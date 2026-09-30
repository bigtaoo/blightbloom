/**
 * One headless arena match driven by `ArenaBotController`, with the per-seat numbers the
 * capacity question needs (design/03 "What the sim can and cannot see"): how often a seat held
 * a gun it could not pay for (`dryTicks`), how low its bar went, what it looted, swapped and
 * parried. Split from `pvpCapacity.sim.ts` so the bookkeeping has its own tests.
 */
import { Button, buildRunSpecs, createGameEngine, FP_SCALE, Prng, PVP_SCALE_FACTOR, scaleWeaponDamage, WEAPON_SIM_BY_ID, type EngineConfig, type GameState, type PlayerActor } from '@dd/engine';
import { buildPvpEngineConfig } from '../../src/game/match/pvpConfig';
import { ArenaBotController, type ArenaBotProfile } from './ArenaBotController';

export const MAX_TICKS = 20_000;
/** Upper bound of the per-seat idle offset at the drop, in ticks (1.5 s). */
export const MAX_START_DELAY = 45;

export interface SeatStats {
  skin: string;
  /** The seat's squad (`teamId`); every seat is its own squad in a match without squads. */
  team: number;
  /** Where the seat stood before the first tick, in grid units: which spawn it drew. */
  startGx: number;
  startGy: number;
  /** Alive at the end, downed or not: in a squad match, the winning squad's members. */
  survived: boolean;
  liveTicks: number;
  /** Ticks holding a ranged weapon the pool could not pay for. */
  dryTicks: number;
  /** Ticks the CARRIED gun was unaffordable, whatever was in hand: a seat that holsters a dry
   *  gun for its blade reads 0 on `dryTicks` and is starved all the same. */
  starvedTicks: number;
  /** Live ticks with the blade in hand, for whatever reason. */
  bladeTicks: number;
  /** The lowest the bar went, as a share of the pool. */
  minEnergyFrac: number;
  pickedGuns: number;
  swaps: number;
  /** Swings that turned at least one bullet: `deflect` events at this seat's body. */
  parries: number;
  /** Trigger pulls on a ranged weapon (`bullet_fired` events, one per pull). */
  shots: number;
}

export interface ArenaMatch {
  seed: number;
  seats: number;
  ticks: number;
  timedOut: boolean;
  /** Skin of the first surviving seat, 'tie' when none. With squads that is whichever member of
   *  the winning squad comes first, so read `winnerTeam` there. */
  winner: string;
  /** The surviving squad's `teamId`, -1 when none. */
  winnerTeam: number;
  bySeat: SeatStats[];
}

/** `pvpBalanceSim`'s deconfounding: shuffle which skin sits on which seat, off a Prng stream no
 *  gameplay system reads, so a spawn-position advantage cannot read as a character one. */
export function shuffledArenaConfig(seed: number, seats: number): EngineConfig {
  const config = buildPvpEngineConfig(seed, seats);
  const skins = config.players!.map((p) => p.skinId);
  new Prng(seed ^ 0x5eed0001).shuffle(skins);
  return { ...config, players: config.players!.map((p, i) => ({ ...p, skinId: skins[i]! })) };
}

/**
 * Put `weaponId` in the seat's gun slot, scaled exactly as `PickupSystem.applyWeapon` scales an
 * arena pickup — what the seat would hold had it looted that frame off the floor.
 */
export function equipArenaGun(p: PlayerActor, weaponId: string): void {
  const base = WEAPON_SIM_BY_ID[weaponId];
  if (base?.kind !== 'ranged') throw new Error(`not a gun: ${weaponId}`);
  const slot = p.weapons.findIndex((w) => w.spec.kind === 'ranged');
  if (slot < 0) throw new Error('seat has no gun slot');
  const w = buildRunSpecs([scaleWeaponDamage(base, PVP_SCALE_FACTOR)])[0]!;
  p.weapons[slot] = w;
  if (p.activeSlot === slot) p.weapon = w;
}

export interface MatchSetup {
  /** Every seat's bar resized to this before the first tick — the A/B that asks whether the
   *  roster's own pools (70 / 100 / 130) move anything. */
  pool?: number;
  /** Every seat starts holding this gun instead of the landing blaster (`equipArenaGun`). */
  gun?: string;
}

