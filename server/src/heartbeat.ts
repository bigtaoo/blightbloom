/**
 * A periodic `info` line from every long-lived process.
 *
 * Ported from funny's `server/shared/src/heartbeat.ts`, and the reason it exists is worth
 * repeating rather than assuming: **an idle log store and a broken log store look
 * identical.** A quiet night on a game with few players produces no backend lines at all,
 * so "Grafana shows nothing" cannot be read as "nothing went wrong" — it is equally
 * consistent with Alloy having lost the Docker socket, Loki being out of disk, or the
 * container having been dead since the last deploy. funny ran for months in exactly that
 * state before noticing.
 *
 * A line every five minutes turns that ambiguity into a question with an answer: the
 * "service liveness" panel in `monitoring/grafana/dashboards/backend.json` counts these,
 * and a service missing from it is a service that is not talking, whatever the reason.
 *
 * Deliberately `info`, not `debug`: a deployment that sets `BB_LOG_LEVEL=warn` to quiet
 * things down would otherwise silence the one line that proves the pipeline works, which
 * is the failure this exists to prevent, arriving through the setting meant to tidy up.
 */
import type { Logger } from './log';

export const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;

export interface HeartbeatDeps {
  log: Logger;
  intervalMs?: number;
  /** Injected by tests; the real one is `setInterval`. */
  setIntervalImpl?: (fn: () => void, ms: number) => { unref?: () => void };
  now?: () => number;
}

/**
 * Start beating. Returns a stop function.
 *
 * Beats ONCE immediately, then on the interval. The immediate beat is what makes a
 * just-restarted service visible without a five-minute wait — and it is also what proves
 * the whole collection path end to end within seconds of a deploy, which is when somebody
 * is actually watching.
 */
export function startHeartbeat(deps: HeartbeatDeps): () => void {
  const log = deps.log;
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const beat = (): void => {
    const mem = process.memoryUsage();
    log.info('heartbeat', {
      uptimeSec: Math.round((now() - startedAt) / 1000),
      rssMb: Math.round(mem.rss / 1024 / 1024),
      heapMb: Math.round(mem.heapUsed / 1024 / 1024),
    });
  };

  beat();
  const setIntervalImpl = deps.setIntervalImpl ?? ((fn, ms) => setInterval(fn, ms));
  const handle = setIntervalImpl(beat, deps.intervalMs ?? HEARTBEAT_INTERVAL_MS);
  // Without this a heartbeat keeps the event loop alive forever, so a process that has
  // finished its real work (and every test that starts one) would never exit.
  handle.unref?.();
  return () => clearInterval(handle as unknown as ReturnType<typeof setInterval>);
}
