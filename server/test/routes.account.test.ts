/**
 * `server/src/routes/account.ts` at the unit layer — the two `/account/meta` handlers
 * after ROADMAP 8.2 moved ownership into the `entitlements` table
 * (design/19-server-platform.md §2).
 *
 * `matchsvc.http.test.ts` drives the same handlers through a real `node:http` server and
 * asserts the end-to-end shape; it is not repeated here. What this file adds is the set of
 * cases a real client cannot easily produce, and which are exactly the branches a
 * whole-blob route grew when it stopped being blind:
 *
 *  - a stored blob that is NOT an object (a string, `null`, an array), which the pre-8.2
 *    route accepted and stored verbatim and so can still be sitting in a real database;
 *  - the two 401 refusals, which never reach the table at all;
 *  - the `data === undefined` 400, asserted to have written nothing;
 *  - a granted entitlement showing up in BOTH places the response carries it — overwritten
 *    into `data`, and listed with its `source` alongside.
 *
 * The database is real (`openDb(':memory:')`) and only `AuthService` is faked: the whole
 * question here is what reaches and leaves the store, and a mocked one would answer none of it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AuthService } from '../src/AuthService';
import type { AccountsStore } from '../src/db';
import { freshAccounts } from './mongoHarness';
import { EntitlementService, blueprintSku, characterSku } from '../src/EntitlementService';
import { getMeta, postGuestMerge, postMeta, GUEST_ID_HEADER, type AccountRouteDeps } from '../src/routes/account';

const ACCOUNT = 'acct-1';
const SESSION = { accountId: ACCOUNT, username: 'ada' };

let store: AccountsStore;
let ents: EntitlementService;

interface Recorded {
  status: number;
  body: string;
}

function fakeRes(): { res: ServerResponse; sent: Recorded } {
  const sent: Recorded = { status: 0, body: '' };
  const res = {
    writeHead(status: number) {
      sent.status = status;
      return res;
    },
    end(body?: string) {
      sent.body = body ?? '';
    },
  };
  return { res: res as unknown as ServerResponse, sent };
}

function fakeReq(headers: Record<string, string> = {}): IncomingMessage & EventEmitter {
  const req = new EventEmitter() as EventEmitter & { headers: Record<string, string> };
  req.headers = headers;
  return req as unknown as IncomingMessage & EventEmitter;
}

/** A session for anyone presenting a Bearer token, none otherwise — `requireAuth`'s two
 * inputs, without standing up password hashing. */
function fakeAuth(): AuthService {
  return {
    verifySession: vi.fn((token: string) => (token ? SESSION : null)),
  } as unknown as AuthService;
}

const url = new URL('http://match.test/account/meta');
const parsed = (sent: Recorded) => JSON.parse(sent.body) as Record<string, unknown>;
const authed = (extra: Record<string, string> = {}) => fakeReq({ authorization: 'Bearer tok-1', ...extra });
const GUEST = 'install-7';

function deps(): AccountRouteDeps {
  return { auth: fakeAuth(), store };
}

/**
 * Drive `postMeta` to completion.
 *
 * The handler is asynchronous now, so emitting `data`/`end` and reading `sent` on the next
 * line would read it before the route has written anything — the shape of test that passes
 * today and quietly reports an empty body the moment one more `await` appears in the
 * handler. The handler's own promise is awaited instead, and the stream is fed on a later
 * tick so the route is already listening when the bytes arrive.
 */
async function post(body: unknown): Promise<Recorded> {
  const req = authed();
  const { res, sent } = fakeRes();
  const done = postMeta(req, res, url, deps());
  await Promise.resolve();
  req.emit('data', Buffer.from(JSON.stringify(body)));
  req.emit('end');
  await done;
  return sent;
}

async function storedBlob(): Promise<string | undefined> {
  return (await store.metaState.findOne({ _id: ACCOUNT }))?.data;
}

/** Write a blob past the route, to reproduce a document a PRE-8.2 server stored. */
async function seedRawBlob(raw: string): Promise<void> {
  await store.metaState.insertOne({ _id: ACCOUNT, data: raw });
}

beforeEach(async () => {
  store = await freshAccounts();
  await store.accounts.insertOne({
    _id: ACCOUNT,
    username: 'ada',
    passwordHash: 'hash',
    provider: 'local',
    createdAt: 1,
  });
  ents = new EntitlementService(store);
});

