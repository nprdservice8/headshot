import {
  AgXToneMapping,
  BackSide,
  Color,
  DirectionalLight,
  DoubleSide,
  Euler,
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
  Quaternion,
  Scene,
  SphereGeometry,
  Vector3,
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
  SPRINT_FOV_KICK_DEG,
  SUN_AZIMUTH_DEG,
  SUN_COLOR,
  SUN_ELEVATION_DEG,
  SUN_INTENSITY,
  WALK_SPEED,
} from "../shared/constants.ts";
import { clamp } from "../shared/math.ts";
import { weaponDefinition } from "../shared/weapons.ts";
import type { Assets } from "./assets.ts";
import type { ReloadMotion } from "./reload.ts";

const FOG_NEAR = 60;
const FOG_FAR = 260;
const NEAR_PLANE = 0.05;
/** Far enough for the Himalaya on the horizon (art/scenery.py). */
const FAR_PLANE = 2500;
const SKY_RADIUS = 350;
const MAX_PIXEL_RATIO = 2;
// AgX rolls off highlights hard at neutral exposure, which reads as a dim scene; this lifts it.
const EXPOSURE = 1.7;
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
// Aiming down the sights brings the rear sight this far in front of the eye, on the camera's
// axis, and the walk bob nearly dies away so the sight picture holds still.
const VIEWMODEL_SIGHT_DISTANCE = 0.22;
const VIEWMODEL_ADS_BOB = 0.25;
// Where a reload brings the weapon (client/reload.ts times it): a gun drops, comes in towards the
// chest and rolls its magazine well up into view; the launcher is tipped forward off the shoulder.
const VIEWMODEL_RELOAD_DROP = 0.06;
const VIEWMODEL_RELOAD_BACK = 0.03;
const VIEWMODEL_RELOAD_PITCH = 0.12;
const VIEWMODEL_RELOAD_ROLL = 0.42;
const VIEWMODEL_LAUNCHER_RELOAD_DROP = 0.05;
const VIEWMODEL_LAUNCHER_RELOAD_PITCH = -0.3;
const VIEWMODEL_LAUNCHER_RELOAD_ROLL = 0.15;

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
// One mesh, one muzzle point and one copy of the arms (posed for that grip) per weapon id (see
// WEAPON in shared/weapons.ts), all loaded up front and swapped by visibility so switching weapons
// never touches the network or reloads assets. Weapons with iron sights also carry a sight point:
// a camera pose at the rear sight looking along the sight line, which aiming lines up on the eye.
const VIEW_WEAPON_NAMES = ["ViewRifle", "ViewSmg", "ViewBazooka"];
const VIEW_MUZZLE_NAMES = ["MuzzleRifle", "MuzzleSmg", "MuzzleBazooka"];
const VIEW_ARMS_NAMES = ["ArmsRifle", "ArmsSmg", "ArmsBazooka"];
const VIEW_SIGHT_NAMES = ["SightRifle", "SightSmg", "SightBazooka"];
const viewWeapons: Object3D[] = [];
const viewMuzzles: Object3D[] = [];
const viewArms: Object3D[] = [];
const viewSights: Object3D[] = [];
let currentWeapon = 0;
let viewmodelKick = 0;
let bobPhase = 0;
let swayX = 0;
let swayY = 0;
let lastYaw = 0;
let lastPitch = 0;
/** 0 at the hip, 1 with the sights on the eye, sliding between as aiming starts and stops. */
let adsBlend = 0;
let cameraFov = FIELD_OF_VIEW_DEG;
const aimPosition = new Vector3();
const aimQuaternion = new Quaternion();
const baseQuaternion = new Quaternion();
const motionEuler = new Euler();

const sky = new Mesh(
  new SphereGeometry(SKY_RADIUS, 32, 16),
  new MeshBasicMaterial({ vertexColors: true, side: BackSide, fog: false, depthWrite: false }),
);

let renderer: WebGLRenderer | null = null;
const litMaterial = new MeshLambertMaterial({ vertexColors: true });
// The reflex sights' dots glow: pure vertex colour, no lighting or tone mapping to dull them, and
// seen from either side since the disc faces the eye only when aiming.
const dotMaterial = new MeshBasicMaterial({
  vertexColors: true,
  toneMapped: false,
  side: DoubleSide,
});

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
    const weaponIndex = VIEW_WEAPON_NAMES.indexOf(object.name);
    if (weaponIndex !== -1) viewWeapons[weaponIndex] = object;
    const muzzleIndex = VIEW_MUZZLE_NAMES.indexOf(object.name);
    if (muzzleIndex !== -1) viewMuzzles[muzzleIndex] = object;
    const armsIndex = VIEW_ARMS_NAMES.indexOf(object.name);
    if (armsIndex !== -1) viewArms[armsIndex] = object;
    const sightIndex = VIEW_SIGHT_NAMES.indexOf(object.name);
    if (sightIndex !== -1) viewSights[sightIndex] = object;
    if (!(object instanceof Mesh)) return;
    // Safe: the loader gives every mesh a material, named as art/player.py grouped its faces.
    const source = object.material as Material;
    object.material = source.name === "Dot" ? dotMaterial : litMaterial;
  });
  for (let i = 0; i < VIEW_WEAPON_NAMES.length; i++) {
    showViewmodelWeapon(i, i === currentWeapon);
    if (weaponDefinition(i).ironSights && !viewSights[i]) {
      throw new Error(
        `viewmodel.glb has no ${VIEW_SIGHT_NAMES[i]}; rebuild it (npm run art -- player)`,
      );
    }
  }
}

