/**
 * The gameserver paths `index.http.test.ts` does not reach: the ladder-report callback, the
 * reconnect/mismatch branches of the WS handshake, the inbound-message handler, and `main()`'s
 * listen/shutdown sequence.
 *
 * Measured 2026-09-03, `src/index.ts` was 68.91% lines / 66.66% branches with those four
 * regions uncovered — and every one of them fails quietly:
 *
 *   reportSettledMatch  a wrong guard means every PvP result is silently dropped (or every
 *                       PvE one is wrongly REPORTED, moving real players' ratings), and the
 *                       call is `.catch()`-swallowed by design, so nothing logs either way.
 *   the reconnect arm   getting it backwards either refuses every legitimate reconnect or
 *                       lets a stale ticket into a live room; both look like "the network".
 *   the message handler a malformed frame that throws takes the socket down mid-match.
 *   shutdown            rooms not destroyed before close leaves each room's metronome
 *                       interval running, and the process never exits on deploy.
 *
 * `reportSettledMatch` reads `BB_MATCHSVC_URL` at MODULE scope, so its cases re-import the
 * module under a stubbed env rather than pretending a setter exists.
 *
 * ROADMAP 8.1 (2026-09-04) rewired that callback through `internalFetch` (design/19's D2 —
 * the old `fetch(...).catch(() => {})` never consumed its response body, which funny
 * measured wedging undici's keep-alive pool so that NO report arrived). The four guard arms
 * below are unchanged; what is new is that the call now carries a credential, drains what
 * comes back, retries a transient failure, and — the part D2 cost most — says so when it
 * finally gives up instead of failing silently. `internalFetch`'s own mechanics are tested
 * in `internalFetch.test.ts`; these cases pin what THIS call site asks it for.
 */
import { describe, it, expect, vi, afterEach, type MockInstance } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { WebSocket, type WebSocketServer } from 'ws';
import { createGameserver, main, SETTLEMENT_RETRY } from '../src/index';
import type { SettledMatch } from '../src/MatchRoom';
import { signTicket, type TicketPayload } from '../src/ticket';
import type { RoomManager } from '../src/RoomManager';

const SECRET = 'lifecycle-test-secret';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
  // Console spies too: `vi.spyOn` on an ALREADY-spied method hands back the existing mock,
  // so without this a later case reads the earlier ones' calls and a "warns once" assertion
  // counts the whole file (ROADMAP 8.1 added several).
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// reportSettledMatch
// ─────────────────────────────────────────────────────────────────────────────

const settled = (over: Partial<SettledMatch> = {}): SettledMatch => ({
  roomId: 'room-1',
  // The base case is the only one that may be reported: a PvP room. Every `skips:` arm
  // below spoils exactly one field of this, so a guard that stops checking one of them
  // has to turn the corresponding arm red rather than hide behind the others.
  mode: 'pvp',
  winner: 0,
  placements: [3, 2, 1],
  playerCount: 4,
  hashOk: true,
  ...over,
});

/** Never sleep for real — otherwise every retry case pays the settlement backoff ladder. */
const noSleep = () => Promise.resolve();

interface RecordedCall {
  url: string;
  body: unknown;
  headers: Record<string, string>;
  /** The response handed back, so a case can ask whether its body was released. */
  res: Response;
}

/**
 * Re-imports index.ts with `BB_MATCHSVC_URL` set (or not) and a recording `fetch` that
 * hands back REAL `Response` objects — `bodyUsed` on one of those is the only honest
 * witness that D2's drain actually happens, and a `{ ok: true }` literal (what this helper
 * used to return) cannot report it. `statuses` scripts one status per attempt, the last
 * one repeating, so a retry ladder can be driven without a second helper.
 */
