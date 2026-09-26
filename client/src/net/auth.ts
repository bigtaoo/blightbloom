/**
 * Client auth calls (design/16-accounts.md) — thin wrapper over matchsvc's `/auth/*`
 * and `/account/*` routes, same injected-fetch shape as `net/party.ts`/`matchmaking.ts`
 * so this is unit-testable without a network.
 *
 * ## Two functions that used to live here, deleted 2026-09-17 (design/16 hole 2)
 *
 * `fetchMe` (`GET /auth/me`) and `fetchAccountMeta` (`GET /account/meta`) both existed, were
 * both tested, and both had **zero production callers** — which is the whole of what made a
 * stored session "verified": nothing ever asked. A boot that reads `localStorage` and
 * believes it renders `Hi, {name}` over an expired or revoked session while every bearer
 * call 401s into a `.catch()`.
 *
 * The fix is deliberately NOT a boot-time `fetchMe`. `/account/meta` is already called on the
 * way in, so its 401 is the answer to the same question for no extra round trip — which is
 * what `net/entitlements.ts`'s `fetchAccountState` now returns as a VALUE rather than
 * throwing, and what `OnlineMatch.syncMetaWithSession` acts on. Keeping two dead readers of
 * the two routes around would have left the code looking like it checks.
 */

/**
 * A refused `/auth/*` call, carrying the status the server answered with.
 *
 * The same shape, and the same reason, as `net/party.ts`'s `PartyRequestError` (2026-09-22):
 * four routes in this file spend a per-IP budget now, and a 429 is the one refusal here whose
 * message must NOT be the server's own. Everything else this file throws carries prose the
 * player needs and the server owns — "username is taken", "password must be at least 8
 * characters" — and `LoginScreen` shows it verbatim. A throttle is the opposite case: its
 * prose says nothing the player can act on, it arrives in English on a screen the player has
 * in one of eight languages, and the only action it suggests is the one that spends more of
 * the budget they have run out of.
 *
 * It carries the STATUS rather than the parsed message, because the message is the server's
 * prose and a client that branches on prose breaks the day the prose is reworded.
 */
export class AuthRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'AuthRequestError';
  }
}

export interface AuthResult {
  accountId: string;
  username: string;
  token: string;
}

export interface AuthCallOptions {
  /** Injected for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
}

async function call<T>(
  baseUrl: string,
  path: string,
  init: RequestInit,
  opts: AuthCallOptions,
): Promise<T> {
  const doFetch = opts.fetch ?? fetch;
  const res = await doFetch(`${baseUrl}${path}`, init);
  const json = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok || json?.error) throw new AuthRequestError(json?.error ?? `auth request failed (${res.status})`, res.status);
  return json as T;
}

function post<T>(baseUrl: string, path: string, body: unknown, opts: AuthCallOptions): Promise<T> {
  return call(baseUrl, path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, opts);
}

export function register(baseUrl: string, username: string, password: string, opts: AuthCallOptions = {}): Promise<AuthResult> {
  return post(baseUrl, '/auth/register', { username, password }, opts);
}

export function login(baseUrl: string, username: string, password: string, opts: AuthCallOptions = {}): Promise<AuthResult> {
  return post(baseUrl, '/auth/login', { username, password }, opts);
}

/**
 * Exchange a game-portal user token for one of our sessions (design/20 "account
 * integration"). The player never sees a form — this is the whole of the login they get on a
 * portal, and it runs at boot.
 *
 * `portalToken` is the PORTAL's token (RS256, one hour, minted by CrazyGames and never
 * decoded on this side); the `token` in the result is OURS. Distinguishing the two matters
 * at exactly one call site and this is it.
 *
 * Throws like every other call in this file, and `portalAuth.ts` — the only caller — treats
 * every throw as "stay a guest". That is deliberate rather than lazy: a portal player whose
 * exchange failed is in precisely the state a player who never logged in is, and the game
 * already works completely in that state.
 */
export function portalLogin(baseUrl: string, portalToken: string, opts: AuthCallOptions = {}): Promise<AuthResult> {
  return post(baseUrl, '/auth/portal', { token: portalToken }, opts);
}

export async function logout(baseUrl: string, token: string, opts: AuthCallOptions = {}): Promise<void> {
  await post<{ ok: true }>(baseUrl, '/auth/logout', { token }, opts);
}

export async function changePassword(
  baseUrl: string,
  token: string,
  oldPassword: string,
  newPassword: string,
  opts: AuthCallOptions = {},
): Promise<void> {
  await post<{ ok: true }>(baseUrl, '/auth/change-password', { token, oldPassword, newPassword }, opts);
}

export type MetaCallOptions = AuthCallOptions;

/**
 * Claim this browser's guest install id against the logged-in account (`POST /account
 * /guest-merge`, design/16 hole 1) — the server-side idempotency key of the one-time device
 * merge. `true` means this caller won the claim and may apply the merge it just offered the
 * player; `false` means the device had already been through the question and the account's
 * own state stands.
 *
 * ## Why a whole round trip for a boolean, and why it is not a local flag
 *
 * A `localStorage` "already merged" flag would answer the same question for free and be
 * wrong in both directions. It survives nothing — clearing site data re-offers a merge of
 * progress that was already folded in, which double-counts the material bank — and it is
 * per-BROWSER where the rule is per-(device, account). The account is the only place that
 * can hold "this device has been through the question" across a second tab, a reinstall and
 * a different machine, so the account is where it lives.
 *
 * Throws like every other call here. A caller that cannot reach the server must take the
 * account's state unchanged rather than merge unclaimed: merging twice silently inflates a
 * bank, while declining once is visible and recoverable.
 */
export async function claimGuestMerge(
  baseUrl: string,
  token: string,
  guestId: string,
  opts: MetaCallOptions = {},
): Promise<boolean> {
  const { claimed } = await call<{ claimed: boolean }>(
    baseUrl,
    '/account/guest-merge',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ guestId }),
    },
    opts,
  );
  return claimed;
}

export async function saveAccountMeta(baseUrl: string, token: string, data: unknown, opts: MetaCallOptions = {}): Promise<void> {
  await call<{ ok: true }>(
    baseUrl,
    '/account/meta',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ data }),
    },
    opts,
  );
}

/**
 * Claim a boss's rare character drop for the signed-in account (`POST /account/claim-drop`,
 * 2026-09-26). Ownership is the server's answer, so a drop granted only locally would vanish
 * at the next login; see `meta/accountSync.ts` for when this is sent. Resolves whether a row
 * landed (`false`: the account already owned it).
 */
export async function claimAccountDrop(baseUrl: string, token: string, skinId: string, opts: MetaCallOptions = {}): Promise<boolean> {
  const res = await call<{ granted: boolean }>(
    baseUrl,
    '/account/claim-drop',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ skinId }),
    },
    opts,
  );
  return res.granted;
}
