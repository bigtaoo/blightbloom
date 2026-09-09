/**
 * THE OBSERVABILITY CONFIGS AGREE WITH COMPOSE, AND WITH THE CODE (design/19 §10).
 *
 * Sibling to `deploy.manifests.test.ts`, and the same argument one layer over: the log
 * pipeline is six files that reference each other entirely through text no compiler
 * compares — a service name in a URL, a port in a scrape target, a regex in a collector
 * that has to match a format produced by a TypeScript module, a datasource uid in a
 * dashboard. Every one of them fails the same way: silently, as a panel that shows nothing,
 * which is indistinguishable from a quiet week. That is the exact failure this whole layer
 * was built to end, so it cannot be the failure mode of the layer itself.
 *
 * Nothing here starts a container.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createLogger } from '../src/log';

const serverRoot = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string): string => readFileSync(join(serverRoot, rel), 'utf8');

const compose = read('docker-compose.yml');
const alloy = read('monitoring/alloy/config.alloy');
const loki = read('monitoring/loki/config.yml');
const prometheus = read('monitoring/prometheus/prometheus.yml');
const datasources = read('monitoring/grafana/provisioning/datasources/datasources.yml');
const ciDeploy = read('deploy/ci-deploy.sh');

/** Every `- ./monitoring/...:<container path>[:ro]` bind mount in compose. */
const configMounts = [...compose.matchAll(/^\s+- (\.\/monitoring\/[^:\s]+):([^:\s]+)(:ro)?$/gm)].map((m) => ({
  host: m[1]!,
  container: m[2]!,
  readonly: m[3] === ':ro',
}));

describe('the config files compose mounts', () => {
  it('found the mounts at all', () => {
    // The vacuity guard. Every assertion below iterates this list, so a reformat that makes
    // the regex match nothing would turn the whole file green over an empty set.
    expect(configMounts.length).toBeGreaterThanOrEqual(5);
  });

  it('all exist on disk', () => {
    // A missing source is not an error to Docker: it CREATES it, as a root-owned empty
    // directory, and mounts that over the image's own default. Loki then starts with no
    // config and Grafana with no datasource, both of them healthy and both of them useless.
    for (const m of configMounts) {
      expect(existsSync(join(serverRoot, m.host)), `${m.host} is mounted but does not exist`).toBe(true);
    }
  });

  it('are all read-only', () => {
    // These are tracked files the deploy replaces wholesale. A container that can write one
    // is a container that can make the box disagree with the repo, invisibly.
    for (const m of configMounts) expect(m.readonly, m.host).toBe(true);
  });

  it('are shipped by the deploy and required by the forced command', () => {
    // Without both, the box keeps whatever config it had — and a dashboard edit that CI
    // reports as deployed is a dashboard nobody is looking at.
    expect(ciDeploy).toContain('cp -R "$STAGE/monitoring" "$TARGET/monitoring"');
    expect(ciDeploy).toMatch(/for path in [^\n]*\bmonitoring\b/);
  });

  it('are re-read by a deploy, which needs --force-recreate', () => {
    // Changing a bind-mounted file does not change the container's definition, so a plain
    // `up -d` finds nothing to do and the OLD config keeps running. This flag is the whole
    // reason a dashboard change reaches the box at all.
    expect(ciDeploy).toContain('docker compose up -d --build --force-recreate');
  });
});

