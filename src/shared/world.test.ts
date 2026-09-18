import assert from "node:assert/strict";
import { before, test } from "node:test";
import type { World } from "@dimforge/rapier3d-compat";
import RAPIER from "@dimforge/rapier3d-compat";
import { PLAYER_RADIUS } from "./constants.ts";
import { createMover, createMoveState, type Mover, stepMovement } from "./movement.ts";
import { castWorldRay, createArenaWorld, PLAY_HALF_SIZE, SPAWN_POINTS } from "./world.ts";

let world: World;
let mover: Mover;

before(async () => {
  await RAPIER.init();
  world = createArenaWorld();
  mover = createMover(world);
});

test("every spawn point stands clear, on solid ground, inside the play area", () => {
  for (const point of SPAWN_POINTS) {
    const state = createMoveState(point.x, point.y, point.z);
    for (let i = 0; i < 30; i++) stepMovement(mover, state, 0, 0);
    const at = `spawn (${point.x}, ${point.y}, ${point.z})`;
    // Anything overlapping the spawn would have pushed the player sideways or up.
    assert.ok(Math.hypot(state.x - point.x, state.z - point.z) < 0.01, `${at} pushed aside`);
    assert.ok(Math.abs(state.y - point.y) < 0.05, `${at} settled at y = ${state.y}`);
    assert.equal(state.grounded, true, `${at} is not on the ground`);
    assert.ok(Math.max(Math.abs(point.x), Math.abs(point.z)) < PLAY_HALF_SIZE - PLAYER_RADIUS);
  }
});

test("the houses around the edge have no gaps and reach the play area's edge", () => {
  const inset = 0.5;
  for (let along = -PLAY_HALF_SIZE + inset; along <= PLAY_HALF_SIZE - inset; along += 0.5) {
    for (const height of [0.5, 1.5, 3]) {
      const edges = [
        castWorldRay(world, along, height, -PLAY_HALF_SIZE + inset, 0, 0, -1, 2),
        castWorldRay(world, along, height, PLAY_HALF_SIZE - inset, 0, 0, 1, 2),
        castWorldRay(world, -PLAY_HALF_SIZE + inset, height, along, -1, 0, 0, 2),
        castWorldRay(world, PLAY_HALF_SIZE - inset, height, along, 1, 0, 0, 2),
      ];
      // Shorter is fine: some houses inside the arena are built right up against the edge.
      for (const distance of edges) {
        assert.ok(distance < inset + 0.01, `gap near ${along} at height ${height}`);
      }
    }
  }
});
