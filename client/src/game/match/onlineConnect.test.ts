/**
 * connectOnlineSession (ROADMAP 3.3; design/10 screen-flow gap — the Matchmaking
 * screen). Previously untested (no `fetch`/transport injection existed at all — every
 * prior verification was live-browser only, per ROADMAP's "browser-verified two-tab"
 * notes). Now drives it with a fake `findMatch` fetch (same convention as
 * `net/matchmaking.test.ts`) and a fake `Transport` (same shape as
 * `net/coopsession.test.ts`'s `FakeTransport`), so the whole matchmaking → ticket →
 * match_start / timeout / disconnect / cancel flow is testable with no real network or
 * WebSocket.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { connectOnlineSession } from './onlineConnect';
import type { Transport } from '../../net/transport';
import type { ClientMsg, ServerMsg } from '@dd/engine';

class FakeTransport implements Transport {
  readonly sent: ClientMsg[] = [];
  closed = false;
  private handler: ((m: ServerMsg) => void) | null = null;
  private disconnectHandler: ((reason: string) => void) | null = null;
  send(m: ClientMsg): void {
    this.sent.push(m);
  }
  onMessage(h: (m: ServerMsg) => void): void {
    this.handler = h;
  }
  onDisconnect(h: (reason: string) => void): void {
    this.disconnectHandler = h;
  }
  close(): void {
    this.closed = true;
  }
  deliver(m: ServerMsg): void {
    this.handler?.(m);
  }
  fail(reason: string): void {
    this.disconnectHandler?.(reason);
  }
}

const MATCH = { wsUrl: 'ws://localhost:8787/ws', roomId: 'room-1', owner: 0, seed: 1, playerCount: 2, teamId: 0, token: 'tok' };
const MATCH_START: ServerMsg = { type: 'match_start', seed: 1, startFrame: 0, localOwner: 0, playerCount: 2 };

/** A fetch stub that returns the queued JSON bodies in sequence — mirrors
 * matchmaking.test.ts's own `fakeFetch` exactly. */
function fakeFetch(bodies: unknown[]) {
  let i = 0;
  // The parameters are declared (rather than the bare `async () =>` this used to be) so a
  // test can read what was SENT off `mock.calls` — the /find request body is the subject of
  // the seat-count case below, and an untyped mock types its calls as `[]`.
  return vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
    const body = bodies[Math.min(i++, bodies.length - 1)];
    return { ok: true, status: 200, json: async () => body } as Response;
  });
}

const noSleep = async () => {};

/** Flush the microtask queue (fetch/json Promise chain resolution) without needing fake
 * timers — connectOnlineSession's own internal setTimeout is untouched by this. */
async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

afterEach(() => vi.useRealTimers());

