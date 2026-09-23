/**
 * BotClient (design/15 follow-up — practice-bot backfill). Proves the wiring, not
 * the individual pieces (PvpBotController's targeting is pinned in the client package's
 * pvpBot.test.ts, AllyController's in ally.test.ts; CoopSession/NetInputSource/
 * FrameBroadcast have their own suites): a bot seat, driven through `runBotClient`,
 * actually submits commands into a REAL MatchRoom's broadcast, keeps submitting as new
 * frames confirm, and stops cleanly without leaking its timer — in-process, no sockets,
 * via a `BridgeTransport` wiring `runBotClient`'s injected `Transport` straight to a
 * `RoomConnection` (mirrors MatchRoom.test.ts's FakeConn/FakeScheduler harness). Fake
 * timers stand in for the bot's `setInterval` tick cadence so the test stays synchronous
 * and deterministic.
 *
 * Since 2026-09-17 a bot also lands in CO-OP rooms (design/10's front-door audit), where
 * it runs a different brain over a different EngineConfig — both decided from the
 * `match_start` the room sends, never from the caller. The last describe here is what pins
 * that, and it is the only place the two halves are observable together.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { Button, hashState, makeCommand, type Brad, type ClientMsg, type PlayerCommand, type ServerMsg } from '@dd/engine';
import { createGameState, type GameState } from '@dd/engine/state/GameState';
import { pxToFp } from '@dd/engine/content/convert';
import { freshStatus } from '@dd/engine/content/damage';
import { BASIC_ENEMY } from '@dd/engine/content/enemies';
import { toFp } from '@dd/engine/math/fixed';
import { ENEMY_TEAM_ID, type EnemyActor } from '@dd/engine/state/entities';
import { CoopSession } from '@dd/net/CoopSession';
import { buildOnlineConfig } from '@dd/game/match/matchConfig';
import { AllyController } from '@dd/game/controllers/AllyController';
import { PvpBotController } from '@dd/game/controllers/PvpBotController';
import type { Transport } from '@dd/net/transport';
import { MatchRoom, type RoomConnection, type Scheduler, type IntervalHandle } from '../src/MatchRoom';
import { brainFor, runBotClient, spawnBotClient } from '../src/BotClient';

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
  // `protected` rather than `private` for `ModeStrippingBridge` below, which wraps the
  // handler on its way in.
  protected handler: ((msg: ServerMsg) => void) | null = null;

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

/**
 * A `BridgeTransport` that deletes `mode` from the `match_start` it relays — the only thing
 * that distinguishes a pre-design/15 gameserver from this one, from a bot's side. Counts what
 * it stripped so a test cannot pass because the field was never there.
 */
class ModeStrippingBridge extends BridgeTransport {
  strippedMatchStarts = 0;

  override onMessage(handler: (msg: ServerMsg) => void): void {
    super.onMessage((msg) => {
      if (msg.type === 'match_start' && msg.mode !== undefined) {
        this.strippedMatchStarts++;
        const { mode: _dropped, ...rest } = msg;
        handler(rest as ServerMsg);
        return;
      }
      handler(msg);
    });
  }
}

/** One enemy at a pixel position — the `brainFor` fixture's only moving part. Mirrors the
 *  client's own `ally.test.ts` helper; `AllyController` reads nothing here but the position. */
function enemyAt(s: GameState, xpx: number, ypx: number): EnemyActor {
  return {
    id: s.nextId(), faction: 'enemy', teamId: ENEMY_TEAM_ID,
    gx: pxToFp(xpx), gy: pxToFp(ypx), z: toFp(0), vx: toFp(0), vy: toFp(0),
    knockVx: toFp(0), knockVy: toFp(0),
    facing: 0 as Brad, hp: BASIC_ENEMY.maxHp, maxHp: BASIC_ENEMY.maxHp,
    shield: 0, maxShield: 0, ticksSinceHit: 0,
    radius: BASIC_ENEMY.radius, footprintRadius: BASIC_ENEMY.footprintRadius, solidRadius: BASIC_ENEMY.radius,
    alive: true, weapon: null, firing: false, status: freshStatus(), enraged: false, armorBroken: false, aggroed: false, holding: false,
  };
}

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

