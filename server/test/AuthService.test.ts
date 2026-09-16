/**
 * AuthService (design/16-accounts.md). Drives the REAL collections and their real indexes
 * against a throwaway database on the shared mongod, with an injected fake
 * clock/id/token source — mirrors PartyService.test.ts's style.
 *
 * `freshAccounts()` runs `ensureAccountsIndexes`, which matters more here than anywhere
 * else in the suite: `register` no longer checks for a duplicate name, it relies on
 * `accounts_username_ci` to refuse one. A store without that index would make every
 * "rejects a duplicate" case below pass by accident and assert nothing.
 */
import { describe, it, expect } from 'vitest';
import { AuthService, type AuthServiceDeps } from '../src/AuthService';
import { freshAccounts } from './mongoHarness';

async function make(overrides: Partial<AuthServiceDeps> = {}) {
  let now = 1_000;
  let idN = 0;
  let tokenN = 0;
  const deps: AuthServiceDeps = {
    nowMs: () => now,
    newAccountId: () => `acct-${++idN}`,
    newToken: () => `token-${++tokenN}`,
    ...overrides,
  };
  const store = await freshAccounts();
  const auth = new AuthService(store, deps);
  return { auth, store, advance: (ms: number) => (now += ms) };
}

describe('AuthService — register', () => {
  it('registers a new account and returns a session token', async () => {
    const { auth } = await make();
    const result = await auth.register('alice', 'hunter22');
    expect(result).toMatchObject({ accountId: 'acct-1', username: 'alice', token: 'token-1' });
  });

  it('rejects a duplicate username', async () => {
    const { auth } = await make();
    await auth.register('alice', 'hunter22');
    const result = await auth.register('alice', 'differentpw');
    expect(result).toMatchObject({ error: expect.stringContaining('taken') });
  });

  it('rejects a too-short username', async () => {
    const { auth } = await make();
    expect(await auth.register('ab', 'hunter22')).toMatchObject({ error: expect.any(String) });
  });

  it('rejects a blacklisted username (design/16-accounts.md local filter)', async () => {
    const { auth } = await make();
    expect(await auth.register('admin', 'hunter22')).toMatchObject({ error: 'username not allowed' });
    expect(await auth.register('xxAdminxx', 'hunter22')).toMatchObject({ error: 'username not allowed' });
  });

  it('rejects a username with invalid characters', async () => {
    const { auth } = await make();
    expect(await auth.register('al ice!', 'hunter22')).toMatchObject({ error: expect.any(String) });
  });

  it('rejects a too-short password', async () => {
    const { auth } = await make();
    expect(await auth.register('alice', 'short')).toMatchObject({ error: expect.any(String) });
  });

  it('never stores the password in plaintext', async () => {
    const { auth, store } = await make();
    await auth.register('alice', 'hunter22');
    const row = await store.accounts.findOne({ username: 'alice' });
    expect(row?.passwordHash).toBeTruthy();
    expect(row?.passwordHash).not.toContain('hunter22');
  });
});

describe('AuthService — login', () => {
  it('logs in with the correct password and issues a fresh session', async () => {
    const { auth } = await make();
    await auth.register('alice', 'hunter22');
    const result = await auth.login('alice', 'hunter22');
    expect(result).toMatchObject({ accountId: 'acct-1', username: 'alice', token: 'token-2' });
  });

  it('rejects the wrong password', async () => {
    const { auth } = await make();
    await auth.register('alice', 'hunter22');
    expect(await auth.login('alice', 'wrongpass')).toMatchObject({ error: expect.any(String) });
  });

  it('rejects an unknown username', async () => {
    const { auth } = await make();
    expect(await auth.login('nobody', 'hunter22')).toMatchObject({ error: expect.any(String) });
  });
});

