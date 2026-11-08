/**
 * Bridge storage behind `webStorage()`: the Playgama counterpart of
 * `platform/crazygames/portalStorage.ts`.
 *
 * Playgama's requirements ask a game to keep progress in Bridge storage rather than in
 * `localStorage` directly — on the catalog Bridge decides where it lives (the platform's cloud
 * for a signed-in player), and reading it all at once at boot is the shape the docs prescribe.
 * Bridge's `get` is ASYNC while every store here reads synchronously, so the keys are read in
 * one call before the first store is constructed, kept in a cache, and every write goes to the
 * cache at once and to Bridge on the next tick, coalesced.
 *
 * The same keys as on CrazyGames (`SYNCED_KEYS`) and for the same reasons — the run save is
 * ~400 KB and written on the way out of a run, the session token means nothing offline, the
 * perf toggles are a developer's. Everything else stays in `localStorage`.
 */
import { browserStorage, setStorageOverride, type KeyValueStorage } from '../webStorage';
import { SYNCED_KEYS } from '../crazygames/portalStorage';
import type { PlaygamaBridge } from './bridge';

export type BridgeStorageOutcome = 'adopted' | 'unavailable';

export interface BridgeStorageDeps {
  bridge: Pick<PlaygamaBridge, 'hasStorage' | 'load' | 'save'>;
  /** Defaults to the real `localStorage`; injected for tests. */
  local?: KeyValueStorage | null;
  /** Defaults to `setStorageOverride`; injected for tests. */
  install?: (s: KeyValueStorage) => void;
  /** When a batch of writes goes out; the next macrotask by default. */
  later?: (fn: () => void) => void;
}

/** What `adoptBridgeStorage` hands back: the outcome, and a way to push pending writes now
 *  (the page is going away, or the platform paused the game). */
export interface BridgeStorageHandle {
  outcome: BridgeStorageOutcome;
  flush(): void;
}

/**
 * Read `SYNCED_KEYS` from Bridge and route them through it from here on. Never rejects: without
 * Bridge storage the stores keep `localStorage`, which is the state before this existed.
 */
export async function adoptBridgeStorage(deps: BridgeStorageDeps): Promise<BridgeStorageHandle> {
  if (!deps.bridge.hasStorage()) return { outcome: 'unavailable', flush: () => undefined };
  const keys = [...SYNCED_KEYS];
  const cache = await deps.bridge.load(keys);
  // An empty string is how a removed key is stored (below), so it reads back as absent.
  for (const [k, v] of [...cache]) if (v === '') cache.delete(k);
  const local = deps.local === undefined ? browserStorage() : deps.local;
  const later = deps.later ?? ((fn) => void setTimeout(fn, 0));

  let pending = new Map<string, string>();
  let queued = false;
  const flush = (): void => {
    queued = false;
    if (pending.size === 0) return;
    const batch = pending;
    pending = new Map();
    deps.bridge.save(batch);
  };
  const write = (k: string, v: string): void => {
    if (v === '') cache.delete(k);
    else cache.set(k, v);
    pending.set(k, v);
    if (queued) return;
    queued = true;
    later(flush);
  };

  // A player who played this build before Bridge storage answered (or on this domain's
  // `localStorage` in a preview) keeps that progress: copied in where Bridge has nothing,
  // never over what Bridge already holds.
  for (const k of keys) {
    if (cache.has(k)) continue;
    try {
      const v = local?.getItem(k) ?? null;
      if (v !== null) write(k, v);
    } catch {
      /* this key starts empty; the stores fail soft on it exactly as before */
    }
  }

  const synced = (k: string): boolean => SYNCED_KEYS.has(k);
  (deps.install ?? setStorageOverride)({
    getItem: (k) => (synced(k) ? (cache.get(k) ?? null) : (local?.getItem(k) ?? null)),
    setItem: (k, v) => {
      if (synced(k)) return write(k, v);
      if (!local) throw new Error('storage unavailable');
      local.setItem(k, v);
    },
    // Bridge has a `delete` of its own, but routing it through the same coalesced batch keeps a
    // remove-then-set in one tick in order; the empty string is read back as absent above.
    removeItem: (k) => (synced(k) ? write(k, '') : local?.removeItem(k)),
  });
  return { outcome: 'adopted', flush };
}
