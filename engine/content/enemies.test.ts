/**
 * buildEnemyActor's movement AI fields (ENGINE_VERSION 37 — see AIDecideSystem's
 * `chase()` and this module's `DEFAULT_ENEMY_MOVE_SPEED_PER_TICK`/
 * `DEFAULT_ENEMY_ENGAGE_RANGE_FP`). Complements bossai.test.ts, which exercises the
 * boss-trait fields (enrage/onDeathSpawn) through the same factory — this file is
 * scoped to the moveSpeedPerTick/engageRangeFp knobs specifically.
 */
import { describe, it, expect } from 'vitest';
import { createGameState } from '@dd/engine/state/GameState';
import type { GameState } from '@dd/engine/state/GameState';
import {
  buildEnemyActor,
  ENEMY_BLUEPRINTS,
  BASIC_ENEMY,
  BLIGHTLORD,
  DEFAULT_ENEMY_MOVE_SPEED_PER_TICK,
  DEFAULT_ENEMY_ENGAGE_RANGE_FP,
  DEFAULT_ENEMY_AGGRO_RANGE_FP,
} from '@dd/engine/content/enemies';
import { toFp } from '@dd/engine/math/fixed';
import { pxToFp } from '@dd/engine/content/convert';
import { PLAYER_BASE } from '@dd/engine/content/players';

const CFG = { seed: 3, worldW: 1600, worldH: 1200, waves: [] as const };
const state = (): GameState => createGameState(CFG);

describe('buildEnemyActor — movement AI fields (ENGINE_VERSION 37)', () => {
  it('a basic mob gets the shared defaults (no blueprint override authored yet)', () => {
    const e = buildEnemyActor(state(), pxToFp(400), pxToFp(400), 'basic');
    expect(e.moveSpeedPerTick).toBe(DEFAULT_ENEMY_MOVE_SPEED_PER_TICK);
    expect(e.engageRangeFp).toBe(DEFAULT_ENEMY_ENGAGE_RANGE_FP);
    // Confirms this actually exercised the `??` fallback branch, not an authored value.
    expect(BASIC_ENEMY.moveSpeedPerTick).toBeUndefined();
    expect(BASIC_ENEMY.engageRangeFp).toBeUndefined();
  });

  it('a blightlord (boss) also gets the shared defaults — no distinct kiting behavior yet', () => {
    const e = buildEnemyActor(state(), pxToFp(400), pxToFp(400), 'blightlord');
    expect(e.moveSpeedPerTick).toBe(DEFAULT_ENEMY_MOVE_SPEED_PER_TICK);
    expect(e.engageRangeFp).toBe(DEFAULT_ENEMY_ENGAGE_RANGE_FP);
    expect(BLIGHTLORD.moveSpeedPerTick).toBeUndefined();
    expect(BLIGHTLORD.engageRangeFp).toBeUndefined();
  });

  it('an unknown type falls back to BASIC_ENEMY, movement fields included', () => {
    const e = buildEnemyActor(state(), pxToFp(400), pxToFp(400), 'nonexistent-type');
    expect(e.moveSpeedPerTick).toBe(DEFAULT_ENEMY_MOVE_SPEED_PER_TICK);
    expect(e.engageRangeFp).toBe(DEFAULT_ENEMY_ENGAGE_RANGE_FP);
  });

  it('a blueprint-level override wins over the shared default (the knob a future rush/sniper variant would use)', () => {
    const TEST_TYPE = '__test_fast_rusher';
    ENEMY_BLUEPRINTS[TEST_TYPE] = {
      ...BASIC_ENEMY,
      type: TEST_TYPE,
      moveSpeedPerTick: toFp(1), // far above the default — should dominate
      engageRangeFp: toFp(0), // melee-style, closes all the way to the target
    };
    try {
      const e = buildEnemyActor(state(), pxToFp(400), pxToFp(400), TEST_TYPE);
      expect(e.moveSpeedPerTick).toBe(toFp(1));
      expect(e.engageRangeFp).toBe(toFp(0));
    } finally {
      delete ENEMY_BLUEPRINTS[TEST_TYPE]; // don't leak a fake registry entry into other test files
    }
  });
});

