/**
 * The client's feature-flag reader (design/21-ops-analytics.md §9's delivery path): fetch
 * `GET /client/flags`, hold the answer, and never make anything worse when the fetch fails.
 *
 * The contract — the names, the types, the shipped defaults and the parse — is
 * `./publicFlags.ts`, which the SERVER imports too. This file is the browser's half: a
 * module-level store, a typed getter every call site uses, and a poll.
 *
 * ## Fail-safe by construction, the same way the services are
 *
 * `server/src/flags/client.ts` states the rule and this file follows it exactly, because a
 * flag that means one thing in a service and another in a browser is worse than no flag.
 * The store STARTS at {@link PUBLIC_FLAG_DEFAULTS} and is replaced, wholesale, only by a
 * complete usable answer. An unreachable server, a 404 from a deployment that predates this
 * route, an HTML error page from something in front of it, a body that is not JSON, a
 * banner over its cap — every one of them leaves the previous values in place. So "the flag
 * route is unreachable" and "the flags are as shipped" are the same state, and there is no
 * arrangement of failures that produces a third one.
 *
 * ## Why a module sink rather than a value threaded through the game
 *
 * The two call sites are a results-screen offer and a menu label, which have no dependency
 * bundle between them and are eleven constructor arguments apart. Same shape, and the same
 * reasoning, as `setUiAudio`/`setHostKind`/`setAnalytics` — a getter a screen calls, set
 * once at boot by an entry point. {@link setPublicFlags} with `null` is how a test resets
 * it, and is also what makes "no poller installed" a real state rather than an accident.
 *
 * ## Why it re-polls, and why the interval is five minutes and not sixty seconds
 *
 * A boot-only fetch would deliver the ad-offer switch fine — it is read when a run ends —
 * and would miss the banner's whole purpose. The player who needs to be told the servers
 * are going down in twenty minutes is the one already sitting in the menu, and they are
 * exactly the player a boot-only fetch cannot reach.
 *
 * Five minutes rather than the services' sixty seconds because the cost scales with
 * PLAYERS, not with processes: a handful of services at one request a minute is noise, and
 * every live client at one request a minute is a load pattern chosen for nothing. An operator
 * putting up a maintenance notice is working in tens of minutes, so five is inside the
 * decision it serves. A backgrounded tab's timer is throttled by the browser on top of
 * that, which is free and in the right direction.
 */
import {
  PUBLIC_FLAGS_PATH,
  PUBLIC_FLAG_DEFAULTS,
  parsePublicFlags,
  type PublicFlagName,
  type PublicFlags,
} from './publicFlags';

/** See the file header on why this is not sixty seconds. */
export const PUBLIC_FLAG_POLL_INTERVAL_MS = 300_000;

let values: PublicFlags = { ...PUBLIC_FLAG_DEFAULTS };

/**
 * One flag's current value. Type-preserving, so `publicFlag('ui.maintenanceBanner')` is a
 * `string` and `publicFlag('ads.rewardedOfferEnabled')` is a `boolean`, and a typo at a call
 * site is a compile error rather than an `undefined` that reads as "off".
 */
export function publicFlag<K extends PublicFlagName>(name: K): PublicFlags[K] {
  return values[name];
}

/** Everything, as a snapshot — for a diagnostics readout, and for a test's assertion. */
export function publicFlagsSnapshot(): PublicFlags {
  return { ...values };
}

let listener: (() => void) | null = null;

/**
 * Whoever wants to be told a value changed. ONE slot, not a list, and that is the design
 * rather than a shortcut: there is exactly one thing on screen that has to react to a flag
 * arriving after it was drawn — the menu's maintenance banner — and a single slot makes the
 * second such consumer a decision somebody has to make rather than a registration they can
 * add. Same shape as every other module sink here (`setUiAudio`, `setHostKind`).
 *
 * `null` unsubscribes, which is how a test leaves the module as it found it.
 */
export function setPublicFlagsListener(fn: (() => void) | null): void {
  listener = fn;
}

/**
 * Replace the store, or reset it to the shipped defaults with `null`. Returns whether
 * anything actually changed, and notifies {@link setPublicFlagsListener} when it did.
 *
 * Notifying on CHANGE and not on every write is what keeps a five-minute poll from
 * re-laying out a screen every five minutes for nothing — and it is why `refresh` below
 * does not compute "changed" itself: one comparison, in the one place that knows both the
 * old and the new values.
 *
 * A FRESH copy on reset, never the exported constant itself: handing out the module's own
 * object would let one mutation outlive the failure that produced it, and "falls back to
 * the compiled-in default" would quietly stop being true after the first one. Same reason
 * `server/src/flags/defs.ts`'s `defaultFlags()` returns a new object.
 */
export function setPublicFlags(next: PublicFlags | null): boolean {
  const wanted = next === null ? { ...PUBLIC_FLAG_DEFAULTS } : { ...next };
  const changed = (Object.keys(wanted) as PublicFlagName[]).some((n) => values[n] !== wanted[n]);
  values = wanted;
  if (changed) listener?.();
  return changed;
}

