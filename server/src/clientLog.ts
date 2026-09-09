/**
 * The browser half of the log store: validation, and the Loki push payload.
 *
 * A player's console is the one place where "it broke" is visible and nowhere else. This
 * module turns a batch of client-side log entries into a Loki push body — and, much more
 * of its length, refuses the ways a batch can be wrong.
 *
 * Everything here is PURE. The route (`routes/telemetry.ts`) does the I/O, the rate
 * limiting and the auth; this file takes an unknown value and returns either a payload or
 * a reason, which is what makes the interesting parts testable without a socket.
 *
 * ## Three properties worth stating before the code
 *
 * **Labels are a fixed, tiny set.** `source`, `level`, `host` — three names, and `host` has
 * three possible values. Everything identifying (the session id, the build, the account,
 * the tag) goes into the LINE as logfmt and is filtered at query time. This is not a style
 * preference: a label per session id would make one Loki stream per player per visit,
 * which is the standard way to make a log store unqueryable, and it is reachable here
 * because the values come from the open internet.
 *
 * **Every client-supplied value is capped or allowlisted, without exception.** This
 * endpoint takes a body from anyone who can reach `bb.gamestao.com` — no account needed,
 * because the errors most worth having are the ones that happen before or instead of a
 * login. funny's own audit of the equivalent endpoint (`claudedocs/server-audits.md`)
 * found an uncapped id field amplifying ~200x into its log store; the caps below are that
 * lesson, applied before rather than after.
 *
 * **A device clock is not a clock.** Entries carry the client's own timestamps, and a
 * browser's clock can be wrong by years — set forward past Loki's future-sample rejection,
 * or back past its retention window, either of which drops the batch with nothing visible
 * at this end. So client timestamps are never used directly: `toNanos` converts each entry
 * to an AGE (how long before the client sent the batch), bounds that age, and subtracts it
 * from the SERVER's clock. Relative timing inside a session survives; an absurd device
 * clock cannot push anything outside the ingestible window.
 */

/** The three build targets, matching `client/src/platform/hostKind.ts`'s `HostKind`. */
export const HOSTS = ['web', 'wechat', 'crazygames'] as const;
export type ClientHost = (typeof HOSTS)[number];

/** Same four names the server logger uses, so one vocabulary covers both halves. */
export const CLIENT_LEVELS = ['error', 'warn', 'info', 'debug'] as const;
export type ClientLevel = (typeof CLIENT_LEVELS)[number];

export const LIMITS = {
  /** Entries per request. A client's own ring buffer is 200 (`client/src/net/clientLog.ts`),
   *  so this is that buffer emptied in one flush and nothing beyond it. */
  entries: 200,
  msg: 1000,
  tag: 48,
  /** An opaque per-visit random id the client mints; never an account id, never a device id. */
  session: 40,
  ver: 40,
  /** The oldest an entry may claim to be. Anything older is clamped to it rather than
   *  dropped — a stale entry is still evidence, and a hole is not. */
  ageMs: 60 * 60 * 1000,
} as const;

export interface ClientLogEntry {
  /** Client-clock milliseconds when the line was recorded. */
  t: number;
  level: ClientLevel;
  msg: string;
  /** Optional sub-area, e.g. `net` / `boot` / `render`. */
  tag?: string;
}

export interface ClientLogBatch {
  session: string;
  host: ClientHost;
  ver: string;
  /** The client's own `Date.now()` at the moment it sent, the anchor `toNanos` measures ages against. */
  now: number;
  entries: ClientLogEntry[];
}

/** A Loki push body: `{ streams: [{ stream: {labels}, values: [[ns, line], ...] }] }`. */
export interface LokiPayload {
  streams: Array<{ stream: Record<string, string>; values: Array<[string, string]> }>;
}

const str = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.trim().slice(0, max);
  return t.length > 0 ? t : null;
};

const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): T | null =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : null;

const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Parse an untrusted body into a batch, or return `null`.
 *
 * `null` means "nothing usable here" and the route answers 200 anyway — a telemetry
 * endpoint that returns 4xx teaches a client to retry, and a client retrying a malformed
 * body retries it forever. Individual bad ENTRIES are dropped while their siblings
 * survive, for the same reason a single unserialisable field should not lose a crash
 * report.
 */
