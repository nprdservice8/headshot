import { FIELD_OF_VIEW_DEG, KILL_FEED_MAX, KILL_FEED_MS } from "../shared/constants.ts";
import type { RosterEntry } from "../shared/protocol.ts";
import { weaponDefinition } from "../shared/weapons.ts";
import {
  ARENA_BOXES,
  ARENA_HALF_SIZE,
  type ArenaKind,
  GROUND_PATCHES,
  type GroundPatch,
  PLAY_HALF_SIZE,
} from "../shared/world.ts";
import {
  ACCOUNT_STORAGE_KEY,
  type Account,
  GUEST_STORAGE_KEY,
  readAccounts,
  SESSION_STORAGE_KEY,
} from "./account.ts";

export function getElement<T extends HTMLElement>(id: string, type: { new (): T }): T {
  const element = document.getElementById(id);
  if (!(element instanceof type)) throw new Error(`index.html is missing #${id}`);
  return element;
}

const menu = getElement("menu", HTMLFormElement);
const nameInput = getElement("name", HTMLInputElement);
const nameLabel = getElement("name-label", HTMLLabelElement);
const emailInput = getElement("email", HTMLInputElement);
const passwordInput = getElement("password", HTMLInputElement);
const loginTab = getElement("login-tab", HTMLButtonElement);
const signupTab = getElement("signup-tab", HTMLButtonElement);
const playButton = getElement("play", HTMLButtonElement);
const guestPlayButton = getElement("guest-play", HTMLButtonElement);
const menuStatus = getElement("menu-status", HTMLParagraphElement);
const passwordToggle = getElement("password-toggle", HTMLButtonElement);
const authPanel = getElement("auth-panel", HTMLDivElement);
const deployPanel = getElement("deploy-panel", HTMLDivElement);
const deployName = getElement("deploy-name", HTMLSpanElement);
const deployStatus = getElement("deploy-status", HTMLParagraphElement);
const rejoinButton = getElement("rejoin", HTMLButtonElement);
const hud = getElement("hud", HTMLDivElement);
const hp = getElement("hp", HTMLSpanElement);
const grenades = getElement("grenades", HTMLSpanElement);
const hitmarker = getElement("hitmarker", HTMLDivElement);
const damageFlash = getElement("damage-flash", HTMLDivElement);
const criticalVignette = getElement("critical-vignette", HTMLDivElement);
const damageIndicators = getElement("damage-indicators", HTMLDivElement);
const hpBarFill = getElement("hp-bar-fill", HTMLDivElement);
const killFeed = getElement("kill-feed", HTMLUListElement);
const centerMessage = getElement("center-message", HTMLDivElement);
const clickToPlay = getElement("click-to-play", HTMLDivElement);
const pauseMenu = getElement("pause-menu", HTMLDivElement);
const resumeBtn = getElement("resume-btn", HTMLButtonElement);
const exitBtn = getElement("exit-btn", HTMLButtonElement);
const scoreboard = getElement("scoreboard", HTMLDivElement);
const scoreboardRows = getElement("scoreboard-rows", HTMLTableSectionElement);
const matchKills = getElement("match-kills", HTMLSpanElement);
const onlinePlayers = getElement("online-players", HTMLSpanElement);
const minimapCanvas = getElement("minimap-canvas", HTMLCanvasElement);
const fullMap = getElement("fullmap", HTMLDivElement);
const fullMapCanvas = getElement("fullmap-canvas", HTMLCanvasElement);
const weaponName = getElement("weapon-name", HTMLSpanElement);
const weaponAmmo = getElement("weapon-ammo", HTMLSpanElement);
const weaponSlots = getElement("weapon-slots", HTMLDivElement);
const crosshair = getElement("crosshair", HTMLDivElement);

