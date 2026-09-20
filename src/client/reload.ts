import {
  OTHER_RELOAD_GAIN,
  OWN_RELOAD_GAIN,
  RELOAD_SOUND_DISTANCE,
  TICK_MS,
} from "../shared/constants.ts";
import { clamp } from "../shared/math.ts";
import { type WeaponId, weaponDefinition } from "../shared/weapons.ts";
import { playReload, type ReloadSound, type SoundPlacement } from "./audio.ts";

// Reloading, for you and for the players you can see: a run of metal knocks at set fractions of
// the weapon's reload time, and the motion that makes them. The weapon comes down and rolls
// towards you, the magazine drops out, the fresh one is slapped in, the bolt is racked and the
// weapon comes back up; a launcher is tipped and a rocket shoved into it. The server decides when
// a reload starts and ends (shared/weapons.ts sets how long); this only shows and sounds it.

/** One knock in a reload: when in the reload it lands, what it sounds like, and how the
 * first-person weapon jolts as it does (metres and radians in camera space). */
type Beat = {
  at: number;
  sound: ReloadSound;
  joltX: number;
  joltY: number;
  joltZ: number;
  joltPitch: number;
};

/** A weapon's reload: its knocks, and when the support hand leaves the weapon and comes back. */
type Script = {
  beats: readonly Beat[];
  handOut: number;
  handBack: number;
};

const GUN_SCRIPT: Script = {
  beats: [
    { at: 0.22, sound: "reload-out", joltX: 0, joltY: -0.018, joltZ: 0, joltPitch: -0.03 },
    { at: 0.6, sound: "reload-in", joltX: 0.004, joltY: 0.022, joltZ: 0, joltPitch: 0.09 },
    { at: 0.78, sound: "reload-bolt", joltX: 0, joltY: 0, joltZ: 0.024, joltPitch: -0.04 },
  ],
  handOut: 0.14,
  handBack: 0.6,
};
const ROCKET_SCRIPT: Script = {
  beats: [
    { at: 0.38, sound: "reload-rocket", joltX: 0, joltY: 0.006, joltZ: -0.035, joltPitch: 0.06 },
    { at: 0.72, sound: "reload-in", joltX: 0, joltY: 0.014, joltZ: 0, joltPitch: 0.03 },
  ],
  handOut: 0.08,
  handBack: 0.38,
};
/** The weapon is down by this far into the reload, and starts back up from `RAISE_FROM`. */
const LOWERED_BY = 0.14;
const RAISE_FROM = 0.86;
/** How long the hand takes to reach the magazine, as a fraction of the reload. */
const HAND_TRAVEL = 0.1;
const JOLT_DECAY_PER_SEC = 14;
/** The drawn motion follows the scripted one at this rate, so a cancelled reload (switching
 * weapons, dying) eases back into the aim instead of snapping. */
const SETTLE_PER_SEC = 22;

/** Where a reload's motion is, smoothed: `lower` and `hand` run 0 to 1, the rest are the current
 * knock's jolt in camera space. */
export type ReloadMotion = {
  lower: number;
  hand: number;
  x: number;
  y: number;
  z: number;
  pitch: number;
};

type Reload = {
  active: boolean;
  weapon: WeaponId;
  startMs: number;
  durationMs: number;
  /** Knocks sounded so far. */
  beat: number;
  /** The server's flag last seen, for its edges. */
  wasReloading: boolean;
  seen: boolean;
  motion: ReloadMotion;
};

function createReload(): Reload {
  return {
    active: false,
    weapon: 0,
    startMs: 0,
    durationMs: 1,
    beat: 0,
    wasReloading: false,
    seen: false,
    motion: { lower: 0, hand: 0, x: 0, y: 0, z: 0, pitch: 0 },
  };
}

const own = createReload();
const others = new Map<number, Reload>();
/** Reused for every placed knock, so hearing someone reload never allocates. */
const placement: SoundPlacement = {
  x: 0,
  y: 0,
  z: 0,
  listenerX: 0,
  listenerY: 0,
  listenerZ: 0,
  listenerYaw: 0,
  maxDistance: RELOAD_SOUND_DISTANCE,
};

function scriptFor(weapon: WeaponId): Script {
  return weaponDefinition(weapon).projectile ? ROCKET_SCRIPT : GUN_SCRIPT;
}

function smoothstep(from: number, to: number, value: number): number {
  const t = clamp((value - from) / (to - from), 0, 1);
  return t * t * (3 - 2 * t);
}

function start(reload: Reload, weapon: WeaponId, nowMs: number): void {
  reload.active = true;
  reload.weapon = weapon;
  reload.startMs = nowMs;
  reload.durationMs = weaponDefinition(weapon).reloadTicks * TICK_MS;
  reload.beat = 0;
}

