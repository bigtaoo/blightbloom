/**
 * gameserver bootstrap (design/06, ROADMAP 3.1) — the co-op frame-broadcast data plane.
 * The ONLY file that touches the socket layer: it wraps each WebSocket as a
 * RoomConnection and provides the real-timer Scheduler, then hands everything to the
 * pure RoomManager / MatchRoom lifecycle (which the tests drive with fakes).
 *
 * Handshake (ROADMAP 3.3): a client connects with a signed ticket — `/ws?ticket=<token>`
 * — issued by the matchmaking control plane (matchsvc.ts). The gameserver derives the
 * trusted `{roomId, owner, seed, playerCount}` from the VERIFIED ticket, never from raw
 * query params, so a client can no longer claim another seat or a different seed.
 * A real `DDU_TICKET_SECRET` makes a valid ticket mandatory (invalid/absent → 4401);
 * with no secret set (pure local dev) the legacy raw-param handshake
 * (`/ws?roomId=..&owner=..&seed=..&count=..`) is still accepted for manual testing.
 *
 * Wire format: newline-free JSON per message (ClientMsg in, ServerMsg out). PlayerCommand
 * is already compact plain data, so JSON is fine for the co-op MVP; a WeChat/production
 * build would swap in a binary codec behind this same seam.
 */
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ClientMsg, ServerMsg } from '@dd/engine';
import { RoomManager } from './RoomManager';
import { Phase, type RoomConnection, type SettledMatch } from './MatchRoom';
import { buildRatingReportBody } from './ladderReport';
import { verifyTicket, type MatchMode } from './ticket';
import { INTERNAL_CALLER_GAMESERVER, internalKeyFor, ticketSecret } from './config';
import { internalFetch, type InternalFetchInit } from './internalFetch';

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '0.0.0.0';
// matchsvc's control-plane URL (design/15, ROADMAP 4.6) — where a settled PvP match's
// checkpoint-verified placements get reported for ladder rating. Unset in dev = the
// callback is skipped entirely (see `reportSettledMatch` below), not a hard failure.
const MATCHSVC_URL = process.env.DDU_MATCHSVC_URL;

/**
 * How hard the gameserver tries to land a settlement report (design/19 §3, ROADMAP 8.1).
 * A settlement is the retryable kind of call: it happens exactly once per match, nothing
 * re-sends it, and a lost one silently costs real players the rating they just earned —
 * the opposite of a periodic heartbeat, which passes no `retry` because the next tick is
 * already the retry.
 *
 * The budget used to be 3, and the note here used to explain that the ceiling was low
 * because `/rating/report` was at-least-once against a receiver with no dedupe key, so a
 * delivered-but-unacknowledged report double-applied on retry — 8.1's one open item.
 * That is closed: the report now carries `ladderReport.ts`'s `reportKey`, and matchsvc
 * claims it in `rating_reports` inside the same transaction that moves the ratings
 * (`RatingStore.applyMatchOnce`). A redelivery loses the claim and comes back 200 with
 * `duplicate: true`, which ends the ladder rather than being counted a failure.
 *
 * So the trade this constant expresses changed shape. Retrying can no longer multiply a
 * rating; what it still costs is one in-flight request per attempt against a peer that may
 * be struggling. 5 attempts at 250/500/1000/2000/2000 ms is ~3.75 s of backoff plus up to
 * 5 x `DEFAULT_TIMEOUT_MS` — enough to ride out a matchsvc restart, still bounded, and
 * still fire-and-forget so no match waits on it.
 *
 * Exported so `index.lifecycle.test.ts` can assert the give-up point against the real
 * budget instead of a copy of the number, which is the part that must not drift.
 */
export const SETTLEMENT_RETRY = { attempts: 5, baseDelayMs: 250, maxDelayMs: 2_000 } as const;

