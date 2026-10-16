/**
 * `portalStorage.ts` — `SDK.data` behind `webStorage()`. What has to hold: nothing is adopted
 * unless the module answers, a migration never overwrites what the portal already has, and
 * only `SYNCED_KEYS` leave `localStorage` (the run save in particular must not — see the
 * module header for the debounce that would lose it).
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { adoptPortalStorage, SYNCED_KEYS } from './portalStorage';
import { setStorageOverride, webStorage, type KeyValueStorage } from '../webStorage';

function mapStorage(init: Record<string, string> = {}): KeyValueStorage & { map: Map<string, string> } {
  const map = new Map(Object.entries(init));
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

function sdkWith(data: unknown) {
  return { init: vi.fn(() => Promise.resolve('crazygames' as const)), dataModule: () => data as never };
}

async function adopt(data: unknown, local: KeyValueStorage | null = mapStorage()) {
  const box: { installed: KeyValueStorage | null } = { installed: null };
  const sdk = sdkWith(data);
  const outcome = await adoptPortalStorage({
    sdk,
    scriptLoaded: true,
    local,
    install: (s) => {
      box.installed = s;
    },
  });
  return { outcome, installed: box.installed, sdk };
}

afterEach(() => setStorageOverride(null));

describe('adoptPortalStorage', () => {
  it('does not wait for a script that was blocked', async () => {
    const sdk = sdkWith(mapStorage());
    expect(await adoptPortalStorage({ sdk, scriptLoaded: false, local: null, install: vi.fn() })).toBe('no-script');
    expect(sdk.init).not.toHaveBeenCalled();
  });

  it('is unavailable without a module, with a partial one, or with one that throws', async () => {
    expect((await adopt(null)).outcome).toBe('unavailable');
    expect((await adopt({ getItem: () => null })).outcome).toBe('unavailable');
    const disabled = {
      getItem: () => {
        throw new Error('dataModuleDisabled');
      },
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };
    const r = await adopt(disabled);
    expect(r.outcome).toBe('unavailable');
    expect(r.installed).toBeNull();
  });

  it('routes synced keys to the module and everything else to localStorage', async () => {
    const remote = mapStorage();
    const local = mapStorage();
    const { outcome, installed } = await adopt(remote, local);
    expect(outcome).toBe('adopted');
    installed!.setItem('daydayup.meta.v1', 'M');
    installed!.setItem('daydayup.runsave.v1', 'R');
    installed!.setItem('daydayup.session.v1', 'S');
    expect(remote.map.get('daydayup.meta.v1')).toBe('M');
    expect(local.map.has('daydayup.meta.v1')).toBe(false);
    expect([...remote.map.keys()]).toEqual(['daydayup.meta.v1']);
    expect(local.map.get('daydayup.runsave.v1')).toBe('R');
    expect(installed!.getItem('daydayup.runsave.v1')).toBe('R');
    expect(installed!.getItem('daydayup.meta.v1')).toBe('M');
    installed!.removeItem('daydayup.meta.v1');
    installed!.removeItem('daydayup.runsave.v1');
    expect([...local.map.keys()]).toEqual(['daydayup.session.v1']);
    expect(remote.map.size).toBe(0);
  });

  it('migrates a key the module lacks and never overwrites one it has', async () => {
    const remote = mapStorage({ 'daydayup.meta.v1': 'portal-copy' });
    const local = mapStorage({
      'daydayup.meta.v1': 'device-copy',
      'daydayup.playerId.v1': 'guest-1',
      'daydayup.runsave.v1': 'big',
    });
    await adopt(remote, local);
    expect(remote.map.get('daydayup.meta.v1')).toBe('portal-copy');
    expect(remote.map.get('daydayup.playerId.v1')).toBe('guest-1');
    expect(remote.map.has('daydayup.runsave.v1')).toBe(false);
    expect(remote.map.has('daydayup.settings.v1')).toBe(false); // absent locally: nothing copied
    expect(local.map.get('daydayup.meta.v1')).toBe('device-copy'); // left as the rollback
  });

  it('a key that fails to migrate does not stop the rest', async () => {
    const remote = mapStorage();
    const local = mapStorage({ 'daydayup.playerId.v1': 'p', 'daydayup.settings.v1': 's' });
    const realSet = remote.setItem;
    remote.setItem = (k, v) => {
      if (k === 'daydayup.playerId.v1') throw new Error('dataLimitExcedeed');
      realSet(k, v);
    };
    expect((await adopt(remote, local)).outcome).toBe('adopted');
    expect(remote.map.get('daydayup.settings.v1')).toBe('s');
    expect(remote.map.has('daydayup.playerId.v1')).toBe(false);
  });

  it('coerces a non-string from the module to null', async () => {
    const { installed } = await adopt({ getItem: () => undefined, setItem: vi.fn(), removeItem: vi.fn() });
    expect(installed!.getItem('daydayup.meta.v1')).toBeNull();
  });

  it('with no localStorage, unsynced keys read null and a write throws like a full store', async () => {
    const { installed } = await adopt(mapStorage(), null);
    expect(installed!.getItem('daydayup.runsave.v1')).toBeNull();
    expect(() => installed!.setItem('daydayup.runsave.v1', 'x')).toThrow();
    expect(() => installed!.removeItem('daydayup.runsave.v1')).not.toThrow();
    installed!.setItem('daydayup.meta.v1', 'ok');
    expect(installed!.getItem('daydayup.meta.v1')).toBe('ok');
  });

  it('installs into webStorage() and migrates from the real localStorage by default', async () => {
    const remote = mapStorage();
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get: () => mapStorage({ 'daydayup.playerId.v1': 'from-browser' }),
    });
    try {
      await adoptPortalStorage({ sdk: sdkWith(remote), scriptLoaded: true });
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
    expect(remote.map.get('daydayup.playerId.v1')).toBe('from-browser');
    webStorage()!.setItem('daydayup.settings.v1', 'x');
    expect(remote.map.get('daydayup.settings.v1')).toBe('x');
  });

  it('syncs exactly the account-scoped keys', () => {
    expect([...SYNCED_KEYS].sort()).toEqual(['daydayup.meta.v1', 'daydayup.playerId.v1', 'daydayup.settings.v1']);
  });
});
