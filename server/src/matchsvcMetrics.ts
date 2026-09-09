/**
 * matchsvc's own Prometheus gauges (design/19 §10) — split out of `matchsvc.ts` on
 * 2026-09-09, when Phase C's flag wiring pushed that file past the 500-line convention.
 *
 * A sibling of free functions rather than a layer: this module owns no service and is
 * imported by the assembly shell, never the other way round (CLAUDE.md's rule that a
 * split-out file never imports the shell back). `matchsvc.ts` re-exports the one name here
 * so `deploy.dashboardMetrics.test.ts` and `metrics.test.ts` keep the import they have.
 *
 * Nothing in here queries anything. Every value is a field read or a method call that is
 * already O(1) — which is the property a `/metrics` handler needs, and the reason the
 * analytics rollup hands over CACHED gauges (`analytics/job.ts`) instead of recomputing on
 * a scrape.
 */
import type { Matchmaker } from './Matchmaker';
import type { GameRegistry } from './GameRegistry';
import type { RollupJob } from './analytics/job';
import { gauge, processMetrics, type Metric } from './metrics';

/**
 * What only matchsvc knows. Two gauges, and both were chosen because a question exists for
 * them: "is anybody waiting and not getting matched?" (the queue depths, split by mode
 * because a co-op queue and a PvP queue fill at completely different rates) and "is there
 * anywhere to send them?" (the registry, whose empty state makes every `/find` answer 503
 * while every container stays green).
 */
export function matchsvcMetrics(
  matchmaker: Matchmaker,
  registry: GameRegistry,
  rollup?: RollupJob | null,
): Metric[] {
  return [
    ...processMetrics('matchsvc'),
    gauge('bb_matchsvc_queue_waiting', 'Players waiting in the matchmaking queue.', matchmaker.waiting(2, 'coop'), {
      mode: 'coop',
      playerCount: '2',
    }),
    gauge('bb_matchsvc_queue_waiting', 'Players waiting in the matchmaking queue.', matchmaker.waiting(2, 'pvp'), {
      mode: 'pvp',
      playerCount: '2',
    }),
    gauge(
      'bb_matchsvc_gameservers_available',
      'Gameserver instances the registry would hand a new match to. Zero means every /find answers 503.',
      registry.pick() ? 1 : 0,
    ),
    // The analytics rollup's cached gauges (design/21 §2.5). A field read, not a query —
    // see `analytics/job.ts` for why the scrape must not recompute. Absent entirely when
    // analytics is off, and absent for any retention offset that cannot be answered yet,
    // which is what makes a dashboard say "No data" instead of "0% came back".
    ...(rollup?.metrics() ?? []).map((m) => ({ ...m })),
  ];
}
