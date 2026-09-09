/**
 * THE LINE THAT PROVES THE PIPELINE IS ALIVE (src/heartbeat.ts).
 *
 * The whole point of this module is that an idle log store and a broken one draw the same
 * empty dashboard. So the properties worth pinning are the ones that would quietly restore
 * that ambiguity: a first beat that only arrives after five minutes, a level that a
 * routine `BB_LOG_LEVEL=warn` silences, and a timer that keeps the process alive.
 */
import { describe, it, expect, vi } from 'vitest';
import { startHeartbeat, HEARTBEAT_INTERVAL_MS } from '../src/heartbeat';
import { createLogger, type Level } from '../src/log';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

function harness(level: Level = 'debug'): {
  lines: Array<{ level: Level; line: string }>;
  log: ReturnType<typeof createLogger>;
  fire: () => void;
  intervals: number[];
  unrefs: number;
  setIntervalImpl: (fn: () => void, ms: number) => { unref?: () => void };
} {
  const lines: Array<{ level: Level; line: string }> = [];
  const log = createLogger('matchsvc', { level, sink: { write: (l, line) => lines.push({ level: l, line }) } });
  const fns: Array<() => void> = [];
  const intervals: number[] = [];
  let unrefs = 0;
  return {
    lines,
    log,
    intervals,
    get unrefs() {
      return unrefs;
    },
    fire: () => fns.forEach((f) => f()),
    setIntervalImpl: (fn, ms) => {
      fns.push(fn);
      intervals.push(ms);
      return {
        unref: () => {
          unrefs += 1;
        },
      };
    },
  };
}

describe('startHeartbeat', () => {
  it('beats ONCE immediately, before any interval has elapsed', () => {
    // Without this a just-deployed service is invisible for five minutes — which is exactly
    // the window in which somebody is watching a deploy and wants to know it worked.
    const h = harness();
    startHeartbeat({ log: h.log, setIntervalImpl: h.setIntervalImpl });
    expect(h.lines).toHaveLength(1);
    expect(h.lines[0]!.line).toContain('heartbeat');
  });

  it('beats again on each interval', () => {
    const h = harness();
    startHeartbeat({ log: h.log, setIntervalImpl: h.setIntervalImpl });
    h.fire();
    h.fire();
    expect(h.lines).toHaveLength(3);
  });

  it('defaults to five minutes', () => {
    const h = harness();
    startHeartbeat({ log: h.log, setIntervalImpl: h.setIntervalImpl });
    expect(h.intervals).toEqual([HEARTBEAT_INTERVAL_MS]);
    expect(HEARTBEAT_INTERVAL_MS).toBe(5 * 60 * 1000);
  });

  it('logs at INFO, so a deployment quieting things to warn does not silence it', () => {
    // The failure this module exists to prevent, arriving through the setting meant to tidy
    // up. Asserted as "info survives `warn`-level being ABSENT", not just "it is info".
    const h = harness();
    startHeartbeat({ log: h.log, setIntervalImpl: h.setIntervalImpl });
    expect(h.lines[0]!.level).toBe('info');

    const quiet = harness('warn');
    startHeartbeat({ log: quiet.log, setIntervalImpl: quiet.setIntervalImpl });
    // Documents the real consequence rather than asserting a comfortable one: at `warn`
    // the beat IS suppressed, which is why compose pins `BB_LOG_LEVEL: info`.
    expect(quiet.lines).toHaveLength(0);
  });

  it('carries uptime and memory, and the uptime MOVES', () => {
    // A beat whose fields never change is a beat that could be a constant string.
    let t = 1000;
    const h = harness();
    startHeartbeat({ log: h.log, setIntervalImpl: h.setIntervalImpl, now: () => t });
    t = 61_000;
    h.fire();
    expect(h.lines[0]!.line).toContain('uptimeSec=0');
    expect(h.lines[1]!.line).toContain('uptimeSec=60');
    expect(h.lines[1]!.line).toMatch(/rssMb=\d+/);
    expect(h.lines[1]!.line).toMatch(/heapMb=\d+/);
  });

  it('unrefs its timer, so it never holds the process open', () => {
    // Un-unref'd, every test that starts one would hang the runner and a process that has
    // finished its work would never exit.
    const h = harness();
    startHeartbeat({ log: h.log, setIntervalImpl: h.setIntervalImpl });
    expect(h.unrefs).toBe(1);
  });

  it('survives a timer handle with no unref, rather than throwing on it', () => {
    // The browser/`@types/node` shapes differ, and a `setInterval` returning a bare number
    // must not turn a logging concern into a boot failure.
    const h = harness();
    expect(() => startHeartbeat({ log: h.log, setIntervalImpl: () => ({}) })).not.toThrow();
  });

  it('is started by EVERY long-lived process, not just the HTTP ones', () => {
    // The panel this feeds reads a missing service as a service that is not talking, so a
    // process that never beats is a permanent false alarm — which trains everybody to
    // ignore the panel, which is the failure it exists to prevent. `backup` was exactly
    // that on the first deploy (2026-09-09): three heartbeats where there are four
    // processes. It is also the process that HAS failed silently, for 18 hours.
    //
    // Asserted against the compose file's own list of entrypoints rather than a hardcoded
    // four, so a fifth service cannot be added without either beating or failing here.
    const serverRoot = fileURLToPath(new URL('..', import.meta.url));
    const compose = readFileSync(join(serverRoot, 'docker-compose.yml'), 'utf8');
    const bundles = [...compose.matchAll(/command: \["node", "(\w+)\.mjs"\]/g)].map((m) => m[1]!);
    expect(bundles.sort()).toEqual(['backup', 'billsvc', 'index', 'matchsvc']);

    // Each bundle name maps to the entrypoint file that becomes it (scripts/build.mjs).
    const entryOf: Record<string, string> = {
      index: 'src/index.ts',
      matchsvc: 'src/matchsvc.ts',
      billsvc: 'src/billsvc/main.ts',
      backup: 'src/backup/main.ts',
    };
    for (const bundle of bundles) {
      const src = readFileSync(join(serverRoot, entryOf[bundle]!), 'utf8');
      expect(src, `${entryOf[bundle]} never calls startHeartbeat`).toContain('startHeartbeat(');
    }
  });

  it('returns a stopper that clears the real timer', () => {
    const clear = vi.spyOn(globalThis, 'clearInterval');
    const h = harness();
    const stop = startHeartbeat({ log: h.log, intervalMs: 10_000 });
    stop();
    expect(clear).toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
