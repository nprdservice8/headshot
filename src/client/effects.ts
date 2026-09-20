import {
  AdditiveBlending,
  BoxGeometry,
  BufferGeometry,
  Color,
  DataTexture,
  DynamicDrawUsage,
  Float32BufferAttribute,
  Mesh,
  MeshBasicMaterial,
  NormalBlending,
  type Object3D,
  PlaneGeometry,
  Points,
  PointsMaterial,
  type Scene,
  Sprite,
  SpriteMaterial,
  Vector3,
} from "three";
import {
  BULLET_STREAK_LENGTH,
  BULLET_VISUAL_SPEED,
  EXPLOSION_EFFECT_MS,
  EXPLOSION_RADIUS,
  MUZZLE_FLASH_MS,
} from "../shared/constants.ts";
import { clamp } from "../shared/math.ts";

// Short-lived effects. Every one is created up front and reused, so shooting never allocates.

const TEXTURE_SIZE = 64;
const BULLET_POOL_SIZE = 32;
const IMPACT_POOL_SIZE = 24;
const FLASH_POOL_SIZE = 12;
const EXPLOSION_POOL_SIZE = 6;
const BULLET_THICKNESS = 0.03;
const BULLET_COLOR = 0xfff1b8;
const FLASH_COLOR = 0xffc56b;
const FLASH_SIZE = 0.45;
const VIEWMODEL_FLASH_SIZE = 0.28;
const IMPACT_COLOR = 0xb9b1a3;
const IMPACT_MS = 380;
const IMPACT_START_SIZE = 0.15;
const IMPACT_END_SIZE = 0.7;
// An explosion: a white-hot core for a few frames, fireballs bursting out that cool from yellow
// to a dark red (EXPLOSION_EFFECT_MS), a shockwave ring, a dust ring racing across the ground,
// sparks arcing out under gravity, and smoke that rises and lingers. The camera shakes nearby.
const FIRE_PER_EXPLOSION = 8;
const SMOKE_PER_EXPLOSION = 8;
const SPARKS_PER_EXPLOSION = 28;
const CORE_COLOR = 0xfff6e0;
const CORE_MS = 110;
const CORE_SIZE = EXPLOSION_RADIUS * 0.6;
const FIRE_HOT_COLOR = 0xfff3b0;
const FIRE_ORANGE_COLOR = 0xff8a1f;
const FIRE_EMBER_COLOR = 0x8a1a05;
const FIRE_OUT_COLOR = 0x200600;
/** Fractions of EXPLOSION_EFFECT_MS at which the fire turns orange, then ember, and starts fading. */
const FIRE_ORANGE_AT = 0.2;
const FIRE_EMBER_AT = 0.55;
const FIRE_FADE_FROM = 0.45;
const FIRE_START_SIZE = 0.7;
const FIRE_END_SIZE = EXPLOSION_RADIUS * 0.55;
/** How far the fireballs fly out, and how much of that is upwards (0 flat, 1 straight up). */
const FIRE_SPREAD = 2.4;
const FIRE_LIFT = 0.35;
const SHOCK_COLOR = 0xffd9a0;
const SHOCK_MS = 320;
const SHOCK_END_SIZE = EXPLOSION_RADIUS * 2.4;
const SHOCK_OPACITY = 0.7;
const DUST_COLOR = 0xcbb999;
const DUST_MS = 750;
const DUST_END_SIZE = EXPLOSION_RADIUS * 2.8;
const DUST_OPACITY = 0.8;
const DUST_LIFT = 0.06;
/** An air burst higher than this above the ground throws no dust ring. */
const DUST_MAX_HEIGHT = 2.5;
const SPARK_COLOR = 0xffc266;
const SPARK_SIZE = 0.16;
const SPARK_MS = 1000;
const SPARK_SPEED_MIN = 5;
const SPARK_SPEED_MAX = 15;
const SPARK_GRAVITY = 14;
const SMOKE_COLOR = 0x3b3835;
const SMOKE_MS = 2800;
const SMOKE_START_SIZE = 1;
const SMOKE_END_SIZE = 6;
const SMOKE_SPREAD = 1.8;
const SMOKE_LIFT = 0.5;
const SMOKE_RISE = 3.5;
const SMOKE_OPACITY = 0.75;
/** Smoke fades in over the first fraction of its life, so it appears out of the fire. */
const SMOKE_FADE_IN = 6;
const SHAKE_DISTANCE = 28;
const SHAKE_MAX_RAD = 0.05;
const SHAKE_MS = 600;
const SHAKE_PITCH_HZ = 23;
const SHAKE_YAW_HZ = 17;
const SHAKE_ROLL_HZ = 13;

