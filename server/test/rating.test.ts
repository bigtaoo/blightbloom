/**
 * PvP ladder rating (design/15, ROADMAP 4.6) — the matchsvc-side rating math and
 * store, in isolation from any HTTP/matchsvc wiring.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db';
import { computeRatingDeltas, RatingStore, DEFAULT_RATING, type RatingChange } from '../src/rating';

/**
 * A real file-backed account DB, for the cases that need TWO connections to one database —
 * `:memory:` gives each connection its own private database, so a dedupe claim made on one
 * would be invisible to the other and the test would pass for the wrong reason.
 */
let tempDir: string | undefined;
let openDbs: DatabaseSync[] = [];

function fileDb(): DatabaseSync {
  tempDir ??= mkdtempSync(join(tmpdir(), 'bb-rating-'));
  const db = openDb(join(tempDir, 'ratings.db'));
  openDbs.push(db);
  return db;
}

afterEach(() => {
  for (const db of openDbs) db.close(); // release the handle before rmSync (Windows-safe)
  openDbs = [];
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe('computeRatingDeltas', () => {
  it('a single participant (nothing to compare against) gets a zero delta', () => {
    expect(computeRatingDeltas([1000], [1])).toEqual([0]);
  });

  it('equal ratings: 1st place gains, last place loses, by roughly symmetric amounts', () => {
    const deltas = computeRatingDeltas([1000, 1000, 1000, 1000], [1, 2, 3, 4]);
    expect(deltas[0]!).toBeGreaterThan(0); // 1st gained
    expect(deltas[3]!).toBeLessThan(0); // last lost
    // Monotonic: better placement never gains less than a worse one at equal rating.
    expect(deltas[0]!).toBeGreaterThanOrEqual(deltas[1]!);
    expect(deltas[1]!).toBeGreaterThanOrEqual(deltas[2]!);
    expect(deltas[2]!).toBeGreaterThanOrEqual(deltas[3]!);
  });

  it('a favorite (higher rating) placing last loses more than an underdog placing last', () => {
    const deltas = computeRatingDeltas([1400, 1000, 1000, 600], [4, 2, 3, 1]);
    // deltas[0] is the 1400-rated favorite finishing last; deltas[3] is the 600-rated
    // underdog finishing FIRST — both are "surprising" outcomes, both should be large
    // relative to a same-rating same-placement case, but signed opposite.
    expect(deltas[0]!).toBeLessThan(0);
    expect(deltas[3]!).toBeGreaterThan(0);
  });

  it('a higher-rated favorite winning gains less than a lower-rated underdog winning', () => {
    const favoriteWins = computeRatingDeltas([1400, 1000, 1000, 1000], [1, 2, 3, 4]);
    const underdogWins = computeRatingDeltas([600, 1000, 1000, 1000], [1, 2, 3, 4]);
    expect(favoriteWins[0]!).toBeLessThan(underdogWins[0]!);
  });
});

describe('computeRatingDeltas — squad-aware (design/05/15 squad follow-up)', () => {
  it('omitting teamIds is byte-identical to the original per-seat formula', () => {
    const ratings = [1400, 1000, 1000, 600];
    const places = [4, 2, 3, 1];
    expect(computeRatingDeltas(ratings, places)).toEqual(
      computeRatingDeltas(ratings, places, ratings.map((_, i) => i)), // singleton teams
    );
  });

  it('every member of a squad gets the identical delta, even with different individual places', () => {
    // team0 = seats 0,1 (adjacent places 1,2 — the winning squad); team1 = seats 2,3 (places 3,4).
    const deltas = computeRatingDeltas([1000, 1000, 1000, 1000], [1, 2, 3, 4], [0, 0, 1, 1]);
    expect(deltas[0]).toBe(deltas[1]); // same squad, same delta
    expect(deltas[2]).toBe(deltas[3]);
    expect(deltas[0]!).toBeGreaterThan(0); // winning squad gains
    expect(deltas[2]!).toBeLessThan(0); // losing squad loses
  });

  it('expected score compares the SQUAD average rating, not each member\'s own', () => {
    // team0 = a 1400-favorite paired with a 600-underdog (avg 1000) that still WINS;
    // team1 = two 1000s (avg 1000). Field average is also 1000, so both squads' expected
    // score is identical (0.5) despite wildly different individual ratings within team0 —
    // proof the math uses the squad average, not the 1400 or the 600 individually.
    const deltas = computeRatingDeltas([1400, 600, 1000, 1000], [1, 2, 3, 4], [0, 0, 1, 1]);
    expect(deltas[0]).toBe(deltas[1]);
    expect(deltas[0]).toBe(16); // K=32 * (actual 1 - expected 0.5)
    expect(deltas[2]).toBe(deltas[3]);
    expect(deltas[2]).toBe(-16);
  });
});

describe('RatingStore', () => {
  it('an unknown account starts at DEFAULT_RATING', () => {
    const store = new RatingStore();
    expect(store.get('alice')).toBe(DEFAULT_RATING);
  });

  it('applyMatch updates every account and returns before/after for each', () => {
    const store = new RatingStore();
    const changes = store.applyMatch(['alice', 'bob', 'carol', 'dave'], [1, 2, 3, 4]);
    expect(changes).toHaveLength(4);
    expect(changes[0]!.accountId).toBe('alice');
    expect(changes[0]!.before).toBe(DEFAULT_RATING);
    expect(changes[0]!.after).toBeGreaterThan(DEFAULT_RATING); // alice won
    expect(store.get('alice')).toBe(changes[0]!.after); // persisted
    expect(store.get('dave')).toBeLessThan(DEFAULT_RATING); // dave placed last
  });

  it('ratings compound across multiple matches', () => {
    const store = new RatingStore();
    store.applyMatch(['alice', 'bob'], [1, 2]);
    const afterFirst = store.get('alice');
    store.applyMatch(['alice', 'bob'], [1, 2]);
    expect(store.get('alice')).toBeGreaterThan(afterFirst); // won again, rating keeps climbing
  });

  it('applyMatch, given teamIds, applies the same delta to every squadmate', () => {
    const store = new RatingStore();
    const changes = store.applyMatch(['alice', 'bob', 'carol', 'dave'], [1, 2, 3, 4], [0, 0, 1, 1]);
    const delta = (c: (typeof changes)[number]) => c.after - c.before;
    expect(delta(changes[0]!)).toBe(delta(changes[1]!)); // alice/bob, same squad
    expect(delta(changes[2]!)).toBe(delta(changes[3]!)); // carol/dave, same squad
    expect(delta(changes[0]!)).toBeGreaterThan(delta(changes[2]!)); // winning squad > losing squad
  });
});

describe('RatingStore — SQLite-backed', () => {
  it('persists ratings in the given db, surviving a fresh RatingStore instance', () => {
    const db = openDb(':memory:');
    const store = new RatingStore(db);
    const changes = store.applyMatch(['alice', 'bob'], [1, 2]);

    // A brand new store over the SAME db (simulates a server restart) sees the same ratings.
    const reopened = new RatingStore(db);
    expect(reopened.get('alice')).toBe(changes[0]!.after);
    expect(reopened.get('bob')).toBe(changes[1]!.after);
  });

  it('a db-backed store does not leak into an in-memory-only store, and vice versa', () => {
    const db = openDb(':memory:');
    const dbStore = new RatingStore(db);
    const memStore = new RatingStore();
    dbStore.applyMatch(['alice', 'bob'], [1, 2]);
    expect(memStore.get('alice')).toBe(DEFAULT_RATING);
  });

  it('a scaffold guest/bot id (seat:{roomId}:{seatIdx}) persists fine despite the FK on accounts', () => {
    const db = openDb(':memory:');
    const store = new RatingStore(db);
    expect(() => store.applyMatch(['seat:room1:0', 'seat:room1:1'], [1, 2])).not.toThrow();
    expect(store.get('seat:room1:0')).toBeGreaterThan(DEFAULT_RATING);
  });
});

describe('computeRatingDeltas — the squad-aware arms nothing else reaches', () => {
  it('gives everyone zero when the whole field is ONE team', () => {
    // `numTeams <= 1 ? 0.5 : ...`. A four-seat room where every seat shares a squad has no
    // ranking to express, so the actual score is a draw against itself — and the delta must
    // be 0 rather than the K-factor swing an `(numTeams - rank) / (numTeams - 1)` with
    // numTeams === 1 would produce (a division by zero, i.e. NaN ratings written to the DB).
    const deltas = computeRatingDeltas([1200, 1200, 1000, 1400], [1, 1, 1, 1], [7, 7, 7, 7]);
    expect(deltas).toEqual([0, 0, 0, 0]);
    for (const d of deltas) expect(Number.isFinite(d)).toBe(true);
  });

  it('breaks a tie between two teams that share a best place by teamId, deterministically', () => {
    // The `|| a.teamId - b.teamId` arm. Two teams whose best member placed the same is
    // structurally impossible from a real match, but the sort has to be TOTAL anyway:
    // without the tiebreak the order depends on the engine's sort stability, and the same
    // settled match could rate differently on two runs.
    const run = (): number[] => computeRatingDeltas([1200, 1200], [1, 1], [5, 2]);
    const first = run();
    for (let i = 0; i < 5; i++) expect(run()).toEqual(first);
    // Team 2 sorts ahead of team 5, so seat 1 (team 2) is ranked first and gains.
    expect(first[1]!).toBeGreaterThan(0);
    expect(first[0]!).toBeLessThan(0);
  });
});

/**
 * `applyMatchOnce` — exactly-once settlement (design/19 §3, closing the one item ROADMAP
 * 8.1 left open and wrote at its own call site).
 *
 * The defect these cases exist for is not hypothetical and was not a race: 8.1 gave
 * `reportSettledMatch` a retry budget, and `applyMatch` had no dedupe key, so a report that
 * was DELIVERED and lost only its response — a timeout, or a 5xx written after the write —
 * added the whole match's deltas a second time. A "the second call returns applied: false"
 * test would prove almost none of that, so each case below asserts what happened to the
 * RATINGS, and the two failure directions are separated:
 *
 *   lose the claim, apply anyway  → the retry double-credits (the original defect)
 *   win the claim, then fail      → that match's rating is gone permanently, with the key
 *                                   burned so no retry can ever land it. Strictly worse.
 */
describe('RatingStore.applyMatchOnce — the dedupe claim', () => {
  const KEY = 'room-7:0123456789abcdef';

  it.each([
    ['in-memory', (): RatingStore => new RatingStore()],
    ['SQLite', (): RatingStore => new RatingStore(openDb(':memory:'))],
    ['SQLite on a real file', (): RatingStore => new RatingStore(fileDb())],
  ])('%s: the same reportKey applies ONCE, and the second report moves nothing', (_label, make) => {
    const store = make();
    const first = store.applyMatchOnce(KEY, ['alice', 'bob'], [1, 2]);
    expect(first.applied).toBe(true);
    const afterFirst = { alice: store.get('alice'), bob: store.get('bob') };
    expect(afterFirst.alice).toBeGreaterThan(DEFAULT_RATING); // the match really was applied

    const second = store.applyMatchOnce(KEY, ['alice', 'bob'], [1, 2]);
    expect(second.applied).toBe(false);
    // The assertion that matters. `applied: false` with the ratings moved again would be
    // the original defect wearing the new return type.
    expect(store.get('alice')).toBe(afterFirst.alice);
    expect(store.get('bob')).toBe(afterFirst.bob);
  });

  it.each([
    ['in-memory', (): RatingStore => new RatingStore()],
    ['SQLite', (): RatingStore => new RatingStore(openDb(':memory:'))],
  ])('%s: a DIFFERENT reportKey is a different match and applies again', (_label, make) => {
    // The mirror of the case above, and the one that fails if the key is over-broad (e.g. a
    // roomId-only key against `index.ts`'s legacy dev handshake, where a room id can be
    // reused): a store that refuses every second report is not idempotent, it is broken.
    const store = make();
    store.applyMatchOnce('room-7:aaaaaaaaaaaaaaaa', ['alice', 'bob'], [1, 2]);
    const afterFirst = store.get('alice');
    const second = store.applyMatchOnce('room-8:bbbbbbbbbbbbbbbb', ['alice', 'bob'], [1, 2]);
    expect(second.applied).toBe(true);
    expect(store.get('alice')).toBeGreaterThan(afterFirst);
  });

  it('returns the same {before, after} changes an unconditional applyMatch would', () => {
    const once = new RatingStore().applyMatchOnce(KEY, ['alice', 'bob', 'carol'], [1, 2, 3], [0, 0, 1]);
    const plain = new RatingStore().applyMatch(['alice', 'bob', 'carol'], [1, 2, 3], [0, 0, 1]);
    expect(once.applied && once.changes).toEqual(plain);
  });

  it('records applied_at from the injected clock, so an operator can date the claim', () => {
    const db = openDb(':memory:');
    new RatingStore(db, () => 1_700_000_000_000).applyMatchOnce(KEY, ['alice', 'bob'], [1, 2]);
    const row = db.prepare('SELECT report_key, applied_at FROM rating_reports').get() as unknown as {
      report_key: string;
      applied_at: number;
    };
    expect(row.report_key).toBe(KEY);
    expect(row.applied_at).toBe(1_700_000_000_000);
  });

  it('leaves applyMatch itself unchanged — an unkeyed apply still compounds', () => {
    // design/15's contract, and what every pre-8.1 caller and test depends on. If dedupe
    // had been folded INTO `applyMatch`, this would silently become a no-op.
    const store = new RatingStore();
    store.applyMatch(['alice', 'bob'], [1, 2]);
    const afterFirst = store.get('alice');
    store.applyMatch(['alice', 'bob'], [1, 2]);
    expect(store.get('alice')).toBeGreaterThan(afterFirst);
  });
});

describe('RatingStore.applyMatchOnce — the claim and the ratings are ONE transaction', () => {
  const KEY = 'room-rollback:0000000000000000';

  it('SQLite: a failed rating write rolls the CLAIM back with it, so a retry can still land', () => {
    // The failure this protects against is the worse of the two directions: a burned key
    // for a match whose deltas were never written means that match's rating is gone
    // forever, and the next retry is answered "already applied". Forced with a real SQLite
    // trigger rather than a mocked driver — the point is that the DATABASE aborts the write
    // the claim is supposed to be tied to.
    const db = openDb(':memory:');
    const store = new RatingStore(db);
    db.exec(`CREATE TRIGGER ratings_refuse BEFORE INSERT ON ratings BEGIN SELECT RAISE(ABORT, 'disk on fire'); END`);

    expect(() => store.applyMatchOnce(KEY, ['alice', 'bob'], [1, 2])).toThrow(/disk on fire/);
    expect(store.get('alice')).toBe(DEFAULT_RATING); // nothing was applied
    const claims = db.prepare('SELECT COUNT(*) AS c FROM rating_reports').get() as unknown as { c: number };
    expect(claims.c).toBe(0);

    // And now the retry — the whole reason the rollback matters. `routes/rating.ts` answers
    // the throw with a 500, which is the one status `internalFetch` retries.
    db.exec('DROP TRIGGER ratings_refuse');
    const retry = store.applyMatchOnce(KEY, ['alice', 'bob'], [1, 2]);
    expect(retry.applied).toBe(true);
    expect(store.get('alice')).toBeGreaterThan(DEFAULT_RATING);
  });

  it('SQLite: the connection is usable afterwards — no transaction left open', () => {
    // A `ROLLBACK` that did not run (or ran twice) leaves the connection either inside a
    // transaction or throwing on the next `BEGIN`, and the process serves every later
    // settlement through this same connection.
    const db = openDb(':memory:');
    const store = new RatingStore(db);
    db.exec(`CREATE TRIGGER ratings_refuse BEFORE INSERT ON ratings BEGIN SELECT RAISE(ABORT, 'nope'); END`);
    expect(() => store.applyMatchOnce(KEY, ['alice'], [1])).toThrow();
    db.exec('DROP TRIGGER ratings_refuse');
    expect(() => store.applyMatchOnce('another:key000000000000', ['carol', 'dave'], [1, 2])).not.toThrow();
    expect(store.get('carol')).toBeGreaterThan(DEFAULT_RATING);
  });

  it('in-memory: a failed apply restores the cache AND releases the claim', () => {
    // The no-db backend hand-rolls the transaction, so it gets the same test rather than
    // being trusted. `super.applyMatch` really does write the cache before the throw, which
    // is what makes the restore observable.
    class FlakyStore extends RatingStore {
      fail = true;
      override applyMatch(
        accountIds: readonly string[],
        places: readonly number[],
        teamIds?: readonly number[],
      ): RatingChange[] {
        const changes = super.applyMatch(accountIds, places, teamIds);
        if (this.fail) throw new Error('boom');
        return changes;
      }
    }
    const store = new FlakyStore();
    expect(() => store.applyMatchOnce(KEY, ['alice', 'bob'], [1, 2])).toThrow(/boom/);
    expect(store.get('alice')).toBe(DEFAULT_RATING); // rolled back, not left half-applied
    expect(store.get('bob')).toBe(DEFAULT_RATING);

    store.fail = false;
    expect(store.applyMatchOnce(KEY, ['alice', 'bob'], [1, 2]).applied).toBe(true);
    expect(store.get('alice')).toBeGreaterThan(DEFAULT_RATING);
  });

  it('in-memory: a failed apply RESTORES an existing rating rather than clearing it', () => {
    // The other arm of the same rollback, and the one a fresh store cannot show: these
    // accounts already have a ladder history, so "undo" means putting the previous number
    // back, not deleting the entry and silently resetting them to DEFAULT_RATING.
    class FlakyStore extends RatingStore {
      fail = false;
      override applyMatch(
        accountIds: readonly string[],
        places: readonly number[],
        teamIds?: readonly number[],
      ): RatingChange[] {
        const changes = super.applyMatch(accountIds, places, teamIds);
        if (this.fail) throw new Error('boom');
        return changes;
      }
    }
    const store = new FlakyStore();
    store.applyMatch(['alice', 'bob'], [1, 2]); // a prior match, so both have a real rating
    const established = { alice: store.get('alice'), bob: store.get('bob') };
    expect(established.alice).not.toBe(DEFAULT_RATING);

    store.fail = true;
    expect(() => store.applyMatchOnce(KEY, ['alice', 'bob'], [1, 2])).toThrow(/boom/);
    expect(store.get('alice')).toBe(established.alice);
    expect(store.get('bob')).toBe(established.bob);
  });
});

describe('RatingStore.applyMatchOnce — two settlements racing for one claim', () => {
  const KEY = 'room-race:1111111111111111';

  it('two connections to one database file: the second loses the claim and applies nothing', () => {
    // The durable half of "only one wins". Within one process every apply is synchronous,
    // so the interleaving that matters is across CONNECTIONS — a restarted matchsvc, or a
    // second instance — which is exactly what a shared `rating_reports` row is for. A
    // `:memory:` db per connection could not show this at all.
    const a = new RatingStore(fileDb());
    const b = new RatingStore(fileDb());
    expect(a.applyMatchOnce(KEY, ['alice', 'bob'], [1, 2]).applied).toBe(true);
    const afterA = a.get('alice');

    expect(b.applyMatchOnce(KEY, ['alice', 'bob'], [1, 2]).applied).toBe(false);
    expect(b.get('alice')).toBe(afterA); // b sees a's committed rating, and did not add to it
    expect(a.get('alice')).toBe(afterA);
  });

  it('a peer already holding the write lock THROWS rather than skipping the claim', () => {
    // `BEGIN IMMEDIATE` sits outside the try on purpose: a busy database means no
    // transaction was opened, so there is nothing to roll back, and the honest answer is to
    // fail the request. `routes/rating.ts` turns it into a 500 and the sender retries —
    // whereas treating a locked database as "already claimed" would DROP the settlement,
    // which is the failure nothing logs.
    const holder = fileDb();
    const store = new RatingStore(fileDb());
    holder.exec('BEGIN IMMEDIATE');
    holder.prepare('INSERT INTO ratings (account_id, rating) VALUES (?, ?)').run('someone-else', 1234);
    try {
      expect(() => store.applyMatchOnce(KEY, ['alice', 'bob'], [1, 2])).toThrow(/locked/i);
    } finally {
      holder.exec('ROLLBACK');
    }
    // Nothing was claimed, so once the lock clears the settlement still lands.
    expect(store.applyMatchOnce(KEY, ['alice', 'bob'], [1, 2]).applied).toBe(true);
  });
});
