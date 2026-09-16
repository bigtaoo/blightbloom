/**
 * PvP ladder rating (design/15, ROADMAP 4.6) — the matchsvc-side rating math and
 * store, in isolation from any HTTP/matchsvc wiring.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import type { AccountsStore } from '../src/db';
import { computeRatingDeltas, RatingStore, DEFAULT_RATING, type RatingChange } from '../src/rating';
import { openTestAccounts, type AccountsTestContext } from './mongoHarness';

/**
 * The old suite kept a `fileDb()` helper next to its `:memory:` one, because `:memory:`
 * gives every SQLite CONNECTION its own private database — so a dedupe claim made through
 * one would have been invisible to the other, and a two-connection test would have passed
 * for the wrong reason. That distinction does not exist here: two `AccountsStore`s built
 * over one database name see one database, which is what the `fileDb` cases were buying.
 * The two-store cases below therefore build two stores over `ctx.store` instead.
 */
let ctx: AccountsTestContext;
let store_: AccountsStore;

beforeEach(async () => {
  ctx = await openTestAccounts();
  store_ = ctx.store;
});
afterEach(async () => {
  await ctx.dispose();
});

describe('computeRatingDeltas', () => {
  it('a single participant (nothing to compare against) gets a zero delta', async () => {
    expect(computeRatingDeltas([1000], [1])).toEqual([0]);
  });

  it('equal ratings: 1st place gains, last place loses, by roughly symmetric amounts', async () => {
    const deltas = computeRatingDeltas([1000, 1000, 1000, 1000], [1, 2, 3, 4]);
    expect(deltas[0]!).toBeGreaterThan(0); // 1st gained
    expect(deltas[3]!).toBeLessThan(0); // last lost
    // Monotonic: better placement never gains less than a worse one at equal rating.
    expect(deltas[0]!).toBeGreaterThanOrEqual(deltas[1]!);
    expect(deltas[1]!).toBeGreaterThanOrEqual(deltas[2]!);
    expect(deltas[2]!).toBeGreaterThanOrEqual(deltas[3]!);
  });

  it('a favorite (higher rating) placing last loses more than an underdog placing last', async () => {
    const deltas = computeRatingDeltas([1400, 1000, 1000, 600], [4, 2, 3, 1]);
    // deltas[0] is the 1400-rated favorite finishing last; deltas[3] is the 600-rated
    // underdog finishing FIRST — both are "surprising" outcomes, both should be large
    // relative to a same-rating same-placement case, but signed opposite.
    expect(deltas[0]!).toBeLessThan(0);
    expect(deltas[3]!).toBeGreaterThan(0);
  });

  it('a higher-rated favorite winning gains less than a lower-rated underdog winning', async () => {
    const favoriteWins = computeRatingDeltas([1400, 1000, 1000, 1000], [1, 2, 3, 4]);
    const underdogWins = computeRatingDeltas([600, 1000, 1000, 1000], [1, 2, 3, 4]);
    expect(favoriteWins[0]!).toBeLessThan(underdogWins[0]!);
  });
});