/** A streak flying from (x, y, z) along (dx, dy, dz) for `distance` metres; `impact` puffs on arrival. */
type Bullet = {
  mesh: Mesh<BoxGeometry, MeshBasicMaterial>;
  startMs: number;
  x: number;
  y: number;
  z: number;
  dx: number;
  dy: number;
  dz: number;
  distance: number;
  impact: boolean;
};
/** A sprite at (x, y, z); a puff of a blast instead flies out along (dx, dy, dz). */
type Puff = {
  sprite: Sprite;
  startMs: number;
  x: number;
  y: number;
  z: number;
  dx: number;
  dy: number;
  dz: number;
};
type Explosion = {
  startMs: number;
  x: number;
  y: number;
  z: number;
  groundBelow: number;
  core: Puff;
  shock: Puff;
  dust: Mesh;
  fire: Puff[];
  smoke: Puff[];
  sparks: Points;
  sparkPositions: Float32BufferAttribute;
  sparkVelocities: Float32Array;
};

const bullets: Bullet[] = [];
const impacts: Puff[] = [];
const flashes: Puff[] = [];
const explosions: Explosion[] = [];
let viewmodelFlash: Sprite | null = null;
let viewmodelFlashHideMs = 0;
let shakeStrength = 0;
let shakeStartMs = 0;

const tmpVector = new Vector3();
/** Scratch for scattering sparks, which have no sprite of their own. */
const tmpPuff: Puff = { sprite: new Sprite(), startMs: 0, x: 0, y: 0, z: 0, dx: 0, dy: 0, dz: 0 };
const fireHot = new Color(FIRE_HOT_COLOR);
const fireOrange = new Color(FIRE_ORANGE_COLOR);
const fireEmber = new Color(FIRE_EMBER_COLOR);
const fireOut = new Color(FIRE_OUT_COLOR);

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
  return { sprite, startMs: 0, x: 0, y: 0, z: 0, dx: 0, dy: 0, dz: 0 };
}

