/**
 * EntitlementService + the `entitlements` schema (design/19-server-platform.md §2,
 * ROADMAP 8.2). Runs against real collections with their real indexes rather than a stub, because half
 * of what this pass ships IS the schema: the UNIQUE constraint that makes an at-least-once
 * delivery idempotent, the foreign key `ratings` deliberately does not have, and the two
 * CHECKs that keep the column design/19 §7's audit groups by from filling with junk. A
 * mocked `DatabaseSync` would assert none of them.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { AccountsStore } from '../src/db';
import { freshAccounts } from './mongoHarness';
import {
  BLUEPRINT_SKU_PREFIX,
  CHARACTER_SKU_PREFIX,
  ENTITLEMENT_SOURCES,
  EntitlementService,
  OWNERSHIP_FIELDS,
  applyOwnership,
  blueprintSku,
  characterSku,
  skusToOwnership,
  stripOwnership,
  type EntitlementSource,
} from '../src/EntitlementService';

let store: AccountsStore;
let ents: EntitlementService;

/**
 * A real `accounts` document.
 *
 * The SQLite version's comment said "the foreign key below is enforced, so every test that
 * grants needs one" — that FK is gone (see db.ts) and nothing would now refuse a grant for
 * an account that does not exist. The fixture stays anyway: these tests are about
 * entitlements, and writing them against accounts that exist keeps them describing a state
 * the server can actually be in. The refusal itself is `routes/internalEntitlements.ts`'s
 * explicit check, and it is tested there.
 */
async function makeAccount(id: string): Promise<string> {
  await store.accounts.insertOne({
    _id: id,
    username: `user-${id}`,
    passwordHash: 'hash',
    provider: 'local',
    createdAt: 1_700_000_000_000,
  });
  return id;
}

beforeEach(async () => {
  store = await freshAccounts();
  ents = new EntitlementService(store);
});

// --- SKU namespacing --------------------------------------------------------------------

describe('SKU namespacing', () => {
  it('builds a blueprint and a character SKU in two distinct namespaces', async () => {
    expect(blueprintSku('cannon')).toBe('blueprint:cannon');
    expect(characterSku('cannon')).toBe('character:cannon');
    // The whole reason for the prefixes: the SAME id in the two namespaces must not
    // collide under UNIQUE(account_id, sku).
    expect(blueprintSku('cannon')).not.toBe(characterSku('cannon'));
  });

  it('the exported prefixes are the ones the builders actually use', async () => {
    // Pins the constants the client mirrors (client/src/net/entitlements.ts) to the
    // builders, so a rename cannot silently desync the two sides of the wire.
    expect(blueprintSku('x').startsWith(BLUEPRINT_SKU_PREFIX)).toBe(true);
    expect(characterSku('x').startsWith(CHARACTER_SKU_PREFIX)).toBe(true);
  });
});

describe('skusToOwnership', () => {
  it('splits SKUs into the two MetaState ownership arrays, keeping order', async () => {
    expect(skusToOwnership(['blueprint:cannon', 'character:hero', 'blueprint:seeker'])).toEqual({
      unlockedBlueprints: ['cannon', 'seeker'],
      ownedCharacters: ['hero'],
    });
  });

  it('skips a SKU in neither namespace rather than throwing', async () => {
    // billsvc may later sell something that is neither — an unknown namespace must not be
    // able to break /account/meta for an account that owns one.
    expect(skusToOwnership(['bundle:season1', 'blueprint:cannon'])).toEqual({
      unlockedBlueprints: ['cannon'],
      ownedCharacters: [],
    });
  });

  it('skips a bare prefix with an empty id, in BOTH namespaces', async () => {
    // `'blueprint:'` slices to `''`, which would otherwise enter the array as an empty
    // weaponId and show up in the Forge as a nameless row.
    expect(skusToOwnership(['blueprint:', 'character:'])).toEqual({ unlockedBlueprints: [], ownedCharacters: [] });
  });

  it('returns empty arrays for no SKUs at all — the case every account is in today', async () => {
    expect(skusToOwnership([])).toEqual({ unlockedBlueprints: [], ownedCharacters: [] });
  });
});

// --- blob shaping -----------------------------------------------------------------------

