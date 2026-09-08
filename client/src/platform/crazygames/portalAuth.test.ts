/**
 * `portalAuth.ts` — the silent login a game portal requires and the credential form it
 * forbids (design/20 "account integration").
 *
 * Driven against a plain object in place of the SDK's user module and an injected exchange,
 * so no network and no portal domain is involved. Two properties get most of the attention
 * here, because both are invisible on a live page:
 *
 * - **Every failure ends as a guest.** No SDK, accounts unavailable, a guest, no token, a
 *   401, our own server down: all of them leave a fully playable session-less player, and
 *   each is a separate case below rather than one "it does not throw".
 * - **A stored session belongs to a PLAYER, not to a browser.** A web-game portal is a
 *   shared-machine environment. The cases where the portal says "somebody else" or "nobody"
 *   are the ones that stop player B inheriting player A's account.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PortalAuth } from './portalAuth';
import type { CrazyGamesSdk } from './sdk';
import type { CgSdkShape } from './sdk';
import { getSession, setSession } from '../../net/session';
import { notifySessionChanged, onSessionChanged, resetSessionEvents } from '../sessionEvents';

type UserApi = CgSdkShape['user'];

/** Yield to a macrotask, which flushes every pending microtask behind it. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

const ADA = { userId: 'u-1', username: 'Ada' };
const RESULT = { accountId: 'acct-1', username: 'Ada', token: 'our-session-token' };

/** A user module whose answers each case sets, plus a hook to fire the auth listener. */
function userHost(over: Partial<Record<keyof NonNullable<UserApi>, unknown>> = {}) {
  const listeners: ((u: unknown) => void)[] = [];
  const api = {
    isUserAccountAvailable: async () => true,
    getUser: async () => ADA,
    getUserToken: async () => 'portal.user.token',
    addAuthListener: (l: (u: unknown) => void) => void listeners.push(l),
    removeAuthListener: (l: (u: unknown) => void) => void listeners.splice(listeners.indexOf(l), 1),
    ...over,
  } as NonNullable<UserApi>;
  return {
    sdk: { userApi: () => api } as unknown as CrazyGamesSdk,
    listeners,
    fire: async (u: unknown) => {
      listeners.forEach((l) => l(u));
      // The listener kicks off an exchange it cannot hand back (the SDK's own callback
      // signature returns nothing), so this drains the microtask queue by yielding to a
      // macrotask — several awaits deep, and counting them here would be counting
      // implementation steps.
      await flush();
    },
  };
}

let notified = 0;
let stopWatching: () => void;

beforeEach(() => {
  setSession(null);
  resetSessionEvents();
  notified = 0;
  stopWatching = onSessionChanged(() => {
    notified += 1;
  });
});

afterEach(() => {
  stopWatching();
  setSession(null);
  resetSessionEvents();
});