describe('computeRatingDeltas — squad-aware (design/05/15 squad follow-up)', () => {
  it('omitting teamIds is byte-identical to the original per-seat formula', async () => {
    const ratings = [1400, 1000, 1000, 600];
    const places = [4, 2, 3, 1];
    expect(computeRatingDeltas(ratings, places)).toEqual(
      computeRatingDeltas(ratings, places, ratings.map((_, i) => i)), // singleton teams
    );
  });

  it('every member of a squad gets the identical delta, even with different individual places', async () => {
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
  it('an unknown account starts at DEFAULT_RATING', async () => {
    const store = new RatingStore();
    expect(await store.get('alice')).toBe(DEFAULT_RATING);
  });

  it('applyMatch updates every account and returns before/after for each', async () => {
    const store = new RatingStore();
    const changes = await store.applyMatch(['alice', 'bob', 'carol', 'dave'], [1, 2, 3, 4]);
    expect(changes).toHaveLength(4);
    expect(changes[0]!.accountId).toBe('alice');
    expect(changes[0]!.before).toBe(DEFAULT_RATING);
    expect(changes[0]!.after).toBeGreaterThan(DEFAULT_RATING); // alice won
    expect(await store.get('alice')).toBe(changes[0]!.after); // persisted
    expect(await store.get('dave')).toBeLessThan(DEFAULT_RATING); // dave placed last
  });

  it('ratings compound across multiple matches', async () => {
    const store = new RatingStore();
    await store.applyMatch(['alice', 'bob'], [1, 2]);
    const afterFirst = await store.get('alice');
    await store.applyMatch(['alice', 'bob'], [1, 2]);
    expect(await store.get('alice')).toBeGreaterThan(afterFirst); // won again, rating keeps climbing
  });

  it('applyMatch, given teamIds, applies the same delta to every squadmate', async () => {
    const store = new RatingStore();
    const changes = await store.applyMatch(['alice', 'bob', 'carol', 'dave'], [1, 2, 3, 4], [0, 0, 1, 1]);
    const delta = (c: (typeof changes)[number]) => c.after - c.before;
    expect(delta(changes[0]!)).toBe(delta(changes[1]!)); // alice/bob, same squad
    expect(delta(changes[2]!)).toBe(delta(changes[3]!)); // carol/dave, same squad
    expect(delta(changes[0]!)).toBeGreaterThan(delta(changes[2]!)); // winning squad > losing squad
  });
});

describe('RatingStore — cluster-backed', () => {
  it('persists ratings in the given store, surviving a fresh RatingStore instance', async () => {
    const store = new RatingStore(store_);
    const changes = await store.applyMatch(['alice', 'bob'], [1, 2]);

    // A brand new store over the SAME collections (simulates a restart) sees the same ratings.
    const reopened = new RatingStore(store_);
    expect(await reopened.get('alice')).toBe(changes[0]!.after);
    expect(await reopened.get('bob')).toBe(changes[1]!.after);
  });

  it('a store-backed RatingStore does not leak into an in-memory-only one, and vice versa', async () => {
    const dbStore = new RatingStore(store_);
    const memStore = new RatingStore();
    await dbStore.applyMatch(['alice', 'bob'], [1, 2]);
    expect(await memStore.get('alice')).toBe(DEFAULT_RATING);
  });

  it('a scaffold guest/bot id (seat:{roomId}:{seatIdx}) persists fine, having no account behind it', async () => {
    // Was "despite the FK on accounts" — `ratings` deliberately carried no foreign key so
    // that a bot scaffold could hold a rating. There is no FK anywhere now (see db.ts), so
    // what this pins is narrower and still worth pinning: an id shaped like a scaffold is
    // written and read back like any other.
    const store = new RatingStore(store_);
    await expect(store.applyMatch(['seat:room1:0', 'seat:room1:1'], [1, 2])).resolves.toBeDefined();
    expect(await store.get('seat:room1:0')).toBeGreaterThan(DEFAULT_RATING);
  });
});

describe('computeRatingDeltas — the squad-aware arms nothing else reaches', () => {
  it('gives everyone zero when the whole field is ONE team', async () => {
    // `numTeams <= 1 ? 0.5 : ...`. A four-seat room where every seat shares a squad has no
    // ranking to express, so the actual score is a draw against itself — and the delta must
    // be 0 rather than the K-factor swing an `(numTeams - rank) / (numTeams - 1)` with
    // numTeams === 1 would produce (a division by zero, i.e. NaN ratings written to the DB).
    const deltas = computeRatingDeltas([1200, 1200, 1000, 1400], [1, 1, 1, 1], [7, 7, 7, 7]);
    expect(deltas).toEqual([0, 0, 0, 0]);
    for (const d of deltas) expect(Number.isFinite(d)).toBe(true);
  });

  it('breaks a tie between two teams that share a best place by teamId, deterministically', async () => {
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
    ['cluster', (): RatingStore => new RatingStore(store_)],
  ])('%s: the same reportKey applies ONCE, and the second report moves nothing', async (_label, make) => {
    const store = make();
    const first = await store.applyMatchOnce(KEY, ['alice', 'bob'], [1, 2]);
    expect(first.applied).toBe(true);
    const afterFirst = { alice: await store.get('alice'), bob: await store.get('bob') };
    expect(afterFirst.alice).toBeGreaterThan(DEFAULT_RATING); // the match really was applied

    const second = await store.applyMatchOnce(KEY, ['alice', 'bob'], [1, 2]);
    expect(second.applied).toBe(false);
    // The assertion that matters. `applied: false` with the ratings moved again would be
    // the original defect wearing the new return type.
    expect(await store.get('alice')).toBe(afterFirst.alice);
    expect(await store.get('bob')).toBe(afterFirst.bob);
  });

  it.each([
    ['in-memory', (): RatingStore => new RatingStore()],
    ['cluster', (): RatingStore => new RatingStore(store_)],
  ])('%s: a DIFFERENT reportKey is a different match and applies again', async (_label, make) => {
    // The mirror of the case above, and the one that fails if the key is over-broad (e.g. a
    // roomId-only key against `index.ts`'s legacy dev handshake, where a room id can be
    // reused): a store that refuses every second report is not idempotent, it is broken.
    const store = make();
    await store.applyMatchOnce('room-7:aaaaaaaaaaaaaaaa', ['alice', 'bob'], [1, 2]);
    const afterFirst = await store.get('alice');
    const second = await store.applyMatchOnce('room-8:bbbbbbbbbbbbbbbb', ['alice', 'bob'], [1, 2]);
    expect(second.applied).toBe(true);
    expect(await store.get('alice')).toBeGreaterThan(afterFirst);
  });

  it('returns the same {before, after} changes an unconditional applyMatch would', async () => {
    const once = await new RatingStore().applyMatchOnce(KEY, ['alice', 'bob', 'carol'], [1, 2, 3], [0, 0, 1]);
    const plain = await new RatingStore().applyMatch(['alice', 'bob', 'carol'], [1, 2, 3], [0, 0, 1]);
    expect(once.applied && once.changes).toEqual(plain);
  });

  it('records appliedAt from the injected clock, so an operator can date the claim', async () => {
    await new RatingStore(store_, () => 1_700_000_000_000).applyMatchOnce(KEY, ['alice', 'bob'], [1, 2]);
    const doc = await store_.ratingReports.findOne({});
    expect(doc?._id).toBe(KEY);
    expect(doc?.appliedAt).toBe(1_700_000_000_000);
  });

  it('claims exactly once under CONCURRENT reports of the same key', async () => {
    // Not in the old suite, and it is the assertion the port most needs: `node:sqlite` is
    // synchronous, so two settlements could not interleave and a sequential test was the
    // only one worth writing. Every call is a promise now, so eight simultaneous retries of
    // one at-least-once delivery is a state this code really reaches.
    const store = new RatingStore(store_);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => store.applyMatchOnce('room-race:ffffffffffffffff', ['alice', 'bob'], [1, 2])),
    );
    expect(results.filter((r) => r.applied)).toHaveLength(1);
    expect(await store_.ratingReports.countDocuments({ _id: 'room-race:ffffffffffffffff' })).toBe(1);
  });

  it('leaves applyMatch itself unchanged — an unkeyed apply still compounds', async () => {
    // design/15's contract, and what every pre-8.1 caller and test depends on. If dedupe
    // had been folded INTO `applyMatch`, this would silently become a no-op.
    const store = new RatingStore();
    await store.applyMatch(['alice', 'bob'], [1, 2]);
    const afterFirst = await store.get('alice');
    await store.applyMatch(['alice', 'bob'], [1, 2]);
    expect(await store.get('alice')).toBeGreaterThan(afterFirst);
  });
});

