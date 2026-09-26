import { describe, it, expect } from 'vitest';
import {
  SKIN_DEFS,
  DEFAULT_SKIN_ID,
  resolveSkin,
  toShieldBreakSim,
  type SkinDef,
} from '@dd/engine/content/skins';
import { createGameState } from '@dd/engine/state/GameState';
import { BASE_MAX_ENERGY } from '@dd/engine/balance/energy';

const ALL: SkinDef[] = Object.values(SKIN_DEFS);

describe('SKIN_DEFS — characters as balanced defensive identities (design/14)', () => {
  it('the default id resolves to a real skin', () => {
    expect(SKIN_DEFS[DEFAULT_SKIN_ID]).toBeDefined();
  });

  it('every skin has a positive HP pool and a valid id/keys', () => {
    for (const s of ALL) {
      expect(s.maxHp).toBeGreaterThan(0);
      expect(s.maxShield).toBeGreaterThanOrEqual(0);
      // Unlike maxShield, a pool of 0 is not a legal archetype: `spendEnergy` refuses
      // every priced pull forever at 0, so a 0-capacity character could fire nothing but
      // the two free weapons in the game. "No shield" is a playstyle; "no ammo" is a
      // broken character (ENGINE_VERSION 60).
      expect(s.maxEnergy, `${s.id} has an unusable energy pool`).toBeGreaterThan(0);
      expect(s.id).toBeTruthy();
      expect(s.atlasKey).toBeTruthy(); // render ref (sim ignores it)
    }
  });

  /**
   * Every authored number on a character is an INTEGER, at BOTH scales (2026-09-21).
   *
   * This is the gate the roster did not have, and its absence cost exactly what you would
   * expect: `vanguard.maxShield` shipped as `3.2` for two months — the only fractional
   * design number anywhere in `engine/content` — because the PvP pair used to be derived
   * as `Math.round(pool × PVP_SCALE_FACTOR)` and 16/5 is 3.2. The forge prints this pair
   * verbatim, so the remainder was on screen; `serializeState` hashes hp and shield, so it
   * was in the replay hash as a `hp: 5.2` too. Fixed point is how the SIM carries
   * sub-unit quantities (`math/fixed.ts`, positions and velocities) — a design number a
   * player reads is not.
   */
  it('every authored number is an integer, at both scales', () => {
    for (const s of ALL) {
      for (const [label, v] of [
        ['maxHp', s.maxHp], ['maxShield', s.maxShield], ['maxEnergy', s.maxEnergy],
        ['pvp.maxHp', s.pvp.maxHp], ['pvp.maxShield', s.pvp.maxShield],
      ] as const) {
        expect(Number.isInteger(v), `${s.id}.${label} is ${v}, not an integer`).toBe(true);
      }
      if (s.shieldBreak) {
        // The passive's radius is authored in grid and converted once to fp, so a fraction
        // there is legitimate geometry — its DAMAGE is a design number like the pools.
        const dmg = s.shieldBreak.kind === 'aoe' ? s.shieldBreak.damage : 0;
        expect(Number.isInteger(dmg), `${s.id}.shieldBreak.damage is ${dmg}`).toBe(true);
      }
    }
  });

  // The arena pair is a SECOND scale of the same identity, not a second character
  // (design/15): it may be re-tuned on its own, but it must not invert who is tankier —
  // a player who picks the big-shield character in the forge has to get the big-shield
  // character in the arena. Checked as a rank correspondence per axis rather than as a
  // fixed ratio, so either column can move without this becoming a restatement of the
  // multiplication the split removed.
  it('the arena pair keeps the PvE ordering on each axis (one roster, two scales)', () => {
    for (const a of ALL) {
      for (const b of ALL) {
        if (a.id === b.id) continue;
        expect(Math.sign(a.pvp.maxHp - b.pvp.maxHp), `${a.id} vs ${b.id} hp order`)
          .toBe(Math.sign(a.maxHp - b.maxHp));
        expect(Math.sign(a.pvp.maxShield - b.pvp.maxShield), `${a.id} vs ${b.id} shield order`)
          .toBe(Math.sign(a.maxShield - b.maxShield));
      }
    }
  });

  // …and the side-grade rule itself has to survive the trip to the arena. Without this,
  // the PvP column is an unguarded second content set where an all-rounder could appear
  // while every rule above stayed green on the PvE one.
  it('no character Pareto-dominates another at the ARENA scale either', () => {
    for (const a of ALL) {
      for (const b of ALL) {
        if (a.id === b.id) continue;
        const dominates =
          a.pvp.maxHp >= b.pvp.maxHp &&
          a.pvp.maxShield >= b.pvp.maxShield &&
          a.maxEnergy >= b.maxEnergy && // unscaled by design (ENGINE_VERSION 60)
          (a.pvp.maxHp > b.pvp.maxHp || a.pvp.maxShield > b.pvp.maxShield || a.maxEnergy > b.maxEnergy);
        expect(dominates, `${a.id} strictly dominates ${b.id} in the arena`).toBe(false);
      }
    }
  });

  // The reference pool is a DEFINITION, not a tuning choice: every `energyCost` in
  // `content/weaponSpecs/` was authored against the default character's bar, and
  // `balance/energy.ts`'s sustainability classification is stated in those terms. If the
  // default character's capacity drifts off `BASE_MAX_ENERGY`, the whole price table is
  // silently re-based and nothing else in the tree would say so.
  it('the default character IS the reference pool every energyCost is priced against', () => {
    expect(SKIN_DEFS[DEFAULT_SKIN_ID]!.maxEnergy).toBe(BASE_MAX_ENERGY);
  });

  it('ships the 3 launch characters (design/13 launch scope)', () => {
    expect(ALL.length).toBe(3);
  });

  // The locked side-grade rule (design/14): no character is strictly better than
  // another. Encoded as: no skin Pareto-dominates another on (maxHp, maxShield,
  // maxEnergy).
  //
  // `maxEnergy` joined the tuple in ENGINE_VERSION 60, and widening it made the rule
  // STRICTER, not looser — a third axis gives a would-be all-rounder one more column it
  // has to lose on. Note which direction that cuts: it would now be legal to hand a
  // character both the biggest body and the biggest shield as long as it had the smallest
  // pool, which is why the budget band below is checked separately and still counts only
  // the two DEFENSIVE axes. Capacity is not survivability and must not be spendable as if
  // it were.
  it('no character Pareto-dominates another on (maxHp, maxShield, maxEnergy) — no all-rounder', () => {
    for (const a of ALL) {
      for (const b of ALL) {
        if (a.id === b.id) continue;
        const dominates =
          a.maxHp >= b.maxHp &&
          a.maxShield >= b.maxShield &&
          a.maxEnergy >= b.maxEnergy &&
          (a.maxHp > b.maxHp || a.maxShield > b.maxShield || a.maxEnergy > b.maxEnergy);
        expect(dominates, `${a.id} strictly dominates ${b.id}`).toBe(false);
      }
    }
  });

  // The direction of the trade, pinned by NAME rather than by "they differ" (design/14's
  // side-grade rule says the roster spans, but not which way round). Capacity is the
  // SHORT-fight axis and the body is the long-fight one, so they must run opposite: the
  // character that cannot survive an extended trade gets the deepest opening burst, and
  // the one built to stand and trade pays for its body here. A pass that flipped this
  // would still satisfy Pareto and the spread check while making the fragile character
  // strictly worse in both regimes.
  it('the deepest pool belongs to the smallest body, and the shallowest to the biggest', () => {
    const byEnergy = [...ALL].sort((a, b) => a.maxEnergy - b.maxEnergy);
    const shallowest = byEnergy[0]!;
    const deepest = byEnergy[byEnergy.length - 1]!;
    expect(shallowest.maxHp).toBe(Math.max(...ALL.map((s) => s.maxHp)));
    expect(deepest.maxHp).toBe(Math.min(...ALL.map((s) => s.maxHp)));
  });

  // The full 2.3 suite (design/13/14 "playstyle-complete free roster"): the roster must
  // actually SPAN a range on each defensive axis — one balanced, one shield-heavy, one
  // HP-heavy — not three near-identical stat lines that happen to dodge Pareto domination.
  it('spans a real range on each defensive axis (distinct playstyles, not clones)', () => {
    const hps = ALL.map((s) => s.maxHp);
    const shields = ALL.map((s) => s.maxShield);
    expect(new Set(hps).size).toBeGreaterThanOrEqual(3); // every character a distinct body
    expect(new Set(shields).size).toBeGreaterThanOrEqual(3); // and a distinct shield buffer
    expect(Math.max(...hps) - Math.min(...hps)).toBeGreaterThanOrEqual(4); // meaningful HP spread
    expect(Math.max(...shields) - Math.min(...shields)).toBeGreaterThanOrEqual(4); // and shield spread
    // Same rule for the capacity axis (ENGINE_VERSION 60) — three distinct pools, spanning
    // enough that the difference is a real number of extra pulls off a full bar and not a
    // rounding error. 40 is a little over one pull of the most expensive frame in the game.
    const pools = ALL.map((s) => s.maxEnergy);
    expect(new Set(pools).size).toBeGreaterThanOrEqual(3);
    expect(Math.max(...pools) - Math.min(...pools)).toBeGreaterThanOrEqual(40);
  });

  // Side-grades are of EQUAL WORTH (design/14 "never a power ladder"): total defensive
  // budget (hp + shield) must stay within a tight band, so no character is a global upgrade
  // in raw survivability even while trading one axis for the other.
  it('keeps total defensive budget within a tight band (equal worth, no power ladder)', () => {
    const budgets = ALL.map((s) => s.maxHp + s.maxShield);
    expect(Math.max(...budgets) - Math.min(...budgets)).toBeLessThanOrEqual(3);
    // `maxEnergy` is deliberately NOT summed in. It is denominated in energy, not hit
    // points, so adding the two would be an invented exchange rate of exactly the kind
    // design/03 refuses to make up — and at ~100 it would swamp a 9-point body budget
    // and make this band meaningless.
  });

  // …and within that band, no two characters share a budget EXACTLY. Measured, not
  // stylistic: an exact tie makes a near-symmetric fight double-KO far more often, which
  // shows up in `pvpBalanceSim` as simultaneous-elimination ties (confirmed across 3
  // different splits at total=9). This is the constraint vanguard's `3.2` was invented to
  // satisfy; the constraint was real and is kept, the fraction was not needed to meet it.
  it('no two characters share an exact (hp + shield) budget', () => {
    const budgets = ALL.map((s) => s.maxHp + s.maxShield);
    expect(new Set(budgets).size, `budgets collide: ${budgets.join(', ')}`).toBe(ALL.length);
  });

  // Same constraint at the arena scale: the PvP columns are authored, not derived (v67), so
  // nothing about the PvE budgets guarantees theirs are distinct.
  it('no two characters share an exact arena (hp + shield) budget', () => {
    const budgets = ALL.map((s) => s.pvp.maxHp + s.pvp.maxShield);
    expect(new Set(budgets).size, `arena budgets collide: ${budgets.join(', ')}`).toBe(ALL.length);
  });

  // A shield-break passive is only meaningful on a character that HAS a shield to break
  // (design/14): a zero-shield body must not carry an inert passive.
  it('only shielded characters carry a shield-break passive', () => {
    for (const s of ALL) {
      if (s.maxShield === 0) expect(s.shieldBreak, `${s.id} has an inert passive`).toBeUndefined();
    }
  });
});

