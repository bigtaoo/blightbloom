/**
 * `ops.db` (design/21 §4) — the override table, and the two properties that make it safe.
 *
 * 1. **A row means "overridden"; absence means "as shipped".** So clearing DELETES rather
 *    than writing the default in, and a test here proves the deletion rather than the
 *    value — because a stored copy of the default goes stale the day a deploy changes it,
 *    with the table looking perfectly consistent.
 * 2. **C1 is enforced on both sides of the table.** `setFlag` refuses a name outside the
 *    allowlist, and `readOverrides` refuses one too, so a row written by hand at a
 *    `sqlite3` prompt cannot become a live flag either.
 *
 * Real files rather than `:memory:`, because a `:memory:` database is per-connection and
 * these functions are about what a SECOND process reads back — the same reason
 * `daydayup-testing-conventions` records for the cross-connection dedupe case.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { FLAG_DEFS, FLAG_NAMES } from '../src/flags/defs';
import {
  clearFlag,
  effectiveFlags,
  listOverrides,
  openOpsDb,
  readOverrides,
  setFlag,
} from '../src/flags/store';

const dirs: string[] = [];
const open: DatabaseSync[] = [];
const T0 = 1_757_000_000_000;

function scratchDb(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), 'bb-flags-store-'));
  dirs.push(dir);
  const db = openOpsDb(join(dir, 'ops.db'));
  open.push(db);
  return db;
}

afterEach(() => {
  while (open.length) open.pop()!.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('setFlag', () => {
  it('stores a legitimate override and reads it back through a fresh statement', () => {
    const db = scratchDb();
    expect(setFlag(db, 'match.queueTimeoutMs', 45_000, T0, 'admin')).toBe(true);
    expect(readOverrides(db).values['match.queueTimeoutMs']).toBe(45_000);
  });

  it('stores each of the three value shapes', () => {
    const db = scratchDb();
    expect(setFlag(db, 'ads.rewardedOfferEnabled', false, T0, 'admin')).toBe(true);
    expect(setFlag(db, 'ui.maintenanceBanner', 'back at 14:00 UTC', T0, 'admin')).toBe(true);
    expect(setFlag(db, 'match.pvpBotBackfillDelayMs', 0, T0, 'admin')).toBe(true);
    const { values } = readOverrides(db);
    // All three falsy, and all three legitimate. A truthiness check anywhere in this path
    // would drop every one of them.
    expect(values['ads.rewardedOfferEnabled']).toBe(false);
    expect(values['match.pvpBotBackfillDelayMs']).toBe(0);
    expect(values['ui.maintenanceBanner']).toBe('back at 14:00 UTC');
  });

  it('REFUSES a name outside the allowlist and writes NOTHING', () => {
    // C1's line at the write path. The row count is what is asserted, not just the return
    // value: a function that answered `false` and stored the row anyway would pass a
    // return-value-only test, and `readOverrides` would then be the only thing between that
    // row and a live flag.
    const db = scratchDb();
    expect(setFlag(db, 'billing.devStub', true, T0, 'admin')).toBe(false);
    expect(setFlag(db, 'auth.skipPasswordCheck', true, T0, 'admin')).toBe(false);
    expect(setFlag(db, '__proto__', true, T0, 'admin')).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS n FROM flags').get()).toEqual({ n: 0 });
  });

  it('REFUSES a value its definition rejects, and writes nothing', () => {
    const db = scratchDb();
    expect(setFlag(db, 'match.queueTimeoutMs', 1e9, T0, 'admin')).toBe(false);
    expect(setFlag(db, 'match.queueTimeoutMs', 'soon', T0, 'admin')).toBe(false);
    expect(setFlag(db, 'ads.rewardedOfferEnabled', 'true', T0, 'admin')).toBe(false);
    expect(setFlag(db, 'ui.maintenanceBanner', 'x'.repeat(500), T0, 'admin')).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS n FROM flags').get()).toEqual({ n: 0 });
  });

  it('UPSERTS: a second set replaces the value and the metadata, not adds a row', () => {
    const db = scratchDb();
    setFlag(db, 'match.queueTimeoutMs', 45_000, T0, 'admin');
    setFlag(db, 'match.queueTimeoutMs', 90_000, T0 + 5000, 'ops2');
    expect(db.prepare('SELECT COUNT(*) AS n FROM flags').get()).toEqual({ n: 1 });
    const row = listOverrides(db).rows[0]!;
    expect(row.value).toBe(90_000);
    expect(row.updatedAtMs).toBe(T0 + 5000);
    expect(row.setBy).toBe('ops2');
  });
});

describe('clearFlag', () => {
  it('DELETES the row rather than writing the default into it', () => {
    // The property, asserted as a row count. A "clear" that stored the current default
    // would read identically today and silently stop following the default the day a deploy
    // changed it — with the table looking perfectly consistent, which is what makes that
    // failure survive.
    const db = scratchDb();
    setFlag(db, 'match.queueTimeoutMs', 45_000, T0, 'admin');
    expect(clearFlag(db, 'match.queueTimeoutMs')).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS n FROM flags').get()).toEqual({ n: 0 });
    expect(readOverrides(db).values['match.queueTimeoutMs']).toBeUndefined();
    expect(effectiveFlags(db)['match.queueTimeoutMs']).toBe(FLAG_DEFS['match.queueTimeoutMs'].default);
  });

  it('answers false for a flag that was not overridden', () => {
    // So the console can say "cleared" rather than "cleared (there was nothing there)".
    expect(clearFlag(scratchDb(), 'match.queueTimeoutMs')).toBe(false);
  });

  it('CLEARS a stale row whose name is no longer in the allowlist', () => {
    // The one operation that has to work on a name outside the allowlist: a flag REMOVED in
    // a deploy leaves a row behind, and if clearing were gated on `isFlagName` the only way
    // to remove it would be an SSH session — for a row the console is already showing as a
    // problem.
    const db = scratchDb();
    db.prepare('INSERT INTO flags (name, value, updated_at, set_by) VALUES (?,?,?,?)').run(
      'removed.oldFlag',
      'true',
      T0,
      'admin',
    );
    expect(clearFlag(db, 'removed.oldFlag')).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS n FROM flags').get()).toEqual({ n: 0 });
  });
});

describe('readOverrides', () => {
  /** A row written straight into the table, bypassing `setFlag` — which is what a human at
   *  a `sqlite3` prompt does, and the only way to produce the cases below. */
  function handWrite(db: DatabaseSync, name: string, valueJson: string): void {
    db.prepare('INSERT OR REPLACE INTO flags (name, value, updated_at, set_by) VALUES (?,?,?,?)').run(
      name,
      valueJson,
      T0,
      'sqlite3',
    );
  }

  it('SKIPS a row whose name is not in the allowlist, and reports it', () => {
    // C1's second enforcement point. The two are edited by different people at different
    // times, so both matter: a row that got in some other way must still not become a flag.
    const db = scratchDb();
    handWrite(db, 'billing.devStub', 'true');
    const { values, skipped } = readOverrides(db);
    expect(values).toEqual({});
    expect(skipped).toEqual(['billing.devStub']);
    // ...and the row is LEFT in place. Deleting somebody's data on a read is not a read's
    // business, and the console needs the row in order to show it as a problem.
    expect(db.prepare('SELECT COUNT(*) AS n FROM flags').get()).toEqual({ n: 1 });
  });

  it('SKIPS a row whose value its definition refuses, and reports it', () => {
    const db = scratchDb();
    handWrite(db, 'match.queueTimeoutMs', '999999999');
    handWrite(db, 'ads.rewardedOfferEnabled', '"true"');
    const { values, skipped } = readOverrides(db);
    expect(values).toEqual({});
    expect(skipped.sort()).toEqual(['ads.rewardedOfferEnabled', 'match.queueTimeoutMs']);
  });

  it('SKIPS a row whose value is not JSON at all', () => {
    const db = scratchDb();
    handWrite(db, 'ui.maintenanceBanner', 'not json');
    expect(readOverrides(db).skipped).toEqual(['ui.maintenanceBanner']);
  });

  it('keeps the GOOD rows when a bad one is beside them', () => {
    // The control for all three cases above: a reader that gave up on the first bad row
    // would pass every one of them and silently drop a legitimate override.
    const db = scratchDb();
    setFlag(db, 'match.queueTimeoutMs', 45_000, T0, 'admin');
    handWrite(db, 'billing.devStub', 'true');
    const { values, skipped } = readOverrides(db);
    expect(values['match.queueTimeoutMs']).toBe(45_000);
    expect(skipped).toEqual(['billing.devStub']);
  });
});

