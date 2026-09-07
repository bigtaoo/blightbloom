/**
 * MatchRoom's REFUSAL arms — every early `return` that says "no, not from you, not now".
 *
 * Sibling to `MatchRoom.test.ts`, which drives the happy lifecycle (join → launch → relay →
 * settle) and, measured 2026-09-03, left this room at 99.08% LINES and 83.14% BRANCHES. That
 * gap is the whole argument for gating branches as well as lines: the lines these guards live
 * on all execute — it is only ever the taken side that runs, so every "wrong caller, wrong
 * phase, wrong seat" arm was unexercised while the file read as fully covered.
 *
 * These are not defensive nice-to-haves. `submitCmd`/`reportResult`/`reportCheckpoint` are
 * driven straight off the wire by whatever a client sends, so each guard is a trust boundary:
 * losing one means a settled room accepting a second settlement, a spectator's seat index
 * moving someone else's player, or a checkpoint vote arriving from a seat that is not in the
 * match. None of those throws — they quietly corrupt a live match.
 */
import { describe, it, expect } from 'vitest';
import { makeCommand } from '@dd/engine';
import type { Brad, PlayerCommand, ServerMsg } from '@dd/engine';
import {
  MatchRoom,
  Phase,
  type IntervalHandle,
  type RoomConnection,
  type Scheduler,
  type SettledMatch,
} from '../src/MatchRoom';
import { RoomManager } from '../src/RoomManager';
import type { MatchMode } from '../src/ticket';

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
  get running(): boolean {
    return this.fns.length > 0;
  }
}

class FakeConn implements RoomConnection {
  readonly msgs: ServerMsg[] = [];
  constructor(
    readonly owner: number,
    readonly accountId?: string,
  ) {}
  send(m: ServerMsg): void {
    this.msgs.push(m);
  }
  ofType<T extends ServerMsg['type']>(t: T): Extract<ServerMsg, { type: T }>[] {
    return this.msgs.filter((m) => m.type === t) as Extract<ServerMsg, { type: T }>[];
  }
}

const cmd = (owner: number, buttons = 0): PlayerCommand =>
  makeCommand({ owner, tick: 0, moveBrad: 0 as Brad, moveMag: 0, buttons });

type RoomExtras = { onSettled?: (m: SettledMatch) => void; mode?: MatchMode };

function room(playerCount = 2, extra: RoomExtras = {}) {
  const scheduler = new FakeScheduler();
  const destroyed: string[] = [];
  const r = new MatchRoom('r1', 99, playerCount, {
    scheduler,
    onDestroy: (id) => destroyed.push(id),
    framesPerBatch: 1,
    ...extra,
  });
  return { r, scheduler, destroyed };
}

/** A launched room with every seat filled. */
function live(playerCount = 2, extra: RoomExtras = {}) {
  const ctx = room(playerCount, extra);
  const conns = Array.from({ length: playerCount }, (_, i) => new FakeConn(i));
  for (const c of conns) expect(ctx.r.join(c)).toBe(true);
  expect(ctx.r.phase).toBe(Phase.IN_MATCH);
  return { ...ctx, conns };
}

describe('submitCmd', () => {
  it('drops a command from a room that has not launched', () => {
    const { r, scheduler } = room(2);
    r.join(new FakeConn(0));
    r.submitCmd(0, cmd(0));
    scheduler.pulse();
    expect(r.frame).toBe(0); // nothing was ever broadcast
  });

  it('drops a command from a seat index this room does not have', () => {
    // A client can put any integer in a message. The seat check is what stops seat 7 of a
    // 2-player room from being invented — and `this.seats[7]` is `undefined`, so without the
    // guard the relay would stamp and broadcast a command for a player nobody controls.
    const { r, conns, scheduler } = live(2);
    r.submitCmd(0, cmd(0)); // a legitimate command, so the batch below is not empty
    r.submitCmd(7, cmd(7)); // the invented seat
    scheduler.pulse();

    const owners = conns.flatMap((c) =>
      c.ofType('frame_batch').flatMap((b) => b.frames.flatMap((f) => f.cmds.map((x) => x.owner))),
    );
    // The non-empty guard: without it this sweep passes on a broadcast that carried nothing
    // at all, which is exactly what a mis-typed message name produced on the first draft.
    expect(owners.length).toBeGreaterThan(0);
    expect(owners).toContain(0);
    expect(owners).not.toContain(7);
  });

  it('drops a command once the room is OVER', () => {
    const { r, scheduler } = live(1);
    r.reportResult(0, 1234, 0);
    expect(r.phase).toBe(Phase.OVER);
    const frameAtSettle = r.frame;
    r.submitCmd(0, cmd(0));
    scheduler.pulse();
    expect(r.frame).toBe(frameAtSettle);
  });
});

