/**
 * The rollup job — `src/analytics/job.ts` — plus `analytics/db.ts`'s `analyticsEnabledFromEnv`.
 *
 * The job is small, and every case here is about a failure mode that looks like success:
 *
 *   - **A cycle that throws must not kill the timer.** A job that dies on its first bad
 *     cycle leaves a dashboard showing the last good numbers forever, which is the worst
 *     possible presentation of "the rollup stopped".
 *   - **The cache holds the last GOOD answer**, so a bad cycle costs freshness rather than
 *     replacing real numbers with nothing.
 *   - **An empty database yields an empty metric list**, never a zeroed one. This is the
 *     rule the whole design turns on, tested here at the layer that serves it.
 *   - **`runOnce` must not reject.** It is handed straight to `setInterval`, so a rejecting
 *     version would turn one bad cycle into an unhandled rejection — a process-level event,
 *     from a subsystem whose whole posture is that its failures are local.
 *
 * A bad cycle is produced the way `analyticsStore.test.ts` produces one: a collection
 * validator the server enforces, so the failure comes from mongod rather than from a stub.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Db } from 'mongodb';
import {
  EVENT_RETENTION_DAYS,
  analyticsEnabledFromEnv,
  dailyRollupOf,
  ensureAnalyticsIndexes,
  eventsOf,
} from '../src/analytics/db';
import { writeBatch } from '../src/analytics/store';
import { ROLLUP_INTERVAL_MS, runRollupCycle, startRollupJob } from '../src/analytics/job';
import type { Logger } from '../src/log';
import { openTestMongo, type MongoTestContext } from './mongoHarness';

const DAY_MS = 86_400_000;
/** 2026-09-09T12:00:00Z — so "yesterday" is 2026-09-08. */
const NOW = Date.UTC(2026, 8, 9, 12, 0, 0);

function recordingLog(): Logger & { lines: { level: string; msg: string }[] } {
  const lines: { level: string; msg: string }[] = [];
  const log = {
    lines,
    error: (msg: string) => void lines.push({ level: 'error', msg }),
    warn: (msg: string) => void lines.push({ level: 'warn', msg }),
    info: (msg: string) => void lines.push({ level: 'info', msg }),
    debug: (msg: string) => void lines.push({ level: 'debug', msg }),
    child: () => log as never,
  };
  return log as never;
}

let ctx: MongoTestContext;
let db: Db;
let log: ReturnType<typeof recordingLog>;
beforeEach(async () => {
  ctx = await openTestMongo();
  db = ctx.db('analytics');
  await ensureAnalyticsIndexes(db);
  log = recordingLog();
});
afterEach(async () => {
  await ctx.dispose();
});

/** Make every `persistRollup` fail, from the server. The validator admits nothing, so the
 *  transaction inside `persistRollup` aborts — a real refusal rather than a stubbed one. */
async function breakRollup(): Promise<void> {
  await db.command({ collMod: 'dailyRollup', validator: { metric: { $eq: '__nothing_matches__' } } });
}

/** Record `install` active `daysAgo` days before NOW, through the real write path. */
async function active(daysAgo: number, install: string): Promise<void> {
  await writeBatch(
    db,
    {
      install,
      session: `s-${install}`,
      host: 'web',
      build: '1.0.0',
      locale: 'en',
      events: [{ name: 'session_start', atMs: NOW - daysAgo * DAY_MS, props: {} }],
    },
    null,
  );
}

