import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { inflateRawSync } from "node:zlib";
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

// Builds public/assets/ from free (CC0) sources: Quaternius models, which are downloaded, run
// through the Blender scripts in this folder and compressed, and recorded sounds (Kenney's
// footsteps, the Free Firearm Sound Library's guns, rubberduck's fireworks for explosions,
// SpringySpringo's and Brian MacIntosh's gun handling for reloads).
//
//   node art/build.ts            everything (the lightmap bake takes a few minutes)
//   node art/build.ts player     only the characters, first-person arms and grenade
//   node art/build.ts map        only the map
//   node art/build.ts sounds     only the sound samples (needs art/source/firearms, see below)
//   add --preview to render test images into art/out/preview instead of exporting
//
// Needs Blender 5.2. Set BLENDER to its blender.exe if it isn't in the default place below.

const SOURCE_DIR = "art/source";
const OUT_DIR = "art/out";
const ASSETS_DIR = "public/assets";
const SOUNDS_DIR = "public/assets/sounds";
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
  "SubmachineGun_2.blend": "1lZ9pCt7irLKjhc6PCkkQYCFb2f5-_99x",
  // Toon Shooter Game Kit
  "Grenade.gltf": "1PoDGyV0rwytND58F15_dKL5TH9QsRaU-",
  "RocketLauncher.gltf": "1TktWvDvJd_caCULg9ddKQOcIIDxCQ92x",
  "Crate.gltf": "1CARthb8FHddjbfEPG44jbImahtkFfydK",
  "Debris_BrokenCar.gltf": "1Mndrt2nFDOQWMcvGsYbVZoU5DKhL0mrt",
  "Container_Long.gltf": "10fh-JeIdf_Wwd0gJb72TnGULdD9lcsl3",
  "Container_Small.gltf": "1y0pB6G2lehCu8TuhtCxrbUzn7w7zv_Ci",
};

// Kenney's Impact Sounds (CC0, kenney.nl/assets/impact-sounds): recorded footsteps. The concrete
// steps ship as they are (game name → member of the zip); the grass steps are long rustles that
// art/sounds.py cuts short for dirt. The game picks a set by the ground it walks on
// (src/client/footsteps.ts), so the counts here are what it expects.
const SOUND_PACK_URL =
  "https://kenney.nl/media/pages/assets/impact-sounds/87b4ddecda-1677589768/kenney_impact-sounds.zip";
const SOUND_PACK = "kenney_impact-sounds.zip";
const SOUNDS: Readonly<Record<string, string>> = {
  "step-stone-0.ogg": "Audio/footstep_concrete_000.ogg",
  "step-stone-1.ogg": "Audio/footstep_concrete_001.ogg",
  "step-stone-2.ogg": "Audio/footstep_concrete_002.ogg",
  "step-stone-3.ogg": "Audio/footstep_concrete_003.ogg",
  "step-stone-4.ogg": "Audio/footstep_concrete_004.ogg",
};
const IMPACTS_OUT_DIR = "art/out/impacts";

// Weapon samples are cut by art/sounds.py from two more CC0 recordings. rubberduck's fireworks
// (opengameart.org/content/25-cc0-bang-firework-sfx) download here; The Free Firearm Sound
// Library (opengameart.org/content/the-free-firearm-sound-library) is a 194 MB .7z that Node
// can't unpack, so extract it with 7-Zip into art/source/firearms/ once by hand.
const BANG_PACK_URL = "https://opengameart.org/sites/default/files/25-CC0-bang-sfx.zip";
const BANG_PACK = "25-CC0-bang-sfx.zip";
const BANGS_OUT_DIR = "art/out/bangs";
const FIREARMS_DIR = "art/source/firearms/Prepared SFX Library";
// Reloads are cut from two more CC0 recordings of gun handling: SpringySpringo's airsoft reloads
// (opengameart.org/content/gun-reload-sounds) and Brian MacIntosh's clip loads
// (opengameart.org/content/gun-reload-sound-effects).
const RELOAD_RECORDINGS: readonly string[] = [
  "gunreload1.wav",
  "assaultriflereload1_0.wav",
  "shotguncock_0.wav",
  "clipload1.wav",
  "clipload2.wav",
  "singlebullet1.wav",
];
const RELOAD_RECORDINGS_URL = "https://opengameart.org/sites/default/files/";

// The map's traffic comes from Kenney's Car Kit (CC0, kenney.nl/assets/car-kit): these models
// plus the palette image they are painted from, kept in art/source/carkit. Shop signs are set in
// Noto Sans Devanagari (OFL), from the Google Fonts repository.
const CAR_KIT_URL =
  "https://kenney.nl/media/pages/assets/car-kit/1a312ec241-1775131960/kenney_car-kit.zip";
