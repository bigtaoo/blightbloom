/**
 * The analytics event vocabulary — the ONE definition of what may be reported, shared by
 * the client that sends it and the server that refuses everything else (design/21 §2.2, A3).
 *
 * This module lives under `client/src/net/` and is imported by the server through the
 * `@dd/net/*` path alias, which is what makes "shared" literal rather than a comment. That
 * matters more here than anywhere else in the codebase: the server drops any event whose
 * name is not in this list, so two copies that drift do not produce a type error or a red
 * test — they produce an event the client sends forever and the server silently discards,
 * which is indistinguishable from "nobody does that any more". A single module cannot drift
 * from itself.
 *
 * Because the server bundles it, everything here is PURE — no browser globals, no imports,
 * no `Date.now()`. It is a table plus the functions that read it.
 *
 * ## Why a closed vocabulary at all
 *
 * `POST /client/events` takes a body from anybody who can reach `bb.gamestao.com`, exactly
 * like the log route beside it. An open `track(name, props)` surface is therefore an open
 * write into our own store from the internet, and funny's audit of its equivalent endpoint
 * found an uncapped id field amplifying ~200x into its log store. Every value below is
 * either an enumerated constant or bounded by a charset and a length, and there is no
 * escape hatch: a prop the table does not name is dropped, not stored.
 *
 * ## What is NOT here
 *
 * No account id and no `user_id` of any kind. The account, when there is a session at all,
 * is attached SERVER-side from the bearer token — a field the client can write is a field
 * that says nothing, the same rule the client log module already follows.
 */

/** The three build targets, matching `client/src/platform/hostKind.ts`'s `HostKind`. */
export const HOSTS = ['web', 'wechat', 'crazygames'] as const;
export type AnalyticsHost = (typeof HOSTS)[number];

/**
 * Caps on every client-supplied value. Sized so that a full batch at the wire limit is a
 * few tens of KB rather than a megabyte, and so that no single field can carry a payload.
 */
export const LIMITS = {
  /** Events per batch. The client flushes well below this; the server truncates at it. */
  eventsPerBatch: 100,
  /** Identifier fields (`install`, `session`) and every `id`-kind prop. */
  idMax: 48,
  /** `build` and `locale`, which are ours but still arrive over the wire. */
  shortMax: 32,
  /**
   * How far back a client-supplied timestamp may be, in ms. Older entries are clamped, not
   * dropped: a wrong device clock should cost precision, not the whole batch.
   */
  maxAgeMs: 24 * 60 * 60 * 1000,
} as const;

/** The charset an `id`-kind value may use. Deliberately narrow — content ids, screen names
 *  and generated ids all fit, and nothing that could be mistaken for markup or a query does. */
export const ID_RE = /^[a-z0-9_.:-]{1,48}$/;

/** A field's shape. `enum` is for a genuinely closed, small set; `id` for our own
 *  identifiers (charset- and length-capped); `int` for a bounded number. */
export type FieldSpec =
  | { kind: 'enum'; values: readonly string[] }
  | { kind: 'id' }
  | { kind: 'int'; min: number; max: number };

/**
 * The vocabulary. Adding an event here is the whole change on the ingest side — the parser
 * reads this table and knows nothing else about any particular event.
 *
 * Every `int` bound is a real bound rather than a large number: `floor` cannot exceed the
 * deepest floor the game has, and a `duration_s` past a day is a broken clock rather than a
 * long session. A bound that cannot be violated by correct data is free, and it is what
 * stops a hostile batch from storing arbitrary integers.
 */
