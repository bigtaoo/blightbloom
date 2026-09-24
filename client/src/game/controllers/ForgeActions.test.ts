/**
 * ForgeActions (extracted from Game.ts 2026-08-12, CLAUDE.md "500-line file
 * convention") — drives real `Forge` + `Loadout` screens and a `MemoryMetaStore` (all
 * directly unit-testable without a live Pixi renderer, per this repo's own testing
 * conventions) through the exact craft/cycle/clear/browse transactions Game.ts used to
 * inline. Two screens since the 2026-09-21 split: crafting redraws the forge, the character
 * cycle and CLEAR redraw the loadout screen.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { DOMAdapter } from 'pixi.js';
import { defaultMetaState, purchasableBlueprints, grantCharacter, MemoryMetaStore, type MetaState } from '../../meta';
import { Forge } from '../screens/Forge';
import { Loadout } from '../screens/Loadout';
import { ForgeActions } from './ForgeActions';
import { setUiAudio } from '../../audio/uiSound';

// `Forge.render()` reads `Text.height` to flow its layout, which lazily measures text
// on a real `<canvas>` 2D context — absent under this repo's plain-node vitest
// environment. Same fake-canvas `DOMAdapter` seam `Forge.test.ts` already uses (the
// glyph metrics don't matter to any assertion below, only where content visually
// flows).
DOMAdapter.set({
  ...DOMAdapter.get(),
  createCanvas: (width?: number, height?: number) => {
    const ctx = {
      font: '',
      measureText(text: string) {
        const m = /(\d+(?:\.\d+)?)px/.exec(this.font as string);
        const fontSize = m ? parseFloat(m[1]!) : 10;
        const w = text.length * fontSize * 0.6;
        return { width: w, actualBoundingBoxAscent: fontSize * 0.8, actualBoundingBoxDescent: fontSize * 0.2 };
      },
    };
    return { width: width ?? 0, height: height ?? 0, getContext: () => ctx } as unknown as HTMLCanvasElement;
  },
  getCanvasRenderingContext2D: () => class {} as unknown as typeof CanvasRenderingContext2D,
});

/** The Loadout screen's weapon cards that are actually drawn — its private fixed pool, the
 *  same escape hatch `Loadout.test.ts` uses. */
function cardsOf(l: Loadout): Array<{ nameLabel: string; statusLabel: string }> {
  const p = l as unknown as { weaponCards: Array<{ view: { visible: boolean }; nameLabel: string; statusLabel: string }> };
  return p.weaponCards.filter((c) => c.view.visible);
}

function craftableMeta(): MetaState {
  // repeater is a starter (drop) blueprint, cost physical×3 (see meta/forge.test.ts).
  return { ...defaultMetaState(), materialBank: { mat_physical: 4 } };
}

