export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

/** Wraps an angle into [-PI, PI]. */
export function wrapAngle(angle: number): number {
  return angle - Math.PI * 2 * Math.floor((angle + Math.PI) / (Math.PI * 2));
}

/** Interpolates along the shorter way around the circle. */
export function lerpAngle(from: number, to: number, t: number): number {
  return from + wrapAngle(to - from) * t;
}

/** Keeps network numbers short: 0.01 m is invisible, and shorter JSON means less bandwidth. */
export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
