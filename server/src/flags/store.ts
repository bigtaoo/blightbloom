/**
 * The `ops` database — the flag overrides (design/21 §4), and the ONLY database adminsvc
 * may write.
 *
 * Until 2026-09-15 this was `ops.db`, a fourth `node:sqlite` file. It is now the fourth
 * logical database on the cluster (`src/mongo.ts`), with one collection in it. Everything
 * that made it safe was a property of the SHAPE of the data rather than of SQLite, so all
 * of it survives the move unchanged; what did not survive is recorded at the end.
 *
 * ## How this coexists with B1
 *
 * Decision B1 says the console holds no write handle to **player data**. `accounts`,
 * `billing` and `analytics` are three other databases, adminsvc reaches them through a
 * cluster user with a read-only role, and nothing about a player is in this one — one
 * document per flag, holding a name this repo declared and a value this repo validated.
 *
 * The distinction is load-bearing rather than a technicality, so it is worth being able to
 * say it in one sentence: **a total compromise of the console can change how the game
 * behaves; it cannot change who anybody is or what they own.** §4's own note that this is
 * "the first write in the whole design, which is why it is last" is the same observation
 * from the other side.
 *
 * ## Sparse on purpose: a document means "overridden"
 *
 * There is no document per flag. A flag with no document uses its compiled-in default
 * (`defs.ts`'s `FLAG_DEFS`), and clearing an override DELETES the document rather than
 * writing the default into it. That matters for one specific reason: a stored copy of the
 * default goes stale silently the day the default changes in a deploy, and the console
 * would then show, and every service would then use, a value nobody chose — with the
 * collection looking perfectly consistent. Absence is the only representation of "as
 * shipped" that cannot drift.
 *
 * ## The flag NAME is the `_id`
 *
 * `name TEXT PRIMARY KEY` becomes `_id`, rather than a `name` field under a generated
 * ObjectId with a unique index beside it. One column was the whole key, so the natural key
 * IS the identity: an upsert on `{ _id: name }` is then the same single atomic operation
 * `ON CONFLICT(name) DO UPDATE` was, and there is no second index to create, forget, or
 * create without `unique`.
 *
 * `_id` carries no enum of the allowlist, and that is deliberate for the reason the SQL
 * `CHECK` was left off: the allowlist lives in `defs.ts` and changes with a deploy, so a
 * copy in the database would go stale in the direction that REFUSES a legitimate new flag.
 * It is enforced on both sides of the collection instead — {@link setFlag} will not write an
 * unknown name, and {@link readOverrides} will not return one.
 *
 * ## Values are stored as JSON text
 *
 * One string field rather than a typed one, because the type is already declared in code and
 * the database is not the authority on it. `JSON.parse` on the way out then goes through
 * `coerceFlag`, so a hand-written document that says `"true"` for a boolean flag is refused
 * at read time and the default is used — see `defs.ts` on why guessing is worse. Storing the
 * value as a native BSON type would make that case unrepresentable in the store and
 * therefore untestable, while doing nothing about the case it exists for.
 *
 * ## What the move changed
 *
 * {@link clearFlag} used to count the rows, then delete them, then report the count — a
 * look-before-write that could report `true` twice for one document if two operators
 * cleared the same flag at once. It is one `deleteOne` now and the server decides.
 */
import type { Collection, Db } from 'mongodb';
import { FLAG_DEFS, FLAG_NAMES, coerceFlag, isFlagName, type FlagName, type FlagValue } from './defs';

/** The one collection. A constant, so a typo cannot quietly create a second one. */
export const FLAGS_COLLECTION = 'flags';

/** One OVERRIDDEN flag. See the file header for why absence, not a stored default, is how
 *  "as shipped" is represented. */
export interface FlagDoc {
  /** The flag name (`defs.ts`'s allowlist), or a name a removed flag left behind. */
  _id: string;
  /** The value as JSON text. See the file header. */
  value: string;
  updatedAt: number;
  /** Who set it. There is one operator (decision B3), so this is the operator NAME rather
   *  than an account id, and it exists for the same reason design/21 §3.3 asks for an audit
   *  LINE rather than an audit system: the useful question months later is "was this set on
   *  purpose", and a name plus a timestamp answers it. */
  setBy: string;
}

export interface FlagOverride {
  name: FlagName;
  value: FlagValue;
  updatedAtMs: number;
  setBy: string;
}

/** The override collection. */
export const flagsOf = (db: Db): Collection<FlagDoc> => db.collection<FlagDoc>(FLAGS_COLLECTION);