// Perception radius (ENGINE_VERSION 42) — the third knob in the same family, wired
// through the same `??` fallback. `AIDecideSystem.test.ts` covers what the radius DOES;
// this file covers only that a mob is built carrying it.
describe('buildEnemyActor — perception radius (ENGINE_VERSION 42)', () => {
  it('a fresh mob starts un-aggroed and carries the shared default radius', () => {
    const e = buildEnemyActor(state(), pxToFp(400), pxToFp(400), 'basic');
    expect(e.aggroed).toBe(false); // nothing has noticed the player yet
    expect(e.aggroRangeFp).toBe(DEFAULT_ENEMY_AGGRO_RANGE_FP);
    expect(BASIC_ENEMY.aggroRangeFp).toBeUndefined(); // really took the fallback branch
  });

  it('exactly two blueprints author their own radius — both WIDER than the roster default', () => {
    // Through ENGINE_VERSION 58 this read "no per-mob perception authored yet" and
    // asserted `toBeUndefined()` for every blueprint. `STALKER` (v59) is the first mob to
    // want its own: a rusher woken at the same distance as a shooter spends its whole
    // approach inside the notice delay and arrives as one more body in the crowd.
    // `PYREFANG` (Task 2, v70) is the second, for the same reason applied to a kiting
    // boss rather than a rusher: it has to notice and start repositioning before the
    // player is already standing in range of its next ring.
    //
    // The list is named rather than the assertion loosened to "undefined OR a number":
    // the point of the original test was that the knob stays UNUSED unless someone means
    // it, and a test that accepts any value has stopped saying that. Wider is asserted
    // too — a mob with a SHORTER radius than the roster default would be a typo the type
    // system cannot see.
    const authored = Object.entries(ENEMY_BLUEPRINTS).filter(([, bp]) => bp.aggroRangeFp !== undefined);
    expect(authored.map(([type]) => type).sort()).toEqual(['pyrefang', 'stalker']);
    for (const [type, bp] of authored) {
      expect(bp.aggroRangeFp!, `${type} must notice from further out than the roster default`)
        .toBeGreaterThan(DEFAULT_ENEMY_AGGRO_RANGE_FP as number);
    }
    for (const [type, bp] of Object.entries(ENEMY_BLUEPRINTS)) {
      const built = buildEnemyActor(state(), pxToFp(400), pxToFp(400), type).aggroRangeFp;
      expect(built, `${type} lost its radius in buildEnemyActor`).toBe(bp.aggroRangeFp ?? DEFAULT_ENEMY_AGGRO_RANGE_FP);
    }
  });

  it('a blueprint-level override wins over the shared default', () => {
    const TEST_TYPE = '__test_short_sighted';
    ENEMY_BLUEPRINTS[TEST_TYPE] = { ...BASIC_ENEMY, type: TEST_TYPE, aggroRangeFp: toFp(2) };
    try {
      expect(buildEnemyActor(state(), pxToFp(400), pxToFp(400), TEST_TYPE).aggroRangeFp).toBe(toFp(2));
    } finally {
      delete ENEMY_BLUEPRINTS[TEST_TYPE];
    }
  });

  it("the perception radius is WIDER than the engage range, so v40's reaction window survives", () => {
    // A mob that notices the player must still have ground to cover before it may fire.
    // Invert these two and a mob would wake up already in range — the alpha-strike shape
    // v40/v41 exist to prevent.
    expect(DEFAULT_ENEMY_AGGRO_RANGE_FP).toBeGreaterThan(DEFAULT_ENEMY_ENGAGE_RANGE_FP);
  });

  it('a mob is slower than the player, so backing off always opens the gap', () => {
    expect(DEFAULT_ENEMY_MOVE_SPEED_PER_TICK).toBeLessThan(PLAYER_BASE.speedPerTick);
  });
});

