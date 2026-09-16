/**
 * Seeds a throwaway set of databases so the ops console can be LOOKED AT
 * (design/21 §3, and §2.5's rule that an instrument has to be shown to see the change).
 *
 * Not a fixture and not a test helper — a developer tool, in `scripts/` beside `reconcile.ts`
 * and `grantAudit.ts`. It writes through this repo's own collection handles and index
 * installers so every schema is the shipped one, and it fills each of the four sections with
 * the states that are interesting to look at rather than the states a fresh box has: an
 * account with entitlements and one without, an open review-queue item and a reviewed one, a
 * webhook document with divergences, and a rollup history deep enough that the cohort grid
 * contains a measured rate, a measured zero and an unknown at the same time.
 *
 *   BB_MONGO_URI=... BB_MONGO_DB_PREFIX=demo npx tsx scripts/seedOpsDemo.ts
 *   BB_MONGO_URI=... BB_MONGO_DB_PREFIX=demo BB_ANALYTICS_ENABLED=1 BB_OPS_FLAGS_ENABLED=1 \
 *   BB_ADMIN_ALLOW_WRITABLE=1 BB_ADMIN_PASSWORD=... BB_ADMIN_INSECURE_COOKIE=1 \
 *   npm run adminsvc -w server
 *
 * ## The prefix is REQUIRED, and that is this script's only safety mechanism
 *
 * It used to take a directory and write four files into it, so the worst case was a mess in
 * a temp folder. There are no files now: every write below goes to whatever cluster
 * `BB_MONGO_URI` names, and an unset `BB_MONGO_DB_PREFIX` means the BARE database names —
 * which on a production URI is production. So the prefix is checked before anything is
 * connected, and "forgot the prefix" is a refusal rather than a seeded `accounts` database
 * full of demo players called `zoe`.
 *
 * `BB_ADMIN_ALLOW_WRITABLE=1` is needed to point the console at a local mongod, which has no
 * roles and therefore fails the write probe (`adminsvc/server.ts`). `BB_ADMIN_INSECURE_COOKIE=1`
 * is required to sign in over plain http — the session cookie is `Secure` otherwise and a
 * browser will not send it back to `http://localhost`. The startup guard refuses that flag
 * under `NODE_ENV=production`.
 */
import { accountsStore, ensureAccountsIndexes } from '../src/db';
import { closeMongo, connectMongo, dbName, store } from '../src/mongo';
import { billingStore, ensureBillingIndexes } from '../src/billingDb';
import { dailyActiveOf, ensureAnalyticsIndexes, eventsOf } from '../src/analytics/db';
import { addDays, persistRollup } from '../src/analytics/rollup';
import { ensureOpsIndexes, flagsOf, setFlag } from '../src/flags/store';

if (!process.env.BB_MONGO_DB_PREFIX?.trim()) {
  console.error(
    'refusing to seed: BB_MONGO_DB_PREFIX is unset, so this would write demo data into the ' +
      'bare database names — which on a production URI is production. Set it to something ' +
      'like `demo` and re-run.',
  );
  process.exit(2);
}

const NOW = Date.UTC(2026, 8, 9, 12, 0, 0);
const DAY0 = '2026-09-01';

await connectMongo();

