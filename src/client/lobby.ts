import {
  AmbientLight,
  AnimationMixer,
  Color,
  DirectionalLight,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Timer,
  WebGLRenderer,
} from "three";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { LOBBY_POLL_MS, TICK_RATE } from "../shared/constants.ts";
import type { LobbyStatus, RosterEntry } from "../shared/protocol.ts";
import {
  isWeaponId,
  WEAPON_DEFINITIONS,
  type WeaponDefinition,
  type WeaponId,
  weaponDefinition,
} from "../shared/weapons.ts";
import { currentPlayer, GUEST_STORAGE_KEY, SESSION_STORAGE_KEY } from "./account.ts";
import { loadLoadout, loadRecord, type MatchResult, saveLoadout } from "./stats.ts";

// The lobby: who you are and how you've done, what you'll spawn with, and who is in the match
// right now, then a Deploy button. Career stats come from localStorage (see stats.ts); the live
// match comes from the server's /api/lobby.

const LOBBY_STATUS_PATH = "/api/lobby";
/** Gorkhali army ranks, earned by career kills. */
const RANKS: readonly { title: string; kills: number }[] = [
  { title: "Recruit", kills: 0 },
  { title: "Sepoy", kills: 10 },
  { title: "Naik", kills: 30 },
  { title: "Havildar", kills: 75 },
  { title: "Subedar", kills: 150 },
  { title: "Kaji", kills: 300 },
  { title: "Bada Kaji", kills: 600 },
];
const WEAPON_ROLES: Record<WeaponId, string> = {
  0: "Medium range · versatile",
  1: "Close range · fast",
  2: "Explosive · area damage",
};
/** Bar scales: what fills a stat bar completely. */
const BAR_MAX_DAMAGE = 150;
const BAR_MAX_RPM = 1000;
const BAR_MAX_RANGE = 100;
const BAR_MIN_MOBILITY = 0.5;
const BAR_MAX_MOBILITY = 1.2;

function element<T extends HTMLElement>(id: string, type: { new (): T }): T {
  const found = document.getElementById(id);
  if (!(found instanceof type)) throw new Error(`lobby.html is missing #${id}`);
  return found;
}

const player = currentPlayer();
if (!player) {
  location.replace("/");
} else {
  showIdentity(player.name, player.guest);
  showCareer(player.key);
  showLoadout();
  element("deploy", HTMLButtonElement).addEventListener("click", () =>
    location.assign("/?play=true"),
  );
  element("logout-btn", HTMLButtonElement).addEventListener("click", () => {
    try {
      localStorage.removeItem(SESSION_STORAGE_KEY);
      sessionStorage.removeItem(GUEST_STORAGE_KEY);
    } finally {
      location.assign("/");
    }
  });
  pollMatch(player.name);
  startCharacterPreview(element("character-preview", HTMLCanvasElement));
}

