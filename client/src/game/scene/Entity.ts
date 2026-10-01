import { Container, Graphics } from 'pixi.js';
import { THEME } from '../theme';
import { staticGraphics } from '../../render/staticGraphics';
import { writeSortKey } from './ySort';

/** Nested-ellipse ground shadow (see `makeShadow`): `SHADOW_RINGS` ellipses stepping evenly
 *  from `SHADOW_R_OUTER` down to `SHADOW_R_INNER` times the body radius. Because they
 *  composite, the total darkness ramps up toward the core.
 *
 *  Count raised from 4 and the per-ring alpha cut on 2026-08-18 after looking at a 7x live
 *  render: four rings at 0.08/0.12/0.16/0.22 left four VISIBLE concentric edges under the
 *  character, which reads as a ripple or a targeting reticle rather than as a penumbra. Many
 *  faint rings is the same trick at a step size small enough to disappear.
 *
 *  Retuned again 2026-08-19 (measured pass) for the enemy shadows, which read as black
 *  DINNER PLATES the crystals sat in: 12 rings over a narrower 1.3..0.3 span, and the alpha
 *  RAMPED across the rings instead of held flat, so the outer edge (`SHADOW_ALPHA_OUTER`) is
 *  nearly invisible while the contact core still lands around 0.48. A flat per-ring alpha
 *  makes the outermost ring itself a visible hard edge, which is most of what made a shadow
 *  read as a disc rather than as a penumbra — the other half was its SIZE, see `makeShadow`. */
const SHADOW_RINGS = 12;
const SHADOW_R_OUTER = 1.15;
const SHADOW_R_INNER = 0.3;
const SHADOW_ALPHA_OUTER = 0.015;
const SHADOW_ALPHA_INNER = 0.1;
/** Exponent on the alpha ramp. Linear still spread the darkness fairly evenly across the whole
 *  disc, so a shadow read as a flat dark plate with a soft rim rather than as a pool with a
 *  contact point — visible in a 4x render of a grounded enemy, whose art sits ABOVE the ground
 *  point so the shadow's near half is the part you actually see. Squaring concentrates the
 *  darkness into the inner third and leaves the outer half nearly transparent. */
const SHADOW_ALPHA_CURVE = 2;

/** Vertical foreshortening of everything round that lies ON THE GROUND PLANE in this
 *  tilted view (design/01): this shadow and `Actor.setStatus`'s auras, which are flat
 *  discs at the actor's feet and so are compressed by the camera tilt. Shared between them
 *  so they cannot drift apart.
 *
 *  `EnergyShieldFilter` does NOT use it — a shield is a sphere around the body, not a disc
 *  under it — but note that this does not make it a CIRCLE, which is what the 2026-08-24
 *  version of this comment concluded ("a sphere reads as a circle from every angle") and what
 *  the shell was until 2026-08-27. That is true of a real camera and this renderer is not one:
 *  the world grid is drawn unsquashed while wall heights are extruded 1:1 upward in px, i.e.
 *  the shear (x, y, z) -> (x, y - z), under which a sphere's silhouette is an ellipse with
 *  semi-axes 1 and sqrt(2). The shell is taller than wide now — `SHELL_ASPECT` in
 *  `fx/filters/shieldFx.ts`, which owns that reasoning; this constant and that one are the two
 *  halves of how round things read here, and the contrast between them is the point: squashed
 *  = lying on the ground, taller = standing in the world. */
export const SHADOW_SQUASH = 0.62;

/** How much a shadow slides away from the key light per world px of height. The key light
 *  is fixed "upper-left" (`NormalLitFilter`'s KEY_DIR, `RoomBuilder`'s pillar banding), so
 *  shadows fall to the lower RIGHT — and further in x than in y, because the view is
 *  tilted. Same two numbers `scene/wallRender.ts` casts a wall's shadow with. */
export const SHADOW_SLANT_X = 0.42;
export const SHADOW_SLANT_Y = 0.22;

/** How fast a shadow shrinks/fades with height. Raised from 0.012 (2026-08-18): that value
 *  was tuned for a bullet's tens-of-px `z` and left the 4-7 px of an actor's hover at
 *  k = 0.95, i.e. invisible — which is the whole cue the hover exists to produce. Raised
 *  again 0.022 -> 0.04 (2026-08-19) alongside `Actor`'s bigger hover: over a 2.5..9.5 px bob
 *  that is now k = 0.91 down to 0.72, i.e. the shadow visibly tightens and fades as the body
 *  rises. The alternative — lifting the body further still — reads as flying rather than
 *  hovering, so the readability is bought here instead. */
const SHADOW_LIFT_FALLOFF = 0.04;

