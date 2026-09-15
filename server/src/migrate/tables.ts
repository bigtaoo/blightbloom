/**
 * The one-time migration off `node:sqlite` (stage 7 of the 2026-09-15 port): the row → document
 * mapping, one entry per legacy table, and the id scheme that makes re-running it safe.
 *
 * ## DELETE THIS DIRECTORY once the live data has moved and been verified
 *
 * It is the only code left in this repository that knows anything about SQLite, and that is
 * deliberate rather than an oversight: the owner's decision was to delete SQLite entirely,
 * and the way to honour that while still being able to carry four live `.db` files onto the
 * cluster is to put the exception in one directory with its own expiry date on it. Nothing
 * under `src/` imports this, no bundle contains it (`deploy.bundle.test.ts` asserts that no
 * bundle carries `node:sqlite` at all), and it runs from `scripts/migrateFromSqlite.ts` under
 * `tsx` on the box that holds the files.
 *
 * ## Absent, null, and the difference between them
 *
 * The port's rule (`billing/collections.ts`, `db.ts`) is that a field a unique index can see
 * is ABSENT when it has no value, and a field nothing indexes uniquely holds an explicit
 * `null` where SQL's `IS NULL` behaviour has to survive. A migration that got this backwards
 * would not fail: it would write one `null` into `orders.platformTxnId`, and the partial
 * unique index would then admit exactly one such document and reject the SECOND unsettled
 * order — on the payment path, in production, only under concurrency. So every mapping below
 * says which of the two it is doing, and `migrate.tables.test.ts` pins the pairs.
 *
 * ## Why every document gets a deterministic `_id`
 *
 * Re-running a half-finished migration has to be safe, which means every write is an upsert
 * onto a key derived from the SOURCE row rather than from the clock. Most tables had a `TEXT
 * PRIMARY KEY` and keep it verbatim. Two did not — `entitlements` and `events` were
 * `INTEGER PRIMARY KEY` — and for those {@link legacyObjectId} builds an ObjectId from the
 * row's own timestamp and its own integer id, so the same row always produces the same
 * `_id` and the ordering the integer carried survives.
 */
import { ObjectId } from 'mongodb';

/**
 * An ObjectId that encodes a legacy row: its timestamp, and its integer primary key.
 *
 * `db.ts` explains why `entitlements._id` is an ObjectId at all — it embeds a creation time
 * and sorts by it, which is how "oldest grant first" survived the loss of an autoincrementing
 * integer. A migration has to reproduce that, and `ObjectId.createFromTime` cannot: it zeroes
 * the eight bytes after the timestamp, so two grants minted in the same SECOND would collide
 * into one document and the second would silently overwrite the first.
 *
 * So the tail is built by hand. `0xbb` marks the document as one this migration wrote (a byte
 * the driver's own random-plus-counter tail effectively never produces, and one an operator
 * can grep an `_id` for), and the remaining six bytes carry the legacy integer id. The result
 * is deterministic — a re-run upserts onto the same document — and ordered, because within one
 * second the ids ascend exactly as the integers did.
 *
 * Six bytes is 2.8e14 rows. A table that outgrows it is a table that outgrew SQLite years
 * before this migration ran, so the range is asserted rather than defended against.
 */
export function legacyObjectId(atMs: number, legacyId: number): ObjectId {
  if (!Number.isInteger(legacyId) || legacyId < 0 || legacyId > 0xff_ffff_ffff_ff) {
    throw new RangeError(`legacy id ${legacyId} does not fit the six bytes an ObjectId tail has for it`);
  }
  const buf = Buffer.alloc(12);
  buf.writeUInt32BE(Math.floor(atMs / 1000) >>> 0, 0);
  buf.writeUInt8(0xbb, 4);
  buf.writeUIntBE(legacyId, 5, 6);
  return new ObjectId(buf);
}

