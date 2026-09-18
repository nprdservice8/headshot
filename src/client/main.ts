import RAPIER from "@dimforge/rapier3d-compat";
import { Vector3 } from "three";
import { viewDirection } from "../shared/combat.ts";
import {
  EYE_HEIGHT,
  MAX_FRAME_MS,
  RAGDOLL_BLAST_SPEED,
  RAGDOLL_SHOT_SPEED,
  RIFLE_RANGE,
  TICK_MS,
} from "../shared/constants.ts";
import { weaponDefinition } from "../shared/weapons.ts";
import { lerp } from "../shared/math.ts";
import { createMover } from "../shared/movement.ts";
import {
  BUTTON,
  type DeathMessage,
  type MatchMessage,
  type RosterEntry,
} from "../shared/protocol.ts";
import { castWorldRay, createArenaWorld } from "../shared/world.ts";
import { loadAssets } from "./assets.ts";
import { initAudio, playExplosionSound, playLocalGunshot, playRemoteGunshot } from "./audio.ts";
import * as characters from "./characters.ts";
import * as effects from "./effects.ts";
import * as hud from "./hud.ts";
import {
  consumeButtons,
  currentWeapon,
  initInput,
  isPointerLocked,
  isScoreboardHeld,
  look,
  requestPointerLock,
} from "./input.ts";
import * as net from "./net.ts";
import {
  blastRagdolls,
  initRagdolls,
  type Ragdoll,
  ragdollFocus,
  spawnRagdoll,
  stepRagdolls,
  syncRagdollMeshes,
} from "./ragdoll.ts";
import * as render from "./render.ts";

const NAME_STORAGE_KEY = "headshot.name";
const DEATH_CAMERA_DISTANCE = 4;
const DEATH_CAMERA_HEIGHT = 2.5;
/** Ground probes start this far above the feet, so standing exactly on a surface still hits it. */
const GROUND_PROBE_LIFT = 0.1;
const OWN_TRACER_DROP = 0.1;

const canvas = hud.getElement("game", HTMLCanvasElement);

const [assets] = await Promise.all([loadAssets(), RAPIER.init()]);
// The browser's own physics world: the arena for predicting movement, plus local-only ragdolls.
const world = createArenaWorld();
const mover = createMover(world);
render.initRenderer(canvas, assets);
characters.initCharacters(assets, render.scene, probeGround);
initRagdolls(world, render.scene);
effects.initEffects(render.scene, render.getViewmodelMuzzle());
await render.warmUp();

let joined = false;
let disconnected = false;
let roster: RosterEntry[] = [];
let match: MatchMessage = { type: "match", state: "playing", winnerId: -1 };
let ownRagdoll: Ragdoll | null = null;
let localTick = 0;
let nextLocalFireTick = 0;
let frameDt = 0;
let lastDrawX = 0;
let lastDrawZ = 0;

const muzzle = new Vector3();
const aim = { x: 0, y: 0, z: 0 };
const focus = { x: 0, y: 0, z: 0 };

initInput(canvas, () => joined);
hud.onPlay(play, readSavedName());
hud.setMenuReady();

hud.onResume(() => {
  requestPointerLock(canvas);
});

hud.onExit(() => {
  location.reload();
});

document.addEventListener("pointerlockchange", () => {
  if (joined) {
    const locked = isPointerLocked();
    hud.setPauseVisible(!locked);
  }
});

function probeGround(x: number, y: number, z: number, max: number): number {
  const lift = GROUND_PROBE_LIFT;
  return castWorldRay(world, x, y + lift, z, 0, -1, 0, max + lift) - lift;
}

function readSavedName(): string {
  try {
    return localStorage.getItem(NAME_STORAGE_KEY) ?? "";
  } catch {
    return ""; // Storage can be blocked (private windows); the name just isn't remembered.
  }
}