/**
 * Create the one index this collection needs beyond `_id`.
 *
 * `{ updatedAt: -1 }` is what {@link listOverrides} sorts the console's table by. It carries
 * no `unique`, on purpose and not by omission: two flags set in the same millisecond is a
 * normal thing an operator does with two clicks, and a unique index here would refuse the
 * second write. The uniqueness that matters — one document per flag — is `_id`'s, which no
 * call can forget to create.
 */
export async function ensureOpsIndexes(db: Db): Promise<void> {
  await flagsOf(db).createIndex({ updatedAt: -1 }, { name: 'flags_updated_at' });
}

/**
 * Every override in the collection that is still legitimate, keyed by name.
 *
 * "Still legitimate" is doing real work. Two documents are skipped rather than returned:
 *
 *  - one whose name is no longer in the allowlist, which is what a flag REMOVED in a
 *    deploy leaves behind. The document is left in place (deleting somebody's data on a
 *    read is not this function's business) and simply never read again.
 *  - one whose value does not pass `coerceFlag` — a hand-written document, or one written
 *    under an older definition with a wider range.
 *
 * Both cases are logged by the caller rather than swallowed here: a flag that is silently
 * not being applied is exactly the kind of thing somebody spends an afternoon on.
 */
export async function readOverrides(
  db: Db,
): Promise<{ values: Partial<Record<FlagName, FlagValue>>; skipped: string[] }> {
  const docs = await flagsOf(db).find({}).toArray();
  const values: Partial<Record<FlagName, FlagValue>> = {};
  const skipped: string[] = [];
  for (const doc of docs) {
    const name = String(doc._id);
    if (!isFlagName(name)) {
      skipped.push(name);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(doc.value));
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
 *  {@link readOverrides} this returns documents that FAILED validation too — the console is
 *  where somebody needs to see that one exists and is not being applied. */
export async function listOverrides(db: Db): Promise<{ rows: FlagOverride[]; invalid: string[] }> {
  const docs = await flagsOf(db).find({}).sort({ updatedAt: -1 }).toArray();
  const out: FlagOverride[] = [];
  const invalid: string[] = [];
  for (const doc of docs) {
    const name = String(doc._id);
    let value: FlagValue | null = null;
    if (isFlagName(name)) {
      try {
        value = coerceFlag(name, JSON.parse(String(doc.value)) as unknown);
      } catch {
        value = null;
      }
    }
    if (value === null) {
      invalid.push(name);
      continue;
    }
    out.push({ name: name as FlagName, value, updatedAtMs: Number(doc.updatedAt), setBy: String(doc.setBy) });
  }
  return { rows: out, invalid };
}

/**
 * Sets one override. Returns false — and writes NOTHING — for a name outside the allowlist
 * or a value its definition refuses.
 *
 * This is the first of C1's two enforcement points, and the one that matters: the console's
 * write path cannot create a document for a flag that does not exist in code, so the
 * collection cannot grow a name nobody reviewed. The second point is {@link readOverrides},
 * which would refuse such a document anyway — belt and braces, because these two are edited
 * by different people at different times.
 */
export async function setFlag(
  db: Db,
  name: string,
  value: unknown,
  nowMs: number,
  setBy: string,
): Promise<boolean> {
  if (!isFlagName(name)) return false;
  const coerced = coerceFlag(name, value);
  if (coerced === null) return false;
  await flagsOf(db).updateOne(
    { _id: name },
    { $set: { value: JSON.stringify(coerced), updatedAt: nowMs, setBy } },
    { upsert: true },
  );
  return true;
}

/**
 * Clears one override, returning the flag to its compiled-in default.
 *
 * Deletes the document rather than writing the default into it — see the file header.
 * Answers `true` when one was actually removed, so the console can say "cleared" rather than
 * "cleared (there was nothing there)", and the server is what decides that: one `deleteOne`,
 * not a count followed by a delete.
 *
 * Accepts a name outside the allowlist on purpose: clearing is the one operation that must
 * work on a stale document a removed flag left behind.
 */
export async function clearFlag(db: Db, name: string): Promise<boolean> {
  const r = await flagsOf(db).deleteOne({ _id: name });
  return r.deletedCount === 1;
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
export async function effectiveFlags(db: Db): Promise<Record<string, FlagValue>> {
  const { values } = await readOverrides(db);
  const out: Record<string, FlagValue> = {};
  for (const name of FLAG_NAMES) out[name] = values[name] ?? FLAG_DEFS[name].default;
  return out;
}
