import { readdir, readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import RAPIER from "@dimforge/rapier3d-compat";
import { type RawData, type WebSocket, WebSocketServer } from "ws";
import {
  MAX_MESSAGE_BYTES,
  MAX_MESSAGES_PER_SEC,
  SERVER_PORT,
  TICK_MS,
} from "../shared/constants.ts";
import { decodeClientMessage, encodeMessage, type ServerMessage } from "../shared/protocol.ts";
import {
  addPlayer,
  createMatch,
  lobbyStatus,
  queueInput,
  removePlayer,
  tickMatch,
  welcomePlayer,
} from "./match.ts";
import {
  acceptsGzip,
  contentTypeFor,
  etagFor,
  isCompressible,
  resolveStaticPath,
} from "./static-files.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const PUBLIC_DIR = resolve(ROOT, "public");
const DIST_DIR = resolve(ROOT, "dist");
const TICK_BUDGET_MS = 2;
const TICK_STATS_INTERVAL_MS = 30_000;
const MAX_TICK_CATCH_UP_MS = 1000;
const CLOSE_POLICY_VIOLATION = 1008;
const LOBBY_STATUS_PATH = "/api/lobby";
const CLOSE_INTERNAL_ERROR = 1011;
const CLOSE_MATCH_FULL = 4001;

/** Fake network conditions for testing: `LAG_MS` delays every message, `JITTER_MS` adds random extra. */
function readDelayEnv(name: string): number {
  const value = Number(process.env[name] ?? 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}
const LAG_MS = readDelayEnv("LAG_MS");
const JITTER_MS = readDelayEnv("JITTER_MS");
const PORT = Number(process.env.PORT) || SERVER_PORT;

type Client = {
  socket: WebSocket;
  playerId: number;
  rateWindowStartMs: number;
  messagesInWindow: number;
  /** With fake lag on, messages are released in order no earlier than these times. */
  nextSendMs: number;
  nextReceiveMs: number;
};

await RAPIER.init();

const clients = new Map<number, Client>();
const match = createMatch({
  send(playerId, message) {
    const client = clients.get(playerId);
    if (client) sendTo(client, message);
  },
  broadcast(message) {
    const text = encodeMessage(message);
    for (const client of clients.values()) sendText(client, text);
  },
});

function sendTo(client: Client, message: ServerMessage): void {
  sendText(client, encodeMessage(message));
}

function sendText(client: Client, text: string): void {
  withFakeLag(client, "nextSendMs", () => {
    if (client.socket.readyState === client.socket.OPEN) client.socket.send(text);
  });
}

function withFakeLag(
  client: Client,
  key: "nextSendMs" | "nextReceiveMs",
  action: () => void,
): void {
  if (LAG_MS === 0 && JITTER_MS === 0) {
    action();
    return;
  }
  // Real TCP never reorders messages, so jitter only ever delays a message behind the previous one.
  const now = performance.now();
  const releaseMs = Math.max(client[key], now + LAG_MS + Math.random() * JITTER_MS);
  client[key] = releaseMs;
  setTimeout(action, releaseMs - now);
}

function handleMessage(client: Client, data: RawData, isBinary: boolean): void {
  // With fake lag, a message can be handled after its socket closed; a late join would leave a ghost.
  if (client.socket.readyState !== client.socket.OPEN) return;
  const now = performance.now();
  if (now - client.rateWindowStartMs >= 1000) {
    client.rateWindowStartMs = now;
    client.messagesInWindow = 0;
  }
  if (++client.messagesInWindow > MAX_MESSAGES_PER_SEC) {
    client.socket.close(CLOSE_POLICY_VIOLATION, "Too many messages");
    return;
  }

  const message = isBinary ? null : decodeClientMessage(data.toString());
  if (message === null) {
    client.socket.close(CLOSE_POLICY_VIOLATION, "Invalid message");
    return;
  }

  switch (message.type) {
    case "join": {
      if (client.playerId !== -1) return;
      const player = addPlayer(match, message.name);
      if (player === null) {
        client.socket.close(CLOSE_MATCH_FULL, "Match is full");
        return;
      }
      client.playerId = player.id;
      clients.set(player.id, client);
      welcomePlayer(match, player);
      console.log(`${player.name} joined (${match.players.size} playing)`);
      return;
    }
    case "input":
      if (client.playerId !== -1) queueInput(match, client.playerId, message);
      return;
  }
}

const httpServer = createServer((request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405).end();
    return;
  }
  if (request.url === LOBBY_STATUS_PATH) {
    const body = JSON.stringify(lobbyStatus(match));
    response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(request.method === "HEAD" ? undefined : body);
    return;
  }
  const filePath = resolveStaticPath(request.url ?? "/", PUBLIC_DIR, DIST_DIR);
  if (filePath === null) {
    response.writeHead(404).end();
    return;
  }
  loadStaticFile(filePath).then(
    (file) => {
      if (request.headers["if-none-match"] === file.etag) {
        response.writeHead(304, { ETag: file.etag, "Cache-Control": "no-cache" }).end();
        return;
      }
      const gzipped = file.gzipped && acceptsGzip(request.headers["accept-encoding"]);
      response.writeHead(200, {
        "Content-Type": contentTypeFor(filePath),
        "Cache-Control": "no-cache",
        ETag: file.etag,
        Vary: "Accept-Encoding",
        ...(gzipped ? { "Content-Encoding": "gzip" } : {}),
      });
      // Safe: `gzipped` is only true when file.gzipped is set.
      const body = gzipped ? (file.gzipped as Buffer) : file.body;
      response.end(request.method === "HEAD" ? undefined : body);
    },
    () => response.writeHead(404).end(),
  );
});

