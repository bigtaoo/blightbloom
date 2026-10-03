/**
 * `ai/parry.ts` — the shipped PvP bot's parry (2026-10-03). Each rule is pinned on both sides,
 * since a bot that never parries looks the same as one that parries nothing it is shown: the
 * case that swings has a twin that must not.
 */
import { describe, expect, it } from 'vitest';
import { Button, FP_SCALE, createGameEngine, createGameState, makeCommand, type Brad, type GameState, type PlayerActor, type Projectile } from '@dd/engine';
import { PvpBotController } from '../PvpBotController';
import { PARRY_LOOKAHEAD, PARRY_SHARE_PERCENT, bulletToParry, parryMove, picked } from './parry';

const CFG = { seed: 3, worldW: 1600, worldH: 1200, waves: [] as const };
const G = FP_SCALE;
const PICKED = Array.from({ length: 100 }, (_, i) => i + 1).find((id) => picked(id, 0))!;
const SKIPPED = Array.from({ length: 100 }, (_, i) => i + 1).find((id) => !picked(id, 0))!;

/** Seat 0 (the bot, blaster in hand) and a rival 6 grid east of it. */
function duel(): GameState {
  const s = createGameState({ ...CFG, players: [{ start: [400, 400], teamId: 0 }, { start: [400, 400], teamId: 1 }] });
  s.players[1]!.gx = (s.players[0]!.gx + 6 * G) as never;
  return s;
}

/** A rival bullet `dx` grid east of seat 0, moving at `vx` grid/tick along x. */
function bullet(s: GameState, dx: number, vx: number, over: Partial<Projectile> = {}): Projectile {
  const me = s.players[0]!;
  const b = { id: PICKED, alive: true, teamId: 1, faction: 'player', gx: me.gx + dx * G, gy: me.gy, vx: vx * G, vy: 0, ...over } as unknown as Projectile;
  s.projectiles.push(b);
  return b;
}

const blade = (p: PlayerActor) => p.weapons.find((w) => w.spec.kind === 'melee')!;
const reachOf = (p: PlayerActor) => {
  const spec = blade(p).spec;
  return spec.kind === 'melee' ? spec : undefined!;
};
const toParry = (s: GameState) => bulletToParry(s, s.players[0]!, 0, reachOf(s.players[0]!).range, reachOf(s.players[0]!).arcHalf);
const drawBlade = (p: PlayerActor) => {
  p.weapon = blade(p);
};

describe('picked', () => {
  it('picks about PARRY_SHARE_PERCENT of bullets, for each seat on its own', () => {
    const N = 10_000;
    const share = (owner: number) => Array.from({ length: N }, (_, i) => picked(i + 1, owner)).filter(Boolean).length / N;
    for (const owner of [0, 1, 7]) expect(Math.abs(share(owner) * 100 - PARRY_SHARE_PERCENT)).toBeLessThan(3);
    // Two seats facing one volley do not pick alike: their picks overlap by chance, not by id.
    let both = 0;
    for (let id = 1; id <= N; id++) if (picked(id, 0) && picked(id, 1)) both++;
    expect(Math.abs(both / N - (PARRY_SHARE_PERCENT / 100) ** 2)).toBeLessThan(0.03);
  });
});

describe('bulletToParry', () => {
  it('a picked bullet coming at the bot within the look-ahead', () => {
    const s = duel();
    const reach = reachOf(s.players[0]!).range / G;
    bullet(s, reach + 0.5 * PARRY_LOOKAHEAD - 0.1, -0.5);
    expect(toParry(s)).toBe(true);
  });

  it('not the same bullet further out than the look-ahead covers', () => {
    const s = duel();
    const reach = reachOf(s.players[0]!).range / G;
    bullet(s, reach + 0.5 * PARRY_LOOKAHEAD + 0.1, -0.5);
    expect(toParry(s)).toBe(false);
  });

  it('a bullet already inside the reach and closing, but not one moving away', () => {
    const s = duel();
    bullet(s, 1, -0.5);
    expect(toParry(s)).toBe(true);
    s.projectiles[0]!.vx = (0.5 * G) as never;
    expect(toParry(s)).toBe(false);
  });

  it('not a bullet it did not pick, a rebound, its own side, or a still one', () => {
    for (const over of [{ id: SKIPPED }, { deflected: true }, { teamId: 0 }, { vx: 0 }] as Partial<Projectile>[]) {
      const s = duel();
      bullet(s, 1, -0.5, over);
      expect(toParry(s), JSON.stringify(over)).toBe(false);
    }
  });

  it('not a bullet from behind: the swing faces the nearest hostile, east', () => {
    const s = duel();
    bullet(s, -1, 0.5);
    expect(toParry(s)).toBe(false);
  });

  it('nothing with no hostile to face', () => {
    const s = duel();
    s.players[1]!.alive = false;
    bullet(s, 1, -0.5);
    expect(toParry(s)).toBe(false);
  });
});

