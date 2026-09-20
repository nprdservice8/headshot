import {
  EXPLOSION_SOUND_DISTANCE,
  EXPLOSION_SOUND_GAIN,
  EXPLOSION_THUMP_GAIN,
  GUNSHOT_SOUND_DISTANCE,
  LAUNCH_SOUND_DISTANCE,
  OWN_LAUNCH_GAIN,
  OWN_SHOT_GAIN,
  REMOTE_LAUNCH_GAIN,
  REMOTE_SHOT_GAIN,
} from "../shared/constants.ts";
import { WEAPON, type WeaponId } from "../shared/weapons.ts";

// Web Audio. Every sound is a recorded sample from public/assets/sounds (see art/build.ts),
// played with a little random pitch and volume so repeats don't sound mechanical. Sounds from
// elsewhere in the world fade with distance, dull when far, and pan to the side they are on.

const SOUND_DIR = "/assets/sounds/";
/** How many takes of each sample art/build.ts ships. */
const SAMPLE_TAKES = {
  "step-stone": 5,
  "step-dirt": 5,
  "shot-rifle": 4,
  "shot-smg": 4,
  launch: 3,
  explosion: 4,
  "reload-out": 2,
  "reload-in": 2,
  "reload-bolt": 2,
  "reload-rocket": 2,
} as const;
export type SampleName = keyof typeof SAMPLE_TAKES;
/** Random pitch spread around 1, as a fraction. */
const SAMPLE_PITCH_SPREAD = 0.12;
const SAMPLE_GAIN_SPREAD = 0.2;
// Feet: the recordings are thin, so each footfall gets a copy pitched well down and low-passed
// underneath it for the weight of a boot. A jump is a quick, lighter scuff; a landing is both
// boots at once, pitched down, with a heavier thud that grows with the fall.
const STEP_PITCH_SPREAD = 0.06;
const STEP_WEIGHT_RATE = 0.55;
const STEP_WEIGHT_CUTOFF_HZ = 220;
const STEP_WEIGHT_GAIN = 0.5;
const JUMP_RATE = 1.2;
const LANDING_RATE = 0.78;
const LANDING_SECOND_BOOT_S = 0.045;
const LANDING_THUD_RATE = 0.42;
const LANDING_THUD_CUTOFF_HZ = 160;
const LANDING_THUD_GAIN = 1.1;
export type Surface = "step-stone" | "step-dirt";
export type ReloadSound = "reload-out" | "reload-in" | "reload-bolt" | "reload-rocket";
/** Reload knocks are real handling recordings played as they are; a wider pitch spread would
 * turn a gun into a toy. */
const RELOAD_PITCH_SPREAD = 0.04;

/** Where a sound comes from and who hears it, for sounds not your own. */
export type SoundPlacement = {
  x: number;
  y: number;
  z: number;
  listenerX: number;
  listenerY: number;
  listenerZ: number;
  listenerYaw: number;
  maxDistance: number;
};
/** Distant sounds lose their highs: the cutoff drops this many Hz per metre from 8 kHz. */
const DISTANCE_MUFFLE_HZ_PER_METRE = 60;
const MIN_MUFFLE_HZ = 500;
/** Explosions get a second copy an octave down and low-passed, for the thump the fireworks
 * recordings are missing at close range. */
const THUMP_RATE = 0.5;
const THUMP_CUTOFF_HZ = 180;

const WEAPON_SAMPLE: Record<WeaponId, SampleName> = {
  [WEAPON.RIFLE]: "shot-rifle",
  [WEAPON.SMG]: "shot-smg",
  [WEAPON.BAZOOKA]: "launch",
};

let audioCtx: AudioContext | null = null;
const samples: Partial<Record<SampleName, AudioBuffer[]>> = {};
/** The take played last per sample, so the same one never plays twice in a row. */
const lastTake: Partial<Record<SampleName, number>> = {};

/** Initialize or resume the AudioContext on user gesture. */
export function initAudio(): void {
  if (!audioCtx) {
    const AudioContextClass =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;
    audioCtx = new AudioContextClass();
  }
  if (audioCtx.state === "suspended") {
    audioCtx.resume().catch(() => undefined);
  }
}

/** Fetches and decodes every sample. Decoding runs in an offline context, which needs no user
 * gesture, so this can join the asset load before the menu enables Play. */
export async function loadSounds(): Promise<void> {
  const decoder = new OfflineAudioContext(1, 1, 44100);
  const names = Object.keys(SAMPLE_TAKES) as SampleName[];
  await Promise.all(
    names.map(async (name) => {
      const takes: AudioBuffer[] = [];
      for (let i = 0; i < SAMPLE_TAKES[name]; i++) {
        const response = await fetch(`${SOUND_DIR}${name}-${i}.ogg`);
        if (!response.ok) throw new Error(`Missing sound ${name}-${i}.ogg`);
        takes.push(await decoder.decodeAudioData(await response.arrayBuffer()));
      }
      samples[name] = takes;
    }),
  );
}

