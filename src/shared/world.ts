import type { World } from "@dimforge/rapier3d-compat";
import RAPIER from "@dimforge/rapier3d-compat";
import { GROUP_ALL, GROUP_WORLD, TICK_SEC, WORLD_GRAVITY } from "./constants.ts";

/** A solid box. `yaw` turns it around Y, then `tilt` leans it around its own X axis (for ramps). */
export type SolidBox = {
  x: number;
  y: number;
  z: number;
  hx: number;
  hy: number;
  hz: number;
  yaw: number;
  tilt: number;
};

/** What a box is, which decides how the map builder (art/map.py) dresses it. */
export type ArenaKind =
  | "floor"
  | "wall"
  | "platform"
  | "ramp"
  | "cover"
  | "crate"
  | "step"
  | "pillar";

export type ArenaBox = SolidBox & { kind: ArenaKind };

export type SpawnPoint = { x: number; y: number; z: number; yaw: number };

export type Quat = { x: number; y: number; z: number; w: number };

const RAMP_THICKNESS = 0.3;

function box(
  x: number,
  y: number,
  z: number,
  hx: number,
  hy: number,
  hz: number,
  kind: ArenaKind,
): ArenaBox {
  return { x, y, z, hx, hy, hz, yaw: 0, tilt: 0, kind };
}

/** A ramp whose top surface starts on the ground at (x, z) and rises `height` over `length` toward `yaw`. */
export function ramp(
  x: number,
  z: number,
  yaw: number,
  length: number,
  height: number,
  width: number,
): ArenaBox {
  const tilt = -Math.atan2(height, length);
  const hy = RAMP_THICKNESS / 2;
  // Box centre = middle of the top surface, pushed down along the surface normal by half the thickness.
  const normalY = Math.cos(tilt);
  const normalForward = Math.sin(tilt);
  const topX = x + (Math.sin(yaw) * length) / 2;
  const topZ = z + (Math.cos(yaw) * length) / 2;
  return {
    x: topX - Math.sin(yaw) * normalForward * hy,
    y: height / 2 - normalY * hy,
    z: topZ - Math.cos(yaw) * normalForward * hy,
    hx: width / 2,
    hy,
    hz: Math.hypot(length, height) / 2,
    yaw,
    tilt,
    kind: "ramp",
  };
}

export const ARENA_HALF_SIZE = 20;

export const ARENA_BOXES: readonly ArenaBox[] = [
  box(0, -0.5, 0, ARENA_HALF_SIZE, 0.5, ARENA_HALF_SIZE, "floor"),
  box(0, 2.5, -20.5, 21, 2.5, 0.5, "wall"),
  box(0, 2.5, 20.5, 21, 2.5, 0.5, "wall"),
  box(-20.5, 2.5, 0, 0.5, 2.5, 21, "wall"),
  box(20.5, 2.5, 0, 0.5, 2.5, 21, "wall"),
  // Central platform, reached by two ramps
  box(0, 1, 0, 4, 1, 4, "platform"),
  ramp(0, 8, Math.PI, 4, 2, 3),
  ramp(0, -8, 0, 4, 2, 3),
  // Corner platforms
  box(-14, 0.75, -14, 4, 0.75, 4, "platform"),
  ramp(-7, -14, -Math.PI / 2, 3, 1.5, 2.5),
  box(14, 0.75, 14, 4, 0.75, 4, "platform"),
  ramp(7, 14, Math.PI / 2, 3, 1.5, 2.5),
  // Cover walls
  box(-10, 1.25, 6, 0.4, 1.25, 3, "cover"),
  box(10, 1.25, -6, 0.4, 1.25, 3, "cover"),
  box(6, 1.25, 12, 3, 1.25, 0.4, "cover"),
  box(-6, 1.25, -12, 3, 1.25, 0.4, "cover"),
  { ...box(0, 1, 14, 1.5, 1, 0.4, "cover"), yaw: 0.6 },
  { ...box(0, 1, -14.5, 1.5, 1, 0.4, "cover"), yaw: -0.6 },
  // Crates
  box(12, 0.6, 4, 0.6, 0.6, 0.6, "crate"),
  box(-12, 0.6, -4, 0.6, 0.6, 0.6, "crate"),
  box(4, 0.6, -16, 0.6, 0.6, 0.6, "crate"),
  box(-4, 0.6, 16, 0.6, 0.6, 0.6, "crate"),
  // Low steps the player walks up without jumping
  box(15, 0.15, -13, 2, 0.15, 2, "step"),
  box(15, 0.45, -13, 1.2, 0.15, 1.2, "step"),
  // Pillars
  box(-15, 2, 8, 0.8, 2, 0.8, "pillar"),
  box(15, 2, -4, 0.8, 2, 0.8, "pillar"),
];

function spawn(x: number, y: number, z: number): SpawnPoint {
  return { x, y, z, yaw: Math.atan2(x, z) };
}

export const SPAWN_POINTS: readonly SpawnPoint[] = [
  spawn(-17, 0, 17),
  spawn(17, 0, -17),
  spawn(-17, 0, 0),
  spawn(17, 0, 3),
  spawn(0, 0, 17.5),
  spawn(0, 0, -17.5),
  spawn(-14, 1.5, -14),
  spawn(14, 1.5, 14),
];

/** Yaw around Y followed by tilt around the local X axis. */
export function boxRotation(yaw: number, tilt: number): Quat {
  const sy = Math.sin(yaw / 2);
  const cy = Math.cos(yaw / 2);
  const sx = Math.sin(tilt / 2);
  const cx = Math.cos(tilt / 2);
  return { x: cy * sx, y: sy * cx, z: -sy * sx, w: cy * cx };
}

/** Packs Rapier interaction groups: membership in the high 16 bits, filter in the low 16. */
export function collisionGroups(membership: number, filter: number): number {
  return ((membership << 16) | filter) >>> 0;
}

const SOLID_GROUPS = collisionGroups(GROUP_WORLD, GROUP_ALL);
export const WORLD_ONLY_QUERY = collisionGroups(GROUP_ALL, GROUP_WORLD);

/** Builds a physics world containing the static arena. Call after `RAPIER.init()`. */
export function createArenaWorld(): World {
  const world = new RAPIER.World({ x: 0, y: -WORLD_GRAVITY, z: 0 });
  world.timestep = TICK_SEC;
  for (const b of ARENA_BOXES) addSolidBox(world, b);
  // Builds the broad phase so scene queries see the arena before the first real step.
  world.step();
  return world;
}

export function addSolidBox(world: World, b: SolidBox): void {
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(b.hx, b.hy, b.hz)
      .setTranslation(b.x, b.y, b.z)
      .setRotation(boxRotation(b.yaw, b.tilt))
      .setCollisionGroups(SOLID_GROUPS),
  );
}

const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });

/** Distance along a normalized ray to the first arena surface, or `maxDistance` if nothing is hit. */
export function castWorldRay(
  world: World,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxDistance: number,
): number {
  ray.origin.x = ox;
  ray.origin.y = oy;
  ray.origin.z = oz;
  ray.dir.x = dx;
  ray.dir.y = dy;
  ray.dir.z = dz;
  const hit = world.castRay(ray, maxDistance, true, undefined, WORLD_ONLY_QUERY);
  return hit === null ? maxDistance : hit.timeOfImpact;
}