export const EVENTS = {
  /** A visit began. The row every retention cohort is built from. */
  session_start: {},
  /** A visit ended (a timer, a hidden tab, or the page going away). */
  session_end: { duration_s: { kind: 'int', min: 0, max: 86_400 } },
  /** A screen was shown. The funnel's early steps live here. */
  screen_view: { screen: { kind: 'id' } },
  /**
   * A run began.
   *
   * `character` only, and the missing `weapon` is a finding rather than an omission: no
   * AUTHORED weapon id survives into the simulation state. A `WeaponState` carries a
   * `WeaponSimSpec` — numbers the sim reads — and nothing that names which weapon it came
   * from, whereas an actor keeps `atlasKey` because something has to draw it. Declaring a
   * field nothing can populate would put an always-absent column in the table and an
   * always-empty panel on the dashboard, so it is left out until there is a source for it.
   */
  run_start: { character: { kind: 'id' } },
  /** A run ended, however it ended. `abandon` is the one this exists for. */
  run_end: {
    outcome: { kind: 'enum', values: ['win', 'loss', 'abandon'] },
    floor: { kind: 'int', min: 0, max: 999 },
    duration_s: { kind: 'int', min: 0, max: 86_400 },
  },
  /**
   * A purchase completed.
   *
   * There is no `store_open` beside it, and that is a decision rather than a gap: opening
   * the store IS `screen_view { screen: 'store' }`, and the rollup counts screen views per
   * SCREEN (`rollup.ts`'s `screenViewCounts`), so the conversion denominator already exists
   * as its own gauge. A second event for the same act would put the same number in the
   * table twice and give two panels that must be kept in agreement by hand.
   */
  store_purchase: { sku: { kind: 'id' } },
  /** The rewarded-ad offer (design/20): shown, and taken. */
  ad_offer_shown: {},
  ad_completed: {},
} as const satisfies Record<string, Record<string, FieldSpec>>;

export type AnalyticsEventName = keyof typeof EVENTS;

/** Every legal event name, for the parser's membership test and for tests that sweep. */
export const EVENT_NAMES = Object.keys(EVENTS) as readonly AnalyticsEventName[];

/** A prop value, after validation. */
export type PropValue = string | number;

/** One event as it travels: the name, the client's own clock, and its props. */
export interface AnalyticsEvent {
  name: AnalyticsEventName;
  /** Client clock, ms. Never trusted as a time — see the batch's `sentAt`. */
  at: number;
  props?: Readonly<Record<string, PropValue>>;
}

/** The envelope. The fields that are constant for a visit ride here rather than on every
 *  event, which is most of why a batch is small. */
export interface AnalyticsBatch {
  /** Browser-local install id (design/21 A2). Random, first-party, clearable. */
  install: string;
  /** Per-visit id. Means nothing outside this store. */
  session: string;
  host: AnalyticsHost;
  build: string;
  locale: string;
  /** The client's clock when it sent this batch. Used ONLY to turn each `at` into an age. */
  sentAt: number;
  events: readonly AnalyticsEvent[];
}

export function isEventName(name: string): name is AnalyticsEventName {
  return Object.prototype.hasOwnProperty.call(EVENTS, name);
}

/** The spec table for one event, or undefined if the name is not in the vocabulary. */
export function specFor(name: string): Record<string, FieldSpec> | undefined {
  return isEventName(name) ? (EVENTS[name] as Record<string, FieldSpec>) : undefined;
}

/**
 * Validate one prop value against its spec. Returns the value to store, or `undefined` to
 * drop it.
 *
 * Dropping rather than rejecting is deliberate and matches the route's posture: a batch is
 * never refused for a bad field, because a refusal teaches a client to retry and a client
 * retrying a malformed batch retries it forever. What a bad field costs is itself.
 */
export function coerceProp(spec: FieldSpec, value: unknown): PropValue | undefined {
  switch (spec.kind) {
    case 'enum':
      return typeof value === 'string' && spec.values.includes(value) ? value : undefined;
    case 'id':
      return typeof value === 'string' && ID_RE.test(value) ? value : undefined;
    case 'int':
      // `Number.isInteger` rejects NaN, Infinity and every non-number, which is three of the
      // four ways this field goes wrong in one call. The fourth is a legal integer out of
      // range, and clamping it would invent data — so it is dropped like any other bad value.
      return typeof value === 'number' && Number.isInteger(value) && value >= spec.min && value <= spec.max
        ? value
        : undefined;
  }
}
