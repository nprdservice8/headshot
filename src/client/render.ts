import {
  BoxGeometry,
  BufferAttribute,
  type BufferGeometry,
  Color,
  DirectionalLight,
  Fog,
  GridHelper,
  Group,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  PerspectiveCamera,
  Quaternion,
  Scene,
  SphereGeometry,
  Vector3,
  WebGLRenderer,
} from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import {
  EXPLOSION_EFFECT_MS,
  EXPLOSION_RADIUS,
  FIELD_OF_VIEW_DEG,
  GRENADE_RADIUS,
  MUZZLE_FLASH_MS,
  TRACER_LIFETIME_MS,
  WALK_CYCLE_RAD_PER_METRE,
  WALK_SPEED,
} from "../shared/constants.ts";
import { lerp } from "../shared/math.ts";
import { ARENA_BOXES, ARENA_HALF_SIZE, boxRotation } from "../shared/world.ts";

// Body proportions, in metres from the feet. Limb meshes pivot at the hip or shoulder.
export const LEG = { width: 0.22, length: 0.8, hipX: 0.12, hipY: 0.8 };
export const TORSO = { width: 0.55, height: 0.65, depth: 0.3, centerY: 1.125 };
export const HEAD = { size: 0.36, centerY: 1.6 };
export const ARM = { width: 0.17, length: 0.65, shoulderX: 0.36, shoulderY: 1.4 };

const SKY_COLOR = 0x9cc7e6;
const FOG_NEAR = 45;
const FOG_FAR = 130;
const NEAR_PLANE = 0.05;
const FAR_PLANE = 300;
const MAX_PIXEL_RATIO = 2;
const LEG_SWING_RAD = 0.8;
const MAX_WALK_STEP = 1;
const TRACER_POOL_SIZE = 32;
const EXPLOSION_POOL_SIZE = 6;
const TRACER_THICKNESS = 0.025;
const VIEWMODEL_RECOIL = 0.06;
const VIEWMODEL_RECOVERY_PER_SEC = 14;
const TEAM_COLORS = [
  0xe8534a, 0x4a90e8, 0x5cc26b, 0xf2b33d, 0xa45ee8, 0x3dc9c9, 0xe86fb8, 0xd9d9d9,
];

export const scene = new Scene();
export const camera = new PerspectiveCamera(FIELD_OF_VIEW_DEG, 1, NEAR_PLANE, FAR_PLANE);
camera.rotation.order = "YXZ";
scene.add(camera);

let renderer: WebGLRenderer | null = null;

// Shared geometries and materials: every player, ragdoll and effect reuses these.
const legGeometry = new BoxGeometry(LEG.width, LEG.length, LEG.width).translate(
  0,
  -LEG.length / 2,
  0,
);
const armGeometry = new BoxGeometry(ARM.width, ARM.length, ARM.width).translate(
  0,
  -ARM.length / 2,
  0,
);
const torsoGeometry = new BoxGeometry(TORSO.width, TORSO.height, TORSO.depth);
const headGeometry = new BoxGeometry(HEAD.size, HEAD.size, HEAD.size);
const gunGeometry = new BoxGeometry(0.08, 0.6, 0.1);
const grenadeGeometry = new SphereGeometry(GRENADE_RADIUS, 10, 8);
const tracerGeometry = new BoxGeometry(TRACER_THICKNESS, TRACER_THICKNESS, 1);
const explosionGeometry = new SphereGeometry(1, 20, 14);

const skinMaterial = new MeshLambertMaterial({ color: 0xf0c49c });
const pantsMaterial = new MeshLambertMaterial({ color: 0x2f3542 });
const gunMaterial = new MeshLambertMaterial({ color: 0x1d1f24 });
const grenadeMaterial = new MeshLambertMaterial({ color: 0x3f5b2e });
const tracerMaterial = new MeshBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0.85 });
const teamMaterials = TEAM_COLORS.map((color) => new MeshLambertMaterial({ color }));

export type PlayerView = {
  root: Group;
  head: Mesh;
  torso: Mesh;
  armLeft: Mesh;
  armRight: Mesh;
  legLeft: Mesh;
  legRight: Mesh;
  gun: Mesh;
  walkPhase: number;
  lastX: number;
  lastZ: number;
};

const playerViews = new Map<number, PlayerView>();
const grenadeViews = new Map<number, Mesh>();
const seenGrenades = new Set<number>();

type Tracer = { mesh: Mesh; hideAtMs: number };
type Explosion = { mesh: Mesh<SphereGeometry, MeshBasicMaterial>; startMs: number };
const tracers: Tracer[] = [];
const explosions: Explosion[] = [];

const viewmodel = new Group();
const muzzleFlash = new Mesh(
  new BoxGeometry(0.12, 0.12, 0.12),
  new MeshBasicMaterial({ color: 0xffd36b, depthTest: false }),
);
let muzzleFlashHideAtMs = 0;
let viewmodelKick = 0;

