/**
 * The daily non-`purchase` entitlement audit, as a CLI (design/19 §7, ROADMAP 8.5).
 *
 *   npm run audit:grants -w server -- [--day=2026-09-04] [--days=1] [--threshold=3] [--dry-run]
 *
 * TWO LOGICAL DATABASES, ONE CLUSTER, AND ONE POSTURE THAT LOST ITS ENFORCEMENT:
 *
 *   the ACCOUNTS store   `entitlements` is the collection this audit is JUDGING, and the whole
 *                        posture is that it observes and files — it must not change what it is
 *                        looking at. That used to be a capability the process did not hold
 *                        (`new DatabaseSync(path, { readOnly: true })`, enforced by SQLite).
 *                        One client reaching one cluster cannot hold half a handle, so it is a
 *                        convention here now: nothing below writes to `accounts`, and the
 *                        enforcement that remains is the Atlas role this script's credential
 *                        carries. Stated rather than assumed, because the difference between
 *                        "SQLite refuses the write" and "this file does not attempt one" is
 *                        the whole distance between a guarantee and a habit.
 *   the BILLING store    the `billing` logical database, read-write, for `reviewQueue` alone.
 *                        Money keeps its own database (design/19 §4) — a separate database on
 *                        the cluster, not a separate cluster, which is what makes it one
 *                        connection.
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
import { ensureBillingIndexes } from '../src/billingDb';
import { accountsStore } from '../src/db';
import { closeMongo, connectMongo, store } from '../src/mongo';
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

await connectMongo();
const accounts = accountsStore(store('accounts'));
const billing = store('billing');
await ensureBillingIndexes(billing);
try {
  const rows = await readGrantsInWindow(accounts, sinceMs, untilMs);
  const findings = auditGrants(rows, { threshold });
  console.log(
    `grant audit ${new Date(sinceMs).toISOString().slice(0, 10)} .. ${new Date(untilMs - 1).toISOString().slice(0, 10)}: ` +
      `${rows.length} entitlement row(s) read, ${findings.length} account-day(s) over threshold ${threshold}`,
  );
  for (const f of findings) console.log(`  ${formatFinding(f)}`);
  if (args['dry-run'] === 'true') {
    console.log('  --dry-run: nothing filed');
  } else {
    const filed = await fileGrantAnomalies(billing, findings, Date.now());
    console.log(`  filed ${filed} new review entr(y|ies); ${findings.length - filed} already on the queue`);
  }
} finally {
  await closeMongo();
}
