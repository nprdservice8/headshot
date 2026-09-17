import type {
  Collider,
  KinematicCharacterController,
  Shape,
  World,
} from "@dimforge/rapier3d-compat";
import RAPIER from "@dimforge/rapier3d-compat";
import {
  AIR_ACCEL,
  CONTROLLER_OFFSET,
  GROUND_ACCEL,
  GROUP_PLAYER,
  GROUP_WORLD,
  JUMP_SPEED,
  MAX_SLOPE_RAD,
  PLAYER_GRAVITY,
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
  SNAP_TO_GROUND,
  STEP_HEIGHT,
  STEP_MIN_WIDTH,
  TICK_SEC,
  WALK_SPEED,
} from "./constants.ts";
import { BUTTON } from "./protocol.ts";
import { collisionGroups } from "./world.ts";

/** Position is the point between the feet. */
export type MoveState = {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  grounded: boolean;
};

/**
 * One capsule collider and character controller shared by every player in a world.
 * Players never collide with each other, so moving a single probe to each player in turn is enough.
 */
export type Mover = {
  world: World;
  controller: KinematicCharacterController;
  collider: Collider;
  /** The capsule grown by the controller offset, for finding surfaces the capsule is too close to. */
  skinShape: Shape;
};

const PLAYER_QUERY = collisionGroups(GROUP_PLAYER, GROUP_WORLD);
const CAPSULE_HALF_HEIGHT = PLAYER_HEIGHT / 2 - PLAYER_RADIUS;

export function createMover(world: World): Mover {
  const collider = world.createCollider(
    RAPIER.ColliderDesc.capsule(CAPSULE_HALF_HEIGHT, PLAYER_RADIUS).setCollisionGroups(
      PLAYER_QUERY,
    ),
  );
  const controller = world.createCharacterController(CONTROLLER_OFFSET);
  controller.setMaxSlopeClimbAngle(MAX_SLOPE_RAD);
  controller.setMinSlopeSlideAngle(MAX_SLOPE_RAD);
  controller.enableAutostep(STEP_HEIGHT, STEP_MIN_WIDTH, false);
  controller.enableSnapToGround(SNAP_TO_GROUND);
  controller.setApplyImpulsesToDynamicBodies(false);
  const skinShape = new RAPIER.Capsule(CAPSULE_HALF_HEIGHT, PLAYER_RADIUS + CONTROLLER_OFFSET);
  return { world, controller, collider, skinShape };
}

export function createMoveState(x: number, y: number, z: number): MoveState {
  return { x, y, z, vx: 0, vy: 0, vz: 0, grounded: false };
}

export function copyMoveState(from: MoveState, to: MoveState): void {
  to.x = from.x;
  to.y = from.y;
  to.z = from.z;
  to.vx = from.vx;
  to.vy = from.vy;
  to.vz = from.vz;
  to.grounded = from.grounded;
}

const probe = { x: 0, y: 0, z: 0 };
const desired = { x: 0, y: 0, z: 0 };
const moved = { x: 0, y: 0, z: 0 };
const push = { x: 0, y: 0, z: 0 };
const IDENTITY_ROTATION = { x: 0, y: 0, z: 0, w: 1 };
const contact = new RAPIER.ShapeContact(
  0,
  { x: 0, y: 0, z: 0 },
  { x: 0, y: 0, z: 0 },
  { x: 0, y: 0, z: 0 },
  { x: 0, y: 0, z: 0 },
);
let pushingCollider: Collider | null = null;

function accumulatePush(surface: Collider): boolean {
  const hit = pushingCollider?.contactCollider(surface, CONTROLLER_OFFSET, contact);
  if (hit && hit.distance < CONTROLLER_OFFSET) {
    const depth = CONTROLLER_OFFSET - hit.distance;
    push.x -= hit.normal1.x * depth;
    push.y -= hit.normal1.y * depth;
    push.z -= hit.normal1.z * depth;
  }
  return true;
}

/**
 * Rapier's controller never moves out of a surface it already touches, so a capsule that lands a
 * hair too deep sinks a little further every tick. This pushes it back out to the controller offset.
 */
