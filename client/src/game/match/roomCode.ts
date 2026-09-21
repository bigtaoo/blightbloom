/**
 * The party room code's SHAPE — the one definition, shared by the server that mints codes
 * and the client field that accepts them (design/05/15's squad follow-up).
 *
 * ## Why this file exists at all, and why it lives under `client/src/game/`
 *
 * It was two constants for about an hour. `server/src/routes/party.ts` had `CODE_LENGTH = 6`
 * and `client/src/game/screens/PartyScreen.ts` had `ROOM_CODE_LENGTH = 6`, with a comment on
 * the client one justifying the copy: "nothing in `client/src` may import from
 * `server/src`". That is true and it is the wrong direction. The sharing already happens the
 * other way round — `server/src/config.ts` re-exports `SQUAD_SIZE`/`teamIdForOwner` from
 * `@dd/game/match/pvpConfig`, and its comment there says why: "instead of two hand-mirrored
 * copies that could drift (design/06's own stated lesson)". So the duplicate was exactly the
 * mistake the neighbouring file warns about, and no test could have caught the drift, because
 * each constant is independently correct — the server would mint six digits into a field five
 * wide and every suite on both sides would stay green.
 *
 * Hence: the client's pure layer owns the shape, and the server imports it through the alias
 * it already uses. One number, and `len-5` is now a single edit that both packages' tests see.
 *
 * ## The contract
 *
 * SIX DECIMAL DIGITS, `000000` through `999999`, leading zeros significant. It was five
 * characters of `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` until 2026-09-21 — an alphabet picked so a
 * code read aloud could not be misheard (no 0/O, no 1/I). Digits carry that one step further:
 * no letter is left for a digit to be confused with, the code is dictatable and typable in
 * every one of the eight locales this game ships (a Cyrillic or Chinese layout reaches a digit
 * without switching; `A` is not always where the player expects it), and a phone can offer a
 * numeric keypad for it. The cost is keyspace — 32^5 (~33.5M) collapses to 10^6 (1M) — which
 * `server/src/routes/party.ts` discusses where it matters: collisions (a non-event, and
 * redrawn) and guessing (materially easier, undefended).
 *
 * Pure by construction: no imports, no globals, so the server can load it and
 * `pureLayerBoundary.test.ts` holds it to staying that way.
 */

/** Digits per code. The field's `maxLength`, and the count `randomCode` draws. */
export const ROOM_CODE_LENGTH = 6;

/** The alphabet's size — `0`-`9`. Read by the server's generator as its `randomInt` bound. */
export const ROOM_CODE_DIGITS = 10;

/**
 * Exactly {@link ROOM_CODE_LENGTH} digits, anchored at both ends.
 *
 * The anchors are the load-bearing part: an unanchored `[0-9]{6}` matches `abc123456xyz`, so
 * a route validating with it would hand an arbitrary string to its lookup map.
 *
 * ## `[0-9]` and not `\d`, and definitely not `\p{Nd}` (a mutation battery, 2026-09-21)
 *
 * `[0-9]` looks fussy next to `\d` and the two ARE the same here: a battery mutant swapping
 * in `^\d{6}$` with the `u` flag survived the whole suite, and that is correct rather than a
 * gap — JavaScript's `\d` is ASCII-only whatever flags it carries, unlike .NET or
 * Python's `re` on `str`. So tidying this to `\d` would be harmless.
 *
 * The reason the comment is here anyway is the edit that LOOKS like the same tidy-up and is
 * not: `^[\p{Nd}]{6}$` with `u` matches every Unicode decimal digit, so `\uff11\uff12…`
 * (full-width), `\u0661…` (Arabic-Indic) and `\u0966…` (Devanagari) all become codes this
 * system would accept and could never have minted — six characters that read to a human as
 * a valid code and key `PartyService`'s map as something else entirely. Measured, all three.
 * `roomCode.test.ts`'s near-miss list carries one of each specifically to kill it.
 */
export const ROOM_CODE_PATTERN = new RegExp(`^[0-9]{${ROOM_CODE_LENGTH}}$`);

/**
 * Whether `value` is a code this system could have minted.
 *
 * Takes `unknown` rather than `string` on purpose, and the narrowing is the point: a JSON
 * body's `code` field arrives as whatever the caller sent, and with a digit-only code the
 * mistake the shape invites is sending it as a NUMBER — which also silently truncates
 * `004271` to `4271` on the way. Accepting `unknown` means a caller cannot forget to check
 * the type first and have it coerce.
 */
export function isRoomCode(value: unknown): value is string {
  return typeof value === 'string' && ROOM_CODE_PATTERN.test(value);
}

/**
 * A pasted or dictated code reduced to what it was meant to be: surrounding whitespace off,
 * everything else untouched.
 *
 * Deliberately NOT a code-repairer. It does not strip interior separators, drop non-digits or
 * pad — a code arriving as `12-34-56` or `4271` is a caller-side bug, and quietly "fixing" it
 * here would turn a refusal the sender can act on into a lookup miss that reads to the player
 * as "the code my friend gave me is wrong". The trim alone is worth doing because a code
 * copied out of a chat message carries a leading or trailing space often enough that refusing
 * it would be its own bug report.
 */
export function normalizeRoomCode(raw: string): string {
  return raw.trim();
}
