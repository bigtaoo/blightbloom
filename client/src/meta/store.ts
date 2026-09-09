/**
 * MetaStore — the persistence port for the between-run MetaState (design/14 "the
 * persistent layer between runs"). Symmetric to platform's InputSource / AudioBus: a
 * small swappable interface so the meta layer never touches a concrete storage API
 * directly. Web uses localStorage; tests (and any no-storage host) use the in-memory
 * store.
 *
 * WeChat still uses the in-memory one, so a guest's progress there does not survive a
 * reload — but the primitive it needs now exists: `platform/wechat/weChatStorage.ts`
 * (2026-09-09) wraps `wx.getStorageSync`/`setStorageSync` and already backs the identity
 * store. What is left here is not the adapter, it is this store's own question: a save that
 * has never persisted on that host means the first load after wiring it reads a fresh
 * account, and `migrate` below is what would have to be right about it.
 */
import { defaultMetaState, type MetaState } from './MetaState';

export interface MetaStore {
  load(): MetaState;
  save(m: MetaState): void;
}

/** In-memory store — no persistence across reloads. Default for tests / headless. */
export class MemoryMetaStore implements MetaStore {
  private state: MetaState;
  constructor(initial: MetaState = defaultMetaState()) {
    this.state = initial;
  }
  load(): MetaState {
    return this.state;
  }
  save(m: MetaState): void {
    this.state = m;
  }
}

const DEFAULT_KEY = 'daydayup.meta.v1';

/** localStorage-backed store for the web build. Fails soft: any load/parse/quota error
 * falls back to a fresh account rather than throwing (a corrupt save must not brick the
 * game). `migrate` backfills fields a newer build added, so old saves keep working. */
export function createWebMetaStore(key: string = DEFAULT_KEY): MetaStore {
  const available = typeof localStorage !== 'undefined';
  return {
    load(): MetaState {
      if (!available) return defaultMetaState();
      try {
        const raw = localStorage.getItem(key);
        return raw ? migrate(JSON.parse(raw)) : defaultMetaState();
      } catch {
        return defaultMetaState();
      }
    },
    save(m: MetaState): void {
      if (!available) return;
      try {
        localStorage.setItem(key, JSON.stringify(m));
      } catch {
        /* quota / private-mode — a lost save is acceptable, a crash is not */
      }
    },
  };
}

/** Merge a parsed save onto current defaults so a save written by an older build (missing
 * a field, or predating a newly-added starter blueprint / free character) stays valid.
 * Unlocks/ownership union with defaults; the rest takes the saved value when well-typed. */
export function migrate(parsed: unknown): MetaState {
  const d = defaultMetaState();
  if (!parsed || typeof parsed !== 'object') return d;
  const p = parsed as Partial<MetaState>;
  const union = (base: readonly string[], saved: unknown): string[] =>
    Array.isArray(saved) ? [...new Set([...base, ...saved.filter((x): x is string => typeof x === 'string')])] : [...base];
  // Every OTHER field here drops anything ill-typed rather than trusting a parsed save
  // verbatim; materialBank didn't, so a corrupted/hand-edited entry (e.g. a string qty)
  // passed straight through and broke forge.ts's `sum + e.qty` reduce (string
  // concatenation instead of addition) instead of failing safe like everything else.
  const materialBank = (saved: unknown): Record<string, number> => {
    if (!saved || typeof saved !== 'object') return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(saved as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    }
    return out;
  };
  return {
    materialBank: materialBank(p.materialBank),
    unlockedBlueprints: union(d.unlockedBlueprints, p.unlockedBlueprints),
    ownedCharacters: union(d.ownedCharacters, p.ownedCharacters),
    loadout: Array.isArray(p.loadout) ? p.loadout.filter((x): x is string => typeof x === 'string') : [],
    selectedSkin: typeof p.selectedSkin === 'string' ? p.selectedSkin : d.selectedSkin,
    hasSeenTutorial: typeof p.hasSeenTutorial === 'boolean' ? p.hasSeenTutorial : d.hasSeenTutorial,
  };
}
