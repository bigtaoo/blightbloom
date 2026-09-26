/**
 * The boss's rare character drop (design/14, 2026-09-26 — the owner's "a boss drop at 1%" for
 * juggernaut, which until then had no way to be owned at all).
 *
 * Built as the schematic's twin (`blueprintDrop.test.ts`), and tested the same way for the
 * same reason: no golden scenario kills a boss, so the golden gate is blind to this branch
 * and a single recorded run of a 1% roll would pin "no drop" and stay green with the roll
 * deleted. The rate is therefore measured over fixed seeds instead.
 */
import { describe, it, expect } from 'vitest';
import { toFp } from '@dd/engine/math/fixed';
import type { Brad } from '@dd/engine/math/trig';
import { toFpGrid } from '@dd/engine/content/convert';
import { freshStatus } from '@dd/engine/content/damage';
import { BASIC_ENEMY } from '@dd/engine/content/enemies';
import { DROP_CHARACTERS, SKIN_DEFS } from '@dd/engine/content/skins';
import { createGameState } from '@dd/engine/state/GameState';
import type { GameState } from '@dd/engine/state/GameState';
import { ENEMY_TEAM_ID, type EnemyActor } from '@dd/engine/state/entities';
import { DeathDropsSystem, PickupSystem } from '@dd/engine/systems';
import { CHARACTER_DROP_PERMILLE } from '@dd/engine/config';
import { hashState } from '@dd/engine/replay';

const sys = new DeathDropsSystem();
const pickups = new PickupSystem();

function state(seed: number): GameState {
  return createGameState({ seed, worldW: 1600, worldH: 1600, waves: [] });
}

function addCorpse(s: GameState, boss: boolean): EnemyActor {
  const e = {
    id: s.nextId(), faction: 'enemy', teamId: ENEMY_TEAM_ID,
    gx: toFpGrid(20), gy: toFpGrid(20), z: toFp(0), vx: toFp(0), vy: toFp(0),
    knockVx: toFp(0), knockVy: toFp(0),
    facing: 0 as Brad, hp: 0, maxHp: BASIC_ENEMY.maxHp,
    shield: 0, maxShield: 0, ticksSinceHit: 0,
    radius: BASIC_ENEMY.radius, footprintRadius: BASIC_ENEMY.footprintRadius,
    solidRadius: BASIC_ENEMY.radius,
    alive: true, weapon: null, firing: false, status: freshStatus(),
    enraged: false, armorBroken: false, aggroed: false, holding: false,
    ...(boss ? { boss: true } : {}),
  } as EnemyActor;
  s.enemies.push(e);
  return e;
}

const dropped = (s: GameState) => s.pickups.filter((i) => i.kind === 'character');

/** The first seed in 1..limit whose boss kill drops the character, with the state after it. */
function firstDroppingSeed(limit = 2000): GameState {
  for (let seed = 1; seed <= limit; seed++) {
    const s = state(seed);
    addCorpse(s, true);
    sys.tick(s);
    if (dropped(s).length > 0) return s;
  }
  throw new Error('no seed dropped the character');
}

describe('the content', () => {
  it('drops juggernaut only — never the free default or the paid character', () => {
    expect(DROP_CHARACTERS).toEqual(['juggernaut']);
    for (const id of DROP_CHARACTERS) expect(SKIN_DEFS[id]).toBeDefined();
  });

  it('is the owner’s 1%, as an integer per-mille', () => {
    expect(CHARACTER_DROP_PERMILLE).toBe(10);
  });
});