/**
 * Report a settled match's placements to matchsvc's ladder (design/15, ROADMAP 4.6) —
 * ONLY when the room was a PvP room (`mode`) AND the result was checkpoint/hash-verified
 * (`hashOk`); every PvE/co-op settlement is silently skipped, same as it always was
 * before 4.6 existed. The placement→rank conversion lives in `ladderReport.ts` (pure,
 * unit-tested).
 *
 * `mode` is the arm that has to come first, and it is the one that was missing until
 * 2026-09-05. The other three are all necessary but only one of them is TRUSTED:
 * `hashOk` is the room's own comparison of the seats' hashes, while `placements` and
 * `winner` are relayed verbatim off the seats' `result` messages. Gating "was this PvP?"
 * on `placements` being present therefore asked the players — a co-op squad that agrees
 * on a hash and all send a fabricated `placements` array plus a numeric `winner` moved
 * real accounts' ratings off a match nobody competed in. `SettledMatch.mode` comes from
 * the verified ticket via `MatchRoom.modeValue`, which no seat can author; `placements`
 * and `winner` stay in the guard because `buildRatingReportBody` needs both to be
 * well-formed, not as evidence of what kind of match this was.
 *
 * Goes through `internalFetch` rather than a bare `fetch` — design/19's D2, and the one
 * call in this process that had the defect. The old shape was
 * `fetch(...).catch(() => {})`, which never consumed the response body: funny shipped
 * that exact line and measured it wedging undici's keep-alive pool under a concurrent
 * burst so that NO report arrived, for ~30 s at a time, with nothing logged either way.
 * Three things change: the body is always drained, the attempt has an explicit timeout
 * (undici's `fetch` has none), and a transient failure is retried — see
 * `SETTLEMENT_RETRY` for why bounded. It stays fire-and-forget: settlement never awaits
 * the ladder, and `internalFetch` never rejects, so there is no unhandled rejection to
 * take the gameserver down mid-match. What it no longer does is fail SILENTLY.
 *
 * The body carries `reportKey` (`ladderReport.ts`), which makes the retry above safe: a
 * redelivered report loses matchsvc's dedupe claim and is answered 200, so the ladder stops
 * on the first attempt that reaches an already-applied settlement instead of applying it
 * again. Nothing here has to check for that — a 200 is a 200 — which is the point of
 * putting the marker in the body and not in the status.
 *
 * `opts` is a test seam (the same role `GameserverOptions` plays for `createGameserver`) —
 * production passes nothing and gets the real `fetch`, the real timers and the real key.
 */
export function reportSettledMatch(match: SettledMatch, opts: InternalFetchInit = {}): void {
  if (!MATCHSVC_URL || match.mode !== 'pvp' || !match.hashOk) return;
  if (!match.placements || typeof match.winner !== 'number') return;
  const body = buildRatingReportBody(match.roomId, match.winner, match.placements, match.playerCount, match.seatAccounts);
  void internalFetch(`${MATCHSVC_URL}/rating/report`, {
    method: 'POST',
    json: body,
    internalKey: internalKeyFor(INTERNAL_CALLER_GAMESERVER),
    caller: INTERNAL_CALLER_GAMESERVER,
    retry: SETTLEMENT_RETRY,
    ...opts,
  }).then((result) => {
    if (result.ok) return;
    // Best-effort still, but no longer invisible: D2's whole cost was that a total outage
    // and a healthy server looked identical from here.
    console.warn(
      `[blightbloom] ladder report for room ${match.roomId} failed after ${result.attempts} ` +
        `attempt(s): ${result.failure}${result.status === undefined ? '' : ` ${result.status}`}` +
        `${result.error === undefined ? '' : ` (${result.error})`}`,
    );
  });
}

/** A live socket presented to the room layer as a seat sink. */
class SocketConnection implements RoomConnection {
  constructor(
    readonly owner: number,
    readonly roomId: string,
    private readonly ws: WebSocket,
    readonly accountId?: string,
  ) {}
  send(msg: ServerMsg): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(msg));
  }
}

interface Seat {
  roomId: string;
  owner: number;
  seed: number;
  count: number;
  mode: MatchMode;
  /** The logged-in account behind this seat (design/16-accounts.md), from the verified
   * ticket. `undefined` for guests/bots or the legacy dev raw-param handshake. */
  accountId?: string;
}

/**
 * Resolve the trusted seat for a handshake. A `?ticket=` is verified and its payload is
 * authoritative (the spoof-proof path). With no configured secret (dev), a ticketless
 * connection may fall back to the legacy raw params; once a real secret is set a valid
 * ticket is required. Returns null → close the socket.
 */
function resolveSeat(url: URL, secret: string, isDev: boolean): Seat | null {
  const token = url.searchParams.get('ticket');
  if (token) {
    const payload = verifyTicket(token, secret, Date.now());
    if (!payload) return null;
    return {
      roomId: payload.roomId,
      owner: payload.owner,
      seed: payload.seed,
      count: payload.playerCount,
      mode: payload.mode ?? 'coop',
      accountId: payload.accountId,
    };
  }
  if (!isDev) return null; // a configured secret ⇒ ticket mandatory

  // Legacy dev handshake: raw params, trusted only because no secret is configured.
  const roomId = url.searchParams.get('roomId') ?? '';
  const owner = Number(url.searchParams.get('owner'));
  const seed = Number(url.searchParams.get('seed'));
  const count = Number(url.searchParams.get('count'));
  if (!roomId || !Number.isInteger(owner) || !Number.isInteger(seed) || !Number.isInteger(count) || count < 1) {
    return null;
  }
  const mode: MatchMode = url.searchParams.get('mode') === 'pvp' ? 'pvp' : 'coop';
  return { roomId, owner, seed, count, mode };
}

export interface GameserverOptions {
  /** Ticket secret/isDev override — tests can pin a fixed value instead of the
   * env-derived `ticketSecret()` default (mirrors matchsvc's `secret` option in
   * `MatchsvcServerOptions`). */
  ticketSecret?: { secret: string; isDev: boolean };
}

