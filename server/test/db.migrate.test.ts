/**
 * `openDb`'s additive-column migration (db.ts's `ADDED_COLUMNS`, 2026-09-08).
 *
 * This exists because `CREATE TABLE IF NOT EXISTS` cannot be the whole schema story for a
 * database that is already deployed — the table exists, so its body is never re-read, and a
 * new column simply is not there. Every case below therefore builds an OLD database by hand
 * (the pre-2026-09-08 `accounts` DDL, verbatim) on a real temp file and then opens it with
 * the current `openDb`. A `:memory:` database would always take the fresh-schema path and
 * could never fail, which is exactly the way this test would pass while the deployed server
 * broke.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db';

/** The `accounts` table as it shipped BEFORE display_name. Held as a literal rather than
 *  derived from db.ts, because a derived copy would silently follow the change it is meant
 *  to detect. */
const OLD_ACCOUNTS_DDL = `
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'local',
  provider_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX accounts_provider_id ON accounts(provider, provider_id);
CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  expires_at INTEGER NOT NULL
);
`;

let tempDir: string | undefined;
const opened: DatabaseSync[] = [];

afterEach(() => {
  for (const db of opened) db.close(); // release the handle before rmSync (Windows)
  opened.length = 0;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

/** A database file holding the pre-migration schema plus one local account. */
function legacyDbPath(): string {
  tempDir = mkdtempSync(join(tmpdir(), 'bb-db-migrate-'));
  const path = join(tempDir, 'legacy.db');
  const old = new DatabaseSync(path);
  old.exec(OLD_ACCOUNTS_DDL);
  old
    .prepare('INSERT INTO accounts (id, username, password_hash, provider, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('acct-old', 'alice', 'salt:hash', 'local', 1);
  old.close();
  return path;
}

function columns(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

describe('openDb — migrating a database that predates display_name', () => {
  it('adds the column to an existing accounts table', () => {
    const path = legacyDbPath();
    const before = new DatabaseSync(path);
    expect(columns(before, 'accounts')).not.toContain('display_name');
    before.close();

    const db = openDb(path);
    opened.push(db);
    expect(columns(db, 'accounts')).toContain('display_name');
  });

  it('leaves the existing rows intact, with the new column NULL', () => {
    const db = openDb(legacyDbPath());
    opened.push(db);
    expect(db.prepare('SELECT id, username, display_name FROM accounts').all()).toEqual([
      { id: 'acct-old', username: 'alice', display_name: null },
    ]);
  });

  it('is idempotent — opening the same file twice does not throw', () => {
    // SQLite's ADD COLUMN has no IF NOT EXISTS and throws on a repeat, so the guard is a
    // PRAGMA read. This is the case that fails if that read is ever dropped, and it fails
    // by making the server refuse to start at all.
    const path = legacyDbPath();
    const first = openDb(path);
    opened.push(first);
    expect(() => opened.push(openDb(path))).not.toThrow();
  });

  it('is a no-op on a database created by the CURRENT schema', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'bb-db-fresh-'));
    const path = join(tempDir, 'fresh.db');
    const fresh = openDb(path);
    opened.push(fresh);
    expect(columns(fresh, 'accounts')).toContain('display_name');
    // Only ONE display_name column — an unguarded ALTER on a table that already declares it
    // would throw here rather than duplicate, but the count is what states the intent.
    expect(columns(fresh, 'accounts').filter((c) => c === 'display_name')).toHaveLength(1);
  });

  it('lets a federated login land on the migrated table', () => {
    // The migration is only worth anything if the code that needs the column then works
    // against the migrated file — the half a PRAGMA assertion cannot show.
    const path = legacyDbPath();
    const db = openDb(path);
    opened.push(db);
    db.prepare(
      `INSERT INTO accounts (id, username, password_hash, provider, provider_id, created_at, display_name)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('acct-cg', 'cg:u1', '!', 'cg', 'u1', 2, 'PortalPlayer');
    expect(
      db.prepare('SELECT COALESCE(display_name, username) AS name FROM accounts ORDER BY id').all(),
    ).toEqual([{ name: 'PortalPlayer' }, { name: 'alice' }]);
  });
});
