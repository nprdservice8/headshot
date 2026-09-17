import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { type BuildOptions, build, context } from "esbuild";

// `node build.ts` builds the production bundle. `node build.ts --dev` rebuilds on every change and
// runs the game server in the same process (npm run dev restarts it when server code changes).

const OUTFILE = "dist/game.js";
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

if (dev) {
  const watcher = await context(options);
  await watcher.rebuild();
  await watcher.watch();
  await import("./src/server/main.ts");
} else {
  await build(options);
  const bundle = readFileSync(OUTFILE);
  const gzipped = gzipSync(bundle, { level: 9 }).length;
  const kb = (bytes: number) => `${(bytes / 1024).toFixed(0)} KB`;
  console.log(`${OUTFILE}: ${kb(bundle.length)}, ${kb(gzipped)} gzipped`);
  if (gzipped > LOAD_BUDGET_BYTES) {
    console.error(`Over the ${kb(LOAD_BUDGET_BYTES)} load budget`);
    process.exitCode = 1;
  }
}