describe('GET /account/meta — the session boundary', () => {
  it('401s an unauthenticated read without touching the tables', async () => {
    const { res, sent } = fakeRes();
    await getMeta(fakeReq(), res, url, deps());
    expect(sent.status).toBe(401);
    expect(parsed(sent)).toEqual({ error: 'invalid or expired session' });
  });
});

describe('GET /account/meta — ownership comes from entitlements, not the blob', () => {
  it('answers { data: null, entitlements: [] } for an account that has saved nothing', async () => {
    const { res, sent } = fakeRes();
    await getMeta(authed(), res, url, deps());
    expect(sent.status).toBe(200);
    // `data: null` is load-bearing and unchanged by 8.2: the client answers it by pushing
    // its own (possibly guest-accumulated) local state up, rather than overwriting it.
    expect(parsed(sent)).toEqual({ data: null, entitlements: [], guestMerged: true });
  });

  it('still answers { data: null } when the account owns something but has never saved', async () => {
    // The window `pullAccountMeta`'s optional `local` argument exists for: a purchase made
    // before this device ever wrote a blob. The server must NOT invent a blob here — that
    // would replace the player's local materials with defaults.
    await ents.grant(ACCOUNT, characterSku('hero'), 'purchase', { orderId: 'ord-1', nowMs: 42 });
    const { res, sent } = fakeRes();
    await getMeta(authed(), res, url, deps());
    expect(parsed(sent)).toEqual({
      data: null,
      entitlements: [{ sku: 'character:hero', source: 'purchase', grantedAt: 42 }],
      guestMerged: true,
    });
  });

  it('overwrites the stored blob ownership with the entitlements table, and lists them alongside', async () => {
    await seedRawBlob(JSON.stringify({ materialBank: { mat_fire: 2 }, unlockedBlueprints: ['smuggled'], ownedCharacters: ['smuggled'] }));
    await ents.grant(ACCOUNT, blueprintSku('cannon'), 'purchase', { orderId: 'ord-1', nowMs: 10 });
    await ents.grant(ACCOUNT, characterSku('hero'), 'grant', { nowMs: 20 });

    const { res, sent } = fakeRes();
    await getMeta(authed(), res, url, deps());
    expect(parsed(sent)).toEqual({
      data: { materialBank: { mat_fire: 2 }, unlockedBlueprints: ['cannon'], ownedCharacters: ['hero'] },
      entitlements: [
        { sku: 'blueprint:cannon', source: 'purchase', grantedAt: 10 },
        { sku: 'character:hero', source: 'grant', grantedAt: 20 },
      ],
      guestMerged: true,
    });
  });

  it('never leaks order_id to the client — it addresses a row in billsvc private database', async () => {
    await ents.grant(ACCOUNT, characterSku('hero'), 'purchase', { orderId: 'ord-secret', nowMs: 1 });
    const { res, sent } = fakeRes();
    await getMeta(authed(), res, url, deps());
    expect(sent.body).not.toContain('ord-secret');
    expect(Object.keys((parsed(sent).entitlements as Record<string, unknown>[])[0]!)).toEqual(['sku', 'source', 'grantedAt']);
  });

  it('reads only THIS account entitlements', async () => {
    await store.accounts.insertOne({
      _id: 'acct-2',
      username: 'bob',
      passwordHash: 'hash',
      provider: 'local',
      createdAt: 1,
    });
    await ents.grant('acct-2', characterSku('hero'), 'grant');
    await seedRawBlob(JSON.stringify({ loadout: [] }));
    const { res, sent } = fakeRes();
    await getMeta(authed(), res, url, deps());
    expect(parsed(sent).data).toEqual({ loadout: [], unlockedBlueprints: [], ownedCharacters: [] });
  });

  it.each([
    ['a bare string', '"not-a-blob"', 'not-a-blob'],
    ['a stored null', 'null', null],
    ['an array', '[1,2]', [1, 2]],
  ])('returns %s verbatim rather than crashing — a pre-8.2 server accepted and stored it', async (_label, raw, expected) => {
    await seedRawBlob(raw);
    await ents.grant(ACCOUNT, characterSku('hero'), 'grant');
    const { res, sent } = fakeRes();
    await getMeta(authed(), res, url, deps());
    expect(sent.status).toBe(200);
    // The ownership still comes back in `entitlements`, so the client is not left blind.
    expect(parsed(sent).data).toEqual(expected);
    expect(parsed(sent).entitlements).toHaveLength(1);
  });
});