describe('stripOwnership (the POST normalizer)', () => {
  it('drops both ownership fields and keeps everything the client legitimately authors', async () => {
    const blob = {
      materialBank: { mat_fire: 3 },
      unlockedBlueprints: ['cannon'],
      ownedCharacters: ['paid-hero'],
      loadout: ['repeater'],
      selectedSkin: 'juggernaut',
      hasSeenTutorial: true,
    };
    expect(stripOwnership(blob)).toEqual({
      materialBank: { mat_fire: 3 },
      loadout: ['repeater'],
      selectedSkin: 'juggernaut',
      hasSeenTutorial: true,
    });
  });

  it('names every field it drops — the strip covers OWNERSHIP_FIELDS exactly', async () => {
    // Derived from the exported list rather than hardcoded, so adding a third purchasable
    // field to OWNERSHIP_FIELDS makes this test cover it without an edit — and, more to the
    // point, so a field ADDED to the list but forgotten in `stripOwnership` fails here.
    const blob = Object.fromEntries(OWNERSHIP_FIELDS.map((f) => [f, ['smuggled']]));
    expect(stripOwnership({ ...blob, keep: 1 })).toEqual({ keep: 1 });
  });

  it('does not mutate the caller of record', async () => {
    const blob = { unlockedBlueprints: ['cannon'], keep: 1 };
    stripOwnership(blob);
    expect(blob.unlockedBlueprints).toEqual(['cannon']);
  });

  it.each([
    ['null', null],
    ['a string', 'not-a-blob'],
    ['a number', 7],
    ['an array', ['a', 'b']],
  ])('returns %s verbatim — there is nothing to strip, and the route already accepts it', (_label, value) => {
    expect(stripOwnership(value)).toEqual(value);
  });
});

describe('applyOwnership (the GET overwrite)', () => {
  it('replaces both fields with the server answer and leaves the rest alone', async () => {
    const out = applyOwnership(
      { materialBank: { mat_ice: 1 }, unlockedBlueprints: ['smuggled'], ownedCharacters: ['smuggled'] },
      { unlockedBlueprints: ['cannon'], ownedCharacters: ['hero'] },
    );
    expect(out).toEqual({ materialBank: { mat_ice: 1 }, unlockedBlueprints: ['cannon'], ownedCharacters: ['hero'] });
  });

  it('ADDS both fields to a blob that has neither, so the client always gets arrays', async () => {
    expect(applyOwnership({ loadout: [] }, { unlockedBlueprints: ['cannon'], ownedCharacters: [] })).toEqual({
      loadout: [],
      unlockedBlueprints: ['cannon'],
      ownedCharacters: [],
    });
  });

  it('copies the arrays rather than aliasing the caller state', async () => {
    const own = { unlockedBlueprints: ['cannon'], ownedCharacters: [] };
    const out = applyOwnership({}, own) as { unlockedBlueprints: string[] };
    out.unlockedBlueprints.push('mutated');
    expect(own.unlockedBlueprints).toEqual(['cannon']);
  });

  it.each([
    ['null', null],
    ['a string', 'not-a-blob'],
    ['an array', [1, 2]],
  ])('returns %s untouched — a non-object blob has nowhere to put the fields', (_label, value) => {
    expect(applyOwnership(value, { unlockedBlueprints: ['cannon'], ownedCharacters: [] })).toEqual(value);
  });
});

// --- the table ---------------------------------------------------------------------------

