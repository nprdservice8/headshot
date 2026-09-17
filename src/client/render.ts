import {
  AgXToneMapping,
  BackSide,
  Color,
  DirectionalLight,
  Float32BufferAttribute,
  Fog,
  Group,
  HemisphereLight,
  type Material,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  type Object3D,
  PerspectiveCamera,
  Scene,
  SphereGeometry,
  type Vector3,
  WebGLRenderer,
} from "three";
import {
  ADS_FOV_DEG,
  ADS_TRANSITION_PER_SEC,
  FIELD_OF_VIEW_DEG,
  GROUND_COLOR,
  LIGHTMAP_RANGE,
  SCENERY_LIGHT_RANGE,
  SKY_HORIZON_COLOR,
  SKY_INTENSITY,
  SKY_ZENITH_COLOR,
  SUN_AZIMUTH_DEG,
  SUN_COLOR,
  SUN_ELEVATION_DEG,
  SUN_INTENSITY,
  WALK_SPEED,
  SPRINT_FOV_KICK_DEG,
} from "../shared/constants.ts";
import { clamp } from "../shared/math.ts";
import type { Assets } from "./assets.ts";
import { teamColor } from "./characters.ts";

const FOG_NEAR = 50;
const FOG_FAR = 190;
const NEAR_PLANE = 0.05;
const FAR_PLANE = 400;
const SKY_RADIUS = 350;
const MAX_PIXEL_RATIO = 2;
const EXPOSURE = 1.15;
/** Must match VIEW_FOV_DEG in art/player.py, which posed the arms for this field of view. */
const VIEWMODEL_FOV_DEG = 60;
const VIEWMODEL_NEAR = 0.01;
const VIEWMODEL_FAR = 5;
const VIEWMODEL_RECOIL_BACK = 0.045;
const VIEWMODEL_RECOIL_RISE = 0.06;
const VIEWMODEL_RECOVERY_PER_SEC = 14;
const VIEWMODEL_BOB_PER_METRE = 1.9;
const VIEWMODEL_BOB_SIDE = 0.009;
const VIEWMODEL_BOB_UP = 0.007;
const VIEWMODEL_SWAY = 0.04;
const VIEWMODEL_SWAY_MAX = 0.03;
const VIEWMODEL_SWAY_RECOVERY_PER_SEC = 10;

export const scene = new Scene();
export const camera = new PerspectiveCamera(FIELD_OF_VIEW_DEG, 1, NEAR_PLANE, FAR_PLANE);
camera.rotation.order = "YXZ";

// The first-person arms and rifle are drawn in their own pass after clearing depth, so they never
// poke into walls and keep their own field of view.
const viewmodelScene = new Scene();
const viewmodelCamera = new PerspectiveCamera(VIEWMODEL_FOV_DEG, 1, VIEWMODEL_NEAR, VIEWMODEL_FAR);
viewmodelScene.add(viewmodelCamera);
const viewmodel = new Group();
viewmodelCamera.add(viewmodel);
let viewmodelMuzzle: Object3D = viewmodel;
let viewmodelTeamMaterial: MeshLambertMaterial | null = null;
let viewmodelKick = 0;
let bobPhase = 0;
let swayX = 0;
let swayY = 0;
let lastYaw = 0;
let lastPitch = 0;
let cameraFov = FIELD_OF_VIEW_DEG;

const sky = new Mesh(
  new SphereGeometry(SKY_RADIUS, 32, 16),
  new MeshBasicMaterial({ vertexColors: true, side: BackSide, fog: false, depthWrite: false }),
);

let renderer: WebGLRenderer | null = null;
let grenadeTemplate: Object3D | null = null;
const grenadeViews = new Map<number, Object3D>();
const seenGrenades = new Set<number>();
const litMaterial = new MeshLambertMaterial({ vertexColors: true });

export function initRenderer(canvas: HTMLCanvasElement, assets: Assets): void {
  renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
  renderer.toneMapping = AgXToneMapping;
  renderer.toneMappingExposure = EXPOSURE;
  renderer.autoClear = false;
  resize();
  window.addEventListener("resize", resize);

  scene.background = new Color(SKY_HORIZON_COLOR);
  scene.fog = new Fog(SKY_HORIZON_COLOR, FOG_NEAR, FOG_FAR);
  paintSky();
  sky.renderOrder = -1;
  scene.add(sky);
  addLights(scene);
  addLights(viewmodelScene);
  addMap(assets);

  for (const object of assets.viewmodel.children.slice()) viewmodel.add(object);
  viewmodel.traverse((object) => {
    if (object.name === "Muzzle") viewmodelMuzzle = object;
    if (!(object instanceof Mesh)) return;
    const source = object.material as Material;
    if (source.name === "Team") {
      viewmodelTeamMaterial = new MeshLambertMaterial({ vertexColors: true });
      object.material = viewmodelTeamMaterial;
    } else {
      object.material = litMaterial;
    }
  });

  grenadeTemplate = assets.grenade;
  grenadeTemplate.traverse((object) => {
    if (object instanceof Mesh) object.material = litMaterial;
  });
}

