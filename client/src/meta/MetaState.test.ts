/**
 * MetaState (design/14 persistent between-run layer) — pins defaultMetaState()'s shape
 * and the FREE_CHARACTERS roster derivation.
 */
import { describe, it, expect } from 'vitest';
import { defaultMetaState, FREE_CHARACTERS } from './MetaState';
import { STARTER_BLUEPRINTS, DEFAULT_SKIN_ID, SKIN_DEFS } from '@dd/engine';

describe('FREE_CHARACTERS', () => {
  it('is exactly vanguard (Task 8, "vanguard=free, skirmisher=paid, juggernaut=event", 2026-09-23)', () => {
    expect(FREE_CHARACTERS).toEqual([DEFAULT_SKIN_ID]);
  });

  it('is a strict subset of the real roster, never a name the catalog does not carry', () => {
    for (const id of FREE_CHARACTERS) expect(SKIN_DEFS[id]).toBeDefined();
  });

  it('is non-empty', () => {
    expect(FREE_CHARACTERS.length).toBeGreaterThan(0);
  });
});

describe('defaultMetaState()', () => {
  it('starts with an empty material bank', () => {
    expect(defaultMetaState().materialBank).toEqual({});
  });

  it('pre-unlocks the starter blueprints', () => {
    expect(defaultMetaState().unlockedBlueprints).toEqual([...STARTER_BLUEPRINTS]);
  });

  it('owns the full free roster', () => {
    expect(defaultMetaState().ownedCharacters).toEqual([...FREE_CHARACTERS]);
  });

  it('starts with an empty loadout', () => {
    expect(defaultMetaState().loadout).toEqual([]);
  });

  it('selects the default skin', () => {
    expect(defaultMetaState().selectedSkin).toBe(DEFAULT_SKIN_ID);
  });

  it('has not seen the tutorial yet', () => {
    expect(defaultMetaState().hasSeenTutorial).toBe(false);
  });

  it('returns a fresh object each call (no shared mutable state between accounts)', () => {
    const a = defaultMetaState();
    const b = defaultMetaState();
    expect(a).not.toBe(b);
    expect(a.unlockedBlueprints).not.toBe(b.unlockedBlueprints);
    expect(a.ownedCharacters).not.toBe(b.ownedCharacters);
    a.unlockedBlueprints.push('mutated');
    expect(b.unlockedBlueprints).not.toContain('mutated');
  });
});
