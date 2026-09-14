/**
 * Shop rendering (design/05 "Shops", ENGINE_VERSION 64; shopkeeper 2026-09-14).
 *
 * The same four properties `ChestLayer.test.ts` next door pins, for the same reason — each
 * would fail silently in a live frame and nothing else in the repo would notice — plus one this
 * prop has and a chest does not: the **mat is the range gate made visible**, so its radius has
 * to be derived from the constant `ShopSystem` actually refuses purchases on. A mat drawn at
 * some other size is a promise the sim does not keep, and no engine test can see it.
 *
 * The last block covers the SHOPKEEPER, which is art-only and has no engine half at all: the
 * purchase verb is unchanged, so nothing in `@dd/engine` can fail if the keeper is wrong. That
 * is exactly why it is pinned here rather than left to a frame nobody screenshots — placement,
 * sort order and the missing-texture path are the whole feature. The keeper's measurements
 * against the real FILE live one door over in `npcArt.test.ts`; the texture here is a
 * dimensioned stand-in so the two failure modes stay separable.
 */
import { describe, it, expect, vi } from 'vitest';
import { Container, Graphics, Texture, TextureSource, type Sprite } from 'pixi.js';
import { SHOP_INTERACT_RANGE_GRID, type GameState, type Shop, type ShopOffer } from '@dd/engine';
import { COUNTER_HEIGHT_PX, KEEPER_BACK_PX, KEEPER_WIDTH_PX, ShopLayer } from './ShopLayer';
import { fpToPx } from '../coords';

// `render/environmentSprites.ts` is mocked so BOTH keeper paths are reachable under vitest,
// and defaults to "nothing loaded" so every test above the keeper block keeps exercising the
// counter-only room — the same convention `Portal.test.ts`/`Pickup.test.ts` use.
const mocks = vi.hoisted(() => ({ keeperTexture: undefined as Texture | undefined }));

vi.mock('../../render/environmentSprites', () => ({
  getShopkeeperTexture: () => mocks.keeperTexture,
}));

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