/** Whether an ObjectId carries this migration's marker byte. */
export function isMigratedId(id: ObjectId): boolean {
  return id.id[4] === 0xbb;
}

/** One legacy table, and how to turn a row of it into a document. */
export interface TableMap {
  /** Which of the four files it lives in. */
  store: 'accounts' | 'billing' | 'analytics' | 'ops';
  /** The SQLite table. */
  table: string;
  /** The target collection. */
  collection: string;
  /** `ORDER BY` clause, so a table whose ordering carried meaning keeps it. */
  orderBy: string;
  /**
   * The filter the document is upserted on.
   *
   * A separate function from {@link TableMap.doc} rather than "whatever `_id` came out",
   * because two collections are keyed by a COMPOUND unique index instead of an `_id`
   * (`dailyActive` on `(day, install)`, `dailyRollup` on `(day, metric, labels)`) — exactly
   * as their SQLite tables were keyed by a compound PRIMARY KEY. Upserting those on a
   * generated `_id` would duplicate every document on the second run.
   */
  key: (row: Record<string, unknown>) => Record<string, unknown>;
  doc: (row: Record<string, unknown>) => Record<string, unknown>;
}

/** A nullable TEXT column that becomes an ABSENT field. */
const absent = (field: string, value: unknown): Record<string, unknown> =>
  value === null || value === undefined ? {} : { [field]: value };

const str = (v: unknown): string => String(v);
const num = (v: unknown): number => Number(v);
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/**
 * Every table, in the order the migration walks them.
 *
 * `accounts` first within its store, so a box watched mid-migration fills in the way a reader
 * expects. Nothing depends on the order for correctness — there are no foreign keys left to
 * violate, which is the one place the port's loss of them makes something easier.
 */
