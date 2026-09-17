import { type AnimationClip, type Group, SRGBColorSpace, type Texture, TextureLoader } from "three";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

// Everything the game draws that isn't built in code. art/build.ts makes these files.

const ASSET_DIR = "/assets/";

export type Assets = {
  map: Group;
  arenaLight: Texture;
  character: Group;
  characterClips: AnimationClip[];
  viewmodel: Group;
  grenade: Group;
};

export async function loadAssets(): Promise<Assets> {
  const gltf = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const [map, character, viewmodel, grenade, arenaLight] = await Promise.all([
    gltf.loadAsync(`${ASSET_DIR}map.glb`),
    gltf.loadAsync(`${ASSET_DIR}character.glb`),
    gltf.loadAsync(`${ASSET_DIR}viewmodel.glb`),
    gltf.loadAsync(`${ASSET_DIR}grenade.glb`),
    new TextureLoader().loadAsync(`${ASSET_DIR}arena-light.webp`),
  ]);
  arenaLight.colorSpace = SRGBColorSpace;
  // glTF texture coordinates start at the top of the image.
  arenaLight.flipY = false;
  return {
    map: map.scene,
    arenaLight,
    character: character.scene,
    characterClips: character.animations,
    viewmodel: viewmodel.scene,
    grenade: grenade.scene,
  };
}
