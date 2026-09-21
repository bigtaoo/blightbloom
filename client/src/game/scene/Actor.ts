import { Graphics, Rectangle } from 'pixi.js';
import type { DamageType, StatusState } from '@dd/engine';
import { THEME, ELEMENT_COLORS } from '../theme';
import { ActorFilters } from './actorFilters';
import { SHELL_ASPECT, SHELL_SURFACE, SHELL_CLEARANCE } from '../fx/filters';
import { Entity } from './Entity';
import { Skin } from './Skin';
import { drawHealthBar } from './healthBar';
import { auraMaskOf, drawStatusAura, AURA_BIT_BURN } from './statusAura';
import { BODY_LIFT_R, HOVER } from './actorLift';
import type { ShotShape, SwingShape } from '../../render/rigAttackMotion';

export type Faction = 'player' | 'enemy';
export type WeaponKind = 'ranged' | 'melee';


/** Spreads hover phase across actors so a room full of floaters doesn't pulse in lockstep.
 *  Render-only and deliberately construction-ORDER dependent, not state-derived — nothing
 *  in the sim can see it (design/08 "render only reads"). */
let hoverPhaseSeq = 0;


// Actor view (player / enemy). Pure presentation: body skin, a soft shadow, and a
// cosmetic weapon graphic that swaps shape by the engine weapon's kind (Stage D:
// no weapon logic lives here — the engine owns firing, cooldowns, and the loadout).
export class Actor extends Entity {
  private skin: Skin;
  private weaponGfx = new Graphics();
  private statusAura = new Graphics(); // lingering elemental aura, behind the body
  private auraMask = 0; // bitmask of the effects currently drawn (skip redraw if same)
  private auraT = 0; // aura pulse clock (render-only, ms)
  // Floating hp bar above the head (both factions). Public like `Entity.shadow` — it is a
  // world-space companion display object this Actor owns and positions but does NOT parent
  // (see `healthBarOffsetY`/`applyTransform` override below), so `Scene.spawn` can mount it
  // on `layers.hud` instead of adding it as this container's own child.
  healthBar: Graphics | null = null;
  // Local y offset from this actor's own screen position (set once at construction, same
  // value `healthBar.y` used to be set to directly back when it was a child). Kept separate
  // now that `healthBar.y` holds an ABSOLUTE position synced every frame instead.
  private healthBarOffsetY = 0;
  private isLocal = false;
  private readonly isBoss: boolean;
  /** design/13's element identity for this actor, if it has one (`EnemyActor.element`) — the
   *  ICON half of the locked dual-channel law, drawn as a badge on the health bar. Undefined
   *  for every player and every un-elemental mob, and the bar then draws exactly as before. */
  private readonly element: DamageType | undefined;
  private hpRatio = -1; // last-drawn hp fraction (skip redraw if unchanged)
  // Lighting is NOT here. Until 2026-08-24 every actor carried its own always-on
  // `NormalLitFilter`, which meant every actor cost a render-target pass and broke the
  // sprite batch — measured as the dominant cost of the frame (src/perf/README.md). It is
  // now one screen-space pass over `Layers.lit` (`SceneLightFilter`), so an actor with no
  // status at all carries NO filter and batches with its neighbours.
  // The four conditionally-active skin shaders (shield shell / hit outline / death dissolve /
  // burn heat-haze) and the rule that composes them into one `filters` list live in
  // `actorFilters.ts` — see its header for why this is composition and not a base class. This
  // object owns no engine state; `Actor` mirrors sim values into it and ticks its clocks.
  private readonly fx: ActorFilters = new ActorFilters({
    setSkinFilters: (filters) => {
      this.skin.view.filters = filters;
    },
    setSkinAlpha: (alpha) => {
      this.skin.view.alpha = alpha;
    },
  });
  private weaponKind: WeaponKind | null | undefined = undefined;
  private weaponName: string | undefined = undefined;
  private weaponElement: DamageType | undefined = undefined;
  private radiusPx: number;
  // Idle hover (see HOVER above) — null for a grounded archetype, in which case `visualZ`
  // is never written and this actor behaves exactly as it did before the depth pass.
  private readonly hover: { base: number; amp: number; periodMs: number } | null;
  private hoverT: number;

