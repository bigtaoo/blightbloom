/**
 * Shop rendering (design/05 "Shops", ENGINE_VERSION 64).
 *
 * The same four properties `ChestLayer.test.ts` next door pins, for the same reason — each
 * would fail silently in a live frame and nothing else in the repo would notice — plus one this
 * prop has and a chest does not: the **mat is the range gate made visible**, so its radius has
 * to be derived from the constant `ShopSystem` actually refuses purchases on. A mat drawn at
 * some other size is a promise the sim does not keep, and no engine test can see it.
 */
import { describe, it, expect } from 'vitest';
import { Container, Graphics } from 'pixi.js';
import { SHOP_INTERACT_RANGE_GRID, type GameState, type Shop, type ShopOffer } from '@dd/engine';
import { ShopLayer } from './ShopLayer';
import { fpToPx } from '../coords';

type Fp = Shop['gx'];
const fp = (grid: number) => (grid * 1000) as Fp;

const offer = (over: Partial<ShopOffer> = {}): ShopOffer => ({
  id: 1,
  kind: 'heal',
  price: 12,
  sold: false,
  ...over,
});

function shop(over: Partial<Shop> = {}): Shop {
  return {
    id: 1,
    roomId: 'r1',
    gx: fp(10),
    gy: fp(12),
    stock: [offer()],
    ...over,
  };
}

/** The two layers `ShopLayer` draws into, plus a state carrying just `shops` — every other
 *  field is untouched by this module, so a full GameState would only hide what it reads. */
function harness(shops: Shop[]) {
  const entities = new Container();
  const ground = new Container();
  const layer = new ShopLayer(entities, ground);
  const state = { shops } as unknown as GameState;
  return { entities, ground, layer, state };
}

/** The alpha each `fill` in this Graphics was given. Pixi v8 folds the geometry into the fill
 *  instruction's own path, so there is no separate `ellipse` instruction to read — the SIZE is
 *  read back off `bounds` (the convention `ChestLayer.test.ts` already uses) and only the alpha
 *  has to come out of the instruction list. */
function fillAlphas(g: Graphics): (number | undefined)[] {
  type Instr = { action: string; data: { style?: { alpha?: number } } };
  const ctx = (g as unknown as { context: { instructions: Instr[] } }).context;
  return ctx.instructions.filter((i) => i.action === 'fill').map((i) => i.data.style?.alpha);
}

describe('ShopLayer — placement', () => {
  it('puts a counter in the entity layer and Y-sorts it on the ground coordinate', () => {
    const s = shop();
    const { entities, layer, state } = harness([s]);
    layer.update(state);
    expect(entities.children).toHaveLength(1);
    expect(entities.children[0]!.x).toBe(fpToPx(s.gx));
    expect(entities.children[0]!.y).toBe(fpToPx(s.gy));
    // The sort key is where it STANDS, never where its awning is drawn — the rule every body
    // in this scene follows.
    expect(entities.children[0]!.zIndex).toBe(fpToPx(s.gy));
  });

  it('puts the mat in the GROUND layer, so an actor is always drawn over it', () => {
    const s = shop();
    const { ground, layer, state } = harness([s]);
    layer.update(state);
    expect(ground.children).toHaveLength(1);
    expect(ground.children[0]!.x).toBe(fpToPx(s.gx));
  });

  it('draws the mat at the range the SIM actually gates on', () => {
    // The assertion this file exists for. `ShopSystem.buy` refuses outside
    // `SHOP_INTERACT_RANGE_GRID`; the picture has to agree, or a player standing on a drawn
    // mat taps a row and nothing happens. Derived from the constant, so retuning the range
    // moves both at once and a hardcoded pixel radius here would fail.
    const { ground, layer, state } = harness([shop()]);
    layer.update(state);
    // Bounds, not a hardcoded pixel count: the mat is one ellipse, so its width is twice the
    // radius plus the 1.5px rim stroke. Asserted as a tight band around the derived figure so
    // that retuning `SHOP_INTERACT_RANGE_GRID` moves both the sim and this together, while a
    // mat drawn at some unrelated size still fails.
    const want = SHOP_INTERACT_RANGE_GRID * 32 * 2;
    expect((ground.children[0] as Graphics).bounds.width).toBeGreaterThanOrEqual(want);
    expect((ground.children[0] as Graphics).bounds.width).toBeLessThanOrEqual(want + 4);
  });

  it('draws the mat flatter than it is wide — it lies in the floor, not on it', () => {
    const { ground, layer, state } = harness([shop()]);
    layer.update(state);
    const g = ground.children[0] as Graphics;
    expect(g.bounds.height).toBeLessThan(g.bounds.width);
  });

  it('reuses the same counter across frames instead of rebuilding it', () => {
    const { entities, layer, state } = harness([shop()]);
    layer.update(state);
    const first = entities.children[0];
    layer.update(state);
    expect(entities.children[0]).toBe(first);
  });
});

describe('ShopLayer — the one state a shop has', () => {
  it('redraws the mat when the last line sells, and not before', () => {
    // A cleared-out counter has to look different from one you have not reached. Asserted as a
    // change in the drawn alpha rather than "it redrew", because a redraw that produced the
    // same picture would be indistinguishable from no redraw at all to a player.
    const s = shop({ stock: [offer({ id: 1 }), offer({ id: 2 })] });
    const { ground, layer, state } = harness([s]);
    layer.update(state);
    const open = fillAlphas(ground.children[0] as Graphics);
    expect(open.length).toBeGreaterThan(0); // the control: a mat with no fill would pass below

    s.stock[0]!.sold = true;
    layer.update(state);
    expect(fillAlphas(ground.children[0] as Graphics)).toEqual(open); // ONE line sold is not sold out

    s.stock[1]!.sold = true;
    layer.update(state);
    expect(fillAlphas(ground.children[0] as Graphics)).not.toEqual(open);
  });
});

describe('ShopLayer — teardown', () => {
  it('removes both containers when a shop leaves the state', () => {
    const { entities, ground, layer, state } = harness([shop()]);
    layer.update(state);
    (state.shops as Shop[]).length = 0;
    layer.update(state);
    expect(entities.children).toHaveLength(0);
    expect(ground.children).toHaveLength(0);
  });

  it('clear() drops everything — the run reset does not sweep these two layers', () => {
    const { entities, ground, layer, state } = harness([shop(), shop({ id: 2 })]);
    layer.update(state);
    expect(entities.children).toHaveLength(2);
    layer.clear();
    expect(entities.children).toHaveLength(0);
    expect(ground.children).toHaveLength(0);
  });

  it('survives the GROUND layer being swept out from under it', () => {
    // `RoomBuilder.build` destroys every child of `layers.ground` on its first line, and a door
    // unlocking triggers one. This layer found that the hard way — it threw on a destroyed
    // container's null `position` — where `ChestLayer` had been failing silently at it for a
    // version. Asserted on the mat being REBUILT, not merely on "no throw": a guard that
    // swallowed the destroyed view without replacing it would pass a crash test while leaving
    // the range gate invisible, which is the whole thing the mat is for.
    const { ground, layer, state } = harness([shop()]);
    layer.update(state);

    for (const c of [...ground.children]) c.destroy(); // what RoomBuilder.build does
    layer.update(state);

    expect(ground.children).toHaveLength(1);
    expect(ground.children[0]!.destroyed).toBe(false);
    expect((ground.children[0] as Graphics).bounds.width).toBeGreaterThan(0);
  });
});
