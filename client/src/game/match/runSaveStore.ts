/**
 * The host half of save-and-continue: where a `SavedRun` is kept, and the one slot it lives
 * in (design/05 "Only the boss floor ends a run", ENGINE_VERSION 61).
 *
 * Split from `runSave.ts` for the reason `replayDownload.ts` is split from `MatchRecorder`:
 * this is the only part that touches the host. The format, the version/content checks and the
 * "may this run be saved" rule are all pure and stay next door — which is what lets
 * `ScreenNav.savable()` reach the RULE without dragging `localStorage` into the client's pure
 * layer (`src/game/pureLayerBoundary.test.ts`, which is where that boundary is enforced; a
 * coverage percentage cannot see it).
 */
import { parseRunSave, type RunSaveStore, type SavedRun, type SavedRunSummary } from './runSave';

const STORAGE_KEY = 'daydayup.runsave.v1';

/**
 * localStorage-backed store. Fails soft on every path, in the direction that loses a save
 * rather than breaking the game — except `save`, which reports failure, because a caller that
 * is about to leave the run needs to know the save did not land.
 */
export function createWebRunSaveStore(key: string = STORAGE_KEY): RunSaveStore {
  const available = typeof localStorage !== 'undefined';
  return {
    load(): unknown {
      if (!available) return null;
      try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : null;
      } catch {
        return null; // corrupt / unreadable — no save, rather than a throw on the way in
      }
    },
    save(value: SavedRun): boolean {
      if (!available) return false;
      try {
        localStorage.setItem(key, JSON.stringify(value));
        return true;
      } catch {
        return false; // quota (a very long run) or private mode — the caller must say so
      }
    },
    clear(): void {
      if (!available) return;
      try {
        localStorage.removeItem(key);
      } catch {
        /* nothing useful to do, and a failed clear must not break leaving a run */
      }
    },
  };
}

// ── the single process-wide save slot ─────────────────────────────────────────────
//
// One save, replaced rather than accumulated: two unfinished runs would need a picker, and
// design/05 has one run in flight at a time. Cached in module scope for the same reason
// `net/session.ts` caches the session — the Forge asks "is there a save?" on every re-render
// (a keystroke, a page turn), and parsing a ~400 KB command stream per keypress to answer a
// yes/no is the kind of cost that only shows up on someone else's machine.

let cached: SavedRun | null = null;
let loaded = false;

/** The saved run as stored, valid but not necessarily RESUMABLE — see `checkResumable`. */
export function loadSavedRun(store: RunSaveStore = createWebRunSaveStore()): SavedRun | null {
  if (!loaded) {
    cached = parseRunSave(store.load());
    loaded = true;
  }
  return cached;
}

/** What the Forge needs, without touching the stream. */
export function savedRunSummary(store: RunSaveStore = createWebRunSaveStore()): SavedRunSummary | null {
  const save = loadSavedRun(store);
  if (!save) return null;
  return { floorIndex: save.floorIndex, ticks: save.ticks, savedAtMs: save.savedAtMs };
}

/** Store a save, replacing any previous one. False means it did NOT persist. */
export function writeSavedRun(save: SavedRun, store: RunSaveStore = createWebRunSaveStore()): boolean {
  const ok = store.save(save);
  // Cached either way: an unpersisted save is still the truth for THIS session, and the
  // caller has already told the player it could not be kept.
  cached = save;
  loaded = true;
  return ok;
}

/** Drop the save. Called by every path that abandons or finishes a run — see
 *  `RunLifecycle.quitRun` / `beginRun` and `RunOutcome.handle`. */
export function clearSavedRun(store: RunSaveStore = createWebRunSaveStore()): void {
  cached = null;
  loaded = true;
  store.clear();
}

/** Test-only: forget the in-process cache so a fresh store is actually read again. */
export function resetRunSaveCacheForTests(): void {
  cached = null;
  loaded = false;
}
