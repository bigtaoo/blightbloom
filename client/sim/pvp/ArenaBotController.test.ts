/**
 * `ArenaBotController` — the sim-only arena bot behind `pvpCapacity.sim.ts`. Each behaviour is
 * pinned on both sides (it acts when it should, and holds when it should not), because the
 * sweep reads "no effect" as a result and a behaviour that silently never fires reads the same.
 */
import { describe, expect, it } from 'vitest';
import { Button, FP_SCALE, createGameEngine, createGameState, makeCommand, type GameState, type PlayerActor, type Projectile } from '@dd/engine';
import { shuffledArenaConfig } from './arenaMatch';
import { PvpBotController } from '../../src/game/controllers/PvpBotController';
import { ARENA_PROFILES, ArenaBotController, LOOT_DETOUR_FP, PARRY_LOOKAHEAD, REARM_SHOTS, bulletIncoming, drySwapDue, lootToSeek } from './ArenaBotController';

const CFG = { seed: 3, worldW: 1600, worldH: 1200, waves: [] as const };
const G = FP_SCALE;

/** Two seats on different teams, `gap` grid apart along x. Seat 0 holds the blaster. */
function duel(gap: number): GameState {
  const s = createGameState({ ...CFG, players: [{ start: [400, 400], teamId: 0 }, { start: [400, 400], teamId: 1 }] });
  s.players[1]!.gx = (s.players[0]!.gx + gap * G) as never;
  return s;
}

/** A bullet from seat 1's team at `dx` grid from seat 0, moving at `vx` grid/tick. */
function bullet(s: GameState, dx: number, vx: number, teamId = 1): Projectile {
  const me = s.players[0]!;
  const b = { id: 99, alive: true, teamId, faction: 'player', gx: me.gx + dx * G, gy: me.gy, vx: vx * G, vy: 0 } as unknown as Projectile;
  s.projectiles.push(b);
  return b;
}

const blade = (p: PlayerActor) => p.weapons.find((w) => w.spec.kind === 'melee')!;
const gunCost = (p: PlayerActor) => {
  const g = p.weapons.find((w) => w.spec.kind === 'ranged')!.spec;
  return g.kind === 'ranged' ? g.energyCost : 0;
};
const swapped = (buttons: number) => (buttons & Button.SWAP_WEAPON) !== 0;

