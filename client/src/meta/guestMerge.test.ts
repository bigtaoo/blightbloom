/**
 * The one-time device merge, pure half (design/16-accounts.md hole 1, closed 2026-09-17).
 *
 * The three functions here are small, and the reason they are worth their own suite is that
 * every one of them is a decision about somebody's saved progress. `hasGuestProgress` decides
 * whether a modal appears at all; `guestMergeOffer` decides the numbers the player reads off
 * it; `mergeGuestIntoAccount` decides what they keep. The failures are correspondingly quiet
 * — a prompt that never appears, a count that understates what is at stake, a bank that is
 * added twice — so each case below asserts the thing that would otherwise be invisible.
 */
import { describe, it, expect } from 'vitest';
import { STARTER_BLUEPRINTS } from '@dd/engine';
import { defaultMetaState, FREE_CHARACTERS, type MetaState } from './MetaState';
import { guestMergeOffer, hasGuestProgress, mergeGuestIntoAccount } from './guestMerge';

const state = (over: Partial<MetaState> = {}): MetaState => ({ ...defaultMetaState(), ...over });

describe('hasGuestProgress', () => {
  it('is false for a state that is exactly what every new player is handed', () => {
    // The case that decides whether the confirmation screen is noise. `defaultMetaState`
    // pre-unlocks the starter blueprints and the whole free roster, and `migrate()` re-unions
    // both on every load — so measuring "progress" against emptiness instead of against a
    // fresh account would put a two-button modal in front of every player on earth, offering
    // to merge nothing into nothing.
    expect(hasGuestProgress(defaultMetaState())).toBe(false);
  });

  it.each([
    ['a banked material', { materialBank: { mat_fire: 1 } }],
    ['a staged loadout', { loadout: ['smg'] }],
    ['a blueprint beyond the starters', { unlockedBlueprints: [...STARTER_BLUEPRINTS, 'cryobolt'] }],
    ['a character beyond the free roster', { ownedCharacters: [...FREE_CHARACTERS, 'paid_hero'] }],
    ['a banked schematic (design/14, ENGINE_VERSION 68)', { blueprintStock: { flamer: 1 } }],
  ])('is true for %s', (_name, over) => {
    expect(hasGuestProgress(state(over))).toBe(true);
  });

  it('is false for a blueprintStock entry whose quantity is zero', () => {
    // Same shape as the empty-bank case above: a zero-qty key can exist in the record
    // (e.g. left behind by a craft that spent the last one) without meaning "progress".
    expect(hasGuestProgress(state({ blueprintStock: { flamer: 0 } }))).toBe(false);
  });

  it.each([
    ['a chosen character', { selectedSkin: 'someone_else' }],
    ['a finished tutorial', { hasSeenTutorial: true }],
  ])('is false for %s — a preference is not progress', (_name, over) => {
    // Both of these differ from `defaultMetaState`, so a naive deep-compare would call them
    // progress and raise a modal about a badge and a dropdown.
    expect(hasGuestProgress(state(over))).toBe(false);
  });

  it('counts a bank key whose quantity is missing as nothing, not as NaN', () => {
    // `materialBank` is a plain record and a present-but-undefined value is representable
    // (the same fallback `PortalPrompt.totalCarryOut` needs). Without the `?? 0` the total is
    // NaN, `NaN > 0` is false, and a player with a real bank is silently offered nothing.
    const bank = { mat_fire: undefined, mat_ice: 4 } as unknown as Record<string, number>;
    expect(hasGuestProgress(state({ materialBank: bank }))).toBe(true);
    expect(guestMergeOffer(state({ materialBank: bank }), defaultMetaState()).materials).toBe(4);
  });

  it('counts a blueprintStock key whose quantity is missing as nothing, not as NaN', () => {
    // Same `?? 0` fallback as the materialBank case above, for the newer field.
    const stock = { flamer: undefined, spear: 2 } as unknown as Record<string, number>;
    expect(hasGuestProgress(state({ blueprintStock: stock }))).toBe(true);
    expect(guestMergeOffer(state({ blueprintStock: stock }), defaultMetaState()).blueprints).toBe(2);
  });
});

describe('guestMergeOffer', () => {
  it('counts the whole guest bank and only the ownership the account LACKS', () => {
    // The numbers are what the player is choosing between, so they have to be the delta, not
    // the total: an account that already owns a blueprint has nothing to gain from it, and
    // counting it would overstate what pressing COMBINE buys.
    const guest = state({
      materialBank: { mat_fire: 5, 'mat_ice@2': 3 },
      unlockedBlueprints: [...STARTER_BLUEPRINTS, 'cryobolt', 'cannon'],
      ownedCharacters: [...FREE_CHARACTERS, 'paid_hero'],
    });
    const account = state({
      materialBank: { mat_fire: 100 },
      unlockedBlueprints: [...STARTER_BLUEPRINTS, 'cannon'],
      ownedCharacters: [...FREE_CHARACTERS, 'paid_hero'],
    });
    expect(guestMergeOffer(guest, account)).toEqual({ materials: 8, blueprints: 1, characters: 0 });
  });

  it('is all zeroes when the account already holds everything the guest does', () => {
    const account = state({ unlockedBlueprints: [...STARTER_BLUEPRINTS, 'cryobolt'] });
    expect(guestMergeOffer(defaultMetaState(), account)).toEqual({ materials: 0, blueprints: 0, characters: 0 });
  });

  it('folds banked schematics into the blueprints count, on top of unlocked-only deltas (design/14)', () => {
    // `blueprintStock` (a boss-drop schematic, ENGINE_VERSION 68) reads to a player as
    // "a blueprint-ish thing this merge would bring over" exactly like an unlocked
    // permanent — one combined number, not a second count on the confirmation screen.
    const guest = state({
      unlockedBlueprints: [...STARTER_BLUEPRINTS, 'cryobolt'],
      blueprintStock: { flamer: 2, spear: 1 },
    });
    expect(guestMergeOffer(guest, defaultMetaState()).blueprints).toBe(4); // 1 unlocked + 3 schematics
  });

  it('counts every schematic, even for a weapon the account already holds permanently', () => {
    // A schematic is stackable count, not membership (unlike unlockedBlueprints) — so it
    // is never subtracted against what the account already owns, only summed.
    const guest = state({ blueprintStock: { cryobolt: 3 } });
    const account = state({ unlockedBlueprints: [...STARTER_BLUEPRINTS, 'cryobolt'] });
    expect(guestMergeOffer(guest, account).blueprints).toBe(3);
  });
});