const FLASH_MS = 220;
// The minimap is a circle around you that turns with you (forward is up), showing the arena's
// buildings and cover from the world.ts layout, with the other players as dots.
const MINIMAP_SIZE = 140;
const MINIMAP_CENTER = MINIMAP_SIZE / 2;
/** Metres from you to the rim. */
const MINIMAP_RANGE = 36;
const MINIMAP_SCALE = (MINIMAP_CENTER - 2) / MINIMAP_RANGE;
/** The layout is drawn once at this resolution, then blitted turned and zoomed each frame. */
const MINIMAP_LAYOUT_PX_PER_METRE = 3;
const MINIMAP_PIXEL_RATIO = Math.min(window.devicePixelRatio || 1, 2);
/** Screen-edge width of the view cone; a bit wider than the vertical field of view, like the screen. */
const MINIMAP_VIEW_CONE_RAD = ((FIELD_OF_VIEW_DEG + 10) * Math.PI) / 180;
const MINIMAP_ENEMY_RADIUS = 3.5;
const MINIMAP_ENEMY_TICK = 6;
const MINIMAP_RIM_INSET = 6;
// The full map (M): the whole arena, north up, in a square overlay.
const FULL_MAP_SIZE = 560;
const FULL_MAP_MARGIN = 12;
const FULL_MAP_SCALE = (FULL_MAP_SIZE - FULL_MAP_MARGIN * 2) / (ARENA_HALF_SIZE * 2);
const FULL_MAP_CONE_LENGTH = 40;
/** The quarters of the arena, named where the map is painted (see world.ts and CLAUDE.md). */
const DISTRICTS: readonly { name: string; x: number; z: number }[] = [
  { name: "DURBAR SQUARE", x: 0, z: -14 },
  { name: "ARMY CAMP", x: -36, z: -30 },
  { name: "STUPA", x: 42, z: -55 },
  { name: "BAZAAR", x: 52, z: 38 },
  { name: "RUINS", x: -46, z: 56 },
];
/** What the ground is made of, from world.ts's patches. */
const MAP_SURFACE_FILL: Record<GroundPatch["surface"], string> = {
  asphalt: "rgba(120, 132, 150, 0.18)",
  paving: "rgba(205, 170, 115, 0.14)",
  dirt: "rgba(150, 118, 78, 0.18)",
  flagstones: "rgba(160, 170, 178, 0.16)",
};
/** Colour by what a box is: brick for houses, red for the gates, gold for the temples, amber for
 * cover you can vault, steel for vehicles. Taller things draw brighter (see layoutAlpha). */
type MapStyle = { rgb: string; alpha: number; outline: boolean };
const BRICK: MapStyle = { rgb: "196, 118, 92", alpha: 0.55, outline: true };
const STONE: MapStyle = { rgb: "150, 132, 118", alpha: 0.45, outline: true };
const GATE: MapStyle = { rgb: "255, 95, 109", alpha: 0.6, outline: true };
const TEMPLE: MapStyle = { rgb: "255, 207, 74", alpha: 0.42, outline: true };
const TEMPLE_BASE: MapStyle = { rgb: "255, 207, 74", alpha: 0.22, outline: false };
const COVER: MapStyle = { rgb: "201, 165, 90", alpha: 0.38, outline: false };
const STEEL: MapStyle = { rgb: "127, 155, 184", alpha: 0.5, outline: true };
const MAP_KIND_STYLE: Partial<Record<ArenaKind, MapStyle>> = {
  house: BRICK,
  ruin: STONE,
  gate: GATE,
  plinth: TEMPLE_BASE,
  terrace: TEMPLE_BASE,
  stairs: TEMPLE_BASE,
  shrine: TEMPLE,
  tier: TEMPLE,
  spire: TEMPLE,
  dome: TEMPLE,
  harmika: TEMPLE,
  shikhara: TEMPLE,
  pillar: TEMPLE,
  sandbags: COVER,
  crate: COVER,
  rubble: COVER,
  tent: COVER,
  platform: COVER,
  ramp: COVER,
  container: STEEL,
  truck: STEEL,
  car: STEEL,
};
/** A box this tall or more draws at full strength; lower ones fade towards three quarters. */
const MAP_FULL_HEIGHT = 10;
const MAP_OUTLINE = "rgba(0, 0, 0, 0.35)";
/** Full map furniture. */
const FULL_MAP_GRID_METRES = 25;
const FULL_MAP_GATES: readonly { name: string; x: number; z: number }[] = [
  { name: "N GATE", x: 0, z: -PLAY_HALF_SIZE - 6 },
  { name: "S GATE", x: 0, z: PLAY_HALF_SIZE + 6 },
  { name: "W GATE", x: -PLAY_HALF_SIZE - 6, z: 0 },
  { name: "E GATE", x: PLAY_HALF_SIZE + 6, z: 0 },
];
const MAP_GRENADE_RADIUS = 2.5;
const MAP_ROCKET_RADIUS = 3;
const MAP_ROCKET_TICK = 8;

