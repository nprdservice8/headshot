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
  | "house"
  | "roof"
  | "gate"
  | "ruin"
  | "plinth"
  | "terrace"
  | "stairs"
  | "ramp"
  | "rubble"
  | "shrine"
  | "tier"
  | "spire"
  | "dome"
  | "harmika"
  | "shikhara"
  | "pillar"
  | "sandbags"
  | "crate"
  | "container"
  | "truck"
  | "car"
  | "tent"
  | "platform";

export type ArenaBox = SolidBox & { kind: ArenaKind };

export type SpawnPoint = { x: number; y: number; z: number; yaw: number };

export type Quat = { x: number; y: number; z: number; w: number };

// The map: a war-torn corner of old Kathmandu. A temple square in the middle, four streets out to
// barricaded gates, an army camp, a stupa courtyard, a bazaar and a quarter in ruins, all inside
// a ring of houses that nobody can get past.

/** The floor runs out to here. */
export const ARENA_HALF_SIZE = 75;
/** The inner faces of the houses around the edge. Nothing that moves gets further out. */
export const PLAY_HALF_SIZE = 66;

const RING_DEPTH = ARENA_HALF_SIZE - PLAY_HALF_SIZE;
const RAMP_THICKNESS = 0.3;
/** How far a roof reaches past the walls under it. */
const EAVE = 0.9;
/** Roof rise per metre of run. */
const ROOF_PITCH = 0.55;
const GATE_HEIGHT = 7;
const SANDBAG_HEIGHT = 1.2;
const CRATE_SIZE = 1.2;
const CONTAINER_HEIGHT = 2.6;

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

/** A box standing on the ground, optionally turned. */
function onGround(
  x: number,
  z: number,
  hx: number,
  hz: number,
  height: number,
  kind: ArenaKind,
  yaw = 0,
): ArenaBox {
  return { ...box(x, height / 2, z, hx, height / 2, hz, kind), yaw };
}

/** A ramp whose top surface starts on the ground at (x, z) and rises `height` over `length` toward `yaw`. */
export function ramp(
  x: number,
  z: number,
  yaw: number,
  length: number,
  height: number,
  width: number,
  kind: ArenaKind = "ramp",
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
    kind,
  };
}

/** Brick walls with a hipped tile roof on top, its eaves overhanging the walls. */
function house(
  x: number,
  z: number,
  hx: number,
  hz: number,
  height: number,
  kind: ArenaKind = "house",
): ArenaBox[] {
  const rise = (Math.min(hx, hz) + EAVE) * ROOF_PITCH;
  return [
    box(x, height / 2, z, hx, height / 2, hz, kind),
    box(x, height + rise / 2, z, hx + EAVE, rise / 2, hz + EAVE, "roof"),
  ];
}

/** Square levels, each `rise` tall, narrowing toward the top: a temple plinth or stupa terraces. */
function stepped(
  x: number,
  z: number,
  halves: readonly number[],
  rise: number,
  kind: ArenaKind,
): ArenaBox[] {
  return halves.map((half, level) => box(x, rise * (level + 0.5), z, half, rise / 2, half, kind));
}

/** Stacked from the bottom: [kind, half width, height]. */
function tower(x: number, z: number, base: number, parts: [ArenaKind, number, number][]) {
  let y = base;
  return parts.map(([kind, half, height]) => {
    y += height;
    return box(x, y - height / 2, z, half, height / 2, half, kind);
  });
}

/** Five-level plinth with stairs north and south, and a three-roofed pagoda on top. The stairs
 * are as steep as they can be while still clearing the corner of every level they cross. */
function greatTemple(x: number, z: number): ArenaBox[] {
  return [
    ...stepped(x, z, [10, 8.5, 7, 5.5, 4.5], 0.9, "plinth"),
    ramp(x, z + 11.4, Math.PI, 6.9, 4.5, 3, "stairs"),
    ramp(x, z - 11.4, 0, 6.9, 4.5, 3, "stairs"),
    ...tower(x, z, 4.5, [
      ["shrine", 2.5, 3.2],
      ["tier", 4.2, 1.6],
      ["shrine", 1.9, 1.4],
      ["tier", 3.3, 1.3],
      ["shrine", 1.5, 1.1],
      ["tier", 2.5, 1.2],
      ["spire", 0.35, 1.8],
    ]),
  ];
}

