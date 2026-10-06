/**
 * Matchmaker — chapters (2026-10-06). A co-op room plays ONE PvE chapter, so the queue is
 * keyed by it: co-op waiters who chose different chapters are never grouped, the ticket and
 * the bot-fill hook both carry the chapter, and PvP is untouched by any of it.
 */
import { describe, it, expect } from 'vitest';
import { Matchmaker, type MatchmakerDeps } from '../src/Matchmaker';
import { signTicket, verifyTicket } from '../src/ticket';

const SECRET = 'mm-secret';

function make(overrides: Partial<MatchmakerDeps> = {}) {
  let now = 1_000;
  let n = 0;
  const deps: MatchmakerDeps = {
    nowMs: () => now,
    nextSeed: () => ++n,
    newRoomId: () => `room-${++n}`,
    sign: (p) => signTicket(p, SECRET),
    ...overrides,
  };
  return { mm: new Matchmaker(deps), advance: (ms: number) => (now += ms), at: () => now };
}

/** `enqueue` with only the shape arguments that matter here. */
const coop = (mm: Matchmaker, chapterId?: 'ember' | 'frost') =>
  mm.enqueue(2, 'coop', undefined, undefined, undefined, undefined, chapterId);

describe('Matchmaker — chapters', () => {
  it('never groups two co-op players who chose different chapters', () => {
    const { mm } = make();
    const a = coop(mm, 'ember');
    const b = coop(mm, 'frost');
    expect(a.ticket).toBeUndefined();
    expect(b.ticket).toBeUndefined();
    expect(mm.waiting(2, 'coop', 'ember')).toBe(1);
    expect(mm.waiting(2, 'coop', 'frost')).toBe(1);
  });

  it('groups two co-op players who chose the same chapter — the control', () => {
    const { mm, at } = make();
    coop(mm, 'frost');
    const b = coop(mm, 'frost');
    expect(b.ticket).toBeDefined();
    // The chapter rides in the SIGNED grant, which is what the gameserver builds the room from.
    expect(verifyTicket(b.ticket!.token, SECRET, at())?.chapterId).toBe('frost');
  });

  it('queues a co-op request that names no chapter — every pre-chapter client — for the first one', () => {
    const { mm, at } = make();
    coop(mm); // an old client
    const b = coop(mm, 'ember'); // a new client that picked chapter 1
    expect(b.ticket).toBeDefined(); // the same queue
    expect(verifyTicket(b.ticket!.token, SECRET, at())?.chapterId).toBe('ember');
    expect(mm.waiting(2)).toBe(0);
  });

  it('keeps PvP chapter-blind: a chapter passed with a PvP request is dropped, not keyed on', () => {
    const { mm, at } = make();
    mm.enqueue(2, 'pvp', undefined, undefined, undefined, undefined, 'frost');
    const b = mm.enqueue(2, 'pvp');
    expect(b.ticket).toBeDefined(); // grouped with the chapter-less PvP request
    expect(verifyTicket(b.ticket!.token, SECRET, at())).not.toHaveProperty('chapterId');
  });

  it('hands the chapter to onBotFill so the bot tickets agree with the room', () => {
    const fills: { chapterId?: string; mode: string }[] = [];
    const { mm, advance } = make({ onBotFill: (i) => void fills.push(i) });
    const a = coop(mm, 'frost');
    advance(5_000);
    expect(mm.poll(a.queueId).status).toBe('matched');
    expect(fills).toMatchObject([{ mode: 'coop', chapterId: 'frost' }]);
  });

  it('a co-op backfill takes only its own chapter’s waiters', () => {
    // The backfill path keys the queue too: a frost waiter aging into a room must not sweep
    // up the ember waiter sitting in another queue.
    const fills: { botOwners: readonly number[] }[] = [];
    const { mm, advance } = make({ onBotFill: (i) => void fills.push(i) });
    const a = coop(mm, 'frost');
    advance(1_000);
    coop(mm, 'ember');
    advance(4_000);
    expect(mm.poll(a.queueId).status).toBe('matched');
    expect(fills).toMatchObject([{ botOwners: [1] }]); // a bot, not the ember player
    expect(mm.waiting(2, 'coop', 'ember')).toBe(1);
  });

  it('gives no PvP bot fill a chapter', () => {
    const fills: { chapterId?: string }[] = [];
    const { mm, advance } = make({ onBotFill: (i) => void fills.push(i) });
    const a = mm.enqueue(2, 'pvp');
    advance(5_000);
    mm.poll(a.queueId);
    expect(fills).toHaveLength(1);
    expect(fills[0]!.chapterId).toBeUndefined();
  });
});
