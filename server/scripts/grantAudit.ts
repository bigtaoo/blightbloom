/**
 * The daily non-`purchase` entitlement audit, as a CLI (design/19 §7, ROADMAP 8.5).
 *
 *   npm run audit:grants -w server -- [--day=2026-09-04] [--days=1] [--threshold=3] [--dry-run]
 *
 * TWO DATABASES, OPENED DIFFERENTLY ON PURPOSE:
 *
 *   the ACCOUNT file (`BB_DB_PATH`)      opened READ-ONLY. `entitlements` is the table this
 *                                         audit is judging, and the whole posture is that it
 *                                         observes and files — so it must not hold a
 *                                         connection that could change what it is looking at.
 *                                         SQLite enforces that; a comment would not.
 *   the BILLING file (`BB_BILLING_DB_PATH`) opened read-write, for `review_queue` alone.
 *
 * design/19 §7 rules out an admin service, so this is a script rather than a route — and it is
 * deliberately NOT mounted on matchsvc, which is a parallel workstream's file. All the logic is
 * in `src/grantAudit.ts`, which is pure and tested; this is argument parsing and printing.
 *
 * ═══ FILES, NEVER ACTS ═══ Nothing below revokes, suspends or flags anything. It writes rows
 * to a queue a human works. Re-running it over a day that was already filed produces nothing,
 * because `(accountId, dayKey)` is the queue's idempotency key — an audit an operator is
 * afraid to re-run is an audit that stops being run.
 */
import { DatabaseSync } from 'node:sqlite';
import { openBillingDb } from '../src/billingDb';
import { defaultDbPath } from '../src/db';
import {
  DEFAULT_GRANT_THRESHOLD,
  auditGrants,
  dayKeyOf,
  dayWindow,
  fileGrantAnomalies,
  formatFinding,
  readGrantsInWindow,
} from '../src/grantAudit';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const [k, v] = a.slice(2).split('=');
      return [k, v ?? 'true'];
    }),
);

const threshold = Number(args.threshold ?? process.env.BB_GRANT_AUDIT_THRESHOLD ?? DEFAULT_GRANT_THRESHOLD);
if (!Number.isInteger(threshold) || threshold < 0) throw new Error(`--threshold must be a non-negative integer`);

const days = Number(args.days ?? 1);
if (!Number.isInteger(days) || days < 1) throw new Error(`--days must be a positive integer`);

// Default window: the `days` whole UTC days ending at the last UTC midnight. TODAY IS EXCLUDED
// — a partial day would be re-audited tomorrow with more rows in it, and the second run would
// find nothing to file because the first one already claimed `(account, day)`. Auditing only
// complete days is what makes the idempotency key safe to have.
const endDayKey = dayKeyOf(Date.now() - 86_400_000);
const first = args.day ?? dayKeyOf(dayWindow(endDayKey).sinceMs - (days - 1) * 86_400_000);
const sinceMs = dayWindow(first).sinceMs;
const untilMs = args.day ? dayWindow(args.day).untilMs : dayWindow(endDayKey).untilMs;

const accounts = new DatabaseSync(process.env.BB_DB_PATH ?? defaultDbPath(), { readOnly: true });
const billing = openBillingDb();
try {
  const rows = readGrantsInWindow(accounts, sinceMs, untilMs);
  const findings = auditGrants(rows, { threshold });
  console.log(
    `grant audit ${new Date(sinceMs).toISOString().slice(0, 10)} .. ${new Date(untilMs - 1).toISOString().slice(0, 10)}: ` +
      `${rows.length} entitlement row(s) read, ${findings.length} account-day(s) over threshold ${threshold}`,
  );
  for (const f of findings) console.log(`  ${formatFinding(f)}`);
  if (args['dry-run'] === 'true') {
    console.log('  --dry-run: nothing filed');
  } else {
    const filed = fileGrantAnomalies(billing, findings, Date.now());
    console.log(`  filed ${filed} new review entr(y|ies); ${findings.length - filed} already on the queue`);
  }
} finally {
  accounts.close();
  billing.close();
}
