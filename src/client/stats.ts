import { RECENT_MATCHES_KEPT } from "../shared/constants.ts";
import { isWeaponId, WEAPON, type WeaponId } from "../shared/weapons.ts";

// Career stats and recent results, kept per player in localStorage. The game records them as it
// plays; the lobby shows them. Nothing here is trusted by the server.

export type CareerStats = {
  kills: number;
  headshots: number;
  deaths: number;
  matches: number;
  wins: number;
  /** Most kills in one match. */
  bestKills: number;
};

export type MatchResult = {
  /** Wall-clock time the match ended. */
  endedAtMs: number;
  won: boolean;
  winner: string;
  kills: number;
  deaths: number;
};

export type PlayerRecord = { stats: CareerStats; recent: MatchResult[] };

const STATS_STORAGE_PREFIX = "headshot.stats.";
const LOADOUT_STORAGE_KEY = "headshot.loadout";

function emptyRecord(): PlayerRecord {
  return {
    stats: { kills: 0, headshots: 0, deaths: 0, matches: 0, wins: 0, bestKills: 0 },
    recent: [],
  };
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isMatchResult(value: unknown): value is MatchResult {
  if (typeof value !== "object" || value === null) return false;
  const result = value as Record<string, unknown>;
  return (
    isCount(result.endedAtMs) &&
    typeof result.won === "boolean" &&
    typeof result.winner === "string" &&
    isCount(result.kills) &&
    isCount(result.deaths)
  );
}

export function loadRecord(playerKey: string): PlayerRecord {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STATS_STORAGE_PREFIX + playerKey) ?? "");
    if (typeof value !== "object" || value === null) return emptyRecord();
    const saved = value as Record<string, unknown>;
    const stats = saved.stats as Record<string, unknown> | undefined;
    const record = emptyRecord();
    if (stats) {
      for (const field of Object.keys(record.stats) as (keyof CareerStats)[]) {
        const count = stats[field];
        if (isCount(count)) record.stats[field] = count;
      }
    }
    if (Array.isArray(saved.recent)) record.recent = saved.recent.filter(isMatchResult);
    return record;
  } catch {
    return emptyRecord();
  }
}

function saveRecord(playerKey: string, record: PlayerRecord): void {
  try {
    localStorage.setItem(STATS_STORAGE_PREFIX + playerKey, JSON.stringify(record));
  } catch {
    // Stats are a convenience; a browser without storage just doesn't keep them.
  }
}

export function recordKill(playerKey: string, head: boolean): void {
  const record = loadRecord(playerKey);
  record.stats.kills++;
  if (head) record.stats.headshots++;
  saveRecord(playerKey, record);
}

export function recordDeath(playerKey: string): void {
  const record = loadRecord(playerKey);
  record.stats.deaths++;
  saveRecord(playerKey, record);
}

export function recordMatch(playerKey: string, result: MatchResult): void {
  const record = loadRecord(playerKey);
  record.stats.matches++;
  if (result.won) record.stats.wins++;
  record.stats.bestKills = Math.max(record.stats.bestKills, result.kills);
  record.recent.unshift(result);
  record.recent.length = Math.min(record.recent.length, RECENT_MATCHES_KEPT);
  saveRecord(playerKey, record);
}

/** The weapon the player chose to spawn with in the lobby; the rifle until they choose. */
export function loadLoadout(): WeaponId {
  try {
    const id = Number(localStorage.getItem(LOADOUT_STORAGE_KEY));
    return isWeaponId(id) ? id : WEAPON.RIFLE;
  } catch {
    return WEAPON.RIFLE;
  }
}

export function saveLoadout(weapon: WeaponId): void {
  try {
    localStorage.setItem(LOADOUT_STORAGE_KEY, String(weapon));
  } catch {
    // Then the next match starts with the rifle, as before.
  }
}
