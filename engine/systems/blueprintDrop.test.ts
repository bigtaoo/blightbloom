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
import { DeathDropsSystem, PickupSystem } from '@dd/engine/systems';
import { EARNABLE_BLUEPRINTS, STARTER_BLUEPRINTS } from '@dd/engine/content/blueprints';
import { BLUEPRINT_DROP_PERMILLE, BOSS_WEAPON_DROPS } from '@dd/engine/config';
import { WEAPON_DROP_POOL } from '@dd/engine/content/drops';

const sys = new DeathDropsSystem();

function state(seed: number): GameState {
  return createGameState({ seed, worldW: 1600, worldH: 1600, waves: [] });
}

/** The weaponId a boss's roll produced this tick, or `null` — reads the physical ground
 *  pickup (ENGINE_VERSION 68), replacing the old `state.runBlueprint` flag. */
function rolledSchematic(s: GameState): string | null {
  return s.pickups.find((i) => i.kind === 'schematic')?.weaponId ?? null;
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
    if (rolledSchematic(s) !== null) hits++;
  }
  return hits / trials;
}

describe('who rolls', () => {
  it('never rolls for an ordinary enemy, however many die', () => {
    const s = state(3);
    for (let i = 0; i < 50; i++) addCorpse(s, false);
    sys.tick(s);
    expect(rolledSchematic(s)).toBeNull();
    expect(s.pickups.filter((i) => i.kind === 'schematic')).toEqual([]);
  });

  it('rolls for a boss', () => {
    // A seed picked BECAUSE it drops — the control for it is the rate measurement below, which
    // is what proves this is not simply "always drops". A ground pickup fires no event of its
    // own at drop time (same as `dropBossWeapons`'s weapons two describes down) — the `pickup`
    // event only fires once a player actually collects it (`PickupSystem`, not run here).
    let found: GameState | null = null;
    for (let seed = 1; seed <= 200 && !found; seed++) {
      const s = state(seed);
      addCorpse(s, true);
      sys.tick(s);
      if (rolledSchematic(s) !== null) found = s;
    }
    expect(found).not.toBeNull();
    expect(found!.pickups.some((i) => i.kind === 'schematic')).toBe(true);
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
      const won = rolledSchematic(s);
      if (won === null) continue;
      checked++;
      expect(EARNABLE_BLUEPRINTS).toContain(won);
      expect(STARTER_BLUEPRINTS).not.toContain(won);
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
      if (rolledSchematic(s) === null) continue;
      seen++;
      expect(s.pickups.filter((i) => i.kind === 'schematic')).toHaveLength(1);
    }
    expect(seen).toBeGreaterThan(0);
  });

  it('does not re-roll once a run already rolled (schematicRolled guard)', () => {
    const s = state(1);
    s.schematicRolled = true; // simulates an earlier boss kill already having settled the roll
    addCorpse(s, true);
    sys.tick(s);
    expect(rolledSchematic(s)).toBeNull();
    expect(s.pickups.filter((i) => i.kind === 'schematic')).toEqual([]);
    // That a suppressed roll also costs no DRAW — the part that would silently shift every
    // later loot roll of the run — is the cursor case below, which is the only shape that can
    // assert it: the ordinary death-drop roll draws too, so a before/after on one state cannot
    // tell the two apart.
  });
});

describe('the draw itself', () => {
  it('costs zero draws for a non-boss death, beyond the boss weapon a boss also pays', () => {
    const s = state(9);
    addCorpse(s, false);
    const before = s.dropPrng.peek();
    // The ordinary death-drop roll DOES draw, so the comparison has to be against a run where
    // the only difference is the boss flag — hence two states, not one before/after.
    sys.tick(s);
    const nonBoss = s.dropPrng.peek();

    const t = state(9);
    addCorpse(t, true);
    t.schematicRolled = true; // blocks the blueprint roll without changing anything else
    sys.tick(t);

    // A boss also drops `BOSS_WEAPON_DROPS` guaranteed weapons (2026-09-14), one `nextInt`
    // into the weapon pool each — so "the suppressed blueprint roll is free" is now measured
    // by advancing the non-boss stream by exactly that many draws and demanding the two land
    // on the same value. Stated as the draws themselves rather than as a count, because the
    // count is what a peek() cannot see and the equality is what makes it exact: a blueprint
    // roll that leaked one draw would move this by one and fail.
    for (let i = 0; i < BOSS_WEAPON_DROPS; i++) s.dropPrng.nextInt(WEAPON_DROP_POOL.length);
    expect(t.dropPrng.peek()).toBe(s.dropPrng.peek());
    expect(nonBoss).not.toBe(before);
  });

  it('puts BOSS_WEAPON_DROPS weapons on the ground for a boss and none for anything else', () => {
    // The guarantee that replaced the per-floor allowance. Asserted against the non-boss
    // control on the SAME seed, so a table roll that happened to produce a weapon could not
    // be mistaken for the boss payment — which it cannot today (PvE's table has no weapon
    // entry), and that is exactly the kind of "true for a reason the test does not check"
    // this control is for.
    const boss = state(9);
    addCorpse(boss, true);
    sys.tick(boss);
    expect(boss.pickups.filter((i) => i.kind === 'weapon')).toHaveLength(BOSS_WEAPON_DROPS);

    const mob = state(9);
    addCorpse(mob, false);
    sys.tick(mob);
    expect(mob.pickups.filter((i) => i.kind === 'weapon')).toHaveLength(0);
  });
});

describe('collecting the schematic (design/14, ENGINE_VERSION 68 — per-seat, not squad-wide)', () => {
  const pickupSys = new PickupSystem();

  it('a player who walks over the drop carries it — a teammate standing elsewhere does not', () => {
    let s: GameState | null = null;
    for (let seed = 1; seed <= 200 && !s; seed++) {
      const t = state(seed);
      // A second seat, its own bags — not a shallow spread of seat 0, which would share
      // `floorMaterials`/`bankedMaterials` object references between "two" players.
      t.players.push({ ...t.players[0]!, id: t.nextId(), floorMaterials: {}, bankedMaterials: {}, blueprintPickup: null });
      addCorpse(t, true);
      sys.tick(t);
      if (rolledSchematic(t) !== null) s = t;
    }
    expect(s).not.toBeNull();
    const drop = s!.pickups.find((i) => i.kind === 'schematic')!;
    const [a, b] = s!.players;
    a!.gx = drop.gx;
    a!.gy = drop.gy; // only seat A walks onto it
    b!.gx = toFpGrid(500);
    b!.gy = toFpGrid(500);
    s!.tick += 1; // past the drop's own spawnTick — PickupSystem's same-tick guard (design/08)

    pickupSys.tick(s!);

    expect(a!.blueprintPickup).toBe(drop.weaponId);
    expect(b!.blueprintPickup).toBeNull();
    const ev = s!.events.find((e) => e.type === 'pickup' && e.kind === 'schematic');
    expect(ev).toBeDefined();
    expect((ev as { by: number }).by).toBe(a!.id);
  });
});
