/**
 * Seeds a throwaway set of databases so the ops console can be LOOKED AT
 * (design/21 §3, and §2.5's rule that an instrument has to be shown to see the change).
 *
 * Not a fixture and not a test helper — a developer tool, in `scripts/` beside `reconcile.ts`
 * and `grantAudit.ts`. It writes through this repo's own openers so every schema is the
 * shipped one, and it fills each of the three sections with the states that are interesting
 * to look at rather than the states a fresh box has: an account with entitlements and one
 * without, an open review-queue item and a reviewed one, a webhook row with divergences, and
 * a rollup history deep enough that the cohort grid contains a measured rate, a measured zero
 * and an unknown at the same time.
 *
 *   npx tsx scripts/seedOpsDemo.ts <dir>
 *   BB_DB_PATH=<dir>/accounts.db BB_BILLING_DB_PATH=<dir>/billing.db \
 *   BB_ANALYTICS_DB_PATH=<dir>/analytics.db BB_OPS_DB_PATH=<dir>/ops.db \
 *   BB_ADMIN_PASSWORD=... BB_ADMIN_INSECURE_COOKIE=1 npm run adminsvc -w server
 *
 * `BB_ADMIN_INSECURE_COOKIE=1` is required to sign in over plain http, which is what that
 * flag exists for — the session cookie is `Secure` otherwise and a browser will not send it
 * back to `http://localhost`. The startup guard refuses the flag under
 * `NODE_ENV=production`.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../src/db';
import { openBillingDb } from '../src/billingDb';
import { openAnalyticsDb } from '../src/analytics/db';
import { addDays, persistRollup } from '../src/analytics/rollup';
import { openOpsDb, setFlag } from '../src/flags/store';

const dir = process.argv[2];
if (dir === undefined || dir.length === 0) {
  console.error('usage: npx tsx scripts/seedOpsDemo.ts <dir>');
  process.exit(2);
}
mkdirSync(dir, { recursive: true });

const NOW = Date.UTC(2026, 8, 9, 12, 0, 0);
const DAY0 = '2026-09-01';

// ── accounts.db: two local players, one portal account, ratings and entitlements ──
const accounts = openDb(join(dir, 'accounts.db'));
const addAccount = accounts.prepare(
  `INSERT OR REPLACE INTO accounts (id, username, password_hash, provider, provider_id, created_at, display_name)
   VALUES (?,?,?,?,?,?,?)`,
);
addAccount.run('acc_zoe', 'zoe', 'x', 'local', null, Date.UTC(2026, 7, 20), null);
addAccount.run('acc_quiet', 'quiet_one', 'x', 'local', null, Date.UTC(2026, 8, 1), null);
addAccount.run('acc_cg', 'cg:11223344', 'x', 'cg', '11223344', Date.UTC(2026, 8, 7), 'Zoë from the portal');
const addRating = accounts.prepare('INSERT OR REPLACE INTO ratings (account_id, rating) VALUES (?,?)');
addRating.run('acc_zoe', 1184);
addRating.run('acc_cg', 998);
const addEnt = accounts.prepare(
  `INSERT OR REPLACE INTO entitlements (account_id, sku, source, order_id, granted_at) VALUES (?,?,?,?,?)`,
);
addEnt.run('acc_zoe', 'blueprint:cannon', 'purchase', 'ord_1', Date.UTC(2026, 8, 5));
addEnt.run('acc_zoe', 'character:scout', 'grant', null, Date.UTC(2026, 8, 6));
accounts.close();

// ── billing.db: an open finding, a reviewed one, and three callbacks incl. a divergent one ──
const billing = openBillingDb(join(dir, 'billing.db'));
const addReview = billing.prepare(
  `INSERT OR REPLACE INTO review_queue (id, kind, account_id, day_key, summary, evidence_json, state, created_at, reviewed_at, note)
   VALUES (?,?,?,?,?,?,?,?,?,?)`,
);
addReview.run(
  'money-taken-nothing-granted:del_7',
  'money-taken-nothing-granted',
  'acc_cg',
  null,
  'settled purchase the control plane refused',
  '{"deliveryId":"del_7","attempts":9,"lastStatus":404}',
  'open',
  Date.UTC(2026, 8, 8, 3, 12),
  null,
  null,
);
addReview.run(
  'grant-anomaly:acc_zoe:2026-09-06',
  'grant-anomaly',
  'acc_zoe',
  '2026-09-06',
  '9 non-purchase grants in one day',
  '{"count":9,"threshold":5}',
  'reviewed',
  Date.UTC(2026, 8, 6, 23, 0),
  Date.UTC(2026, 8, 7, 9, 30),
  'launch event reward, expected',
);
const addHook = billing.prepare(
  `INSERT OR REPLACE INTO webhook_events (id, platform, order_id, txn_id, event_type, outcome, detail, raw,
     first_seen_at, last_seen_at, seen_count, divergences) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
);
addHook.run(
  'txn_a1:transaction.completed',
  'paddle',
  'ord_1',
  'txn_a1',
  'transaction.completed',
  'settled',
  null,
  '{"event_type":"transaction.completed","data":{"id":"txn_a1","items":[{"price":{"product_id":"bp.cannon"}}]}}',
  Date.UTC(2026, 8, 5, 10, 0),
  Date.UTC(2026, 8, 5, 10, 0, 12),
  2,
  0,
);
addHook.run(
  'txn_b2:transaction.completed',
  'paddle',
  null,
  'txn_b2',
  'transaction.completed',
  'rejected',
  'signature mismatch',
  '{"event_type":"transaction.completed","data":{"id":"txn_b2","amount":"0.01"}}',
  Date.UTC(2026, 8, 8, 4, 0),
  Date.UTC(2026, 8, 8, 6, 30),
  5,
  3,
);
// The case `billingDb.ts` calls the one where the evidence matters most: a payload that
// could not be parsed, so it carries neither id — and the raw column is all there is.
addHook.run(
  'unparsable:1757000000',
  'paddle',
  null,
  null,
  'unknown',
  'ignored',
  'no txn id in body',
  '<html><head><title>502 Bad Gateway</title></head><body>nginx</body></html>',
  Date.UTC(2026, 8, 8, 5, 0),
  Date.UTC(2026, 8, 8, 5, 0),
  1,
  0,
);
billing.close();

// ── analytics.db: a real return curve, rolled up by the shipped writer one day at a time ──
const analytics = openAnalyticsDb(join(dir, 'analytics.db'));
const addActive = analytics.prepare('INSERT OR IGNORE INTO daily_active (day, install, host) VALUES (?,?,?)');
const day = (n: number): string => addDays(DAY0, n);
const cohort = (n: number, count: number, host = 'web'): void => {
  for (let i = 0; i < count; i += 1) addActive.run(day(n), `install_${n}_${i}`, host);
};
// A shrinking-but-real curve: each day brings new installs, and a share of the previous
// day's come back — which is what makes the grid's diagonal interesting rather than flat.
for (let n = 0; n <= 8; n += 1) {
  cohort(n, 20 - n, n % 3 === 0 ? 'crazygames' : 'web');
  for (let back = 1; back <= Math.min(n, 4); back += 1) {
    const returning = Math.max(0, 8 - back * 2);
    for (let i = 0; i < returning; i += 1) addActive.run(day(n), `install_${n - back}_${i}`, 'web');
  }
}
const addEvent = analytics.prepare(
  `INSERT INTO events (at_ms, day, name, install, session, host, build, locale, account_id, props)
   VALUES (?,?,?,?,?,?,?,?,?,?)`,
);
addEvent.run(NOW, day(7), 'session_start', 'install_7_0', 's1', 'web', 'demo', 'en', 'acc_zoe', '{}');
addEvent.run(NOW, day(5), 'session_start', 'install_5_0', 's2', 'crazygames', 'demo', 'en', 'acc_cg', '{}');
// The shipped job, once per simulated day — so every rollup row is one production wrote.
for (let n = 1; n <= 9; n += 1) persistRollup(analytics, day(n), NOW);
analytics.close();

// ── ops.db: one live override, and one stale row a removed flag would leave behind ──
const ops = openOpsDb(join(dir, 'ops.db'));
setFlag(ops, 'match.pvpBotBackfillDelayMs', 12_000, Date.UTC(2026, 8, 9, 8, 15), 'admin');
ops.prepare('INSERT OR REPLACE INTO flags (name, value, updated_at, set_by) VALUES (?,?,?,?)').run(
  'removed.oldFlag',
  'true',
  Date.UTC(2026, 8, 2, 11, 0),
  'sqlite3',
);
ops.close();

console.log(`seeded ${dir}: accounts.db billing.db analytics.db ops.db`);