describe('buildEnemyActor — solid clearance (v43, reversed in 48, floored in 50)', () => {
  // v43 gave the PLAYER a wall clearance equal to its body radius; mobs deliberately kept
  // the feet circle through v47, because widening a mob's clearance moves every chase path
  // that hugs a wall — a balance change to garrisons measured against the paths in
  // `client/sim/pveLevelSim.sim.ts`. v48 reversed that opt-out (live report: *"怪物也要遵守
  // 同样的规则"*). v50 finished the sentence: "the same rule" also has to mean a mob can never
  // stand somewhere the PLAYER cannot follow, and for four of the eight blueprints the mob's
  // own body is narrower than the player's, so the rule alone did not deliver that.
  // `npm run test:pve-sim` was re-run at each step and every balance gate still passes.
  it('no blueprint clears a solid by less than the player does', () => {
    // The v50 rule itself, as one sentence over the whole registry. This is the assertion the
    // live report *"怪物不能跑进阻挡区域"* asks for: any band a mob can stand in, the player's
    // own body can enter too.
    for (const type of Object.keys(ENEMY_BLUEPRINTS)) {
      const e = buildEnemyActor(state(), pxToFp(400), pxToFp(400), type);
      expect(
        e.solidRadius as number,
        `${type} clears a solid by ${e.solidRadius} against the player's ${PLAYER_BASE.solidRadius}`,
      ).toBeGreaterThanOrEqual(PLAYER_BASE.solidRadius as number);
    }
  });

  it('a body WIDER than the player still stops at its own silhouette — the floor only ever widens', () => {
    // The half v43/v48 were about, and the reason this is `Math.max` rather than a flat
    // assignment: a brute or a boss sunk into stone by the difference between its body and the
    // player's would be the original report all over again, from the other side.
    const wide = Object.values(ENEMY_BLUEPRINTS).filter(
      (bp) => (bp.radius as number) > (PLAYER_BASE.solidRadius as number),
    );
    expect(wide.length, 'no blueprint is wider than the player — this test proves nothing').toBeGreaterThan(0);
    for (const bp of wide) {
      const e = buildEnemyActor(state(), pxToFp(400), pxToFp(400), bp.type);
      expect(e.solidRadius, `${bp.type} lost its own body clearance`).toBe(e.radius);
    }
  });

  it('the floor actually BINDS — some blueprint really is narrower than the player', () => {
    // The anti-vacuity guard for the rule above. If every mob were already player-sized or
    // bigger, `Math.max` would be dead code and the first test would pass for the wrong reason.
    // Four blueprints are narrower today (critter 13 px; basic/emberling/frostling/venom 15 px
    // against the player's 16), and each of them is a mob that used to be able to tuck into a
    // 31 fp band and die there.
    const narrow = Object.values(ENEMY_BLUEPRINTS).filter(
      (bp) => (bp.radius as number) < (PLAYER_BASE.solidRadius as number),
    );
    expect(narrow.map((bp) => bp.type).sort().length, 'the v50 floor is inert — no mob is narrower than the player').toBeGreaterThan(0);
    for (const bp of narrow) {
      const e = buildEnemyActor(state(), pxToFp(400), pxToFp(400), bp.type);
      expect(e.solidRadius, `${bp.type} was not raised to the floor`).toBe(PLAYER_BASE.solidRadius);
      expect(e.solidRadius as number).toBeGreaterThan(bp.radius as number);
    }
  });

  it('every blueprint keeps the SMALLER feet circle for actor-vs-actor push-out — only the solid clearance moved', () => {
    // The fake-3D depth cue design/07 describes still applies between two BODIES (a mob may
    // crowd another mob it visually overlaps) — v48/v50 only changed the wall/pillar side.
    for (const type of Object.keys(ENEMY_BLUEPRINTS)) {
      const e = buildEnemyActor(state(), pxToFp(400), pxToFp(400), type);
      expect(e.footprintRadius, `${type}'s feet circle grew too`).toBeLessThan(e.radius);
      expect(e.footprintRadius as number, `${type}'s feet circle grew to the solid clearance`).toBeLessThan(
        e.solidRadius as number,
      );
    }
  });
});