describe('RatingStore.applyMatchOnce — the claim and the ratings are ONE transaction', () => {
  const KEY = 'room-rollback:0000000000000000';

  /**
   * Make the SERVER refuse every write to `ratings`, and undo it.
   *
   * The SQLite version of these two tests installed a `BEFORE INSERT ... RAISE(ABORT)`
   * trigger, and its comment said why: "forced with a real SQLite trigger rather than a
   * mocked driver — the point is that the DATABASE aborts the write the claim is supposed to
   * be tied to". A collection validator that nothing can satisfy is the same instrument. A
   * stubbed collection would test that this code handles an exception; this tests that the
   * transaction really discards a claim when the write beside it is rejected.
   */
  const refuseRatingWrites = (refuse: boolean): Promise<unknown> =>
    ctx.db.command({ collMod: 'ratings', validator: refuse ? { $expr: false } : {} });

  it('cluster: a failed rating write rolls the CLAIM back with it, so a retry can still land', async () => {
    // The failure this protects against is the worse of the two directions: a burned key
    // for a match whose deltas were never written means that match's rating is gone
    // forever, and the next retry is answered "already applied".
    const store = new RatingStore(store_);
    await store_.ratings.insertOne({ _id: '__seed', rating: 1 }); // the collection must exist to collMod it
    await refuseRatingWrites(true);

    await expect(store.applyMatchOnce(KEY, ['alice', 'bob'], [1, 2])).rejects.toThrow();
    expect(await store.get('alice')).toBe(DEFAULT_RATING); // nothing was applied
    expect(await store_.ratingReports.countDocuments()).toBe(0);

    // And now the retry — the whole reason the rollback matters. `routes/rating.ts` answers
    // the throw with a 500, which is the one status `internalFetch` retries.
    await refuseRatingWrites(false);
    const retry = await store.applyMatchOnce(KEY, ['alice', 'bob'], [1, 2]);
    expect(retry.applied).toBe(true);
    expect(await store.get('alice')).toBeGreaterThan(DEFAULT_RATING);
  });

  it('cluster: the client is usable afterwards — no session or transaction left open', async () => {
    // `applyMatchOnce` ends its session in a `finally`. A leaked session is not visible from
    // the outside until the pool runs out, so what this asserts is the observable half: the
    // very next settlement through the same store still works.
    const store = new RatingStore(store_);
    await store_.ratings.insertOne({ _id: '__seed', rating: 1 });
    await refuseRatingWrites(true);
    await expect(store.applyMatchOnce(KEY, ['alice'], [1])).rejects.toThrow();
    await refuseRatingWrites(false);
    await expect(store.applyMatchOnce('another:key000000000000', ['carol', 'dave'], [1, 2])).resolves.toMatchObject({
      applied: true,
    });
    expect(await store.get('carol')).toBeGreaterThan(DEFAULT_RATING);
  });

  it('in-memory: a failed apply restores the cache AND releases the claim', async () => {
    // The no-db backend hand-rolls the transaction, so it gets the same test rather than
    // being trusted. `super.applyMatch` really does write the cache before the throw, which
    // is what makes the restore observable.
    class FlakyStore extends RatingStore {
      fail = true;
      override async applyMatch(
        accountIds: readonly string[],
        places: readonly number[],
        teamIds?: readonly number[],
      ): Promise<RatingChange[]> {
        const changes = await super.applyMatch(accountIds, places, teamIds);
        if (this.fail) throw new Error('boom');
        return changes;
      }
    }
    const store = new FlakyStore();
    await expect(store.applyMatchOnce(KEY, ['alice', 'bob'], [1, 2])).rejects.toThrow(/boom/);
    expect(await store.get('alice')).toBe(DEFAULT_RATING); // rolled back, not left half-applied
    expect(await store.get('bob')).toBe(DEFAULT_RATING);

    store.fail = false;
    expect((await store.applyMatchOnce(KEY, ['alice', 'bob'], [1, 2])).applied).toBe(true);
    expect(await store.get('alice')).toBeGreaterThan(DEFAULT_RATING);
  });

  it('in-memory: a failed apply RESTORES an existing rating rather than clearing it', async () => {
    // The other arm of the same rollback, and the one a fresh store cannot show: these
    // accounts already have a ladder history, so "undo" means putting the previous number
    // back, not deleting the entry and silently resetting them to DEFAULT_RATING.
    class FlakyStore extends RatingStore {
      fail = false;
      override async applyMatch(
        accountIds: readonly string[],
        places: readonly number[],
        teamIds?: readonly number[],
      ): Promise<RatingChange[]> {
        const changes = await super.applyMatch(accountIds, places, teamIds);
        if (this.fail) throw new Error('boom');
        return changes;
      }
    }
    const store = new FlakyStore();
    await store.applyMatch(['alice', 'bob'], [1, 2]); // a prior match, so both have a real rating
    const established = { alice: await store.get('alice'), bob: await store.get('bob') };
    expect(established.alice).not.toBe(DEFAULT_RATING);

    store.fail = true;
    await expect(store.applyMatchOnce(KEY, ['alice', 'bob'], [1, 2])).rejects.toThrow(/boom/);
    expect(await store.get('alice')).toBe(established.alice);
    expect(await store.get('bob')).toBe(established.bob);
  });
});

