/**
 * `ops.db` — the flag overrides (design/21 §4), and the ONLY writable database in adminsvc.
 *
 * ## How this coexists with B1
 *
 * Decision B1 says the console holds no write handle to **player data**, and that is still
 * exactly true: `accounts.db`, `billing.db` and `analytics.db` are opened `readOnly: true`
 * by `adminsvc/dbs.ts` and there is no opener in that directory that could produce anything
 * else. `ops.db` is a fourth file, it belongs to adminsvc, and nothing about a player is in
 * it — one row per flag, holding a name this repo declared and a value this repo validated.
 *
 * The distinction is load-bearing rather than a technicality, so it is worth being able to
 * say it in one sentence: **a total compromise of the console can change how the game
 * behaves; it cannot change who anybody is or what they own.** §4's own note that this is
 * "the first write in the whole design, which is why it is last" is the same observation
 * from the other side.
 *
 * ## Sparse on purpose: a row means "overridden"
 *
 * There is no row per flag. A flag with no row uses its compiled-in default
 * (`defs.ts`'s `FLAG_DEFS`), and clearing an override DELETES the row rather than writing
 * the default into it. That matters for one specific reason: a stored copy of the default
 * goes stale silently the day the default changes in a deploy, and the console would then
 * show, and every service would then use, a value nobody chose — with the table looking
 * perfectly consistent. Absence is the only representation of "as shipped" that cannot
 * drift.
 *
 * ## Values are stored as JSON text
 *
 * One `TEXT` column rather than three typed ones, because the type is already declared in
 * code and the database is not the authority on it. `JSON.parse` on the way out then goes
 * through `coerceFlag`, so a hand-edited row that says `"true"` for a boolean flag is
 * refused at read time and the default is used — see `defs.ts` on why guessing is worse.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FLAG_DEFS, FLAG_NAMES, coerceFlag, isFlagName, type FlagName, type FlagValue } from './defs';

const SCHEMA = `
-- One row per OVERRIDDEN flag. A flag with no row is at its compiled-in default; see the
-- file header for why absence is the only safe representation of that.
--
-- \`name\` carries no CHECK constraint listing the allowlist, and that is deliberate: the
-- allowlist lives in \`defs.ts\` and changes with a deploy, so a SQL CHECK would be a second
-- copy that goes stale in the direction that REFUSES a legitimate new flag. The allowlist is
-- enforced on both sides of this table instead — \`setFlag\` will not write an unknown name,
-- and \`readOverrides\` will not return one.
CREATE TABLE IF NOT EXISTS flags (
  name TEXT PRIMARY KEY,
  -- The value as JSON text. See the file header.
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  -- Who set it. There is one operator (decision B3), so this is the operator NAME rather
  -- than an account id, and it exists for the same reason design/21 §3.3 asks for an audit
  -- LINE rather than an audit system: the useful question months later is "was this set on
  -- purpose", and a name plus a timestamp answers it.
  set_by TEXT NOT NULL
);
`;

export interface FlagOverride {
  name: FlagName;
  value: FlagValue;
  updatedAtMs: number;
  setBy: string;
}

/** Opens (creating if needed) `ops.db` and ensures the schema exists. */
export function openOpsDb(path: string = defaultOpsDbPath()): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}

/**
 * `BB_OPS_DB_PATH`, or a `data/ops.db` sibling of the other three defaults.
 *
 * A distinct variable, like every other database in this project, for the reason
 * `billingDb.ts` states: pointing two stores at one file by setting one variable is the
 * failure that separation exists to prevent. Here it would be worse than usual — the other
 * three are opened READ-ONLY by this process, so aiming this one at `accounts.db` would
 * hand adminsvc the write handle B1 exists to deny it.
 */
export function defaultOpsDbPath(): string {
  const env = process.env.BB_OPS_DB_PATH;
  if (env && env.length > 0) return env;
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '../../data/ops.db');
}

/**
 * Every override in the table that is still legitimate, keyed by name.
 *
 * "Still legitimate" is doing real work. Two rows are skipped rather than returned:
 *
 *  - one whose `name` is no longer in the allowlist, which is what a flag REMOVED in a
 *    deploy leaves behind. The row is left in place (deleting somebody's data on a read is
 *    not this function's business) and simply never read again.
 *  - one whose value does not pass `coerceFlag` — a hand-edited row, or a row written under
 *    an older definition with a wider range.
 *
 * Both cases are logged by the caller rather than swallowed here: a flag that is silently
 * not being applied is exactly the kind of thing somebody spends an afternoon on.
 */
