/**
 * Client matchmaking (ROADMAP 3.3, design/06) — the client counterpart to the server's
 * matchsvc control plane. It asks for a match and returns the signed seat ticket the
 * client then redeems on the gameserver socket (`${wsUrl}?ticket=${token}`), so the
 * player never hand-picks a roomId/seat — the control plane assigns and signs them.
 *
 * Poll-based to match matchsvc: `POST /find` enqueues (and may return the match inline if
 * this player completes a group), else we poll `GET /find/:queueId` until `matched`.
 * `fetch`/`sleep` are injected so the whole flow is unit-testable with a fake — the ONLY
 * real-network dependency, mirroring how transport.ts isolates the WebSocket.
 */
import { getSession } from './session';

/** Everything needed to open the gameserver socket for the assigned seat. */
export interface MatchInfo {
  wsUrl: string;
  roomId: string;
  owner: number;
  seed: number;
  playerCount: number;
  /** The squad this seat belongs to (design/05/15) — see `@dd/game/pvpConfig`'s
   * `teamIdForOwner`. Included for completeness/diagnostics; gameplay never needs to
   * read it off the ticket since `buildPvpEngineConfig` derives it independently from
   * `(owner, playerCount)` alone. */
  teamId: number;
  token: string;
}

export interface FindMatchOptions {
  playerCount: number;
  /** PvE co-op vs. PvP arena (design/15). Default 'coop' — the field predates PvP, so
   * every existing caller (and the matchsvc side) is unaffected by its absence. */
  mode?: 'coop' | 'pvp';
  /** A pre-formed party's id (design/05/15's PvP squad follow-up) — every member's
   * client sends this once their leader starts matching, so the control plane groups
   * them into one squad chunk. Omitted (every pre-party caller) → plain solo queue. */
  partyId?: string;
  /**
   * The logged-in session's bearer token, sent as `Authorization: Bearer` so matchsvc can
   * VERIFY who this seat belongs to (design/16-accounts.md hole 3, design/20's seat names).
   * Default: the stored session's token, or none at all for a guest.
   *
   * This replaced an `accountId` field that travelled in the request BODY, and the
   * difference is the whole of the fix. A body field is a claim: matchsvc had no way to
   * tell a player naming themselves from a player naming somebody else, so anyone could
   * post a stranger's accountId and move their ladder rating — and, because nothing ever
   * set this header, that was the only path in production, for logged-in players too.
   * A token is a proof, and `routes/match.ts` now accepts nothing else.
   *
   * Omitting it is a GUEST seat, deliberately: the match is played, won and scored on
   * screen exactly as before, and only the durable ladder rank needs a name that cannot be
   * borrowed (`design/15-pvp-arena.md` "Who a rating belongs to").
   */
  token?: string;
  /** Injected for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Injected for tests; defaults to a real timer sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Poll cadence while queued (ms). Default 500. */
  pollIntervalMs?: number;
  /** Give up after this long queued (ms). Default 60 s. */
  timeoutMs?: number;
  /** Cooperative cancel — checked each poll; when true, throws `matchmaking cancelled`. */
  signal?: { cancelled: boolean };
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Find (or wait for) a match. Resolves with the seat's MatchInfo, or rejects if the
 * queue times out / the request expires server-side / the service errors. `baseUrl` is
 * the matchsvc origin (e.g. `http://localhost:8788`), no trailing slash.
 */
export async function findMatch(baseUrl: string, opts: FindMatchOptions): Promise<MatchInfo> {
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? realSleep;
  const pollIntervalMs = opts.pollIntervalMs ?? 500;
  const timeoutMs = opts.timeoutMs ?? 60_000;

  // An explicit `undefined` check rather than `opts.token ?? getSession()?.token`: a caller
  // that passes an empty string is saying "queue as a guest", and must not be handed the
  // stored session the way an OMITTED field is. The two are different requests.
  const token = opts.token !== undefined ? opts.token : getSession()?.token;
  const findRes = await doFetch(`${baseUrl}/find`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // Only when there is one. A `Bearer undefined` header would be a token matchsvc has
      // to try and fail to verify, which is the same guest outcome by a noisier route.
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      playerCount: opts.playerCount,
      mode: opts.mode ?? 'coop',
      partyId: opts.partyId,
    }),
  });
  const found = (await findRes.json()) as { queueId?: string; match?: MatchInfo; error?: string };
  if (!findRes.ok || found.error) throw new Error(found.error ?? `matchmaking failed (${findRes.status})`);
  if (found.match) return found.match; // this arrival completed the group
  if (!found.queueId) throw new Error('matchmaking: no queueId returned');

  const deadline = timeoutMs; // relative budget, tracked by elapsed polls below
  let elapsed = 0;
  for (;;) {
    if (opts.signal?.cancelled) throw new Error('matchmaking cancelled');
    await sleep(pollIntervalMs);
    elapsed += pollIntervalMs;

    const pollRes = await doFetch(`${baseUrl}/find/${encodeURIComponent(found.queueId)}`);
    const status = (await pollRes.json()) as { status?: string; match?: MatchInfo };
    if (status.status === 'matched' && status.match) return status.match;
    if (status.status === 'expired') throw new Error('matchmaking: request expired');
    if (elapsed >= deadline) throw new Error('matchmaking: timed out waiting for a match');
    // otherwise 'queued' → keep polling
  }
}

export interface RequestResumeOptions {
  /** Injected for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
}

/**
 * Mint a fresh, short-lived ticket for an in-progress match (ROADMAP reconnect,
 * design/06) — the ORIGINAL match ticket has almost certainly expired by the time a
 * mid-match disconnect happens (30s TTL vs. a match that runs for minutes), so a
 * dropped client can't just redeem it again. `matchsvc./resume` re-signs the same
 * `{roomId, owner, seed, playerCount, teamId, mode}` grant with a new expiry, proving
 * legitimacy via the original (now-expired-but-still-validly-signed) `token` rather
 * than trusting the caller's word for which seat it once held. Rejects if the token's
 * signature doesn't check out (a forged/foreign ticket) — matchsvc has no notion of
 * whether the room itself is still alive on the gameserver; that's `resume`'s job.
 */
export async function requestResume(baseUrl: string, token: string, opts: RequestResumeOptions = {}): Promise<MatchInfo> {
  const doFetch = opts.fetch ?? fetch;
  const res = await doFetch(`${baseUrl}/resume`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  const body = (await res.json().catch(() => null)) as { match?: MatchInfo; error?: string } | null;
  if (!res.ok || !body?.match) throw new Error(body?.error ?? `resume: failed to reconnect (${res.status})`);
  return body.match;
}
