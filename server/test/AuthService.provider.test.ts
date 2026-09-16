/**
 * The FEDERATED half of AuthService (`loginWithProvider`, design/20 "account integration").
 * Separate from `AuthService.test.ts` — which owns the username/password surface — because
 * what is pinned here is not "a provider login works" but the four properties that make it
 * safe to hand somebody else's identity to a table whose unique key is a username of OUR
 * shape: no password can ever open the row, the provider's name is not run through our
 * naming rules, the derived handle cannot collide with a local account, and a race creates
 * one account rather than two.
 */
import { describe, it, expect } from 'vitest';
import { AuthService } from '../src/AuthService';
import { freshAccounts } from './mongoHarness';

async function make() {
  let idN = 0;
  let tokenN = 0;
  const store = await freshAccounts();
  const auth = new AuthService(store, {
    nowMs: () => 1_000,
    newAccountId: () => `acct-${++idN}`,
    newToken: () => `token-${++tokenN}`,
  });
  return { auth, store };
}

const cg = (providerId: string, displayName: string) => ({ provider: 'cg', providerId, displayName });

describe('loginWithProvider — find or create', () => {
  it('registers on first sight and returns the PROVIDER display name, not the handle', async () => {
    const { auth } = await make();
    expect(await auth.loginWithProvider(cg('u1', 'PortalPlayer'))).toMatchObject({
      accountId: 'acct-1',
      username: 'PortalPlayer',
      token: 'token-1',
    });
  });

  it('logs the SAME account in on a second sight — one row, two sessions', async () => {
    const { auth, store } = await make();
    const first = await auth.loginWithProvider(cg('u1', 'PortalPlayer'));
    const second = await auth.loginWithProvider(cg('u1', 'PortalPlayer'));
    expect(second.accountId).toBe(first.accountId);
    expect(second.token).not.toBe(first.token);
    expect(await store.accounts.countDocuments()).toBe(1);
    expect(await store.sessions.countDocuments()).toBe(2);
  });

  it('stores the handle as {provider}:{providerId} and the name in displayName', async () => {
    const { auth, store } = await make();
    await auth.loginWithProvider(cg('u1', 'PortalPlayer'));
    expect(await store.accounts.findOne({})).toMatchObject({
      username: 'cg:u1',
      displayName: 'PortalPlayer',
      provider: 'cg',
      providerId: 'u1',
    });
  });

  it('adopts a RENAME on the provider side — the provider owns the name, every login', async () => {
    const { auth, store } = await make();
    const first = await auth.loginWithProvider(cg('u1', 'OldName'));
    const renamed = await auth.loginWithProvider(cg('u1', 'NewName'));
    expect(renamed.accountId).toBe(first.accountId);
    expect(renamed.username).toBe('NewName');
    expect(await store.accounts.findOne({ _id: first.accountId })).toMatchObject({ displayName: 'NewName' });
  });

  it('keeps two providers with the same providerId apart', async () => {
    const { auth } = await make();
    const a = await auth.loginWithProvider({ provider: 'cg', providerId: 'u1', displayName: 'A' });
    const b = await auth.loginWithProvider({ provider: 'wx', providerId: 'u1', displayName: 'B' });
    expect(b.accountId).not.toBe(a.accountId);
  });
});

describe('loginWithProvider — the two namespaces cannot collide', () => {
  it('lets a portal player and a local account share a display name', async () => {
    // The project owner's 2026-09-08 decision — the same human on two platforms is two
    // accounts — only works if the namespaces cannot collide. `alice` the local account and
    // `alice` the portal player must both exist, and neither may reach the other's row.
    const { auth } = await make();
    expect(await auth.register('alice', 'hunter22')).toMatchObject({ username: 'alice' });
    expect(await auth.loginWithProvider(cg('u1', 'alice'))).toMatchObject({ username: 'alice', accountId: 'acct-2' });
  });

  it('cannot have its handle registered locally — the `:` is unreachable by validateUsername', async () => {
    const { auth } = await make();
    await auth.loginWithProvider(cg('u1', 'PortalPlayer'));
    expect(await auth.register('cg:u1', 'hunter22')).toMatchObject({ error: expect.stringContaining('may only contain') });
  });

  it('accepts a provider name our OWN rules would reject', async () => {
    // Every one of these fails `validateUsername`, and each is a name a real CrazyGames
    // account can have. Applying our rules here would be an unfixable dead end for that
    // player rather than a moderation win — see loginWithProvider's own note.
    const { auth } = await make();
    const names = ['x', 'has spaces', 'dash-name', 'ünïcodé', '玩家', 'admin', 'a'.repeat(60)];
    for (const [i, name] of names.entries()) {
      expect((await auth.loginWithProvider(cg(`u${i}`, name))).username).toBe(name.slice(0, 40));
    }
  });

  it('truncates a pathologically long name to 40 characters', async () => {
    const { auth, store } = await make();
    await auth.loginWithProvider(cg('u1', 'z'.repeat(500)));
    const row = (await store.accounts.findOne({}))!;
    expect(row.displayName).toHaveLength(40);
  });
});

