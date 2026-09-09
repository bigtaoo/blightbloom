/**
 * The console's session cookie: the store's expiry arithmetic, and the two string formats.
 *
 * The clock is a parameter everywhere in `session.ts`, so every case here is a plain
 * function call with a fixed `now` — no timers, no `vi.useFakeTimers`, and an expiry test
 * that does not take eight hours.
 */
import { describe, it, expect } from 'vitest';
import {
  ADMIN_COOKIE,
  ADMIN_COOKIE_PATH,
  AdminSessionStore,
  clearCookieHeader,
  cookieHeader,
  readCookie,
} from '../src/adminsvc/session';

const T0 = 1_757_000_000_000;

describe('AdminSessionStore', () => {
  it('mints a 64-hex token that validates, and a different one each time', () => {
    const store = new AdminSessionStore(1000);
    const a = store.create(T0);
    const b = store.create(T0);
    expect(a.token).toMatch(/^[0-9a-f]{64}$/);
    expect(a.token).not.toBe(b.token);
    expect(store.valid(a.token, T0)).toBe(true);
    expect(store.valid(b.token, T0)).toBe(true);
  });

  it('refuses an unknown token and an undefined one', () => {
    const store = new AdminSessionStore(1000);
    expect(store.valid('f'.repeat(64), T0)).toBe(false);
    expect(store.valid(undefined, T0)).toBe(false);
  });

  it('expires exactly AT the TTL, not one millisecond after', () => {
    // `<=` rather than `<` in `valid`. A boundary test on both sides, because an off-by-one
    // here is a session that outlives its own cookie's `Max-Age` — the browser stops
    // sending it and the server would still honour a copy.
    const store = new AdminSessionStore(1000);
    const session = store.create(T0);
    expect(store.valid(session.token, T0 + 999)).toBe(true);
    expect(store.valid(session.token, T0 + 1000)).toBe(false);
  });

  it('DELETES an expired session on the way to refusing it, so a backwards clock cannot revive it', () => {
    // The property, not the implementation: after one expired read the token is gone, so
    // asking again with an earlier `now` still refuses. Without the delete, a clock that
    // stepped back (an NTP correction, a container restart on a box with a bad RTC) would
    // hand a lapsed session back.
    const store = new AdminSessionStore(1000);
    const session = store.create(T0);
    expect(store.valid(session.token, T0 + 5000)).toBe(false);
    expect(store.size()).toBe(0);
    expect(store.valid(session.token, T0)).toBe(false);
  });

  it('sweeps lapsed sessions when a new one is created', () => {
    // The map is swept on write rather than on a timer (a timer would keep the process
    // alive or need `unref`). Observed through `size`, because inferring it from `valid`
    // would be satisfied by the lazy delete above and prove nothing about the sweep.
    const store = new AdminSessionStore(1000);
    store.create(T0);
    store.create(T0);
    expect(store.size()).toBe(2);
    store.create(T0 + 2000);
    expect(store.size()).toBe(1);
  });

  it('keeps a live session when a new one is created', () => {
    // The control for the sweep above: a sweep that deleted everything would pass that
    // test too.
    const store = new AdminSessionStore(10_000);
    const first = store.create(T0);
    store.create(T0 + 1);
    expect(store.size()).toBe(2);
    expect(store.valid(first.token, T0 + 1)).toBe(true);
  });

  it('revokes, and revoking is idempotent and undefined-safe', () => {
    const store = new AdminSessionStore(1000);
    const session = store.create(T0);
    store.revoke(session.token);
    expect(store.valid(session.token, T0)).toBe(false);
    expect(() => store.revoke(session.token)).not.toThrow();
    expect(() => store.revoke(undefined)).not.toThrow();
    expect(store.size()).toBe(0);
  });

  it('defaults its TTL when none is given', () => {
    const store = new AdminSessionStore();
    const session = store.create(T0);
    expect(session.expiresAtMs).toBe(T0 + 8 * 60 * 60 * 1000);
  });
});

