import assert from "node:assert/strict";
import { test } from "node:test";
import { Group, Scene, Vector3 } from "three";
import { ROCKET_CONVERGE_DISTANCE } from "../shared/constants.ts";
import { initProjectiles, removeUnseenProjectiles, updateRocketView } from "./projectiles.ts";

function assertNear(position: Vector3, x: number, y: number, z: number): void {
  assert.ok(
    Math.abs(position.x - x) < 1e-9 &&
      Math.abs(position.y - y) < 1e-9 &&
      Math.abs(position.z - z) < 1e-9,
    `expected (${x}, ${y}, ${z}), drawn at ${position.toArray()}`,
  );
}

test("a rocket is drawn leaving the muzzle it was fired from, then slides onto its true path", () => {
  const scene = new Scene();
  initProjectiles(scene, new Group());
  const muzzle = new Vector3(1, -0.5, 0);
  // First seen 2 m out from the eye, flying along +Z.
  assert.equal(updateRocketView(7, 0, 1.6, 2, 0, 0, 1, muzzle), true);
  const drawn = scene.children[0];
  assert.ok(drawn);
  assert.deepEqual(drawn.position.toArray(), [1, -0.5, 0]);

  // Halfway along the converge distance the drawn rocket sits halfway between the muzzle's
  // offset and the true path.
  const halfway = ROCKET_CONVERGE_DISTANCE / 2;
  assert.equal(updateRocketView(7, 0, 1.6, 2 + halfway, 0, 0, 1, null), false);
  assertNear(drawn.position, 0.5, 0.55, 2 + halfway - 1);

  updateRocketView(7, 0, 1.6, 2 + ROCKET_CONVERGE_DISTANCE, 0, 0, 1, null);
  assertNear(drawn.position, 0, 1.6, 2 + ROCKET_CONVERGE_DISTANCE);

  removeUnseenProjectiles();
  removeUnseenProjectiles();
  assert.equal(scene.children.length, 0, "a rocket no longer in snapshots is removed");
});
