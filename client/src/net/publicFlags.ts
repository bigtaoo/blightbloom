/**
 * The PUBLIC feature-flag contract (design/21-ops-analytics.md §9, first bullet) — the
 * names, the types, the shipped defaults, the bounds and the wire path, shared by the
 * browser that reads them and the server that answers them.
 *
 * This module lives in `client/src/net/` and the SERVER imports it through the `@dd/net/*`
 * alias, exactly as `analyticsEvents.ts` is imported by `server/src/analytics/ingest.ts`.
 * That direction is deliberate: the contract belongs to the client, because the client is
 * the half that cannot be redeployed in lockstep with the server, and a value it may
 * receive has to have a compiled-in meaning on the day it arrives.
 *
 * ## Why a separate route exists at all
 *
 * §9 proposed "a PUBLIC field on a response the client already fetches". No such response
 * exists. The only two unauthenticated calls a browser makes to matchsvc are
 * `POST /client/log` and `POST /client/events`, and both are batched on a 30-second timer,
 * fire-and-forget, absent entirely on the WeChat shell until the `wx.request` adapter landed
 * the following day (design/21 §9), and — for the analytics one —
 * behind an opt-out that a consent gate would switch off. A maintenance banner that arrives
 * thirty seconds into a visit, and never at all for a player who declined analytics, is not
 * a maintenance banner. So the delivery path is its own route, and the surface it adds is
 * the smallest one that can work: an unauthenticated GET whose entire answer is values a
 * player is already shown.
 *
 * ## What may be public, and what that costs
 *
 * `FlagDef.public` on the server is the marker, and this file is the other half of it: a
 * flag reaches a browser only if it appears in BOTH. Two flags qualify today and the test
 * of whether a third does is not "is it harmless" but "is its value already visible to the
 * player it is delivered to":
 *
 *  - `ui.maintenanceBanner` is a line of text shown to every player, so publishing it
 *    discloses nothing — it IS the disclosure.
 *  - `ads.rewardedOfferEnabled` decides whether a button is drawn, so a player can read it
 *    off their own screen.
 *
 * The two matchmaking timings deliberately do NOT qualify, and they are the useful negative
 * example: `match.pvpBotBackfillDelayMs` is how long a queue waits before it quietly
 * substitutes a practice bot for a human, and publishing it would tell a player which of
 * their opponents was not a person. It is not a secret, and it is still not ours to hand out.
 *
 * ## Deploy ordering, which the all-or-nothing parse makes matter
 *
 * {@link parsePublicFlags} refuses a response missing any name, for the reason the server's
 * own poll parser gives (`server/src/flags/client.ts`): a partial merge lets one garbled
 * value silently revert a deliberate override while the console keeps showing it as set.
 *
 * The consequence, which is worth knowing BEFORE adding a third public flag: a client that
 * knows a name the server does not yet send falls back to its compiled-in defaults for
 * ALL of them — so during that deploy window every override is off, including a banner
 * somebody has just put up. The server ignores nothing and a client ignores names it does
 * not know, so **ship the server half first**; the client picks the new name up on its own
 * deploy. The reverse order costs one window of shipped defaults.
 */

/** Where matchsvc answers. A GET, no headers, no credentials — so no CORS preflight. */
export const PUBLIC_FLAGS_PATH = '/client/flags';

/**
 * The maintenance banner's cap and its forbidden character class, defined HERE and imported
 * by `server/src/flags/defs.ts` so `coerceFlag` and {@link parsePublicFlags} enforce one
 * rule rather than two copies of it that can drift apart.
 *
 * 140 characters because the banner is one line above a menu on a landscape phone, and the
 * character class because that text is rendered by four different paths (three client entry
 * points and the console's own table). No control character — a newline above all, which is
 * how a fake record gets into a log line — and no `<`, so no render path has to remember to
 * escape it. Text that cannot contain markup is one fewer thing to get right.
 */
export const BANNER_MAX_LENGTH = 140;

/**
 * The characters no flag TEXT may contain — the banner today, and any string flag added
 * later. `server/src/flags/defs.ts`'s `coerceFlag` imports this rather than declaring its
 * own copy: the server refusing a value the client would accept, or accepting one the
 * client refuses, is a banner that is set in the console and invisible in the game with
 * nothing anywhere saying why.
 */
export const FLAG_TEXT_FORBIDDEN = /[\u0000-\u001f\u007f<]/;

/** Whether a string is usable as the maintenance banner. Both halves call this one. */
export function isUsableBanner(value: string): boolean {
  return value.length <= BANNER_MAX_LENGTH && !FLAG_TEXT_FORBIDDEN.test(value);
}

/**
 * Every public flag, with the type it has. The keys are the wire's keys and the names the
 * console shows, so they are the server's allowlist names verbatim rather than a
 * client-side renaming — one name for one switch, in the log line, on the page and in the
 * bundle.
 */
export interface PublicFlags {
  /** Draw the rewarded-ad offer that doubles an extraction payout (portal build only). */
  'ads.rewardedOfferEnabled': boolean;
  /** One-line notice above the main menu. Empty means no banner. */
  'ui.maintenanceBanner': string;
}

export type PublicFlagName = keyof PublicFlags;

/**
 * The compiled-in values. What every client uses before its first successful fetch, and
 * after every failed one — the shipped behaviour, which is the only state "the flag service
 * is unreachable" can produce.
 *
 * `server/src/flags/defs.ts` imports these as the `default` of both flags, so there is one
 * copy of each value rather than a client copy and a server copy that agree until they
 * don't. `publicFlags.contract.test.ts` on the server asserts the agreement anyway, in both
 * directions, because the NAME SET is the half a shared constant cannot make structural.
 */
export const PUBLIC_FLAG_DEFAULTS: PublicFlags = {
  'ads.rewardedOfferEnabled': true,
  'ui.maintenanceBanner': '',
};

/** Every public flag name, sorted — the wire's key order and this module's iteration order. */
export const PUBLIC_FLAG_NAMES = Object.keys(PUBLIC_FLAG_DEFAULTS).sort() as PublicFlagName[];

/**
 * Parses `GET /client/flags`' body into a complete set, or `null` for "not usable, keep what
 * you have".
 *
 * ALL-OR-NOTHING, and strict on every value — see the file header for both, and for the
 * deploy ordering the first of them implies. Validation runs on this side as well as the
 * server's not because the server is untrusted but because this is a trust boundary of its
 * own: the bytes reaching this function came off a network, and the banner they may carry
 * goes straight into a `Text` on screen.
 */
export function parsePublicFlags(body: unknown): PublicFlags | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const flags = (body as { flags?: unknown }).flags;
  if (typeof flags !== 'object' || flags === null || Array.isArray(flags)) return null;
  const source = flags as Record<string, unknown>;

  // `hasOwnProperty` rather than a truthiness check, and rather than `in`: `false` and `''`
  // are both legitimate values and both falsy, and `in` would answer true for `toString`.
  for (const name of PUBLIC_FLAG_NAMES) {
    if (!Object.prototype.hasOwnProperty.call(source, name)) return null;
  }

  const offer = source['ads.rewardedOfferEnabled'];
  if (typeof offer !== 'boolean') return null;
  const banner = source['ui.maintenanceBanner'];
  if (typeof banner !== 'string' || !isUsableBanner(banner)) return null;

  return { 'ads.rewardedOfferEnabled': offer, 'ui.maintenanceBanner': banner };
}
