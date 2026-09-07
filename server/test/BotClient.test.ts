/**
 * BotClient (design/15 follow-up — PvP practice-bot backfill). Proves the wiring, not
 * the individual pieces (PvpBotController's targeting is pinned in the client package's
 * pvpBot.test.ts; CoopSession/NetInputSource/FrameBroadcast have their own suites): a
 * bot seat, driven through `runBotClient`, actually submits commands into a REAL
 * MatchRoom's broadcast, keeps submitting as new frames confirm, and stops cleanly
 * without leaking its timer — in-process, no sockets, via a `BridgeTransport` wiring
 * `runBotClient`'s injected `Transport` straight to a `RoomConnection` (mirrors
 * MatchRoom.test.ts's FakeConn/FakeScheduler harness). Fake timers stand in for the
 * bot's `setInterval` tick cadence so the test stays synchronous and deterministic.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { makeCommand, type Brad, type ClientMsg, type PlayerCommand, type ServerMsg } from '@dd/engine';
import type { Transport } from '@dd/net/transport';
import { MatchRoom, type RoomConnection, type Scheduler, type IntervalHandle } from '../src/MatchRoom';
import { runBotClient, spawnBotClient } from '../src/BotClient';

class FakeScheduler implements Scheduler {
  private fns: Array<() => void> = [];
  setInterval(fn: () => void): IntervalHandle {
    this.fns.push(fn);
    return fn;
  }
  clearInterval(h: IntervalHandle): void {
    this.fns = this.fns.filter((f) => f !== h);
  }
  pulse(): void {
    for (const f of [...this.fns]) f();
  }
}

/** Wires a bot's Transport straight to a RoomConnection — no socket, synchronous. */
class BridgeTransport implements Transport {
  readonly conn: RoomConnection;
  readonly sent: ClientMsg[] = [];
  closed = false;
  private handler: ((msg: ServerMsg) => void) | null = null;

  constructor(owner: number) {
    this.conn = { owner, send: (m) => this.handler?.(m) };
  }
  send(msg: ClientMsg): void {
    this.sent.push(msg);
  }
  onMessage(handler: (msg: ServerMsg) => void): void {
    this.handler = handler;
  }
  close(): void {
    this.closed = true;
  }
}

const humanCmd = (tick: number): PlayerCommand =>
  makeCommand({ owner: 0, tick, moveBrad: 0 as Brad, moveMag: 0, buttons: 0 });

afterEach(() => {
  vi.useRealTimers();
});

describe('BotClient — drives a real seat through a real MatchRoom', () => {
  it('submits commands into the broadcast as frames confirm, then stops cleanly', () => {
    vi.useFakeTimers();
    const scheduler = new FakeScheduler();
    const room = new MatchRoom('r1', 99, 2, { scheduler, onDestroy: () => {}, mode: 'pvp', framesPerBatch: 1 });

    // Seat 0: a silent human stand-in — the test drives its commands directly.
    const human: RoomConnection = { owner: 0, send: () => {} };
    expect(room.join(human)).toBe(true);

    // Seat 1: the bot, wired via the bridge instead of a socket.
    const bridge = new BridgeTransport(1);
    const bot = runBotClient({
      transport: bridge,
      wsUrl: 'unused', // spawnBotClient's own concern, not runBotClient's
      token: 'unused',
      roomId: 'r1',
      owner: 1,
      seed: 99,
      playerCount: 2,
      tickMs: 10,
    });
    expect(room.join(bridge.conn)).toBe(true); // completes the room → match_start fires

    // room.join → launch() → conn.send(match_start) all happen synchronously in-process,
    // so the bot's onMatchStart has already armed its (fake-timer) tick interval.
    room.submitCmd(0, humanCmd(1));
    vi.advanceTimersByTime(10); // one bot tick: computes + submits its own command
    scheduler.pulse(); // one broadcast pulse: confirms the frame both seats submitted to
    room.submitCmd(0, humanCmd(2));
    vi.advanceTimersByTime(10); // the bot drains the newly-confirmed frame, submits again
    scheduler.pulse();

    const cmdMsgsFromBot = bridge.sent.filter((m) => m.type === 'cmd' && m.cmd.owner === 1);
    expect(cmdMsgsFromBot.length).toBeGreaterThan(0); // the bot is a live command source
    expect(bridge.closed).toBe(false); // match still running — no close yet

    bot.stop();
    expect(bridge.closed).toBe(true);
    const sentCountAtStop = bridge.sent.length;
    vi.advanceTimersByTime(50); // any leftover interval must have been cleared by stop()
    scheduler.pulse();
    expect(bridge.sent.length).toBe(sentCountAtStop); // no further ticks after stop()
  });
});

