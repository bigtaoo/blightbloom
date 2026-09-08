/**
 * The portal verification-key cache (`src/portalKeys.ts`, design/20). Its whole contract is
 * a pair of opposite failure postures — a failed FETCH keeps serving the stale key, a failed
 * VERIFICATION never refetches — so the cases here are mostly about counting requests, and
 * the injected `fetchImpl` is what makes that countable.
 */
import { describe, it, expect } from 'vitest';
import { createPortalKeyStore, CRAZYGAMES_PUBLIC_KEY_URL } from '../src/portalKeys';

const PEM = '-----BEGIN RSA PUBLIC KEY-----\nAAAA\n-----END RSA PUBLIC KEY-----\n';

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    json: async () => body,
  } as unknown as Response;
}

/** A fetch that counts its calls and answers from a queue; the last entry repeats. */
function stubFetch(answers: (() => Promise<Response>)[]) {
  const urls: string[] = [];
  const impl = (async (url: unknown) => {
    urls.push(String(url));
    const next = answers[Math.min(urls.length - 1, answers.length - 1)];
    if (!next) throw new Error('no answer configured');
    return next();
  }) as unknown as typeof fetch;
  return { impl, urls };
}

describe('createPortalKeyStore', () => {
  it('fetches the published document and returns its publicKey', async () => {
    const { impl, urls } = stubFetch([async () => jsonResponse({ publicKey: PEM })]);
    const store = createPortalKeyStore({ fetchImpl: impl });
    expect(await store.key()).toBe(PEM);
    expect(urls).toEqual([CRAZYGAMES_PUBLIC_KEY_URL]);
  });

  it('serves the cached key without refetching until the TTL elapses', async () => {
    let now = 1000;
    const { impl, urls } = stubFetch([async () => jsonResponse({ publicKey: PEM })]);
    const store = createPortalKeyStore({ fetchImpl: impl, nowMs: () => now, ttlMs: 60_000 });

    expect(await store.key()).toBe(PEM);
    now += 59_000;
    expect(await store.key()).toBe(PEM);
    expect(urls).toHaveLength(1);

    now += 2_000; // past the TTL
    expect(await store.key()).toBe(PEM);
    expect(urls).toHaveLength(2);
  });

  it('collapses a burst of cold-cache calls into ONE request', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { impl, urls } = stubFetch([
      async () => {
        await gate;
        return jsonResponse({ publicKey: PEM });
      },
    ]);
    const store = createPortalKeyStore({ fetchImpl: impl });

    const all = Promise.all([store.key(), store.key(), store.key()]);
    release();
    expect(await all).toEqual([PEM, PEM, PEM]);
    expect(urls).toHaveLength(1);
  });

  it('keeps serving the STALE key when a refetch fails', async () => {
    let now = 1000;
    const { impl } = stubFetch([
      async () => jsonResponse({ publicKey: PEM }),
      async () => {
        throw new Error('CDN down');
      },
    ]);
    const store = createPortalKeyStore({ fetchImpl: impl, nowMs: () => now, ttlMs: 10 });

    expect(await store.key()).toBe(PEM);
    now += 1000;
    // The refetch threw; the key we already have is still the right key. This is the
    // difference between "stale" and "wrong", and locking every portal player out for the
    // length of someone else's outage is the outcome this arm exists to prevent.
    expect(await store.key()).toBe(PEM);
  });

  it('returns null when it has NEVER fetched successfully', async () => {
    const { impl } = stubFetch([
      async () => {
        throw new Error('offline');
      },
    ]);
    expect(await createPortalKeyStore({ fetchImpl: impl }).key()).toBeNull();
  });

  it('treats a non-OK response, a missing field and a non-PEM string as no key', async () => {
    const bodies: [string, () => Promise<Response>][] = [
      ['404', async () => jsonResponse({ publicKey: PEM }, false)],
      ['no publicKey field', async () => jsonResponse({ key: PEM })],
      ['non-string', async () => jsonResponse({ publicKey: 42 })],
      // The PEM sniff matters: a portal error page served as JSON would otherwise be
      // cached as a "key" and then fail every verification with no clue why.
      ['a string that is not a key', async () => jsonResponse({ publicKey: 'service unavailable' })],
      ['invalid json', async () => ({ ok: true, json: async () => { throw new Error('bad json'); } }) as unknown as Response],
    ];
    for (const [name, answer] of bodies) {
      const { impl } = stubFetch([answer]);
      expect(await createPortalKeyStore({ fetchImpl: impl }).key(), name).toBeNull();
    }
  });

  it('retries on the NEXT call after a failure — a failed fetch must not poison the cache', async () => {
    const { impl, urls } = stubFetch([
      async () => {
        throw new Error('transient');
      },
      async () => jsonResponse({ publicKey: PEM }),
    ]);
    const store = createPortalKeyStore({ fetchImpl: impl });
    expect(await store.key()).toBeNull();
    expect(await store.key()).toBe(PEM);
    expect(urls).toHaveLength(2);
  });
});