const tmpVector = new Vector3();

export function initRenderer(canvas: HTMLCanvasElement): void {
  renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
  resize();
  window.addEventListener("resize", resize);

  scene.background = new Color(SKY_COLOR);
  scene.fog = new Fog(SKY_COLOR, FOG_NEAR, FOG_FAR);
  scene.add(new HemisphereLight(0xdcecff, 0x4b4238, 2.2));
  const sun = new DirectionalLight(0xfff2dd, 1.8);
  sun.position.set(25, 40, 12);
  scene.add(sun);

  scene.add(createArenaMesh());
  const grid = new GridHelper(ARENA_HALF_SIZE * 2, ARENA_HALF_SIZE * 2, 0x596170, 0x596170);
  grid.position.y = 0.005;
  scene.add(grid);

  createViewmodel();
  for (let i = 0; i < TRACER_POOL_SIZE; i++) {
    const mesh = new Mesh(tracerGeometry, tracerMaterial);
    mesh.visible = false;
    scene.add(mesh);
    tracers.push({ mesh, hideAtMs: 0 });
  }
  for (let i = 0; i < EXPLOSION_POOL_SIZE; i++) {
    const material = new MeshBasicMaterial({
      color: 0xffa640,
      transparent: true,
      depthWrite: false,
    });
    const mesh = new Mesh(explosionGeometry, material);
    mesh.visible = false;
    scene.add(mesh);
    explosions.push({ mesh, startMs: 0 });
  }
}

function resize(): void {
  if (!renderer) return;
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
}

/** The whole static arena as one mesh with vertex colours: one draw call. */
function createArenaMesh(): Mesh {
  const color = new Color();
  const rotation = new Quaternion();
  const pieces: BufferGeometry[] = [];
  for (const box of ARENA_BOXES) {
    const geometry = new BoxGeometry(box.hx * 2, box.hy * 2, box.hz * 2);
    color.setHex(box.color);
    const vertexCount = geometry.getAttribute("position").count;
    const colors = new Float32Array(vertexCount * 3);
    for (let i = 0; i < vertexCount; i++) colors.set([color.r, color.g, color.b], i * 3);
    geometry.setAttribute("color", new BufferAttribute(colors, 3));
    const q = boxRotation(box.yaw, box.tilt);
    geometry.applyQuaternion(rotation.set(q.x, q.y, q.z, q.w));
    geometry.translate(box.x, box.y, box.z);
    pieces.push(geometry);
  }
  const merged = mergeGeometries(pieces);
  for (const piece of pieces) piece.dispose();
  if (!merged) throw new Error("Arena geometry could not be merged");
  return new Mesh(merged, new MeshLambertMaterial({ vertexColors: true }));
}

function createViewmodel(): void {
  const gun = new Mesh(
    new BoxGeometry(0.045, 0.06, 0.38),
    new MeshLambertMaterial({ color: 0x24272e, depthTest: false }),
  );
  gun.position.set(0.17, -0.19, -0.56);
  muzzleFlash.position.set(0.17, -0.17, -0.77);
  muzzleFlash.visible = false;
  viewmodel.add(gun, muzzleFlash);
  // Drawn on top of everything so the gun never pokes into walls.
  for (const mesh of [gun, muzzleFlash]) mesh.renderOrder = 1;
  camera.add(viewmodel);
}

export function setViewmodelVisible(visible: boolean): void {
  viewmodel.visible = visible;
}

export function muzzleWorldPosition(out: Vector3): Vector3 {
  camera.updateMatrixWorld();
  return muzzleFlash.getWorldPosition(out);
}

export function playLocalShotEffects(nowMs: number): void {
  muzzleFlash.visible = true;
  muzzleFlash.rotation.z = Math.random() * Math.PI;
  muzzleFlashHideAtMs = nowMs + MUZZLE_FLASH_MS;
  viewmodelKick = VIEWMODEL_RECOIL;
}

function createPlayerView(id: number): PlayerView {
  const shirt = teamMaterials[id % teamMaterials.length] ?? skinMaterial;
  const root = new Group();
  const legLeft = new Mesh(legGeometry, pantsMaterial);
  const legRight = new Mesh(legGeometry, pantsMaterial);
  legLeft.position.set(-LEG.hipX, LEG.hipY, 0);
  legRight.position.set(LEG.hipX, LEG.hipY, 0);
  const torso = new Mesh(torsoGeometry, shirt);
  torso.position.y = TORSO.centerY;
  const head = new Mesh(headGeometry, skinMaterial);
  head.position.y = HEAD.centerY;
  const armLeft = new Mesh(armGeometry, shirt);
  const armRight = new Mesh(armGeometry, shirt);
  armLeft.position.set(-ARM.shoulderX, ARM.shoulderY, 0);
  armRight.position.set(ARM.shoulderX, ARM.shoulderY, 0);
  // Arms point forward when rotated a quarter turn around X; the gun sits past the right hand.
  const gun = new Mesh(gunGeometry, gunMaterial);
  gun.position.set(-0.06, -ARM.length - 0.12, -0.05);
  armRight.add(gun);
  root.add(legLeft, legRight, torso, head, armLeft, armRight);
  scene.add(root);
  return {
    root,
    head,
    torso,
    armLeft,
    armRight,
    legLeft,
    legRight,
    gun,
    walkPhase: 0,
    lastX: 0,
    lastZ: 0,
  };
}

