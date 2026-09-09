/**
 * The PUBLIC flag contract (design/21 §9's delivery path) — does the server's allowlist
 * agree with the module the CLIENT compiles its own defaults from?
 *
 * ## Why this file exists at all, when both halves are typed
 *
 * `publicFlagValues` is written as an explicit literal precisely so that a name added to
 * `PublicFlags` and forgotten is a compile error. That covers the SHAPE. It does not cover
 * the MARKER: nothing in the type system connects `public: true` in `FLAG_DEFS` to
 * membership of `PublicFlags`, so a flag could be marked public and never served, or served
 * and never marked — and the second of those is the one that matters, because
 * `FlagDef.public` is what the console renders as the "this value is published" pill and
 * what a reviewer reads when deciding whether a new flag may go out to browsers.
 *
 * So the marker set and the contract set are asserted equal in BOTH directions. One
 * direction alone is the classic half-guard: `every public flag is in the contract` passes
 * happily while the contract carries a flag nobody marked, and vice versa.
 *
 * ## And why the DEFAULTS are asserted too, when they are one literal
 *
 * They are one literal today — `FLAG_DEFS` imports `PUBLIC_FLAG_DEFAULTS`. This asserts the
 * relationship rather than the values, so it survives somebody "tidying" that import away
 * into a copy of the number. A client and a server that disagree about a default disagree
 * about what the game does with no flag set, which is the state almost every player is in.
 */
import { describe, it, expect } from 'vitest';
import {
  FLAG_DEFS,
  FLAG_NAMES,
  PUBLIC_FLAG_NAMES_FROM_DEFS,
  coerceFlag,
  defaultFlags,
  publicFlagValues,
  type FlagDef,
  type FlagName,
} from '../src/flags/defs';
import {
  BANNER_MAX_LENGTH,
  PUBLIC_FLAG_DEFAULTS,
  PUBLIC_FLAG_NAMES,
  isUsableBanner,
  parsePublicFlags,
} from '@dd/net/publicFlags';

describe('the public marker and the client contract', () => {
  it('name the SAME set of flags, in both directions', () => {
    expect([...PUBLIC_FLAG_NAMES_FROM_DEFS].sort()).toEqual([...PUBLIC_FLAG_NAMES].sort());
  });

  it('is exactly the two client-facing flags, and NOT the two matchmaking timings', () => {
    // Pinned as a literal for the reason `flags.defs.test.ts` pins the allowlist: adding a
    // flag to a PUBLIC surface should fail a test and be argued in a review, not happen as
    // a side effect of adding a flag. The negative half is the point — publishing
    // `match.pvpBotBackfillDelayMs` would tell a player which of their opponents was not a
    // person.
    expect([...PUBLIC_FLAG_NAMES].sort()).toEqual(['ads.rewardedOfferEnabled', 'ui.maintenanceBanner']);
    expect(PUBLIC_FLAG_NAMES_FROM_DEFS).not.toContain('match.pvpBotBackfillDelayMs');
    expect(PUBLIC_FLAG_NAMES_FROM_DEFS).not.toContain('match.queueTimeoutMs');
  });

  it('agrees on every public flag\'s default and its TYPE', () => {
    for (const name of PUBLIC_FLAG_NAMES) {
      const def = FLAG_DEFS[name as FlagName];
      expect(def.default, name).toBe(PUBLIC_FLAG_DEFAULTS[name]);
      expect(typeof def.default, name).toBe(typeof PUBLIC_FLAG_DEFAULTS[name]);
    }
  });

  it('agrees on the banner cap, so neither side accepts what the other refuses', () => {
    expect(FLAG_DEFS['ui.maintenanceBanner'].maxLength).toBe(BANNER_MAX_LENGTH);
    // The consequence, driven through both validators at the boundary rather than asserted
    // as an equality of two numbers: a value the server stores that the client refuses is a
    // banner set in the console and invisible in the game, with nothing anywhere saying why.
    const atCap = 'x'.repeat(BANNER_MAX_LENGTH);
    expect(coerceFlag('ui.maintenanceBanner', atCap)).toBe(atCap);
    expect(isUsableBanner(atCap)).toBe(true);
    const overCap = 'x'.repeat(BANNER_MAX_LENGTH + 1);
    expect(coerceFlag('ui.maintenanceBanner', overCap)).toBeNull();
    expect(isUsableBanner(overCap)).toBe(false);
  });

  it('refuses the same TEXT on both sides — markup, newline, control character', () => {
    // One regex, imported by the server rather than copied, so this asserts the sharing
    // rather than a coincidence. Driven through both entry points anyway: `coerceFlag` is
    // what the console's write path calls and `isUsableBanner` is what the browser calls,
    // and it is their agreement — not the constant's identity — that keeps a stored banner
    // from being silently dropped on arrival.
    for (const bad of ['<b>down</b>', 'two\nlines', 'tab\there', 'nul\u0000byte']) {
      expect(coerceFlag('ui.maintenanceBanner', bad), bad).toBeNull();
      expect(isUsableBanner(bad), bad).toBe(false);
    }
    for (const good of ['Back at 14:00 UTC — sorry!', 'Wartungsarbeiten läuft', '']) {
      expect(coerceFlag('ui.maintenanceBanner', good), good).not.toBeNull();
      expect(isUsableBanner(good), good).toBe(true);
    }
  });
});