describe('ArenaBotController', () => {
  it('with every flag off, is the shipped bot', () => {
    for (const gap of [2, 6, 20]) {
      const s = duel(gap);
      bullet(s, 1, -0.3);
      expect(new ArenaBotController(ARENA_PROFILES.shipped).build(s, 0, 5)).toEqual(new PvpBotController({ revives: false }).build(s, 0, 5));
    }
  });

  it('stands idle until its start delay has passed', () => {
    const bot = new ArenaBotController(ARENA_PROFILES.shipped, 10);
    expect(bot.build(duel(6), 0, 10)).toMatchObject({ moveMag: 0, buttons: 0 });
    expect(bot.build(duel(6), 0, 11).buttons & Button.FIRE).toBeTruthy();
  });

  it('parries: draws the blade and swings on the same tick a bullet is coming', () => {
    const s = duel(6);
    bullet(s, 2, -0.5);
    const cmd = new ArenaBotController(ARENA_PROFILES.parries).build(s, 0, 5);
    expect(cmd.buttons & (Button.SWAP_WEAPON | Button.FIRE)).toBe(Button.SWAP_WEAPON | Button.FIRE);
    expect(new ArenaBotController(ARENA_PROFILES.shipped).build(s, 0, 5).buttons & Button.SWAP_WEAPON).toBe(0);
  });

  it('does not draw for a bullet moving away, or for a blade still recovering', () => {
    const away = duel(6);
    bullet(away, 0.5, 0.5);
    expect(swapped(new ArenaBotController(ARENA_PROFILES.parries).build(away, 0, 5).buttons)).toBe(false);
    const recovering = duel(6);
    bullet(recovering, 2, -0.5);
    blade(recovering.players[0]!).cooldownTicks = 3;
    expect(swapped(new ArenaBotController(ARENA_PROFILES.parries).build(recovering, 0, 5).buttons)).toBe(false);
  });

  it('keeps a parry blade out through its recovery, then goes back to the gun', () => {
    const s = duel(6);
    const me = s.players[0]!;
    const bot = new ArenaBotController(ARENA_PROFILES.parries);
    const b = bullet(s, 2, -0.5);
    expect(swapped(bot.build(s, 0, 5).buttons)).toBe(true);
    me.activeSlot = me.weapons.indexOf(blade(me));
    me.weapon = blade(me);
    b.alive = false;
    blade(me).cooldownTicks = 4;
    expect(swapped(bot.build(s, 0, 8).buttons)).toBe(false);
    blade(me).cooldownTicks = 0;
    const back = bot.build(s, 0, 9);
    expect(swapped(back.buttons)).toBe(true);
    // A parry blade holds the gun's spacing: it does not walk in on the opponent.
    expect(back.moveMag).toBe(new PvpBotController().build(s, 0, 9).moveMag);
  });

  it('never pulses the swap on consecutive ticks (the engine swaps on a press edge)', () => {
    const s = duel(6);
    bullet(s, 2, -0.5);
    const bot = new ArenaBotController(ARENA_PROFILES.parries);
    expect(swapped(bot.build(s, 0, 5).buttons)).toBe(true);
    expect(swapped(bot.build(s, 0, 6).buttons)).toBe(false);
  });

  it('meleeWhenDry: holsters a gun it cannot pay for, and closes in with the blade', () => {
    const s = duel(6);
    s.players[0]!.energy = gunCost(s.players[0]!) - 1;
    const cmd = new ArenaBotController(ARENA_PROFILES.lootsDry).build(s, 0, 5);
    expect(swapped(cmd.buttons)).toBe(true);
    expect(cmd.moveMag).toBeGreaterThan(0);
    expect(swapped(new ArenaBotController(ARENA_PROFILES.loots).build(s, 0, 5).buttons)).toBe(false);
  });

  it('meleeWhenDry: reacts to what the gun points at, a mob included, not only to an opponent', () => {
    // The opponent 22 grid off, out of range; a mob 3 grid off, or only a mob parked far away.
    const withMob = (mob: [number, number]): GameState => {
      const engine = createGameEngine({ ...CFG, waves: [[mob]], players: [{ start: [400, 400], teamId: 0 }, { start: [1100, 400], teamId: 1 }] });
      engine.step([0, 1].map((owner) => makeCommand({ owner, tick: 1, moveBrad: 0 as never, moveMag: 0, buttons: 0 }))); // the wave spawns
      const s = engine.state;
      s.players[0]!.energy = gunCost(s.players[0]!) - 1;
      return s;
    };
    const bot = () => new ArenaBotController(ARENA_PROFILES.lootsDry);
    expect(swapped(bot().build(withMob([496, 400]), 0, 5).buttons)).toBe(true);
    expect(swapped(bot().build(withMob([1550, 1150]), 0, 5).buttons)).toBe(false);
  });
});

describe('drySwapDue', () => {
  it('re-draws the gun at REARM_SHOTS pulls — a count, not a share of the pool', () => {
    const me = duel(6).players[0]!;
    me.activeSlot = me.weapons.indexOf(blade(me));
    me.weapon = blade(me);
    const cost = gunCost(me);
    for (const pool of [70, 130]) {
      me.maxEnergy = pool;
      me.energy = cost * REARM_SHOTS - 1;
      expect(drySwapDue(me, true), `pool ${pool}`).toBe(false);
      me.energy = cost * REARM_SHOTS;
      expect(drySwapDue(me, true), `pool ${pool}`).toBe(true);
    }
    // A bar too small for REARM_SHOTS pulls re-draws when full.
    me.maxEnergy = cost;
    me.energy = cost;
    expect(drySwapDue(me, true)).toBe(true);
  });

  it('does not holster with nobody in range, or with a pull affordable', () => {
    const me = duel(6).players[0]!;
    me.energy = gunCost(me) - 1;
    expect(drySwapDue(me, false)).toBe(false);
    me.energy = gunCost(me);
    expect(drySwapDue(me, true)).toBe(false);
  });
});

