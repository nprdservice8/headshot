import {
  CLOCK_BLEND,
  CLOCK_RESYNC_TICKS,
  ERROR_BLEND_PER_SEC,
  INTERP_DELAY_TICKS,
  MAX_PENDING_INPUTS,
  MAX_SNAPSHOT_BUFFER,
  RECONCILE_SNAP_DISTANCE,
  TICK_MS,
} from "../shared/constants.ts";
import { clamp, lerp, lerpAngle } from "../shared/math.ts";
import { copyMoveState, createMoveState, type Mover, stepMovement } from "../shared/movement.ts";
import {
  BUTTON,
  type ClientMessage,
  type DeathMessage,
  decodeServerMessage,
  type ExplosionMessage,
  encodeMessage,
  type HitMessage,
  type MatchMessage,
  type RosterEntry,
  type ServerMessage,
  type ShotMessage,
  type SnapshotMessage,
} from "../shared/protocol.ts";

export type NetHandlers = {
  onWelcome(): void;
  onRoster(players: RosterEntry[]): void;
  onMatch(message: MatchMessage): void;
  onHit(message: HitMessage): void;
  onSelfDeath(message: DeathMessage): void;
  onRespawn(yaw: number): void;
  onClose(reason: string): void;
};

/** Events that happen in the world, shown when the delayed view of other players reaches them. */
export type WorldEvent = ShotMessage | DeathMessage | ExplosionMessage;

export const self = {
  id: -1,
  alive: false,
  hp: 0,
  grenades: 0,
  rockets: 0,
  ammo: 0,
  reloading: false,
  weapon: 0,
  ads: false,
  sprinting: false,
};

/** The local player: `predicted` is the latest tick, `previous` the one before, for smooth rendering. */
export const predicted = createMoveState(0, 0, 0);
export const previous = createMoveState(0, 0, 0);
/** Visual offset left over from a server correction, faded out over a few frames. */
export const correction = { x: 0, y: 0, z: 0 };

let socket: WebSocket | null = null;
let handlers: NetHandlers | null = null;
let mover: Mover | null = null;

let inputSeq = 0;
// Inputs the server has not confirmed yet, as a ring buffer so predicting never allocates.
const pendingSeq = new Int32Array(MAX_PENDING_INPUTS);
const pendingButtons = new Uint8Array(MAX_PENDING_INPUTS);
const pendingYaw = new Float64Array(MAX_PENDING_INPUTS);
const pendingSprint = new Uint8Array(MAX_PENDING_INPUTS);
let pendingStart = 0;
let pendingCount = 0;

const snapshots: SnapshotMessage[] = [];
const worldEvents: WorldEvent[] = [];

// Maps local time to the server's tick count, following the arrival of snapshots.
let clockBaseTick = 0;
let clockBaseMs = 0;
let clockSynced = false;

export function connect(name: string, clientMover: Mover, netHandlers: NetHandlers): void {
  mover = clientMover;
  handlers = netHandlers;
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${protocol}://${location.host}`);
  socket = ws;
  ws.addEventListener("open", () => send({ type: "join", name }));
  ws.addEventListener("message", (event) => {
    if (typeof event.data === "string") receive(decodeServerMessage(event.data));
  });
  ws.addEventListener("close", (event) => {
    socket = null;
    handlers?.onClose(event.reason || "Lost connection to the server");
  });
}

function send(message: ClientMessage): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(encodeMessage(message));
}

function receive(message: ServerMessage): void {
  switch (message.type) {
    case "welcome":
      self.id = message.id;
      clockSynced = false;
      updateClock(message.tick);
      handlers?.onWelcome();
      return;
    case "snapshot":
      receiveSnapshot(message);
      return;
    case "roster":
      handlers?.onRoster(message.players);
      return;
    case "match":
      handlers?.onMatch(message);
      return;
    case "hit":
      handlers?.onHit(message);
      return;
    case "death":
      // Your own death shows immediately; everyone else's waits for the delayed view to catch up.
      if (message.victimId === self.id) handlers?.onSelfDeath(message);
      else worldEvents.push(message);
      return;
    case "shot":
      // Your own shots were already drawn the moment you clicked.
      if (message.shooterId !== self.id) worldEvents.push(message);
      return;
    case "explosion":
      worldEvents.push(message);
      return;
  }
}