describe('connectOnlineSession — success', () => {
  it('resolves with a live, started CoopSession once match_start arrives', async () => {
    let transport!: FakeTransport;
    const promise = connectOnlineSession({
      matchBaseUrl: 'http://mm', pvp: false, pvpSeats: 2, lagMs: 0,
      onMatchStart: () => {},
      fetch: fakeFetch([{ queueId: 'q1', match: MATCH }]),
      sleep: noSleep,
      createTransport: (url) => {
        transport = new FakeTransport();
        expect(url).toBe(`${MATCH.wsUrl}?ticket=${MATCH.token}`);
        return transport;
      },
    });
    await flush();
    transport.deliver(MATCH_START);

    const session = await promise;
    expect(session.started).toBe(true);
  });

  it('calls onMatchStart with the ticket-assigned localOwner before resolving', async () => {
    let transport!: FakeTransport;
    const seen: number[] = [];
    const promise = connectOnlineSession({
      matchBaseUrl: 'http://mm', pvp: false, pvpSeats: 2, lagMs: 0,
      onMatchStart: (localOwner) => seen.push(localOwner),
      fetch: fakeFetch([{ queueId: 'q1', match: MATCH }]),
      sleep: noSleep,
      createTransport: () => (transport = new FakeTransport()),
    });
    await flush();
    transport.deliver({ ...MATCH_START, localOwner: 1 });
    await promise;
    expect(seen).toEqual([1]);
  });

  it('asks for TWO seats in co-op and `pvpSeats` in pvp — the request, not the ticket', async () => {
    /**
     * `playerCount: opts.pvp ? opts.pvpSeats : COOP_SEATS` is the only place the co-op match SIZE is
     * decided, and the server's co-op bot backfill rests on it: `Matchmaker.formWithBots`
     * fills every seat the real waiters did not take, so "co-op gets exactly one AI ally"
     * is a fact about this line and nothing else (design/10, 2026-09-17). Dropping the
     * ternary would hand a solo co-op player three bots instead of one, silently.
     *
     * Every other case in this file passes `pvpSeats: 2`, so none of them can see the
     * difference — and the assertion has to read the /find REQUEST, because the join below
     * is built from the ticket the server sent back, which is the server's answer rather
     * than the client's question.
     */
    const coopFetch = fakeFetch([{ queueId: 'q1', match: MATCH }]);
    await connectOnlineSession({
      matchBaseUrl: 'http://mm', pvp: false, pvpSeats: 8, lagMs: 0, // pvpSeats set, and IGNORED
      onMatchStart: () => {},
      fetch: coopFetch,
      sleep: noSleep,
      createTransport: () => new FakeTransport(),
      matchStartTimeoutMs: 1,
    }).catch(() => {}); // never resolves here — no match_start is delivered; the POST is the subject
    await flush();
    const coopBody = JSON.parse(coopFetch.mock.calls[0]![1]!.body as string);
    expect(coopBody).toMatchObject({ playerCount: 2, mode: 'coop' });

    const pvpFetch = fakeFetch([{ queueId: 'q2', match: MATCH }]);
    await connectOnlineSession({
      matchBaseUrl: 'http://mm', pvp: true, pvpSeats: 8, lagMs: 0,
      onMatchStart: () => {},
      fetch: pvpFetch,
      sleep: noSleep,
      createTransport: () => new FakeTransport(),
      matchStartTimeoutMs: 1,
    }).catch(() => {});
    await flush();
    const pvpBody = JSON.parse(pvpFetch.mock.calls[0]![1]!.body as string);
    expect(pvpBody).toMatchObject({ playerCount: 8, mode: 'pvp' });
  });

  it('hands the queue countdown through to the caller, and a co-op party id with it', async () => {
    const fetch = fakeFetch([{ queueId: 'q1', botFillInMs: 5_000 }, { status: 'matched', match: MATCH }]);
    const onQueued = vi.fn();
    await connectOnlineSession({
      matchBaseUrl: 'http://mm', pvp: false, pvpSeats: 8, lagMs: 0, partyId: 'party-3',
      onMatchStart: () => {},
      onQueued,
      fetch,
      sleep: noSleep,
      createTransport: () => new FakeTransport(),
      matchStartTimeoutMs: 1,
    }).catch(() => {});
    await flush();
    expect(onQueued).toHaveBeenCalledWith({ botFillInMs: 5_000 });
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toMatchObject({ playerCount: 2, mode: 'coop', partyId: 'party-3' });
  });

  it('joins the room with the seat/seed/playerCount the ticket assigned', async () => {
    let transport!: FakeTransport;
    const promise = connectOnlineSession({
      matchBaseUrl: 'http://mm', pvp: true, pvpSeats: 8, lagMs: 0,
      onMatchStart: () => {},
      fetch: fakeFetch([{ queueId: 'q1', match: MATCH }]),
      sleep: noSleep,
      createTransport: () => (transport = new FakeTransport()),
    });
    await flush();
    expect(transport.sent).toEqual([{ type: 'join', roomId: MATCH.roomId, owner: MATCH.owner, seed: MATCH.seed, playerCount: MATCH.playerCount }]);
    transport.deliver(MATCH_START);
    await promise;
  });
});

