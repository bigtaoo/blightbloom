/**
 * metaGrants (split out of Game.ts, design/14 blueprint two-tier pass, ENGINE_VERSION 68) —
 * the pure `MetaState -> MetaState` transforms `Game.ts`'s `bankRunCarryOut`/`onWeaponPickup`
 * are one-line wrappers over. Had zero dedicated coverage despite being exactly the kind of
 * small pure logic this repo's "全部加测试" convention expects covered.
 */
import { describe, it, expect } from 'vitest';
import { EARNABLE_BLUEPRINTS, type GameState } from '@dd/engine';
import { defaultMetaState } from '../../meta/MetaState';
import { grantRunCarryOut, grantWeaponPickup } from './metaGrants';

const EARNABLE = EARNABLE_BLUEPRINTS[0]!; // e.g. 'flamer' — a drop blueprint, not a starter
const PERMANENT_ONLY = 'cryobolt'; // a purchase-only blueprint, never in EARNABLE_BLUEPRINTS

/** Only the two fields `grantRunCarryOut` reads off a seat — a minimal fake, same
 *  "cast a plain object" convention `EventReactor.test.ts`'s `fakeFx`/`fakeHost` use. */
function stateWithPlayer(over: { bankedMaterials?: Record<string, number>; blueprintPickup?: string | null; characterPickup?: string | null }): GameState {
  return {
    players: [{ bankedMaterials: {}, blueprintPickup: null, characterPickup: null, ...over }],
  } as unknown as GameState;
}

describe('grantRunCarryOut', () => {
  it('banks this seat\'s materials into the account', () => {
    const meta = defaultMetaState();
    const s = stateWithPlayer({ bankedMaterials: { mat_fire: 2, mat_ice: 1 } });
    const next = grantRunCarryOut(meta, s, 0);
    expect(next.materialBank).toEqual({ mat_fire: 2, mat_ice: 1 });
  });

  it('returns the state unchanged when the seat does not exist (e.g. an out-of-range owner)', () => {
    const meta = defaultMetaState();
    const s = { players: [] } as unknown as GameState;
    expect(grantRunCarryOut(meta, s, 0)).toBe(meta);
  });

  it('does not touch a null blueprintPickup', () => {
    const meta = defaultMetaState();
    const s = stateWithPlayer({ blueprintPickup: null });
    expect(grantRunCarryOut(meta, s, 0).blueprintStock).toEqual({});
  });

  it('banks a non-null blueprintPickup as a schematic, by default', () => {
    const meta = defaultMetaState();
    const s = stateWithPlayer({ blueprintPickup: EARNABLE });
    expect(grantRunCarryOut(meta, s, 0).blueprintStock).toEqual({ [EARNABLE]: 1 });
  });

  it('skips the schematic when includeBlueprint is false — the rewarded-ad repeat call', () => {
    // `RunOutcome.doubleOffer` passes false: unlike bankMaterials (idempotent-safe to
    // call twice), a schematic grant stacks, so the second call must not double it.
    const meta = defaultMetaState();
    const s = stateWithPlayer({ bankedMaterials: { mat_fire: 1 }, blueprintPickup: EARNABLE });
    const next = grantRunCarryOut(meta, s, 0, false);
    expect(next.blueprintStock).toEqual({});
    expect(next.materialBank).toEqual({ mat_fire: 1 }); // materials still bank either way
  });

  it('reads the localOwner-th seat, not always seat 0', () => {
    const meta = defaultMetaState();
    const s = {
      players: [
        { bankedMaterials: { mat_fire: 1 }, blueprintPickup: null },
        { bankedMaterials: { mat_ice: 5 }, blueprintPickup: null },
      ],
    } as unknown as GameState;
    expect(grantRunCarryOut(meta, s, 1).materialBank).toEqual({ mat_ice: 5 });
  });
});

describe('grantWeaponPickup', () => {
  it('banks an EARNABLE_BLUEPRINTS weapon as a stacking schematic, not a permanent unlock', () => {
    const meta = defaultMetaState();
    const next = grantWeaponPickup(meta, EARNABLE);
    expect(next.blueprintStock[EARNABLE]).toBe(1);
    expect(next.unlockedBlueprints).not.toContain(EARNABLE);
  });

  it('stacks a second find of the same earnable weapon', () => {
    let meta = defaultMetaState();
    meta = grantWeaponPickup(meta, EARNABLE);
    meta = grantWeaponPickup(meta, EARNABLE);
    expect(meta.blueprintStock[EARNABLE]).toBe(2);
  });

  it('grants a non-earnable catalogued weapon (purchase/event) as a permanent unlock', () => {
    const meta = defaultMetaState();
    const next = grantWeaponPickup(meta, PERMANENT_ONLY);
    expect(next.unlockedBlueprints).toContain(PERMANENT_ONLY);
    expect(next.blueprintStock[PERMANENT_ONLY]).toBeUndefined();
  });

  it('is idempotent for an already-unlocked permanent weapon', () => {
    let meta = defaultMetaState();
    meta = grantWeaponPickup(meta, PERMANENT_ONLY);
    const again = grantWeaponPickup(meta, PERMANENT_ONLY);
    expect(again.unlockedBlueprints.filter((id) => id === PERMANENT_ONLY)).toHaveLength(1);
  });

  it('leaves meta unchanged for an uncatalogued weapon id', () => {
    const meta = defaultMetaState();
    const next = grantWeaponPickup(meta, 'no-such-weapon');
    expect(next).toEqual(meta);
  });
});

describe('grantRunCarryOut — the boss character drop (design/14, 2026-09-26)', () => {
  it('grants the picked-up character to the account', () => {
    const next = grantRunCarryOut(defaultMetaState(), stateWithPlayer({ characterPickup: 'juggernaut' }), 0);
    expect(next.ownedCharacters).toContain('juggernaut');
  });

  it('is idempotent — the rewarded-ad repeat call (includeBlueprint false) grants it once, not twice', () => {
    const s = stateWithPlayer({ characterPickup: 'juggernaut' });
    const once = grantRunCarryOut(defaultMetaState(), s, 0);
    const twice = grantRunCarryOut(once, s, 0, false);
    expect(twice.ownedCharacters.filter((c) => c === 'juggernaut')).toHaveLength(1);
  });

  it('grants nothing without a pickup', () => {
    const meta = defaultMetaState();
    expect(grantRunCarryOut(meta, stateWithPlayer({}), 0).ownedCharacters).toEqual(meta.ownedCharacters);
  });
});
