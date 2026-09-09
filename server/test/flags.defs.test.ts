/**
 * The feature-flag ALLOWLIST (design/21 §4, decision C1).
 *
 * ## Why this file pins the exact set of names
 *
 * C1's danger is not one wrong flip. It is that the SET of things a flag can reach grows
 * one plausible entry at a time until it includes something that should never have been
 * remotely reachable — an auth decision, billsvc's dev-stub mode, a validation at a trust
 * boundary. A code comment cannot stop that. What can is an exact-set assertion: adding a
 * flag fails this suite, and the only way past it is to edit this file, which means saying
 * out loud in a review which side of C1's line the new one falls on.
 *
 * So the first case here is deliberately the kind of test that would normally be a smell —
 * a restatement of a literal. It is the mechanism, not a check.
 *
 * ## And why the FORBIDDEN half is a pattern test rather than a list
 *
 * A list of forbidden names would be a list somebody has to have thought of. The pattern
 * test below catches the shapes instead: a flag whose name contains `auth`, `stub`,
 * `verify`, `secret`, `key`, `password` or `admin` is refused outright, because none of the
 * legitimate categories §4 names would ever produce one, and every prohibited category
 * would.
 */
import { describe, it, expect } from 'vitest';
import {
  FLAG_DEFS,
  FLAG_NAMES,
  coerceFlag,
  defaultFlags,
  isFlagName,
  type FlagName,
} from '../src/flags/defs';

describe('the allowlist', () => {
  it('is EXACTLY these four names', () => {
    // The mechanism (see the file header). If this fails because you added a flag: say in
    // the commit message which of §4's legitimate categories it is, and confirm it is
    // neither an auth decision, nor anything reaching billsvc's dev-stub mode, nor a
    // validation at a trust boundary.
    expect(FLAG_NAMES).toEqual([
      'ads.rewardedOfferEnabled',
      'match.pvpBotBackfillDelayMs',
      'match.queueTimeoutMs',
      'ui.maintenanceBanner',
    ]);
  });

  it('has no flag whose NAME is in a category C1 forbids', () => {
    // Shapes rather than a list, because a list is a list of things somebody thought of.
    const forbidden = /auth|login|session|token|stub|verif|secret|\bkey\b|password|admin|bypass|disable.*check/i;
    for (const name of FLAG_NAMES) expect(name, `${name} looks like something C1 forbids`).not.toMatch(forbidden);
  });

  it('declares a help line, a consumer and a delivery state for every flag', () => {
    for (const name of FLAG_NAMES) {
      const def = FLAG_DEFS[name] as { help: string; consumer: string; delivered: boolean };
      expect(def.help.length, name).toBeGreaterThan(20);
      expect(def.consumer.length, name).toBeGreaterThan(5);
      expect(typeof def.delivered, name).toBe('boolean');
    }
  });

  it('records which flags have NO consumer yet, rather than pretending they do', () => {
    // The gap building Phase C found: §4's delivery mechanism is an `x-internal-key`
    // endpoint, which a browser cannot call and must never be able to — so the two
    // client-facing flags have a row, a control and nothing on the other end. A switch that
    // looks live and changes nothing is the worst thing an ops panel can contain, so the
    // state is in the TYPE and on the page. This test is what stops it being quietly
    // "fixed" by flipping the boolean instead of building the path.
    const undelivered = FLAG_NAMES.filter((n) => !(FLAG_DEFS[n] as { delivered: boolean }).delivered);
    expect(undelivered).toEqual(['ads.rewardedOfferEnabled', 'ui.maintenanceBanner']);
    for (const name of undelivered) {
      expect((FLAG_DEFS[name] as { consumer: string }).consumer).toMatch(/client/);
    }
  });

  it('gives every number flag a declared range', () => {
    // A flag with no bounds and a way to set the queue timeout to a year are the same
    // thing. `coerceFlag` refuses a number flag with no range outright, so this is the test
    // that keeps that refusal from being reachable in production.
    for (const name of FLAG_NAMES) {
      const def = FLAG_DEFS[name] as { default: unknown; range?: { min: number; max: number } };
      if (typeof def.default !== 'number') continue;
      expect(def.range, name).toBeDefined();
      expect(def.range!.min, name).toBeLessThan(def.range!.max);
      expect(def.default, name).toBeGreaterThanOrEqual(def.range!.min);
      expect(def.default, name).toBeLessThanOrEqual(def.range!.max);
    }
  });

  it('gives every string flag a length cap', () => {
    for (const name of FLAG_NAMES) {
      const def = FLAG_DEFS[name] as { default: unknown; maxLength?: number };
      if (typeof def.default !== 'string') continue;
      expect(def.maxLength, name).toBeGreaterThan(0);
    }
  });

  it('has no object- or array-valued flag', () => {
    // `FlagValue` is three primitives on purpose: a JSON-shaped flag is a config file with
    // no schema, and the next person to add one would be adding a remote code path rather
    // than a remote switch.
    for (const name of FLAG_NAMES) {
      expect(['boolean', 'number', 'string'], name).toContain(typeof FLAG_DEFS[name].default);
    }
  });
});

