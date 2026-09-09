/**
 * The wire half of analytics ingest (design/21 §2.3): an unknown body from the open
 * internet in, a batch of rows fit to store out — or `null`.
 *
 * Everything here is PURE. The route does the I/O, the rate limiting and the bearer
 * resolution; this file takes a value and returns either rows or nothing, which is what
 * makes every refusal below testable without a socket. It is the same split the client-log
 * validator beside it already uses, for the same reason.
 *
 * ## The vocabulary is not repeated here
 *
 * Every name, every field and every bound comes from `@dd/net/analyticsEvents`, the module
 * the CLIENT sends from. This file contains no list of event names at all — it reads the
 * table. That is deliberate: a validator carrying its own copy of the vocabulary is a
 * validator that can disagree with the sender, and the failure mode of that disagreement is
 * silence (events sent forever, dropped forever, nothing red anywhere).
 *
 * ## A device clock is not a clock
 *
 * Entries carry the client's own timestamps and a browser's clock can be wrong by years.
 * So a client timestamp is never stored: {@link anchorToServer} turns each one into an AGE
 * relative to the client's own send time, bounds that age, and subtracts it from the
 * SERVER's clock. Relative timing inside a visit survives; a device clock set to 2011
 * cannot file a row into 2011, which matters more here than it does for logs — a row's day
 * is what a retention cohort is keyed by, so one bad clock would otherwise invent a cohort.
 *
 * ## Refusals are cheap and quiet
 *
 * A malformed FIELD costs itself, a malformed EVENT costs itself, and only a body that is
 * not a recognisable batch at all costs the batch. Nothing here throws and nothing here
 * produces a 4xx: the route answers 200 with a count, because a 4xx teaches a client to
 * retry and a client retrying a malformed batch retries it forever.
 */
import {
  HOSTS,
  LIMITS,
  coerceProp,
  specFor,
  type AnalyticsEventName,
  type AnalyticsHost,
  type PropValue,
} from '@dd/net/analyticsEvents';

/** One row, ready to insert. `atMs` is SERVER-anchored — see the file header. */
export interface IngestedEvent {
  name: AnalyticsEventName;
  atMs: number;
  props: Record<string, PropValue>;
}

/** A validated batch. The account id is NOT here: the route attaches it from the bearer. */
export interface IngestedBatch {
  install: string;
  session: string;
  host: AnalyticsHost;
  build: string;
  locale: string;
  events: IngestedEvent[];
}

/** A bounded string, or null. Rejects the empty string, which is never a legal id here. */
function str(v: unknown, max: number): string | null {
  return typeof v === 'string' && v.length > 0 && v.length <= max ? v : null;
}

/** A member of a fixed set, or null. */
function oneOf<T extends string>(v: unknown, allowed: readonly T[]): T | null {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : null;
}

/** A real number, or null. `Number.isFinite` is the whole check: NaN and both infinities
 *  are the three ways a JSON number arrives unusable, and all three fail it. */
function finite(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Turn a client-clock instant into a server-anchored one.
 *
 * The age is clamped into `[0, LIMITS.maxAgeMs]`. A NEGATIVE age — an entry stamped after
 * the batch was sent — is a clock that moved during the visit, not a future event, so it
 * becomes "now" rather than being dropped. An age past the bound is clamped rather than
 * dropped for the same reason the log route clamps: a wrong clock should cost precision,
 * not the data.
 */
export function anchorToServer(entryMs: number, clientSentMs: number, serverNowMs: number): number {
  const age = clientSentMs - entryMs;
  const bounded = age < 0 ? 0 : age > LIMITS.maxAgeMs ? LIMITS.maxAgeMs : age;
  return serverNowMs - bounded;
}

/**
 * The UTC day an event belongs to, as `YYYY-MM-DD`.
 *
 * UTC and not a local zone, deliberately: the operator's zone is not the players' zone, and
 * a cohort's boundary has to be one fixed line for everybody or "the same day" stops being
 * a single set. It is computed from the SERVER-anchored instant, so a device clock cannot
 * choose which cohort its owner lands in.
 */
export function dayKey(atMs: number): string {
  return new Date(atMs).toISOString().slice(0, 10);
}

/** Validate one event object. Returns null when nothing usable is left of it. */
function parseEvent(item: unknown, clientSentMs: number, serverNowMs: number): IngestedEvent | null {
  if (typeof item !== 'object' || item === null) return null;
  const e = item as Record<string, unknown>;

  // `specFor` IS the membership test — it returns undefined for a name the vocabulary does
  // not have. Asking `isEventName` first and then looking the spec up would make the
  // spec-missing branch unreachable, which is a coverage hole and a dead guard at once.
  const spec = typeof e.name === 'string' ? specFor(e.name) : undefined;
  if (spec === undefined) return null;
  const name = e.name as AnalyticsEventName;
  const at = finite(e.at);
  if (at === null) return null;

  const props: Record<string, PropValue> = {};
  if (typeof e.props === 'object' && e.props !== null) {
    const raw = e.props as Record<string, unknown>;
    // Iterate the SPEC, never the payload: a loop over the payload's own keys is a loop
    // whose length an attacker chooses, and it is how an unknown prop gets stored by
    // accident. Walking the spec means an unnamed prop is not rejected — it is unreachable,
    // and the prop count is bounded by the vocabulary rather than by a cap that would never
    // be reached and so could never be tested.
    for (const [field, fieldSpec] of Object.entries(spec)) {
      const value = coerceProp(fieldSpec, raw[field]);
      if (value !== undefined) props[field] = value;
    }
  }

  return { name, atMs: anchorToServer(at, clientSentMs, serverNowMs), props };
}

/**
 * Parse a whole batch. `null` means "nothing here to store" — a body that is not an object,
 * an envelope missing a field that identifies the visit, or an events array from which
 * nothing survived validation.
 */
export function parseAnalyticsBatch(body: unknown, serverNowMs: number): IngestedBatch | null {
  if (typeof body !== 'object' || body === null) return null;
  const raw = body as Record<string, unknown>;

  const install = str(raw.install, LIMITS.idMax);
  const session = str(raw.session, LIMITS.idMax);
  const host = oneOf(raw.host, HOSTS);
  const sentAt = finite(raw.sentAt);
  if (install === null || session === null || host === null || sentAt === null) return null;

  // A missing build or locale is normal (a dev build with no manifest, a host that has no
  // locale to report), and losing the batch over either would lose exactly the data from
  // the odd build — the same trade the log route makes for its `ver`.
  const build = str(raw.build, LIMITS.shortMax) ?? 'unknown';
  const locale = str(raw.locale, LIMITS.shortMax) ?? 'unknown';

  if (!Array.isArray(raw.events)) return null;
  const events: IngestedEvent[] = [];
  for (const item of raw.events.slice(0, LIMITS.eventsPerBatch)) {
    const parsed = parseEvent(item, sentAt, serverNowMs);
    if (parsed !== null) events.push(parsed);
  }

  return events.length > 0 ? { install, session, host, build, locale, events } : null;
}