describe('POST /account/meta — ownership is ignored, not rejected', () => {
  it('401s an unauthenticated write without reading the body', async () => {
    const req = authed();
    req.headers = {};
    const { res, sent } = fakeRes();
    await postMeta(req, res, url, deps());
    expect(sent.status).toBe(401);
    // No listener was attached, so nothing would consume a body if one arrived. Still the
    // assertion that matters, and it is stronger than it looks now: the session is resolved
    // BEFORE the body is read, so an unauthenticated request never reaches the store or the
    // stream. Reordering those two would leave this red.
    expect(req.listenerCount('end')).toBe(0);
  });

  it('400s a body with no data field and writes no row', async () => {
    expect((await post({})).status).toBe(400);
    expect(await storedBlob()).toBeUndefined();
  });

  it('200s a blob carrying self-granted ownership, and stores it with that ownership removed', async () => {
    // The free-money hole design/19 §2 closes. Accepting-and-ignoring rather than rejecting
    // is deliberate: every pre-existing guest/offline path POSTs the full MetaState.
    const sent = await post({
      data: {
        materialBank: { mat_ice: 1 },
        unlockedBlueprints: ['cannon', 'emberblade'],
        ownedCharacters: ['paid-hero'],
        loadout: ['repeater'],
      },
    });
    expect(sent.status).toBe(200);
    expect(parsed(sent)).toEqual({ ok: true });
    // Stripped on WRITE, not merely overwritten on read: `meta_state` must never hold a
    // client-authored ownership claim, or a human reading the table is misled by one.
    expect(JSON.parse((await storedBlob())!)).toEqual({ materialBank: { mat_ice: 1 }, loadout: ['repeater'] });
    expect(await storedBlob()).not.toContain('paid-hero');
  });

  it('grants nothing — a POST is not a grant seam', async () => {
    await post({ data: { ownedCharacters: ['paid-hero'], unlockedBlueprints: ['cannon'] } });
    expect(await ents.list(ACCOUNT)).toEqual([]);
  });

  it('upserts: a second write replaces the first blob rather than accumulating', async () => {
    await post({ data: { materialBank: { mat_fire: 1 } } });
    await post({ data: { materialBank: { mat_ice: 9 } } });
    expect(JSON.parse((await storedBlob())!)).toEqual({ materialBank: { mat_ice: 9 } });
  });

  it.each([
    ['a bare string', 'not-a-blob'],
    ['a null', null],
    ['an array', [1, 2]],
  ])('stores %s verbatim — there is nothing to strip, exactly as before 8.2', async (_label, data) => {
    expect((await post({ data })).status).toBe(200);
    expect(JSON.parse((await storedBlob())!)).toEqual(data);
  });

  it('round-trips through GET with the server ownership written over it', async () => {
    await ents.grant(ACCOUNT, blueprintSku('cannon'), 'event', { nowMs: 5 });
    await post({ data: { materialBank: { mat_fire: 4 }, unlockedBlueprints: ['smuggled'], ownedCharacters: ['smuggled'] } });
    const { res, sent } = fakeRes();
    await getMeta(authed(), res, url, deps());
    expect(parsed(sent).data).toEqual({
      materialBank: { mat_fire: 4 },
      unlockedBlueprints: ['cannon'],
      ownedCharacters: [],
    });
  });
});

/**
 * The one-time device merge (design/16 hole 1, 2026-09-17) — `accounts.mergedGuestIds`, the
 * idempotency key, read by `GET /account/meta` and written by `POST /account/guest-merge`.
 *
 * Every case here is about ASKING TWICE, because that is the failure the whole mechanism
 * exists to prevent and the only one that cannot be recovered from: a second merge adds a
 * material bank the account already holds, and nothing afterwards can tell it happened. Its
 * mirror — a claim that reports success for a device already recorded — would be that bug
 * with an extra step, so the two `claimed` arms are asserted separately rather than through
 * one round trip.
 */
async function guestMerge(body: unknown, headers: Record<string, string> = { authorization: 'Bearer tok-1' }): Promise<Recorded> {
  const req = fakeReq(headers);
  const { res, sent } = fakeRes();
  const done = postGuestMerge(req, res, url, deps());
  await Promise.resolve();
  req.emit('data', Buffer.from(JSON.stringify(body)));
  req.emit('end');
  await done;
  return sent;
}

const mergedIds = async (): Promise<string[] | undefined> =>
  (await store.accounts.findOne({ _id: ACCOUNT }))?.mergedGuestIds;