describe('parryMove', () => {
  it('gun in hand and a bullet coming: swap to the blade and swing on the same tick', () => {
    const s = duel();
    bullet(s, 1, -0.5);
    expect(parryMove(s, s.players[0]!, 0)).toEqual({ swap: true, fire: true });
  });

  it('waits a tick when last tick already held the swap: the engine swaps on the press edge', () => {
    const s = duel();
    bullet(s, 1, -0.5);
    s.players[0]!.prevButtons = Button.SWAP_WEAPON;
    expect(parryMove(s, s.players[0]!, 0)).toBeNull();
  });

  it('leaves a blade still recovering in its holster: a holstered cooldown is frozen', () => {
    const s = duel();
    bullet(s, 1, -0.5);
    blade(s.players[0]!).cooldownTicks = 3;
    expect(parryMove(s, s.players[0]!, 0)).toBeNull();
  });

  it('blade out and a bullet coming: swing, no swap', () => {
    const s = duel();
    drawBlade(s.players[0]!);
    bullet(s, 1, -0.5);
    expect(parryMove(s, s.players[0]!, 0)).toEqual({ swap: false, fire: true });
  });

  it('blade out and nothing coming: back to the gun once recovered, not before', () => {
    const s = duel();
    const me = s.players[0]!;
    drawBlade(me);
    expect(parryMove(s, me, 0)).toEqual({ swap: true, fire: false });
    blade(me).cooldownTicks = 5;
    expect(parryMove(s, me, 0)).toEqual({ swap: false, fire: false });
  });

  it('blade out and a rival inside its reach: keeps swinging at the body', () => {
    const s = duel();
    const me = s.players[0]!;
    drawBlade(me);
    s.players[1]!.gx = (me.gx + G) as never;
    expect(parryMove(s, me, 0)).toEqual({ swap: false, fire: true });
  });

  it('leaves a seat with no gun alone, and one with no deflecting blade', () => {
    const s = duel();
    const me = s.players[0]!;
    me.weapons = [blade(me)];
    drawBlade(me);
    expect(parryMove(s, me, 0)).toBeNull();
    const t = duel();
    t.players[0]!.weapons = t.players[0]!.weapons.filter((w) => w.spec.kind !== 'melee');
    bullet(t, 1, -0.5);
    expect(parryMove(t, t.players[0]!, 0)).toBeNull();
  });
});

describe('PvpBotController parries', () => {
  /** Seat 1 stands and fires at the bot, 7.5 grid off, until either falls. */
  function shootAt(bot: PvpBotController) {
    const engine = createGameEngine({ ...CFG, waves: [[[1550, 1150]]], players: [{ start: [400, 400], teamId: 0 }, { start: [640, 400], teamId: 1 }] });
    const s = engine.state;
    const shooter = s.players[1]!;
    let deflects = 0;
    let reboundHits = 0;
    for (let t = 1; t <= 600 && s.phase !== 'gameover'; t++) {
      const rebounds = s.projectiles.filter((b) => b.alive && b.deflected);
      engine.step([bot.build(s, 0, t), makeCommand({ owner: 1, tick: t, moveBrad: 0 as Brad, moveMag: 0, buttons: Button.FIRE })]);
      deflects += s.events.filter((e) => e.type === 'deflect').length;
      // A rebound that landed is gone after the step, on the tick the shooter was hit.
      if (s.events.some((e) => e.type === 'hit' && e.target === shooter.id) && rebounds.some((b) => !b.alive)) reboundHits++;
    }
    return { deflects, reboundHits };
  }

  it("bats a rival seat's bullets back, and a rebound lands on the shooter", () => {
    const on = shootAt(new PvpBotController());
    expect(on.deflects).toBeGreaterThan(0);
    expect(on.reboundHits).toBeGreaterThan(0);
    // Control: the same match without the rule turns nothing back.
    expect(shootAt(new PvpBotController({ parries: false }))).toEqual({ deflects: 0, reboundHits: 0 });
  });

  it('never swaps away from a revive: the hold is the commitment', () => {
    const at = (downed: boolean) => {
      const s = createGameState({ ...CFG, players: [{ start: [400, 400], teamId: 0 }, { start: [400, 420], teamId: 0 }, { start: [400, 400], teamId: 1 }] });
      s.players[2]!.gx = (s.players[0]!.gx + 6 * G) as never;
      s.players[1]!.downed = downed;
      s.players[1]!.reviveProgressTicks = 1; // a channel already running holds under fire (`ai/revive.ts`)
      bullet(s, 1, -0.5);
      return new PvpBotController().build(s, 0, 1).buttons;
    };
    expect(at(true) & (Button.INTERACT | Button.SWAP_WEAPON)).toBe(Button.INTERACT);
    // Control: the same bullet with nobody to revive is parried.
    expect(at(false) & Button.SWAP_WEAPON).toBe(Button.SWAP_WEAPON);
  });
});
