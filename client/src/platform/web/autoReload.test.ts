/**
 * Foreground auto-reload watcher (autoReload.ts). Fake-fetch driven, node env — the
 * installAutoReload() half is DOM/import.meta.env glue and is left to the browser; these
 * pin the comparison logic that decides whether a reload actually happens.
 */
import { describe, it, expect, vi } from 'vitest';
import { createVersionWatcher, fetchDeployedHash, deployedVersion } from './autoReload';

function watcherOn(hashes: Array<string | null>, canReload?: () => boolean) {
  const reload = vi.fn();
  const fetchHash = vi.fn(async () => hashes.shift() ?? null);
  return { watcher: createVersionWatcher({ fetchHash, reload, canReload }), reload, fetchHash };
}

describe('createVersionWatcher', () => {
  it('takes the first successful fetch as the baseline without reloading', async () => {
    const { watcher, reload } = watcherOn(['aaa']);
    await watcher.check();
    expect(reload).not.toHaveBeenCalled();
    expect(watcher.baseline()).toBe('aaa');
  });

  it('does not reload while the deployed hash is unchanged', async () => {
    const { watcher, reload } = watcherOn(['aaa', 'aaa', 'aaa']);
    await watcher.check();
    await watcher.check();
    await watcher.check();
    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads once the deployed hash differs from the baseline', async () => {
    const { watcher, reload } = watcherOn(['aaa', 'bbb']);
    await watcher.check();
    await watcher.check();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('ignores a null hash (dev server / 404) and keeps the baseline unset', async () => {
    const { watcher, reload } = watcherOn([null, null]);
    await watcher.check();
    await watcher.check();
    expect(reload).not.toHaveBeenCalled();
    expect(watcher.baseline()).toBeNull();
  });

  it('does not treat the first hash after failed checks as an update', async () => {
    const { watcher, reload } = watcherOn([null, 'aaa']);
    await watcher.check();
    await watcher.check();
    expect(reload).not.toHaveBeenCalled();
    expect(watcher.baseline()).toBe('aaa');
  });

  it('swallows a rejected fetch rather than propagating it', async () => {
    const reload = vi.fn();
    const watcher = createVersionWatcher({
      fetchHash: async () => { throw new Error('offline'); },
      reload,
    });
    await expect(watcher.check()).resolves.toBeUndefined();
    expect(reload).not.toHaveBeenCalled();
  });

  it('defers the reload while canReload vetoes it, then applies it on a later check', async () => {
    let allowed = false;
    const { watcher, reload } = watcherOn(['aaa', 'bbb', 'bbb'], () => allowed);
    await watcher.check(); // baseline
    await watcher.check(); // update seen, vetoed
    expect(reload).not.toHaveBeenCalled();
    allowed = true;
    await watcher.check();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('keeps the old baseline while vetoed, so the update is not silently forgotten', async () => {
    const { watcher } = watcherOn(['aaa', 'bbb'], () => false);
    await watcher.check();
    await watcher.check();
    expect(watcher.baseline()).toBe('aaa');
  });
});

describe('fetchDeployedHash', () => {
  it('requests /version.json cache-busted and no-store, and returns the hash', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ hash: 'abc', builtAt: 'x' }) }) as Response);
    expect(await fetchDeployedHash(fetchImpl)).toBe('abc');
    const [url, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toMatch(/^\/version\.json\?_=\d+$/);
    expect(init.cache).toBe('no-store');
  });

  it('returns null on a non-ok response (SPA fallback served index.html, or 404)', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }) as Response);
    expect(await fetchDeployedHash(fetchImpl)).toBeNull();
  });

  it('returns null when the payload has no hash field', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({}) }) as Response);
    expect(await fetchDeployedHash(fetchImpl)).toBeNull();
  });
});

describe('deployedVersion — the build stamp on every client log batch', () => {
  it('is null before an install, rather than throwing', () => {
    // `net/clientLog.ts` reads this per flush, and the first flush can in principle beat
    // `installAutoReload` (which runs at the end of boot). A throw there would be an error
    // inside the error reporter.
    expect(deployedVersion()).toBeNull();
  });

  it('reports the baseline the reload watcher already fetched, once it has one', async () => {
    // The whole point of the field: a dashboard asking "is this error only on the new
    // build?" needs a real answer, and before this was wired every real client reported
    // `unknown` — a panel that looked populated and said nothing.
    const watcher = createVersionWatcher({ fetchHash: async () => 'abc123', reload: () => {} });
    expect(watcher.baseline()).toBeNull();
    await watcher.check();
    expect(watcher.baseline()).toBe('abc123');
  });
});