describe('PortalAuth.start — a signed-in portal player', () => {
  it('exchanges the portal token for one of our sessions, and announces it', async () => {
    const host = userHost();
    const exchange = vi.fn(async () => RESULT);
    const auth = new PortalAuth({ sdk: host.sdk, baseUrl: 'https://svc', exchange });
    await auth.start();

    expect(exchange).toHaveBeenCalledWith('https://svc', 'portal.user.token');
    expect(getSession()).toEqual({ ...RESULT, origin: 'portal', providerId: 'u-1' });
    expect(notified).toBe(1);
  });

  it('records the portal user and the session in diagnostics', async () => {
    const host = userHost();
    const auth = new PortalAuth({ sdk: host.sdk, baseUrl: 'https://svc', exchange: async () => RESULT });
    await auth.start();
    expect(auth.diagnostics()).toEqual({
      available: true,
      portalUser: 'Ada',
      session: 'Ada',
      lastError: null,
    });
  });

  it('does not re-exchange for the SAME player on a later visit', async () => {
    // The session is already this player's, from a previous visit. Spending a token round
    // trip on it would be a request per boot for no answer we do not already have.
    setSession({ ...RESULT, origin: 'portal', providerId: 'u-1' });
    const host = userHost();
    const exchange = vi.fn(async () => RESULT);
    const auth = new PortalAuth({ sdk: host.sdk, baseUrl: 'https://svc', exchange });
    await auth.start();
    expect(exchange).not.toHaveBeenCalled();
    expect(getSession()?.token).toBe('our-session-token');
    expect(notified).toBe(0);
  });

  it('refreshes a name the player changed on the portal, without an exchange', async () => {
    setSession({ ...RESULT, username: 'OldName', origin: 'portal', providerId: 'u-1' });
    const host = userHost();
    const exchange = vi.fn(async () => RESULT);
    const auth = new PortalAuth({ sdk: host.sdk, baseUrl: 'https://svc', exchange });
    await auth.start();
    expect(exchange).not.toHaveBeenCalled();
    expect(getSession()?.username).toBe('Ada');
    expect(notified).toBe(1); // the menu label has to be redrawn
  });

  it('DOES exchange when the stored session belongs to a different portal player', async () => {
    // Someone else used this browser. Their session must not become this player's.
    setSession({ accountId: 'acct-9', username: 'Grace', token: 'graces-token', origin: 'portal', providerId: 'u-9' });
    const host = userHost();
    const exchange = vi.fn(async () => RESULT);
    const auth = new PortalAuth({ sdk: host.sdk, baseUrl: 'https://svc', exchange });
    await auth.start();
    expect(exchange).toHaveBeenCalledTimes(1);
    expect(getSession()).toMatchObject({ accountId: 'acct-1', providerId: 'u-1' });
  });

  it('DOES exchange when the stored session was typed in rather than granted', async () => {
    // No `origin`, i.e. a `LoginScreen` session from a build that has one. It is not this
    // portal player's, so it is replaced rather than trusted.
    setSession({ accountId: 'acct-7', username: 'Typed', token: 'typed-token' });
    const host = userHost();
    const exchange = vi.fn(async () => RESULT);
    await new PortalAuth({ sdk: host.sdk, baseUrl: 'https://svc', exchange }).start();
    expect(exchange).toHaveBeenCalledTimes(1);
  });
});

describe('PortalAuth.start — every way to end up a guest', () => {
  const guestCases: [string, Partial<Record<keyof NonNullable<UserApi>, unknown>>][] = [
    ['the account module is unavailable on this domain', { isUserAccountAvailable: async () => false }],
    ['the player is not logged in on the portal', { getUser: async () => null }],
    ['getUser rejects', { getUser: async () => { throw new Error('disabled'); } }],
    ['no user token comes back', { getUserToken: async () => null }],
    ['getUserToken rejects', { getUserToken: async () => { throw new Error('userNotAuthenticated'); } }],
  ];

  for (const [name, over] of guestCases) {
    it(`leaves no session when ${name}`, async () => {
      const host = userHost(over);
      const exchange = vi.fn(async () => RESULT);
      const auth = new PortalAuth({ sdk: host.sdk, baseUrl: 'https://svc', exchange });
      await auth.start();
      expect(getSession()).toBeNull();
    });
  }

  it('leaves no session when the exchange itself fails, and says why', async () => {
    const host = userHost();
    const auth = new PortalAuth({
      sdk: host.sdk,
      baseUrl: 'https://svc',
      exchange: async () => {
        throw new Error('invalid portal token');
      },
    });
    await auth.start();
    expect(getSession()).toBeNull();
    // The one state worth having an instrument for: the portal says this player is signed
    // in and we are not holding a session for them.
    expect(auth.diagnostics()).toEqual({
      available: true,
      portalUser: 'Ada',
      session: null,
      lastError: 'invalid portal token',
    });
  });

  it('records a non-Error rejection as a string rather than losing it', async () => {
    const host = userHost();
    const auth = new PortalAuth({
      sdk: host.sdk,
      baseUrl: 'https://svc',
      exchange: async () => {
        throw 'a bare string';
      },
    });
    await auth.start();
    expect(auth.diagnostics().lastError).toBe('a bare string');
  });

  it('records "no user token" distinctly from an exchange failure', async () => {
    const host = userHost({ getUserToken: async () => null });
    const auth = new PortalAuth({ sdk: host.sdk, baseUrl: 'https://svc', exchange: async () => RESULT });
    await auth.start();
    expect(auth.diagnostics().lastError).toBe('no user token');
  });

  it('reports unavailable, and never asks who the player is', async () => {
    const getUser = vi.fn(async () => ADA);
    const host = userHost({ isUserAccountAvailable: async () => false, getUser });
    const auth = new PortalAuth({ sdk: host.sdk, baseUrl: 'https://svc', exchange: async () => RESULT });
    await auth.start();
    expect(auth.diagnostics().available).toBe(false);
    expect(getUser).not.toHaveBeenCalled();
    // ...and it did not subscribe either: there is nothing to hear from.
    expect(host.listeners).toHaveLength(0);
  });

  it('works with no user module at all', async () => {
    const sdk = { userApi: () => undefined } as unknown as CrazyGamesSdk;
    const auth = new PortalAuth({ sdk, baseUrl: 'https://svc', exchange: async () => RESULT });
    await expect(auth.start()).resolves.toBeUndefined();
    expect(getSession()).toBeNull();
  });
});

