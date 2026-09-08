/**
 * `sdkUser.ts` — the four reads that make up the portal's user module.
 *
 * Every case drives a plain object in place of the SDK's own (the `CgGlobal`/`StoreHost`
 * convention this directory already uses), and the shapes that matter are the WRONG ones:
 * these are methods on a remote script, and the failure this file is built around is not
 * "the answer was false" but "the method threw, or was not there, or answered something that
 * is not the documented type". All four of those have to arrive as a guest.
 */
import { describe, it, expect, vi } from 'vitest';
import type { CgSdkShape } from './sdk';
import { readUser, readUserReporting, readUserToken, subscribeAuth, userAvailable } from './sdkUser';

type UserApi = CgSdkShape['user'];

const ADA = { userId: 'u-1', username: 'Ada', profilePictureUrl: 'https://x/1.png' };

describe('userAvailable', () => {
  it('is true only for a literal true', async () => {
    expect(await userAvailable({ isUserAccountAvailable: async () => true })).toBe(true);
  });

  it('is false for every other answer, including truthy ones', async () => {
    // `isUserAccountAvailable` reads like a property and is a method; a caller that got that
    // wrong would hold a Function here, which is truthy. Strict equality is what makes that
    // mistake fail loudly rather than enable the whole account path on a page with none.
    const answers: unknown[] = [false, undefined, null, 0, '', 'true', 1, {}, () => true];
    for (const answer of answers) {
      expect(await userAvailable({ isUserAccountAvailable: async () => answer })).toBe(false);
    }
  });

  it('is false when the method is missing, or the module is', async () => {
    expect(await userAvailable({})).toBe(false);
    expect(await userAvailable(undefined)).toBe(false);
  });

  it('is false when the promise rejects', async () => {
    expect(
      await userAvailable({
        isUserAccountAvailable: async () => {
          throw new Error('accounts not enabled on this domain');
        },
      }),
    ).toBe(false);
  });

  it('is false when the method throws synchronously', async () => {
    expect(
      await userAvailable({
        isUserAccountAvailable: () => {
          throw new Error('boom');
        },
      }),
    ).toBe(false);
  });
});

describe('readUserReporting', () => {
  // `getUser` is the call the whole silent login rests on, and the platform's own SDK logs
  // that it is still in BETA on every invocation. So "the call did not work" needs to be
  // distinguishable from "this player is a guest" — the same null, two different bugs.

  it('reports a user with no failure', async () => {
    expect(await readUserReporting({ getUser: async () => ADA })).toEqual({ user: ADA, failed: false, reason: null });
  });

  it('reports a guest as a SUCCESS, because that is the documented answer', async () => {
    for (const answer of [null, undefined]) {
      expect(await readUserReporting({ getUser: async () => answer })).toEqual({
        user: null, failed: false, reason: null,
      });
    }
  });

  it('reports a rejection as a failure, with the reason', async () => {
    const got = await readUserReporting({
      getUser: async () => {
        throw new Error('still in BETA');
      },
    });
    expect(got.user).toBeNull();
    expect(got.failed).toBe(true);
    expect(got.reason).toBe('still in BETA');
  });

  it('reports a missing method as a failure-free guest', async () => {
    // An SDK with no `user` module at all is `auth unavailable` upstream, not a broken read;
    // the optional-chain answers undefined and that is a legitimate nothing.
    expect(await readUserReporting({})).toEqual({ user: null, failed: false, reason: null });
    expect(await readUserReporting(undefined)).toEqual({ user: null, failed: false, reason: null });
  });

  it('reports an UNREADABLE answer as a failure, not as a guest', async () => {
    // The renamed-field case: the platform has already removed one field from this object,
    // so an answer that cannot be narrowed is live. Calling it "guest" would hide exactly
    // the breakage worth knowing about.
    for (const answer of ['a bare string', 42, true, []]) {
      const got = await readUserReporting({ getUser: async () => answer });
      expect(got.user, String(answer)).toBeNull();
      expect(got.failed, String(answer)).toBe(true);
      expect(got.reason, String(answer)).toContain('unreadable');
    }
  });

  it('is what readUser is built on, so the two can never disagree', async () => {
    const apis = [
      { getUser: async () => ADA },
      { getUser: async () => null },
      { getUser: async () => { throw new Error('x'); } },
      { getUser: async () => 'junk' },
    ];
    for (const api of apis) {
      expect(await readUser(api)).toEqual((await readUserReporting(api)).user);
    }
  });
});