describe('RatingStore.applyMatchOnce — two settlements racing for one claim', () => {
  const KEY = 'room-race:1111111111111111';

  it('two independent stores over one database: the second loses the claim and applies nothing', async () => {
    // The durable half of "only one wins" — a restarted matchsvc, or a second instance,
    // settling the same at-least-once report. Two `RatingStore`s over the same collections
    // are what that looks like from here.
    const a = new RatingStore(store_);
    const b = new RatingStore(store_);
    expect((await a.applyMatchOnce(KEY, ['alice', 'bob'], [1, 2])).applied).toBe(true);
    const afterA = await a.get('alice');

    expect((await b.applyMatchOnce(KEY, ['alice', 'bob'], [1, 2])).applied).toBe(false);
    expect(await b.get('alice')).toBe(afterA); // b sees a's committed rating, and did not add to it
    expect(await a.get('alice')).toBe(afterA);
  });

  it('two stores settling SIMULTANEOUSLY: exactly one applies, and the ratings move once', async () => {
    // REPLACES a SQLite-only test, rather than porting one.
    //
    // The old suite asserted that a peer holding `BEGIN IMMEDIATE` made the claim THROW
    // ("locked"), on the reasoning that treating a busy database as "already claimed" would
    // silently drop a settlement. That mechanism does not exist here: MongoDB has no
    // database-wide write lock, and a genuine conflict on the claim document surfaces as a
    // transient transaction error that `withTransaction` RETRIES on its own. There is no
    // "locked" to assert and pretending otherwise would be a test of nothing.
    //
    // What survives is the property the old test was ultimately protecting: under real
    // simultaneity the settlement is neither dropped nor applied twice.
    const a = new RatingStore(store_);
    const b = new RatingStore(store_);
    const [ra, rb] = await Promise.all([
      a.applyMatchOnce(KEY, ['alice', 'bob'], [1, 2]),
      b.applyMatchOnce(KEY, ['alice', 'bob'], [1, 2]),
    ]);
    expect([ra.applied, rb.applied].filter(Boolean)).toHaveLength(1);
    const winner = ra.applied ? ra : rb;
    expect(winner.applied && (await a.get('alice'))).toBe(winner.applied && winner.changes[0]!.after);
    expect(await store_.ratingReports.countDocuments({ _id: KEY })).toBe(1);
  });
});
