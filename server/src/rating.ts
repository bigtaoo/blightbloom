/**
 * PvP ladder rating (design/15, ROADMAP 4.6) — matchsvc-side ONLY, computed from
 * checkpoint-verified match placements (design/06/15's anti-cheat backstop, ROADMAP
 * 4.4). This file has NO dependency on `@dd/engine` at all, by construction — the
 * rating is account-level bookkeeping, never engine-replicated state, and must never
 * enter the replay/state hash (design/15's explicit "does NOT touch
 * state.bankedMaterials or any engine-replicated state").
 *
 * A simplified multiplayer Elo (the common FFA/battle-royale MMR shape): each
 * participant's ACTUAL score for the match is their normalized finish placement
 * (1st = 1, last = 0); their EXPECTED score is the logistic comparison of their own
 * rating against the field's average rating — "the field" standing in as one
 * aggregate opponent, the standard generalization of 2-player Elo to N participants.
 * Exact K-factor/starting rating are first-pass constants (design/15 doesn't lock
 * ladder tuning), not a tuned production curve.
 *
 * Squad-aware (design/05/15's squad follow-up, ROADMAP 4.6 — the one item design/15
 * flagged as "deliberately not done"): design/15 notes squadmates land at *adjacent*,
 * not tied, individual `places` (`ladderReport.ts`'s per-seat elimination order), which
 * would otherwise reward/punish teammates of the same squad by different amounts for
 * the exact same team result. When `teamIds` is passed, a team's ACTUAL score comes
 * from its TEAM rank (best member's place decides the team's rank among teams, so
 * every member of a squad shares one actual score) and its EXPECTED score compares the
 * team's AVERAGE rating (not each member's own) against the field average — every
 * squad member gets the same delta, as if the squad were one combined participant.
 * Omitting `teamIds` (every pre-squad caller) defaults each index to its own singleton
 * team, which degenerates the math back to the original per-seat formula exactly.
 */
import type { ClientSession } from 'mongodb';
import type { AccountsStore } from './db';

export const K_FACTOR = 32;
export const DEFAULT_RATING = 1000;

/**
 * Given each participant's CURRENT rating and 1-based finish place (1 = best, N =
 * worst — ties aren't modeled, matching design/15's same-tick placement tiebreak
 * already producing a total order with no draws), return the rating DELTA to apply
 * to each (same index order as `ratings`/`places`). `teamIds` (optional, index-aligned)
 * groups participants into squads — see the file doc comment above.
 */
export function computeRatingDeltas(
  ratings: readonly number[],
  places: readonly number[],
  teamIds?: readonly number[],
): number[] {
  const n = ratings.length;
  if (n <= 1) return ratings.map(() => 0); // nothing to compare against — no-op match
  const avgRating = ratings.reduce((a, b) => a + b, 0) / n;

  const teams = teamIds ?? ratings.map((_, i) => i); // default: every participant its own team of 1
  const byTeam = new Map<number, number[]>(); // teamId -> participant indices
  teams.forEach((teamId, i) => {
    const indices = byTeam.get(teamId);
    if (indices) indices.push(i);
    else byTeam.set(teamId, [i]);
  });

  // Team rank (1 = best) from its best (lowest) member place; a stable teamId tiebreak
  // covers the structurally-impossible case of overlapping team place ranges.
  const teamOrder = [...byTeam.entries()]
    .map(([teamId, indices]) => ({
      teamId,
      indices,
      minPlace: Math.min(...indices.map((i) => places[i]!)),
      avgRating: indices.reduce((a, i) => a + ratings[i]!, 0) / indices.length,
    }))
    .sort((a, b) => a.minPlace - b.minPlace || a.teamId - b.teamId);
  const numTeams = teamOrder.length;
  const rankByTeam = new Map(teamOrder.map((t, rank) => [t.teamId, rank + 1]));
  const ratingByTeam = new Map(teamOrder.map((t) => [t.teamId, t.avgRating]));

  return ratings.map((_, i) => {
    const teamId = teams[i]!;
    const rank = rankByTeam.get(teamId)!;
    const actual = numTeams <= 1 ? 0.5 : (numTeams - rank) / (numTeams - 1); // 1st team → 1, last team → 0
    const teamRating = ratingByTeam.get(teamId)!;
    const expected = 1 / (1 + Math.pow(10, (avgRating - teamRating) / 400));
    return Math.round(K_FACTOR * (actual - expected));
  });
}

