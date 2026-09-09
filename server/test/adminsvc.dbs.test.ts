/**
 * Decision B1, asserted rather than asserted-about (design/21 §3.1): **the console cannot
 * write player data.**
 *
 * The weak version of this test would check that `openAdminDbs` passed `readOnly: true`.
 * That is a test of a call site, and it passes against a handle whose option was ignored.
 * What is checked here instead is the capability: a write is ATTEMPTED through each of the
 * three handles, against real tables created by this repo's own openers, and each one has
 * to throw. That is the form the sentence has to take to survive a bug in adminsvc — it is
 * SQLite refusing, not our code declining.
 *
 * The other half of the file is the three nullable arms, which are normal states with three
 * normal causes (see `dbs.ts`'s header) and not defensive code: `readOnly` mode does not
 * create a missing file, and all three files belong to other processes.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db';
import { openBillingDb } from '../src/billingDb';
import { openAnalyticsDb } from '../src/analytics/db';
import { analyticsPathFromEnv, openAdminDbs, openReadOnly, type AdminDbs } from '../src/adminsvc/dbs';
// matchsvc's own reader for the same variable — imported so the last case in this file can
// compare the two implementations instead of trusting that they agree.
import { analyticsDbPathFromEnv } from '../src/matchsvc';

const dirs: string[] = [];
const bundles: AdminDbs[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bb-adminsvc-dbs-'));
  dirs.push(dir);
  return dir;
}

/** A directory holding all three real databases, each created by its OWN opener. Not a
 *  hand-written schema: a console that can read a file this repo's writer did not create
 *  proves nothing about the deployed pair. */
function threeDatabases(): { dir: string; accounts: string; billing: string; analytics: string } {
  const dir = scratch();
  const paths = {
    dir,
    accounts: join(dir, 'accounts.db'),
    billing: join(dir, 'billing.db'),
    analytics: join(dir, 'analytics.db'),
  };
  for (const [open, path] of [
    [openDb, paths.accounts],
    [openBillingDb, paths.billing],
    [openAnalyticsDb, paths.analytics],
  ] as const) {
    const db = open(path);
    db.close(); // Windows keeps a lock on an open file, and the dir removal below would EPERM.
  }
  return paths;
}

