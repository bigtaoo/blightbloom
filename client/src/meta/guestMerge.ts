/**
 * The one-time device merge (design/16-accounts.md hole 1, closed 2026-09-17) — the pure half:
 * what counts as guest progress, and what combining it with an account's state produces.
 *
 * ## The rule, and the rule it is NOT
 *
 * `OnlineMatch.syncMetaWithSession` used to be `setMeta(remote ?? local)`, and the `??` only
 * ever reached the brand-new-account branch. Logging into an account that already had server
 * state therefore discarded whatever this browser had banked as a guest, silently.
 *
 * The fix is deliberately not a field-by-field union on every login. That is the wrong
 * DEFAULT on a shared computer, where the local guest progress belongs to whoever used the
 * browser last and unioning it into the account of whoever logs in now is a way of handing
 * one player another's materials. The rule is narrower: **this device merges once, on its
 * first association with any account, and the account is the truth afterwards.** The
 * idempotency key is the guest install id (`net/identity.ts`), held server-side in
 * `accounts.mergedGuestIds`, so a second tab, a re-login and a reinstall all get the same
 * answer.
 *
 * ## What a merge actually keeps, and the half of it that is not durable
 *
 * `materialBank` ADDS. That is the durable half and the one worth the whole mechanism: the
 * bank is what a guest accumulates, `POST /account/meta` stores it verbatim, and it comes
 * back on every later login.
 *
 * `unlockedBlueprints` / `ownedCharacters` UNION — and that union lives for this session
 * only. ROADMAP 8.2 moved both fields to the server's `entitlements` table:
 * `POST /account/meta` strips them out of the blob and `GET` writes the server's own answer
 * back over them, so ownership a client granted ITSELF cannot survive a round trip. Today
 * the only such ownership is `ForgeActions.acquireBlueprint`'s `demo: free grant` scaffold,
 * which already vanishes on any login (`accountSync.ts` says so outright). Unioning it here
 * is still right — the player who chose COMBINE should not watch a blueprint disappear
 * between the button and the Forge — but it is not a promise this layer can keep, and
 * granting a real entitlement from the client is precisely the free-money hole 8.2 closed.
 *
 * `blueprintStock` (design/14, ENGINE_VERSION 68) ADDS, exactly like `materialBank` — a
 * one-time schematic is stackable count, not a set, so unioning it would silently drop
 * duplicates a guest legitimately earned from more than one boss kill.
 *
 * `loadout` and `selectedSkin` are the ACCOUNT's: they are a staged choice rather than an
 * accumulation, two of them cannot be added, and "the account is the truth" has to mean
 * something. `hasSeenTutorial` is OR'd instead, because `MetaState` describes it as
 * guest-local and account-independent — a player who has already been through the tutorial
 * on this browser must not be recommended it again by a fresh account.
 */
import { STARTER_BLUEPRINTS } from '@dd/engine';
import { FREE_CHARACTERS, type MetaState } from './MetaState';

/** What the confirmation screen counts, so the player is choosing between two described
 *  things rather than two words. Every number is what the LOCAL side has that the account
 *  does not — the loss, not the total. */
export interface GuestMergeOffer {
  /** Total quantity across every bank key the guest holds. Additive, so all of it survives. */
  materials: number;
  /** Blueprints unlocked locally and not owned on the account, PLUS every banked one-time
   *  schematic (design/14, ENGINE_VERSION 68) — the two are folded into one count here
   *  rather than adding a second number to a one-time confirmation screen, since both read
   *  the same to a player: "blueprint-ish things this merge would bring over." */
  blueprints: number;
  /** Characters owned locally and not on the account. */
  characters: number;
}

function bankTotal(bank: Readonly<Record<string, number>>): number {
  let n = 0;
  // `?? 0` rather than a bare add: `materialBank` is a plain record and a key present with
  // no value is representable (the same fallback `PortalPrompt.totalCarryOut` needs), and
  // one `undefined` in this sum turns every count on the panel into NaN.
  for (const v of Object.values(bank)) n += v ?? 0;
  return n;
}

/**
 * Does this device hold guest progress worth asking about?
 *
 * Measured against a FRESH account rather than against emptiness, because the starter
 * blueprints and the free roster are handed to everyone by `defaultMetaState()` and re-unioned
 * on every load by `migrate()` — counting those would make every guest on earth look like
 * they had something to lose and would put the confirmation screen in front of a player with
 * nothing on either side of it.
 *
 * `selectedSkin` and `hasSeenTutorial` are deliberately not progress: one is a preference and
 * the other is a badge, and neither is worth a modal.
 */
export function hasGuestProgress(m: MetaState): boolean {
  if (bankTotal(m.materialBank) > 0) return true;
  if (m.loadout.length > 0) return true;
  if (m.unlockedBlueprints.some((id) => !STARTER_BLUEPRINTS.includes(id))) return true;
  if (Object.values(m.blueprintStock).some((qty) => (qty ?? 0) > 0)) return true;
  return m.ownedCharacters.some((id) => !FREE_CHARACTERS.includes(id));
}

/** What the guest side would add to the account side — the numbers the prompt shows. */
export function guestMergeOffer(guest: MetaState, account: MetaState): GuestMergeOffer {
  const ownedBp = new Set(account.unlockedBlueprints);
  const ownedCh = new Set(account.ownedCharacters);
  const schematicCount = Object.values(guest.blueprintStock).reduce((n, qty) => n + (qty ?? 0), 0);
  return {
    materials: bankTotal(guest.materialBank),
    blueprints: guest.unlockedBlueprints.filter((id) => !ownedBp.has(id)).length + schematicCount,
    characters: guest.ownedCharacters.filter((id) => !ownedCh.has(id)).length,
  };
}

function union(a: readonly string[], b: readonly string[]): string[] {
  return [...new Set([...a, ...b])];
}

/**
 * The account's state with this device's guest progress folded in — see the header for which
 * field does what and why. Pure: neither argument is mutated, which matters because the
 * caller still holds `run.meta` and has to be able to fall back to it.
 */
export function mergeGuestIntoAccount(guest: MetaState, account: MetaState): MetaState {
  const materialBank: Record<string, number> = { ...account.materialBank };
  for (const [key, qty] of Object.entries(guest.materialBank)) {
    materialBank[key] = (materialBank[key] ?? 0) + (qty ?? 0);
  }
  // Additive like `materialBank` above, not a union like `unlockedBlueprints` below — a
  // schematic is a stackable count (design/14, ENGINE_VERSION 68), so combining two devices'
  // stock must not collapse "one on each side" into "one total".
  const blueprintStock: Record<string, number> = { ...account.blueprintStock };
  for (const [id, qty] of Object.entries(guest.blueprintStock)) {
    blueprintStock[id] = (blueprintStock[id] ?? 0) + (qty ?? 0);
  }
  return {
    ...account,
    materialBank,
    blueprintStock,
    unlockedBlueprints: union(account.unlockedBlueprints, guest.unlockedBlueprints),
    ownedCharacters: union(account.ownedCharacters, guest.ownedCharacters),
    hasSeenTutorial: account.hasSeenTutorial || guest.hasSeenTutorial,
  };
}
