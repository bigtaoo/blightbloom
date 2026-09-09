/**
 * The feature-flag ALLOWLIST (design/21-ops-analytics.md §4, decision C1) — every flag that
 * exists, its type, its compiled-in default, and what it does.
 *
 * This file is the whole safety argument for Phase C, so it is worth stating what the
 * argument actually is. A flag table is a remote control over a running deployment. The
 * danger is not that somebody flips a flag wrongly; it is that the SET of things a flag can
 * reach grows one plausible entry at a time until it includes something that should never
 * have been remotely reachable. C1's answer is that the set is a literal in code, reviewed
 * like code, and shipped in the bundle — so a new flag is a commit and a deploy, and the
 * console can only ever set a value for a name that is already here.
 *
 * ## The line, concretely
 *
 * **Legitimate:** the rewarded-ad offer on/off, the PvP practice-bot backfill delay, a
 * maintenance banner, matchmaking queue timeouts. Things whose worst outcome is a worse
 * game for as long as the value is wrong.
 *
 * **Never, permanently:** anything that changes an authentication decision; anything that
 * could put billsvc into or out of dev-stub mode; anything that disables a validation at a
 * trust boundary. A flag that could re-enable the dev receipt stub is a remote
 * "mint me free entitlements" button, and no amount of care around the console makes that
 * an acceptable thing to build. Those stay deploys.
 *
 * `flags.forbidden.test.ts` holds that line as a test rather than as this paragraph: it
 * pins the exact set of names, so ADDING one fails the suite and forces the question to be
 * answered in a review rather than in a hurry.
 *
 * ## Why the defaults live here and not in the database
 *
 * Fail-safe by construction (§4). A service never connects to `ops.db`; it polls adminsvc
 * and merges what it gets OVER these values. So an unreachable console, an empty table, a
 * malformed row and a garbled response all produce the same outcome — every service keeps
 * its compiled-in default, which is the behaviour that shipped. There is no state in which
 * "the flag service is down" means anything other than "the flags are as deployed".
 */

import {
  BANNER_MAX_LENGTH,
  FLAG_TEXT_FORBIDDEN,
  PUBLIC_FLAG_DEFAULTS,
  type PublicFlags,
} from '@dd/net/publicFlags';

/** The value kinds a flag may have. Deliberately three, and deliberately not `object`: a
 *  JSON-shaped flag is a config file with no schema, and the next person to add one would
 *  be adding a remote code path rather than a remote switch. */
export type FlagValue = boolean | number | string;

export interface FlagDef<T extends FlagValue = FlagValue> {
  /** The compiled-in value. What every service uses when adminsvc says nothing. */
  default: T;
  /** One line, shown in the console beside the flag. Written for whoever flips it at 2am. */
  help: string;
  /** For a number flag, the inclusive range a stored value must fall in. A value outside it
   *  is REFUSED at read time and the default is used — see `client.ts`. Required for every
   *  number, because "a flag with no bounds" and "a way to set the queue timeout to a year"
   *  are the same thing. */
  range?: { min: number; max: number };
  /** For a string flag, the maximum length, and the character class it must match. Same
   *  reasoning: a string with no cap is a way to put a megabyte through every service's
   *  poll response. */
  maxLength?: number;
  /**
   * Which process actually READS this flag, and whether a value set in the console reaches
   * it today.
   *
   * This field exists because building Phase C found a gap the design did not name: two of
   * the four flags below are about the CLIENT, and §4's delivery mechanism is an internal
   * `x-internal-key` endpoint that a browser cannot call and must never be able to. For one
   * pass those two had a row in `ops.db`, a control in the console and nothing on the other
   * end, and the state was carried here rather than left to be discovered — because a
   * switch that looks live and changes nothing is the worst thing an ops panel can contain,
   * and this project had already paid for that shape once (design/21 §2.5's "errors by
   * build version" panel, fully populated and meaningless).
   *
   * **The gap is closed as of 2026-09-09** by the public delivery path — `FlagDef.public`
   * below, `@dd/net/publicFlags` and matchsvc's `GET /client/flags`. The field stays,
   * because it is what makes the NEXT undelivered flag visible instead of silent, and
   * `flags.defs.test.ts` requires every flag to declare it.
   */
  consumer: string;
  /** False for a flag nothing reads yet. See `consumer`. */
  delivered: boolean;
  /**
   * Whether this flag's value is served to BROWSERS, by `GET /client/flags`.
   *
   * The marker half of the public delivery path, and only half on purpose: a flag reaches a
   * client only if it is `public: true` HERE *and* present in `@dd/net/publicFlags`, which
   * is the module the client compiles its own defaults from. Two independent edits, in two
   * workspaces, so publishing a flag cannot happen as a side effect of adding one.
   *
   * The test for whether a flag may be public is not "is it harmless" — it is **"is its
   * value already visible to the player it is delivered to"**. The banner IS its own
   * disclosure and the ad offer is a button a player can see; `match.pvpBotBackfillDelayMs`
   * would tell a player which opponent was not a person, so it stays internal. Absent means
   * private, so a new flag is private until somebody says otherwise.
   */
  public?: boolean;
}