describe('resume', () => {
  it('refuses a seat this room does not have', () => {
    const { r } = live(2);
    expect(r.resume(new FakeConn(9), 0)).toBe(false);
  });

  it('refuses while the room is still WAITING — there is nothing to resume into', () => {
    const { r } = room(2);
    r.join(new FakeConn(0));
    expect(r.resume(new FakeConn(0), 0)).toBe(false);
  });

  it('refuses after the room has settled', () => {
    const { r } = live(1);
    r.reportResult(0, 7, 0);
    expect(r.resume(new FakeConn(0), 0)).toBe(false);
  });

  it('restarts the metronome only once EVERY seat is back', () => {
    // The pause-on-disconnect contract: one player's return must not resume the shared clock
    // while another is still gone, or the reconnecting client races ahead of the absent one.
    const { r, scheduler, conns } = live(2);
    r.onDisconnect(conns[0]!);
    r.onDisconnect(conns[1]!);
    expect(scheduler.running).toBe(false);

    expect(r.resume(new FakeConn(0), 0)).toBe(true);
    expect(scheduler.running).toBe(false); // seat 1 is still missing
    expect(r.resume(new FakeConn(1), 0)).toBe(true);
    expect(scheduler.running).toBe(true);
  });

  it('adopts the reconnecting connection\'s accountId when it has one', () => {
    // The seat's accountId is what the ladder reports against. A reconnect that dropped it
    // would silently rate the match as a guest's.
    const settledCalls: SettledMatch[] = [];
    const { r, conns } = live(1, { onSettled: (m) => settledCalls.push(m) });
    r.onDisconnect(conns[0]!);
    r.resume(new FakeConn(0, 'acct-9'), 0);
    r.reportResult(0, 1, 0, [1]);
    expect(settledCalls[0]!.seatAccounts).toEqual({ 0: 'acct-9' });
  });
});

describe('onDisconnect', () => {
  it('ignores a stale connection whose seat has already been taken over', () => {
    // The reconnect race: the new socket is seated, then the OLD one's close event fires.
    // Without the identity check that close would free the seat the live client just took,
    // pausing a match whose player is right there.
    const { r, scheduler, conns } = live(2);
    const replacement = new FakeConn(0);
    r.onDisconnect(conns[0]!);
    r.resume(replacement, 0);
    expect(scheduler.running).toBe(true);

    r.onDisconnect(conns[0]!); // the stale socket, arriving late
    expect(scheduler.running).toBe(true);
  });

  it('ignores a connection for a seat this room does not have', () => {
    const { r, destroyed } = live(1);
    r.onDisconnect(new FakeConn(5));
    expect(destroyed).toEqual([]);
  });

  it('destroys the room once the last seat is gone', () => {
    const { r, destroyed, conns } = live(2);
    r.onDisconnect(conns[0]!);
    expect(destroyed).toEqual([]);
    r.onDisconnect(conns[1]!);
    expect(destroyed).toEqual(['r1']);
  });
});

describe('reportCheckpoint', () => {
  it('ignores a checkpoint before the match starts and after it ends', () => {
    const { r } = room(4);
    expect(() => r.reportCheckpoint(0, 10, 1)).not.toThrow();

    const started = live(4);
    for (let i = 0; i < 4; i++) started.r.reportResult(i, 5, 0);
    expect(started.r.phase).toBe(Phase.OVER);
    expect(() => started.r.reportCheckpoint(0, 10, 1)).not.toThrow();
  });

  it('ignores a checkpoint from a seat this room does not have', () => {
    const { r } = live(4);
    expect(() => r.reportCheckpoint(11, 10, 1)).not.toThrow();
  });

  it('is a NO-OP below the quorum seat count, however divergent the reports', () => {
    // The stated rule: a low-population match is expected to be internally inconsistent, so
    // no majority can be trusted. The assertion that matters is that nobody is kicked — this
    // arm existing is what stops a 2-player co-op run from ejecting a player over a hash
    // difference the design explicitly tolerates.
    const { r, conns } = live(2);
    for (let round = 0; round < 10; round++) {
      r.reportCheckpoint(0, round, 1);
      r.reportCheckpoint(1, round, 999); // permanently divergent
    }
    for (const c of conns) expect(c.ofType('error')).toHaveLength(0);
  });
});

