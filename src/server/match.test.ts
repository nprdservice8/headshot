import assert from "node:assert/strict";
import { before, test } from "node:test";
import RAPIER from "@dimforge/rapier3d-compat";
import {
  BODY_DAMAGE,
  EYE_HEIGHT,
  FIRE_INTERVAL_TICKS,
  GRENADE_FUSE_TICKS,
  HEALTH_REGEN_DELAY_TICKS,
  HEALTH_REGEN_INTERVAL_TICKS,
  KILLS_TO_WIN,
  MATCH_RESTART_TICKS,
  MAX_HP,
  MAX_INPUT_QUEUE,
  SPAWN_SAFE_DISTANCE,
} from "../shared/constants.ts";
import { BUTTON, type InputMessage, type ServerMessage } from "../shared/protocol.ts";
import type { SpawnPoint } from "../shared/world.ts";
import {
  addPlayer,
  chooseSpawn,
  createMatch,
  type Match,
  type Player,
  queueInput,
  tickMatch,
} from "./match.ts";

type Sent = { to: number | "everyone"; message: ServerMessage };

before(async () => {
  await RAPIER.init();
});

function setup() {
  const sent: Sent[] = [];
  const match = createMatch(
    {
      send: (to, message) => sent.push({ to, message }),
      broadcast: (message) => sent.push({ to: "everyone", message }),
    },
    () => 0,
  );
  const shooter = mustAdd(match, "Shooter");
  const target = mustAdd(match, "Target");
  return { match, sent, shooter, target };
}

function mustAdd(match: Match, name: string): Player {
  const player = addPlayer(match, name);
  assert.ok(player);
  return player;
}

// Positions below are open floor in the street north of the temple square (see shared/world.ts).
function place(match: Match, player: Player, x: number, z: number): void {
  player.move.x = x;
  player.move.y = 0.01;
  player.move.z = z;
  player.move.vx = 0;
  player.move.vy = 0;
  player.move.vz = 0;
  player.spawnTick = match.tick;
}

function ticks(match: Match, count: number): void {
  for (let i = 0; i < count; i++) tickMatch(match);
}

let seq = 0;
function input(
  match: Match,
  player: Player,
  buttons: number,
  yaw: number,
  pitch: number,
  viewTick = match.tick,
  weapon = 0,
) {
  const message: InputMessage = {
    type: "input",
    seq: ++seq,
    buttons,
    yaw,
    pitch,
    viewTick,
    weapon,
  };
  queueInput(match, player.id, message);
}

/** Pitch that aims from a standing player's eye at a height `targetY` a horizontal `distance` away. */
function aimPitch(shooter: Player, targetY: number, distance: number): number {
  return Math.atan2(targetY - (shooter.move.y + EYE_HEIGHT), distance);
}

function messagesOfType<T extends ServerMessage["type"]>(sent: Sent[], type: T) {
  return sent
    .map((s) => s.message)
    .filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
}

test("a body shot does body damage and a headshot kills", () => {
  const { match, sent, shooter, target } = setup();
  place(match, shooter, -3, -38);
  place(match, target, -3, -44);
  ticks(match, 20);

  input(match, shooter, BUTTON.FIRE, 0, aimPitch(shooter, 0.9, 6));
  tickMatch(match);
  assert.equal(target.hp, MAX_HP - BODY_DAMAGE);
  assert.deepEqual(messagesOfType(sent, "hit").at(-1), {
    type: "hit",
    targetId: target.id,
    head: false,
    damage: BODY_DAMAGE,
  });

  ticks(match, FIRE_INTERVAL_TICKS);
  input(match, shooter, BUTTON.FIRE, 0, aimPitch(shooter, 1.6, 6));
  tickMatch(match);
  assert.equal(target.alive, false);
  assert.equal(shooter.kills, 1);
  assert.equal(target.deaths, 1);
  const death = messagesOfType(sent, "death").at(-1);
  assert.equal(death?.head, true);
  assert.equal(death?.killerId, shooter.id);
});

test("a player hit below 50 HP regenerates gradually to full health after five seconds", () => {
  const { match, target } = setup();
  target.hp = 48;
  target.regenTick = match.tick + HEALTH_REGEN_DELAY_TICKS;
  target.regenerating = true;

  ticks(match, HEALTH_REGEN_DELAY_TICKS - 1);
  assert.equal(target.hp, 48);
  tickMatch(match);
  assert.equal(target.hp, 49);
  ticks(match, HEALTH_REGEN_INTERVAL_TICKS - 1);
  assert.equal(target.hp, 49);
  tickMatch(match);
  assert.equal(target.hp, 50);
  ticks(match, HEALTH_REGEN_INTERVAL_TICKS * 50);
  assert.equal(target.hp, MAX_HP);
  assert.equal(target.regenerating, false);
});

test("lag compensation: a shot hits where the target was on the shooter's screen", () => {
  const { match, shooter, target } = setup();
  place(match, shooter, -3, -38);
  place(match, target, -3, -44);
  ticks(match, 20);
  const seenAtTick = match.tick;

  // The target steps two metres aside; the shooter's screen is still showing the old position.
  target.move.x = -5;
  ticks(match, 6);
  input(match, shooter, BUTTON.FIRE, 0, aimPitch(shooter, 0.9, 6), seenAtTick);
  tickMatch(match);
  assert.equal(target.hp, MAX_HP - BODY_DAMAGE);

  // Aiming at the old position with an up-to-date view misses.
  ticks(match, FIRE_INTERVAL_TICKS);
  input(match, shooter, BUTTON.FIRE, 0, aimPitch(shooter, 0.9, 6));
  tickMatch(match);
  assert.equal(target.hp, MAX_HP - BODY_DAMAGE);
});

