/**
 * MatchRoom's settlement timeout (design/15, decided 2026-09-26): the first end-of-match report
 * arms `SETTLE_TIMEOUT_MS`; when it runs out the room settles on the reports it has, and every
 * seat still silent is treated as offline — no vote, listed as `absent`, never a suspect.
 * Before this a seat that never reported held the room open forever, so a losing player could
 * keep a PvP result off the ladder by closing the tab.
 *
 * The verdict rules themselves are pinned in `settlement.test.ts`; this file pins the room's
 * half: when the timer is armed, cleared and fired, and what a timed-out settlement sends.
 */
import { describe, expect, it } from 'vitest';
import type { ServerMsg } from '@dd/engine';
import { MatchRoom, Phase, type IntervalHandle, type RoomConnection, type Scheduler, type SettledMatch } from '../src/MatchRoom';
import { MIN_PVP_SETTLE_FRAME, SETTLE_TIMEOUT_MS } from '../src/settlement';

/** A scheduler that records every timeout's delay, and fires timeouts only on `expire`. */
class FakeScheduler implements Scheduler {
  private fns: Array<() => void> = [];
  timeouts: Array<{ fn: () => void; ms: number }> = [];
  armed = 0;
  setInterval(fn: () => void): IntervalHandle {
    this.fns.push(fn);
    return fn;
  }
  clearInterval(h: IntervalHandle): void {
    this.fns = this.fns.filter((f) => f !== h);
  }
  setTimeout(fn: () => void, ms: number): IntervalHandle {
    const t = { fn, ms };
    this.timeouts.push(t);
    this.armed++;
    return t;
  }
  clearTimeout(h: IntervalHandle): void {
    this.timeouts = this.timeouts.filter((t) => t !== h);
  }
  pulse(): void {
    for (const f of [...this.fns]) f();
  }
  expire(): void {
    const due = this.timeouts;
    this.timeouts = [];
    for (const t of due) t.fn();
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
  get over() {
    return this.msgs.filter((m) => m.type === 'match_over');
  }
}

/** A started PvP room of `n` seats, one pulse in, so its frame sits at the duration floor. */
function started(n = 4) {
  const scheduler = new FakeScheduler();
  const settled: SettledMatch[] = [];
  const destroyed: string[] = [];
  const r = new MatchRoom('r1', 4242, n, {
    scheduler,
    mode: 'pvp',
    onDestroy: (id) => destroyed.push(id),
    onSettled: (m) => settled.push(m),
    framesPerBatch: MIN_PVP_SETTLE_FRAME,
  });
  const conns = Array.from({ length: n }, (_, o) => new FakeConn(o, `acct-${o}`));
  for (const c of conns) r.join(c);
  scheduler.pulse();
  return { r, conns, settled, destroyed, scheduler };
}

const PLACE = [3, 2, 1] as const;

describe('MatchRoom settlement timeout — arming and clearing', () => {
  it('arms exactly one SETTLE_TIMEOUT_MS timer on the first report, and no more on later ones', () => {
    const { r, scheduler } = started();
    expect(scheduler.armed).toBe(0);
    r.reportResult(0, 0xaaa, 0, PLACE);
    expect(scheduler.timeouts.map((t) => t.ms)).toEqual([SETTLE_TIMEOUT_MS]);
    r.reportResult(1, 0xaaa, 0, PLACE);
    r.reportResult(1, 0xaaa, 0, PLACE); // a repeated report from the same seat changes nothing
    expect(scheduler.armed).toBe(1);
  });

  it('is not the metronome: pulses alone never settle a room waiting on a report', () => {
    const { r, settled, scheduler } = started();
    for (const o of [0, 1, 2]) r.reportResult(o, 0xaaa, 0, PLACE);
    for (let i = 0; i < 5; i++) scheduler.pulse();
    expect(settled).toEqual([]);
    expect(r.phase).toBe(Phase.IN_MATCH);
  });

  it('is cleared when the last report settles the room, so a late expiry cannot settle twice', () => {
    const { r, settled, scheduler } = started();
    for (const o of [0, 1, 2, 3]) r.reportResult(o, 0xaaa, 0, PLACE);
    expect(settled).toHaveLength(1);
    expect(scheduler.timeouts).toEqual([]);
    scheduler.expire();
    expect(settled).toHaveLength(1);
  });

  it('is never armed by a room that ends with nobody reporting', () => {
    const { r, conns, settled, destroyed, scheduler } = started();
    for (const c of conns) r.onDisconnect(c);
    expect(destroyed).toEqual(['r1']);
    expect(settled).toEqual([]);
    expect(scheduler.armed).toBe(0);
  });
});

describe('MatchRoom settlement timeout — a silent seat is treated as offline', () => {
  it('settles on the reports it has, rates them, and lists the silent seat as absent', () => {
    const { r, conns, settled, destroyed, scheduler } = started();
    for (const o of [0, 1, 2]) r.reportResult(o, 0xaaa, 0, PLACE);
    scheduler.expire();

    expect(settled).toHaveLength(1);
    const m = settled[0]!;
    expect(m.hashOk).toBe(true);
    expect(m.winner).toBe(0);
    expect(m.placements).toEqual(PLACE);
    expect(m.integrity).toMatchObject({ verdict: 'partial', dissenters: [], kicked: [], absent: [3] });
    expect(m.integrity.log).toEqual([]); // not clean, so the log rides along for the record
    // The silent seat's account is still credited: it was in the match, it just did not report.
    expect(m.seatAccounts).toEqual({ 0: 'acct-0', 1: 'acct-1', 2: 'acct-2', 3: 'acct-3' });
    for (const c of conns) expect(c.over).toEqual([{ type: 'match_over', winner: 0, reason: 'placement', placements: PLACE }]);
    expect(destroyed).toEqual(['r1']);
    expect(scheduler.running).toBe(false);
  });

  it('lets one honest reporter settle a 1v1 the other seat walked away from', () => {
    const { r, settled, scheduler } = started(2);
    r.reportResult(0, 0xaaa, 0, [1]);
    scheduler.expire();
    expect(settled[0]).toMatchObject({ hashOk: true, winner: 0, placements: [1] });
    expect(settled[0]!.integrity).toMatchObject({ verdict: 'partial', absent: [1] });
  });

  it('still settles nothing when the seats that did report disagree', () => {
    const { r, conns, settled, scheduler } = started();
    r.reportResult(0, 0xaaa, 0, PLACE);
    r.reportResult(1, 0xbbb, 0, PLACE);
    scheduler.expire();
    expect(settled[0]!.hashOk).toBe(false);
    expect(settled[0]!.integrity).toMatchObject({ verdict: 'no_consensus', dissenters: [], absent: [2, 3] });
    expect(conns[0]!.over[0]).toMatchObject({ reason: 'disconnect' });
  });

  it('holds three reporters to unanimity: 2-to-1 at the quorum settles nothing', () => {
    const { r, settled, scheduler } = started();
    r.reportResult(0, 0xaaa, 0, PLACE);
    r.reportResult(1, 0xaaa, 0, PLACE);
    r.reportResult(2, 0xbad, 0, PLACE);
    scheduler.expire();
    expect(settled[0]!.integrity).toMatchObject({ verdict: 'no_consensus', dissenters: [], absent: [3] });
  });

  it('names a dissenter among five reporters of eight and still lists the silent seats', () => {
    const { r, settled, scheduler } = started(8);
    const squads = [7, 6, 5, 4]; // two squads of four; seat 0 represents the winning one
    for (const o of [0, 1, 2, 3]) r.reportResult(o, 0xaaa, 0, squads);
    r.reportResult(4, 0xbad, 0, squads);
    scheduler.expire();
    expect(settled[0]!.hashOk).toBe(true);
    expect(settled[0]!.integrity).toMatchObject({ verdict: 'dissent', dissenters: [4], absent: [5, 6, 7] });
  });

  it('shows a non-seat-0 reporter on the end screen when seat 0 is the silent one and nothing settled', () => {
    const { r, conns, scheduler } = started();
    r.reportResult(2, 0xaaa, 2, [0, 1, 3]);
    r.reportResult(3, 0xbbb, 0, PLACE);
    scheduler.expire();
    expect(conns[1]!.over[0]).toMatchObject({ winner: 2, reason: 'disconnect' });
  });

  it('ignores a report that arrives after the timeout settled the room', () => {
    const { r, settled, scheduler } = started();
    r.reportResult(0, 0xaaa, 0, PLACE);
    scheduler.expire();
    r.reportResult(3, 0xbbb, 3, [2, 1, 0]);
    expect(settled).toHaveLength(1);
    expect(scheduler.armed).toBe(1);
  });

  it('refuses a resume into a room the timeout already settled', () => {
    const { r, scheduler } = started();
    r.reportResult(0, 0xaaa, 0, PLACE);
    scheduler.expire();
    expect(r.resume(new FakeConn(3), 0)).toBe(false);
  });
});

describe('MatchRoom settlement timeout — everyone leaves before it runs out', () => {
  it('settles at once when the last seat disconnects after a report, rather than dropping the result', () => {
    const { r, conns, settled, destroyed, scheduler } = started();
    for (const o of [0, 1, 2]) r.reportResult(o, 0xaaa, 0, PLACE);
    for (const c of conns) r.onDisconnect(c);
    expect(settled).toHaveLength(1);
    expect(settled[0]!.integrity).toMatchObject({ verdict: 'partial', absent: [3] });
    expect(destroyed).toEqual(['r1']); // exactly once: settle's own destroy, not a second one
    expect(scheduler.timeouts).toEqual([]);
  });

  it('does not settle while any seat is still connected', () => {
    const { r, conns, settled } = started();
    r.reportResult(0, 0xaaa, 0, PLACE);
    for (const c of conns.slice(0, 3)) r.onDisconnect(c);
    expect(settled).toEqual([]);
  });

  it('settles when an integrity kick takes the last connection after a report', () => {
    const { r, conns, settled, destroyed } = started();
    // Seat 3 diverges twice at checkpoints (INTEGRITY_KICK_STREAK); seats 0-2 report a result
    // and leave between the two, so the kick that completes tick 300 leaves nobody.
    for (const o of [0, 1, 2]) r.reportCheckpoint(o, 150, 0xaaa);
    r.reportCheckpoint(3, 150, 0xbad);
    for (const o of [0, 1, 2]) r.reportCheckpoint(o, 300, 0xaaa);
    for (const o of [0, 1, 2]) r.reportResult(o, 0xaaa, 0, PLACE);
    for (const c of conns.slice(0, 3)) r.onDisconnect(c);
    expect(settled).toEqual([]);

    r.reportCheckpoint(3, 300, 0xbad); // strike 2 → kick → the room is empty
    expect(settled).toHaveLength(1);
    expect(settled[0]!.integrity).toMatchObject({ verdict: 'dissent', kicked: [3], absent: [3] });
    expect(settled[0]!.hashOk).toBe(true);
    expect(destroyed).toEqual(['r1']);
  });
});
