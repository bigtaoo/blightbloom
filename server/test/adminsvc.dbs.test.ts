/**
 * Decision B1, asserted rather than asserted-about (design/21 §3.1): **the console cannot
 * write player data.**
 *
 * ## What this file used to be able to prove, and what it can prove now
 *
 * Until 2026-09-15 it proved a CAPABILITY. `openAdminDbs` returned three handles opened
 * `readOnly: true`, so a write attempted through one of them threw — SQLite refusing, not
 * our code declining — and the three cases here attempted an INSERT, a DELETE, an UPDATE and
 * a DROP and required a throw from each.
 *
 * That capability is gone. There is one pooled client, it cannot hold half a handle, and
 * what stands in its place is an Atlas ROLE living in the cluster's configuration, where no
 * test in this repository can see it. So B1 is now bought by a PROBE — `probeWriteAccess`
 * attempts a real write at boot and `assertReadOnlyAccess` refuses to start the process
 * unless every player-data database said no — and what this file proves is that the probe
 * works: that it performs a genuine write rather than asking about permissions, that it
 * reports an acceptance as an acceptance, that an acceptance stops the process, and that a
 * refusal is what lets it through.
 *
 * **The weaker half is stated rather than hidden.** The suite's mongod has no roles, so a
 * real role refusal cannot be staged here; the refusal arm is bought with a collection
 * VALIDATOR that makes the server reject every document. That is a genuine server-side
 * refusal of a genuine write — the same shape of `MongoServerError` arriving from the same
 * place — but it is not an authorization refusal, and no test here can be. What is
 * untestable in this repository is exactly the thing that moved out of it.
 *
 * The rest of the file is the nullable arms, which are normal states and not defensive code:
 * one connection means one failure that takes all three, and analytics is opt-in.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  WRITE_PROBE_COLLECTION,
  WRITE_PROBE_ID,
  openAdminDbs,
  openedDbs,
  probeWriteAccess,
  type AdminDbs,
} from '../src/adminsvc/dbs';
import { ALLOW_WRITABLE_VAR, AdminWritableError, assertReadOnlyAccess } from '../src/adminsvc/server';
import { closeMongo } from '../src/mongo';
import { openTestMongo, type MongoTestContext } from './mongoHarness';

/**
 * A cluster that cannot be reached, for the two cases about that.
 *
 * Port 1 answers nothing, and the two timeouts are what turn the driver's 30-second default
 * server selection into a test rather than a wait. It is a real connection attempt against a
 * real socket — the failure being asserted is the driver's, not a thrown stub's.
 */
const UNREACHABLE = 'mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=200&connectTimeoutMS=200';

let ctx: MongoTestContext;

beforeEach(async () => {
  ctx = await openTestMongo();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await ctx.dispose();
  // `mongo.ts`'s client is process-wide and a vitest worker runs many files in one process.
  // Any case here that went through `connectMongo()` has to leave that slot empty, or the
  // next file's first `store()` call silently gets this file's connection.
  await closeMongo();
});

/** A logger that records, so a case can assert on the line an operator would search for. */
function recorder(): { lines: { level: string; msg: string; fields?: Record<string, unknown> }[]; log: never } {
  const lines: { level: string; msg: string; fields?: Record<string, unknown> }[] = [];
  const push = (level: string) => (msg: string, fields?: Record<string, unknown>) => {
    lines.push({ level, msg, fields });
  };
  const log = {
    error: push('error'),
    warn: push('warn'),
    info: push('info'),
    debug: push('debug'),
    child: () => log,
  };
  return { lines, log: log as never };
}

/**
 * The error a promise rejected with.
 *
 * `.catch((e) => e as Error)` on its own widens to `boolean | Error` — the resolved type
 * leaks into the union — and every assertion on `.message` then needs a cast that would also
 * silently accept a promise that RESOLVED. This throws in that case instead, so a case
 * asserting on a refusal cannot pass against a boot that went through.
 */
async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected a rejection, got a resolved promise');
}

/** The three-handle bundle over this context's own databases, with no connection of its
 *  own — `open` is the injection point that keeps every case off the process-wide client. */
