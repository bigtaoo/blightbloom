/**
 * The reader every service uses (design/21 §4): poll adminsvc's internal flags endpoint,
 * merge what comes back over the compiled-in defaults, and never make anything worse when
 * the poll fails.
 *
 * ## Fail-safe by construction, not by care
 *
 * A service never opens `ops.db`. It holds a `FlagValues` object that STARTS as
 * `defaultFlags()` and is replaced, wholesale, only when a poll produces a complete usable
 * answer. Every failure — adminsvc down, DNS gone, a 401 because the internal key was
 * rotated on one side only, an HTML error page from something in front of it, a body that is
 * not JSON, a value outside its declared range — leaves the previous object in place. So
 * "the flag service is unreachable" and "the flags are as deployed" are the same state, and
 * there is no arrangement of failures that produces a third one.
 *
 * That is why {@link parseFlagsResponse} returns `null` for anything unusable rather than a
 * partial object: a partial merge would mean a garbled response could turn ONE flag off
 * while leaving the rest, which is a state nobody configured and nobody could reproduce.
 *
 * ## Why a poll and not a push
 *
 * design/19 §3's internal seam is a request/response one, and a push would need adminsvc to
 * know who its subscribers are — i.e. it would need the console to hold a list of live
 * services, and a service that missed a push would be silently on a stale value with
 * nothing to correct it. A poll has one failure mode (the value is up to one interval old)
 * and it is self-healing.
 *
 * ## What this does NOT do
 *
 * It does not decide anything. Nothing here reads a flag and acts; a call site asks
 * `flags.get('name')` and gets a value. C1's list of what may never be a flag is enforced
 * in `defs.ts`, at the only place that can enforce it — the allowlist itself.
 */
import { internalFetchJson } from '../internalFetch';
import type { Logger } from '../log';
import { FLAG_NAMES, coerceFlag, defaultFlags, type FlagName, type FlagValue, type FlagValues } from './defs';

/** The path adminsvc serves. Internal-only: `x-internal-key`, and never proxied by Caddy
 *  (it is under `/internal/`, which the console's dispatch chain answers and the reverse
 *  proxy has no route to — see `adminsvc/routes.ts`). */
export const INTERNAL_FLAGS_PATH = '/internal/flags';

/**
 * How often a service re-asks. 60s: a flag is an operational switch, not a control loop, and
 * an operator who flips one waits at most a minute. Four services at one request a minute is
 * noise next to a single player's `/find` polling.
 */
export const FLAG_POLL_INTERVAL_MS = 60_000;

/**
 * Per-attempt timeout, and no retry.
 *
 * `internalFetch`'s own header states the rule this follows: retry is for a call that
 * happens once and that nothing re-sends. A poll is the opposite — the next tick re-asks
 * anyway — so retrying here would only add load to a peer that is already struggling, and
 * the cost of skipping one cycle is that a flag is 60 seconds stale.
 */
export const FLAG_POLL_TIMEOUT_MS = 3_000;

/**
 * Parses a poll response into a complete flag set, or `null`.
 *
 * ALL-OR-NOTHING, deliberately (see the file header). A response is usable only when it is
 * an object carrying a usable value for every name in the allowlist. A missing name is
 * rejected rather than defaulted, because the two situations that produce one are a peer
 * running older code and a truncated body — and in both cases "use the default for that one
 * flag" silently reverts a deliberate override while the console keeps showing it as set.
 */
export function parseFlagsResponse(body: unknown): FlagValues | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const flags = (body as { flags?: unknown }).flags;
  if (typeof flags !== 'object' || flags === null || Array.isArray(flags)) return null;
  const source = flags as Record<string, unknown>;
  const out = {} as Record<FlagName, FlagValue>;
  for (const name of FLAG_NAMES) {
    // `hasOwnProperty` rather than a truthiness check: `false` and `0` and `''` are all
    // legitimate flag values, and every one of them is falsy.
    if (!Object.prototype.hasOwnProperty.call(source, name)) return null;
    const coerced = coerceFlag(name, source[name]);
    if (coerced === null) return null;
    out[name] = coerced;
  }
  return out as FlagValues;
}

