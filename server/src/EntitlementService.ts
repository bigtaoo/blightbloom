/**
 * EntitlementService (design/19-server-platform.md §2, ROADMAP 8.2) — the server-owned
 * half of `MetaState`.
 *
 * `POST /account/meta` is a whole-blob upsert, which was the right call while `MetaState`
 * was a localStorage mirror and nothing in it was worth money (design/16-accounts.md says
 * so outright). The moment blueprints and characters are sold that route becomes a
 * free-money hole, and characters are the one meta axis that reaches PvP
 * (design/14-meta-forging.md). The fix is not to validate the blob — that is whack-a-mole
 * — it is to move the two purchasable, account-level things OUT of it:
 *
 * - `meta_state` keeps what the client legitimately authors (materials, loadout,
 *   in-progress forge state) and stays a blob;
 * - `entitlements` owns blueprint/character OWNERSHIP, and `GET /account/meta` overwrites
 *   those fields in the returned blob from this table. A client that POSTs itself extra
 *   ownership is IGNORED rather than rejected (`stripOwnership` below), so every
 *   pre-existing guest and offline path keeps working byte-for-byte.
 *
 * A guest has no session, therefore no row here at all — local-only, exactly as today.
 *
 * `source` is not decoration. It is what makes design/19 §7's operational work possible: a
 * daily audit that counts non-`purchase` grants per account, and a support path that can
 * hand-issue one with plain SQL and have it still read as different from a paid one
 * afterwards. This project has no admin service and will not have one soon, so the schema
 * is deliberately shaped to be queried and corrected by a human at a `sqlite3` prompt.
 */
import type { ClientSession } from 'mongodb';
import type { AccountsStore, EntitlementDoc } from './db';

/**
 * Where an entitlement came from (design/19 §2). `purchase` is the only one that implies
 * money moved and the only one that requires an `order_id` (enforced by a CHECK in
 * `db.ts`); `grant` is a support hand-issue, `event` a time-limited campaign, `starter` a
 * new-account gift, `drop` something earned in a run.
 */
export const ENTITLEMENT_SOURCES = ['purchase', 'grant', 'event', 'starter', 'drop'] as const;
export type EntitlementSource = (typeof ENTITLEMENT_SOURCES)[number];

/** One row of `entitlements`, in this codebase's camelCase rather than SQL's snake_case. */
export interface EntitlementRow {
  /** The ObjectId as a hex string. Was an INTEGER PRIMARY KEY; nothing outside this module
   *  ever read it as a number, and what callers actually depend on is the ORDER `list()`
   *  returns, which an ObjectId preserves. */
  id: string;
  accountId: string;
  sku: string;
  source: EntitlementSource;
  /** billsvc's `orders._id` (design/19 §4). Lives in a DIFFERENT logical database, so this
   * is deliberately a plain string with no reference — the join is done by a human, or by
   * reconciliation, never by the cluster. */
  orderId: string | null;
  grantedAt: number;
}

/**
 * SKUs are namespaced by what they own rather than split across two tables: one
 * `UNIQUE(account_id, sku)` then covers both, `WHERE sku LIKE 'character:%'` is the whole
 * query a human needs, and a blueprint id can never collide with a skin id.
 */
export const BLUEPRINT_SKU_PREFIX = 'blueprint:';
export const CHARACTER_SKU_PREFIX = 'character:';

export function blueprintSku(weaponId: string): string {
  return `${BLUEPRINT_SKU_PREFIX}${weaponId}`;
}

export function characterSku(skinId: string): string {
  return `${CHARACTER_SKU_PREFIX}${skinId}`;
}

/**
 * The two `MetaState` fields this table owns. Named once, here, because three places have
 * to agree on them: the strip on write, the overwrite on read, and the client's own
 * projection (`client/src/net/entitlements.ts`).
 */
export const OWNERSHIP_FIELDS = ['unlockedBlueprints', 'ownedCharacters'] as const;

export interface Ownership {
  unlockedBlueprints: string[];
  ownedCharacters: string[];
}

/**
 * Project a set of SKUs onto the two ownership arrays. A SKU in neither namespace is
 * skipped rather than rejected: billsvc may later sell something that is not a blueprint
 * or a character, and an unknown namespace must not be able to break `/account/meta`.
 * An empty id after the prefix (`'blueprint:'`) is skipped for the same reason.
 */
