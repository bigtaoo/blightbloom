/**
 * `adoptBridgeStorage` — the synchronous stores over Bridge's asynchronous storage.
 *
 * What would fail silently: a synced key read from `localStorage` (progress that never reaches
 * the platform), a migration that overwrites what Bridge already holds (a returning player's
 * cloud save replaced by a stale local one), a removed key reading back as `''` instead of
 * absent, and writes that are not coalesced (one platform call per store write).
 */
import { describe, expect, it } from 'vitest';
import { adoptBridgeStorage } from './bridgeStorage';
import type { KeyValueStorage } from '../webStorage';
import { IDENTITY_STORAGE_KEY } from '../../net/identity';
import { META_STORAGE_KEY } from '../../meta/store';
import { SETTINGS_STORAGE_KEY } from '../../settings/store';

function memory(seed: Record<string, string> = {}): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(seed));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

function harness(opts: { held?: Record<string, string>; local?: KeyValueStorage | null; storage?: boolean } = {}) {
  const saves: Map<string, string>[] = [];
  const loads: string[][] = [];
  const queue: (() => void)[] = [];
  let installed: KeyValueStorage | null = null;
  const bridge = {
    hasStorage: () => opts.storage ?? true,
    load: async (keys: readonly string[]) => {
      loads.push([...keys]);
      return new Map(Object.entries(opts.held ?? {}).filter(([k]) => keys.includes(k)));
    },
    save: (m: ReadonlyMap<string, string>) => void saves.push(new Map(m)),
  };
  const run = () => adoptBridgeStorage({
    bridge,
    local: opts.local === undefined ? memory() : opts.local,
    install: (s) => (installed = s),
    later: (fn) => void queue.push(fn),
  });
  const tick = () => {
    for (const fn of queue.splice(0)) fn();
  };
  return { run, saves, loads, tick, store: () => installed! };
}

describe('adoptBridgeStorage', () => {
  it('leaves localStorage in charge where Bridge has no storage', async () => {
    const h = harness({ storage: false });
    const handle = await h.run();
    expect(handle.outcome).toBe('unavailable');
    expect(h.loads).toEqual([]);
    expect(() => handle.flush()).not.toThrow();
  });

  it('reads every synced key in ONE call and serves them synchronously', async () => {
    const h = harness({ held: { [META_STORAGE_KEY]: '{"m":1}' } });
    const handle = await h.run();
    expect(handle.outcome).toBe('adopted');
    expect(h.loads).toHaveLength(1);
    expect(new Set(h.loads[0])).toEqual(new Set([IDENTITY_STORAGE_KEY, META_STORAGE_KEY, SETTINGS_STORAGE_KEY]));
    expect(h.store().getItem(META_STORAGE_KEY)).toBe('{"m":1}');
    expect(h.store().getItem(SETTINGS_STORAGE_KEY)).toBeNull();
  });

  it('reads a key stored as the empty string (a removal) as absent', async () => {
    const h = harness({ held: { [META_STORAGE_KEY]: '' } });
    await h.run();
    expect(h.store().getItem(META_STORAGE_KEY)).toBeNull();
  });

  it('coalesces a tick of writes into one save, and a remove is written as the empty string', async () => {
    const h = harness();
    await h.run();
    const s = h.store();
    s.setItem(META_STORAGE_KEY, 'a');
    s.setItem(META_STORAGE_KEY, 'b');
    s.setItem(SETTINGS_STORAGE_KEY, 'c');
    s.removeItem(SETTINGS_STORAGE_KEY);
    expect(s.getItem(META_STORAGE_KEY)).toBe('b');
    expect(s.getItem(SETTINGS_STORAGE_KEY)).toBeNull();
    expect(h.saves).toEqual([]);
    h.tick();
    expect(h.saves).toEqual([new Map([[META_STORAGE_KEY, 'b'], [SETTINGS_STORAGE_KEY, '']])]);
    h.tick();
    expect(h.saves).toHaveLength(1);
  });

  it('flush sends pending writes now, and an empty flush sends nothing', async () => {
    const h = harness();
    const handle = await h.run();
    handle.flush();
    expect(h.saves).toEqual([]);
    h.store().setItem(META_STORAGE_KEY, 'x');
    handle.flush();
    expect(h.saves).toEqual([new Map([[META_STORAGE_KEY, 'x']])]);
    h.tick(); // the queued flush finds nothing left
    expect(h.saves).toHaveLength(1);
  });

  it('migrates localStorage only where Bridge holds nothing', async () => {
    const local = memory({ [META_STORAGE_KEY]: 'local-meta', [IDENTITY_STORAGE_KEY]: 'local-id' });
    const h = harness({ held: { [META_STORAGE_KEY]: 'cloud-meta' }, local });
    await h.run();
    expect(h.store().getItem(META_STORAGE_KEY)).toBe('cloud-meta');
    expect(h.store().getItem(IDENTITY_STORAGE_KEY)).toBe('local-id');
    h.tick();
    expect(h.saves).toEqual([new Map([[IDENTITY_STORAGE_KEY, 'local-id']])]);
  });

  it('survives a localStorage that throws on read during migration', async () => {
    const local: KeyValueStorage = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => undefined,
      removeItem: () => undefined,
    };
    const h = harness({ local });
    const handle = await h.run();
    expect(handle.outcome).toBe('adopted');
  });

  it('routes every other key to localStorage', async () => {
    const local = memory();
    const h = harness({ local });
    await h.run();
    const s = h.store();
    s.setItem('daydayup.runSave.v1', 'big');
    expect(local.data.get('daydayup.runSave.v1')).toBe('big');
    expect(s.getItem('daydayup.runSave.v1')).toBe('big');
    s.removeItem('daydayup.runSave.v1');
    expect(local.data.has('daydayup.runSave.v1')).toBe(false);
    h.tick();
    expect(h.saves).toEqual([]);
  });

  it('without localStorage: other keys read null, writes throw, removes are no-ops', async () => {
    const h = harness({ local: null });
    await h.run();
    const s = h.store();
    expect(s.getItem('other')).toBeNull();
    expect(() => s.setItem('other', 'v')).toThrow('storage unavailable');
    expect(() => s.removeItem('other')).not.toThrow();
    s.setItem(META_STORAGE_KEY, 'still synced');
    expect(s.getItem(META_STORAGE_KEY)).toBe('still synced');
  });

  it('defaults to the real localStorage, setTimeout and override', async () => {
    const { setStorageOverride, webStorage } = await import('../webStorage');
    const saves: Map<string, string>[] = [];
    try {
      const handle = await adoptBridgeStorage({
        bridge: { hasStorage: () => true, load: async () => new Map(), save: (m) => void saves.push(new Map(m)) },
      });
      expect(handle.outcome).toBe('adopted');
      webStorage()!.setItem(META_STORAGE_KEY, 'm');
      await new Promise((r) => setTimeout(r, 0));
      expect(saves).toEqual([new Map([[META_STORAGE_KEY, 'm']])]);
    } finally {
      setStorageOverride(null);
    }
  });
});