describe('runRollupCycle', () => {
  it('persists yesterday, prunes what aged out, and returns the gauges', async () => {
    await active(1, 'a');
    await active(EVENT_RETENTION_DAYS + 1, 'ancient');
    const metrics = await runRollupCycle({ db, log, now: () => NOW });
    expect(metrics.find((m) => m.name === 'bb_dau' && m.labels?.host === 'all')?.value).toBe(1);
    expect(await dailyRollupOf(db).countDocuments({ day: '2026-09-08' })).toBeGreaterThan(0);
    expect(await eventsOf(db).countDocuments()).toBe(1);
  });

  it('logs one falsifiable line rather than "rollup ok"', async () => {
    await runRollupCycle({ db, log, now: () => NOW });
    expect(log.lines).toEqual([{ level: 'info', msg: 'analytics rollup' }]);
  });

  it('returns an EMPTY list on an empty database — no zeroed retention', async () => {
    const metrics = await runRollupCycle({ db, log, now: () => NOW });
    expect(metrics.some((m) => m.name === 'bb_retention_ratio')).toBe(false);
    // DAU zero IS a measurement and is reported; retention zero would be a claim.
    expect(metrics.find((m) => m.name === 'bb_dau')?.value).toBe(0);
  });

  it('reports retention once a cohort has aged', async () => {
    await active(2, 'a');
    await active(1, 'a');
    const metrics = await runRollupCycle({ db, log, now: () => NOW });
    expect(metrics.find((m) => m.name === 'bb_retention_ratio' && m.labels?.d === '1')?.value).toBe(1);
  });

  it('keeps the prune window wide enough that persist-before-prune cannot matter', () => {
    // The premise behind the ordering note in job.ts. The rollup's day is always yesterday
    // and the prune's cutoff is EVENT_RETENTION_DAYS back, so the two never overlap — as
    // long as the window is more than one day. Shortening it to 1 is the change that makes
    // the order load-bearing, and this is the test that says so.
    expect(EVENT_RETENTION_DAYS).toBeGreaterThan(1);
  });
});

describe('startRollupJob', () => {
  interface FakeTimer {
    /** Typed loosely so a test can AWAIT the cycle a tick started — `job.ts` hands the real
     *  `runOnce` to the timer rather than a wrapper that throws its promise away. */
    fn: () => unknown;
    ms: number;
  }

  function start(over: Partial<Parameters<typeof startRollupJob>[0]> = {}) {
    const timers: FakeTimer[] = [];
    let cleared = 0;
    const job = startRollupJob({
      db,
      log,
      now: () => NOW,
      setIntervalImpl: (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length;
      },
      clearIntervalImpl: () => void (cleared += 1),
      ...over,
    });
    return { job, timers, cleared: () => cleared };
  }

  it('runs one cycle at once, so a restarted process serves real gauges without waiting an hour', async () => {
    await active(1, 'a');
    const { job } = start();
    await job.ready;
    expect(job.metrics().find((m) => m.name === 'bb_dau' && m.labels?.host === 'all')?.value).toBe(1);
  });

  it('serves NO gauges — not zeroed ones — before the first cycle lands', async () => {
    // The window the port introduced: the first cycle is a round trip now, not a synchronous
    // call. "No analytics gauges" is the correct answer during it, and the absent-versus-zero
    // rule is why.
    await active(1, 'a');
    const { job } = start();
    expect(job.metrics()).toEqual([]);
    await job.ready;
    expect(job.metrics().length).toBeGreaterThan(0);
  });

  it('registers an hourly timer by default', async () => {
    const { job, timers } = start();
    await job.ready;
    expect(timers).toHaveLength(1);
    expect(timers[0]!.ms).toBe(ROLLUP_INTERVAL_MS);
    expect(ROLLUP_INTERVAL_MS).toBeLessThan(DAY_MS);
  });

  it('refreshes the cache on each tick', async () => {
    const { job, timers } = start();
    await job.ready;
    expect(job.metrics().find((m) => m.name === 'bb_dau')?.value).toBe(0);
    await active(1, 'a');
    await timers[0]!.fn();
    expect(job.metrics().find((m) => m.name === 'bb_dau')?.value).toBe(1);
  });

  it('survives a cycle that throws, and the timer keeps running', async () => {
    await breakRollup();
    const { job, timers } = start();
    await job.ready;
    expect(job.metrics()).toEqual([]);
    expect(log.lines).toEqual([{ level: 'warn', msg: 'analytics rollup failed' }]);
    // And the next tick is still attempted rather than the job being dead — and it RESOLVES
    // rather than rejecting, which is what keeps `setInterval`'s discarded promise from
    // becoming an unhandled rejection.
    await expect(timers[0]!.fn()).resolves.toBeUndefined();
    expect(log.lines).toHaveLength(2);
  });

  it('keeps the last GOOD answer when a later cycle fails', async () => {
    await active(1, 'a');
    const { job, timers } = start();
    await job.ready;
    expect(job.metrics().find((m) => m.name === 'bb_dau' && m.labels?.host === 'all')?.value).toBe(1);
    await breakRollup();
    await timers[0]!.fn();
    // Freshness lost, numbers kept — the alternative is a panel that empties on one bad
    // cycle and looks like "nobody played".
    expect(job.metrics().find((m) => m.name === 'bb_dau' && m.labels?.host === 'all')?.value).toBe(1);
  });

  it('clears its timer on stop', async () => {
    const h = start();
    await h.job.ready;
    h.job.stop();
    expect(h.cleared()).toBe(1);
  });

  it('runOnce is idempotent', async () => {
    await active(1, 'a');
    const { job } = start();
    await job.ready;
    await job.runOnce();
    await job.runOnce();
    // Two hosts would be two documents; one install on one host is 'all' plus 'web'.
    expect(await dailyRollupOf(db).countDocuments({ metric: 'dau' })).toBe(2);
  });

  it('works with real timers, unref-ed so it cannot hold the process open', async () => {
    // The default arms — a real `setInterval(...).unref()` and a real `clearInterval`. If
    // the unref were dropped, vitest would hang at the end of this file rather than fail,
    // which is why this case exists at all.
    const job = startRollupJob({ db, log, now: () => NOW, intervalMs: 3_600_000 });
    await job.ready;
    expect(job.metrics()).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'bb_dau' })]));
    job.stop();
  });
});

