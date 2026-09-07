/**
 * THE DEPLOY MANIFESTS AGREE WITH THE CODE (design/19-server-platform.md, ROADMAP 9).
 *
 * The same handful of facts — three bundle filenames, three ports, the externals, the
 * env var names — are written down in FIVE places that no compiler compares:
 * `scripts/build.mjs`, `Dockerfile`, `docker-compose.yml`, `deploy/package.json` and
 * `deploy/ci-deploy.sh` (plus the CI workflow that feeds the last one). Every one of them
 * is plain text to `tsc`, none is imported by anything under `src/`, and the way they
 * break is silent: a renamed env var leaves compose quietly passing a value nobody reads
 * and the process running on its default, a copy-pasted service block leaves a healthcheck
 * polling its neighbour's port and reporting a dead container healthy.
 *
 * Sibling to `deploy.bundle.test.ts`, which boots the real artifact. This one never spawns
 * anything — it reads the files and cross-checks them, which is why it costs milliseconds
 * and can afford to be exhaustive.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { assertBillingStartupSafety, BillingStartupError } from '../src/billsvc/startupGuard';
// @ts-expect-error — plain .mjs build script, the same untyped-helper import vitest.config.ts uses.
import { entries, external, target } from '../scripts/build.mjs';

const serverRoot = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string): string => readFileSync(join(serverRoot, rel), 'utf8');

const compose = read('docker-compose.yml');
const dockerfile = read('Dockerfile');
const ciDeploy = read('deploy/ci-deploy.sh');
const deployPkg = JSON.parse(read('deploy/package.json')) as { dependencies: Record<string, string> };
const workflow = read('../.github/workflows/server-deploy.yml');

const bundleNames: string[] = (entries as Array<{ out: string }>).map((e) => `${e.out}.mjs`);

// ───────────────────────── a deliberately small compose reader ─────────────────────────

interface ComposeService {
  command: string[];
  env: Record<string, string>;
  expose: string[];
  healthcheck: string;
  envFile: string | null;
}

/**
 * Reads the five things this file asserts on out of `docker-compose.yml`, by indentation.
 * Hand-rolled rather than pulling in a YAML parser: the server workspace has two runtime
 * dependencies and adding a third to read one file it already ships is a worse trade than
 * the 40 lines below. The risk of a hand-rolled reader is that a reformat makes it match
 * NOTHING and every assertion here then passes over an empty set — which is exactly what
 * the first `describe` exists to prevent.
 */