export const TABLES: readonly TableMap[] = [
  {
    store: 'accounts',
    table: 'accounts',
    collection: 'accounts',
    orderBy: 'created_at ASC, id ASC',
    key: (r) => ({ _id: str(r.id) }),
    // `provider_id` and `display_name` are ABSENT rather than null, and this is the pair the
    // whole absent/null rule was written for: `accounts_provider_id` is a PARTIAL unique
    // index filtered on `{$type: 'string'}`, and one stored null in `providerId` would make
    // the index admit exactly one such document — refusing the second LOCAL account ever to
    // be migrated.
    doc: (r) => ({
      _id: str(r.id),
      username: str(r.username),
      passwordHash: str(r.password_hash),
      provider: str(r.provider),
      ...absent('providerId', r.provider_id),
      createdAt: num(r.created_at),
      ...absent('displayName', r.display_name),
    }),
  },
  {
    store: 'accounts',
    table: 'sessions',
    collection: 'sessions',
    orderBy: 'expires_at ASC',
    key: (r) => ({ _id: str(r.token) }),
    // Migrated rather than dropped, so the cutover does not log every signed-in player out.
    // An expired one is harmless: `AuthService` checks `expiresAt` on every read, and the
    // TTL index sweeps it.
    doc: (r) => ({ _id: str(r.token), accountId: str(r.account_id), expiresAt: num(r.expires_at) }),
  },
  {
    store: 'accounts',
    table: 'ratings',
    collection: 'ratings',
    orderBy: 'account_id ASC',
    key: (r) => ({ _id: str(r.account_id) }),
    doc: (r) => ({ _id: str(r.account_id), rating: num(r.rating) }),
  },
  {
    store: 'accounts',
    table: 'meta_state',
    collection: 'metaState',
    orderBy: 'account_id ASC',
    key: (r) => ({ _id: str(r.account_id) }),
    doc: (r) => ({ _id: str(r.account_id), data: str(r.data) }),
  },
  {
    store: 'accounts',
    table: 'entitlements',
    collection: 'entitlements',
    // BY THE INTEGER KEY, which is the ordering `list()` used to answer "oldest grant first"
    // with. `legacyObjectId` is what carries it across; see there.
    orderBy: 'id ASC',
    key: (r) => ({ _id: legacyObjectId(num(r.granted_at), num(r.id)) }),
    doc: (r) => ({
      _id: legacyObjectId(num(r.granted_at), num(r.id)),
      accountId: str(r.account_id),
      sku: str(r.sku),
      source: str(r.source),
      // ABSENT: the collection validator requires a string `orderId` when `source` is
      // `purchase`, and an explicit null would fail it for a grant rather than satisfy it.
      ...absent('orderId', r.order_id),
      grantedAt: num(r.granted_at),
    }),
  },
  {
    store: 'accounts',
    table: 'rating_reports',
    collection: 'ratingReports',
    orderBy: 'applied_at ASC',
    key: (r) => ({ _id: str(r.report_key) }),
    doc: (r) => ({ _id: str(r.report_key), appliedAt: num(r.applied_at) }),
  },
  {
    store: 'billing',
    table: 'orders',
    collection: 'orders',
    orderBy: 'created_at ASC, id ASC',
    key: (r) => ({ _id: str(r.id) }),
    // `platform_txn_id` and `settled_at` ABSENT. The first is the dangerous one: its unique
    // index is partial on `{$type: 'string'}` precisely so that any number of UNSETTLED
    // orders can coexist, the way SQLite's distinct-NULLs behaviour allowed — and one stored
    // null would make the second unsettled order fail with E11000 on the payment path.
    doc: (r) => ({
      _id: str(r.id),
      accountId: str(r.account_id),
      sku: str(r.sku),
      platform: str(r.platform),
      amountCents: num(r.amount_cents),
      currency: str(r.currency),
      state: str(r.state),
      ...absent('platformTxnId', r.platform_txn_id),
      createdAt: num(r.created_at),
      ...absent('settledAt', r.settled_at),
    }),
  },
  {
    store: 'billing',
    table: 'receipts',
    collection: 'receipts',
    orderBy: 'verified_at ASC, id ASC',
    key: (r) => ({ _id: str(r.id) }),
    doc: (r) => ({
      _id: str(r.id),
      accountId: str(r.account_id),
      platform: str(r.platform),
      product: str(r.product),
      raw: str(r.raw),
      verifiedAt: num(r.verified_at),
    }),
  },
  {
    store: 'billing',
    table: 'ledger',
    collection: 'ledger',
    orderBy: 'ts ASC, id ASC',
    key: (r) => ({ _id: str(r.id) }),
    doc: (r) => ({
      _id: str(r.id),
      accountId: str(r.account_id),
      sku: str(r.sku),
      ...absent('orderId', r.order_id),
      ...absent('receiptId', r.receipt_id),
      kind: str(r.kind),
      ts: num(r.ts),
    }),
  },
  {
    store: 'billing',
    table: 'deliveries',
    collection: 'deliveries',
    orderBy: 'created_at ASC, id ASC',
    key: (r) => ({ _id: str(r.id) }),
    doc: (r) => ({
      _id: str(r.id),
      accountId: str(r.account_id),
      sku: str(r.sku),
      grantsJson: str(r.grants_json),
      orderId: str(r.order_id),
      receiptId: str(r.receipt_id),
      state: str(r.state),
      attempts: num(r.attempts),
      createdAt: num(r.created_at),
      // ABSENT unless delivered. `failed` means we gave up, which is a different fact from a
      // landing time and must not borrow this field to say so.
      ...absent('deliveredAt', r.delivered_at),
    }),
  },
  {
    store: 'billing',
    table: 'webhook_events',
    collection: 'webhookEvents',
    orderBy: 'first_seen_at ASC, id ASC',
    key: (r) => ({ _id: str(r.id) }),
    // Explicit NULLs, not absence: nothing indexes these uniquely, and
    // `webhookEventsForOrder` reads `orderId` as an equality filter where a stored null and
    // an absent field must behave the way SQL's `IS NULL` did.
    doc: (r) => ({
      _id: str(r.id),
      platform: str(r.platform),
      orderId: strOrNull(r.order_id),
      txnId: strOrNull(r.txn_id),
      eventType: str(r.event_type),
      outcome: str(r.outcome),
      detail: strOrNull(r.detail),
      raw: str(r.raw),
      firstSeenAt: num(r.first_seen_at),
      lastSeenAt: num(r.last_seen_at),
      seenCount: num(r.seen_count),
      divergences: num(r.divergences),
    }),
  },
  {
    store: 'billing',
    table: 'review_queue',
    collection: 'reviewQueue',
    orderBy: 'created_at ASC, id ASC',
    key: (r) => ({ _id: str(r.id) }),
    doc: (r) => ({
      _id: str(r.id),
      kind: str(r.kind),
      accountId: str(r.account_id),
      dayKey: strOrNull(r.day_key),
      summary: str(r.summary),
      evidenceJson: str(r.evidence_json),
      state: str(r.state),
      createdAt: num(r.created_at),
      reviewedAt: numOrNull(r.reviewed_at),
      note: strOrNull(r.note),
    }),
  },
  {
    store: 'analytics',
    table: 'events',
    collection: 'events',
    orderBy: 'id ASC',
    key: (r) => ({ _id: legacyObjectId(num(r.at_ms), num(r.id)) }),
    // `props` was JSON TEXT and becomes a SUBDOCUMENT, which is the one shape change in this
    // whole migration: `rollup.ts`'s screen-view split reached into the blob through
    // `json_extract` and is a plain `$group` on `props.screen` now. An unparsable blob is a
    // hand-edited row, and it becomes `{}` rather than failing the migration — the event's
    // other nine fields are what retention is computed from.
    doc: (r) => ({
      _id: legacyObjectId(num(r.at_ms), num(r.id)),
      atMs: num(r.at_ms),
      day: str(r.day),
      name: str(r.name),
      install: str(r.install),
      session: str(r.session),
      host: str(r.host),
      build: str(r.build),
      locale: str(r.locale),
      accountId: strOrNull(r.account_id),
      props: parseProps(r.props),
    }),
  },
  {
    store: 'analytics',
    table: 'daily_active',
    collection: 'dailyActive',
    orderBy: 'day ASC, install ASC',
    // The old `PRIMARY KEY (day, install)`, which is a compound UNIQUE INDEX now and not an
    // `_id`. Upserting on a generated id would duplicate every document on a second run.
    key: (r) => ({ day: str(r.day), install: str(r.install) }),
    doc: (r) => ({ day: str(r.day), install: str(r.install), host: str(r.host) }),
  },
  {
    store: 'analytics',
    table: 'daily_rollup',
    collection: 'dailyRollup',
    orderBy: 'day ASC, metric ASC, labels ASC',
    key: (r) => ({ day: str(r.day), metric: str(r.metric), labels: str(r.labels) }),
    doc: (r) => ({
      day: str(r.day),
      metric: str(r.metric),
      labels: str(r.labels),
      value: num(r.value),
      computedAt: num(r.computed_at),
    }),
  },
  {
    store: 'ops',
    table: 'flags',
    collection: 'flags',
    orderBy: 'name ASC',
    key: (r) => ({ _id: str(r.name) }),
    doc: (r) => ({ _id: str(r.name), value: str(r.value), updatedAt: num(r.updated_at), setBy: str(r.set_by) }),
  },
];

/**
 * `events.props`, as a subdocument.
 *
 * Anything that does not parse to a plain object becomes `{}`. That is the same posture
 * `readOverrides` takes toward a hand-edited flag value and `reviewQueue` toward an
 * unparsable `evidence_json`: design/19 §8 declines to build an admin service and plans for
 * corrections made by hand at a prompt, so a row somebody broke by hand is a row this has to
 * carry across rather than stop on.
 */
export function parseProps(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
