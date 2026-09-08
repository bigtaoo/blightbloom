/**
 * Daily reconciliation, as a CLI (design/19-server-platform.md §7, ROADMAP 8.5).
 *
 *   npm run reconcile -w server -- [--days=1] [--platforms=dev,stripe] [--strict]
 *
 * A script and not a route, because design/19 §7 ends with "No admin service" and adding one
 * to the control plane to hold a cron job would be building exactly the thing that section
 * declines. All the logic is in `src/billsvc/reconcile.ts`, which is pure and tested; this
 * file is argument parsing, wiring and printing, and lives under `scripts/` where neither the
 * coverage gate nor the file-length check reaches — deliberately, because there is nothing
 * here worth asserting that is not already asserted next to the logic.
 *
 * WHAT IT CAN ACTUALLY VERIFY TODAY, said plainly. No merchant account exists on Apple,
 * Google, WeChat or Stripe (design/19 §9), so those four ports return not-implemented and land
 * in `unreconciled`. The run then prints INCOMPLETE, which is the honest answer and not a
 * failure of this script. The `dev` platform is the one that can genuinely reconcile, against
 * the order book named by `BB_BILLING_DEV_ORDERS` — a JSON array of `PlatformOrder`, authored
 * rather than derived from the local tables, which is what makes a difference it reports mean
 * something.
 *
 * Environment: `BB_BILLING_DB_PATH` (the billing file), `BB_BILLING_DEV_STUB` (must be on for
 * the dev platform to answer at all), `BB_BILLING_DEV_ORDERS` (path to the dev order book).
 */
import { readFileSync } from 'node:fs';
import { openBillingDb } from '../src/billingDb';
import { createPlatformOrderLister } from '../src/billsvc/iap/factory';
import { DevStubOrderBook } from '../src/billsvc/iap/devStub';
import {
  dailyWindow,
  formatReconcileReport,
  parsePlatformList,
  reconcileWindow,
} from '../src/billsvc/reconcile';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const [k, v] = a.slice(2).split('=');
      return [k, v ?? 'true'];
    }),
);

const days = Number(args.days ?? 1);
if (!Number.isInteger(days) || days < 1) throw new Error(`--days must be a positive integer, got '${args.days}'`);

const bookPath = process.env.BB_BILLING_DEV_ORDERS;
const book = bookPath ? DevStubOrderBook.fromJson(readFileSync(bookPath, 'utf8')) : undefined;

const db = openBillingDb();
try {
  const { sinceMs, untilMs } = dailyWindow(Date.now(), days);
  const report = await reconcileWindow(
    { db, listOrders: createPlatformOrderLister(process.env, book), platforms: parsePlatformList(args.platforms) },
    sinceMs,
    untilMs,
  );
  for (const line of formatReconcileReport(report)) console.log(line);

  // Exit 0 by default even when the report is INCOMPLETE. Four of the five platforms cannot be
  // asked and will not be until a merchant account exists, so a non-zero exit would be the
  // permanent state and a cron mail nobody reads. `--strict` is for the day that changes.
  if (args.strict === 'true' && (!report.complete || report.differenceCount > 0)) process.exitCode = 1;
} finally {
  // Windows keeps a lock on an unclosed SQLite file; the test suite found that the hard way.
  db.close();
}
