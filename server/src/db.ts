/**
 * The CONTROL PLANE's store (design/16-accounts.md) — accounts, sessions, ratings, meta
 * state, entitlements and the ladder's exactly-once claims.
 *
 * Six collections on the `accounts` logical database (`mongo.ts`), replacing the six tables
 * of the `node:sqlite` file this module owned until 2026-09-15. Shapes are unchanged; what
 * changed is where each of the old schema's guarantees now lives, and that is the only
 * interesting thing about this file.
 *
 * ## A constraint the old schema described but never enforced
 *
 * `username` was `TEXT NOT NULL UNIQUE` — SQLite's default BINARY collation, so
 * case-SENSITIVE — while `AuthService.register` looked for a duplicate with
 * `WHERE username = ? COLLATE NOCASE` and its comment stated the intent: "'Alice' and
 * 'alice' being two distinct accounts is a real impersonation/confusion footgun". The
 * index therefore never enforced what the check was for. The check enforced it alone, by
 * looking before it wrote.
 *
 * That was safe only because `node:sqlite` is synchronous: nothing could interleave between
 * the SELECT and the INSERT, so the look-before-write was atomic by accident. Every read
 * here returns a promise, so it would stop being safe the moment this file was ported —
 * concurrent registrations of 'Alice' and 'alice' would both find nothing and both insert,
 * producing exactly the footgun the comment named.
 *
 * The port does not reproduce it. The unique index below carries `collation: strength 2`,
 * so case-insensitive uniqueness is enforced by the DATABASE, and `AuthService` claims a
 * name by inserting and catching E11000 rather than by asking first — the shape design/19
 * §4's AMENDMENT 2 already required of billing settlement and `rating.ts` already required
 * of ladder settlement.
 *
 * ## Why both unique indexes are PARTIAL
 *
 * MongoDB's unique index treats a MISSING field as a single `null` value and admits exactly
 * one document carrying it, where SQLite treats every NULL as distinct. `providerId` is
 * absent on every local account, so a plain `unique: true` on `{provider, providerId}`
 * would admit ONE local account and reject every other with E11000. Both unique indexes
 * here are filtered to documents where the field is actually a string.
 * `test/mongo.semantics.test.ts` pins that behaviour against a real server.
 *
 * ## What no longer exists
 *
 * FOREIGN KEYS. `entitlements.account_id REFERENCES accounts(id)` and
 * `meta_state.account_id` have no MongoDB equivalent: a document naming an account that
 * does not exist is now accepted by the cluster and refused only by the one code path that
 * writes it. The old schema's comment argued the FK earned its place because "a hand-issued
 * row for a typo'd account id fails loudly at the `sqlite3` prompt instead of becoming an
 * orphan that silently never delivers" — that protection is gone, and an operator writing
 * documents by hand in `mongosh` has nothing checking them.
 *
 * The CHECK constraints did survive, as `$jsonSchema` + `$expr` validators: the `source`
 * enum and "a purchase-sourced entitlement must carry an order id" are enforced by the
 * server against every writer, that same `mongosh` prompt included.
 */
import type { Collection, Db } from 'mongodb';

/** One account. `_id` is the account id the rest of the server passes around as a string. */
export interface AccountDoc {
  _id: string;
  /** The LOGIN HANDLE, case-insensitively unique (see the header). `displayName` is what a
   *  human sees and is not unique — the two are the same string for a local account, and
   *  deliberately different for a federated one: a CrazyGames account's handle is
   *  `cg:{userId}`, unreachable by AuthService's own `[a-zA-Z0-9_]` rule so it can never
   *  collide with a local account, while its display name is the portal's, which the
   *  platform requires the game to show and which no uniqueness rule of ours may reject. */
  username: string;
  passwordHash: string;
  provider: string;
  /** ABSENT, not null, for a local account — see the header on partial indexes. */
  providerId?: string;
  createdAt: number;
  displayName?: string;
}

export interface SessionDoc {
  /** The session token. */
  _id: string;
  accountId: string;
  expiresAt: number;
}

/** No reference to `accounts`, deliberately: a rating key is any opaque id `ladderReport.ts`
 *  hands us, including a guest/bot scaffold (`seat:{roomId}:{seatIdx}`) that never has an
 *  account document at all (design/15's ladder predates design/16's accounts). */
export interface RatingDoc {
  _id: string;
  rating: number;
}

export interface MetaStateDoc {
  _id: string;
  data: string;
}

/** Server-owned ownership of the purchasable half of MetaState (design/19 §2, ROADMAP 8.2).
 *  `metaState` above keeps what the client legitimately authors and stays a blob;
 *  blueprint/character ownership lives here, because a whole-blob upsert is a free-money
 *  hole once those are sold. */
export interface EntitlementDoc {
  _id: string;
  accountId: string;
  sku: string;
  source: 'purchase' | 'grant' | 'event' | 'starter' | 'drop';
  /** billsvc's `orders._id` (design/19 §4). No reference: that collection lives in a
   *  different logical store on purpose, so the join is reconciliation's job, never the
   *  cluster's. */
  orderId?: string;
  grantedAt: number;
}

