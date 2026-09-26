import { Container } from 'pixi.js';
import { MenuLayer } from '../ui/menuLayer';

// Render layers (see design/01-rendering.md).
// The world layer pans with the camera; the ui layer is fixed.
export class Layers {
  readonly root = new Container();
  readonly world = new Container();

  // Full-viewport backdrop (Backdrop.ts, design/10 legibility fix 2026-08-02) — screen
  // space like `ui`, NOT a child of `world`, so it never scales/pans with the camera and
  // always covers whatever black void a small zoomed-to-fit room would otherwise leave.
  // Added to `root` before `world` so it always paints behind everything else.
  readonly backdrop = new Container();

  // Everything the one scene-lighting pass shades (`SceneLightFilter`, attached by
  // `FxController.attach`): the floor, the ground shadows, and the Y-sorted entity set.
  // Deliberately NOT `fx` (muzzle flashes and particles ARE light — shading them would dim
  // the very thing casting the light, and that layer carries its own bloom-lite blur) and
  // NOT `hud` (a floating health bar is a readout riding in world space, not a surface).
  // Introduced 2026-08-24 when lighting moved off the individual actors — see litFx.ts.
  readonly lit = new Container();

  // The void's FAR SIDE (Terrain.ts, 2026-08-28) — the ground beyond the wall, in WORLD space so
  // it pans and zooms with everything else, but a SIBLING of `lit` rather than a child of it, so
  // `SceneLightFilter` never shades it. That placement is the point: the 2026-08-27 frame that
  // closed the camera list found much of what read as "the void" was the light pass darkening what
  // lay beyond, so putting this plane inside `lit` would hand it back to the pass that was
  // blacking that area out. Added to `world` before `lit`, so floor and stone paint over it and
  // what still shows through is exactly the void.
  readonly terrain = new Container();

  readonly ground = new Container();
  readonly shadow = new Container();
  readonly entities = new Container(); // Y-sort
  readonly fx = new Container();
  // World-space, always-on-top, never blurred (unlike `fx`, which carries a permanent
  // bloom-lite BlurFilter for muzzle flashes/trails — see FxController.attach). The one thing
  // that needs both properties at once is a floating health bar: it has to pan/zoom with the
  // camera like everything else in `world`, but must never be visually buried behind a standing
  // wall the occlusion x-ray only PARTIALLY fades (design/01 "Limits of fake 3D" — a health bar
  // is a HUD readout riding in world space, not a body part; it should never share the body's
  // "reads through translucent stone" treatment, which stays legible for a near-white body but
  // washes out the bar's own dark contour/track, live report *"血条被墙挡住了"*). Drawn after
  // every other `world` child but `numbers`, so it is unconditionally in front of every wall/pillar/door/actor.
  readonly hud = new Container();
  // Floating damage numbers (`fx/DamageNumbers.ts`, design/10). World-space and never blurred for
  // the same reasons as `hud`, and above it so a number rising off a target is never cut by that
  // target's own health bar. A layer of its own rather than children of `hud`: numbers come and
  // go on every hit, and `hud` is a render group precisely because it almost never changes — one
  // number spawning inside it would rebuild every health bar's instructions with it.
  readonly numbers = new Container();
  readonly ui = new Container();

  // `ui` splits into exactly three screen-space sub-layers, in this paint order:
  //
  //  hudOverlay — the in-run HUD + touch controls (Game.buildHud's `hudView`). NOT the
  //    `hud` layer above: that one is world-space floating health bars, this one is
  //    fixed to the viewport. Stays UNSCALED — a thumbstick should be thumb-sized on a
  //    phone, not shrunk with the menus.
  //  menu — every full-screen menu/overlay + the forge's SETTINGS button. On its own
  //    container because that container carries a transform: MenuLayer.fit() scales it
  //    down on viewports shorter than the menus' design size (a WeChat landscape phone
  //    is 390 logical px tall — see ui/menuLayer.ts).
  //
  // Menus paint OVER the HUD (that is why the pause menu is legible mid-run), which is
  // the pre-split order: `Game.buildHud()` runs before the menu screens are added, so
  // `hudView` was always the lower of the two. Pinning it here as two named containers
  // makes that an invariant of the layer tree instead of an add-order accident.
  readonly hudOverlay = new Container();
  readonly menu = new MenuLayer();

  // ...and one more above both, added 2026-09-01 with the asset phases (design/12): the art
  // progress screen the run gate puts up (`ui/loadingScreen.ts`, via
  // `controllers/TransitionGate.ts`). It has to be its own layer for the same reason the split above
  // exists — a full-screen wait mounted into `menu` would paint UNDER whichever screen's own
  // full-viewport Panel was already up, which is exactly how the forge's SETTINGS button spent
  // months invisible. Unscaled like `hudOverlay`: a spinner is not menu content, and it must be
  // the same physical size on a 390 px-tall phone as on a desktop window.
  //
  // Empty in almost every frame of a session. While it is not, its spinner redraws each frame
  // and so invalidates `ui`'s render group — which is fine for the second or two a gate lasts,
  // and is why nothing here gets a render group of its own.
  readonly overlay = new Container();

  constructor() {
    // entities are sorted by zIndex (= gy) for top-down depth occlusion
    this.entities.sortableChildren = true;

    this.lit.addChild(this.ground, this.shadow, this.entities);
    this.world.addChild(this.terrain, this.lit, this.fx, this.hud, this.numbers);
    this.root.addChild(this.backdrop, this.world, this.ui);
    this.ui.addChild(this.hudOverlay, this.menu, this.overlay);

    // Own render group per structurally-STATIC layer (2026-08-24 draw-call pass).
    //
    // A Pixi v8 render group caches its instruction set — the flattened list of "add this
    // renderable to the batch, break here, draw this on its own" — and rebuilds it only when its
    // own contents change. Writing any descendant's `zIndex` invalidates it
    // (`sortMixin.depthOfChildModified` -> `structureDidChange`), and `entities` is a layer whose
    // whole purpose is that every actor writes a `zIndex` every frame. Before this split there was
    // ONE group for all of `root`, so those per-actor writes threw away the cached instructions for
    // the floor, the ground shadows, the health bars and the whole UI as well, and all of it was
    // re-collected 60 times a second: 168 Graphics re-added per frame, of which 54 belonged to
    // layers that had not changed since the room loaded.
    //
    // The layers below either never change during a room (`ground`) or change only when an entity
    // spawns/dies (`shadow`, `hud`) or on a phase/resize (`ui`, `backdrop`) — all of which still
    // invalidate their own group correctly, just not once per frame. Measured on the level-1 start
    // room, 8 live enemies: 168 -> 114 re-adds, render collection 0.60 -> 0.52 ms, and it is what
    // makes `staticGraphics()` affordable on `ground`/`shadow` (see that module).
    //
    // NOT `entities` (rebuilt every frame by design — a group there would buy nothing and add a
    // batch boundary), NOT `fx` (particles are added and removed constantly, plus it carries a
    // blur filter), and NOT `lit`/`world` (they hold `entities`, so they inherit its churn).
    for (const layer of [this.ground, this.shadow, this.hud, this.ui, this.backdrop]) {
      layer.enableRenderGroup();
    }
  }
}
