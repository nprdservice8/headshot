import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
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
} from "../src/shared/constants.ts";
import { ARENA_BOXES, ARENA_HALF_SIZE, boxRotation, GROUND_PATCHES } from "../src/shared/world.ts";

// Builds public/assets/ from free (CC0) Quaternius models: downloads them, runs the Blender
// scripts in this folder, then compresses the results.
//
//   node art/build.ts            everything (the lightmap bake takes a few minutes)
//   node art/build.ts player     only the soldier, first-person arms and grenade
//   node art/build.ts map        only the map
//   add --preview to render test images into art/out/preview instead of exporting
//
// Needs Blender 5.2. Set BLENDER to its blender.exe if it isn't in the default place below.

const SOURCE_DIR = "art/source";
const OUT_DIR = "art/out";
const ASSETS_DIR = "public/assets";
const BLENDER =
  process.env.BLENDER ??
  join(process.env.LOCALAPPDATA ?? "", "Programs/blender-5.2.2-windows-x64/blender.exe");
const GLTF_TRANSFORM = "node_modules/@gltf-transform/cli/bin/cli.js";

// Google Drive file ids, from the download folders linked on each pack's page at quaternius.com.
const SOURCES: Readonly<Record<string, string>> = {
  // Ultimate Modular Men
  "Swat.gltf": "1VGmU5f8a43NBT22JWB507NDSLbmNxzF9",
  // Ultimate Gun Pack
  "AssaultRifle2_1.blend": "1rK8s_qjUk0ovltVKijcxUe3KtL6rcxCc",
  // Toon Shooter Game Kit
  "Grenade.gltf": "1PoDGyV0rwytND58F15_dKL5TH9QsRaU-",
  "Crate.gltf": "1CARthb8FHddjbfEPG44jbImahtkFfydK",
  "Container_Long.gltf": "10fh-JeIdf_Wwd0gJb72TnGULdD9lcsl3",
  "Container_Small.gltf": "1y0pB6G2lehCu8TuhtCxrbUzn7w7zv_Ci",
};

const args = process.argv.slice(2);
const preview = args.includes("--preview");
const targets = args.filter((arg) => !arg.startsWith("--"));
const wants = (target: string) => targets.length === 0 || targets.includes(target);

async function download(): Promise<void> {
  mkdirSync(SOURCE_DIR, { recursive: true });
  for (const [name, id] of Object.entries(SOURCES)) {
    const path = join(SOURCE_DIR, name);
    if (existsSync(path)) continue;
    console.log(`Downloading ${name}`);
    const url = `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`;
    const response = await fetch(url);
    const body = Buffer.from(await response.arrayBuffer());
    // Drive answers with an HTML page instead of the file when a download is refused.
    if (!response.ok || body.subarray(0, 15).toString().includes("<!")) {
      throw new Error(`Could not download ${name} (HTTP ${response.status})`);
    }
    writeFileSync(path, body);
  }
}

function writeLayout(): void {
  const layout = {
    halfSize: ARENA_HALF_SIZE,
    ground: GROUND_PATCHES,
    boxes: ARENA_BOXES.map((box) => ({ ...box, rotation: boxRotation(box.yaw, box.tilt) })),
    lighting: {
      sunAzimuthDeg: SUN_AZIMUTH_DEG,
      sunElevationDeg: SUN_ELEVATION_DEG,
      sunColor: SUN_COLOR,
      sunIntensity: SUN_INTENSITY,
      zenithColor: SKY_ZENITH_COLOR,
      horizonColor: SKY_HORIZON_COLOR,
      groundColor: GROUND_COLOR,
      skyIntensity: SKY_INTENSITY,
      lightmapRange: LIGHTMAP_RANGE,
      sceneryLightRange: SCENERY_LIGHT_RANGE,
    },
  };
  writeFileSync(join(OUT_DIR, "layout.json"), JSON.stringify(layout, null, 2));
}

function blender(script: string): void {
  const scriptArgs = preview ? ["--", "--preview"] : [];
  execFileSync(
    BLENDER,
    ["-b", "--factory-startup", "--python-exit-code", "1", "--python", script, ...scriptArgs],
    { stdio: "inherit" },
  );
}

function gltfTransform(...commandArgs: string[]): void {
  execFileSync(process.execPath, [GLTF_TRANSFORM, ...commandArgs], { stdio: "inherit" });
}

/** Meshopt-compresses a model. Flattening, joining and palettes are off: they break skinning. */
function optimize(name: string): void {
  const pruned = join(OUT_DIR, `pruned-${name}`);
  // Empty nodes such as "Muzzle" mark points the game looks up, and the map's lightmap UVs have
  // no texture in the file referencing them, so pruning must keep both.
  gltfTransform(
    "prune",
    join(OUT_DIR, name),
    pruned,
    "--keep-leaves",
    "true",
    "--keep-attributes",
    "true",
  );
  gltfTransform(
    "optimize",
    pruned,
    join(ASSETS_DIR, name),
    "--prune",
    "false",
    "--compress",
    "meshopt",
    "--flatten",
    "false",
    "--join",
    "false",
    "--instance",
    "false",
    "--palette",
    "false",
    "--simplify",
    "false",
    "--texture-compress",
    "false",
  );
}

await download();
mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(ASSETS_DIR, { recursive: true });
writeLayout();
if (wants("player")) {
  blender("art/player.py");
  if (!preview)
    for (const name of ["character.glb", "viewmodel.glb", "grenade.glb"]) optimize(name);
}
if (wants("map")) {
  blender("art/map.py");
  if (!preview) {
    optimize("map.glb");
    copyFileSync(join(OUT_DIR, "arena-light.webp"), join(ASSETS_DIR, "arena-light.webp"));
  }
}
