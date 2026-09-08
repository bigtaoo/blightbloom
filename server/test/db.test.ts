/**
 * db.ts (design/16-accounts.md) — `openDb`'s parent-directory creation for a real file
 * path, and `defaultDbPath`'s two branches (`BB_DB_PATH` override vs. the fallback
 * relative to this package). `openDb(':memory:')` itself is already covered indirectly
 * via AuthService.test.ts/rating.test.ts, so this file doesn't repeat that.
 *
 * The fallback branch resolves to the REAL `server/data/daydayup.db` used by local dev
 * (see db.ts) — this suite never calls `openDb()` with that fallback live to avoid
 * touching that file; it only asserts the path `defaultDbPath()` computes. Anything that
 * actually opens a db here uses a real temp directory instead (this repo's convention —
 * no fs/node:sqlite mocking).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { openDb, defaultDbPath } from '../src/db';

const ORIGINAL_ENV = process.env.BB_DB_PATH;

let tempDir: string | undefined;
let openDbs: DatabaseSync[] = [];

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.BB_DB_PATH;
  else process.env.BB_DB_PATH = ORIGINAL_ENV;

  for (const db of openDbs) db.close(); // release the file handle before rmSync (Windows-safe)
  openDbs = [];
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe('defaultDbPath', () => {
  it('returns BB_DB_PATH verbatim when set', () => {
    process.env.BB_DB_PATH = '/some/configured/path.db';
    expect(defaultDbPath()).toBe('/some/configured/path.db');
  });

  it('falls back to server/data/daydayup.db (relative to this package) when unset', () => {
    delete process.env.BB_DB_PATH;
    // server/test and server/src are sibling directories directly under server/, so
    // '../data/daydayup.db' resolves identically from either — this reproduces db.ts's
    // own computation without importing its private state.
    const expected = join(dirname(fileURLToPath(import.meta.url)), '../data/daydayup.db');
    expect(defaultDbPath()).toBe(expected);
  });

  it('treats an empty-string BB_DB_PATH the same as unset', () => {
    process.env.BB_DB_PATH = '';
    const expected = join(dirname(fileURLToPath(import.meta.url)), '../data/daydayup.db');
    expect(defaultDbPath()).toBe(expected);
  });
});

describe('openDb — real temp file path', () => {
  it('creates the parent directory (mkdirSync recursive branch) and a working db', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'bb-db-test-'));
    const dbPath = join(tempDir, 'nested', 'sub', 'accounts.db');
    expect(existsSync(dirname(dbPath))).toBe(false); // parent dir doesn't exist yet

    const db = openDb(dbPath);
    openDbs.push(db);

    expect(existsSync(dirname(dbPath))).toBe(true);
    expect(existsSync(dbPath)).toBe(true);

    // The schema ran and the db is actually usable, not just an empty file.
    db.exec(
      "INSERT INTO accounts (id, username, password_hash, created_at) VALUES ('acct-1', 'tester', 'hash', 1)",
    );
    const row = db.prepare('SELECT username FROM accounts WHERE id = ?').get('acct-1') as
      | { username: string }
      | undefined;
    expect(row?.username).toBe('tester');
  });

  it('is idempotent when the parent directory already exists', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'bb-db-test-'));
    const dbPath = join(tempDir, 'accounts.db'); // tempDir itself already exists
    const db = openDb(dbPath);
    openDbs.push(db);
    expect(existsSync(dbPath)).toBe(true);
  });

  it('honours BB_DB_PATH as the default path when openDb() is called with no argument', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'bb-db-test-'));
    const dbPath = join(tempDir, 'env-configured', 'accounts.db');
    process.env.BB_DB_PATH = dbPath;

    const db = openDb(); // no explicit path → falls through to defaultDbPath()
    openDbs.push(db);

    expect(existsSync(dbPath)).toBe(true);
  });
});