function updateClock(serverTick: number): void {
  const now = performance.now();
  const estimate = estimateServerTick(now);
  if (!clockSynced || Math.abs(serverTick - estimate) > CLOCK_RESYNC_TICKS) {
    clockBaseTick = serverTick;
    clockBaseMs = now;
    clockSynced = true;
    return;
  }
  // Drift slowly toward each arrival so network jitter doesn't shake the view of other players.
  clockBaseTick += (serverTick - estimate) * CLOCK_BLEND;
}

function estimateServerTick(nowMs: number): number {
  return clockBaseTick + (nowMs - clockBaseMs) / TICK_MS;
}

/** The server tick other players are drawn at: slightly in the past, so there is always data to blend. */
export function renderTick(nowMs: number): number {
  return estimateServerTick(nowMs) - INTERP_DELAY_TICKS;
}

function receiveSnapshot(snapshot: SnapshotMessage): void {
  updateClock(snapshot.tick);
  snapshots.push(snapshot);
  if (snapshots.length > MAX_SNAPSHOT_BUFFER) snapshots.shift();
  reconcile(snapshot);
}

/** Resets the local player to the server's state, then replays the inputs the server hasn't seen yet. */
function reconcile(snapshot: SnapshotMessage): void {
  if (!mover) return;
  const you = snapshot.you;
  const oldX = predicted.x;
  const oldY = predicted.y;
  const oldZ = predicted.z;
  const wasAlive = self.alive;
  self.alive = you.alive;
  self.hp = you.hp;
  self.grenades = you.grenades;
  self.rockets = you.rockets;
  self.ammo = you.ammo;
  self.reloading = you.reloading;
  self.weapon = you.weapon;
  self.ads = you.ads;
  self.sprinting = you.sprinting;

  while (pendingCount > 0 && (pendingSeq[pendingStart] ?? 0) <= snapshot.ack) {
    pendingStart = (pendingStart + 1) % MAX_PENDING_INPUTS;
    pendingCount--;
  }

  predicted.x = you.x;
  predicted.y = you.y;
  predicted.z = you.z;
  predicted.vx = you.vx;
  predicted.vy = you.vy;
  predicted.vz = you.vz;
  predicted.grounded = you.grounded;
  predicted.stamina = you.stamina;
  if (you.alive) {
    for (let i = 0; i < pendingCount; i++) {
      const index = (pendingStart + i) % MAX_PENDING_INPUTS;
      stepMovement(
        mover,
        predicted,
        pendingButtons[index] ?? 0,
        pendingYaw[index] ?? 0,
        pendingSprint[index] === 1,
      );
    }
  } else {
    pendingCount = 0;
  }

  const dx = predicted.x - oldX;
  const dy = predicted.y - oldY;
  const dz = predicted.z - oldZ;
  if (!wasAlive || !you.alive || Math.hypot(dx, dy, dz) > RECONCILE_SNAP_DISTANCE) {
    copyMoveState(predicted, previous);
    correction.x = 0;
    correction.y = 0;
    correction.z = 0;
  } else {
    // Shift both render endpoints and cancel the jump with a correction that fades out.
    previous.x += dx;
    previous.y += dy;
    previous.z += dz;
    correction.x -= dx;
    correction.y -= dy;
    correction.z -= dz;
  }

  if (!wasAlive && you.alive) {
    const me = findById(snapshot.players, self.id);
    handlers?.onRespawn(me?.yaw ?? 0);
  }
}

