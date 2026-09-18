import assert from "node:assert/strict";
import { before, test } from "node:test";
import type { World } from "@dimforge/rapier3d-compat";
import RAPIER from "@dimforge/rapier3d-compat";
import {
  PLAYER_RADIUS,
  SPRINT_SPEED,
  SPRINT_STAMINA_MAX,
  STEP_HEIGHT,
  TICK_RATE,
  WALK_SPEED,
} from "./constants.ts";
import {
  copyMoveState,
  createMover,
  createMoveState,
  type Mover,
  type MoveState,
  stepMovement,
} from "./movement.ts";
import { BUTTON } from "./protocol.ts";
import { addSolidBox, PLAY_HALF_SIZE, ramp } from "./world.ts";

let world: World;
let mover: Mover;

function solidBox(x: number, y: number, z: number, hx: number, hy: number, hz: number) {
  addSolidBox(world, { x, y, z, hx, hy, hz, yaw: 0, tilt: 0 });
}

// A private test course, so arena layout changes never break these tests.
before(async () => {
  await RAPIER.init();
  world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  solidBox(0, -0.5, 0, 100, 0.5, 100); // floor, top at y = 0
  solidBox(0, 2, -20, 5, 2, 0.5); // wall; its near face is at z = -19.5
  solidBox(20, 0.15, -12, 2, 0.15, 4); // 0.3 m step spanning z = -16..-8
  addSolidBox(world, ramp(40, 0, Math.PI, 6, 2, 3)); // rises 2 m toward -Z, from z = 0 to z = -6
  world.step();
  mover = createMover(world);
});

function run(state: MoveState, buttons: number, ticks: number, yaw = 0): void {
  for (let i = 0; i < ticks; i++) stepMovement(mover, state, buttons, yaw);
}

test("settles onto the floor and reports grounded", () => {
  const state = createMoveState(0, 0.5, 0);
  run(state, 0, 30);
  assert.ok(Math.abs(state.y) < 0.05, `y = ${state.y}`);
  assert.equal(state.grounded, true);
});

test("walks forward at walk speed", () => {
  const state = createMoveState(0, 0, 0);
  run(state, 0, 10);
  run(state, BUTTON.FORWARD, TICK_RATE);
  const startZ = state.z;
  run(state, BUTTON.FORWARD, TICK_RATE);
  assert.ok(Math.abs(startZ - state.z - WALK_SPEED) < 0.3, `moved ${startZ - state.z}`);
  assert.ok(Math.abs(state.x) < 0.01);
});

test("sprinting increases predicted speed deterministically", () => {
  const state = createMoveState(0, 0, 0);
  run(state, 0, 10);
  for (let i = 0; i < TICK_RATE; i++) stepMovement(mover, state, BUTTON.FORWARD, 0, true);
  const startZ = state.z;
  for (let i = 0; i < TICK_RATE; i++) stepMovement(mover, state, BUTTON.FORWARD, 0, true);
  assert.ok(Math.abs(startZ - state.z - SPRINT_SPEED) < 0.3, `moved ${startZ - state.z}`);
});

test("sprint stamina runs out and forces a walk until it regenerates", () => {
  // Sprinting for the full stamina tank covers ~27 m; yaw PI runs +Z, away from every obstacle
  // in the test course, so nothing but the stamina gate itself can stop the player.
  const yaw = Math.PI;
  const state = createMoveState(0, 0, 0);
  run(state, 0, 10);
  // Sprint until stamina runs out and the gate itself reports exhaustion (floating-point drain
  // can land a hair above zero on the exact tick count, so wait for the gate, not a tick count).
  let ticksToExhaustion = 0;
  do {
    stepMovement(mover, state, BUTTON.FORWARD, yaw, true);
    ticksToExhaustion++;
    assert.ok(ticksToExhaustion <= TICK_RATE * SPRINT_STAMINA_MAX + 5, "never exhausted");
  } while (state.sprinting);
  assert.ok(state.stamina < 0.02, `stamina = ${state.stamina}`);

  // Holding sprint with an empty tank settles back to walk speed, never bursts back to sprint speed.
  for (let i = 0; i < TICK_RATE; i++) stepMovement(mover, state, BUTTON.FORWARD, yaw, true);
  assert.equal(state.sprinting, false, "must fully recover before sprinting again");
  const startZ = state.z;
  for (let i = 0; i < TICK_RATE; i++) stepMovement(mover, state, BUTTON.FORWARD, yaw, true);
  assert.ok(Math.abs(state.z - startZ - WALK_SPEED) < 0.3, `moved ${state.z - startZ}`);

  for (let i = 0; i < TICK_RATE * SPRINT_STAMINA_MAX * 4; i++) stepMovement(mover, state, 0, 0);
  assert.equal(state.stamina, SPRINT_STAMINA_MAX);
});

test("yaw turns the forward direction", () => {
  const state = createMoveState(0, 0, 0);
  run(state, 0, 10);
  run(state, BUTTON.FORWARD, TICK_RATE, Math.PI / 2);
  assert.ok(state.x < -4, `x = ${state.x}`);
  assert.ok(Math.abs(state.z) < 0.1, `z = ${state.z}`);
});

