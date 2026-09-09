/**
 * Attaches {@link createAnalytics} to a real browser: the sender, the flush timer, and the
 * one event that fires when the page is going away.
 *
 * Split from `analytics.ts` for the reason every seam in this codebase is split — the
 * queue, the batching and the wire format are testable with no DOM, and this file, which
 * cannot be, holds nothing but wiring.
 *
 * ## `fetch` with `keepalive`, never `navigator.sendBeacon`
 *
 * This is not a preference and porting it wrong makes the exit flush silently never land,
 * which costs exactly `session_end` — half of the churn funnel. Two independent reasons,
 * both of which the log module beside this one already documents:
 *
 *  - `sendBeacon` always sends CREDENTIALED, so the browser requires
 *    `Access-Control-Allow-Credentials: true` on a cross-origin response — and matchsvc
 *    answers `Access-Control-Allow-Origin: *`, which is incompatible with credentials by
 *    specification. The client is on `b.gamestao.com` and the server on `bb.gamestao.com`,
 *    so every send here is cross-origin.
 *  - `sendBeacon` cannot set headers at all, so it can never carry `Authorization`. The
 *    server resolves the account from that header, so a beacon-only exit path would make
 *    every exit event anonymous. funny measured exactly this: 2,848 `session_end` rows, not
 *    one of them attributable, and the churn funnel is built on that event.
 *
 * ## The token is read per flush, not captured once
 *
 * A player who logs in mid-visit starts being attributable without the SDK having to be
 * told, and a player who logs out stops. Same reason the log module reads it per flush.
 *
 * ## `session_start` and `session_end` are emitted HERE
 *
 * Not from a call site, because a visit beginning is not something the game does — it is
 * this module existing. Emitting them here makes exactly one of each per visit true by
 * construction, where two call sites in two entry points would make it a convention that
 * a third entry point can forget. `session_end` rides the same `pagehide` that triggers the
 * exit flush, and is pushed BEFORE it so that it is in the batch rather than in the next
 * one, which for the last batch of a visit means "instead of nowhere".
 */
import { CLIENT_EVENTS_PATH, createAnalytics, setAnalytics, type Analytics } from './analytics';
import type { AnalyticsBatch, AnalyticsHost } from './analyticsEvents';
import { getInstallId } from './identity';

export interface AnalyticsInstallOptions {
  /** Origin of matchsvc, as `main.ts` already resolves it for the log route. */
  baseUrl: string;
  /** The bearer token of the logged-in session, or null for a guest. */
  token: () => string | null;
  host: AnalyticsHost;
  /**
   * The deployed build, read per flush. `null` is legitimate and becomes `'unknown'`: a dev
   * build has no version manifest, the WeChat config never runs the manifest plugin, and
   * the portal build is served from a sub-path where the absolute manifest URL 404s. Same
   * three cases `installClientLog`'s own `version` getter documents, and the same handling.
   */
  build: () => string | null;
  /** The current language, read per flush — a player can change it mid-visit. */
  locale: () => string;
  /** Injected by tests. */
  fetchImpl?: typeof fetch;
  now?: () => number;
  /**
   * The global to attach the exit listener to. `globalThis`, not `window` — the WeChat shell
   * has no `window` and that entry installs this module too.
   *
   * On that shell `globalThis.addEventListener` exists (Pixi's `EventSystem` needs it) and
   * `pagehide` is never dispatched, so the listener below is dead weight there rather than a
   * second flush: `session_end` is simply ABSENT on that host. `wx.onHide` is not a
   * substitute — it fires on every backgrounding and is followed by `onShow`, so feeding it
   * in would multiply the row the churn funnel counts and understate every duration.
   * `main.wechat.ts` uses it for the flush alone, which is the half of `pagehide` that is
   * honest there.
   */
  target?: {
    addEventListener?: (type: string, fn: () => void) => void;
    removeEventListener?: (type: string, fn: () => void) => void;
  };
  setIntervalImpl?: (fn: () => void, ms: number) => unknown;
  clearIntervalImpl?: (handle: unknown) => void;
  /** Overridable so a test does not have to wait 30 seconds. */
  flushIntervalMs?: number;
  /** The per-visit id. Injected only so a test can pin it; generated otherwise. */
  session?: string;
}

let installed: Analytics | null = null;
let uninstall: (() => void) | null = null;

/** A random per-visit id. Not a security boundary and never persisted — it exists to group
 *  one visit's events together, and it means nothing outside this store. */
function randomSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `v-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Install once and return the handle. A second call returns the first one untouched — every
 * entry point calls this, and two entry points can legitimately be loaded in one test file.
 */
export function installAnalytics(opts: AnalyticsInstallOptions): Analytics {
  if (installed) return installed;

  const now = opts.now ?? (() => Date.now());
  const doFetch = opts.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);
  const url = `${opts.baseUrl.replace(/\/$/, '')}${CLIENT_EVENTS_PATH}`;

  const send = (batch: AnalyticsBatch): void => {
    if (doFetch === undefined) return;
    const token = opts.token();
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token !== null) headers.authorization = `Bearer ${token}`;
    void doFetch(url, {
      method: 'POST',
      headers,
      // `credentials: 'omit'` is required, not tidy: matchsvc answers
      // `access-control-allow-origin: *`, and a wildcard origin is illegal for a
      // credentialed request.
      credentials: 'omit',
      keepalive: true,
      body: JSON.stringify(batch),
    }).catch(() => {
      /* a log store that is down must not surface anywhere near a player */
    });
  };

  const startedAt = now();
  const analytics = createAnalytics({
    install: getInstallId(),
    session: opts.session ?? randomSessionId(),
    host: opts.host,
    build: () => opts.build() ?? 'unknown',
    locale: opts.locale,
    now,
    send,
  });

  const setIntervalFn = opts.setIntervalImpl ?? ((fn, ms) => setInterval(fn, ms));
  const clearIntervalFn = opts.clearIntervalImpl ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  const timer = setIntervalFn(() => analytics.flush(), opts.flushIntervalMs ?? 30_000);

  // `pagehide` rather than `beforeunload`, which iOS does not reliably fire. And
  // `visibilitychange` is deliberately NOT a flush trigger: a backgrounded tab on mobile is
  // the normal case, and flushing there would send a batch every time a phone call arrives.
  const target = opts.target ?? (globalThis as unknown as AnalyticsInstallOptions['target']);
  const onPageHide = (): void => {
    // Ordered: the event first, then the flush that carries it. `duration_s` is clamped to
    // the vocabulary's own bound by the server, so a machine that slept for a week reports
    // the cap rather than being dropped.
    analytics.track('session_end', { duration_s: Math.max(0, Math.round((now() - startedAt) / 1000)) });
    analytics.flush();
  };
  target?.addEventListener?.('pagehide', onPageHide);

  uninstall = () => {
    clearIntervalFn(timer);
    target?.removeEventListener?.('pagehide', onPageHide);
  };

  installed = analytics;
  setAnalytics(analytics);
  // The first event of the visit, and the row every retention cohort is built from. Last,
  // so that a throw anywhere above leaves nothing half-installed reporting a visit.
  analytics.track('session_start');
  return analytics;
}

/** Test-only: undo the install so the next test file starts clean. */
export function uninstallAnalyticsForTests(): void {
  uninstall?.();
  uninstall = null;
  installed = null;
  setAnalytics(null);
}
