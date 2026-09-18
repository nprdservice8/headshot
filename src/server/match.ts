import type { RigidBody, World } from "@dimforge/rapier3d-compat";
import RAPIER from "@dimforge/rapier3d-compat";
import {
  createHistory,
  type PositionHistory,
  rayHitsSphere,
  rayHitsUprightCapsule,
  recordHistory,
  sampleHistory,
  type Vec3,
  viewDirection,
} from "../shared/combat.ts";
import {
  BODY_BOTTOM_Y,
  BODY_CENTER_Y,
  BODY_RADIUS,
  BODY_TOP_Y,
  EXPLOSION_MIN_LIFT,
  EXPLOSION_RADIUS,
  EYE_HEIGHT,
  GRENADE_ANGULAR_DAMPING,
  GRENADE_FRICTION,
  GRENADE_FUSE_TICKS,
  GRENADE_LINEAR_DAMPING,
  GRENADE_RADIUS,
  GRENADE_RESTITUTION,
  GRENADE_SPAWN_DISTANCE,
  GRENADE_THROW_LIFT,
  GRENADE_THROW_SPEED,
  GRENADES_PER_LIFE,
  GROUP_GRENADE,
  GROUP_WORLD,
  HEAD_CENTER_Y,
  HEAD_RADIUS,
  HEALTH_REGEN_DELAY_TICKS,
  HEALTH_REGEN_INTERVAL_TICKS,
  HEALTH_REGEN_TRIGGER_HP,
  INPUT_REPEAT_TICKS,
  KILLS_TO_WIN,
  MATCH_RESTART_TICKS,
  MAX_HP,
  MAX_INPUT_QUEUE,
  MAX_LIVE_GRENADES,
  MAX_LIVE_ROCKETS,
  MAX_PLAYERS,
  MAX_REWIND_TICKS,
  RESPAWN_DELAY_TICKS,
  ROCKET_EXPLOSION_KNOCKBACK,
  ROCKET_EXPLOSION_MAX_DAMAGE,
  ROCKET_EXPLOSION_RADIUS,
  ROCKET_LIFETIME_TICKS,
  ROCKET_RADIUS,
  ROCKET_SPEED,
  ROCKETS_PER_LIFE,
  SNAPSHOT_INTERVAL_TICKS,
  SPAWN_SAFE_DISTANCE,
  SPRINT_STAMINA_MAX,
} from "../shared/constants.ts";
import { clamp, round2, round3 } from "../shared/math.ts";
import {
  createMover,
  createMoveState,
  type Mover,
  type MoveState,
  stepMovement,
} from "../shared/movement.ts";
import {
  BUTTON,
  type DeathCause,
  type GrenadeSnapshot,
  type InputMessage,
  MOVEMENT_BUTTONS,
  type PlayerSnapshot,
  type RocketSnapshot,
  type RosterEntry,
  type ServerMessage,
} from "../shared/protocol.ts";
import { WEAPON, WEAPON_DEFINITIONS, type WeaponId, weaponDefinition } from "../shared/weapons.ts";
import {
  castWorldRay,
  collisionGroups,
  createArenaWorld,
  SPAWN_POINTS,
  type SpawnPoint,
} from "../shared/world.ts";

/** How the match talks to the outside world. The server wires this to sockets; tests record it. */
export type Transport = {
  send(playerId: number, message: ServerMessage): void;
  broadcast(message: ServerMessage): void;
};

export type Player = {
  id: number;
  name: string;
  move: MoveState;
  yaw: number;
  pitch: number;
  alive: boolean;
  hp: number;
  grenades: number;
  rockets: number;
  weapon: WeaponId;
  /** Rounds left in each weapon's magazine, indexed by WeaponId. The bazooka slot is unused. */
  ammo: [number, number, number];
  reloading: boolean;
  reloadWeapon: WeaponId;
  reloadEndTick: number;
  ads: boolean;
  sprinting: boolean;
  kills: number;
  deaths: number;
  inputs: InputMessage[];
  lastSeq: number;
  ackSeq: number;
  heldButtons: number;
  previousButtons: number;
  viewTick: number;
  missedInputTicks: number;
  nextFireTick: number;
  regenTick: number;
  regenerating: boolean;
  respawnTick: number;
  spawnTick: number;
  history: PositionHistory;
};

