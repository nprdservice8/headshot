/**
 * Procedural Web Audio gunshot synthesis.
 * Synthesizes punchy local gunshots and distance-attenuated 3D remote gunshots
 * without requiring external sound files or dependencies.
 */

let audioCtx: AudioContext | null = null;
let noiseBuffer: AudioBuffer | null = null;

const MAX_GUNSHOT_DISTANCE = 100;

/** Initialize or resume the AudioContext on user gesture. */
export function initAudio(): void {
  if (!audioCtx) {
    const AudioContextClass =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;
    audioCtx = new AudioContextClass();
    createNoiseBuffer(audioCtx);
  }
  if (audioCtx.state === "suspended") {
    audioCtx.resume().catch(() => undefined);
  }
}

function createNoiseBuffer(ctx: AudioContext): void {
  const bufferSize = ctx.sampleRate * 0.5;
  const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) {
    data[i] = Math.random() * 2 - 1;
  }
  noiseBuffer = buffer;
}

/** Play punchy local gunshot sound effect. */
export function playLocalGunshot(): void {
  if (!audioCtx || audioCtx.state !== "running") {
    initAudio();
  }
  const ctx = audioCtx;
  if (!ctx || ctx.state !== "running") return;

  const now = ctx.currentTime;

  // 1. Noise burst (gunpowder explosion & tail decay)
  if (noiseBuffer) {
    const noiseSource = ctx.createBufferSource();
    noiseSource.buffer = noiseBuffer;

    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.setValueAtTime(950 + (Math.random() - 0.5) * 150, now);
    filter.Q.setValueAtTime(1.2, now);

    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0.7, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);

    noiseSource.connect(filter);
    filter.connect(noiseGain);
    noiseGain.connect(ctx.destination);

    noiseSource.start(now);
    noiseSource.stop(now + 0.2);
  }

  // 2. Sub-bass punch (sine pitch drop for mechanical punch & low-end weight)
  const osc = ctx.createOscillator();
  const oscGain = ctx.createGain();

  const startPitch = 160 + (Math.random() - 0.5) * 20;
  osc.type = "sine";
  osc.frequency.setValueAtTime(startPitch, now);
  osc.frequency.exponentialRampToValueAtTime(30, now + 0.08);

  oscGain.gain.setValueAtTime(0.8, now);
  oscGain.gain.exponentialRampToValueAtTime(0.001, now + 0.1);

  osc.connect(oscGain);
  oscGain.connect(ctx.destination);

  osc.start(now);
  osc.stop(now + 0.11);

  // 3. Transient crack (high frequency triangle click for initial bullet exit snap)
  const clickOsc = ctx.createOscillator();
  const clickGain = ctx.createGain();
  clickOsc.type = "triangle";
  clickOsc.frequency.setValueAtTime(2500, now);
  clickOsc.frequency.exponentialRampToValueAtTime(400, now + 0.015);

  clickGain.gain.setValueAtTime(0.5, now);
  clickGain.gain.exponentialRampToValueAtTime(0.001, now + 0.015);

  clickOsc.connect(clickGain);
  clickGain.connect(ctx.destination);

  clickOsc.start(now);
  clickOsc.stop(now + 0.02);
}

/** Play distance-attenuated remote gunshot sound effect from another player. */
export function playRemoteGunshot(
  shotX: number,
  shotY: number,
  shotZ: number,
  listenerX: number,
  listenerY: number,
  listenerZ: number,
): void {
  const ctx = audioCtx;
  if (!ctx || ctx.state !== "running" || !noiseBuffer) return;

  const dx = shotX - listenerX;
  const dy = shotY - listenerY;
  const dz = shotZ - listenerZ;
  const distance = Math.hypot(dx, dy, dz);

  if (distance > MAX_GUNSHOT_DISTANCE) return;

  const now = ctx.currentTime;
  const volume = Math.max(0, 1 - distance / MAX_GUNSHOT_DISTANCE);
  const attenuatedGain = volume * volume * 0.5;

  if (attenuatedGain < 0.01) return;

  const noiseSource = ctx.createBufferSource();
  noiseSource.buffer = noiseBuffer;

  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  const cutoffFreq = Math.max(400, 3000 - distance * 30);
  filter.frequency.setValueAtTime(cutoffFreq, now);

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(attenuatedGain, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);

  noiseSource.connect(filter);
  filter.connect(gain);
  gain.connect(ctx.destination);

  noiseSource.start(now);
  noiseSource.stop(now + 0.25);
}

const MAX_EXPLOSION_DISTANCE = 150;

/** Play distance-attenuated 3D grenade explosion sound effect. */
export function playExplosionSound(
  expX: number,
  expY: number,
  expZ: number,
  listenerX: number,
  listenerY: number,
  listenerZ: number,
): void {
  const ctx = audioCtx;
  if (!ctx || ctx.state !== "running" || !noiseBuffer) return;

  const dx = expX - listenerX;
  const dy = expY - listenerY;
  const dz = expZ - listenerZ;
  const distance = Math.hypot(dx, dy, dz);

  if (distance > MAX_EXPLOSION_DISTANCE) return;

  const now = ctx.currentTime;
  const volume = Math.max(0, 1 - distance / MAX_EXPLOSION_DISTANCE);
  const attenuatedGain = volume * volume * 1.2;

  if (attenuatedGain < 0.01) return;

  // 1. Deep Sub-bass Rumble (sweeping down 120Hz -> 25Hz over 0.6s)
  const subOsc = ctx.createOscillator();
  const subGain = ctx.createGain();

  subOsc.type = "sine";
  subOsc.frequency.setValueAtTime(120, now);
  subOsc.frequency.exponentialRampToValueAtTime(25, now + 0.6);

  subGain.gain.setValueAtTime(0.9 * attenuatedGain, now);
  subGain.gain.exponentialRampToValueAtTime(0.001, now + 0.65);

  subOsc.connect(subGain);
  subGain.connect(ctx.destination);

  subOsc.start(now);
  subOsc.stop(now + 0.7);

  // 2. Heavy Explosion Noise Burst with Lowpass Filter
  const noiseSource = ctx.createBufferSource();
  noiseSource.buffer = noiseBuffer;

  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  const cutoff = Math.max(250, 2200 - distance * 15);
  filter.frequency.setValueAtTime(cutoff, now);

  const noiseGain = ctx.createGain();
  noiseGain.gain.setValueAtTime(1.0 * attenuatedGain, now);
  noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.5);

  noiseSource.connect(filter);
  filter.connect(noiseGain);
  noiseGain.connect(ctx.destination);

  noiseSource.start(now);
  noiseSource.stop(now + 0.55);

  // 3. Shockwave Blast Snap (triangle pitch drop for initial blast impact)
  const blastOsc = ctx.createOscillator();
  const blastGain = ctx.createGain();

  blastOsc.type = "triangle";
  blastOsc.frequency.setValueAtTime(350, now);
  blastOsc.frequency.exponentialRampToValueAtTime(40, now + 0.08);

  blastGain.gain.setValueAtTime(0.8 * attenuatedGain, now);
  blastGain.gain.exponentialRampToValueAtTime(0.001, now + 0.09);

  blastOsc.connect(blastGain);
  blastGain.connect(ctx.destination);

  blastOsc.start(now);
  blastOsc.stop(now + 0.1);
}