function initials(name: string): string {
  return name
    .split(/[\s-]+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");
}

function showIdentity(name: string, guest: boolean): void {
  element("chip-avatar", HTMLSpanElement).textContent = initials(name);
  element("avatar", HTMLSpanElement).textContent = initials(name);
  element("player-name", HTMLElement).textContent = name;
  element("operative-name", HTMLElement).textContent = name;
  element("player-kind", HTMLElement).textContent = guest
    ? "Guest · stats kept this session"
    : "Account";
}

type Rank = { title: string; kills: number };

function rankFor(kills: number): { current: Rank; next: Rank | null } {
  let current: Rank = { title: "Recruit", kills: 0 };
  let next: Rank | null = null;
  for (const rank of RANKS) {
    if (kills >= rank.kills) current = rank;
    else if (!next) next = rank;
  }
  return { current, next };
}

function showCareer(playerKey: string): void {
  const { stats, recent } = loadRecord(playerKey);
  const { current, next } = rankFor(stats.kills);
  element("rank", HTMLElement).textContent = current.title;
  const progress = next ? (stats.kills - current.kills) / (next.kills - current.kills) : 1;
  element("rank-progress", HTMLElement).style.width = `${Math.round(progress * 100)}%`;
  element("rank-next", HTMLElement).textContent = next
    ? `${next.kills - stats.kills} kills to ${next.title}`
    : "Highest rank reached";
  element("stat-kd", HTMLElement).textContent = (stats.kills / Math.max(1, stats.deaths)).toFixed(
    2,
  );
  element("stat-kills", HTMLElement).textContent = String(stats.kills);
  element("stat-deaths", HTMLElement).textContent = String(stats.deaths);
  element("stat-wins", HTMLElement).textContent = String(stats.wins);
  element("stat-matches", HTMLElement).textContent = String(stats.matches);
  element("stat-headshots", HTMLElement).textContent =
    `${Math.round((stats.headshots / Math.max(1, stats.kills)) * 100)}%`;
  element("best-kills", HTMLElement).textContent =
    stats.bestKills > 0 ? `BEST ${stats.bestKills} KILLS` : "";
  const list = element("recent", HTMLUListElement);
  list.replaceChildren();
  if (recent.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "No matches yet. Deploy to play your first.";
    list.append(empty);
    return;
  }
  for (const result of recent) list.append(recentRow(result));
}

function timeAgo(ms: number): string {
  const minutes = Math.round((Date.now() - ms) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

function recentRow(result: MatchResult): HTMLLIElement {
  const row = document.createElement("li");
  const badge = document.createElement("span");
  badge.className = `badge ${result.won ? "win" : "loss"}`;
  badge.textContent = result.won ? "WIN" : "LOSS";
  const score = document.createElement("span");
  score.textContent = `${result.kills} K / ${result.deaths} D`;
  const detail = document.createElement("small");
  detail.textContent = `${result.won ? "You won" : `${result.winner} won`} · ${timeAgo(result.endedAtMs)}`;
  row.append(badge, score, detail);
  return row;
}

function roundsPerMinute(weapon: WeaponDefinition): number {
  return Math.round((TICK_RATE / weapon.fireIntervalTicks) * 60);
}

function bar(label: string, fill: number): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "bar";
  const text = document.createElement("span");
  text.textContent = label;
  const meter = document.createElement("i");
  meter.style.setProperty("--fill", `${Math.round(Math.max(0, Math.min(1, fill)) * 100)}%`);
  row.append(text, meter);
  return row;
}

function weaponCard(weapon: WeaponDefinition, selected: boolean): HTMLButtonElement {
  const card = document.createElement("button");
  card.type = "button";
  card.className = `weapon${selected ? " selected" : ""}`;
  card.dataset.weapon = String(weapon.id);
  const slot = document.createElement("span");
  slot.className = "slot";
  slot.textContent = `[${weapon.id + 1}]`;
  const name = document.createElement("b");
  name.className = "weapon-name";
  name.textContent = weapon.name.toUpperCase();
  const role = document.createElement("span");
  role.className = "role";
  role.textContent = WEAPON_ROLES[weapon.id];
  const damage = weapon.projectile ? weapon.projectile.directDamage : weapon.damage;
  const bars = document.createElement("div");
  bars.className = "bars";
  bars.append(
    bar("DMG", damage / BAR_MAX_DAMAGE),
    bar("RATE", roundsPerMinute(weapon) / BAR_MAX_RPM),
    bar("RANGE", weapon.projectile ? 1 : weapon.fullDamageRange / BAR_MAX_RANGE),
    bar(
      "SPEED",
      (weapon.movementMultiplier - BAR_MIN_MOBILITY) / (BAR_MAX_MOBILITY - BAR_MIN_MOBILITY),
    ),
  );
  const specs = document.createElement("p");
  specs.className = "specs";
  const reload = (weapon.reloadTicks / TICK_RATE).toFixed(1);
  specs.textContent = weapon.projectile
    ? `${damage} direct · ${weapon.projectile.splashDamage} splash over ${weapon.projectile.radius} m · ${weapon.magSize + weapon.reserve} rockets · ${reload}s reload`
    : `${damage} damage to ${weapon.fullDamageRange} m · ${roundsPerMinute(weapon)} RPM · ${weapon.magSize} rounds · ${reload}s reload`;
  card.append(slot, name, role, bars, specs);
  return card;
}

function showLoadout(): void {
  const container = element("weapons", HTMLDivElement);
  const chosen = loadLoadout();
  container.replaceChildren(
    ...WEAPON_DEFINITIONS.map((weapon) => weaponCard(weapon, weapon.id === chosen)),
  );
  showDeployInfo(chosen);
  container.addEventListener("click", (event) => {
    const card = (event.target as HTMLElement).closest<HTMLButtonElement>(".weapon");
    if (!card) return;
    const id = Number(card.dataset.weapon);
    if (!isWeaponId(id)) return;
    saveLoadout(id);
    for (const other of container.children) other.classList.toggle("selected", other === card);
    showDeployInfo(id);
  });
}

function showDeployInfo(weapon: WeaponId): void {
  const info = element("deploy-info", HTMLElement);
  info.replaceChildren();
  info.append("Deploying as ");
  const who = document.createElement("b");
  who.className = "who";
  who.textContent = player?.name ?? "";
  info.append(who, " with the ");
  const what = document.createElement("b");
  what.className = "who";
  what.textContent = weaponDefinition(weapon).name;
  info.append(what, ". Switch weapons in play with 1, 2, 3 or the wheel.");
}

function isLobbyStatus(value: unknown): value is LobbyStatus {
  if (typeof value !== "object" || value === null) return false;
  const status = value as Record<string, unknown>;
  return (
    (status.state === "playing" || status.state === "ended") &&
    typeof status.winnerId === "number" &&
    Array.isArray(status.players) &&
    typeof status.maxPlayers === "number" &&
    typeof status.killsToWin === "number"
  );
}

function playerRow(entry: RosterEntry, position: number, me: boolean): HTMLLIElement {
  const row = document.createElement("li");
  if (me) row.className = "me";
  const pos = document.createElement("span");
  pos.className = "pos";
  pos.textContent = String(position);
  const name = document.createElement("span");
  name.textContent = entry.name;
  const kills = document.createElement("span");
  kills.className = "k";
  kills.textContent = String(entry.kills);
  const deaths = document.createElement("span");
  deaths.className = "d";
  deaths.textContent = String(entry.deaths);
  row.append(pos, name, kills, deaths);
  return row;
}

function showMatch(status: LobbyStatus | null, pingMs: number, myName: string): void {
  const pill = element("status-pill", HTMLElement);
  const ping = element("ping", HTMLElement);
  const list = element("players", HTMLUListElement);
  if (!status) {
    pill.className = "pill offline";
    pill.textContent = "SERVER OFFLINE";
    ping.textContent = "";
    element("match-players", HTMLElement).textContent = "";
    list.replaceChildren();
    return;
  }
  element("rule-kills", HTMLElement).textContent = String(status.killsToWin);
  element("rule-players", HTMLElement).textContent = String(status.maxPlayers);
  element("match-players", HTMLElement).textContent =
    `${status.players.length}/${status.maxPlayers} PLAYING`;
  ping.textContent = `${Math.round(pingMs)} MS`;
  if (status.state === "ended") {
    const winner = status.players.find((entry) => entry.id === status.winnerId);
    pill.className = "pill ended";
    pill.textContent = winner
      ? `ROUND OVER · ${winner.name.toUpperCase()} WON`
      : "ROUND OVER · RESTARTING";
  } else {
    pill.className = "pill";
    pill.textContent = status.players.length === 0 ? "LIVE · WAITING FOR PLAYERS" : "LIVE";
  }
  list.replaceChildren();
  if (status.players.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "Nobody is in the match yet. Be the first to deploy.";
    list.append(empty);
    return;
  }
  status.players.forEach((entry, index) => {
    list.append(playerRow(entry, index + 1, entry.name === myName));
  });
}

/** Asks the server who is playing, every couple of seconds, and times the round trip. */
function pollMatch(myName: string): void {
  async function poll(): Promise<void> {
    const started = performance.now();
    try {
      const response = await fetch(LOBBY_STATUS_PATH, { cache: "no-store" });
      const body: unknown = await response.json();
      showMatch(isLobbyStatus(body) ? body : null, performance.now() - started, myName);
    } catch {
      showMatch(null, 0, myName);
    }
    setTimeout(poll, LOBBY_POLL_MS);
  }
  poll();
}

async function startCharacterPreview(canvas: HTMLCanvasElement): Promise<void> {
  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = SRGBColorSpace;
  const scene = new Scene();
  scene.background = new Color(0x080d16);
  const camera = new PerspectiveCamera(35, 1, 0.1, 100);
  camera.position.set(0, 1.45, 4.1);
  camera.lookAt(0, 1.2, 0);
  scene.add(new AmbientLight(0xa9d7ff, 1.8));
  const key = new DirectionalLight(0x00f0ff, 3.5);
  key.position.set(3, 5, 4);
  scene.add(key);
  const rim = new DirectionalLight(0xffcf4a, 2.5);
  rim.position.set(-4, 2, -3);
  scene.add(rim);

  const model = await new GLTFLoader()
    .setMeshoptDecoder(MeshoptDecoder)
    .loadAsync("/assets/character.glb");
  // The lobby shows your own character: the King (see art/player.py).
  const general = model.scene.getObjectByName("General");
  if (general) general.visible = false;
  scene.add(model.scene);
  const mixer = new AnimationMixer(model.scene);
  const idle = model.animations.find((clip) => clip.name === "Idle");
  if (idle) mixer.clipAction(idle).play();
  const timer = new Timer();

  function draw(timestamp: number): void {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const renderWidth = Math.round(width * renderer.getPixelRatio());
    const renderHeight = Math.round(height * renderer.getPixelRatio());
    if (canvas.width !== renderWidth || canvas.height !== renderHeight) {
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    }
    timer.update(timestamp);
    const delta = timer.getDelta();
    mixer.update(delta);
    model.scene.rotation.y += delta * 0.25;
    renderer.render(scene, camera);
    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);
}
