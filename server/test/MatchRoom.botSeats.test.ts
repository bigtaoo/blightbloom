/**
 * Bot seats on the wire (ENGINE_VERSION 88): `match_start.botSeats`, which every client's
 * co-op config flags so a run whose people are all dead ends. The same compatibility
 * property as `MatchRoom.names.test.ts`, whose fakes this copies: a room with no bot puts
 * NOTHING new on the wire.
 */
import { describe, it, expect } from 'vitest';
import type { ServerMsg } from '@dd/engine';
import { MatchRoom, type RoomConnection, type Scheduler, type IntervalHandle } from '../src/MatchRoom';

class FakeScheduler implements Scheduler {
  private fns: Array<() => void> = [];
  setInterval(fn: () => void): IntervalHandle {
    this.fns.push(fn);
    return fn;
  }
  clearInterval(h: IntervalHandle): void {
    this.fns = this.fns.filter((f) => f !== h);
  }
  /** Settlement timeouts: never fired by `pulse`, only by `expire`. */
  private timeouts: Array<() => void> = [];
  setTimeout(fn: () => void): IntervalHandle {
    this.timeouts.push(fn);
    return fn;
  }
  clearTimeout(h: IntervalHandle): void {
    this.timeouts = this.timeouts.filter((f) => f !== h);
  }
  /** Fire every pending timeout, as if its full delay had passed. */
  expire(): void {
    const due = this.timeouts;
    this.timeouts = [];
    for (const f of due) f();
  }
  get pendingTimeouts(): number {
    return this.timeouts.length;
  }
  pulse(): void {
    for (const f of [...this.fns]) f();
  }
}

class FakeConn implements RoomConnection {
  readonly msgs: ServerMsg[] = [];
  constructor(
    readonly owner: number,
    readonly accountId?: string,
    readonly name?: string,
    readonly bot?: boolean,
  ) {}
  send(m: ServerMsg): void {
    this.msgs.push(m);
  }
}

function room(playerCount: number) {
  const scheduler = new FakeScheduler();
  return {
    scheduler,
    room: new MatchRoom('r1', 7, playerCount, { scheduler, onDestroy: () => {} }),
  };
}

/** The `match_start` this connection received. */
function start(conn: FakeConn) {
  const msg = conn.msgs.find((m) => m.type === 'match_start');
  if (!msg || msg.type !== 'match_start') throw new Error('no match_start');
  return msg;
}

describe('match_start botSeats', () => {
  it('names the seats bots hold, to every seat in the room, the bots included', () => {
    const r = room(3);
    const conns = [new FakeConn(0), new FakeConn(1, undefined, undefined, true), new FakeConn(2, undefined, undefined, true)];
    for (const c of conns) r.room.join(c);
    for (const c of conns) expect(start(c).botSeats).toEqual([1, 2]);
  });

  it('a room of people puts nothing new on the wire', () => {
    const r = room(2);
    const a = new FakeConn(0), b = new FakeConn(1, undefined, undefined, false);
    r.room.join(a);
    r.room.join(b);
    expect(start(a).botSeats).toBeUndefined();
    expect('botSeats' in JSON.parse(JSON.stringify(start(b)))).toBe(false);
  });

  it('the seat is read off the connection that joins it, not its index', () => {
    const r = room(2);
    const a = new FakeConn(0, undefined, undefined, true), b = new FakeConn(1);
    r.room.join(a);
    r.room.join(b);
    expect(start(b).botSeats).toEqual([0]);
  });
});