function pickTake(name: SampleName): AudioBuffer | undefined {
  const takes = samples[name];
  if (!takes || takes.length === 0) return undefined;
  let index = Math.floor(Math.random() * takes.length);
  if (takes.length > 1 && index === lastTake[name]) index = (index + 1) % takes.length;
  lastTake[name] = index;
  return takes[index];
}

function vary(value: number, spread: number): number {
  return value * (1 + (Math.random() * 2 - 1) * spread);
}

/** Plays `take` at `rate` through `chain` (in order) and a gain of `volume` to the output,
 * `delay` seconds from now. */
function startSource(
  ctx: AudioContext,
  take: AudioBuffer,
  rate: number,
  volume: number,
  chain: readonly AudioNode[],
  delay = 0,
): void {
  const source = ctx.createBufferSource();
  source.buffer = take;
  source.playbackRate.value = rate;
  const gainNode = ctx.createGain();
  gainNode.gain.value = volume;
  let tail: AudioNode = source;
  for (const node of chain) {
    tail.connect(node);
    tail = node;
  }
  tail.connect(gainNode);
  gainNode.connect(ctx.destination);
  source.start(ctx.currentTime + delay);
}

function lowpass(ctx: AudioContext, cutoffHz: number): BiquadFilterNode {
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = cutoffHz;
  return filter;
}

/** The distance falloff and the muffle-and-pan chain for a placed sound; null when it is out of
 * earshot. Your own sounds (no placement) play straight, at full volume. */
function placed(
  ctx: AudioContext,
  at: SoundPlacement | null,
): { falloff: number; chain: AudioNode[] } | null {
  if (!at) return { falloff: 1, chain: [] };
  const dx = at.x - at.listenerX;
  const dy = at.y - at.listenerY;
  const dz = at.z - at.listenerZ;
  const distance = Math.hypot(dx, dy, dz);
  if (distance > at.maxDistance) return null;
  const falloff = (1 - distance / at.maxDistance) ** 2;
  if (falloff < 0.01) return null;
  const filter = lowpass(
    ctx,
    Math.max(MIN_MUFFLE_HZ, 8000 - distance * DISTANCE_MUFFLE_HZ_PER_METRE),
  );
  const panner = ctx.createStereoPanner();
  // The listener's right-hand direction for a yaw about +Y is (cos yaw, 0, -sin yaw).
  const flat = Math.hypot(dx, dz);
  panner.pan.value =
    flat > 0.01 ? (dx * Math.cos(at.listenerYaw) - dz * Math.sin(at.listenerYaw)) / flat : 0;
  return { falloff, chain: [filter, panner] };
}

/** One boot on the ground. */
export function playFootstep(surface: Surface, gain: number, at: SoundPlacement | null): void {
  const ctx = audioCtx;
  if (ctx?.state !== "running") return;
  const voice = placed(ctx, at);
  const take = pickTake(surface);
  if (!voice || !take) return;
  const volume = vary(gain * voice.falloff, SAMPLE_GAIN_SPREAD);
  startSource(ctx, take, vary(1, STEP_PITCH_SPREAD), volume, voice.chain);
  startSource(ctx, take, STEP_WEIGHT_RATE, volume * STEP_WEIGHT_GAIN, [
    lowpass(ctx, STEP_WEIGHT_CUTOFF_HZ),
    ...voice.chain,
  ]);
}

/** The push-off of a jump: a quick, light scuff. */
export function playJump(surface: Surface, gain: number, at: SoundPlacement | null): void {
  const ctx = audioCtx;
  if (ctx?.state !== "running") return;
  const voice = placed(ctx, at);
  const take = pickTake(surface);
  if (!voice || !take) return;
  startSource(ctx, take, vary(JUMP_RATE, STEP_PITCH_SPREAD), gain * voice.falloff, voice.chain);
}

/** Coming back down: both boots a moment apart, pitched down, over a thud. */
export function playLanding(surface: Surface, gain: number, at: SoundPlacement | null): void {
  const ctx = audioCtx;
  if (ctx?.state !== "running") return;
  const voice = placed(ctx, at);
  const first = pickTake(surface);
  const second = pickTake(surface);
  if (!voice || !first || !second) return;
  const volume = gain * voice.falloff;
  startSource(ctx, first, vary(LANDING_RATE, STEP_PITCH_SPREAD), volume, voice.chain);
  startSource(
    ctx,
    second,
    vary(LANDING_RATE, STEP_PITCH_SPREAD),
    volume * 0.8,
    voice.chain,
    LANDING_SECOND_BOOT_S,
  );
  startSource(ctx, first, LANDING_THUD_RATE, volume * LANDING_THUD_GAIN, [
    lowpass(ctx, LANDING_THUD_CUTOFF_HZ),
    ...voice.chain,
  ]);
}

