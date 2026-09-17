/**
 * Client auth calls (design/16-accounts.md). Fake-fetch driven, mirrors
 * party.test.ts's style — the server's own AuthService.test.ts owns the real
 * register/login/session behavior; this just pins the client's request/response shapes.
 *
 * `fetchMe` and `fetchAccountMeta` were tested here until 2026-09-17 and are gone with the
 * functions: both had zero production callers, which is what made design/16's hole 2 — a
 * stored token nothing ever verified — invisible. Their cases passing was never evidence
 * that anything checked a session, and that is the shape worth remembering: a green test
 * over a function nobody calls measures the test, not the product. The check that replaced
 * them is `net/entitlements.ts`'s 401-as-a-value, on a route the boot path already calls.
 */
import { describe, it, expect, vi } from 'vitest';
import { register, login, portalLogin, logout, changePassword, claimGuestMerge, saveAccountMeta } from './auth';

const RESULT = { accountId: 'acct-1', username: 'alice', token: 'tok-1' };

function fakeFetch(status: number, body: unknown) {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({ ok: status < 400, status, json: async () => body }) as Response);
}

describe('auth client calls', () => {
  it('register posts username+password and returns the session', async () => {
    const fetch = fakeFetch(200, RESULT);
    const result = await register('http://mm', 'alice', 'hunter22', { fetch });
    expect(result).toEqual(RESULT);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('http://mm/auth/register');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ username: 'alice', password: 'hunter22' });
  });

  it('register rejects with the server error message', async () => {
    const fetch = fakeFetch(400, { error: 'username already taken' });
    await expect(register('http://mm', 'alice', 'hunter22', { fetch })).rejects.toThrow(/already taken/);
  });

  it('login posts username+password and returns the session', async () => {
    const fetch = fakeFetch(200, RESULT);
    const result = await login('http://mm', 'alice', 'hunter22', { fetch });
    expect(result).toEqual(RESULT);
  });

  it('login rejects on wrong credentials', async () => {
    const fetch = fakeFetch(401, { error: 'invalid username or password' });
    await expect(login('http://mm', 'alice', 'wrong', { fetch })).rejects.toThrow(/invalid/);
  });

  it('portalLogin posts the PORTAL token under `token`, and returns OUR session', async () => {
    // The two tokens in one request (design/20 "account integration"): the body carries the
    // platform's RS256 user token, the response carries this server's opaque session. A
    // wiring mistake here reads as "login silently does nothing" on a live portal page.
    const fetch = fakeFetch(200, RESULT);
    const result = await portalLogin('http://mm', 'cg.user.token', { fetch });
    expect(result).toEqual(RESULT);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('http://mm/auth/portal');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ token: 'cg.user.token' });
    // No bearer header: the portal token is the credential being presented, in the body.
    expect((init as RequestInit).headers).toEqual({ 'content-type': 'application/json' });
  });

  it('portalLogin rejects with the reason, so a caller can record which failure it was', async () => {
    // 401 and 503 mean different things to `portalAuth.ts` (a bad token vs. we could not
    // check), and both have to arrive as a message rather than as a bare failure.
    await expect(
      portalLogin('http://mm', 'bad', { fetch: fakeFetch(401, { error: 'invalid portal token' }) }),
    ).rejects.toThrow(/invalid portal token/);
    await expect(
      portalLogin('http://mm', 'ok', { fetch: fakeFetch(503, { error: 'portal verification key unavailable' }) }),
    ).rejects.toThrow(/key unavailable/);
  });

  it('logout posts the token', async () => {
    const fetch = fakeFetch(200, { ok: true });
    await logout('http://mm', 'tok-1', { fetch });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('http://mm/auth/logout');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ token: 'tok-1' });
  });

  it('changePassword posts token+old+new', async () => {
    const fetch = fakeFetch(200, { ok: true });
    await changePassword('http://mm', 'tok-1', 'old', 'newpassword1', { fetch });
    const [, init] = fetch.mock.calls[0]!;
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ token: 'tok-1', oldPassword: 'old', newPassword: 'newpassword1' });
  });

  it('saveAccountMeta posts the data with a bearer token', async () => {
    const fetch = fakeFetch(200, { ok: true });
    await saveAccountMeta('http://mm', 'tok-1', { unlockedBlueprints: ['a'] }, { fetch });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('http://mm/account/meta');
    expect((init as RequestInit).headers).toMatchObject({ authorization: 'Bearer tok-1' });
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ data: { unlockedBlueprints: ['a'] } });
  });
});

/**
 * `claimGuestMerge` (design/16 hole 1) — the one-time device merge's idempotency key.
 *
 * Its whole contract is the boolean, and the two arms of it mean opposite things to the
 * caller: `true` is "apply the merge you just offered", `false` is "another tab answered
 * first, take the account's state unchanged". A call that reported `true` twice would add a
 * material bank the account already holds, with nothing afterwards able to tell.
 */
describe('claimGuestMerge', () => {
  it('posts the guest id with a bearer token, and returns the claim', async () => {
    const fetch = fakeFetch(200, { claimed: true });
    expect(await claimGuestMerge('http://mm', 'tok-1', 'install-7', { fetch })).toBe(true);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('http://mm/account/guest-merge');
    expect((init as RequestInit).headers).toMatchObject({ authorization: 'Bearer tok-1' });
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ guestId: 'install-7' });
  });

  it('returns false — not an error — when the device was already claimed', async () => {
    // A second tab, or a second login on the same browser. Ordinary, and the caller's
    // correct response to it is to keep the account's state rather than to retry.
    const fetch = fakeFetch(200, { claimed: false });
    expect(await claimGuestMerge('http://mm', 'tok-1', 'install-7', { fetch })).toBe(false);
  });

  it('rejects on a 401 rather than reporting an unclaimed device as claimed', async () => {
    const fetch = fakeFetch(401, { error: 'invalid or expired session' });
    await expect(claimGuestMerge('http://mm', 'bogus', 'install-7', { fetch })).rejects.toThrow(/invalid/);
  });
});

/** A response whose body genuinely isn't JSON — e.g. a proxy's HTML error page in
 * front of a 502/504 — so `res.json()` itself rejects with a SyntaxError. */
function fakeFetchNonJsonBody(status: number) {
  const json = async (): Promise<never> => {
    throw new SyntaxError('Unexpected token < in JSON');
  };
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({ ok: status < 400, status, json }) as unknown as Response);
}

describe('auth client calls — non-JSON error bodies (a proxy 502/504 HTML page, not a real API response)', () => {
  it('claimGuestMerge throws a clean Error instead of an unhandled SyntaxError', async () => {
    const fetch = fakeFetchNonJsonBody(502);
    await expect(claimGuestMerge('http://mm', 'tok-1', 'install-7', { fetch })).rejects.toThrow(/auth request failed \(502\)/);
  });

  it('every other auth call already had this guard via call() — confirms the same shape applies here too', async () => {
    const fetch = fakeFetchNonJsonBody(500);
    await expect(login('http://mm', 'alice', 'hunter22', { fetch })).rejects.toThrow(/auth request failed \(500\)/);
  });
});