export type Grenade = { id: number; ownerId: number; body: RigidBody; explodeTick: number };
/** Bazooka rockets are straight, server-simulated projectiles with swept collision each tick. */
export type Rocket = {
  id: number;
  ownerId: number;
  x: number;
  y: number;
  z: number;
  dx: number;
  dy: number;
  dz: number;
  expireTick: number;
};

export type Match = {
  tick: number;
  world: World;
  mover: Mover;
  players: Map<number, Player>;
  grenades: Grenade[];
  rockets: Rocket[];
  nextPlayerId: number;
  nextGrenadeId: number;
  state: "playing" | "ended";
  winnerId: number;
  restartTick: number;
  transport: Transport;
  random: () => number;
};

const GRENADE_GROUPS = collisionGroups(GROUP_GRENADE, GROUP_WORLD);

const direction: Vec3 = { x: 0, y: 0, z: 0 };
const rewound: Vec3 = { x: 0, y: 0, z: 0 };
const grenadePosition: Vec3 = { x: 0, y: 0, z: 0 };

/** Call after `RAPIER.init()`. */
export function createMatch(transport: Transport, random: () => number = Math.random): Match {
  const world = createArenaWorld();
  return {
    tick: 0,
    world,
    mover: createMover(world),
    players: new Map(),
    grenades: [],
    rockets: [],
    nextPlayerId: 1,
    nextGrenadeId: 1,
    state: "playing",
    winnerId: -1,
    restartTick: 0,
    transport,
    random,
  };
}

/** Returns null when the match is full. */
export function addPlayer(match: Match, name: string): Player | null {
  if (match.players.size >= MAX_PLAYERS) return null;
  const player: Player = {
    id: match.nextPlayerId++,
    name,
    move: createMoveState(0, 0, 0),
    yaw: 0,
    pitch: 0,
    alive: false,
    hp: 0,
    grenades: 0,
    rockets: 0,
    weapon: WEAPON.RIFLE,
    ammo: [0, 0, 0],
    reloading: false,
    reloadWeapon: WEAPON.RIFLE,
    reloadEndTick: 0,
    ads: false,
    sprinting: false,
    kills: 0,
    deaths: 0,
    inputs: [],
    lastSeq: -1,
    ackSeq: -1,
    heldButtons: 0,
    previousButtons: 0,
    viewTick: match.tick,
    missedInputTicks: 0,
    nextFireTick: 0,
    regenTick: 0,
    regenerating: false,
    respawnTick: 0,
    spawnTick: 0,
    history: createHistory(),
  };
  match.players.set(player.id, player);
  respawn(match, player);
  return player;
}

/** Sends a newly added player everything it needs. Separate so the caller can route messages to it first. */
export function welcomePlayer(match: Match, player: Player): void {
  match.transport.send(player.id, { type: "welcome", id: player.id, tick: match.tick });
  match.transport.send(player.id, { type: "match", state: match.state, winnerId: match.winnerId });
  broadcastRoster(match);
}

export function removePlayer(match: Match, playerId: number): void {
  if (!match.players.delete(playerId)) return;
  broadcastRoster(match);
}

export function queueInput(match: Match, playerId: number, input: InputMessage): void {
  const player = match.players.get(playerId);
  // Old or repeated seqs are ignored so a client cannot replay inputs.
  if (!player || input.seq <= player.lastSeq) return;
  player.lastSeq = input.seq;
  // Dropping the oldest keeps latency low when a client sends faster than the tick rate.
  if (player.inputs.length >= MAX_INPUT_QUEUE) player.inputs.shift();
  player.inputs.push(input);
}