  constructor(
    faction: Faction,
    radiusPx: number,
    tint?: number,
    boss = false,
    atlasKey?: string,
    element?: DamageType,
  ) {
    super();
    this.element = element;
    this.radiusPx = radiusPx;
    this.isBoss = boss;
    // The actor container sorts children so the weapon can sit in front of / behind.
    this.sortableChildren = true;

    // Aura sits behind everything (zIndex -1) and glows additively.
    this.statusAura.zIndex = -1;
    this.statusAura.blendMode = 'add';
    this.addChild(this.statusAura);

    const [body, front] =
      faction === 'player'
        ? [THEME.colors.player, THEME.colors.playerFront]
        : [THEME.colors.enemy, 0xffd6d6];
    // An enemy blueprint tint (elemental variant) overrides the default body colour.
    // `atlasKey` is the entity's resolved skin/body-rig name — for players, the
    // SkinDef.atlasKey (design/13's 3-character roster), falling back to the default
    // character's skin if a player entity somehow carries none (forward-compat, like
    // resolveSkin). For enemies, the blueprint's `bodyRig` (design/13 "roster variety
    // beyond the base body") — most variants are still re-tints of the shared
    // critter-core body ("one neutral-grey body, re-tinted per variant"), re-tinted at
    // runtime via `rigTint`; brute/floater instead point at their own distinct rig
    // registry entry while reusing the same tint mechanism. Falls back to the Graphics
    // placeholder like any skin that hasn't (or never will) preload.
    const resolvedTint = tint ?? body;
    const rigName = faction === 'player' ? (atlasKey ?? 'char_vanguard') : (atlasKey ?? 'critter-core');
    this.hover = HOVER[rigName] ?? null;
    this.hoverT = this.hover ? (hoverPhaseSeq++ * 0.37) * this.hover.periodMs : 0;
    if (this.hover) this.visualZ = this.hover.base;
    this.skin = new Skin(
      resolvedTint,
      front,
      radiusPx,
      rigName,
      faction === 'enemy' ? resolvedTint : undefined,
    );
    this.addChild(this.skin.view);
    // Pin the filter render area to a fixed square, X-centered on the skin's local
    // origin (0,0) — the placeholder's facing-direction "front" wedge (Skin.ts) and a
    // real rig's mounted weapon sprite both extend the auto-computed bounds out to one
    // side only (whichever way the actor is currently facing/aiming), which drags
    // EVERY skin-level filter's UV-space "center" along with it. Most filters
    // (OutlineFilter, HeatHazeFilter) sample the real alpha edge so
    // they're visually tolerant of that drift, but EnergyShieldFilter's rim-glow is a
    // hardcoded UV-distance-from-0.5 circle (see filters.ts) — it needs the render
    // area itself to stay centered and symmetric, or the glow renders lopsided toward
    // whichever side the bounds happen to extend that frame. 3x radius comfortably
    // covers body + any mounted weapon reach in every facing/aim direction.
    //
    // Y is measured, not assumed 0: a rig's decorative bones hang off the body bone's
    // TIP, not its center (design/12/13's FK convention — orb-core's eye/belly/weapon
    // sockets all sit ~1 body-length above the shell's own origin, see orbCoreRig.ts),
    // so the assembled silhouette is consistently top-heavy relative to (0,0) — found
    // 2026-08-12 from a user report that the shield glow sat low, hugging the ground
    // instead of the character (`critter-core`'s single-bone enemies have no such
    // offset and were never visibly wrong). Unlike the X asymmetry above, this one does
    // NOT depend on facing/aim (only the weapon socket's own rotation does, an X-axis
    // effect already handled by pinning X), so measuring it once, here, at a neutral
    // rest pose is safe — it won't drift during play the way a per-frame bounds read
    // would. `setFacing` lays the rig out at rest (or is a harmless no-op default for
    // the Graphics placeholder) so `getLocalBounds` reports real numbers.
    this.skin.setFacing(0, 0, 0, 'idle');
    const restBounds = this.skin.view.getLocalBounds();
    const filterCenterY = restBounds.y + restBounds.height / 2;
    // TALLER THAN WIDE, by exactly `SHELL_ASPECT` (2026-08-27). The shield shell takes its
    // screen aspect from this region and nothing else — its shader works in region-normalized
    // uv, so a circle there is an ellipse of the region's aspect — which is why `SHELL_ASPECT`
    // is imported rather than restated: a square region here silently turns the shell back into
    // the true circle it was until today, with no other symptom. See that constant's own comment
    // for why a circle was never the projection-consistent shape for a sphere in this renderer.
    //
    // The other three per-actor filters share this rect. None of them reads a centre, so none
    // changes shape: `OutlineFilter` only ever steps by a texel, and `DissolveFilter`'s noise
    // grid and `HeatHazeFilter`'s stripe frequency stretch vertically with the region — both are
    // isotropic noise by intent, and a 1.3x stretch of a death dissolve is not a cue anything
    // reads. What they DO pay is the region's extra area.
    // Solved from the shell's own geometry rather than hand-set (it was a flat `radiusPx * 3`
    // until 2026-08-27): the shader draws its surface at `SHELL_SURFACE` in normalized `dist`,
    // which lands at `SHELL_SURFACE / sqrt(2) * regionWidth` px from the centre, and what we
    // actually want to state is where that surface sits relative to the BODY —
    // `SHELL_CLEARANCE` body radii outside it. Inverting that is this line. Expressing the
    // intent and deriving the region keeps the three of them from drifting: retune the surface
    // or the aspect and the clearance stays what it says it is.
    const filterHalfX = (radiusPx * (1 + SHELL_CLEARANCE) * Math.SQRT2) / (2 * SHELL_SURFACE);
    const filterHalfY = filterHalfX * SHELL_ASPECT;
    this.skin.view.filterArea = new Rectangle(
      -filterHalfX,
      filterCenterY - filterHalfY,
      filterHalfX * 2,
      filterHalfY * 2,
    );

    this.weaponGfx.zIndex = 1;
    this.addChild(this.weaponGfx);
    // Sized from the DRAWN body, not from the collision radius (2026-08-19 volume pass).
    // It used to be `radiusPx * 0.7`, and measuring a live frame showed both halves of that
    // being wrong at once: every rig's `referenceRadius` IS its body bone's `bodyR`, so the
    // gameplay radius already equals the rig's declared body radius — but the PNG bound to
    // that bone paints as little as 0.68 of it (`skinRegistry.BODY_FILL`), so an enemy's
    // shadow came out ~45% wider than the crystal standing in it and read as a black plate.
    // The 0.7 factor was a hand-tuned fudge in the same direction, applied uniformly, which
    // is why it happened to look acceptable on the hero and not on the roster. Same class of
    // bug as the `footprintRadius` mismatch fixed the same week: a number sized against art
    // that has since changed, with nothing in either file showing it.
    this.makeShadow(this.skin.bodyDrawnR);

    // Lift the body + weapon so the container origin (gx,gy — where the shadow and
    // the engine's collision footprint sit) lands near the feet rather than the
    // torso. The sprite then rises above the ground point, so via Y-sort it draws
    // over a pillar it stands against (design/01 fake-3D depth). A rig skin needs no
    // lift of its own — its body bone already stands the art off the ground point (see
    // BODY_LIFT_R) — so for those the lift is 0 and the body's real on-screen centre is
    // the measured one, which is also what the aura/health bar anchor to below (they
    // wrap the BODY, not the ground point).
    const lift = this.skin.hasRig ? 0 : radiusPx * BODY_LIFT_R;
    const bodyCenterY = -lift + (this.skin.hasRig ? filterCenterY : 0);
    this.skin.view.y = -lift;
    this.weaponGfx.y = -lift;
    this.statusAura.y = bodyCenterY;

    // Every actor carries a floating health bar above its head (design/10 legibility
    // fix, 2026-08-02 for enemies: previously boss-only, so a regular mob's damage
    // state — and a poison/burn melt — was invisible without reading the HUD; extended
    // to the player 2026-08-02 so hp is readable on the map itself, not just the corner
    // HUD). A boss's is drawn bigger/further out (setHealth) so it still reads as the
    // more prominent threat.
    //
    // NOT a child of this container (2026-08-21, live report *"血条被墙挡住了"*): a bar
    // parented here would Y-sort with the body, so a wall the occlusion x-ray only
    // PARTIALLY fades (`scene/occlusion.ts`'s cap-only fade, `XRAY_FADE` = 0.34) reads the
    // bar through the SAME translucent stone the body does — which keeps a near-white body
    // legible but composites the bar's own dark contour/track (`healthBar.ts`'s near-black
    // `CONTOUR`/navy `TRACK`) down into the same 27-88 luma band the wall itself occupies,
    // erasing the two-tone contrast that pass was built to guarantee. `Scene.spawn` mounts
    // this on `layers.hud` instead — world-space and always drawn last, so it is never
    // behind a wall/pillar/door regardless of Y-sort or the x-ray's fade state. `applyTransform`
    // below keeps it positioned at this offset from the actor's own screen position, the same
    // "owned but not parented" pattern `Entity.shadow` already uses.
    this.healthBar = new Graphics();
    this.healthBarOffsetY = bodyCenterY - radiusPx * (boss ? 1.7 : 1.3);

    // Nothing to attach yet: all four skin shaders are conditionally active and each
    // one's own setter calls applySkinFilters on its activation edge. A freshly spawned
    // actor therefore has `filters === null` and costs no pass at all.
  }

