/**
 * MetaState — the persistent, between-run progression layer (design/14). This is NOT
 * simulation state: the deterministic engine (@dd/engine) is per-run and reconstructs a
 * match from seed + input alone (design/06). Meta lives OUTSIDE it — what the account has
 * unlocked and banked, and what the player has chosen to bring into the NEXT run. It only
 * ever influences a run by choosing that run's EngineConfig (skinId + loadout); it never
 * feeds the sim mid-match, so it cannot break determinism or replay.
 *
 * Everything here is plain serializable data (persisted via meta/store). The forge
 * transactions that evolve it are pure functions in meta/forge.
 */
import { STARTER_BLUEPRINTS, DEFAULT_SKIN_ID, DEFAULT_CHAPTER_ID, type ChapterId } from '@dd/engine';

export interface MetaState {
  /** Banked materials, keyed by (element, rolled tier) via `bankKey` → total qty (tier 0
   * keeps the flat `mat_<element>` key). The run's carry-out bag (GameState.bankedMaterials)
   * is folded in here on a successful extraction. The sole crafting currency (design/14);
   * a recipe's minTier is enforced against these tiered keys (see meta/forge). */
  materialBank: Record<string, number>;
  /** Permanently unlocked weapon blueprints (weaponIds into BLUEPRINT_CATALOG) — never
   * spent by a craft, and never lost. Two sources, treated identically (design/14,
   * revised ENGINE_VERSION 68): the starter grant every account is created with, and a
   * store purchase — a registration grant is not a trial, it behaves exactly like a
   * purchase. Distinct from a crafted instance (one run, design/05) and from
   * `blueprintStock` below (a boss's one-time schematic drop, consumed by the craft
   * that spends it). */
  unlockedBlueprints: string[];
  /** One-time blueprint SCHEMATICS on hand (weaponId → count), from a boss's rare drop
   * (design/14, ENGINE_VERSION 68). Stackable — a squad's boss can pay out at most one
   * per run, but nothing stops several runs' drops from piling up unused. Crafting a
   * weaponId already in `unlockedBlueprints` never touches this: the permanent recipe
   * is checked first, so a stacked schematic for a weapon you also own outright is
   * simply not spent (design/14 "a schematic for a weapon you already own permanently
   * is a real, accepted dud — see `content/blueprints.ts`'s boss-roll doc comment"). */
  blueprintStock: Record<string, number>;
  /** Characters the account owns (skinIds). Free roster today; paid roster is 2.3/2.4. */
  ownedCharacters: string[];
  /** Up to WEAPON_SLOTS crafted weaponIds staged for the next run (design/05/14). Consumed
   * into that run's EngineConfig.loadout; each crafted instance is wiped at run end. */
  loadout: string[];
  /** The chosen character carried into the next run (EngineConfig.skinId, design/14). */
  selectedSkin: string;
  /** Whether this local player has completed or explicitly skipped the tutorial level
   * (design/10 screen-flow gap). Guest-local, account-independent — it only gates the
   * "recommended" badge the lobby shows on its TUTORIAL row, never blocks play. */
  hasSeenTutorial: boolean;
  /** The deepest dungeon floor (1-based) any PvE run has reached, win or lose; 0 before the
   * first one ends. Drawn under the lobby's hero (design/10, 2026-09-27). Only ever rises —
   * see `recordFloorReached`. The tutorial, the PvP arena and replays never write it. */
  bestFloor: number;
  /** The PvE chapter the next solo run starts in (engine `world/chapters.ts`), picked in the
   *  lobby. Only ever set to an UNLOCKED chapter by `selectChapter`, and read through
   *  `playableChapter`, which falls back to the first chapter for one that is not — see
   *  `meta/chapterProgress.ts`. */
  selectedChapter: ChapterId;
  /** Chapter ids whose boss this account has beaten (a last-floor extraction). Clearing chapter
   *  N unlocks chapter N+1; chapter 1 is always unlocked. A plain `string[]` rather than
   *  `ChapterId[]` on purpose: an id a NEWER build wrote must survive a round trip through an
   *  older one (`store.ts migrate`), or playing on a stale tab would re-lock a chapter. */
  clearedChapters: string[];
  /** The deepest floor (1-based) any run in the endless chapter has reached, win or lose; 0
   *  before the first. Its own record rather than `bestFloor`'s, which counts a chapter's five
   *  floors: one endless run would bury that number for good. Drawn on the lobby's chapter
   *  picker when it shows the endless chapter. Only ever rises (`recordEndlessFloorReached`). */
  endlessBestFloor: number;
}

/** The free character roster (Task 8, "vanguard=free, skirmisher=paid, juggernaut=event",
 * 2026-09-23 — the free-vs-paid split ROADMAP 2.3/2.4 deferred to "the store's job").
 * `vanguard` is the only one granted to every account by default; `skirmisher` is sold
 * via a character SKU (`server/src/billsvc/skus.ts`); `juggernaut` is a 1% boss drop since
 * 2026-09-26 (engine `DROP_CHARACTERS`, claimed by `meta/accountSync.ts`), so it is in NEITHER
 * list — there is no way to own it this pass. A save that already owns skirmisher or
 * juggernaut from before this change keeps them: `meta/store.ts migrate()` only UNIONS
 * this list into a save's `ownedCharacters`, never subtracts from it. */
export const FREE_CHARACTERS: readonly string[] = [DEFAULT_SKIN_ID];

/** A fresh account (design/14): the common-drop blueprints pre-unlocked so the forge has
 * something to craft, the free roster owned, an empty bank and loadout, default character. */
export function defaultMetaState(): MetaState {
  return {
    materialBank: {},
    unlockedBlueprints: [...STARTER_BLUEPRINTS],
    blueprintStock: {},
    ownedCharacters: [...FREE_CHARACTERS],
    loadout: [],
    selectedSkin: DEFAULT_SKIN_ID,
    hasSeenTutorial: false,
    bestFloor: 0,
    selectedChapter: DEFAULT_CHAPTER_ID,
    clearedChapters: [],
    endlessBestFloor: 0,
  };
}

/** `m` with `floor` folded into `bestFloor` — the same object back when it is no deeper, so a
 * caller can skip the save. */
export function recordFloorReached(m: MetaState, floor: number): MetaState {
  if (!Number.isFinite(floor) || floor <= m.bestFloor) return m;
  return { ...m, bestFloor: Math.floor(floor) };
}

/** `m` with `floor` folded into `endlessBestFloor`, the same object back when it is no deeper. */
export function recordEndlessFloorReached(m: MetaState, floor: number): MetaState {
  if (!Number.isFinite(floor) || floor <= m.endlessBestFloor) return m;
  return { ...m, endlessBestFloor: Math.floor(floor) };
}
