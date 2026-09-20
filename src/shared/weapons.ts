import { TICK_RATE } from "./constants.ts";

// Every weapon is a row in WEAPON_DEFINITIONS; the server, prediction, HUD and effects all read
// from here. Add a weapon by appending a row (ids are sent over the wire, so never reorder) and
// giving it a first-person model in art/player.py.

/** Stable IDs are sent over the wire; do not reorder them. */
export const WEAPON = { RIFLE: 0, SMG: 1, BAZOOKA: 2 } as const;
export type WeaponId = (typeof WEAPON)[keyof typeof WEAPON];

/** A weapon whose rounds fly: the server simulates them and they explode where they land. */
export type ProjectileDefinition = {
  speed: number;
  /** Damage to the player a round hits square on, before the splash reaches everyone else. */
  directDamage: number;
  /** Splash damage at the centre of the explosion, fading to nothing at `radius`. */
  splashDamage: number;
  radius: number;
  knockback: number;
  /** Rounds that hit nothing explode in the air after this long. */
  lifetimeTicks: number;
  /** Their collision size. */
  bodyRadius: number;
};

export type WeaponDefinition = {
  id: WeaponId;
  name: string;
  shortName: string;
  /** Body-shot damage up to `fullDamageRange`, fading to `minDamageFraction` of it at `range`. */
  damage: number;
  fullDamageRange: number;
  minDamageFraction: number;
  /** Nothing is hit beyond this. */
  range: number;
  fireIntervalTicks: number;
  spreadRad: number;
  reloadTicks: number;
  /** Rounds per magazine. */
  magSize: number;
  /** Spare rounds each life beyond the loaded magazine; `Infinity` for bottomless pockets. */
  reserve: number;
  /** Scales the movement speed while equipped. */
  movementMultiplier: number;
  /** Scales the first-person kick and camera flash when fired. */
  recoil: number;
  /** Aiming raises the weapon to the eye and lines its sights up on the centre of the screen
   * (a `Sight` point exported by art/player.py). Without them, aiming only narrows the view. */
  ironSights: boolean;
  /** Set for weapons that fire simulated rounds instead of instant hitscan shots. */
  projectile: ProjectileDefinition | null;
};

/** Rounds per minute to whole simulation ticks between shots, rounding to the nearest tick. */
function ticksPerShot(roundsPerMinute: number): number {
  return Math.max(1, Math.round((60 / roundsPerMinute) * TICK_RATE));
}

function secondsToTicks(seconds: number): number {
  return Math.round(seconds * TICK_RATE);
}

export const WEAPON_DEFINITIONS: readonly [WeaponDefinition, WeaponDefinition, WeaponDefinition] = [
  // Medium range, versatile: full damage out to 60 m, still worth firing beyond.
  {
    id: WEAPON.RIFLE,
    name: "Assault Rifle",
    shortName: "AR",
    damage: 35,
    fullDamageRange: 60,
    minDamageFraction: 0.6,
    range: 150,
    // 650 RPM lands between 5 and 6 ticks at 60 Hz; 6 ticks is 600 RPM.
    fireIntervalTicks: ticksPerShot(650),
    spreadRad: 0.012,
    reloadTicks: secondsToTicks(2),
    magSize: 30,
    reserve: Number.POSITIVE_INFINITY,
    movementMultiplier: 1,
    recoil: 1,
    ironSights: true,
    projectile: null,
  },
  // Close range, fast: matches the rifle's time to kill inside 25 m (four rounds; at 60 Hz the
  // fire rate can't make up for a fifth), then loses hard past it, and moves quicker.
  {
    id: WEAPON.SMG,
    name: "Submachine Gun",
    shortName: "SMG",
    damage: 25,
    fullDamageRange: 25,
    minDamageFraction: 0.4,
    range: 70,
    // 950 RPM lands nearest 4 ticks at 60 Hz, which is 900 RPM.
    fireIntervalTicks: ticksPerShot(950),
    spreadRad: 0.02,
    reloadTicks: secondsToTicks(1.5),
    magSize: 35,
    reserve: Number.POSITIVE_INFINITY,
    movementMultiplier: 1.15,
    recoil: 0.55,
    ironSights: true,
    projectile: null,
  },
  // Heavy: one slow rocket at a time, three per life, splash that reaches round cover.
  {
    id: WEAPON.BAZOOKA,
    name: "Bazooka",
    shortName: "RPG",
    damage: 0,
    fullDamageRange: 0,
    minDamageFraction: 1,
    range: 0,
    fireIntervalTicks: secondsToTicks(3.5),
    spreadRad: 0,
    reloadTicks: secondsToTicks(3),
    magSize: 1,
    // reserve: 2,
    reserve: Number.POSITIVE_INFINITY,
    movementMultiplier: 0.75,
    recoil: 2.2,
    ironSights: false,
    projectile: {
      speed: 25,
      directDamage: 150,
      splashDamage: 80,
      radius: 5,
      knockback: 16,
      lifetimeTicks: 5 * TICK_RATE,
      bodyRadius: 0.14,
    },
  },
];

export function weaponDefinition(id: number): WeaponDefinition {
  return WEAPON_DEFINITIONS[id] ?? WEAPON_DEFINITIONS[WEAPON.RIFLE];
}

export function isWeaponId(id: number): id is WeaponId {
  return Number.isInteger(id) && id >= 0 && id < WEAPON_DEFINITIONS.length;
}

/** Body-shot damage at `distance`: full inside the effective range, then fading linearly. */
export function damageAtRange(weapon: WeaponDefinition, distance: number): number {
  if (distance <= weapon.fullDamageRange) return weapon.damage;
  const fade = (distance - weapon.fullDamageRange) / (weapon.range - weapon.fullDamageRange);
  const fraction = 1 - Math.min(1, fade) * (1 - weapon.minDamageFraction);
  return Math.round(weapon.damage * fraction);
}