describe('AuthService — login rate limiting', () => {
  it('locks out login after 5 consecutive failures, even with the correct password', async () => {
    const { auth } = await make();
    await auth.register('alice', 'hunter22');
    for (let i = 0; i < 5; i++) {
      expect(await auth.login('alice', 'wrongpass')).toMatchObject({ error: expect.any(String) });
    }
    const locked = await auth.login('alice', 'hunter22') as { error: string };
    expect(locked.error).toMatch(/too many/i);
  });

  it('a correct login before the 5th failure resets the streak', async () => {
    const { auth } = await make();
    await auth.register('alice', 'hunter22');
    await auth.login('alice', 'wrongpass');
    await auth.login('alice', 'wrongpass');
    expect(await auth.login('alice', 'hunter22')).toMatchObject({ accountId: 'acct-1' });
    // Streak reset — 4 more failures shouldn't trip the 5-attempt lock yet.
    for (let i = 0; i < 4; i++) await auth.login('alice', 'wrongpass');
    expect(await auth.login('alice', 'hunter22')).toMatchObject({ accountId: 'acct-1' });
  });

  it('the lockout is per-username — another account is unaffected', async () => {
    const { auth } = await make();
    await auth.register('alice', 'hunter22');
    await auth.register('bob', 'hunter22');
    for (let i = 0; i < 5; i++) await auth.login('alice', 'wrongpass');
    expect(await auth.login('alice', 'hunter22')).toMatchObject({ error: expect.stringMatching(/too many/i) });
    expect(await auth.login('bob', 'hunter22')).toMatchObject({ accountId: expect.any(String) });
  });

  it('the lockout key folds case, matching the COLLATE NOCASE username lookup', async () => {
    const { auth } = await make();
    await auth.register('alice', 'hunter22');
    for (let i = 0; i < 5; i++) await auth.login('Alice', 'wrongpass');
    expect(await auth.login('ALICE', 'hunter22')).toMatchObject({ error: expect.stringMatching(/too many/i) });
  });

  it('login succeeds again once the lockout window elapses', async () => {
    const { auth, advance } = await make();
    await auth.register('alice', 'hunter22');
    for (let i = 0; i < 5; i++) await auth.login('alice', 'wrongpass');
    expect(await auth.login('alice', 'hunter22')).toMatchObject({ error: expect.stringMatching(/too many/i) });
    advance(15 * 60_000 + 1);
    expect(await auth.login('alice', 'hunter22')).toMatchObject({ accountId: 'acct-1' });
  });
});

describe('AuthService — sessions', () => {
  it('verifies a live session token', async () => {
    const { auth } = await make();
    const { token } = await auth.register('alice', 'hunter22') as { token: string };
    expect(await auth.verifySession(token)).toMatchObject({ accountId: 'acct-1', username: 'alice' });
  });

  it('rejects an unknown token', async () => {
    const { auth } = await make();
    expect(await auth.verifySession('bogus')).toBeNull();
  });

  it('rejects an expired session', async () => {
    const { auth, advance } = await make();
    const { token } = await auth.register('alice', 'hunter22') as { token: string };
    advance(31 * 24 * 60 * 60_000); // past the 30-day TTL
    expect(await auth.verifySession(token)).toBeNull();
  });

  it('invalidates a session on logout', async () => {
    const { auth } = await make();
    const { token } = await auth.register('alice', 'hunter22') as { token: string };
    await auth.logout(token);
    expect(await auth.verifySession(token)).toBeNull();
  });
});

describe('AuthService — changePassword', () => {
  it('changes the password and invalidates the old one', async () => {
    const { auth } = await make();
    const { accountId } = await auth.register('alice', 'hunter22') as { accountId: string };
    const result = await auth.changePassword(accountId, 'hunter22', 'newpassword1');
    expect(result).toMatchObject({ ok: true });
    expect(await auth.login('alice', 'hunter22')).toMatchObject({ error: expect.any(String) });
    expect(await auth.login('alice', 'newpassword1')).toMatchObject({ accountId });
  });

  it('rejects the wrong current password', async () => {
    const { auth } = await make();
    const { accountId } = await auth.register('alice', 'hunter22') as { accountId: string };
    expect(await auth.changePassword(accountId, 'wrongpass', 'newpassword1')).toMatchObject({ error: expect.any(String) });
  });
});