function resolvePenetration(mover: Mover, state: MoveState): void {
  push.x = 0;
  push.y = 0;
  push.z = 0;
  pushingCollider = mover.collider;
  mover.world.intersectionsWithShape(
    probe,
    IDENTITY_ROTATION,
    mover.skinShape,
    accumulatePush,
    undefined,
    PLAYER_QUERY,
    mover.collider,
  );
  pushingCollider = null;
  state.x += push.x;
  state.y += push.y;
  state.z += push.z;
  moveProbeTo(mover, state);
}

/** Advances one player by exactly one tick. The server and the predicting client both run this. */
export function stepMovement(mover: Mover, state: MoveState, buttons: number, yaw: number): void {
  let localX = 0;
  let localZ = 0;
  if (buttons & BUTTON.FORWARD) localZ -= 1;
  if (buttons & BUTTON.BACK) localZ += 1;
  if (buttons & BUTTON.LEFT) localX -= 1;
  if (buttons & BUTTON.RIGHT) localX += 1;

  // Yaw 0 looks down -Z, matching the Three.js camera.
  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);
  let wishX = localX * cos + localZ * sin;
  let wishZ = -localX * sin + localZ * cos;
  const wishLength = Math.hypot(wishX, wishZ);
  if (wishLength > 0) {
    wishX /= wishLength;
    wishZ /= wishLength;
  }

  // In the air, letting go of the keys keeps momentum so knockback and jumps carry.
  if (state.grounded || wishLength > 0) {
    const blend = Math.min(1, (state.grounded ? GROUND_ACCEL : AIR_ACCEL) * TICK_SEC);
    state.vx += (wishX * WALK_SPEED - state.vx) * blend;
    state.vz += (wishZ * WALK_SPEED - state.vz) * blend;
  }

  if (state.grounded && buttons & BUTTON.JUMP) {
    state.vy = JUMP_SPEED;
  }
  state.vy -= PLAYER_GRAVITY * TICK_SEC;

  // State can arrive from outside (spawns, server corrections) slightly inside a surface.
  moveProbeTo(mover, state);
  resolvePenetration(mover, state);

  // Horizontal and vertical moves are separate passes: in one combined pass the controller treats
  // the floor it stands on as an obstacle every few ticks and the player stutters.
  desired.x = state.vx * TICK_SEC;
  desired.y = 0;
  desired.z = state.vz * TICK_SEC;
  mover.controller.computeColliderMovement(mover.collider, desired, undefined, PLAYER_QUERY);
  mover.controller.computedMovement(moved);
  state.x += moved.x;
  state.y += moved.y;
  state.z += moved.z;
  const movedX = moved.x;
  const movedZ = moved.z;

  moveProbeTo(mover, state);
  desired.x = 0;
  desired.y = state.vy * TICK_SEC;
  desired.z = 0;
  mover.controller.computeColliderMovement(mover.collider, desired, undefined, PLAYER_QUERY);
  mover.controller.computedMovement(moved);
  state.x += moved.x;
  state.y += moved.y;
  state.z += moved.z;

  const grounded = mover.controller.computedGrounded() && state.vy <= 0;
  // Once more at the end, so the state other code sees (and the network sends) is never inside a wall.
  moveProbeTo(mover, state);
  resolvePenetration(mover, state);
  // In the air, velocity follows what actually happened so walls absorb knockback. On the ground the
  // controller bends movement along slopes, and feeding that back would slow players on every ramp.
  if (!grounded) {
    state.vx = movedX / TICK_SEC;
    state.vz = movedZ / TICK_SEC;
  }
  const hitCeiling = desired.y > 0 && moved.y < desired.y * 0.5;
  if (grounded || hitCeiling) {
    state.vy = 0;
  }
  state.grounded = grounded;
}

function moveProbeTo(mover: Mover, state: MoveState): void {
  probe.x = state.x;
  probe.y = state.y + PLAYER_HEIGHT / 2;
  probe.z = state.z;
  mover.collider.setTranslation(probe);
}
