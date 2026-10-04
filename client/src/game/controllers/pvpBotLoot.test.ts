/**
 * The shipped PvP bot loots and draws its blade for a dry gun (2026-10-03, `ai/loot.ts`,
 * `ai/dryBlade.ts`). Each rule is pinned on both sides: the case that acts has a twin, or the
 * same state with the rule switched off, that must not.
 */
import { describe, expect, it } from 'vitest';
import { Button, FP_SCALE, createGameEngine, createGameState, makeCommand, quantizeMove, type Brad, type GameState, type PlayerActor } from '@dd/engine';
import { buildPvpEngineConfig } from '../match/pvpConfig';
import { PvpBotController } from './PvpBotController';
import { REARM_SHOTS, rearmed } from './ai/dryBlade';
import { LOOT_DETOUR_FP } from './ai/loot';

const CFG = { seed: 3, worldW: 1600, worldH: 1200, waves: [] as const };
const G = FP_SCALE;

/** Seat 0 (the bot, blaster in hand) and a rival `gap` grid east of it. */
function duel(gap: number): GameState {
  const s = createGameState({ ...CFG, players: [{ start: [400, 400], teamId: 0 }, { start: [400, 400], teamId: 1 }] });
  s.players[1]!.gx = (s.players[0]!.gx + gap * G) as never;
  return s;
}

/** A floor item `dx`, `dy` grid from seat 0. */
function drop(s: GameState, dx: number, dy: number, item: { kind: 'crate' } | { kind: 'weapon'; weaponId: string }): number {
  const me = s.players[0]!;
  const id = 50 + s.pickups.length;
  s.pickups.push({ id, gx: me.gx + dx * G, gy: me.gy + dy * G, spawnTick: 0, alive: true, ...item } as never);
  return id;
}

const blade = (p: PlayerActor) => p.weapons.find((w) => w.spec.kind === 'melee')!;
const gunCost = (p: PlayerActor) => {
  const g = p.weapons.find((w) => w.spec.kind === 'ranged')!.spec;
  return g.kind === 'ranged' ? g.energyCost : 0;
};
const bladeRange = (p: PlayerActor) => {
  const spec = blade(p).spec;
  return spec.kind === 'melee' ? spec.range / G : 0;
};
const bot = new PvpBotController();
const noLoot = new PvpBotController({ loots: false });
const noDry = new PvpBotController({ bladeWhenDry: false });
const noParry = new PvpBotController({ parries: false });
const toward = (dx: number, dy: number) => quantizeMove(dx * G, dy * G);