describe('nothing here can collide with the box owner\'s own stack', () => {
  it('every observability service is prefixed obs-', () => {
    // The single most consequential line in this file. This compose project joins the
    // host's SHARED `docker_default` network, and compose publishes each service NAME as a
    // network alias on it — while the box's owner already runs Loki, Grafana, Prometheus
    // and Promtail there under exactly those names. A service called `loki` would put two
    // containers behind one DNS name, and their collector's pushes could start landing in
    // our store, or ours in theirs, intermittently, with nothing failing anywhere.
    const names = [...compose.matchAll(/^ {2}([a-z][\w-]*):$/gm)].map((m) => m[1]!);
    const theirs = ['loki', 'grafana', 'prometheus', 'promtail', 'alloy', 'cadvisor', 'node-exporter'];
    for (const n of names) expect(theirs, `service '${n}' collides with a host stack service name`).not.toContain(n);
  });

  it('Alloy collects only this project\'s containers', () => {
    // The mirror of the above: their collector sees ours, and this is what stops ours from
    // seeing theirs. Both the Docker-side filter and the Alloy-side `keep` are asserted,
    // because the daemon's name filter is a SUBSTRING match rather than an anchored one.
    expect(alloy).toMatch(/values\s*=\s*\["wnet-test-"\]/);
    expect(alloy).toMatch(/regex\s*=\s*"\/wnet-test-\.\*"[\s\S]{0,80}action\s*=\s*"keep"/);
  });
});

describe('the addresses in each config resolve to a real service and port', () => {
  /** `service` -> its single exposed port, read out of compose. */
  const exposed: Record<string, string> = {};
  for (const block of compose.split(/^ {2}(?=[a-z])/m)) {
    const name = /^([\w-]+):/.exec(block)?.[1];
    const port = /expose:\s*\n\s+- "(\d+)"/.exec(block)?.[1];
    if (name && port) exposed[name] = port;
  }

  it('read the ports at all', () => {
    expect(Object.keys(exposed).sort()).toEqual([
      'billsvc',
      'gameserver',
      'matchsvc',
      'obs-alloy',
      'obs-grafana',
      'obs-loki',
      'obs-prometheus',
    ]);
  });

  it('Alloy pushes to the Loki service, at the port Loki exposes', () => {
    const url = new URL(/url\s*=\s*"([^"]+)"/.exec(alloy)![1]!);
    expect(url.hostname).toBe('obs-loki');
    expect(url.port).toBe(exposed['obs-loki']);
    expect(url.pathname).toBe('/loki/api/v1/push');
  });

  it('matchsvc pushes client logs to the same place', () => {
    // Two different files name this endpoint. They agreeing is what makes the client half
    // and the backend half land in one store, which is the point of having one store.
    const url = new URL(/BB_LOKI_PUSH_URL:\s*(\S+)/.exec(compose)![1]!);
    expect(url.hostname).toBe('obs-loki');
    expect(url.port).toBe(exposed['obs-loki']);
    expect(url.pathname).toBe('/loki/api/v1/push');
  });

  it('Loki listens on the port compose exposes for it', () => {
    expect(/http_listen_port:\s*(\d+)/.exec(loki)![1]).toBe(exposed['obs-loki']);
  });

  it('Prometheus scrapes each app service at the port that service listens on', () => {
    const targets = [...prometheus.matchAll(/targets:\s*\[([\w-]+):(\d+)\]/g)].map((m) => ({
      host: m[1]!,
      port: m[2]!,
    }));
    expect(targets.length).toBeGreaterThanOrEqual(6);
    for (const t of targets) {
      // The two host-stack exporters are deliberately not ours — see prometheus.yml's
      // header for why scraping the box owner's cAdvisor beats standing up a second one.
      if (t.host.startsWith('docker-')) continue;
      expect(exposed[t.host], `prometheus scrapes unknown service ${t.host}`).toBeDefined();
      expect(t.port, `prometheus scrapes ${t.host} on the wrong port`).toBe(exposed[t.host]);
    }
  });

  it('Grafana\'s datasources name real services at their real ports', () => {
    for (const m of datasources.matchAll(/url:\s*http:\/\/([\w-]+):(\d+)\s*$/gm)) {
      expect(exposed[m[1]!], `datasource points at unknown service ${m[1]}`).toBeDefined();
      expect(m[2], m[1]).toBe(exposed[m[1]!]);
    }
  });

  it('Grafana is served under the sub-path Caddy routes, with the sub-path flag set', () => {
    // Half of this is a two-part setting: `GF_SERVER_ROOT_URL` alone makes Grafana generate
    // /grafana links while still SERVING at /, so every asset 404s behind the proxy and the
    // page renders blank with a 200.
    const root = /GF_SERVER_ROOT_URL:\s*(\S+)/.exec(compose)![1]!;
    expect(new URL(root).pathname).toBe('/grafana/');
    expect(compose).toMatch(/GF_SERVER_SERVE_FROM_SUB_PATH:\s*"true"/);
    // ...and the healthcheck has to ask for the sub-path too, or a healthy Grafana reports
    // itself unhealthy forever and compose restarts it in a loop.
    expect(compose).toContain('http://127.0.0.1:3000/grafana/api/health');
  });

  it('Grafana neither allows sign-up nor anonymous access', () => {
    // It is on the public internet under a path anybody can guess.
    expect(compose).toMatch(/GF_USERS_ALLOW_SIGN_UP:\s*"false"/);
    expect(compose).toMatch(/GF_AUTH_ANONYMOUS_ENABLED:\s*"false"/);
  });
});

