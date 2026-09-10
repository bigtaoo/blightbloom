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
import { STARTER_BLUEPRINTS, DEFAULT_SKIN_ID, SKIN_DEFS } from '@dd/engine';

export interface MetaState {
  /** Banked materials, keyed by (element, rolled tier) via `bankKey` → total qty (tier 0
   * keeps the flat `mat_<element>` key). The run's carry-out bag (GameState.bankedMaterials)
   * is folded in here on a successful extraction. The sole crafting currency (design/14);
   * a recipe's minTier is enforced against these tiered keys (see meta/forge). */
  materialBank: Record<string, number>;
  /** Permanently unlocked weapon blueprints (weaponIds into BLUEPRINT_CATALOG). Account-
   * level, never lost — distinct from a crafted instance, which is one run (design/14). */
  unlockedBlueprints: string[];
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
}

/** The free character roster — every SkinDef currently shipped (no paid ones yet; the
 * free-vs-paid split is 2.3/2.4). Derived from the catalog so a new skin is owned by
 * default until the paid roster exists. */
export const FREE_CHARACTERS: readonly string[] = Object.keys(SKIN_DEFS);

/** A fresh account (design/14): the common-drop blueprints pre-unlocked so the forge has
 * something to craft, the free roster owned, an empty bank and loadout, default character. */
export function defaultMetaState(): MetaState {
  return {
    materialBank: {},
    unlockedBlueprints: [...STARTER_BLUEPRINTS],
    ownedCharacters: [...FREE_CHARACTERS],
    loadout: [],
    selectedSkin: DEFAULT_SKIN_ID,
    hasSeenTutorial: false,
  };
}