// Last values written, so the DOM is only touched when something changes.
let shownHp = -1;
let shownGrenades = -1;
let shownCenterMessage = "";
let shownWeapon = -1;
let shownReserve = -1;
let shownAmmo = -1;
let shownReloading = false;
let shownKills = -1;
let shownOnlinePlayers = -1;

export function showDirectionalIndicator(angleRad: number): void {
  const arc = document.createElement("div");
  arc.className = "damage-indicator-arc";
  arc.style.transform = `rotate(${angleRad}rad)`;
  damageIndicators.append(arc);
  requestAnimationFrame(() => {
    arc.style.opacity = "0";
  });
  setTimeout(() => arc.remove(), 1200);
}

let signupMode = false;
let currentAccount: Account | null = null;
let currentGuestName: string | null = null;
/** Set when the page opened with ?play and a session: the game joins as soon as it has loaded. */
let pendingPlay: ((name: string) => void) | null = null;

function setMode(signup: boolean): void {
  signupMode = signup;
  nameInput.hidden = !signup;
  nameLabel.hidden = !signup;
  nameInput.required = signup;
  passwordInput.autocomplete = signup ? "new-password" : "current-password";
  passwordInput.placeholder = signup ? "At least 6 characters" : "Enter your password";
  loginTab.classList.toggle("active", !signup);
  signupTab.classList.toggle("active", signup);
  loginTab.setAttribute("aria-selected", String(!signup));
  signupTab.setAttribute("aria-selected", String(signup));
  playButton.textContent = signup ? "Create account & play" : "Log in & play";
  setMenuStatus("");
}

function saveSession(account: Account): void {
  try {
    localStorage.setItem(SESSION_STORAGE_KEY, account.email);
  } catch {
    // The player can still use this session, but it won't persist after a refresh.
  }
}

function openLobby(account: Account): void {
  currentAccount = account;
  saveSession(account);
  location.assign("/lobby.html");
}

function restoreSession(): void {
  try {
    const email = localStorage.getItem(SESSION_STORAGE_KEY);
    const account = readAccounts().find((entry) => entry.email === email);
    const guestName = sessionStorage.getItem(GUEST_STORAGE_KEY)?.trim() ?? "";
    if (!account && guestName.length === 0) return;
    if (new URLSearchParams(location.search).has("play")) {
      currentAccount = account ?? null;
      currentGuestName = account ? null : guestName;
      return;
    }
    if (account) openLobby(account);
    else location.assign("/lobby.html");
  } catch {
    // No saved session is expected when browser storage is unavailable.
  }
}

/**
 * Accounts are stored in localStorage because this game currently has no account service.
 * A production version should move password handling to a server using a password hash.
 */
export function onPlay(handler: (name: string) => void): void {
  loginTab.addEventListener("click", () => setMode(false));
  signupTab.addEventListener("click", () => setMode(true));
  menu.addEventListener("submit", (event) => {
    event.preventDefault();
    const name = nameInput.value.trim();
    const email = emailInput.value.trim().toLowerCase();
    const password = passwordInput.value;
    if (!emailInput.validity.valid) {
      setMenuStatus("Enter a valid email address.", true);
      return;
    }
    const accounts = readAccounts();
    if (signupMode) {
      if (name.length < 2) {
        setMenuStatus("Enter a name with at least 2 characters.", true);
        return;
      }
      if (password.length < 6) {
        setMenuStatus("Your password needs at least 6 characters.", true);
        return;
      }
      if (accounts.some((account) => account.email === email)) {
        setMenuStatus("An account already exists for this email. Please log in.", true);
        return;
      }
      try {
        accounts.push({ name, email, password });
        localStorage.setItem(ACCOUNT_STORAGE_KEY, JSON.stringify(accounts));
      } catch {
        setMenuStatus("Could not save your account in this browser.", true);
        return;
      }
      openLobby({ name, email, password });
      return;
    }
    const account = accounts.find((entry) => entry.email === email && entry.password === password);
    if (!account) {
      setMenuStatus("Email or password is incorrect. Please try again.", true);
      return;
    }
    openLobby(account);
  });
  guestPlayButton.addEventListener("click", () => {
    const name = `Guest-${Math.floor(1000 + Math.random() * 9000)}`;
    try {
      localStorage.removeItem(SESSION_STORAGE_KEY);
      sessionStorage.setItem(GUEST_STORAGE_KEY, name);
    } catch {
      // The guest can still play until this page is refreshed.
      currentGuestName = name;
      handler(name);
      return;
    }
    location.assign("/lobby.html");
  });
  passwordToggle.addEventListener("click", () => {
    const shown = passwordInput.type === "password";
    passwordInput.type = shown ? "text" : "password";
    passwordToggle.textContent = shown ? "Hide" : "Show";
    passwordToggle.setAttribute("aria-pressed", String(shown));
  });
  rejoinButton.addEventListener("click", () => {
    const name = currentAccount?.name ?? currentGuestName;
    if (name) handler(name);
  });
  setMode(false);
  restoreSession();
  if (new URLSearchParams(location.search).has("play")) {
    const name = currentAccount?.name ?? currentGuestName;
    if (name) {
      // The game joins once its assets are in (setMenuReady); meanwhile say so.
      showDeploying(name, "Loading the arena…");
      pendingPlay = handler;
    }
  }
}

