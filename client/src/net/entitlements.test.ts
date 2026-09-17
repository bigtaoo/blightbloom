/**
 * net/entitlements (design/19-server-platform.md §2, ROADMAP 8.2) — the client half of
 * server-owned ownership: the wire read, its defensive parse, and the projection onto
 * MetaState's two ownership arrays.
 *
 * Injected `fetch` throughout, same convention as net/auth.test.ts / net/party.test.ts —
 * no network, no msw, no global patching.
 *
 * The parse tests are not paranoia for its own sake. This response now decides what the
 * player owns, and the two things that reach it are (a) a server that may be older or
 * newer than this build and (b) whatever a proxy substitutes on a bad day. `migrate()`
 * distrusts a localStorage save for exactly this reason; the wire deserves the same.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  ACCOUNT_UNAUTHORIZED,
  BLUEPRINT_SKU_PREFIX,
  CHARACTER_SKU_PREFIX,
  ENTITLEMENT_SOURCES,
  entitlementOwnership,
  fetchAccountState,
  parseEntitlements,
  type AccountState,
  type Entitlement,
} from './entitlements';

/** A `fetch` returning one canned JSON response. */
function fakeFetch(body: unknown, init: { status?: number; ok?: boolean } = {}): typeof fetch {
  const status = init.status ?? 200;
  return vi.fn(async () => ({
    ok: init.ok ?? (status >= 200 && status < 300),
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

/** A `fetch` whose body is not JSON at all — a proxy's HTML error page. */
function nonJsonFetch(status: number): typeof fetch {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      throw new SyntaxError('Unexpected token <');
    },
  })) as unknown as typeof fetch;
}

const ent = (sku: string, source: Entitlement['source'] = 'purchase', grantedAt = 1): Entitlement => ({
  sku,
  source,
  grantedAt,
});

describe('entitlementOwnership', () => {
  it('splits the two namespaces into the two MetaState arrays, keeping order', () => {
    expect(
      entitlementOwnership([ent('blueprint:cannon'), ent('character:hero'), ent('blueprint:seeker')]),
    ).toEqual({ unlockedBlueprints: ['cannon', 'seeker'], ownedCharacters: ['hero'] });
  });

  it('skips a SKU in neither namespace rather than throwing', () => {
    // Same rule as the server's `skusToOwnership`: billsvc may later sell something that is
    // neither, and it must not be able to break the Forge for whoever owns one.
    expect(entitlementOwnership([ent('bundle:season1'), ent('character:hero')])).toEqual({
      unlockedBlueprints: [],
      ownedCharacters: ['hero'],
    });
  });

  it('skips a bare prefix with an empty id, in BOTH namespaces', () => {
    expect(entitlementOwnership([ent('blueprint:'), ent('character:')])).toEqual({
      unlockedBlueprints: [],
      ownedCharacters: [],
    });
  });

  it('is empty for an empty list — every account today', () => {
    expect(entitlementOwnership([])).toEqual({ unlockedBlueprints: [], ownedCharacters: [] });
  });

  it('uses the same prefixes the server writes', () => {
    // The one thing that silently breaks if the two sides drift: a typo in either prefix
    // yields "owns nothing" rather than an error, so pin the literals.
    expect(BLUEPRINT_SKU_PREFIX).toBe('blueprint:');
    expect(CHARACTER_SKU_PREFIX).toBe('character:');
  });
});