  // Swap the cosmetic weapon shape to match the engine's active weapon kind. A real rig
  // mounts its own weapon sprite (design/03/12/13's universal mount); the Graphics
  // placeholder is only drawn when NO rig is loaded, so the two never render on top of each
  // other. `Skin.weaponMount` is the single source of that decision — see its doc for why it
  // is asked of the rig rather than of the faction, and what the faction gate that used to
  // live here cost. `damageType` re-tints the mounted weapon sprite to its element hue
  // (`ELEMENT_COLORS`, same law as a bullet's own colour) — physical stays the weapon's
  // neutral authored colour, matching `Bullet.color`'s own `ELEMENT_COLORS[type] ?? fallback`
  // convention.
  setWeaponKind(kind: WeaponKind | null, damageType?: DamageType, name?: string): void {
    if (kind === this.weaponKind && damageType === this.weaponElement && name === this.weaponName) return;
    this.weaponKind = kind;
    this.weaponElement = damageType;
    this.weaponName = name;
    this.skin.setWeaponKind(kind, name);
    this.skin.setWeaponTint(damageType !== undefined ? (ELEMENT_COLORS[damageType] ?? 0xffffff) : 0xffffff);
    this.drawWeapon(this.skin.weaponMount === 'placeholder' ? kind : null);
  }

