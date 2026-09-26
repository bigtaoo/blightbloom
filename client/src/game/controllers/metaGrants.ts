/**
 * Run-carry-out / weapon-pickup blueprint grants, split out of Game.ts (CLAUDE.md 500-line
 * convention, form (1) — independent functions, no shared state): pure `MetaState -> MetaState`
 * transforms over a `GameState`/weaponId, so Game.ts's own methods are one line each —
 * `this.run.meta = grantXxx(...)` — plus the `this.store.save` every meta write already needs.
 */
import { EARNABLE_BLUEPRINTS, type GameState } from '@dd/engine';
import { bankMaterials, unlockBlueprint, addSchematic, grantCharacter, type MetaState } from '../../meta';

/**
 * A finished run's carry-out (design/05/14): this seat's own banked materials, its character
 * drop if it picked one up, and — only when `includeBlueprint` (default true) — its one-time
 * schematic pickup, if any.
 *
 * Per-seat since ENGINE_VERSION 68 — only THIS client's own local seat's bags leave the sim;
 * a teammate's client applies its own local seat's bags the same way, on its own call to this
 * same function (design/06 — every client reaches its own outcome from the same replicated
 * state, never from a peer's).
 *
 * `includeBlueprint` is false on the rewarded-ad's repeat call (`RunOutcome.doubleOffer`) —
 * unlike the old permanent `unlockBlueprint`, stacking a schematic is NOT idempotent, so the
 * caller decides explicitly whether this call should touch it (see the interface doc comment
 * on `RunOutcomeHost.bankRunCarryOut`).
 */
export function grantRunCarryOut(meta: MetaState, s: GameState, localOwner: number, includeBlueprint = true): MetaState {
  const p = s.players[localOwner];
  if (!p) return meta;
  let next = bankMaterials(meta, p.bankedMaterials);
  if (includeBlueprint && p.blueprintPickup !== null) next = addSchematic(next, p.blueprintPickup);
  // The boss's rare character drop (design/14, 2026-09-26). Idempotent, so the rewarded-ad's
  // repeat call may run it again harmlessly — no `includeBlueprint`-style gate needed. For a
  // signed-in account this local grant is what the account-sync store turns into a server
  // claim (`meta/accountSync.ts`), because ownership there is the server's answer.
  if (p.characterPickup !== null) next = grantCharacter(next, p.characterPickup);
  return next;
}

/**
 * A catalogued weapon found on the floor grants its blueprint (design/14, ENGINE_VERSION 68).
 * A floor weapon whose id names an EARNABLE blueprint (flamer/scattergun/spear, the same pool
 * the boss schematic rolls from) is itself a schematic find, not a permanent grant — finding
 * one in a chest/shop is exactly as earned as finding one on the boss, and stacks the same
 * way. Every OTHER catalogued weapon (the starter pair, already permanent; a purchase/event
 * id) keeps the old permanent-on-first-find behaviour unchanged.
 */
export function grantWeaponPickup(meta: MetaState, weaponId: string): MetaState {
  if (EARNABLE_BLUEPRINTS.includes(weaponId)) return addSchematic(meta, weaponId);
  if (!meta.unlockedBlueprints.includes(weaponId)) return unlockBlueprint(meta, weaponId);
  return meta;
}