/**
 * Exactly-once ladder settlement (design/19 §3). The DOCUMENT is the mechanism, not an
 * index over one: settlement claims it with an upsert and reads `upsertedCount`, inside the
 * same transaction that writes `ratings` — never a find followed by an insert, which
 * answers the question before holding the lock that would make the answer true.
 *
 * No rating fields: the document is a CLAIM, not a record of what was applied. The deltas
 * are already in `ratings`, and `appliedAt` plus a prefix match on the room id is what an
 * operator needs to answer "did this room's settlement land?".
 */
export interface RatingReportDoc {
  /** `ladderReport.ts`'s `{roomId}:{digest}`. */
  _id: string;
  appliedAt: number;
}

/** The control plane's collections, typed. Handed to every store that reads them, the way a
 *  `DatabaseSync` used to be — see `test/mongoHarness.ts` on why nothing reaches for a
 *  process-wide handle instead. */
export interface AccountsStore {
  accounts: Collection<AccountDoc>;
  sessions: Collection<SessionDoc>;
  ratings: Collection<RatingDoc>;
  metaState: Collection<MetaStateDoc>;
  entitlements: Collection<EntitlementDoc>;
  ratingReports: Collection<RatingReportDoc>;
}

/**
 * Case-insensitive comparison, for the `username` index and for every query that has to
 * match it.
 *
 * Exported, and there is exactly one of it, because a query that omits the collation
 * silently falls back to the default one: it stops using the index AND stops folding case,
 * so `login('Alice')` would simply not find `alice`. That failure is invisible at the call
 * site, which is why no caller is allowed to spell this out for itself.
 */
export const CI_COLLATION = { locale: 'en', strength: 2 } as const;

export function accountsStore(db: Db): AccountsStore {
  return {
    accounts: db.collection<AccountDoc>('accounts'),
    sessions: db.collection<SessionDoc>('sessions'),
    ratings: db.collection<RatingDoc>('ratings'),
    metaState: db.collection<MetaStateDoc>('metaState'),
    entitlements: db.collection<EntitlementDoc>('entitlements'),
    ratingReports: db.collection<RatingReportDoc>('ratingReports'),
  };
}

/** The `entitlements` validator — the two CHECK constraints the SQLite table carried, kept
 *  as a server-side rule so they bind a `mongosh` prompt too, not only this code. */
const ENTITLEMENT_VALIDATOR: Record<string, unknown> = {
  $and: [
    {
      $jsonSchema: {
        bsonType: 'object',
        required: ['accountId', 'sku', 'source', 'grantedAt'],
        properties: {
          accountId: { bsonType: 'string' },
          sku: { bsonType: 'string' },
          source: { enum: ['purchase', 'grant', 'event', 'starter', 'drop'] },
          grantedAt: { bsonType: 'number' },
        },
      },
    },
    // A paid entitlement with no order behind it is unauditable, and design/19 §7's
    // reconciliation could never match it to anything on the platform side.
    { $expr: { $or: [{ $ne: ['$source', 'purchase'] }, { $eq: [{ $type: '$orderId' }, 'string'] }] } },
  ],
};

/**
 * Creates every index and validator this store depends on. Idempotent — `createIndex` with
 * an identical specification is a no-op — so every service may call it at boot, and that is
 * what keeps a freshly created Atlas database correct with no separate migration step.
 */
export async function ensureAccountsIndexes(db: Db): Promise<void> {
  const s = accountsStore(db);

  // Case-insensitive AND unique: the constraint the old schema described in a comment but
  // did not enforce. See the file header.
  await s.accounts.createIndex(
    { username: 1 },
    { unique: true, collation: CI_COLLATION, name: 'accounts_username_ci' },
  );
  // Partial: `providerId` is absent on every local account, and a plain unique index would
  // admit exactly one of them.
  await s.accounts.createIndex(
    { provider: 1, providerId: 1 },
    { unique: true, partialFilterExpression: { providerId: { $type: 'string' } }, name: 'accounts_provider_id' },
  );

  await s.sessions.createIndex({ expiresAt: 1 }, { name: 'sessions_expiry' });
  await s.sessions.createIndex({ accountId: 1 }, { name: 'sessions_account' });

  // A SKU is own-or-not, never stacked (design/19 §2) — so this is also the idempotency key
  // an at-least-once platform callback is delivered through.
  await s.entitlements.createIndex({ accountId: 1, sku: 1 }, { unique: true, name: 'entitlements_account_sku' });
  await s.entitlements.createIndex({ orderId: 1 }, { name: 'entitlements_order' });
  // `WHERE sku LIKE 'character:%'` covered both namespaces out of one table at a `sqlite3`
  // prompt; design/19 §7's daily audit groups by this one.
  await s.entitlements.createIndex({ grantedAt: 1 }, { name: 'entitlements_granted_at' });

  await ensureValidator(db, 'entitlements', ENTITLEMENT_VALIDATOR);
}

/** Installs a collection validator whether or not the collection exists yet. `createCollection`
 *  fails on an existing collection, so an existing one is amended with `collMod` instead. */
async function ensureValidator(db: Db, name: string, validator: Record<string, unknown>): Promise<void> {
  const existing = await db.listCollections({ name }).toArray();
  if (existing.length === 0) {
    await db.createCollection(name, { validator });
    return;
  }
  await db.command({ collMod: name, validator });
}