  /**
   * Mark this actor as the seat THIS client is driving (`Scene` resolves which one).
   *
   * Every actor got a floating health bar in the 2026-08-02 legibility pass, which had
   * an unintended cost: the player's own bar became indistinguishable from a mob's, so
   * "which one of these is me" stopped being answerable at a glance — the user's own
   * report, pointing at their character and asking what it was. Fixed with two cues: a
   * teal ground ring at the feet, and a health bar outlined in that same teal instead of
   * the default near-black.
   *
   * The ring half was dropped again 2026-08-14 (same user, two more screenshot rounds
   * later): first report was the ring reading as "only half a shield" (it shared the
   * body's own y=0 ground origin, so its top half sat behind the lifted body sprite and
   * got painted over — fixed same day by moving it to a zIndex in FRONT of the body so
   * the full ellipse always shows), second report was that the now-always-visible ring
   * and the (correctly, separately fixed) `EnergyShieldFilter` rim-glow are both cyan
   * and both wrap the character, so a live shield and "this is you" became
   * indistinguishable at a glance — the exact ambiguity this marker exists to prevent,
   * just moved from "ring vs body" to "ring vs shield". Asked the user how to resolve
   * it; chosen fix: drop the ground ring entirely and rely on the health-bar teal
   * outline alone (setHealth below) — it never occupies the same on-screen space as the
   * shield glow, so the two can never be confused, at the cost of a slightly less
   * prominent marker than a full-body ring gave.
   */
  setLocal(local: boolean): void {
    if (local === this.isLocal) return;
    this.isLocal = local;
    this.hpRatio = -1; // force setHealth to redraw the bar in its new outline style
  }