describe('EntitlementService.grant', () => {
  it('lands a row and reports that it did', async () => {
    const a = await makeAccount('acct-1');
    expect(await ents.grant(a, blueprintSku('cannon'), 'grant')).toBe(true);
    expect(await ents.list(a)).toHaveLength(1);
  });

  it('is idempotent: a redelivered grant is a no-op that reports false', async () => {
    // design/19 §4 — platform callbacks are at-least-once by contract, so the UNIQUE
    // constraint (not a prior SELECT) has to be the idempotency key.
    const a = await makeAccount('acct-1');
    expect(await ents.grant(a, characterSku('hero'), 'purchase', { orderId: 'ord-1' })).toBe(true);
    expect(await ents.grant(a, characterSku('hero'), 'purchase', { orderId: 'ord-1' })).toBe(false);
    expect(await ents.list(a)).toHaveLength(1);
  });

  it('a re-grant never overwrites the first grant source or order — the audit record wins', async () => {
    // A free hand-issue arriving after a paid one must not erase the order behind it, or
    // §7's reconciliation loses the only local end of that join.
    const a = await makeAccount('acct-1');
    await ents.grant(a, characterSku('hero'), 'purchase', { orderId: 'ord-1', nowMs: 1000 });
    expect(await ents.grant(a, characterSku('hero'), 'grant', { nowMs: 2000 })).toBe(false);
    expect((await ents.list(a))[0]).toMatchObject({ source: 'purchase', orderId: 'ord-1', grantedAt: 1000 });
  });

  it('scopes ownership per account — the same SKU granted twice is two independent rows', async () => {
    const a = await makeAccount('acct-1');
    const b = await makeAccount('acct-2');
    expect(await ents.grant(a, characterSku('hero'), 'grant')).toBe(true);
    expect(await ents.grant(b, characterSku('hero'), 'grant')).toBe(true);
    expect(await ents.list(a)).toHaveLength(1);
    expect(await ents.list(b)).toHaveLength(1);
  });

  it('defaults order_id to NULL and granted_at to the wall clock when neither is given', async () => {
    const before = Date.now();
    const a = await makeAccount('acct-1');
    await ents.grant(a, blueprintSku('cannon'), 'drop');
    const row = (await ents.list(a))[0]!;
    expect(row.orderId).toBeNull();
    expect(row.grantedAt).toBeGreaterThanOrEqual(before);
    expect(row.grantedAt).toBeLessThanOrEqual(Date.now());
  });

  it('records the injected clock verbatim when one is given', async () => {
    const a = await makeAccount('acct-1');
    await ents.grant(a, blueprintSku('cannon'), 'event', { nowMs: 1_234_567 });
    expect((await ents.list(a))[0]!.grantedAt).toBe(1_234_567);
  });

  it.each(ENTITLEMENT_SOURCES)('accepts source %s', async (source) => {
    const a = await makeAccount('acct-1');
    // Only `purchase` needs an order behind it; the collection validator is what makes that true.
    const opts = source === 'purchase' ? { orderId: 'ord-1' } : {};
    expect(await ents.grant(a, blueprintSku('cannon'), source, opts)).toBe(true);
    expect((await ents.list(a))[0]!.source).toBe(source);
  });

  it('REFUSES a purchase with no order behind it — an unauditable paid row', async () => {
    const a = await makeAccount('acct-1');
    await expect(ents.grant(a, characterSku('hero'), 'purchase')).rejects.toThrow(/validation/i);
    expect(await ents.list(a)).toEqual([]);
  });

  it('REFUSES a source outside the enum, so a typo cannot poison the audit column', async () => {
    // Reachable only past TypeScript, which is exactly the shape a hand-written SQL
    // correction (design/19 §7's "no admin service") takes.
    const a = await makeAccount('acct-1');
    await expect(ents.grant(a, characterSku('hero'), 'gift' as EntitlementSource)).rejects.toThrow(/validation/i);
  });

  it('ACCEPTS a grant to an account that does not exist — the foreign key is gone', async () => {
    // INVERTED, rather than deleted, because the change is worth pinning. The SQLite table
    // declared `account_id REFERENCES accounts(id)` and this case asserted the throw; the
    // cluster has no such constraint and this write now succeeds, producing exactly the
    // orphan the old schema's comment warned about ("an orphan that silently never
    // delivers"). `db.ts`'s header says so, and the check that actually stands is
    // `routes/internalEntitlements.ts`'s explicit account lookup — tested there, not here.
    //
    // If MongoDB ever grows a referential constraint, this test goes red, which is the
    // right way to be told.
    await expect(ents.grant('no-such-account', characterSku('hero'), 'grant')).resolves.toBe(true);
    expect(await ents.list('no-such-account')).toHaveLength(1);
  });
});

describe('EntitlementService.revoke', () => {
  it('deletes an owned SKU and reports that it did', async () => {
    const a = await makeAccount('acct-1');
    await ents.grant(a, characterSku('hero'), 'grant');
    expect(await ents.revoke(a, characterSku('hero'))).toBe(true);
    expect(await ents.list(a)).toEqual([]);
  });

  it('reports false for a SKU the account never owned', async () => {
    const a = await makeAccount('acct-1');
    expect(await ents.revoke(a, characterSku('hero'))).toBe(false);
  });

  it('does not touch another account holding the same SKU', async () => {
    const a = await makeAccount('acct-1');
    const b = await makeAccount('acct-2');
    await ents.grant(a, characterSku('hero'), 'grant');
    await ents.grant(b, characterSku('hero'), 'grant');
    await ents.revoke(a, characterSku('hero'));
    expect(await ents.list(b)).toHaveLength(1);
  });
});