describe('connectOnlineSession — failure before a transport ever exists', () => {
  it('propagates a findMatch failure (e.g. cancelled) without constructing a transport', async () => {
    const createTransport = vi.fn();
    const signal = { cancelled: true };
    await expect(
      connectOnlineSession({
        matchBaseUrl: 'http://mm', pvp: false, pvpSeats: 2, lagMs: 0,
        onMatchStart: () => {},
        fetch: fakeFetch([{ queueId: 'q1' }]),
        sleep: noSleep,
        signal,
        createTransport,
      }),
    ).rejects.toThrow(/cancelled/);
    expect(createTransport).not.toHaveBeenCalled();
  });

  it('propagates a matchsvc service error the same way', async () => {
    const fetch = vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: 'playerCount must be an integer in [1, 8]' }) } as Response));
    await expect(
      connectOnlineSession({
        matchBaseUrl: 'http://mm', pvp: true, pvpSeats: 99, lagMs: 0,
        onMatchStart: () => {},
        fetch, sleep: noSleep,
      }),
    ).rejects.toThrow(/playerCount/);
  });
});

describe('connectOnlineSession — failure after ticket redemption (design/10 gap)', () => {
  it('rejects if the transport disconnects before match_start ever arrives', async () => {
    let transport!: FakeTransport;
    const promise = connectOnlineSession({
      matchBaseUrl: 'http://mm', pvp: false, pvpSeats: 2, lagMs: 0,
      onMatchStart: () => {},
      fetch: fakeFetch([{ queueId: 'q1', match: MATCH }]),
      sleep: noSleep,
      createTransport: () => (transport = new FakeTransport()),
    });
    await flush();
    transport.fail('socket closed (1006)');
    await expect(promise).rejects.toThrow(/connection failed/);
  });

  it('rejects after matchStartTimeoutMs if match_start never arrives, and closes the transport', async () => {
    vi.useFakeTimers();
    let transport!: FakeTransport;
    const promise = connectOnlineSession({
      matchBaseUrl: 'http://mm', pvp: false, pvpSeats: 2, lagMs: 0,
      onMatchStart: () => {},
      fetch: fakeFetch([{ queueId: 'q1', match: MATCH }]),
      sleep: noSleep,
      matchStartTimeoutMs: 5000,
      createTransport: () => (transport = new FakeTransport()),
    });
    await flush();
    // Attach the rejection expectation BEFORE advancing timers, so the handler is in
    // place the instant the timer fires — otherwise there's a real window where the
    // rejection is briefly "unhandled" from Node's perspective (a test-ordering
    // artifact, not a bug in connectOnlineSession itself).
    const rejected = expect(promise).rejects.toThrow(/timed out waiting for the match to start/);
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    expect(transport.closed).toBe(true);
  });

  it('a disconnect that arrives AFTER match_start (late/duplicate close event) never rejects the already-settled promise', async () => {
    let transport!: FakeTransport;
    const promise = connectOnlineSession({
      matchBaseUrl: 'http://mm', pvp: false, pvpSeats: 2, lagMs: 0,
      onMatchStart: () => {},
      fetch: fakeFetch([{ queueId: 'q1', match: MATCH }]),
      sleep: noSleep,
      reconnectSleep: noSleep,
      createTransport: () => (transport = new FakeTransport()),
    });
    await flush();
    transport.deliver(MATCH_START);
    const session = await promise;
    expect(() => transport.fail('socket closed (1000)')).not.toThrow();
    expect(session.started).toBe(true); // unaffected — nothing to reject into any more
    await flush(); // let the reconnect attempt this now kicks off (see below) settle
  });

  it('a timeout that fires AFTER match_start never rejects an already-resolved promise', async () => {
    vi.useFakeTimers();
    let transport!: FakeTransport;
    const promise = connectOnlineSession({
      matchBaseUrl: 'http://mm', pvp: false, pvpSeats: 2, lagMs: 0,
      onMatchStart: () => {},
      fetch: fakeFetch([{ queueId: 'q1', match: MATCH }]),
      sleep: noSleep,
      matchStartTimeoutMs: 5000,
      createTransport: () => (transport = new FakeTransport()),
    });
    await flush();
    transport.deliver(MATCH_START);
    await promise; // resolved well before the timeout
    await vi.advanceTimersByTimeAsync(5000);
    expect(transport.closed).toBe(false); // the timeout's own transport.close() never ran
  });
});

