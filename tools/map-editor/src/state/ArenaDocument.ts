import type { ArenaMap } from '@dd/engine/content/arenas';

// Kept on the `ddu-` codename prefix on purpose, the same rule the 2026-09-06 rename
// applied to `daydayup.*` (roadmap/39): this string is MATCHED against a key already in a
// designer's browser, so renaming it silently drops their unsaved draft rather than
// renaming anything. A human never reads it.
const AUTOSAVE_KEY = 'ddu-mapeditor:arena:draft';

/** In-memory editing state for the (single, per plan) open ArenaMap document,
 * plus a localStorage autosave on every mutation. */
export class ArenaDocument {
  map: ArenaMap;
  private listeners = new Set<() => void>();

  constructor(map: ArenaMap) {
    this.map = map;
  }

  on(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  mutate(fn: (map: ArenaMap) => void): void {
    fn(this.map);
    this.autosave();
    this.emit();
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  private autosave(): void {
    try {
      localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(this.map));
    } catch {
      // best-effort
    }
  }

  static loadAutosave(): ArenaMap | null {
    try {
      const raw = localStorage.getItem(AUTOSAVE_KEY);
      return raw ? (JSON.parse(raw) as ArenaMap) : null;
    } catch {
      return null;
    }
  }

  static blank(id: string): ArenaMap {
    return { id, sizeGrid: { w: 200, h: 200 }, rooms: [], doors: [], spawns: [], eyeCandidates: [] };
  }
}
