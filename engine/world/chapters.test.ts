import { describe, expect, it } from 'vitest';
import {
  CHAPTERS,
  CHAPTER_ORDER,
  DEFAULT_CHAPTER_ID,
  chapterIdOfConfig,
  chapterIdOr,
  isChapterId,
  nextChapterId,
} from '@dd/engine/world/chapters';
import { EMBER_DUNGEON, EMBER_PROCEDURAL_DUNGEON } from '@dd/engine/world/rooms/ember';
import { EMBER_L1_ROOMS } from '@dd/engine/world/rooms/emberLevel1';
import { FROST_DUNGEON } from '@dd/engine/world/rooms/frost';

describe('the chapter catalog', () => {
  it('lists every chapter once, in unlock order, starting with the default', () => {
    expect([...CHAPTER_ORDER]).toEqual(['ember', 'frost']);
    expect(CHAPTER_ORDER[0]).toBe(DEFAULT_CHAPTER_ID);
    expect(Object.keys(CHAPTERS).sort()).toEqual([...CHAPTER_ORDER].sort());
  });

  it("keys each chapter by its config's biome id — the one equivalence chapterIdOfConfig relies on", () => {
    for (const id of CHAPTER_ORDER) expect(CHAPTERS[id].config.biomeId).toBe(id);
  });

  it('chapter 1 is the shipped ember pairing, byte for byte — saves and replays hash it', () => {
    expect(CHAPTERS.ember.config).toBe(EMBER_DUNGEON);
    expect(CHAPTERS.ember.library).toBe(EMBER_L1_ROOMS);
    expect(CHAPTERS.frost.config).toBe(FROST_DUNGEON);
  });

  it('every chapter boss piece and extraction piece resolves in that chapter library', () => {
    for (const id of CHAPTER_ORDER) {
      const { config, library } = CHAPTERS[id];
      const ids = new Set(library.map((p) => p.id));
      expect(ids.has(config.bossPieceId), id).toBe(true);
      expect(ids.has(config.extractionPieceId), id).toBe(true);
    }
  });
});

describe('chapter id helpers', () => {
  it('isChapterId accepts exactly the catalog ids', () => {
    expect(isChapterId('ember')).toBe(true);
    expect(isChapterId('frost')).toBe(true);
    for (const bad of ['storm', '', 'EMBER', 1, null, undefined, {}]) expect(isChapterId(bad)).toBe(false);
  });

  it('chapterIdOr falls back to the default for anything untrusted', () => {
    expect(chapterIdOr('frost')).toBe('frost');
    expect(chapterIdOr('nope')).toBe(DEFAULT_CHAPTER_ID);
    expect(chapterIdOr(undefined)).toBe(DEFAULT_CHAPTER_ID);
  });

  it('chapterIdOfConfig names a catalog config and refuses everything else', () => {
    expect(chapterIdOfConfig(EMBER_DUNGEON)).toBe('ember');
    expect(chapterIdOfConfig(FROST_DUNGEON)).toBe('frost');
    expect(chapterIdOfConfig(undefined)).toBeNull();
    // Same biome id, different config: a fixture is not mistaken for the shipped chapter.
    expect(EMBER_PROCEDURAL_DUNGEON.biomeId).toBe('ember');
    expect(chapterIdOfConfig(EMBER_PROCEDURAL_DUNGEON)).toBeNull();
    expect(chapterIdOfConfig({ ...EMBER_DUNGEON, biomeId: 'storm' })).toBeNull();
  });

  it('nextChapterId walks the unlock order and stops after the last chapter', () => {
    expect(nextChapterId('ember')).toBe('frost');
    expect(nextChapterId('frost')).toBeNull();
  });
});