describe('parseEntitlements', () => {
  it('keeps a well-formed entry verbatim', () => {
    expect(parseEntitlements([{ sku: 'character:hero', source: 'purchase', grantedAt: 42 }])).toEqual([
      { sku: 'character:hero', source: 'purchase', grantedAt: 42 },
    ]);
  });

  it.each(ENTITLEMENT_SOURCES)('accepts source %s', (source) => {
    expect(parseEntitlements([{ sku: 'character:hero', source, grantedAt: 1 }])).toHaveLength(1);
  });

  it.each([
    ['not an array', { sku: 'character:hero' }],
    ['null', null],
    ['undefined (the field is absent)', undefined],
    ['a string', 'character:hero'],
  ])('returns [] when the payload is %s', (_label, raw) => {
    expect(parseEntitlements(raw)).toEqual([]);
  });

  it.each([
    ['a null entry', null],
    ['a bare string entry', 'character:hero'],
    ['a missing sku', { source: 'purchase', grantedAt: 1 }],
    ['an empty sku', { sku: '', source: 'purchase', grantedAt: 1 }],
    ['a non-string sku', { sku: 7, source: 'purchase', grantedAt: 1 }],
    ['a source outside the enum', { sku: 'character:hero', source: 'gift', grantedAt: 1 }],
    ['a non-string source', { sku: 'character:hero', source: 3, grantedAt: 1 }],
  ])('drops %s WITHOUT discarding the valid entries around it', (_label, bad) => {
    const good = { sku: 'blueprint:cannon', source: 'grant', grantedAt: 2 };
    // Position matters: a parser that bailed on the first bad entry would still pass a test
    // that only put the bad one last.
    expect(parseEntitlements([bad, good, bad])).toEqual([good]);
  });

  it('defaults a missing or non-numeric grantedAt to 0 rather than dropping the entitlement', () => {
    // The timestamp is display/audit metadata; losing it must not cost the player the thing
    // they own.
    expect(parseEntitlements([{ sku: 'character:hero', source: 'purchase' }])).toEqual([
      { sku: 'character:hero', source: 'purchase', grantedAt: 0 },
    ]);
    expect(parseEntitlements([{ sku: 'character:hero', source: 'purchase', grantedAt: 'soon' }])[0]!.grantedAt).toBe(0);
  });
});

