/**
 * Where in the broadcast window a command lands (2026-10-03): `WindowClock` on its own, then
 * `MatchRoom` with a clocked fake scheduler — a command lands on the window frame its arrival
 * time falls in, and without a clock everything still lands on the window's last frame.
 */
import { describe, it, expect } from 'vitest';
import { makeCommand } from '@dd/engine';
import type { Brad, PlayerCommand, ServerMsg } from '@dd/engine';
import { MatchRoom, type IntervalHandle, type RoomConnection, type Scheduler } from '../src/MatchRoom';
import { WindowClock } from '../src/windowClock';

describe('WindowClock', () => {
  it('reads frames passed since the last restart, fractional and unclamped', () => {
    let t = 1000;
    const clock = new WindowClock(() => t, 100, 3);
    clock.restart();
    expect(clock.offset()).toBe(0);
    t = 1050;
    expect(clock.offset()).toBeCloseTo(1.5);
    t = 1130; // a late metronome reads past the window; FrameBroadcast clamps
    expect(clock.offset()).toBeCloseTo(3.9);
    clock.restart();
    expect(clock.offset()).toBe(0);
  });

  it('reads undefined without a clock, so the command keeps the old last-frame landing', () => {
    const clock = new WindowClock(undefined, 100, 3);
    clock.restart();
    expect(clock.offset()).toBeUndefined();
  });
});

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
  /** Move the clock to `t` and fire the metronome, as a real 100 ms interval would. */
  pulseAt(t: number): void {
    this.t = t;
    for (const f of [...this.fns]) f();
  }
}

class Conn implements RoomConnection {
  readonly msgs: ServerMsg[] = [];
  constructor(readonly owner: number) {}
  send(m: ServerMsg): void {
    this.msgs.push(m);
  }
}

const cmd = (owner: number, moveMag: number): PlayerCommand =>
  makeCommand({ owner, tick: 0, moveBrad: 0 as Brad, moveMag, buttons: 0 });

function started(clocked: boolean) {
  const scheduler = new ClockedScheduler(clocked);
  const room = new MatchRoom('w1', 5, 2, { scheduler, onDestroy: () => {} });
  const a = new Conn(0);
  room.join(a);
  room.join(new Conn(1));
  const landed = () =>
    a.msgs.flatMap((m) => (m.type === 'frame_batch' ? m.frames.map((f) => [f.frame, f.cmds.map((c) => c.owner)]) : []));
  return { room, scheduler, landed };
}

describe('MatchRoom lands a command on the frame its arrival falls in', () => {
  it('splits a 100 ms window into its three frames by arrival time', () => {
    const { room, scheduler, landed } = started(true);
    scheduler.t = 10;
    room.submitCmd(0, cmd(0, 255)); // first third → frame 1
    scheduler.t = 50;
    room.submitCmd(1, cmd(1, 255)); // second third → frame 2
    scheduler.t = 99;
    room.submitCmd(0, cmd(0, 0)); // last third → frame 3
    scheduler.pulseAt(100);
    scheduler.t = 140; // the window restarted at the pulse: 40 ms in → frame 5
    room.submitCmd(1, cmd(1, 0));
    scheduler.pulseAt(200);
    expect(landed()).toEqual([[1, [0]], [2, [1]], [3, [0]], [5, [1]]]);
  });

  it('a late metronome still lands everything inside its own window', () => {
    const { room, scheduler, landed } = started(true);
    scheduler.t = 130; // the interval fired 30 ms late
    room.submitCmd(0, cmd(0, 255));
    scheduler.pulseAt(131);
    expect(landed()).toEqual([[3, [0]]]);
  });

  it('without a clock, every command lands on the window toFrame as before', () => {
    const { room, scheduler, landed } = started(false);
    room.submitCmd(0, cmd(0, 255));
    room.submitCmd(1, cmd(1, 255));
    scheduler.pulseAt(100);
    expect(landed()).toEqual([[3, [0, 1]]]);
  });
});
