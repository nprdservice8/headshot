import { extname, resolve, sep } from "node:path";

export const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".glb": "model/gltf-binary",
  ".ktx2": "image/ktx2",
  ".webp": "image/webp",
  ".wasm": "application/wasm",
  ".ogg": "audio/ogg",
};

/** File types worth gzipping on the way out. Images and Vorbis are already compressed. */
const COMPRESSIBLE = new Set([".html", ".js", ".map", ".css", ".json", ".glb", ".wasm"]);

export function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

export function isCompressible(filePath: string): boolean {
  return COMPRESSIBLE.has(extname(filePath).toLowerCase());
}

/** Whether a request's Accept-Encoding header allows a gzipped body. */
export function acceptsGzip(acceptEncoding: string | undefined): boolean {
  if (!acceptEncoding) return false;
  return acceptEncoding.split(",").some((entry) => {
    const [coding, ...params] = entry.trim().split(";");
    if (coding?.trim() !== "gzip") return false;
    return !params.some((param) => param.replace(/\s/g, "") === "q=0");
  });
}

/** A validator that changes whenever the file does, so a browser that has it can ask "still this
 * one?" and get a 304 instead of the whole file again. */
export function etagFor(size: number, mtimeMs: number): string {
  return `"${size.toString(36)}-${Math.floor(mtimeMs).toString(36)}"`;
}

/**
 * Maps a request path to a file inside `publicDir` or, under /dist/, inside `distDir`.
 * Returns null for anything that would escape those folders or can't be decoded.
 */
export function resolveStaticPath(
  requestUrl: string,
  publicDir: string,
  distDir: string,
): string | null {
  const pathname = requestUrl.split("?", 1)[0] ?? "/";
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  if (decoded === "/") return resolve(publicDir, "index.html");

  const inDist = decoded.startsWith("/dist/");
  const root = inDist ? distDir : publicDir;
  const relative = inDist ? decoded.slice("/dist/".length) : decoded.slice(1);
  const filePath = resolve(root, relative);
  return filePath.startsWith(root + sep) ? filePath : null;
}