describe('fetchAccountState', () => {
  it('GETs /account/meta with the bearer token', async () => {
    const doFetch = fakeFetch({ data: null, entitlements: [] });
    await fetchAccountState('http://mm', 'tok-1', { fetch: doFetch });
    expect(doFetch).toHaveBeenCalledWith('http://mm/account/meta', { headers: { authorization: 'Bearer tok-1' } });
  });

  it('returns the blob and the parsed entitlements together — one round trip, not two', async () => {
    const doFetch = fakeFetch({
      data: { materialBank: { mat_fire: 1 } },
      entitlements: [{ sku: 'character:hero', source: 'purchase', grantedAt: 9 }],
    });
    expect(await fetchAccountState('http://mm', 'tok-1', { fetch: doFetch })).toEqual({
      data: { materialBank: { mat_fire: 1 } },
      entitlements: [{ sku: 'character:hero', source: 'purchase', grantedAt: 9 }],
      guestMerged: true,
    });
    expect(doFetch).toHaveBeenCalledTimes(1);
  });

  it('normalizes a brand-new account to { data: null, entitlements: [] }', async () => {
    expect(await fetchAccountState('http://mm', 'tok-1', { fetch: fakeFetch({ data: null, entitlements: [] }) })).toEqual({
      data: null,
      entitlements: [],
      guestMerged: true,
    });
  });

  it('tolerates a pre-8.2 server that answers with no entitlements field at all', async () => {
    // Deployment order is not guaranteed: a new client may reach an old matchsvc, and the
    // answer has to be "owns nothing extra", not a crash on the Forge screen.
    expect(await fetchAccountState('http://mm', 'tok-1', { fetch: fakeFetch({ data: { loadout: [] } }) })).toEqual({
      data: { loadout: [] },
      entitlements: [],
      guestMerged: true,
    });
  });

  it('throws the server error message on an error payload', async () => {
    await expect(
      fetchAccountState('http://mm', 'bad', { fetch: fakeFetch({ error: 'server exploded' }, { status: 500 }) }),
    ).rejects.toThrow('server exploded');
  });

  it('throws on a 2xx body that still carries an error field', async () => {
    await expect(
      fetchAccountState('http://mm', 'tok-1', { fetch: fakeFetch({ error: 'nope' }, { status: 200 }) }),
    ).rejects.toThrow('nope');
  });

  it('throws a clean Error, not a SyntaxError, when a proxy substitutes an HTML error page', async () => {
    // The guard net/auth.ts's own fetchMe/fetchAccountMeta carry, for the same reason: an
    // unguarded res.json() turns a 502 into an unhandled SyntaxError deep in the caller.
    await expect(fetchAccountState('http://mm', 'tok-1', { fetch: nonJsonFetch(502) })).rejects.toThrow(
      'account request failed (502)',
    );
  });

  it('falls back to the global fetch when none is injected — the arm the real app takes', async () => {
    // Every other test here injects, so without this the production path through this
    // function is the one arm no test exercises.
    const global = fakeFetch({ data: null, entitlements: [] });
    vi.stubGlobal('fetch', global);
    try {
      expect(await fetchAccountState('http://mm', 'tok-1')).toEqual({ data: null, entitlements: [], guestMerged: true });
      expect(global).toHaveBeenCalledWith('http://mm/account/meta', { headers: { authorization: 'Bearer tok-1' } });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('drops a malformed entitlement entry rather than failing the whole read', async () => {
    const doFetch = fakeFetch({
      data: null,
      entitlements: [{ sku: 'character:hero', source: 'purchase', grantedAt: 1 }, { sku: 'x', source: 'gift' }],
    });
    const state = await fetchAccountState('http://mm', 'tok-1', { fetch: doFetch });
    expect(state).not.toBe(ACCOUNT_UNAUTHORIZED);
    expect((state as AccountState).entitlements).toEqual([{ sku: 'character:hero', source: 'purchase', grantedAt: 1 }]);
  });
});

/**
 * The 401, as a VALUE (design/16 hole 2, 2026-09-17).
 *
 * This is the whole of what verifies a stored session now, so the distinction it draws is
 * load-bearing in both directions and both are asserted here: a 401 must NOT throw (or the
 * caller's `catch` swallows it back into "keep using local state", which is the 30-day
 * `Hi, {name}` over a dead session), and a network/5xx failure must STILL throw (or the
 * caller signs an offline player out of an account that is perfectly valid).
 */
describe('fetchAccountState — a 401 is the answer, not a failure', () => {
  it('returns ACCOUNT_UNAUTHORIZED on a 401 instead of throwing', async () => {
    const result = await fetchAccountState('http://mm', 'expired', {
      fetch: fakeFetch({ error: 'invalid or expired session' }, { status: 401 }),
    });
    expect(result).toBe(ACCOUNT_UNAUTHORIZED);
  });

  it('reads the 401 off the STATUS, so a proxy HTML body is still a clean sign-out', async () => {
    // A 401 whose body is not JSON would otherwise fall into the guarded `res.json()` and
    // come back as `account request failed (401)` — a throw, which the caller reads as
    // "offline". The player would then keep a dead session indefinitely.
    expect(await fetchAccountState('http://mm', 'expired', { fetch: nonJsonFetch(401) })).toBe(ACCOUNT_UNAUTHORIZED);
  });

  it('still THROWS on a 500, a 502 and a rejected fetch — offline is not logged out', async () => {
    await expect(fetchAccountState('http://mm', 'tok-1', { fetch: nonJsonFetch(500) })).rejects.toThrow();
    await expect(fetchAccountState('http://mm', 'tok-1', { fetch: nonJsonFetch(502) })).rejects.toThrow();
    const dead = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    await expect(fetchAccountState('http://mm', 'tok-1', { fetch: dead })).rejects.toThrow(/Failed to fetch/);
  });
});

/**
 * `guestMerged` and the `x-guest-id` header (design/16 hole 1).
 *
 * Both defaults point at "do not offer a merge", and that is deliberate rather than
 * incidental: not asking costs a guest nothing (their progress stays on the device), while
 * asking a second time costs them a material bank counted twice, with nothing able to tell
 * afterwards. So an absent field, a non-boolean field and a caller that sent no id all read
 * as `true`.
 */
describe('fetchAccountState — the guest-merge question', () => {
  it('sends x-guest-id only when a guestId is supplied', async () => {
    const withId = fakeFetch({ data: null, entitlements: [], guestMerged: false });
    await fetchAccountState('http://mm', 'tok-1', { fetch: withId, guestId: 'install-7' });
    expect(withId).toHaveBeenCalledWith('http://mm/account/meta', {
      headers: { authorization: 'Bearer tok-1', 'x-guest-id': 'install-7' },
    });

    const without = fakeFetch({ data: null, entitlements: [] });
    await fetchAccountState('http://mm', 'tok-1', { fetch: without });
    expect(without).toHaveBeenCalledWith('http://mm/account/meta', { headers: { authorization: 'Bearer tok-1' } });
  });

  it('carries an explicit false through — the one value that opens the question', async () => {
    const state = await fetchAccountState('http://mm', 'tok-1', {
      fetch: fakeFetch({ data: {}, entitlements: [], guestMerged: false }),
      guestId: 'install-7',
    });
    expect((state as AccountState).guestMerged).toBe(false);
  });

  it.each([
    ['absent (a pre-2026-09-17 server)', {}],
    ['a string', { guestMerged: 'no' }],
    ['null', { guestMerged: null }],
  ])('reads %s as true — do not ask', async (_name, extra) => {
    const state = await fetchAccountState('http://mm', 'tok-1', {
      fetch: fakeFetch({ data: {}, entitlements: [], ...extra }),
      guestId: 'install-7',
    });
    expect((state as AccountState).guestMerged).toBe(true);
  });
});
