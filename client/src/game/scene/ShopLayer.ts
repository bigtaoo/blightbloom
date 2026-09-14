// Shop rendering (design/05 "Shops", ENGINE_VERSION 64) — the drawn half of `GameState.shops`.
//
// Shaped like `ChestLayer` next door, and for the same reason: one controller diffing its own
// map against the sim's array each frame, rather than an `Entity` in `Scene`'s `views`. A shop
// draws into TWO layers at once — a counter body that Y-sorts among the actors
// (`layers.entities`) and a flat "stand here" mat that every actor must be drawn over
// (`layers.ground`) — and a single `Entity` has one position and one layer.
//
// ## No art for the COUNTER yet, deliberately — but there is now a person behind it
//
// The same staged rollout every object in this room went through: walls, pillars, doors, drops,
// props and chests each shipped a Graphics form first and grew a sprite later. The counter shapes
// below are the drawn form for now, not a fallback waiting on a file.
//
// The SHOPKEEPER (2026-09-14) is the exception, and deliberately the other way round: it exists
// only as art. The owner's *"商店是通过房间里的 npc 打开的"* said a shop should be a person, and
// this pass answered the half of that which is not a design change — a room with a merchant
// standing in it — while leaving the VERB exactly where design/05 "The gesture is a tap on a row"
// put it. Nothing here touches `@dd/engine`: the panel still opens on `SHOP_INTERACT_RANGE_GRID`
// proximity (`ui/shopProximity.ts`) and `ShopSystem` still refuses a purchase by the same
// distance, so there is no `ENGINE_VERSION` bump and no replay behind this file.
//
// Which is also why the keeper has no Graphics form. Every other object here drew itself before
// its art landed, because a room with a hole where a wall goes is unplayable; a room with no
// merchant is just the room design/05 already described. A procedural stand-in for a CHARACTER
// would be a second authored design of one — and design/13 keeps exactly one body plan.
//
// ## What the mat is for, and why it is not decoration
//
// `ShopSystem` refuses a purchase from outside `SHOP_INTERACT_RANGE_GRID`, and a refusal the
// player cannot predict reads as a broken button. So the mat is drawn at exactly that radius,
// converted from the same constant the sim gates on — the reasoning `ChestLayer`'s plates are
// built on ("am I standing on it" answered by the picture rather than guessed), applied to the
// one prop whose range gate is invisible. Stand on the mat, the panel is live.
//
// The mat also dims once every line is sold, which is the only state a shop has: a counter you
// have cleared out looks different from one you have not reached yet, without needing text.
import { Container, Graphics, Sprite } from 'pixi.js';
import { SHOP_INTERACT_RANGE_GRID, type GameState, type Shop } from '@dd/engine';
import { getShopkeeperTexture } from '../../render/environmentSprites';
import { fpToPx } from '../coords';
import { THEME } from '../theme';
import { SHADOW_SQUASH } from './Entity';

/** Half-width of the counter body, world px. Between a small and a big chest: a shop is
 *  furniture you walk up to, and it has to read from across a room without competing with the
 *  big chest's ring for attention. */
const BODY_HALF = 12;
/** A counter is wider than it is tall in this tilted view — the same foreshortening every
 *  ground-plane object in this scene gets. */
const BODY_ASPECT = 0.75;
/** The slab's drawn height above its ground point, world px. Exported for the reason
 *  `propRender` exports its metrics: `KEEPER_BACK_PX` below is only meaningful RELATIVE to it
 *  (the slab has to cross the keeper's base, or the merchant stops reading as standing behind
 *  a counter), and a test cannot state that against a number locked inside `create()`. */
export const COUNTER_HEIGHT_PX = BODY_HALF * 2 * BODY_ASPECT;
/** The interaction mat's radius in world px, derived from the SIM's own gate rather than
 *  chosen. `coords.ts` has no grid→px helper (the sim speaks Fp), and one grid is 32 px here,
 *  the same conversion `ChestLayer`'s PLATE_RADIUS_PX makes. */
const MAT_RADIUS_PX = SHOP_INTERACT_RANGE_GRID * 32;

const COUNTER_FILL = 0x3f4d63; // cool slate — deliberately NOT the chest's warm timber
const COUNTER_TOP = 0x7e8db0; // the lit upper edge
const AWNING = 0xc05a4a; // one warm accent, so a counter is findable in a fire-lit room

