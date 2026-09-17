import {
  type AnimationAction,
  AnimationClip,
  AnimationMixer,
  DataTexture,
  Group,
  InstancedMesh,
  type Material,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  type Object3D,
  PlaneGeometry,
  Quaternion,
  type Scene,
  SkinnedMesh,
  Vector3,
} from "three";
import { clone as cloneSkinned } from "three/addons/utils/SkeletonUtils.js";
import { MAX_PLAYERS, WALK_SPEED } from "../shared/constants.ts";
import { clamp } from "../shared/math.ts";
import type { Assets } from "./assets.ts";

// Other players' soldiers. The legs play running clips blended by the direction of travel; the
// upper body holds a rifle pose that pitches with the player's aim.

const TEAM_COLORS = [
  0xb8433b, 0x3b6fb8, 0x4e9a58, 0xc99a2e, 0x8250b8, 0x2e9e9e, 0xb85890, 0xa6a6a6,
];
/** Metres travelled in one loop of the running clips, so the feet don't slide. */
const RUN_CYCLE_METRES = 4.6;
const SPEED_SMOOTHING_PER_SEC = 12;
/** Faster than this up or down counts as off the ground (ramps stay below it). */
const AIRBORNE_SPEED = 3.5;
/** A jump of more than this in one frame is a respawn, not movement. */
const MAX_FRAME_STEP = 1;
const TORSO_PITCH_SHARE = 0.45;
const RECOIL_PITCH = 0.14;
const RECOIL_RECOVERY_PER_SEC = 10;
const SHADOW_SIZE = 1.1;
const SHADOW_OPACITY = 0.55;
const SHADOW_LIFT = 0.02;
const SHADOW_MAX_HEIGHT = 3;
const SHADOW_TEXTURE_SIZE = 32;

export type CharacterModel = {
  model: Object3D;
  /** The skeleton's bones, in the same order for every model. */
  bones: Object3D[];
  teamMaterial: MeshLambertMaterial;
};

export type PlayerView = CharacterModel & {
  root: Group;
  mixer: AnimationMixer;
  idle: AnimationAction;
  runForward: AnimationAction;
  runBack: AnimationAction;
  runLeft: AnimationAction;
  runRight: AnimationAction;
  runs: AnimationAction[];
  torso: Object3D;
  chest: Object3D;
  torsoAxis: Vector3;
  chestAxis: Vector3;
  muzzle: Object3D;
  shadowSlot: number;
  runPhase: number;
  forwardSpeed: number;
  sideSpeed: number;
  recoil: number;
  lastX: number;
  lastY: number;
  lastZ: number;
};

/** Distance from a point straight down to the ground, up to `max`. */
export type GroundProbe = (x: number, y: number, z: number, max: number) => number;

type Clips = {
  idle: AnimationClip;
  runForward: AnimationClip;
  runBack: AnimationClip;
  runLeft: AnimationClip;
  runRight: AnimationClip;
  aim: AnimationClip;
};

const playerViews = new Map<number, PlayerView>();
const bodyMaterial = new MeshLambertMaterial({ vertexColors: true });
const shadowSlotsUsed: boolean[] = [];

let scene: Scene | null = null;
let template: Object3D | null = null;
let clips: Clips | null = null;
let shadows: InstancedMesh | null = null;
let probeGround: GroundProbe = () => 0;

const tmpQuaternion = new Quaternion();
const tmpMatrix = new Matrix4();
const tmpPosition = new Vector3();
const tmpScale = new Vector3();
const identity = new Quaternion();
const rightAxis = new Vector3(1, 0, 0);

export function teamColor(id: number): number {
  return TEAM_COLORS[id % TEAM_COLORS.length] ?? 0xffffff;
}

function findClip(all: AnimationClip[], name: string): AnimationClip {
  const clip = AnimationClip.findByName(all, name);
  if (!clip) throw new Error(`character.glb has no "${name}" animation`);
  return clip;
}

/** A copy of a clip that only moves some bones, and never scales them. */
function clipFor(clip: AnimationClip, keep: (bone: string) => boolean): AnimationClip {
  const tracks = clip.tracks.filter((track) => {
    const dot = track.name.lastIndexOf(".");
    return track.name.slice(dot + 1) !== "scale" && keep(track.name.slice(0, dot));
  });
  // A single-pose clip has zero length, which would make looping divide by zero.
  return new AnimationClip(clip.name, Math.max(clip.duration, 1), tracks);
}

function findObject(root: Object3D, name: string): Object3D {
  const found = root.getObjectByName(name);
  if (!found) throw new Error(`character.glb has no "${name}" node`);
  return found;
}