describe('mergeGuestIntoAccount', () => {
  const guest = state({
    materialBank: { mat_fire: 5, mat_ice: 2 },
    unlockedBlueprints: [...STARTER_BLUEPRINTS, 'cryobolt'],
    blueprintStock: { flamer: 1, spear: 2 },
    ownedCharacters: [...FREE_CHARACTERS, 'guest_hero'],
    loadout: ['guest_smg'],
    selectedSkin: 'guest_skin',
    hasSeenTutorial: true,
  });
  const account = state({
    materialBank: { mat_fire: 10, mat_poison: 1 },
    unlockedBlueprints: [...STARTER_BLUEPRINTS, 'cannon'],
    blueprintStock: { flamer: 3, scattergun: 1 },
    ownedCharacters: [...FREE_CHARACTERS, 'account_hero'],
    loadout: ['account_rifle'],
    selectedSkin: 'account_skin',
    hasSeenTutorial: false,
  });

  it('ADDS the material bank per key, keeping keys only one side has', () => {
    // The durable half of the whole mechanism: the bank is what a guest accumulates and what
    // `POST /account/meta` stores verbatim. A union (rather than a sum) would silently drop
    // whichever side was smaller on a shared key.
    expect(mergeGuestIntoAccount(guest, account).materialBank).toEqual({ mat_fire: 15, mat_ice: 2, mat_poison: 1 });
  });

  it('ADDS blueprintStock per key, keeping keys only one side has (design/14, ENGINE_VERSION 68)', () => {
    // Additive like materialBank, NOT a union like unlockedBlueprints below — a schematic
    // is a stackable count, so combining two devices' stock must not collapse "one on
    // each side" into "one total" (that would lose real progress a guest earned).
    expect(mergeGuestIntoAccount(guest, account).blueprintStock).toEqual({ flamer: 4, spear: 2, scattergun: 1 });
  });

  it('UNIONS blueprints and characters, with no duplicates', () => {
    const merged = mergeGuestIntoAccount(guest, account);
    expect(merged.unlockedBlueprints).toContain('cryobolt');
    expect(merged.unlockedBlueprints).toContain('cannon');
    expect(merged.ownedCharacters).toContain('guest_hero');
    expect(merged.ownedCharacters).toContain('account_hero');
    expect(new Set(merged.unlockedBlueprints).size).toBe(merged.unlockedBlueprints.length);
    expect(new Set(merged.ownedCharacters).size).toBe(merged.ownedCharacters.length);
  });

  it('keeps the ACCOUNT\'s loadout and character — two staged choices cannot be added', () => {
    // "The account is the truth afterwards" has to mean something, and this is where it
    // means it. A loadout is a choice for the next run, not an accumulation.
    const merged = mergeGuestIntoAccount(guest, account);
    expect(merged.loadout).toEqual(['account_rifle']);
    expect(merged.selectedSkin).toBe('account_skin');
  });

  it('ORs hasSeenTutorial — it is guest-local by definition', () => {
    // `MetaState` documents this field as account-independent, so a player who has already
    // been through the tutorial on this browser must not be recommended it again by a fresh
    // account. Asserted in both directions, because taking the account's value would pass an
    // assertion in one of them by accident.
    expect(mergeGuestIntoAccount(guest, account).hasSeenTutorial).toBe(true);
    expect(mergeGuestIntoAccount(state({ hasSeenTutorial: false }), state({ hasSeenTutorial: true })).hasSeenTutorial).toBe(true);
    expect(mergeGuestIntoAccount(state({ hasSeenTutorial: false }), state({ hasSeenTutorial: false })).hasSeenTutorial).toBe(false);
  });

  it('mutates neither argument — the caller still needs the local copy to fall back to', () => {
    // `OnlineMatch.resolveAccountMeta` decides whether to APPLY the merge after computing it
    // (the claim can be lost to another tab), so a merge that wrote into `run.meta` on the
    // way past would have already double-counted the bank by the time it was rejected.
    const localBefore = JSON.stringify(guest);
    const remoteBefore = JSON.stringify(account);
    mergeGuestIntoAccount(guest, account);
    expect(JSON.stringify(guest)).toBe(localBefore);
    expect(JSON.stringify(account)).toBe(remoteBefore);
  });

  it('treats a present-but-undefined guest quantity as zero rather than NaN', () => {
    const bank = { mat_fire: undefined } as unknown as Record<string, number>;
    const merged = mergeGuestIntoAccount(state({ materialBank: bank }), state({ materialBank: { mat_fire: 3 } }));
    expect(merged.materialBank['mat_fire']).toBe(3);
  });

  it('treats a present-but-undefined guest schematic quantity as zero rather than NaN', () => {
    const stock = { flamer: undefined } as unknown as Record<string, number>;
    const merged = mergeGuestIntoAccount(state({ blueprintStock: stock }), state({ blueprintStock: { flamer: 3 } }));
    expect(merged.blueprintStock['flamer']).toBe(3);
  });
});
