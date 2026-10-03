/**
 * The PvP bot's parry ONLINE (2026-10-03): through a clocked `MatchRoom` at its shipped 3 frames
 * per 100 ms batch, with the bot reading the confirmed stream the way `BotClient` does. A parry
 * is a 4-tick swing timed against a bullet a few ticks out, so it is the bot's one behaviour that
 * the confirmed stream's lag can quietly undo, and offline tests and sims never see that lag.
 *
 * The gate: online the bot parries at least `ONLINE_SHARE` as often as the same duels offline.
 * The control is the session's default jitter cushion of 3 frames, which `BotClient` ran under
 * until this pass: it fails the gate (11 parries of 30 offline, against 26 at 0).
 */
import { describe, it, expect } from 'vitest';
import { Button, hashState, makeCommand, type Brad, type ClientMsg, type EngineConfig, type GameEvent, type ServerMsg } from '@dd/engine';
import { createGameEngine } from '@dd/engine/GameEngine';
import { CoopSession } from '@dd/net/CoopSession';
import { PvpBotController } from '@dd/game/controllers/PvpBotController';
import type { Transport } from '@dd/net/transport';
import { BOT_BUFFER_FRAMES } from '../src/BotClient';
import { MatchRoom, type IntervalHandle, type RoomConnection, type Scheduler } from '../src/MatchRoom';

const SEED = 3;
const BATCH_MS = 100;
const FPB = 3;
const FRAMES = 900;
const GAPS_PX = [160, 240, 320];
const ONLINE_SHARE = 0.6;

/** Seat 0 stands and shoots; seat 1, the bot, `gap` px east of it. One far mob keeps the match open. */
const duel = (gap: number) => (): EngineConfig => ({
  seed: SEED, worldW: 1600, worldH: 1200, waves: [[[1550, 1150]]],
  players: [{ start: [400, 400], teamId: 0 }, { start: [400 + gap, 400], teamId: 1 }],
});
const shooter = (f: number) => makeCommand({ owner: 0, tick: f, moveBrad: 0 as Brad, moveMag: 0, buttons: Button.FIRE });
const deflects = (events: readonly GameEvent[]) => events.filter((e) => e.type === 'deflect').length;

class ClockedScheduler implements Scheduler {
  t = 0;
  private fns: Array<() => void> = [];
  setInterval(fn: () => void): IntervalHandle {
    this.fns.push(fn);
    return fn;
  }
  clearInterval(): void {}
  setTimeout(fn: () => void): IntervalHandle {
    return fn;
  }
  clearTimeout(): void {}
  readonly now = () => this.t;
  pulseAt(t: number): void {
    this.t = t;
    for (const f of [...this.fns]) f();
  }
}

class Bridge implements Transport {
  readonly conn: RoomConnection;
  private handler: ((m: ServerMsg) => void) | null = null;
  constructor(private readonly room: () => MatchRoom, readonly owner: number) {
    this.conn = { owner, send: (m) => this.handler?.(m) };
  }
  send(m: ClientMsg): void {
    if (m.type === 'cmd') this.room().submitCmd(this.owner, m.cmd);
  }
  onMessage(h: (m: ServerMsg) => void): void {
    this.handler = h;
  }
  close(): void {}
}

function offline(gap: number): number {
  const engine = createGameEngine(duel(gap)());
  const bot = new PvpBotController();
  let n = 0;
  for (let f = 1; f <= FRAMES && engine.state.phase !== 'gameover'; f++) {
    engine.step([shooter(f), bot.build(engine.state, 1, f)]);
    n += deflects(engine.state.events);
  }
  return n;
}

function online(gap: number, botBuffer: number): { parries: number; agree: boolean } {
  const scheduler = new ClockedScheduler();
  let room!: MatchRoom;
  room = new MatchRoom('parry', SEED, 2, { scheduler, onDestroy: () => {}, mode: 'pvp' });
  const bridges = [new Bridge(() => room, 0), new Bridge(() => room, 1)];
  const [human, botSession] = bridges.map(
    (b) =>
      new CoopSession({
        transport: b, roomId: 'parry', owner: b.owner, seed: SEED, playerCount: 2,
        buildConfig: duel(gap), bufferFrames: b.owner === 1 ? botBuffer : 0,
      }),
  );
  for (const b of bridges) expect(room.join(b.conn)).toBe(true);
  const bot = new PvpBotController();
  let parries = 0;
  for (let f = 1; f <= FRAMES; f++) {
    scheduler.t = ((f - 1) * BATCH_MS) / FPB + 1;
    human!.submit(shooter(f));
    // As `runBotClient` ticks: build from the confirmed state, submit, drive. One frame per
    // drive here, since `drive` hands back the last stepped frame's events only.
    botSession!.submit(bot.build(botSession!.state!, 1, botSession!.frame));
    if (f % FPB === 0) scheduler.pulseAt((f / FPB) * BATCH_MS);
    human!.drive();
    for (let tick = botSession!.state!.tick; ; tick = botSession!.state!.tick) {
      const events = botSession!.drive(1);
      if (botSession!.state!.tick === tick) break;
      parries += deflects(events);
    }
  }
  human!.drive();
  return { parries, agree: hashState(human!.state!) === hashState(botSession!.state!) };
}

describe('the PvP bot parries online', () => {
  it('at the shipped batch size, about as often as offline', () => {
    const sum = (f: (gap: number) => number) => GAPS_PX.reduce((n, g) => n + f(g), 0);
    const base = sum(offline);
    expect(base).toBeGreaterThan(0);
    const shipped = GAPS_PX.map((g) => online(g, BOT_BUFFER_FRAMES));
    for (const r of shipped) expect(r.agree).toBe(true);
    expect(shipped.reduce((n, r) => n + r.parries, 0)).toBeGreaterThanOrEqual(ONLINE_SHARE * base);
  });

  it('control: under a 3-frame cushion it reads the match too late, and parries far less', () => {
    const base = GAPS_PX.reduce((n, g) => n + offline(g), 0);
    const cushioned = GAPS_PX.reduce((n, g) => n + online(g, 3).parries, 0);
    expect(cushioned).toBeLessThan(ONLINE_SHARE * base);
  });
});
