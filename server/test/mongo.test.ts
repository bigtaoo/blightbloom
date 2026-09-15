/**
 * `src/mongo.ts` — the cluster connection.
 *
 * This file exists because the module had 10% line and 0% BRANCH coverage when the port's
 * first pass was measured, while the package as a whole read 97.6/97.3 and the 90/90 gate
 * was comfortably green. That is the failure design/18 "Layer 4" describes: a percentage
 * over a whole tree cannot tell you that the one module every service calls before it binds
 * a port is untested.
 *
 * What is untested here is specifically the REFUSAL paths — a missing `BB_MONGO_URI`, a
 * store reached before boot. Those are the lines whose only job is to fail loudly, which is
 * exactly the category that runs on every call while only the happy side is ever exercised.
 */
import { describe, it, expect, beforeEach, afterEach, inject } from 'vitest';
import { closeMongo, connectMongo, dbName, mongoUri, requireClient, store, STORES } from '../src/mongo';

const ORIGINAL_URI = process.env.BB_MONGO_URI;
const ORIGINAL_PREFIX = process.env.BB_MONGO_DB_PREFIX;

beforeEach(async () => {
  // Every test starts from a disconnected module, because `connectMongo` memoises per
  // process and a leaked connection from one case would make the next one's assertions
  // about "before boot" meaningless.
  await closeMongo();
  delete process.env.BB_MONGO_URI;
  delete process.env.BB_MONGO_DB_PREFIX;
});

afterEach(async () => {
  await closeMongo();
  if (ORIGINAL_URI === undefined) delete process.env.BB_MONGO_URI;
  else process.env.BB_MONGO_URI = ORIGINAL_URI;
  if (ORIGINAL_PREFIX === undefined) delete process.env.BB_MONGO_DB_PREFIX;
  else process.env.BB_MONGO_DB_PREFIX = ORIGINAL_PREFIX;
});

describe('mongoUri', () => {
  it('throws, naming the variable, when BB_MONGO_URI is unset', () => {
    // The refusal the module header argues for: no default and no localhost fallback,
    // because a wrong default brings a service up healthy against an EMPTY database and it
    // starts writing accounts into it. The variable name is in the message because that is
    // what an operator reads at 3am.
    expect(() => mongoUri()).toThrow(/BB_MONGO_URI is not set/);
  });

  it('treats whitespace and an empty string the same as unset', () => {
    process.env.BB_MONGO_URI = '';
    expect(() => mongoUri()).toThrow(/BB_MONGO_URI is not set/);
    process.env.BB_MONGO_URI = '   ';
    expect(() => mongoUri()).toThrow(/BB_MONGO_URI is not set/);
  });

  it('returns the value trimmed', () => {
    process.env.BB_MONGO_URI = '  mongodb://host/  ';
    expect(mongoUri()).toBe('mongodb://host/');
  });
});

describe('dbName', () => {
  it('leaves the four names bare with no prefix — which is what production uses', () => {
    expect(STORES.map(dbName)).toEqual(['accounts', 'billing', 'analytics', 'ops']);
  });

  it('applies BB_MONGO_DB_PREFIX, so one cluster can host more than one environment', () => {
    process.env.BB_MONGO_DB_PREFIX = 'staging';
    expect(STORES.map(dbName)).toEqual([
      'staging_accounts',
      'staging_billing',
      'staging_analytics',
      'staging_ops',
    ]);
  });

  it('treats an empty or whitespace prefix as absent, not as a leading underscore', () => {
    // `BB_MONGO_DB_PREFIX:` with no value in a compose file produces `""`. Reading that as a
    // prefix would point every service at `_accounts` — a fifth, empty database that looks
    // exactly like a fresh install.
    process.env.BB_MONGO_DB_PREFIX = '';
    expect(dbName('accounts')).toBe('accounts');
    process.env.BB_MONGO_DB_PREFIX = '  ';
    expect(dbName('accounts')).toBe('accounts');
  });
});

describe('requireClient and store — before boot', () => {
  it('throws rather than connecting lazily', () => {
    // Reaching a store before `connectMongo()` has completed is a WIRING bug, not a state to
    // recover from: a lazy connect here would move a bad URI from a boot failure to a
    // failure on some player's first request, which is the posture the module refuses.
    expect(() => requireClient()).toThrow(/has not completed/);
    expect(() => store('accounts')).toThrow(/has not completed/);
  });
});

describe('connectMongo', () => {
  it('memoises, so every service shares one pooled client', async () => {
    const a = await connectMongo(inject('mongoUri'));
    const b = await connectMongo(inject('mongoUri'));
    expect(b).toBe(a);
    // And the memoised client is the one `store()` hands out.
    expect(store('accounts').client).toBe(a);
  });

  it('shares ONE in-flight connection between concurrent callers', async () => {
    // Every `main.ts` awaits this and so does the first thing each service does afterwards.
    // Without the `connecting` latch these would open several clients and leak all but one.
    const [a, b, c] = await Promise.all([
      connectMongo(inject('mongoUri')),
      connectMongo(inject('mongoUri')),
      connectMongo(inject('mongoUri')),
    ]);
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it('reads BB_MONGO_URI when called with no argument', async () => {
    process.env.BB_MONGO_URI = inject('mongoUri');
    await expect(connectMongo()).resolves.toBeDefined();
  });

  it('clears the in-flight latch when the connection FAILS, so a retry can still connect', async () => {
    // The arm that matters on a cold boot against a cluster that is not up yet. A latch left
    // set would make every later attempt await a promise that has already rejected — the
    // service would never connect again without a restart, which is the opposite of what a
    // retry loop is for.
    await expect(
      connectMongo('mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=200&connectTimeoutMS=200'),
    ).rejects.toThrow();
    await expect(connectMongo(inject('mongoUri'))).resolves.toBeDefined();
  });

  it('closeMongo is safe when nothing was ever connected', async () => {
    await expect(closeMongo()).resolves.toBeUndefined();
  });

  it('closeMongo releases the memoised client, so the next reach throws again', async () => {
    await connectMongo(inject('mongoUri'));
    expect(() => requireClient()).not.toThrow();
    await closeMongo();
    expect(() => requireClient()).toThrow(/has not completed/);
  });
});

describe('store', () => {
  it('hands back the four logical databases under their resolved names', async () => {
    process.env.BB_MONGO_DB_PREFIX = 'pinned';
    await connectMongo(inject('mongoUri'));
    expect(STORES.map((s) => store(s).databaseName)).toEqual([
      'pinned_accounts',
      'pinned_billing',
      'pinned_analytics',
      'pinned_ops',
    ]);
  });
});