export function onResume(handler: () => void): void {
  resumeBtn.addEventListener("click", handler);
}

export function onExit(handler: () => void): void {
  exitBtn.addEventListener("click", handler);
}

export function setPauseVisible(visible: boolean): void {
  pauseMenu.hidden = !visible;
  if (visible) {
    clickToPlay.hidden = true;
  }
}

/** The game has loaded: a pending direct deploy can now join. The form itself never waited,
 * since logging in only leads to the lobby. */
export function setMenuReady(): void {
  const name = currentAccount?.name ?? currentGuestName;
  if (pendingPlay && name) pendingPlay(name);
  pendingPlay = null;
}

/** A line under the form; `error` colours it as one. Also mirrored to the deploying panel. */
export function setMenuStatus(status: string, error = false): void {
  menuStatus.textContent = status;
  menuStatus.classList.toggle("error", error && status.length > 0);
  if (!deployPanel.hidden) deployStatus.textContent = status;
}

/** Back to the menu after a disconnect: the deploying panel with the reason and a rejoin. */
export function showMenu(status: string): void {
  showDeploying(currentAccount?.name ?? currentGuestName ?? "", status);
  deployPanel.classList.add("settled");
  rejoinButton.hidden = false;
  criticalVignette.classList.remove("active");
  menu.hidden = false;
  hud.hidden = true;
}

/** The menu's right-hand side while joining: who is deploying and how it is going. */
function showDeploying(name: string, status: string): void {
  authPanel.hidden = true;
  deployPanel.hidden = false;
  deployPanel.classList.remove("settled");
  rejoinButton.hidden = true;
  deployName.textContent = name;
  deployStatus.textContent = status;
}

export function showHud(): void {
  menu.hidden = true;
  hud.hidden = false;
}

export function setHealth(value: number): void {
  if (value === shownHp) return;
  if (value < shownHp && shownHp > 0) flash(damageFlash);
  shownHp = value;
  hp.textContent = String(value);

  const clampedHp = Math.max(0, Math.min(100, value));
  hpBarFill.style.width = `${clampedHp}%`;

  const color = clampedHp > 50 ? "var(--cyan)" : clampedHp > 25 ? "var(--accent)" : "var(--danger)";
  document.documentElement.style.setProperty("--hp-color", color);
  criticalVignette.classList.toggle("active", clampedHp <= 25);
}

export function setGrenades(value: number): void {
  if (value === shownGrenades) return;
  shownGrenades = value;
  grenades.textContent = String(value);
}