  // Update the floating health bar from the engine actor's hp. Colour ramps green →
  // amber → red as it drains; redraws only when the fraction changes, so an actor
  // sitting at full hp costs nothing per tick. What the bar LOOKS like lives in
  // `healthBar.ts` (and its header records the measurements that shaped it); the size
  // is per-actor, so it stays here — a boss's bar is drawn bigger and further out so it
  // still reads as the more prominent threat.
  setHealth(hp: number, maxHp: number): void {
    if (!this.healthBar || maxHp <= 0) return;
    const ratio = Math.max(0, Math.min(1, hp / maxHp));
    if (ratio === this.hpRatio) return;
    this.hpRatio = ratio;
    drawHealthBar(this.healthBar, {
      w: this.radiusPx * (this.isBoss ? 2.2 : 1.7),
      h: this.isBoss ? 6 : 4,
      ratio,
      local: this.isLocal,
      element: this.element,
    });
  }

  /**
   * Mirror the engine actor's lingering status (design/03/07). Redraws only when the active SET
   * changes — the pulse is an alpha animation in `interpolate`, so a steady burn never rebuilds
   * geometry. What the aura looks like lives in `statusAura.ts`; the caching and the hand-off to
   * the burn shader stay here, because both are this actor's own state.
   */
  setStatus(status: StatusState): void {
    const mask = auraMaskOf(status);
    if (mask === this.auraMask) return;
    this.auraMask = mask;
    drawStatusAura(this.statusAura, mask, this.radiusPx);
    // Heat-haze distortion while burning. The on/off edge is detected inside
    // `ActorFilters.setBurning`, so this is an unconditional hand-off.
    this.fx.setBurning((mask & AURA_BIT_BURN) !== 0);
  }

  /** Mirror the engine actor's two-pool shield (design/02/05/07) — see `ActorFilters.setShield`
   *  for the shell itself and for why `maxShield <= 0` is a cheap no-op. */
  setShield(shield: number, maxShield: number): void {
    this.fx.setShield(shield, maxShield);
  }

  /** The DRAWN body's half-width and height in world px (`Skin.silhouette`) — what the
   *  occlusion x-ray measures a standing block's art against (`scene/occlusion.ts`). */
  get bodySilhouette(): { halfW: number; bodyH: number } {
    return this.skin.silhouette;
  }

  /** Recompose this actor's skin filters against the current quality tier — see
   *  `ActorFilters.refreshQuality` and `Scene.refreshQuality`. */
  refreshQuality(): void {
    this.fx.refreshQuality();
  }

  /**
   * This actor just took a hit (`EventReactor`'s 'hit' case, for whichever actor the event names
   * as `target`). One signal, so one call: the silhouette flash + shield dent (`ActorFilters.
   * hitFlash`) and the rig's own `hurt` flinch are the shader and clip halves of one reaction,
   * the same shape `onAttack` established. `dx`/`dy` are the impact point as a delta from this
   * actor's centre, and only the shader half reads them — the flinch is authored per body plan,
   * in the rig's own bone space, so there is no direction for it to take.
   */
  onHurt(dx = 0, dy = 0): void {
    this.fx.hitFlash(dx, dy);
    this.skin.hurt();
  }

  /** This actor's view was just created for a new engine id (`Scene.spawn`) — the id appearing
   *  IS the signal, so there is no event to listen for. Called after the constructor has measured
   *  the rest pose (filter area, silhouette): the spawn clip opens at 20% scale and alpha 0, so
   *  measuring through it would size every one of those against a body that has not arrived. */
  onSpawn(): void {
    this.skin.spawn();
  }