export function tickMatch(match: Match): void {
  match.tick++;
  if (match.state === "ended" && match.tick >= match.restartTick) restartMatch(match);

  for (const player of match.players.values()) updatePlayer(match, player);
  for (const player of match.players.values()) {
    recordHistory(player.history, match.tick, player.move.x, player.move.y, player.move.z);
  }

  match.world.step();
  updateGrenades(match);
  updateRockets(match);

  if (match.tick % SNAPSHOT_INTERVAL_TICKS === 0) sendSnapshots(match);
}

function updatePlayer(match: Match, player: Player): void {
  const input = player.inputs.shift();
  let buttons: number;
  if (input) {
    player.missedInputTicks = 0;
    player.ackSeq = input.seq;
    player.yaw = input.yaw;
    player.pitch = input.pitch;
    player.viewTick = input.viewTick;
    player.heldButtons = input.buttons;
    player.weapon = input.weapon as WeaponId;
    buttons = input.buttons;
  } else {
    // Late inputs: keep walking briefly so network jitter doesn't stop the player, but never shoot.
    player.missedInputTicks++;
    buttons =
      player.missedInputTicks <= INPUT_REPEAT_TICKS ? player.heldButtons & MOVEMENT_BUTTONS : 0;
  }

  player.ads = (buttons & BUTTON.ADS) !== 0;
  const wantsSprint =
    (buttons & BUTTON.SPRINT) !== 0 && !player.ads && (buttons & MOVEMENT_BUTTONS) !== 0;

  if (!player.alive) {
    if (match.state === "playing" && match.tick >= player.respawnTick) respawn(match, player);
  } else {
    stepMovement(match.mover, player.move, buttons, player.yaw, wantsSprint);
    // Stamina can deny a sprint request, so the reported flag follows what actually happened.
    player.sprinting = player.move.sprinting;
    if (player.regenerating && match.tick >= player.regenTick) {
      player.hp = Math.min(MAX_HP, player.hp + 1);
      player.regenerating = player.hp < MAX_HP;
      if (player.regenerating) player.regenTick = match.tick + HEALTH_REGEN_INTERVAL_TICKS;
    }
    if (match.state === "playing") {
      updateReload(match, player, buttons);
      if (buttons & BUTTON.FIRE && match.tick >= player.nextFireTick) {
        const weapon = weaponDefinition(player.weapon);
        if (weapon.id === WEAPON.BAZOOKA) {
          if (player.rockets > 0 && match.rockets.length < MAX_LIVE_ROCKETS) {
            player.nextFireTick = match.tick + weapon.fireIntervalTicks;
            fireBazooka(match, player);
          }
        } else if (!player.reloading && player.ammo[weapon.id] > 0) {
          player.nextFireTick = match.tick + weapon.fireIntervalTicks;
          player.ammo[weapon.id]--;
          fireHitscan(match, player);
        }
      }
      const grenadePressed = buttons & BUTTON.GRENADE && !(player.previousButtons & BUTTON.GRENADE);
      if (grenadePressed && player.grenades > 0 && match.grenades.length < MAX_LIVE_GRENADES) {
        throwGrenade(match, player);
      }
    }
  }
  player.previousButtons = buttons;
}

/** The bazooka reloads via its own fire cooldown; only the hitscan weapons use a magazine. */
function updateReload(match: Match, player: Player, buttons: number): void {
  if (player.weapon === WEAPON.BAZOOKA) return;
  // Switching weapons mid-reload cancels it, same as the ammo it would have refilled.
  if (player.reloading && player.weapon !== player.reloadWeapon) player.reloading = false;

  if (player.reloading) {
    if (match.tick >= player.reloadEndTick) {
      player.ammo[player.weapon] = weaponDefinition(player.weapon).magSize;
      player.reloading = false;
    }
    return;
  }
  const magSize = weaponDefinition(player.weapon).magSize;
  if (player.ammo[player.weapon] >= magSize) return;
  const reloadPressed =
    (buttons & BUTTON.RELOAD) !== 0 && !(player.previousButtons & BUTTON.RELOAD);
  const emptyAndFiring = (buttons & BUTTON.FIRE) !== 0 && player.ammo[player.weapon] === 0;
  if (reloadPressed || emptyAndFiring) {
    player.reloading = true;
    player.reloadWeapon = player.weapon;
    player.reloadEndTick = match.tick + weaponDefinition(player.weapon).reloadTicks;
  }
}