describe('cookieHeader', () => {
  it('carries HttpOnly, SameSite=Strict, the scoped path, and Secure', () => {
    const header = cookieHeader({ token: 'a'.repeat(64), expiresAtMs: T0 + 3600_000 }, T0, true);
    expect(header).toContain(`${ADMIN_COOKIE}=${'a'.repeat(64)}`);
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Strict');
    expect(header).toContain('Secure');
    expect(header).toContain(`Path=${ADMIN_COOKIE_PATH}`);
    expect(header).toContain('Max-Age=3600');
  });

  it('scopes the path to /admin and NOT to the whole site', () => {
    // The one attribute chosen for something other than its own security: a `Path=/` cookie
    // would ride along on every `POST /client/events` and every `/find` poll, because the
    // game and the console are one origin behind Caddy.
    expect(ADMIN_COOKIE_PATH).toBe('/admin');
    expect(cookieHeader({ token: 'b'.repeat(64), expiresAtMs: T0 }, T0, true)).not.toContain('Path=/;');
  });

  it('omits Secure only when told to', () => {
    const header = cookieHeader({ token: 'c'.repeat(64), expiresAtMs: T0 + 1000 }, T0, false);
    expect(header).not.toContain('Secure');
    expect(header).toContain('HttpOnly');
  });

  it('floors Max-Age at zero for a session already past its expiry', () => {
    // Not reachable through the login (a fresh session is always in the future) and pinned
    // anyway: a negative `Max-Age` is not a smaller number, it is a DIFFERENT instruction —
    // browsers treat it as "delete now" — so a clock skew would silently log the operator
    // straight back out with no error anywhere.
    expect(cookieHeader({ token: 'd'.repeat(64), expiresAtMs: T0 - 5000 }, T0, true)).toContain('Max-Age=0');
  });
});

describe('clearCookieHeader', () => {
  it('empties the value, zeroes the age, and keeps the SAME path', () => {
    // A clear whose `Path` does not match the one that set the cookie leaves the original
    // in place — the classic way a logout button does nothing at all.
    const header = clearCookieHeader(true);
    expect(header).toContain(`${ADMIN_COOKIE}=;`);
    expect(header).toContain('Max-Age=0');
    expect(header).toContain(`Path=${ADMIN_COOKIE_PATH}`);
    expect(header).toContain('Secure');
    expect(clearCookieHeader(false)).not.toContain('Secure');
  });
});

describe('readCookie', () => {
  const token = 'e'.repeat(64);

  it('finds the token among other cookies, in any position', () => {
    expect(readCookie(`${ADMIN_COOKIE}=${token}`)).toBe(token);
    expect(readCookie(`other=1; ${ADMIN_COOKIE}=${token}; third=x`)).toBe(token);
    expect(readCookie(`${ADMIN_COOKIE}=${token}; other=1`)).toBe(token);
  });

  it('tolerates whitespace around the name and the value', () => {
    expect(readCookie(`  ${ADMIN_COOKIE} = ${token} `)).toBe(token);
  });

  it('returns undefined for absent, non-string, empty and valueless forms', () => {
    expect(readCookie(undefined)).toBeUndefined();
    expect(readCookie(['a=1'])).toBeUndefined();
    expect(readCookie('')).toBeUndefined();
    expect(readCookie('other=1')).toBeUndefined();
    expect(readCookie(`${ADMIN_COOKIE}=`)).toBeUndefined();
    expect(readCookie(ADMIN_COOKIE)).toBeUndefined();
  });

  it('refuses anything that is not 64 lowercase hex', () => {
    // The shape check is what keeps a hostile cookie value from reaching the session map as
    // a key at all: the token is minted here as 64 hex characters, so there is no legitimate
    // value with a `;`, a quote or upper case in it.
    expect(readCookie(`${ADMIN_COOKIE}=${token.slice(0, 63)}`)).toBeUndefined();
    expect(readCookie(`${ADMIN_COOKIE}=${token}f`)).toBeUndefined();
    expect(readCookie(`${ADMIN_COOKIE}=${'E'.repeat(64)}`)).toBeUndefined();
    expect(readCookie(`${ADMIN_COOKIE}=<script>`)).toBeUndefined();
  });

  it('does not match a cookie whose name merely CONTAINS ours', () => {
    // `bb_admin_other=…` and `x_bb_admin=…` are different cookies. A `startsWith` or an
    // `includes` here would read a value somebody else set.
    expect(readCookie(`${ADMIN_COOKIE}_other=${token}`)).toBeUndefined();
    expect(readCookie(`x_${ADMIN_COOKIE}=${token}`)).toBeUndefined();
  });
});
