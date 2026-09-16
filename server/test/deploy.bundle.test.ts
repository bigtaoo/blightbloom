/**
 * THE DEPLOY BUNDLES ACTUALLY BOOT (design/19-server-platform.md, ROADMAP 9).
 *
 * Everything else in this suite imports TypeScript straight out of `src/` the way `tsx`
 * does in dev. Production runs something else entirely: flat ESM files that
 * `scripts/build.mjs` produced by collapsing the `@dd/engine` / `@dd/game/*` / `@dd/net/*`
 * workspace graph into one bundle per process, with `ws` and `mongodb` deliberately
 * left external. Nothing verified that artifact until this file — a wrong `external`
 * entry, an alias esbuild silently failed to resolve, or an entrypoint pointed at the
 * wrong source all produce a suite that is entirely green and a container that dies on
 * `ERR_MODULE_NOT_FOUND` seconds after `docker compose up`. The whole point of a build
 * step is that its output is not the thing you tested.
 *
 * The sixth bundle is why that sentence is worth repeating. `dist/migrate.mjs` exists
 * because the cutover runbook's own command did not: it said `node --import tsx/esm
 * scripts/migrateFromSqlite.ts`, and no image this tree builds has `scripts/`, TypeScript
 * or `tsx` in it. The migration's LOGIC had tests against a real cluster; the way it
 * reaches a production box had none, so the suite was green and the command was
 * unrunnable. The last `describe` in this file is that missing layer — it runs the shipped
 * migration bundle as a bare process against a real SQLite file and a real cluster, in the
 * runbook's own order. Delete it with the migration itself.
 *
 * So: build into a scratch directory (never `server/dist`, which is a real deploy
 * artifact), then BOOT each bundle as its own `node` process — no tsx, no loader, no
 * monorepo `node_modules` beyond the `ws` the deploy image installs for itself — and
 * require it to answer its own `/health`, naming its own service. Answering with the
 * WRONG service name is the failure a smoke test that only checks `ok: true` would wave
 * through, and it is one typo in `build.mjs`'s `entries` away.
 */
import { describe, it, expect, beforeAll, afterAll, inject } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, symlinkSync } from 'node:fs';
import { MongoClient } from 'mongodb';
// The one remaining `node:sqlite` import in this repository outside the migration itself,
// and it is here for the same reason the migration is: to write the legacy files the
// cutover has to read. It goes with `src/migrate/` when that is deleted.
import { DatabaseSync } from 'node:sqlite';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
// @ts-expect-error — plain .mjs build script, the same untyped-helper import vitest.config.ts uses.
import { buildAll, entries, external } from '../scripts/build.mjs';

/** An OS-assigned free port. Racy in principle; the window is a few ms and this is a test. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const require_ = createRequire(import.meta.url);
const deployPkg = JSON.parse(readFileSync(new URL('../deploy/package.json', import.meta.url), 'utf8')) as {
  dependencies: Record<string, string>;
};

let outdir = '';
let built: string[] = [];
const children: ChildProcess[] = [];
const staged: string[] = [];

/**
 * Stand in for the deploy image's `npm install --omit=dev`: link ONLY what
 * `deploy/package.json` declares into the scratch directory's own `node_modules`.
 *
 * This is the half of the test that makes it worth running. The scratch dir lives in the
 * OS temp tree, so Node's upward `node_modules` walk from a bundle finds nothing of this
 * monorepo — a bundle reaching for anything the deploy manifest does not list fails to
 * boot here exactly as it would in the container. Building into `server/dist` instead
 * would quietly let the whole repo's `node_modules` satisfy it, and the test would pass
 * on a deploy manifest missing every one of its dependencies.
 */
function stageDeployDependencies(dir: string): void {
  const nm = join(dir, 'node_modules');
  mkdirSync(nm, { recursive: true });
  for (const dep of Object.keys(deployPkg.dependencies)) {
    const pkgRoot = dirname(require_.resolve(`${dep}/package.json`));
    // `junction` is the one dir-link type Windows grants without elevation; ignored elsewhere.
    const link = join(nm, dep);
    symlinkSync(pkgRoot, link, 'junction');
    staged.push(link);
  }
}