function showViewmodelWeapon(weapon: number, visible: boolean): void {
  for (const parts of [viewWeapons, viewArms]) {
    const part = parts[weapon];
    if (part) part.visible = visible;
  }
}

/** The first-person muzzle of the currently equipped weapon, for effects that attach to it. */
export function getViewmodelMuzzle(): Object3D {
  return viewMuzzles[currentWeapon] ?? viewmodel;
}

/** Shows the equipped weapon's mesh and hides the others. Safe to call every frame. */
export function setViewmodelWeapon(weapon: number): void {
  if (weapon === currentWeapon) return;
  showViewmodelWeapon(currentWeapon, false);
  currentWeapon = weapon;
  showViewmodelWeapon(currentWeapon, true);
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
  // The hills and mountains far away are baked the same way, with haze already in their colours;
  // fog would hide them completely.
  const backdrop = new MeshBasicMaterial({ vertexColors: true, fog: false });
  backdrop.color.setScalar(SCENERY_LIGHT_RANGE);
  const byName: Record<string, Material> = { Scenery: scenery, Backdrop: backdrop };
  assets.map.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    const source = object.material as Material;
    object.material = byName[source.name] ?? arena;
  });
  // The map never moves.
  assets.map.updateMatrixWorld(true);
  assets.map.traverse((object) => {
    object.matrixAutoUpdate = false;
  });
  scene.add(assets.map);
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

/** The point in the world that sits on the drawn first-person muzzle, for bullets and rockets
 * that should be seen leaving it. The arms are drawn through a narrower lens than the world, so
 * the muzzle's own world position would land inward of it on screen; its sideways offsets from
 * the eye are scaled by the ratio of the two lenses to compensate. */
export function muzzleWorldPosition(out: Vector3): Vector3 {
  syncViewmodelCamera();
  getViewmodelMuzzle().getWorldPosition(out);
  viewmodelCamera.worldToLocal(out);
  const match =
    Math.tan((VIEWMODEL_FOV_DEG * Math.PI) / 360) / Math.tan((camera.fov * Math.PI) / 360);
  out.x *= match;
  out.y *= match;
  return viewmodelCamera.localToWorld(out);
}

/** `strength` is the weapon's recoil (shared/weapons.ts): 1 is the rifle's kick. */
export function kickViewmodel(strength: number): void {
  viewmodelKick = strength;
}

/** Recoil, walking bob, a little lag behind mouse movement, and the reload's motion on top; all
 * of it on a base pose that slides from the hip to the sights lined up on the eye while aiming. */
export function updateViewmodel(
  dt: number,
  distanceMoved: number,
  grounded: boolean,
  yaw: number,
  pitch: number,
  ads: boolean,
  reload: ReloadMotion,
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
  const sight = viewSights[currentWeapon];
  const aiming = ads && sight !== undefined;
  adsBlend += ((aiming ? 1 : 0) - adsBlend) * (1 - Math.exp(-ADS_TRANSITION_PER_SEC * dt));
  const bob = moving * (1 - adsBlend * (1 - VIEWMODEL_ADS_BOB));
  const launcher = weaponDefinition(currentWeapon).projectile !== null;
  const lowered = reload.lower;
  viewmodel.position.set(
    Math.cos(bobPhase) * VIEWMODEL_BOB_SIDE * bob + swayX + reload.x,
    -Math.abs(Math.sin(bobPhase)) * VIEWMODEL_BOB_UP * bob +
      swayY -
      lowered * (launcher ? VIEWMODEL_LAUNCHER_RELOAD_DROP : VIEWMODEL_RELOAD_DROP) +
      reload.y,
    viewmodelKick * VIEWMODEL_RECOIL_BACK + lowered * VIEWMODEL_RELOAD_BACK + reload.z,
  );
  motionEuler.set(
    viewmodelKick * VIEWMODEL_RECOIL_RISE +
      lowered * (launcher ? VIEWMODEL_LAUNCHER_RELOAD_PITCH : VIEWMODEL_RELOAD_PITCH) +
      reload.pitch,
    0,
    lowered * (launcher ? VIEWMODEL_LAUNCHER_RELOAD_ROLL : VIEWMODEL_RELOAD_ROLL),
  );
  viewmodel.quaternion.setFromEuler(motionEuler);
  if (sight === undefined || adsBlend < 0.001) return;
  // The pose that moves the sight point onto the camera's axis, VIEWMODEL_SIGHT_DISTANCE ahead:
  // undo the sight's own rotation, then carry what is left of its offset back to the eye.
  aimQuaternion.copy(sight.quaternion).invert();
  aimPosition.copy(sight.position).applyQuaternion(aimQuaternion).negate();
  aimPosition.z -= VIEWMODEL_SIGHT_DISTANCE;
  baseQuaternion.identity().slerp(aimQuaternion, adsBlend);
  viewmodel.quaternion.premultiply(baseQuaternion);
  viewmodel.position.applyQuaternion(baseQuaternion).addScaledVector(aimPosition, adsBlend);
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
