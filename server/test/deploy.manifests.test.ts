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
  /** Empty for a service built from this repo's own Dockerfile (`build: .`). */
  image: string;
  command: string[];
  env: Record<string, string>;
  expose: string[];
  healthcheck: string;
  envFile: string | null;
  /** Each bind mount's host side (`./data/matchsvc`) and whether it is `:ro`. Named
   *  volumes (`loki-data:/loki`) and absolute host paths are not collected. */
  volumes: Array<{ host: string; readonly: boolean }>;
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
  let section: 'env' | 'expose' | 'healthcheck' | 'volumes' | 'command' | null = null;
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
      service = { image: '', command: [], env: {}, expose: [], healthcheck: '', envFile: null, volumes: [] };
      out[name] = service;
      section = null;
      continue;
    }
    if (!service) continue;

    if (indent === 4) {
      section = null;
      const [key, ...rest] = line.split(':');
      const value = rest.join(':').trim();
      // A command is written either inline as a JSON array (`["node", "index.mjs"]`) or as
      // a YAML block list, which the observability services use for their long flag lists.
      // Parsing the first shape only used to be safe because every service had it; with the
      // second present, `JSON.parse('')` throws and takes the whole FILE down — every
      // assertion here included. Handled rather than assumed.
      if (key === 'command' && value.startsWith('[')) service.command = JSON.parse(value) as string[];
      else if (key === 'command') section = 'command';
      else if (key === 'image') service.image = value;
      else if (key === 'env_file') service.envFile = value;
      else if (key === 'environment') section = 'env';
      else if (key === 'expose') section = 'expose';
      else if (key === 'healthcheck') section = 'healthcheck';
      else if (key === 'volumes') section = 'volumes';
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
    } else if (section === 'command') {
      const m = /^-\s*(.+)$/.exec(line);
      if (m) service.command.push(m[1]!);
    } else if (section === 'volumes') {
      // `- ./data/matchsvc:/sources/matchsvc:ro` -> `{ host: './data/matchsvc', readonly: true }`.
      const m = /^-\s*(\.[^:]+):(.*)$/.exec(line);
      if (m) service.volumes.push({ host: m[1]!, readonly: m[2]!.endsWith(':ro') });
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
/**
 * The observability stack (design/19 §10): off-the-shelf images that run no code from this
 * repo. Almost every assertion in this file is about OUR bundles — a bundle name, a port an
 * entrypoint reads, an env var `src/` looks up — and none of that applies to Grafana. Kept
 * as an explicit list for the same reason the two above are: adding a service should force
 * a decision about which kind it is, and deriving the category from "has no `build:`" would
 * silently reclassify one of ours the day somebody pins it to a published image.
 */
const OBS_SERVICES = ['obs-alloy', 'obs-grafana', 'obs-loki', 'obs-prometheus'] as const;
const APP_SERVICES = [...HTTP_SERVICES, ...WORKER_SERVICES] as const;
/** The port each observability service listens on, cross-checked against `expose` below. */
const OBS_PORT: Record<string, string> = {
  'obs-loki': '3100',
  'obs-alloy': '12345',
  'obs-prometheus': '9090',
  'obs-grafana': '3000',
};

describe('the compose reader actually read something', () => {
  it('found all eight services, each fully populated', () => {
    // Every other test in this file is vacuous if this one is wrong: an empty `env` makes
    // "no unknown env var" trivially true, an empty `command` makes the bundle-name check
    // an assertion about nothing. Pinned to the exact shape rather than "at least one".
    expect(Object.keys(services).sort()).toEqual([...APP_SERVICES, ...OBS_SERVICES].sort());
    for (const name of APP_SERVICES) {
      const svc = services[name]!;
      expect(svc.command, name).toHaveLength(2);
      expect(Object.keys(svc.env).length, name).toBeGreaterThanOrEqual(3);
      expect(svc.healthcheck, name).not.toBe('');
      expect(svc.envFile, name).toBe('.env');
    }
    for (const name of HTTP_SERVICES) {
      expect(services[name]!.expose, name).toHaveLength(1);
      expect(services[name]!.healthcheck, name).toContain('/health');
    }
    for (const name of OBS_SERVICES) {
      const svc = services[name]!;
      // No `build:`, so an unpinned image is a deploy whose bytes change without a commit.
      expect(svc.image, name).not.toBe('');
      expect(svc.image, `${name} is unpinned`).not.toMatch(/(:latest$|^[^:]+$)/);
      expect(svc.command.length + Object.keys(svc.env).length, name).toBeGreaterThan(0);
      expect(svc.expose, name).toEqual([OBS_PORT[name]]);
      // Every service is verified after a deploy, but not all of them the same way, and the
      // exception is not a relaxation: `obs-alloy`'s image contains no HTTP client at all
      // (no wget/curl/nc/busybox, and /bin/sh is dash, so not even /dev/tcp), so a Docker
      // healthcheck — which runs INSIDE the container — can only ever exit 127 and report a
      // working collector as permanently unhealthy. It is checked from outside instead, by
      // asking Prometheus whether its scrape of it is up. So the rule asserted here is
      // "either a healthcheck, or a named check in the deploy script" — which is what stops
      // a service from silently having neither.
      if (svc.healthcheck === '') {
        expect(ciDeploy, `${name} has no healthcheck and no deploy-time check either`).toContain(name);
      }
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
    expect(services.backup!.env.BB_BACKUP_DIR).toBe('/backups');
    expect(mounts.some((p) => p[0] === './backups' && p[1] === '/backups' && p[2] === undefined)).toBe(true);
  });

  it('every bind-mounted state dir is one the deploy script makes container-writable', () => {
    // Docker creates a MISSING bind-mount source as `root:root`, and the mount then HIDES
    // the image's own `chown node:node /data /backups` — so a state dir the host does not
    // already own as uid 1000 is one the container cannot write to, and it finds out at
    // runtime. Not hypothetical: `backups/` landed root-owned from the 2026-09-07 deploy
    // that introduced the worker, which then spent 18 hours failing EACCES on every write
    // — zero snapshots — while CI reported success. `ci-deploy.sh` normalises the ownership
    // now; this pins its list to the mounts that actually exist, because a mount added to
    // compose alone reintroduces precisely the original bug.
    // Two kinds of bind mount now, and only one of them needs an ownership rule:
    // WRITABLE state (`./data/*`, `./backups`) which a container writes as uid 1000, and
    // READ-ONLY config (`./monitoring/*`) which it only reads. Splitting them here rather
    // than listing both is what keeps the rule stated as a rule — a new writable mount is
    // caught, and a new config file is not made to look like one.
    // Grouped by HOST path, not by mount, because the same directory is mounted twice with
    // different modes on purpose: `./data/matchsvc` is writable for matchsvc and `:ro` for
    // the backup worker. What decides whether it needs an ownership rule is whether ANY
    // container writes it — so a host dir counts as writable if even one of its mounts is.
    const all = Object.values(services).flatMap((s) => s.volumes);
    const hosts = [...new Set(all.map((v) => v.host))];
    const mountsOf = (h: string): Array<{ readonly: boolean }> => all.filter((v) => v.host === h);
    const rw = hosts.filter((h) => mountsOf(h).some((v) => !v.readonly));
    const ro = hosts.filter((h) => mountsOf(h).every((v) => v.readonly));
    expect(rw.sort()).toEqual(['./backups', './data/billsvc', './data/matchsvc']);
    expect(ro.length).toBeGreaterThan(0);
    for (const host of ro) expect(host, 'a never-written mount is config, and config lives here').toMatch(/^\.\/monitoring\//);
    const fixed = /for dir in (.+); do/.exec(ciDeploy)?.[1]?.split(' ') ?? [];
    for (const host of rw) {
      expect(fixed, `${host} is bind-mounted writable but never made writable`).toContain(host.slice('./'.length));
    }
    // ...and the config mounts must NOT be chowned: they are tracked files the deploy
    // replaces wholesale, and handing them to a container user would be a change to the
    // repo's own content on the box.
    for (const host of ro) expect(fixed).not.toContain(host.slice('./'.length));
    // The uid is written as a literal `1000` in a shell script, which is only correct while
    // the image still runs as the node image's own `node` user. If that USER line changes,
    // the chown starts handing every state dir to a user the container is not — so the two
    // are asserted together rather than left as a coincidence.
    expect(dockerfile).toMatch(/^USER node$/m);
    expect(ciDeploy).toContain('1000:1000');
  });
});

describe('the bundle filenames', () => {
  it('are the same set in build.mjs, compose and the deploy script', () => {
    // These names exist independently in three files and are matched by nothing at build
    // time: renaming an entrypoint in build.mjs alone ships an image whose `command:`
    // names a file that is no longer there.
    const fromCompose = APP_SERVICES.map((n) => services[n]!.command[1]);
    expect(new Set(fromCompose)).toEqual(new Set(bundleNames));
    for (const name of APP_SERVICES) expect(services[name]!.command[0]).toBe('node');
    for (const name of bundleNames) expect(ciDeploy).toContain(`dist/${name}`);
  });

  it('are what CI actually ships and what the far end checks for', () => {
    // The forced command refuses a payload missing any of these (no half-finished deploy),
    // so its list and the workflow's `tar` list have to agree — a file added to one and not
    // the other either never arrives or aborts every deploy.
    const shipped = /tar czf - -C server (.+?)\s*\|/.exec(workflow)?.[1]?.split(/\s+/) ?? [];
    expect(shipped).toEqual(['dist', 'Dockerfile', 'docker-compose.yml', 'deploy/package.json', 'monitoring']);
    const required = /for path in ([^\n]+); do/.exec(ciDeploy)?.[1]?.split(/\s+/) ?? [];
    expect(required).toHaveLength(bundleNames.length + 4);
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
          for (const m of text.matchAll(/'(BB_[A-Z0-9_]+)'/g)) names.add(m[1]!);
        }
      }
    };
    walk(join(serverRoot, 'src'));
    return names;
  }

  it('are all names the code actually reads', () => {
    const known = readByCode();
    expect(known.size).toBeGreaterThan(5); // the scan found something to compare against
    // APP services only. The observability containers read `GF_*`/`LOKI_*` names defined by
    // their own images, which nothing in `src/` will ever mention — sweeping them in here
    // would either fail forever or force the scan to be loosened until it caught nothing.
    for (const name of APP_SERVICES) {
      for (const key of Object.keys(services[name]!.env)) {
        expect([...known], `${name}.${key} is set in compose but read nowhere in src/`).toContain(key);
      }
    }
  });

  it('never inline a secret — those come from the untracked .env', () => {
    // The ticket secret and the internal-auth key are the two credentials that make every
    // trust boundary in the server real. A tracked compose file is the wrong place for
    // either, and `env_file: .env` (asserted above) is how they arrive instead.
    expect(compose).not.toContain('BB_TICKET_SECRET');
    expect(compose).not.toContain('BB_INTERNAL_KEY');
    // Grafana's admin password is the third credential, and the only one compose mentions
    // by name at all. It must appear ONLY as an interpolation of the untracked .env — and
    // with `:?`, which makes a missing value refuse the deploy rather than boot the
    // image's own admin/admin on a login page that is on the public internet.
    const grafanaPassword = /GF_SECURITY_ADMIN_PASSWORD:\s*(.+)/.exec(compose)?.[1] ?? '';
    expect(grafanaPassword).toMatch(/^\$\{BB_GRAFANA_ADMIN_PASSWORD:\?/);
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
    expect(internal.length).toBeGreaterThanOrEqual(3);
    for (const { name, key, url } of internal) {
      const peer = services[url.hostname];
      expect(peer, `${name}.${key} points at unknown service ${url.hostname}`).toBeDefined();
      // An app service declares its port through the env var its entrypoint reads; an
      // observability image's port is fixed by the image, so `expose` is the declaration.
      const expected = PORT_VAR[url.hostname] ? peer!.env[PORT_VAR[url.hostname]!] : peer!.expose[0];
      expect(url.port, `${name}.${key}`).toBe(expected);
    }
  });

  it('sends clients to the PUBLIC gameserver address, not the container hop', () => {
    // matchsvc mints tickets a browser redeems, so this one is deliberately NOT an internal
    // name — it is the only cross-service URL in the file that must not resolve in Docker.
    const url = new URL(services.matchsvc!.env.BB_GAMESERVER_URL!);
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
    expect(billsvcEnv().BB_BILLING_DEV_STUB).toBe('1');
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
    for (const name of Object.keys(services).filter((n) => n !== 'billsvc')) {
      expect(() => assertBillingStartupSafety({ ...services[name]!.env, NODE_ENV: 'production' })).not.toThrow();
    }
  });
});
