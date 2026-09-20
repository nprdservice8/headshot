import assert from "node:assert/strict";
import { test } from "node:test";
import { Group, type Object3D, Points, Scene, Sprite } from "three";
import { EXPLOSION_EFFECT_MS } from "../shared/constants.ts";
import {
  applyCameraShake,
  initEffects,
  shakeCamera,
  showExplosion,
  updateEffects,
} from "./effects.ts";

function visible(scene: Scene, kind: new (...args: never[]) => Object3D): number {
  let count = 0;
  scene.traverse((object) => {
    if (object instanceof kind && object.visible) count++;
  });
  return count;
}

test("a blast bursts, flies out and dies away, leaving the pool ready for the next", () => {
  const scene = new Scene();
  initEffects(scene, new Group());
  assert.equal(visible(scene, Sprite), 0);

  showExplosion(0, 1, 0, 1, 0);
  updateEffects(1);
  assert.ok(visible(scene, Sprite) > 10, "core, shockwave, fireballs and smoke all show");
  assert.equal(visible(scene, Points), 1, "sparks show");

  // Halfway through the fire, the fireballs have flown out from the centre and coloured.
  updateEffects(EXPLOSION_EFFECT_MS / 2);
  let flown = 0;
  let orange = 0;
  scene.traverse((object) => {
    if (!(object instanceof Sprite) || !object.visible) return;
    if (object.position.distanceTo({ x: 0, y: 1, z: 0 }) > 0.5) flown++;
    if (object.material.color.r > object.material.color.g + 0.2) orange++;
  });
  assert.ok(flown >= 8, `fireballs and smoke moved out: ${flown}`);
  assert.ok(orange >= 8, `fire is coloured, not white: ${orange}`);

  updateEffects(10_000);
  assert.equal(visible(scene, Sprite), 0, "everything has faded out");
  assert.equal(visible(scene, Points), 0);
});

test("a close blast shakes the camera harder than a far one, and the shake settles", () => {
  const camera = new Group();
  shakeCamera(40, 0);
  applyCameraShake(camera, 10);
  assert.equal(camera.rotation.x, 0, "out of range: no shake");

  shakeCamera(2, 0);
  applyCameraShake(camera, 10);
  const near = Math.abs(camera.rotation.x) + Math.abs(camera.rotation.y);
  assert.ok(near > 0);
  camera.rotation.set(0, 0, 0);
  applyCameraShake(camera, 5000);
  assert.equal(camera.rotation.x, 0, "settled");
});
