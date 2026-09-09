/**
 * The one outbound hop from a service process to the log store.
 *
 * Small, and deliberately shaped around one failure that funny actually lived through:
 * its equivalent env var was empty in production for months, so every client crash report
 * was accepted, converted, handed to a shipper pointed at `null`, and dropped — while
 * Grafana showed an empty dashboard that looked exactly like a quiet week. Two things here
 * exist because of that:
 *
 *  - **An unconfigured URL is logged once, loudly, at the first push.** Not silently
 *    ignored, and not on every push either (a log line per client report is its own
 *    outage). One WARN naming the variable is enough to make the difference between "no
 *    errors happened" and "nothing was ever delivered" visible from the same logs the
 *    dashboards are built on.
 *  - **A failed push is logged too, rate-limited the same way.** Loki being down must not
 *    be silent, and must equally not turn one broken dependency into a second log flood.
 *
 * What it must NEVER do is affect the caller. Every route that ships here does so with
 * `void push(...)` — not awaited, not error-propagating — so a dead or slow log store
 * cannot delay, fail or change a single player-facing response. That is the whole contract
 * of this module and it is asserted in `test/routes.telemetry.test.ts`.
 */
import type { Logger } from './log';

/**
 * Where client logs go. Unset means "drop, and say so once" — the correct behaviour for a
 * local `npm run dev` (no Loki within reach) and a bug in production, which is why the
 * first push says which it thinks it is rather than assuming.
 */
export function lokiPushUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = (env.BB_LOKI_PUSH_URL ?? '').trim();
  return raw.length > 0 ? raw : null;
}

export interface PushDeps {
  url: string | null;
  log: Logger;
  fetchImpl?: typeof fetch;
  /** Milliseconds between repeats of the SAME complaint. Injected so a test need not wait. */
  complainEveryMs?: number;
  now?: () => number;
}

/** Per-`PushDeps` complaint state, so two shippers do not silence each other's first warning. */
const lastComplaint = new WeakMap<object, Map<string, number>>();

function shouldComplain(key: object, what: string, at: number, everyMs: number): boolean {
  const seen = lastComplaint.get(key) ?? new Map<string, number>();
  lastComplaint.set(key, seen);
  const previous = seen.get(what);
  if (previous !== undefined && at - previous < everyMs) return false;
  seen.set(what, at);
  return true;
}

/**
 * POST a Loki push body. Resolves either way — a rejection here would become an unhandled
 * rejection at every `void push(...)` call site, which on Node 22 ends the process.
 */
export async function pushToLoki(deps: PushDeps, payload: unknown): Promise<void> {
  const now = deps.now ?? Date.now;
  const everyMs = deps.complainEveryMs ?? 5 * 60 * 1000;

  if (!deps.url) {
    if (shouldComplain(deps, 'unset', now(), everyMs)) {
      deps.log.warn(
        'client logs are being DROPPED: no log store configured. Expected in local dev; in a deployment it means the dashboards will stay empty and look quiet.',
        { env: 'BB_LOKI_PUSH_URL' },
      );
    }
    return;
  }

  const doFetch = deps.fetchImpl ?? fetch;
  try {
    const res = await doFetch(deps.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      // A log store that has stopped answering must not hold a socket open behind a
      // player's request forever, even though nothing awaits this.
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      // Loki answers 400 with a body naming the offending stream/timestamp, which is the
      // difference between "rejected" and "rejected because the entry was too old".
      const detail = await res.text().catch(() => '');
      if (shouldComplain(deps, `status:${res.status}`, now(), everyMs)) {
        deps.log.warn('log store refused a push', { status: res.status, detail: detail.slice(0, 300) });
      }
    }
  } catch (e) {
    if (shouldComplain(deps, 'unreachable', now(), everyMs)) {
      deps.log.warn('log store unreachable', { url: deps.url, error: (e as Error).message });
    }
  }
}
