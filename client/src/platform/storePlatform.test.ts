/**
 * The store's platform gate.
 *
 * This is the one file in the purchase feature whose failure mode is not a bad UX but a
 * store rejection: a web checkout inside an iOS build breaks App Store rule 3.1.1, and a
 * WeChat mini-game may not open an external one either. So every case here is written as
 * "on this host, does the entry exist at all", and the host is a plain object — the same
 * feature-detection-with-an-injected-host shape `replayDownload.ts` uses, for the same
 * reason: the answer has to be assertable without being on the platform.
 */
import { describe, it, expect } from 'vitest';
import { resetHostKind, setHostKind } from './hostKind';
import { detectStorePlatform, isWebStoreHost, type StoreHost } from './storePlatform';

const WEB: StoreHost = { document: {}, fetch: () => {}, location: { search: '' } };

describe('isWebStoreHost', () => {
  it('is true for a browser: a DOM and a real fetch', () => {
    expect(isWebStoreHost(WEB)).toBe(true);
  });

  it('is FALSE whenever `wx` exists, DOM shims and all', () => {
    // The trap this check exists for, and why the `wx` test runs FIRST and unconditionally:
    // the mini-game runtime injects DOM-shaped compat objects for libraries that probe for
    // them (`gameQueryParams.ts` records the same trap with its always-empty
    // `location.search`), so "has a document" alone answers `true` there.
    expect(isWebStoreHost({ ...WEB, wx: {} })).toBe(false);
    expect(isWebStoreHost({ wx: { getSystemInfoSync: () => {} } })).toBe(false);
  });

  it('is false without a fetch — the three store routes ARE fetch calls', () => {
    expect(isWebStoreHost({ document: {} })).toBe(false);
    expect(isWebStoreHost({ document: {}, fetch: 'not a function' })).toBe(false);
  });

  it('is false without a document', () => {
    expect(isWebStoreHost({ fetch: () => {} })).toBe(false);
    expect(isWebStoreHost({ document: null, fetch: () => {} })).toBe(false);
  });

  it('is false for a bare object — node, a worker, a test runner', () => {
    expect(isWebStoreHost({})).toBe(false);
  });
});

describe('detectStorePlatform', () => {
  it('returns the web processor on a browser', () => {
    expect(detectStorePlatform(WEB)).toBe('stripe');
  });

  it('returns NULL on the mini-game runtime — the entry must not exist there', () => {
    // Not "returns a platform that then refuses". The caller renders nothing at all, which
    // is what `Forge.storeEnabled` is for.
    expect(detectStorePlatform({ ...WEB, wx: {} })).toBeNull();
  });

  it('returns null on any host that is not a browser', () => {
    expect(detectStorePlatform({})).toBeNull();
    expect(detectStorePlatform({ document: {} })).toBeNull();
  });

  it('opts a web session into the dev stub on `?store=dev`', () => {
    // The only platform whose payment block ever comes back `configured: true` — and the
    // only way to walk create → pay → webhook → delivered locally.
    expect(detectStorePlatform({ ...WEB, location: { search: '?store=dev' } })).toBe('dev');
    expect(detectStorePlatform({ ...WEB, location: { search: '?pvp=1&store=dev&perf=1' } })).toBe('dev');
  });

  it('does NOT let the dev opt-in cross the platform gate', () => {
    // A query param cannot buy its way onto a host that may not sell. (No mini-game can
    // carry one anyway — this pins the ORDER of the two checks, not a reachable URL.)
    expect(detectStorePlatform({ ...WEB, wx: {}, location: { search: '?store=dev' } })).toBeNull();
  });

  it.each(['', '?store=', '?store=stripe', '?storedev=1', '?other=dev'])(
    'ignores a search string that is not the opt-in (%s)',
    (search) => {
      expect(detectStorePlatform({ ...WEB, location: { search } })).toBe('stripe');
    },
  );

  it('survives a host with a location that carries no search at all', () => {
    // The mini-game's compat `location` shape, minus the `wx` that would have caught it —
    // this is the guard being a property of the function rather than of the caller.
    expect(detectStorePlatform({ document: {}, fetch: () => {}, location: {} })).toBe('stripe');
    expect(detectStorePlatform({ document: {}, fetch: () => {} })).toBe('stripe');
  });
});

describe('detectStorePlatform — the game-portal host', () => {
  // The one host this file cannot feature-detect. A CrazyGames page is an ordinary Chrome in
  // an iframe: it has a `document`, it has `fetch`, and it has no `wx`, so every probe here
  // answers exactly as it does on our own domain. What differs is permission, not capability
  // — in-game purchases there are limited to invited games and must go through the
  // platform's own Xsolla account, so a checkout of ours is the same "steering the player
  // elsewhere" the iOS branch already refuses.

  it('sells nothing on a portal host', () => {
    expect(detectStorePlatform(WEB, 'crazygames')).toBeNull();
  });

  it('refuses even with the dev opt-in in the URL', () => {
    // Ordering again: a query param must not buy its way onto a host that may not sell.
    expect(detectStorePlatform({ ...WEB, location: { search: '?store=dev' } }, 'crazygames')).toBeNull();
  });

  it('still sells on the same runtime when the host is not declared a portal', () => {
    // The control this pair needs to mean anything: the host object is IDENTICAL in both
    // cases, so the only thing that changed the answer is the declaration.
    expect(detectStorePlatform(WEB, 'web')).toBe('stripe');
  });

  it('defaults to the process-wide declaration when none is passed', () => {
    expect(detectStorePlatform(WEB)).toBe('stripe');
    setHostKind('crazygames');
    try {
      expect(detectStorePlatform(WEB)).toBeNull();
    } finally {
      resetHostKind();
    }
  });
});
