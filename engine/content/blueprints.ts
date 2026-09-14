/**
 * Weapon blueprints + crafting recipes (design/14 forging). A BLUEPRINT is a permanent
 * account-level unlock — the *right* to make a weapon; a CRAFT spends materials to turn
 * an unlocked blueprint into one instance that enters exactly one run (like every weapon,
 * wiped at run end, design/05). This module fixes the catalog DATA only (design/14 says
 * "blueprints, recipes and character stats are concrete @dd/engine content"); the
 * persistent forge STATE + craft/unlock transactions + material bank live in the meta
 * layer (client/src/meta), which is between-run and NOT part of the deterministic sim.
 *
 * Crafting currency is the five elemental materials (content/materials.ts) — the run's
 * only carry-out (design/05/14), the sole crafting currency (no soft currency). A recipe
 * names element × qty, optionally at a minimum rolled tier. `minTier` IS enforced now: the
 * material bank keys by (element, tier) via `bankKey`, and the meta forge's canAfford/craft
 * only count materials rolled at ≥ the recipe's minTier (deeper floors roll higher tiers,
 * ROADMAP 1.5) — so a premium recipe genuinely demands materials from deeper runs.
 */
import type { DamageType } from './damage';
import { DAMAGE_TYPES } from './damage';
import { WEAPON_SPECS } from './weapons';

/** How blueprints are obtained (design/14). 'drop' = falls from runs (2–3 common,
 * permanent the moment obtained); 'purchase' = RMB store; 'event' = time-limited. */
export type BlueprintSource = 'drop' | 'purchase' | 'event';

/** One material requirement of a recipe: how much of which elemental material. */
export interface MaterialCost {
  element: DamageType;
  qty: number;
  minTier?: number; // design/14. ENFORCED — the module doc above has the mechanism (the bank
  // keys by (element, rolled tier), so only deep-enough materials count). This said "not yet
  // enforced" until 2026-09-03, contradicting that doc eleven lines up.
}

export interface WeaponBlueprint {
  weaponId: string; // key into WEAPON_SPECS — the weapon this blueprint crafts
  // i18n key (design/09 — no display strings in engine data). Currently vestigial: the
  // client displays a blueprint row under the WEAPON's own nameKey (WEAPON_SPECS[weaponId]
  // .nameKey) rather than this one, since weaponId ≡ this record's own key for every
  // entry today — translating this field too would mean authoring the identical string
  // twice per locale. Kept (not removed) so a future blueprint that names a DIFFERENT
  // display name than its underlying weapon (e.g. a themed variant) has somewhere to put it.
  nameKey: string;
  cost: readonly MaterialCost[];
  source: BlueprintSource;
}

/** The craftable-weapon catalog (design/14, first-pass — recipes/costs are to-tune).
 * Costs lean on the weapon's own element so the elemental economy reads intuitively. */
export const BLUEPRINT_CATALOG: Record<string, WeaponBlueprint> = {
  // Common run drops — unlocked early, cheap physical/fire staples.
  repeater: { weaponId: 'repeater', nameKey: 'blueprint.repeater', source: 'drop', cost: [{ element: 'physical', qty: 3 }] },
  flamer: { weaponId: 'flamer', nameKey: 'blueprint.flamer', source: 'drop', cost: [{ element: 'fire', qty: 3 }] },
  // Purchasable / event elemental blueprints.
  cryobolt: { weaponId: 'cryobolt', nameKey: 'blueprint.cryobolt', source: 'purchase', cost: [{ element: 'ice', qty: 3 }] },
  teslagun: { weaponId: 'teslagun', nameKey: 'blueprint.teslagun', source: 'purchase', cost: [{ element: 'lightning', qty: 3 }] },
  venomspit: { weaponId: 'venomspit', nameKey: 'blueprint.venomspit', source: 'purchase', cost: [{ element: 'poison', qty: 3 }] },
  cannon: { weaponId: 'cannon', nameKey: 'blueprint.cannon', source: 'purchase', cost: [{ element: 'physical', qty: 5 }] },
  // Premium recipes gate on rolled tier (design/14): the emberblade demands REFINED fire
  // (tier ≥ 1, from deeper floors) plus raw physical — a reason to descend past floor 0.
  emberblade: { weaponId: 'emberblade', nameKey: 'blueprint.emberblade', source: 'event', cost: [{ element: 'fire', qty: 2, minTier: 1 }, { element: 'physical', qty: 2 }] },

  // ── Frame-library recipes (design/03/14 follow-up) — the Phase 1.1 showcase weapons
  // had zero blueprints, so deep-floor material tiers had almost nothing to gate besides
  // emberblade. Sourced/tiered by the same rarity → source ladder the original catalog
  // already used (common/fine → drop, epic → purchase, legend/legendary → event + minTier).
  scattergun: { weaponId: 'scattergun', nameKey: 'blueprint.scattergun', source: 'drop', cost: [{ element: 'physical', qty: 3 }] },
  hammer: { weaponId: 'hammer', nameKey: 'blueprint.hammer', source: 'drop', cost: [{ element: 'physical', qty: 3 }] },
  spear: { weaponId: 'spear', nameKey: 'blueprint.spear', source: 'drop', cost: [{ element: 'physical', qty: 3 }] },
  seeker: { weaponId: 'seeker', nameKey: 'blueprint.seeker', source: 'purchase', cost: [{ element: 'physical', qty: 4 }] },
  mortar: { weaponId: 'mortar', nameKey: 'blueprint.mortar', source: 'purchase', cost: [{ element: 'physical', qty: 4 }] },
  novaburst: { weaponId: 'novaburst', nameKey: 'blueprint.novaburst', source: 'purchase', cost: [{ element: 'physical', qty: 4 }] },
  carom: { weaponId: 'carom', nameKey: 'blueprint.carom', source: 'purchase', cost: [{ element: 'physical', qty: 4 }] },
  leech: { weaponId: 'leech', nameKey: 'blueprint.leech', source: 'purchase', cost: [{ element: 'physical', qty: 4 }] },
  lasercutter: { weaponId: 'lasercutter', nameKey: 'blueprint.lasercutter', source: 'event', cost: [{ element: 'physical', qty: 3, minTier: 1 }] },
  tomahawk: { weaponId: 'tomahawk', nameKey: 'blueprint.tomahawk', source: 'event', cost: [{ element: 'physical', qty: 3, minTier: 1 }] },
  gyre: { weaponId: 'gyre', nameKey: 'blueprint.gyre', source: 'event', cost: [{ element: 'physical', qty: 3, minTier: 1 }] },

  // ── Remaining elemental melee + the new elemental frame siblings — same
  // REFINED-material gate as emberblade, one tier deeper for the legendary showcase.
  frostbrand: { weaponId: 'frostbrand', nameKey: 'blueprint.frostbrand', source: 'event', cost: [{ element: 'ice', qty: 2, minTier: 1 }, { element: 'physical', qty: 2 }] },
  stormglaive: { weaponId: 'stormglaive', nameKey: 'blueprint.stormglaive', source: 'event', cost: [{ element: 'lightning', qty: 2, minTier: 2 }, { element: 'physical', qty: 2 }] },
  cinderscatter: { weaponId: 'cinderscatter', nameKey: 'blueprint.cinderscatter', source: 'purchase', cost: [{ element: 'fire', qty: 3 }] },
  frostseeker: { weaponId: 'frostseeker', nameKey: 'blueprint.frostseeker', source: 'event', cost: [{ element: 'ice', qty: 2, minTier: 1 }, { element: 'physical', qty: 2 }] },
};