export function readOverrides(db: DatabaseSync): { values: Partial<Record<FlagName, FlagValue>>; skipped: string[] } {
  const rows = db.prepare('SELECT name, value FROM flags').all() as { name: string; value: string }[];
  const values: Partial<Record<FlagName, FlagValue>> = {};
  const skipped: string[] = [];
  for (const row of rows) {
    const name = String(row.name);
    if (!isFlagName(name)) {
      skipped.push(name);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(row.value));
    } catch {
      skipped.push(name);
      continue;
    }
    const coerced = coerceFlag(name, parsed);
    if (coerced === null) {
      skipped.push(name);
      continue;
    }
    values[name] = coerced;
  }
  return { values, skipped };
}

/** Every override with its metadata, for the console's table. Newest first. Unlike
 *  {@link readOverrides} this returns rows that FAILED validation too — the console is where
 *  somebody needs to see that a row exists and is not being applied. */
export function listOverrides(db: DatabaseSync): { rows: FlagOverride[]; invalid: string[] } {
  const rows = db
    .prepare('SELECT name, value, updated_at, set_by FROM flags ORDER BY updated_at DESC')
    .all() as { name: string; value: string; updated_at: number; set_by: string }[];
  const out: FlagOverride[] = [];
  const invalid: string[] = [];
  for (const row of rows) {
    const name = String(row.name);
    let value: FlagValue | null = null;
    if (isFlagName(name)) {
      try {
        value = coerceFlag(name, JSON.parse(String(row.value)) as unknown);
      } catch {
        value = null;
      }
    }
    if (value === null) {
      invalid.push(name);
      continue;
    }
    out.push({ name: name as FlagName, value, updatedAtMs: Number(row.updated_at), setBy: String(row.set_by) });
  }
  return { rows: out, invalid };
}

/**
 * Sets one override. Returns false — and writes NOTHING — for a name outside the allowlist
 * or a value its definition refuses.
 *
 * This is the first of C1's two enforcement points, and the one that matters: the console's
 * write path cannot create a row for a flag that does not exist in code, so the flag table
 * cannot grow a name nobody reviewed. The second point is `readOverrides` above, which
 * would refuse such a row anyway — belt and braces, because these two are edited by
 * different people at different times.
 */
export function setFlag(
  db: DatabaseSync,
  name: string,
  value: unknown,
  nowMs: number,
  setBy: string,
): boolean {
  if (!isFlagName(name)) return false;
  const coerced = coerceFlag(name, value);
  if (coerced === null) return false;
  db.prepare(
    `INSERT INTO flags (name, value, updated_at, set_by) VALUES (?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, set_by = excluded.set_by`,
  ).run(name, JSON.stringify(coerced), nowMs, setBy);
  return true;
}

/**
 * Clears one override, returning the flag to its compiled-in default.
 *
 * Deletes the row rather than writing the default into it — see the file header. Answers
 * `true` when a row was actually removed, so the console can say "cleared" rather than
 * "cleared (there was nothing there)". Accepts a name outside the allowlist on purpose:
 * clearing is the one operation that must work on a stale row a removed flag left behind.
 */
export function clearFlag(db: DatabaseSync, name: string): boolean {
  const before = db.prepare('SELECT COUNT(*) AS n FROM flags WHERE name = ?').get(name) as { n: number };
  if (Number(before.n) === 0) return false;
  db.prepare('DELETE FROM flags WHERE name = ?').run(name);
  return true;
}

/**
 * The wire payload adminsvc serves to a polling service: every flag name with its effective
 * value, defaults merged with overrides.
 *
 * A TOTAL object rather than only the overrides, so a polling service's merge has nothing to
 * decide — it either got a usable answer and uses it, or it got nothing and uses its own
 * defaults. Sending only the overrides would make every service reimplement the merge, and
 * the one that got it wrong would be the one nobody looked at.
 *
 * The defaults come from `FLAG_DEFS` directly rather than through a cached
 * `defaultFlags()`, so there is no module-level snapshot that could be built before
 * anything and no second home for a value that already has one.
 */
export function effectiveFlags(db: DatabaseSync): Record<string, FlagValue> {
  const { values } = readOverrides(db);
  const out: Record<string, FlagValue> = {};
  for (const name of FLAG_NAMES) out[name] = values[name] ?? FLAG_DEFS[name].default;
  return out;
}