describe("Alloy's parser against the line the logger really writes", () => {
  /**
   * Lifted out of the Alloy config and made runnable here: unescape the HCL string
   * literal, then translate Go's named-group syntax (`(?P<x>`) to JavaScript's (`(?<x>`) —
   * Alloy's regexes are RE2, which JS is not.
   *
   * That translation is the one caveat worth stating: this asserts the pattern against
   * JavaScript's engine, not Go's. It is exact for everything the expression actually uses
   * (literal characters, `\d`/`\s`, bounded quantifiers, a negated class), and it would not
   * be for the constructs RE2 refuses outright — a backreference, a lookahead — none of
   * which appear here. A test that only re-stated the pattern as a string would catch a
   * changed format and not a broken pattern; this catches both.
   */
  const stageRegex = (): RegExp => {
    const raw = /expression\s*=\s*"([^"]+)"/.exec(alloy)![1]!;
    return new RegExp(raw.replace(/\\\\/g, '\\').replace(/\(\?P</g, '(?<'));
  };

  function realLine(level: 'error' | 'warn' | 'info' | 'debug', tag = 'matchsvc'): string {
    let out = '';
    createLogger(tag, { level: 'debug', sink: { write: (_l, line) => (out = line) } })[level]('a message', { k: 'v' });
    return out;
  }

  it('is a string literal Alloy can actually PARSE — every backslash doubled', () => {
    // Added 2026-09-09 after the first deploy, where this is exactly what went wrong and
    // the tests below did not notice. Alloy's config language accepts `\\` as an escape and
    // REFUSES `\d`, so a regex written with single backslashes makes the container fail its
    // initial load and sit in a restart loop — while the assertions below passed, because
    // unescaping a string that has nothing to unescape is a no-op and leaves exactly the
    // pattern they wanted to see. A test that reads a file through a lenient parser cannot
    // tell you the real parser will accept it; this asserts the literal's own shape instead.
    const raw = /expression\s*=\s*"([^"]+)"/.exec(alloy)![1]!;
    expect(raw.split('\\\\').join('')).not.toContain('\\');
  });

  it('extracts the level and the tag from a real line, at every level', () => {
    // The cross-check that matters most in this file: two files, one regex, one formatter,
    // and no compiler between them. Run against the ACTUAL logger rather than a copy of its
    // format, so a change to either side is caught by the other.
    for (const level of ['error', 'warn', 'info', 'debug'] as const) {
      const m = stageRegex().exec(realLine(level));
      expect(m, `${level}: ${realLine(level)}`).not.toBeNull();
      expect(m!.groups?.level ?? m![1], level).toBe(level.toUpperCase());
    }
  });

  it('extracts a CHILD tag too', () => {
    const m = stageRegex().exec(realLine('warn', 'matchsvc:store'));
    expect(m).not.toBeNull();
    expect(m!.groups?.tag ?? m![2]).toBe('matchsvc:store');
  });

  it('does NOT match a line the logger did not write, so those keep their raw form', () => {
    // Node's own `ExperimentalWarning`, Loki's startup output, a bare stack-trace
    // continuation. They must pass through unlabelled rather than being dropped — which is
    // why the dashboards' "All" level is `.*` and not `.+`.
    expect(stageRegex().exec('(node:1) ExperimentalWarning: SQLite is an experimental feature')).toBeNull();
    expect(stageRegex().exec('    at Object.<anonymous> (/app/index.mjs:1:1)')).toBeNull();
  });

  it('lowercases the level, matching what the client half sends', () => {
    // One vocabulary across both sources, or every dashboard needs two filters.
    expect(alloy).toContain('ToLower');
  });
});