describe('the shipped bot loots', () => {
  it('walks to a better gun while nothing is in range; without the rule it chases the rival', () => {
    const s = duel(30);
    drop(s, 0, -5, { kind: 'weapon', weaponId: 'repeater' });
    expect(bot.build(s, 0, 5)).toMatchObject(toward(0, -5));
    expect(noLoot.build(s, 0, 5).moveBrad).not.toBe(toward(0, -5).moveBrad);
  });

  it('walks to an unopened crate too', () => {
    const s = duel(30);
    drop(s, 0, 5, { kind: 'crate' });
    expect(bot.build(s, 0, 5)).toMatchObject(toward(0, 5));
  });

  it('passes over a worse gun, a blade worth more, a taken gun, and a crate beyond the detour', () => {
    const s = duel(30);
    drop(s, 0, -2, { kind: 'weapon', weaponId: 'seeker' });
    drop(s, 0, -2, { kind: 'weapon', weaponId: 'spear' }); // melee, rated above the blaster
    drop(s, 0, -2, { kind: 'weapon', weaponId: 'repeater' });
    s.pickups[s.pickups.length - 1]!.alive = false;
    drop(s, 0, LOOT_DETOUR_FP / G + 1, { kind: 'crate' });
    expect(bot.build(s, 0, 5)).toEqual(noLoot.build(s, 0, 5));
  });

  it('does not detour while what it aims at is in fire range', () => {
    const s = duel(6);
    drop(s, 0, -5, { kind: 'weapon', weaponId: 'repeater' });
    expect(bot.build(s, 0, 5)).toEqual(noLoot.build(s, 0, 5));
  });

  it('clicks a better gun inside the reveal ring, even mid-fight; not a worse one', () => {
    const s = duel(6);
    const id = drop(s, 0, -1, { kind: 'weapon', weaponId: 'repeater' });
    expect(bot.build(s, 0, 5).pickupTargetId).toBe(id);
    expect(noLoot.build(s, 0, 5).pickupTargetId).toBe(0);
    const t = duel(6);
    drop(t, 0, -1, { kind: 'weapon', weaponId: 'seeker' });
    expect(bot.build(t, 0, 5).pickupTargetId).toBe(0);
  });

  it('really picks the gun up in a running match', () => {
    const run = (b: PvpBotController) => {
      const engine = createGameEngine({ ...CFG, waves: [[[1550, 1150]]], players: [{ start: [400, 400], teamId: 0 }, { start: [1500, 1100], teamId: 1 }] });
      const s = engine.state;
      drop(s, 0, -4, { kind: 'weapon', weaponId: 'repeater' });
      for (let t = 1; t <= 120; t++) engine.step([b.build(s, 0, t), makeCommand({ owner: 1, tick: t, moveBrad: 0 as Brad, moveMag: 0, buttons: 0 })]);
      return s.players[0]!.weapons.find((w) => w.spec.kind === 'ranged')!.spec.name;
    };
    expect(run(bot)).toBe('repeater');
    expect(run(noLoot)).toBe('blaster');
  });
});

