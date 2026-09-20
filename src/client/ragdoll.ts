import type { RigidBody, World } from "@dimforge/rapier3d-compat";
import RAPIER from "@dimforge/rapier3d-compat";
import { Matrix4, type Object3D, Quaternion, type Scene, Vector3 } from "three";
import type { Vec3 } from "../shared/combat.ts";
import {
  EXPLOSION_RADIUS,
  GROUP_RAGDOLL,
  GROUP_WORLD,
  MAX_RAGDOLLS,
  RAGDOLL_BLAST_SPEED,
  RAGDOLL_LIFETIME_MS,
} from "../shared/constants.ts";
import { collisionGroups } from "../shared/world.ts";
import {
  type CharacterModel,
  createCharacterModel,
  type PlayerView,
  setLook,
} from "./characters.ts";

// Ragdolls only exist in this browser. They never affect gameplay, so they are never networked.
// Each body part is a physics body; every bone of the soldier's skeleton follows the part it
// belongs to, with its world matrix written directly.

const RAGDOLL_GROUPS = collisionGroups(GROUP_RAGDOLL, GROUP_WORLD);
const PART_DENSITY = 1;
const PART_FRICTION = 0.9;
const PART_RESTITUTION = 0.05;
const LINEAR_DAMPING = 0.05;
const ANGULAR_DAMPING = 0.8;
const BLAST_LIFT = 0.5;
const HEAD_LENGTH = 0.22;

/** A body part runs from one bone to another. Names are as three.js loads them (dots removed). */
type PartSpec = { from: string; to: string; radius: number; parent: number };

const PARTS: readonly PartSpec[] = [
  { from: "Hips", to: "Torso", radius: 0.14, parent: -1 },
  { from: "Torso", to: "Neck", radius: 0.15, parent: 0 },
  { from: "Head", to: "", radius: 0.12, parent: 1 },
  { from: "UpperArmL", to: "LowerArmL", radius: 0.055, parent: 1 },
  { from: "LowerArmL", to: "WristL", radius: 0.05, parent: 3 },
  { from: "UpperArmR", to: "LowerArmR", radius: 0.055, parent: 1 },
  { from: "LowerArmR", to: "WristR", radius: 0.05, parent: 5 },
  { from: "UpperLegL", to: "LowerLegL", radius: 0.075, parent: 0 },
  { from: "LowerLegL", to: "FootL", radius: 0.06, parent: 7 },
  { from: "UpperLegR", to: "LowerLegR", radius: 0.075, parent: 0 },
  { from: "LowerLegR", to: "FootR", radius: 0.06, parent: 9 },
];

export type Ragdoll = CharacterModel & {
  /** For each bone, the index of the part it follows. */
  partOfBone: Int8Array;
  offsets: Matrix4[];
  partMatrices: Matrix4[];
  bodies: RigidBody[];
  createdMs: number;
  active: boolean;
};

const pool: Ragdoll[] = [];
let world: World | null = null;

const start = new Vector3();
const end = new Vector3();
const axis = new Vector3();
const up = new Vector3(0, 1, 0);
const rotation = new Quaternion();
const inverse = new Matrix4();
const unitScale = new Vector3(1, 1, 1);
const bodyPosition = { x: 0, y: 0, z: 0 };
const bodyRotation = { x: 0, y: 0, z: 0, w: 1 };
const bodyVelocity = { x: 0, y: 0, z: 0 };
const anchor = new Vector3();

function boneIndex(bones: readonly Object3D[], name: string): number {
  const index = bones.findIndex((bone) => bone.name === name);
  if (index < 0) throw new Error(`The character skeleton has no "${name}" bone`);
  return index;
}

/** Which part each bone follows: its nearest ancestor that starts a part. The feet hang off the
 * rig's root rather than the legs, so they are matched to the lower legs by name. */