describe('ShopLayer — the shopkeeper (design/05 "Shops", 2026-09-14)', () => {
  /** The shipped file's real dimensions (`client/public/environment/npc_shopkeeper.png`).
   *  Deliberately not square and deliberately not round: the drawn HEIGHT is derived from
   *  the art's own aspect, and a square stand-in would hide that arithmetic entirely —
   *  every assertion below about the keeper's height would pass on a bug. */
  function keeperTex(width = 298, height = 320): Texture {
    return new Texture({ source: new TextureSource({ width, height }) });
  }

  function withKeeper<T>(tex: Texture | undefined, run: () => T): T {
    mocks.keeperTexture = tex;
    try {
      return run();
    } finally {
      mocks.keeperTexture = undefined;
    }
  }

  const keeperOf = (entities: Container) => entities.children[1]!;
  const spriteOf = (entities: Container) => (keeperOf(entities) as Container).children[1] as unknown as Sprite;

  it('draws NO keeper at all when the texture has not loaded — and leaves the counter alone', () => {
    // The whole graceful-degradation claim, stated as the thing a player would see: a shop
    // with no art is the room design/05 already described, not a room with a hole in it.
    // There is no Graphics fallback behind this sprite on purpose (see the file header), so
    // "the counter is untouched" is the only correct behaviour and has to be pinned — a
    // half-built keeper container would satisfy a bare "does not throw".
    const { entities, layer, state } = harness([shop()]);
    layer.update(state);
    expect(entities.children).toHaveLength(1);
    expect((entities.children[0] as Container).children.length).toBeGreaterThan(0);
  });

  it('stands NORTH of the counter and sorts BEHIND it', () => {
    withKeeper(keeperTex(), () => {
      const s = shop();
      const { entities, layer, state } = harness([s]);
      layer.update(state);

      expect(entities.children).toHaveLength(2);
      const keeper = keeperOf(entities);
      expect(keeper.x).toBe(fpToPx(s.gx));
      expect(keeper.y).toBe(fpToPx(s.gy) - KEEPER_BACK_PX);
      // Its OWN ground point is the sort key, not the counter's — which is what puts the slab
      // in front of its base, and what lets an actor standing in the gap between the two sort
      // correctly against both. A keeper parented to `body` would pass a position check and
      // fail this one.
      expect(keeper.zIndex).toBeLessThan(entities.children[0]!.zIndex);
      expect(keeper.zIndex).toBe(fpToPx(s.gy) - KEEPER_BACK_PX);
    });
  });

  it('is scaled by WIDTH, letting the art set its own height', () => {
    // The rule every sprite in this scene follows. Asserted against a NON-square texture so
    // that a height wrongly taken from the width still fails: 298x320 derives 30.07, and the
    // 28 a square file would give is the bug this catches.
    withKeeper(keeperTex(), () => {
      const { entities, layer, state } = harness([shop()]);
      layer.update(state);
      const sprite = spriteOf(entities);
      expect(sprite.width).toBeCloseTo(KEEPER_WIDTH_PX, 5);
      expect(sprite.height).toBeCloseTo(KEEPER_WIDTH_PX * (320 / 298), 5);
      // Bottom-anchored on its ground point, like every other body in this scene.
      expect(sprite.anchor.y).toBe(1);
    });
  });

  it('re-proportions itself when the art file does, rather than holding a baked height', () => {
    // The control for the test above: if the height were a constant, both aspects would draw
    // the same sprite and the assertion above would be pinning nothing.
    withKeeper(keeperTex(298, 640), () => {
      const { entities, layer, state } = harness([shop()]);
      layer.update(state);
      expect(spriteOf(entities).height).toBeCloseTo(KEEPER_WIDTH_PX * (640 / 298), 5);
    });
  });

  it('clears the awning, so the person is visible rather than filed behind the furniture', () => {
    // The one composition property that art alone can break. The keeper stands `KEEPER_BACK_PX`
    // north and rises by its own aspect; the counter's awning apex is the highest thing the
    // counter draws. If a replacement file came back much wider than tall, the keeper's head
    // would sink behind that triangle and the room would read as a counter with a shoulder
    // behind it. Measured off the real Pixi bounds rather than restated arithmetic.
    withKeeper(keeperTex(), () => {
      const { entities, layer, state } = harness([shop()]);
      layer.update(state);
      const counterTop = entities.children[0]!.getBounds().top;
      const keeperTop = keeperOf(entities).getBounds().top;
      expect(keeperTop).toBeLessThan(counterTop);
    });
  });

  it('grows a keeper on a counter that was built before the texture arrived', () => {
    // `preloadEnvironmentSprites()` is awaited at the run gate, so in practice a shop is never
    // created ahead of it — but a view is only rebuilt when something destroys it, so a
    // create()-only keeper would have left THAT shop keeperless for its whole floor. Cheap to
    // make impossible; impossible to notice if it ever happened.
    const { entities, layer, state } = harness([shop()]);
    layer.update(state);
    expect(entities.children).toHaveLength(1);

    withKeeper(keeperTex(), () => {
      layer.update(state);
      expect(entities.children).toHaveLength(2);
      expect(keeperOf(entities).y).toBe(fpToPx(shop().gy) - KEEPER_BACK_PX);
    });
  });

  it('takes the keeper with it when the shop leaves, and on clear()', () => {
    withKeeper(keeperTex(), () => {
      const { entities, layer, state } = harness([shop()]);
      layer.update(state);
      expect(entities.children).toHaveLength(2);
      (state.shops as Shop[]).length = 0;
      layer.update(state);
      expect(entities.children).toHaveLength(0);
    });

    withKeeper(keeperTex(), () => {
      const { entities, layer, state } = harness([shop()]);
      layer.update(state);
      layer.clear();
      expect(entities.children).toHaveLength(0);
    });
  });

  it('reuses the same keeper across frames instead of rebuilding it', () => {
    // `sync` resolves the texture EVERY frame (so a counter built before the preload finished
    // still grows a keeper), and the whole cost of that is one `??=`. Written as `=` it rebuilds
    // the container and adds a fresh child to the entity layer sixty times a second — a leak
    // with no visible symptom, since each new keeper is drawn exactly where the last one was.
    //
    // Found by mutation: `??=` → `=` survived the entire suite, because the sibling test above
    // only ever checked `children[0]`, the counter. Both halves are asserted here — the same
    // OBJECT, and no growth in the layer — because identity alone would still pass if a rebuilt
    // keeper happened to be reused, and a length check alone would pass if the old one were
    // removed and replaced.
    withKeeper(keeperTex(), () => {
      const { entities, layer, state } = harness([shop()]);
      layer.update(state);
      const first = keeperOf(entities);
      layer.update(state);
      layer.update(state);
      expect(keeperOf(entities)).toBe(first);
      expect(entities.children).toHaveLength(2);
    });
  });

  it('stands close enough that the counter SLAB crosses its base', () => {
    // What `KEEPER_BACK_PX` is actually for, and the thing every other test here was blind to:
    // they all derive their expectations from the imported constant, so DOUBLING it survived the
    // whole suite. The claim is a relation, not a number — at 0 the merchant stands inside the
    // counter, and at `COUNTER_HEIGHT_PX` or beyond its base clears the slab's top edge and it
    // floats behind the furniture instead of standing at it.
    expect(KEEPER_BACK_PX).toBeGreaterThan(0);
    expect(KEEPER_BACK_PX).toBeLessThan(COUNTER_HEIGHT_PX);

    // ...and the same statement made against what is actually drawn, so a keeper that stopped
    // being positioned from this constant at all would still fail.
    withKeeper(keeperTex(), () => {
      const s = shop();
      const { entities, layer, state } = harness([s]);
      layer.update(state);
      const groundY = fpToPx(s.gy);
      const keeperBase = keeperOf(entities).y;
      expect(keeperBase).toBeLessThan(groundY); // north of the counter's own ground point
      expect(keeperBase).toBeGreaterThan(groundY - COUNTER_HEIGHT_PX); // ...but below the slab's top
    });
  });

  it('rebuilds after the COUNTER is destroyed out from under it, keeper and all', () => {
    // The mat's exposure to `RoomBuilder.build` has a test; the body's did not, and the guard
    // covers all three. Asserted on the whole view coming back rather than on "no throw",
    // because the keeper is a child of neither the body nor the mat: a rebuild that restored
    // two of the three would leave the merchant behind as an orphan in the entity layer, which
    // reads on screen as a person standing at no counter.
    withKeeper(keeperTex(), () => {
      const { entities, ground, layer, state } = harness([shop()]);
      layer.update(state);
      entities.children[0]!.destroy(); // the counter; `create()` adds it before the keeper
      layer.update(state);

      expect(entities.children).toHaveLength(2);
      expect(ground.children).toHaveLength(1);
      for (const c of entities.children) expect(c.destroyed).toBe(false);
      expect(ground.children[0]!.destroyed).toBe(false);
    });
  });

  it('rebuilds after the keeper is destroyed out from under it', () => {
    // Same exposure the mat has to `RoomBuilder.build`, one layer over: the keeper lives in
    // `layers.entities` and is no more the owner of that container than the mat is of
    // `layers.ground`. Asserted on a live REBUILD, because a guard that dropped the destroyed
    // keeper without replacing it would pass a crash test and quietly empty the room.
    withKeeper(keeperTex(), () => {
      const { entities, layer, state } = harness([shop()]);
      layer.update(state);
      keeperOf(entities).destroy();
      layer.update(state);
      expect(entities.children).toHaveLength(2);
      expect(keeperOf(entities).destroyed).toBe(false);
      expect(spriteOf(entities).width).toBeCloseTo(KEEPER_WIDTH_PX, 5);
    });
  });
});