describe('EntitlementService.list', () => {
  it('is empty for an account that has been granted nothing', async () => {
    expect(await ents.list(await makeAccount('acct-1'))).toEqual([]);
  });

  it('returns full rows in grant order, mapped out of the document fields', async () => {
    const a = await makeAccount('acct-1');
    await ents.grant(a, blueprintSku('cannon'), 'purchase', { orderId: 'ord-9', nowMs: 10 });
    await ents.grant(a, characterSku('hero'), 'starter', { nowMs: 20 });
    expect((await ents.list(a)).map((r) => ({ ...r, id: typeof r.id }))).toEqual([
      // `id` was an INTEGER PRIMARY KEY and is an ObjectId's hex string now. Nothing outside
      // this module reads it; what callers depend on is the ORDER, which is asserted by the
      // two rows below being in grant order.
      { id: 'string', accountId: a, sku: 'blueprint:cannon', source: 'purchase', orderId: 'ord-9', grantedAt: 10 },
      { id: 'string', accountId: a, sku: 'character:hero', source: 'starter', orderId: null, grantedAt: 20 },
    ]);
  });

  it('returns only this account rows', async () => {
    const a = await makeAccount('acct-1');
    const b = await makeAccount('acct-2');
    await ents.grant(a, blueprintSku('cannon'), 'grant');
    await ents.grant(b, blueprintSku('seeker'), 'grant');
    expect((await ents.list(a)).map((r) => r.sku)).toEqual(['blueprint:cannon']);
  });
});

describe('EntitlementService.owns', () => {
  it('answers true only for a SKU this account actually holds', async () => {
    const a = await makeAccount('acct-1');
    const b = await makeAccount('acct-2');
    await ents.grant(a, characterSku('hero'), 'grant');
    expect(await ents.owns(a, characterSku('hero'))).toBe(true);
    expect(await ents.owns(a, characterSku('other'))).toBe(false);
    // The check a PvP character gate would make (design/14: the one meta axis that reaches
    // PvP) — it has to be account-scoped, not "does anyone own this".
    expect(await ents.owns(b, characterSku('hero'))).toBe(false);
  });
});

describe('EntitlementService.ownership', () => {
  it('projects this account grants onto the two MetaState arrays', async () => {
    const a = await makeAccount('acct-1');
    await ents.grant(a, blueprintSku('cannon'), 'purchase', { orderId: 'ord-1' });
    await ents.grant(a, characterSku('hero'), 'event');
    await ents.grant(a, 'bundle:season1', 'event'); // an unknown namespace, skipped
    expect(await ents.ownership(a)).toEqual({ unlockedBlueprints: ['cannon'], ownedCharacters: ['hero'] });
  });

  it('is empty for an account with no grants — which is every account today', async () => {
    expect(await ents.ownership(await makeAccount('acct-1'))).toEqual({ unlockedBlueprints: [], ownedCharacters: [] });
  });
});

describe('the entitlements schema itself', () => {
  it('is hand-queryable the way design/19 §7 requires, with no admin service', async () => {
    // Not decoration: §7 rules out an admin service and says the requirement is only that
    // the schema be readable and correctable with plain SQL. This is that claim, executed.
    const a = await makeAccount('acct-1');
    await ents.grant(a, characterSku('hero'), 'purchase', { orderId: 'ord-1' });
    await ents.grant(a, characterSku('villain'), 'grant');
    await ents.grant(a, blueprintSku('cannon'), 'grant');

    // `WHERE sku LIKE 'character:%' ORDER BY id`, as an operator would type it in mongosh.
    const characters = await store.entitlements
      .find({ sku: { $regex: '^character:' } })
      .sort({ _id: 1 })
      .toArray();
    expect(characters.map((r) => r.sku)).toEqual(['character:hero', 'character:villain']);

    // §7's daily anomaly audit, in one pipeline: count the non-purchase grants per account.
    const audit = await store.entitlements
      .aggregate([{ $match: { source: { $ne: 'purchase' } } }, { $group: { _id: '$accountId', n: { $sum: 1 } } }])
      .toArray();
    expect(audit).toEqual([{ _id: a, n: 2 }]);
  });

  it('survives a second service over the same collections', async () => {
    const a = await makeAccount('acct-1');
    await ents.grant(a, characterSku('hero'), 'grant');
    // Was "CREATE TABLE IF NOT EXISTS, like every other table here". The equivalent property
    // is that a second service over the same store reads the same data rather than
    // re-initialising anything under it.
    await expect(new EntitlementService(store).list('acct-1')).resolves.toHaveLength(1);
  });
});