describe('resolveSkin — forward-compatible selection', () => {
  it('absent or unknown id → the default (design/09)', () => {
    expect(resolveSkin().id).toBe(DEFAULT_SKIN_ID);
    expect(resolveSkin('does_not_exist').id).toBe(DEFAULT_SKIN_ID);
  });

  it('a known id resolves to that character', () => {
    expect(resolveSkin('skirmisher').id).toBe('skirmisher');
  });
});

describe('toShieldBreakSim — human units → fp (convert once)', () => {
  it('converts aoe radius to fp and carries integer damage', () => {
    const sim = toShieldBreakSim({ kind: 'aoe', radiusGrid: 2, damage: 3 });
    expect(sim).toEqual({ kind: 'aoe', radius: 2000, damage: 3 });
  });

  it('converts knock radius + impulse', () => {
    const sim = toShieldBreakSim({ kind: 'knock', radiusGrid: 2, impulseGridPerSec: 10 });
    expect(sim.kind).toBe('knock');
    if (sim.kind === 'knock') {
      expect(sim.radius).toBe(2000);
      expect(sim.impulse).toBeGreaterThan(0);
    }
  });
});

describe('character selection wires into the PlayerActor (design/14)', () => {
  const CFG = { seed: 1, worldW: 800, worldH: 800, waves: [] as const };

  it('the default character spawns with the default skin stats + passive', () => {
    const p = createGameState(CFG).players[0]!;
    const def = resolveSkin();
    expect(p.maxHp).toBe(def.maxHp);
    expect(p.maxShield).toBe(def.maxShield);
    expect(p.shield).toBe(def.maxShield); // spawns with a full shield
    expect(p.shieldBreak).toBeDefined();
  });

  it('selecting a non-default character changes (maxHp, maxShield, maxEnergy) + passive', () => {
    const p = createGameState({ ...CFG, skinId: 'skirmisher' }).players[0]!;
    expect(p.maxHp).toBe(3);
    expect(p.maxShield).toBe(6);
    expect(p.maxEnergy).toBe(130);
    expect(p.energy).toBe(130); // spawns with a full bar, the same rule the shield spawns on
    expect(p.shieldBreak).toEqual({ kind: 'aoe', radius: 3000, damage: 2 });
  });
});