/** Tests the shot against where targets were on the shooter's screen, then against the arena. */
function fireHitscan(match: Match, shooter: Player): void {
  const weapon = weaponDefinition(shooter.weapon);
  const eyeX = shooter.move.x;
  const eyeY = shooter.move.y + EYE_HEIGHT;
  const eyeZ = shooter.move.z;
  const spread = weapon.spreadRad * (shooter.ads ? 0.35 : 1);
  // Stable pseudo-random offsets let every client predict the same visual spread without trusting it.
  const seed = Math.sin((match.tick + shooter.id * 31) * 12.9898) * 43758.5453;
  const offsetYaw = (seed - Math.floor(seed) - 0.5) * spread;
  const offsetPitch = Math.sin(seed * 91.7) * 0.5 * spread;
  viewDirection(shooter.yaw + offsetYaw, shooter.pitch + offsetPitch, direction);
  const newestTick = match.tick - 1;
  const rewindTick = clamp(shooter.viewTick, newestTick - MAX_REWIND_TICKS, newestTick);

  let nearest = weapon.range;
  let target: Player | null = null;
  let head = false;
  for (const other of match.players.values()) {
    if (other === shooter || !other.alive || other.spawnTick > rewindTick) continue;
    sampleHistory(other.history, newestTick, rewindTick, rewound);
    const headDistance = rayHitsSphere(
      eyeX,
      eyeY,
      eyeZ,
      direction.x,
      direction.y,
      direction.z,
      rewound.x,
      rewound.y + HEAD_CENTER_Y,
      rewound.z,
      HEAD_RADIUS,
    );
    const bodyDistance = rayHitsUprightCapsule(
      eyeX,
      eyeY,
      eyeZ,
      direction.x,
      direction.y,
      direction.z,
      rewound.x,
      rewound.z,
      rewound.y + BODY_BOTTOM_Y,
      rewound.y + BODY_TOP_Y,
      BODY_RADIUS,
    );
    const distance = Math.min(headDistance, bodyDistance);
    if (distance < nearest) {
      nearest = distance;
      target = other;
      head = headDistance <= bodyDistance;
    }
  }

  const wallDistance = castWorldRay(
    match.world,
    eyeX,
    eyeY,
    eyeZ,
    direction.x,
    direction.y,
    direction.z,
    nearest,
  );
  const end = Math.min(nearest, wallDistance);
  match.transport.broadcast({
    type: "shot",
    tick: match.tick,
    shooterId: shooter.id,
    fromX: round2(eyeX),
    fromY: round2(eyeY),
    fromZ: round2(eyeZ),
    toX: round2(eyeX + direction.x * end),
    toY: round2(eyeY + direction.y * end),
    toZ: round2(eyeZ + direction.z * end),
  });

  if (target && nearest <= wallDistance) {
    damagePlayer(match, target, head ? MAX_HP : weapon.damage, shooter, head, "rifle", direction);
  }
}

function fireBazooka(match: Match, shooter: Player): void {
  shooter.rockets--;
  viewDirection(shooter.yaw, shooter.pitch, direction);
  const eyeX = shooter.move.x;
  const eyeY = shooter.move.y + EYE_HEIGHT;
  const eyeZ = shooter.move.z;
  const clearance = castWorldRay(
    match.world,
    eyeX,
    eyeY,
    eyeZ,
    direction.x,
    direction.y,
    direction.z,
    0.65,
  );
  const distance = Math.max(0.05, clearance - ROCKET_RADIUS);
  match.rockets.push({
    id: match.nextGrenadeId++,
    ownerId: shooter.id,
    x: eyeX + direction.x * distance,
    y: eyeY + direction.y * distance,
    z: eyeZ + direction.z * distance,
    dx: direction.x,
    dy: direction.y,
    dz: direction.z,
    expireTick: match.tick + ROCKET_LIFETIME_TICKS,
  });
}