describe('readUser', () => {
  it('narrows the SDK object into a CgUser', async () => {
    expect(await readUser({ getUser: async () => ADA })).toEqual(ADA);
  });

  it('drops a non-string profile picture rather than carrying it through', async () => {
    const got = await readUser({ getUser: async () => ({ userId: 'u-1', username: 'Ada', profilePictureUrl: 42 }) });
    expect(got).toEqual({ userId: 'u-1', username: 'Ada', profilePictureUrl: undefined });
  });

  it('falls back to the id when the username is missing or empty', async () => {
    // An id is at least a true statement about who this is; a placeholder would be shown to
    // other players (the platform requires the name be displayed).
    for (const username of [undefined, '', 42, null]) {
      expect((await readUser({ getUser: async () => ({ userId: 'u-1', username }) }))?.username).toBe('u-1');
    }
  });

  it('is null for a guest — the documented answer, not an error', async () => {
    expect(await readUser({ getUser: async () => null })).toBeNull();
  });

  it('is null for every malformed answer', async () => {
    const answers: unknown[] = [undefined, 'Ada', 42, {}, { username: 'Ada' }, { userId: '' }, { userId: 7 }, []];
    for (const answer of answers) {
      expect(await readUser({ getUser: async () => answer })).toBeNull();
    }
  });

  it('is null when the method is missing or rejects', async () => {
    expect(await readUser({})).toBeNull();
    expect(await readUser(undefined)).toBeNull();
    expect(
      await readUser({
        getUser: async () => {
          throw new Error('module disabled');
        },
      }),
    ).toBeNull();
  });
});

describe('readUserToken', () => {
  it('returns a non-empty string token', async () => {
    expect(await readUserToken({ getUserToken: async () => 'header.payload.sig' })).toBe('header.payload.sig');
  });

  it('is null for an empty, non-string, missing or rejected token', async () => {
    expect(await readUserToken({ getUserToken: async () => '' })).toBeNull();
    expect(await readUserToken({ getUserToken: async () => 42 })).toBeNull();
    expect(await readUserToken({})).toBeNull();
    expect(
      await readUserToken({
        getUserToken: async () => {
          // What the real module does for a guest: it rejects rather than resolving falsy.
          throw new Error('userNotAuthenticated');
        },
      }),
    ).toBeNull();
  });
});

describe('subscribeAuth', () => {
  /** A user module that records its listeners, so both halves of subscribe/unsubscribe are
   *  observable rather than assumed. */
  function listenerHost() {
    const listeners: ((u: unknown) => void)[] = [];
    const api: UserApi = {
      addAuthListener: (l) => void listeners.push(l),
      removeAuthListener: (l) => void listeners.splice(listeners.indexOf(l), 1),
    };
    return { api, listeners, fire: (u: unknown) => listeners.forEach((l) => l(u)) };
  }

  it('forwards a narrowed user to the listener', () => {
    const host = listenerHost();
    const seen = vi.fn();
    subscribeAuth(host.api, seen);
    host.fire(ADA);
    expect(seen).toHaveBeenCalledWith(ADA);
  });

  it('forwards null for a logout, and for a malformed payload', () => {
    // The same narrowing `readUser` applies. One function, so the two paths cannot disagree
    // about what a valid user is.
    const host = listenerHost();
    const seen = vi.fn();
    subscribeAuth(host.api, seen);
    host.fire(null);
    host.fire({ username: 'no id here' });
    expect(seen).toHaveBeenCalledTimes(2);
    expect(seen).toHaveBeenNthCalledWith(1, null);
    expect(seen).toHaveBeenNthCalledWith(2, null);
  });

  it('removes the listener it added when unsubscribed', () => {
    const host = listenerHost();
    const seen = vi.fn();
    const off = subscribeAuth(host.api, seen);
    expect(host.listeners).toHaveLength(1);
    off();
    expect(host.listeners).toHaveLength(0);
    expect(seen).not.toHaveBeenCalled();
  });

  it('swallows a throw from the listener — it runs inside the SDK dispatch', () => {
    const host = listenerHost();
    subscribeAuth(host.api, () => {
      throw new Error('our own handler blew up');
    });
    expect(() => host.fire(ADA)).not.toThrow();
  });

  it('hands back a working no-op unsubscribe when there is nothing to subscribe to', () => {
    // A caller must never have to check whether it managed to subscribe.
    for (const api of [undefined, {}, { addAuthListener: 'not a function' } as unknown as UserApi]) {
      const off = subscribeAuth(api, vi.fn());
      expect(() => off()).not.toThrow();
    }
  });

  it('hands back a no-op unsubscribe when addAuthListener THROWS', () => {
    const off = subscribeAuth(
      {
        addAuthListener: () => {
          throw new Error('nope');
        },
      },
      vi.fn(),
    );
    expect(() => off()).not.toThrow();
  });

  it('does not throw when removeAuthListener is missing', () => {
    const off = subscribeAuth({ addAuthListener: () => {} }, vi.fn());
    expect(() => off()).not.toThrow();
  });
});