export function getPlayerView(id: number): PlayerView | undefined {
  return playerViews.get(id);
}

export function updatePlayerView(
  id: number,
  x: number,
  y: number,
  z: number,
  yaw: number,
  pitch: number,
  visible: boolean,
  dt: number,
): void {
  let view = playerViews.get(id);
  if (!view) {
    view = createPlayerView(id);
    view.lastX = x;
    view.lastZ = z;
    playerViews.set(id, view);
  }
  view.root.visible = visible;
  view.root.position.set(x, y, z);
  view.root.rotation.y = yaw;
  view.head.rotation.x = pitch;
  view.armLeft.rotation.x = Math.PI / 2 + pitch;
  view.armRight.rotation.x = Math.PI / 2 + pitch;

  const distance = Math.hypot(x - view.lastX, z - view.lastZ);
  view.lastX = x;
  view.lastZ = z;
  if (distance > MAX_WALK_STEP) return; // a respawn teleport, not a step
  view.walkPhase += distance * WALK_CYCLE_RAD_PER_METRE;
  const speed = dt > 0 ? distance / dt : 0;
  const swing = Math.sin(view.walkPhase) * LEG_SWING_RAD * Math.min(1, speed / WALK_SPEED);
  view.legLeft.rotation.x = swing;
  view.legRight.rotation.x = -swing;
}

export function removePlayerViewsExcept(keep: ReadonlySet<number>): void {
  for (const [id, view] of playerViews) {
    if (keep.has(id)) continue;
    scene.remove(view.root);
    playerViews.delete(id);
  }
}

export function updateGrenadeView(id: number, x: number, y: number, z: number): void {
  let mesh = grenadeViews.get(id);
  if (!mesh) {
    mesh = new Mesh(grenadeGeometry, grenadeMaterial);
    scene.add(mesh);
    grenadeViews.set(id, mesh);
  }
  mesh.position.set(x, y, z);
  seenGrenades.add(id);
}

/** Call once per frame after all updateGrenadeView calls. */
export function removeUnseenGrenades(): void {
  for (const [id, mesh] of grenadeViews) {
    if (seenGrenades.has(id)) continue;
    scene.remove(mesh);
    grenadeViews.delete(id);
  }
  seenGrenades.clear();
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
  let tracer = tracers[0];
  for (const candidate of tracers) {
    if (!tracer || candidate.hideAtMs < tracer.hideAtMs) tracer = candidate;
  }
  if (!tracer) return;
  const length = Math.hypot(toX - fromX, toY - fromY, toZ - fromZ);
  tracer.mesh.position.set((fromX + toX) / 2, (fromY + toY) / 2, (fromZ + toZ) / 2);
  tracer.mesh.scale.set(1, 1, length);
  tracer.mesh.lookAt(tmpVector.set(toX, toY, toZ));
  tracer.mesh.visible = true;
  tracer.hideAtMs = nowMs + TRACER_LIFETIME_MS;
}

export function showExplosion(x: number, y: number, z: number, nowMs: number): void {
  let effect = explosions[0];
  for (const candidate of explosions) {
    if (!effect || candidate.startMs < effect.startMs) effect = candidate;
  }
  if (!effect) return;
  effect.mesh.position.set(x, y, z);
  effect.mesh.visible = true;
  effect.startMs = nowMs;
}

export function updateEffects(nowMs: number, dt: number): void {
  for (const tracer of tracers) {
    if (tracer.mesh.visible && nowMs >= tracer.hideAtMs) tracer.mesh.visible = false;
  }
  for (const effect of explosions) {
    if (!effect.mesh.visible) continue;
    const t = (nowMs - effect.startMs) / EXPLOSION_EFFECT_MS;
    if (t >= 1) {
      effect.mesh.visible = false;
      continue;
    }
    const eased = 1 - (1 - t) * (1 - t);
    effect.mesh.scale.setScalar(lerp(0.3, EXPLOSION_RADIUS * 0.6, eased));
    effect.mesh.material.opacity = 1 - t;
  }
  if (muzzleFlash.visible && nowMs >= muzzleFlashHideAtMs) muzzleFlash.visible = false;
  viewmodelKick *= Math.exp(-VIEWMODEL_RECOVERY_PER_SEC * dt);
  viewmodel.position.z = viewmodelKick;
}

export function draw(): void {
  renderer?.render(scene, camera);
}
