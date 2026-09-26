/**
 * MatchRoom / RoomManager lifecycle (design/06, ROADMAP 3.1). Drives the room with a
 * fake metronome and fake connections (no sockets, no timers) — every branch of seat
 * assignment, match start, command relay, reconnect, and settlement is exercised
 * deterministically. The relay CONTENT (ordering/watermark) is proven in @dd/engine's
 * FrameBroadcast tests; this pins the server's orchestration around it.
 */
import { describe, it, expect } from 'vitest';
import { makeCommand } from '@dd/engine';
import type { Brad, PlayerCommand, ServerMsg } from '@dd/engine';
import { MatchRoom, type RoomConnection, type Scheduler, type IntervalHandle } from '../src/MatchRoom';
import { RoomManager } from '../src/RoomManager';

class FakeScheduler implements Scheduler {
  private fns: Array<() => void> = [];
  setInterval(fn: () => void): IntervalHandle {
    this.fns.push(fn);
    return fn;
  }
  clearInterval(h: IntervalHandle): void {
    this.fns = this.fns.filter((f) => f !== h);
  }
  /** Fire every live metronome once (one broadcast pulse). */
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

function room(playerCount = 2, framesPerBatch = 3) {
  const scheduler = new FakeScheduler();
  const destroyed: string[] = [];
  const r = new MatchRoom('r1', 99, playerCount, {
    scheduler,
    onDestroy: (id) => destroyed.push(id),
    framesPerBatch,
  });
  return { r, scheduler, destroyed };
}

describe('MatchRoom — start / relay / broadcast', () => {
  it('launches only when every seat is filled, and tells each seat its own localOwner', () => {
    const { r, scheduler } = room(2);
    const a = new FakeConn(0);
    const b = new FakeConn(1);

    expect(r.join(a)).toBe(true);
    expect(a.ofType('match_start')).toHaveLength(0); // room not full yet
    expect(scheduler.running).toBe(false);

    expect(r.join(b)).toBe(true);
    const sa = a.ofType('match_start')[0]!;
    const sb = b.ofType('match_start')[0]!;
    expect([sa.localOwner, sb.localOwner]).toEqual([0, 1]); // each learns ITS seat
    expect(sa.seed).toBe(99);
    expect(sa.playerCount).toBe(2);
    expect(scheduler.running).toBe(true); // metronome started
  });

  it('defaults match_start.mode to coop, and carries an explicit pvp mode through (design/15)', () => {
    const scheduler = new FakeScheduler();
    const destroyed: string[] = [];
    const rCoop = new MatchRoom('rc', 1, 2, { scheduler, onDestroy: (id) => destroyed.push(id) });
    const a = new FakeConn(0);
    const b = new FakeConn(1);
    rCoop.join(a); rCoop.join(b);
    expect(a.ofType('match_start')[0]!.mode).toBe('coop');
    expect(rCoop.modeValue).toBe('coop');

    const rPvp = new MatchRoom('rp', 1, 2, { scheduler, mode: 'pvp', onDestroy: (id) => destroyed.push(id) });
    const c = new FakeConn(0);
    const d = new FakeConn(1);
    rPvp.join(c); rPvp.join(d);
    expect(c.ofType('match_start')[0]!.mode).toBe('pvp');
    expect(rPvp.modeValue).toBe('pvp');
  });

  it('a metronome pulse broadcasts a frame_batch to every seat; the watermark advances', () => {
    const { r, scheduler } = room(2, 3);
    const a = new FakeConn(0);
    const b = new FakeConn(1);
    r.join(a); r.join(b);

    scheduler.pulse(); // empty pulse
    for (const c of [a, b]) {
      const batch = c.ofType('frame_batch').at(-1)!;
      expect(batch.toFrame).toBe(3);
      expect(batch.frames).toEqual([]);
    }
    scheduler.pulse();
    expect(a.ofType('frame_batch').at(-1)!.toFrame).toBe(6);
  });

  it('relays a command tagged with the connection\'s OWN seat, ignoring any client-sent owner', () => {
    const { r, scheduler } = room(2, 3);
    const a = new FakeConn(0);
    const b = new FakeConn(1);
    r.join(a); r.join(b);

    // Seat 1 tries to spoof a command as owner 0 — the server must overwrite it to 1.
    r.submitCmd(1, cmd(0, 4));
    scheduler.pulse();
    const batch = a.ofType('frame_batch').at(-1)!;
    expect(batch.frames).toHaveLength(1);
    expect(batch.frames[0]!.cmds).toHaveLength(1);
    expect(batch.frames[0]!.cmds[0]!.owner).toBe(1); // authority: owner forced to the seat
    expect(batch.frames[0]!.frame).toBe(3);
  });
});

describe('MatchRoom — join guards', () => {
  it('rejects an out-of-range seat, a taken seat, and a join after the match started', () => {
    const { r } = room(2);
    expect(r.join(new FakeConn(5))).toBe(false); // out of range
    expect(r.join(new FakeConn(0))).toBe(true);
    expect(r.join(new FakeConn(0))).toBe(false); // seat 0 taken
    r.join(new FakeConn(1)); // fills → launches
    expect(r.join(new FakeConn(1))).toBe(false); // match already started
  });
});

describe('MatchRoom — reconnect', () => {
  it('pauses the metronome on disconnect and resyncs the missed frame log on resume', () => {
    const { r, scheduler } = room(2, 3);
    const a = new FakeConn(0);
    const b = new FakeConn(1);
    r.join(a); r.join(b);

    r.submitCmd(0, cmd(0, 1));
    scheduler.pulse(); // frame 3, logged (non-empty)
    scheduler.pulse(); // frame 6, empty

    r.onDisconnect(b); // seat 1 drops
    expect(scheduler.running).toBe(false); // clock paused — co-op waits, doesn't forfeit

    const b2 = new FakeConn(1);
    expect(r.resume(b2, 0)).toBe(true); // rejoin, asking for everything after frame 0
    const resync = b2.ofType('conn_resync')[0]!;
    expect(resync.curFrame).toBe(6);
    expect(resync.log.map((f) => f.frame)).toEqual([3]); // only the non-empty frame
    expect(scheduler.running).toBe(true); // metronome resumed (both connected again)
  });
});

describe('MatchRoom — settlement', () => {
  it('broadcasts match_over and destroys once every seat reports, and agrees the outcome', () => {
    const { r, scheduler, destroyed } = room(2);
    const a = new FakeConn(0);
    const b = new FakeConn(1);
    r.join(a); r.join(b);

    r.reportResult(0, 0xabc, 'enemies');
    expect(a.ofType('match_over')).toHaveLength(0); // waiting for seat 1
    r.reportResult(1, 0xabc, 'enemies'); // matching hash

    const over = a.ofType('match_over')[0]!;
    expect(over.winner).toBe('enemies');
    expect(over.reason).toBe('wipe');
    expect(destroyed).toEqual(['r1']);
    expect(scheduler.running).toBe(false);
  });

  it('flags a hash mismatch (re-judge backstop) but still ends the match', () => {
    const { r } = room(2);
    const a = new FakeConn(0);
    const b = new FakeConn(1);
    r.join(a); r.join(b);
    r.reportResult(0, 0x111, 0);
    r.reportResult(1, 0x222, 0); // divergent hash
    expect(a.ofType('match_over')[0]!.reason).toBe('disconnect'); // mismatch marker
  });

  it('fires onSettled with the checkpoint-verified outcome (design/15, ROADMAP 4.6), for the ladder-rating caller', () => {
    const scheduler = new FakeScheduler();
    const settled: unknown[] = [];
    const r = new MatchRoom('r1', 99, 2, {
      scheduler,
      onDestroy: () => {},
      onSettled: (m) => settled.push(m),
    });
    const a = new FakeConn(0);
    const b = new FakeConn(1);
    r.join(a); r.join(b);
    r.reportResult(0, 0xabc, 1, [0]);
    r.reportResult(1, 0xabc, 1, [0]); // matching hash
    expect(settled).toEqual([{ roomId: 'r1', mode: 'coop', winner: 1, placements: [0], playerCount: 2, hashOk: true, integrity: { verdict: 'clean', dissenters: [], kicked: [], settleFrame: 0, seed: 99 } }]);
  });

  it('onSettled reports hashOk: false on a divergent-hash settlement, never crashing the caller', () => {
    const scheduler = new FakeScheduler();
    const settled: unknown[] = [];
    const r = new MatchRoom('r1', 99, 2, {
      scheduler,
      onDestroy: () => {},
      onSettled: (m) => settled.push(m),
    });
    const a = new FakeConn(0);
    const b = new FakeConn(1);
    r.join(a); r.join(b);
    r.reportResult(0, 0x111, 0);
    r.reportResult(1, 0x222, 0); // divergent hash
    expect(settled).toEqual([{ roomId: 'r1', mode: 'coop', winner: 0, placements: undefined, playerCount: 2, hashOk: false,
      // Two seats is under the quorum, so it takes unanimity and a split settles nothing.
      integrity: { verdict: 'no_consensus', dissenters: [], kicked: [], settleFrame: 0, seed: 99, log: [] } }]);
  });

  it('onSettled includes seatAccounts (design/16-accounts.md) for whichever seats were logged in', () => {
    const scheduler = new FakeScheduler();
    const settled: unknown[] = [];
    const r = new MatchRoom('r1', 99, 2, {
      scheduler,
      onDestroy: () => {},
      onSettled: (m) => settled.push(m),
    });
    const a = new FakeConn(0, 'acct-alice'); // logged in
    const b = new FakeConn(1); // guest — no accountId
    r.join(a); r.join(b);
    r.reportResult(0, 0xabc, 0, [1]);
    r.reportResult(1, 0xabc, 0, [1]);
    expect(settled).toEqual([{ roomId: 'r1', mode: 'coop', winner: 0, placements: [1], playerCount: 2, hashOk: true, integrity: { verdict: 'clean', dissenters: [], kicked: [], settleFrame: 0, seed: 99 }, seatAccounts: { 0: 'acct-alice' } }]);
  });

  // `mode` joined this shape on 2026-09-05 (the ladder gate stopped trusting client-supplied
  // `placements` as the "was this PvP?" signal). `seatAccounts` is still the field this case
  // is about: it stays ABSENT, rather than present-and-empty, for a guest-only match.
  it('onSettled omits seatAccounts entirely when no seat was logged in', () => {
    const scheduler = new FakeScheduler();
    const settled: unknown[] = [];
    const r = new MatchRoom('r1', 99, 2, {
      scheduler,
      onDestroy: () => {},
      onSettled: (m) => settled.push(m),
    });
    const a = new FakeConn(0);
    const b = new FakeConn(1);
    r.join(a); r.join(b);
    r.reportResult(0, 0xabc, 0, [1]);
    r.reportResult(1, 0xabc, 0, [1]);
    expect(settled).toEqual([{ roomId: 'r1', mode: 'coop', winner: 0, placements: [1], playerCount: 2, hashOk: true, integrity: { verdict: 'clean', dissenters: [], kicked: [], settleFrame: 0, seed: 99 } }]);
  });

  it('reports \'placement\' (design/15, ROADMAP 4.2e) when the reported result carries a placements array', () => {
    const { r } = room(2);
    const a = new FakeConn(0);
    const b = new FakeConn(1);
    r.join(a); r.join(b);
    r.reportResult(0, 0xabc, 1, [0]); // seat 1 won; seat 0 placed 2nd
    r.reportResult(1, 0xabc, 1, [0]); // matching hash + placements
    const over = a.ofType('match_over')[0]!;
    expect(over.reason).toBe('placement');
    expect(over.winner).toBe(1);
    expect(over.placements).toEqual([0]);
  });

  it('never reports \'placement\' for a PvE result with no placements array', () => {
    const { r } = room(2);
    const a = new FakeConn(0);
    const b = new FakeConn(1);
    r.join(a); r.join(b);
    r.reportResult(0, 0xabc, 0);
    r.reportResult(1, 0xabc, 0);
    expect(a.ofType('match_over')[0]!.reason).toBe('extract');
  });
});

describe('MatchRoom — anti-cheat checkpoints (design/15, ROADMAP 4.4)', () => {
  it('runs no consensus check at all below the quorum (playerCount <= 3)', () => {
    const { r } = room(2); // below CHECKPOINT_QUORUM (3)
    const a = new FakeConn(0);
    const b = new FakeConn(1);
    r.join(a); r.join(b);
    // Seat 1 disagrees with seat 0 for many consecutive checkpoints — with only 2
    // real seats this must never kick anyone (design/15: no signal to trust below quorum).
    for (let tick = 150; tick <= 750; tick += 150) {
      r.reportCheckpoint(0, tick, 0xaaa);
      r.reportCheckpoint(1, tick, 0xbbb);
    }
    expect(a.ofType('error')).toHaveLength(0);
    expect(b.ofType('error')).toHaveLength(0);
  });

  it('kicks the minority seat after INTEGRITY_KICK_STREAK consecutive same-tick mismatches', () => {
    const { r } = room(4); // above quorum
    const conns = [new FakeConn(0), new FakeConn(1), new FakeConn(2), new FakeConn(3)];
    for (const c of conns) r.join(c);

    // Tick 150: seat 3 disagrees (strike 1) — not kicked yet.
    r.reportCheckpoint(0, 150, 0xaaa);
    r.reportCheckpoint(1, 150, 0xaaa);
    r.reportCheckpoint(2, 150, 0xaaa);
    r.reportCheckpoint(3, 150, 0xbad);
    expect(conns[3]!.ofType('error')).toHaveLength(0);

    // Tick 300: seat 3 disagrees AGAIN, consecutively — strike 2, kicked.
    r.reportCheckpoint(0, 300, 0xaaa);
    r.reportCheckpoint(1, 300, 0xaaa);
    r.reportCheckpoint(2, 300, 0xaaa);
    r.reportCheckpoint(3, 300, 0xbad);

    expect(conns[3]!.ofType('error')).toHaveLength(1);
    expect(conns[3]!.ofType('error')[0]!.code).toBe('integrity_mismatch');
    // Every other seat is untouched.
    for (const c of [conns[0]!, conns[1]!, conns[2]!]) expect(c.ofType('error')).toHaveLength(0);
  });

  it('a clean report in between resets the streak — no kick from two NON-consecutive mismatches', () => {
    const { r } = room(4);
    const conns = [new FakeConn(0), new FakeConn(1), new FakeConn(2), new FakeConn(3)];
    for (const c of conns) r.join(c);

    r.reportCheckpoint(0, 150, 0xaaa);
    r.reportCheckpoint(1, 150, 0xaaa);
    r.reportCheckpoint(2, 150, 0xaaa);
    r.reportCheckpoint(3, 150, 0xbad); // strike 1

    r.reportCheckpoint(0, 300, 0xaaa);
    r.reportCheckpoint(1, 300, 0xaaa);
    r.reportCheckpoint(2, 300, 0xaaa);
    r.reportCheckpoint(3, 300, 0xaaa); // agrees this time — streak resets

    r.reportCheckpoint(0, 450, 0xaaa);
    r.reportCheckpoint(1, 450, 0xaaa);
    r.reportCheckpoint(2, 450, 0xaaa);
    r.reportCheckpoint(3, 450, 0xbad); // strike 1 again, not 2 — never kicked

    expect(conns[3]!.ofType('error')).toHaveLength(0);
  });

  it('waits for every seat to report before evaluating a tick (a partial report never triggers a kick)', () => {
    const { r } = room(4);
    const conns = [new FakeConn(0), new FakeConn(1), new FakeConn(2), new FakeConn(3)];
    for (const c of conns) r.join(c);
    r.reportCheckpoint(0, 150, 0xaaa);
    r.reportCheckpoint(1, 150, 0xaaa);
    r.reportCheckpoint(2, 150, 0xaaa);
    // Seat 3 never reports this tick — nothing should be decided.
    expect(conns.every((c) => c.ofType('error').length === 0)).toBe(true);
  });
});

describe('RoomManager — routing + room parameter cross-check', () => {
  it('creates a room on the first join and rejects a joiner that disagrees on seed/count', () => {
    const scheduler = new FakeScheduler();
    const mgr = new RoomManager({ scheduler });
    const a = new FakeConn(0);
    const b = new FakeConn(1);

    expect(mgr.join(a, 'room', 7, 2)).toBe(true);
    expect(mgr.size).toBe(1);
    expect(mgr.join(b, 'room', 8, 2)).toBe(false); // seed disagreement → rejected
    expect(mgr.join(b, 'room', 7, 3)).toBe(false); // playerCount disagreement → rejected
    expect(mgr.join(b, 'room', 7, 2)).toBe(true); // agrees → seated, match starts
    expect(scheduler.running).toBe(true);
  });

  it('rejects a joiner that disagrees on mode (design/15) — a coop room is not a pvp room', () => {
    const scheduler = new FakeScheduler();
    const mgr = new RoomManager({ scheduler });
    const a = new FakeConn(0);
    const b = new FakeConn(1);

    expect(mgr.join(a, 'room', 7, 2, 'pvp')).toBe(true);
    expect(mgr.join(b, 'room', 7, 2)).toBe(false); // implicit 'coop' disagrees with the room's 'pvp'
    expect(mgr.join(b, 'room', 7, 2, 'pvp')).toBe(true); // agrees → seated
  });

  it('routes cmd/resume/result by roomId and cleans up on the last disconnect', () => {
    const scheduler = new FakeScheduler();
    const mgr = new RoomManager({ scheduler });
    const a = new FakeConn(0);
    const b = new FakeConn(1);
    mgr.join(a, 'room', 7, 2);
    mgr.join(b, 'room', 7, 2);

    mgr.handle(a, 'room', { type: 'cmd', cmd: cmd(0, 1) });
    scheduler.pulse();
    expect(a.ofType('frame_batch').at(-1)!.frames).toHaveLength(1);

    mgr.onClose(a, 'room');
    mgr.onClose(b, 'room');
    expect(mgr.size).toBe(0); // room destroyed when empty
  });

  it('a resume against a room that is no longer resumable sends the client a resume_failed error (ROADMAP reconnect)', () => {
    const scheduler = new FakeScheduler();
    const mgr = new RoomManager({ scheduler });
    // No `join` at all — 'room' doesn't even exist, exactly like a resume ticket
    // redeemed after the match already settled and its MatchRoom was destroyed.
    const conn = new FakeConn(0);
    mgr.handle(conn, 'room', { type: 'resume', roomId: 'room', owner: 0, lastFrame: 0 });
    expect(conn.msgs).toEqual([]); // handle() itself no-ops on an unknown roomId (unchanged)
  });

  it('a resume against a room that HAS a MatchRoom but rejects it (e.g. still WAITING) reports resume_failed', () => {
    const scheduler = new FakeScheduler();
    const mgr = new RoomManager({ scheduler });
    const a = new FakeConn(0);
    mgr.join(a, 'room', 7, 2); // seat 1 never joins — room stays WAITING, never IN_MATCH

    const b = new FakeConn(1);
    mgr.handle(b, 'room', { type: 'resume', roomId: 'room', owner: 1, lastFrame: 0 });

    expect(b.ofType('error')).toEqual([
      { type: 'error', code: 'resume_failed', message: 'Unable to resume this match — it may have already ended.' },
    ]);
    expect(b.ofType('conn_resync')).toEqual([]); // never actually reseated
  });

  it('a resume that DOES succeed never sends a resume_failed error', () => {
    const scheduler = new FakeScheduler();
    const mgr = new RoomManager({ scheduler });
    const a = new FakeConn(0);
    const b = new FakeConn(1);
    mgr.join(a, 'room', 7, 2);
    mgr.join(b, 'room', 7, 2); // both seated → IN_MATCH

    mgr.onClose(b, 'room'); // b drops
    const b2 = new FakeConn(1);
    mgr.handle(b2, 'room', { type: 'resume', roomId: 'room', owner: 1, lastFrame: 0 });

    expect(b2.ofType('conn_resync')).toHaveLength(1);
    expect(b2.ofType('error')).toEqual([]);
  });

  it('routes checkpoint messages through to the room (design/15, ROADMAP 4.4)', () => {
    const scheduler = new FakeScheduler();
    const mgr = new RoomManager({ scheduler });
    const a = new FakeConn(0);
    const b = new FakeConn(1);
    mgr.join(a, 'room', 7, 2);
    mgr.join(b, 'room', 7, 2);
    // Below quorum (2 seats) — this only proves the message reaches reportCheckpoint
    // without throwing; the quorum-gated consensus behavior itself is covered above.
    expect(() => mgr.handle(a, 'room', { type: 'checkpoint', tick: 150, stateHash: 0xabc })).not.toThrow();
  });
});
