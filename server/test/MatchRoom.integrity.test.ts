/**
 * MatchRoom's settlement under the per-seat vote (design/15, "PvP integrity", decided
 * 2026-09-26): what reaches `onSettled` — `hashOk`, the verdict, the named seats, the log —
 * for each way a room can settle. The vote and bounds rules themselves are pinned in
 * `settlement.test.ts`; this file pins that the room feeds them the right inputs (its own
 * frame, its own mode, every kick) and routes their answers to the right fields.
 */
import { describe, expect, it } from 'vitest';
import { makeCommand } from '@dd/engine';
import type { Brad, ServerMsg } from '@dd/engine';
import { MatchRoom, type IntervalHandle, type RoomConnection, type Scheduler, type SettledMatch } from '../src/MatchRoom';
import { MIN_PVP_SETTLE_FRAME } from '../src/settlement';

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
  ) {}
  send(m: ServerMsg): void {
    this.msgs.push(m);
  }
}

/**
 * A full, started 4-seat room whose broadcast frame sits exactly at the PvP duration floor
 * (one pulse of `MIN_PVP_SETTLE_FRAME` frames), so bounds pass unless a case moves them.
 */
function started(mode: 'pvp' | 'coop' = 'pvp', pulses = 1) {
  const scheduler = new FakeScheduler();
  const settled: SettledMatch[] = [];
  const r = new MatchRoom('r1', 4242, 4, {
    scheduler,
    mode,
    onDestroy: () => {},
    onSettled: (m) => settled.push(m),
    framesPerBatch: MIN_PVP_SETTLE_FRAME,
  });
  const conns = [0, 1, 2, 3].map((o) => new FakeConn(o, `acct-${o}`));
  for (const c of conns) r.join(c);
  for (let i = 0; i < pulses; i++) scheduler.pulse();
  return { r, conns, settled, scheduler };
}

const PLACE = [3, 2, 1] as const;

describe('MatchRoom settlement — the vote reaches onSettled', () => {
  it('a unanimous PvP room settles clean, rates, and carries no log', () => {
    const { r, settled } = started();
    for (const o of [0, 1, 2, 3]) r.reportResult(o, 0xaaa, 0, PLACE);
    expect(settled).toHaveLength(1);
    expect(settled[0]!.hashOk).toBe(true);
    expect(settled[0]!.integrity).toEqual({
      verdict: 'clean',
      dissenters: [],
      kicked: [],
      settleFrame: MIN_PVP_SETTLE_FRAME,
      seed: 4242,
    });
  });

  it('one divergent seat of four no longer voids the result: it rates, and the seat is named', () => {
    const { r, conns, settled } = started();
    r.reportResult(0, 0xaaa, 0, PLACE);
    r.reportResult(1, 0xbad, 0, PLACE); // the dissenter reports SECOND — order must not matter
    r.reportResult(2, 0xaaa, 0, PLACE);
    r.reportResult(3, 0xaaa, 0, PLACE);
    const m = settled[0]!;
    expect(m.hashOk).toBe(true);
    expect(m.winner).toBe(0);
    expect(m.placements).toEqual(PLACE);
    expect(m.integrity.verdict).toBe('dissent');
    expect(m.integrity.dissenters).toEqual([1]);
    expect(m.integrity.log).toEqual([]); // no commands were submitted; the log is still attached
    const over = conns[0]!.msgs.find((x) => x.type === 'match_over');
    expect(over).toMatchObject({ reason: 'placement', winner: 0 });
  });

  it('a first reporter who lies about the placements no longer decides them', () => {
    const { r, settled } = started();
    r.reportResult(3, 0xaaa, 3, [2, 1, 0]); // seat 3 reports first and names itself the winner
    for (const o of [0, 1, 2]) r.reportResult(o, 0xaaa, 0, PLACE);
    expect(settled[0]!.winner).toBe(0);
    expect(settled[0]!.placements).toEqual(PLACE);
    expect(settled[0]!.integrity.dissenters).toEqual([3]);
  });

  it('a 2-2 split settles nothing, names nobody, and archives the log', () => {
    const { r, conns, settled, scheduler } = started();
    r.submitCmd(0, makeCommand({ owner: 0, tick: 0, moveBrad: 0 as Brad, moveMag: 0, buttons: 1 }));
    scheduler.pulse(); // lands the command in the log, at twice the floor
    r.reportResult(0, 0xaaa, 0, PLACE);
    r.reportResult(1, 0xaaa, 0, PLACE);
    r.reportResult(2, 0xbbb, 0, PLACE);
    r.reportResult(3, 0xbbb, 0, PLACE);
    const m = settled[0]!;
    expect(m.hashOk).toBe(false);
    expect(m.integrity.verdict).toBe('no_consensus');
    expect(m.integrity.dissenters).toEqual([]);
    expect(m.integrity.log).toHaveLength(1);
    expect(m.integrity.log![0]!.frame).toBe(MIN_PVP_SETTLE_FRAME * 2);
    expect(conns[0]!.msgs.find((x) => x.type === 'match_over')).toMatchObject({ reason: 'disconnect' });
  });
});

describe('MatchRoom settlement — the bounds check', () => {
  it('an agreed PvP result naming the winner among the losers settles nothing', () => {
    const { r, settled } = started();
    for (const o of [0, 1, 2, 3]) r.reportResult(o, 0xaaa, 0, [3, 2, 0]);
    expect(settled[0]!.hashOk).toBe(false);
    expect(settled[0]!.integrity).toMatchObject({ verdict: 'bounds', bounds: 'placements_mismatch' });
    expect(settled[0]!.integrity.log).toBeDefined();
  });

  it('an agreed PvP result that settles before the duration floor is too short', () => {
    const { r, settled } = started('pvp', 0); // frame 0: nothing has been broadcast yet
    for (const o of [0, 1, 2, 3]) r.reportResult(o, 0xaaa, 0, PLACE);
    expect(settled[0]!.integrity).toMatchObject({ verdict: 'bounds', bounds: 'too_short', settleFrame: 0 });
    expect(settled[0]!.hashOk).toBe(false);
  });

  it('a co-op room is never bounds-checked, however short and whatever it reports', () => {
    const { r, settled } = started('coop', 0);
    for (const o of [0, 1, 2, 3]) r.reportResult(o, 0xaaa, 'enemies');
    expect(settled[0]!.hashOk).toBe(true);
    expect(settled[0]!.integrity.verdict).toBe('clean');
  });
});

describe('MatchRoom settlement — checkpoint kicks reach the record', () => {
  it('a seat kicked mid-match is named at settlement even after it reconnects and votes with the majority', () => {
    const { r, settled } = started();
    for (const tick of [30, 60]) {
      for (const o of [0, 1, 2]) r.reportCheckpoint(o, tick, 0x111);
      r.reportCheckpoint(3, tick, 0x999); // two consecutive divergences → kicked
    }
    const back = new FakeConn(3, 'acct-3');
    expect(r.resume(back, 0)).toBe(true);
    for (const o of [0, 1, 2, 3]) r.reportResult(o, 0xaaa, 0, PLACE);
    const m = settled[0]!;
    expect(m.hashOk).toBe(true); // a kick does not void the result on its own
    expect(m.integrity.verdict).toBe('dissent');
    expect(m.integrity.kicked).toEqual([3]);
    expect(m.integrity.dissenters).toEqual([]);
  });
});