describe('ForgeActions', () => {
  it('craftAt: crafts an affordable blueprint, moves the browse cursor, persists, and re-renders', () => {
    const forge = new Forge();
    const loadout = new Loadout();
    const store = new MemoryMetaStore();
    const actions = new ForgeActions({ forge, loadout, store });
    const meta = craftableMeta();
    const i = forge.order.indexOf('repeater');
    expect(i).toBeGreaterThanOrEqual(0);

    const next = actions.craftAt(meta, i, 800, 600);

    expect(next.loadout).toEqual(['repeater']);
    expect(next.materialBank.mat_physical).toBe(1); // 4 - 3
    expect(forge.selectedIndex).toBe(i); // browse cursor moved even though this call also crafts
    expect(store.load().loadout).toEqual(['repeater']); // persisted
  });

  it('craftAt: still moves the browse cursor and re-renders on a failed craft (unaffordable), without persisting', () => {
    const forge = new Forge();
    const loadout = new Loadout();
    const store = new MemoryMetaStore();
    const actions = new ForgeActions({ forge, loadout, store });
    const meta = defaultMetaState(); // no materials banked
    const i = forge.order.indexOf('repeater');

    const next = actions.craftAt(meta, i, 800, 600);

    expect(next).toBe(meta); // unchanged
    expect(forge.selectedIndex).toBe(i); // cursor still moves — same as before the split
    expect(store.load()).toEqual(defaultMetaState()); // nothing persisted
  });

  it('cycleCharacter: advances to the next owned character and persists; no-ops with < 2 owned', () => {
    const forge = new Forge();
    const loadout = new Loadout();
    const store = new MemoryMetaStore();
    const actions = new ForgeActions({ forge, loadout, store });
    // skirmisher is no longer in the free default roster (Task 8) — grant it explicitly,
    // the same way a completed character-SKU purchase would, so there is more than one
    // owned character to cycle between.
    const meta = grantCharacter(defaultMetaState(), 'skirmisher');
    expect(meta.ownedCharacters.length).toBeGreaterThan(1);

    const next = actions.cycleCharacter(meta, 800, 600);

    expect(next.selectedSkin).not.toBe(meta.selectedSkin);
    expect(next.ownedCharacters).toContain(next.selectedSkin);
    expect(store.load().selectedSkin).toBe(next.selectedSkin);

    const single = { ...meta, ownedCharacters: [meta.selectedSkin] };
    expect(actions.cycleCharacter(single, 800, 600)).toBe(single); // no-op, unchanged reference
  });

  // Two cases for `acquireBlueprint` — the `demo: free grant` scaffold (ROADMAP 2.4) — used
  // to sit here. It is gone rather than moved (see this class's header); a purchase is now
  // `StorePurchase`/`StoreScreen`'s job. What replaces them is the guard below, which fails
  // if ANY forge action starts handing out ownership again.
  it('grants nothing for free: no forge action can widen what the account owns', () => {
    const forge = new Forge();
    const loadout = new Loadout();
    const store = new MemoryMetaStore();
    const actions = new ForgeActions({ forge, loadout, store });
    const meta = craftableMeta();
    const shelf = purchasableBlueprints(meta);
    expect(shelf.length).toBeGreaterThan(0); // there IS something a grant could hand over

    // Every public verb, driven the way the forge drives it.
    let next = actions.craftAt(meta, forge.order.indexOf('repeater'), 800, 600);
    next = actions.cycleCharacter(next, 800, 600);
    next = actions.clear(next, 800, 600);
    actions.moveSelection(next, 1, 800, 600);

    expect(next.unlockedBlueprints.sort()).toEqual([...meta.unlockedBlueprints].sort());
    expect(next.ownedCharacters.sort()).toEqual([...meta.ownedCharacters].sort());
    expect(purchasableBlueprints(next)).toEqual(shelf); // the shelf is exactly as full as before
  });

  it('clear: empties the staged loadout and persists', () => {
    const forge = new Forge();
    const loadout = new Loadout();
    const store = new MemoryMetaStore();
    const actions = new ForgeActions({ forge, loadout, store });
    const meta = { ...defaultMetaState(), loadout: ['repeater'] };

    const next = actions.clear(meta, 800, 600);

    expect(next.loadout).toEqual([]);
    expect(store.load().loadout).toEqual([]);
  });

  /**
   * The claim the 2026-09-21 split introduced and nothing else checks: a craft happens on the
   * FORGE and is read on the LOADOUT screen, which is a different object. Both were verified
   * by hand in the running client; this is the half that survives.
   *
   * Note what would pass without it. `craftAt` re-renders the forge, so `Forge.test.ts` sees
   * the staged badge appear; `Loadout.test.ts` renders a hand-built meta with `loadout:
   * ['repeater']` and sees the card. Neither exercises the seam — the returned `MetaState`
   * travelling from one screen to the other — and a `craftAt` that dropped its return value
   * would leave both files green and the player looking at a weapon they did not craft.
   */
  it('a craft on the forge is what the LOADOUT screen then says you are carrying', () => {
    const forge = new Forge();
    const loadout = new Loadout();
    const store = new MemoryMetaStore();
    const actions = new ForgeActions({ forge, loadout, store });

    const before = craftableMeta();
    loadout.render(before, 800, 600);
    expect(cardsOf(loadout).map((c) => c.statusLabel)).toEqual(['default kit', 'default kit']);

    const after = actions.craftAt(before, forge.order.indexOf('repeater'), 800, 600);
    // The navigation is what re-renders it in the product (`ScreenFlow.showLoadout`), so the
    // test does the same rather than expecting a screen to refresh itself from under a
    // screen the player is actually looking at.
    loadout.render(after, 800, 600);

    const cards = cardsOf(loadout);
    expect(cards[0]!.nameLabel).toBe('Repeater');
    expect(cards[0]!.statusLabel).toBe('forged');
    expect(cards[1]!.statusLabel).toBe('default kit'); // the starter still fills the other slot
  });

  it('...and a CLEAR takes it straight back off, on the screen that owns that button', () => {
    const forge = new Forge();
    const loadout = new Loadout();
    const store = new MemoryMetaStore();
    const actions = new ForgeActions({ forge, loadout, store });

    const crafted = actions.craftAt(craftableMeta(), forge.order.indexOf('repeater'), 800, 600);
    const cleared = actions.clear(crafted, 800, 600);

    // No second `render` here on purpose: CLEAR is pressed ON this screen, so `ForgeActions`
    // re-renders it itself — and that asymmetry (craft redraws the forge, clear redraws the
    // loadout screen) is the one thing the split had to get right about this controller.
    expect(cardsOf(loadout).map((c) => c.statusLabel)).toEqual(['default kit', 'default kit']);
    expect(cleared.loadout).toEqual([]);
  });

  it('moveSelection: moves the browse cursor without touching meta or the store', () => {
    const forge = new Forge();
    const loadout = new Loadout();
    const store = new MemoryMetaStore();
    const actions = new ForgeActions({ forge, loadout, store });
    const meta = defaultMetaState();
    const before = forge.selectedIndex;

    actions.moveSelection(meta, 1, 800, 600);

    expect(forge.selectedIndex).not.toBe(before);
    expect(store.load()).toEqual(defaultMetaState()); // untouched
  });
});