describe('the shipped bot draws its blade for a dry gun', () => {
  /** Seat 0 with `shots` pulls of energy, a rival `gap` grid east. */
  function dry(gap: number, shots: number, bladeOut = false): GameState {
    const s = duel(gap);
    const me = s.players[0]!;
    me.energy = gunCost(me) * shots;
    if (bladeOut) me.weapon = blade(me);
    return s;
  }

  it('holsters a gun it cannot pay for with a target in range; not one it can, or with none', () => {
    expect(bot.build(dry(6, 0), 0, 5).buttons).toBe(Button.SWAP_WEAPON);
    expect(bot.build(dry(6, 1), 0, 5).buttons & Button.SWAP_WEAPON).toBe(0);
    expect(bot.build(dry(20, 0), 0, 5).buttons & Button.SWAP_WEAPON).toBe(0);
    expect(noDry.build(dry(6, 0), 0, 5).buttons & Button.SWAP_WEAPON).toBe(0);
  });

  it('swaps on the press edge only', () => {
    const s = dry(6, 0);
    s.players[0]!.prevButtons = Button.SWAP_WEAPON;
    expect(bot.build(s, 0, 5).buttons).toBe(0);
  });

  it('closes in with the blade and swings once a body is inside its reach', () => {
    // 3 grid: outside the blade's reach, inside the gun's spacing ring, where the gun bot strafes.
    const far = dry(3, 0, true);
    expect(bot.build(far, 0, 5)).toMatchObject({ ...toward(3, 0), buttons: 0 });
    expect(noDry.build(far, 0, 5).moveBrad).not.toBe(toward(3, 0).moveBrad);
    const near = dry(bladeRange(far.players[0]!) - 0.2, 0, true);
    expect(bot.build(near, 0, 5).buttons).toBe(Button.FIRE);
  });

  it('goes back to the gun at REARM_SHOTS pulls, not one short, and not mid-swing', () => {
    expect(bot.build(dry(6, REARM_SHOTS - 1, true), 0, 5).buttons & Button.SWAP_WEAPON).toBe(0);
    expect(bot.build(dry(6, REARM_SHOTS, true), 0, 5).buttons).toBe(Button.SWAP_WEAPON);
    const s = dry(6, REARM_SHOTS, true);
    blade(s.players[0]!).swingTicksLeft = 2;
    expect(noParry.build(s, 0, 5).buttons & Button.SWAP_WEAPON).toBe(0);
    s.players[0]!.weapon!.swingTicksLeft = 0;
    expect(noParry.build(s, 0, 5).buttons).toBe(Button.SWAP_WEAPON);
  });

  it('a blade drawn to parry stays out while the gun is not rearmed', () => {
    // With nothing coming the parry rule would put a recovered blade back at once (`ai/parry.ts`).
    const low = dry(6, REARM_SHOTS - 1, true);
    expect(rearmed(low.players[0]!)).toBe(false);
    expect(bot.build(low, 0, 5).buttons & Button.SWAP_WEAPON).toBe(0);
    expect(noDry.build(low, 0, 5).buttons & Button.SWAP_WEAPON).toBe(Button.SWAP_WEAPON);
  });

  it('a bar too small for REARM_SHOTS pulls rearms when full', () => {
    const s = dry(6, 0, true);
    const me = s.players[0]!;
    me.maxEnergy = gunCost(me) * REARM_SHOTS - 1;
    me.energy = me.maxEnergy;
    expect(rearmed(me)).toBe(true);
    expect(bot.build(s, 0, 5).buttons).toBe(Button.SWAP_WEAPON);
  });

  it("never overrides a revive walk with its closing in", () => {
    const squad = (downed: boolean) => {
      const s = createGameEngine(buildPvpEngineConfig(5, 8)).state;
      const me = s.players[0]!;
      const mate = s.players.find((p) => p !== me && p.teamId === me.teamId)!;
      Object.assign(mate, { gx: me.gx, gy: me.gy + 6 * G, downed, hp: downed ? 0 : mate.hp, bleedoutTicks: 900 });
      me.bandages = 1;
      me.energy = 0;
      me.weapon = blade(me);
      s.players.filter((p) => p.teamId !== me.teamId).forEach((p) => Object.assign(p, { gx: me.gx + 14 * G, gy: me.gy - G }));
      return s;
    };
    expect(bot.build(squad(true), 0, 5)).toMatchObject({ moveBrad: noDry.build(squad(true), 0, 5).moveBrad });
    // Control: with nobody to revive, the same blade walks another way, at the rivals.
    expect(bot.build(squad(false), 0, 5).moveBrad).not.toBe(bot.build(squad(true), 0, 5).moveBrad);
  });

  it('leaves a seat with no gun alone', () => {
    const s = dry(6, 0, true);
    s.players[0]!.weapons = [blade(s.players[0]!)];
    expect(noParry.build(s, 0, 5)).toEqual(new PvpBotController({ parries: false, bladeWhenDry: false }).build(s, 0, 5));
  });

  it('in a running match: to the blade when dry, a swing, and back to the gun', () => {
    // The rival inside the blade's reach: the pool refills REARM_SHOTS pulls in under a second,
    // so a dry blade only gets to swing at a body already close.
    const engine = createGameEngine({ ...CFG, waves: [[[1550, 1150]]], players: [{ start: [400, 400], teamId: 0 }, { start: [430, 400], teamId: 1 }] });
    const s = engine.state;
    s.players[0]!.energy = 0;
    const held: string[] = [];
    let swings = 0;
    for (let t = 1; t <= 600 && s.phase !== 'gameover'; t++) {
      const cmd = noParry.build(s, 0, t);
      if (s.players[0]!.weapon?.spec.kind === 'melee' && cmd.buttons & Button.FIRE) swings++;
      engine.step([cmd, makeCommand({ owner: 1, tick: t, moveBrad: 0 as Brad, moveMag: 0, buttons: 0 })]);
      const kind = s.players[0]!.weapon?.spec.kind ?? '';
      if (held[held.length - 1] !== kind) held.push(kind);
    }
    expect(held[0]).toBe('melee');
    expect(held.lastIndexOf('ranged')).toBeGreaterThan(held.indexOf('melee'));
    expect(swings).toBeGreaterThan(0);
  });
});
