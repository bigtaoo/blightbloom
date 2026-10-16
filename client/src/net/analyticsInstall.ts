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
import type { AnalyticsBatch, AnalyticsHost, DeviceClass, OsFamily, BrowserFamily } from './analyticsEvents';
import { getInstallId, installIdStorage } from './identity';
import { createActiveClock } from './activeClock';
import { deviceSplit, trafficSource } from './visitContext';

/** What `session_start` says about where the visit came from and what it runs on. */
export interface VisitProps {
  source?: string;
  device?: DeviceClass;
  os?: OsFamily;
  browser?: BrowserFamily;
}

/** What `index.html`'s inline beacon leaves on `globalThis.__bbOpen`: the visit id it sent
 *  `page_open` under, and when. */
export interface PageOpen {
  session: string;
  at: number;
}

/** The slice of `document` the visible-time clock reads. */
export interface VisibilitySource {
  hidden: boolean;
  addEventListener: (type: 'visibilitychange', fn: () => void) => void;
  removeEventListener: (type: 'visibilitychange', fn: () => void) => void;
}

/** How often, at most, `active_time` is sent: once a minute of NEW visible time. */
export const ACTIVE_REPORT_STEP_S = 60;

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
  /**
   * Source and device split for `session_start`. Read from `navigator`, `location` and
   * `document.referrer` when absent; the WeChat entry passes its own, since that shell has
   * none of the three.
   */
  visit?: VisitProps;
  /**
   * The inline beacon's hand-off. When present, the visit reuses its session id — so
   * "opened but never booted" is a join by visit — and `session_start` carries `boot_ms`.
   * Defaults to `globalThis.__bbOpen`; `null` means there was none.
   */
  pageOpen?: PageOpen | null;
  /** Visibility for the playtime clock. `globalThis.document` by default; with no document
   *  (WeChat) the visit counts as visible throughout. */
  doc?: VisibilitySource | null;
}

let installed: Analytics | null = null;
let uninstall: (() => void) | null = null;

/** A random per-visit id. Not a security boundary and never persisted — it exists to group
 *  one visit's events together, and it means nothing outside this store. */
function randomSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `v-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** The browser's own answer to {@link VisitProps}. Every global is optional: a test runner,
 *  a worker or a shell without one gets fewer props, never a throw. */
export function browserVisit(g: {
  navigator?: { userAgent?: string; maxTouchPoints?: number };
  location?: { search?: string; hostname?: string };
  document?: { referrer?: string };
}): VisitProps {
  const visit: VisitProps = {};
  const ua = g.navigator?.userAgent;
  if (typeof ua === 'string') Object.assign(visit, deviceSplit(ua, g.navigator?.maxTouchPoints ?? 0));
  const source = trafficSource(g.location?.search ?? '', g.document?.referrer ?? '', g.location?.hostname ?? '');
  if (source !== undefined) visit.source = source;
  return visit;
}

/** `globalThis.__bbOpen` if it is the shape the inline script writes, else null. */
function readPageOpen(): PageOpen | null {
  const v = (globalThis as { __bbOpen?: unknown }).__bbOpen;
  if (typeof v !== 'object' || v === null) return null;
  const { session, at } = v as Record<string, unknown>;
  return typeof session === 'string' && session !== '' && typeof at === 'number' && Number.isFinite(at) ? { session, at } : null;
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
  const pageOpen = opts.pageOpen === undefined ? readPageOpen() : opts.pageOpen;
  const analytics = createAnalytics({
    install: getInstallId(),
    session: opts.session ?? pageOpen?.session ?? randomSessionId(),
    host: opts.host,
    build: () => opts.build() ?? 'unknown',
    locale: opts.locale,
    now,
    send,
  });

  const setIntervalFn = opts.setIntervalImpl ?? ((fn, ms) => setInterval(fn, ms));
  const clearIntervalFn = opts.clearIntervalImpl ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  // Visible time, and the heartbeat that reports it. The heartbeat rides the flush timer
  // rather than owning one: it only has to be roughly a minute, and a second timer is a
  // second thing to forget to clear.
  const doc = opts.doc === undefined ? ((globalThis as { document?: VisibilitySource }).document ?? null) : opts.doc;
  const clock = createActiveClock(now, doc === null ? true : !doc.hidden);
  const activeS = (): number => Math.round(clock.activeMs() / 1000);
  let reportedS = 0;
  const reportActive = (minStep: number): void => {
    const active = activeS();
    if (active - reportedS >= minStep) {
      reportedS = active;
      analytics.track('active_time', { active_s: active });
    }
  };
  // Going hidden reports whatever has accrued, however little: a backgrounded mobile tab is
  // the visit most likely to be killed with no `pagehide`, so its last number is queued now.
  // Queued, not flushed — see the `pagehide` note below for why hiding is no flush trigger
  // here (the WeChat entry flushes on `onHide` itself, after this has run).
  const onVisibility = (): void => {
    const visible = doc === null ? true : !doc.hidden;
    clock.setVisible(visible);
    if (!visible) reportActive(1);
  };
  doc?.addEventListener('visibilitychange', onVisibility);
  const timer = setIntervalFn(() => {
    reportActive(ACTIVE_REPORT_STEP_S);
    analytics.flush();
  }, opts.flushIntervalMs ?? 30_000);

  // `pagehide` rather than `beforeunload`, which iOS does not reliably fire. And
  // `visibilitychange` is deliberately NOT a flush trigger: a backgrounded tab on mobile is
  // the normal case, and flushing there would send a batch every time a phone call arrives.
  const target = opts.target ?? (globalThis as unknown as AnalyticsInstallOptions['target']);
  const onPageHide = (): void => {
    // Ordered: the event first, then the flush that carries it. `duration_s` is clamped to
    // the vocabulary's own bound by the server, so a machine that slept for a week reports
    // the cap rather than being dropped.
    analytics.track('session_end', { duration_s: Math.max(0, Math.round((now() - startedAt) / 1000)), active_s: activeS() });
    analytics.flush();
  };
  target?.addEventListener?.('pagehide', onPageHide);

  uninstall = () => {
    clearIntervalFn(timer);
    target?.removeEventListener?.('pagehide', onPageHide);
    doc?.removeEventListener('visibilitychange', onVisibility);
  };

  installed = analytics;
  setAnalytics(analytics);
  // The first event of the visit, and the row every retention cohort is built from. Last,
  // so that a throw anywhere above leaves nothing half-installed reporting a visit.
  // `storage` is read here, after `getInstallId()` above has minted or loaded the id.
  // `boot_ms` is measured from the inline beacon, so it includes downloading the bundle —
  // the wait a player actually sat through, not just this module's share of it.
  const visit = opts.visit ?? browserVisit(globalThis as Parameters<typeof browserVisit>[0]);
  const props: Record<string, string | number> = { storage: installIdStorage() };
  for (const [k, v] of Object.entries(visit)) if (v !== undefined) props[k] = v;
  if (pageOpen !== null) props.boot_ms = Math.max(0, Math.round(now() - pageOpen.at));
  analytics.track('session_start', props);
  return analytics;
}

/** Test-only: undo the install so the next test file starts clean. */
export function uninstallAnalyticsForTests(): void {
  uninstall?.();
  uninstall = null;
  installed = null;
  setAnalytics(null);
}