test("a wall stops the player", () => {
  const state = createMoveState(0, 0, -15);
  run(state, BUTTON.FORWARD, TICK_RATE * 3);
  assert.ok(state.z > -19.5 + 0.3 && state.z < -19, `z = ${state.z}`);
});

test("a wall absorbs velocity in the air", () => {
  const state = createMoveState(0, 0, -17);
  run(state, 0, 10);
  state.vz = -12;
  state.vy = 4;
  state.grounded = false;
  run(state, 0, 20);
  assert.ok(state.z > -19.5 + 0.3, `z = ${state.z}`);
  assert.ok(Math.abs(state.vz) < 0.5, `vz = ${state.vz}`);
});

test("overlapping corner walls never admit a capsule wedge", () => {
  // This mirrors the perimeter construction: two thick colliders overlap rather than merely meet.
  solidBox(-10.5, 2, 0, 0.75, 2, 11);
  solidBox(0, 2, -10.5, 11, 2, 0.75);
  const state = createMoveState(-8, 0, -8);
  run(state, 0, 10);
  run(state, BUTTON.FORWARD | BUTTON.LEFT, TICK_RATE * 3, Math.PI / 4);
  assert.ok(state.x > -10.2 || state.z > -10.2, `wedged into corner x=${state.x}, z=${state.z}`);
});

test("nothing throws a player past the edge of the play area", () => {
  // The test course's floor runs on past the edge, with nothing standing at it.
  const limit = PLAY_HALF_SIZE - PLAYER_RADIUS;
  for (const [vx, vz] of [
    [80, 20],
    [20, 80],
    [60, 60],
  ] as const) {
    const state = createMoveState(50, 0, 50);
    state.vx = vx;
    state.vy = 30;
    state.vz = vz;
    run(state, BUTTON.FORWARD, TICK_RATE * 4, Math.atan2(-vx, -vz));
    assert.ok(
      Math.abs(state.x) <= limit && Math.abs(state.z) <= limit,
      `at ${state.x}, ${state.z}`,
    );
    assert.ok(
      state.x === limit || state.x === -limit || Math.abs(state.z) === limit,
      "reached the edge",
    );
  }
});

test("jumping leaves the ground and lands again", () => {
  const state = createMoveState(0, 0, 0);
  run(state, 0, 10);
  run(state, BUTTON.JUMP, 1);
  assert.equal(state.grounded, false);
  let peak = 0;
  for (let i = 0; i < TICK_RATE; i++) {
    stepMovement(mover, state, 0, 0);
    peak = Math.max(peak, state.y);
  }
  assert.ok(peak > 0.8 && peak < 1.4, `peak = ${peak}`);
  assert.equal(state.grounded, true);
  assert.ok(Math.abs(state.y) < 0.05);
});

test("does not sink into the floor after landing", () => {
  const state = createMoveState(0, 0, 0);
  run(state, 0, 10);
  run(state, BUTTON.JUMP, 1);
  run(state, 0, TICK_RATE * 5);
  assert.ok(state.y >= 0 && state.y < 0.05, `y = ${state.y}`);
});

test("pushes out of a floor it starts inside", () => {
  const state = createMoveState(0, -0.02, 0);
  run(state, 0, TICK_RATE);
  assert.ok(state.y >= 0 && state.y < 0.05, `y = ${state.y}`);
});

test("walks up a step lower than STEP_HEIGHT", () => {
  assert.ok(STEP_HEIGHT > 0.3);
  const state = createMoveState(20, 0, -5);
  run(state, 0, 10);
  run(state, BUTTON.FORWARD, Math.round(TICK_RATE * 1.3));
  assert.ok(state.z < -10, `z = ${state.z}`);
  assert.ok(Math.abs(state.y - 0.3) < 0.05, `y = ${state.y}`);
});

test("walks up a ramp", () => {
  const state = createMoveState(40, 0, 2);
  run(state, 0, 10);
  run(state, BUTTON.FORWARD, Math.round(TICK_RATE * 1.2));
  assert.ok(state.z < -4, `z = ${state.z}`);
  assert.ok(state.y > 1, `y = ${state.y}`);
  assert.equal(state.grounded, true);
});

test("replaying the same inputs from the same state gives the same result", () => {
  const start = createMoveState(0, 0, 0);
  run(start, 0, 10);
  const inputs = [BUTTON.FORWARD, BUTTON.FORWARD | BUTTON.LEFT, BUTTON.JUMP, BUTTON.RIGHT, 0];
  const a = createMoveState(0, 0, 0);
  const b = createMoveState(0, 0, 0);
  copyMoveState(start, a);
  copyMoveState(start, b);
  for (let i = 0; i < 90; i++) stepMovement(mover, a, inputs[i % inputs.length] ?? 0, i * 0.01);
  for (let i = 0; i < 90; i++) stepMovement(mover, b, inputs[i % inputs.length] ?? 0, i * 0.01);
  assert.deepEqual(a, b);
});