afterEach(() => {
  while (bundles.length) bundles.pop()!.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('B1 — the console holds no write capability', () => {
  it('REFUSES an INSERT through every one of the three handles', () => {
    const paths = threeDatabases();
    const dbs = openAdminDbs(paths);
    bundles.push(dbs);

    expect(dbs.accounts).not.toBeNull();
    expect(dbs.billing).not.toBeNull();
    expect(dbs.analytics).not.toBeNull();

    // One write per database, each against a table that really exists — a statement against
    // a missing table would throw for the wrong reason and this test would pass on nothing.
    expect(() =>
      dbs.accounts!.prepare('INSERT INTO accounts (id, username, password_hash, provider, created_at) VALUES (?,?,?,?,?)').run(
        'a1',
        'someone',
        'h',
        'local',
        1,
      ),
    ).toThrow(/readonly|read-only/i);
    expect(() =>
      dbs.billing!.prepare(
        `INSERT INTO review_queue (id, kind, account_id, summary, evidence_json, state, created_at)
         VALUES (?,?,?,?,?,?,?)`,
      ).run('r1', 'grant-anomaly', 'a1', 's', '{}', 'open', 1),
    ).toThrow(/readonly|read-only/i);
    expect(() =>
      dbs.analytics!.prepare('INSERT INTO daily_active (day, install, host) VALUES (?,?,?)').run('2026-09-01', 'i', 'web'),
    ).toThrow(/readonly|read-only/i);
  });

  it('REFUSES a DELETE, an UPDATE and a DROP too', () => {
    // Three more verbs, because "cannot INSERT" is a weaker claim than the sentence B1
    // makes. A DROP in particular is the one a read-only posture has to cover: an attacker
    // with SQL on this handle would not add a row, they would remove a table.
    const paths = threeDatabases();
    const dbs = openAdminDbs(paths);
    bundles.push(dbs);
    expect(() => dbs.accounts!.prepare('DELETE FROM accounts').run()).toThrow(/readonly|read-only/i);
    expect(() => dbs.accounts!.prepare('UPDATE ratings SET rating = 9999').run()).toThrow(/readonly|read-only/i);
    expect(() => dbs.accounts!.exec('DROP TABLE entitlements')).toThrow(/readonly|read-only/i);
  });

  it('still SELECTS through the same handles', () => {
    // The control. Every refusal above would also be satisfied by a handle that cannot do
    // anything at all, which is a broken console rather than a safe one.
    const paths = threeDatabases();
    const dbs = openAdminDbs(paths);
    bundles.push(dbs);
    expect(dbs.accounts!.prepare('SELECT COUNT(*) AS n FROM accounts').get()).toEqual({ n: 0 });
    expect(dbs.billing!.prepare('SELECT COUNT(*) AS n FROM webhook_events').get()).toEqual({ n: 0 });
    expect(dbs.analytics!.prepare('SELECT COUNT(*) AS n FROM daily_rollup').get()).toEqual({ n: 0 });
  });

  it('does not CREATE a missing database, so a typo cannot become an empty console', () => {
    // The whole reason each handle is nullable. A writable open would have created three
    // empty files and every section would have rendered a working, empty page — which is
    // indistinguishable from "nobody has ever played" and is how a wrong env var survives.
    const dir = scratch();
    const missing = join(dir, 'not-there.db');
    const result = openReadOnly(missing);
    expect('error' in result).toBe(true);
    // ...whereas the WRITABLE opener creates it. Closed immediately: on Windows an open
    // SQLite handle locks the file and this suite's own `rmSync` would EPERM.
    const created = openDb(missing);
    expect(created.prepare('SELECT COUNT(*) AS n FROM accounts').get()).toEqual({ n: 0 });
    created.close();
  });
});

describe('openAdminDbs — the absent arms', () => {
  it('reports each missing file on its own, with a reason, and keeps the others', () => {
    // One missing database must not take the other two with it: a console that will not
    // open is a console that cannot be used to find out why it will not open.
    const paths = threeDatabases();
    const dbs = openAdminDbs({ ...paths, billing: join(paths.dir, 'no-billing.db') });
    bundles.push(dbs);
    expect(dbs.accounts).not.toBeNull();
    expect(dbs.analytics).not.toBeNull();
    expect(dbs.billing).toBeNull();
    expect(dbs.errors.billing).toBeTruthy();
    // An OPENED handle records the empty string, not `undefined` — the record is total on
    // purpose, so no call site needs a `?? ''` fallback that no input could reach.
    expect(dbs.errors.accounts).toBe('');
    expect(dbs.errors.analytics).toBe('');
  });

  it('treats analytics: null as "not configured" rather than as an error', () => {
    // The opt-in state (design/21 §2.4): `BB_ANALYTICS_DB_PATH` unset means this deployment
    // collects nothing, which is a supported deployment and not a misconfiguration. The
    // page says so in those words, so the reason string has to be the one a person reads.
    const paths = threeDatabases();
    const dbs = openAdminDbs({ ...paths, analytics: null });
    bundles.push(dbs);
    expect(dbs.analytics).toBeNull();
    expect(dbs.errors.analytics).toContain('BB_ANALYTICS_DB_PATH');
  });

  it('never throws, even with all three absent', () => {
    const dir = scratch();
    const dbs = openAdminDbs({
      accounts: join(dir, 'a.db'),
      billing: join(dir, 'b.db'),
      analytics: join(dir, 'c.db'),
    });
    bundles.push(dbs);
    expect([dbs.accounts, dbs.billing, dbs.analytics]).toEqual([null, null, null]);
    expect(Object.keys(dbs.errors).sort()).toEqual(['accounts', 'analytics', 'billing']);
    for (const [name, reason] of Object.entries(dbs.errors)) expect(reason, name).not.toBe('');
  });

  it('logs a WARN per unavailable database when a logger is passed', () => {
    // "The commerce tab says unavailable" and "the file is not where the env var points"
    // are the same fact, and only one of them is searchable in the log store.
    const dir = scratch();
    const warnings: { msg: string; fields?: Record<string, unknown> }[] = [];
    const log = {
      error: () => {},
      warn: (msg: string, fields?: Record<string, unknown>) => warnings.push({ msg, fields }),
      info: () => {},
      debug: () => {},
      child: () => log,
    };
    const dbs = openAdminDbs(
      { accounts: join(dir, 'a.db'), billing: join(dir, 'b.db'), analytics: null },
      log as never,
    );
    bundles.push(dbs);
    // Two, not three: `analytics: null` is a configuration state, not a failed open, so it
    // has a reason on the page and no log line.
    expect(warnings).toHaveLength(2);
    expect(warnings.map((w) => w.fields?.db).sort()).toEqual(['accounts', 'billing']);
  });

  it('closes only the handles it actually opened', () => {
    // `close()` iterates the opened map, not the three fields — closing a `null` would
    // throw and take a shutdown with it.
    const paths = threeDatabases();
    const dbs = openAdminDbs({ ...paths, analytics: null });
    expect(() => dbs.close()).not.toThrow();
  });

  it('rejects a file that is not a database at all', () => {
    // The near miss worth covering: `BB_DB_PATH` pointed at a directory, or at a text file
    // somebody left behind. SQLite opens it and fails on the first read; the error belongs
    // on the page rather than as a crash at boot.
    const dir = scratch();
    const notADb = join(dir, 'notes.txt');
    writeFileSync(notADb, 'this is not a sqlite file\n');
    const dbs = openAdminDbs({ accounts: notADb, billing: join(dir, 'b.db'), analytics: null });
    bundles.push(dbs);
    // Either the open throws or the first query does — both are acceptable and both must
    // leave the process standing, so this asserts the survivable outcome rather than which.
    if (dbs.accounts !== null) {
      expect(() => dbs.accounts!.prepare('SELECT 1 FROM accounts').get()).toThrow();
    } else {
      expect(dbs.errors.accounts).toBeTruthy();
    }
  });
});

describe('analyticsPathFromEnv', () => {
  it('reads the variable, and treats an EMPTY value as unset', () => {
    // The same empty-string-is-unset rule matchsvc applies to the same variable, and the
    // same reason design/19 §9 records: a trailing `BB_ANALYTICS_DB_PATH:` with no value in
    // a compose file produces `""`, which beats a `??` fallback. Here that would be
    // `new DatabaseSync('', {readOnly:true})`.
    expect(analyticsPathFromEnv({ BB_ANALYTICS_DB_PATH: '/data/analytics.db' })).toBe('/data/analytics.db');
    expect(analyticsPathFromEnv({ BB_ANALYTICS_DB_PATH: '' })).toBeNull();
    expect(analyticsPathFromEnv({ BB_ANALYTICS_DB_PATH: '   ' })).toBeNull();
    expect(analyticsPathFromEnv({})).toBeNull();
  });

  it('agrees with matchsvc\'s reader on every one of those inputs', () => {
    // The two are deliberately separate two-line functions (importing `matchsvc.ts` would
    // pull `ws` and every route group into the console's bundle), so nothing but a test
    // keeps them from drifting. A drift here is silent: the console would look at a
    // different file from the one being written.
    const cases = [{ BB_ANALYTICS_DB_PATH: '/x.db' }, { BB_ANALYTICS_DB_PATH: '' }, {}, { BB_ANALYTICS_DB_PATH: ' ' }];
    for (const env of cases) {
      expect(analyticsPathFromEnv(env)).toBe(analyticsDbPathFromEnv(env));
    }
  });
});
