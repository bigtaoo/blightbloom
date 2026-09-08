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
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db';
import { AuthService } from '../src/AuthService';

function make() {
  let idN = 0;
  let tokenN = 0;
  const db: DatabaseSync = openDb(':memory:');
  const auth = new AuthService(db, {
    nowMs: () => 1_000,
    newAccountId: () => `acct-${++idN}`,
    newToken: () => `token-${++tokenN}`,
  });
  return { auth, db };
}

const cg = (providerId: string, displayName: string) => ({ provider: 'cg', providerId, displayName });

describe('loginWithProvider — find or create', () => {
  it('registers on first sight and returns the PROVIDER display name, not the handle', () => {
    const { auth } = make();
    expect(auth.loginWithProvider(cg('u1', 'PortalPlayer'))).toMatchObject({
      accountId: 'acct-1',
      username: 'PortalPlayer',
      token: 'token-1',
    });
  });

  it('logs the SAME account in on a second sight — one row, two sessions', () => {
    const { auth, db } = make();
    const first = auth.loginWithProvider(cg('u1', 'PortalPlayer'));
    const second = auth.loginWithProvider(cg('u1', 'PortalPlayer'));
    expect(second.accountId).toBe(first.accountId);
    expect(second.token).not.toBe(first.token);
    expect(db.prepare('SELECT COUNT(*) AS n FROM accounts').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 2 });
  });

  it('stores the handle as {provider}:{providerId} and the name in display_name', () => {
    const { auth, db } = make();
    auth.loginWithProvider(cg('u1', 'PortalPlayer'));
    expect(db.prepare('SELECT username, display_name, provider, provider_id FROM accounts').get()).toEqual({
      username: 'cg:u1',
      display_name: 'PortalPlayer',
      provider: 'cg',
      provider_id: 'u1',
    });
  });

  it('adopts a RENAME on the provider side — the provider owns the name, every login', () => {
    const { auth, db } = make();
    const first = auth.loginWithProvider(cg('u1', 'OldName'));
    const renamed = auth.loginWithProvider(cg('u1', 'NewName'));
    expect(renamed.accountId).toBe(first.accountId);
    expect(renamed.username).toBe('NewName');
    expect(db.prepare('SELECT display_name FROM accounts WHERE id = ?').get(first.accountId)).toEqual({
      display_name: 'NewName',
    });
  });

  it('keeps two providers with the same providerId apart', () => {
    const { auth } = make();
    const a = auth.loginWithProvider({ provider: 'cg', providerId: 'u1', displayName: 'A' });
    const b = auth.loginWithProvider({ provider: 'wx', providerId: 'u1', displayName: 'B' });
    expect(b.accountId).not.toBe(a.accountId);
  });
});

describe('loginWithProvider — the two namespaces cannot collide', () => {
  it('lets a portal player and a local account share a display name', () => {
    // The project owner's 2026-09-08 decision — the same human on two platforms is two
    // accounts — only works if the namespaces cannot collide. `alice` the local account and
    // `alice` the portal player must both exist, and neither may reach the other's row.
    const { auth } = make();
    expect(auth.register('alice', 'hunter22')).toMatchObject({ username: 'alice' });
    expect(auth.loginWithProvider(cg('u1', 'alice'))).toMatchObject({ username: 'alice', accountId: 'acct-2' });
  });

  it('cannot have its handle registered locally — the `:` is unreachable by validateUsername', () => {
    const { auth } = make();
    auth.loginWithProvider(cg('u1', 'PortalPlayer'));
    expect(auth.register('cg:u1', 'hunter22')).toMatchObject({ error: expect.stringContaining('may only contain') });
  });

  it('accepts a provider name our OWN rules would reject', () => {
    // Every one of these fails `validateUsername`, and each is a name a real CrazyGames
    // account can have. Applying our rules here would be an unfixable dead end for that
    // player rather than a moderation win — see loginWithProvider's own note.
    const { auth } = make();
    const names = ['x', 'has spaces', 'dash-name', 'ünïcodé', '玩家', 'admin', 'a'.repeat(60)];
    names.forEach((name, i) => {
      expect(auth.loginWithProvider(cg(`u${i}`, name)).username).toBe(name.slice(0, 40));
    });
  });

  it('truncates a pathologically long name to 40 characters', () => {
    const { auth, db } = make();
    auth.loginWithProvider(cg('u1', 'z'.repeat(500)));
    const row = db.prepare('SELECT display_name FROM accounts').get() as { display_name: string };
    expect(row.display_name).toHaveLength(40);
  });
});

