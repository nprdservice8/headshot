import {
  EXPLOSION_KNOCKBACK,
  EXPLOSION_MAX_DAMAGE,
  EXPLOSION_RADIUS,
  HISTORY_TICKS,
} from "./constants.ts";
import { clamp, lerp } from "./math.ts";

export type Vec3 = { x: number; y: number; z: number };

/** Unit vector for a view direction. Yaw 0 looks down -Z; positive pitch looks up. */
export function viewDirection(yaw: number, pitch: number, out: Vec3): void {
  const cosPitch = Math.cos(pitch);
  out.x = -Math.sin(yaw) * cosPitch;
  out.y = Math.sin(pitch);
  out.z = -Math.cos(yaw) * cosPitch;
}

/** Distance along a normalized ray to a sphere, or Infinity on a miss. 0 if the ray starts inside. */
export function rayHitsSphere(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  cx: number,
  cy: number,
  cz: number,
  radius: number,
): number {
  const lx = ox - cx;
  const ly = oy - cy;
  const lz = oz - cz;
  const b = lx * dx + ly * dy + lz * dz;
  const c = lx * lx + ly * ly + lz * lz - radius * radius;
  if (c <= 0) return 0;
  const h = b * b - c;
  if (h < 0) return Number.POSITIVE_INFINITY;
  const t = -b - Math.sqrt(h);
  return t >= 0 ? t : Number.POSITIVE_INFINITY;
}

/** Distance along a normalized ray to an upright capsule, or Infinity on a miss. */
export function rayHitsUprightCapsule(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  cx: number,
  cz: number,
  bottomY: number,
  topY: number,
  radius: number,
): number {
  let best = Math.min(
    rayHitsSphere(ox, oy, oz, dx, dy, dz, cx, bottomY, cz, radius),
    rayHitsSphere(ox, oy, oz, dx, dy, dz, cx, topY, cz, radius),
  );
  // Cylinder side: a circle test in the XZ plane, kept only if the hit height is between the caps.
  const px = ox - cx;
  const pz = oz - cz;
  const a = dx * dx + dz * dz;
  if (a > 1e-9) {
    const b = px * dx + pz * dz;
    const c = px * px + pz * pz - radius * radius;
    const h = b * b - a * c;
    if (h >= 0) {
      // c <= 0 means the ray starts inside the infinite cylinder.
      const t = c <= 0 ? 0 : (-b - Math.sqrt(h)) / a;
      const y = oy + dy * t;
      if (t >= 0 && y >= bottomY && y <= topY) {
        best = Math.min(best, t);
      }
    }
  }
  return best;
}

export function explosionDamage(distance: number): number {
  if (distance >= EXPLOSION_RADIUS) return 0;
  return Math.round(EXPLOSION_MAX_DAMAGE * (1 - distance / EXPLOSION_RADIUS));
}

export function explosionKnockback(distance: number): number {
  if (distance >= EXPLOSION_RADIUS) return 0;
  return EXPLOSION_KNOCKBACK * (1 - distance / EXPLOSION_RADIUS);
}

/** Where a player's feet were on each recent tick, in ring buffers indexed by tick. */
export type PositionHistory = { x: Float32Array; y: Float32Array; z: Float32Array };

export function createHistory(): PositionHistory {
  return {
    x: new Float32Array(HISTORY_TICKS),
    y: new Float32Array(HISTORY_TICKS),
    z: new Float32Array(HISTORY_TICKS),
  };
}

export function recordHistory(
  history: PositionHistory,
  tick: number,
  x: number,
  y: number,
  z: number,
): void {
  const i = tick % HISTORY_TICKS;
  history.x[i] = x;
  history.y[i] = y;
  history.z[i] = z;
}

/**
 * Position at a possibly fractional `tick`, interpolated between recorded ticks.
 * `tick` is clamped to what the buffer still holds, ending at `newestTick`.
 */
export function sampleHistory(
  history: PositionHistory,
  newestTick: number,
  tick: number,
  out: Vec3,
): void {
  const clamped = clamp(tick, Math.max(0, newestTick - HISTORY_TICKS + 2), newestTick);
  const tick0 = Math.floor(clamped);
  const tick1 = Math.min(tick0 + 1, newestTick);
  const t = clamped - tick0;
  const i0 = tick0 % HISTORY_TICKS;
  const i1 = tick1 % HISTORY_TICKS;
  out.x = lerp(history.x[i0] ?? 0, history.x[i1] ?? 0, t);
  out.y = lerp(history.y[i0] ?? 0, history.y[i1] ?? 0, t);
  out.z = lerp(history.z[i0] ?? 0, history.z[i1] ?? 0, t);
}