/** `reserve` is the equipped weapon's spare rounds, -1 when unlimited. */
export function setWeapon(
  weapon: number,
  ammo: number,
  reserve: number,
  reloading: boolean,
  ads: boolean,
  sprinting: boolean,
): void {
  if (
    weapon !== shownWeapon ||
    ammo !== shownAmmo ||
    reserve !== shownReserve ||
    reloading !== shownReloading
  ) {
    shownWeapon = weapon;
    shownAmmo = ammo;
    shownReserve = reserve;
    shownReloading = reloading;
    const definition = weaponDefinition(weapon);
    weaponName.textContent = definition.name.toUpperCase();
    weaponAmmo.textContent = reloading
      ? "RELOADING…"
      : reserve < 0
        ? `${ammo}/${definition.magSize}`
        : `${ammo} | ${reserve}`;
    for (const slot of weaponSlots.children) {
      slot.classList.toggle("selected", Number((slot as HTMLElement).dataset.weapon) === weapon);
    }
  }
  // Through iron sights the weapon itself is the crosshair.
  crosshair.classList.toggle("ads", ads);
  crosshair.classList.toggle("sighted", ads && weaponDefinition(weapon).ironSights);
  crosshair.classList.toggle("sprinting", sprinting);
}

export function flashHitmarker(head: boolean): void {
  hitmarker.classList.toggle("head", head);
  flash(hitmarker);
}

function flash(element: HTMLElement): void {
  element.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FLASH_MS, easing: "ease-out" });
}

export function addKillFeedEntry(killer: string, victim: string, icon: string): void {
  const entry = document.createElement("li");
  if (killer.length > 0) entry.append(textSpan(killer, ""));
  entry.append(textSpan(icon, "icon"), textSpan(victim, ""));
  killFeed.prepend(entry);
  while (killFeed.children.length > KILL_FEED_MAX) killFeed.lastElementChild?.remove();
  setTimeout(() => entry.remove(), KILL_FEED_MS);
}

function textSpan(text: string, className: string): HTMLSpanElement {
  const span = document.createElement("span");
  span.textContent = text;
  if (className) span.className = className;
  return span;
}

export function setScoreboard(players: readonly RosterEntry[], myId: number): void {
  scoreboardRows.replaceChildren(
    ...players.map((player) => {
      const row = document.createElement("tr");
      if (player.id === myId) row.className = "me";
      const name = document.createElement("td");
      name.textContent = player.name;
      const kills = document.createElement("td");
      kills.className = "number";
      kills.textContent = String(player.kills);
      const deaths = document.createElement("td");
      deaths.className = "number";
      deaths.textContent = String(player.deaths);
      row.append(name, kills, deaths);
      return row;
    }),
  );
}

export function setMatchStats(players: readonly RosterEntry[], myId: number): void {
  const me = players.find((player) => player.id === myId);
  const kills = me?.kills ?? 0;
  if (kills !== shownKills) {
    shownKills = kills;
    matchKills.textContent = String(kills);
  }
  if (players.length !== shownOnlinePlayers) {
    shownOnlinePlayers = players.length;
    onlinePlayers.textContent = String(players.length);
  }
}

/** Top-down footprints of every solid box, in map space: x to the right, z down, north up. */
function renderMinimapLayout(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  const size = ARENA_HALF_SIZE * 2 * MINIMAP_LAYOUT_PX_PER_METRE;
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D context is unavailable");
  context.translate(size / 2, size / 2);
  context.scale(MINIMAP_LAYOUT_PX_PER_METRE, MINIMAP_LAYOUT_PX_PER_METRE);
  for (const patch of GROUND_PATCHES) {
    context.fillStyle = MAP_SURFACE_FILL[patch.surface];
    context.fillRect(patch.x - patch.hx, patch.z - patch.hz, patch.hx * 2, patch.hz * 2);
  }
  // Lowest first, so a temple's tiers stack up on its plinth the way they do in the world.
  const boxes = ARENA_BOXES.filter((box) => MAP_KIND_STYLE[box.kind]).sort(
    (a, b) => a.y + a.hy - (b.y + b.hy),
  );
  context.lineWidth = 1 / MINIMAP_LAYOUT_PX_PER_METRE;
  context.strokeStyle = MAP_OUTLINE;
  for (const box of boxes) {
    const style = MAP_KIND_STYLE[box.kind];
    if (!style) continue;
    const height = Math.min(1, (box.y + box.hy) / MAP_FULL_HEIGHT);
    context.save();
    context.translate(box.x, box.z);
    // A yaw about +Y turns +X towards -Z, which is anticlockwise on a z-down map.
    context.rotate(-box.yaw);
    context.fillStyle = `rgba(${style.rgb}, ${(style.alpha * (0.75 + 0.25 * height)).toFixed(3)})`;
    context.fillRect(-box.hx, -box.hz, box.hx * 2, box.hz * 2);
    if (style.outline) context.strokeRect(-box.hx, -box.hz, box.hx * 2, box.hz * 2);
    context.restore();
  }
  return canvas;
}