  /**
   * This actor died — called once by `Scene` when its id drops out of the engine's alive list,
   * instead of destroying the view that same tick. Three things, and the split is deliberate:
   *
   *   - the rig's `death` clip owns the BODY's own collapse (squash, sink, fade — per body plan);
   *   - `ActorFilters` owns the dissolve shader AND the clock that decides when the view is gone
   *     (`isDissolved`), so art never gets a vote on view lifetime. The clip is simply cut off
   *     mid-collapse when the dissolve finishes, which is what the shipped numbers do (a 900 ms
   *     death clip against `DISSOLVE_MS` = 700), so the two read as one continuous motion;
   *   - hiding this actor's OTHER furniture belongs here, because those are its own children:
   *     weapon, status aura and health bar are all meaningless on a dead actor and would
   *     otherwise float over a half-dissolved silhouette. (The rig-MOUNTED weapon module is not
   *     one of them — it fades with the socket bone it hangs on, see `ModuleMount.alpha`.)
   */
  onDeath(): void {
    this.fx.startDissolve();
    this.skin.die();
    this.weaponGfx.visible = false;
    this.statusAura.visible = false;
    if (this.healthBar) this.healthBar.visible = false;
  }

  /** True once the death-dissolve has fully played out — Scene destroys the view then. */
  get isDissolved(): boolean {
    return this.fx.isDissolved;
  }

  private drawWeapon(kind: WeaponKind | null): void {
    const g = this.weaponGfx;
    g.clear();
    const r = this.radiusPx;
    if (kind === 'ranged') {
      g.rect(r * 0.5, -2.5, r * 0.8, 5).fill({ color: THEME.colors.gun }); // barrel
    } else if (kind === 'melee') {
      g.moveTo(r * 0.3, 0)
        .lineTo(r * 1.5, 0)
        .stroke({ color: THEME.colors.sword, width: 3 }); // blade
    }
  }

  /**
   * The mounted weapon's business end in the same space `Entity.x/y` live in — i.e.
   * ready to hand straight to another Entity's `place()`. See `RigSkin.muzzleLocal` for
   * why this exists (bullets visibly leaving mid-gun instead of the muzzle) and what it
   * is used for; null whenever this actor has no rig-mounted module, which is every
   * enemy. Reads the pose `interpolate` last laid out, so call it after that (which is
   * where `Scene` sits in the frame anyway).
   */
  muzzlePos(): { x: number; y: number; heightPx: number } | null {
    const local = this.skin.muzzleAnchor();
    if (!local) return null;
    // `skin.view.y` is the placeholder-only body lift (0 for a rig, see the constructor),
    // included rather than assumed so this stays correct if that ever changes. It is NEGATIVE
    // (screen y grows downward), so it raises the drawn body — hence it lowers the screen
    // point and RAISES the height, which is one lift stated twice, not two different ones.
    return {
      x: this.x + local.x,
      y: this.y + this.skin.view.y + local.y,
      // How high off the floor the barrel tip is drawn — `RigSkin.muzzleLocal` for why this
      // is separable from `y` at all, and `Scene` for what needs it (a round drawn at the
      // height it was fired from, so nothing is left to bend its path). `drawnLift` is this
      // frame's own `z + visualZ`, the hover included, since the gun rides with the body.
      heightPx: this.drawnLift + local.heightPx - this.skin.view.y,
    };
  }

  /** This actor just attacked (`EventReactor`, off `bullet_fired`/`melee_swing`'s `ownerId` —
   *  design/08's one engine→render channel). One call for both kinds: each plays the rig's own
   *  `attack` clip over idle/move plus an aim-relative envelope — a shot kicks the module back
   *  (taking `muzzlePos()` with it), a swing sweeps forward. See `render/rigAttackMotion.ts`.
   *
   *  The shape is the WEAPON that attacked, and it is what SIZES and PACES the motion: for a
   *  swing its sector, hit window, recovery and knockback; for a shot its fire interval and the
   *  damage one trigger pull puts out. Omitted for an attacker whose weapon could not be
   *  resolved, which falls back to that kind's starter weapon. */
  onAttack(kind: 'ranged', shot?: ShotShape): void;
  onAttack(kind: 'melee', swing?: SwingShape): void;
  onAttack(kind: WeaponKind, shape?: ShotShape | SwingShape): void {
    if (kind === 'melee') this.skin.attack(kind, shape as SwingShape | undefined);
    else this.skin.attack(kind, shape as ShotShape | undefined);
  }