describe('connectOnlineSession — mid-match reconnect (ROADMAP reconnect, design/06)', () => {
  const RESUMED = { ...MATCH, token: 'tok2' };

  it('a mid-match disconnect requests a resume ticket and sends `resume` (not `join`) on the fresh transport', async () => {
    let transport!: FakeTransport;
    let transport2!: FakeTransport;
    const resumeFetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ match: RESUMED }) }) as unknown as Response);
    const reconnecting: number[] = [];
    let reconnected = false;

    const promise = connectOnlineSession({
      matchBaseUrl: 'http://mm', pvp: false, pvpSeats: 2, lagMs: 0,
      onMatchStart: () => {},
      fetch: fakeFetch([{ queueId: 'q1', match: MATCH }]),
      sleep: noSleep,
      reconnectSleep: noSleep,
      resumeFetch,
      onReconnecting: (n) => reconnecting.push(n),
      onReconnected: () => { reconnected = true; },
      createTransport: (url) => {
        if (!transport) {
          expect(url).toBe(`${MATCH.wsUrl}?ticket=${MATCH.token}`);
          return (transport = new FakeTransport());
        }
        expect(url).toBe(`${RESUMED.wsUrl}?ticket=${RESUMED.token}`);
        return (transport2 = new FakeTransport());
      },
    });
    await flush();
    transport.deliver(MATCH_START);
    await promise;

    transport.fail('socket closed (1006)');
    await flush(10);

    expect(resumeFetch).toHaveBeenCalledTimes(1);
    expect(reconnecting).toEqual([1]);
    expect(reconnected).toBe(true);
    expect(transport2.sent).toEqual([{ type: 'resume', roomId: MATCH.roomId, owner: MATCH.owner, lastFrame: 0 }]);
  });

  it('gives up after maxReconnectAttempts and reports the last failure', async () => {
    const resumeFetch = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ error: 'boom' }) }) as unknown as Response);
    let lost: string | undefined;
    let transport!: FakeTransport;

    const promise = connectOnlineSession({
      matchBaseUrl: 'http://mm', pvp: false, pvpSeats: 2, lagMs: 0,
      onMatchStart: () => {},
      fetch: fakeFetch([{ queueId: 'q1', match: MATCH }]),
      sleep: noSleep,
      reconnectSleep: noSleep,
      resumeFetch,
      maxReconnectAttempts: 2,
      onConnectionLost: (reason) => { lost = reason; },
      createTransport: () => (transport = new FakeTransport()),
    });
    await flush();
    transport.deliver(MATCH_START);
    await promise;

    transport.fail('socket closed (1006)');
    await flush(20);

    expect(resumeFetch).toHaveBeenCalledTimes(2);
    expect(lost).toMatch(/boom/);
  });

  it('a `resume_failed` server error ends the retry loop immediately, without waiting out further attempts', async () => {
    let transport!: FakeTransport;
    let transport2!: FakeTransport;
    let lost: string | undefined;
    const resumeFetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ match: RESUMED }) }) as unknown as Response);

    const promise = connectOnlineSession({
      matchBaseUrl: 'http://mm', pvp: false, pvpSeats: 2, lagMs: 0,
      onMatchStart: () => {},
      fetch: fakeFetch([{ queueId: 'q1', match: MATCH }]),
      sleep: noSleep,
      reconnectSleep: noSleep,
      resumeFetch,
      onConnectionLost: (reason) => { lost = reason; },
      createTransport: () => (transport ? (transport2 = new FakeTransport()) : (transport = new FakeTransport())),
    });
    await flush();
    transport.deliver(MATCH_START);
    await promise;

    transport.fail('socket closed (1006)');
    await flush(10);
    transport2.deliver({ type: 'error', code: 'resume_failed', message: 'match already ended' });
    await flush();

    expect(lost).toBe('match already ended');
  });
});