/**
 * Builds the gameserver's HTTP+WS stack WITHOUT starting it (`server.listen()` is the
 * caller's job) — the same testability seam as `matchsvc.ts`'s `createMatchsvcServer`.
 * `main()` below is the real CLI entrypoint; a test can bind an ephemeral port and drive
 * real HTTP/WS traffic against the returned `server`/`wss` instead.
 */
export function createGameserver(opts: GameserverOptions = {}): { server: Server; wss: WebSocketServer; manager: RoomManager } {
  const manager = new RoomManager({
    // Node timers are the metronome clock in production; the tests inject a fake.
    scheduler: {
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
    },
    onSettled: reportSettledMatch, // design/15, ROADMAP 4.6 — ladder rating report
  });

  const http = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'daydayup-gameserver' }));
      return;
    }
    res.writeHead(426, { 'content-type': 'text/plain' });
    res.end('Upgrade Required');
  });
  const wss = new WebSocketServer({ server: http, path: '/ws' });
  const { secret, isDev } = opts.ticketSecret ?? ticketSecret();

  wss.on('connection', (ws: WebSocket, req) => {
    const url = new URL(req.url ?? '', `ws://${req.headers.host}`);
    const seat = resolveSeat(url, secret, isDev);
    if (!seat) {
      // A configured secret makes a ticket mandatory; dev-with-no-secret also lands here
      // only for a malformed legacy handshake.
      ws.close(4401, 'invalid or missing ticket');
      return;
    }
    const { roomId, owner, seed, count, mode, accountId } = seat;

    const conn = new SocketConnection(owner, roomId, ws, accountId);

    // A room already IN_MATCH (or settled/OVER) can never be `join()`-ed — that call
    // only succeeds while seats are still filling (MatchRoom.join). Reaching here with
    // a ticket for such a room means this is a RECONNECT (ROADMAP reconnect, design/06):
    // matchsvc's `/resume` mints a ticket for the exact seat/seed/playerCount/mode the
    // client already held, so a genuine mismatch (wrong seed/count/mode) still means a
    // stale/foreign ticket and gets rejected exactly like the old join-mismatch case did.
    // A real reconnect instead just holds the socket open and waits for the client's own
    // `resume` message (with `lastFrame`) to actually reseat it via `room.resume()` —
    // there's no seat-claim work to do here at handshake time the way a fresh `join` has.
    const existing = manager.room(roomId);
    if (existing && existing.phase !== Phase.WAITING) {
      if (existing.seedValue !== seed || existing.playerCountValue !== count || existing.modeValue !== mode) {
        ws.close(4403, 'seat unavailable / room mismatch');
        return;
      }
    } else {
      const seated = manager.join(conn, roomId, seed, count, mode);
      if (!seated) {
        ws.close(4403, 'seat unavailable / room mismatch');
        return;
      }
    }

    ws.on('message', (data: Buffer) => {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(data.toString('utf8')) as ClientMsg;
      } catch {
        return; // ignore malformed frames
      }
      manager.handle(conn, roomId, msg);
    });
    ws.on('close', () => manager.onClose(conn, roomId));
    ws.on('error', () => {
      /* the close event fires next; nothing extra to do */
    });
  });

  return { server: http, wss, manager };
}

export interface MainOptions extends GameserverOptions {
  /** Listen port/host overrides — a test binds port 0 rather than fighting for 8787. */
  port?: number;
  host?: string;
  /** How the shutdown handler ends the process. Injected ONLY so a test can observe the
   * shutdown sequence without killing its own runner; production passes nothing and gets
   * `process.exit`. */
  exit?: (code: number) => void;
}

/**
 * The real CLI entrypoint. Exported (2026-09-03) rather than private, because the shutdown
 * path is the one piece of this file with no other way in and a real consequence: `SIGTERM`
 * during a deploy must destroy every live room before the socket closes, or each room's
 * metronome interval outlives it and the process refuses to exit. That whole sequence was
 * uncovered, and a reordering of it fails in a way nothing else here would notice.
 */
export function main(opts: MainOptions = {}): {
  server: Server;
  wss: WebSocketServer;
  manager: RoomManager;
  shutdown: () => void;
} {
  const { server, wss, manager } = createGameserver(opts);
  const exit = opts.exit ?? ((code: number) => process.exit(code));

  const shutdown = (): void => {
    // Order matters: rooms first (their metronome intervals are what keep the event loop
    // alive), then the socket layer, then the HTTP server underneath it.
    manager.destroyAll();
    wss.close();
    server.close();
    exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const port = opts.port ?? PORT;
  const host = opts.host ?? HOST;
  server.listen(port, host, () => {
    console.log(`blightbloom gameserver (co-op frame relay) on ws://${host}:${port}/ws`);
  });
  return { server, wss, manager, shutdown };
}

// Only auto-start when run directly (`node --import tsx/esm src/index.ts`), not when
// imported by a test — the same ESM `require.main === module` equivalent matchsvc.ts
// uses now that `createGameserver` is a real importable export.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
