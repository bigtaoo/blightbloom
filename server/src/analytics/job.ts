/**
 * The periodic half of analytics (design/21 §2.5): compute yesterday's numbers, persist
 * them, prune what has aged out, and hold the result for `/metrics` to serve.
 *
 * ## Why a cache rather than computing on scrape
 *
 * Prometheus scrapes every 30 seconds and the numbers change once a day. Recomputing on
 * each scrape would run the whole rollup 2,880 times to produce the same answer, and it
 * would put SQLite work — synchronous work, in the process that serves `/find` — on a path
 * triggered by something outside this project. So the job computes on ITS OWN schedule and
 * `/metrics` reads {@link RollupJob.metrics}, which is a field read.
 *
 * The cost of that trade, stated rather than discovered: between the job's start and its
 * first cycle there is a window where `/metrics` reports no analytics gauges at all. The
 * window is one synchronous cycle wide because {@link startRollupJob} runs one immediately,
 * and "no gauges" is the correct answer during it — see the absent-versus-zero rule below.
 *
 * ## Hourly, not daily
 *
 * The work is idempotent (`persistRollup` replaces by primary key) and cheap (a handful of
 * indexed `COUNT`s), so the interval is chosen for a different reason: a DAILY timer in a
 * process that restarts on every deploy is a timer that can miss a day entirely, and the
 * miss is invisible — the row is simply absent, which reads exactly like a quiet day.
 * Hourly means a restart costs at most an hour of staleness and the day boundary is picked
 * up on its own.
 *
 * ## An absent gauge, never a zero
 *
 * `rollupMetrics` omits a retention offset it cannot answer, and this file must not undo
 * that by substituting anything. On a database with nothing in it the metric list is empty
 * and that is what is served: no analytics gauges. A dashboard panel then reads "No data",
 * which is true, rather than 0%, which would say every player left.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { Logger } from '../log';
import { prune } from './store';
import { dayKey } from './ingest';
import { rollupMetrics, persistRollup, type RollupMetric } from './rollup';

/** Default cycle interval. See the file header for why it is not a day. */
export const ROLLUP_INTERVAL_MS = 60 * 60 * 1000;

export interface RollupJobDeps {
  db: DatabaseSync;
  log: Logger;
  now?: () => number;
  intervalMs?: number;
  /** Injected so a test can drive cycles without a real timer. */
  setIntervalImpl?: (fn: () => void, ms: number) => unknown;
  clearIntervalImpl?: (handle: unknown) => void;
}

export interface RollupJob {
  /** The gauges from the last successful cycle. Empty until the first one completes, and
   *  empty forever on a database with no activity in it — both correct. */
  metrics: () => readonly RollupMetric[];
  /** Run a cycle now. Exposed for tests and called once by {@link startRollupJob}. */
  runOnce: () => void;
  stop: () => void;
}

/**
 * One cycle: persist, prune, refresh the cache.
 *
 * **Persist BEFORE pruning**, and the honest version of why: the rollup reads rows the
 * prune deletes, so the order is the safe one — but with the shipped constants it cannot
 * currently make a difference, because the rollup's day is always yesterday and the prune's
 * cutoff is 90 days back. Rather than leave that as an untestable comment, the premise is a
 * test: `EVENT_RETENTION_DAYS > 1` is what makes the order irrelevant, and shortening the
 * window to a day is the change that would make it matter. If that test ever goes red, this
 * order stops being a formality and starts being the reason the numbers are right.
 */
export function runRollupCycle(deps: RollupJobDeps): RollupMetric[] {
  const now = deps.now ?? Date.now;
  const today = dayKey(now());
  const rows = persistRollup(deps.db, today, now());
  const pruned = prune(deps.db, today);
  const metrics = rollupMetrics(deps.db, today);
  deps.log.info('analytics rollup', {
    day: today,
    rows,
    prunedEvents: pruned.events,
    prunedActive: pruned.active,
    gauges: metrics.length,
  });
  return metrics;
}

/**
 * Start the job. Runs one cycle synchronously before returning, so a freshly started
 * process serves real gauges immediately rather than after an hour.
 *
 * A cycle that throws is caught and logged, and the cache is left holding the last good
 * answer. Losing an hour of freshness is a smaller failure than a timer that dies on its
 * first bad cycle and never runs again — which is the shape that makes a dashboard look
 * healthy while it slowly goes stale.
 */
export function startRollupJob(deps: RollupJobDeps): RollupJob {
  let latest: readonly RollupMetric[] = [];

  const runOnce = (): void => {
    try {
      latest = runRollupCycle(deps);
    } catch (e) {
      deps.log.warn('analytics rollup failed', { err: (e as Error).message });
    }
  };

  runOnce();

  const setIntervalFn = deps.setIntervalImpl ?? ((fn, ms) => setInterval(fn, ms).unref());
  const clearIntervalFn = deps.clearIntervalImpl ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  const handle = setIntervalFn(runOnce, deps.intervalMs ?? ROLLUP_INTERVAL_MS);

  return {
    metrics: () => latest,
    runOnce,
    stop: () => clearIntervalFn(handle),
  };
}