/** How far NORTH of the counter's own ground point the shopkeeper stands, world px.
 *  Derived, not picked: it is exactly **half `COUNTER_HEIGHT_PX`**, which is this projection's
 *  reading of how deep the counter is — so the keeper stands one counter-depth behind it, and
 *  the slab crosses the bottom of its silhouette the way a real counter crosses a vendor.
 *  Retuning the counter's size moves the keeper with it instead of leaving it embedded in the
 *  furniture or floating off it.
 *
 *  **The relation is the load-bearing part, not the number**, and `0 < KEEPER_BACK_PX <
 *  COUNTER_HEIGHT_PX` is what a test can hold: at 0 the merchant stands *in* the counter, and
 *  at `COUNTER_HEIGHT_PX` or beyond its base clears the slab's top edge and it floats behind
 *  the furniture instead of standing at it. Doubling this used to survive the whole suite. */
export const KEEPER_BACK_PX = COUNTER_HEIGHT_PX / 2;
/** The keeper's drawn width, world px — the art brief's own stated display size
 *  ("displayed in game at about 28 pixels wide", `art/npc/prompts.md`), which is what its
 *  silhouette and its no-detail-finer-than-a-sixth rule were drawn against. It sits just
 *  under a player's 32 px drawn body (`PLAYER_BASE.radius` × 2, design/12): a shopkeeper
 *  reads as a person of the same world, without out-sizing the player standing at it.
 *  Width, with the art's own aspect setting the height — the rule every sprite in this
 *  scene follows (`buildPropBody`, `buildPillarSprite`), because aspect is the art's to
 *  choose and a number here would silently re-proportion a replacement file.
 *
 *  Both keeper constants are exported for the reason `propRender` exports its metrics: so a
 *  test derives the drawn geometry instead of restating it, and retuning the counter cannot
 *  leave a passing test pinned to the old numbers. */
export const KEEPER_WIDTH_PX = 28;

interface ShopView {
  body: Container;
  mat: Graphics;
  /** The shopkeeper, or `null` while its texture has not loaded (or never will). Its own
   *  container rather than a child of `body`, because it has to Y-sort against the ACTORS
   *  on its own ground point — a child would inherit the counter's `zIndex` and a player
   *  walking through the gap between the two would sort against the wrong one of them. */
  keeper: Container | null;
  /** Last drawn "everything sold" state, so the mat is only redrawn when it changes rather
   *  than every frame — the same redraw-on-key-change convention the rest of this layer and
   *  `WeaponPickupPrompt` follow. `null` is the sentinel that forces the first draw. */
  drawnSoldOut: boolean | null;
}

export class ShopLayer {
  private readonly views = new Map<number, ShopView>();

  /**
   * @param entities the Y-sorted actor layer — the counter goes here, so it occludes and is
   *        occluded exactly like an actor.
   * @param ground the flat decal layer — the mat goes here, so a player standing on it is
   *        always drawn over it.
   */
  constructor(
    private readonly entities: Container,
    private readonly ground: Container,
  ) {}

  update(state: GameState): void {
    const seen = new Set<number>();
    for (const shop of state.shops) {
      seen.add(shop.id);
      let v = this.views.get(shop.id);
      // **`RoomBuilder.build` destroys every child of `layers.ground`** (its own first line),
      // so the mat below is torn out from under this map on every room rebuild — a door
      // unlocking is enough. The view is rebuilt rather than patched, because a destroyed Pixi
      // object nulls its own `position` and there is nothing left to reattach. Found by this
      // layer crashing on it; `ChestLayer` has the same exposure and takes the same guard.
      if (v && (v.mat.destroyed || v.body.destroyed || v.keeper?.destroyed === true)) {
        this.dispose(v);
        v = undefined;
      }
      if (!v) {
        v = this.create();
        this.views.set(shop.id, v);
      }
      this.sync(shop, v);
    }
    for (const [id, v] of this.views) {
      if (seen.has(id)) continue;
      this.dispose(v);
      this.views.delete(id);
    }
  }

  /** Drop every view. Called when a match ends — the containers belong to layers this class
   *  does not own, so leaving children behind would leak a floor's shops into the next run. */
  clear(): void {
    for (const v of this.views.values()) this.dispose(v);
    this.views.clear();
  }

  /** Destroy one view's containers, each only if something else has not already done it —
   *  which `RoomBuilder.build` routinely has, for the mat (see `update`).
   *
   *  It does NOT null the fields afterwards. A `v.keeper = null` here read as defensive and was
   *  unreachable: every caller discards the view in the same breath (the teardown loop deletes
   *  it, `clear()` empties the map, and the destroyed-guard in `update` sets `v = undefined`
   *  before rebuilding). A mutation battery is what said so — deleting that line survived the
   *  whole suite, because there is no frame in which anything reads the field again. */
  private dispose(v: ShopView): void {
    if (!v.body.destroyed) v.body.destroy({ children: true });
    if (!v.mat.destroyed) v.mat.destroy({ children: true });
    if (v.keeper && !v.keeper.destroyed) v.keeper.destroy({ children: true });
  }

