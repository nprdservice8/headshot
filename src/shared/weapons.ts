import {
  BODY_DAMAGE,
  FIRE_INTERVAL_TICKS,
  RIFLE_RANGE,
  ROCKET_COOLDOWN_TICKS,
} from "./constants.ts";

/** Stable IDs are sent over the wire; do not reorder them. */
export const WEAPON = { RIFLE: 0, SMG: 1, BAZOOKA: 2 } as const;
export type WeaponId = (typeof WEAPON)[keyof typeof WEAPON];

export type WeaponDefinition = {
  id: WeaponId;
  name: string;
  shortName: string;
  damage: number;
  fireIntervalTicks: number;
  spreadRad: number;
  reloadTicks: number;
  /** Rounds per magazine. The bazooka ignores this: it tracks rockets per life instead. */
  magSize: number;
  range: number;
  projectile: boolean;
};

export const WEAPON_DEFINITIONS: readonly [WeaponDefinition, WeaponDefinition, WeaponDefinition] = [
  {
    id: WEAPON.RIFLE,
    name: "Rifle",
    shortName: "RFL",
    damage: BODY_DAMAGE,
    fireIntervalTicks: FIRE_INTERVAL_TICKS,
    spreadRad: 0.012,
    reloadTicks: 72,
    magSize: 30,
    range: RIFLE_RANGE,
    projectile: false,
  },
  {
    id: WEAPON.SMG,
    name: "SMG",
    shortName: "SMG",
    damage: 16,
    fireIntervalTicks: 4,
    spreadRad: 0.028,
    reloadTicks: 84,
    magSize: 25,
    range: 90,
    projectile: false,
  },
  {
    id: WEAPON.BAZOOKA,
    name: "Bazooka",
    shortName: "RPG",
    damage: 125,
    fireIntervalTicks: ROCKET_COOLDOWN_TICKS,
    spreadRad: 0.004,
    reloadTicks: ROCKET_COOLDOWN_TICKS,
    magSize: 1,
    range: 120,
    projectile: true,
  },
];

export function weaponDefinition(id: number): WeaponDefinition {
  return WEAPON_DEFINITIONS[id] ?? WEAPON_DEFINITIONS[WEAPON.RIFLE];
}

export function isWeaponId(id: number): id is WeaponId {
  return Number.isInteger(id) && id >= WEAPON.RIFLE && id <= WEAPON.BAZOOKA;
}