function throwGrenade(match: Match, thrower: Player): void {
  thrower.grenades--;
  viewDirection(thrower.yaw, thrower.pitch, direction);
  const eyeX = thrower.move.x;
  const eyeY = thrower.move.y + EYE_HEIGHT;
  const eyeZ = thrower.move.z;
  // Never spawn the grenade inside a wall the thrower is facing.
  const clearance = castWorldRay(
    match.world,
    eyeX,
    eyeY,
    eyeZ,
    direction.x,
    direction.y,
    direction.z,
    GRENADE_SPAWN_DISTANCE,
  );
  const spawnDistance = Math.max(0, clearance - GRENADE_RADIUS * 2);
  const body = match.world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(
        eyeX + direction.x * spawnDistance,
        eyeY + direction.y * spawnDistance,
        eyeZ + direction.z * spawnDistance,
      )
      .setLinvel(
        direction.x * GRENADE_THROW_SPEED + thrower.move.vx,
        direction.y * GRENADE_THROW_SPEED + GRENADE_THROW_LIFT,
        direction.z * GRENADE_THROW_SPEED + thrower.move.vz,
      )
      .setLinearDamping(GRENADE_LINEAR_DAMPING)
      .setAngularDamping(GRENADE_ANGULAR_DAMPING)
      .setCcdEnabled(true),
  );
  match.world.createCollider(
    RAPIER.ColliderDesc.ball(GRENADE_RADIUS)
      .setRestitution(GRENADE_RESTITUTION)
      .setFriction(GRENADE_FRICTION)
      .setCollisionGroups(GRENADE_GROUPS),
    body,
  );
  match.grenades.push({
    id: match.nextGrenadeId++,
    ownerId: thrower.id,
    body,
    explodeTick: match.tick + GRENADE_FUSE_TICKS,
  });
}

function updateGrenades(match: Match): void {
  for (let i = match.grenades.length - 1; i >= 0; i--) {
    const grenade = match.grenades[i];
    if (!grenade || match.tick < grenade.explodeTick) continue;
    // Swap-remove: order doesn't matter and this avoids shifting the array.
    const last = match.grenades.pop();
    if (last && last !== grenade) match.grenades[i] = last;
    explode(match, grenade);
  }
}

function updateRockets(match: Match): void {
  const distance = ROCKET_SPEED / 60;
  for (let i = match.rockets.length - 1; i >= 0; i--) {
    const rocket = match.rockets[i];
    if (!rocket) continue;
    let hit = match.tick >= rocket.expireTick;
    if (!hit) {
      const wall = castWorldRay(
        match.world,
        rocket.x,
        rocket.y,
        rocket.z,
        rocket.dx,
        rocket.dy,
        rocket.dz,
        distance + ROCKET_RADIUS,
      );
      if (wall < distance + ROCKET_RADIUS) hit = true;
      for (const player of match.players.values()) {
        if (!player.alive) continue;
        const body = rayHitsUprightCapsule(
          rocket.x,
          rocket.y,
          rocket.z,
          rocket.dx,
          rocket.dy,
          rocket.dz,
          player.move.x,
          player.move.z,
          player.move.y + BODY_BOTTOM_Y,
          player.move.y + BODY_TOP_Y,
          BODY_RADIUS + ROCKET_RADIUS,
        );
        if (body <= distance) {
          hit = true;
          break;
        }
      }
    }
    if (hit) {
      const last = match.rockets.pop();
      if (last && last !== rocket) match.rockets[i] = last;
      explodeAt(
        match,
        rocket.ownerId,
        rocket.x,
        rocket.y,
        rocket.z,
        ROCKET_EXPLOSION_RADIUS,
        ROCKET_EXPLOSION_MAX_DAMAGE,
        ROCKET_EXPLOSION_KNOCKBACK,
        "bazooka",
      );
    } else {
      rocket.x += rocket.dx * distance;
      rocket.y += rocket.dy * distance;
      rocket.z += rocket.dz * distance;
    }
  }
}

