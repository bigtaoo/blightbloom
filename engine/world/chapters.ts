/**
 * The PvE chapter catalog (design/gameplay/04-chapters.md) — every dungeon a run can be
 * started in, in unlock order.
 *
 * A chapter is a whole run: its own biome, five floors and boss. Clearing a chapter's boss
 * unlocks the next one (client `meta/chapterProgress.ts`); an unlocked chapter can be replayed
 * any time. The last entry, `endless`, is the exception that proves the shape: a run with no
 * last floor, whose floors are the four chapters' in rotation (`rooms/endless.ts`). Chapters are NOT chained into one run — the carry-out bag is only safe once the
 * boss is dead, and a three-chapter run would put it at risk three times as long.
 *
 * The chapter id IS the config's `biomeId`. `DungeonConfig` has no id field of its own, and
 * a second one would be a second name that could disagree with the first; one biome per
 * chapter is the plan, so the biome names the chapter. `chapterIdOfConfig` is the one place
 * that equivalence is written down.
 *
 * Adding a chapter: author its `DungeonConfig` + library (see `rooms/frost.ts`), add it to
 * `CHAPTERS` and `CHAPTER_ORDER` below, map its biome in the client's `BIOME_ID_TO_ELEMENT`,
 * and give it a `chapter.<id>.name` string in every locale. Nothing else in the client or the
 * server enumerates chapters — they all read this catalog.
 */
import type { RoomPiece } from '../content/rooms';
import type { DungeonConfig } from './dungeon';
import { EMBER_DUNGEON } from './rooms/ember';
import { EMBER_L1_ROOMS } from './rooms/emberLevel1';
import { FROST_DUNGEON, FROST_L1_ROOMS } from './rooms/frost';
import { STORM_DUNGEON, STORM_L1_ROOMS } from './rooms/storm';
import { BLIGHT_DUNGEON, BLIGHT_L1_ROOMS } from './rooms/blight';
import { ENDLESS_DUNGEON, ENDLESS_ROOMS } from './rooms/endless';

/** Every chapter id, in unlock order. `endless` (2026-10-06) is the last entry, unlocked by
 *  clearing `blight`: it cycles through the four chapters' floors with no last floor
 *  (`rooms/endless.ts`), so it unlocks nothing itself. */
export const CHAPTER_ORDER = ['ember', 'frost', 'storm', 'blight', 'endless'] as const;
export type ChapterId = (typeof CHAPTER_ORDER)[number];

/** The chapter a run starts in when nothing chose one: an old save, an old client's
 *  `match_start`, a first-time player. Always the first chapter, which is always unlocked. */
export const DEFAULT_CHAPTER_ID: ChapterId = 'ember';

/** What `EngineConfig.dungeon` takes for a chapter. */
export interface ChapterContent {
  readonly config: DungeonConfig;
  readonly library: readonly RoomPiece[];
}

export const CHAPTERS: Readonly<Record<ChapterId, ChapterContent>> = {
  ember: { config: EMBER_DUNGEON, library: EMBER_L1_ROOMS },
  frost: { config: FROST_DUNGEON, library: FROST_L1_ROOMS },
  storm: { config: STORM_DUNGEON, library: STORM_L1_ROOMS },
  blight: { config: BLIGHT_DUNGEON, library: BLIGHT_L1_ROOMS },
  endless: { config: ENDLESS_DUNGEON, library: ENDLESS_ROOMS },
};

/** Narrow an untrusted value (a save file, a wire message, storage) to a chapter id. */
export function isChapterId(v: unknown): v is ChapterId {
  return typeof v === 'string' && (CHAPTER_ORDER as readonly string[]).includes(v);
}

/** An untrusted value as a chapter id, falling back to the default chapter. */
export function chapterIdOr(v: unknown): ChapterId {
  return isChapterId(v) ? v : DEFAULT_CHAPTER_ID;
}

/** The chapter a dungeon config belongs to, or null for a config outside the catalog
 *  (a test fixture, the procedural `EMBER_PROCEDURAL_DUNGEON`). Reads `biomeId` — see the
 *  module doc — and then checks the config really is that chapter's, so a fixture that
 *  happens to reuse a biome id is not mistaken for the shipped chapter. */
export function chapterIdOfConfig(config: DungeonConfig | undefined): ChapterId | null {
  if (!config || !isChapterId(config.biomeId)) return null;
  return CHAPTERS[config.biomeId].config === config ? config.biomeId : null;
}

/** The chapter after `id` in unlock order, or null after the last one. */
export function nextChapterId(id: ChapterId): ChapterId | null {
  return CHAPTER_ORDER[CHAPTER_ORDER.indexOf(id) + 1] ?? null;
}