describe('BotClient — a CO-OP room gets an ally, not a PvP practice bot', () => {
  /**
   * A bot decides two things from the room's mode, and they fail differently, so they are
   * asserted separately here.
   *
   * The EngineConfig first, because it is the one that fails silently. Until 2026-09-17 the
   * bot built `buildPvpEngineConfig(seed, playerCount)` for every room — correct only while
   * PvP was the only mode a bot could land in. Dropped into a co-op room it would simulate
   * the ARENA while every human in that room simulated the dungeon: two engines, the same
   * confirmed frames, divergent state from frame one, and nothing anywhere saying so until
   * the end-of-match hashes disagree. So the assertion is the determinism claim itself
   * (design/06) — the bot's state hash against a reference `CoopSession` built the way a
   * browser tab builds one, driven off the same room.
   *
   * NOT asserted by watching what the bot DOES: a wrongly-configured bot is a perfectly
   * busy bot. The arena spawns PvE enemies of its own (three of them alive by tick 600 on
   * this seed), so "the co-op bot fires at something" is true under the old config too —
   * checked, and it is why this test compares states instead.
   */
  it('runs the room\'s own EngineConfig — its state hash matches a real client\'s', () => {
    vi.useFakeTimers();
    const scheduler = new FakeScheduler();
    const room = new MatchRoom('rc1', 4242, 2, { scheduler, onDestroy: () => {}, mode: 'coop', framesPerBatch: 1 });

    // Seat 0: a REAL client session — same `CoopSession`, same `buildOnlineConfig` a browser
    // tab uses (onlineConnect.ts). This is the reference the bot has to agree with.
    const humanBridge = new BridgeTransport(0);
    const humanSession = new CoopSession({
      transport: humanBridge,
      roomId: 'rc1',
      owner: 0,
      seed: 4242,
      playerCount: 2,
      buildConfig: buildOnlineConfig,
    });
    expect(room.join(humanBridge.conn)).toBe(true);

    // Seat 1: the bot.
    const botBridge = new BridgeTransport(1);
    const bot = runBotClient({
      transport: botBridge,
      wsUrl: 'unused',
      token: 'unused',
      roomId: 'rc1',
      owner: 1,
      seed: 4242,
      playerCount: 2,
      tickMs: 10,
    });
    expect(room.join(botBridge.conn)).toBe(true); // completes the room → match_start (mode 'coop')

    for (let i = 1; i <= 120; i++) {
      humanSession.submit(humanCmd(i)); // the human stands still; only the seats' ENGINES matter
      humanSession.drive();
      vi.advanceTimersByTime(10); // one bot tick
      scheduler.pulse(); // one broadcast pulse — both seats get the same confirmed frame
    }
    // Both sessions drain whatever the last pulse confirmed, so the comparison is between
    // two engines at the SAME frame rather than one that saw an extra batch.
    humanSession.drive();
    bot.session.drive();

    expect(humanSession.frame).toBeGreaterThan(0); // the reference really advanced
    expect(bot.session.frame).toBe(humanSession.frame); // same frames confirmed on both
    expect(hashState(bot.session.state!)).toBe(hashState(humanSession.state!));

    bot.stop();
  }, 60_000);

  /**
   * The BRAIN, which fails loudly instead: `PvpBotController` fires at the nearest player on
   * a DIFFERENT team, and a co-op seat has no such thing — the co-op branch of
   * `buildOnlineConfig` sets no `teamId`, so `GameState.buildSeat` gives every seat the
   * shared default 0 (`seat.teamId ?? 0`). Its candidate list is empty on every tick of
   * every co-op match, so the old brain could only ever emit `idleCommand`: a partner who
   * stands at the door for the whole run. `AllyController` engages the floor's enemies, so
   * one FIRE on the wire is the whole difference.
   */
  it('picks the brain from the MODE — ally for co-op, practice bot for pvp', () => {
    /**
     * The choice itself, pinned where it is made rather than through a running bot.
     *
     * Not an integration test on purpose, and the reason is the finding that produced this
     * one: watching a live bot cannot tell the two brains apart. `NetInputSource` relays
     * only a command that CHANGED (design/15 sparse input sync), so a brain holding its
     * output sends nothing and there is no tick-aligned stream to diff — and in a 2-seat
     * arena both seats spawn together, inside `KEEP_DIST_FP` of each other AND of the
     * arena's own PvE spawns, so both brains hold and fire and emit byte-identical commands
     * for hundreds of ticks (measured: gap 438 fp at tick 400, under either wiring).
     *
     * The fixture is therefore built to make them DISAGREE: an enemy to the ally's east and
     * an opposing player to its west, so each brain walks the other way.
     */
    const state = createGameState({
      seed: 3,
      worldW: 1600,
      worldH: 1200,
      waves: [],
      // Seat 0 west of the bot; DISTINCT teams, so `PvpBotController` has a target at all.
      players: [{ start: [200, 400], teamId: 0 }, { start: [400, 400], teamId: 1 }],
    });
    state.enemies.push(enemyAt(state, 600, 400)); // and an enemy to its east, for the ally

    const ally = brainFor('coop')(state, 1, 5);
    const pvp = brainFor('pvp')(state, 1, 5);
    expect(ally, 'fixture does not separate the brains').not.toEqual(pvp);

    // Each matches the controller it is supposed to BE, rather than merely differing from
    // the other one — "they differ" is also true of a third, wrong brain.
    expect(ally).toEqual(new AllyController().build(state, 1, 0, 5));
    expect(pvp).toEqual(new PvpBotController().build(state, 1, 5));

  });

  it('falls back to the ally when `match_start` states no mode at all', () => {
    /**
     * `runBotClient` spells the fallback `m.mode ?? 'coop'`, matching the protocol's own
     * default (`protocol.ts`: "Optional/absent → 'coop'"). Every `MatchRoom` in this repo
     * sends a mode, so nothing else in the suite reaches that `??` — it is there for a
     * gameserver older than design/15, and the cost of getting it wrong is an arena bot
     * standing in a dungeon, which is the one combination that does nothing at all.
     *
     * The harness is the co-op room from the test above with ONE variable changed: a
     * transport that deletes `mode` from `match_start` as it passes. Real frames, real
     * state, real `MatchRoom` — only the server's claim about the mode is missing, which
     * is exactly what an old gameserver looks like from here.
     */
    vi.useFakeTimers();
    const scheduler = new FakeScheduler();
    const room = new MatchRoom('rc4', 4242, 2, { scheduler, onDestroy: () => {}, mode: 'coop', framesPerBatch: 1 });

    const human: RoomConnection = { owner: 0, send: () => {} };
    room.join(human);
    const bridge = new ModeStrippingBridge(1);
    const bot = runBotClient({
      transport: bridge,
      wsUrl: 'unused',
      token: 'unused',
      roomId: 'rc4',
      owner: 1,
      seed: 4242,
      playerCount: 2,
      tickMs: 10,
    });
    room.join(bridge.conn);

    expect(bridge.strippedMatchStarts).toBe(1); // the harness really did remove it

    const fired = (): boolean =>
      bridge.sent.some((m) => m.type === 'cmd' && m.cmd.owner === 1 && (m.cmd.buttons & Button.FIRE) !== 0);
    for (let i = 0; i < 3_000 && !fired(); i++) {
      room.submitCmd(0, humanCmd(i + 1));
      vi.advanceTimersByTime(10);
      scheduler.pulse();
    }

    // Same discriminator as the co-op case: a `PvpBotController` here has no other-team
    // player to target and can only idle, so one FIRE is the fallback having chosen an ally.
    expect(fired()).toBe(true);
    bot.stop();
  }, 60_000);

  it('a co-op seat has no OPPONENT, which is why the old brain could only idle there', () => {
    vi.useFakeTimers();
    const scheduler = new FakeScheduler();
    const room = new MatchRoom('rc2', 4242, 2, { scheduler, onDestroy: () => {}, mode: 'coop', framesPerBatch: 1 });

    const human: RoomConnection = { owner: 0, send: () => {} };
    expect(room.join(human)).toBe(true);
    const bridge = new BridgeTransport(1);
    const bot = runBotClient({
      transport: bridge,
      wsUrl: 'unused',
      token: 'unused',
      roomId: 'rc2',
      owner: 1,
      seed: 4242,
      playerCount: 2,
      tickMs: 10,
    });
    room.join(bridge.conn);

    const fired = (): boolean =>
      bridge.sent.some((m) => m.type === 'cmd' && m.cmd.owner === 1 && (m.cmd.buttons & Button.FIRE) !== 0);

    for (let i = 0; i < 3_000 && !fired(); i++) {
      room.submitCmd(0, humanCmd(i + 1)); // the human stands still the whole time
      vi.advanceTimersByTime(10);
      scheduler.pulse();
    }

    // Every co-op seat shares team 0, so `PvpBotController`'s candidate list — living
    // players on a DIFFERENT team — is empty for the whole match, and its only possible
    // output is `idleCommand`. The ally fires. That gap is the player-visible difference
    // between a partner and a mannequin standing at the door.
    expect(bot.session.state!.players.map((p) => p.teamId)).toEqual([0, 0]);
    expect(fired()).toBe(true);
    bot.stop();
  }, 60_000);
});