/**
 * The switch, which replaced `analyticsDbPathFromEnv` on 2026-09-15.
 *
 * The cases below are the same cases, asked of a boolean instead of a path, and the reason
 * they are still here is that the PATH used to be the switch: an unset `BB_ANALYTICS_DB_PATH`
 * had nothing to fall back to, so the deployment collected nothing. `store('analytics')`
 * always resolves, so a port that simply dropped the reader would have turned collection on
 * for every deployment that upgraded — in the one subsystem with a privacy policy attached,
 * silently, by omission.
 *
 * Every case here therefore asserts the OFF direction for an input that is not an explicit
 * yes. That asymmetry is the whole content of the function.
 */
describe('analyticsEnabledFromEnv', () => {
  it('is ON for an explicit 1 or true, in either case', () => {
    expect(analyticsEnabledFromEnv({ BB_ANALYTICS_ENABLED: '1' })).toBe(true);
    expect(analyticsEnabledFromEnv({ BB_ANALYTICS_ENABLED: 'true' })).toBe(true);
    expect(analyticsEnabledFromEnv({ BB_ANALYTICS_ENABLED: 'TRUE' })).toBe(true);
    // Trimmed, so a compose value with a stray space is still the yes somebody typed.
    expect(analyticsEnabledFromEnv({ BB_ANALYTICS_ENABLED: '  1  ' })).toBe(true);
  });

  it('treats an EMPTY value as OFF', () => {
    // design/19 §9's already-paid-for lesson, from the safe side: a compose file with a
    // trailing `BB_ANALYTICS_ENABLED:` and no value produces `""`. Under the old path
    // reader the equivalent mistake opened SQLite's temporary database, so collection
    // appeared to work and vanished on restart. Here it collects nothing, which is the
    // answer a privacy-relevant subsystem should give to a question nobody answered.
    expect(analyticsEnabledFromEnv({ BB_ANALYTICS_ENABLED: '' })).toBe(false);
    expect(analyticsEnabledFromEnv({ BB_ANALYTICS_ENABLED: '   ' })).toBe(false);
  });

  it('is OFF when unset', () => {
    expect(analyticsEnabledFromEnv({})).toBe(false);
  });

  it('is OFF for anything else, including the values that LOOK affirmative', () => {
    // `yes` and `on` are not accepted, deliberately: an allowlist of two spellings is a rule
    // somebody can check against a compose file, and every near miss lands on the safe side
    // rather than on a guess about what was meant.
    for (const raw of ['0', 'false', 'yes', 'on', 'enabled', '2']) {
      expect(analyticsEnabledFromEnv({ BB_ANALYTICS_ENABLED: raw }), raw).toBe(false);
    }
  });
});