export interface RatingChange {
  accountId: string;
  before: number;
  after: number;
}

/**
 * The outcome of an exactly-once apply. A union rather than `{applied, changes}` with an
 * empty array, so a caller cannot read the deltas without first asking whether they
 * happened — the whole failure this shape exists to prevent is a duplicate report being
 * reported back as a successful one.
 */
export type ApplyMatchOnceResult =
  | { applied: true; changes: RatingChange[] }
  /** The claim was LOST: this exact report has already moved these ratings. */
  | { applied: false };

/**
 * Ladder store, keyed by an opaque `accountId` string; this module doesn't define
 * what an account IS — a guest/bot's scaffold `seat:{roomId}:{seatIdx}` id (see
 * ladderReport.ts) works exactly like a real one, it just resets every restart.
 *
 * Persists to db.ts's `ratings` collection when an `AccountsStore` is passed in (design/16
 * added that store for exactly this — matchsvc.ts wires its own connection through), so a
 * real player's rating survives a restart the same way their account/blueprints already do.
 * Falls back to an in-memory `Map` when constructed with no store (every existing test,
 * plus any future caller that wants a scratch store) — same value, same shape, just not
 * durable.
 *
 * `applyMatchOnce` is the exactly-once entry point (design/19 §3, closing ROADMAP 8.1's one
 * open item) and the one every real report goes through; `applyMatch` stays what design/15
 * defined — an unconditional apply, with no opinion about whether it has run before.
 */
export class RatingStore {
  private readonly cache = new Map<string, number>();
  /** The no-store backend's `ratingReports` (see `applyMatchOnce`). */
  private readonly claimed = new Set<string>();

  constructor(
    private readonly store?: AccountsStore,
    /** Injected only so a test can pin `ratingReports.appliedAt`; production wants the clock. */
    private readonly nowMs: () => number = () => Date.now(),
  ) {}

  async get(accountId: string, session?: ClientSession): Promise<number> {
    if (this.store) {
      const row = await this.store.ratings.findOne({ _id: accountId }, { session });
      return row?.rating ?? DEFAULT_RATING;
    }
    return this.cache.get(accountId) ?? DEFAULT_RATING;
  }

  /**
   * Apply one verified match's placements; returns every account's {before, after}.
   * `teamIds` (optional, index-aligned with `accountIds`/`places`) makes the rating
   * squad-aware — see `computeRatingDeltas`'s doc comment.
   *
   * `session` is threaded through rather than read from a field because `applyMatchOnce`
   * calls this from INSIDE its transaction: a write that omits the session silently lands
   * outside it and survives the rollback, which is the one failure the claim exists to
   * prevent.
   */
  async applyMatch(
    accountIds: readonly string[],
    places: readonly number[],
    teamIds?: readonly number[],
    session?: ClientSession,
  ): Promise<RatingChange[]> {
    const before: number[] = [];
    for (const id of accountIds) before.push(await this.get(id, session));
    const deltas = computeRatingDeltas(before, places, teamIds);
    const changes: RatingChange[] = [];
    for (const [i, accountId] of accountIds.entries()) {
      const b = before[i]!;
      const after = b + deltas[i]!;
      if (this.store) {
        await this.store.ratings.updateOne({ _id: accountId }, { $set: { rating: after } }, { upsert: true, session });
      } else {
        this.cache.set(accountId, after);
      }
      changes.push({ accountId, before: b, after });
    }
    return changes;
  }

