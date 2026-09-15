/**
 * The daily non-`purchase` entitlement audit (design/19-server-platform.md §7, ROADMAP 8.5).
 * A module of free functions, CLAUDE.md's first split form.
 *
 * WHY IT IS A STANDALONE MODULE AND NOT A ROUTE. design/19 §7 ends with "No admin service.
 * funny has a whole one. Here the requirement is weaker but real: the schema must be
 * queryable and hand-correctable by a human with SQL." So there is no admin surface to hang
 * this off, and adding one to the control plane to hold a cron job would be building exactly
 * the thing that section declines. This module plus `server/scripts/grantAudit.ts` is the
 * whole thing: the script opens the account database READ-ONLY, the module decides, and the
 * findings go to `billsvc`'s review queue.
 *
 * WHAT IT COUNTS. `entitlements.source` (design/19 §2, `db.ts`) is one of `purchase`, `grant`,
 * `event`, `starter`, `drop`. Everything except `purchase` is a thing an account received
 * without money moving, and a burst of them in one day is the shape of a support tool being
 * abused, a campaign misconfigured, or a bug granting in a loop. `purchase` is excluded
 * because the money IS the evidence, and it already has an audit trail on the billing side.
 *
 * ═══ WITH NO EVIDENCE, SKIP — NEVER CONVICT ═══
 *
 * design/19 §7 states this principle for exactly this audit and points at where it already
 * holds: `design/15-pvp-arena.md`'s checkpoint quorum. That mechanism runs no consensus check
 * at all below a quorum of real seats (an early low-population match is EXPECTED to be
 * internally inconsistent, and a majority of three means nothing), and severs a seat only on
 * a CONSECUTIVE run of mismatches — never on one stray report, which is more likely a benign
 * catch-up race. Both halves carry over literally:
 *
 *   - No inference from absence. A row whose `source` is not one this audit counts is SKIPPED,
 *     not counted. An account with no rows produces no finding. There is no "suspiciously
 *     few", no "unusual pattern", nothing derived from what is missing.
 *   - Exactly at the threshold is NOT an anomaly. The comparison is `count > threshold`, and
 *     that is a decision rather than an off-by-one: the threshold is the largest count anyone
 *     has said is fine, so a count equal to it is a case somebody already accepted.
 *   - It FILES, it does not act. The output is `review_queue` rows. Nothing here revokes,
 *     suspends, or flags an account to any other system. `EntitlementService.revoke` exists so
 *     that a HUMAN's correction is a supported operation, and is called by nothing in this
 *     server — deliberately, and this module is the closest thing to a caller it will have.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { AccountsStore } from './db';
import { fileReview, grantAnomalyId } from './billsvc/reviewQueue';

/**
 * The sources counted by default: every one that is not `purchase`.
 *
 * Kept as an explicit list rather than "anything !== 'purchase'" so that adding a source to
 * `db.ts`'s CHECK constraint does not silently change what this audit convicts on — a new
 * source arrives uncounted, and whoever adds it decides.
 *
 * A note for the day a starter pack ships: `starter` is a new-account gift, so an account
 * created with more than `threshold` of them would trip this every time. That is not a reason
 * to weaken the threshold — it is a reason to pass `countedSources` without `'starter'` at
 * that point. Nothing grants `starter` today.
 */
export const DEFAULT_COUNTED_SOURCES: readonly string[] = ['grant', 'event', 'starter', 'drop'];

/**
 * The largest number of counted grants an account may receive in one UTC day without being
 * filed. Provisional in the same way `skus.ts`'s prices are — no number is decided anywhere
 * in design/19 — and chosen to be small enough that a looping bug is caught on its first day.
 */
export const DEFAULT_GRANT_THRESHOLD = 3;

/** One `entitlements` row, as much of it as this audit reads. */
export interface GrantRow {
  accountId: string;
  sku: string;
  source: string;
  grantedAt: number;
}

export interface GrantAuditOptions {
  /** `count > threshold` files. Equal to it does not. Defaults to `DEFAULT_GRANT_THRESHOLD`. */
  threshold?: number;
  countedSources?: readonly string[];
}

export interface GrantAnomalyFinding {
  accountId: string;
  /** `YYYY-MM-DD`, UTC. Half of the idempotency key. */
  dayKey: string;
  count: number;
  threshold: number;
  /** How the count breaks down, so a reviewer can tell a campaign from a support burst. */
  bySource: Record<string, number>;
  /** The SKUs involved, in the order they were granted. The evidence, such as it is. */
  skus: string[];
  /** First and last grant in the day, ms epoch — a loop and a day's drip look different. */
  firstAt: number;
  lastAt: number;
}

/**
 * `YYYY-MM-DD` in UTC.
 *
 * UTC and not a local or Beijing day, and the reason is idempotency rather than correctness:
 * `(accountId, dayKey)` is the review queue's key, so the day boundary has to be the same on
 * every machine that ever re-runs the audit. A local-time key would file a second row for the
 * same grants the first time the job runs from a differently-configured box.
 */
export function dayKeyOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The inverse: the half-open `[since, until)` window covering one `YYYY-MM-DD` UTC day. */
export function dayWindow(dayKey: string): { sinceMs: number; untilMs: number } {
  const sinceMs = Date.parse(`${dayKey}T00:00:00.000Z`);
  if (Number.isNaN(sinceMs)) throw new Error(`not a YYYY-MM-DD day key: '${dayKey}'`);
  return { sinceMs, untilMs: sinceMs + 86_400_000 };
}