beforeAll(async () => {
  outdir = mkdtempSync(join(tmpdir(), 'bb-bundle-'));
  built = await buildAll(outdir, 'silent');
  stageDeployDependencies(outdir);
}, 120_000);

afterAll(() => {
  for (const c of children) c.kill();
  // Best-effort: the junctions must go before the tree (a recursive delete would otherwise
  // follow one into the real package), and a just-killed child can still hold its .db open
  // for a moment on Windows. Leaving a scratch dir behind in the OS temp tree is not worth
  // failing a green suite over — hence `catch {}` here and nowhere else in this file.
  for (const link of staged) {
    try {
      rmdirSync(link);
    } catch {
      /* already gone */
    }
  }
  try {
    if (outdir) rmSync(outdir, { recursive: true, force: true });
  } catch {
    /* a child still holds a handle; the OS reclaims it */
  }
});

/**
 * Boots one bundle and waits for `/health`. Rejects with the child's own stderr rather
 * than a bare timeout — for the failure this file exists to catch (a module the bundle
 * can't resolve at runtime) that output IS the diagnosis, and swallowing it would leave
 * a red test saying only "health did not answer".
 */
async function boot(
  file: string,
  port: number,
  env: Record<string, string>,
  // adminsvc serves every path under `/admin` so that one Caddy `handle` block covers the
  // whole console (design/21 §3.4), so its probe is `/admin/health`. A parameter rather
  // than a second copy of this helper.
  healthPath = '/health',
): Promise<unknown> {
  const child = spawn(process.execPath, [file], {
    env: { ...process.env, HOST: '127.0.0.1', NODE_ENV: 'development', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let output = '';
  child.stdout?.on('data', (d) => (output += String(d)));
  child.stderr?.on('data', (d) => (output += String(d)));
  let exited: number | null = null;
  child.on('exit', (code) => (exited = code));

  for (let i = 0; i < 100; i += 1) {
    if (exited !== null) throw new Error(`${file} exited with ${exited} before answering:\n${output}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}${healthPath}`);
      if (res.ok) return await res.json();
    } catch {
      /* not listening yet */
    }
    await sleep(100);
  }
  throw new Error(`${file} never answered /health in 10s:\n${output}`);
}

describe('the built bundles are self-contained', () => {
  it('emits exactly one file per entrypoint', () => {
    // The guard for every assertion below: a build that silently produced nothing would
    // make "no unresolved alias survived" trivially true of an empty set of files.
    expect(built).toHaveLength(6);
    expect(entries.map((e: { out: string }) => e.out)).toEqual([
      'index',
      'matchsvc',
      'billsvc',
      'backup',
      'adminsvc',
      'migrate',
    ]);
    // Five processes compose runs, and one tool it does not. The flag is what
    // `deploy.manifests.test.ts` cross-checks against compose's `command:` lines, so a new
    // entry that forgets it fails there rather than quietly widening what a deploy must
    // contain.
    expect(entries.filter((e: { service: boolean }) => !e.service).map((e: { out: string }) => e.out)).toEqual([
      'migrate',
    ]);
  });

  it('resolved every @dd/* workspace alias at build time', () => {
    // These aliases exist only in tsconfig.base.json's `paths`. A bundle that still names
    // one is a bundle that needs the monorepo at runtime — which the deploy image is not.
    for (const file of built) {
      expect(readFileSync(file, 'utf8')).not.toMatch(/from\s*["']@dd\//);
    }
  });

  it('kept exactly the declared externals external', () => {
    // `ws` must survive as a real import (bundling it breaks its runtime `require` of the
    // native/WASM fallback); `mongodb` must survive for the same reason and for a sharper
    // one — bundled, its `require('timers/promises')` becomes a dynamic require in ESM
    // output and every service dies at boot, which is exactly what the boot cases below
    // caught. Both are then satisfied by deploy/package.json. Asserted per-bundle rather
    // than in aggregate, because only the processes that actually hold a store should be
    // reaching for one.
    //
    // `node:sqlite` was the third entry until 2026-09-15. Its absence from every SERVICE
    // bundle is now the sharpest evidence available that the port is complete rather than
    // half-done: one surviving `openBillingDb`-shaped import anywhere under `src/` would
    // put the builtin straight back into whichever bundle reached it, and this list is
    // exact. It is NOT absent from `migrate.mjs`, which is the one thing left that reads a
    // `.db` file — so that bundle is named separately below rather than making the rule
    // "no bundle imports it", which would have to be relaxed for the exception and would
    // then no longer catch the regression it exists for.
    expect(external).toEqual(['ws', 'mongodb']);
    const src = Object.fromEntries(built.map((f) => [f, readFileSync(f, 'utf8')]));
    const byName = (name: string) => src[built.find((f) => f.endsWith(`${name}.mjs`))!]!;
    expect(byName('index')).toMatch(/from\s*["']ws["']/);
    for (const name of ['matchsvc', 'billsvc', 'backup', 'adminsvc']) {
      expect(byName(name), name).toMatch(/from\s*["']mongodb["']/);
    }
    for (const name of ['index', 'matchsvc', 'billsvc', 'backup', 'adminsvc']) {
      expect(byName(name), name).not.toMatch(/from\s*["']node:sqlite["']/);
    }
    // The exception, asserted as one. A `migrate.mjs` that does NOT import the builtin is a
    // bundle whose entrypoint is pointed at the wrong file — it would still build, still
    // boot, and still report every table as zero rows on the box.
    expect(byName('migrate')).toMatch(/from\s*["']node:sqlite["']/);
    expect(byName('migrate')).toMatch(/from\s*["']mongodb["']/);
    // The two processes that open no socket must NOT drag `ws` in. For the worker that is
    // the tell that an entrypoint is pointed at the wrong source file; for adminsvc it is
    // sharper, since its whole reason to exist is that it is NOT matchsvc — a `ws` import
    // here would mean the entrypoint had dragged the control plane in behind it, which is
    // the one import that would put a writable `AuthService` in the same process as the
    // read-only console.
    expect(byName('backup')).not.toMatch(/from\s*["']ws["']/);
    expect(byName('adminsvc')).not.toMatch(/from\s*["']ws["']/);
  });
});

describe('each bundle boots as a bare node process and answers /health', () => {
  it('gameserver (index.mjs)', async () => {
    const port = await freePort();
    const body = await boot(join(outdir, 'index.mjs'), port, { PORT: String(port) });
    expect(body).toEqual({ ok: true, service: 'daydayup-gameserver' });
  }, 30_000);

  it('matchsvc (matchsvc.mjs)', async () => {
    // `BB_MONGO_URI` points the bundle at the suite's own mongod, and that is the whole
    // value of this case now: matchsvc CONNECTS before it binds a port, so a bundle that
    // could not load the driver never answers `/health` at all. It is the layer that caught
    // the driver being bundled — esbuild inlined `mongodb`, its `require('timers/promises')`
    // became a dynamic require in ESM output, and every build passed while every deploy
    // died at boot. `scripts/build.mjs` keeps it external for that reason.
    const port = await freePort();
    const body = await boot(join(outdir, 'matchsvc.mjs'), port, {
      MATCH_PORT: String(port),
      BB_MONGO_URI: inject('mongoUri'),
      BB_MONGO_DB_PREFIX: 'deploybundle',
      BB_DB_PATH: join(outdir, 'accounts.db'),
    });
    expect(body).toEqual({ ok: true, service: 'daydayup-matchsvc' });
  }, 30_000);

  it('billsvc (billsvc.mjs)', async () => {
    // Pointed at the suite's own mongod, under a database prefix nothing else uses. The
    // bundle connects at boot and refuses to start without `BB_MONGO_URI` (src/mongo.ts), so
    // this case is also the only place the SHIPPED billing artifact is shown to reach a real
    // cluster rather than only the source being shown to.
    const port = await freePort();
    const body = await boot(join(outdir, 'billsvc.mjs'), port, {
      BILL_PORT: String(port),
      BB_MONGO_URI: inject('mongoUri'),
      BB_MONGO_DB_PREFIX: `bundle${process.pid}`,
      BB_BILLING_DEV_STUB: '1',
    });
    expect(body).toEqual({ ok: true, service: 'daydayup-billsvc' });
  }, 30_000);

  /**
   * adminsvc (design/21 §3), with NO databases on disk — which is the state a fresh box is
   * in, and the one worth booting the real artifact against.
   *
   * `node:sqlite`'s `readOnly` mode does not create a missing file, it throws, and all
   * three files here belong to other processes. So "the console boots, says which handles
   * it has, and serves anyway" is a property of the shipped bundle rather than of a mock,
   * and the three `false`s are the evidence that the null arms in `dbs.ts` are the ones
   * being taken.
   */
  it('adminsvc (adminsvc.mjs) boots with none of its three databases present', async () => {
    const port = await freePort();
    const body = await boot(
      join(outdir, 'adminsvc.mjs'),
      port,
      {
        ADMIN_PORT: String(port),
        BB_ADMIN_PASSWORD: 'x'.repeat(32),
        BB_DB_PATH: join(outdir, 'nothing-here-accounts.db'),
        BB_BILLING_DB_PATH: join(outdir, 'nothing-here-billing.db'),
        BB_ANALYTICS_DB_PATH: join(outdir, 'nothing-here-analytics.db'),
      },
      '/admin/health',
    );
    expect(body).toEqual({
      ok: true,
      service: 'blightbloom-adminsvc',
      // `ops` is the flag store (design/21 §4) and the only handle here that would be
      // CREATED rather than opened — so `BB_OPS_DB_PATH` is left unset above and this is
      // false, which is the state of a deployment that wants no remote switch.
      databases: { accounts: false, billing: false, analytics: false, ops: false },
      sessions: 0,
    });
  }, 30_000);

  /**
   * INVERTED BY THE MONGODB MIGRATION, and left in place saying so.
   *
   * This used to boot matchsvc against a real file and then prove adminsvc could open it
   * read-only — deliberately using matchsvc's own bundle rather than a hand-written schema,
   * because "a console that can read a database this repo's own writer did not create proves
   * nothing about the deployed pair". That argument still holds, and it is exactly why this
   * case cannot be rescued with a fixture: matchsvc writes NO accounts file any more, so
   * there is no longer a pair to prove anything about.
   *
   * What it pins instead is the real, visible consequence of a staged migration: until
   * Stage 4 moves adminsvc onto the cluster, the console's accounts tab is DARK on a live
   * deployment. Writing that down as an assertion is the point — an operator opening the
   * console during the rollout will see it, and this is where it is explained.
   *
   * Stage 4 rewrites this case to boot adminsvc against the cluster and expects
   * `accounts: true` again. If it is still here afterwards, the console is still blind.
   */
  it('adminsvc finds NO accounts database, because matchsvc no longer writes one', async () => {
    const dbPath = join(outdir, 'admin-real-accounts.db');
    const matchPort = await freePort();
    await boot(join(outdir, 'matchsvc.mjs'), matchPort, {
      MATCH_PORT: String(matchPort),
      BB_MONGO_URI: inject('mongoUri'),
      BB_MONGO_DB_PREFIX: 'deployadmin',
      BB_DB_PATH: dbPath,
    });

    const port = await freePort();
    const body = (await boot(
      join(outdir, 'adminsvc.mjs'),
      port,
      {
        ADMIN_PORT: String(port),
        BB_ADMIN_PASSWORD: 'x'.repeat(32),
        BB_DB_PATH: dbPath,
        BB_BILLING_DB_PATH: join(outdir, 'nothing-here-billing.db'),
        BB_ANALYTICS_DB_PATH: join(outdir, 'nothing-here-analytics.db'),
      },
      '/admin/health',
    )) as { databases: Record<string, boolean> };
    expect(body.databases).toEqual({ accounts: false, billing: false, analytics: false, ops: false });
  }, 40_000);

  /**
   * The fail-closed half, against the artifact (design/21 §3.3).
   *
   * Every other assertion about `BB_ADMIN_PASSWORD` is against `assertAdminStartupSafety`
   * as a function. This one is about the PROCESS: a bundle with no credential must exit
   * non-zero with an explanation, not listen with a default. A guard that throws inside a
   * builder nobody calls before `listen` would pass every unit test and ship a public login
   * page with a compiled-in password.
   */
  it('adminsvc REFUSES to start with no credential, and says why', () => {
    const run = spawnSync(process.execPath, [join(outdir, 'adminsvc.mjs')], {
      env: { ...process.env, HOST: '127.0.0.1', ADMIN_PORT: '0', BB_ADMIN_PASSWORD: '' },
      encoding: 'utf8',
      timeout: 15_000,
    });
    expect(run.status).toBe(1);
    expect(`${run.stderr}${run.stdout}`).toContain('BB_ADMIN_PASSWORD');
    // The message has to name the fix, not just the variable — this is the line an operator
    // reads at 2am, and "unset" without "openssl rand -hex 16" is a puzzle.
    expect(`${run.stderr}${run.stdout}`).toContain('openssl rand -hex 16');
  }, 30_000);
});

/**
 * The worker bundle, which has no `/health` route to poll — so this drives the artifact
 * the way compose does: run it, wait for the status file its cycle publishes, then ask the
 * SAME bundle for its health verdict in a second process.
 *
 * This is the one test that exercises `VACUUM INTO` through the built artifact on real
 * `node:sqlite`, as a bare process with only the deploy manifest's dependencies staged —
 * i.e. the only place the backup path is proven to work where it actually runs.
 */
describe('the backup worker bundle snapshots a real database', () => {
  /** A real account document on the suite's own mongod, under this case's own prefix. */
  async function seedCluster(prefix: string): Promise<void> {
    const client = await MongoClient.connect(inject('mongoUri'));
    try {
      await client.db(`${prefix}_accounts`).collection('accounts').insertOne({ _id: 'a1' } as never);
    } finally {
      await client.close();
    }
  }

  it('writes a verified snapshot, then reports itself healthy', async () => {
    const destDir = mkdtempSync(join(tmpdir(), 'bb-backup-dest-'));
    const prefix = `bundlebackup${process.pid}`;
    await seedCluster(prefix);

    const env = {
      // The SHIPPED artifact against a real cluster. It connects before its first cycle, so
      // a bundle that could not load the driver never writes a status file at all — which is
      // the same thing the matchsvc boot case above catches, at the one layer where "the
      // build passed" and "the service runs" are different questions.
      BB_MONGO_URI: inject('mongoUri'),
      BB_MONGO_DB_PREFIX: prefix,
      BB_BACKUP_DIR: destDir,
      // Long enough that the loop sleeps after its first cycle instead of racing the
      // assertions below — the cycle this checks is the one it runs immediately at start.
      BB_BACKUP_INTERVAL_HOURS: '1',
      BB_BACKUP_KEEP: '2',
    };
    const child = spawn(process.execPath, [join(outdir, 'backup.mjs')], {
      env: { ...process.env, NODE_ENV: 'development', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let output = '';
    child.stdout?.on('data', (d) => (output += String(d)));
    child.stderr?.on('data', (d) => (output += String(d)));

    let status: { ok: boolean; sources: { file?: string }[] } | undefined;
    for (let i = 0; i < 100 && status === undefined; i += 1) {
      await sleep(100);
      try {
        status = JSON.parse(readFileSync(join(destDir, 'status.json'), 'utf8'));
      } catch {
        /* not written yet */
      }
    }
    expect(status, `no status.json in 10s:\n${output}`).toBeDefined();
    expect(status!.ok).toBe(true);

    // The snapshot is a real gzipped NDJSON dump: decompress it, parse it, find the
    // document. Asserting on the status file alone would pass on a worker that writes a
    // plausible report and an empty archive — which, since the format became text, is now
    // also a file that LOOKS fine to `ls`.
    const file = join(destDir, status!.sources[0]!.file!);
    const lines = gunzipSync(readFileSync(file)).toString('utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0]!) as { c: string; d: { _id: string } };
    expect(line.c).toBe('accounts');
    expect(line.d._id).toBe('a1');

    // ...and the health mode of the same bundle agrees, which is what compose runs. It is
    // given a URI that answers nothing, on purpose: `--health` must return before it
    // connects, or a network blip turns a container red over a condition its own last cycle
    // already recorded correctly.
    const health = spawnSync(process.execPath, [join(outdir, 'backup.mjs'), '--health'], {
      env: { ...process.env, ...env, BB_MONGO_URI: 'mongodb://127.0.0.1:1/' },
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(health.status, health.stderr).toBe(0);

    child.kill();
    rmSync(destDir, { recursive: true, force: true });
  }, 30_000);

  it('REFUSES to start with no cluster configured, instead of idling green', () => {
    // The silent-no-op failure `src/backup/config.ts` is written against, asserted against
    // the built artifact: exit code 2 and a message, not a container that comes up and
    // backs up nothing. The reachable shape of it changed with the port — it was three
    // unset source PATHS, and it is an unset connection string now — and the contract
    // compose sees did not.
    const run = spawnSync(process.execPath, [join(outdir, 'backup.mjs')], {
      env: { ...process.env, BB_MONGO_URI: '', BB_BACKUP_DIR: outdir },
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('BB_MONGO_URI is not set');
  });
});

/**
 * THE CUTOVER COMMAND, RUN (server/deploy/README.md §5).
 *
 * This is the layer the migration never had. `test/migrate.test.ts` drives `src/migrate/`
 * against a real cluster through an injected reader, which covers every mapping and both
 * refusals — and says nothing at all about whether the thing an operator types on the box
 * exists. It did not: the runbook said `node --import tsx/esm scripts/migrateFromSqlite.ts`
 * inside an image built by `COPY dist/*.mjs ./`, which has no `scripts/`, no TypeScript and
 * no `tsx`. A fully green suite, and a cutover that would have stopped at its first command.
 *
 * So this runs the SHIPPED bundle, as a bare `node` process with only the deploy manifest's
 * dependencies staged, against real `.db` files written by the same builtin that wrote the
 * ones on the box — in the runbook's own order, because the order IS the procedure: dry
 * run, real run, and the refusal that stops a second one.
 *
 * The fixture is deliberately three pairs wide. Each pair is a trap the port would
 * otherwise have shipped, and each is pinned here through the ARTIFACT rather than through
 * `src/`: two accounts where only one has a `provider_id` (the PARTIAL unique index — a
 * stored `null` would admit one of them and refuse the other), two entitlements granted in
 * the same SECOND (`ObjectId.createFromTime` zeroes the tail and would collide them into
 * one document), and two UNSETTLED orders (the same partial-index trap on the payment path,
 * where `billingDb` relied in writing on SQLite treating every NULL as distinct).
 *
 * DELETE THIS DESCRIBE with `src/migrate/` and `scripts/migrateFromSqlite.ts`.
 */
describe('the migration bundle carries real SQLite files onto a real cluster', () => {
  // Its own database prefix, so this never sees — or is seen by — the other cases here.
  const prefix = `bundlemigrate${process.pid}`;
  let dataDir = '';
  /** Both grants land in the same second, which is the collision the id scheme defends. */
  const grantedAt = 1_757_000_000_000;

  /**
   * The legacy files, where compose gave each service its volume. Two of the four is
   * enough: they are the two stores carrying a partial unique index. Leaving `analytics`
   * and `ops` out is not laziness — a store whose file was never there is the third case
   * the migration has to survive, and this is where it is exercised.
   */
  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'bb-legacy-'));
    mkdirSync(join(dataDir, 'matchsvc'), { recursive: true });
    mkdirSync(join(dataDir, 'billsvc'), { recursive: true });

    const accounts = new DatabaseSync(join(dataDir, 'matchsvc', 'accounts.db'));
    accounts.exec(`
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        provider TEXT NOT NULL,
        provider_id TEXT,
        created_at INTEGER NOT NULL,
        display_name TEXT
      );
      CREATE TABLE entitlements (
        id INTEGER PRIMARY KEY,
        account_id TEXT NOT NULL,
        sku TEXT NOT NULL,
        source TEXT NOT NULL,
        order_id TEXT,
        granted_at INTEGER NOT NULL
      );
    `);
    accounts
      .prepare('INSERT INTO accounts VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('acct-local', 'ada', 'hash-a', 'local', null, grantedAt, null);
    accounts
      .prepare('INSERT INTO accounts VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('acct-wechat', 'bo', 'hash-b', 'wechat', 'wx-openid-1', grantedAt, 'Bo');
    for (const [id, sku] of [
      [1, 'starter.pack'],
      [2, 'season.one'],
    ] as const) {
      accounts
        .prepare('INSERT INTO entitlements VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, 'acct-local', sku, 'grant', null, grantedAt);
    }
    accounts.close();

    const billing = new DatabaseSync(join(dataDir, 'billsvc', 'billing.db'));
    billing.exec(`
      CREATE TABLE orders (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        sku TEXT NOT NULL,
        platform TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        currency TEXT NOT NULL,
        state TEXT NOT NULL,
        platform_txn_id TEXT,
        created_at INTEGER NOT NULL,
        settled_at INTEGER
      );
    `);
    for (const id of ['order-1', 'order-2']) {
      billing
        .prepare('INSERT INTO orders VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, 'acct-local', 'season.one', 'paddle', 499, 'EUR', 'created', null, grantedAt, null);
    }
    billing.close();
  });

  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** The bundle, invoked the way the runbook's `docker run … blightbloom:latest` does. */
  function migrate(...args: string[]): { status: number | null; out: string } {
    const run = spawnSync(process.execPath, [join(outdir, 'migrate.mjs'), `--dir=${dataDir}`, ...args], {
      env: { ...process.env, BB_MONGO_URI: inject('mongoUri'), BB_MONGO_DB_PREFIX: prefix },
      encoding: 'utf8',
      timeout: 60_000,
    });
    return { status: run.status, out: `${run.stdout}${run.stderr}` };
  }

  async function withCluster<T>(fn: (client: MongoClient) => Promise<T>): Promise<T> {
    const client = await MongoClient.connect(inject('mongoUri'));
    try {
      return await fn(client);
    } finally {
      await client.close();
    }
  }

  it('--dry-run reads every row, maps it, and writes nothing', async () => {
    const run = migrate('--dry-run');
    expect(run.status, run.out).toBe(0);
    expect(run.out).toContain('DRY RUN');
    // The COUNTS, not just a zero exit: a dry run that silently read nothing looks exactly
    // like a successful one, and on the box that is the difference between a migration and
    // an empty cluster nobody notices until the Players tab is blank.
    expect(run.out).toMatch(/accounts -> accounts\s+2 row/);
    expect(run.out).toMatch(/entitlements -> entitlements\s+2 row/);
    expect(run.out).toMatch(/orders -> orders\s+2 row/);
    // A table no file on this box has. Reported rather than skipped, which is the whole
    // reason `LegacySource.rows` distinguishes an absent table from an empty one.
    expect(run.out).toMatch(/flags -> flags\s+0 row/);

    await withCluster(async (client) => {
      expect(await client.db(`${prefix}_accounts`).collection('accounts').countDocuments({})).toBe(0);
    });
  }, 60_000);

  it('the real run moves every row, and a second run is REFUSED', async () => {
    const run = migrate();
    expect(run.status, run.out).toBe(0);
    expect(run.out).toContain('6 row(s) read');

    await withCluster(async (client) => {
      const accounts = client.db(`${prefix}_accounts`);
      const docs = await accounts.collection('accounts').find({}).sort({ _id: 1 }).toArray();
      expect(docs.map((d) => d._id)).toEqual(['acct-local', 'acct-wechat']);
      // ABSENT, not null. The partial unique index is filtered on `{$type: 'string'}`, so a
      // stored null here would admit the FIRST local account and refuse every one after it
      // — and both of these rows went through the index this same run created.
      expect('providerId' in docs[0]!).toBe(false);
      expect('displayName' in docs[0]!).toBe(false);
      expect(docs[1]!.providerId).toBe('wx-openid-1');

      // Two grants, one second, two documents. `ObjectId.createFromTime` would have made
      // this one document and lost a player's purchase without failing anything.
      const grants = await accounts.collection('entitlements').find({}).sort({ _id: 1 }).toArray();
      expect(grants.map((g) => g.sku)).toEqual(['starter.pack', 'season.one']);
      expect(new Set(grants.map((g) => String(g._id))).size).toBe(2);

      const orders = await client.db(`${prefix}_billing`).collection('orders').find({}).toArray();
      expect(orders).toHaveLength(2);
      for (const order of orders) expect('platformTxnId' in order).toBe(false);
    });

    // The guard that matters most on the box: the files are still there, the command is
    // still in a shell's history, and running it again a week later would overwrite every
    // document with the pre-cutover snapshot. Exit 2, and a message that says so.
    const again = migrate();
    expect(again.status, again.out).toBe(2);
    expect(again.out).toContain('refused');
    expect(again.out).toContain('--force');
  }, 90_000);
});
