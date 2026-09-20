import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { type BuildOptions, build, context } from "esbuild";

// `node build.ts` builds the production bundle. `node build.ts --dev` rebuilds on every change and
// runs the game server in the same process (npm run dev restarts it when server code changes).

const GAME_OUTFILE = "dist/game.js";
const ASSETS_DIR = "public/assets";
const LOAD_BUDGET_BYTES = 3 * 1024 * 1024;
const dev = process.argv.includes("--dev");

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

if (dev) {
  const watcher = await context(options);
  await watcher.rebuild();
  await watcher.watch();
  await import("./src/server/main.ts");
} else {
  await build(options);
  let total = downloadSize(GAME_OUTFILE);
  for (const path of assetFiles(ASSETS_DIR)) total += downloadSize(path);
  console.log(`Download before playing: ${kb(total)} of ${kb(LOAD_BUDGET_BYTES)}`);
  if (total > LOAD_BUDGET_BYTES) {
    console.error("Over the load budget");
    process.exitCode = 1;
  }
}
