/**
 * The boss blueprint drop (design/14, ENGINE_VERSION 63) — `ROADMAP` B5's answer, and the only
 * earn-by-playing path the meta has.
 *
 * **This file is the whole safety net, and that is a deliberate, recorded choice.** No golden
 * scenario kills a boss: `ember-dungeon-floor1`'s scripted stick never clears its spawn room,
 * and the two purpose-built dungeon fixtures both garrison `basic` mobs. So the golden gate is
 * structurally blind to this branch — the same situation v54 was in, resolved the same way it
 * was (unit coverage plus a note in the version entry) rather than by building a fourth
 * fixture, because a 5% roll is a poor thing to pin with one recorded run: a fixture would
 * record "no drop" and stay green with the roll deleted.
 */
import { describe, it, expect } from 'vitest';
import { toFp } from '@dd/engine/math/fixed';
import type { Brad } from '@dd/engine/math/trig';
import { toFpGrid } from '@dd/engine/content/convert';
import { freshStatus } from '@dd/engine/content/damage';
import { BASIC_ENEMY } from '@dd/engine/content/enemies';
import { createGameState } from '@dd/engine/state/GameState';
import type { GameState } from '@dd/engine/state/GameState';
import { ENEMY_TEAM_ID, type EnemyActor } from '@dd/engine/state/entities';
import { DeathDropsSystem } from '@dd/engine/systems';
import { EARNABLE_BLUEPRINTS, STARTER_BLUEPRINTS } from '@dd/engine/content/blueprints';
import { BLUEPRINT_DROP_PERMILLE } from '@dd/engine/config';

const sys = new DeathDropsSystem();

function state(seed: number): GameState {
  return createGameState({ seed, worldW: 1600, worldH: 1600, waves: [] });
}

/** A corpse: `hp <= 0` and still `alive`, which is exactly what `DeathDropsSystem` looks for. */
function addCorpse(s: GameState, boss: boolean): EnemyActor {
  const e: EnemyActor = {
    id: s.nextId(), faction: 'enemy', teamId: ENEMY_TEAM_ID,
    gx: toFpGrid(20), gy: toFpGrid(20), z: toFp(0), vx: toFp(0), vy: toFp(0),
    knockVx: toFp(0), knockVy: toFp(0),
    facing: 0 as Brad, hp: 0, maxHp: BASIC_ENEMY.maxHp,
    shield: 0, maxShield: 0, ticksSinceHit: 0,
    radius: BASIC_ENEMY.radius, footprintRadius: BASIC_ENEMY.footprintRadius,
    solidRadius: BASIC_ENEMY.radius,
    alive: true, weapon: null, firing: false, status: freshStatus(),
    enraged: false, aggroed: false, holding: false,
    ...(boss ? { boss: true } : {}),
  } as EnemyActor;
  s.enemies.push(e);
  return e;
}

/** How many of `trials` distinct seeds dropped a blueprint on one boss kill. Deterministic:
 *  fixed seeds, fixed system, so this is a measurement and not a sample. */
function dropRate(trials: number): number {
  let hits = 0;
  for (let seed = 1; seed <= trials; seed++) {
    const s = state(seed);
    addCorpse(s, true);
    sys.tick(s);
    if (s.runBlueprint !== null) hits++;
  }
  return hits / trials;
}

describe('who rolls', () => {
  it('never rolls for an ordinary enemy, however many die', () => {
    const s = state(3);
    for (let i = 0; i < 50; i++) addCorpse(s, false);
    sys.tick(s);
    expect(s.runBlueprint).toBeNull();
    expect(s.events.filter((e) => e.type === 'blueprint_drop')).toEqual([]);
  });

  it('rolls for a boss', () => {
    // A seed picked BECAUSE it drops — the control for it is the rate measurement below, which
    // is what proves this is not simply "always drops".
    let found: GameState | null = null;
    for (let seed = 1; seed <= 200 && !found; seed++) {
      const s = state(seed);
      addCorpse(s, true);
      sys.tick(s);
      if (s.runBlueprint !== null) found = s;
    }
    expect(found).not.toBeNull();
    expect(found!.events.some((e) => e.type === 'blueprint_drop')).toBe(true);
  });

  it('lands near BLUEPRINT_DROP_PERMILLE over many seeds', () => {
    // The rate is the mechanic. Deleting the threshold test entirely (always drop) or inverting
    // it (never drop) both survive every other case in this file; only this one notices.
    const rate = dropRate(2000);
    const target = BLUEPRINT_DROP_PERMILLE / 1000;
    expect(rate).toBeGreaterThan(target * 0.6);
    expect(rate).toBeLessThan(target * 1.6);
  });
});

describe('what it awards', () => {
  it('always awards something in the EARNABLE pool, never a signup grant', () => {
    // The whole point of the 2026-09-14 pool split: a roll that handed back a blueprint the
    // account was given for free at creation would be a no-op the player watched happen.
    let checked = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const s = state(seed);
      addCorpse(s, true);
      sys.tick(s);
      if (s.runBlueprint === null) continue;
      checked++;
      expect(EARNABLE_BLUEPRINTS).toContain(s.runBlueprint);
      expect(STARTER_BLUEPRINTS).not.toContain(s.runBlueprint);
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('awards at most ONE per run, even for a boss that dies alongside another', () => {
    // `onDeathSpawn` means a boss room can hold a second boss-flagged body; the run's carry-out
    // is one blueprint, not one per corpse.
    let seen = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const s = state(seed);
      addCorpse(s, true);
      addCorpse(s, true);
      addCorpse(s, true);
      sys.tick(s);
      if (s.runBlueprint === null) continue;
      seen++;
      expect(s.events.filter((e) => e.type === 'blueprint_drop')).toHaveLength(1);
    }
    expect(seen).toBeGreaterThan(0);
  });

  it('does not re-roll once a run already holds one', () => {
    const s = state(1);
    s.runBlueprint = 'already_held';
    addCorpse(s, true);
    sys.tick(s);
    expect(s.runBlueprint).toBe('already_held');
    expect(s.events.filter((e) => e.type === 'blueprint_drop')).toEqual([]);
    // That a suppressed roll also costs no DRAW — the part that would silently shift every
    // later loot roll of the run — is the cursor case below, which is the only shape that can
    // assert it: the ordinary death-drop roll draws too, so a before/after on one state cannot
    // tell the two apart.
  });
});

describe('the draw itself', () => {
  it('costs zero draws for a non-boss death', () => {
    const s = state(9);
    addCorpse(s, false);
    const before = s.dropPrng.peek();
    // The ordinary death-drop roll DOES draw, so the comparison has to be against a run where
    // the only difference is the boss flag — hence two states, not one before/after.
    sys.tick(s);
    const nonBoss = s.dropPrng.peek();

    const t = state(9);
    addCorpse(t, true);
    t.runBlueprint = 'held'; // blocks the blueprint roll without changing anything else
    sys.tick(t);
    expect(t.dropPrng.peek()).toBe(nonBoss);
    expect(nonBoss).not.toBe(before);
  });
});
