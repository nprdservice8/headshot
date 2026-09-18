// Every tunable number in the game. Units are metres and seconds unless the name says otherwise.

// Networking
export const SERVER_PORT = 3000;
export const TICK_RATE = 60;
export const TICK_SEC = 1 / TICK_RATE;
export const TICK_MS = 1000 / TICK_RATE;
export const SNAPSHOT_INTERVAL_TICKS = 2;
export const INTERP_DELAY_TICKS = 6;
export const MAX_REWIND_TICKS = 15;
export const HISTORY_TICKS = 64;
export const MAX_INPUT_QUEUE = 8;
export const INPUT_REPEAT_TICKS = 4;
export const MAX_PENDING_INPUTS = 128;
export const MAX_SNAPSHOT_BUFFER = 32;
export const CLOCK_RESYNC_TICKS = 30;
export const CLOCK_BLEND = 0.05;
export const RECONCILE_SNAP_DISTANCE = 2;
export const ERROR_BLEND_PER_SEC = 12;
export const MAX_PLAYERS = 8;
export const MAX_MESSAGE_BYTES = 512;
export const MAX_MESSAGES_PER_SEC = 150;
export const NAME_MAX_LENGTH = 16;
export const MAX_SEQ = 2 ** 31 - 1;
export const MAX_TICK = 2 ** 31 - 1;

// Player body
export const PLAYER_RADIUS = 0.35;
export const PLAYER_HEIGHT = 1.8;
export const EYE_HEIGHT = 1.6;

// Movement
export const WALK_SPEED = 6;
export const SPRINT_SPEED = 9;
export const SPRINT_FOV_KICK_DEG = 7;
export const SPRINT_STAMINA_MAX = 3;
export const SPRINT_DRAIN_PER_SEC = 1;
export const SPRINT_REGEN_PER_SEC = 0.5;
export const ADS_FOV_DEG = 62;
export const ADS_TRANSITION_PER_SEC = 13;
export const GROUND_ACCEL = 14;
export const AIR_ACCEL = 2;
export const JUMP_SPEED = 6.5;
export const PLAYER_GRAVITY = 20;
export const MAX_SLOPE_RAD = (45 * Math.PI) / 180;
export const STEP_HEIGHT = 0.35;
export const STEP_MIN_WIDTH = 0.2;
export const SNAP_TO_GROUND = 0.3;
export const CONTROLLER_OFFSET = 0.01;
export const MAX_PITCH = Math.PI / 2 - 0.01;
export const ANGLE_TOLERANCE = 0.01;

// Hitboxes, measured up from the feet
export const HEAD_CENTER_Y = 1.6;
export const HEAD_RADIUS = 0.2;
export const BODY_BOTTOM_Y = 0.35;
export const BODY_TOP_Y = 1.15;
export const BODY_RADIUS = 0.33;
export const BODY_CENTER_Y = 0.9;

// Rifle
export const MAX_HP = 100;
/** Health must be below this amount when hit to begin regeneration. */
export const HEALTH_REGEN_TRIGGER_HP = 50;
export const HEALTH_REGEN_DELAY_TICKS = 5 * TICK_RATE;
/** One health point every fifth of a second after regeneration starts. */
export const HEALTH_REGEN_INTERVAL_TICKS = TICK_RATE / 5;
export const BODY_DAMAGE = 25;
export const FIRE_INTERVAL_TICKS = 8;
export const RIFLE_RANGE = 150;
export const ROCKET_SPEED = 42;
export const ROCKET_RADIUS = 0.14;
export const ROCKET_LIFETIME_TICKS = 3 * TICK_RATE;
export const ROCKET_COOLDOWN_TICKS = 90;
export const ROCKETS_PER_LIFE = 3;
export const MAX_LIVE_ROCKETS = 12;
export const ROCKET_EXPLOSION_RADIUS = 5;
export const ROCKET_EXPLOSION_MAX_DAMAGE = 125;
export const ROCKET_EXPLOSION_KNOCKBACK = 16;

// Grenades and explosions
export const GRENADES_PER_LIFE = 2;
export const MAX_LIVE_GRENADES = 16;
export const GRENADE_FUSE_TICKS = 3 * TICK_RATE;
export const GRENADE_THROW_SPEED = 15;
export const GRENADE_THROW_LIFT = 2;
export const GRENADE_SPAWN_DISTANCE = 0.6;
export const GRENADE_RADIUS = 0.1;
export const GRENADE_RESTITUTION = 0.4;
export const GRENADE_FRICTION = 0.8;
export const GRENADE_LINEAR_DAMPING = 0.3;
export const GRENADE_ANGULAR_DAMPING = 1;
export const EXPLOSION_RADIUS = 6;
export const EXPLOSION_MAX_DAMAGE = 110;
export const EXPLOSION_KNOCKBACK = 12;
export const EXPLOSION_MIN_LIFT = 0.3;
export const WORLD_GRAVITY = 9.81;

// Match
export const RESPAWN_DELAY_TICKS = 3 * TICK_RATE;
export const KILLS_TO_WIN = 15;
export const MATCH_RESTART_TICKS = 10 * TICK_RATE;
export const SPAWN_SAFE_DISTANCE = 8;

// Collision group bits. Hitboxes are not colliders; see shared/combat.ts.
export const GROUP_WORLD = 1;
export const GROUP_PLAYER = 2;
export const GROUP_GRENADE = 4;
export const GROUP_RAGDOLL = 8;
export const GROUP_ALL = 0xffff;

// Lighting. art/map.py bakes the map's lightmap with these, and the live lights on players and
// weapons use the same values, so moving and static things look lit by the same sun and sky.
// Azimuth is measured from +Z towards +X.
export const SUN_AZIMUTH_DEG = 35;
export const SUN_ELEVATION_DEG = 48;
export const SUN_COLOR = 0xfff0d8;
export const SUN_INTENSITY = 3;
export const SKY_ZENITH_COLOR = 0x6d9bd6;
export const SKY_HORIZON_COLOR = 0xd4e2ee;
export const GROUND_COLOR = 0x7a7064;
export const SKY_INTENSITY = 1.3;
/** Baked light is divided by this to fit 8-bit storage and multiplied back when drawn. */
export const LIGHTMAP_RANGE = 4;
/** The same for scenery, whose lit colour is baked into vertex colours. */
export const SCENERY_LIGHT_RANGE = 2;

// Client feel and visuals
export const MOUSE_SENSITIVITY = 0.0022;
export const FIELD_OF_VIEW_DEG = 80;
export const MAX_FRAME_MS = 250;
export const TRACER_LIFETIME_MS = 60;
export const MUZZLE_FLASH_MS = 50;
export const EXPLOSION_EFFECT_MS = 350;
export const RAGDOLL_LIFETIME_MS = 10_000;
export const MAX_RAGDOLLS = 6;
export const RAGDOLL_SHOT_SPEED = 3;
export const RAGDOLL_BLAST_SPEED = 9;
export const WALK_CYCLE_RAD_PER_METRE = 3.2;
export const KILL_FEED_MS = 5000;
export const KILL_FEED_MAX = 5;