/** A two-roofed pagoda on a three-level plinth, stairs to the south. */
function smallTemple(x: number, z: number): ArenaBox[] {
  return [
    ...stepped(x, z, [3.6, 2.9, 2.2], 0.7, "plinth"),
    ramp(x, z + 4.5, Math.PI, 2.3, 2.1, 1.6, "stairs"),
    ...tower(x, z, 2.1, [
      ["shrine", 1.4, 2.2],
      ["tier", 2.4, 1.2],
      ["shrine", 1, 0.8],
      ["tier", 1.7, 0.9],
      ["spire", 0.25, 0.8],
    ]),
  ];
}

/** A whitewashed dome on three terraces, stairs north and south. */
function stupa(x: number, z: number): ArenaBox[] {
  return [
    ...stepped(x, z, [11, 9, 6.5], 0.8, "terrace"),
    ramp(x, z + 13.2, Math.PI, 4.2, 1.6, 3, "stairs"),
    ramp(x, z - 13.2, 0, 4.2, 1.6, 3, "stairs"),
    ...tower(x, z, 2.4, [
      ["dome", 6.5, 4.2],
      ["harmika", 1.6, 2],
      ["spire", 1.2, 7],
    ]),
  ];
}

/** A stone tower temple in the style of Patan's Krishna Mandir. */
function shikhara(x: number, z: number): ArenaBox[] {
  return [
    ...stepped(x, z, [5, 4, 3], 0.8, "plinth"),
    ramp(x, z + 6.2, Math.PI, 3.2, 2.4, 2, "stairs"),
    ...tower(x, z, 2.4, [
      ["shikhara", 2.2, 11],
      ["spire", 0.3, 1.2],
    ]),
  ];
}

const sandbags = (x: number, z: number, hx: number, hz: number, yaw = 0) =>
  onGround(x, z, hx, hz, SANDBAG_HEIGHT, "sandbags", yaw);
const crate = (x: number, z: number, yaw = 0) =>
  onGround(x, z, CRATE_SIZE / 2, CRATE_SIZE / 2, CRATE_SIZE, "crate", yaw);
/** A 20-foot container, or a 40-foot one when `long`. */
const container = (x: number, z: number, alongX: boolean, long = false) => {
  const length = long ? 6.1 : 3.03;
  return alongX
    ? onGround(x, z, length, 1.22, CONTAINER_HEIGHT, "container")
    : onGround(x, z, 1.22, length, CONTAINER_HEIGHT, "container");
};
const truck = (x: number, z: number, yaw: number) => onGround(x, z, 1.25, 3.9, 3.1, "truck", yaw);
const car = (x: number, z: number, yaw: number) => onGround(x, z, 0.9, 2.1, 1.6, "car", yaw);

const RING_HEIGHTS = [11, 9, 12.5, 8.5, 10.5, 9.5, 12];

/** Houses shoulder to shoulder along one edge of the arena, from `start` onward. */
function edgeRow(
  side: "n" | "s" | "w" | "e",
  start: number,
  widths: readonly number[],
  shift: number,
) {
  const depth = (side === "n" || side === "w" ? -1 : 1) * (PLAY_HALF_SIZE + RING_DEPTH / 2);
  let at = start;
  return widths.flatMap((width, i) => {
    const along = at + width / 2;
    at += width;
    const height = RING_HEIGHTS[(i + shift) % RING_HEIGHTS.length] ?? GATE_HEIGHT;
    return side === "n" || side === "s"
      ? house(along, depth, width / 2, RING_DEPTH / 2, height)
      : house(depth, along, RING_DEPTH / 2, width / 2, height);
  });
}

/** The ring of houses around the arena, broken only by a barricaded gate at the end of each street. */
function ring(): ArenaBox[] {
  // Each list of widths fills a stretch from a corner to a gate, or from a gate to a corner.
  const long = [12, 10, 14, 9, 13, 11];
  const longBack = [11, 13, 9, 14, 10, 12];
  const short = [11, 13, 9, 15, 12];
  const shortBack = [12, 15, 9, 13, 11];
  const middle = PLAY_HALF_SIZE + RING_DEPTH / 2;
  const half = RING_DEPTH / 2;
  return [
    ...edgeRow("n", -ARENA_HALF_SIZE, long, 0),
    ...edgeRow("n", 6, longBack, 3),
    ...edgeRow("s", -ARENA_HALF_SIZE, longBack, 1),
    ...edgeRow("s", 6, long, 4),
    ...edgeRow("w", -PLAY_HALF_SIZE, short, 2),
    ...edgeRow("w", 6, shortBack, 5),
    ...edgeRow("e", -PLAY_HALF_SIZE, shortBack, 3),
    ...edgeRow("e", 6, short, 0),
    ...house(0, -middle, 6, half, GATE_HEIGHT, "gate"),
    ...house(0, middle, 6, half, GATE_HEIGHT, "gate"),
    ...house(-middle, 0, half, 6, GATE_HEIGHT, "gate"),
    ...house(middle, 0, half, 6, GATE_HEIGHT, "gate"),
  ];
}