const minimapLayout = renderMinimapLayout();

/** A canvas showing part of the arena: the minimap (a circle around you that turns with you) and
 * the full map (the whole arena, north up). Both draw the same layout and markers. */
type MapView = {
  context: CanvasRenderingContext2D;
  size: number;
  /** World point at the canvas centre and how the world is turned; the frame's view. */
  centerX: number;
  centerZ: number;
  rotation: number;
  /** Pixels per metre. */
  scale: number;
  round: boolean;
};

function createMapView(
  canvas: HTMLCanvasElement,
  size: number,
  scale: number,
  round: boolean,
): MapView {
  canvas.width = size * MINIMAP_PIXEL_RATIO;
  canvas.height = size * MINIMAP_PIXEL_RATIO;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D context is unavailable");
  return { context, size, centerX: 0, centerZ: 0, rotation: 0, scale, round };
}

const minimapView = createMapView(minimapCanvas, MINIMAP_SIZE, MINIMAP_SCALE, true);
const fullMapView = createMapView(fullMapCanvas, FULL_MAP_SIZE, FULL_MAP_SCALE, false);

/** Where a world point lands on a view, relative to its centre. */
function mapPointX(view: MapView, x: number, z: number): number {
  const dx = x - view.centerX;
  const dz = z - view.centerZ;
  return (dx * Math.cos(view.rotation) - dz * Math.sin(view.rotation)) * view.scale;
}

function mapPointY(view: MapView, x: number, z: number): number {
  const dx = x - view.centerX;
  const dz = z - view.centerZ;
  return (dx * Math.sin(view.rotation) + dz * Math.cos(view.rotation)) * view.scale;
}

/** Clears the view and draws the arena layout under its transform, leaving the context set up
 * with the origin at the canvas centre. */
function beginMapView(view: MapView, centerX: number, centerZ: number, rotation: number): void {
  view.centerX = centerX;
  view.centerZ = centerZ;
  view.rotation = rotation;
  const { context, size } = view;
  const half = size / 2;
  context.setTransform(MINIMAP_PIXEL_RATIO, 0, 0, MINIMAP_PIXEL_RATIO, 0, 0);
  context.clearRect(0, 0, size, size);
  context.translate(half, half);
  if (view.round) {
    context.beginPath();
    context.arc(0, 0, half - 1, 0, Math.PI * 2);
    context.clip();
  }
  context.save();
  context.rotate(rotation);
  context.scale(view.scale, view.scale);
  context.translate(-centerX, -centerZ);
  context.drawImage(
    minimapLayout,
    -ARENA_HALF_SIZE,
    -ARENA_HALF_SIZE,
    ARENA_HALF_SIZE * 2,
    ARENA_HALF_SIZE * 2,
  );
  context.restore();
}

/** Your marker: an arrow pointing the way you face, with the view cone behind it. */
function drawSelfMarker(
  view: MapView,
  x: number,
  z: number,
  yaw: number,
  coneLength: number,
): void {
  const { context } = view;
  context.save();
  context.translate(mapPointX(view, x, z), mapPointY(view, x, z));
  // Facing (-sin yaw, -cos yaw) in the world is straight up after turning by the view's rotation.
  context.rotate(view.rotation - yaw);
  context.beginPath();
  context.moveTo(0, 0);
  context.arc(
    0,
    0,
    coneLength,
    -Math.PI / 2 - MINIMAP_VIEW_CONE_RAD / 2,
    -Math.PI / 2 + MINIMAP_VIEW_CONE_RAD / 2,
  );
  context.closePath();
  context.fillStyle = "rgba(0, 240, 255, 0.1)";
  context.fill();
  context.fillStyle = "#00f0ff";
  context.shadowColor = "#00f0ff";
  context.shadowBlur = 8;
  context.beginPath();
  context.moveTo(0, -6);
  context.lineTo(4, 5);
  context.lineTo(0, 3);
  context.lineTo(-4, 5);
  context.closePath();
  context.fill();
  context.restore();
}

