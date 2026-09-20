import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { type BuildOptions, build, context, type Plugin } from "esbuild";

// `node build.ts` builds the production bundle. `node build.ts --dev` rebuilds on every change and
// runs the game server in the same process (npm run dev restarts it when server code changes).

const GAME_OUTFILE = "dist/game.js";
const ASSETS_DIR = "public/assets";
const LOAD_BUDGET_BYTES = 3 * 1024 * 1024;
const dev = process.argv.includes("--dev");

// Rapier's browser build carries its 2.7 MB of WASM as a base64 string inside the JavaScript,
// which the browser has to download, parse as text and decode on the main thread before it can
// compile it. The bundle is rewritten to load the real .wasm file instead (copied next to it in
// dist/): a third smaller on the wire, streamed and compiled while everything else downloads.
// The pinned version's minified source is matched exactly; an upgrade that changes it fails here.
const RAPIER_DIST = "node_modules/@dimforge/rapier3d-compat/dist";
const RAPIER_WASM = "rapier_wasm3d_bg.wasm";
const RAPIER_WASM_OUTFILE = `dist/${RAPIER_WASM}`;
const INLINED_WASM = /\w+\.toByteArray\("[A-Za-z0-9+/=]+"\)\.buffer/;
const rapierWasmFile: Plugin = {
  name: "rapier-wasm-file",
  setup(plugin) {
    plugin.onLoad({ filter: /rapier3d-compat[\\/]dist[\\/]rapier\.mjs$/ }, (args) => {
      const source = readFileSync(args.path, "utf8");
      if (!INLINED_WASM.test(source)) {
        throw new Error(`${args.path} has no inlined WASM to split out; the Rapier build changed`);
      }
      return {
        contents: source.replace(INLINED_WASM, JSON.stringify(`/${RAPIER_WASM_OUTFILE}`)),
        loader: "js",
      };
    });
  },
};

const options: BuildOptions = {
  entryPoints: {
    game: "src/client/main.ts",
    lobby: "src/client/lobby.ts",
  },
  outdir: "dist",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: !dev,
  sourcemap: true,
  logLevel: "info",
  plugins: [rapierWasmFile],
};

const kb = (bytes: number) => `${(bytes / 1024).toFixed(0)} KB`;

/** Every file under the assets folder, including the sounds subfolder. */
function assetFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? assetFiles(path) : [path];
  });
}

/** Size on the wire: gzipped, as a server or CDN would send it. */
function downloadSize(path: string): number {
  const size = gzipSync(readFileSync(path), { level: 9 }).length;
  console.log(`  ${path}: ${kb(size)}`);
  return size;
}

mkdirSync("dist", { recursive: true });
copyFileSync(join(RAPIER_DIST, RAPIER_WASM), RAPIER_WASM_OUTFILE);

if (dev) {
  const watcher = await context(options);
  await watcher.rebuild();
  await watcher.watch();
  await import("./src/server/main.ts");
} else {
  await build(options);
  let total = downloadSize(GAME_OUTFILE) + downloadSize(RAPIER_WASM_OUTFILE);
  for (const path of assetFiles(ASSETS_DIR)) total += downloadSize(path);
  console.log(`Download before playing: ${kb(total)} of ${kb(LOAD_BUDGET_BYTES)}`);
  if (total > LOAD_BUDGET_BYTES) {
    console.error("Over the load budget");
    process.exitCode = 1;
  }
}
