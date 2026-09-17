import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createHistory,
  explosionDamage,
  rayHitsSphere,
  rayHitsUprightCapsule,
  recordHistory,
  sampleHistory,
  viewDirection,
} from "./combat.ts";
import { EXPLOSION_MAX_DAMAGE, EXPLOSION_RADIUS } from "./constants.ts";

const INF = Number.POSITIVE_INFINITY;

test("viewDirection: yaw 0 looks down -Z, positive pitch looks up", () => {
  const dir = { x: 0, y: 0, z: 0 };
  viewDirection(0, 0, dir);
  assert.ok(Math.abs(dir.z + 1) < 1e-9 && Math.abs(dir.x) < 1e-9);
  viewDirection(0, Math.PI / 4, dir);
  assert.ok(dir.y > 0.7);
  viewDirection(Math.PI / 2, 0, dir);
  assert.ok(Math.abs(dir.x + 1) < 1e-9);
});

test("rayHitsSphere: distance to the near surface, Infinity when missing or behind", () => {
  assert.ok(Math.abs(rayHitsSphere(0, 0, 0, 0, 0, -1, 0, 0, -10, 1) - 9) < 1e-9);
  assert.equal(rayHitsSphere(0, 0, 0, 0, 0, -1, 2, 0, -10, 1), INF);
  assert.equal(rayHitsSphere(0, 0, 0, 0, 0, 1, 0, 0, -10, 1), INF);
  assert.equal(rayHitsSphere(0, 0, -10, 0, 0, -1, 0, 0, -10, 1), 0);
});

test("rayHitsUprightCapsule: side, caps, straight down, and misses", () => {
  // Capsule at x = 0, z = -10 from y = 0.35 to 1.15, radius 0.33.
  const hitSide = rayHitsUprightCapsule(0, 0.8, 0, 0, 0, -1, 0, -10, 0.35, 1.15, 0.33);
  assert.ok(Math.abs(hitSide - 9.67) < 1e-6, `side ${hitSide}`);
  const hitTopCap = rayHitsUprightCapsule(0, 1.3, 0, 0, 0, -1, 0, -10, 0.35, 1.15, 0.33);
  assert.ok(hitTopCap > 9.67 && hitTopCap < 10, `top cap ${hitTopCap}`);
  const hitFromAbove = rayHitsUprightCapsule(0, 5, -10, 0, -1, 0, 0, -10, 0.35, 1.15, 0.33);
  assert.ok(Math.abs(hitFromAbove - (5 - 1.48)) < 1e-6, `from above ${hitFromAbove}`);
  assert.equal(rayHitsUprightCapsule(0, 2, 0, 0, 0, -1, 0, -10, 0.35, 1.15, 0.33), INF);
  assert.equal(rayHitsUprightCapsule(1, 0.8, 0, 0, 0, -1, 0, -10, 0.35, 1.15, 0.33), INF);
  assert.equal(rayHitsUprightCapsule(0, 0.8, 0, 0, 0, 1, 0, -10, 0.35, 1.15, 0.33), INF);
});

test("explosionDamage falls off linearly to zero at the radius", () => {
  assert.equal(explosionDamage(0), EXPLOSION_MAX_DAMAGE);
  assert.equal(explosionDamage(EXPLOSION_RADIUS / 2), Math.round(EXPLOSION_MAX_DAMAGE / 2));
  assert.equal(explosionDamage(EXPLOSION_RADIUS), 0);
  assert.equal(explosionDamage(EXPLOSION_RADIUS * 2), 0);
});

test("sampleHistory interpolates between ticks and clamps to the newest", () => {
  const history = createHistory();
  for (let tick = 100; tick <= 120; tick++) recordHistory(history, tick, tick, 0, -tick);
  const out = { x: 0, y: 0, z: 0 };
  sampleHistory(history, 120, 110.5, out);
  assert.ok(Math.abs(out.x - 110.5) < 1e-4 && Math.abs(out.z + 110.5) < 1e-4);
  sampleHistory(history, 120, 500, out);
  assert.equal(out.x, 120);
});
