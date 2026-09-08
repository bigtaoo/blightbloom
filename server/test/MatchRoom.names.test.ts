/**
 * Seat names on the wire (design/20 — a game portal requires the platform's own usernames be
 * shown in-game so players can recognise their friends).
 *
 * A separate file from `MatchRoom.test.ts`, which owns the lifecycle, because what is pinned
 * here is a compatibility property as much as a feature: a room in which nobody is logged in
 * must put NOTHING new on the wire. Every pre-2026-09-08 client and every existing fixture
 * has to keep seeing a byte-identical `match_start`, and "the field is `undefined`" is the
 * only version of that which is actually true.
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

describe('match_start names', () => {
  it('carries seat index -> name for a room of logged-in players', () => {
    const r = room(2);
    const a = new FakeConn(0, 'acct-a', 'Ada');
    const b = new FakeConn(1, 'acct-b', 'Grace');
    r.room.join(a);
    r.room.join(b);
    // BOTH seats get the whole roster, not just their own name: the point is that each
    // client can label the others.
    expect(start(a).names).toEqual(['Ada', 'Grace']);
    expect(start(b).names).toEqual(['Ada', 'Grace']);
  });

  it('is ABSENT for a room in which nobody is logged in', () => {
    // The compatibility property this file exists for. `undefined`, not `[null, null]`.
    const r = room(2);
    const a = new FakeConn(0);
    r.room.join(a);
    r.room.join(new FakeConn(1));
    expect(start(a).names).toBeUndefined();
    expect('names' in start(a)).toBe(true); // present as a key, undefined as a value
    expect(JSON.parse(JSON.stringify(start(a))).names).toBeUndefined();
  });

  it('nulls the unnamed seats in a MIXED room, rather than shortening the array', () => {
    // Position is the seat index, so a compacted array would attribute a name to the wrong
    // player — which is worse than showing no name at all.
    const r = room(3);
    const a = new FakeConn(0, 'acct-a', 'Ada');
    r.room.join(a);
    r.room.join(new FakeConn(1)); // a guest
    r.room.join(new FakeConn(2, 'acct-c', 'Hopper'));
    expect(start(a).names).toEqual(['Ada', null, 'Hopper']);
  });

  it('does not treat an empty-string name as a name', () => {
    // `conn.name !== undefined` is the assignment guard, so an empty string would be stored
    // and then rendered as a nameless entry with a separator around it.
    const r = room(2);
    const a = new FakeConn(0, 'acct-a', '');
    r.room.join(a);
    r.room.join(new FakeConn(1));
    expect(start(a).names).toBeUndefined();
  });
});

describe('conn_resync names', () => {
  it('carries the roster to a RECONNECTING client, which never sees match_start again', () => {
    const r = room(2);
    const a = new FakeConn(0, 'acct-a', 'Ada');
    const b = new FakeConn(1, 'acct-b', 'Grace');
    r.room.join(a);
    r.room.join(b);

    const back = new FakeConn(0, 'acct-a', 'Ada');
    r.room.onDisconnect(a);
    expect(r.room.resume(back, 0)).toBe(true);
    const resync = back.msgs.find((m) => m.type === 'conn_resync');
    expect(resync && resync.type === 'conn_resync' && resync.names).toEqual(['Ada', 'Grace']);
  });

  it('keeps a dropped player NAMED for the rest of the room while they are away', () => {
    // `seat.name` survives the disconnect for the same reason `seat.accountId` does: three
    // seconds of packet loss must not blank a nameplate for everyone else.
    const r = room(2);
    const a = new FakeConn(0, 'acct-a', 'Ada');
    const b = new FakeConn(1, 'acct-b', 'Grace');
    r.room.join(a);
    r.room.join(b);
    r.room.onDisconnect(b);

    const back = new FakeConn(1, 'acct-b', 'Grace');
    r.room.resume(back, 0);
    const resync = back.msgs.find((m) => m.type === 'conn_resync');
    expect(resync && resync.type === 'conn_resync' && resync.names).toEqual(['Ada', 'Grace']);
  });
});