describe('POST /account/guest-merge — the claim', () => {
  it('401s without a session, and writes nothing', async () => {
    const sent = await guestMerge({ guestId: GUEST }, {});
    expect(sent.status).toBe(401);
    expect(await mergedIds()).toBeUndefined();
  });

  it('claims an unseen device once, and refuses the second claim', async () => {
    expect(parsed(await guestMerge({ guestId: GUEST }))).toEqual({ claimed: true });
    expect(await mergedIds()).toEqual([GUEST]);
    // The second call is the two-tabs race, collapsed into sequence. `false` is what makes
    // the loser take the account's state instead of adding the same bank again.
    expect(parsed(await guestMerge({ guestId: GUEST }))).toEqual({ claimed: false });
    expect(await mergedIds()).toEqual([GUEST]);
  });

  it('keeps one entry per device, so a second browser gets its own answer', async () => {
    await guestMerge({ guestId: GUEST });
    expect(parsed(await guestMerge({ guestId: 'install-9' }))).toEqual({ claimed: true });
    expect(await mergedIds()).toEqual([GUEST, 'install-9']);
  });

  it.each([
    ['missing', {}],
    ['empty', { guestId: '' }],
    ['not a string', { guestId: 42 }],
    ['absurdly long', { guestId: 'x'.repeat(129) }],
  ])('400s a %s guestId rather than storing it', async (_label, body) => {
    const sent = await guestMerge(body);
    expect(sent.status).toBe(400);
    expect(await mergedIds()).toBeUndefined();
  });
});

describe('GET /account/meta — guestMerged', () => {
  it('answers false for a device this account has never been offered a merge on', async () => {
    const { res, sent } = fakeRes();
    await getMeta(authed({ [GUEST_ID_HEADER]: GUEST }), res, url, deps());
    expect(parsed(sent).guestMerged).toBe(false);
  });

  it('answers true once that device has claimed', async () => {
    await guestMerge({ guestId: GUEST });
    const { res, sent } = fakeRes();
    await getMeta(authed({ [GUEST_ID_HEADER]: GUEST }), res, url, deps());
    expect(parsed(sent).guestMerged).toBe(true);
  });

  it('is per-device: another browser on the same account is still unmerged', async () => {
    await guestMerge({ guestId: GUEST });
    const { res, sent } = fakeRes();
    await getMeta(authed({ [GUEST_ID_HEADER]: 'install-9' }), res, url, deps());
    expect(parsed(sent).guestMerged).toBe(false);
  });

  it('is per-account: the same browser is unmerged against a DIFFERENT account', async () => {
    // A shared computer, which is the case the whole "merge once" rule is shaped around. The
    // key is the pair, not the device — recording it on the device alone would silently
    // suppress the second player's prompt and hand them the first one's materials.
    await guestMerge({ guestId: GUEST });
    await store.accounts.insertOne({ _id: 'acct-2', username: 'bob', passwordHash: 'hash', provider: 'local', createdAt: 1 });
    const other = { ...deps(), auth: { verifySession: () => ({ accountId: 'acct-2', username: 'bob' }) } as unknown as AuthService };
    const { res, sent } = fakeRes();
    await getMeta(authed({ [GUEST_ID_HEADER]: GUEST }), res, url, other);
    expect(parsed(sent).guestMerged).toBe(false);
  });

  it.each([
    ['no header at all', {}],
    ['a header repeated, which node hands over as an array', { [GUEST_ID_HEADER]: ['a', 'b'] as unknown as string }],
    ['an absurdly long header', { [GUEST_ID_HEADER]: 'x'.repeat(129) }],
  ])('answers true for %s — the default is always "offer nothing"', async (_label, headers) => {
    // Both defaults point the same way on purpose. Not asking costs a guest nothing (their
    // progress stays on the device); asking twice costs them a bank counted twice.
    const { res, sent } = fakeRes();
    await getMeta(authed(headers), res, url, deps());
    expect(parsed(sent).guestMerged).toBe(true);
  });

  it('does not read the accounts collection at all when no guest id was sent', async () => {
    // The read is the one this route did not have before; every `/account/meta` on every
    // logged-in boot would pay for it. Skipping it when there is no question to answer is
    // the difference, and a spy is the only way to see a query that did not happen.
    const spy = vi.spyOn(store.accounts, 'findOne');
    const { res } = fakeRes();
    await getMeta(authed(), res, url, deps());
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