export function parseBatch(body: unknown): ClientLogBatch | null {
  if (typeof body !== 'object' || body === null) return null;
  const raw = body as Record<string, unknown>;

  const session = str(raw.session, LIMITS.session);
  const host = oneOf(raw.host, HOSTS);
  const now = finite(raw.now);
  if (!session || !host || now === null) return null;

  // A missing build version is normal (a dev build, a target that has no manifest), and
  // losing the whole batch over it would lose exactly the logs from the odd build.
  const ver = str(raw.ver, LIMITS.ver) ?? 'unknown';

  if (!Array.isArray(raw.entries)) return null;
  const entries: ClientLogEntry[] = [];
  for (const item of raw.entries.slice(0, LIMITS.entries)) {
    if (typeof item !== 'object' || item === null) continue;
    const e = item as Record<string, unknown>;
    const level = oneOf(e.level, CLIENT_LEVELS);
    const msg = str(e.msg, LIMITS.msg);
    const t = finite(e.t);
    if (!level || !msg || t === null) continue;
    const tag = str(e.tag, LIMITS.tag);
    entries.push(tag ? { t, level, msg, tag } : { t, level, msg });
  }
  return entries.length > 0 ? { session, host, ver, now, entries } : null;
}

/**
 * A client-clock instant, as Loki nanoseconds on the SERVER's clock. See the header for
 * why this is an age subtraction rather than a conversion.
 *
 * `BigInt` rather than `ms * 1e6`: the product exceeds `Number.MAX_SAFE_INTEGER`, so the
 * decimal string of a plain number is both lossy and, past 1e21, in exponential notation —
 * which Loki rejects outright. funny hit exactly this.
 */
export function toNanos(entryMs: number, clientNowMs: number, serverNowMs: number): string {
  const age = Math.min(Math.max(clientNowMs - entryMs, 0), LIMITS.ageMs);
  return (BigInt(Math.trunc(serverNowMs - age)) * 1_000_000n).toString();
}

/** logfmt-quote a value so `| logfmt` reads it back as one field. */
function field(key: string, value: string): string {
  return `${key}=${/^[\w./:@+-]+$/.test(value) ? value : JSON.stringify(value)}`;
}

export interface BuildOptions {
  batch: ClientLogBatch;
  serverNowMs: number;
  /**
   * The account this batch belongs to, resolved SERVER-side from the request's bearer
   * token — never a field the body may set. Absent for a guest, which is most of them:
   * the crash that happens before a login is the one worth having.
   */
  accountId?: string;
}

/**
 * Group a batch into one Loki stream per level and render each entry as a logfmt line.
 *
 * One stream per level rather than one per entry because Loki charges per stream, and
 * because `{source="client", level="error"}` is the query every dashboard panel starts
 * from. Values are sorted oldest-first within each stream — Loki 3 accepts out-of-order
 * within its window, but "accepts" and "accepts silently under every limit configuration"
 * are different claims, and sorting costs nothing on 200 entries.
 */
export function buildLokiPayload({ batch, serverNowMs, accountId }: BuildOptions): LokiPayload {
  const byLevel = new Map<ClientLevel, Array<[string, string]>>();

  for (const entry of batch.entries) {
    const parts = [
      field('session', batch.session),
      field('ver', batch.ver),
      accountId ? field('acct', accountId) : null,
      entry.tag ? field('tag', entry.tag) : null,
      field('msg', entry.msg),
    ].filter((p): p is string => p !== null);

    const values = byLevel.get(entry.level) ?? [];
    values.push([toNanos(entry.t, batch.now, serverNowMs), parts.join(' ')]);
    byLevel.set(entry.level, values);
  }

  return {
    streams: [...byLevel.entries()].map(([level, values]) => ({
      stream: { source: 'client', level, host: batch.host },
      values: values.sort((a, b) => (BigInt(a[0]) < BigInt(b[0]) ? -1 : 1)),
    })),
  };
}