/**
 * `element` — the render-only element identity design/13's locked dual-channel law needs
 * (added 2026-08-25 alongside the client's `game/elementIcons.ts`). Same category as `tint`
 * and `bodyRig`: authored on the blueprint, copied to the actor, never read by the sim.
 *
 * The reason these tests exist rather than a one-line "the field is copied" check: this field
 * was DELIBERATELY authored instead of derived, and the sweep below is what records why. A
 * "the resist it shrugs off hardest is its element" rule is one line and free, and it is right
 * for exactly the four variants that carry the field and wrong for two of the ones that do not.
 */
describe('EnemyBlueprint.element — design/13 icon channel', () => {
  /** The strongest resist, i.e. the damage type this mob shrugs off hardest — the thing a
   *  derived rule would have used. */
  function toughestAgainst(bp: { resist?: Partial<Record<string, number>> }): string | undefined {
    const entries = Object.entries(bp.resist ?? {}).filter(([, v]) => v !== undefined) as Array<[string, number]>;
    if (!entries.length) return undefined;
    return entries.reduce((best, e) => (e[1] < best[1] ? e : best))[0];
  }

  it('exactly design/13\'s four locked elemental variants carry an element', () => {
    // Enumerated from the authored registry, so a fifth variant added without an element (or
    // an element added to something that is not a locked variant) fails here rather than
    // shipping a mob whose badge silently disagrees with the doc.
    const badged = Object.values(ENEMY_BLUEPRINTS)
      .filter((bp) => bp.element !== undefined)
      .map((bp) => bp.type)
      .sort();
    expect(badged).toEqual(['emberling', 'frostling', 'galvanist', 'ironclad']);
  });

  it('each badged variant names the element it is, matching design/13\'s own list', () => {
    const want: Record<string, string> = {
      emberling: 'fire',
      frostling: 'ice',
      galvanist: 'lightning',
      ironclad: 'physical',
    };
    for (const [type, element] of Object.entries(want)) {
      expect(ENEMY_BLUEPRINTS[type]!.element, type).toBe(element);
    }
  });

  it('a derived "strongest resist" rule would agree on all four badged variants…', () => {
    for (const bp of Object.values(ENEMY_BLUEPRINTS)) {
      if (!bp.element) continue;
      expect(toughestAgainst(bp), bp.type).toBe(bp.element);
    }
  });

  it('…and would be WRONG on the unbadged ones, which is why the field is authored', () => {
    // This is the test that justifies the design decision instead of just asserting it. `brute`
    // resists physical without being the physical variant, and `blightlord` — the boss whose
    // entire flavour is poison, and which is WEAK to poison — resists physical hardest, so a
    // derived rule would badge the poison boss as the physical mob.
    const brute = ENEMY_BLUEPRINTS['brute']!;
    expect(brute.element).toBeUndefined();
    expect(toughestAgainst(brute)).toBe('physical'); // what a derived rule would have said

    expect(BLIGHTLORD.element).toBeUndefined();
    expect(toughestAgainst(BLIGHTLORD)).toBe('physical');
    expect(BLIGHTLORD.resist!.poison).toBeGreaterThan(1000); // …while actually being poison-WEAK
  });

  it('buildEnemyActor copies it through, and leaves it undefined when unauthored', () => {
    expect(buildEnemyActor(state(), pxToFp(400), pxToFp(400), 'emberling').element).toBe('fire');
    expect(buildEnemyActor(state(), pxToFp(400), pxToFp(400), 'ironclad').element).toBe('physical');
    expect(buildEnemyActor(state(), pxToFp(400), pxToFp(400), 'basic').element).toBeUndefined();
    expect(buildEnemyActor(state(), pxToFp(400), pxToFp(400), 'blightlord').element).toBeUndefined();
  });

  it('every authored element is one of the five the colour law closes over', () => {
    const CLOSED: readonly string[] = ['physical', 'fire', 'ice', 'lightning', 'poison'];
    for (const bp of Object.values(ENEMY_BLUEPRINTS)) {
      if (bp.element) expect(CLOSED, bp.type).toContain(bp.element);
    }
  });
});