/**
 * Blueprints a fresh account is handed at creation (design/14, decided 2026-09-14).
 *
 * **An explicit list, and it used to be computed.** It was `every source: 'drop' entry` — all
 * five of them — which made the free-at-signup set and the EARNABLE set the same set by
 * construction, so the boss drop below would have had nothing left to award. Two openers, one
 * gun and one melee: a new account already carries `blaster` + `saber` for free without any
 * blueprint at all, so this grant's job is to show what crafting DOES, not to supply a loadout.
 */
export const STARTER_BLUEPRINTS: readonly string[] = ['repeater', 'hammer'];

/**
 * The pool a boss kill rolls from (design/14, `DeathDropsSystem`) — every `source: 'drop'`
 * blueprint that is not already handed over at signup.
 *
 * Derived rather than listed so the two sets can never overlap: adding a weapon to
 * `STARTER_BLUEPRINTS` removes it from the earnable pool in the same edit, which is the
 * relationship that broke when both were "all the drop entries".
 */
export const EARNABLE_BLUEPRINTS: readonly string[] = Object.values(BLUEPRINT_CATALOG)
  .filter((b) => b.source === 'drop' && !STARTER_BLUEPRINTS.includes(b.weaponId))
  .map((b) => b.weaponId);

/** Validate the catalog at load (design/09 "fail loud, never at use"): every blueprint
 * must name a real weapon and real elemental materials. Called by the catalog test; also
 * safe to call at boot. Returns the catalog so it can wrap a const initializer. */
export function validateBlueprints(catalog: Record<string, WeaponBlueprint> = BLUEPRINT_CATALOG): void {
  // The earnable pool must not be EMPTY, and this is the one check here that is about a
  // relationship rather than about a field. It exists because the failure it catches is
  // silent in every other way: a 5% boss roll against an empty pool awards nothing, forever,
  // with no error and no red test — which is exactly what shipping `STARTER_BLUEPRINTS` as
  // "every drop entry" alongside the drop would have done (design/14, 2026-09-14).
  if (catalog === BLUEPRINT_CATALOG && EARNABLE_BLUEPRINTS.length === 0)
    throw new Error("No earnable blueprints: STARTER_BLUEPRINTS covers every source:'drop' entry");
  for (const [id, bp] of Object.entries(catalog)) {
    if (STARTER_BLUEPRINTS.includes(bp.weaponId) && bp.source !== 'drop')
      throw new Error(`Blueprint '${id}': granted at signup but not source:'drop'`);
    if (!WEAPON_SPECS[bp.weaponId]) throw new Error(`Blueprint '${id}': unknown weaponId '${bp.weaponId}'`);
    for (const c of bp.cost) {
      if (!DAMAGE_TYPES.includes(c.element)) throw new Error(`Blueprint '${id}': unknown material element '${c.element}'`);
      if (c.qty <= 0) throw new Error(`Blueprint '${id}': non-positive cost qty for '${c.element}'`);
      if (c.minTier !== undefined && (c.minTier < 0 || !Number.isInteger(c.minTier)))
        throw new Error(`Blueprint '${id}': minTier must be a non-negative integer for '${c.element}'`);
    }
  }
}