  /** Keeps `healthBar` tracking this actor's own screen position at its fixed offset — it is
   *  deliberately not a child (see the constructor's doc comment), so nothing else moves it.
   *  Every position update funnels through here: `place()` (unused by Actor, but inherited)
   *  and `interpolate()` (Actor's own override, via `super.interpolate` → `applyTransform`)
   *  both call this.
   *
   *  The bar tracks the actor's GROUND height, not its drawn one: `visualZ` — the render-only
   *  idle hover (`actorLift.ts`'s HOVER) — is added back on top of the lift `super` just
   *  subtracted, so the bar hangs at a constant screen height while the body bobs underneath
   *  it. Live report 2026-09-21, *"角色头上的血条能不跟着角色上下晃动吗？眼睛都被晃花了"*:
   *  a hovering archetype's `amp` is 1-2 world px, so the bar travelled 2-4 px peak to trough
   *  — at the 3.4-4.1x a room is cover-fitted to (`FxController`) that is 7-16 screen px, and
   *  `setHealth` draws the track 4 px tall, so the bar crossed its OWN HEIGHT twice a cycle.
   *  It is also the one piece of an actor's furniture the eye is asked to fixate on and read a
   *  fraction off, so the bob that sells the body's weight reads there as jitter. Engine `z` is deliberately still honoured (it is 0 for
   *  every actor today, design/01 "`z` never gates gameplay", but a real knock-up should
   *  carry the bar with it — that is the actor genuinely being somewhere else, not an idle
   *  animation). The body's own `idle` clip bobs the ART inside `skin.view` and never reached
   *  the bar to begin with, so pinning `visualZ` is the whole of the fix. */
  protected override applyTransform(x: number, y: number, z: number): void {
    super.applyTransform(x, y, z);
    if (this.healthBar) {
      this.healthBar.x = this.x;
      this.healthBar.y = this.y + this.visualZ + this.healthBarOffsetY;
    }
  }

  /** `healthBar` lives on `layers.hud`, not as this container's own child (see the
   *  constructor), so `Entity.destroy()`'s `super.destroy({ children: true })` never reaches
   *  it — same reason `Entity` itself has to explicitly tear down `shadow`. */
  override destroy(): void {
    this.healthBar?.parent?.removeChild(this.healthBar);
    this.healthBar?.destroy();
    super.destroy();
  }

  override interpolate(alpha: number, frameDt: number): void {
    // Written BEFORE super, which is what consumes `visualZ` (Entity.applyTransform).
    if (this.hover) {
      this.hoverT += frameDt;
      this.visualZ = this.hover.base + this.hover.amp * Math.sin((this.hoverT / this.hover.periodMs) * Math.PI * 2);
    }
    super.interpolate(alpha, frameDt);
    // Cheap idle/move GROUND clip pick straight from Entity's own interpolation buffers. The
    // other four clips ride on top of or outrank it and are driven by their own signals
    // (`onAttack`/`onHurt`/`onSpawn`/`onDeath`), so this stays a two-way choice however many
    // clips are in flight. A caller that collapses prev onto cur mid-motion
    // (`Scene.positionLocal`'s predicted-pose snap) sets `movingOverride` explicitly since the
    // buffer delta alone would always read as stationary in that case.
    const moving = this.movingOverride ?? Math.hypot(this.curX - this.prevX, this.curY - this.prevY) > 0.01;
    // Upper/lower body split: the body (legs/torso) faces movement (`bodyFacingRad`,
    // == facingRad for anything that doesn't move independently of its aim, like an
    // enemy), while the weapon always points at the aim/shot direction (`facingRad`).
    this.skin.setFacing(this.bodyFacingRad, this.facingRad, frameDt, moving ? 'move' : 'idle');
    this.weaponGfx.rotation = this.facingRad;
    // Gentle breathing pulse so an active aura reads as a live effect, not an outline.
    if (this.auraMask !== 0) {
      this.auraT += frameDt;
      this.statusAura.alpha = 0.75 + 0.25 * Math.sin(this.auraT * 0.008);
    }
    this.fx.tick(frameDt);
  }
}