/** The first-person muzzle, for effects that attach to it. */
export function getViewmodelMuzzle(): Object3D {
  return viewmodelMuzzle;
}

function resize(): void {
  if (!renderer) return;
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  const aspect = window.innerWidth / window.innerHeight;
  camera.aspect = aspect;
  camera.updateProjectionMatrix();
  viewmodelCamera.aspect = aspect;
  viewmodelCamera.updateProjectionMatrix();
}

/** Vertex colours from the ground colour below the horizon up to the zenith colour overhead. */
function paintSky(): void {
  const zenith = new Color(SKY_ZENITH_COLOR);
  const horizon = new Color(SKY_HORIZON_COLOR);
  const ground = new Color(GROUND_COLOR);
  const color = new Color();
  const positions = sky.geometry.getAttribute("position");
  const colors = new Float32Array(positions.count * 3);
  for (let i = 0; i < positions.count; i++) {
    const height = positions.getY(i) / SKY_RADIUS;
    if (height >= 0) color.lerpColors(horizon, zenith, Math.sqrt(height));
    else color.lerpColors(horizon, ground, clamp(-height * 4, 0, 1));
    color.multiplyScalar(SKY_INTENSITY).toArray(colors, i * 3);
  }
  sky.geometry.setAttribute("color", new Float32BufferAttribute(colors, 3));
}

/** Live lights for moving things, matching the sun and sky the map was baked with. */
function addLights(target: Scene): void {
  const skyColor = new Color(SKY_ZENITH_COLOR).lerp(new Color(SKY_HORIZON_COLOR), 0.5);
  // three.js divides light by pi, like Cycles does for the sun but not for the sky.
  target.add(new HemisphereLight(skyColor, GROUND_COLOR, SKY_INTENSITY * Math.PI));
  const sun = new DirectionalLight(SUN_COLOR, SUN_INTENSITY);
  const azimuth = (SUN_AZIMUTH_DEG * Math.PI) / 180;
  const elevation = (SUN_ELEVATION_DEG * Math.PI) / 180;
  sun.position.set(
    Math.cos(elevation) * Math.sin(azimuth),
    Math.sin(elevation),
    Math.cos(elevation) * Math.cos(azimuth),
  );
  target.add(sun);
}

function addMap(assets: Assets): void {
  // Baked light: color x light / pi x intensity, and the bake divided light by LIGHTMAP_RANGE.
  const intensity = Math.PI * LIGHTMAP_RANGE;
  const arena = new MeshBasicMaterial({
    vertexColors: true,
    lightMap: assets.arenaLight,
    lightMapIntensity: intensity,
  });
  // Scenery has its lit colour baked into the vertex colours, scaled down by SCENERY_LIGHT_RANGE.
  const scenery = new MeshBasicMaterial({ vertexColors: true });
  scenery.color.setScalar(SCENERY_LIGHT_RANGE);
  assets.map.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    const source = object.material as Material;
    object.material = source.name === "Scenery" ? scenery : arena;
  });
  // The map never moves.
  assets.map.updateMatrixWorld(true);
  assets.map.traverse((object) => {
    object.matrixAutoUpdate = false;
  });
  scene.add(assets.map);
}

export function setViewmodelTeam(id: number): void {
  viewmodelTeamMaterial?.color.setHex(teamColor(id));
}

export function setViewmodelVisible(visible: boolean): void {
  viewmodel.visible = visible;
}

/** Smooth ADS/sprint FOV so aiming is responsive without a hard camera pop. */
export function updateCameraFov(dt: number, ads: boolean, sprinting: boolean): void {
  const target = ads ? ADS_FOV_DEG : FIELD_OF_VIEW_DEG + (sprinting ? SPRINT_FOV_KICK_DEG : 0);
  cameraFov += (target - cameraFov) * (1 - Math.exp(-ADS_TRANSITION_PER_SEC * dt));
  if (Math.abs(camera.fov - cameraFov) > 0.01) {
    camera.fov = cameraFov;
    camera.updateProjectionMatrix();
  }
}