describe('PortalAuth — dropping a session that is no longer this player’s', () => {
  it('clears a portal session when the portal reports nobody', async () => {
    setSession({ ...RESULT, origin: 'portal', providerId: 'u-1' });
    const host = userHost({ getUser: async () => null });
    await new PortalAuth({ sdk: host.sdk, baseUrl: 'https://svc', exchange: async () => RESULT }).start();
    expect(getSession()).toBeNull();
    expect(notified).toBe(1);
  });

  it('clears a portal session when the module goes unavailable', async () => {
    setSession({ ...RESULT, origin: 'portal', providerId: 'u-1' });
    const host = userHost({ isUserAccountAvailable: async () => false });
    await new PortalAuth({ sdk: host.sdk, baseUrl: 'https://svc', exchange: async () => RESULT }).start();
    expect(getSession()).toBeNull();
  });

  it('NEVER clears a session the player typed a password for', async () => {
    // The guard that keeps this code safe to run on a build that has a login screen. No
    // target ships that combination today, and this is what stops it being the reason one
    // cannot.
    const typed = { accountId: 'acct-7', username: 'Typed', token: 'typed-token' };
    setSession(typed);
    const host = userHost({ getUser: async () => null });
    await new PortalAuth({ sdk: host.sdk, baseUrl: 'https://svc', exchange: async () => RESULT }).start();
    expect(getSession()).toEqual(typed);
    expect(notified).toBe(0);
  });

  it('announces nothing when there was no session to clear', async () => {
    const host = userHost({ getUser: async () => null });
    await new PortalAuth({ sdk: host.sdk, baseUrl: 'https://svc', exchange: async () => RESULT }).start();
    expect(notified).toBe(0);
  });
});

describe('PortalAuth — a login that happens while the game is running', () => {
  it('exchanges when the portal reports a login mid-session', async () => {
    const host = userHost({ getUser: async () => null });
    const exchange = vi.fn(async () => RESULT);
    const auth = new PortalAuth({ sdk: host.sdk, baseUrl: 'https://svc', exchange });
    await auth.start();
    expect(getSession()).toBeNull();

    await host.fire(ADA);
    expect(exchange).toHaveBeenCalledTimes(1);
    expect(getSession()).toMatchObject({ providerId: 'u-1' });
  });

  it('clears the session when the portal reports a logout mid-session', async () => {
    const host = userHost();
    const auth = new PortalAuth({ sdk: host.sdk, baseUrl: 'https://svc', exchange: async () => RESULT });
    await auth.start();
    expect(getSession()).not.toBeNull();

    await host.fire(null);
    expect(getSession()).toBeNull();
  });

  it('stop() unsubscribes, so a later portal event changes nothing', async () => {
    const host = userHost({ getUser: async () => null });
    const exchange = vi.fn(async () => RESULT);
    const auth = new PortalAuth({ sdk: host.sdk, baseUrl: 'https://svc', exchange });
    await auth.start();
    auth.stop();
    expect(host.listeners).toHaveLength(0);
    await host.fire(ADA);
    expect(exchange).not.toHaveBeenCalled();
  });

  it('stop() is safe before start, and twice', () => {
    const auth = new PortalAuth({ sdk: userHost().sdk, baseUrl: 'https://svc', exchange: async () => RESULT });
    expect(() => {
      auth.stop();
      auth.stop();
    }).not.toThrow();
  });

  it('serialises two exchanges that overlap, leaving the LAST one holding the session', async () => {
    // `addAuthListener` can fire while the boot exchange is still in flight. Two concurrent
    // exchanges racing to write `net/session.ts` is the bug this guards, and the observable
    // is which session survives.
    const host = userHost({ getUser: async () => null });
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => {
      releaseFirst = r;
    });
    let call = 0;
    const exchange = vi.fn(async () => {
      const n = ++call;
      order.push(`start:${n}`);
      if (n === 1) await firstGate;
      order.push(`end:${n}`);
      return { ...RESULT, accountId: `acct-${n}`, token: `token-${n}` };
    });
    const auth = new PortalAuth({ sdk: host.sdk, baseUrl: 'https://svc', exchange });
    await auth.start();

    // Two logins, back to back, with the first exchange still open.
    const a = host.fire({ userId: 'u-A', username: 'A' });
    const b = host.fire({ userId: 'u-B', username: 'B' });
    releaseFirst();
    await a;
    await b;
    await flush();

    expect(order).toEqual(['start:1', 'end:1', 'start:2', 'end:2']);
    expect(getSession()?.token).toBe('token-2');
  });

  it('keeps working after a failed exchange — a rejection does not poison the queue', async () => {
    const host = userHost({ getUser: async () => null });
    let attempt = 0;
    const exchange = vi.fn(async () => {
      if (++attempt === 1) throw new Error('server down');
      return RESULT;
    });
    const auth = new PortalAuth({ sdk: host.sdk, baseUrl: 'https://svc', exchange });
    await auth.start();

    await host.fire(ADA);
    expect(getSession()).toBeNull();
    await host.fire(ADA);
    expect(getSession()).toMatchObject({ providerId: 'u-1' });
    expect(auth.diagnostics().lastError).toBeNull();
  });
});

