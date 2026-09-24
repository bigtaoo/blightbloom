/**
 * Forge transactions (design/14) — pure functions over MetaState. Each returns a NEW
 * state (no mutation), so callers can preview/undo and tests stay trivial. THREE layers,
 * revised ENGINE_VERSION 68 (was two): UNLOCK a blueprint permanently (account right, from
 * signup or purchase — the two are identical), BANK a one-time schematic (a boss's rare
 * drop, stackable), and CRAFT an instance from either by spending banked materials,
 * staging it into the next run's loadout (≤ WEAPON_SLOTS; each crafted weapon lasts
 * exactly one run, design/05). A craft always spends materials regardless of which of the
 * two owns it — a permanent recipe's only advantage is that it is never itself spent.
 *
 * **Which one a craft spends is not a choice — it is a fixed order.** `craft()` prefers
 * the permanent recipe when both exist for the same weaponId, so a stacked schematic is
 * never silently burned for a weapon the account already owns outright; it stays banked
 * for a run where the account does not. Today's catalog never actually presents that
 * choice (a permanent recipe and an earnable schematic never name the same weaponId — see
 * `content/blueprints.ts`), but the order costs nothing to get right now rather than later.
 *
 * Crafting currency is the five elemental materials (content/materials.ts), banked per
 * (element, ROLLED tier) via `bankKey` — so a recipe's `minTier` is ENFORCED: a cost of
 * `fire ×3 minTier 2` is only satisfied by fire materials rolled at tier ≥ 2 (deeper
 * floors, ROADMAP 1.5). A cost with no `minTier` accepts any tier (≥ 0). Spending draws
 * from the LOWEST qualifying tier first (deterministic), so a player's scarce high-tier
 * materials are preserved for the recipes that actually require them.
 */
import { BLUEPRINT_CATALOG, PLAYER_BASE, WEAPON_SPECS, parseBankKey, type MaterialCost, type WeaponBlueprint } from '@dd/engine';
import type { MetaState } from './MetaState';

/** Fold a finished run's carry-out bag (GameState.bankedMaterials) into the account bank.
 * Called on a successful extraction — a death banks nothing (design/05, handled upstream). */
export function bankMaterials(m: MetaState, banked: Partial<Record<string, number>>): MetaState {
  const materialBank = { ...m.materialBank };
  for (const [id, qty] of Object.entries(banked)) {
    materialBank[id] = (materialBank[id] ?? 0) + (qty ?? 0);
  }
  return { ...m, materialBank };
}

/** Does the account permanently own this weapon's recipe? (Signup grant or purchase —
 * the two are identical, design/14.) `canCraft` below is the fuller question — this one
 * matters on its own because a permanent recipe is what `craft()` prefers to spend from. */
export function isUnlocked(m: MetaState, weaponId: string): boolean {
  return m.unlockedBlueprints.includes(weaponId);
}

/** How many one-time schematics of this weapon the account is holding (0 if none). */
export function schematicCount(m: MetaState, weaponId: string): number {
  return m.blueprintStock[weaponId] ?? 0;
}

/** Can the forge craft this weapon at all — permanently, or off a banked schematic? This
 * is the gate `craft()` checks; `isUnlocked` alone would refuse a schematic-only weapon. */
export function canCraft(m: MetaState, weaponId: string): boolean {
  return isUnlocked(m, weaponId) || schematicCount(m, weaponId) > 0;
}

/** Grant a blueprint PERMANENTLY (signup / purchase / event — design/14, revised
 * ENGINE_VERSION 68: a registration grant behaves exactly like a purchase, never spent by
 * a craft). Idempotent; ignores unknown ids. Distinct from `addSchematic` below, which
 * banks a one-time, craft-consumed copy instead. */
export function unlockBlueprint(m: MetaState, weaponId: string): MetaState {
  if (!BLUEPRINT_CATALOG[weaponId] || isUnlocked(m, weaponId)) return m;
  return { ...m, unlockedBlueprints: [...m.unlockedBlueprints, weaponId] };
}