export const ARENA_BOXES: readonly ArenaBox[] = [
  box(0, -0.5, 0, ARENA_HALF_SIZE, 0.5, ARENA_HALF_SIZE, "floor"),
  ...ring(),

  // Durbar Square (x -30..30, z -24..24), closed in by houses with alleys between them.
  ...house(-24.75, -29, 5.25, 5, 10),
  ...house(-11.75, -29, 5.25, 5, 12.5),
  ...house(11.75, -29, 5.25, 5, 11),
  ...house(24.75, -29, 5.25, 5, 9.5),
  ...house(-24.75, 29, 5.25, 5, 9),
  ...house(-11.75, 29, 5.25, 5, 11),
  ...house(11.75, 29, 5.25, 5, 12),
  ...house(24.75, 29, 5.25, 5, 10),
  ...house(-35, -20.25, 5, 3.75, 11),
  ...house(-35, -10.25, 5, 3.75, 9),
  ...house(-35, 10.25, 5, 3.75, 10),
  ...house(-35, 20.25, 5, 3.75, 12),
  ...house(35, -20.25, 5, 3.75, 12),
  ...house(35, -10.25, 5, 3.75, 9.5),
  ...house(35, 10.25, 5, 3.75, 10.5),
  ...house(35, 20.25, 5, 3.75, 11),
  ...greatTemple(0, 0),
  ...smallTemple(-21, -14),
  ...smallTemple(21, 13),
  onGround(-14, -20, 0.45, 0.45, 8, "pillar"),
  onGround(14, 20, 0.45, 0.45, 8, "pillar"),
  sandbags(-17, 2, 0.45, 2.8),
  sandbags(17, -2, 0.45, 2.8),
  sandbags(-5, 17.5, 2.8, 0.45),
  sandbags(5, -17.5, 2.8, 0.45),
  sandbags(24, -17, 3, 0.45),
  sandbags(21.45, -14.5, 0.45, 2.05),
  sandbags(-24, 17, 3, 0.45),
  sandbags(-21.45, 14.5, 0.45, 2.05),
  truck(-23, 4, 0.3),
  car(24, 4, -0.5),
  crate(12.5, 12),
  crate(-12.5, -12, 0.4),
  crate(-11.2, -12.4, 0.1),
  crate(9, 21.5, 0.3),

  // The four streets out to the gates.
  sandbags(-2.5, -46, 3.5, 0.45),
  sandbags(2.5, -55, 3.5, 0.45),
  truck(3, -40, 0.08),
  crate(-4, -62),
  crate(-2.7, -62.3, 0.3),
  truck(-2.5, 46, -0.12),
  sandbags(2, 56, 4, 0.45),
  car(3, 38, 0.2),
  sandbags(-50, -2, 0.45, 3.5),
  sandbags(-58, 2.5, 0.45, 3.5),
  car(-45, 3, 1.4),
  truck(50, -2, Math.PI / 2 + 0.05),
  sandbags(60, 2, 0.45, 3.5),
  crate(45, 4),
  crate(45.2, 2.7, 0.5),

  // North-west: the army camp on the old parade ground.
  ...house(-11.25, -41, 4.75, 6.5, 10),
  ...house(-11.25, -60.25, 4.75, 5.75, 9),
  ...house(-47, -11.25, 5, 4.75, 11),
  ...house(-60.5, -11.25, 5.5, 4.75, 9),
  ...house(-55, -25, 7, 5, 8),
  box(-44, 0.6, -52, 7, 0.6, 7, "platform"),
  ramp(-44, -42.6, Math.PI, 2.4, 1.2, 4),
  onGround(-60, -46, 2.6, 3.6, 2.8, "tent"),
  onGround(-60, -34, 2.6, 3.6, 2.8, "tent"),
  container(-26, -47, false),
  container(-22, -56, true, true),
  { ...container(-22, -56, true, true), y: CONTAINER_HEIGHT * 1.5 },
  { ...container(-31, -38, false), yaw: 0.3 },
  truck(-35, -62, Math.PI / 2),
  sandbags(-30, -60, 3, 0.45),
  sandbags(-26.55, -61.95, 0.45, 1.5),
  sandbags(-50, -34, 3, 0.45),
  crate(-38, -46),
  crate(-38, -44.7, 0.2),

  // North-east: the stupa courtyard.
  ...house(11.25, -45, 4.75, 7, 11),
  ...house(11.25, -61, 4.75, 5, 9),
  ...house(45, -11.25, 5, 4.75, 9.5),
  ...house(58, -11.25, 5.5, 4.75, 11),
  ...stupa(42, -42),
  sandbags(59, -40, 0.45, 3),
  sandbags(59, -26, 3, 0.45),
  car(24, -48, 0.4),
  crate(58, -58),
  crate(59.3, -58.2, 0.3),
  crate(26, -60),

  // South-east: the bazaar, with a small temple in its own square.
  ...house(11.25, 41, 4.75, 6, 10),
  ...house(11.25, 58.5, 4.75, 7.5, 12),
  ...house(45, 11.25, 5, 4.75, 10),
  ...house(58, 11.25, 5.5, 4.75, 9),
  ...house(25, 42, 5, 5, 11),
  ...house(25, 58, 5, 8, 9.5),
  ...house(37.5, 42, 4.5, 5, 9),
  ...house(37.5, 58, 4.5, 8, 12),
  ...house(49.5, 42, 4.5, 5, 10.5),
  ...house(49.5, 58, 4.5, 8, 9),
  ...house(61.5, 42, 4.5, 5, 12),
  ...house(61.5, 58, 4.5, 8, 10),
  ...smallTemple(52, 26),
  sandbags(40, 27, 0.45, 3),
  car(61, 25, 0.1),
  crate(31.5, 48.5),
  crate(55.5, 52, 0.6),
  crate(43.5, 36),

  // South-west: a quarter in ruins around a stone tower temple.
  ...house(-11.25, 41, 4.75, 6, 9),
  onGround(-11.25, 58.5, 4.75, 7.5, 5.5, "ruin"),
  ...house(-47, 11.25, 5, 4.75, 9),
  onGround(-60.5, 11.25, 5.5, 4.75, 4, "ruin"),
  ...shikhara(-46, 44),
  onGround(-25, 42, 5, 5, 6, "ruin"),
  onGround(-26, 58, 6, 5, 4.5, "ruin"),
  onGround(-60, 30, 5, 6, 5, "ruin"),
  ramp(-36, 30, Math.PI / 2, 3.5, 1.6, 4, "rubble"),
  ramp(-29, 30, -Math.PI / 2, 3.5, 1.6, 4, "rubble"),
  ramp(-19.5, 44, -Math.PI / 2, 3, 1.5, 3, "rubble"),
  ramp(-52, 22, Math.PI, 3, 1.4, 3.5, "rubble"),
  sandbags(-36, 58, 0.45, 3),
  car(-22, 52, 2.6),
  crate(-58, 58),
  crate(-40, 22, 0.2),
];