describe('PortalAuth — the default exchange', () => {
  it('is the real /auth/portal call when none is injected', async () => {
    // A default nothing exercises is a default nobody has checked, and this one is the whole
    // network half of the feature: an `exchange` that was wired to the wrong route would be
    // invisible to every case above, all of which inject their own.
    const host = userHost();
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      calls.push(String(url));
      return { ok: true, status: 200, json: async () => RESULT } as Response;
    }) as typeof fetch;
    try {
      await new PortalAuth({ sdk: host.sdk, baseUrl: 'https://svc' }).start();
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(calls).toEqual(['https://svc/auth/portal']);
    expect(getSession()).toMatchObject({ accountId: 'acct-1', origin: 'portal', providerId: 'u-1' });
  });
});

describe('PortalAuth.diagnostics — before anything has run', () => {
  it('reports the honest empty state rather than a guess', () => {
    const auth = new PortalAuth({ sdk: userHost().sdk, baseUrl: 'https://svc', exchange: async () => RESULT });
    expect(auth.diagnostics()).toEqual({ available: false, portalUser: null, session: null, lastError: null });
  });

  it('reports a session it did not create — the state a stale storage entry produces', () => {
    setSession({ ...RESULT, origin: 'portal', providerId: 'u-1' });
    const auth = new PortalAuth({ sdk: userHost().sdk, baseUrl: 'https://svc', exchange: async () => RESULT });
    expect(auth.diagnostics().session).toBe('Ada');
    // Deliberately NOT reported as a portal user: nobody has asked the portal yet, and
    // saying otherwise would make the "signed in on the portal, not signed in here" state
    // unreadable.
    expect(auth.diagnostics().portalUser).toBeNull();
  });
});

describe('the notification is the seam the game reacts through', () => {
  it('reaches a subscriber that registered AFTER the login resolved', async () => {
    // `sessionEvents.ts`'s stickiness, exercised through the real login path rather than
    // through the registry directly — this is the ordering a portal boot actually produces.
    stopWatching();
    resetSessionEvents();
    const host = userHost();
    await new PortalAuth({ sdk: host.sdk, baseUrl: 'https://svc', exchange: async () => RESULT }).start();

    const late = vi.fn();
    stopWatching = onSessionChanged(late);
    expect(late).toHaveBeenCalledTimes(1);
    // ...and nothing further is pending afterwards.
    const later = vi.fn();
    const off = onSessionChanged(later);
    expect(later).not.toHaveBeenCalled();
    off();
    notifySessionChanged();
    expect(late).toHaveBeenCalledTimes(2);
  });
});