describe('reportResult', () => {
  it('ignores a result before the match starts', () => {
    const settledCalls: SettledMatch[] = [];
    const { r } = room(2, { onSettled: (m) => settledCalls.push(m) });
    r.join(new FakeConn(0));
    r.reportResult(0, 1, 0);
    expect(settledCalls).toEqual([]);
  });

  it('ignores a result from a seat this room does not have', () => {
    const settledCalls: SettledMatch[] = [];
    const { r } = live(1, { onSettled: (m) => settledCalls.push(m) });
    r.reportResult(4, 1, 0);
    expect(settledCalls).toEqual([]);
  });

  it('SETTLES ONCE — a second report after settlement changes nothing', () => {
    // The one with a real consequence attached: `onSettled` is wired to the ladder, so a
    // room that could settle twice would submit two rating reports for one match.
    const settledCalls: SettledMatch[] = [];
    const { r } = live(1, { onSettled: (m) => settledCalls.push(m) });
    r.reportResult(0, 1234, 0, [1]);
    expect(settledCalls).toHaveLength(1);
    r.reportResult(0, 4321, 0, [1]);
    expect(settledCalls).toHaveLength(1);
    expect(settledCalls[0]!.hashOk).toBe(true);
  });

  it('waits for every seat before settling', () => {
    const settledCalls: SettledMatch[] = [];
    const { r } = live(3, { onSettled: (m) => settledCalls.push(m) });
    r.reportResult(0, 7, 0);
    r.reportResult(1, 7, 0);
    expect(settledCalls).toEqual([]);
    r.reportResult(2, 7, 0);
    expect(settledCalls).toHaveLength(1);
  });

  it('flags a divergent set of hashes as NOT verified', () => {
    // `hashOk: false` is what stops `reportSettledMatch` in index.ts from moving ratings off
    // a match the seats did not agree on. The control is the case above, which is `true`.
    const settledCalls: SettledMatch[] = [];
    const { r } = live(2, { onSettled: (m) => settledCalls.push(m) });
    r.reportResult(0, 111, 0, [2]);
    r.reportResult(1, 222, 0, [2]);
    expect(settledCalls[0]!.hashOk).toBe(false);
  });

  it('reports the mode the ROOM was built with, not anything the seats said', () => {
    // `SettledMatch.mode` is what `reportSettledMatch` gates the ladder on, so it has to come
    // from the ticket-derived `MatchRoomDeps.mode` and nowhere else. The seats here send the
    // full shape of a PvP result — agreed hash, numeric winner, a placements array — into a
    // room built as co-op, which is precisely the payload a squad would forge to farm rating.
    const settledCalls: SettledMatch[] = [];
    const { r } = live(2, { mode: 'coop', onSettled: (m) => settledCalls.push(m) });
    r.reportResult(0, 42, 0, [2, 1]);
    r.reportResult(1, 42, 0, [2, 1]);
    expect(settledCalls[0]!.mode).toBe('coop');
    // …and the placements still ride along verbatim: MatchRoom relays what it was told and
    // labels where it came from, rather than quietly dropping a field the caller may want.
    expect(settledCalls[0]!.placements).toEqual([2, 1]);
    expect(settledCalls[0]!.hashOk).toBe(true);
  });

  it('reports mode pvp for a room the ticket built as pvp', () => {
    // The control for the case above — without it, a `mode` hardcoded to 'coop' would pass.
    const settledCalls: SettledMatch[] = [];
    const { r } = live(1, { mode: 'pvp', onSettled: (m) => settledCalls.push(m) });
    r.reportResult(0, 1, 0, [1]);
    expect(settledCalls[0]!.mode).toBe('pvp');
  });

  it('defaults an unstated mode to coop — the closed side of the ladder gate', () => {
    // Every pre-PvP caller and test omits `MatchRoomDeps.mode`. That default has to land on
    // the side that does NOT report to the ladder, so a room built by a caller who never
    // heard of modes cannot move ratings.
    const settledCalls: SettledMatch[] = [];
    const { r } = live(1, { onSettled: (m) => settledCalls.push(m) });
    r.reportResult(0, 1, 0, [1]);
    expect(settledCalls[0]!.mode).toBe('coop');
  });

  it('omits seatAccounts entirely for a guest-only match', () => {
    // The documented shape contract: a pre-account match's SettledMatch stays byte-identical.
    const settledCalls: SettledMatch[] = [];
    const { r } = live(1, { onSettled: (m) => settledCalls.push(m) });
    r.reportResult(0, 1, 0);
    expect('seatAccounts' in settledCalls[0]!).toBe(false);
  });
});

describe('RoomManager.handle — the message router', () => {
  // The `default:` arm. `handle` is fed straight from `JSON.parse` of a client frame, so an
  // unknown `type` is whatever an older/newer/hostile client sends. Falling through instead
  // of returning would mean the next case ran with the wrong message shape.
  it('ignores an unknown message type without throwing or touching the room', () => {
    const scheduler = new FakeScheduler();
    const manager = new RoomManager({ scheduler });
    const conn = new FakeConn(0);
    expect(manager.join(conn, 'r9', 3, 1, 'coop')).toBe(true);
    const room = manager.room('r9')!;
    const frameBefore = room.frame;

    for (const msg of [{ type: 'nonsense' }, { type: 'join' }, {}] as never[]) {
      expect(() => manager.handle(conn, 'r9', msg)).not.toThrow();
    }
    expect(room.frame).toBe(frameBefore);
    expect(conn.ofType('error')).toHaveLength(0);
    manager.destroyAll();
  });

  it('ignores a message for a room that does not exist', () => {
    const manager = new RoomManager({ scheduler: new FakeScheduler() });
    expect(() => manager.handle(new FakeConn(0), 'no-such-room', { type: 'result', stateHash: 1, winner: 0 } as never)).not.toThrow();
  });
});