describe('AuthService — expired session sweep', () => {
  it('a login/register sweeps away already-expired session rows (not just the one it happens to look up)', async () => {
    const { auth, store, advance } = await make();
    await auth.register('alice', 'hunter22');
    const { token: staleToken } = await auth.register('bob', 'hunter22') as { token: string };
    advance(31 * 24 * 60 * 60_000); // past the 30-day TTL for both existing sessions

    // A fresh login for a THIRD account should sweep bob's/alice's now-expired rows,
    // even though neither is the token this call is looking at.
    await auth.register('carol', 'hunter22');

    const remaining = await store.sessions.find({}).toArray();
    expect(remaining.map((r) => r._id)).not.toContain(staleToken);
    expect(remaining).toHaveLength(1); // only carol's fresh session survives
  });

  it('does not sweep a still-valid session', async () => {
    const { auth, store } = await make();
    const { token } = await auth.register('alice', 'hunter22') as { token: string };
    await auth.register('bob', 'hunter22'); // triggers a sweep pass
    const row = await store.sessions.findOne({ _id: token });
    expect(row).toBeTruthy();
  });
});

describe('AuthService — edge cases', () => {
  it('rejects an empty username and an empty password', async () => {
    const { auth } = await make();
    expect(await auth.register('', 'hunter22')).toMatchObject({ error: expect.any(String) });
    expect(await auth.register('alice', '')).toMatchObject({ error: expect.any(String) });
  });

  it('rejects a too-long username (21 chars, one past MAX_USERNAME)', async () => {
    const { auth } = await make();
    expect(await auth.register('a'.repeat(21), 'hunter22')).toMatchObject({ error: expect.any(String) });
  });

  it('accepts usernames/passwords exactly at the boundary lengths (3/20/8)', async () => {
    const { auth } = await make();
    expect(await auth.register('abc', '12345678')).toMatchObject({ accountId: expect.any(String) });
    expect(await auth.register('a'.repeat(20), '12345678')).toMatchObject({ accountId: expect.any(String) });
  });

  it('rejects a username with unicode/emoji (outside the ASCII charset)', async () => {
    const { auth } = await make();
    expect(await auth.register('用户名', 'hunter22')).toMatchObject({ error: expect.any(String) });
    expect(await auth.register('alice🙂', 'hunter22')).toMatchObject({ error: expect.any(String) });
  });

  it('treats usernames as case-insensitively unique — "Alice" collides with "alice"', async () => {
    const { auth } = await make();
    await auth.register('alice', 'hunter22');
    expect(await auth.register('Alice', 'differentpw')).toMatchObject({ error: expect.stringContaining('taken') });
    expect(await auth.register('ALICE', 'differentpw')).toMatchObject({ error: expect.stringContaining('taken') });
  });

  it('login is also case-insensitive on username', async () => {
    const { auth } = await make();
    await auth.register('alice', 'hunter22');
    expect(await auth.login('ALICE', 'hunter22')).toMatchObject({ username: 'alice' });
  });

  it('an injection-style username is rejected by charset validation, never reaching the store', async () => {
    const { auth, store } = await make();
    await auth.register('alice', 'hunter22');
    const result = await auth.register("'; DROP TABLE accounts; --", 'hunter22');
    expect(result).toMatchObject({ error: expect.any(String) });
    // Prove the store really is untouched, not just that this call errored. The SQLite
    // version asked `sqlite_master` whether the table still existed; the equivalent question
    // here is whether the data is still there and nothing extra was written.
    expect(await store.accounts.countDocuments()).toBe(1);
    expect(await store.accounts.findOne({ username: 'alice' })).toBeTruthy();
  });

  it('a QUERY OPERATOR posing as a username matches nothing', async () => {
    // New with the MongoDB port, and it is the injection shape that actually applies here.
    // SQL injection needed a string to escape out of; an operator object needs no escaping
    // at all — `{ username: { $ne: null } }` would match the FIRST account in the
    // collection and hand back somebody else's session. `login`'s `typeof !== 'string'`
    // guard is what refuses it, and this pins that the guard is load-bearing rather than
    // tidiness.
    const { auth } = await make();
    await auth.register('alice', 'hunter22');
    expect(await auth.login({ $ne: null } as unknown as string, 'hunter22')).toMatchObject({
      error: 'invalid username or password',
    });
    expect(await auth.login({ $gt: '' } as unknown as string, 'hunter22')).toMatchObject({
      error: 'invalid username or password',
    });
  });

  it('a SQL-injection-style PASSWORD (no charset restriction) is handled safely as inert data', async () => {
    const { auth } = await make();
    const nasty = "' OR '1'='1' --";
    const reg = await auth.register('bob', nasty) as { accountId: string };
    expect(reg.accountId).toBeTruthy();
    // The literal string is the only password that works — it was never interpreted as SQL.
    expect(await auth.login('bob', nasty)).toMatchObject({ accountId: reg.accountId });
    expect(await auth.login('bob', 'anything else')).toMatchObject({ error: expect.any(String) });
  });

  it('registering the same username concurrently only lets one succeed (node:sqlite is synchronous — no real race, but pins the guarantee)', async () => {
    const { auth } = await make();
    const results = [await auth.register('carol', 'hunter22'), await auth.register('carol', 'hunter22')];
    const successes = results.filter((r) => 'accountId' in r);
    const failures = results.filter((r) => 'error' in r);
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
  });
});