export interface PublicFlagPollerOptions {
  /** Origin of matchsvc, as the entry points already resolve it for the log route. */
  baseUrl: string;
  /** Injected by tests; the global otherwise, and ABSENT on the WeChat shell — see
   *  {@link installPublicFlags} on what that means there. */
  fetchImpl?: typeof fetch;
  intervalMs?: number;
  setIntervalImpl?: (fn: () => void, ms: number) => unknown;
  clearIntervalImpl?: (handle: unknown) => void;
  /** Where a transition into "cannot reach the flag route" is reported. `console.warn` by
   *  default, which `installClientLog` has already wrapped by the time this runs, so the
   *  line reaches the same store the services' own warning does. */
  warn?: (msg: string) => void;
}

export interface PublicFlagPoller {
  /** One fetch, awaited. Resolves to whether the values CHANGED. Never throws. */
  refresh(): Promise<boolean>;
  /**
   * The BOOT fetch — the one {@link installPublicFlags} issues before it returns — as
   * something a caller can wait on.
   *
   * It exists because the alternative is a floating promise: the boot poll has to happen
   * (a client that waited five minutes for its first values would ship a banner nobody set
   * and an ad offer nobody checked), and without a handle on it nothing can tell whether it
   * has landed. Nothing in the game awaits this — boot must not block on a network call for
   * a menu label — but a diagnostics readout can, and every test in `clientFlags.test.ts`
   * does, which is what makes those tests deterministic rather than dependent on microtask
   * ordering.
   */
  readonly first: Promise<boolean>;
  /** Whether the last fetch produced a usable answer. */
  healthy(): boolean;
  stop(): void;
}

let poller: PublicFlagPoller | null = null;

/**
 * Install the poll once and return it; a second call returns the first untouched, the way
 * `installAnalytics` and `installClientLog` do — every entry point calls this and two
 * entries can legitimately be loaded in one test file.
 *
 * **On the WeChat shell this is inert, and deliberately installed anyway.** That runtime has
 * no `fetch` at all (which is also why `installClientLog` ships nothing there), so the poll
 * never runs and every flag stays at its shipped default — the same fail-safe state as an
 * unreachable server. Calling it from that entry point rather than omitting the call is the
 * choice that leaves a record: the day an adapter over `wx.request` exists, delivery on that
 * host is one seam away instead of a missing call nobody remembers to add. §9's WeChat note
 * already names that adapter as the fix for three things; this is the fourth.
 */
export function installPublicFlags(opts: PublicFlagPollerOptions): PublicFlagPoller {
  if (poller !== null) return poller;

  const doFetch = opts.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);
  const setTimer = opts.setIntervalImpl ?? ((fn, ms) => setInterval(fn, ms));
  const clearTimer = opts.clearIntervalImpl ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  const warn = opts.warn ?? ((msg: string) => console.warn(msg));
  const url = `${opts.baseUrl.replace(/\/+$/, '')}${PUBLIC_FLAGS_PATH}`;

  let ok = false;
  // Monotonic, and the reason there is no in-flight guard. Two fetches CAN overlap — a
  // stalled one and the next interval's — and without this the stalled one's older values
  // would land last and win, reverting a flag for one whole interval. Only the newest fetch
  // issued may write, so a slow response is dropped rather than applied out of order.
  let generation = 0;
  let timer: unknown = null;

  const refresh = async (): Promise<boolean> => {
    if (doFetch === undefined) return false;
    const mine = ++generation;
    let parsed: PublicFlags | null = null;
    try {
      // `credentials: 'omit'` for the reason every other call in this directory carries it:
      // matchsvc answers `access-control-allow-origin: *`, and a wildcard origin is illegal
      // for a credentialed request. No `keepalive` — nothing here needs to survive the page
      // going away, and an unload-time flag read would be a fetch for a screen nobody sees.
      const res = await doFetch(url, { method: 'GET', credentials: 'omit' });
      parsed = res.ok ? parsePublicFlags(await res.json()) : null;
    } catch {
      parsed = null;
    }
    // Superseded by a newer fetch: a complete no-op, and the generation check comes FIRST
    // for that reason. Dropping only a stale SUCCESS would still let a stalled poll's
    // failure mark the client unhealthy — and emit the warning — after a newer poll had
    // already succeeded, which is a log line contradicting the values in use.
    if (mine !== generation) return false;
    if (parsed === null) {
      // One line per TRANSITION out of healthy, never one per failed cycle — and nothing at
      // all before the first success, which is what keeps a dev client with no server behind
      // it (and every offline player) silent instead of warning once a boot.
      if (ok) warn(`[flags] cannot reach ${url} — using the values this build shipped with`);
      ok = false;
      return false;
    }
    ok = true;
    return setPublicFlags(parsed);
  };

  poller = {
    refresh,
    // Issued HERE rather than after the object is built, so the boot fetch is in flight
    // before this function returns — the poll is not delayed by whatever the caller does
    // next — while still being something to await instead of a promise nobody holds.
    first: refresh(),
    healthy: () => ok,
    stop(): void {
      if (timer !== null) clearTimer(timer);
      timer = null;
      poller = null;
    },
  };

  timer = setTimer(() => void refresh(), opts.intervalMs ?? PUBLIC_FLAG_POLL_INTERVAL_MS);
  return poller;
}

/** The installed poller, or `null` on a build that never installed one. */
export function publicFlagPoller(): PublicFlagPoller | null {
  return poller;
}