test("arena walls block shots", () => {
  const { match, sent, shooter, target } = setup();
  // The burnt-out truck spanning z = -43.9..-36.1 stands between them.
  place(match, shooter, 3, -34);
  place(match, target, 3, -44.8);
  ticks(match, 20);
  input(match, shooter, BUTTON.FIRE, 0, aimPitch(shooter, 0.9, 10.8));
  tickMatch(match);
  assert.equal(target.hp, MAX_HP);
  const shot = messagesOfType(sent, "shot").at(-1);
  assert.ok(shot && shot.toZ < -35.9 && shot.toZ > -36.4, `shot ended at z = ${shot?.toZ}`);
});

test("the server enforces the fire rate", () => {
  const { match, sent, shooter } = setup();
  place(match, shooter, -3, -38);
  ticks(match, 5);
  for (let i = 0; i < FIRE_INTERVAL_TICKS * 2; i++) {
    input(match, shooter, BUTTON.FIRE, 0, 0);
    tickMatch(match);
  }
  assert.equal(messagesOfType(sent, "shot").length, 2);
});

test("bazooka fires a swept straight rocket, splashes, and respects its cooldown", () => {
  const { match, sent, shooter, target } = setup();
  place(match, shooter, -3, -38);
  place(match, target, -3, -44);
  ticks(match, 20);
  input(match, shooter, BUTTON.FIRE, 0, aimPitch(shooter, 0.9, 6), match.tick, 2);
  tickMatch(match);
  assert.equal(shooter.rockets, 2);
  assert.equal(match.rockets.length, 1);
  ticks(match, 12);
  assert.equal(match.rockets.length, 0);
  assert.ok(target.hp < MAX_HP, `target hp ${target.hp}`);
  assert.ok(messagesOfType(sent, "explosion").length > 0);
  input(match, shooter, BUTTON.FIRE, 0, 0, match.tick, 2);
  tickMatch(match);
  assert.equal(match.rockets.length, 0, "bazooka cannot bypass its cooldown");
});

test("a grenade explodes after its fuse, hurting and pushing nearby players", () => {
  const { match, sent, shooter, target } = setup();
  place(match, shooter, -3, -38);
  place(match, target, -3, -40.5);
  ticks(match, 5);
  input(match, shooter, BUTTON.GRENADE, 0, -0.9);
  tickMatch(match);
  assert.equal(shooter.grenades, 1);
  assert.equal(match.grenades.length, 1);

  ticks(match, GRENADE_FUSE_TICKS - 2);
  const grenade = match.grenades[0]?.body.translation();
  assert.ok(grenade, "grenade still live just before its fuse ends");
  assert.ok(grenade.y > 0 && grenade.y < 1, `grenade came to rest on the floor, y = ${grenade.y}`);

  // Put the target 2 m from the grenade and the thrower far away, so only the target is caught.
  place(match, target, grenade.x, grenade.z + 2);
  place(match, shooter, -3, -60);
  ticks(match, 2);
  assert.equal(match.grenades.length, 0);
  assert.equal(messagesOfType(sent, "explosion").length, 1);
  assert.ok(target.hp < MAX_HP, `target hp ${target.hp}`);
  assert.ok(target.move.vz > 0, "knockback pushes the target away from the blast");
  assert.equal(shooter.hp, MAX_HP);
});

test("reaching the kill target ends the match, which restarts later", () => {
  const { match, sent, shooter, target } = setup();
  place(match, shooter, -3, -38);
  place(match, target, -3, -44);
  ticks(match, 20);
  shooter.kills = KILLS_TO_WIN - 1;
  input(match, shooter, BUTTON.FIRE, 0, aimPitch(shooter, 1.6, 6));
  tickMatch(match);
  assert.equal(match.state, "ended");
  assert.equal(match.winnerId, shooter.id);
  assert.deepEqual(messagesOfType(sent, "match").at(-1), {
    type: "match",
    state: "ended",
    winnerId: shooter.id,
  });

  ticks(match, MATCH_RESTART_TICKS);
  assert.equal(match.state, "playing");
  assert.equal(shooter.kills, 0);
  assert.equal(target.alive, true);
});

test("the input queue ignores replayed seqs and keeps only the newest inputs", () => {
  const { match, shooter } = setup();
  input(match, shooter, 0, 0, 0);
  const replay: InputMessage = {
    type: "input",
    seq,
    buttons: BUTTON.FIRE,
    yaw: 0,
    pitch: 0,
    viewTick: 0,
    weapon: 0,
  };
  queueInput(match, shooter.id, replay);
  assert.equal(shooter.inputs.length, 1);
  for (let i = 0; i < MAX_INPUT_QUEUE * 2; i++) input(match, shooter, 0, 0, 0);
  assert.equal(shooter.inputs.length, MAX_INPUT_QUEUE);
  assert.equal(shooter.inputs.at(-1)?.seq, seq);
});

test("chooseSpawn avoids living enemies when it can", () => {
  const { match, shooter, target } = setup();
  const points: SpawnPoint[] = [
    { x: 0, y: 0, z: 0, yaw: 0 },
    { x: SPAWN_SAFE_DISTANCE * 2, y: 0, z: 0, yaw: 0 },
  ];
  place(match, target, 1, 1);
  assert.equal(
    chooseSpawn(points, match.players, shooter, () => 0),
    points[1],
  );
  target.alive = false;
  assert.equal(
    chooseSpawn(points, match.players, shooter, () => 0),
    points[0],
  );
});
