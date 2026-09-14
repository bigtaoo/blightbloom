// Shop rendering (design/05 "Shops", ENGINE_VERSION 64) — the drawn half of `GameState.shops`.
//
// Shaped like `ChestLayer` next door, and for the same reason: one controller diffing its own
// map against the sim's array each frame, rather than an `Entity` in `Scene`'s `views`. A shop
// draws into TWO layers at once — a counter body that Y-sorts among the actors
// (`layers.entities`) and a flat "stand here" mat that every actor must be drawn over
// (`layers.ground`) — and a single `Entity` has one position and one layer.
//
// ## No art yet, deliberately
//
// The same staged rollout every object in this room went through: walls, pillars, doors, drops,
// props and chests each shipped a Graphics form first and grew a sprite later. The shapes below
// are the drawn form for now, not a fallback waiting on a file.
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
import { Container, Graphics } from 'pixi.js';
import { SHOP_INTERACT_RANGE_GRID, type GameState, type Shop } from '@dd/engine';
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
/** The interaction mat's radius in world px, derived from the SIM's own gate rather than
 *  chosen. `coords.ts` has no grid→px helper (the sim speaks Fp), and one grid is 32 px here,
 *  the same conversion `ChestLayer`'s PLATE_RADIUS_PX makes. */
const MAT_RADIUS_PX = SHOP_INTERACT_RANGE_GRID * 32;

const COUNTER_FILL = 0x3f4d63; // cool slate — deliberately NOT the chest's warm timber
const COUNTER_TOP = 0x7e8db0; // the lit upper edge
const AWNING = 0xc05a4a; // one warm accent, so a counter is findable in a fire-lit room

interface ShopView {
  body: Container;
  mat: Graphics;
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
      if (v && (v.mat.destroyed || v.body.destroyed)) {
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

  /** Destroy one view's two containers, each only if something else has not already done it —
   *  which `RoomBuilder.build` routinely has, for the mat (see `update`). */
  private dispose(v: ShopView): void {
    if (!v.body.destroyed) v.body.destroy({ children: true });
    if (!v.mat.destroyed) v.mat.destroy({ children: true });
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
    const h = BODY_HALF * 2 * BODY_ASPECT;
    // The counter: a slab with a lit top edge, drawn from its base so it sits ON the ground
    // point rather than centred on it (every body in this scene is anchored at the feet).
    g.rect(-BODY_HALF, -h, BODY_HALF * 2, h).fill({ color: COUNTER_FILL });
    g.rect(-BODY_HALF, -h, BODY_HALF * 2, 3).fill({ color: COUNTER_TOP });
    // The awning: one warm triangle above the slab. Form AND colour differ from a chest
    // (design/13's dual-channel rule), so the two props never have to be told apart by hue.
    g.poly([-BODY_HALF - 2, -h - 2, BODY_HALF + 2, -h - 2, 0, -h - 11]).fill({ color: AWNING });
    body.addChild(g);

    return { body, mat, drawnSoldOut: null };
  }

  private sync(shop: Shop, v: ShopView): void {
    const x = fpToPx(shop.gx);
    const y = fpToPx(shop.gy);
    v.body.position.set(x, y);
    // Y-sort among the actors by the same rule every other body here uses: the ground point.
    v.body.zIndex = y;
    v.mat.position.set(x, y);

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
