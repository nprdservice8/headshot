import assert from "node:assert/strict";
import { test } from "node:test";
import { AnimationClip, Bone, Group, QuaternionKeyframeTrack, Scene, Texture } from "three";
import { getPlayerView, initCharacters, updatePlayerView } from "./characters.ts";

function bone(name: string, ...children: Bone[]): Bone {
  const created = new Bone();
  created.name = name;
  for (const child of children) created.add(child);
  return created;
}

test("aim pitch holds steady instead of stacking up every frame", () => {
  const character = new Group();
  character.add(bone("Torso", bone("Chest", bone("Muzzle"))));
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

  updatePlayerView(1, 0, 0, 0, 0, 0.4, true, 1 / 60);
  const view = getPlayerView(1);
  assert.ok(view);
  const torso = view.torso.quaternion.toArray();
  const chest = view.chest.quaternion.toArray();
  for (let frame = 0; frame < 10; frame++) updatePlayerView(1, 0, 0, 0, 0, 0.4, true, 1 / 60);
  assert.deepEqual(view.torso.quaternion.toArray(), torso);
  assert.deepEqual(view.chest.quaternion.toArray(), chest);
});