export interface FlagClientOptions {
  /** Where adminsvc answers, e.g. `http://adminsvc:8790`. `null` disables polling entirely
   *  and the client stays on its defaults forever — which is the state of every deployment
   *  that has not set `BB_ADMINSVC_URL`, and a supported one. */
  baseUrl: string | null;
  /** The `x-internal-key` value, or `undefined` in design/19 §5's production fail-closed
   *  branch. Sent as-is; adminsvc rejects an absent key with a logged reason, which is the
   *  right outcome and a visible one. */
  key: string | undefined;
  /** Advisory caller name for the audit line on the far side. */
  caller: string;
  log: Logger;
  intervalMs?: number;
  /** Injected by tests; `internalFetch` reads `globalThis.fetch` at call time otherwise. */
  fetchImpl?: typeof fetch;
}

export interface FlagClient {
  /** The current value. Type-preserving: `get('ads.rewardedOfferEnabled')` is a `boolean`. */
  get<K extends FlagName>(name: K): FlagValues[K];
  /** Everything, as a snapshot. For a service that wants to log what it is running with. */
  all(): FlagValues;
  /** One poll, awaited. Returns whether the values CHANGED — so a caller can log a
   *  transition rather than a line a minute. Never throws. */
  poll(): Promise<boolean>;
  /** Starts the interval and does one immediate poll (not awaited). The interval is
   *  `unref`ed, so it never holds the process open — the same rule the analytics rollup
   *  job follows, and the reason a test that builds a client does not leak a timer. */
  start(): void;
  stop(): void;
  /** Whether the last poll produced a usable answer. `false` at startup, before the first
   *  one, and `false` again after a failure — so `/health` can say "running on defaults"
   *  instead of leaving it to be inferred. */
  healthy(): boolean;
}

export function createFlagClient(opts: FlagClientOptions): FlagClient {
  let values: FlagValues = defaultFlags();
  let ok = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  const url = opts.baseUrl === null ? null : `${opts.baseUrl.replace(/\/+$/, '')}${INTERNAL_FLAGS_PATH}`;

  const client: FlagClient = {
    get: (name) => values[name],
    all: () => ({ ...values }),
    healthy: () => ok,

    async poll(): Promise<boolean> {
      if (url === null) return false;
      const { result, json } = await internalFetchJson(url, {
        method: 'GET',
        internalKey: opts.key,
        caller: opts.caller,
        timeoutMs: FLAG_POLL_TIMEOUT_MS,
        fetchImpl: opts.fetchImpl,
      });
      const parsed = result.ok ? parseFlagsResponse(json) : null;
      if (parsed === null) {
        // One line per TRANSITION into unhealthy, not one per failed cycle: a peer that is
        // down for an hour would otherwise write sixty identical lines, which is how a log
        // store stops being read.
        if (ok) opts.log.warn('flag poll failed — keeping compiled-in defaults', { url, status: result.status });
        ok = false;
        return false;
      }
      const changed = FLAG_NAMES.some((name) => values[name] !== parsed[name]);
      values = parsed;
      if (!ok) opts.log.info('flag poll recovered', { url });
      ok = true;
      // The one line worth having per change: what an operator flipped, as seen from the
      // service that has to act on it.
      if (changed) opts.log.info('flags changed', flagFields(values));
      return changed;
    },

    start(): void {
      if (timer !== null) return;
      void client.poll();
      timer = setInterval(() => void client.poll(), opts.intervalMs ?? FLAG_POLL_INTERVAL_MS);
      // `unref()`, not `unref?.()`. `setInterval` here is Node's, which always has it — the
      // optional call was defending against a DOM-typed timer that cannot occur in this
      // process, i.e. a branch no input reaches.
      timer.unref();
    },

    stop(): void {
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
  };

  return client;
}

/** Flag values as log fields. Names carry dots, which `logfmt` handles, and the values are
 *  already bounded by `coerceFlag` — so this cannot put an unbounded string in a log line. */
export function flagFields(values: FlagValues): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const name of FLAG_NAMES) out[name] = values[name];
  return out;
}