describe('loginWithProvider — no password opens the row', () => {
  it('stores the sentinel, and every password attempt against the handle fails', () => {
    const { auth, db } = make();
    auth.loginWithProvider(cg('u1', 'PortalPlayer'));
    const row = db.prepare('SELECT password_hash FROM accounts').get() as { password_hash: string };
    expect(row.password_hash).toBe('!');
    for (const attempt of ['!', '', 'PortalPlayer', 'password']) {
      expect(auth.login('cg:u1', attempt)).toEqual({ error: 'invalid username or password' });
    }
  });

  it('refuses password login even if a REAL hash is planted on the federated row', () => {
    // The second of the two independent guards: `login`'s `provider !== 'local'` check.
    // Planting a working hash defeats the sentinel, and the row must still be unreachable —
    // otherwise a bad migration anywhere near that column is account takeover.
    const { auth, db } = make();
    auth.loginWithProvider(cg('u1', 'PortalPlayer'));
    auth.register('donor', 'hunter22');
    const donor = db.prepare('SELECT password_hash FROM accounts WHERE username = ?').get('donor') as {
      password_hash: string;
    };
    db.prepare('UPDATE accounts SET password_hash = ? WHERE username = ?').run(donor.password_hash, 'cg:u1');
    // Proof the planted hash really is a working one, so the refusal above is the guard
    // and not a broken fixture.
    expect(auth.login('donor', 'hunter22')).toMatchObject({ username: 'donor' });
    expect(auth.login('cg:u1', 'hunter22')).toEqual({ error: 'invalid username or password' });
  });

  it('refuses to change the password of a federated account, with a reason', () => {
    const { auth } = make();
    const s = auth.loginWithProvider(cg('u1', 'PortalPlayer'));
    expect(auth.changePassword(s.accountId, 'anything', 'newpassword')).toMatchObject({
      error: expect.stringContaining('no password'),
    });
  });
});

describe('loginWithProvider — sessions and the display_name fallback', () => {
  it('resolves its session to the display name through verifySession', () => {
    const { auth } = make();
    const s = auth.loginWithProvider(cg('u1', 'PortalPlayer'));
    expect(auth.verifySession(s.token)).toEqual({ accountId: s.accountId, username: 'PortalPlayer' });
  });

  it('keeps a LOCAL account resolving to its username now that display_name exists', () => {
    // The COALESCE fallback. display_name is NULL for every account registered before
    // 2026-09-08, and this is the case that breaks if the fallback is ever dropped.
    const { auth, db } = make();
    const s = auth.register('bob', 'hunter22') as { accountId: string; token: string };
    expect(db.prepare('SELECT display_name FROM accounts WHERE id = ?').get(s.accountId)).toEqual({
      display_name: null,
    });
    expect(auth.verifySession(s.token)).toEqual({ accountId: s.accountId, username: 'bob' });
    expect(auth.login('bob', 'hunter22')).toMatchObject({ username: 'bob' });
  });
});

describe('loginWithProvider — concurrency', () => {
  it('creates ONE account when two first logins race', () => {
    // The `catch` arm: the losing INSERT re-reads the winner's row. Staged by landing the
    // winner between this caller's own lookup and its insert.
    const { auth, db } = make();
    let injected = false;
    const realPrepare = db.prepare.bind(db);
    (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      if (!injected && sql.includes('INSERT INTO accounts')) {
        injected = true;
        realPrepare(
          `INSERT INTO accounts (id, username, password_hash, provider, provider_id, created_at, display_name)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run('winner', 'cg:u1', '!', 'cg', 'u1', 1, 'TheWinner');
      }
      return realPrepare(sql);
    };
    const got = auth.loginWithProvider(cg('u1', 'TheLoser'));
    expect(got.accountId).toBe('winner');
    expect(got.username).toBe('TheWinner');
    expect(db.prepare('SELECT COUNT(*) AS n FROM accounts').get()).toEqual({ n: 1 });
  });

  it('throws rather than inventing a session if the insert fails for a NON-race reason', () => {
    const { auth, db } = make();
    const realPrepare = db.prepare.bind(db);
    (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      if (sql.includes('INSERT INTO accounts')) throw new Error('disk I/O error');
      return realPrepare(sql);
    };
    expect(() => auth.loginWithProvider(cg('u1', 'PortalPlayer'))).toThrow(/insert failed/);
  });
});
