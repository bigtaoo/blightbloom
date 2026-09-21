// Split out of Game.ts, 2026-09-03 — the between-run KEYBOARD routing, and the three verbs
// both it and the two hub screens' buttons run through.
//
// The `craft/cycle/clear` wrappers looked like pure ceremony in the shell (each was three
// lines: measure, delegate, store the result), and that is exactly why they are worth having
// in one place: they are the SINGLE source of truth for both input paths, so a digit key and
// a card tap can never diverge. `ForgeActions` (2026-08-12) owns what each verb does to the
// meta; this owns which key means which verb, and the phase guard around all of them.
//
// ## Two phases, two tables (2026-09-21)
//
// The hub used to be one screen and therefore one guard (`phase === 'forge'`). It is two
// now — the pre-run LOADOUT screen and the FORGE crafting page — and each key belongs to
// exactly one of them, for the same reason the screens were split: a key is an alias for a
// control, and a control that is not on screen has no business firing. So [1-9] and [↑↓]
// (browse and craft, which act on the blueprint grid) run only in the forge phase, while
// [C]/[X]/[Enter] (character, clear, start the run) run only in the loadout phase. [F] is
// the new one and it is the bridge — the loadout screen's FORGE card, as a key.
//
// It is the only controller here that names a keyboard at all. `onKey` takes a `code` string
// rather than an event, so the table can be exercised without a DOM.
import type { Layers } from '../scene/layers';
import type { Forge } from '../screens/Forge';
import type { ForgeActions } from './ForgeActions';
import type { RunState } from '../runState';

export interface ForgeInputDeps {
  run: RunState;
  layers: Layers;
  forge: Forge;
  forgeActions: ForgeActions;
  screenSize: () => { w: number; h: number };
  /** O opens the settings overlay (a touch entry point is the SETTINGS button). */
  openSettings: () => void;
  /** B opens the store (a touch entry point is the STORE button). Was `acquire`, which
   * granted a blueprint for free — see `ForgeActions`'s header for why that is gone. */
  openStore: () => void;
  /** F opens the crafting page (a touch entry point is the loadout screen's FORGE card). */
  openForge: () => void;
  /** Enter descends into a run — the same verb the START RUN button and Fire run. */
  confirm: () => void;
}

export class ForgeInput {
  constructor(private readonly deps: ForgeInputDeps) {}

  private fit(): { w: number; h: number } {
    return this.deps.layers.menu.fit(this.deps.screenSize());
  }

  /**
   * Apply a between-run control (web keyboard, design/14). Mutates meta through the pure
   * forge transactions, persists, and re-renders. No-op outside the two hub phases — which
   * is also what silences the whole table while the STORE screen (its own phase) is up.
   * Every key here routes through the SAME methods the screens' buttons call — one source
   * of truth for both input paths, not duplicated logic.
   *
   * A touch forge is a follow-up (like the touch INTERACT control), which is why this is
   * guarded to the DOM at the call site.
   */
  onKey(code: string): void {
    const phase = this.deps.run.phase;
    if (phase === 'forge') this.onForgeKey(code);
    else if (phase === 'loadout') this.onLoadoutKey(code);
  }

  /** The CRAFTING page's own table: browse the grid, craft from it, open the store. */
  private onForgeKey(code: string): void {
    const digit = /^Digit([1-9])$/.exec(code);
    if (digit) {
      const i = Number(digit[1]) - 1;
      if (this.deps.forge.order[i]) this.craftAt(i);
    } else if (code === 'KeyB') {
      this.deps.openStore();
    } else if (code === 'ArrowUp' || code === 'ArrowDown') {
      // Browse cursor only (design/10 compare card) — never crafts, so it can't be confused
      // with the digit keys'/card taps' immediate craft.
      const { w, h } = this.fit();
      this.deps.forgeActions.moveSelection(this.deps.run.meta, code === 'ArrowUp' ? -1 : 1, w, h);
    }
  }

  /** The PRE-RUN screen's own table: the character, the loadout, the forge, and the run. */
  private onLoadoutKey(code: string): void {
    if (code === 'KeyC') {
      this.cycleCharacter();
    } else if (code === 'KeyX') {
      this.clear();
    } else if (code === 'KeyF') {
      this.deps.openForge();
    } else if (code === 'KeyO') {
      this.deps.openSettings();
    } else if (code === 'Enter' || code === 'NumpadEnter') {
      this.deps.confirm();
    }
  }

  craftAt(i: number): void {
    const { w, h } = this.fit();
    this.deps.run.meta = this.deps.forgeActions.craftAt(this.deps.run.meta, i, w, h);
  }

  cycleCharacter(): void {
    const { w, h } = this.fit();
    this.deps.run.meta = this.deps.forgeActions.cycleCharacter(this.deps.run.meta, w, h);
  }

  clear(): void {
    const { w, h } = this.fit();
    this.deps.run.meta = this.deps.forgeActions.clear(this.deps.run.meta, w, h);
  }
}
