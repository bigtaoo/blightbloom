/**
 * `hostKind` — the declared-host module.
 *
 * The value of a test here is not the getter/setter but the DEFAULT: everything that reads
 * this module changes behaviour when the answer is `crazygames`, and every one of those
 * modules is also loaded by the other two entry points and by every unit test in the suite.
 * So "nothing that fails to opt in is affected" is the property, and it is worth pinning.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { getHostKind, isPortalHost, resetHostKind, setHostKind, type HostKind } from './hostKind';
// The same three names as a VALUE, which this module only has as a type. `analyticsEvents`
// owns the runtime list because the server imports it too, and its own comment says it
// matches `HostKind` — the sweep below is where that agreement is actually exercised.
import { HOSTS } from '../net/analyticsEvents';

afterEach(() => resetHostKind());

describe('hostKind', () => {
  it('defaults to the plain web host', () => {
    expect(getHostKind()).toBe('web');
    expect(isPortalHost()).toBe(false);
  });

  it('records what an entry point declares', () => {
    setHostKind('crazygames');
    expect(getHostKind()).toBe('crazygames');
    expect(isPortalHost()).toBe(true);
  });

  it('does not treat the mini-game as a portal', () => {
    // WeChat is a third-party host too, but not in the sense this predicate means: its
    // restrictions are already handled by its own platform implementation and by
    // `storePlatform`'s `wx` branch. Widening `isPortalHost` to cover it would silently
    // change the mini-game's main menu to quick-play.
    setHostKind('wechat');
    expect(isPortalHost()).toBe(false);
  });

  it('can be asked about a kind other than the current one', () => {
    // The parameterised form is what lets `storePlatform.detectStorePlatform` stay a pure
    // function of its arguments and keep its "reachable from a plain object" property.
    expect(isPortalHost('crazygames')).toBe(true);
    expect(isPortalHost('web')).toBe(false);
    expect(getHostKind()).toBe('web'); // ...and asking does not set anything
  });

  it('reset restores the default', () => {
    setHostKind('crazygames');
    resetHostKind();
    expect(getHostKind()).toBe('web');
  });
});

describe('every entry point declares its own host', () => {
  // The sweep exists because a single-entry check only exists where somebody thought of it,
  // and this is the bug that proves the difference (found 2026-09-09): `main.wechat.ts` had
  // no `setHostKind` call and a comment asserting it needed none, so the mini-game ran as
  // `web` for as long as that entry has existed.
  //
  // It was harmless while `isPortalHost` was the only reader — false either way — and stopped
  // being harmless the moment `wx.request` gave that host a way to send anything, because
  // `clientLog` does not SWITCH on this value, it LABELS a batch with it, and the server
  // turns that label into a Loki stream. A missing declaration is then not a no-op falling
  // back to a safe default; it is every WeChat failure filed under `web` and `host="wechat"`
  // matching nothing, forever, with nothing red anywhere.
  //
  // So the default is for tests and tools, not something an entry point may rely on — which
  // is why `main.ts` states `web` too even though it would get it anyway. A source-order
  // assertion because there is no way to observe a boot ordering from inside a module (the
  // same technique `render/wechatPhasedBoot.test.ts` uses for the asset phases).
  const ENTRIES: ReadonlyArray<[string, HostKind]> = [
    ['main.ts', 'web'],
    ['main.wechat.ts', 'wechat'],
    ['main.crazygames.ts', 'crazygames'],
  ];

  for (const [entry, kind] of ENTRIES) {
    it(`${entry} declares ${kind}, before it installs the logger`, () => {
      const src = readFileSync(new URL(`../${entry}`, import.meta.url), 'utf8');
      const declare = src.indexOf(`setHostKind('${kind}')`);
      const log = src.indexOf('installClientLog({');
      expect(declare, `${entry}: no setHostKind('${kind}') call`).toBeGreaterThan(-1);
      expect(log, `${entry}: no installClientLog call`).toBeGreaterThan(-1);
      expect(declare, `${entry}: the host is declared after the logger reads it`).toBeLessThan(log);
    });
  }

  it('names every host exactly once across the three entries', () => {
    // The other half of the same gap: a copy-pasted entry point declaring somebody else's
    // host is a wrong label rather than a missing one, and reads identically in the store.
    const declared = ENTRIES.map(([entry]) => {
      const src = readFileSync(new URL(`../${entry}`, import.meta.url), 'utf8');
      return HOSTS.filter((h) => src.includes(`setHostKind('${h}')`));
    });
    expect(declared).toEqual([['web'], ['wechat'], ['crazygames']]);
  });
});