/** A living opponent at a point already in view space: a dot with a tick for their facing, or a
 * hollow dot when `inRange` is false. */
function drawOpponentMarker(
  view: MapView,
  mapX: number,
  mapY: number,
  yaw: number,
  inRange: boolean,
): void {
  const { context } = view;
  context.save();
  context.translate(mapX, mapY);
  context.strokeStyle = "#ffcf4a";
  context.fillStyle = "#ffcf4a";
  context.shadowColor = "#ffcf4a";
  context.shadowBlur = 4;
  context.lineWidth = 1.5;
  context.beginPath();
  context.arc(0, 0, MINIMAP_ENEMY_RADIUS, 0, Math.PI * 2);
  if (!inRange) {
    context.stroke();
    context.restore();
    return;
  }
  context.fill();
  const facing = view.rotation - yaw;
  context.beginPath();
  context.moveTo(0, 0);
  context.lineTo(Math.sin(facing) * MINIMAP_ENEMY_TICK, -Math.cos(facing) * MINIMAP_ENEMY_TICK);
  context.stroke();
  context.restore();
}

export function beginMinimap(x: number, z: number, yaw: number, alive: boolean): void {
  beginMapView(minimapView, x, z, yaw);
  const { context } = minimapView;
  // North marker on the rim: world -Z, turned like everything else.
  const rim = MINIMAP_CENTER - MINIMAP_RIM_INSET;
  context.fillStyle = "rgba(255, 255, 255, 0.7)";
  context.font = "700 9px 'Chakra Petch', sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText("N", Math.sin(yaw) * rim, -Math.cos(yaw) * rim);
  if (alive) drawSelfMarker(minimapView, x, z, yaw, MINIMAP_CENTER);
}

/** A living opponent on the minimap, clamped to the rim when out of range. */
export function addMinimapPlayer(x: number, z: number, yaw: number, alive: boolean): void {
  if (!alive) return;
  let mapX = mapPointX(minimapView, x, z);
  let mapY = mapPointY(minimapView, x, z);
  const distance = Math.hypot(mapX, mapY);
  const rim = MINIMAP_CENTER - MINIMAP_RIM_INSET;
  const inRange = distance <= rim;
  if (!inRange) {
    mapX *= rim / distance;
    mapY *= rim / distance;
  }
  drawOpponentMarker(minimapView, mapX, mapY, yaw, inRange);
}

export function setFullMapVisible(visible: boolean): void {
  if (fullMap.hidden === visible) fullMap.hidden = !visible;
}

/** The whole arena, north up, with the districts named and you on it. Draw only while open. */
/** The arena's grid, gate names, compass and scale, drawn under the markers. */
function drawFullMapFurniture(): void {
  const { context, scale } = fullMapView;
  const edge = ARENA_HALF_SIZE * scale;
  context.strokeStyle = "rgba(255, 255, 255, 0.07)";
  context.lineWidth = 1;
  context.beginPath();
  for (let metres = -ARENA_HALF_SIZE; metres <= ARENA_HALF_SIZE; metres += FULL_MAP_GRID_METRES) {
    const at = metres * scale;
    context.moveTo(at, -edge);
    context.lineTo(at, edge);
    context.moveTo(-edge, at);
    context.lineTo(edge, at);
  }
  context.stroke();
  // The playable line: the inner faces of the ring of houses.
  context.strokeStyle = "rgba(0, 240, 255, 0.25)";
  context.setLineDash([4, 4]);
  context.strokeRect(
    -PLAY_HALF_SIZE * scale,
    -PLAY_HALF_SIZE * scale,
    PLAY_HALF_SIZE * 2 * scale,
    PLAY_HALF_SIZE * 2 * scale,
  );
  context.setLineDash([]);

  context.textAlign = "center";
  context.textBaseline = "middle";
  context.font = "700 10px 'Chakra Petch', sans-serif";
  context.fillStyle = "rgba(255, 255, 255, 0.5)";
  for (const district of DISTRICTS) {
    context.fillText(district.name, district.x * scale, district.z * scale);
  }
  context.fillStyle = "rgba(255, 95, 109, 0.85)";
  context.font = "700 8px 'Chakra Petch', sans-serif";
  for (const gate of FULL_MAP_GATES) context.fillText(gate.name, gate.x * scale, gate.z * scale);

  // Compass, top left; scale bar, bottom left.
  const corner = -edge + 4;
  context.fillStyle = "rgba(255, 255, 255, 0.8)";
  context.font = "700 11px 'Chakra Petch', sans-serif";
  context.fillText("N", corner + 10, corner + 20);
  context.beginPath();
  context.moveTo(corner + 10, corner + 4);
  context.lineTo(corner + 14, corner + 12);
  context.lineTo(corner + 6, corner + 12);
  context.closePath();
  context.fill();
  const barMetres = FULL_MAP_GRID_METRES;
  context.strokeStyle = "rgba(255, 255, 255, 0.8)";
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(corner + 6, edge - 10);
  context.lineTo(corner + 6 + barMetres * scale, edge - 10);
  context.stroke();
  context.textAlign = "left";
  context.font = "700 9px 'Chakra Petch', sans-serif";
  context.fillText(`${barMetres} m`, corner + 6, edge - 20);
}

