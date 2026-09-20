import assert from "node:assert/strict";
import { resolve, sep } from "node:path";
import { test } from "node:test";
import {
  acceptsGzip,
  contentTypeFor,
  etagFor,
  isCompressible,
  resolveStaticPath,
} from "./static-files.ts";

const publicDir = resolve("project", "public");
const distDir = resolve("project", "dist");

test("serves index.html for the root and files from public/ and dist/", () => {
  assert.equal(resolveStaticPath("/", publicDir, distDir), resolve(publicDir, "index.html"));
  assert.equal(resolveStaticPath("/?x=1", publicDir, distDir), resolve(publicDir, "index.html"));
  assert.equal(
    resolveStaticPath("/assets/map.glb", publicDir, distDir),
    resolve(publicDir, "assets", "map.glb"),
  );
  assert.equal(resolveStaticPath("/dist/game.js", publicDir, distDir), resolve(distDir, "game.js"));
});

test("rejects paths that escape the served folders", () => {
  const attacks = [
    "/../package.json",
    "/dist/../package.json",
    "/dist/../../secret",
    "/%2e%2e/package.json",
    "/dist/%2e%2e%2fsrc/server/main.ts",
    `/..${sep}package.json`,
    "/%00",
    "/%E0%A4%A",
    "/dist/",
  ];
  for (const url of attacks) assert.equal(resolveStaticPath(url, publicDir, distDir), null, url);
});

test("content types", () => {
  assert.equal(contentTypeFor("a/game.js"), "text/javascript; charset=utf-8");
  assert.equal(contentTypeFor("a/b.unknown"), "application/octet-stream");
});

test("gzips text, models and wasm but not images or sound, and only for clients that accept it", () => {
  assert.equal(isCompressible("dist/game.js"), true);
  assert.equal(isCompressible("dist/rapier_wasm3d_bg.wasm"), true);
  assert.equal(isCompressible("public/assets/map.glb"), true);
  assert.equal(isCompressible("public/assets/arena-light.webp"), false);
  assert.equal(isCompressible("public/assets/sounds/shot-rifle-0.ogg"), false);
  assert.equal(contentTypeFor("dist/rapier_wasm3d_bg.wasm"), "application/wasm");
  assert.equal(acceptsGzip("gzip, deflate, br"), true);
  assert.equal(acceptsGzip("br;q=1.0, gzip;q=0.8"), true);
  assert.equal(acceptsGzip("gzip;q=0, identity"), false);
  assert.equal(acceptsGzip("identity"), false);
  assert.equal(acceptsGzip(undefined), false);
});

test("the ETag changes with the file's size or modification time", () => {
  const original = etagFor(1000, 1_700_000_000_000);
  assert.notEqual(original, etagFor(1001, 1_700_000_000_000));
  assert.notEqual(original, etagFor(1000, 1_700_000_001_000));
  assert.equal(original, etagFor(1000, 1_700_000_000_000.4), "sub-millisecond noise is ignored");
  assert.match(original, /^".+"$/);
});