function mapBones(bones: readonly Object3D[]): Int8Array {
  const partOfBone = new Int8Array(bones.length);
  bones.forEach((bone, index) => {
    const foot = bone.name === "FootL" ? "LowerLegL" : bone.name === "FootR" ? "LowerLegR" : "";
    let part = foot ? PARTS.findIndex((spec) => spec.from === foot) : -1;
    for (let node: Object3D | null = bone; part < 0 && node; node = node.parent) {
      const name = node.name;
      part = PARTS.findIndex((spec) => spec.from === name);
    }
    partOfBone[index] = Math.max(part, 0);
  });
  return partOfBone;
}

export function initRagdolls(clientWorld: World, scene: Scene): void {
  world = clientWorld;
  for (let i = 0; i < MAX_RAGDOLLS; i++) {
    const character = createCharacterModel("general");
    character.model.visible = false;
    for (const bone of character.bones) {
      // The physics writes these matrices; three.js must not recompute them from the hierarchy.
      bone.matrixAutoUpdate = false;
      bone.matrixWorldAutoUpdate = false;
    }
    character.model.traverse((object) => {
      // The skinned mesh stays where it was created while its bones fly around.
      object.frustumCulled = false;
    });
    scene.add(character.model);
    pool.push({
      ...character,
      partOfBone: mapBones(character.bones),
      offsets: character.bones.map(() => new Matrix4()),
      partMatrices: PARTS.map(() => new Matrix4()),
      bodies: [],
      createdMs: 0,
      active: false,
    });
  }
}

function worldPosition(bones: readonly Object3D[], name: string, out: Vector3): Vector3 {
  const bone = bones[boneIndex(bones, name)];
  if (!bone) throw new Error(`Missing bone ${name}`);
  return out.setFromMatrixPosition(bone.matrixWorld);
}

/** Replaces a player's pose with a physics ragdoll moving at the given velocity. */
export function spawnRagdoll(
  view: PlayerView,
  velocityX: number,
  velocityY: number,
  velocityZ: number,
  nowMs: number,
): Ragdoll | null {
  const physics = world;
  if (!physics) return null;
  let ragdoll = pool.find((candidate) => !candidate.active);
  if (!ragdoll) {
    ragdoll = pool.reduce((a, b) => (a.createdMs <= b.createdMs ? a : b));
    removeRagdoll(ragdoll);
  }
  view.root.updateMatrixWorld(true);
  const source = view.bones;

  PARTS.forEach((spec, index) => {
    worldPosition(source, spec.from, start);
    if (spec.to) {
      worldPosition(source, spec.to, end);
    } else {
      // The head has no bone past it: extend along the head bone's own up direction.
      const head = source[boneIndex(source, spec.from)];
      if (head) end.set(0, HEAD_LENGTH, 0).applyMatrix4(head.matrixWorld);
    }
    axis.subVectors(end, start);
    const length = axis.length();
    rotation.setFromUnitVectors(up, axis.normalize());
    const middle = anchor.addVectors(start, end).multiplyScalar(0.5);
    const body = physics.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(middle.x, middle.y, middle.z)
        .setRotation(rotation)
        .setLinvel(velocityX, velocityY, velocityZ)
        .setLinearDamping(LINEAR_DAMPING)
        .setAngularDamping(ANGULAR_DAMPING),
    );
    const halfHeight = Math.max(0.01, length / 2 - spec.radius);
    physics.createCollider(
      RAPIER.ColliderDesc.capsule(halfHeight, spec.radius)
        .setDensity(PART_DENSITY)
        .setFriction(PART_FRICTION)
        .setRestitution(PART_RESTITUTION)
        .setCollisionGroups(RAGDOLL_GROUPS),
      body,
    );
    ragdoll.bodies[index] = body;
    ragdoll.partMatrices[index]?.compose(middle, rotation, unitScale);
    if (spec.parent >= 0) joinParts(ragdoll, spec.parent, index, start);
  });

  source.forEach((bone, index) => {
    const part = ragdoll.partMatrices[ragdoll.partOfBone[index] ?? 0];
    const offset = ragdoll.offsets[index];
    if (part && offset) offset.copy(inverse.copy(part).invert()).multiply(bone.matrixWorld);
  });
  setLook(ragdoll, view.look);
  ragdoll.model.visible = true;
  ragdoll.createdMs = nowMs;
  ragdoll.active = true;
  syncRagdoll(ragdoll);
  return ragdoll;
}