// ── the `accounts` store: two local players, one portal account, ratings, entitlements ──
const accountsDb = store('accounts');
await ensureAccountsIndexes(accountsDb);
const accounts = accountsStore(accountsDb);
// `providerId` and `displayName` are OMITTED rather than set to null for the two local
// accounts: the partial unique index is filtered on `{$type: 'string'}`, and an explicit
// null is a present-and-wrong field rather than an absent one.
await accounts.accounts.replaceOne(
  { _id: 'acc_zoe' },
  { username: 'zoe', passwordHash: 'x', provider: 'local', createdAt: Date.UTC(2026, 7, 20) },
  { upsert: true },
);
await accounts.accounts.replaceOne(
  { _id: 'acc_quiet' },
  { username: 'quiet_one', passwordHash: 'x', provider: 'local', createdAt: Date.UTC(2026, 8, 1) },
  { upsert: true },
);
await accounts.accounts.replaceOne(
  { _id: 'acc_cg' },
  {
    username: 'cg:11223344',
    passwordHash: 'x',
    provider: 'cg',
    providerId: '11223344',
    createdAt: Date.UTC(2026, 8, 7),
    displayName: 'Zoë from the portal',
  },
  { upsert: true },
);
for (const [id, rating] of [['acc_zoe', 1184] as const, ['acc_cg', 998] as const]) {
  await accounts.ratings.replaceOne({ _id: id }, { rating }, { upsert: true });
}
await accounts.entitlements.updateOne(
  { accountId: 'acc_zoe', sku: 'blueprint:cannon' },
  {
    $set: {
      accountId: 'acc_zoe',
      sku: 'blueprint:cannon',
      source: 'purchase',
      orderId: 'ord_1',
      grantedAt: Date.UTC(2026, 8, 5),
    },
  },
  { upsert: true },
);
await accounts.entitlements.updateOne(
  { accountId: 'acc_zoe', sku: 'character:scout' },
  { $set: { accountId: 'acc_zoe', sku: 'character:scout', source: 'grant', grantedAt: Date.UTC(2026, 8, 6) } },
  { upsert: true },
);

// ── billing: an open finding, a reviewed one, and three callbacks incl. a divergent one ──
const billingDb = store('billing');
await ensureBillingIndexes(billingDb);
const billing = billingStore(billingDb);
await billing.reviewQueue.replaceOne(
  { _id: 'money-taken-nothing-granted:del_7' },
  {
    kind: 'money-taken-nothing-granted',
    accountId: 'acc_cg',
    dayKey: null,
    summary: 'settled purchase the control plane refused',
    evidenceJson: '{"deliveryId":"del_7","attempts":9,"lastStatus":404}',
    state: 'open',
    createdAt: Date.UTC(2026, 8, 8, 3, 12),
    reviewedAt: null,
    note: null,
  },
  { upsert: true },
);
await billing.reviewQueue.replaceOne(
  { _id: 'grant-anomaly:acc_zoe:2026-09-06' },
  {
    kind: 'grant-anomaly',
    accountId: 'acc_zoe',
    dayKey: '2026-09-06',
    summary: '9 non-purchase grants in one day',
    evidenceJson: '{"count":9,"threshold":5}',
    state: 'reviewed',
    createdAt: Date.UTC(2026, 8, 6, 23, 0),
    reviewedAt: Date.UTC(2026, 8, 7, 9, 30),
    note: 'launch event reward, expected',
  },
  { upsert: true },
);
await billing.webhookEvents.replaceOne(
  { _id: 'txn_a1:transaction.completed' },
  {
    platform: 'paddle',
    orderId: 'ord_1',
    txnId: 'txn_a1',
    eventType: 'transaction.completed',
    outcome: 'settled',
    detail: null,
    raw: '{"event_type":"transaction.completed","data":{"id":"txn_a1","items":[{"price":{"product_id":"bp.cannon"}}]}}',
    firstSeenAt: Date.UTC(2026, 8, 5, 10, 0),
    lastSeenAt: Date.UTC(2026, 8, 5, 10, 0, 12),
    seenCount: 2,
    divergences: 0,
  },
  { upsert: true },
);
await billing.webhookEvents.replaceOne(
  { _id: 'txn_b2:transaction.completed' },
  {
    platform: 'paddle',
    orderId: null,
    txnId: 'txn_b2',
    eventType: 'transaction.completed',
    outcome: 'rejected',
    detail: 'signature mismatch',
    raw: '{"event_type":"transaction.completed","data":{"id":"txn_b2","amount":"0.01"}}',
    firstSeenAt: Date.UTC(2026, 8, 8, 4, 0),
    lastSeenAt: Date.UTC(2026, 8, 8, 6, 30),
    seenCount: 5,
    divergences: 3,
  },
  { upsert: true },
);
// The case `billing/collections.ts` calls the one where the evidence matters most: a payload
// that could not be parsed, so it carries neither id — and `raw` is all there is.
await billing.webhookEvents.replaceOne(
  { _id: 'unparsable:1757000000' },
  {
    platform: 'paddle',
    orderId: null,
    txnId: null,
    eventType: 'unknown',
    outcome: 'ignored',
    detail: 'no txn id in body',
    raw: '<html><head><title>502 Bad Gateway</title></head><body>nginx</body></html>',
    firstSeenAt: Date.UTC(2026, 8, 8, 5, 0),
    lastSeenAt: Date.UTC(2026, 8, 8, 5, 0),
    seenCount: 1,
    divergences: 0,
  },
  { upsert: true },
);