// Base view for all world objects. Stage D: this is a PURE view — it owns no
// gameplay state and decides no outcomes. The engine is authoritative; the render
// layer only reads engine state and draws it (design/06/08).
//
// Motion is double-buffered for interpolation: the sim advances at a fixed 30 Hz,
// but the screen redraws at display rate (~60 fps). Each sim tick the Scene pushes
// a fresh position (cur → prev, then cur = new); each render frame lerps between
// prev and cur by `alpha` so movement reads smooth despite the slower sim. Ground
// coords are world px; screen.y = y - z (height); zIndex = y for the Y-sort. Angles
// are NOT interpolated (design decision: take the current facing, no wrap wobble).
export class Entity extends Container {
  // Interpolation buffers (world px).
  prevX = 0;
  prevY = 0;
  prevZ = 0;
  curX = 0;
  curY = 0;
  curZ = 0;
  facingRad = 0; // aim/shot direction (weapon)
  bodyFacingRad = 0; // movement direction (body/legs) — see Actor's upper/lower split

  /**
   * Explicit idle/move cue for a caller whose own tick ALSO collapses prev onto cur
   * (`Scene.positionLocal`'s predicted-pose snap, ROADMAP 3.3) — `Actor.interpolate`'s
   * default heuristic (curX/prevX delta) reads as permanently stationary once prev==cur,
   * which is exactly what that snap does every render frame. `null` (the default, reset
   * on every `pushState()`) means "derive it from the buffer delta as usual" — the
   * correct signal for every entity driven the normal way (`Scene.reconcile`, never
   * snapped mid-motion).
   */
  movingOverride: boolean | null = null;

  shadow: Graphics | null = null;

  /**
   * The height (world px) this entity was last DRAWN at — `z + visualZ`, the exact lift
   * `applyTransform` folded into `this.y` on the most recent frame.
   *
   * Kept because screen `y` alone cannot be un-mixed: it is `groundY - lift`, and a caller
   * that needs one of those two back (`Actor.muzzleHeightPx`, so a bullet can be drawn at the
   * height the gun that fired it is drawn at) would otherwise have to re-derive the lift from
   * state that has already moved on. Written on every path that draws, so it is always this
   * frame's answer rather than a stale one.
   */
  drawnLift = 0;

  /**
   * Extra render-only height, added on top of the sim's `z` for BOTH the screen transform
   * and the shadow (2026-08-18 depth pass). This is where a hovering body's idle rise
   * lives: `z` itself comes from the engine and is 0 for every actor (design/01 "Actors
   * stay grounded... `z` never gates gameplay"), so a hover expressed through the rig's
   * own animation clip alone moved the ART but left the shadow pinned at full size —
   * the one cue that says "this thing is off the floor". Never read by the sim; `zIndex`
   * still comes from the ground coordinate alone, so lifting cannot reorder anything.
   */
  protected visualZ = 0;

  /**
   * Fixed world-px offset for this entity's shadow, on top of the height-driven one below.
   * For a STATIC tall object (a pillar) the height that displaces its shadow is the drawn
   * body's, not `z` — which is 0, because the body is drawn upward from a grounded origin
   * rather than lifted by the transform. `RoomBuilder` sets this so a pillar's shadow falls
   * away from the key light exactly as far as a same-height wall's cast shadow does.
   */
  shadowOffsetX = 0;
  shadowOffsetY = 0;

  /**
   * Create an elliptical soft shadow, added to the shadow layer by the caller.
   *
   * `radius` is the DRAWN body's half-width in world px, not a collision radius — see
   * `Actor`'s call site for why that distinction is the whole fix. Everything below is a
   * fraction of it, so a body whose art fills less of its rig than another's gets a
   * proportionally smaller shadow for free.
   *
   * Nested ellipses rather than one flat fill (2026-08-18 depth pass, user report
   * "希望能再强化一下立体效果"): a single uniform ellipse at alpha 0.35 reads as a die-cut disc
   * lying under the character, which is the opposite of the intended cue. Stacking many faint
   * rings from wide to small approximates a penumbra — the contact point reads dark and
   * definite while the outer edge falls off — using nothing but Graphics (a real blur would
   * mean a filter per actor, and a busy room has 30 of them). 0.62 vertical squash is this
   * project's one foreshortening constant, shared with the shield ring and the status auras.
   */
  makeShadow(radius: number): Graphics {
    // `staticGraphics`: SHADOW_RINGS nested ellipses is ~830 floats, well past Pixi's 400-float
    // auto-batch cutoff, so every shadow in the room was its own draw call. The rings are drawn
    // once here and the shadow only ever moves after that, and `layers.shadow` — where the caller
    // mounts it — has its own render group, so batching costs one repack per move instead.
    const s = staticGraphics();
    for (let i = 0; i < SHADOW_RINGS; i++) {
      const t = i / (SHADOW_RINGS - 1);
      const scale = SHADOW_R_OUTER + (SHADOW_R_INNER - SHADOW_R_OUTER) * t;
      s.ellipse(0, 0, radius * scale, radius * scale * SHADOW_SQUASH).fill({
        color: THEME.colors.shadow,
        alpha: SHADOW_ALPHA_OUTER + (SHADOW_ALPHA_INNER - SHADOW_ALPHA_OUTER) * t ** SHADOW_ALPHA_CURVE,
      });
    }
    this.shadow = s;
    return s;
  }

