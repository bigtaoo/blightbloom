/**
 * Portal storage: the CrazyGames `SDK.data` module behind `webStorage()`, for the keys that
 * should follow the player (design/20 "Progress save").
 *
 * Why at all: the portal's own requirements ask a game to keep progress in `SDK.data` rather
 * than `localStorage`, because the module follows a SIGNED-IN portal user across devices and,
 * for a guest, survives the browsers that block storage in an embedded frame no worse than
 * `localStorage` does. It is a `localStorage`-shaped API, so adopting it is one override in
 * `platform/webStorage.ts` — no store changes.
 *
 * Why only SOME keys (`SYNCED_KEYS`), routed per key rather than everything:
 *  - The module has a 1 MB budget and DEBOUNCES its saves (1–30 s, per the docs). The run
 *    save is ~400 KB of command stream and is written on the way out of a run — exactly the
 *    moment a tab is closed. A debounced write there is a save the player was told had landed
 *    and did not, which `runSaveStore.ts` names as the one unacceptable outcome. It stays in
 *    `localStorage`, per device.
 *  - The session is a bearer token `PortalAuth` re-obtains on every visit; copying it into a
 *    portal-side store buys nothing and puts a credential somewhere it does not need to be.
 *  - The perf toggles are a developer's, per machine.
 * What IS synced is what makes a guest the same guest everywhere: the install id, the meta
 * (Forge) state and the settings.
 *
 * Migration: a player who played before this shipped has those keys in `localStorage`. Each is
 * copied INTO the module when the module does not have it yet — read first, never overwrite,
 * so a portal account that already holds progress is not clobbered by a device's older copy.
 * The `localStorage` copy is left in place: it is the rollback if the module is ever turned
 * off again.
 */
import { browserStorage, setStorageOverride, type KeyValueStorage } from '../webStorage';
import type { CrazyGamesSdk } from './sdk';
import { IDENTITY_STORAGE_KEY } from '../../net/identity';
import { META_STORAGE_KEY } from '../../meta/store';
import { SETTINGS_STORAGE_KEY } from '../../settings/store';

/** The keys routed to `SDK.data`; everything else stays in `localStorage`. Imported rather
 *  than respelled: `storageKeys.test.ts` pins each key to the one module that owns it. */
export const SYNCED_KEYS: ReadonlySet<string> = new Set([IDENTITY_STORAGE_KEY, META_STORAGE_KEY, SETTINGS_STORAGE_KEY]);

export type PortalStorageOutcome = 'adopted' | 'no-script' | 'unavailable';

export interface PortalStorageDeps {
  sdk: Pick<CrazyGamesSdk, 'init' | 'dataModule'>;
  /** Whether the SDK script ran. It is a synchronous `<script>` ahead of the entry module, so
   *  when its global is absent at boot it was BLOCKED and is not coming — and waiting out
   *  `init()`'s budget for it would add seconds to every adblocked boot for nothing. */
  scriptLoaded: boolean;
  /** Defaults to the real `localStorage`; injected for tests. */
  local?: KeyValueStorage | null;
  /** Defaults to `setStorageOverride`; injected for tests. */
  install?: (s: KeyValueStorage) => void;
}

/**
 * Wait for the SDK, and if its data module answers, route `SYNCED_KEYS` through it. Never
 * rejects: every failure leaves `localStorage` in place, which is the state before this
 * existed.
 */
export async function adoptPortalStorage(deps: PortalStorageDeps): Promise<PortalStorageOutcome> {
  if (!deps.scriptLoaded) return 'no-script';
  await deps.sdk.init();
  const data = deps.sdk.dataModule();
  const local = deps.local === undefined ? browserStorage() : deps.local;
  // The probe: the module THROWS on every call when the submission's "Progress Save" toggle
  // is off (`dataModuleDisabled`), and a module that throws on the probe would throw inside
  // every store, which fails soft — silently losing every save. Checked once, here, instead.
  try {
    if (!data?.getItem || !data.setItem || !data.removeItem) return 'unavailable';
    data.getItem(IDENTITY_STORAGE_KEY); // a read: no side effect, any key would do
  } catch {
    return 'unavailable';
  }
  const remote: KeyValueStorage = {
    getItem: (k) => {
      const v = data.getItem!(k);
      return typeof v === 'string' ? v : null;
    },
    setItem: (k, v) => void data.setItem!(k, v),
    removeItem: (k) => void data.removeItem!(k),
  };
  migrate(local, remote);
  (deps.install ?? setStorageOverride)(routed(remote, local));
  return 'adopted';
}

/** Copy each synced key the module lacks from `localStorage`. Per key, so one bad value does
 *  not stop the rest. */
function migrate(local: KeyValueStorage | null, remote: KeyValueStorage): void {
  if (!local) return;
  for (const k of SYNCED_KEYS) {
    try {
      if (remote.getItem(k) !== null) continue;
      const v = local.getItem(k);
      if (v !== null) remote.setItem(k, v);
    } catch {
      /* this key stays per device; the stores fail soft on it exactly as before */
    }
  }
}

/** `SYNCED_KEYS` to the module, the rest to `localStorage` — or to nowhere when the frame has
 *  none, which is the `null` storage every store already handles, one key at a time. */
function routed(remote: KeyValueStorage, local: KeyValueStorage | null): KeyValueStorage {
  const pick = (k: string): KeyValueStorage | null => (SYNCED_KEYS.has(k) ? remote : local);
  return {
    getItem: (k) => pick(k)?.getItem(k) ?? null,
    setItem: (k, v) => {
      const s = pick(k);
      if (!s) throw new Error('storage unavailable');
      s.setItem(k, v);
    },
    removeItem: (k) => pick(k)?.removeItem(k),
  };
}
