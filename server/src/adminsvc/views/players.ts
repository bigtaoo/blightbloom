/**
 * The players view (design/21 §3.2, first section) — "who is this account, and what does it
 * own?", which is the one question that today requires an SSH session and a `sqlite3`
 * prompt. Search by username or display name; a row per account.
 *
 * Every statement here is a SELECT through a `readOnly` handle (`dbs.ts`), and every
 * caller-supplied value is a bound parameter. There is no string interpolation of a VALUE
 * into SQL in this file at all — including in the LIKE, whose wildcards are escaped rather
 * than passed through, so a search for `%` is a search for a literal percent sign and not a
 * request for every account on the box.
 *
 * ## Two databases, joined in JavaScript
 *
 * `accounts`, `ratings` and `entitlements` live together in `accounts.db`, so those are one
 * query. "Last active" does not: it comes from the analytics database, which is a separate
 * FILE and therefore a separate handle — SQLite cannot join across them and this project
 * deliberately never `ATTACH`es one to another (that would give one connection a view of
 * two stores, and B1's read-only argument is made per-file). So the join is a `Map` lookup
 * here, and a missing analytics database simply leaves the column blank.
 *
 * ## Last active comes from `events`, NOT from `daily_active`
 *
 * design/21 §3.2 says `daily_active`, and building it found that table cannot answer the
 * question: its columns are `(day, install, host)` and it holds no account id at all — by
 * design, because a retention cohort is a question about a BROWSER, and joining that table
 * to an account would assemble exactly the profile §2.1 promises not to. The account link
 * exists only on `events.account_id`, which the server attaches from the bearer token.
 *
 * The consequence is worth stating on the page rather than hiding: `events` is pruned at 90
 * days (`EVENT_RETENTION_DAYS`), so a blank "last active" means "no event in the last 90
 * days", never "never played". A column that silently conflates those two would be read as
 * the second one.
 */
import type { DatabaseSync } from 'node:sqlite';

/** The most rows one search answers with. A console is a place to look at a player, not to
 *  export the account table; a query that would return more says so instead of truncating
 *  silently (see `PlayerSearchResult.truncated`). */
export const PLAYER_PAGE_SIZE = 50;

/** The longest search term accepted. Anything past this is CUT, and the cut is reported —
 *  see `searchPlayers`, which returns the term it actually used. */
export const MAX_QUERY_LENGTH = 64;

export interface PlayerRow {
  id: string;
  username: string;
  /** NULL for a local account, whose `username` is already the display name (`db.ts`). */
  displayName: string | null;
  provider: string;
  createdAtMs: number;
  /** Absent when the account has never played a rated match — not zero. `ratings` has no
   *  row until `ladderReport` writes one, and a default of 0 would read as "lost every
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
 * Escapes the LIKE metacharacters in a user-supplied term.
 *
 * `%` and `_` are wildcards and `\` is the escape character the queries below declare, so
 * all three have to be escaped for a search to mean the literal string that was typed.
 * Without this, a search for `_` matches every one-character username and a search for `%`
 * matches every account — the second of which is a "list the whole accounts table" button
 * that looks like a typo.
 */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

const LIKE_WHERE = `WHERE username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\'`;

/**
 * Accounts matching `query`, newest first, with their rating, entitlements and last active
 * day. An empty query lists the newest accounts, which is the useful default for a page
 * somebody has just opened.
 *
 * `analytics` is nullable rather than required: the "last active" column is the only thing
 * it feeds, and a deployment with analytics switched off should still be able to look an
 * account up.
 */
export function searchPlayers(
  accounts: DatabaseSync,
  analytics: DatabaseSync | null,
  query: string,
  limit: number = PLAYER_PAGE_SIZE,
): PlayerSearchResult {
  const term = query.trim().slice(0, MAX_QUERY_LENGTH);
  const like = `%${escapeLike(term)}%`;
  const where = term.length === 0 ? '' : LIKE_WHERE;
  const params = term.length === 0 ? [] : [like, like];

  const countRow = accounts.prepare(`SELECT COUNT(*) AS n FROM accounts ${where}`).get(...params) as { n: number };
  const matched = Number(countRow.n);

  const rows = accounts
    .prepare(
      `SELECT a.id, a.username, a.display_name, a.provider, a.created_at, r.rating
       FROM accounts a LEFT JOIN ratings r ON r.account_id = a.id
       ${where}
       ORDER BY a.created_at DESC, a.id ASC
       LIMIT ?`,
    )
    .all(...params, limit) as {
    id: string;
    username: string;
    display_name: string | null;
    provider: string;
    created_at: number;
    rating: number | null;
  }[];

  const ids = rows.map((r) => String(r.id));
  const owned = entitlementsFor(accounts, ids);
  const active = analytics === null ? new Map<string, string>() : lastActiveFor(analytics, ids);

  return {
    rows: rows.map((r) => ({
      id: String(r.id),
      username: String(r.username),
      displayName: r.display_name === null ? null : String(r.display_name),
      provider: String(r.provider),
      createdAtMs: Number(r.created_at),
      rating: r.rating === null ? null : Number(r.rating),
      entitlements: owned.get(String(r.id)) ?? [],
      lastActiveDay: active.get(String(r.id)) ?? null,
    })),
    matched,
    truncated: matched > rows.length,
    term,
  };
}

/**
 * The SKUs each of `ids` owns, as one query rather than one per row.
 *
 * The `IN` list is built from placeholders — one `?` per id — and never from the ids
 * themselves. That is the one place in this file where interpolating a value would be
 * tempting and the one place it would matter: these ids come from the query above today,
 * but a query shape that interpolates values is a query shape that will interpolate a
 * caller's value the next time somebody edits it.
 *
 * An empty `ids` short-circuits, because `IN ()` is a syntax error in SQLite rather than an
 * empty match.
 */
export function entitlementsFor(accounts: DatabaseSync, ids: readonly string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (ids.length === 0) return out;
  const holes = ids.map(() => '?').join(',');
  const rows = accounts
    .prepare(`SELECT account_id, sku FROM entitlements WHERE account_id IN (${holes}) ORDER BY sku ASC`)
    .all(...ids) as { account_id: string; sku: string }[];
  for (const row of rows) {
    const key = String(row.account_id);
    const list = out.get(key);
    if (list === undefined) out.set(key, [String(row.sku)]);
    else list.push(String(row.sku));
  }
  return out;
}

/** The newest `events.day` per account, for the accounts on this page. See the file header
 *  on why this reads `events` and not `daily_active`. */
export function lastActiveFor(analytics: DatabaseSync, ids: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const holes = ids.map(() => '?').join(',');
  const rows = analytics
    .prepare(`SELECT account_id, MAX(day) AS day FROM events WHERE account_id IN (${holes}) GROUP BY account_id`)
    .all(...ids) as { account_id: string; day: string }[];
  for (const row of rows) out.set(String(row.account_id), String(row.day));
  return out;
}
