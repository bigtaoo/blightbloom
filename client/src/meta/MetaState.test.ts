/**
 * MetaState (design/14 persistent between-run layer) — pins defaultMetaState()'s shape
 * and the FREE_CHARACTERS roster derivation.
 */
import { describe, it, expect } from 'vitest';
import { defaultMetaState, FREE_CHARACTERS, recordEndlessFloorReached, recordFloorReached } from './MetaState';
import { STARTER_BLUEPRINTS, DEFAULT_SKIN_ID, SKIN_DEFS, DEFAULT_CHAPTER_ID } from '@dd/engine';

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

describe('recordFloorReached()', () => {
  it('starts a fresh account at 0 — no line under the hero', () => {
    expect(defaultMetaState().bestFloor).toBe(0);
  });

  it('starts in chapter 1 with no chapter cleared', () => {
    expect(defaultMetaState().selectedChapter).toBe(DEFAULT_CHAPTER_ID);
    expect(defaultMetaState().clearedChapters).toEqual([]);
  });

  it('keeps the deeper floor, and hands back the SAME object when nothing changed', () => {
    const m = recordFloorReached(defaultMetaState(), 3);
    expect(m.bestFloor).toBe(3);
    expect(recordFloorReached(m, 5).bestFloor).toBe(5);
    expect(recordFloorReached(m, 2)).toBe(m);
    expect(recordFloorReached(m, 3)).toBe(m);
    expect(recordFloorReached(m, Number.NaN)).toBe(m);
  });
});

describe('recordEndlessFloorReached()', () => {
  it('keeps its own record, apart from the chapters’ bestFloor', () => {
    expect(defaultMetaState().endlessBestFloor).toBe(0);
    const m = recordEndlessFloorReached(defaultMetaState(), 17);
    expect(m.endlessBestFloor).toBe(17);
    expect(m.bestFloor).toBe(0);
    expect(recordEndlessFloorReached(m, 22.5).endlessBestFloor).toBe(22);
    expect(recordEndlessFloorReached(m, 9)).toBe(m);
    expect(recordEndlessFloorReached(m, 17)).toBe(m);
    expect(recordEndlessFloorReached(m, Number.NaN)).toBe(m);
  });
});