/**
 * The UI cue this controller owns (design/11 UI cues, 2026-08-30). Every other button in the
 * client gets its click from the widget (`ui/widgets.ts`), because pressing it always does
 * something. These two do not: a craft can be unaffordable, locked or on a full loadout, and
 * ACQUIRE can have nothing left to buy. So both are built `sound: 'silent'` and the sound is
 * chosen HERE, from the outcome — otherwise a press that changes nothing is audibly identical
 * to one that works, which is the state this pass found the forge in.
 */
describe('ForgeActions — the UI cue follows the outcome', () => {
  function recorder() {
    const log: string[] = [];
    setUiAudio({
      preload: async () => {}, play: (cue) => { log.push(cue); },
      setSfxVolume: () => {}, setMusicVolume: () => {}, updateMusic: () => {}, invalidateMusic: () => {}, resume: () => {},
    });
    return log;
  }

  afterEach(() => setUiAudio(null));

  it('craftAt: ui.tap when the craft lands', () => {
    const log = recorder();
    const forge = new Forge();
    const actions = new ForgeActions({ forge, loadout: new Loadout(), store: new MemoryMetaStore() });
    actions.craftAt(craftableMeta(), forge.order.indexOf('repeater'), 800, 600);
    expect(log).toEqual(['ui.tap']);
  });

  it('craftAt: ui.denied when it cannot be afforded', () => {
    const log = recorder();
    const forge = new Forge();
    const actions = new ForgeActions({ forge, loadout: new Loadout(), store: new MemoryMetaStore() });
    actions.craftAt(defaultMetaState(), forge.order.indexOf('repeater'), 800, 600);
    expect(log).toEqual(['ui.denied']);
  });

  it('craftAt: ui.denied on an empty row, where there is no blueprint at all', () => {
    // The row taps are bounds-guarded upstream, but the digit keys reach this directly.
    const log = recorder();
    const forge = new Forge();
    const actions = new ForgeActions({ forge, loadout: new Loadout(), store: new MemoryMetaStore() });
    actions.craftAt(craftableMeta(), forge.order.length + 5, 800, 600);
    expect(log).toEqual(['ui.denied']);
  });

  it('says nothing at all with no audio attached — the forge still works headless', () => {
    setUiAudio(null);
    const forge = new Forge();
    const actions = new ForgeActions({ forge, loadout: new Loadout(), store: new MemoryMetaStore() });
    expect(() => actions.craftAt(craftableMeta(), forge.order.indexOf('repeater'), 800, 600)).not.toThrow();
  });
});
