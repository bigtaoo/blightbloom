/**
 * The players view (design/21 §3.2, first section) — "who is this account, and what does it
 * own?", which is the one question that used to require an SSH session and a `sqlite3`
 * prompt and now requires an Atlas login.
 *
 * Every read here is a `find` or an `$group` through a handle whose credential has no write
 * role (`dbs.ts`), and every caller-supplied value is a bound value in a filter document.
 * There is no string interpolation of a VALUE into a query anywhere in this file.
 *
 * ## The injection shape changed, and it got sharper
 *
 * The SQL version's danger was a term escaping its quotes, and bound parameters removed it.
 * A document store has no quotes to escape, and two DIFFERENT holes in their place:
 *
 *   - **A term that is an OPERATOR.** `{ username: q }` where `q` is `{ $ne: null }` matches
 *     every account. It cannot happen here because `q` arrives from `URL.searchParams`,
 *     which yields strings — but that is a property of the caller, so `searchPlayers`
 *     re-establishes it with a `typeof` guard rather than inheriting it. `AuthService.login`
 *     carries the same guard for the same reason, and `authService.test.ts` pins it.
 *   - **A term that is a REGEX.** The substring search is `$regex`, and an unescaped `.*`
 *     is then "list every account" — the same button the unescaped SQL `%` was — while
 *     `(a+)+$` is a ReDoS against the SERVER's regex engine, which the LIKE had no
 *     equivalent of. {@link escapeRegex} is what makes the term literal, and the length cut
 *     at {@link MAX_QUERY_LENGTH} bounds what it can be even so.
 *
 * `$options: 'i'` rather than the `accounts_username_ci` collation, deliberately: MongoDB's
 * `$regex` does NOT honour a query collation, so asking for one would produce a search that
 * is case-sensitive in a way nothing on the page could explain. SQLite's `LIKE` was
 * case-insensitive for ASCII, and this keeps that behaviour.
 *
 * ## Two databases, joined in JavaScript
 *
 * `accounts`, `ratings` and `entitlements` are three collections on the `accounts`
 * database, so those are three queries against one handle. "Last active" is not: it comes
 * from the `analytics` database, and a `$lookup` cannot cross databases. So the join is a
 * `Map` lookup here, exactly as it was when they were two files, and a missing analytics
 * handle simply leaves the column blank.
 *
 * ## Last active comes from `events`, NOT from `dailyActive`
 *
 * design/21 §3.2 says `daily_active`, and building it found that collection cannot answer
 * the question: its fields are `(day, install, host)` and it holds no account id at all —
 * by design, because a retention cohort is a question about a BROWSER, and joining that
 * collection to an account would assemble exactly the profile §2.1 promises not to. The
 * account link exists only on `events.accountId`, which the server attaches from the bearer
 * token.
 *
 * The consequence is worth stating on the page rather than hiding: `events` is pruned at 90
 * days (`EVENT_RETENTION_DAYS`), so a blank "last active" means "no event in the last 90
 * days", never "never played". A column that silently conflates those two would be read as
 * the second one.
 */
import type { Db } from 'mongodb';
import type { AccountDoc, EntitlementDoc, RatingDoc } from '../../db';
import { eventsOf } from '../../analytics/db';

/** The most rows one search answers with. A console is a place to look at a player, not to
 *  export the account collection; a query that would return more says so instead of
 *  truncating silently (see `PlayerSearchResult.truncated`). */
export const PLAYER_PAGE_SIZE = 50;

/** The longest search term accepted. Anything past this is CUT, and the cut is reported —
 *  see `searchPlayers`, which returns the term it actually used. It also bounds the regex
 *  the server is asked to run; see the header. */
export const MAX_QUERY_LENGTH = 64;

export interface PlayerRow {
  id: string;
  username: string;
  /** NULL for a local account, whose `username` is already the display name (`db.ts`). */
  displayName: string | null;
  provider: string;
  createdAtMs: number;
  /** Absent when the account has never played a rated match — not zero. `ratings` has no
   *  document until `ladderReport` writes one, and a default of 0 would read as "lost every
   *  match" rather than "has not played". */
  rating: number | null;
  entitlements: string[];
  /** `YYYY-MM-DD`, or null for "no analytics event in the retention window" — see the file
   *  header on why that is not "never played". */
  lastActiveDay: string | null;
}

export interface PlayerSearchResult {
  rows: PlayerRow[];
  /** How many accounts matched, before the page limit. Reported so the page can say "50 of
   *  1,204" rather than showing 50 rows that look like the whole answer. */
  matched: number;
  truncated: boolean;
  /** The term actually searched for, after trimming and the length cut. Returned rather
   *  than assumed, so a page that sent 200 characters shows which 64 were used. */
  term: string;
}