  private create(): ShopView {
    const body = new Container();
    this.entities.addChild(body);
    const mat = new Graphics();
    this.ground.addChild(mat);

    const shadow = new Graphics();
    shadow.ellipse(0, 0, BODY_HALF, BODY_HALF * SHADOW_SQUASH).fill({ color: 0x000000, alpha: 0.28 });
    body.addChild(shadow);

    const g = new Graphics();
    const h = COUNTER_HEIGHT_PX;
    // The counter: a slab with a lit top edge, drawn from its base so it sits ON the ground
    // point rather than centred on it (every body in this scene is anchored at the feet).
    g.rect(-BODY_HALF, -h, BODY_HALF * 2, h).fill({ color: COUNTER_FILL });
    g.rect(-BODY_HALF, -h, BODY_HALF * 2, 3).fill({ color: COUNTER_TOP });
    // The awning: one warm triangle above the slab. Form AND colour differ from a chest
    // (design/13's dual-channel rule), so the two props never have to be told apart by hue.
    g.poly([-BODY_HALF - 2, -h - 2, BODY_HALF + 2, -h - 2, 0, -h - 11]).fill({ color: AWNING });
    body.addChild(g);

    return { body, mat, keeper: null, drawnSoldOut: null };
  }

  /** The shopkeeper: a bottom-anchored sprite on its own ground point, `KEEPER_BACK_PX`
   *  north of the counter's. Built the first frame its texture resolves rather than only in
   *  `create()`, so a counter that was assembled while `preloadEnvironmentSprites()` was
   *  still in flight still grows its keeper instead of going the whole run without one.
   *
   *  No tint. A prop takes `propTint(palette)` so it reads as part of THIS room; design/13
   *  reserves runtime re-tinting for the neutral-grey critter body and explicitly withholds
   *  it from anything carrying its own real colours, which a character does. */
  private createKeeper(): Container | null {
    const tex = getShopkeeperTexture();
    if (!tex) return null;
    const c = new Container();
    this.entities.addChild(c);

    const shadow = new Graphics();
    shadow
      .ellipse(0, 0, KEEPER_WIDTH_PX * 0.32, KEEPER_WIDTH_PX * 0.32 * SHADOW_SQUASH)
      .fill({ color: 0x000000, alpha: 0.28 });
    c.addChild(shadow);

    const sprite = new Sprite(tex);
    sprite.anchor.set(0.5, 1);
    sprite.setSize(KEEPER_WIDTH_PX, KEEPER_WIDTH_PX * (tex.height / tex.width));
    c.addChild(sprite);
    return c;
  }

  private sync(shop: Shop, v: ShopView): void {
    const x = fpToPx(shop.gx);
    const y = fpToPx(shop.gy);
    v.body.position.set(x, y);
    // Y-sort among the actors by the same rule every other body here uses: the ground point.
    v.body.zIndex = y;
    v.mat.position.set(x, y);

    v.keeper ??= this.createKeeper();
    if (v.keeper) {
      // North of the counter, and sorted on THAT point rather than on the counter's — which
      // is what puts the slab in front of the keeper's base, and what lets an actor standing
      // between the two draw correctly against both.
      v.keeper.position.set(x, y - KEEPER_BACK_PX);
      v.keeper.zIndex = y - KEEPER_BACK_PX;
    }

    const soldOut = shop.stock.every((o) => o.sold);
    if (soldOut === v.drawnSoldOut) return;
    v.drawnSoldOut = soldOut;
    v.mat.clear();
    // Squashed by the same factor every ground-plane circle in this scene is, so the mat reads
    // as lying flat rather than as a sphere seen from above.
    const alpha = soldOut ? 0.1 : 0.22;
    v.mat
      .ellipse(0, 0, MAT_RADIUS_PX, MAT_RADIUS_PX * SHADOW_SQUASH)
      .fill({ color: THEME.colors.pickupCoin, alpha })
      .ellipse(0, 0, MAT_RADIUS_PX, MAT_RADIUS_PX * SHADOW_SQUASH)
      .stroke({ color: THEME.colors.pickupCoin, width: 1.5, alpha: soldOut ? 0.25 : 0.6 });
  }
}