async function bundle(opts: { analyticsEnabled?: boolean } = {}): Promise<AdminDbs> {
  return openAdminDbs({ analyticsEnabled: opts.analyticsEnabled ?? true, open: (name) => ctx.db(name) });
}

describe('probeWriteAccess — a real write, not a permissions question', () => {
  it('reports an ACCEPTED write, and leaves the evidence of it', async () => {
    // The local mongod has no roles, so it accepts. That is the honest answer here and it is
    // also what makes this case worth having: a probe that reported "refused" against a
    // server that in fact accepts would be a probe that always passes.
    const db = ctx.db('accounts');
    expect(await probeWriteAccess(db, 1_757_000_000_000)).toEqual({ refused: false });
    // A write really reached the server. A probe that quietly did nothing would report
    // `refused: false` forever without ever asking it anything, and this is the difference —
    // the document is not a side effect, it is the proof.
    expect(await db.collection(WRITE_PROBE_COLLECTION).findOne({})).toEqual({
      _id: WRITE_PROBE_ID,
      at: 1_757_000_000_000,
    });
  });

  it('leaves ONE document however many times it runs', async () => {
    // Why the id is fixed and the write is an upsert. A correctly-scoped cluster never gets
    // this document at all; one that does is a console booting with `BB_ADMIN_ALLOW_WRITABLE`,
    // restarting on a schedule, and it must not accumulate a document per restart in the
    // database it was not supposed to touch.
    const db = ctx.db('accounts');
    for (const at of [1, 2, 3]) await probeWriteAccess(db, at);
    expect(await db.collection(WRITE_PROBE_COLLECTION).countDocuments({})).toBe(1);
    // ...and it carries the LAST probe's time, so the document answers "when was B1 last
    // observed to be false" rather than "when did this first happen".
    expect((await db.collection(WRITE_PROBE_COLLECTION).findOne({}))?.at).toBe(3);
  });

  it('reports a REFUSED write, with the server\'s own reason', async () => {
    // The refusal arm, bought with a validator — see the file header on what this does and
    // does not stand in for. It is a real refusal, by the server, of a real write.
    const db = ctx.db('accounts');
    await db.createCollection(WRITE_PROBE_COLLECTION, { validator: { $expr: false } });
    const probe = await probeWriteAccess(db);
    expect(probe.refused).toBe(true);
    // The reason is carried, not swallowed. It is the only thing an operator staring at a
    // refused boot has to go on, and "some write failed" is not a diagnosis.
    expect(probe.refused && probe.reason.length > 0).toBe(true);
  });
});