describe('publicFlagValues', () => {
  it('carries every public flag and NOTHING else', () => {
    const projected = publicFlagValues(defaultFlags());
    expect(Object.keys(projected).sort()).toEqual([...PUBLIC_FLAG_NAMES].sort());
    // The absence assertion, because `toMatchObject` and a key-by-key loop are both subset
    // checks: an extra key would be invisible to either, and an extra key here is a private
    // flag leaking onto an unauthenticated route. The equality above is what catches it.
    for (const name of FLAG_NAMES) {
      if (PUBLIC_FLAG_NAMES.includes(name as never)) continue;
      expect(Object.prototype.hasOwnProperty.call(projected, name), name).toBe(false);
    }
  });

  it('carries the values it was given, not the defaults', () => {
    // A projection that reached for `FLAG_DEFS[name].default` instead of its argument would
    // pass every assertion above and serve the shipped value to every browser forever, with
    // the console showing the override as applied. That is the whole failure mode of a
    // delivery path, so it gets its own case.
    const projected = publicFlagValues({
      ...defaultFlags(),
      'ads.rewardedOfferEnabled': false,
      'ui.maintenanceBanner': 'back in ten',
    });
    expect(projected).toEqual({
      'ads.rewardedOfferEnabled': false,
      'ui.maintenanceBanner': 'back in ten',
    });
  });

  it('produces something the CLIENT\'s own parser accepts, wrapped as the wire sends it', () => {
    // The end of the round trip, in one assertion: the server's projection, the wire
    // envelope, and the client's all-or-nothing parse. If a name is ever dropped from the
    // projection, this is what goes red — `parsePublicFlags` returns null for an incomplete
    // response, so the failure would otherwise be every browser silently on its defaults.
    const values = { ...defaultFlags(), 'ui.maintenanceBanner': 'scheduled restart 03:00 UTC' };
    const parsed = parsePublicFlags({ flags: publicFlagValues(values) });
    expect(parsed).toEqual({
      'ads.rewardedOfferEnabled': true,
      'ui.maintenanceBanner': 'scheduled restart 03:00 UTC',
    });
  });
});

describe('every flag declares its visibility deliberately', () => {
  it('defaults to PRIVATE — an absent marker is not public', () => {
    // `public` is optional, so the question is what an absent one means. It must mean
    // private, because the alternative is a new flag being published by omission.
    for (const name of FLAG_NAMES) {
      const def = FLAG_DEFS[name] as FlagDef;
      const isPublic = PUBLIC_FLAG_NAMES_FROM_DEFS.includes(name);
      expect(isPublic, name).toBe(def.public === true);
    }
    expect(FLAG_DEFS['match.queueTimeoutMs'] as FlagDef).not.toHaveProperty('public');
  });

  it('marks a public flag delivered, since publishing IS the delivery', () => {
    // The two states could disagree — a flag could be marked public and not delivered — and
    // that combination is meaningless: `GET /client/flags` serves whatever is marked, so a
    // marked flag is being delivered whether or not anything reads it. Asserting it here
    // keeps the console's `not delivered` badge from ever appearing on a row that is
    // simultaneously labelled `public`.
    for (const name of PUBLIC_FLAG_NAMES_FROM_DEFS) {
      expect((FLAG_DEFS[name] as FlagDef).delivered, name).toBe(true);
    }
  });
});
