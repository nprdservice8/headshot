import {
  FOOTSTEP_MAX_DISTANCE,
  FOOTSTEP_MIN_SPEED,
  JUMP_SOUND_GAIN,
  LANDING_HARD_SPEED,
  LANDING_MAX_GAIN,
  LANDING_MIN_GAIN,
  LANDING_SOFT_SPEED,
  OTHER_FOOTSTEP_GAIN,
  OWN_FOOTSTEP_GAIN,
  SPRINT_FOOTSTEP_GAIN,
  SPRINT_SPEED,
  SPRINT_STRIDE,
  WALK_SPEED,
  WALK_STRIDE,
} from "../shared/constants.ts";
import { clamp, lerp } from "../shared/math.ts";
import { GROUND_PATCHES } from "../shared/world.ts";
import { playFootstep, playJump, playLanding, type SoundPlacement, type Surface } from "./audio.ts";

// Footsteps, jumps and landings for you and for the players you can hear. A step sounds every
// stride length of ground covered, on the surface under the walker; leaving the ground upwards
// is a jump, and coming back down is a landing that gets louder the harder it is.

/** Faster than this up or down counts as off the ground for other players, whose grounded flag
 * isn't sent (the same threshold characters.ts animates by). */
const AIRBORNE_SPEED = 3.5;
/** A jump in position bigger than this in one frame is a respawn, not movement. */
const MAX_FRAME_STEP = 1;
/** Anyone this far above the ground patches is standing on something built, which sounds hard. */
const RAISED_GROUND = 0.3;

type Walker = {
  x: number;
  y: number;
  z: number;
  /** Ground covered since the last step. */
  travelled: number;
  airborne: boolean;
  /** The fastest descent seen while airborne, which sets how hard the landing sounds. */
  fallSpeed: number;
  seen: boolean;
};

function createWalker(): Walker {
  return { x: 0, y: 0, z: 0, travelled: 0, airborne: false, fallSpeed: 0, seen: false };
}

const own = createWalker();
const others = new Map<number, Walker>();
/** Reused for every placed footfall, so hearing someone run never allocates. */
const placement: SoundPlacement = {
  x: 0,
  y: 0,
  z: 0,
  listenerX: 0,
  listenerY: 0,
  listenerZ: 0,
  listenerYaw: 0,
  maxDistance: FOOTSTEP_MAX_DISTANCE,
};

/** What the ground sounds like at a point: the last ground patch listed there wins, as it does
 * when the map is painted, and anything above the patches is stone. */
function surfaceAt(x: number, y: number, z: number): Surface {
  if (y > RAISED_GROUND) return "step-stone";
  let surface: Surface = "step-stone";
  for (const patch of GROUND_PATCHES) {
    if (Math.abs(x - patch.x) > patch.hx || Math.abs(z - patch.z) > patch.hz) continue;
    surface = patch.surface === "dirt" ? "step-dirt" : "step-stone";
  }
  return surface;
}

function landingGain(fallSpeed: number): number {
  const hardness = clamp(
    (fallSpeed - LANDING_SOFT_SPEED) / (LANDING_HARD_SPEED - LANDING_SOFT_SPEED),
    0,
    1,
  );
  return lerp(LANDING_MIN_GAIN, LANDING_MAX_GAIN, hardness);
}

/** Stride at this speed: a walk's at walking speed, a sprint's at sprinting speed, in between
 * for anything else. */
function strideAt(speed: number): number {
  const t = clamp((speed - WALK_SPEED) / (SPRINT_SPEED - WALK_SPEED), 0, 1);
  return lerp(WALK_STRIDE, SPRINT_STRIDE, t);
}

/** Your own feet, once per fixed tick, from the predicted movement state. */
export function updateOwnFootsteps(
  x: number,
  y: number,
  z: number,
  vx: number,
  vy: number,
  vz: number,
  grounded: boolean,
  sprinting: boolean,
  alive: boolean,
  dt: number,
): void {
  if (!alive) {
    own.airborne = false;
    own.travelled = 0;
    return;
  }
  if (grounded) {
    if (own.airborne) {
      playLanding(surfaceAt(x, y, z), landingGain(own.fallSpeed), null);
      own.airborne = false;
      own.travelled = 0;
    }
    const speed = Math.hypot(vx, vz);
    if (speed < FOOTSTEP_MIN_SPEED) return;
    own.travelled += speed * dt;
    if (own.travelled < strideAt(speed)) return;
    own.travelled = 0;
    playFootstep(surfaceAt(x, y, z), sprinting ? SPRINT_FOOTSTEP_GAIN : OWN_FOOTSTEP_GAIN, null);
    return;
  }
  if (!own.airborne) {
    own.airborne = true;
    own.fallSpeed = 0;
    // Going up means a jump; stepping off a ledge is silent until the landing.
    if (vy > 0) playJump(surfaceAt(x, y, z), JUMP_SOUND_GAIN, null);
  }
  own.fallSpeed = Math.max(own.fallSpeed, -vy);
}

/** Another player's feet, once per frame, from where they are drawn. Their grounded flag isn't
 * sent, so it is read off their vertical motion like the animation does. */
export function updateOtherFootsteps(
  id: number,
  x: number,
  y: number,
  z: number,
  alive: boolean,
  dt: number,
  listenerX: number,
  listenerY: number,
  listenerZ: number,
  listenerYaw: number,
): void {
  let walker = others.get(id);
  if (!walker) {
    walker = createWalker();
    others.set(id, walker);
  }
  walker.seen = true;
  placement.x = x;
  placement.y = y;
  placement.z = z;
  placement.listenerX = listenerX;
  placement.listenerY = listenerY;
  placement.listenerZ = listenerZ;
  placement.listenerYaw = listenerYaw;
  const dx = x - walker.x;
  const dy = y - walker.y;
  const dz = z - walker.z;
  walker.x = x;
  walker.y = y;
  walker.z = z;
  const step = Math.hypot(dx, dy, dz);
  if (!alive || dt <= 0 || step > MAX_FRAME_STEP) {
    walker.airborne = false;
    walker.travelled = 0;
    return;
  }
  const verticalSpeed = dy / dt;
  if (Math.abs(verticalSpeed) > AIRBORNE_SPEED) {
    if (!walker.airborne) {
      walker.airborne = true;
      walker.fallSpeed = 0;
      if (verticalSpeed > 0) playJump(surfaceAt(x, y, z), JUMP_SOUND_GAIN, placement);
    }
    walker.fallSpeed = Math.max(walker.fallSpeed, -verticalSpeed);
    return;
  }
  if (walker.airborne) {
    walker.airborne = false;
    walker.travelled = 0;
    playLanding(surfaceAt(x, y, z), landingGain(walker.fallSpeed), placement);
    return;
  }
  const speed = Math.hypot(dx, dz) / dt;
  if (speed < FOOTSTEP_MIN_SPEED) return;
  walker.travelled += speed * dt;
  if (walker.travelled < strideAt(speed)) return;
  walker.travelled = 0;
  const gain = speed > WALK_SPEED + 0.5 ? SPRINT_FOOTSTEP_GAIN : OTHER_FOOTSTEP_GAIN;
  playFootstep(surfaceAt(x, y, z), gain, placement);
}

/** Call once per frame after every updateOtherFootsteps: forgets players no longer drawn. */
export function forgetUnseenWalkers(): void {
  for (const [id, walker] of others) {
    if (walker.seen) {
      walker.seen = false;
      continue;
    }
    others.delete(id);
  }
}