describe('assertReadOnlyAccess — B1 as a boot condition', () => {
  it('REFUSES to start when a player-data database accepts a write', async () => {
    const { log } = recorder();
    await expect(assertReadOnlyAccess(await bundle(), {}, log)).rejects.toThrow(AdminWritableError);
  });

  it('names every writable database, and the variable that would let it run anyway', async () => {
    // The message is the whole remedy path. An operator who reads it has to learn which
    // databases the credential can write and what the two ways out are — fix the role, or
    // decide to run without B1 on purpose.
    const { log } = recorder();
    const err = await rejection(assertReadOnlyAccess(await bundle(), {}, log));
    expect(err.message).toContain('accounts');
    expect(err.message).toContain('billing');
    expect(err.message).toContain('analytics');
    expect(err.message).toContain(ALLOW_WRITABLE_VAR);
  });

  it('is an AdminStartupError, so runMain already turns it into exit 1', async () => {
    // Not a decorative hierarchy: `main.ts`'s `runMain` catches `AdminStartupError` and
    // turns it into a readable line plus exit 1, and rethrows anything else as a stack
    // trace starting in `node:internal`. A plain `Error` here would make a misconfigured
    // role look like a crash rather than a configuration refusal.
    const { AdminStartupError } = await import('../src/adminsvc/credentials');
    const { log } = recorder();
    const err = await rejection(assertReadOnlyAccess(await bundle(), {}, log));
    expect(err).toBeInstanceOf(AdminStartupError);
  });

  it('PASSES when every database refuses, and says so per database', async () => {
    const { lines, log } = recorder();
    const dbs = await bundle();
    for (const { db } of openedDbs(dbs)) {
      await db.createCollection(WRITE_PROBE_COLLECTION, { validator: { $expr: false } });
    }
    await expect(assertReadOnlyAccess(dbs, {}, log)).resolves.toBe(true);
    expect(lines.filter((l) => l.msg === 'write probe refused').map((l) => l.fields?.db)).toEqual([
      'accounts',
      'billing',
      'analytics',
    ]);
  });

  it('requires ALL of them — one writable handle out of three still refuses', async () => {
    // B1 is not a rate. A console that can write one of the three player-data databases is
    // a console that can write player data, and the sentence design/21 makes is about the
    // process rather than about a majority of its handles.
    const { log } = recorder();
    const dbs = await bundle();
    for (const { name, db } of openedDbs(dbs)) {
      if (name === 'billing') continue;
      await db.createCollection(WRITE_PROBE_COLLECTION, { validator: { $expr: false } });
    }
    const err = await rejection(assertReadOnlyAccess(dbs, {}, log));
    expect(err).toBeInstanceOf(AdminWritableError);
    expect(err.message).toContain('billing');
    expect(err.message).not.toContain('accounts');
  });

  it('runs anyway under BB_ADMIN_ALLOW_WRITABLE, and WARNS that B1 does not hold', async () => {
    // The escape hatch exists because a local mongod has no roles. What makes it acceptable
    // is that it is loud: the boot is a WARN naming the databases and the variable, and
    // `main.ts` prints `readOnly: false` on the startup line — so a box running without B1
    // never looks like one that holds it.
    const { lines, log } = recorder();
    await expect(assertReadOnlyAccess(await bundle(), { [ALLOW_WRITABLE_VAR]: '1' } as never, log)).resolves.toBe(
      false,
    );
    const warn = lines.find((l) => l.level === 'warn');
    expect(warn?.msg).toContain('B1 does not hold');
    expect(warn?.fields?.dbs).toBe('accounts,billing,analytics');
  });

  it('accepts only 1 and true — an empty or arbitrary value does not open the hatch', async () => {
    // The `""`-beats-`??` trap from the other side (design/19 §9): a compose file with a
    // trailing `BB_ADMIN_ALLOW_WRITABLE:` must not disable the one check standing behind B1.
    const { log } = recorder();
    for (const value of ['', '   ', '0', 'false', 'yes']) {
      await expect(assertReadOnlyAccess(await bundle(), { [ALLOW_WRITABLE_VAR]: value } as never, log)).rejects.toThrow(
        AdminWritableError,
      );
    }
    await expect(assertReadOnlyAccess(await bundle(), { [ALLOW_WRITABLE_VAR]: 'true' } as never, log)).resolves.toBe(
      false,
    );
  });

  it('probes nothing when nothing opened, and lets a dead console boot', async () => {
    // The state a cluster outage produces: three nulls, so there is nothing to probe and
    // no writable handle to refuse over. A console that would not start here is a console
    // that cannot be used to find out why it cannot reach the cluster — which is the same
    // argument `openAdminDbs` never throwing rests on.
    const { lines, log } = recorder();
    const dead: AdminDbs = { accounts: null, billing: null, analytics: null, errors: { accounts: 'x', billing: 'x', analytics: 'x' } };
    await expect(assertReadOnlyAccess(dead, {}, log)).resolves.toBe(true);
    expect(lines).toEqual([]);
  });
});

