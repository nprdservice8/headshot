import {
  BoxGeometry,
  type BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  type Object3D,
  type Scene,
  Vector3,
} from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { ROCKET_CONVERGE_DISTANCE } from "../shared/constants.ts";
import { clamp } from "../shared/math.ts";

// Grenades and rockets live on the server; this draws them from snapshots. The grenade is a
// loaded model, the rocket an RPG round built here from primitives (no CC0 source for one).
// The server launches a rocket from the shooter's eye, which on screen is nowhere near their
// gun, so a rocket is drawn leaving the muzzle it was fired from and slides onto its true path
// over its first metres, the way bullet streaks do.

/** How far ahead of a rocket's true position its nose is pointed while it slides onto its path. */
const ROCKET_LOOK_AHEAD = 2;

const ROCKET_SEGMENTS = 10;
const WARHEAD_RADIUS = 0.075;
const WARHEAD_LENGTH = 0.24;
const COLLAR_LENGTH = 0.1;
const TUBE_RADIUS = 0.035;
const TUBE_LENGTH = 0.42;
const FIN_COUNT = 4;
const FIN_SIZE = new Vector3(0.01, 0.09, 0.12);
const FIN_OFFSET = 0.06;
const FLAME_RADIUS = 0.045;
const FLAME_LENGTH = 0.22;
const WARHEAD_COLOR = 0x4f5a2f;
const TUBE_COLOR = 0x2a2d2b;
const FIN_COLOR = 0x171817;
const FLAME_COLOR = 0xffa040;

type RocketView = {
  view: Object3D;
  /** Where the rocket truly was when first drawn, and the offset from there to the muzzle. */
  startX: number;
  startY: number;
  startZ: number;
  offsetX: number;
  offsetY: number;
  offsetZ: number;
};

const grenadeViews = new Map<number, Object3D>();
const rocketViews = new Map<number, RocketView>();
const seenGrenades = new Set<number>();
const seenRockets = new Set<number>();
let grenadeTemplate: Object3D | null = null;
let rocketTemplate: Object3D | null = null;
let projectileScene: Scene | null = null;
const tmpColor = new Color();
const tmpTarget = new Vector3();

/** Fills the geometry's vertex colours with one colour, so every part shares one lit material. */
function paint(geometry: BufferGeometry, hex: number): BufferGeometry {
  tmpColor.set(hex);
  const count = geometry.getAttribute("position").count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) tmpColor.toArray(colors, i * 3);
  geometry.setAttribute("color", new Float32BufferAttribute(colors, 3));
  return geometry;
}

/** An RPG round with its nose along +Z, so `lookAt` points it down its flight path. Cylinders
 * and cones stand along Y by default, so each is tipped over first. */
function buildRocket(litMaterial: MeshLambertMaterial): Object3D {
  const tubeRear = -TUBE_LENGTH / 2;
  const tubeFront = TUBE_LENGTH / 2;
  const parts: BufferGeometry[] = [
    paint(
      new ConeGeometry(WARHEAD_RADIUS, WARHEAD_LENGTH, ROCKET_SEGMENTS)
        .rotateX(Math.PI / 2)
        .translate(0, 0, tubeFront + COLLAR_LENGTH + WARHEAD_LENGTH / 2),
      WARHEAD_COLOR,
    ),
    paint(
      new CylinderGeometry(WARHEAD_RADIUS, TUBE_RADIUS, COLLAR_LENGTH, ROCKET_SEGMENTS)
        .rotateX(Math.PI / 2)
        .translate(0, 0, tubeFront + COLLAR_LENGTH / 2),
      WARHEAD_COLOR,
    ),
    paint(
      new CylinderGeometry(TUBE_RADIUS, TUBE_RADIUS, TUBE_LENGTH, ROCKET_SEGMENTS).rotateX(
        Math.PI / 2,
      ),
      TUBE_COLOR,
    ),
  ];
  for (let i = 0; i < FIN_COUNT; i++) {
    parts.push(
      paint(
        new BoxGeometry(FIN_SIZE.x, FIN_SIZE.y, FIN_SIZE.z)
          .translate(0, FIN_OFFSET, tubeRear + FIN_SIZE.z / 2)
          .rotateZ((i * Math.PI * 2) / FIN_COUNT),
        FIN_COLOR,
      ),
    );
  }
  const body = mergeGeometries(parts);
  for (const part of parts) part.dispose();
  const rocket = new Group();
  rocket.add(new Mesh(body, litMaterial));
  const flame = new ConeGeometry(FLAME_RADIUS, FLAME_LENGTH, ROCKET_SEGMENTS)
    .rotateX(-Math.PI / 2)
    .translate(0, 0, tubeRear - FLAME_LENGTH / 2);
  rocket.add(new Mesh(flame, new MeshBasicMaterial({ color: FLAME_COLOR, toneMapped: false })));
  return rocket;
}