export function initCharacters(assets: Assets, targetScene: Scene, probe: GroundProbe): void {
  scene = targetScene;
  probeGround = probe;
  template = assets.character;
  const upperBody = new Set<string>();
  findObject(template, "Torso").traverse((bone) => {
    upperBody.add(bone.name);
  });
  const all = assets.characterClips;
  const legs = (bone: string) => !upperBody.has(bone);
  clips = {
    idle: clipFor(findClip(all, "Idle"), legs),
    runForward: clipFor(findClip(all, "RunForward"), legs),
    runBack: clipFor(findClip(all, "RunBack"), legs),
    runLeft: clipFor(findClip(all, "RunLeft"), legs),
    runRight: clipFor(findClip(all, "RunRight"), legs),
    aim: clipFor(findClip(all, "Aim"), (bone) => upperBody.has(bone)),
  };

  const data = new Uint8Array(SHADOW_TEXTURE_SIZE * SHADOW_TEXTURE_SIZE * 4);
  for (let y = 0; y < SHADOW_TEXTURE_SIZE; y++) {
    for (let x = 0; x < SHADOW_TEXTURE_SIZE; x++) {
      const radius = Math.hypot(
        x + 0.5 - SHADOW_TEXTURE_SIZE / 2,
        y + 0.5 - SHADOW_TEXTURE_SIZE / 2,
      );
      data[(y * SHADOW_TEXTURE_SIZE + x) * 4 + 3] = Math.round(
        255 * clamp(1 - radius / (SHADOW_TEXTURE_SIZE / 2), 0, 1) ** 1.5,
      );
    }
  }
  const texture = new DataTexture(data, SHADOW_TEXTURE_SIZE, SHADOW_TEXTURE_SIZE);
  texture.needsUpdate = true;
  const material = new MeshBasicMaterial({
    map: texture,
    transparent: true,
    opacity: SHADOW_OPACITY,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
  });
  shadows = new InstancedMesh(new PlaneGeometry(1, 1).rotateX(-Math.PI / 2), material, MAX_PLAYERS);
  // Instances move every frame, so the whole-mesh bounds used for culling would be wrong.
  shadows.frustumCulled = false;
  for (let i = 0; i < MAX_PLAYERS; i++) {
    shadows.setMatrixAt(i, tmpMatrix.makeScale(0, 0, 0));
    shadowSlotsUsed.push(false);
  }
  targetScene.add(shadows);
}

/** A soldier with this player's colours, not yet added to any scene. */
export function createCharacterModel(id: number): CharacterModel {
  if (!template) throw new Error("initCharacters must run first");
  const model = cloneSkinned(template);
  const teamMaterial = new MeshLambertMaterial({ vertexColors: true, color: teamColor(id) });
  let bones: Object3D[] = [];
  model.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    // Material names come from art/player.py: "Team" is the uniform, tinted per player.
    const source = object.material as Material;
    object.material = source.name === "Team" ? teamMaterial : bodyMaterial;
    if (object instanceof SkinnedMesh) bones = object.skeleton.bones;
  });
  return { model, bones, teamMaterial };
}

/** The axis, in a bone's own space, that points to the character's right in the aim pose.
 * Call while the character stands unrotated at the origin. */
function pitchAxis(bone: Object3D): Vector3 {
  bone.getWorldQuaternion(tmpQuaternion);
  return rightAxis.clone().applyQuaternion(tmpQuaternion.invert());
}