function explode(match: Match, grenade: Grenade): void {
  grenade.body.translation(grenadePosition);
  match.world.removeRigidBody(grenade.body);
  explodeAt(
    match,
    grenade.ownerId,
    grenadePosition.x,
    grenadePosition.y,
    grenadePosition.z,
    EXPLOSION_RADIUS,
    110,
    12,
    "grenade",
  );
}

function explodeAt(
  match: Match,
  ownerId: number,
  x: number,
  y: number,
  z: number,
  radius: number,
  maxDamage: number,
  maxKnockback: number,
  cause: "grenade" | "bazooka",
): void {
  match.transport.broadcast({
    type: "explosion",
    tick: match.tick,
    x: round2(x),
    y: round2(y),
    z: round2(z),
  });

  const owner = match.players.get(ownerId);
  for (const player of match.players.values()) {
    if (!player.alive) continue;
    const dx = player.move.x - x;
    const dy = player.move.y + BODY_CENTER_Y - y;
    const dz = player.move.z - z;
    const distance = Math.hypot(dx, dy, dz);
    if (distance >= radius) continue;
    if (distance > 0.01) {
      direction.x = dx / distance;
      direction.y = dy / distance;
      direction.z = dz / distance;
      const blocked = castWorldRay(
        match.world,
        x,
        y,
        z,
        direction.x,
        direction.y,
        direction.z,
        distance,
      );
      if (blocked < distance - 0.05) continue;
    } else {
      direction.x = 0;
      direction.y = 1;
      direction.z = 0;
    }
    const falloff = 1 - distance / radius;
    const push = maxKnockback * falloff;
    player.move.vx += direction.x * push;
    player.move.vy += Math.max(direction.y, EXPLOSION_MIN_LIFT) * push;
    player.move.vz += direction.z * push;
    player.move.grounded = false;
    damagePlayer(match, player, Math.round(maxDamage * falloff), owner, false, cause, direction);
  }
}

function damagePlayer(
  match: Match,
  target: Player,
  amount: number,
  attacker: Player | undefined,
  head: boolean,
  cause: DeathCause,
  hitDirection: Vec3,
): void {
  if (!target.alive || amount <= 0) return;
  target.hp = Math.max(0, target.hp - amount);
  target.regenTick = match.tick + HEALTH_REGEN_DELAY_TICKS;
  target.regenerating = target.hp > 0 && target.hp < HEALTH_REGEN_TRIGGER_HP;
  if (attacker && attacker !== target) {
    match.transport.send(attacker.id, { type: "hit", targetId: target.id, head, damage: amount });
  }
  if (target.hp > 0) return;

  target.alive = false;
  target.deaths++;
  target.respawnTick = match.tick + RESPAWN_DELAY_TICKS;
  if (attacker && attacker !== target) attacker.kills++;
  match.transport.broadcast({
    type: "death",
    tick: match.tick,
    victimId: target.id,
    killerId: attacker?.id ?? -1,
    head,
    cause,
    dirX: round3(hitDirection.x),
    dirY: round3(hitDirection.y),
    dirZ: round3(hitDirection.z),
  });
  broadcastRoster(match);
  if (attacker && attacker.kills >= KILLS_TO_WIN) endMatch(match, attacker);
}

function respawn(match: Match, player: Player): void {
  const spawn = chooseSpawn(SPAWN_POINTS, match.players, player, match.random);
  player.move.x = spawn.x;
  player.move.y = spawn.y;
  player.move.z = spawn.z;
  player.move.vx = 0;
  player.move.vy = 0;
  player.move.vz = 0;
  player.move.grounded = false;
  player.move.stamina = SPRINT_STAMINA_MAX;
  player.yaw = spawn.yaw;
  player.pitch = 0;
  player.alive = true;
  player.hp = MAX_HP;
  player.grenades = GRENADES_PER_LIFE;
  player.rockets = ROCKETS_PER_LIFE;
  player.weapon = WEAPON.RIFLE;
  player.ammo = [
    WEAPON_DEFINITIONS[WEAPON.RIFLE].magSize,
    WEAPON_DEFINITIONS[WEAPON.SMG].magSize,
    WEAPON_DEFINITIONS[WEAPON.BAZOOKA].magSize,
  ];
  player.reloading = false;
  player.ads = false;
  player.sprinting = false;
  player.spawnTick = match.tick;
  player.nextFireTick = match.tick;
  player.regenTick = match.tick;
  player.regenerating = false;
}