export function initEffects(scene: Scene, viewmodelMuzzle: Object3D): void {
  const soft = glowTexture(0);
  const star = glowTexture(6);
  const ring = ringTexture(0.8, 0.22);
  // Unit-length along Z so scaling stretches it into the streak. Not tone mapped: the streak
  // should stay bright against a sunlit scene rather than roll off with it.
  const bulletGeometry = new BoxGeometry(BULLET_THICKNESS, BULLET_THICKNESS, 1);
  const bulletMaterial = new MeshBasicMaterial({ color: BULLET_COLOR, toneMapped: false });
  for (let i = 0; i < BULLET_POOL_SIZE; i++) {
    const mesh = new Mesh(bulletGeometry, bulletMaterial);
    mesh.visible = false;
    scene.add(mesh);
    bullets.push({
      mesh,
      startMs: 0,
      x: 0,
      y: 0,
      z: 0,
      dx: 0,
      dy: 0,
      dz: 0,
      distance: 0,
      impact: false,
    });
  }
  for (let i = 0; i < IMPACT_POOL_SIZE; i++) impacts.push(puff(scene, soft, IMPACT_COLOR, false));
  for (let i = 0; i < FLASH_POOL_SIZE; i++) flashes.push(puff(scene, star, FLASH_COLOR, true));
  for (let i = 0; i < EXPLOSION_POOL_SIZE; i++) explosions.push(buildExplosion(scene, soft, ring));
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

/** Starts a bullet flying from the muzzle to where the shot landed. `impact` puffs when it gets
 * there, so a shot that hit nothing within range just fades out. */
export function showBullet(
  fromX: number,
  fromY: number,
  fromZ: number,
  toX: number,
  toY: number,
  toZ: number,
  impact: boolean,
  nowMs: number,
): void {
  const bullet = oldest(bullets);
  if (!bullet) return;
  const distance = Math.hypot(toX - fromX, toY - fromY, toZ - fromZ);
  if (distance <= 0) return;
  bullet.x = fromX;
  bullet.y = fromY;
  bullet.z = fromZ;
  bullet.dx = (toX - fromX) / distance;
  bullet.dy = (toY - fromY) / distance;
  bullet.dz = (toZ - fromZ) / distance;
  bullet.distance = distance;
  bullet.impact = impact;
  bullet.startMs = nowMs;
  bullet.mesh.position.set(fromX, fromY, fromZ);
  bullet.mesh.lookAt(tmpVector.set(toX, toY, toZ));
  bullet.mesh.scale.set(1, 1, 0.001);
  bullet.mesh.visible = true;
}

/** Moves the streak along its path, clipped so it never pokes out of the muzzle or past the
 * hit point, then hands over to the impact puff once its tail arrives. */
function updateBullet(bullet: Bullet, nowMs: number): void {
  const head = ((nowMs - bullet.startMs) / 1000) * BULLET_VISUAL_SPEED;
  const tail = Math.max(0, head - BULLET_STREAK_LENGTH);
  if (tail >= bullet.distance) {
    bullet.mesh.visible = false;
    const end = bullet.distance;
    if (bullet.impact) {
      showImpact(
        bullet.x + bullet.dx * end,
        bullet.y + bullet.dy * end,
        bullet.z + bullet.dz * end,
        nowMs,
      );
    }
    return;
  }
  const clippedHead = Math.min(head, bullet.distance);
  const mid = (tail + clippedHead) / 2;
  bullet.mesh.position.set(
    bullet.x + bullet.dx * mid,
    bullet.y + bullet.dy * mid,
    bullet.z + bullet.dz * mid,
  );
  bullet.mesh.scale.z = Math.max(0.001, clippedHead - tail);
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

/** `muzzle` is the currently equipped weapon's muzzle point, since it changes as weapons switch;
 * `scale` grows the flash with the weapon's recoil. */
export function showViewmodelFlash(nowMs: number, muzzle: Object3D, scale: number): void {
  if (!viewmodelFlash) return;
  muzzle.add(viewmodelFlash);
  viewmodelFlash.scale.setScalar(VIEWMODEL_FLASH_SIZE * Math.sqrt(scale));
  viewmodelFlash.material.rotation = Math.random() * Math.PI;
  viewmodelFlash.visible = true;
  viewmodelFlashHideMs = nowMs + MUZZLE_FLASH_MS;
}

/** A ring: alpha peaks at `radius` (of the half-width) and falls off either side. */
function ringTexture(radius: number, width: number): DataTexture {
  const data = new Uint8Array(TEXTURE_SIZE * TEXTURE_SIZE * 4);
  for (let y = 0; y < TEXTURE_SIZE; y++) {
    for (let x = 0; x < TEXTURE_SIZE; x++) {
      const dx = (x + 0.5) / TEXTURE_SIZE - 0.5;
      const dy = (y + 0.5) / TEXTURE_SIZE - 0.5;
      const distance = Math.hypot(dx, dy) * 2;
      const alpha = clamp(1 - Math.abs(distance - radius) / width, 0, 1) ** 2;
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

function buildExplosion(scene: Scene, soft: DataTexture, ring: DataTexture): Explosion {
  const fire: Puff[] = [];
  for (let i = 0; i < FIRE_PER_EXPLOSION; i++) fire.push(puff(scene, soft, FIRE_HOT_COLOR, true));
  const smoke: Puff[] = [];
  for (let i = 0; i < SMOKE_PER_EXPLOSION; i++) smoke.push(puff(scene, soft, SMOKE_COLOR, false));
  const sparkGeometry = new BufferGeometry();
  const sparkPositions = new Float32BufferAttribute(new Float32Array(SPARKS_PER_EXPLOSION * 3), 3);
  sparkPositions.setUsage(DynamicDrawUsage);
  sparkGeometry.setAttribute("position", sparkPositions);
  const sparks = new Points(
    sparkGeometry,
    new PointsMaterial({
      map: soft,
      color: SPARK_COLOR,
      size: SPARK_SIZE,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      toneMapped: false,
    }),
  );
  // Positions change every frame, so the geometry's stale bounds must not cull it.
  sparks.frustumCulled = false;
  sparks.visible = false;
  scene.add(sparks);
  const dust = new Mesh(
    new PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
    new MeshBasicMaterial({
      map: ring,
      color: DUST_COLOR,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
    }),
  );
  dust.visible = false;
  scene.add(dust);
  return {
    startMs: 0,
    x: 0,
    y: 0,
    z: 0,
    groundBelow: 0,
    core: puff(scene, soft, CORE_COLOR, true),
    shock: puff(scene, ring, SHOCK_COLOR, true),
    dust,
    fire,
    smoke,
    sparks,
    sparkPositions,
    sparkVelocities: new Float32Array(SPARKS_PER_EXPLOSION * 3),
  };
}

/** A direction that is random around the compass and biased upwards by `lift` (0 flat, 1 all up). */
function scatter(out: Puff, speed: number, lift: number): void {
  const angle = Math.random() * Math.PI * 2;
  const up = lift + (1 - lift) * (Math.random() * 2 - 1);
  const flat = Math.sqrt(Math.max(0, 1 - up * up));
  out.dx = Math.cos(angle) * flat * speed;
  out.dy = up * speed;
  out.dz = Math.sin(angle) * flat * speed;
}

/** A blast at (x, y, z). `groundBelow` is how far down the ground is, so the dust ring can race
 * across it (an air burst higher than DUST_MAX_HEIGHT throws no dust). */
export function showExplosion(
  x: number,
  y: number,
  z: number,
  groundBelow: number,
  nowMs: number,
): void {
  const explosion = oldest(explosions);
  if (!explosion) return;
  explosion.startMs = nowMs;
  explosion.x = x;
  explosion.y = y;
  explosion.z = z;
  explosion.groundBelow = groundBelow;
  explosion.core.sprite.position.set(x, y, z);
  explosion.core.sprite.visible = true;
  explosion.shock.sprite.position.set(x, y, z);
  explosion.shock.sprite.material.rotation = Math.random() * Math.PI;
  explosion.shock.sprite.visible = true;
  explosion.dust.position.set(x, y - groundBelow + DUST_LIFT, z);
  explosion.dust.visible = groundBelow <= DUST_MAX_HEIGHT;
  // Each fireball and puff of smoke flies off its own way; the numbers only need to look random.
  for (const fire of explosion.fire) {
    scatter(fire, FIRE_SPREAD * (0.4 + Math.random() * 0.6), FIRE_LIFT);
    fire.sprite.material.rotation = Math.random() * Math.PI * 2;
    fire.sprite.visible = true;
  }
  for (const smoke of explosion.smoke) {
    scatter(smoke, SMOKE_SPREAD * (0.3 + Math.random() * 0.7), SMOKE_LIFT);
    smoke.sprite.material.rotation = Math.random() * Math.PI * 2;
    smoke.sprite.visible = true;
  }
  const velocities = explosion.sparkVelocities;
  for (let i = 0; i < SPARKS_PER_EXPLOSION; i++) {
    scatter(tmpPuff, SPARK_SPEED_MIN + Math.random() * (SPARK_SPEED_MAX - SPARK_SPEED_MIN), 0.35);
    velocities[i * 3] = tmpPuff.dx;
    velocities[i * 3 + 1] = tmpPuff.dy;
    velocities[i * 3 + 2] = tmpPuff.dz;
  }
  explosion.sparks.visible = true;
}

/** Shakes the camera for a blast `distance` away; nearer is harder. */
export function shakeCamera(distance: number, nowMs: number): void {
  const strength = clamp(1 - distance / SHAKE_DISTANCE, 0, 1) ** 1.5 * SHAKE_MAX_RAD;
  if (strength <= 0) return;
  // A second blast during a shake takes over only if it is the harder of the two.
  const remaining = shakeStrength * shakeEnvelope(nowMs);
  if (strength < remaining) return;
  shakeStrength = strength;
  shakeStartMs = nowMs;
}

function shakeEnvelope(nowMs: number): number {
  const t = (nowMs - shakeStartMs) / SHAKE_MS;
  return t >= 1 ? 0 : (1 - t) * (1 - t);
}

/** Adds the current shake to a camera whose rotation is set for this frame. */
export function applyCameraShake(camera: Object3D, nowMs: number): void {
  const amount = shakeStrength * shakeEnvelope(nowMs);
  if (amount <= 0) return;
  const t = nowMs / 1000;
  camera.rotation.x += Math.sin(t * SHAKE_PITCH_HZ * Math.PI * 2) * amount;
  camera.rotation.y += Math.sin(t * SHAKE_YAW_HZ * Math.PI * 2 + 1.7) * amount * 0.7;
  camera.rotation.z += Math.sin(t * SHAKE_ROLL_HZ * Math.PI * 2 + 0.6) * amount * 0.5;
}

/** Fire cools from white-yellow through orange to a dark red as it flies out and fades. */
function fireColor(t: number, out: Color): void {
  if (t < FIRE_ORANGE_AT) {
    out.lerpColors(fireHot, fireOrange, t / FIRE_ORANGE_AT);
  } else if (t < FIRE_EMBER_AT) {
    out.lerpColors(fireOrange, fireEmber, (t - FIRE_ORANGE_AT) / (FIRE_EMBER_AT - FIRE_ORANGE_AT));
  } else {
    out.lerpColors(fireEmber, fireOut, (t - FIRE_EMBER_AT) / (1 - FIRE_EMBER_AT));
  }
}

function updateExplosion(explosion: Explosion, nowMs: number): void {
  const sinceMs = nowMs - explosion.startMs;
  const core = explosion.core.sprite;
  if (core.visible) {
    const t = sinceMs / CORE_MS;
    if (t >= 1) core.visible = false;
    else {
      core.scale.setScalar(CORE_SIZE * Math.sqrt(t));
      core.material.opacity = 1 - t * t;
    }
  }
  const shock = explosion.shock.sprite;
  if (shock.visible) {
    const t = sinceMs / SHOCK_MS;
    if (t >= 1) shock.visible = false;
    else {
      const eased = 1 - (1 - t) * (1 - t);
      shock.scale.setScalar(SHOCK_END_SIZE * eased);
      shock.material.opacity = SHOCK_OPACITY * (1 - t);
    }
  }
  const dust = explosion.dust;
  if (dust.visible) {
    const t = sinceMs / DUST_MS;
    if (t >= 1) dust.visible = false;
    else {
      const eased = 1 - (1 - t) * (1 - t) * (1 - t);
      dust.scale.setScalar(DUST_END_SIZE * eased);
      // Safe: the dust plane is built with a single MeshBasicMaterial above.
      (dust.material as MeshBasicMaterial).opacity = DUST_OPACITY * (1 - t);
    }
  }
  for (const fire of explosion.fire) {
    const sprite = fire.sprite;
    if (!sprite.visible) continue;
    const t = sinceMs / EXPLOSION_EFFECT_MS;
    if (t >= 1) {
      sprite.visible = false;
      continue;
    }
    const eased = 1 - (1 - t) * (1 - t);
    sprite.position.set(
      explosion.x + fire.dx * eased,
      explosion.y + fire.dy * eased,
      explosion.z + fire.dz * eased,
    );
    sprite.scale.setScalar(FIRE_START_SIZE + (FIRE_END_SIZE - FIRE_START_SIZE) * eased);
    fireColor(t, sprite.material.color);
    sprite.material.opacity = t < FIRE_FADE_FROM ? 1 : (1 - t) / (1 - FIRE_FADE_FROM);
  }
  for (const smoke of explosion.smoke) {
    const sprite = smoke.sprite;
    if (!sprite.visible) continue;
    const t = sinceMs / SMOKE_MS;
    if (t >= 1) {
      sprite.visible = false;
      continue;
    }
    const eased = 1 - (1 - t) * (1 - t);
    sprite.position.set(
      explosion.x + smoke.dx * eased,
      explosion.y + smoke.dy * eased + SMOKE_RISE * t,
      explosion.z + smoke.dz * eased,
    );
    sprite.scale.setScalar(SMOKE_START_SIZE + (SMOKE_END_SIZE - SMOKE_START_SIZE) * eased);
    sprite.material.opacity = SMOKE_OPACITY * (1 - t) * Math.min(1, t * SMOKE_FADE_IN);
  }
  const sparks = explosion.sparks;
  if (sparks.visible) {
    const t = sinceMs / SPARK_MS;
    if (t >= 1) sparks.visible = false;
    else {
      const seconds = sinceMs / 1000;
      const positions = explosion.sparkPositions;
      const velocities = explosion.sparkVelocities;
      for (let i = 0; i < SPARKS_PER_EXPLOSION; i++) {
        const vx = velocities[i * 3] ?? 0;
        const vy = velocities[i * 3 + 1] ?? 0;
        const vz = velocities[i * 3 + 2] ?? 0;
        positions.setXYZ(
          i,
          explosion.x + vx * seconds,
          explosion.y + vy * seconds - 0.5 * SPARK_GRAVITY * seconds * seconds,
          explosion.z + vz * seconds,
        );
      }
      positions.needsUpdate = true;
      // Safe: the sparks are built with a single PointsMaterial above.
      (sparks.material as PointsMaterial).opacity = 1 - t * t;
    }
  }
}

export function updateEffects(nowMs: number): void {
  for (const bullet of bullets) {
    if (bullet.mesh.visible) updateBullet(bullet, nowMs);
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
