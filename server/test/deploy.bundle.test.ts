/**
 * THE DEPLOY BUNDLES ACTUALLY BOOT (design/19-server-platform.md, ROADMAP 9).
 *
 * Everything else in this suite imports TypeScript straight out of `src/` the way `tsx`
 * does in dev. Production runs something else entirely: three flat ESM files that
 * `scripts/build.mjs` produced by collapsing the `@dd/engine` / `@dd/game/*` / `@dd/net/*`
 * workspace graph into one bundle per process, with `ws` and `node:sqlite` deliberately
 * left external. Nothing verified that artifact until this file — a wrong `external`
 * entry, an alias esbuild silently failed to resolve, or an entrypoint pointed at the
 * wrong source all produce a suite that is entirely green and a container that dies on
 * `ERR_MODULE_NOT_FOUND` seconds after `docker compose up`. The whole point of a build
 * step is that its output is not the thing you tested.
 *
 * So: build into a scratch directory (never `server/dist`, which is a real deploy
 * artifact), then BOOT each bundle as its own `node` process — no tsx, no loader, no
 * monorepo `node_modules` beyond the `ws` the deploy image installs for itself — and
 * require it to answer its own `/health`, naming its own service. Answering with the
 * WRONG service name is the failure a smoke test that only checks `ok: true` would wave
 * through, and it is one typo in `build.mjs`'s `entries` away.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  outdir = mkdtempSync(join(tmpdir(), 'ddu-bundle-'));
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
async function boot(file: string, port: number, env: Record<string, string>): Promise<unknown> {
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
      const res = await fetch(`http://127.0.0.1:${port}/health`);
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
    expect(built).toHaveLength(4);
    expect(entries.map((e: { out: string }) => e.out)).toEqual(['index', 'matchsvc', 'billsvc', 'backup']);
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
    // native/WASM fallback); `node:sqlite` is a builtin. Both are then satisfied by
    // deploy/package.json + Node itself. Asserted per-bundle rather than in aggregate,
    // because only the two DB-backed processes should be reaching for sqlite at all.
    expect(external).toEqual(['ws', 'node:sqlite']);
    const src = Object.fromEntries(built.map((f) => [f, readFileSync(f, 'utf8')]));
    const byName = (name: string) => src[built.find((f) => f.endsWith(`${name}.mjs`))!]!;
    expect(byName('index')).toMatch(/from\s*["']ws["']/);
    expect(byName('matchsvc')).toMatch(/from\s*["']node:sqlite["']/);
    expect(byName('billsvc')).toMatch(/from\s*["']node:sqlite["']/);
    // The backup worker reads both databases through the same builtin — and must NOT drag
    // `ws` in, since bundling a websocket library into a process that opens no socket is
    // the tell that an entrypoint is pointed at the wrong source file.
    expect(byName('backup')).toMatch(/from\s*["']node:sqlite["']/);
    expect(byName('backup')).not.toMatch(/from\s*["']ws["']/);
  });
});

describe('each bundle boots as a bare node process and answers /health', () => {
  it('gameserver (index.mjs)', async () => {
    const port = await freePort();
    const body = await boot(join(outdir, 'index.mjs'), port, { PORT: String(port) });
    expect(body).toEqual({ ok: true, service: 'daydayup-gameserver' });
  }, 30_000);

  it('matchsvc (matchsvc.mjs)', async () => {
    const port = await freePort();
    const body = await boot(join(outdir, 'matchsvc.mjs'), port, {
      MATCH_PORT: String(port),
      DDU_DB_PATH: join(outdir, 'accounts.db'),
    });
    expect(body).toEqual({ ok: true, service: 'daydayup-matchsvc' });
  }, 30_000);

  it('billsvc (billsvc.mjs)', async () => {
    const port = await freePort();
    const body = await boot(join(outdir, 'billsvc.mjs'), port, {
      BILL_PORT: String(port),
      DDU_BILLING_DB_PATH: join(outdir, 'billing.db'),
      DDU_BILLING_DEV_STUB: '1',
    });
    expect(body).toEqual({ ok: true, service: 'daydayup-billsvc' });
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
  /** A real SQLite file with a row in it, written by the same builtin the server uses. */
  function seedDatabase(file: string): void {
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE accounts (id TEXT PRIMARY KEY); INSERT INTO accounts VALUES ('a1');`);
    db.close();
  }

  it('writes a verified snapshot, then reports itself healthy', async () => {
    const sourceDir = mkdtempSync(join(tmpdir(), 'ddu-backup-src-'));
    const destDir = mkdtempSync(join(tmpdir(), 'ddu-backup-dest-'));
    const source = join(sourceDir, 'accounts.db');
    seedDatabase(source);

    const env = {
      DDU_DB_PATH: source,
      DDU_BACKUP_DIR: destDir,
      // Long enough that the loop sleeps after its first cycle instead of racing the
      // assertions below — the cycle this checks is the one it runs immediately at start.
      DDU_BACKUP_INTERVAL_HOURS: '1',
      DDU_BACKUP_KEEP: '2',
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

    // The snapshot is a real gzipped SQLite file: decompress it, open it, read the row
    // back. Asserting on the status file alone would pass on a worker that writes a
    // plausible report and an empty archive.
    const file = join(destDir, status!.sources[0]!.file!);
    const restored = join(destDir, 'restored.db');
    writeFileSync(restored, gunzipSync(readFileSync(file)));
    const db = new DatabaseSync(restored, { readOnly: true });
    expect(db.prepare('SELECT id FROM accounts').all()).toEqual([{ id: 'a1' }]);
    db.close();

    // ...and the health mode of the same bundle agrees, which is what compose runs.
    const health = spawnSync(process.execPath, [join(outdir, 'backup.mjs'), '--health'], {
      env: { ...process.env, ...env },
      encoding: 'utf8',
    });
    expect(health.status, health.stderr).toBe(0);

    child.kill();
    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(destDir, { recursive: true, force: true });
  }, 30_000);

  it('REFUSES to start with no source configured, instead of idling green', () => {
    // The silent-no-op failure `src/backup/config.ts` is written against, asserted against
    // the built artifact: exit code 2 and a message, not a container that comes up and
    // backs up nothing.
    const run = spawnSync(process.execPath, [join(outdir, 'backup.mjs')], {
      env: { ...process.env, DDU_DB_PATH: '', DDU_BILLING_DB_PATH: '', DDU_BACKUP_DIR: outdir },
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('no databases to back up');
  });
});
