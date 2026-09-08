import type { RoomPiece } from '@dd/engine';

// Kept on the `ddu-` codename prefix on purpose, the same rule the 2026-09-06 rename
// applied to `daydayup.*` (roadmap/39): this string is MATCHED against a key already in a
// designer's browser, so renaming it silently drops their unsaved draft rather than
// renaming anything. A human never reads it.
const AUTOSAVE_PREFIX = 'ddu-mapeditor:room:';

/** In-memory editing state for one RoomPiece document, plus a localStorage
 * autosave on every mutation (no undo/redo in v1 — this is the cheap recovery
 * net instead, matching the plan's explicit tradeoff). */
export class RoomDocument {
  piece: RoomPiece;
  private listeners = new Set<() => void>();
  private autosaveKey: string;

  constructor(piece: RoomPiece, autosaveKey = 'draft') {
    this.piece = piece;
    this.autosaveKey = AUTOSAVE_PREFIX + autosaveKey;
  }

  on(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  mutate(fn: (piece: RoomPiece) => void): void {
    fn(this.piece);
    this.autosave();
    this.emit();
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  private autosave(): void {
    try {
      localStorage.setItem(this.autosaveKey, JSON.stringify(this.piece));
    } catch {
      // localStorage unavailable/full — autosave is best-effort insurance only.
    }
  }

  static loadAutosave(autosaveKey = 'draft'): RoomPiece | null {
    try {
      const raw = localStorage.getItem(AUTOSAVE_PREFIX + autosaveKey);
      return raw ? (JSON.parse(raw) as RoomPiece) : null;
    } catch {
      return null;
    }
  }

  static blank(id: string): RoomPiece {
    return {
      id,
      sizeGrid: { w: 20, h: 20 },
      solids: [],
      spawns: { player: [], enemy: [] },
      exits: [],
    };
  }
}
