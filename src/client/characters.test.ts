import assert from "node:assert/strict";
import { test } from "node:test";
import { AnimationClip, Bone, Group, QuaternionKeyframeTrack, Scene, Texture } from "three";
import { getPlayerView, initCharacters, updatePlayerView } from "./characters.ts";
import type { ReloadMotion } from "./reload.ts";

function bone(name: string, ...children: Bone[]): Bone {
  const created = new Bone();
  created.name = name;
  for (const child of children) created.add(child);
  return created;
}

const still: ReloadMotion = { lower: 0, hand: 0, x: 0, y: 0, z: 0, pitch: 0 };

function setUpCharacters(): void {
  const character = new Group();
  character.add(bone("Torso", bone("Chest", bone("Muzzle"), bone("UpperArmL"))));
  // character.glb carries one node per look (see art/player.py), which createCharacterModel toggles.
  for (const look of ["King", "General"]) {
    const skin = new Group();
    skin.name = look;
    character.add(skin);
  }
  // A single-key pose, like the real aim clip: its value never changes after the first frame.
  const aimPose = [0, 0.2, 0, Math.sqrt(1 - 0.04)];
  const aim = new AnimationClip("Aim", 0, [
    new QuaternionKeyframeTrack("Torso.quaternion", [0], aimPose),
    new QuaternionKeyframeTrack("Chest.quaternion", [0], aimPose),
  ]);
  const legClips = ["Idle", "RunForward", "RunBack", "RunLeft", "RunRight"].map(
    (name) => new AnimationClip(name, 1, []),
  );
  const assets = {
    map: new Group(),
    arenaLight: new Texture(),
    character,
    characterClips: [aim, ...legClips],
    viewmodel: new Group(),
    grenade: new Group(),
  };
  initCharacters(assets, new Scene(), () => 0);
}

test("aim pitch holds steady instead of stacking up every frame", () => {
  setUpCharacters();
  updatePlayerView(1, 0, 0, 0, 0, 0.4, true, still, 1 / 60);
  const view = getPlayerView(1);
  assert.ok(view);
  const torso = view.torso.quaternion.toArray();
  const chest = view.chest.quaternion.toArray();
  for (let frame = 0; frame < 10; frame++) {
    updatePlayerView(1, 0, 0, 0, 0, 0.4, true, still, 1 / 60);
  }
  assert.deepEqual(view.torso.quaternion.toArray(), torso);
  assert.deepEqual(view.chest.quaternion.toArray(), chest);
});

test("a reload swings the support arm and dips the rifle, then leaves the aim pose as it was", () => {
  setUpCharacters();
  updatePlayerView(2, 0, 0, 0, 0, 0, true, still, 1 / 60);
  const view = getPlayerView(2);
  assert.ok(view);
  const arm = view.arm.quaternion.toArray();
  const chest = view.chest.quaternion.toArray();
  const reloading: ReloadMotion = { lower: 1, hand: 1, x: 0, y: 0, z: 0, pitch: 0 };
  updatePlayerView(2, 0, 0, 0, 0, 0, true, reloading, 1 / 60);
  assert.notDeepEqual(view.arm.quaternion.toArray(), arm);
  assert.notDeepEqual(view.chest.quaternion.toArray(), chest);
  updatePlayerView(2, 0, 0, 0, 0, 0, true, still, 1 / 60);
  assert.deepEqual(view.arm.quaternion.toArray(), arm);
  assert.deepEqual(view.chest.quaternion.toArray(), chest);
});
