/**
 * `hostKind` — the declared-host module.
 *
 * The value of a test here is not the getter/setter but the DEFAULT: everything that reads
 * this module changes behaviour when the answer is `crazygames`, and every one of those
 * modules is also loaded by the other two entry points and by every unit test in the suite.
 * So "nothing that fails to opt in is affected" is the property, and it is worth pinning.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { getHostKind, isPortalHost, resetHostKind, setHostKind } from './hostKind';

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
