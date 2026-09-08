/**
 * Account/session/rating/meta persistence (design/16-accounts.md). Uses Node's built-in
 * `node:sqlite` (stable since Node 22) rather than a third-party driver — this box has no
 * C++ build toolchain for native modules like better-sqlite3, and the built-in module needs
 * nothing beyond the Node runtime already required to run this server at all. Same
 * synchronous, single-file, zero-ops shape the rest of this project already leans on (no
 * Express, no separate DB service — see matchsvc.ts/RatingStore/PartyService).
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCHEMA = `
-- \`username\` is the LOGIN HANDLE and is unique; \`display_name\` is what a human sees and is
-- not. The two are the same string for a local account (display_name stays NULL and every
-- reader falls back), and deliberately different for a federated one: a CrazyGames account's
-- handle is \`cg:{userId}\` — unreachable by \`AuthService\`'s own \`[a-zA-Z0-9_]\` username rule,
-- so it can never collide with a real local account — while its display_name is the portal's
-- username, which the platform requires the game to show and which no uniqueness rule of
-- ours may reject (design/20 "account integration").
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'local',
  provider_id TEXT,
  created_at INTEGER NOT NULL,
  display_name TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS accounts_provider_id ON accounts(provider, provider_id);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  expires_at INTEGER NOT NULL
);

-- No FK to accounts(id): a rating key is any opaque id ladderReport.ts hands us,
-- including a guest/bot scaffold (\`seat:{roomId}:{seatIdx}\`) that never has an
-- accounts row at all (design/15's ladder predates design/16's accounts table).
CREATE TABLE IF NOT EXISTS ratings (
  account_id TEXT PRIMARY KEY,
  rating INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meta_state (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id),
  data TEXT NOT NULL
);

-- Server-owned ownership of the purchasable half of MetaState (design/19 §2, ROADMAP 8.2;
-- logic in EntitlementService.ts). meta_state above keeps what the client legitimately
-- authors and stays a blob; blueprint/character ownership moves here, because a whole-blob
-- upsert is a free-money hole once those are sold.
--
-- This table DOES take the FK that \`ratings\` above deliberately refuses, and the contrast
-- is the point: a rating key is any opaque id ladderReport.ts hands us, including a
-- guest/bot \`seat:{roomId}:{seatIdx}\` scaffold that never has an accounts row. An
-- entitlement is only ever minted for a real, logged-in account — a guest has no session,
-- so it has no row here at all (design/19: "byte-identical to today") — so there is no
-- legitimate id that could fail the constraint, and node:sqlite enforcing FKs by default
-- is exactly what we want: a hand-issued row for a typo'd account id fails loudly at the
-- \`sqlite3\` prompt instead of becoming an orphan that silently never delivers.
--
-- Shaped to be read and hand-corrected with plain SQL, since design/19 §7 rules out an
-- admin service: \`WHERE sku LIKE 'character:%'\` covers both namespaces out of one table,
-- and the source CHECK keeps a typo out of the column §7's daily audit groups by.
CREATE TABLE IF NOT EXISTS entitlements (
  id INTEGER PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  sku TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('purchase', 'grant', 'event', 'starter', 'drop')),
  -- billsvc's orders.id (design/19 §4). No FK: that table lives in a different database
  -- file on purpose, so the join is reconciliation's job, never SQLite's.
  order_id TEXT,
  granted_at INTEGER NOT NULL,
  -- A SKU here is own-or-not, never stacked (design/19 §2) — so this is also the
  -- idempotency key an at-least-once platform callback is delivered through.
  UNIQUE(account_id, sku),
  -- A paid entitlement with no order behind it is unauditable, and §7's reconciliation
  -- could never match it to anything on the platform side.
  CHECK (source <> 'purchase' OR order_id IS NOT NULL)
);

-- Exactly-once ladder settlement (design/19 §3, closing ROADMAP 8.1's one open item). \`POST /rating/report\` is an
-- AT-LEAST-ONCE delivery: ROADMAP 8.1 gave \`reportSettledMatch\` a retry budget, so a report
-- that was DELIVERED and lost only its response (a timeout, a 5xx written after the write)
-- comes back. With nothing to lose a claim to, the retry adds the whole match's rating
-- deltas a second time — 8.1's own note called that "the first thing to do to this seam
-- next", and this table is it.
--
-- The PRIMARY KEY *is* the mechanism, not an index over one. Delivery claims a row with
-- \`INSERT ... ON CONFLICT DO NOTHING\` and reads \`changes()\`, inside the SAME transaction
-- that writes \`ratings\` (rating.ts's \`applyMatchOnce\`) — never SELECT-then-INSERT, which
-- answers the question before holding the lock that would make the answer true. That is
-- design/19 §4's first billing rule and its AMENDMENT 2, pointed at this seam.
--
-- No FK and no rating columns: the row is a CLAIM, not a record of what was applied. The
-- deltas are already in \`ratings\`, the report keys are \`ladderReport.ts\`'s
-- \`{roomId}:{digest}\` (see there for why a digest rides along), and \`applied_at\` plus
-- \`WHERE report_key LIKE 'the-room-id:%'\` is what an operator needs to answer "did this
-- room's settlement land?" with plain SQL (design/19 §7 rules out an admin service).
CREATE TABLE IF NOT EXISTS rating_reports (
  report_key TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
`;

/**
 * Columns added to a table that already exists in a DEPLOYED database. `CREATE TABLE IF NOT
 * EXISTS` above is the whole schema story for a fresh file and cannot be for an old one:
 * the table exists, so its body is never re-read, and the new column simply is not there.
 *
 * Kept as a table of `(table, column, ddl)` rather than a version counter because that is
 * what this project's one real migration need looks like — one nullable column at a time,
 * each independently idempotent, none of them ordered against another. A numbered-migration
 * runner would be a mechanism with one entry in it. If this list ever grows a change that
 * is NOT an additive nullable column (a rename, a backfill, a constraint), that is the
 * point to build the runner rather than to stretch this.
 */
const ADDED_COLUMNS: readonly { table: string; column: string; ddl: string }[] = [
  // 2026-09-08, design/20 "account integration": the portal's display name, which is not
  // the login handle. NULL for every local account, and read through a fallback.
  { table: 'accounts', column: 'display_name', ddl: 'ALTER TABLE accounts ADD COLUMN display_name TEXT' },
];

/** Applies `ADDED_COLUMNS` to an existing database. Idempotent: `PRAGMA table_info` is asked
 *  first, because SQLite's `ADD COLUMN` has no `IF NOT EXISTS` and throws on a repeat. */
function migrate(db: DatabaseSync): void {
  for (const { table, column, ddl } of ADDED_COLUMNS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (cols.some((c) => c.name === column)) continue;
    db.exec(ddl);
  }
}

/** Opens (creating if needed) the account DB and ensures the schema exists. */
export function openDb(path: string = defaultDbPath()): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** NOTE: the file is still `daydayup.db` after the 2026-09-06 rename to Blightbloom, and
 *  the `/health` `service:` ids in `index.ts`/`matchsvc.ts`/`billsvc/server.ts` are still
 *  `daydayup-*`, on purpose: those are matched by something outside this repo (a deployed
 *  volume, a monitor), so renaming them is a migration, not a rename. Display text moved. */
export function defaultDbPath(): string {
  const env = process.env.BB_DB_PATH;
  if (env && env.length > 0) return env;
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '../data/daydayup.db');
}