describe('loginWithProvider — no password opens the row', () => {
  it('stores the sentinel, and every password attempt against the handle fails', async () => {
    const { auth, store } = await make();
    await auth.loginWithProvider(cg('u1', 'PortalPlayer'));
    const row = (await store.accounts.findOne({}))!;
    expect(row.passwordHash).toBe('!');
    for (const attempt of ['!', '', 'PortalPlayer', 'password']) {
      expect(await auth.login('cg:u1', attempt)).toEqual({ error: 'invalid username or password' });
    }
  });

  it('refuses password login even if a REAL hash is planted on the federated row', async () => {
    // The second of the two independent guards: `login`'s `provider !== 'local'` check.
    // Planting a working hash defeats the sentinel, and the row must still be unreachable —
    // otherwise a bad migration anywhere near that column is account takeover.
    const { auth, store } = await make();
    await auth.loginWithProvider(cg('u1', 'PortalPlayer'));
    await auth.register('donor', 'hunter22');
    const donor = (await store.accounts.findOne({ username: 'donor' }))!;
    await store.accounts.updateOne({ username: 'cg:u1' }, { $set: { passwordHash: donor.passwordHash } });
    // Proof the planted hash really is a working one, so the refusal above is the guard
    // and not a broken fixture.
    expect(await auth.login('donor', 'hunter22')).toMatchObject({ username: 'donor' });
    expect(await auth.login('cg:u1', 'hunter22')).toEqual({ error: 'invalid username or password' });
  });

  it('refuses to change the password of a federated account, with a reason', async () => {
    const { auth } = await make();
    const s = await auth.loginWithProvider(cg('u1', 'PortalPlayer'));
    expect(await auth.changePassword(s.accountId, 'anything', 'newpassword')).toMatchObject({
      error: expect.stringContaining('no password'),
    });
  });
});

describe('loginWithProvider — sessions and the display_name fallback', () => {
  it('resolves its session to the display name through verifySession', async () => {
    const { auth } = await make();
    const s = await auth.loginWithProvider(cg('u1', 'PortalPlayer'));
    expect(await auth.verifySession(s.token)).toEqual({ accountId: s.accountId, username: 'PortalPlayer' });
  });

  it('keeps a LOCAL account resolving to its username now that display_name exists', async () => {
    // The COALESCE fallback. display_name is NULL for every account registered before
    // 2026-09-08, and this is the case that breaks if the fallback is ever dropped.
    const { auth, store } = await make();
    const s = (await auth.register('bob', 'hunter22')) as { accountId: string; token: string };
    // ABSENT rather than null — the partial unique index is filtered on `$type: 'string'`,
    // so a local account must carry no `displayName` field at all (see db.ts).
    expect(await store.accounts.findOne({ _id: s.accountId })).not.toHaveProperty('displayName');
    expect(await auth.verifySession(s.token)).toEqual({ accountId: s.accountId, username: 'bob' });
    expect(await auth.login('bob', 'hunter22')).toMatchObject({ username: 'bob' });
  });
});

describe('loginWithProvider — concurrency', () => {
  it('creates ONE account when several first logins race for real', async () => {
    // The `catch` arm: the losing insert re-reads the winner's document. The SQLite version
    // had to STAGE this by monkeypatching `db.prepare` to land a winner between the
    // caller's own lookup and its insert, because nothing could actually interleave in a
    // synchronous store. Every call is a promise now, so the race can simply be run — which
    // is both a simpler test and a stronger one: it exercises the real ordering rather than
    // one the test author imagined.
    const { auth, store } = await make();
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => auth.loginWithProvider(cg('u1', `Racer${i}`))),
    );
    expect(await store.accounts.countDocuments()).toBe(1);
    // Every caller gets a session, and every session names the SAME account — a loser that
    // invented its own id would hand a player a session for a row that does not exist.
    const ids = new Set(results.map((r) => r.accountId));
    expect(ids.size).toBe(1);
    expect(results.every((r) => r.token)).toBe(true);
  });

  it('throws rather than inventing a session if the insert fails for a NON-race reason', async () => {
    // The guard is `isDuplicateKey`: only E11000 means "lost the race". Anything else must
    // propagate, because answering with a session for an account that was never written is
    // strictly worse than failing the login.
    const { auth, store } = await make();
    store.accounts.insertOne = () => Promise.reject(new Error('connection reset'));
    await expect(auth.loginWithProvider(cg('u1', 'PortalPlayer'))).rejects.toThrow(/connection reset/);
  });

  it('re-reads the winner when the insert loses on the unique index', async () => {
    // The other side of the same guard, staged rather than raced so the `catch` arm is
    // reached deterministically. Reaching it needs BOTH halves of the lost race: the
    // pre-insert lookup must miss (otherwise `loginWithProvider` takes its existing-account
    // branch and never inserts at all) and the insert must then fail on E11000. So the
    // winner is planted directly, the first lookup is forced to miss, and the insert is
    // forced to lose — which is exactly the interleaving a real race produces.
    const { auth, store } = await make();
    await store.accounts.insertOne({
      _id: 'winner',
      username: 'cg:u1',
      passwordHash: '!',
      provider: 'cg',
      providerId: 'u1',
      createdAt: 1,
      displayName: 'TheWinner',
    });
    const realFindOne = store.accounts.findOne.bind(store.accounts);
    let first = true;
    store.accounts.findOne = ((...args: Parameters<typeof realFindOne>) => {
      if (first) {
        first = false;
        return Promise.resolve(null);
      }
      return realFindOne(...args);
    }) as typeof store.accounts.findOne;
    store.accounts.insertOne = () =>
      Promise.reject(Object.assign(new Error('E11000 duplicate key'), { code: 11000 }));

    const loser = await auth.loginWithProvider(cg('u1', 'TheLoser'));
    expect(loser.accountId).toBe('winner');
    expect(loser.username).toBe('TheWinner');
  });
});