/** How the ground is surfaced, for the map builder: bare earth unless a patch covers it, later
 * patches over earlier ones. Collision is the flat floor everywhere. */
export type GroundPatch = {
  x: number;
  z: number;
  hx: number;
  hz: number;
  surface: "paving" | "asphalt" | "dirt" | "flagstones";
};

export const GROUND_PATCHES: readonly GroundPatch[] = [
  { x: 0, z: 0, hx: 6, hz: PLAY_HALF_SIZE, surface: "asphalt" },
  { x: 0, z: 0, hx: PLAY_HALF_SIZE, hz: 6, surface: "asphalt" },
  { x: -36, z: -36, hx: 30, hz: 30, surface: "dirt" },
  { x: 42, z: -42, hx: 16, hz: 16, surface: "flagstones" },
  { x: 52, z: 26, hx: 6, hz: 7, surface: "flagstones" },
  { x: -46, z: 44, hx: 8, hz: 9, surface: "flagstones" },
  { x: 0, z: 0, hx: 30, hz: 24, surface: "paving" },
];

function spawn(x: number, y: number, z: number): SpawnPoint {
  return { x, y, z, yaw: Math.atan2(x, z) };
}

export const SPAWN_POINTS: readonly SpawnPoint[] = [
  spawn(-26, 0, -8),
  spawn(26, 0, 8),
  spawn(-8, 0, -20),
  spawn(8, 0, -21),
  spawn(-8, 0, 21),
  spawn(0, 0, -60),
  spawn(0, 0, 62),
  spawn(-62, 0, 0),
  spawn(62, 0, -1),
  spawn(-58, 0, -56),
  spawn(-34, 0, -30),
  spawn(-44, 1.2, -52),
  spawn(24, 0, -42),
  spawn(54, 0, -58),
  spawn(60, 0, -20),
  spawn(43, 0, 22),
  spawn(43.5, 0, 48.5),
  spawn(62, 0, 32),
  spawn(-38, 0, 53),
  spawn(-58, 0, 44),
  spawn(-44, 0, 30),
  spawn(-2, 0, 35.5),
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
