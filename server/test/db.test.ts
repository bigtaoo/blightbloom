/**
 * db.ts (design/16-accounts.md) — the control plane's indexes and validators, asserted
 * against a real server.
 *
 * Every test here is about a guarantee that used to be a line of SQL DDL. The old suite
 * did not need most of them: `UNIQUE`, `CHECK` and `REFERENCES` were declarative, and a
 * test that SQLite enforces its own `UNIQUE` would have been a test of SQLite. Here the
 * same guarantees are a `createIndex` call with four options, three of which are easy to
 * omit and none of which fail loudly when omitted — so each one is pinned by the failure it
 * is supposed to produce.
 *
 * `ensureAccountsIndexes` runs in `beforeEach` rather than once, because it is the thing
 * under test: a freshly created Atlas database gets its constraints from that call and
 * from nothing else.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Db } from 'mongodb';
import { accountsStore, ensureAccountsIndexes, CI_COLLATION, type AccountsStore } from '../src/db';
import { openTestMongo, type MongoTestContext } from './mongoHarness';

let ctx: MongoTestContext;
let db: Db;
let s: AccountsStore;

beforeEach(async () => {
  ctx = await openTestMongo();
  db = ctx.db('accounts');
  await ensureAccountsIndexes(db);
  s = accountsStore(db);
});
afterEach(async () => {
  await ctx.dispose();
});

const account = (id: string, username: string, extra: Record<string, unknown> = {}) => ({
  _id: id,
  username,
  passwordHash: 'h',
  provider: 'local',
  createdAt: 1,
  ...extra,
});

describe('username uniqueness folds case', () => {
  it('refuses a second account whose username differs only in case', async () => {
    // The guarantee the SQLite schema DESCRIBED in AuthService's comment and did not
    // enforce: its `UNIQUE` used the default BINARY collation, so this insert succeeded and
    // only the look-before-write check stood between the two accounts.
    await s.accounts.insertOne(account('a1', 'Alice'));
    await expect(s.accounts.insertOne(account('a2', 'alice'))).rejects.toMatchObject({ code: 11000 });
    await expect(s.accounts.insertOne(account('a3', 'ALICE'))).rejects.toMatchObject({ code: 11000 });
    expect(await s.accounts.countDocuments()).toBe(1);
  });

  it('admits exactly one of N concurrent registrations of the same name in different cases', async () => {
    // The race the port would have introduced. Sequential inserts pass even against a
    // case-sensitive index plus a look-before-write check; this is the version that does
    // not, and it is the reason `AuthService` claims the name by inserting rather than by
    // asking first.
    const spellings = ['Bob', 'bob', 'BOB', 'bOb', 'BoB'];
    const results = await Promise.allSettled(
      spellings.map((name, i) => s.accounts.insertOne(account(`b${i}`, name))),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await s.accounts.countDocuments()).toBe(1);
  });

  it('finds an account by a differently-cased spelling, but only when the query says so', async () => {
    await s.accounts.insertOne(account('a1', 'Alice'));
    expect(await s.accounts.findOne({ username: 'alice' }, { collation: CI_COLLATION })).toMatchObject({ _id: 'a1' });
    // The trap CI_COLLATION's doc comment is about: the same query WITHOUT the collation
    // silently falls back to the default and finds nothing. A login path that forgot it
    // would reject every user who capitalised differently than they registered.
    expect(await s.accounts.findOne({ username: 'alice' })).toBeNull();
  });
});

describe('the provider index is partial', () => {
  it('admits any number of local accounts, which carry no providerId at all', async () => {
    // A plain unique index on {provider, providerId} admits ONE document with the field
    // missing and rejects the rest — so this is the assertion that would fail if the
    // partialFilterExpression were dropped, and it would fail on the second player to
    // register rather than in some rare state.
    await s.accounts.insertOne(account('a1', 'alice'));
    await s.accounts.insertOne(account('a2', 'bob'));
    await s.accounts.insertOne(account('a3', 'carol'));
    expect(await s.accounts.countDocuments()).toBe(3);
  });

  it('still refuses two accounts claiming one portal identity', async () => {
    await s.accounts.insertOne(account('a1', 'cg:1', { provider: 'crazygames', providerId: '1' }));
    await expect(
      s.accounts.insertOne(account('a2', 'cg:1-again', { provider: 'crazygames', providerId: '1' })),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it('treats the same providerId under two providers as two identities', async () => {
    await s.accounts.insertOne(account('a1', 'cg:7', { provider: 'crazygames', providerId: '7' }));
    await s.accounts.insertOne(account('a2', 'wx:7', { provider: 'wechat', providerId: '7' }));
    expect(await s.accounts.countDocuments()).toBe(2);
  });
});

describe('entitlements', () => {
  const ent = (extra: Record<string, unknown> = {}) => ({
    _id: `e${Math.random()}`,
    accountId: 'a1',
    sku: 'blueprint:cannon',
    source: 'grant' as const,
    grantedAt: 1,
    ...extra,
  });

  it('refuses a second entitlement for the same account and sku', async () => {
    // A SKU is own-or-not, never stacked, so this index is also the idempotency key an
    // at-least-once platform callback is delivered through.
    await s.entitlements.insertOne(ent());
    await expect(s.entitlements.insertOne(ent())).rejects.toMatchObject({ code: 11000 });
  });

  it('refuses a source outside the enum', async () => {
    await expect(s.entitlements.insertOne(ent({ source: 'freebie' as never }))).rejects.toThrow(
      /validation/i,
    );
  });

  it('refuses a purchase-sourced entitlement with no order behind it', async () => {
    // The CHECK constraint the SQLite table carried. It survives as a server-side validator
    // rather than as a rule this code follows, which is the point: it binds a `mongosh`
    // prompt too.
    await expect(s.entitlements.insertOne(ent({ source: 'purchase' }))).rejects.toThrow(/validation/i);
    await expect(
      s.entitlements.insertOne(ent({ source: 'purchase', orderId: 'ord-1' })),
    ).resolves.toMatchObject({ acknowledged: true });
  });

  it('accepts a non-purchase entitlement with no order, which is every grant', async () => {
    await expect(s.entitlements.insertOne(ent({ source: 'starter' }))).resolves.toMatchObject({
      acknowledged: true,
    });
  });
});

describe('ensureAccountsIndexes', () => {
  it('is idempotent, so every service may call it at boot', async () => {
    await ensureAccountsIndexes(db);
    await ensureAccountsIndexes(db);
    const names = (await s.accounts.indexes()).map((i) => i.name);
    expect(names).toContain('accounts_username_ci');
    expect(names).toContain('accounts_provider_id');
  });

  it('installs the validator on a database that already holds the collection', async () => {
    // The `collMod` branch: a deployed cluster reaches this code with `entitlements`
    // already created by an earlier boot, and `createCollection` would throw there.
    await db.collection('entitlements').insertOne({ _id: 'seed' as never, accountId: 'a', sku: 's', source: 'grant', grantedAt: 1 });
    await expect(ensureAccountsIndexes(db)).resolves.toBeUndefined();
  });
});