/** One knock of a reload, yours (no placement) or someone else's. */
export function playReload(sound: ReloadSound, gain: number, at: SoundPlacement | null): void {
  const ctx = audioCtx;
  if (ctx?.state !== "running") return;
  const voice = placed(ctx, at);
  const take = pickTake(sound);
  if (!voice || !take) return;
  const volume = vary(gain * voice.falloff, SAMPLE_GAIN_SPREAD);
  startSource(ctx, take, vary(1, RELOAD_PITCH_SPREAD), volume, voice.chain);
}

/** Plays a sample as your own: full volume, no position. */
export function playSample(name: SampleName, gain: number): void {
  const ctx = audioCtx;
  if (ctx?.state !== "running") return;
  const take = pickTake(name);
  if (!take) return;
  startSource(ctx, take, vary(1, SAMPLE_PITCH_SPREAD), vary(gain, SAMPLE_GAIN_SPREAD), []);
}

/** Plays a sample from somewhere in the world: quieter with distance, panned to the side it is
 * on relative to where the listener is looking, and duller when far. Returns the volume it
 * played at, 0 if it was out of earshot. */
export function playSampleAt(
  name: SampleName,
  gain: number,
  maxDistance: number,
  x: number,
  y: number,
  z: number,
  listenerX: number,
  listenerY: number,
  listenerZ: number,
  listenerYaw: number,
): number {
  const ctx = audioCtx;
  if (ctx?.state !== "running") return 0;
  const dx = x - listenerX;
  const dy = y - listenerY;
  const dz = z - listenerZ;
  const distance = Math.hypot(dx, dy, dz);
  if (distance > maxDistance) return 0;
  const falloff = 1 - distance / maxDistance;
  const volume = vary(gain * falloff * falloff, SAMPLE_GAIN_SPREAD);
  if (volume < 0.01) return 0;
  const take = pickTake(name);
  if (!take) return 0;
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = Math.max(MIN_MUFFLE_HZ, 8000 - distance * DISTANCE_MUFFLE_HZ_PER_METRE);
  const panner = ctx.createStereoPanner();
  // The listener's right-hand direction for a yaw about +Y is (cos yaw, 0, -sin yaw).
  const flat = Math.hypot(dx, dz);
  panner.pan.value =
    flat > 0.01 ? (dx * Math.cos(listenerYaw) - dz * Math.sin(listenerYaw)) / flat : 0;
  startSource(ctx, take, vary(1, SAMPLE_PITCH_SPREAD), volume, [filter, panner]);
  return volume;
}

/** Your own weapon firing. */
export function playOwnWeapon(weapon: WeaponId): void {
  const gain = weapon === WEAPON.BAZOOKA ? OWN_LAUNCH_GAIN : OWN_SHOT_GAIN;
  playSample(WEAPON_SAMPLE[weapon], gain);
}

/** Someone else's weapon firing at (x, y, z). */
export function playRemoteWeapon(
  weapon: WeaponId,
  x: number,
  y: number,
  z: number,
  listenerX: number,
  listenerY: number,
  listenerZ: number,
  listenerYaw: number,
): void {
  const launcher = weapon === WEAPON.BAZOOKA;
  playSampleAt(
    WEAPON_SAMPLE[weapon],
    launcher ? REMOTE_LAUNCH_GAIN : REMOTE_SHOT_GAIN,
    launcher ? LAUNCH_SOUND_DISTANCE : GUNSHOT_SOUND_DISTANCE,
    x,
    y,
    z,
    listenerX,
    listenerY,
    listenerZ,
    listenerYaw,
  );
}

/** A grenade or rocket going off at (x, y, z): the recorded blast plus a low thump under it. */
export function playExplosionAt(
  x: number,
  y: number,
  z: number,
  listenerX: number,
  listenerY: number,
  listenerZ: number,
  listenerYaw: number,
): void {
  const volume = playSampleAt(
    "explosion",
    EXPLOSION_SOUND_GAIN,
    EXPLOSION_SOUND_DISTANCE,
    x,
    y,
    z,
    listenerX,
    listenerY,
    listenerZ,
    listenerYaw,
  );
  const ctx = audioCtx;
  if (volume === 0 || ctx?.state !== "running") return;
  const take = pickTake("explosion");
  if (!take) return;
  const thump = ctx.createBiquadFilter();
  thump.type = "lowpass";
  thump.frequency.value = THUMP_CUTOFF_HZ;
  startSource(ctx, take, THUMP_RATE, volume * EXPLOSION_THUMP_GAIN, [thump]);
}
