import {
  AdditiveBlending,
  BoxGeometry,
  DataTexture,
  Mesh,
  MeshBasicMaterial,
  NormalBlending,
  type Object3D,
  type Scene,
  Sprite,
  SpriteMaterial,
  Vector3,
} from "three";
import {
  EXPLOSION_EFFECT_MS,
  EXPLOSION_RADIUS,
  MUZZLE_FLASH_MS,
  TRACER_LIFETIME_MS,
} from "../shared/constants.ts";
import { clamp } from "../shared/math.ts";

// Short-lived effects. Every one is created up front and reused, so shooting never allocates.

const TEXTURE_SIZE = 64;
const TRACER_POOL_SIZE = 32;
const IMPACT_POOL_SIZE = 24;
const FLASH_POOL_SIZE = 12;
const EXPLOSION_POOL_SIZE = 6;
const SMOKE_PER_EXPLOSION = 6;
const TRACER_THICKNESS = 0.018;
const TRACER_COLOR = 0xffd98a;
const FLASH_COLOR = 0xffc56b;
const FLASH_SIZE = 0.45;
const VIEWMODEL_FLASH_SIZE = 0.28;
const IMPACT_COLOR = 0xb9b1a3;
const IMPACT_MS = 380;
const IMPACT_START_SIZE = 0.15;
const IMPACT_END_SIZE = 0.7;
const FIREBALL_COLOR = 0xff9a3c;
const FIREBALL_END_SIZE = EXPLOSION_RADIUS * 0.9;
const SMOKE_COLOR = 0x5a5550;
const SMOKE_MS = 1600;
const SMOKE_START_SIZE = 1.2;
const SMOKE_END_SIZE = 4.5;
const SMOKE_SPREAD = 1.2;
const SMOKE_RISE = 2.5;
const SMOKE_OPACITY = 0.55;

type Tracer = { mesh: Mesh<BoxGeometry, MeshBasicMaterial>; startMs: number };
type Puff = { sprite: Sprite; startMs: number; x: number; y: number; z: number };
type Explosion = { fireball: Puff; smoke: Puff[]; startMs: number };

const tracers: Tracer[] = [];
const impacts: Puff[] = [];
const flashes: Puff[] = [];
const explosions: Explosion[] = [];
let viewmodelFlash: Sprite | null = null;
let viewmodelFlashHideMs = 0;

const tmpVector = new Vector3();

/** A white texture whose alpha falls off from the centre; `spikes` adds a star shape. */
function glowTexture(spikes: number): DataTexture {
  const data = new Uint8Array(TEXTURE_SIZE * TEXTURE_SIZE * 4);
  for (let y = 0; y < TEXTURE_SIZE; y++) {
    for (let x = 0; x < TEXTURE_SIZE; x++) {
      const dx = (x + 0.5) / TEXTURE_SIZE - 0.5;
      const dy = (y + 0.5) / TEXTURE_SIZE - 0.5;
      const radius = Math.hypot(dx, dy) * 2;
      let alpha = clamp(1 - radius, 0, 1) ** 2;
      if (spikes > 0) {
        const star = Math.abs(Math.cos(Math.atan2(dy, dx) * (spikes / 2))) ** 8;
        alpha = clamp(alpha + star * clamp(1 - radius, 0, 1) ** 3, 0, 1);
      }
      const i = (y * TEXTURE_SIZE + x) * 4;
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = Math.round(alpha * 255);
    }
  }
  const texture = new DataTexture(data, TEXTURE_SIZE, TEXTURE_SIZE);
  texture.needsUpdate = true;
  return texture;
}

function puff(parent: Object3D, map: DataTexture, color: number, additive: boolean): Puff {
  const material = new SpriteMaterial({
    map,
    color,
    transparent: true,
    depthWrite: false,
    blending: additive ? AdditiveBlending : NormalBlending,
  });
  const sprite = new Sprite(material);
  sprite.visible = false;
  parent.add(sprite);
  return { sprite, startMs: 0, x: 0, y: 0, z: 0 };
}

export function initEffects(scene: Scene, viewmodelMuzzle: Object3D): void {
  const soft = glowTexture(0);
  const star = glowTexture(6);
  const tracerGeometry = new BoxGeometry(TRACER_THICKNESS, TRACER_THICKNESS, 1);
  for (let i = 0; i < TRACER_POOL_SIZE; i++) {
    const material = new MeshBasicMaterial({
      color: TRACER_COLOR,
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
    });
    const mesh = new Mesh(tracerGeometry, material);
    mesh.visible = false;
    scene.add(mesh);
    tracers.push({ mesh, startMs: 0 });
  }
  for (let i = 0; i < IMPACT_POOL_SIZE; i++) impacts.push(puff(scene, soft, IMPACT_COLOR, false));
  for (let i = 0; i < FLASH_POOL_SIZE; i++) flashes.push(puff(scene, star, FLASH_COLOR, true));
  for (let i = 0; i < EXPLOSION_POOL_SIZE; i++) {
    const smoke: Puff[] = [];
    for (let j = 0; j < SMOKE_PER_EXPLOSION; j++) smoke.push(puff(scene, soft, SMOKE_COLOR, false));
    explosions.push({ fireball: puff(scene, soft, FIREBALL_COLOR, true), smoke, startMs: 0 });
  }
  const flash = puff(viewmodelMuzzle, star, FLASH_COLOR, true).sprite;
  flash.scale.setScalar(VIEWMODEL_FLASH_SIZE);
  viewmodelFlash = flash;
}