describe('openAdminDbs — the absent arms', () => {
  it('opens all three when analytics is switched on', async () => {
    const dbs = await bundle();
    expect([dbs.accounts, dbs.billing, dbs.analytics].every((d) => d !== null)).toBe(true);
    // An OPENED handle records the empty string, not `undefined` — the record is total on
    // purpose, so no call site needs a `?? ''` fallback that no input could reach.
    expect(dbs.errors).toEqual({ accounts: '', billing: '', analytics: '' });
  });

  it('treats analytics off as "not configured" rather than as an error', async () => {
    // The opt-in state (design/21 §2.4): collection off means this deployment collects
    // nothing, which is a supported deployment and not a misconfiguration. The page says so
    // in those words, so the reason string has to be the one a person reads — and it has to
    // name the variable they would set, which is no longer a path.
    const dbs = await bundle({ analyticsEnabled: false });
    expect(dbs.analytics).toBeNull();
    expect(dbs.errors.analytics).toContain('BB_ANALYTICS_ENABLED');
    expect(dbs.errors.accounts).toBe('');
  });

  it('defaults analytics OFF when nothing says otherwise', async () => {
    // The direction that matters for the one subsystem with a privacy policy attached: a
    // caller that forgets to pass the switch collects nothing rather than everything.
    const dbs = await openAdminDbs({ open: (name) => ctx.db(name) });
    expect(dbs.analytics).toBeNull();
  });

  it('takes all three down together when the CLUSTER is unreachable, with the driver\'s reason', async () => {
    // One connection, so one failure. This is the arm that replaces three independent
    // missing files: there is no longer a state where billing is absent and accounts is
    // fine, and pretending otherwise would be a page that cannot happen.
    const { lines, log } = recorder();
    vi.stubEnv('BB_MONGO_URI', UNREACHABLE);
    // No `open`, so it goes through `connectMongo()` — at a port nothing answers.
    const dbs = await openAdminDbs({ analyticsEnabled: true }, log);
    expect([dbs.accounts, dbs.billing, dbs.analytics]).toEqual([null, null, null]);
    for (const [name, reason] of Object.entries(dbs.errors)) expect(reason, name).not.toBe('');
    // One reason, not three different ones: they are the same failure and the page should
    // not suggest three investigations.
    expect(new Set(Object.values(dbs.errors)).size).toBe(1);
    // "The commerce tab says unavailable" and "the cluster is unreachable" are the same
    // fact, and only one of them is searchable in the log store.
    expect(lines.filter((l) => l.msg === 'cluster unavailable')).toHaveLength(1);
  });

  it('never throws when the cluster is unreachable', async () => {
    // Stated separately from the case above because it is the load-bearing half: a console
    // that cannot start is a console that cannot be used to diagnose the reason it cannot
    // start, and every section renders its own "unavailable" rather than one global error.
    vi.stubEnv('BB_MONGO_URI', UNREACHABLE);
    await expect(openAdminDbs({ analyticsEnabled: true })).resolves.toBeDefined();
  });
});

describe('openedDbs', () => {
  it('lists only what actually opened, in a fixed order', async () => {
    // The helper the probe iterates. A version that walked the three fields blindly would
    // hand a `null` to `probeWriteAccess` and turn a switched-off analytics store into a
    // crash at boot.
    const dbs = await bundle({ analyticsEnabled: false });
    expect(openedDbs(dbs).map((e) => e.name)).toEqual(['accounts', 'billing']);
    expect(openedDbs(await bundle()).map((e) => e.name)).toEqual(['accounts', 'billing', 'analytics']);
  });

  it('is empty for a bundle that opened nothing', () => {
    const dead: AdminDbs = {
      accounts: null,
      billing: null,
      analytics: null,
      errors: { accounts: 'x', billing: 'x', analytics: 'x' },
    };
    expect(openedDbs(dead)).toEqual([]);
  });
});

describe('the three handles are three different logical databases', () => {
  it('a write to one is invisible to the others', async () => {
    // design/19 §4's "money gets its own database" survives the move as a separate DATABASE
    // rather than a collection prefix, and this is what would notice if a later refactor
    // served all three from one handle: the four-store separation would still typecheck,
    // still pass every view test, and be gone.
    const dbs = await bundle();
    await dbs.billing!.collection('marker').insertOne({ _id: 'only-billing' } as never);
    expect(await dbs.accounts!.collection('marker').countDocuments({})).toBe(0);
    expect(await dbs.analytics!.collection('marker').countDocuments({})).toBe(0);
    expect(await dbs.billing!.collection('marker').countDocuments({})).toBe(1);
  });
});

