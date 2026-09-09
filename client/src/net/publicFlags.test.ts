/**
 * The PUBLIC flag contract's parse (design/21 §9's delivery path).
 *
 * `parsePublicFlags` is the client's trust boundary for values that end up on screen and in
 * a decision about whether to draw an ad offer, so every case here is a refusal that has a
 * consequence if it does not happen. The agreement between this module and the server's
 * allowlist is asserted on the SERVER side, where both halves are importable
 * (`server/test/publicFlags.contract.test.ts`) — this file is about what happens to a body
 * that arrives.
 */
import { describe, it, expect } from 'vitest';
import {
  BANNER_MAX_LENGTH,
  PUBLIC_FLAGS_PATH,
  PUBLIC_FLAG_DEFAULTS,
  PUBLIC_FLAG_NAMES,
  isUsableBanner,
  parsePublicFlags,
} from './publicFlags';

/** A complete, valid body — the control every refusal below is a single mutation away from. */
const ok = (over: Record<string, unknown> = {}): unknown => ({
  flags: { 'ads.rewardedOfferEnabled': true, 'ui.maintenanceBanner': '', ...over },
});

describe('the contract itself', () => {
  it('names two flags, and the path the route answers on', () => {
    expect(PUBLIC_FLAG_NAMES).toEqual(['ads.rewardedOfferEnabled', 'ui.maintenanceBanner']);
    expect(PUBLIC_FLAGS_PATH).toBe('/client/flags');
  });

  it('ships an offer that is ON and a banner that is EMPTY', () => {
    // The two defaults are the behaviour of every client that cannot reach the server, so
    // they are the behaviour of every client during an outage. Both are the right way round:
    // an outage must not silently disable the ad offer (which pays), and must not invent a
    // maintenance notice nobody wrote.
    expect(PUBLIC_FLAG_DEFAULTS).toEqual({
      'ads.rewardedOfferEnabled': true,
      'ui.maintenanceBanner': '',
    });
  });
});

describe('parsePublicFlags', () => {
  it('accepts a complete body', () => {
    expect(parsePublicFlags(ok())).toEqual(PUBLIC_FLAG_DEFAULTS);
    expect(parsePublicFlags(ok({ 'ads.rewardedOfferEnabled': false, 'ui.maintenanceBanner': 'back soon' }))).toEqual({
      'ads.rewardedOfferEnabled': false,
      'ui.maintenanceBanner': 'back soon',
    });
  });

  it('accepts the FALSY legitimate values, which a truthiness check would drop', () => {
    // `false` and `''` are both real settings and both falsy. A `if (!source[name])` in the
    // membership loop would refuse the whole body for a flag that is simply turned off.
    const parsed = parsePublicFlags(ok({ 'ads.rewardedOfferEnabled': false, 'ui.maintenanceBanner': '' }));
    expect(parsed).toEqual({ 'ads.rewardedOfferEnabled': false, 'ui.maintenanceBanner': '' });
  });

  it('refuses a body that is not an object carrying a flags object', () => {
    // The shapes a real failure produces: an HTML error page from something in front of the
    // server (parsed to a string or throwing before this is called), a bare array, an empty
    // body, and a `flags` that is not an object.
    for (const body of [null, undefined, 0, 'nope', [], [{ flags: {} }], {}, { flags: null }, { flags: [] }, { flags: 'x' }]) {
      expect(parsePublicFlags(body), JSON.stringify(body) ?? 'undefined').toBeNull();
    }
  });

  it('refuses a body MISSING a name rather than defaulting that one', () => {
    // All-or-nothing (see the module header). The two situations that produce a missing name
    // are a server running older code and a truncated body, and in both "use the default for
    // that one flag" silently reverts a deliberate override while the console shows it set.
    expect(parsePublicFlags({ flags: { 'ads.rewardedOfferEnabled': true } })).toBeNull();
    expect(parsePublicFlags({ flags: { 'ui.maintenanceBanner': 'hi' } })).toBeNull();
    expect(parsePublicFlags({ flags: {} })).toBeNull();
  });

  it('IGNORES a name it does not know, so the server may ship a new flag first', () => {
    // The other half of the ordering rule the module header states. A server that has
    // learned a third public flag must not break every client that has not — otherwise
    // adding a flag would be a synchronised two-workspace deploy.
    expect(parsePublicFlags(ok({ 'ui.somethingNewer': 'x' }))).toEqual(PUBLIC_FLAG_DEFAULTS);
  });

  it('refuses a type mismatch rather than coercing it', () => {
    // `"false"` is the value a hand-edited `ops.db` row produces, and guessing is how it
    // becomes `true`. The server refuses it too; this is the same refusal at the other end.
    for (const v of ['true', 'false', 0, 1, null, {}, []]) {
      expect(parsePublicFlags(ok({ 'ads.rewardedOfferEnabled': v })), String(v)).toBeNull();
    }
    for (const v of [5, true, null, {}, []]) {
      expect(parsePublicFlags(ok({ 'ui.maintenanceBanner': v })), String(v)).toBeNull();
    }
  });

  it('refuses a banner over its cap, at the boundary', () => {
    const atCap = 'x'.repeat(BANNER_MAX_LENGTH);
    expect(parsePublicFlags(ok({ 'ui.maintenanceBanner': atCap }))?.['ui.maintenanceBanner']).toBe(atCap);
    expect(parsePublicFlags(ok({ 'ui.maintenanceBanner': `${atCap}x` }))).toBeNull();
  });

  it('refuses markup and control characters in a banner', () => {
    // The banner goes into a Pixi `Text`, so `<` is not an XSS vector there — but the same
    // string is rendered by the console's HTML table, and a newline in a one-line notice is
    // a layout break. Refusing both at every boundary is what lets four render paths not
    // each remember to escape.
    const NUL = String.fromCharCode(0);
    const DEL = String.fromCharCode(127);
    for (const bad of ['<b>down</b>', 'a<b', 'two\nlines', 'tab\there', `nul${NUL}here`, `del${DEL}here`]) {
      expect(parsePublicFlags(ok({ 'ui.maintenanceBanner': bad })), JSON.stringify(bad)).toBeNull();
    }
  });

  it('accepts the punctuation a real notice needs, so the guard is not refusing every sentence', () => {
    // The control for the case above. Without it, a guard that refused everything would
    // pass every assertion in this file.
    for (const good of ['Back at 14:00 UTC — sorry! (server move)', 'Wartungsarbeiten läuft', '维护中，稍后再来', 'a > b & c']) {
      expect(parsePublicFlags(ok({ 'ui.maintenanceBanner': good })), good).not.toBeNull();
      expect(isUsableBanner(good), good).toBe(true);
    }
  });

  it('refuses an INHERITED property, so a prototype cannot supply a name', () => {
    // `hasOwnProperty` rather than `in`. A `flags` object whose prototype carries
    // `ui.maintenanceBanner` would satisfy an `in` check and then read as whatever the
    // prototype says — and `JSON.parse` cannot produce one, but a caller passing a plain
    // object it built can.
    const proto = { 'ui.maintenanceBanner': 'from the prototype' };
    const flags = Object.create(proto) as Record<string, unknown>;
    flags['ads.rewardedOfferEnabled'] = true;
    expect(parsePublicFlags({ flags })).toBeNull();
  });
});