/** A file as served: read and gzipped once, then kept until it changes on disk (the dev build
 * rewrites dist/ on every edit). Browsers revalidate with the ETag and get a 304 when unchanged,
 * so a reload only re-downloads what the last build touched. */
type StaticFile = {
  mtimeMs: number;
  size: number;
  etag: string;
  body: Buffer;
  gzipped: Buffer | null;
};
const staticFiles = new Map<string, StaticFile>();

async function loadStaticFile(filePath: string): Promise<StaticFile> {
  const { mtimeMs, size } = await stat(filePath);
  const cached = staticFiles.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs && cached.size === size) return cached;
  const body = await readFile(filePath);
  const file: StaticFile = {
    mtimeMs,
    size,
    etag: etagFor(size, mtimeMs),
    body,
    gzipped: isCompressible(filePath) ? gzipSync(body) : null,
  };
  staticFiles.set(filePath, file);
  return file;
}

/** Gzipping the big files blocks the event loop (about 50 ms for Rapier's WASM), which would stall
 * everyone's ticks the first time a newcomer downloads one. Doing it all before the server listens
 * moves that cost to startup; in dev, a rebuilt dist/ file is gzipped again on its next request. */
async function warmStaticFiles(): Promise<void> {
  for (const dir of [PUBLIC_DIR, DIST_DIR]) {
    const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isFile()) await loadStaticFile(resolve(entry.parentPath, entry.name));
    }
  }
}

const socketServer = new WebSocketServer({ server: httpServer, maxPayload: MAX_MESSAGE_BYTES });

socketServer.on("connection", (socket) => {
  const client: Client = {
    socket,
    playerId: -1,
    rateWindowStartMs: performance.now(),
    messagesInWindow: 0,
    nextSendMs: 0,
    nextReceiveMs: 0,
  };
  socket.on("message", (data, isBinary) => {
    withFakeLag(client, "nextReceiveMs", () => {
      try {
        handleMessage(client, data, isBinary);
      } catch (error) {
        // One broken connection must never take the match down for everyone else.
        console.error("Closing a connection after an error:", error);
        socket.close(CLOSE_INTERNAL_ERROR, "Server error");
      }
    });
  });
  socket.on("close", () => {
    if (client.playerId === -1) return;
    const name = match.players.get(client.playerId)?.name;
    clients.delete(client.playerId);
    removePlayer(match, client.playerId);
    client.playerId = -1;
    console.log(`${name} left (${match.players.size} playing)`);
  });
  socket.on("error", (error) => console.error("Socket error:", error.message));
});

// Fixed-timestep loop. Timer wake-ups on Windows can be coarse, so several ticks may run per wake-up;
// clients absorb that unevenness with their interpolation delay.
let nextTickMs = performance.now();
let tickCount = 0;
let tickTotalMs = 0;
let tickWorstMs = 0;

function runDueTicks(): void {
  const now = performance.now();
  if (now - nextTickMs > MAX_TICK_CATCH_UP_MS) nextTickMs = now;
  while (performance.now() >= nextTickMs) {
    const start = performance.now();
    tickMatch(match);
    const took = performance.now() - start;
    tickCount++;
    tickTotalMs += took;
    tickWorstMs = Math.max(tickWorstMs, took);
    nextTickMs += TICK_MS;
  }
  setTimeout(runDueTicks, Math.max(0, nextTickMs - performance.now()));
}

setInterval(() => {
  if (match.players.size > 0 && tickCount > 0) {
    const average = tickTotalMs / tickCount;
    const warning = tickWorstMs > TICK_BUDGET_MS ? ` (over the ${TICK_BUDGET_MS} ms budget)` : "";
    console.log(
      `Tick time: average ${average.toFixed(3)} ms, worst ${tickWorstMs.toFixed(3)} ms${warning}`,
    );
  }
  tickCount = 0;
  tickTotalMs = 0;
  tickWorstMs = 0;
}, TICK_STATS_INTERVAL_MS);

await warmStaticFiles();
httpServer.listen(PORT, () => {
  console.log("Headshot server running");
  console.log(`  On this PC:       http://localhost:${PORT}`);
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) {
        console.log(`  On your network:  http://${address.address}:${PORT}`);
      }
    }
  }
  if (LAG_MS > 0 || JITTER_MS > 0)
    console.log(`  Fake lag: ${LAG_MS} ms + up to ${JITTER_MS} ms jitter`);
  runDueTicks();
});