export function skusToOwnership(skus: Iterable<string>): Ownership {
  const own: Ownership = { unlockedBlueprints: [], ownedCharacters: [] };
  for (const sku of skus) {
    if (sku.startsWith(BLUEPRINT_SKU_PREFIX)) {
      const id = sku.slice(BLUEPRINT_SKU_PREFIX.length);
      if (id) own.unlockedBlueprints.push(id);
    } else if (sku.startsWith(CHARACTER_SKU_PREFIX)) {
      const id = sku.slice(CHARACTER_SKU_PREFIX.length);
      if (id) own.ownedCharacters.push(id);
    }
  }
  return own;
}

/** A blob we can meaningfully add/remove named fields on — i.e. a plain JSON object. An
 * array passes `typeof x === 'object'` and must not, or a client POSTing `data: []` would
 * come back with array elements named `unlockedBlueprints`. */
function isPlainBlob(data: unknown): data is Record<string, unknown> {
  return typeof data === 'object' && data !== null && !Array.isArray(data);
}

/**
 * The WRITE normalizer: drop any ownership the client authored before storing the blob.
 * Ignored, not rejected (design/19 §2) — an older client, a guest promoting its local
 * save, or an offline replay all POST the full `MetaState` and must keep succeeding.
 *
 * Stripping rather than storing-and-overwriting-on-read matters for the SQL-auditability
 * requirement: `meta_state` then never holds a client-authored ownership claim at all, so
 * a human reading the table cannot be misled by one.
 *
 * A non-object `data` (a string, a number, an array, `null`) is stored verbatim — there is
 * nothing to strip, and today's route already accepts anything JSON-shaped.
 */
export function stripOwnership(data: unknown): unknown {
  if (!isPlainBlob(data)) return data;
  const out: Record<string, unknown> = { ...data };
  for (const field of OWNERSHIP_FIELDS) delete out[field];
  return out;
}

/**
 * The READ overwrite: the server's own answer for both ownership fields, replacing
 * whatever the stored blob says (which, after `stripOwnership`, is nothing).
 *
 * A non-object blob is returned untouched for the same reason as above.
 */
export function applyOwnership(data: unknown, own: Ownership): unknown {
  if (!isPlainBlob(data)) return data;
  return { ...data, unlockedBlueprints: [...own.unlockedBlueprints], ownedCharacters: [...own.ownedCharacters] };
}

function toRow(d: EntitlementDoc): EntitlementRow {
  return {
    id: d._id.toHexString(),
    accountId: d.accountId,
    sku: d.sku,
    source: d.source,
    // `null` rather than `undefined`, because absent is how a non-purchase grant is STORED
    // (MongoDB's partial index and the old NULL column mean the same thing here) and every
    // existing caller reads this field as nullable.
    orderId: d.orderId ?? null,
    grantedAt: d.grantedAt,
  };
}

export interface GrantOptions {
  /** billsvc order this grant settles. REQUIRED when `source` is `'purchase'` — the CHECK
   * in `db.ts` rejects a paid entitlement with no order behind it, because one is
   * unauditable and design/19 §7's reconciliation could never match it to anything. */
  orderId?: string;
  /** Injected clock, the same seam `Matchmaker`/`PartyService` already take. */
  nowMs?: number;
  /** The transaction this grant belongs to, when a caller has one open
   *  (`routes/internalEntitlements.ts` grants every SKU of an order together). Omitting it
   *  inside a transaction is silent and wrong: the write lands OUTSIDE the transaction and
   *  survives a rollback, so a partially-delivered order would keep the entitlements it
   *  was supposed to give back. */
  session?: ClientSession;
}

/**
 * Reads and writes `entitlements` (shape in `db.ts`). A thin wrapper over one
 * `AccountsStore` — the same injected shape `AuthService`/`RatingStore` already take, so it
 * composes into matchsvc with no new process.
 */
export class EntitlementService {
  constructor(private readonly store: AccountsStore) {}

