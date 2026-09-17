import type { RigidBody, World } from "@dimforge/rapier3d-compat";
import RAPIER from "@dimforge/rapier3d-compat";
import { Mesh, Quaternion, Vector3 } from "three";
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
import { ARM, HEAD, LEG, type PlayerView, scene, TORSO } from "./render.ts";

// Ragdolls only exist in this browser. They never affect gameplay, so they are never networked.

const RAGDOLL_GROUPS = collisionGroups(GROUP_RAGDOLL, GROUP_WORLD);
const PART_DENSITY = 1;
const PART_FRICTION = 0.9;
const PART_RESTITUTION = 0.05;
const LINEAR_DAMPING = 0.05;
const ANGULAR_DAMPING = 0.8;
const BLAST_LIFT = 0.5;

type Part = { body: RigidBody; mesh: Mesh };
export type Ragdoll = { parts: Part[]; createdMs: number };

const ragdolls: Ragdoll[] = [];
let world: World | null = null;

const position = new Vector3();
const rotation = new Quaternion();
const bodyPosition = { x: 0, y: 0, z: 0 };
const bodyRotation = { x: 0, y: 0, z: 0, w: 1 };
const bodyVelocity = { x: 0, y: 0, z: 0 };

export function initRagdolls(clientWorld: World): void {
  world = clientWorld;
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
  view.root.updateMatrixWorld(true);
  const createPart = (source: Mesh, hx: number, hy: number, hz: number, offsetY: number): Part => {
    source.getWorldPosition(position);
    source.getWorldQuaternion(rotation);
    const body = physics.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(position.x, position.y, position.z)
        .setRotation(rotation)
        .setLinvel(velocityX, velocityY, velocityZ)
        .setLinearDamping(LINEAR_DAMPING)
        .setAngularDamping(ANGULAR_DAMPING),
    );
    physics.createCollider(
      RAPIER.ColliderDesc.cuboid(hx, hy, hz)
        .setTranslation(0, offsetY, 0)
        .setDensity(PART_DENSITY)
        .setFriction(PART_FRICTION)
        .setRestitution(PART_RESTITUTION)
        .setCollisionGroups(RAGDOLL_GROUPS),
      body,
    );
    const mesh = new Mesh(source.geometry, source.material);
    scene.add(mesh);
    return { body, mesh };
  };

  const torso = createPart(view.torso, TORSO.width / 2, TORSO.height / 2, TORSO.depth / 2, 0);
  const head = createPart(view.head, HEAD.size / 2, HEAD.size / 2, HEAD.size / 2, 0);
  const armLeft = createPart(
    view.armLeft,
    ARM.width / 2,
    ARM.length / 2,
    ARM.width / 2,
    -ARM.length / 2,
  );
  const armRight = createPart(
    view.armRight,
    ARM.width / 2,
    ARM.length / 2,
    ARM.width / 2,
    -ARM.length / 2,
  );
  const legLeft = createPart(
    view.legLeft,
    LEG.width / 2,
    LEG.length / 2,
    LEG.width / 2,
    -LEG.length / 2,
  );
  const legRight = createPart(
    view.legRight,
    LEG.width / 2,
    LEG.length / 2,
    LEG.width / 2,
    -LEG.length / 2,
  );
  armRight.mesh.add(view.gun.clone());

  // Joint anchors are in each body's own frame. Limb bodies sit at their shoulder or hip.
  const joint = (a: Part, b: Part, anchorA: Vec3, anchorB: Vec3) =>
    physics.createImpulseJoint(RAPIER.JointData.spherical(anchorA, anchorB), a.body, b.body, true);
  const torsoTop = TORSO.height / 2;
  joint(
    torso,
    head,
    { x: 0, y: torsoTop, z: 0 },
    { x: 0, y: TORSO.centerY + torsoTop - HEAD.centerY, z: 0 },
  );
  const shoulderY = ARM.shoulderY - TORSO.centerY;
  joint(torso, armLeft, { x: -ARM.shoulderX, y: shoulderY, z: 0 }, { x: 0, y: 0, z: 0 });
  joint(torso, armRight, { x: ARM.shoulderX, y: shoulderY, z: 0 }, { x: 0, y: 0, z: 0 });
  const hipY = LEG.hipY - TORSO.centerY;
  joint(torso, legLeft, { x: -LEG.hipX, y: hipY, z: 0 }, { x: 0, y: 0, z: 0 });
  joint(torso, legRight, { x: LEG.hipX, y: hipY, z: 0 }, { x: 0, y: 0, z: 0 });

  const ragdoll: Ragdoll = {
    parts: [torso, head, armLeft, armRight, legLeft, legRight],
    createdMs: nowMs,
  };
  ragdolls.push(ragdoll);
  while (ragdolls.length > MAX_RAGDOLLS) {
    const oldest = ragdolls.shift();
    if (oldest) removeRagdoll(oldest);
  }
  syncRagdollMeshes();
  return ragdoll;
}

function removeRagdoll(ragdoll: Ragdoll): void {
  for (const part of ragdoll.parts) {
    // Removing a body also removes its collider and joints from the WASM heap.
    world?.removeRigidBody(part.body);
    scene.remove(part.mesh);
  }
  ragdoll.parts.length = 0;
}

/** Runs once per fixed tick: expires old ragdolls and advances the physics. */
export function stepRagdolls(nowMs: number): void {
  if (!world) return;
  while (ragdolls[0] && nowMs - ragdolls[0].createdMs > RAGDOLL_LIFETIME_MS) {
    const expired = ragdolls.shift();
    if (expired) removeRagdoll(expired);
  }
  if (ragdolls.length > 0) world.step();
}

export function syncRagdollMeshes(): void {
  for (const ragdoll of ragdolls) {
    for (const part of ragdoll.parts) {
      part.body.translation(bodyPosition);
      part.body.rotation(bodyRotation);
      part.mesh.position.set(bodyPosition.x, bodyPosition.y, bodyPosition.z);
      part.mesh.quaternion.set(bodyRotation.x, bodyRotation.y, bodyRotation.z, bodyRotation.w);
    }
  }
}

export function blastRagdolls(x: number, y: number, z: number): void {
  for (const ragdoll of ragdolls) {
    for (const part of ragdoll.parts) {
      part.body.translation(bodyPosition);
      const dx = bodyPosition.x - x;
      const dy = bodyPosition.y - y;
      const dz = bodyPosition.z - z;
      const distance = Math.hypot(dx, dy, dz);
      if (distance >= EXPLOSION_RADIUS || distance < 0.01) continue;
      const speed = RAGDOLL_BLAST_SPEED * (1 - distance / EXPLOSION_RADIUS);
      part.body.linvel(bodyVelocity);
      bodyVelocity.x += (dx / distance) * speed;
      bodyVelocity.y += (dy / distance + BLAST_LIFT) * speed;
      bodyVelocity.z += (dz / distance) * speed;
      part.body.setLinvel(bodyVelocity, true);
    }
  }
}

/** Where the torso of a ragdoll is, for the death camera. False once the ragdoll is gone. */
export function ragdollFocus(ragdoll: Ragdoll, out: Vec3): boolean {
  const torso = ragdoll.parts[0];
  if (!torso) return false;
  torso.body.translation(bodyPosition);
  out.x = bodyPosition.x;
  out.y = bodyPosition.y;
  out.z = bodyPosition.z;
  return true;
}