// ── analytics: a real return curve, rolled up by the shipped writer one day at a time ──
const analytics = store('analytics');
await ensureAnalyticsIndexes(analytics);
const day = (n: number): string => addDays(DAY0, n);
const active: { day: string; install: string; host: string }[] = [];
const cohort = (n: number, count: number, host = 'web'): void => {
  for (let i = 0; i < count; i += 1) active.push({ day: day(n), install: `install_${n}_${i}`, host });
};
// A shrinking-but-real curve: each day brings new installs, and a share of the previous
// day's come back — which is what makes the grid's diagonal interesting rather than flat.
for (let n = 0; n <= 8; n += 1) {
  cohort(n, 20 - n, n % 3 === 0 ? 'crazygames' : 'web');
  for (let back = 1; back <= Math.min(n, 4); back += 1) {
    const returning = Math.max(0, 8 - back * 2);
    for (let i = 0; i < returning; i += 1) active.push({ day: day(n), install: `install_${n - back}_${i}`, host: 'web' });
  }
}
// One `$setOnInsert` upsert each, which is `INSERT OR IGNORE` — a returning install already
// has a document for that day and must keep the host it FIRST arrived with (`analytics/db.ts`).
for (const doc of active) {
  await dailyActiveOf(analytics).updateOne(
    { day: doc.day, install: doc.install },
    { $setOnInsert: doc },
    { upsert: true },
  );
}
await eventsOf(analytics).insertMany([
  {
    atMs: NOW,
    day: day(7),
    name: 'session_start',
    install: 'install_7_0',
    session: 's1',
    host: 'web',
    build: 'demo',
    locale: 'en',
    accountId: 'acc_zoe',
    props: {},
  },
  {
    atMs: NOW,
    day: day(5),
    name: 'session_start',
    install: 'install_5_0',
    session: 's2',
    host: 'crazygames',
    build: 'demo',
    locale: 'en',
    accountId: 'acc_cg',
    props: {},
  },
]);
// The shipped job, once per simulated day — so every rollup document is one production wrote.
for (let n = 1; n <= 9; n += 1) await persistRollup(analytics, day(n), NOW);

// ── ops: one live override, and one stale document a removed flag would leave behind ──
const ops = store('ops');
await ensureOpsIndexes(ops);
await setFlag(ops, 'match.pvpBotBackfillDelayMs', 12_000, Date.UTC(2026, 8, 9, 8, 15), 'admin');
// Written through the raw collection rather than `setFlag`, on purpose: `setFlag` refuses a
// name outside the allowlist, and this document is exactly the thing that refusal cannot
// produce — the residue of a flag that was REMOVED from `defs.ts` after an operator had set
// it. The console's "unknown flag" row exists for it, so the demo has to contain one.
await flagsOf(ops).replaceOne(
  { _id: 'removed.oldFlag' },
  { value: 'true', updatedAt: Date.UTC(2026, 8, 2, 11, 0), setBy: 'mongosh' },
  { upsert: true },
);

await closeMongo();
console.log(
  `seeded the four stores on the cluster: ${(['accounts', 'billing', 'analytics', 'ops'] as const)
    .map(dbName)
    .join(' ')}`,
);