describe('bulletIncoming', () => {
  const reach = 1.5 * G;
  it('sees a bullet that will cross the reach within the lookahead, and no later one', () => {
    const near = duel(6);
    bullet(near, 1.5 + 0.5 * PARRY_LOOKAHEAD - 0.1, -0.5);
    expect(bulletIncoming(near, near.players[0]!, reach)).toBe(true);
    const far = duel(6);
    bullet(far, 1.5 + 0.5 * PARRY_LOOKAHEAD + 1, -0.5);
    expect(bulletIncoming(far, far.players[0]!, reach)).toBe(false);
  });

  it('ignores its own team, a still bullet, and one that has passed', () => {
    for (const [dx, vx, team] of [[1, -0.5, 0], [1, 0, 1], [1, 0.5, 1]] as const) {
      const s = duel(6);
      bullet(s, dx, vx, team);
      expect(bulletIncoming(s, s.players[0]!, reach), `${dx} ${vx} ${team}`).toBe(false);
    }
  });
});

describe('lootToSeek', () => {
  const drop = (s: GameState, dx: number, item: { kind: 'crate' } | { kind: 'weapon'; weaponId: string }) =>
    s.pickups.push({ id: 50 + s.pickups.length, gx: s.players[0]!.gx + dx * G, gy: s.players[0]!.gy, spawnTick: 0, alive: true, ...item } as never);

  it('walks to a crate or a better gun within the detour, nearest first', () => {
    const s = duel(30);
    drop(s, 5, { kind: 'crate' });
    drop(s, 3, { kind: 'weapon', weaponId: 'repeater' });
    expect(lootToSeek(s, s.players[0]!)).toMatchObject({ kind: 'weapon' });
    expect(new ArenaBotController(ARENA_PROFILES.loots).build(s, 0, 5).moveMag).toBeGreaterThan(0);
  });

  it('passes over a worse gun, a blade, and anything beyond the detour', () => {
    const s = duel(30);
    drop(s, 2, { kind: 'weapon', weaponId: 'seeker' });
    drop(s, 2, { kind: 'weapon', weaponId: 'hammer' });
    drop(s, LOOT_DETOUR_FP / G + 1, { kind: 'crate' });
    expect(lootToSeek(s, s.players[0]!)).toBeUndefined();
  });

  it('clicks a better gun inside the reveal radius, even mid-fight', () => {
    const s = duel(6);
    drop(s, 1, { kind: 'weapon', weaponId: 'repeater' });
    const cmd = new ArenaBotController(ARENA_PROFILES.loots).build(s, 0, 5);
    expect(cmd.pickupTargetId).toBe(50);
    expect(cmd.moveBrad).toBe(new PvpBotController().build(s, 0, 5).moveBrad); // the fight still steers
  });
});

describe('the revive flag', () => {
  /** An eight-seat arena at the drop: seat 0 and a squadmate one grid east of it, downed. */
  function squad(): GameState {
    const s = createGameEngine(shuffledArenaConfig(5, 8)).state;
    const me = s.players[0]!;
    const mate = s.players.find((p) => p !== me && p.teamId === me.teamId)!;
    Object.assign(mate, { gx: me.gx + G, gy: me.gy, downed: true, hp: 0, bleedoutTicks: 900 });
    me.bandages = 1;
    return s;
  }
  const interacts = (buttons: number) => (buttons & Button.INTERACT) !== 0;

  it('switches the shipped rule on and off: on, it holds the revive; off, neither bot revives', () => {
    const on = new ArenaBotController(ARENA_PROFILES.fullRevives).build(squad(), 0, 5);
    expect(interacts(on.buttons)).toBe(true);
    expect(on.moveMag).toBe(0);
    for (const p of [ARENA_PROFILES.full, ARENA_PROFILES.shipped]) expect(interacts(new ArenaBotController(p).build(squad(), 0, 5).buttons)).toBe(false);
    expect(new ArenaBotController(ARENA_PROFILES.shippedRevives).build(squad(), 0, 5)).toEqual(new PvpBotController().build(squad(), 0, 5));
  });

  it('keeps a reviver on the body over the loot walk', () => {
    const s = squad();
    const me = s.players[0]!;
    s.pickups.push({ id: 60, kind: 'crate', gx: me.gx, gy: me.gy + 3 * G, spawnTick: 0, alive: true } as never);
    expect(new ArenaBotController(ARENA_PROFILES.full).build(s, 0, 5).moveMag).toBeGreaterThan(0); // walks to the crate
    const cmd = new ArenaBotController(ARENA_PROFILES.fullRevives).build(s, 0, 5);
    expect(interacts(cmd.buttons)).toBe(true);
    expect(cmd.moveMag).toBe(0);
  });
});