function play(name: string): void {
  // After a disconnect, a fresh page is the simplest way to reset every piece of match state.
  if (disconnected) {
    location.reload();
    return;
  }
  try {
    localStorage.setItem(NAME_STORAGE_KEY, name);
  } catch {
    // Not remembering the name is harmless.
  }
  initAudio();
  hud.setMenuStatus("Connecting…");
  requestPointerLock(canvas);
  net.connect(name, mover, {
    onWelcome() {
      joined = true;
      render.setViewmodelTeam(net.self.id);
      hud.showHud();
    },
    onRoster(players) {
      roster = players;
      hud.setScoreboard(players, net.self.id);
      characters.removePlayerViewsExcept(new Set(players.map((player) => player.id)));
    },
    onMatch(message) {
      match = message;
    },
    onHit(message) {
      hud.flashHitmarker(message.head);
    },
    onSelfDeath(message) {
      const view = characters.getPlayerView(net.self.id);
      if (view) ownRagdoll = spawnDeathRagdoll(view, message);
      addKillFeedEntry(message);
    },
    onRespawn(yaw) {
      look.yaw = yaw;
      look.pitch = 0;
      ownRagdoll = null;
    },
    onClose(reason) {
      joined = false;
      disconnected = true;
      document.exitPointerLock();
      hud.showMenu(`${reason}. Press Play to rejoin.`);
    },
  });
}

function nameOf(id: number): string {
  for (const player of roster) {
    if (player.id === id) return player.name;
  }
  return "Someone";
}

function addKillFeedEntry(death: DeathMessage): void {
  const icon = death.cause === "grenade" ? "💥" : death.head ? "🎯" : "🔫";
  const killer =
    death.killerId === death.victimId || death.killerId === -1 ? "" : nameOf(death.killerId);
  hud.addKillFeedEntry(killer, nameOf(death.victimId), icon);
}

function spawnDeathRagdoll(view: characters.PlayerView, death: DeathMessage): Ragdoll | null {
  const speed = death.cause === "grenade" ? RAGDOLL_BLAST_SPEED : RAGDOLL_SHOT_SPEED;
  return spawnRagdoll(
    view,
    death.dirX * speed,
    death.dirY * speed,
    death.dirZ * speed,
    performance.now(),
  );
}

function triggerDirectionalIndicator(fromX: number, fromZ: number): void {
  const dx = fromX - net.predicted.x;
  const dz = fromZ - net.predicted.z;
  const distSq = dx * dx + dz * dz;
  if (distSq > 0.1 && distSq < 3600) {
    const worldAngle = Math.atan2(-dx, -dz);
    const relAngle = worldAngle - look.yaw;
    hud.showDirectionalIndicator(relAngle);
  }
}

function handleWorldEvent(event: net.WorldEvent): void {
  const now = performance.now();
  switch (event.type) {
    case "shot":
      characters.playShot(event.shooterId);
      if (characters.muzzlePosition(event.shooterId, muzzle)) {
        effects.showMuzzleFlash(muzzle.x, muzzle.y, muzzle.z, now);
      } else {
        muzzle.set(event.fromX, event.fromY - OWN_TRACER_DROP, event.fromZ);
      }
      effects.showTracer(muzzle.x, muzzle.y, muzzle.z, event.toX, event.toY, event.toZ, now);
      effects.showImpact(event.toX, event.toY, event.toZ, now);
      playRemoteGunshot(
        event.fromX,
        event.fromY,
        event.fromZ,
        net.predicted.x,
        net.predicted.y + EYE_HEIGHT,
        net.predicted.z,
      );
      if (event.shooterId !== net.self.id) {
        triggerDirectionalIndicator(event.fromX, event.fromZ);
      }
      return;
    case "death": {
      const view = characters.getPlayerView(event.victimId);
      if (view) spawnDeathRagdoll(view, event);
      addKillFeedEntry(event);
      return;
    }
    case "explosion":
      effects.showExplosion(event.x, event.y, event.z, now);
      blastRagdolls(event.x, event.y, event.z);
      playExplosionSound(
        event.x,
        event.y,
        event.z,
        net.predicted.x,
        net.predicted.y + EYE_HEIGHT,
        net.predicted.z,
      );
      triggerDirectionalIndicator(event.x, event.z);
      return;
  }
}

function fixedTick(nowMs: number): void {
  localTick++;
  stepRagdolls(nowMs);
  if (!joined) return;
  const buttons = consumeButtons();
  net.sendInputAndPredict(buttons, look.yaw, look.pitch, currentWeapon(), nowMs);

  // Your own shots show instantly; the server still decides what they hit.
  const canShoot = net.self.alive && match.state === "playing" && localTick >= nextLocalFireTick;
  if (buttons & BUTTON.FIRE && canShoot) {
    nextLocalFireTick = localTick + weaponDefinition(currentWeapon()).fireIntervalTicks;
    showOwnShot(nowMs);
  }
}