function createPlayerView(id: number): PlayerView {
  if (!scene || !clips || !shadows) throw new Error("initCharacters must run first");
  const character = createCharacterModel(id);
  const root = new Group();
  root.add(character.model);
  scene.add(root);
  const mixer = new AnimationMixer(character.model);
  const action = (clip: AnimationClip, weight: number, timeScale: number) => {
    const created = mixer.clipAction(clip);
    created.setEffectiveWeight(weight);
    created.timeScale = timeScale;
    created.play();
    return created;
  };
  mixer.clipAction(clips.aim).play();
  const view: PlayerView = {
    ...character,
    root,
    mixer,
    idle: action(clips.idle, 1, 1),
    // Running clips are posed by distance travelled rather than by time.
    runForward: action(clips.runForward, 0, 0),
    runBack: action(clips.runBack, 0, 0),
    runLeft: action(clips.runLeft, 0, 0),
    runRight: action(clips.runRight, 0, 0),
    runs: [],
    torso: findObject(character.model, "Torso"),
    chest: findObject(character.model, "Chest"),
    torsoAxis: new Vector3(),
    chestAxis: new Vector3(),
    muzzle: findObject(character.model, "Muzzle"),
    shadowSlot: shadowSlotsUsed.indexOf(false),
    runPhase: 0,
    forwardSpeed: 0,
    sideSpeed: 0,
    recoil: 0,
    lastX: 0,
    lastY: 0,
    lastZ: 0,
  };
  view.runs = [view.runForward, view.runBack, view.runLeft, view.runRight];
  if (view.shadowSlot >= 0) shadowSlotsUsed[view.shadowSlot] = true;
  mixer.update(0);
  root.updateMatrixWorld(true);
  view.torsoAxis.copy(pitchAxis(view.torso));
  view.chestAxis.copy(pitchAxis(view.chest));
  return view;
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
    view.lastY = y;
    view.lastZ = z;
    playerViews.set(id, view);
  }
  view.root.visible = visible;
  view.root.position.set(x, y, z);
  view.root.rotation.y = yaw;

  const dx = x - view.lastX;
  const dy = y - view.lastY;
  const dz = z - view.lastZ;
  view.lastX = x;
  view.lastY = y;
  view.lastZ = z;
  const step = Math.hypot(dx, dz);
  const teleported = step > MAX_FRAME_STEP;
  const airborne = dt > 0 && Math.abs(dy / dt) > AIRBORNE_SPEED;
  if (dt > 0 && !teleported) {
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    // Yaw 0 faces -Z, so forward is (-sin, -cos) and right is (cos, -sin).
    const forward = -(dx * sin + dz * cos) / dt;
    const side = (dx * cos - dz * sin) / dt;
    const blend = 1 - Math.exp(-SPEED_SMOOTHING_PER_SEC * dt);
    view.forwardSpeed += (forward - view.forwardSpeed) * blend;
    view.sideSpeed += (side - view.sideSpeed) * blend;
    if (!airborne) view.runPhase = (view.runPhase + step / RUN_CYCLE_METRES) % 1;
  }
  animate(view, dt);
  pose(view, pitch, dt);
  placeShadow(view, x, y, z, visible);
}

function animate(view: PlayerView, dt: number): void {
  const forward = view.forwardSpeed;
  const side = view.sideSpeed;
  const moving = clamp(Math.hypot(forward, side) / WALK_SPEED, 0, 1);
  const total = Math.abs(forward) + Math.abs(side) || 1;
  view.idle.setEffectiveWeight(1 - moving);
  view.runForward.setEffectiveWeight((moving * Math.max(forward, 0)) / total);
  view.runBack.setEffectiveWeight((moving * Math.max(-forward, 0)) / total);
  view.runRight.setEffectiveWeight((moving * Math.max(side, 0)) / total);
  view.runLeft.setEffectiveWeight((moving * Math.max(-side, 0)) / total);
  for (const run of view.runs) run.time = view.runPhase * run.getClip().duration;
  view.mixer.update(dt);
}

/** Aim pitch and recoil, applied on top of the animation's upper-body pose. */
function pose(view: PlayerView, pitch: number, dt: number): void {
  view.recoil *= Math.exp(-RECOIL_RECOVERY_PER_SEC * dt);
  tmpQuaternion.setFromAxisAngle(view.torsoAxis, pitch * TORSO_PITCH_SHARE);
  view.torso.quaternion.multiply(tmpQuaternion);
  tmpQuaternion.setFromAxisAngle(
    view.chestAxis,
    pitch * (1 - TORSO_PITCH_SHARE) + view.recoil * RECOIL_PITCH,
  );
  view.chest.quaternion.multiply(tmpQuaternion);
}

function placeShadow(view: PlayerView, x: number, y: number, z: number, visible: boolean): void {
  if (!shadows || view.shadowSlot < 0) return;
  const height = visible ? probeGround(x, y, z, SHADOW_MAX_HEIGHT) : SHADOW_MAX_HEIGHT;
  const size = SHADOW_SIZE * clamp(1 - height / SHADOW_MAX_HEIGHT, 0, 1);
  tmpPosition.set(x, y - height + SHADOW_LIFT, z);
  tmpScale.set(size, 1, size);
  shadows.setMatrixAt(view.shadowSlot, tmpMatrix.compose(tmpPosition, identity, tmpScale));
  shadows.instanceMatrix.needsUpdate = true;
}

export function playShot(id: number): void {
  const view = playerViews.get(id);
  if (view) view.recoil = 1;
}

/** Where a player's rifle muzzle is. False if that player isn't being drawn. */
export function muzzlePosition(id: number, out: Vector3): boolean {
  const view = playerViews.get(id);
  if (!view?.root.visible) return false;
  view.muzzle.getWorldPosition(out);
  return true;
}

export function removePlayerViewsExcept(keep: ReadonlySet<number>): void {
  for (const [id, view] of playerViews) {
    if (keep.has(id)) continue;
    scene?.remove(view.root);
    view.mixer.stopAllAction();
    view.mixer.uncacheRoot(view.model);
    view.teamMaterial.dispose();
    if (view.shadowSlot >= 0) {
      shadowSlotsUsed[view.shadowSlot] = false;
      shadows?.setMatrixAt(view.shadowSlot, tmpMatrix.makeScale(0, 0, 0));
    }
    playerViews.delete(id);
  }
}