/**
 * Escapes every regular-expression metacharacter in a user-supplied term.
 *
 * Replaces `escapeLike`, which escaped the three characters `LIKE` treated specially. The
 * set is much larger here and the consequence of missing one is worse: an unescaped `.`
 * turns a search for `a.b` into a search for `a`-anything-`b`, an unescaped `*` or `+`
 * turns a typo into a table scan that matches everything, and an unescaped group with a
 * quantifier is a denial of service the SERVER executes. Escaping the whole class rather
 * than enumerating the dangerous ones is the only version of this that stays correct when
 * somebody adds a character to the pattern.
 */
export function escapeRegex(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, (c) => `\\${c}`);
}

/**
 * Accounts matching `query`, newest first, with their rating, entitlements and last active
 * day. An empty query lists the newest accounts, which is the useful default for a page
 * somebody has just opened.
 *
 * `analytics` is nullable rather than required: the "last active" column is the only thing
 * it feeds, and a deployment with analytics switched off should still be able to look an
 * account up.
 */
export async function searchPlayers(
  accounts: Db,
  analytics: Db | null,
  query: unknown,
  limit: number = PLAYER_PAGE_SIZE,
): Promise<PlayerSearchResult> {
  // See the header: a non-string term is an operator document, and the one that reaches
  // this function today is always a string only because of what `URL.searchParams` yields.
  const term = (typeof query === 'string' ? query : '').trim().slice(0, MAX_QUERY_LENGTH);
  const pattern = { $regex: escapeRegex(term), $options: 'i' };
  const filter =
    term.length === 0 ? {} : { $or: [{ username: pattern }, { displayName: pattern }] };

  const col = accounts.collection<AccountDoc>('accounts');
  const matched = await col.countDocuments(filter);
  const docs = await col
    .find(filter)
    // `_id` breaks the tie, as `a.id ASC` did: two accounts created in the same millisecond
    // is what a seeded box and a settled multi-account test both produce, and an unstable
    // order makes a page that reloads differently for no visible reason.
    .sort({ createdAt: -1, _id: 1 })
    .limit(limit)
    .toArray();

  const ids = docs.map((d) => d._id);
  const [rated, owned, active] = await Promise.all([
    ratingsFor(accounts, ids),
    entitlementsFor(accounts, ids),
    analytics === null ? Promise.resolve(new Map<string, string>()) : lastActiveFor(analytics, ids),
  ]);

  return {
    rows: docs.map((d) => ({
      id: d._id,
      username: d.username,
      // ABSENT rather than null for a local account (`db.ts`), and the page's contract is
      // `null`. Mapped at this boundary so nothing downstream has to know which.
      displayName: d.displayName ?? null,
      provider: d.provider,
      createdAtMs: d.createdAt,
      rating: rated.get(d._id) ?? null,
      entitlements: owned.get(d._id) ?? [],
      lastActiveDay: active.get(d._id) ?? null,
    })),
    matched,
    truncated: matched > docs.length,
    term,
  };
}

/**
 * The rating of each of `ids`, for the accounts on this page.
 *
 * `ratings._id` IS the account id (`db.ts`: a rating key is any opaque id, including a
 * bot/guest scaffold that has no account at all), so this is a primary-key `$in` rather
 * than the LEFT JOIN it replaces. The absent ones are absent from the map, which is what
 * makes `rating: null` mean "has not played a rated match" rather than "rated zero".
 */
export async function ratingsFor(accounts: Db, ids: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (ids.length === 0) return out;
  const docs = await accounts
    .collection<RatingDoc>('ratings')
    .find({ _id: { $in: [...ids] } })
    .toArray();
  for (const doc of docs) out.set(doc._id, doc.rating);
  return out;
}

/**
 * The SKUs each of `ids` owns, as one query rather than one per row.
 *
 * An empty `ids` short-circuits. `$in: []` is a legal empty match here rather than the
 * syntax error `IN ()` was in SQLite, so this guard is no longer load-bearing for
 * correctness — it is kept because a round trip that cannot return anything is still a
 * round trip, and because the same guard IS load-bearing in `lastActiveFor`, where it
 * stops an `$group` over every event ever recorded.
 */
export async function entitlementsFor(accounts: Db, ids: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (ids.length === 0) return out;
  const docs = await accounts
    .collection<EntitlementDoc>('entitlements')
    .find({ accountId: { $in: [...ids] } })
    .sort({ sku: 1 })
    .toArray();
  for (const doc of docs) {
    const list = out.get(doc.accountId);
    if (list === undefined) out.set(doc.accountId, [doc.sku]);
    else list.push(doc.sku);
  }
  return out;
}

/** The newest `events.day` per account, for the accounts on this page. See the file header
 *  on why this reads `events` and not `dailyActive`. */
export async function lastActiveFor(analytics: Db, ids: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const rows = await eventsOf(analytics)
    .aggregate<{ _id: string; day: string }>([
      { $match: { accountId: { $in: [...ids] } } },
      { $group: { _id: '$accountId', day: { $max: '$day' } } },
    ])
    .toArray();
  for (const row of rows) out.set(row._id, row.day);
  return out;
}