const CAR_KIT = "kenney_car-kit.zip";
const CAR_KIT_DIR = "art/source/carkit";
const CAR_KIT_MODELS = ["sedan", "hatchback-sports", "suv", "taxi", "van", "truck", "delivery"];
const CAR_KIT_PALETTE = "Textures/colormap.png";
const FONT_URL =
  "https://raw.githubusercontent.com/google/fonts/main/ofl/notosansdevanagari/NotoSansDevanagari%5Bwdth%2Cwght%5D.ttf";
const FONT = "NotoSansDevanagari.ttf";

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

async function downloadFile(url: string, name: string): Promise<void> {
  const path = join(SOURCE_DIR, name);
  if (existsSync(path)) return;
  console.log(`Downloading ${name}`);
  // Some hosts refuse requests without a browser-like user agent.
  const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!response.ok) throw new Error(`Could not download ${name} (HTTP ${response.status})`);
  writeFileSync(path, Buffer.from(await response.arrayBuffer()));
}

/** The members of a zip file by name. Zips are simple enough that reading them here beats
 * depending on whichever tar or unzip the shell happens to find. */
function readZip(path: string): Map<string, Buffer> {
  const zip = readFileSync(path);
  const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
  const CENTRAL_FILE_HEADER = 0x02014b50;
  let end = zip.length - 22;
  while (end >= 0 && zip.readUInt32LE(end) !== END_OF_CENTRAL_DIRECTORY) end--;
  if (end < 0) throw new Error(`${path} is not a zip file`);
  const entries = zip.readUInt16LE(end + 10);
  let offset = zip.readUInt32LE(end + 16);
  const members = new Map<string, Buffer>();
  for (let i = 0; i < entries; i++) {
    if (zip.readUInt32LE(offset) !== CENTRAL_FILE_HEADER) throw new Error(`${path} is corrupt`);
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localHeader = zip.readUInt32LE(offset + 42);
    const name = zip.toString("utf8", offset + 46, offset + 46 + nameLength);
    // The local header repeats the name and extra fields, with its own lengths.
    const dataStart =
      localHeader + 30 + zip.readUInt16LE(localHeader + 26) + zip.readUInt16LE(localHeader + 28);
    const data = zip.subarray(dataStart, dataStart + compressedSize);
    members.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return members;
}

/** Writes the chosen samples into the assets folder under their game names. The .ogg files are
 * small and already compressed, so they ship as they are. */
function buildSounds(): void {
  mkdirSync(SOUNDS_DIR, { recursive: true });
  const members = readZip(join(SOURCE_DIR, SOUND_PACK));
  for (const [name, member] of Object.entries(SOUNDS)) {
    const data = members.get(member);
    if (!data) throw new Error(`${SOUND_PACK} has no ${member}`);
    writeFileSync(join(SOUNDS_DIR, name), data);
  }
  mkdirSync(IMPACTS_OUT_DIR, { recursive: true });
  for (const [name, data] of members) {
    if (name.endsWith(".ogg")) writeFileSync(join(IMPACTS_OUT_DIR, basename(name)), data);
  }
  mkdirSync(BANGS_OUT_DIR, { recursive: true });
  for (const [name, data] of readZip(join(SOURCE_DIR, BANG_PACK))) {
    if (name.endsWith(".ogg")) writeFileSync(join(BANGS_OUT_DIR, name), data);
  }
  if (!existsSync(FIREARMS_DIR)) {
    throw new Error(
      `${FIREARMS_DIR} is missing: download "Prepared SFX Library.7z" from ` +
        "opengameart.org/content/the-free-firearm-sound-library and extract it into art/source/firearms/",
    );
  }
  blender("art/sounds.py");
}

/** Unpacks the car models and their palette from the kit's zip, keeping the relative path the
 * models reference the palette by. */
function unpackCarKit(): void {
  const models = readZip(join(SOURCE_DIR, CAR_KIT));
  mkdirSync(join(CAR_KIT_DIR, "Textures"), { recursive: true });
  const wanted = [...CAR_KIT_MODELS.map((name) => `${name}.glb`), CAR_KIT_PALETTE];
  for (const name of wanted) {
    const data = models.get(`Models/GLB format/${name}`);
    if (!data) throw new Error(`${CAR_KIT} has no ${name}`);
    writeFileSync(join(CAR_KIT_DIR, name), data);
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
if (wants("sounds")) {
  await downloadFile(SOUND_PACK_URL, SOUND_PACK);
  await downloadFile(BANG_PACK_URL, BANG_PACK);
  for (const name of RELOAD_RECORDINGS) await downloadFile(RELOAD_RECORDINGS_URL + name, name);
  buildSounds();
}
if (wants("player")) {
  blender("art/player.py");
  if (!preview)
    for (const name of ["character.glb", "viewmodel.glb", "grenade.glb"]) optimize(name);
}
if (wants("map")) {
  await downloadFile(CAR_KIT_URL, CAR_KIT);
  await downloadFile(FONT_URL, FONT);
  unpackCarKit();
  blender("art/map.py");
  if (!preview) {
    optimize("map.glb");
    copyFileSync(join(OUT_DIR, "arena-light.webp"), join(ASSETS_DIR, "arena-light.webp"));
  }
}