function syncViewmodelCamera(): void {
  viewmodelCamera.position.copy(camera.position);
  viewmodelCamera.quaternion.copy(camera.quaternion);
  viewmodelCamera.updateMatrixWorld();
}

export function muzzleWorldPosition(out: Vector3): Vector3 {
  syncViewmodelCamera();
  return viewmodelMuzzle.getWorldPosition(out);
}

export function kickViewmodel(): void {
  viewmodelKick = 1;
}

/** Recoil, walking bob and a little lag behind mouse movement. */
export function updateViewmodel(
  dt: number,
  distanceMoved: number,
  grounded: boolean,
  yaw: number,
  pitch: number,
  ads: boolean,
): void {
  viewmodelKick *= Math.exp(-VIEWMODEL_RECOVERY_PER_SEC * dt);
  const moving = grounded && dt > 0 ? clamp(distanceMoved / dt / WALK_SPEED, 0, 1) : 0;
  bobPhase += distanceMoved * VIEWMODEL_BOB_PER_METRE;
  let turn = yaw - lastYaw;
  // Yaw wraps around; the short way round is the real turn.
  if (turn > Math.PI) turn -= 2 * Math.PI;
  if (turn < -Math.PI) turn += 2 * Math.PI;
  const recover = Math.exp(-VIEWMODEL_SWAY_RECOVERY_PER_SEC * dt);
  const swayScale = ads ? 0.35 : 1;
  swayX = clamp(
    swayX * recover + turn * VIEWMODEL_SWAY * swayScale,
    -VIEWMODEL_SWAY_MAX,
    VIEWMODEL_SWAY_MAX,
  );
  swayY = clamp(
    swayY * recover - (pitch - lastPitch) * VIEWMODEL_SWAY * swayScale,
    -VIEWMODEL_SWAY_MAX,
    VIEWMODEL_SWAY_MAX,
  );
  lastYaw = yaw;
  lastPitch = pitch;
  viewmodel.position.set(
    Math.cos(bobPhase) * VIEWMODEL_BOB_SIDE * moving + swayX,
    -Math.abs(Math.sin(bobPhase)) * VIEWMODEL_BOB_UP * moving + swayY,
    viewmodelKick * VIEWMODEL_RECOIL_BACK,
  );
  viewmodel.rotation.x = viewmodelKick * VIEWMODEL_RECOIL_RISE;
}

export function updateGrenadeView(id: number, x: number, y: number, z: number): void {
  let view = grenadeViews.get(id);
  if (!view && grenadeTemplate) {
    view = grenadeTemplate.clone();
    scene.add(view);
    grenadeViews.set(id, view);
  }
  view?.position.set(x, y, z);
  seenGrenades.add(id);
}

/** Rockets reuse the lightweight projectile mesh but are smaller and visually distinct in motion. */
export function updateRocketView(id: number, x: number, y: number, z: number): void {
  updateGrenadeView(-id, x, y, z);
  const view = grenadeViews.get(-id);
  if (view) view.scale.setScalar(0.55);
}

/** Call once per frame after all updateGrenadeView calls. */
export function removeUnseenGrenades(): void {
  for (const [id, view] of grenadeViews) {
    if (seenGrenades.has(id)) continue;
    scene.remove(view);
    grenadeViews.delete(id);
  }
  seenGrenades.clear();
}

/** Compiles every shader and uploads every texture now, so nothing stutters the first time it
 * appears. Hidden objects are shown for the duration, since compiling skips them. */
export async function warmUp(): Promise<void> {
  if (!renderer) return;
  const hidden: Object3D[] = [];
  for (const root of [scene, viewmodelScene]) {
    root.traverse((object) => {
      if (object.visible) return;
      hidden.push(object);
      object.visible = true;
    });
  }
  await renderer.compileAsync(scene, camera);
  await renderer.compileAsync(viewmodelScene, viewmodelCamera);
  for (const object of hidden) object.visible = false;
  syncViewmodelCamera();
  draw();
}

export function draw(): void {
  if (!renderer) return;
  sky.position.copy(camera.position);
  renderer.clear();
  renderer.render(scene, camera);
  if (!viewmodel.visible) return;
  syncViewmodelCamera();
  renderer.clearDepth();
  renderer.render(viewmodelScene, viewmodelCamera);
}
