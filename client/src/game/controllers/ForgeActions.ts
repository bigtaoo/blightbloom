import type { MetaState, MetaStore } from '../../meta';
import { playUiCue } from '../../audio/uiSound';
import { clearLoadout, craft, selectCharacter } from '../../meta';
import { SKIN_DEFS } from '@dd/engine';
import type { Forge } from '../screens/Forge';
import type { Loadout } from '../screens/Loadout';

export interface ForgeActionsDeps {
  /** The crafting page — re-rendered by the verbs that change what its cards say. */
  forge: Forge;
  /**
   * The pre-run screen — re-rendered by the verbs that change what it shows you carrying.
   *
   * Two screens rather than one since the 2026-09-21 split, and which verb re-renders which
   * is not symmetric: crafting happens ON the forge, so `craftAt` redraws that; the
   * character cycle and CLEAR happen on the loadout screen, so they redraw that one. Each
   * verb redraws the screen the player is actually looking at while they run it, and the
   * other screen re-reads the meta the next time it is opened — which it does anyway, since
   * `render` takes the `MetaState` as an argument rather than caching one.
   */
  loadout: Loadout;
  store: MetaStore;
}

/**
 * The between-run craft / cycle-character / clear / browse actions (design/14), split out
 * of Game.ts (CLAUDE.md "500-line file convention", form ② — independent class +
 * composition: a single, cleanly self-contained concern with no cross-boundary calls back
 * into Game — every method here takes the current `MetaState` + the current screen size as
 * plain parameters and returns the updated `MetaState`, persisting it via the injected
 * `MetaStore` and re-rendering the injected screen itself). `ForgeInput`'s key table and
 * the two screens' own button callbacks call straight through to these methods — one
 * source of truth for both input paths, unchanged from before the split.
 *
 * Since 2026-09-21 the verbs are spread over TWO screens rather than one (see
 * `ForgeActionsDeps.loadout`), which is the only thing the crafting-page split changed
 * here: what each verb DOES to the meta is byte-identical.
 *
 * `acquireBlueprint` used to live here — the `demo: free grant` scaffold (ROADMAP 2.4) that
 * handed the player the first purchasable blueprint for nothing. It is gone rather than
 * moved: a grant the client makes to itself does not survive the next login now that the
 * server answers `/account/meta` from its own entitlements table (design/19 §2), so the
 * replacement is a real purchase, and it lives in `StorePurchase`/`StoreScreen` because
 * money is not a forge transaction.
 */
export class ForgeActions {
  constructor(private readonly deps: ForgeActionsDeps) {}

  /** Craft blueprint `i` into the loadout (a digit key or a forge card tap) —
   * also moves the browse cursor onto it, so the compare card previews what was just
   * crafted. Still ignores locked/unaffordable/full, but no longer *silently*: this is
   * where the UI cue is chosen, because the widget cannot know which happened (the row
   * card is constructed with no sound of its own for exactly this reason). A press that
   * changes nothing used to be indistinguishable from a press the game never received —
   * `ui.denied` is the difference (design/11 UI cues). */
  craftAt(meta: MetaState, i: number, w: number, h: number): MetaState {
    this.deps.forge.selectedIndex = i;
    const id = this.deps.forge.order[i];
    let next = meta;
    if (id) {
      const res = craft(meta, id);
      if (res.ok) {
        next = res.meta;
        this.deps.store.save(next);
      }
    }
    playUiCue(next === meta ? 'ui.denied' : 'ui.tap');
    this.deps.forge.render(next, w, h);
    return next;
  }

  /** Advance the chosen character to the next owned one (design/14 roster select). */
  cycleCharacter(meta: MetaState, w: number, h: number): MetaState {
    const owned = meta.ownedCharacters.filter((id) => SKIN_DEFS[id]);
    const next = owned.length < 2 ? meta : selectCharacter(meta, owned[(owned.indexOf(meta.selectedSkin) + 1) % owned.length]!);
    if (next !== meta) {
      this.deps.store.save(next);
      this.deps.loadout.render(next, w, h);
    }
    return next;
  }

  clear(meta: MetaState, w: number, h: number): MetaState {
    const next = clearLoadout(meta);
    this.deps.store.save(next);
    this.deps.loadout.render(next, w, h);
    return next;
  }

  /** Browse cursor only (design/10 compare card) — never crafts, so it can't be
   * confused with the digit keys'/row taps' immediate craft. */
  moveSelection(meta: MetaState, delta: number, w: number, h: number): void {
    this.deps.forge.moveSelection(delta);
    this.deps.forge.render(meta, w, h);
  }
}