/**
 * Every flag. The keys are the names the console shows and the wire carries; the object is
 * `as const` so `FlagName` is a union of literals and a typo at a read site is a compile
 * error rather than a silent default.
 */
export const FLAG_DEFS = {
  /**
   * The rewarded-ad offer on the CrazyGames build (design/20). The one switch worth having
   * on day one: the offer doubles an extraction payout, so if the balance turns out wrong —
   * or the platform's ad fill collapses and the offer becomes a button that does nothing —
   * turning it off should not wait for a client deploy.
   */
  'ads.rewardedOfferEnabled': {
    // From the shared contract, so the value a client compiles in and the value this
    // console shows as "shipped default" are one literal rather than two that agree today.
    default: PUBLIC_FLAG_DEFAULTS['ads.rewardedOfferEnabled'],
    help: 'Show the rewarded-ad offer that doubles an extraction payout (portal build only).',
    consumer: 'client (portal build) — RunOutcome.doubleOffer, via GET /client/flags',
    delivered: true,
    public: true,
  },
  /**
   * How long a PvP queue waits before matchmaking backfills a practice bot. Already a
   * constant somewhere; a flag because the right value depends on how many people are
   * actually queueing, which is a thing that changes without a deploy.
   */
  'match.pvpBotBackfillDelayMs': {
    default: 30_000,
    help: 'Wait this long before backfilling a PvP queue with a practice bot. Lower = matches sooner, more bots.',
    range: { min: 0, max: 300_000 },
    consumer: 'matchsvc (Matchmaker.pvpBotFillMs)',
    delivered: true,
  },
  /** How long a queued player waits before `/find` gives up. */
  'match.queueTimeoutMs': {
    default: 120_000,
    help: 'Give up on a queued player after this long.',
    range: { min: 10_000, max: 900_000 },
    consumer: 'matchsvc (Matchmaker.queueTtlMs)',
    delivered: true,
  },
  /**
   * A one-line notice the client shows above the menu. Empty means no banner.
   *
   * The only flag whose value is player-visible TEXT, which is why it is capped and
   * character-restricted: it goes through the same allowlist as everything else, and a
   * banner is not a place to be able to put markup.
   */
  'ui.maintenanceBanner': {
    default: PUBLIC_FLAG_DEFAULTS['ui.maintenanceBanner'],
    help: 'One-line notice shown above the menu. Empty = no banner.',
    // The shared contract's cap, for the reason the `default` above is: the client refuses a
    // longer value at its own boundary, and a server that accepted one would put a banner in
    // the console that no player ever sees.
    maxLength: BANNER_MAX_LENGTH,
    consumer: 'client (web + portal) — MainMenu banner, via GET /client/flags',
    delivered: true,
    public: true,
  },
} as const satisfies Record<string, FlagDef>;

export type FlagName = keyof typeof FLAG_DEFS;

/** Every flag name, sorted — the console's list order and the wire's key order. */
export const FLAG_NAMES = Object.keys(FLAG_DEFS).sort() as FlagName[];

/** The type-preserving default for one flag. */
export type FlagValues = { [K in FlagName]: (typeof FLAG_DEFS)[K]['default'] };