/** Sounds the knocks that are due and moves the motion on, then ends the reload once it has
 * run its time. */
function advance(
  reload: Reload,
  nowMs: number,
  dt: number,
  gain: number,
  at: SoundPlacement | null,
): void {
  const motion = reload.motion;
  let lower = 0;
  let hand = 0;
  let jolt = 0;
  let joltBeat: Beat | undefined;
  if (reload.active) {
    const progress = clamp((nowMs - reload.startMs) / reload.durationMs, 0, 1);
    const script = scriptFor(reload.weapon);
    while (reload.beat < script.beats.length) {
      const beat = script.beats[reload.beat];
      if (!beat || beat.at > progress) break;
      playReload(beat.sound, gain, at);
      reload.beat++;
    }
    lower = smoothstep(0, LOWERED_BY, progress) * (1 - smoothstep(RAISE_FROM, 1, progress));
    hand =
      smoothstep(script.handOut, script.handOut + HAND_TRAVEL, progress) *
      (1 - smoothstep(script.handBack, script.handBack + HAND_TRAVEL, progress));
    joltBeat = script.beats[reload.beat - 1];
    if (joltBeat) {
      const sinceBeatS = ((progress - joltBeat.at) * reload.durationMs) / 1000;
      jolt = Math.exp(-JOLT_DECAY_PER_SEC * sinceBeatS);
    }
    if (progress >= 1) reload.active = false;
  }
  const blend = 1 - Math.exp(-SETTLE_PER_SEC * dt);
  motion.lower += (lower - motion.lower) * blend;
  motion.hand += (hand - motion.hand) * blend;
  motion.x += ((joltBeat?.joltX ?? 0) * jolt - motion.x) * blend;
  motion.y += ((joltBeat?.joltY ?? 0) * jolt - motion.y) * blend;
  motion.z += ((joltBeat?.joltZ ?? 0) * jolt - motion.z) * blend;
  motion.pitch += ((joltBeat?.joltPitch ?? 0) * jolt - motion.pitch) * blend;
}

/** Starts your own reload straight away, ahead of the server confirming it, so the motion answers
 * the key press. Does nothing if one is already running. */
export function startOwnReload(weapon: WeaponId, nowMs: number): void {
  if (own.active) return;
  start(own, weapon, nowMs);
}

/** Whether your own reload is running, predicted or confirmed: no shots show meanwhile. */
export function isOwnReloading(): boolean {
  return own.active;
}

/** Your own reload, once per frame. `reloading` and `weapon` are the server's word: a reload it
 * starts that wasn't predicted (firing on empty) starts here, and one it ends early (switching
 * weapons, dying) is cancelled. */
export function updateOwnReload(
  weapon: WeaponId,
  reloading: boolean,
  alive: boolean,
  nowMs: number,
  dt: number,
): ReloadMotion {
  if (own.active && (!alive || own.weapon !== weapon)) own.active = false;
  if (reloading && !own.wasReloading && !own.active && alive) start(own, weapon, nowMs);
  own.wasReloading = reloading;
  advance(own, nowMs, dt, OWN_RELOAD_GAIN, null);
  return own.motion;
}

/** Another player's reload, once per frame from their snapshot flag, sounded from where they
 * are drawn. Runs from the flag's rising edge to its falling edge or the weapon's reload time,
 * whichever comes first. */
export function updateOtherReload(
  id: number,
  weapon: WeaponId,
  reloading: boolean,
  alive: boolean,
  x: number,
  y: number,
  z: number,
  nowMs: number,
  dt: number,
  listenerX: number,
  listenerY: number,
  listenerZ: number,
  listenerYaw: number,
): ReloadMotion {
  let reload = others.get(id);
  if (!reload) {
    reload = createReload();
    others.set(id, reload);
  }
  reload.seen = true;
  placement.x = x;
  placement.y = y;
  placement.z = z;
  placement.listenerX = listenerX;
  placement.listenerY = listenerY;
  placement.listenerZ = listenerZ;
  placement.listenerYaw = listenerYaw;
  if (reload.active && (!alive || !reloading || reload.weapon !== weapon)) reload.active = false;
  if (reloading && !reload.wasReloading && alive) start(reload, weapon, nowMs);
  reload.wasReloading = reloading;
  advance(reload, nowMs, dt, OTHER_RELOAD_GAIN, placement);
  return reload.motion;
}

/** Call once per frame after every updateOtherReload: forgets players no longer drawn. */
export function forgetUnseenReloaders(): void {
  for (const [id, reload] of others) {
    if (reload.seen) {
      reload.seen = false;
      continue;
    }
    others.delete(id);
  }
}