function parseCompose(yaml: string): Record<string, ComposeService> {
  const out: Record<string, ComposeService> = {};
  let service: ComposeService | null = null;
  let section: 'env' | 'expose' | 'healthcheck' | null = null;
  let inServices = false;

  for (const raw of yaml.split(/\r?\n/)) {
    if (/^\s*#/.test(raw) || raw.trim() === '') continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();

    if (indent === 0) {
      inServices = line === 'services:';
      service = null;
      continue;
    }
    if (!inServices) continue;

    if (indent === 2) {
      const name = /^([\w-]+):$/.exec(line)?.[1];
      if (!name) continue;
      service = { command: [], env: {}, expose: [], healthcheck: '', envFile: null };
      out[name] = service;
      section = null;
      continue;
    }
    if (!service) continue;

    if (indent === 4) {
      section = null;
      const [key, ...rest] = line.split(':');
      const value = rest.join(':').trim();
      if (key === 'command') service.command = JSON.parse(value) as string[];
      else if (key === 'env_file') service.envFile = value;
      else if (key === 'environment') section = 'env';
      else if (key === 'expose') section = 'expose';
      else if (key === 'healthcheck') section = 'healthcheck';
      continue;
    }

    if (section === 'env') {
      const m = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
      if (m) service.env[m[1]!] = m[2]!.replace(/^"(.*)"$/, '$1');
    } else if (section === 'expose') {
      const m = /^-\s*"?(\d+)"?$/.exec(line);
      if (m) service.expose.push(m[1]!);
    } else if (section === 'healthcheck' && line.startsWith('test:')) {
      service.healthcheck = line.slice('test:'.length).trim();
    }
  }
  return out;
}

const services = parseCompose(compose);

/** The port env var each process reads for its own listener (src/index.ts, matchsvc.ts, billsvc/main.ts). */
const PORT_VAR: Record<string, string> = { gameserver: 'PORT', matchsvc: 'MATCH_PORT', billsvc: 'BILL_PORT' };

/**
 * The services that serve HTTP, which is every assertion about ports, `expose` and a
 * `/health` route. `backup` (2026-09-07) is a WORKER: no port, no route, and its
 * healthcheck runs its own bundle. Kept as an explicit list rather than "whatever has a
 * PORT_VAR entry" so that adding a service forces a decision about which kind it is —
 * derive it and a new HTTP service that simply forgot its port silently becomes a worker.
 */
const HTTP_SERVICES = ['billsvc', 'gameserver', 'matchsvc'] as const;
const WORKER_SERVICES = ['backup'] as const;

describe('the compose reader actually read something', () => {
  it('found all four services, each fully populated', () => {
    // Every other test in this file is vacuous if this one is wrong: an empty `env` makes
    // "no unknown env var" trivially true, an empty `command` makes the bundle-name check
    // an assertion about nothing. Pinned to the exact shape rather than "at least one".
    expect(Object.keys(services).sort()).toEqual([...HTTP_SERVICES, ...WORKER_SERVICES].sort());
    for (const [name, svc] of Object.entries(services)) {
      expect(svc.command, name).toHaveLength(2);
      expect(Object.keys(svc.env).length, name).toBeGreaterThanOrEqual(3);
      expect(svc.healthcheck, name).not.toBe('');
      expect(svc.envFile, name).toBe('.env');
    }
    for (const name of HTTP_SERVICES) {
      expect(services[name]!.expose, name).toHaveLength(1);
      expect(services[name]!.healthcheck, name).toContain('/health');
    }
  });

  it('the worker exposes no port and healthchecks itself', () => {
    // Both halves matter. A worker that `expose`s a port is a copy-paste leftover; a worker
    // whose healthcheck polls `/health` would report a container that serves nothing as
    // permanently unhealthy, and `restart: unless-stopped` would then loop it forever.
    for (const name of WORKER_SERVICES) {
      const svc = services[name]!;
      expect(svc.expose, name).toEqual([]);
      expect(svc.healthcheck, name).not.toContain('/health');
      // It asks the SAME bundle it runs — a second implementation of the health rule (an
      // inline `node -e` in this file) is one no test could reach.
      expect(svc.healthcheck, name).toContain(svc.command[1]!);
      expect(svc.healthcheck, name).toContain('--health');
    }
  });

  it('the backup worker mounts its sources READ-ONLY and writes only to its own volume', () => {
    // The property that makes this container safe to run beside a live database at all
    // (src/backup/snapshot.ts: `VACUUM INTO` works through a read-only handle). A `:ro`
    // dropped from these two lines is invisible until the day the worker has a bug.
    const block = /\n  backup:\n([\s\S]*?)\n(?:  [\w-]+:|networks:)/.exec(compose)?.[1] ?? '';
    expect(block).not.toBe('');
    // Only the `volumes:` list — `networks:` is a bullet list too, and matching every
    // bullet in the block swept `- wnet` in as a fourth "mount" (caught by the length
    // assertion below, which is why it is an exact count and not `>= 2`).
    const volumes = /\n    volumes:\n([\s\S]*?)\n    [a-z_]+:/.exec(block)?.[1] ?? '';
    // `host:container[:mode]`, split on the colons rather than matched with two greedy
    // groups (which quietly makes `mode` the whole container path).
    const mounts = [...volumes.matchAll(/^\s+- (\S+)$/gm)].map(([, spec]) => spec!.split(':'));
    expect(mounts).toHaveLength(3);
    for (const parts of mounts) {
      expect(parts.length, parts.join(':')).toBeGreaterThanOrEqual(2);
      const [host, , mode] = parts as [string, string, string | undefined];
      // Every mount of a service DATA directory is read-only; the only writable one is the
      // backup directory itself.
      expect(mode === 'ro', parts.join(':')).toBe(host.startsWith('./data/'));
    }
    expect(services.backup!.env.DDU_BACKUP_DIR).toBe('/backups');
    expect(mounts.some((p) => p[0] === './backups' && p[1] === '/backups' && p[2] === undefined)).toBe(true);
  });
});

describe('the bundle filenames', () => {
  it('are the same set in build.mjs, compose and the deploy script', () => {
    // These names exist independently in three files and are matched by nothing at build
    // time: renaming an entrypoint in build.mjs alone ships an image whose `command:`
    // names a file that is no longer there.
    const fromCompose = Object.values(services).map((s) => s.command[1]);
    expect(new Set(fromCompose)).toEqual(new Set(bundleNames));
    for (const svc of Object.values(services)) expect(svc.command[0]).toBe('node');
    for (const name of bundleNames) expect(ciDeploy).toContain(`dist/${name}`);
  });

  it('are what CI actually ships and what the far end checks for', () => {
    // The forced command refuses a payload missing any of these (no half-finished deploy),
    // so its list and the workflow's `tar` list have to agree — a file added to one and not
    // the other either never arrives or aborts every deploy.
    const shipped = /tar czf - -C server (.+?)\s*\|/.exec(workflow)?.[1]?.split(/\s+/) ?? [];
    expect(shipped).toEqual(['dist', 'Dockerfile', 'docker-compose.yml', 'deploy/package.json']);
    const required = /for path in ([^\n]+); do/.exec(ciDeploy)?.[1]?.split(/\s+/) ?? [];
    expect(required).toHaveLength(bundleNames.length + 3);
    for (const path of required) {
      const top = path.split('/')[0]!;
      expect(shipped.some((s) => s === path || s === top), `${path} is checked for but never sent`).toBe(true);
    }
  });
});

describe('externals and the runtime package.json', () => {
  it('declares exactly the non-builtin externals, no more', () => {
    // Under-declaring is the boot failure `deploy.bundle.test.ts` reproduces. Over-declaring
    // is quieter and still wrong: an unused dependency in the image is one more thing
    // `npm install` can fail on, on a box this project only borrows.
    const needed = (external as string[]).filter((m) => !m.startsWith('node:'));
    expect(Object.keys(deployPkg.dependencies).sort()).toEqual([...needed].sort());
  });

  it('pins each dependency to an exact version', () => {
    // No `^`: the image is rebuilt on every deploy, so a range means the deployed bytes can
    // change without a commit — the one property that makes a rollback meaningless.
    for (const [dep, range] of Object.entries(deployPkg.dependencies)) {
      expect(range, dep).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});

describe('Dockerfile', () => {
  it('runs a Node at least as new as the bundles target', () => {
    // `node:sqlite` is what sets this floor (src/db.ts) — an older base image starts fine
    // and then throws on the first DB open, i.e. after the healthcheck has gone green.
    const image = /^FROM node:(\d+)-/m.exec(dockerfile);
    expect(image).not.toBeNull();
    const targetMajor = Number(/^node(\d+)$/.exec(target as string)![1]);
    expect(Number(image![1])).toBeGreaterThanOrEqual(targetMajor);
  });

  it('copies the runtime manifest and the bundles, and drops root', () => {
    expect(dockerfile).toMatch(/COPY deploy\/package\.json \.\/package\.json/);
    expect(dockerfile).toMatch(/COPY dist\/\*\.mjs \.\//);
    expect(dockerfile).toMatch(/^USER node$/m);
    // Nothing of the monorepo may sneak in: the image has no TypeScript and no aliases.
    expect(dockerfile).not.toMatch(/^COPY\s+(src|\.\.|node_modules)/m);
  });
});

describe('compose env vars', () => {
  /** Every name the server source actually reads, from either access shape. */
  function readByCode(): Set<string> {
    const names = new Set<string>();
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        if (statSync(p).isDirectory()) walk(p);
        else if (e.endsWith('.ts')) {
          const text = readFileSync(p, 'utf8');
          for (const m of text.matchAll(/\bprocess\.env\.([A-Z][A-Z0-9_]*)/g)) names.add(m[1]!);
          for (const m of text.matchAll(/\benv\.([A-Z][A-Z0-9_]*)/g)) names.add(m[1]!);
          // `startupGuard`'s DEV_ONLY_FLAGS reaches its names through `env[name]`.
          for (const m of text.matchAll(/'(DDU_[A-Z0-9_]+)'/g)) names.add(m[1]!);
        }
      }
    };
    walk(join(serverRoot, 'src'));
    return names;
  }

  it('are all names the code actually reads', () => {
    const known = readByCode();
    expect(known.size).toBeGreaterThan(5); // the scan found something to compare against
    for (const [name, svc] of Object.entries(services)) {
      for (const key of Object.keys(svc.env)) {
        expect([...known], `${name}.${key} is set in compose but read nowhere in src/`).toContain(key);
      }
    }
  });

  it('never inline a secret — those come from the untracked .env', () => {
    // The ticket secret and the internal-auth key are the two credentials that make every
    // trust boundary in the server real. A tracked compose file is the wrong place for
    // either, and `env_file: .env` (asserted above) is how they arrive instead.
    expect(compose).not.toContain('DDU_TICKET_SECRET');
    expect(compose).not.toContain('DDU_INTERNAL_KEY');
  });
});

describe('ports and internal addresses', () => {
  it('each HTTP service healthchecks and exposes its OWN port', () => {
    // The copy-pasted-block bug: a healthcheck polling the neighbour's port reports a dead
    // container healthy, which is worse than having no healthcheck at all.
    for (const name of HTTP_SERVICES) {
      const svc = services[name]!;
      const port = svc.env[PORT_VAR[name]!];
      expect(port, `${name} sets no ${PORT_VAR[name]}`).toBeTruthy();
      expect(svc.expose).toEqual([port]);
      expect(svc.healthcheck).toContain(`http://127.0.0.1:${port}/health`);
    }
  });

  it('every internal URL names a real service at the port that service listens on', () => {
    // `http://matchsvc:8788` is resolved by Docker's own DNS — a stale name or port fails
    // only at the first cross-service call, which for billsvc is the first delivery of a
    // thing somebody paid for.
    const internal = Object.entries(services).flatMap(([name, svc]) =>
      Object.entries(svc.env)
        .filter(([, v]) => v.startsWith('http://'))
        .map(([key, v]) => ({ name, key, url: new URL(v) })),
    );
    expect(internal.length).toBeGreaterThanOrEqual(2);
    for (const { name, key, url } of internal) {
      const peer = services[url.hostname];
      expect(peer, `${name}.${key} points at unknown service ${url.hostname}`).toBeDefined();
      expect(url.port, `${name}.${key}`).toBe(peer!.env[PORT_VAR[url.hostname]!]);
    }
  });

  it('sends clients to the PUBLIC gameserver address, not the container hop', () => {
    // matchsvc mints tickets a browser redeems, so this one is deliberately NOT an internal
    // name — it is the only cross-service URL in the file that must not resolve in Docker.
    const url = new URL(services.matchsvc!.env.DDU_GAMESERVER_URL!);
    expect(url.protocol).toBe('wss:');
    expect(services[url.hostname]).toBeUndefined();
  });
});

describe("billsvc's compose environment against the real startup guard", () => {
  const billsvcEnv = (): Record<string, string> => ({ ...services.billsvc!.env });

  it('boots — the deployed env is one the guard accepts', () => {
    // Not a restatement of the compose file: this feeds the shipped env to the shipped
    // predicate. The deploy runs the dev receipt stub on purpose (no Paddle credential
    // exists yet, design/19 §9), and that is only legal below production.
    expect(billsvcEnv().DDU_BILLING_DEV_STUB).toBe('1');
    expect(() => assertBillingStartupSafety(billsvcEnv())).not.toThrow();
  });

  it('would REFUSE to boot if that same env were flipped to production', () => {
    // The control. Without it the test above passes just as happily against a guard that
    // never throws at all — which is the state a broken refactor of startupGuard leaves.
    expect(() => assertBillingStartupSafety({ ...billsvcEnv(), NODE_ENV: 'production' })).toThrow(
      BillingStartupError,
    );
  });

  it('is the only service carrying a dev-only flag', () => {
    for (const name of ['gameserver', 'matchsvc', 'backup']) {
      expect(() => assertBillingStartupSafety({ ...services[name]!.env, NODE_ENV: 'production' })).not.toThrow();
    }
  });
});