/** The pooled item that has been idle longest. */
function oldest<T extends { startMs: number }>(pool: readonly T[]): T | undefined {
  let pick = pool[0];
  for (const candidate of pool) {
    if (pick && candidate.startMs < pick.startMs) pick = candidate;
  }
  return pick;
}

export function showTracer(
  fromX: number,
  fromY: number,
  fromZ: number,
  toX: number,
  toY: number,
  toZ: number,
  nowMs: number,
): void {
  const tracer = oldest(tracers);
  if (!tracer) return;
  const length = Math.hypot(toX - fromX, toY - fromY, toZ - fromZ);
  tracer.mesh.position.set((fromX + toX) / 2, (fromY + toY) / 2, (fromZ + toZ) / 2);
  tracer.mesh.scale.set(1, 1, length);
  tracer.mesh.lookAt(tmpVector.set(toX, toY, toZ));
  tracer.mesh.visible = true;
  tracer.startMs = nowMs;
}

export function showImpact(x: number, y: number, z: number, nowMs: number): void {
  const impact = oldest(impacts);
  if (!impact) return;
  impact.sprite.position.set(x, y, z);
  impact.sprite.material.rotation = Math.random() * Math.PI * 2;
  impact.sprite.visible = true;
  impact.startMs = nowMs;
}

export function showMuzzleFlash(x: number, y: number, z: number, nowMs: number): void {
  const flash = oldest(flashes);
  if (!flash) return;
  flash.sprite.position.set(x, y, z);
  flash.sprite.scale.setScalar(FLASH_SIZE);
  flash.sprite.material.rotation = Math.random() * Math.PI;
  flash.sprite.visible = true;
  flash.startMs = nowMs;
}

/** `muzzle` is the currently equipped weapon's muzzle point, since it changes as weapons switch. */
export function showViewmodelFlash(nowMs: number, muzzle: Object3D): void {
  if (!viewmodelFlash) return;
  muzzle.add(viewmodelFlash);
  viewmodelFlash.material.rotation = Math.random() * Math.PI;
  viewmodelFlash.visible = true;
  viewmodelFlashHideMs = nowMs + MUZZLE_FLASH_MS;
}

export function showExplosion(x: number, y: number, z: number, nowMs: number): void {
  const explosion = oldest(explosions);
  if (!explosion) return;
  explosion.startMs = nowMs;
  explosion.fireball.sprite.position.set(x, y, z);
  explosion.fireball.sprite.visible = true;
  for (const smoke of explosion.smoke) {
    // Each puff drifts off in its own direction; the numbers only need to look random.
    const angle = Math.random() * Math.PI * 2;
    const spread = Math.random() * SMOKE_SPREAD;
    smoke.x = x + Math.cos(angle) * spread;
    smoke.y = y;
    smoke.z = z + Math.sin(angle) * spread;
    smoke.sprite.material.rotation = Math.random() * Math.PI * 2;
    smoke.sprite.visible = true;
  }
}

export function updateEffects(nowMs: number): void {
  for (const tracer of tracers) {
    if (!tracer.mesh.visible) continue;
    const t = (nowMs - tracer.startMs) / TRACER_LIFETIME_MS;
    if (t >= 1) tracer.mesh.visible = false;
    else tracer.mesh.material.opacity = 1 - t;
  }
  for (const impact of impacts) {
    if (!impact.sprite.visible) continue;
    const t = (nowMs - impact.startMs) / IMPACT_MS;
    if (t >= 1) {
      impact.sprite.visible = false;
      continue;
    }
    impact.sprite.scale.setScalar(IMPACT_START_SIZE + (IMPACT_END_SIZE - IMPACT_START_SIZE) * t);
    impact.sprite.material.opacity = (1 - t) * (1 - t);
  }
  for (const flash of flashes) {
    if (flash.sprite.visible && nowMs - flash.startMs >= MUZZLE_FLASH_MS)
      flash.sprite.visible = false;
  }
  if (viewmodelFlash?.visible && nowMs >= viewmodelFlashHideMs) viewmodelFlash.visible = false;
  for (const explosion of explosions) updateExplosion(explosion, nowMs);
}

function updateExplosion(explosion: Explosion, nowMs: number): void {
  const fireball = explosion.fireball.sprite;
  if (fireball.visible) {
    const t = (nowMs - explosion.startMs) / EXPLOSION_EFFECT_MS;
    if (t >= 1) {
      fireball.visible = false;
    } else {
      const eased = 1 - (1 - t) * (1 - t);
      fireball.scale.setScalar(0.5 + (FIREBALL_END_SIZE - 0.5) * eased);
      fireball.material.opacity = 1 - t;
    }
  }
  for (const smoke of explosion.smoke) {
    if (!smoke.sprite.visible) continue;
    const t = (nowMs - explosion.startMs) / SMOKE_MS;
    if (t >= 1) {
      smoke.sprite.visible = false;
      continue;
    }
    const eased = 1 - (1 - t) * (1 - t);
    smoke.sprite.position.set(smoke.x, smoke.y + SMOKE_RISE * eased, smoke.z);
    smoke.sprite.scale.setScalar(SMOKE_START_SIZE + (SMOKE_END_SIZE - SMOKE_START_SIZE) * eased);
    smoke.sprite.material.opacity = SMOKE_OPACITY * (1 - t) * Math.min(1, t * 8);
  }
}