describe('the metronome under partial rooms', () => {
  it('a disconnect BEFORE launch stops no clock and still destroys the empty room', () => {
    // onDisconnect's phase arm. A room that is still filling has no metronome to stop, and
    // the destroy-when-empty rule has to hold there too: without it a room somebody opened
    // and abandoned sits in RoomManager forever, holding its seed and its id.
    const { r, scheduler, destroyed } = room(2);
    const first = new FakeConn(0);
    expect(r.join(first)).toBe(true);
    expect(r.phase).toBe(Phase.WAITING);
    expect(scheduler.running).toBe(false);

    r.onDisconnect(first);
    expect(scheduler.running).toBe(false);
    expect(destroyed).toEqual(['r1']);
  });

  it('a resume into a room that never lost anyone does not arm a SECOND interval', () => {
    // `resume` calls startMetronome whenever every seat is connected — which is still true
    // when nothing disconnected in the first place (a client that reconnects over a socket
    // the server has not yet noticed is gone). Two live intervals would tick the shared
    // clock twice per batch window, so every client would receive the same match at double
    // speed. Asserted through the frame counter rather than an interval count: the doubling
    // is the symptom that reaches players.
    const { r, scheduler } = live(2);
    expect(r.frame).toBe(0);
    scheduler.pulse();
    const perPulse = r.frame;
    expect(perPulse).toBeGreaterThan(0);

    expect(r.resume(new FakeConn(0), 0)).toBe(true);
    scheduler.pulse();
    expect(r.frame).toBe(perPulse * 2); // still one tick per pulse, not two
  });
});

describe('kickSeat — the integrity kick against a seat that is already gone', () => {
  /** Four seats (above CHECKPOINT_QUORUM), all joined, one strike already on seat 3. */
  function struck() {
    const ctx = room(4);
    const conns = [new FakeConn(0), new FakeConn(1), new FakeConn(2), new FakeConn(3)];
    for (const c of conns) expect(ctx.r.join(c)).toBe(true);
    for (const owner of [0, 1, 2]) ctx.r.reportCheckpoint(owner, 150, 0xaaa);
    ctx.r.reportCheckpoint(3, 150, 0xbad); // strike 1 — one short of the kick
    expect(conns[3]!.ofType('error')).toHaveLength(0);
    return { ...ctx, conns };
  }

  it('is a no-op when the convicted seat dropped before the vote completed', () => {
    // The race the guard exists for: seat 3 reports its divergent hash, its socket drops,
    // and only THEN do the remaining seats finish that tick and convict it. Sending to a
    // freed seat would throw on a null connection; freeing it twice would run the
    // destroy-when-empty check against a room whose other seats are all still playing.
    const { r, conns, destroyed } = struck();
    r.reportCheckpoint(3, 300, 0xbad); // the second divergent report, still connected
    r.onDisconnect(conns[3]!); // ...then the socket goes

    expect(() => {
      for (const owner of [0, 1, 2]) r.reportCheckpoint(owner, 300, 0xaaa);
    }).not.toThrow();

    // Nothing was sent to the seat that had already left, and the match goes on.
    expect(conns[3]!.ofType('error')).toHaveLength(0);
    expect(destroyed).toEqual([]);
    expect(r.phase).toBe(Phase.IN_MATCH);
    for (const c of [conns[0]!, conns[1]!, conns[2]!]) expect(c.ofType('error')).toHaveLength(0);
  });

  it('destroys the room when the kick takes the last connection with it', () => {
    // The other end of the same rule. Three seats drop mid-tick; the fourth is then kicked
    // for the divergence it had already been reported for, leaving nobody. A room that did
    // not destroy itself here would keep its metronome and its RoomManager entry alive with
    // zero connections — the leak `onDisconnect` avoids on the ordinary path.
    const { r, conns, destroyed, scheduler } = struck();
    for (const owner of [0, 1, 2]) r.reportCheckpoint(owner, 300, 0xaaa);
    for (const owner of [0, 1, 2]) r.onDisconnect(conns[owner]!);
    expect(destroyed).toEqual([]); // seat 3 is still connected

    r.reportCheckpoint(3, 300, 0xbad); // completes the tick → strike 2 → kick
    expect(conns[3]!.ofType('error')[0]!.code).toBe('integrity_mismatch');
    expect(destroyed).toEqual(['r1']);
    expect(scheduler.running).toBe(false);
  });
});