/**
 * THE PURE CORE. Rows in, findings out — no database, no clock, no queue. Groups by
 * `(accountId, dayKey)` rather than taking a single day, so one call can audit a backfill
 * window and produce one finding per account per day, each with its own idempotency key.
 *
 * Findings come back ordered by `dayKey` then `accountId`: the caller writes them to a table
 * keyed on exactly that pair, and a deterministic order makes a re-run's log diffable.
 */
export function auditGrants(rows: readonly GrantRow[], opts: GrantAuditOptions = {}): GrantAnomalyFinding[] {
  const threshold = opts.threshold ?? DEFAULT_GRANT_THRESHOLD;
  const counted = new Set(opts.countedSources ?? DEFAULT_COUNTED_SOURCES);
  const groups = new Map<string, GrantAnomalyFinding>();

  for (const row of rows) {
    // SKIP, do not count. A `purchase` has money behind it, and a source this audit was not
    // told to count is one nobody has decided about — neither is evidence of anything.
    if (!counted.has(row.source)) continue;
    const dayKey = dayKeyOf(row.grantedAt);
    // A NUL separator, written as an escape: it is the one character that cannot appear in
    // either half, so no account id can be crafted to collide with another day.
    const key = `${dayKey}\u0000${row.accountId}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        accountId: row.accountId,
        dayKey,
        count: 0,
        threshold,
        bySource: {},
        skus: [],
        firstAt: row.grantedAt,
        lastAt: row.grantedAt,
      };
      groups.set(key, group);
    }
    group.count += 1;
    group.bySource[row.source] = (group.bySource[row.source] ?? 0) + 1;
    group.skus.push(row.sku);
    // Not assuming the input is sorted: `readGrantsInWindow` orders by `granted_at`, but this
    // function is pure and its contract must not depend on a caller it cannot see.
    if (row.grantedAt < group.firstAt) group.firstAt = row.grantedAt;
    if (row.grantedAt > group.lastAt) group.lastAt = row.grantedAt;
  }

  return [...groups.values()]
    .filter((g) => g.count > threshold) // `>`, never `>=`. See the header.
    .sort((a, b) => (a.dayKey < b.dayKey ? -1 : a.dayKey > b.dayKey ? 1 : a.accountId < b.accountId ? -1 : 1));
}

/**
 * Read the account plane's `entitlements` documents in `[sinceMs, untilMs)`.
 *
 * Takes the store rather than opening one, so the caller decides how the connection is made.
 * The caller that matters (`server/scripts/grantAudit.ts`) used to open the SQLite file
 * READ-ONLY, and that was not a nicety: the audit's whole posture is that it observes and
 * files, so it should not hold a handle that could write to the table it is judging.
 *
 * THAT GUARANTEE IS WEAKER NOW. `readOnly: true` was enforced by SQLite itself — a
 * capability the process did not hold. Its replacement is an Atlas ROLE on a separate
 * database user, which lives in the cluster's configuration rather than in this repository,
 * so nothing a code review can see keeps this script from writing. Run it as a user with
 * `read` on the `accounts` database; see `mongo.ts`'s header.
 *
 * Sorted by `grantedAt` then `_id` — the ObjectId tiebreak stands in for the old `id ASC`,
 * which mattered because a settled multi-SKU order mints several grants in one millisecond.
 */
export async function readGrantsInWindow(
  store: AccountsStore,
  sinceMs: number,
  untilMs: number,
): Promise<GrantRow[]> {
  const docs = await store.entitlements
    .find({ grantedAt: { $gte: sinceMs, $lt: untilMs } })
    .sort({ grantedAt: 1, _id: 1 })
    .toArray();
  return docs.map((d) => ({ accountId: d.accountId, sku: d.sku, source: d.source, grantedAt: d.grantedAt }));
}

/** One line per finding, for the cron log. */
export function formatFinding(f: GrantAnomalyFinding): string {
  const sources = Object.entries(f.bySource)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([source, n]) => `${source}×${n}`)
    .join(', ');
  return (
    `account '${f.accountId}' received ${f.count} non-purchase entitlement(s) on ${f.dayKey} ` +
    `(threshold ${f.threshold}; ${sources}) — filed for review, nothing revoked`
  );
}

/**
 * File findings into `billsvc`'s review queue. Returns how many rows were NEW.
 *
 * A control-plane concern writing into the billing plane's file, on purpose: that file is the
 * one an operator already opens when money is the question, the delivery pump's
 * "money-taken-nothing-granted" entries land in the same table, and a second queue in the
 * account database would mean a human has to know which of two places to look
 * (`billingDb.ts` says the same from the other side).
 *
 * `(accountId, dayKey)` is the key, via `grantAnomalyId`, so re-running the audit over a day
 * that was already filed produces NOTHING — not a duplicate, not a reopened row, not a
 * refreshed timestamp. An audit an operator is afraid to re-run is an audit that stops being
 * run.
 */
export function fileGrantAnomalies(reviewDb: DatabaseSync, findings: readonly GrantAnomalyFinding[], ts: number): number {
  let filed = 0;
  for (const f of findings) {
    const isNew = fileReview(reviewDb, grantAnomalyId(f.accountId, f.dayKey), {
      kind: 'grant-anomaly',
      accountId: f.accountId,
      dayKey: f.dayKey,
      summary: formatFinding(f),
      evidence: f,
      ts,
    });
    if (isNew) filed += 1;
  }
  return filed;
}