describe('AuthService — the non-string arms of every public entry point', () => {
  // Each of these reads straight off a JSON request body, so `unknown` is not defensive
  // typing — a client can send a number, an object or nothing at all for any of them. The
  // arms below were the file's only uncovered branches (93.65%) while its LINE coverage
  // read 100%, which is the shape the branch bar exists to catch.
  it('login refuses a non-string username or password without touching the DB', async () => {
    const { auth } = await make();
    await auth.register('alice', 'hunter22');
    for (const [u, p] of [
      [42, 'hunter22'],
      ['alice', { toString: () => 'hunter22' }],
      [undefined, undefined],
      [null, 'hunter22'],
    ] as Array<[unknown, unknown]>) {
      expect(await auth.login(u, p)).toEqual({ error: 'invalid username or password' });
    }
    // The control: the same account still logs in, so the guard rejects the shape and not
    // every call.
    expect('token' in await auth.login('alice', 'hunter22')).toBe(true);
  });

  it('verifySession refuses a non-string or empty token', async () => {
    const { auth } = await make();
    for (const token of [undefined, null, 0, '', 7, {}] as unknown[]) {
      expect(await auth.verifySession(token)).toBeNull();
    }
  });

  it('changePassword rejects an invalid NEW password after the old one verified', async () => {
    // The ordering is the point: the old password is checked first, so reaching the
    // new-password validation at all requires a legitimate caller. A missing arm here means
    // a logged-in user can set an unusable password and lock themselves out.
    const { auth } = await make();
    const reg = await auth.register('bob', 'hunter22');
    const accountId = (reg as { accountId: string }).accountId;
    expect(await auth.changePassword(accountId, 'hunter22', 'x')).toMatchObject({
      error: expect.any(String),
    });
    // ...and the old password is still the live one.
    expect('token' in await auth.login('bob', 'hunter22')).toBe(true);
  });

  it('treats a corrupted stored password hash as a failed login, not a crash', async () => {
    // `verifyPassword`'s `!saltHex || !hashHex` arm. Only a damaged row reaches it (a
    // truncated write, a bad migration), and the alternative to returning false is
    // `Buffer.from(undefined, 'hex')` throwing inside the login handler.
    const { auth, store } = await make();
    await auth.register('carol', 'hunter22');
    await store.accounts.updateOne({ username: 'carol' }, { $set: { passwordHash: 'garbage' } });
    expect(await auth.login('carol', 'hunter22')).toEqual({ error: 'invalid username or password' });
  });
});
