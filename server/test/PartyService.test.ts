/**
 * PartyService (design/05/15 PvP squad follow-up). Drives the pure core with injected
 * fakes (hand-advanced clock, deterministic id/code source) — mirrors
 * Matchmaker.test.ts's style.
 */
import { describe, it, expect } from 'vitest';
import {
  PartyService,
  MAX_PARTY_SIZE,
  CODE_DRAW_ATTEMPTS,
  CodeSpaceExhausted,
  type PartyServiceDeps,
} from '../src/PartyService';

function make(overrides: Partial<PartyServiceDeps> = {}) {
  let now = 1_000;
  let partyN = 0;
  let codeN = 0;
  const deps: PartyServiceDeps = {
    nowMs: () => now,
    newPartyId: () => `party-${++partyN}`,
    newCode: () => `CODE${++codeN}`,
    ...overrides,
  };
  const svc = new PartyService(deps);
  return { svc, advance: (ms: number) => (now += ms) };
}

describe('PartyService — create/join/leave', () => {
  it('creates a party with the creator as sole member and leader', () => {
    const { svc } = make();
    const p = svc.create('alice');
    expect(p).toMatchObject({ leaderId: 'alice', members: ['alice'], matching: false });
    expect(p.code).toBeTruthy();
    expect(p.partyId).toBeTruthy();
  });

  it('lets another player join via the code', () => {
    const { svc } = make();
    const p = svc.create('alice');
    const joined = svc.join(p.code, 'bob');
    expect(joined).toMatchObject({ partyId: p.partyId, members: ['alice', 'bob'] });
  });

  it('joining twice with the same playerId is idempotent, not a duplicate', () => {
    const { svc } = make();
    const p = svc.create('alice');
    svc.join(p.code, 'bob');
    const again = svc.join(p.code, 'bob');
    expect(again!.members).toEqual(['alice', 'bob']);
  });

  it('rejects join on an unknown code', () => {
    const { svc } = make();
    expect(svc.join('NOPE', 'bob')).toBeNull();
  });

  it(`caps membership at MAX_PARTY_SIZE (${MAX_PARTY_SIZE})`, () => {
    const { svc } = make();
    const p = svc.create('p0');
    for (let i = 1; i < MAX_PARTY_SIZE; i++) {
      expect(svc.join(p.code, `p${i}`)).not.toBeNull();
    }
    expect(svc.join(p.code, 'overflow')).toBeNull();
    expect(svc.get(p.partyId)!.members).toHaveLength(MAX_PARTY_SIZE);
  });

  it('leaving reassigns leadership to the next member, never leaves it dangling', () => {
    const { svc } = make();
    const p = svc.create('alice');
    svc.join(p.code, 'bob');
    const afterLeave = svc.leave(p.partyId, 'alice');
    expect(afterLeave).toMatchObject({ leaderId: 'bob', members: ['bob'] });
  });

  it('dissolves the party once the last member leaves, freeing the code', () => {
    const { svc } = make();
    const p = svc.create('alice');
    expect(svc.leave(p.partyId, 'alice')).toBeNull();
    expect(svc.get(p.partyId)).toBeNull();
    // The code is free again — a fresh party could theoretically reuse it (not
    // asserted here since newCode() never repeats in this fake), but joining the old
    // code must now fail rather than resurrecting the dissolved party.
    expect(svc.join(p.code, 'carol')).toBeNull();
  });

  it('a dissolved code is actually REISSUABLE, not merely unjoinable', () => {
    // The sibling case above asserts the negative half (the old code no longer resolves)
    // with a fake whose codes never repeat, so it cannot see the positive half: that
    // `codeToPartyId` gave the string back to the pool rather than holding it forever. A
    // generator pinned to ONE code makes the difference visible — a `delete` that never
    // happened turns the second `create` into `CODE_DRAW_ATTEMPTS` collisions and a throw.
    const { svc } = make({ newCode: () => 'ONLY' });
    const first = svc.create('alice');
    expect(first.code).toBe('ONLY');
    svc.leave(first.partyId, 'alice');
    const second = svc.create('bob');
    expect(second.code).toBe('ONLY');
    expect(second.partyId).not.toBe(first.partyId);
    expect(svc.join('ONLY', 'carol')!.members).toEqual(['bob', 'carol']);
  });

  it('leave on an unknown partyId is a no-op null, not a throw', () => {
    const { svc } = make();
    expect(svc.leave('nope', 'alice')).toBeNull();
  });
});

describe('PartyService — mode (2026-09-26, co-op room codes)', () => {
  it('defaults to a PvP squad, the only party that existed before the field', () => {
    const { svc } = make();
    expect(svc.create('alice')).toMatchObject({ mode: 'pvp', capacity: MAX_PARTY_SIZE });
  });

  it('caps a co-op party at the two seats of a co-op room', () => {
    const { svc } = make();
    const p = svc.create('alice', 'coop');
    expect(p).toMatchObject({ mode: 'coop', capacity: 2 });
    expect(svc.join(p.code, 'bob')).toMatchObject({ members: ['alice', 'bob'], mode: 'coop' });
    expect(svc.join(p.code, 'carol')).toBeNull();
    // Control for the cap: the same third join succeeds on a squad.
    const squad = svc.create('dave');
    svc.join(squad.code, 'erin');
    expect(svc.join(squad.code, 'frank')).not.toBeNull();
  });

  it('a rejoin by an existing member of a full co-op party is still idempotent', () => {
    const { svc } = make();
    const p = svc.create('alice', 'coop');
    svc.join(p.code, 'bob');
    expect(svc.join(p.code, 'bob')!.members).toEqual(['alice', 'bob']);
  });
});