async function withMatchsvc(
  url: string | undefined,
  statuses: number[] = [200],
): Promise<{
  report: (m: SettledMatch, opts?: Record<string, unknown>) => void;
  calls: RecordedCall[];
  fetchMock: ReturnType<typeof vi.fn>;
}> {
  if (url === undefined) vi.stubEnv('BB_MATCHSVC_URL', '');
  else vi.stubEnv('BB_MATCHSVC_URL', url);
  const calls: RecordedCall[] = [];
  const fetchMock = vi.fn((u: string, init: { body: string; headers: Record<string, string> }) => {
    const status = statuses[Math.min(calls.length, statuses.length - 1)]!;
    const res = new Response('{"changes":[]}', { status });
    calls.push({ url: u, body: JSON.parse(init.body), headers: init.headers, res });
    return Promise.resolve(res);
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.resetModules();
  const mod = await import('../src/index');
  return {
    report: (m, opts = {}) => mod.reportSettledMatch(m, { sleep: noSleep, ...opts }),
    calls,
    fetchMock,
  };
}

describe('reportSettledMatch — the ladder callback', () => {
  it('POSTs a verified PvP result to matchsvc', async () => {
    const { report, calls } = await withMatchsvc('http://matchsvc.test');
    report(settled());
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://matchsvc.test/rating/report');
    // The body is `buildRatingReportBody`'s output (pure, tested in ladderReport.test.ts);
    // what this pins is that the five arguments reach it in the right order — a swapped
    // `winner`/`playerCount` pair still produces a well-formed body and wrong ratings.
    const body = calls[0]!.body as { accountIds: string[]; places: number[] };
    expect(body.accountIds).toHaveLength(4);
    expect(body.places).toHaveLength(4);
    expect(Math.min(...body.places)).toBe(1); // the winner's seat placed first
  });

  it('carries seatAccounts through, so a logged-in seat is rated as itself', async () => {
    const { report, calls } = await withMatchsvc('http://matchsvc.test');
    report(settled({ seatAccounts: { 0: 'acct-winner' } }));
    const body = calls[0]!.body as { accountIds: string[] };
    expect(body.accountIds).toContain('acct-winner');
  });

  it.each([
    ['no matchsvc configured', undefined, settled()],
    ['a co-op room, whatever its seats reported', 'http://matchsvc.test', settled({ mode: 'coop' })],
    ['the hash did not verify', 'http://matchsvc.test', settled({ hashOk: false })],
    ['no placements to convert', 'http://matchsvc.test', settled({ placements: undefined })],
    ['no numeric winner', 'http://matchsvc.test', settled({ winner: null as never })],
  ])('skips: %s', async (_label, url, match) => {
    // Each of the five guard arms, separately. Four of them protect real players: reporting
    // an unverified or PvE result moves ladder ratings off a match nobody competed in.
    const { report, fetchMock } = await withMatchsvc(url);
    report(match);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips a co-op room even when its seats send a full, self-consistent PvP result', async () => {
    // The arm above with the spoofing spelled out, because the `mode: 'coop'` row on its own
    // reads like bookkeeping. Everything a seat controls is set to exactly what a real PvP
    // settlement looks like — agreed hash, a numeric winner, a well-formed placements array,
    // logged-in accounts to move ratings for. The ONLY thing saying this was not a match is
    // the room's ticket-derived mode. Before 2026-09-05 the guard asked `placements` instead,
    // so this exact payload was reported and moved real accounts' ratings.
    const { report, fetchMock } = await withMatchsvc('http://matchsvc.test');
    report(settled({ mode: 'coop', hashOk: true, winner: 0, placements: [3, 2, 1], seatAccounts: { 0: 'acct-a', 1: 'acct-b' } }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('swallows a rejected report — a dropped rating never blocks settlement', async () => {
    vi.stubEnv('BB_MATCHSVC_URL', 'http://matchsvc.test');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('matchsvc is down'))),
    );
    vi.resetModules();
    const mod = await import('../src/index');
    // An unhandled rejection here would take the gameserver down mid-match, which is a far
    // worse outcome than a lost rating update. `internalFetch` resolves rather than
    // rejecting, so `void`-ing the call is safe — pinned here rather than assumed.
    expect(() => mod.reportSettledMatch(settled(), { sleep: noSleep })).not.toThrow();
    await vi.waitFor(() => expect(ladderWarnings(warn)).toHaveLength(1));
  });
});

/** Only the warnings this call site owns; anything else on the console is somebody else's. */
function ladderWarnings(warn: MockInstance<typeof console.warn>): string[] {
  return warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('ladder report'));
}

describe('reportSettledMatch — what ROADMAP 8.1 changed about the call itself', () => {
  it('presents the internal key and names itself as the caller', async () => {
    // Without this the report is refused by matchsvc's own `internalAuth` — the gameserver
    // is the ONLY legitimate caller of that route and now has to prove it.
    const { report, calls } = await withMatchsvc('http://matchsvc.test');
    report(settled());
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.headers['x-internal-key']).toBe('dev-insecure-internal-key-do-not-use-in-prod');
    expect(calls[0]!.headers['x-internal-caller']).toBe('gameserver');
    expect(calls[0]!.headers['content-type']).toBe('application/json');
  });

  it('drains the response body — D2, the whole reason this stopped being a bare fetch', async () => {
    const { report, calls } = await withMatchsvc('http://matchsvc.test');
    report(settled());
    await vi.waitFor(() => expect(calls[0]?.res.bodyUsed).toBe(true));
  });

  it('retries a 5xx and stops as soon as one lands', async () => {
    const { report, calls } = await withMatchsvc('http://matchsvc.test', [503, 200]);
    report(settled());
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    // ...and no third: a 2xx ends the ladder. It is now safe for a 2xx to be a REDELIVERY
    // rather than a first landing (matchsvc answers a lost dedupe claim 200 with
    // `duplicate: true`), which is exactly why this stop condition is the right one.
    await new Promise((r) => setTimeout(r, 5));
    expect(calls).toHaveLength(2);
    expect(calls[0]!.res.bodyUsed).toBe(true); // both attempts drained, not just the last
    expect(calls[1]!.res.bodyUsed).toBe(true);
  });

  it('sends the SAME reportKey on every attempt of one settlement', async () => {
    // The property the whole exactly-once mechanism rests on, and the one that breaks
    // silently: a key that changed between attempts would win a fresh claim each time, so
    // the dedupe table would fill up and the ratings would double-apply anyway — with every
    // test above still green, because each individual response is a 200.
    const { report, calls } = await withMatchsvc('http://matchsvc.test', [503, 503, 200]);
    report(settled());
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    const keys = calls.map((c) => (c.body as { reportKey: string }).reportKey);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]!.startsWith('room-1:')).toBe(true); // and it names the room, for the audit
  });

  it('a duplicate answer (200) is not logged as a failure', async () => {
    // matchsvc answers an already-applied report 200 with `duplicate: true` in the BODY,
    // deliberately not 409: a non-2xx here would print "ladder report ... failed" for a
    // match whose rating actually landed, which is worse than saying nothing.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { report, calls } = await withMatchsvc('http://matchsvc.test', [200]);
    report(settled());
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 5));
    expect(ladderWarnings(warn)).toHaveLength(0);
  });

  it('never retries a 401 — a refused key cannot be fixed by asking again', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { report, calls } = await withMatchsvc('http://matchsvc.test', [401]);
    report(settled());
    await vi.waitFor(() => expect(ladderWarnings(warn)).toHaveLength(1));
    expect(calls).toHaveLength(1);
    expect(ladderWarnings(warn)[0]).toContain('401');
    expect(ladderWarnings(warn)[0]).toContain('room-1'); // WHICH match was lost, not just that one was
  });

  it('gives up after a bounded number of attempts rather than hammering a down peer', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { report, calls } = await withMatchsvc('http://matchsvc.test', [500]);
    report(settled());
    await vi.waitFor(() => expect(ladderWarnings(warn)).toHaveLength(1));
    // Against the real budget rather than a copy of the number: what must not drift is that
    // the ladder STOPS, not the particular ceiling (which this pass raised from 3 to 5 once
    // a retry could no longer multiply a rating).
    expect(calls).toHaveLength(SETTLEMENT_RETRY.attempts);
    expect(calls.every((c) => c.res.bodyUsed)).toBe(true);
  });

  it('logs NOTHING when the report lands — the warning is a failure signal, not traffic', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { report, calls } = await withMatchsvc('http://matchsvc.test');
    report(settled());
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 5));
    expect(ladderWarnings(warn)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The WS handshake's reconnect / mismatch arms
// ─────────────────────────────────────────────────────────────────────────────

function startServer(): {
  wsBase: string;
  server: Server;
  manager: RoomManager;
  close: () => Promise<void>;
} {
  const { server, wss, manager } = createGameserver({
    ticketSecret: { secret: SECRET, isDev: false },
  });
  return {
    server,
    manager,
    get wsBase() {
      const { port } = server.address() as AddressInfo;
      return `ws://127.0.0.1:${port}/ws`;
    },
    close: () =>
      new Promise<void>((resolve) => {
        manager.destroyAll();
        (wss as WebSocketServer).close();
        server.close(() => resolve());
      }),
  };
}

const ticketFor = (over: Partial<TicketPayload> = {}): string =>
  signTicket(
    {
      roomId: 'room-live',
      owner: 0,
      seed: 42,
      playerCount: 1,
      teamId: 0,
      exp: Date.now() + 30_000,
      ...over,
    },
    SECRET,
  );

/** Opens a socket and resolves with its first outcome — a message or a close code. */
function firstOutcome(url: string): {
  ws: WebSocket;
  outcome: Promise<{ msg?: Record<string, unknown>; closeCode?: number }>;
} {
  const ws = new WebSocket(url);
  const outcome = new Promise<{ msg?: Record<string, unknown>; closeCode?: number }>((resolve) => {
    ws.once('message', (d: Buffer) => resolve({ msg: JSON.parse(d.toString('utf8')) }));
    ws.once('close', (code) => resolve({ closeCode: code }));
  });
  return { ws, outcome };
}

describe('gameserver WS — a room that is already in match', () => {
  it('REJECTS a ticket whose seed does not match the live room (4403)', async () => {
    const ctx = startServer();
    await new Promise<void>((r) => ctx.server.listen(0, r));
    try {
      // A playerCount:1 room launches the moment its single seat joins, so the room is
      // already IN_MATCH by the time the second socket arrives.
      const first = firstOutcome(`${ctx.wsBase}?ticket=${ticketFor()}`);
      expect((await first.outcome).msg).toMatchObject({ type: 'match_start' });

      const stale = firstOutcome(`${ctx.wsBase}?ticket=${ticketFor({ seed: 999 })}`);
      expect((await stale.outcome).closeCode).toBe(4403);
      first.ws.close();
    } finally {
      await ctx.close();
    }
  });

  it('REJECTS a ticket whose playerCount does not match (4403)', async () => {
    const ctx = startServer();
    await new Promise<void>((r) => ctx.server.listen(0, r));
    try {
      const first = firstOutcome(`${ctx.wsBase}?ticket=${ticketFor()}`);
      await first.outcome;
      const stale = firstOutcome(`${ctx.wsBase}?ticket=${ticketFor({ playerCount: 4, owner: 1 })}`);
      expect((await stale.outcome).closeCode).toBe(4403);
      first.ws.close();
    } finally {
      await ctx.close();
    }
  });

  it('ACCEPTS a matching ticket and holds the socket open — the reconnect path', async () => {
    // The other side of the same branch, and the one a "reject mismatches" rule would break
    // silently: a genuine mid-match reconnect presents a `/resume` ticket for the exact same
    // seat/seed/count, and must NOT be closed. There is no handshake-time reseating — the
    // client's own `resume` message does that — so the observable contract is simply that the
    // socket stays up.
    const ctx = startServer();
    await new Promise<void>((r) => ctx.server.listen(0, r));
    try {
      const first = firstOutcome(`${ctx.wsBase}?ticket=${ticketFor()}`);
      await first.outcome;

      const again = new WebSocket(`${ctx.wsBase}?ticket=${ticketFor()}`);
      const closed = await new Promise<number | 'still-open'>((resolve) => {
        again.once('close', (c) => resolve(c));
        setTimeout(() => resolve('still-open'), 300);
      });
      expect(closed).toBe('still-open');
      again.close();
      first.ws.close();
    } finally {
      await ctx.close();
    }
  });

  it('REJECTS a seat another socket already holds in a still-filling room (4403)', async () => {
    const ctx = startServer();
    await new Promise<void>((r) => ctx.server.listen(0, r));
    try {
      // playerCount 2 → the room stays WAITING after one join, so the second attempt goes
      // through `manager.join` and is refused for the seat, not for a room mismatch.
      const seat = { roomId: 'room-wait', playerCount: 2, owner: 0 };
      const a = firstOutcome(`${ctx.wsBase}?ticket=${ticketFor(seat)}`);
      await new Promise((r) => setTimeout(r, 50));
      const b = firstOutcome(`${ctx.wsBase}?ticket=${ticketFor(seat)}`);
      expect((await b.outcome).closeCode).toBe(4403);
      a.ws.close();
    } finally {
      await ctx.close();
    }
  });
});

describe('gameserver WS — inbound frames', () => {
  it('ignores a malformed frame and keeps the socket alive', async () => {
    const ctx = startServer();
    await new Promise<void>((r) => ctx.server.listen(0, r));
    try {
      const { ws, outcome } = firstOutcome(`${ctx.wsBase}?ticket=${ticketFor()}`);
      await outcome;
      ws.send('{ not json');
      const closed = await new Promise<number | 'still-open'>((resolve) => {
        ws.once('close', (c) => resolve(c));
        setTimeout(() => resolve('still-open'), 300);
      });
      // A throw out of the 'message' listener would kill this connection — and in a co-op
      // match, a dropped seat pauses the metronome for everyone else too.
      expect(closed).toBe('still-open');
      ws.close();
    } finally {
      await ctx.close();
    }
  });

  it('routes a well-formed frame into the room layer', async () => {
    const ctx = startServer();
    await new Promise<void>((r) => ctx.server.listen(0, r));
    try {
      const { ws, outcome } = firstOutcome(`${ctx.wsBase}?ticket=${ticketFor()}`);
      await outcome;
      const handle = vi.spyOn(ctx.manager, 'handle');
      ws.send(JSON.stringify({ type: 'result', hash: 7 }));
      await new Promise((r) => setTimeout(r, 100));
      expect(handle).toHaveBeenCalledTimes(1);
      // The seat identity has to survive the hop — a handler that passed the wrong
      // connection would attribute one player's commands to another's seat.
      expect(handle.mock.calls[0]![0]).toMatchObject({ owner: 0, roomId: 'room-live' });
      expect(handle.mock.calls[0]![2]).toMatchObject({ type: 'result', hash: 7 });
      ws.close();
    } finally {
      await ctx.close();
    }
  });

  it('drops the seat when the socket closes', async () => {
    const ctx = startServer();
    await new Promise<void>((r) => ctx.server.listen(0, r));
    try {
      const { ws, outcome } = firstOutcome(`${ctx.wsBase}?ticket=${ticketFor()}`);
      await outcome;
      const onClose = vi.spyOn(ctx.manager, 'onClose');
      ws.close();
      await new Promise((r) => setTimeout(r, 150));
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      await ctx.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// main()
// ─────────────────────────────────────────────────────────────────────────────

describe('main() — the CLI entrypoint', () => {
  it('listens, serves, and shuts down in the order that lets the process exit', async () => {
    const exits: number[] = [];
    const app = main({
      port: 0,
      host: '127.0.0.1',
      ticketSecret: { secret: SECRET, isDev: false },
      exit: (c) => void exits.push(c),
    });
    try {
      await new Promise<void>((r) => app.server.once('listening', r));
      const { port } = app.server.address() as AddressInfo;
      expect(port).toBeGreaterThan(0);
      expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);

      // A live room, so `destroyAll` has something to do. Without it this case would assert
      // the shutdown ORDER against an empty room table and prove nothing about it.
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${ticketFor()}`);
      await new Promise<void>((r) => ws.once('message', () => r()));
      expect(app.manager.room('room-live')).toBeTruthy();

      const destroyAll = vi.spyOn(app.manager, 'destroyAll');
      app.shutdown();
      expect(destroyAll).toHaveBeenCalledTimes(1);
      expect(exits).toEqual([0]);
      ws.close();
    } finally {
      // main() registers real signal handlers; leaving them attached leaks across files and
      // eventually trips node's MaxListenersExceededWarning.
      process.off('SIGINT', app.shutdown);
      process.off('SIGTERM', app.shutdown);
      await new Promise((r) => setTimeout(r, 50));
    }
  });

  it('registers SIGINT and SIGTERM, so a deploy actually stops it', async () => {
    const app = main({ port: 0, host: '127.0.0.1', exit: () => {} });
    try {
      await new Promise<void>((r) => app.server.once('listening', r));
      expect(process.listeners('SIGTERM')).toContain(app.shutdown);
      expect(process.listeners('SIGINT')).toContain(app.shutdown);
    } finally {
      app.shutdown();
      process.off('SIGINT', app.shutdown);
      process.off('SIGTERM', app.shutdown);
      await new Promise((r) => setTimeout(r, 50));
    }
  });
});
