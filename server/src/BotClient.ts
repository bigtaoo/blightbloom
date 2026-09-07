/**
 * PvP practice-bot runner (design/15 follow-up, Matchmaker.ts's `onBotFill`). When a
 * PvP queue bot-fills after sitting `pvpBotFillMs` without enough real players, matchsvc
 * spawns one of these per empty seat. It redeems a ticket and opens the gameserver
 * socket EXACTLY like a real player's browser tab would (same ticket-authenticated `/ws`
 * handshake, same `join`/`cmd`/`result` wire messages) — MatchRoom/RoomManager need no
 * bot concept at all, because a bot connection is byte-for-byte the same shape as a
 * human one.
 *
 * It drives a real headless `CoopSession` off the server's confirmed frame stream (full
 * determinism, no shortcuts — the engine can't tell a bot from a remote player, design/08)
 * and picks its own commands via `PvpBotController` (fight the nearest living opponent,
 * hold position otherwise). `buildPvpEngineConfig` (client/src/game/pvpConfig.ts) is the
 * SAME function `Game.buildOnlineConfig` calls for a real player's pvp branch, so the
 * bot's engine is byte-identical to every human client's (design/06 anti-drift).
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
import { hashState, type ClientMsg, type ServerMsg } from '@dd/engine';
import { buildPvpEngineConfig } from '@dd/game/match/pvpConfig';
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

/** The testable core: takes an injected Transport (a fake in tests, WsTransport in prod). */
export function runBotClient(opts: BotClientOptions & { transport: Transport }): { stop: () => void } {
  const bot = new PvpBotController();
  const tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
  let timer: ReturnType<typeof setInterval> | null = null;
  let done = false;

  const session = new CoopSession({
    transport: opts.transport,
    roomId: opts.roomId,
    owner: opts.owner,
    seed: opts.seed,
    playerCount: opts.playerCount,
    buildConfig: () => buildPvpEngineConfig(opts.seed, opts.playerCount),
    onMatchStart: () => {
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
    session.submit(bot.build(s, opts.owner, session.frame));
    session.drive();
    if (s.phase === 'gameover') {
      session.reportResult(hashState(s));
      stop();
    }
  }

  return { stop };
}
