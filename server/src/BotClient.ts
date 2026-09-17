/**
 * Practice-bot runner (design/15 follow-up, Matchmaker.ts's `onBotFill`). When a queue
 * bot-fills after sitting out its mode's backfill delay without enough real players,
 * matchsvc spawns one of these per empty seat. It redeems a ticket and opens the
 * gameserver socket EXACTLY like a real player's browser tab would (same
 * ticket-authenticated `/ws` handshake, same `join`/`cmd`/`result` wire messages) —
 * MatchRoom/RoomManager need no bot concept at all, because a bot connection is
 * byte-for-byte the same shape as a human one.
 *
 * It drives a real headless `CoopSession` off the server's confirmed frame stream (full
 * determinism, no shortcuts — the engine can't tell a bot from a remote player, design/08)
 * and picks its own commands from a brain chosen by the room's MODE:
 *
 *   `pvp`   `PvpBotController` — fight the nearest living opponent, idle otherwise.
 *   `coop`  `AllyController` — fight the nearest enemy, and regroup on the human seat when
 *           the floor is quiet. This is not a new bot written for the server: it is the
 *           exact controller the local `?coop=1` toggle has driven the second seat with
 *           since ROADMAP 3.1, which is what made a co-op backfill worth wiring at all
 *           (design/10's front-door audit, 2026-09-17) — the content already existed and
 *           only matchmaking refused to reach it.
 *
 * **The mode comes from `match_start`, never from the caller.** `buildOnlineConfig`
 * (client/src/game/match/matchConfig.ts) is the SAME function every real client builds its
 * EngineConfig with, reading the same `MatchStart` the same gameserver sent — so the bot's
 * engine is byte-identical to every human client's in the room by construction rather than
 * by two call sites agreeing (design/06 anti-drift). It replaced a direct
 * `buildPvpEngineConfig(seed, playerCount)` call, which was correct only for as long as PvP
 * was the only mode a bot could land in.
 *
 * Known limitation (accepted, not solved here): if a bot's socket drops mid-match, this
 * seat behaves exactly like a disconnected real player — MatchRoom pauses the metronome
 * waiting for a reconnect (co-op/PvP are both latency-tolerant) rather than forfeiting.
 * There is no bot reconnect logic; a dropped bot stalls the match same as a dropped human
 * would, an existing accepted tradeoff this feature doesn't change.
 */
import { WebSocket } from 'ws';
import { CoopSession } from '@dd/net/CoopSession';
import type { Transport } from '@dd/net/transport';
import { hashState, type ClientMsg, type GameState, type MatchMode, type PlayerCommand, type ServerMsg } from '@dd/engine';
import { buildOnlineConfig } from '@dd/game/match/matchConfig';
import { AllyController } from '@dd/game/controllers/AllyController';
import { PvpBotController } from '@dd/game/controllers/PvpBotController';

export interface BotClientOptions {
  wsUrl: string; // the gameserver's ws:// origin (matchsvc's GAMESERVER_URL)
  token: string; // a ticket signed for this bot's own seat
  roomId: string;
  owner: number;
  seed: number;
  playerCount: number;
  /** Sim tick cadence (ms) — matches the client's fixed step (30 Hz, SIM_DT_MS). */
  tickMs?: number;
}

const DEFAULT_TICK_MS = 1000 / 30;

/**
 * The seat a co-op ally regroups on when the floor is quiet. Always a REAL player:
 * `Matchmaker.formWithBots` seats every live waiter first and hands the bots the trailing
 * indices, so seat 0 is human in every room that reached this file (`formWithBots` returns
 * early on an empty queue, so a room of nothing but bots cannot be formed).
 */
const LEADER_SEAT = 0;

/** A bot's per-tick command source, once the mode is known. Both controllers are the
 *  client's own — see this file's header on why that matters. */
type Brain = (s: GameState, owner: number, tick: number) => PlayerCommand;

/**
 * The brain a seat in a `mode` room runs. Built per bot rather than shared: `new` is free,
 * and a controller is a seat's command source, not a service.
 *
 * Exported only so a test can pin the CHOICE directly. It cannot be pinned through
 * `runBotClient`: `NetInputSource` relays a command only when it CHANGED (design/15 sparse
 * input sync), so a brain holding its output puts nothing on the wire and there is no
 * tick-aligned stream to compare against — and the two brains agree, tick for tick, in any
 * room where both their targets sit inside `KEEP_DIST_FP`, which a 2-seat arena with a
 * shared spawn is (measured). A test that watched behaviour instead would be green for
 * either wiring.
 */
export function brainFor(mode: MatchMode): Brain {
  if (mode === 'pvp') {
    const pvp = new PvpBotController();
    return (s, o, tick) => pvp.build(s, o, tick);
  }
  const ally = new AllyController();
  // `AllyController` takes the seat to regroup on as well as its own. Passing LEADER_SEAT
  // for every bot is safe precisely because a bot is never seated there; guarding it
  // anyway would be guarding against `formWithBots` changing its seat order, which is a
  // thing a test asserts rather than a thing this file should defend against.
  return (s, o, tick) => ally.build(s, o, LEADER_SEAT, tick);
}