  /**
   * Apply one verified match AT MOST ONCE, keyed by `reportKey` (`ladderReport.ts`'s
   * `{roomId}:{digest}`) — design/19 §3, closing the one thing ROADMAP 8.1 left open.
   *
   * `POST /rating/report` is an at-least-once delivery: 8.1 gave `reportSettledMatch` a
   * retry budget, so a report that was DELIVERED and lost only its response comes back, and
   * before this method existed it was applied a second time. That is not a theoretical race
   * — it is what a 5xx written after the write, or a timeout on a slow response, does.
   *
   * IDEMPOTENCY IS A CLAIM, NEVER A LOOK-BEFORE-WRITE, and the claim is in the SAME
   * transaction as the ratings it guards. `INSERT ... ON CONFLICT DO NOTHING` then
   * `changes()` — the shape design/19 §4 specifies for billing delivery — because
   * SELECT-then-INSERT answers the question before holding the lock that would make the
   * answer true. Two directions matter equally and are tested separately:
   *
   *  - LOSE the claim ⇒ apply nothing. Otherwise the retry double-credits.
   *  - WIN the claim and then FAIL ⇒ the claim rolls back with the ratings. Otherwise the
   *    key is burned for a match whose deltas were never written, and that match's rating
   *    is gone permanently — strictly worse than double-crediting, which is at least
   *    visible and reversible.
   *
   * Throws whatever the write threw, after rolling back. The caller (`routes/rating.ts`)
   * turns that into a 5xx precisely so the retry ladder gets to try again.
   *
   * THE CALLBACK MUST BE SAFE TO RUN TWICE. `withTransaction` re-runs its body on a
   * transient transaction error, which is a shape `BEGIN IMMEDIATE` never had. Two
   * consequences are designed for rather than discovered:
   *
   *  - `appliedAt` is read from the clock ONCE, out here, so a retried attempt claims the
   *    same instant it would have claimed the first time.
   *  - `outcome` is assigned fresh at the top of every attempt. A `let` that accumulated
   *    across attempts would let a losing first attempt decide a winning second one.
   *
   * The retry itself is harmless because the previous attempt's writes were rolled back:
   * the claim is unclaimed again, so it is re-won rather than seen as somebody else's.
   */
  async applyMatchOnce(
    reportKey: string,
    accountIds: readonly string[],
    places: readonly number[],
    teamIds?: readonly number[],
  ): Promise<ApplyMatchOnceResult> {
    const store = this.store;
    if (!store) return this.applyMatchOnceInMemory(reportKey, accountIds, places, teamIds);

    const appliedAt = this.nowMs();
    const session = store.client.startSession();
    try {
      let outcome: ApplyMatchOnceResult = { applied: false };
      await session.withTransaction(async () => {
        outcome = { applied: false };
        // THE CLAIM, and it is the transaction's first statement on purpose. `upsertedCount`
        // is the whole mechanism — a find followed by an insert would answer the question
        // before holding the lock that would make the answer true (design/19 §4 AMENDMENT 2).
        const claim = await store.ratingReports.updateOne(
          { _id: reportKey },
          { $setOnInsert: { appliedAt } },
          { upsert: true, session },
        );
        if (claim.upsertedCount !== 1) {
          // Nothing to commit — and unlike billsvc's `settle`, losing this claim raises no
          // follow-up question (there is no second account whose report this could be), so
          // the transaction simply ends having written nothing.
          return;
        }
        outcome = { applied: true, changes: await this.applyMatch(accountIds, places, teamIds, session) };
      });
      return outcome;
    } finally {
      await session.endSession();
    }
  }

  /**
   * The no-db backend's `applyMatchOnce`. A `Set` is the claim table and a snapshot of the
   * touched keys is the transaction — hand-rolled so the two backends answer identically,
   * including the rollback. Worth the eight lines: every RatingStore test that does not
   * specifically want the cluster runs on this path, so a memory store that "deduped" but left a
   * half-applied match behind would make those tests agree with a store that cannot happen.
   */
  private async applyMatchOnceInMemory(
    reportKey: string,
    accountIds: readonly string[],
    places: readonly number[],
    teamIds?: readonly number[],
  ): Promise<ApplyMatchOnceResult> {
    if (this.claimed.has(reportKey)) return { applied: false };
    this.claimed.add(reportKey);
    const snapshot = accountIds.map((id) => [id, this.cache.get(id)] as const);
    try {
      return { applied: true, changes: await this.applyMatch(accountIds, places, teamIds) };
    } catch (e) {
      this.claimed.delete(reportKey);
      for (const [id, prior] of snapshot) {
        if (prior === undefined) this.cache.delete(id);
        else this.cache.set(id, prior);
      }
      throw e;
    }
  }
}
