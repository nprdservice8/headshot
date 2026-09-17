import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { type BuildOptions, build, context } from "esbuild";

// `node build.ts` builds the production bundle. `node build.ts --dev` rebuilds on every change and
// runs the game server in the same process (npm run dev restarts it when server code changes).

const OUTFILE = "dist/game.js";
const ASSETS_DIR = "public/assets";
const LOAD_BUDGET_BYTES = 3 * 1024 * 1024;
const dev = process.argv.includes("--dev");

const options: BuildOptions = {
  entryPoints: ["src/client/main.ts"],
  outfile: OUTFILE,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: !dev,
  sourcemap: true,
  logLevel: "info",
};

const kb = (bytes: number) => `${(bytes / 1024).toFixed(0)} KB`;

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
  let total = downloadSize(OUTFILE);
  for (const name of readdirSync(ASSETS_DIR)) total += downloadSize(join(ASSETS_DIR, name));
  console.log(`Download before playing: ${kb(total)} of ${kb(LOAD_BUDGET_BYTES)}`);
  if (total > LOAD_BUDGET_BYTES) {
    console.error("Over the load budget");
    process.exitCode = 1;
  }
}
