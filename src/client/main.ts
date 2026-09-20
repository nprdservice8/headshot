import RAPIER from "@dimforge/rapier3d-compat";
import { Vector3 } from "three";
import { viewDirection } from "../shared/combat.ts";
import {
  EYE_HEIGHT,
  MAX_FRAME_MS,
  RAGDOLL_BLAST_SPEED,
  RAGDOLL_SHOT_SPEED,
  TICK_MS,
  TICK_SEC,
} from "../shared/constants.ts";
import { lerp } from "../shared/math.ts";
import { createMover } from "../shared/movement.ts";
import {
  BUTTON,
  type DeathMessage,
  type MatchMessage,
  type RosterEntry,
} from "../shared/protocol.ts";
import { WEAPON, type WeaponId, weaponDefinition } from "../shared/weapons.ts";
import { castWorldRay, createArenaWorld } from "../shared/world.ts";
import { currentPlayer } from "./account.ts";
import { loadAssets } from "./assets.ts";
import {
  initAudio,
  loadSounds,
  playExplosionAt,
  playOwnWeapon,
  playRemoteWeapon,
} from "./audio.ts";
import * as characters from "./characters.ts";
import * as effects from "./effects.ts";
import { forgetUnseenWalkers, updateOtherFootsteps, updateOwnFootsteps } from "./footsteps.ts";
import * as hud from "./hud.ts";
import {
  consumeButtons,
  currentWeapon,
  initInput,
  isMapOpen,
  isPointerLocked,
  isScoreboardHeld,
  look,
  requestPointerLock,
} from "./input.ts";
import * as net from "./net.ts";
import * as projectiles from "./projectiles.ts";
import {
  blastRagdolls,
  initRagdolls,
  type Ragdoll,
  ragdollFocus,
  spawnRagdoll,
  stepRagdolls,
  syncRagdollMeshes,
} from "./ragdoll.ts";
import {
  forgetUnseenReloaders,
  isOwnReloading,
  startOwnReload,
  updateOtherReload,
  updateOwnReload,
} from "./reload.ts";
import * as render from "./render.ts";
import { recordDeath, recordKill, recordMatch } from "./stats.ts";

const DEATH_CAMERA_DISTANCE = 4;
const DEATH_CAMERA_HEIGHT = 2.5;
/** Ground probes start this far above the feet, so standing exactly on a surface still hits it. */
const GROUND_PROBE_LIFT = 0.1;
/** Shots from a shooter with no drawn soldier start a little below the eye, as if from a gun. */
const FALLBACK_MUZZLE_DROP = 0.1;
/** Where a soldier's hands work their weapon, above the feet: where a reload sounds from. */
const HANDS_HEIGHT = 1.2;
/** How far below a blast the ground is looked for, so its dust ring lands on it. */
const EXPLOSION_DUST_PROBE = 3;

const canvas = hud.getElement("game", HTMLCanvasElement);

const [assets] = await Promise.all([loadAssets(), RAPIER.init(), loadSounds()]);
// The browser's own physics world: the arena for predicting movement, plus local-only ragdolls.
const world = createArenaWorld();
const mover = createMover(world);
render.initRenderer(canvas, assets);
characters.initCharacters(assets, render.scene, probeGround);
initRagdolls(world, render.scene);
effects.initEffects(render.scene, render.getViewmodelMuzzle());
projectiles.initProjectiles(render.scene, assets.grenade);
await render.warmUp();

let joined = false;
let disconnected = false;
let roster: RosterEntry[] = [];
let match: MatchMessage = { type: "match", state: "playing", winnerId: -1 };
/** Career stats are kept per signed-in player; a guest with no session keeps none. */
const playerKey = currentPlayer()?.key ?? "";
let ownRagdoll: Ragdoll | null = null;
let localTick = 0;
let nextLocalFireTick = 0;
let previousButtons = 0;
let frameDt = 0;
let frameNowMs = 0;
let lastDrawX = 0;
let lastDrawZ = 0;

const muzzle = new Vector3();
const aim = { x: 0, y: 0, z: 0 };
const focus = { x: 0, y: 0, z: 0 };

initInput(canvas, () => joined);
hud.onPlay(play);
hud.setMenuReady();

hud.onResume(() => {
  requestPointerLock(canvas);
});