describe('BotClient — stop() is idempotent and final', () => {
  // The `done` flag's two arms. `stop()` is reachable twice in production — from `tick`'s
  // gameover branch and from whatever tears the bot down — and a second `clearInterval` on a
  // stale handle is harmless, but a second `session.close()` is not: it closes a socket a
  // NEW bot may already have been handed for the same seat.
  it('ignores a second stop, and ticks nothing after the first', () => {
    vi.useFakeTimers();
    const scheduler = new FakeScheduler();
    const room = new MatchRoom('r2', 5, 2, { scheduler, onDestroy: () => {}, mode: 'pvp', framesPerBatch: 1 });
    const human: RoomConnection = { owner: 0, send: () => {} };
    room.join(human);

    const bridge = new BridgeTransport(1);
    const bot = runBotClient({
      transport: bridge,
      wsUrl: 'unused',
      token: 'unused',
      roomId: 'r2',
      owner: 1,
      seed: 5,
      playerCount: 2,
      // no tickMs — exercises the DEFAULT_TICK_MS fallback, i.e. the cadence every real
      // bot actually runs at (matchsvc never passes one).
    });
    room.join(bridge.conn);

    bot.stop();
    expect(bridge.closed).toBe(true);
    const sentAtStop = bridge.sent.length;

    bot.stop(); // second call: must be a no-op, not a second close
    vi.advanceTimersByTime(500);
    scheduler.pulse();
    expect(bridge.sent.length).toBe(sentAtStop);
  });
});

describe('BotClient — the match ending', () => {
  it('reports its result and closes itself once the sim reaches gameover', () => {
    // The gameover arm of `tick`, and the reason a bot is fire-and-forget: nothing tracks the
    // handle, so if this branch never fired every bot-filled match would leak a live socket
    // and a 30 Hz interval for the lifetime of the process.
    vi.useFakeTimers();
    const scheduler = new FakeScheduler();
    const room = new MatchRoom('r3', 11, 2, { scheduler, onDestroy: () => {}, mode: 'pvp', framesPerBatch: 1 });

    // Seat 0 is a human who never acts, so the bot wins on its own — the match really does
    // reach gameover rather than being told it has.
    const human: RoomConnection = { owner: 0, send: () => {} };
    room.join(human);
    const bridge = new BridgeTransport(1);
    runBotClient({
      transport: bridge,
      wsUrl: 'unused',
      token: 'unused',
      roomId: 'r3',
      owner: 1,
      seed: 11,
      playerCount: 2,
      tickMs: 10,
    });
    room.join(bridge.conn);

    for (let i = 0; i < 20_000 && !bridge.closed; i++) {
      room.submitCmd(0, humanCmd(i + 1));
      vi.advanceTimersByTime(10);
      scheduler.pulse();
    }

    expect(bridge.closed).toBe(true); // stop() ran, which only the gameover arm does here
    const results = bridge.sent.filter((m) => m.type === 'result');
    expect(results).toHaveLength(1); // exactly one, from the tick that saw gameover
  }, 60_000);
});

describe('spawnBotClient — the production entry point', () => {
  it('opens a ticket-authenticated socket at the given gameserver URL', async () => {
    // `spawnBotClient` is the only line matchsvc actually calls, and it was uncovered: the
    // suite above drives `runBotClient` with an injected transport, which skips both the URL
    // assembly and the ticket encoding. A token that is not URL-encoded arrives truncated at
    // the first `+` or `=` and the gameserver refuses the handshake — silently, from the
    // bot's side.
    vi.useRealTimers();
    const wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((r) => wss.once('listening', () => r()));
    const { port } = wss.address() as AddressInfo;
    const seen: string[] = [];
    wss.on('connection', (_ws, req) => seen.push(req.url ?? ''));
    try {
      const token = 'a+b/c=d'; // the characters base64url signing produces that URLs mangle
      spawnBotClient({
        wsUrl: `ws://127.0.0.1:${port}/ws`,
        token,
        roomId: 'r4',
        owner: 1,
        seed: 3,
        playerCount: 2,
      });
      const deadline = Date.now() + 3000;
      while (seen.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));

      expect(seen).toHaveLength(1);
      const query = new URL(seen[0]!, 'ws://x').searchParams;
      expect(query.get('ticket')).toBe(token);
    } finally {
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
    }
  }, 20_000);
});

describe('BotClient — a bot torn down before its match ever starts', () => {
  /**
   * The unarmed-timer path through `stop()`. `onMatchStart` is what arms the tick interval,
   * so a bot whose room never fills — matchmaking cancelled, the human seat never arrived,
   * the process shutting down between spawn and launch — reaches `stop()` having never had
   * one. `spawnBotClient` is fire-and-forget, so anything that throws in here lands on
   * matchsvc rather than on the bot.
   *
   * What this asserts is the TEARDOWN, not the `timer !== null` check itself: that check is
   * defensive rather than load-bearing (Node's `clearInterval` tolerates a null handle, so
   * deleting the guard keeps this test green — checked). The property worth pinning is that
   * a bot abandoned before launch still closes its transport and leaves nothing scheduled;
   * a leaked interval here is a matchsvc that never exits.
   */
  it('closes its transport without touching a timer that was never armed', () => {
    vi.useFakeTimers();
    const bridge = new BridgeTransport(1);
    const bot = runBotClient({
      transport: bridge,
      wsUrl: 'unused',
      token: 'unused',
      roomId: 'r5',
      owner: 1,
      seed: 11,
      playerCount: 2,
    });
    // Nobody joined this bot to a room, so no `match_start` ever reached it.
    expect(vi.getTimerCount()).toBe(0);

    expect(() => bot.stop()).not.toThrow();
    expect(bridge.closed).toBe(true);

    // And it stays torn down: the late `match_start` a racing matchmaker could still deliver
    // must not resurrect a bot whose session is already closed.
    vi.advanceTimersByTime(1000);
    expect(vi.getTimerCount()).toBe(0);
  });
});