export function initProjectiles(scene: Scene, grenade: Object3D): void {
  projectileScene = scene;
  const litMaterial = new MeshLambertMaterial({ vertexColors: true });
  grenade.traverse((object) => {
    if (object instanceof Mesh) object.material = litMaterial;
  });
  grenadeTemplate = grenade;
  rocketTemplate = buildRocket(litMaterial);
}

function projectileView(id: number, template: Object3D | null): Object3D | undefined {
  let view = grenadeViews.get(id);
  if (!view && template && projectileScene) {
    view = template.clone();
    projectileScene.add(view);
    grenadeViews.set(id, view);
  }
  seenGrenades.add(id);
  return view;
}

export function updateGrenadeView(id: number, x: number, y: number, z: number): void {
  projectileView(id, grenadeTemplate)?.position.set(x, y, z);
}

/** The heading never changes in flight, so the model is pointed along it every frame. A rocket
 * seen for the first time starts at `muzzle` (where its shooter's gun is drawn; null when that
 * isn't known) and slides onto its true path over ROCKET_CONVERGE_DISTANCE. Returns whether this
 * is the rocket's first frame. */
export function updateRocketView(
  id: number,
  x: number,
  y: number,
  z: number,
  dx: number,
  dy: number,
  dz: number,
  muzzle: Vector3 | null,
): boolean {
  let rocket = rocketViews.get(id);
  const isNew = !rocket;
  if (!rocket) {
    if (!rocketTemplate || !projectileScene) return false;
    const view = rocketTemplate.clone();
    projectileScene.add(view);
    rocket = {
      view,
      startX: x,
      startY: y,
      startZ: z,
      offsetX: muzzle ? muzzle.x - x : 0,
      offsetY: muzzle ? muzzle.y - y : 0,
      offsetZ: muzzle ? muzzle.z - z : 0,
    };
    rocketViews.set(id, rocket);
  }
  seenRockets.add(id);
  const flown = Math.hypot(x - rocket.startX, y - rocket.startY, z - rocket.startZ);
  const slide = 1 - clamp(flown / ROCKET_CONVERGE_DISTANCE, 0, 1);
  rocket.view.position.set(
    x + rocket.offsetX * slide,
    y + rocket.offsetY * slide,
    z + rocket.offsetZ * slide,
  );
  rocket.view.lookAt(
    tmpTarget.set(
      x + dx * ROCKET_LOOK_AHEAD,
      y + dy * ROCKET_LOOK_AHEAD,
      z + dz * ROCKET_LOOK_AHEAD,
    ),
  );
  return isNew;
}

/** Call once per frame after all updateGrenadeView and updateRocketView calls. */
export function removeUnseenProjectiles(): void {
  for (const [id, view] of grenadeViews) {
    if (seenGrenades.has(id)) continue;
    projectileScene?.remove(view);
    grenadeViews.delete(id);
  }
  seenGrenades.clear();
  for (const [id, rocket] of rocketViews) {
    if (seenRockets.has(id)) continue;
    projectileScene?.remove(rocket.view);
    rocketViews.delete(id);
  }
  seenRockets.clear();
}