describe('listOverrides', () => {
  it('returns validated rows newest first, and names the invalid ones separately', () => {
    const db = scratchDb();
    setFlag(db, 'match.queueTimeoutMs', 45_000, T0, 'admin');
    setFlag(db, 'ads.rewardedOfferEnabled', false, T0 + 1000, 'admin');
    db.prepare('INSERT INTO flags (name, value, updated_at, set_by) VALUES (?,?,?,?)').run(
      'removed.oldFlag',
      'true',
      T0 + 2000,
      'sqlite3',
    );
    const { rows, invalid } = listOverrides(db);
    expect(rows.map((r) => r.name)).toEqual(['ads.rewardedOfferEnabled', 'match.queueTimeoutMs']);
    // The state worth being loud about: the table says the flag is set and every service is
    // ignoring it.
    expect(invalid).toEqual(['removed.oldFlag']);
  });

  it('is empty on a fresh database', () => {
    expect(listOverrides(scratchDb())).toEqual({ rows: [], invalid: [] });
  });
});

describe('effectiveFlags', () => {
  it('is TOTAL — every name, defaults where there is no override', () => {
    // The wire shape `flags/client.ts` requires: it treats a response missing any name as
    // unusable, so a partial payload here would make every poll fail while the endpoint
    // answered 200.
    const db = scratchDb();
    const flags = effectiveFlags(db);
    expect(Object.keys(flags).sort()).toEqual([...FLAG_NAMES].sort());
    for (const name of FLAG_NAMES) expect(flags[name], name).toBe(FLAG_DEFS[name].default);
  });

  it('merges an override over the default and leaves the rest alone', () => {
    const db = scratchDb();
    setFlag(db, 'match.queueTimeoutMs', 45_000, T0, 'admin');
    const flags = effectiveFlags(db);
    expect(flags['match.queueTimeoutMs']).toBe(45_000);
    expect(flags['match.pvpBotBackfillDelayMs']).toBe(FLAG_DEFS['match.pvpBotBackfillDelayMs'].default);
  });

  it('ignores an override that failed validation, and stays total', () => {
    const db = scratchDb();
    db.prepare('INSERT INTO flags (name, value, updated_at, set_by) VALUES (?,?,?,?)').run(
      'match.queueTimeoutMs',
      '999999999',
      T0,
      'sqlite3',
    );
    const flags = effectiveFlags(db);
    expect(Object.keys(flags).sort()).toEqual([...FLAG_NAMES].sort());
    expect(flags['match.queueTimeoutMs']).toBe(FLAG_DEFS['match.queueTimeoutMs'].default);
  });

  it('survives a second connection to the same file', () => {
    // The reason these cases use a real file. `ops.db` is written by adminsvc and read by
    // adminsvc, but the flag an operator sets has to survive a restart — and `:memory:`
    // would make that pass without proving it.
    const dir = mkdtempSync(join(tmpdir(), 'bb-flags-reopen-'));
    dirs.push(dir);
    const path = join(dir, 'ops.db');
    const first = openOpsDb(path);
    setFlag(first, 'match.queueTimeoutMs', 45_000, T0, 'admin');
    first.close();
    const second = openOpsDb(path);
    open.push(second);
    expect(effectiveFlags(second)['match.queueTimeoutMs']).toBe(45_000);
  });
});