hud.onExit(() => {
  location.assign("/lobby.html");
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

function play(name: string): void {
  // After a disconnect, a fresh page is the simplest way to reset every piece of match state.
  if (disconnected) {
    location.reload();
    return;
  }
  initAudio();
  hud.setMenuStatus("Connecting…");
  requestPointerLock(canvas);
  net.connect(name, mover, {
    onWelcome() {
      joined = true;
      characters.setSelfId(net.self.id);
      hud.showHud();
    },
    onRoster(players) {
      roster = players;
      hud.setScoreboard(players, net.self.id);
      hud.setMatchStats(players, net.self.id);
      characters.removePlayerViewsExcept(new Set(players.map((player) => player.id)));
    },
    onMatch(message) {
      if (message.state === "ended" && match.state !== "ended" && playerKey) {
        const me = roster.find((player) => player.id === net.self.id);
        recordMatch(playerKey, {
          endedAtMs: Date.now(),
          won: message.winnerId === net.self.id,
          winner: nameOf(message.winnerId),
          kills: me?.kills ?? 0,
          deaths: me?.deaths ?? 0,
        });
      }
      match = message;
    },
    onHit(message) {
      hud.flashHitmarker(message.head);
    },
    onSelfDeath(message) {
      if (playerKey) recordDeath(playerKey);
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
      hud.showMenu(`${reason}.`);
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
        muzzle.set(event.fromX, event.fromY - FALLBACK_MUZZLE_DROP, event.fromZ);
      }
      effects.showBullet(muzzle.x, muzzle.y, muzzle.z, event.toX, event.toY, event.toZ, true, now);
      // Safe: the server only sends WeaponIds.
      playRemoteWeapon(
        event.weapon as WeaponId,
        event.fromX,
        event.fromY,
        event.fromZ,
        net.predicted.x,
        net.predicted.y + EYE_HEIGHT,
        net.predicted.z,
        look.yaw,
      );
      if (event.shooterId !== net.self.id) {
        triggerDirectionalIndicator(event.fromX, event.fromZ);
      }
      return;
    case "death": {
      if (event.killerId === net.self.id && playerKey) recordKill(playerKey, event.head);
      const view = characters.getPlayerView(event.victimId);
      if (view) spawnDeathRagdoll(view, event);
      addKillFeedEntry(event);
      return;
    }
    case "explosion": {
      effects.showExplosion(
        event.x,
        event.y,
        event.z,
        probeGround(event.x, event.y, event.z, EXPLOSION_DUST_PROBE),
        now,
      );
      const eyeY = net.predicted.y + EYE_HEIGHT;
      effects.shakeCamera(
        Math.hypot(event.x - net.predicted.x, event.y - eyeY, event.z - net.predicted.z),
        now,
      );
      blastRagdolls(event.x, event.y, event.z);
      playExplosionAt(
        event.x,
        event.y,
        event.z,
        net.predicted.x,
        net.predicted.y + EYE_HEIGHT,
        net.predicted.z,
        look.yaw,
      );
      triggerDirectionalIndicator(event.x, event.z);
      return;
    }
  }
}

function fixedTick(nowMs: number): void {
  localTick++;
  stepRagdolls(nowMs);
  if (!joined) return;
  const buttons = consumeButtons();
  net.sendInputAndPredict(buttons, look.yaw, look.pitch, currentWeapon(), nowMs);
  const reloadPressed = buttons & BUTTON.RELOAD && !(previousButtons & BUTTON.RELOAD);
  previousButtons = buttons;
  // A reload shows straight away under the same rules the server applies (match.ts), read from
  // the last snapshot; one it starts on its own (firing on empty) shows when that snapshot lands.
  // Until the server has confirmed a weapon switch, the ammo it reports is the old weapon's.
  const weapon = currentWeapon();
  if (
    reloadPressed &&
    net.self.alive &&
    match.state === "playing" &&
    weapon === net.self.weapon &&
    !net.self.reloading &&
    net.self.ammo < weaponDefinition(weapon).magSize &&
    net.self.reserve !== 0
  ) {
    // Safe: input.ts only selects WeaponIds.
    startOwnReload(weapon as WeaponId, nowMs);
  }
  updateOwnFootsteps(
    net.predicted.x,
    net.predicted.y,
    net.predicted.z,
    net.predicted.vx,
    net.predicted.vy,
    net.predicted.vz,
    net.predicted.grounded,
    net.predicted.sprinting,
    net.self.alive,
    TICK_SEC,
  );

  // Your own shots show instantly; the server still decides what they hit. Empty or reloading
  // is known from the last snapshot, which is close enough to keep the feedback honest.
  const canShoot =
    net.self.alive &&
    match.state === "playing" &&
    localTick >= nextLocalFireTick &&
    net.self.ammo > 0 &&
    !net.self.reloading &&
    !isOwnReloading();
  if (buttons & BUTTON.FIRE && canShoot) {
    nextLocalFireTick = localTick + weaponDefinition(currentWeapon()).fireIntervalTicks;
    showOwnShot(nowMs);
  }
}

function showOwnShot(nowMs: number): void {
  const weapon = weaponDefinition(currentWeapon());
  playOwnWeapon(weapon.id);
  render.kickViewmodel(weapon.recoil);
  effects.showViewmodelFlash(nowMs, render.getViewmodelMuzzle(), weapon.recoil);
  // A rocket is drawn from snapshots once the server has launched it; only hitscan shots need a
  // bullet drawn right away.
  if (weapon.projectile) return;
  const eyeX = net.predicted.x;
  const eyeY = net.predicted.y + EYE_HEIGHT;
  const eyeZ = net.predicted.z;
  viewDirection(look.yaw, look.pitch, aim);
  const distance = castWorldRay(world, eyeX, eyeY, eyeZ, aim.x, aim.y, aim.z, weapon.range);
  const hitX = eyeX + aim.x * distance;
  const hitY = eyeY + aim.y * distance;
  const hitZ = eyeZ + aim.z * distance;
  render.muzzleWorldPosition(muzzle);
  effects.showBullet(
    muzzle.x,
    muzzle.y,
    muzzle.z,
    hitX,
    hitY,
    hitZ,
    distance < weapon.range,
    nowMs,
  );
}

function drawOtherPlayer(
  id: number,
  x: number,
  y: number,
  z: number,
  yaw: number,
  pitch: number,
  alive: boolean,
  weapon: number,
  reloading: boolean,
): void {
  hud.addMinimapPlayer(x, z, yaw, alive);
  if (isMapOpen()) hud.addFullMapPlayer(x, z, yaw, alive, nameOf(id));
  const reload = updateOtherReload(
    id,
    // Safe: the server only sends WeaponIds.
    weapon as WeaponId,
    reloading,
    alive,
    x,
    y + HANDS_HEIGHT,
    z,
    frameNowMs,
    frameDt,
    net.predicted.x,
    net.predicted.y + EYE_HEIGHT,
    net.predicted.z,
    look.yaw,
  );
  characters.updatePlayerView(id, x, y, z, yaw, pitch, alive, reload, frameDt);
  updateOtherFootsteps(
    id,
    x,
    y,
    z,
    alive,
    frameDt,
    net.predicted.x,
    net.predicted.y + EYE_HEIGHT,
    net.predicted.z,
    look.yaw,
  );
}

/** A rocket is drawn leaving the gun of whoever fired it: your own launcher's muzzle, or the
 * soldier's rifle for anyone else. Rockets aren't announced like shots are, so one that just
 * appeared is a launch you can hear unless it is your own, which was heard when you fired. */
function drawRocket(
  id: number,
  ownerId: number,
  x: number,
  y: number,
  z: number,
  dx: number,
  dy: number,
  dz: number,
): void {
  hud.addMapRocket(x, z, dx, dz);
  const own = ownerId === net.self.id;
  let launchedFrom: Vector3 | null = null;
  if (own) launchedFrom = render.muzzleWorldPosition(muzzle);
  else if (characters.muzzlePosition(ownerId, muzzle)) launchedFrom = muzzle;
  if (!projectiles.updateRocketView(id, x, y, z, dx, dy, dz, launchedFrom) || own) return;
  playRemoteWeapon(
    WEAPON.BAZOOKA,
    x,
    y,
    z,
    net.predicted.x,
    net.predicted.y + EYE_HEIGHT,
    net.predicted.z,
    look.yaw,
  );
}

function drawGrenade(id: number, x: number, y: number, z: number): void {
  projectiles.updateGrenadeView(id, x, y, z);
  hud.addMapGrenade(x, z);
}

function drawFrame(nowMs: number, alpha: number): void {
  frameNowMs = nowMs;
  const tick = net.renderTick(nowMs);
  net.fadeCorrection(frameDt);
  const x = lerp(net.previous.x, net.predicted.x, alpha) + net.correction.x;
  const y = lerp(net.previous.y, net.predicted.y, alpha) + net.correction.y;
  const z = lerp(net.previous.z, net.predicted.z, alpha) + net.correction.z;
  hud.beginMinimap(x, z, look.yaw, net.self.alive);
  hud.setFullMapVisible(isMapOpen());
  if (isMapOpen()) hud.beginFullMap(x, z, look.yaw, net.self.alive);
  net.processWorldEvents(tick, handleWorldEvent);
  net.forEachOtherPlayer(tick, drawOtherPlayer);
  forgetUnseenWalkers();
  forgetUnseenReloaders();
  net.forEachGrenade(tick, drawGrenade);
  net.forEachRocket(tick, drawRocket);
  projectiles.removeUnseenProjectiles();

  // Safe: the server only sends WeaponIds.
  const ownReload = updateOwnReload(
    net.self.weapon as WeaponId,
    net.self.reloading,
    net.self.alive,
    nowMs,
    frameDt,
  );
  // Your own body is never drawn, but its pose is kept up to date for your ragdoll.
  characters.updatePlayerView(
    net.self.id,
    x,
    y,
    z,
    look.yaw,
    look.pitch,
    false,
    ownReload,
    frameDt,
  );
  render.updateViewmodel(
    frameDt,
    Math.hypot(x - lastDrawX, z - lastDrawZ),
    net.predicted.grounded,
    look.yaw,
    look.pitch,
    net.self.ads,
    ownReload,
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
  effects.applyCameraShake(camera, nowMs);
  render.setViewmodelVisible(net.self.alive);
  render.setViewmodelWeapon(net.self.weapon);
  syncRagdollMeshes();
  effects.updateEffects(nowMs);

  hud.setHealth(net.self.hp);
  hud.setGrenades(net.self.grenades);
  hud.setWeapon(
    net.self.weapon,
    net.self.ammo,
    net.self.reserve,
    net.self.reloading,
    net.self.ads,
    net.self.sprinting,
  );
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