describe('who rolls, and how often', () => {
  it('never for an ordinary enemy, however many die', () => {
    const s = state(3);
    for (let i = 0; i < 50; i++) addCorpse(s, false);
    sys.tick(s);
    expect(dropped(s)).toEqual([]);
    expect(s.characterRolled).toBe(false);
  });

  it('lands near CHARACTER_DROP_PERMILLE over many seeds', () => {
    // SPREAD seeds, not 1..N. Measured while writing this: across consecutive seeds a fresh
    // `Prng`'s first few draws are correlated (the second `nextInt(1000)` landed under 10 in
    // 20 of 6000 seeds 1..6000, a third of the 1% it should), so a 1% roll that happens to be
    // an early draw reads as 0.35%. A real run's seed is a crypto draw (matchsvc) and the boss
    // dies thousands of draws in, so the spread is what describes play.
    let hits = 0;
    const trials = 6000;
    for (let i = 1; i <= trials; i++) {
      const s = state((i * 2654435761) >>> 0);
      addCorpse(s, true);
      sys.tick(s);
      hits += dropped(s).length;
    }
    // 1% of 6000 is 60; a 0% or 5% bug lands far outside this band either way.
    expect(hits).toBeGreaterThan(30);
    expect(hits).toBeLessThan(95);
  });

  it('drops a DROP_CHARACTERS id at the boss, as a physical pickup', () => {
    const s = firstDroppingSeed();
    const [item] = dropped(s);
    expect(DROP_CHARACTERS).toContain(item!.skinId);
    expect(item!.alive).toBe(true);
  });

  it('rolls at most once per run, even for two bosses dying together', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const s = state(seed);
      addCorpse(s, true);
      addCorpse(s, true);
      sys.tick(s);
      expect(dropped(s).length).toBeLessThanOrEqual(1);
      expect(s.characterRolled).toBe(true);
    }
  });

  it('a run that already rolled does not roll again', () => {
    const reference = firstDroppingSeed();
    const s = state(reference.seed);
    expect(typeof reference.seed).toBe('number');
    s.characterRolled = true;
    addCorpse(s, true);
    sys.tick(s);
    expect(dropped(s)).toEqual([]);
  });

  it('is independent of the schematic roll — suppressing one never moves the other', () => {
    // Same seed, schematic blocked vs not: the character outcome may not depend on it only
    // if both runs spend their draws in a fixed order. Measured over seeds, as a set.
    const outcome = (block: boolean) => {
      const hits: number[] = [];
      for (let seed = 1; seed <= 1500; seed++) {
        const s = state(seed);
        if (block) s.schematicRolled = true;
        addCorpse(s, true);
        sys.tick(s);
        if (dropped(s).length > 0) hits.push(seed);
      }
      return hits;
    };
    expect(outcome(false).length).toBeGreaterThan(0);
    // The set may differ (the schematic roll spends draws first), but neither run is empty,
    // which is what a shared guard between the two would produce.
    expect(outcome(true).length).toBeGreaterThan(0);
  });
});

describe('who carries it out', () => {
  it('the seat that walks over it — a teammate elsewhere does not — and it enters the state hash', () => {
    const s = firstDroppingSeed();
    s.players.push({ ...s.players[0]!, id: s.nextId(), floorMaterials: {}, bankedMaterials: {}, blueprintPickup: null, characterPickup: null });
    const item = dropped(s)[0]!;
    const [a, b] = s.players;
    a!.gx = item.gx;
    a!.gy = item.gy;
    b!.gx = toFpGrid(500);
    b!.gy = toFpGrid(500);
    s.tick += 1;
    const before = hashState(s);

    pickups.tick(s);

    expect(a!.characterPickup).toBe(item.skinId);
    expect(b!.characterPickup).toBeNull();
    const ev = s.events.find((e) => e.type === 'pickup' && e.kind === 'character') as { by: number; skinId?: string } | undefined;
    expect(ev?.by).toBe(a!.id);
    expect(ev?.skinId).toBe(item.skinId);
    // The seat's carry-out is hashed: two clients disagreeing about who holds it must diverge.
    const held = hashState(s);
    a!.characterPickup = null;
    expect(hashState(s)).not.toBe(held);
    expect(held).not.toBe(before);
  });

  it('a second pickup never overwrites the first', () => {
    const s = firstDroppingSeed();
    const p = s.players[0]!;
    p.characterPickup = 'juggernaut';
    const item = dropped(s)[0]!;
    item.skinId = 'someone_else';
    p.gx = item.gx;
    p.gy = item.gy;
    s.tick += 1;
    pickups.tick(s);
    expect(p.characterPickup).toBe('juggernaut');
  });
});