/** Node `ws`-backed Transport — the only place this module touches a real socket.
 *
 * Exported for the same reason `runBotClient` is: it is the half of this file a fake
 * Transport can never exercise, and it was at 0% until 2026-09-03 while the suite around it
 * looked thorough. Three of its behaviours fail SILENTLY on a live socket — a message sent
 * before `open` (every `join`, since `CoopSession` sends one the moment it is constructed and
 * the socket is still CONNECTING), a malformed inbound frame, and a frame arriving before
 * `onMessage` is wired — so none of them would surface as an error anywhere; the bot would
 * just never appear in the match. `BotClient.wsTransport.test.ts` drives it over a real
 * `ws` server. */
export class WsTransport implements Transport {
  private handler: ((msg: ServerMsg) => void) | null = null;
  private readonly ws: WebSocket;
  private readonly outbox: string[] = [];
  private open = false;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on('open', () => {
      this.open = true;
      for (const s of this.outbox) this.ws.send(s);
      this.outbox.length = 0;
    });
    this.ws.on('message', (data: Buffer) => {
      if (!this.handler) return;
      try {
        this.handler(JSON.parse(data.toString('utf8')) as ServerMsg);
      } catch {
        /* ignore malformed frames */
      }
    });
    // MANDATORY, not defensive. `ws` reports socket failures as an 'error' EVENT, and an
    // 'error' event with no listener is an uncaught exception in Node — so without this line
    // a single bot seat failing to connect kills the whole matchsvc process, taking down
    // matchmaking, parties, accounts and the ladder with it. Two ordinary situations reach
    // it: the gameserver being unreachable (`ECONNREFUSED`, i.e. matchsvc outliving a
    // gameserver restart, which is the normal deploy order) and `close()` landing while the
    // socket is still CONNECTING. Verified 2026-09-03 by pointing a bare `ws` client at a
    // dead port — the process died on `connect ECONNREFUSED`.
    //
    // Swallowing is the right response and not a shrug: there is nothing to retry here. The
    // bot is fire-and-forget by design (`spawnBotClient` keeps no handle), and a seat that
    // fails to fill is already the accepted outcome — the room simply runs with one fewer
    // bot, which is what would have happened had the queue not bot-filled at all.
    this.ws.on('error', () => {
      /* see above — the listener's existence is the fix; there is no recovery to attempt */
    });
  }

  send(msg: ClientMsg): void {
    const s = JSON.stringify(msg);
    if (this.open) this.ws.send(s);
    else this.outbox.push(s); // flushed on open
  }

  onMessage(handler: (msg: ServerMsg) => void): void {
    this.handler = handler;
  }

  close(): void {
    this.ws.close();
  }
}

/** Spawn a bot's own connection + session. Fire-and-forget — matchsvc doesn't track the
 * handle; the bot lives and dies with the match (closes itself at match/gameover). */
export function spawnBotClient(opts: BotClientOptions): void {
  runBotClient({ ...opts, transport: new WsTransport(`${opts.wsUrl}?ticket=${encodeURIComponent(opts.token)}`) });
}

/**
 * The testable core: takes an injected Transport (a fake in tests, WsTransport in prod).
 *
 * Returns the live `CoopSession` alongside `stop`. `spawnBotClient` ignores it — nothing in
 * production reads a bot back — but it is the only way to observe the one property this
 * file claims and cannot otherwise show: that the bot's engine agrees, state for state, with
 * the real clients in its room. That is a hash comparison against another session driven off
 * the same frames, and a hash of the bot's own state is not a new capability — it is exactly
 * what `tick` already puts on the wire in its `result` message at gameover.
 */
export function runBotClient(opts: BotClientOptions & { transport: Transport }): { stop: () => void; session: CoopSession } {
  const tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
  let timer: ReturnType<typeof setInterval> | null = null;
  let done = false;
  // Decided in `onMatchStart`, not here: the room's mode is the gameserver's to state (see
  // the header). Null until then is unobservable — nothing ticks before `match_start`.
  let brain: Brain | null = null;

  const session = new CoopSession({
    transport: opts.transport,
    roomId: opts.roomId,
    owner: opts.owner,
    seed: opts.seed,
    playerCount: opts.playerCount,
    buildConfig: buildOnlineConfig,
    onMatchStart: (m) => {
      brain = brainFor(m.mode ?? 'coop');
      timer = setInterval(tick, tickMs);
    },
  });

  function stop(): void {
    if (done) return;
    done = true;
    if (timer !== null) clearInterval(timer);
    session.close();
  }

  function tick(): void {
    // `done` is the only arm of this guard a test can reach (see BotClient.test.ts): `stop`
    // clears the interval, so a tick after teardown needs one already in flight, and
    // `session.started` is set before `onMatchStart` arms the interval at all. Both stay
    // uncovered on purpose — the cost of dropping them is a bot that submits into a closed
    // session, which surfaces as a matchsvc crash rather than a missing bot.
    if (done || !session.started) return;
    const s = session.state!;
    session.submit(brain!(s, opts.owner, session.frame));
    session.drive();
    if (s.phase === 'gameover') {
      session.reportResult(hashState(s));
      stop();
    }
  }

  return { stop, session };
}
