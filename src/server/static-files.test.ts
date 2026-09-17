import assert from "node:assert/strict";
import { resolve, sep } from "node:path";
import { test } from "node:test";
import { contentTypeFor, resolveStaticPath } from "./static-files.ts";

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