/** Runs every fixed tick: sends this tick's input and moves the local player straight away. */
export function sendInputAndPredict(
  buttons: number,
  yaw: number,
  pitch: number,
  weapon: number,
  nowMs: number,
): void {
  if (!mover || self.id === -1 || socket?.readyState !== WebSocket.OPEN) return;
  inputSeq++;
  send({
    type: "input",
    seq: inputSeq,
    buttons,
    yaw,
    pitch,
    viewTick: Math.max(0, renderTick(nowMs)),
    weapon,
  });
  if (!self.alive) return;

  copyMoveState(predicted, previous);
  stepMovement(
    mover,
    predicted,
    buttons,
    yaw,
    (buttons & BUTTON.SPRINT) !== 0 && (buttons & BUTTON.ADS) === 0,
  );
  if (pendingCount === MAX_PENDING_INPUTS) {
    pendingStart = (pendingStart + 1) % MAX_PENDING_INPUTS;
    pendingCount--;
  }
  const index = (pendingStart + pendingCount) % MAX_PENDING_INPUTS;
  pendingSeq[index] = inputSeq;
  pendingButtons[index] = buttons;
  pendingYaw[index] = yaw;
  pendingSprint[index] = (buttons & BUTTON.SPRINT) !== 0 && (buttons & BUTTON.ADS) === 0 ? 1 : 0;
  pendingCount++;
}

export function fadeCorrection(dt: number): void {
  const keep = Math.exp(-ERROR_BLEND_PER_SEC * dt);
  correction.x *= keep;
  correction.y *= keep;
  correction.z *= keep;
}

export function processWorldEvents(tick: number, handle: (event: WorldEvent) => void): void {
  while (worldEvents[0] && worldEvents[0].tick <= tick) {
    const event = worldEvents.shift();
    if (event) handle(event);
  }
}

// The two snapshots around the render tick, and how far between them it is.
let older: SnapshotMessage | undefined;
let newer: SnapshotMessage | undefined;
let blend = 0;

function bracket(tick: number): boolean {
  older = snapshots[0];
  newer = older;
  for (const snapshot of snapshots) {
    newer = snapshot;
    if (snapshot.tick > tick) break;
    older = snapshot;
  }
  if (!older || !newer) return false;
  const span = newer.tick - older.tick;
  blend = span > 0 ? clamp((tick - older.tick) / span, 0, 1) : 0;
  return true;
}

/** A plain loop instead of `find`, which would create a closure every frame. */
function findById<T extends { id: number }>(items: readonly T[], id: number): T | undefined {
  for (const item of items) {
    if (item.id === id) return item;
  }
  return undefined;
}

export type PlayerVisitor = (
  id: number,
  x: number,
  y: number,
  z: number,
  yaw: number,
  pitch: number,
  alive: boolean,
) => void;

/** Calls `visit` for every other player, blended between snapshots at the render tick. */
export function forEachOtherPlayer(tick: number, visit: PlayerVisitor): void {
  if (!bracket(tick) || !older || !newer) return;
  for (const to of newer.players) {
    if (to.id === self.id) continue;
    const from = findById(older.players, to.id);
    // Only blend while alive in both, so a respawn doesn't slide across the map.
    if (!from?.alive || !to.alive) {
      visit(to.id, to.x, to.y, to.z, to.yaw, to.pitch, to.alive && (from?.alive ?? true));
      continue;
    }
    visit(
      to.id,
      lerp(from.x, to.x, blend),
      lerp(from.y, to.y, blend),
      lerp(from.z, to.z, blend),
      lerpAngle(from.yaw, to.yaw, blend),
      lerp(from.pitch, to.pitch, blend),
      true,
    );
  }
}

export function forEachGrenade(
  tick: number,
  visit: (id: number, x: number, y: number, z: number) => void,
): void {
  if (!bracket(tick) || !older || !newer) return;
  for (const to of newer.grenades) {
    const from = findById(older.grenades, to.id) ?? to;
    visit(to.id, lerp(from.x, to.x, blend), lerp(from.y, to.y, blend), lerp(from.z, to.z, blend));
  }
}

export function forEachRocket(
  tick: number,
  visit: (id: number, x: number, y: number, z: number) => void,
): void {
  if (!bracket(tick) || !older || !newer) return;
  for (const to of newer.rockets) {
    const from = findById(older.rockets, to.id) ?? to;
    visit(to.id, lerp(from.x, to.x, blend), lerp(from.y, to.y, blend), lerp(from.z, to.z, blend));
  }
}