/** Bank a one-time blueprint schematic (a boss kill's rare drop, design/14, ENGINE_VERSION
 * 68) — stackable, unlike `unlockBlueprint`. A schematic for a weapon the account already
 * owns permanently still banks: the roll cannot see the account (design/06), and `craft()`
 * simply never spends a stacked copy it does not need (see this module's own header). */
export function addSchematic(m: MetaState, weaponId: string): MetaState {
  if (!BLUEPRINT_CATALOG[weaponId]) return m;
  return { ...m, blueprintStock: { ...m.blueprintStock, [weaponId]: schematicCount(m, weaponId) + 1 } };
}

/** Bank keys that satisfy a cost's (element, minTier), lowest tier first — the draw order
 * craft() spends in. Iterating this keeps the transaction deterministic. */
function qualifyingKeys(m: MetaState, c: MaterialCost): { key: string; tier: number; qty: number }[] {
  const id = `mat_${c.element}`;
  const min = c.minTier ?? 0;
  return Object.entries(m.materialBank)
    .map(([key, qty]) => ({ key, ...parseBankKey(key), qty: qty ?? 0 }))
    .filter((e) => e.materialId === id && e.tier >= min && e.qty > 0)
    .sort((a, b) => a.tier - b.tier);
}

/** How much of a cost's element the bank holds at ≥ its minTier. */
function availableFor(m: MetaState, c: MaterialCost): number {
  return qualifyingKeys(m, c).reduce((sum, e) => sum + e.qty, 0);
}

/** Does the bank hold enough of every material a recipe demands, at the required tier? */
export function canAfford(m: MetaState, bp: WeaponBlueprint): boolean {
  return bp.cost.every((c) => availableFor(m, c) >= c.qty);
}

/** Total banked qty of an element across all tiers ≥ minTier (default 0 = every tier) —
 * for the forge/HUD material board, which shows one number per element. */
export function bankTotal(m: MetaState, element: string, minTier = 0): number {
  return availableFor(m, { element: element as MaterialCost['element'], qty: 0, minTier });
}

export type CraftFailure = 'unknown' | 'locked' | 'loadout-full' | 'kind-taken' | 'unaffordable';
export type CraftResult = { ok: true; meta: MetaState } | { ok: false; reason: CraftFailure };

/** The `'ranged' | 'melee'` kind a staged weaponId will occupy, or undefined for an id
 * the weapon catalog doesn't know (dropped by `resolveLoadout` anyway, design/09
 * forward-compat). */
function kindOf(weaponId: string): string | undefined {
  return WEAPON_SPECS[weaponId]?.kind;
}

/** Is a weapon of this kind already staged? The guard behind the one-gun-and-one-melee
 * invariant (see `craft`). */
export function kindAlreadyStaged(m: MetaState, weaponId: string): boolean {
  const kind = kindOf(weaponId);
  return kind !== undefined && m.loadout.some((id) => kindOf(id) === kind);
}

/** Craft one instance of `weaponId` into the staged loadout: requires the blueprint to
 * exist and be CRAFTABLE (a permanent recipe, or a banked schematic — `canCraft`), a
 * free loadout slot **of a kind not already staged**, and enough materials. Always spends
 * the materials; spends one schematic too, UNLESS the account also holds the permanent
 * recipe, in which case the schematic stays banked (this module's own header).
 *
 * **The kind check is what makes design/03/05's central claim true** — *"every loadout
 * carries one gun and one melee weapon, so parry is always OWNED"* (`ENGINE_VERSION` 45).
 * That was never enforced anywhere: `resolveLoadout` only fills FREE slots by kind and
 * honours a staged same-kind pair verbatim (deliberately — an explicit choice is never
 * discarded), and this function used to check only the slot COUNT. So two of the five
 * blueprints a fresh account starts unlocked (`repeater` + `scattergun`, both guns) could
 * be staged together into a run with no melee weapon at all: no parry, and a swap button
 * toggling between two of the same thing — the exact state `ENGINE_VERSION` 46's
 * same-kind pickup rule was written to prevent a floor weapon from producing. The forge is
 * the only place a same-kind pair can enter a normal run, so it is the right place for the
 * gate; `resolveLoadout` stays unchanged, so a hand-built `EngineConfig` (tests, the sim
 * harnesses, `?dev` fixtures) can still ask for two of a kind on purpose. */
