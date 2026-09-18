import { KILL_FEED_MAX, KILL_FEED_MS } from "../shared/constants.ts";
import type { RosterEntry } from "../shared/protocol.ts";

export function getElement<T extends HTMLElement>(id: string, type: { new (): T }): T {
  const element = document.getElementById(id);
  if (!(element instanceof type)) throw new Error(`index.html is missing #${id}`);
  return element;
}

const menu = getElement("menu", HTMLFormElement);
const nameInput = getElement("name", HTMLInputElement);
const playButton = getElement("play", HTMLButtonElement);
const menuStatus = getElement("menu-status", HTMLParagraphElement);
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
const weaponName = getElement("weapon-name", HTMLSpanElement);
const weaponAmmo = getElement("weapon-ammo", HTMLSpanElement);
const weaponSlots = getElement("weapon-slots", HTMLDivElement);
const crosshair = getElement("crosshair", HTMLDivElement);

const FLASH_MS = 220;

// Last values written, so the DOM is only touched when something changes.
let shownHp = -1;
let shownGrenades = -1;
let shownCenterMessage = "";
let shownWeapon = -1;
let shownRockets = -1;
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

export function onPlay(handler: (name: string) => void, savedName: string): void {
  nameInput.value = savedName;
  menu.addEventListener("submit", (event) => {
    event.preventDefault();
    const name = nameInput.value.trim();
    if (name.length > 0) handler(name);
  });
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

export function setMenuReady(): void {
  playButton.disabled = false;
  playButton.textContent = "Play";
}

export function setMenuStatus(status: string): void {
  menuStatus.textContent = status;
}

export function showMenu(status: string): void {
  setMenuStatus(status);
  criticalVignette.classList.remove("active");
  menu.hidden = false;
  hud.hidden = true;
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

export function setWeapon(weapon: number, rockets: number, ads: boolean, sprinting: boolean): void {
  if (weapon !== shownWeapon || rockets !== shownRockets) {
    shownWeapon = weapon;
    shownRockets = rockets;
    const names = ["RIFLE", "SMG", "BAZOOKA"];
    weaponName.textContent = names[weapon] ?? "RIFLE";
    weaponAmmo.textContent = weapon === 2 ? `${rockets} ROCKETS` : "∞ AMMO";
    for (const slot of weaponSlots.children) {
      slot.classList.toggle("selected", Number((slot as HTMLElement).dataset.weapon) === weapon);
    }
  }
  crosshair.classList.toggle("ads", ads);
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