/** The compiled-in set, as a fresh object. What every service starts from. */
export function defaultFlags(): FlagValues {
  const out = {} as Record<string, FlagValue>;
  for (const name of FLAG_NAMES) out[name] = FLAG_DEFS[name].default;
  return out as FlagValues;
}

/**
 * The names marked `public: true` — the key set `GET /client/flags` answers with.
 *
 * Derived from the markers rather than written out, so it cannot fall behind them. Its
 * agreement with the client's own `PUBLIC_FLAG_NAMES` is the one half of the contract a
 * shared constant cannot make structural, and `publicFlags.contract.test.ts` asserts it in
 * both directions.
 */
export const PUBLIC_FLAG_NAMES_FROM_DEFS = FLAG_NAMES.filter((name) => (FLAG_DEFS[name] as FlagDef).public === true);

/**
 * Projects a full flag set down to the public subset, in the shape the wire and the client
 * share (`@dd/net/publicFlags`).
 *
 * Written as an explicit literal rather than as a filter-and-cast, and that is the whole
 * value of it: a name added to `PublicFlags` and forgotten here is a MISSING PROPERTY, i.e.
 * a compile error in this file, and a name removed from the allowlist is a compile error on
 * the right-hand side. A `Object.fromEntries(...) as PublicFlags` would type-check whatever
 * it produced and ship an object with a name missing — which the client's all-or-nothing
 * parse would then refuse wholesale, leaving every browser on its defaults with nothing red
 * anywhere.
 */
export function publicFlagValues(values: FlagValues): PublicFlags {
  return {
    'ads.rewardedOfferEnabled': values['ads.rewardedOfferEnabled'],
    'ui.maintenanceBanner': values['ui.maintenanceBanner'],
  };
}

/** Whether a string is a flag name. The membership test the wire parser and the console's
 *  write path both use — nothing else decides what a valid flag is. */
export function isFlagName(name: string): name is FlagName {
  return Object.prototype.hasOwnProperty.call(FLAG_DEFS, name);
}

/**
 * Coerces and validates one stored/received value against its definition, or returns `null`
 * for "not usable, keep the default".
 *
 * Every refusal here is a case where the alternative is worse than ignoring the value:
 *
 *  - **A type mismatch.** A flag declared boolean arriving as `"true"` is a row somebody
 *    wrote by hand at a `sqlite3` prompt, and guessing what they meant is how `"false"`
 *    becomes `true`.
 *  - **A number outside its range**, or `NaN`/`Infinity`. `queueTimeoutMs: 1e9` is not a
 *    tuning decision, it is a queue that never times out.
 *  - **A string over its cap, or carrying a control character or a `<`.** The maintenance
 *    banner is the one flag a player sees; it reaches the client through the same JSON the
 *    rest do, and text that cannot contain markup is one fewer thing for four render paths
 *    to remember to escape.
 *
 * Returning `null` rather than throwing is the fail-safe posture again: one bad row must
 * cost that one flag its override, not the whole poll.
 */
export function coerceFlag(name: FlagName, value: unknown): FlagValue | null {
  const def: FlagDef = FLAG_DEFS[name];
  if (typeof def.default === 'boolean') return typeof value === 'boolean' ? value : null;
  if (typeof def.default === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    // `range!` rather than a `=== undefined` guard: every number flag declares one, and
    // `flags.defs.test.ts` asserts that over the whole allowlist. A guard here would be a
    // branch no input can reach, which a coverage gate cannot tell apart from an untested
    // one — and the test is the stronger statement anyway, because it fails when somebody
    // ADDS a number flag without bounds rather than when one is read.
    const range = def.range!;
    return value >= range.min && value <= range.max ? value : null;
  }
  if (typeof value !== 'string') return null;
  // Same reasoning as `range!` above: every string flag declares a cap, asserted over the
  // whole allowlist by `flags.defs.test.ts`.
  if (value.length > def.maxLength!) return null;
  // No control character (a newline above all) and no `<`: see the doc comment above. The
  // class is imported rather than written here because the CLIENT enforces the same one at
  // its own trust boundary (`@dd/net/publicFlags`), and two copies that drift would mean a
  // banner the console accepts and no player ever sees.
  return FLAG_TEXT_FORBIDDEN.test(value) ? null : value;
}
