/**
 * Blueprint catalog integrity (design/14). The recipes are engine content, so they must
 * reference real weapons and real elemental materials — validated at load (design/09
 * "fail loud, never at use"). These tests pin that guard and the starter set.
 */
import { describe, it, expect } from 'vitest';
import {
  BLUEPRINT_CATALOG,
  EARNABLE_BLUEPRINTS,
  STARTER_BLUEPRINTS,
  validateBlueprints,
} from '@dd/engine/content/blueprints';
import { WEAPON_SPECS } from '@dd/engine/content/weapons';
import { DAMAGE_TYPES } from '@dd/engine/content/damage';

describe('BLUEPRINT_CATALOG', () => {
  it('passes load-time validation (every weaponId + material element is real)', () => {
    expect(() => validateBlueprints()).not.toThrow();
  });

  it('every blueprint names a real weapon and positive elemental costs', () => {
    for (const [id, bp] of Object.entries(BLUEPRINT_CATALOG)) {
      expect(bp.weaponId, id).toBe(id); // key === weaponId by convention
      expect(WEAPON_SPECS[bp.weaponId], id).toBeDefined();
      expect(bp.cost.length, id).toBeGreaterThan(0);
      for (const c of bp.cost) {
        expect(DAMAGE_TYPES).toContain(c.element);
        expect(c.qty).toBeGreaterThan(0);
      }
    }
  });

  it('starter and earnable blueprints PARTITION the drop-source ones (design/14, 2026-09-14)', () => {
    // This used to assert that STARTER_BLUEPRINTS WAS every drop entry, which is exactly the
    // bug: the free-at-signup set and the earnable set were the same set, so a boss roll would
    // have had nothing to award. The two must now be disjoint and cover the drops between them.
    const drops = Object.values(BLUEPRINT_CATALOG).filter((b) => b.source === 'drop').map((b) => b.weaponId);
    expect([...STARTER_BLUEPRINTS, ...EARNABLE_BLUEPRINTS].sort()).toEqual([...drops].sort());
    expect(STARTER_BLUEPRINTS.filter((id) => EARNABLE_BLUEPRINTS.includes(id))).toEqual([]);
    for (const id of [...STARTER_BLUEPRINTS, ...EARNABLE_BLUEPRINTS]) expect(BLUEPRINT_CATALOG[id]).toBeDefined();
    expect(STARTER_BLUEPRINTS.length).toBeGreaterThanOrEqual(1);
  });

  it('leaves a NON-EMPTY earnable pool, which is the thing the 5% boss roll stands on', () => {
    // A 5% roll against an empty pool awards nothing forever, silently. `validateBlueprints`
    // refuses it; this asserts the shipped catalog does not need that refusal.
    expect(EARNABLE_BLUEPRINTS.length).toBeGreaterThan(0);
    expect(() => validateBlueprints()).not.toThrow();
  });

  it('hands a fresh account one gun and one melee — the forge has to be demonstrable', () => {
    // The reason the grant is two entries rather than zero: a new player must be able to see
    // what crafting DOES in each slot. (The loadout itself comes free from PLAYER_BASE, so
    // this is about the forge, not about being armed.)
    const kinds = STARTER_BLUEPRINTS.map((id) => WEAPON_SPECS[BLUEPRINT_CATALOG[id]!.weaponId]!.kind);
    expect(kinds).toContain('ranged');
    expect(kinds).toContain('melee');
  });

  it('fails loud on an unknown weaponId', () => {
    expect(() => validateBlueprints({ ghost: { weaponId: 'nope', nameKey: 'x', source: 'drop', cost: [{ element: 'fire', qty: 1 }] } })).toThrow(/weaponId/);
  });

  it('fails loud on an unknown material element', () => {
    expect(() =>
      validateBlueprints({ bad: { weaponId: 'repeater', nameKey: 'x', source: 'drop', cost: [{ element: 'plasma' as never, qty: 1 }] } }),
    ).toThrow(/element/);
  });

  it('fails loud on a negative / non-integer minTier (design/14 gate)', () => {
    expect(() =>
      validateBlueprints({ bad: { weaponId: 'repeater', nameKey: 'x', source: 'drop', cost: [{ element: 'fire', qty: 1, minTier: -1 }] } }),
    ).toThrow(/minTier/);
    expect(() =>
      validateBlueprints({ bad: { weaponId: 'repeater', nameKey: 'x', source: 'drop', cost: [{ element: 'fire', qty: 1, minTier: 1.5 }] } }),
    ).toThrow(/minTier/);
  });
});
