/**
 * The whole online path at the SHIPPED batch size (2026-10-03, volume 121): two real
 * `CoopSession`s through a real `MatchRoom` at its default 3 frames per 100 ms batch, with a
 * clocked scheduler, against the LOCAL run of the same intent.
 *
 * The relay tests in `BotClient.test.ts` all run at `framesPerBatch: 1`, where a batch has no
 * frames between its watermarks — which is how every online seat moving one frame in three
 * (`NetInputSource` filling only each batch's last frame) went unseen. This file is the one
 * place the room's timing, the frame landing and the client's held-input fill meet at the
 * batch size players actually get.
 *
 * What it does NOT pin: a one-shot repeated on held frames (a starting seat has one weapon,
 * so a repeated swap changes nothing — `netinput.test.ts` pins that), and two commands folding
 * on one frame (one command per seat per frame here — `framebroadcast.test.ts` pins that).
 */
import { describe, it, expect } from 'vitest';
import { Button, hashState, makeCommand, type Brad, type ClientMsg, type MatchStart, type PlayerCommand, type ServerMsg } from '@dd/engine';
import { toReplay, runReplay } from '@dd/engine/replay';
import { CoopSession } from '@dd/net/CoopSession';
import { buildOnlineConfig } from '@dd/game/match/matchConfig';
import type { Transport } from '@dd/net/transport';
import { MatchRoom, type IntervalHandle, type RoomConnection, type Scheduler } from '../src/MatchRoom';

const SEED = 4242;
const BATCH_MS = 100;
const FPB = 3;
const FRAMES = 90; // 30 batches, 3 s

class ClockedScheduler implements Scheduler {
  t = 0;
  private fns: Array<() => void> = [];
  constructor(private readonly clocked: boolean) {}
  setInterval(fn: () => void): IntervalHandle {
    this.fns.push(fn);
    return fn;
  }
  clearInterval(h: IntervalHandle): void {
    this.fns = this.fns.filter((f) => f !== h);
  }
  setTimeout(fn: () => void): IntervalHandle {
    return fn;
  }
  clearTimeout(): void {}
  get now(): (() => number) | undefined {
    return this.clocked ? () => this.t : undefined;
  }
  pulseAt(t: number): void {
    this.t = t;
    for (const f of [...this.fns]) f();
  }
}

/** A seat's transport wired straight to the room: what it sends is submitted at the clock's now. */
class Bridge implements Transport {
  readonly conn: RoomConnection;
  start: MatchStart | null = null;
  private handler: ((m: ServerMsg) => void) | null = null;
  constructor(private readonly room: () => MatchRoom, readonly owner: number) {
    this.conn = {
      owner,
      send: (m) => {
        if (m.type === 'match_start') this.start = m;
        this.handler?.(m);
      },
    };
  }
  send(m: ClientMsg): void {
    if (m.type === 'cmd') this.room().submitCmd(this.owner, m.cmd);
  }
  onMessage(h: (m: ServerMsg) => void): void {
    this.handler = h;
  }
  close(): void {}
}

/**
 * What each seat intends on sim frame `f`: seat 0 runs east, stops, then taps a weapon swap
 * once; seat 1 runs north firing, then turns west. Most frames repeat the previous command,
 * so the client sends nothing and the hold has to carry the seat.
 */
function intent(owner: number, f: number): PlayerCommand {
  if (owner === 0) {
    const run = f <= 40;
    return makeCommand({
      owner, tick: f, moveBrad: 0 as Brad, moveMag: run ? 255 : 0,
      buttons: f === 55 ? Button.SWAP_WEAPON : 0,
    });
  }
  return makeCommand({
    owner, tick: f, moveBrad: (f <= 30 ? 0xc000 : 0x8000) as Brad, moveMag: 255,
    buttons: f <= 30 ? Button.FIRE : 0,
  });
}

function playOnline(clocked: boolean) {
  const scheduler = new ClockedScheduler(clocked);
  let room!: MatchRoom;
  room = new MatchRoom('relay', SEED, 2, { scheduler, onDestroy: () => {}, mode: 'coop' });
  const bridges = [new Bridge(() => room, 0), new Bridge(() => room, 1)];
  const sessions = bridges.map(
    (b) =>
      new CoopSession({
        transport: b, roomId: 'relay', owner: b.owner, seed: SEED, playerCount: 2,
        buildConfig: buildOnlineConfig, bufferFrames: 0,
      }),
  );
  for (const b of bridges) expect(room.join(b.conn)).toBe(true);

  for (let f = 1; f <= FRAMES; f++) {
    // Frame f's input leaves the client 1 ms into frame f's third of its window.
    scheduler.t = ((f - 1) * BATCH_MS) / FPB + 1;
    sessions.forEach((s, owner) => s.submit(intent(owner, f)));
    if (f % FPB === 0) {
      scheduler.pulseAt((f / FPB) * BATCH_MS);
      for (const s of sessions) s.drive();
    }
  }
  return { sessions, config: buildOnlineConfig(bridges[0]!.start!) };
}

function playLocal(config: ReturnType<typeof buildOnlineConfig>) {
  const cmds: PlayerCommand[] = [];
  for (let f = 1; f <= FRAMES; f++) for (const owner of [0, 1]) cmds.push(intent(owner, f));
  return runReplay(toReplay(config, cmds), FRAMES);
}

describe('online relay at the shipped batch size', () => {
  it('two clients through a clocked MatchRoom reproduce the local run byte-for-byte', () => {
    const { sessions, config } = playOnline(true);
    const local = playLocal(config);

    for (const s of sessions) expect(s.state!.tick).toBe(FRAMES);
    expect(hashState(sessions[1]!.state!)).toBe(hashState(sessions[0]!.state!));
    expect(hashState(sessions[0]!.state!)).toBe(hashState(local.state));

    // Not two idle runs agreeing: both seats really walked, the full distance.
    const start = runReplay(toReplay(config, []), 0).state.players;
    const online = sessions[0]!.state!.players;
    expect(online[0]!.gx).not.toBe(start[0]!.gx);
    expect(online[1]!.gy).not.toBe(start[1]!.gy);
    expect(online[0]!.gx).toBe(local.state.players[0]!.gx);
  });

  it('control: without the server clock every command lands late and the run differs', () => {
    const { sessions, config } = playOnline(false);
    const local = playLocal(config);
    expect(hashState(sessions[1]!.state!)).toBe(hashState(sessions[0]!.state!)); // still in lockstep
    expect(hashState(sessions[0]!.state!)).not.toBe(hashState(local.state)); // but not the run intended
  });
});