export function runArenaMatch(seed: number, seats: number, profile: ArenaBotProfile, setup: MatchSetup = {}): ArenaMatch {
  const config = shuffledArenaConfig(seed, seats);
  const engine = createGameEngine(config);
  const s = engine.state as GameState;
  for (const p of s.players) {
    if (setup.gun !== undefined) equipArenaGun(p, setup.gun);
    if (setup.pool !== undefined) (p.maxEnergy = setup.pool), (p.energy = setup.pool);
  }
  // Per-seat reaction offsets off their own stream (see `ArenaBotController`'s `startDelay`).
  const delays = new Prng(seed ^ 0x0de1a7ed);
  const bots = Array.from({ length: seats }, () => new ArenaBotController(profile, delays.nextInt(MAX_START_DELAY + 1)));
  const bySeat: SeatStats[] = s.players.map((p, i) => ({
    skin: config.players![i]!.skinId ?? 'unknown',
    team: p.teamId,
    startGx: p.gx / FP_SCALE,
    startGy: p.gy / FP_SCALE,
    survived: false,
    liveTicks: 0,
    dryTicks: 0,
    starvedTicks: 0,
    bladeTicks: 0,
    minEnergyFrac: 1,
    pickedGuns: 0,
    swaps: 0,
    parries: 0,
    shots: 0,
  }));

  let ticks = 0;
  while (s.phase !== 'gameover' && ticks < MAX_TICKS) {
    const next = s.tick + 1;
    const cmds = bots.map((b, seat) => b.build(s, seat, next));
    for (const c of cmds) if (c.buttons & Button.SWAP_WEAPON) bySeat[c.owner]!.swaps++;
    engine.step(cmds);
    ticks++;
    for (const e of s.events) {
      if (e.type === 'pickup' && e.kind === 'weapon' && e.weaponId) {
        const seat = s.players.findIndex((p) => p.id === e.by);
        if (seat >= 0) bySeat[seat]!.pickedGuns++;
      } else if (e.type === 'bullet_fired') {
        const seat = s.players.findIndex((p) => p.id === e.ownerId);
        if (seat >= 0) bySeat[seat]!.shots++;
      } else if (e.type === 'deflect') {
        const seat = deflector(s, e.gx, e.gy);
        if (seat >= 0) bySeat[seat]!.parries++;
      }
    }
    s.players.forEach((p, i) => {
      if (!p.alive || p.downed) return;
      const st = bySeat[i]!;
      st.liveTicks++;
      const w = p.weapon?.spec;
      if (w?.kind === 'ranged' && p.energy < w.energyCost) st.dryTicks++;
      if (w?.kind === 'melee') st.bladeTicks++;
      const gun = p.weapons.find((x) => x.spec.kind === 'ranged')?.spec;
      if (gun?.kind === 'ranged' && p.energy < gun.energyCost) st.starvedTicks++;
      if (p.maxEnergy > 0) st.minEnergyFrac = Math.min(st.minEnergyFrac, p.energy / p.maxEnergy);
    });
  }
  s.players.forEach((p, i) => (bySeat[i]!.survived = p.alive));
  const survivor = s.players.findIndex((p) => p.alive);
  return {
    seed,
    seats,
    ticks,
    timedOut: ticks >= MAX_TICKS,
    winner: survivor >= 0 ? bySeat[survivor]!.skin : 'tie',
    winnerTeam: survivor >= 0 ? bySeat[survivor]!.team : -1,
    bySeat,
  };
}

/** The seat whose active blade is mid-swing nearest the deflect point. A `deflect` event
 *  carries only the bullet's position, and only a seat with an open swing can have made it. */
function deflector(s: GameState, gx: number, gy: number): number {
  let best = -1;
  let d = Infinity;
  s.players.forEach((p, i) => {
    const w = p.weapon;
    if (!p.alive || !w || w.spec.kind !== 'melee' || w.swingTicksLeft <= 0) return;
    const dd = (p.gx - gx) ** 2 + (p.gy - gy) ** 2;
    if (dd < d) {
      d = dd;
      best = i;
    }
  });
  return best;
}