describe('the dashboards', () => {
  const dir = join(serverRoot, 'monitoring/grafana/dashboards');
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));

  it('there are some, and each is valid JSON with a unique uid', () => {
    expect(files.length).toBeGreaterThanOrEqual(3);
    const uids = files.map((f) => (JSON.parse(readFileSync(join(dir, f), 'utf8')) as { uid: string }).uid);
    // A duplicate uid makes Grafana's provisioner import one and silently skip the other.
    expect(new Set(uids).size).toBe(uids.length);
    for (const uid of uids) expect(uid).toBeTruthy();
  });

  it('every panel names a datasource uid that provisioning actually declares', () => {
    // A dashboard referring to a uid that does not exist renders every panel as "Datasource
    // not found" — a wall of errors that looks like the data is missing.
    const declared = new Set([...datasources.matchAll(/^\s+uid:\s*(\S+)/gm)].map((m) => m[1]!));
    expect(declared.size).toBeGreaterThanOrEqual(2);
    for (const f of files) {
      const text = readFileSync(join(dir, f), 'utf8');
      for (const m of text.matchAll(/"uid":\s*"([^"]+)"/g)) {
        // The dashboard's own top-level uid is not a datasource reference.
        if (m[1] === (JSON.parse(text) as { uid: string }).uid) continue;
        expect([...declared], `${f} references datasource '${m[1]}'`).toContain(m[1]);
      }
    }
  });

  it('the provisioning path is the one compose mounts the dashboards at', () => {
    const provider = read('monitoring/grafana/provisioning/dashboards/dashboards.yml');
    const path = /path:\s*(\S+)/.exec(provider)![1]!;
    const mount = configMounts.find((m) => m.host.endsWith('grafana/dashboards'));
    expect(mount, 'the dashboards directory is not mounted').toBeDefined();
    expect(mount!.container).toBe(path);
  });
});

describe('retention is bounded, on a disk this project does not own', () => {
  it('Loki expires logs, and the compactor is what does it', () => {
    // `retention_period` alone is inert: without `retention_enabled` on the compactor,
    // nothing ever deletes and the setting reads like a guarantee it is not making.
    expect(loki).toMatch(/retention_period:\s*\d+h/);
    expect(loki).toMatch(/retention_enabled:\s*true/);
  });

  it('Prometheus expires too', () => {
    expect(compose).toMatch(/--storage\.tsdb\.retention\.time=\d+d/);
  });

  it('every container has a bounded json-file log, including the new ones', () => {
    // The observability stack writes to the same disk it reads from; an unbounded container
    // log on a borrowed box is the one failure here that reaches the box's owner.
    const blocks = compose.split(/^ {2}(?=[a-z][\w-]*:$)/m).filter((b) => /^[\w-]+:/.test(b));
    const services = blocks.filter((b) => /container_name:/.test(b));
    expect(services.length).toBe(8);
    for (const b of services) {
      const name = /^([\w-]+):/.exec(b)![1];
      expect(b, `${name} has no log size limit`).toMatch(/max-size:\s*"\d+m"/);
    }
  });
});