describe('PartyService — code uniqueness', () => {
  it('redraws a code already in use instead of handing out a duplicate', () => {
    // The whole point of server-side dedup, and the reason `newCode` is injected. The
    // generator collides with the live party's code twice, then yields a free one; the
    // second party must end up with the free one and the first party's code must still
    // resolve to the FIRST party.
    const queue = ['AAA', 'AAA', 'AAA', 'BBB'];
    const { svc } = make({ newCode: () => queue.shift()! });
    const first = svc.create('alice');
    const second = svc.create('bob');
    expect(first.code).toBe('AAA');
    expect(second.code).toBe('BBB');
    expect(svc.join('AAA', 'carol')!.partyId).toBe(first.partyId);
    expect(svc.join('BBB', 'dave')!.partyId).toBe(second.partyId);
  });

  it('two parties never share a code, over many creates against a colliding generator', () => {
    // A generator that yields each code THREE times before moving on — far worse than
    // anything real, which is the point. With 40 parties alive at once every code must
    // still be distinct and must still resolve to its own party. The set-size assertion is
    // what catches a "dedup" that works by overwriting the earlier owner of a code, which
    // leaves an existing party silently unjoinable rather than throwing anything.
    let n = 0;
    const { svc } = make({ newCode: () => `C${Math.floor(n++ / 3) % 60}` });
    const parties = Array.from({ length: 40 }, (_, i) => svc.create(`p${i}`));
    expect(new Set(parties.map((party) => party.code)).size).toBe(40);
    for (const party of parties) {
      expect(svc.join(party.code, `late-${party.partyId}`)!.partyId).toBe(party.partyId);
    }
  });

  it(`throws CodeSpaceExhausted after ${CODE_DRAW_ATTEMPTS} collisions rather than looping forever`, () => {
    // The bound exists because the loop it replaced was `while (taken) redraw()` on the one
    // event loop that also serves matchmaking and ladder settlement: a saturated keyspace
    // there is not a slow create, it is a hung process. A generator with exactly one code
    // is a saturated keyspace of size 1.
    let draws = 0;
    const { svc } = make({
      newCode: () => {
        draws++;
        return 'SAME';
      },
    });
    expect(svc.create('alice').code).toBe('SAME');
    draws = 0;
    expect(() => svc.create('bob')).toThrow(CodeSpaceExhausted);
    // Bounded, and bounded at the documented number — not merely "it stopped".
    expect(draws).toBe(CODE_DRAW_ATTEMPTS);
    // And the refusal left nothing half-built behind: the first party is untouched and its
    // code still resolves to it.
    expect(svc.join('SAME', 'carol')!.members).toEqual(['alice', 'carol']);
  });

  it('a sweep runs before the draws, so an expired code is available again immediately', () => {
    // Ordering, asserted rather than assumed: `create` sweeps first, so the one code this
    // generator has is free by the time it is drawn. Sweeping AFTER would make this throw.
    const { svc, advance } = make({ newCode: () => 'SAME' });
    svc.create('alice');
    advance(10 * 60_000 + 1);
    expect(svc.create('bob').code).toBe('SAME');
  });
});

describe('PartyService — startMatching', () => {
  it('only the leader can start matching', () => {
    const { svc } = make();
    const p = svc.create('alice');
    svc.join(p.code, 'bob');
    expect(svc.startMatching(p.partyId, 'bob')).toBeNull(); // not the leader
    const started = svc.startMatching(p.partyId, 'alice');
    expect(started!.matching).toBe(true);
    expect(svc.get(p.partyId)!.matching).toBe(true);
  });

  it('returns null for an unknown party', () => {
    const { svc } = make();
    expect(svc.startMatching('nope', 'alice')).toBeNull();
  });
});

describe('PartyService — expiry', () => {
  it('an idle party expires after its TTL and frees its code', () => {
    const { svc, advance } = make();
    const p = svc.create('alice');
    advance(10 * 60_000 + 1); // past the default 10 min idle TTL
    expect(svc.get(p.partyId)).toBeNull();
    expect(svc.join(p.code, 'bob')).toBeNull();
  });

  it('activity (join/leave/startMatching) resets the idle clock', () => {
    const { svc, advance } = make();
    const p = svc.create('alice');
    advance(9 * 60_000);
    svc.join(p.code, 'bob'); // refreshes updatedAt
    advance(9 * 60_000); // would have expired from create-time alone, not from join-time
    expect(svc.get(p.partyId)).not.toBeNull();
  });
});