  // One-shot static placement (pillars): no interpolation, drawn where it stands.
  place(x: number, y: number, z = 0): void {
    this.prevX = this.curX = x;
    this.prevY = this.curY = y;
    this.prevZ = this.curZ = z;
    this.applyTransform(x, y, z);
  }

  // Ingest one sim-tick position: shift cur → prev, then set the new cur. `bodyFacingRad`
  // defaults to `facingRad` for entities with no separate body orientation (enemies,
  // bullets, pickups) — only the player view (Scene.ts) ever passes a distinct one.
  pushState(x: number, y: number, z: number, facingRad: number, bodyFacingRad: number = facingRad): void {
    this.prevX = this.curX;
    this.prevY = this.curY;
    this.prevZ = this.curZ;
    this.curX = x;
    this.curY = y;
    this.curZ = z;
    this.facingRad = facingRad;
    this.bodyFacingRad = bodyFacingRad;
    this.movingOverride = null; // back to the default buffer-delta heuristic until told otherwise
  }

  // Collapse prev onto cur — call right after a view is created so it appears at
  // its spawn position instead of lerping in from (0,0).
  snap(): void {
    this.prevX = this.curX;
    this.prevY = this.curY;
    this.prevZ = this.curZ;
  }

  // Interpolated ground position (world px), for the camera to follow smoothly.
  interpGroundX(alpha: number): number {
    return this.prevX + (this.curX - this.prevX) * alpha;
  }
  interpGroundY(alpha: number): number {
    return this.prevY + (this.curY - this.prevY) * alpha;
  }

  // Render-frame interpolation. alpha ∈ [0,1) is the fraction into the current tick.
  interpolate(alpha: number, _frameDt: number): void {
    this.applyTransform(
      this.prevX + (this.curX - this.prevX) * alpha,
      this.prevY + (this.curY - this.prevY) * alpha,
      this.prevZ + (this.curZ - this.prevZ) * alpha,
    );
  }

  /** The last pose `applyTransform` was given, so `nudge` can redraw from it. */
  private posedX = 0;
  private posedY = 0;
  private posedZ = 0;

  /**
   * Redraw this frame's pose shifted by (`dx`, `dy`) world px — everything `applyTransform` places
   * (shadow, and a subclass's hand-synced parts such as `Actor`'s health bar) moves with it. Not
   * cumulative: a second call replaces the first, and the next `interpolate`/`place` clears it.
   * `FxController.updateCamera` uses it on the followed player to cancel the camera's whole-pixel
   * rounding, so the one thing the eye tracks keeps its exact, unrounded screen position.
   */
  nudge(dx: number, dy: number): void {
    const { posedX: x, posedY: y, posedZ: z } = this;
    this.applyTransform(x + dx, y + dy, z);
    this.posedX = x;
    this.posedY = y;
  }

  // Write the Pixi transform + shadow from an interpolated ground position + height.
  // `visualZ` (the render-only hover) is folded in here rather than at every call site, so
  // `place()` and `interpolate()` and any future caller all get it.
  protected applyTransform(x: number, y: number, z: number): void {
    this.posedX = x;
    this.posedY = y;
    this.posedZ = z;
    const lift = z + this.visualZ;
    this.drawnLift = lift;
    this.x = x;
    this.y = y - lift;
    // Y-sort — the GROUND coordinate, never the lifted one. Written without Pixi's re-sort
    // notification: `layers.entities` raises that itself, only when the order changes (`ySort.ts`).
    writeSortKey(this, y);

    if (this.shadow) {
      // Displaced away from the key light in proportion to height: a body at head height
      // does not cast straight down. Without this, a hover only ever scaled the shadow,
      // which reads as the shadow breathing rather than the body rising.
      this.shadow.x = x + this.shadowOffsetX + lift * SHADOW_SLANT_X;
      this.shadow.y = y + this.shadowOffsetY + lift * SHADOW_SLANT_Y;
      const k = 1 / (1 + lift * SHADOW_LIFT_FALLOFF); // higher lift → smaller, fainter shadow
      this.shadow.scale.set(k);
      this.shadow.alpha = k;
    }
  }

  destroy(): void {
    this.shadow?.parent?.removeChild(this.shadow);
    this.shadow?.destroy();
    super.destroy({ children: true });
  }
}
