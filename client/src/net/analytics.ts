/**
 * The client half of analytics (design/21 §2.6): a bounded queue of events, flushed in
 * batches to matchsvc's `POST /client/events`.
 *
 * The question this exists to answer is "do people come back, and where do they stop" —
 * which no amount of looking at the code can answer, and which nobody can ask a player.
 *
 * ## Shape
 *
 * - **A bounded queue, oldest dropped.** Past {@link QUEUE_CAPACITY} the oldest event goes,
 *   not the newest: the interesting events are the ones that just happened, and a queue
 *   that discards new arrivals reports the beginning of a problem and never its end.
 * - **Batched on a timer and on the way out.** Every {@link FLUSH_INTERVAL_MS}, plus one
 *   flush when the page is going away — which for `session_end` is the only chance there
 *   will be.
 * - **Failure is silent and total.** Analytics that can break the game is worse than no
 *   analytics. Every send is fire-and-forget with a swallowed rejection, and nothing here
 *   is ever awaited by anything a player is waiting for. A failed flush does NOT re-queue:
 *   a retry loop on a server that is down is how a background task becomes the foreground
 *   problem, and the events it would save are the least valuable ones we have.
 * - **No sampling, and no server-side collection config.** funny has both, because it has
 *   the traffic to need them. Here a sample rate would mostly be a way to make a small
 *   number wrong, and a config endpoint is a second thing to deploy and a second thing to
 *   get wrong.
 *
 * ## Pure, so that all of the above is testable
 *
 * Everything is injected: the clock, the sender, and the visit's identity. No `Date.now()`,
 * no `localStorage`, no `fetch`, no timers. `analyticsInstall.ts` is the file that touches
 * a browser, and it holds nothing but wiring — the same split the client log module uses.
 */
import type { AnalyticsBatch, AnalyticsEvent, AnalyticsEventName, AnalyticsHost, PropValue } from './analyticsEvents';
import { LIMITS } from './analyticsEvents';

/** How many events are held before the oldest starts being dropped. Comfortably more than
 *  a flush interval's worth of play, and below the server's per-batch cap so that a normal
 *  flush is never truncated. */
export const QUEUE_CAPACITY = 60;

/** Matches the log module's cadence, deliberately: two background flushes on the same
 *  rhythm are one wake-up, and the exit flush is what actually protects the data. */
export const FLUSH_INTERVAL_MS = 30_000;

/** The route. `matchsvc` is the service Caddy proxies wholesale. */
export const CLIENT_EVENTS_PATH = '/client/events';

/** What the SDK needs from the outside world. */
export interface AnalyticsDeps {
  /** Stable per browser, never the account id — see `identity.ts`'s `getInstallId`. */
  install: string;
  /** New per visit. */
  session: string;
  host: AnalyticsHost;
  /**
   * Read at FLUSH time, not captured at install.
   *
   * Both of the next two are getters for the same reason, and it is a reason this project
   * has already paid for once: `clientLog`'s build-version field was a value captured at
   * install, nothing could supply it that early (the manifest arrives from `/version.json`
   * after boot), so every real client reported `unknown` while the dashboard panel that
   * splits errors by build looked perfectly populated. `locale` has the milder version of
   * the same problem — a player can change language from the settings screen mid-visit.
   */
  build: () => string;
  locale: () => string;
  now: () => number;
  /** Fire-and-forget. Never awaited, never allowed to throw into a caller. */
  send: (batch: AnalyticsBatch) => void;
}

export interface Analytics {
  /** Record an event. Synchronous, non-blocking, and safe to call from anywhere. */
  track: (name: AnalyticsEventName, props?: Record<string, PropValue>) => void;
  /** Send what is queued. A no-op when the queue is empty — an empty batch is a request
   *  that costs a round trip to say nothing, and the server would refuse it anyway. */
  flush: () => void;
  /** For tests and for the install layer's own assertions. */
  pending: () => number;
}

export function createAnalytics(deps: AnalyticsDeps): Analytics {
  const queue: AnalyticsEvent[] = [];

  const track = (name: AnalyticsEventName, props?: Record<string, PropValue>): void => {
    // The props object is copied rather than referenced: a caller reusing one mutable
    // object for every call would otherwise have every queued event change under it, which
    // reads as "the data is wrong" long after the call site is forgotten.
    const event: AnalyticsEvent = props === undefined ? { name, at: deps.now() } : { name, at: deps.now(), props: { ...props } };
    queue.push(event);
    while (queue.length > QUEUE_CAPACITY) queue.shift();
  };

  const flush = (): void => {
    if (queue.length === 0) return;
    // Splice first, then send. If `send` throws synchronously the events are already gone,
    // which is the correct outcome: keeping them would mean the next flush retries a batch
    // that has already failed once, forever.
    const events = queue.splice(0, LIMITS.eventsPerBatch);
    const batch: AnalyticsBatch = {
      install: deps.install,
      session: deps.session,
      host: deps.host,
      build: deps.build(),
      locale: deps.locale(),
      sentAt: deps.now(),
      events,
    };
    try {
      deps.send(batch);
    } catch {
      /* a sender that throws is a sender that sent nothing; the game continues */
    }
  };

  return { track, flush, pending: () => queue.length };
}

/**
 * The module-level handle, so a call site does not have to be handed one.
 *
 * A module singleton rather than a parameter threaded through the game, for the same reason
 * `assetHost.ts` and `hostKind.ts` are: the readers are scattered across screens that have
 * no other reason to know about the network, and the alternative is a constructor argument
 * in a dozen places whose only job is to be passed on.
 *
 * Before {@link setAnalytics} is called — in a test, in a tool, in the WeChat build if it
 * opts out — {@link track} is a no-op. That is the default on purpose: a missing analytics
 * handle must never be a crash, and it must never be a reason for a call site to write
 * `if (analytics)`.
 */
let current: Analytics | null = null;

export function setAnalytics(a: Analytics | null): void {
  current = a;
}

/** Record an event, if analytics is installed. The one function call sites use. */
export function track(name: AnalyticsEventName, props?: Record<string, PropValue>): void {
  current?.track(name, props);
}

/** Flush now, if analytics is installed. */
export function flushAnalytics(): void {
  current?.flush();
}

/** Test-only: forget the installed handle. */
export function resetAnalyticsForTests(): void {
  current = null;
}
