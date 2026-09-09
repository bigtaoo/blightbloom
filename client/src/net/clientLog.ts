/**
 * The client half of the log store (design/19 §10): a ring buffer of what happened in this
 * browser, flushed in batches to matchsvc's `POST /client/log`.
 *
 * The problem it exists for: a player's console is the ONE place where "it broke" is
 * visible, and it is the one place nobody can look. Every bug report this project has had
 * from a real device — the blank WeChat labels, the CrazyGames SDK calls that were silent
 * no-ops, the CORS preflight that failed as a bare "Failed to fetch" — was found by
 * somebody happening to have a devtools window open. This makes the same information
 * arrive by itself.
 *
 * ## Shape
 *
 * - **A ring buffer, not a stream.** Every line is recorded regardless of whether it will
 *   be sent; the buffer holds the last {@link RING_CAPACITY}. So when something does go
 *   wrong, the lines LEADING UP TO IT are already in hand rather than having been dropped
 *   for being uninteresting at the time.
 * - **Batched, on a timer and on the way out.** A flush every {@link FLUSH_INTERVAL_MS},
 *   plus one on `pagehide` — which is the only chance to hear about a crash, since there
 *   is no later.
 * - **`fetch` with `keepalive`, never `navigator.sendBeacon`.** This is not a preference,
 *   it is a hard constraint of this deployment and porting it wrong makes the exit flush
 *   silently never land: `sendBeacon` always sends CREDENTIALED, which makes the browser
 *   require `Access-Control-Allow-Credentials: true` on a cross-origin response —
 *   and matchsvc answers `Access-Control-Allow-Origin: *` (server/src/routes/http.ts),
 *   which is *incompatible* with credentials by specification. The client is on
 *   `b.gamestao.com` and the server on `bb.gamestao.com`, so every send here is
 *   cross-origin. funny hit exactly this and its fix is the one used here.
 * - **Failure is silent and total.** A logger that can break the game is worse than no
 *   logger. Every send is fire-and-forget with a swallowed rejection, and nothing on this
 *   path is ever awaited by anything a player is waiting for.
 *
 * ## What it does not do
 *
 * No user identity is read or sent. The `session` id is random per visit and means nothing
 * outside this store; the ACCOUNT, when there is one, is attached server-side from the
 * bearer token (`server/src/routes/telemetry.ts`) rather than sent from here, because a
 * field a client can write is a field that says nothing.
 */
import { getHostKind } from '../platform/hostKind';

export const RING_CAPACITY = 200;
export const FLUSH_INTERVAL_MS = 30_000;
/** Levels, most severe first — the same four names the server logger uses. */
export const LEVELS = ['error', 'warn', 'info', 'debug'] as const;
export type ClientLogLevel = (typeof LEVELS)[number];

/** Matches `server/src/clientLog.ts`'s caps; trimming here saves sending what will be cut. */
const MSG_MAX = 1000;
const TAG_MAX = 48;

export interface ClientLogEntry {
  t: number;
  level: ClientLogLevel;
  msg: string;
  tag?: string;
}

export interface ClientLoggerDeps {
  /** matchsvc's base URL — `runState.ts`'s `matchBaseUrl`. */
  baseUrl: string;
  /** The bearer token of the logged-in session, if any; read per flush, never cached. */
  token?: () => string | null;
  /** The build this page is running, if it can be known. `null` becomes `unknown`. */
  version?: () => string | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Injected by tests. Production uses the real `setInterval`. */
  setIntervalImpl?: (fn: () => void, ms: number) => unknown;
  clearIntervalImpl?: (handle: unknown) => void;
  /** The least severe level that is SENT. Everything is always RECORDED — see the header. */
  minLevel?: ClientLogLevel;
  intervalMs?: number;
  /** Random session id, injected so a test can assert on a fixed one. */
  sessionId?: string;
}

export interface ClientLogger {
  log(level: ClientLogLevel, tag: string, msg: string): void;
  /** Everything buffered, oldest first. For tests and for a crash flush. */
  snapshot(): readonly ClientLogEntry[];
  /** Send what is buffered above `minLevel` and forget it. Never rejects. */
  flush(): Promise<void>;
  /** Stop the timer and detach the global handlers. */
  stop(): void;
  readonly session: string;
}

/** A per-visit random id. Not a device id and not persisted — a new tab is a new session. */
function randomSession(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  const uuid = g.crypto?.randomUUID?.();
  // `Math.random` is the fallback for the two targets whose runtime may not expose
  // `crypto.randomUUID` (an older WeChat shell, an http:// origin). A collision here costs
  // two visits sharing a filter value in a dashboard, so a weaker source is acceptable
  // where refusing to log at all would not be.
  return uuid ?? `s-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

const rank = (level: ClientLogLevel): number => LEVELS.indexOf(level);

export function createClientLogger(deps: ClientLoggerDeps): ClientLogger {
  const now = deps.now ?? Date.now;
  const doFetch = deps.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const session = deps.sessionId ?? randomSession();
  const minRank = rank(deps.minLevel ?? 'warn');
  const ring: ClientLogEntry[] = [];
  let sending = false;

  const log = (level: ClientLogLevel, tag: string, msg: string): void => {
    ring.push({ t: now(), level, msg: String(msg).slice(0, MSG_MAX), tag: tag.slice(0, TAG_MAX) });
    if (ring.length > RING_CAPACITY) ring.splice(0, ring.length - RING_CAPACITY);
  };

  const flush = async (): Promise<void> => {
    // One in flight at a time. Without this, a slow network plus the 30s timer plus a
    // `pagehide` would send the same entries several times over.
    if (sending) return;
    const sendable = ring.filter((e) => rank(e.level) <= minRank);
    if (sendable.length === 0) return;

    // Cleared BEFORE the request, not after. A failed send drops those lines rather than
    // retrying them, deliberately: retrying is how a client that cannot reach the server
    // turns one outage into a growing buffer and a request storm the moment it recovers.
    ring.length = 0;
    sending = true;

    const token = deps.token?.() ?? null;
    try {
      await doFetch(`${deps.baseUrl}/client/log`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        // `keepalive` is what lets this survive the page going away; `credentials: 'omit'`
        // is what lets it pass CORS at all. See the header — this pair is the whole reason
        // `navigator.sendBeacon` is not used.
        keepalive: true,
        credentials: 'omit',
        body: JSON.stringify({
          session,
          host: getHostKind(),
          ver: deps.version?.() ?? 'unknown',
          now: now(),
          entries: sendable,
        }),
      });
    } catch {
      // Deliberately nothing. A logger that surfaces its own failure to a player has
      // become the bug it was installed to find.
    } finally {
      sending = false;
    }
  };

  const setIntervalImpl = deps.setIntervalImpl ?? ((fn, ms) => setInterval(fn, ms));
  const clearIntervalImpl = deps.clearIntervalImpl ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  const timer = setIntervalImpl(() => void flush(), deps.intervalMs ?? FLUSH_INTERVAL_MS);

  return {
    log,
    snapshot: () => [...ring],
    flush,
    stop: () => clearIntervalImpl(timer),
    session,
  };
}