/** A random spawn point with no living enemy nearby, or any spawn point if none is safe. */
export function chooseSpawn(
  points: readonly SpawnPoint[],
  players: ReadonlyMap<number, Player>,
  spawning: Player,
  random: () => number,
): SpawnPoint {
  const safe = points.filter((point) => {
    for (const other of players.values()) {
      if (other === spawning || !other.alive) continue;
      if (Math.hypot(other.move.x - point.x, other.move.z - point.z) < SPAWN_SAFE_DISTANCE) {
        return false;
      }
    }
    return true;
  });
  const choices = safe.length > 0 ? safe : points;
  const choice = choices[Math.floor(random() * choices.length)] ?? points[0];
  if (!choice) throw new Error("The arena has no spawn points");
  return choice;
}

function endMatch(match: Match, winner: Player): void {
  match.state = "ended";
  match.winnerId = winner.id;
  match.restartTick = match.tick + MATCH_RESTART_TICKS;
  for (const grenade of match.grenades) match.world.removeRigidBody(grenade.body);
  match.grenades.length = 0;
  match.rockets.length = 0;
  match.transport.broadcast({ type: "match", state: match.state, winnerId: winner.id });
}

function restartMatch(match: Match): void {
  match.state = "playing";
  match.winnerId = -1;
  for (const player of match.players.values()) {
    player.kills = 0;
    player.deaths = 0;
    respawn(match, player);
  }
  match.transport.broadcast({ type: "match", state: match.state, winnerId: -1 });
  broadcastRoster(match);
}

function broadcastRoster(match: Match): void {
  const players: RosterEntry[] = [];
  for (const p of match.players.values()) {
    players.push({ id: p.id, name: p.name, kills: p.kills, deaths: p.deaths });
  }
  players.sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
  match.transport.broadcast({ type: "roster", players });
}

// Snapshots allocate while they are JSON. The binary format planned before going public removes that.
function sendSnapshots(match: Match): void {
  const players: PlayerSnapshot[] = [];
  for (const p of match.players.values()) {
    players.push({
      id: p.id,
      x: round2(p.move.x),
      y: round2(p.move.y),
      z: round2(p.move.z),
      yaw: round3(p.yaw),
      pitch: round3(p.pitch),
      weapon: p.weapon,
      ads: p.ads,
      sprinting: p.sprinting,
      alive: p.alive,
    });
  }
  const grenades: GrenadeSnapshot[] = [];
  for (const g of match.grenades) {
    g.body.translation(grenadePosition);
    grenades.push({
      id: g.id,
      x: round2(grenadePosition.x),
      y: round2(grenadePosition.y),
      z: round2(grenadePosition.z),
    });
  }
  const rockets: RocketSnapshot[] = match.rockets.map((rocket) => ({
    id: rocket.id,
    x: round2(rocket.x),
    y: round2(rocket.y),
    z: round2(rocket.z),
  }));
  for (const p of match.players.values()) {
    // The receiver's own state is sent at full precision: its client replays inputs from it.
    match.transport.send(p.id, {
      type: "snapshot",
      tick: match.tick,
      ack: p.ackSeq,
      you: {
        x: p.move.x,
        y: p.move.y,
        z: p.move.z,
        vx: p.move.vx,
        vy: p.move.vy,
        vz: p.move.vz,
        grounded: p.move.grounded,
        stamina: round2(p.move.stamina),
        alive: p.alive,
        hp: p.hp,
        grenades: p.grenades,
        rockets: p.rockets,
        ammo: p.ammo[p.weapon],
        reloading: p.reloading,
        weapon: p.weapon,
        ads: p.ads,
        sprinting: p.sprinting,
      },
      players,
      grenades,
      rockets,
    });
  }
}