describe('defaultFlags', () => {
  it('returns every name with its declared default', () => {
    const defaults = defaultFlags();
    expect(Object.keys(defaults).sort()).toEqual([...FLAG_NAMES].sort());
    for (const name of FLAG_NAMES) expect(defaults[name], name).toBe(FLAG_DEFS[name].default);
  });

  it('returns a FRESH object each time', () => {
    // A shared object would let one service's poll result mutate another's view, and — worse
    // — a mutation would outlive the failure that produced it, so "keeps its compiled-in
    // default" would stop being true after the first bad poll.
    const a = defaultFlags();
    const b = defaultFlags();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});

describe('isFlagName', () => {
  it('accepts every allowlisted name and nothing else', () => {
    for (const name of FLAG_NAMES) expect(isFlagName(name)).toBe(true);
    expect(isFlagName('nope')).toBe(false);
    expect(isFlagName('')).toBe(false);
    expect(isFlagName('MATCH.QUEUETIMEOUTMS')).toBe(false);
  });

  it('refuses an inherited Object property', () => {
    // `name in FLAG_DEFS` would answer TRUE for `toString`, `constructor` and `__proto__`,
    // and `setFlag` would then write a row for it. `hasOwnProperty` is what makes the
    // allowlist a set rather than a prototype chain.
    for (const key of ['toString', 'constructor', '__proto__', 'valueOf', 'hasOwnProperty']) {
      expect(isFlagName(key), key).toBe(false);
    }
  });
});

describe('coerceFlag', () => {
  const BOOL = 'ads.rewardedOfferEnabled' satisfies FlagName;
  const NUM = 'match.queueTimeoutMs' satisfies FlagName;
  const STR = 'ui.maintenanceBanner' satisfies FlagName;

  it('accepts a correctly-typed value', () => {
    expect(coerceFlag(BOOL, false)).toBe(false);
    expect(coerceFlag(NUM, 60_000)).toBe(60_000);
    expect(coerceFlag(STR, 'back in ten minutes')).toBe('back in ten minutes');
    // The three falsy legitimate values, each of which a truthiness check would drop.
    expect(coerceFlag(BOOL, false)).toBe(false);
    expect(coerceFlag(STR, '')).toBe('');
    expect(coerceFlag('match.pvpBotBackfillDelayMs', 0)).toBe(0);
  });

  it('refuses a type mismatch rather than guessing', () => {
    // A boolean flag arriving as `"false"` is a row somebody wrote by hand at a `sqlite3`
    // prompt. Guessing is how `"false"` becomes `true`.
    expect(coerceFlag(BOOL, 'false')).toBeNull();
    expect(coerceFlag(BOOL, 0)).toBeNull();
    expect(coerceFlag(BOOL, null)).toBeNull();
    expect(coerceFlag(NUM, '60000')).toBeNull();
    expect(coerceFlag(NUM, true)).toBeNull();
    expect(coerceFlag(STR, 5)).toBeNull();
    expect(coerceFlag(STR, null)).toBeNull();
    expect(coerceFlag(STR, undefined)).toBeNull();
  });

  it('refuses a number outside its declared range, at both ends', () => {
    const range = FLAG_DEFS[NUM].range;
    expect(coerceFlag(NUM, range.min)).toBe(range.min);
    expect(coerceFlag(NUM, range.max)).toBe(range.max);
    expect(coerceFlag(NUM, range.min - 1)).toBeNull();
    expect(coerceFlag(NUM, range.max + 1)).toBeNull();
  });

  it('refuses NaN and both infinities', () => {
    // `queueTimeoutMs: Infinity` passes a `>= min` check and is a queue that never times
    // out; `NaN` fails every comparison and would sail through a `!(v < min)` guard.
    expect(coerceFlag(NUM, Number.NaN)).toBeNull();
    expect(coerceFlag(NUM, Number.POSITIVE_INFINITY)).toBeNull();
    expect(coerceFlag(NUM, Number.NEGATIVE_INFINITY)).toBeNull();
  });

  it('refuses a string over its cap, at the boundary', () => {
    const max = FLAG_DEFS[STR].maxLength;
    expect(coerceFlag(STR, 'x'.repeat(max))).toBe('x'.repeat(max));
    expect(coerceFlag(STR, 'x'.repeat(max + 1))).toBeNull();
  });

  it('refuses a control character and a markup character in a string flag', () => {
    // The maintenance banner is the one flag a player sees. Text that cannot contain markup
    // is one fewer thing for four render paths to remember to escape, and a newline is how
    // a fake log record gets in.
    expect(coerceFlag(STR, 'line one\nline two')).toBeNull();
    expect(coerceFlag(STR, 'tab\there')).toBeNull();
    expect(coerceFlag(STR, 'nul\u0000here')).toBeNull();
    expect(coerceFlag(STR, '<script>alert(1)</script>')).toBeNull();
    // ...while ordinary punctuation, accents and an em dash are fine, so the guard is not
    // quietly refusing every real sentence.
    expect(coerceFlag(STR, 'Back at 14:00 UTC — sorry! (server move)')).not.toBeNull();
    expect(coerceFlag(STR, 'Wartungsarbeiten läuft')).not.toBeNull();
  });
});