export function craft(m: MetaState, weaponId: string): CraftResult {
  const bp = BLUEPRINT_CATALOG[weaponId];
  if (!bp) return { ok: false, reason: 'unknown' };
  const permanent = isUnlocked(m, weaponId);
  if (!permanent && schematicCount(m, weaponId) <= 0) return { ok: false, reason: 'locked' };
  if (m.loadout.length >= PLAYER_BASE.weaponSlots) return { ok: false, reason: 'loadout-full' };
  if (kindAlreadyStaged(m, weaponId)) return { ok: false, reason: 'kind-taken' };
  if (!canAfford(m, bp)) return { ok: false, reason: 'unaffordable' };

  // Spend each cost from its qualifying tiers, lowest first (deterministic); an emptied
  // key is dropped so the bank doesn't accumulate zero entries.
  const materialBank = { ...m.materialBank };
  for (const c of bp.cost) {
    let owed = c.qty;
    for (const e of qualifyingKeys({ ...m, materialBank }, c)) {
      if (owed <= 0) break;
      const spend = Math.min(owed, e.qty);
      const left = e.qty - spend;
      if (left > 0) materialBank[e.key] = left;
      else delete materialBank[e.key];
      owed -= spend;
    }
  }
  // The permanent recipe is preferred and is never itself spent (this module's own
  // header); only a craft with NO permanent recipe touches the schematic stack, and it
  // always spends exactly one — `canCraft`'s guard above already proved one is banked.
  const blueprintStock = permanent ? m.blueprintStock : { ...m.blueprintStock };
  if (!permanent) {
    const left = schematicCount(m, weaponId) - 1;
    if (left > 0) blueprintStock[weaponId] = left;
    else delete blueprintStock[weaponId];
  }
  return { ok: true, meta: { ...m, materialBank, blueprintStock, loadout: [...m.loadout, weaponId] } };
}

/** Clear the staged loadout (e.g. after a run consumes it, or the player reconsiders).
 * The crafted weapons are gone either way — they were spent when crafted (design/05). */
export function clearLoadout(m: MetaState): MetaState {
  return { ...m, loadout: [] };
}

/** Choose the character for the next run; ignored if the account doesn't own it. */
export function selectCharacter(m: MetaState, skinId: string): MetaState {
  if (!m.ownedCharacters.includes(skinId)) return m;
  return { ...m, selectedSkin: skinId };
}

/** Grant a character to the account (design/14 "free + purchase"). Idempotent. */
export function grantCharacter(m: MetaState, skinId: string): MetaState {
  if (m.ownedCharacters.includes(skinId)) return m;
  return { ...m, ownedCharacters: [...m.ownedCharacters, skinId] };
}

// ── Monetization scaffolding (design/14, ROADMAP 2.4) ────────────────────────────
// Direct-purchase, bounded, NO gacha (design/14). Real payment is out of scope (and a
// prohibited action); these are the pure GRANT half — what a completed purchase does to
// the account. A store UI + a platform billing adapter (WeChat/web) would call these
// after their own payment flow. `acquireBlueprint` is just `unlockBlueprint` under a
// name that reads as a purchase at the call site.
export const acquireBlueprint = unlockBlueprint;

/** Blueprints that are bought/earned (not drops) and not yet unlocked — the store's
 * blueprint shelf (design/14). Pure over the catalog + account state. */
export function purchasableBlueprints(m: MetaState): string[] {
  return Object.values(BLUEPRINT_CATALOG)
    .filter((b) => b.source !== 'drop' && !isUnlocked(m, b.weaponId))
    .map((b) => b.weaponId);
}