  /**
   * Grant one SKU. Returns `true` when a row actually landed, `false` when the account
   * already owned it.
   *
   * An upsert read through `upsertedCount`, never find-then-insert: delivery is driven by
   * at-least-once platform callbacks (design/19 §4), so the unique index — not a prior read
   * — has to be the idempotency key. `$setOnInsert` is what makes a re-grant a no-op rather
   * than an update: the FIRST grant's `source` and `orderId` are the audit record, and
   * letting a later `grant` overwrite them would let a free hand-issue erase the paid order
   * that preceded it.
   *
   * Throws if `source` is `'purchase'` without an `orderId` — the collection validator
   * rejects it, because a paid entitlement with no order is unauditable.
   *
   * WHAT NO LONGER THROWS: an `accountId` naming no account. The SQLite table declared a
   * FOREIGN KEY and the old comment counted on it ("failing loud is what keeps a typo'd
   * hand-issue from becoming an orphan row that silently never delivers"). MongoDB has no
   * such constraint and this method does not add a lookup to fake one — a read here would be
   * a look-before-write on the hot delivery path, and it would still not bind the `mongosh`
   * prompt the FK was protecting against. The orphan is now caught by design/19 §7's
   * reconciliation instead of at write time. See `db.ts`'s header.
   */
  async grant(
    accountId: string,
    sku: string,
    source: EntitlementSource,
    opts: GrantOptions = {},
  ): Promise<boolean> {
    const setOnInsert: Record<string, unknown> = {
      accountId,
      sku,
      source,
      grantedAt: opts.nowMs ?? Date.now(),
    };
    // ABSENT, never null: `orderId: null` would be stored as a real null, and the
    // `entitlements_order` index plus every `$type: 'string'` test would then see a field
    // that is present and wrong rather than missing.
    if (opts.orderId !== undefined) setOnInsert.orderId = opts.orderId;
    const result = await this.store.entitlements.updateOne(
      { accountId, sku },
      { $setOnInsert: setOnInsert },
      { upsert: true, session: opts.session },
    );
    return result.upsertedCount > 0;
  }

  /**
   * Remove one SKU. Returns whether a row was actually deleted.
   *
   * Manual-only: design/19 §7's anomaly audit FILES rather than acts ("with no evidence,
   * skip — never convict"), so nothing in this server calls this on its own; the one automatic
   * removal (a platform-approved refund, ROADMAP 9.3) goes through `revokePurchase` below,
   * which cannot remove an entitlement held for any other reason. This exists so
   * that a support correction is a supported operation rather than a hand-written DELETE.
   */
  async revoke(accountId: string, sku: string): Promise<boolean> {
    const result = await this.store.entitlements.deleteOne({ accountId, sku });
    return result.deletedCount > 0;
  }

  /**
   * Remove one SKU ONLY IF it is held because of THAT purchase — `source: 'purchase'` and the
   * same `orderId` (ROADMAP 9.3, a platform-approved refund). Returns whether a row went.
   *
   * The filter is the whole point. `entitlements` keeps the FIRST grant (`grant` above), so an
   * account that earned a blueprint from a boss drop and then also bought it holds a `drop`
   * row, and the purchase was delivered as "already owned". Refunding that purchase must not
   * take away the drop — the refund gives back the money, not something earned for free.
   */
  async revokePurchase(accountId: string, sku: string, orderId: string, session?: ClientSession): Promise<boolean> {
    const result = await this.store.entitlements.deleteOne({ accountId, sku, source: 'purchase', orderId }, { session });
    return result.deletedCount > 0;
  }

  /** Every entitlement this account holds, oldest grant first — `_id` is an ObjectId, which
   *  is creation-ordered, so this is the same ordering the monotonic INTEGER key gave. */
  async list(accountId: string): Promise<EntitlementRow[]> {
    const docs = await this.store.entitlements.find({ accountId }).sort({ _id: 1 }).toArray();
    return docs.map(toRow);
  }

  /** Whether this account owns one specific SKU — the check a future PvP character gate
   * (design/14's "the one meta axis that reaches PvP") wants, without loading the list. */
  async owns(accountId: string, sku: string): Promise<boolean> {
    const doc = await this.store.entitlements.findOne({ accountId, sku }, { projection: { _id: 1 } });
    return doc !== null;
  }

  /** The ownership arrays `GET /account/meta` writes over the stored blob with. */
  async ownership(accountId: string): Promise<Ownership> {
    return skusToOwnership((await this.list(accountId)).map((r) => r.sku));
  }
}