export function beginFullMap(x: number, z: number, yaw: number, alive: boolean): void {
  beginMapView(fullMapView, 0, 0, 0);
  drawFullMapFurniture();
  if (alive) drawSelfMarker(fullMapView, x, z, yaw, FULL_MAP_CONE_LENGTH);
}

/** A living opponent on the full map, with their name beside them. */
export function addFullMapPlayer(
  x: number,
  z: number,
  yaw: number,
  alive: boolean,
  name: string,
): void {
  if (!alive) return;
  const mapX = mapPointX(fullMapView, x, z);
  const mapY = mapPointY(fullMapView, x, z);
  drawOpponentMarker(fullMapView, mapX, mapY, yaw, true);
  const { context } = fullMapView;
  context.fillStyle = "#ffcf4a";
  context.font = "700 9px 'Chakra Petch', sans-serif";
  context.textAlign = "left";
  context.textBaseline = "middle";
  context.fillText(name, mapX + MINIMAP_ENEMY_RADIUS + 4, mapY);
}

function drawGrenadeMarker(view: MapView, x: number, z: number): void {
  const { context } = view;
  context.fillStyle = "#ff9a3c";
  context.beginPath();
  context.arc(mapPointX(view, x, z), mapPointY(view, x, z), MAP_GRENADE_RADIUS, 0, Math.PI * 2);
  context.fill();
}

function drawRocketMarker(view: MapView, x: number, z: number, dx: number, dz: number): void {
  const { context } = view;
  const mapX = mapPointX(view, x, z);
  const mapY = mapPointY(view, x, z);
  // The heading, turned like the view; the tick trails behind the rocket.
  const headX = dx * Math.cos(view.rotation) - dz * Math.sin(view.rotation);
  const headY = dx * Math.sin(view.rotation) + dz * Math.cos(view.rotation);
  context.strokeStyle = "#ff9a3c";
  context.fillStyle = "#ff9a3c";
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(mapX - headX * MAP_ROCKET_TICK, mapY - headY * MAP_ROCKET_TICK);
  context.lineTo(mapX, mapY);
  context.stroke();
  context.beginPath();
  context.arc(mapX, mapY, MAP_ROCKET_RADIUS, 0, Math.PI * 2);
  context.fill();
}

/** A live grenade, on the minimap and, when open, the full map. */
export function addMapGrenade(x: number, z: number): void {
  drawGrenadeMarker(minimapView, x, z);
  if (!fullMap.hidden) drawGrenadeMarker(fullMapView, x, z);
}

/** A rocket in flight with its heading, on the minimap and, when open, the full map. */
export function addMapRocket(x: number, z: number, dx: number, dz: number): void {
  drawRocketMarker(minimapView, x, z, dx, dz);
  if (!fullMap.hidden) drawRocketMarker(fullMapView, x, z, dx, dz);
}

export function setScoreboardVisible(visible: boolean): void {
  if (scoreboard.hidden === visible) scoreboard.hidden = !visible;
}

export function setCenterMessage(text: string): void {
  if (text === shownCenterMessage) return;
  shownCenterMessage = text;
  centerMessage.textContent = text;
}

export function setClickToPlayVisible(visible: boolean): void {
  if (clickToPlay.hidden === visible) clickToPlay.hidden = !visible;
}