function showOwnShot(nowMs: number): void {
  const eyeX = net.predicted.x;
  const eyeY = net.predicted.y + EYE_HEIGHT;
  const eyeZ = net.predicted.z;
  viewDirection(look.yaw, look.pitch, aim);
  const distance = castWorldRay(world, eyeX, eyeY, eyeZ, aim.x, aim.y, aim.z, RIFLE_RANGE);
  playLocalGunshot();
  const hitX = eyeX + aim.x * distance;
  const hitY = eyeY + aim.y * distance;
  const hitZ = eyeZ + aim.z * distance;
  render.kickViewmodel();
  effects.showViewmodelFlash(nowMs);
  render.muzzleWorldPosition(muzzle);
  effects.showTracer(muzzle.x, muzzle.y, muzzle.z, hitX, hitY, hitZ, nowMs);
  if (distance < RIFLE_RANGE) effects.showImpact(hitX, hitY, hitZ, nowMs);
}

function drawOtherPlayer(
  id: number,
  x: number,
  y: number,
  z: number,
  yaw: number,
  pitch: number,
  alive: boolean,
): void {
  characters.updatePlayerView(id, x, y, z, yaw, pitch, alive, frameDt);
}

function drawFrame(nowMs: number, alpha: number): void {
  const tick = net.renderTick(nowMs);
  net.processWorldEvents(tick, handleWorldEvent);
  net.forEachOtherPlayer(tick, drawOtherPlayer);
  net.forEachGrenade(tick, render.updateGrenadeView);
  net.forEachRocket(tick, render.updateRocketView);
  render.removeUnseenGrenades();

  net.fadeCorrection(frameDt);
  const x = lerp(net.previous.x, net.predicted.x, alpha) + net.correction.x;
  const y = lerp(net.previous.y, net.predicted.y, alpha) + net.correction.y;
  const z = lerp(net.previous.z, net.predicted.z, alpha) + net.correction.z;
  // Your own body is never drawn, but its pose is kept up to date for your ragdoll.
  characters.updatePlayerView(net.self.id, x, y, z, look.yaw, look.pitch, false, frameDt);
  render.updateViewmodel(
    frameDt,
    Math.hypot(x - lastDrawX, z - lastDrawZ),
    net.predicted.grounded,
    look.yaw,
    look.pitch,
    net.self.ads,
  );
  render.updateCameraFov(frameDt, net.self.ads, net.self.sprinting);
  lastDrawX = x;
  lastDrawZ = z;

  const camera = render.camera;
  if (net.self.alive) {
    camera.position.set(x, y + EYE_HEIGHT, z);
    camera.rotation.set(look.pitch, look.yaw, 0);
  } else if (ownRagdoll && ragdollFocus(ownRagdoll, focus)) {
    camera.position.set(
      focus.x + Math.sin(look.yaw) * DEATH_CAMERA_DISTANCE,
      focus.y + DEATH_CAMERA_HEIGHT,
      focus.z + Math.cos(look.yaw) * DEATH_CAMERA_DISTANCE,
    );
    camera.lookAt(focus.x, focus.y, focus.z);
  }
  render.setViewmodelVisible(net.self.alive);
  syncRagdollMeshes();
  effects.updateEffects(nowMs);

  hud.setHealth(net.self.hp);
  hud.setGrenades(net.self.grenades);
  hud.setWeapon(net.self.weapon, net.self.rockets, net.self.ads, net.self.sprinting);
  hud.setScoreboardVisible(isScoreboardHeld() || match.state === "ended");
  hud.setClickToPlayVisible(!isPointerLocked());
  if (match.state === "ended") {
    hud.setCenterMessage(`${nameOf(match.winnerId)} wins! Next match in a few seconds`);
  } else {
    hud.setCenterMessage(net.self.alive ? "" : "Respawning…");
  }
  render.draw();
}

let lastFrameMs = performance.now();
let accumulatorMs = 0;

function frame(nowMs: number): void {
  const elapsedMs = Math.min(nowMs - lastFrameMs, MAX_FRAME_MS);
  lastFrameMs = nowMs;
  frameDt = elapsedMs / 1000;
  accumulatorMs += elapsedMs;
  while (accumulatorMs >= TICK_MS) {
    fixedTick(nowMs);
    accumulatorMs -= TICK_MS;
  }
  if (joined) drawFrame(nowMs, accumulatorMs / TICK_MS);
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