/** A ball joint where the child part starts, given in each body's own frame. */
function joinParts(ragdoll: Ragdoll, parentIndex: number, childIndex: number, at: Vector3): void {
  const parent = ragdoll.bodies[parentIndex];
  const child = ragdoll.bodies[childIndex];
  const parentMatrix = ragdoll.partMatrices[parentIndex];
  const childMatrix = ragdoll.partMatrices[childIndex];
  if (!world || !parent || !child || !parentMatrix || !childMatrix) return;
  const inParent = at.clone().applyMatrix4(inverse.copy(parentMatrix).invert());
  const inChild = at.clone().applyMatrix4(inverse.copy(childMatrix).invert());
  world.createImpulseJoint(RAPIER.JointData.spherical(inParent, inChild), parent, child, true);
}

function removeRagdoll(ragdoll: Ragdoll): void {
  // Removing a body also removes its collider and joints from the WASM heap.
  for (const body of ragdoll.bodies) world?.removeRigidBody(body);
  ragdoll.bodies.length = 0;
  ragdoll.model.visible = false;
  ragdoll.active = false;
}

/** Runs once per fixed tick: expires old ragdolls and advances the physics. */
export function stepRagdolls(nowMs: number): void {
  if (!world) return;
  let anyActive = false;
  for (const ragdoll of pool) {
    if (!ragdoll.active) continue;
    if (nowMs - ragdoll.createdMs > RAGDOLL_LIFETIME_MS) removeRagdoll(ragdoll);
    else anyActive = true;
  }
  if (anyActive) world.step();
}

function syncRagdoll(ragdoll: Ragdoll): void {
  for (let i = 0; i < ragdoll.bodies.length; i++) {
    const body = ragdoll.bodies[i];
    if (!body) continue;
    body.translation(bodyPosition);
    body.rotation(bodyRotation);
    anchor.set(bodyPosition.x, bodyPosition.y, bodyPosition.z);
    rotation.set(bodyRotation.x, bodyRotation.y, bodyRotation.z, bodyRotation.w);
    ragdoll.partMatrices[i]?.compose(anchor, rotation, unitScale);
  }
  for (let i = 0; i < ragdoll.bones.length; i++) {
    const bone = ragdoll.bones[i];
    const part = ragdoll.partMatrices[ragdoll.partOfBone[i] ?? 0];
    const offset = ragdoll.offsets[i];
    if (bone && part && offset) bone.matrixWorld.multiplyMatrices(part, offset);
  }
}

export function syncRagdollMeshes(): void {
  for (const ragdoll of pool) {
    if (ragdoll.active) syncRagdoll(ragdoll);
  }
}

export function blastRagdolls(x: number, y: number, z: number): void {
  for (const ragdoll of pool) {
    if (!ragdoll.active) continue;
    for (const body of ragdoll.bodies) {
      body.translation(bodyPosition);
      const dx = bodyPosition.x - x;
      const dy = bodyPosition.y - y;
      const dz = bodyPosition.z - z;
      const distance = Math.hypot(dx, dy, dz);
      if (distance >= EXPLOSION_RADIUS || distance < 0.01) continue;
      const speed = RAGDOLL_BLAST_SPEED * (1 - distance / EXPLOSION_RADIUS);
      body.linvel(bodyVelocity);
      bodyVelocity.x += (dx / distance) * speed;
      bodyVelocity.y += (dy / distance + BLAST_LIFT) * speed;
      bodyVelocity.z += (dz / distance) * speed;
      body.setLinvel(bodyVelocity, true);
    }
  }
}

/** Where the torso of a ragdoll is, for the death camera. False once the ragdoll is gone. */
export function ragdollFocus(ragdoll: Ragdoll, out: Vec3): boolean {
  const torso = ragdoll.bodies[1];
  if (!ragdoll.active || !torso) return false;
  torso.translation(bodyPosition);
  out.x = bodyPosition.x;
  out.y = bodyPosition.y;
  out.z = bodyPosition.z;
  return true;
}
