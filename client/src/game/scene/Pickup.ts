import { Graphics, Sprite } from 'pixi.js';
import { WEAPON_SIM_BY_ID } from '@dd/engine';
import { THEME, elementColor } from '../theme';
import { drawElementBadge } from '../elementIcons';
import { drawRarityPips } from '../rarityOverlay';
import { getWeaponTexture } from '../../render/weaponSkins';
import { getPickupTexture } from '../../render/environmentSprites';
import { Entity } from './Entity';
import type { PickupKind } from '@dd/engine';

export type { PickupKind };

// Glow tint per kind — same colour as the shape itself (THEME.colors.pickup*), just
// softened/additive, so the glow reads as "this shape, glowing" rather than a mismatched
// halo.
const PICKUP_GLOW: Record<PickupKind, number> = {
  heal: THEME.colors.pickupHeal,
  weapon: THEME.colors.pickupWeapon,
  buff: THEME.colors.pickupBuff,
  crate: THEME.colors.pickupCrate,
  material: THEME.colors.pickupMaterial,
  bandage: THEME.colors.pickupHeal, // shares heal's hue on purpose: same "restore" family, own sprite
  energy: THEME.colors.pickupEnergy, // its own hue — see the theme entry for why it is the cool one
  coin: THEME.colors.pickupCoin, // gold; separated from `material` by shape, not hue (see the theme entry)
  schematic: THEME.colors.pickupSchematic, // rose — a boss's one-time blueprint drop (design/14)
};

// Ambient hover, deliberately in the same band as the scene's other idle loops —
// Portal's alpha pulse (0.003 rad/ms) and Actor's status aura (0.008). The original
// 0.12 rad/ms was ~19 Hz, i.e. 2.0 rad of phase per 60fps frame: close enough to the
// Nyquist limit (π) that the "bob" aliased into a strobe whose apparent rate changed
// with the display's refresh rate instead of reading as a float.
const BOB_PERIOD_MS = 2000; // one unhurried hover cycle every 2s (0.5 Hz)
const BOB_RATE = (Math.PI * 2) / BOB_PERIOD_MS; // rad/ms
/** Hover height the bob oscillates around (px). Exported because a COLLECTED drop's flight
 *  (`scene/pickupFlight.ts`) starts from a fresh view rather than from the one that was on the
 *  floor, and has to launch from the height that one was drawn at — the two numbers being the
 *  same is what makes the flight continuous with the drop it replaces. */
export const BOB_REST_Z = 9;
const BOB_AMPLITUDE = 4; // px either side of rest — bigger than before; slow travel needs the reach to read

// Golden angle: spacing successive drops' start phase by it keeps a whole floor's worth
// of loot from bobbing in lockstep (which is what made the field read as one flicker),
// with no Math.random — same determinism rule the rest of this render layer follows.
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

// The glow's fill alpha is the value at the TOP of the hover; the breathe below only ever
// scales it DOWN (Pixi clamps alpha at 1, so modulating above the fill would silently
// flatten the bright half of the cycle into a plateau).
const GLOW_ALPHA_PEAK = 0.34;
const GLOW_BREATHE = 0.36; // how much dimmer the bottom of the arc is, as a fraction of peak

// On-screen extent of a drop's sprite art, along whichever axis is longer (2026-08-20).
// ONE number for every kind rather than the per-kind 14/18 the Graphics fallbacks below
// still use: each file keeps its own aspect (the crystal is 116x192, the bandage 192x100),
// so scaling by the long axis is what makes a floor of mixed loot read as one size class.
// It stays inside the glow's own diameter (GLOW_RADIUS * 2 = 26) so the glow reads as
// "this shape, glowing" rather than as a disc with something small on it.
const ART_LONG_AXIS = 18;
const GLOW_RADIUS = 13;
/** Bands the glow ramps over. It was ONE flat additive circle until 2026-08-20, which was
 *  fine behind a flat 14px Graphics silhouette and stopped being fine the moment the drops
 *  became real sprites: measured live, the disc reads as a hard-edged coloured plate that
 *  the art sits on, like a token. Non-overlapping annuli instead, each carrying exactly its
 *  own ramp value — stacked translucent shapes step in OPACITY and compound, which is the
 *  same trap `wallTone`'s coping ramp and `roomLight`'s falloff are both built to avoid. Twelve
 *  of them over 13 px (the same count `roomLight` settled on) keeps the largest step to 0.052
 *  alpha; ten came out at 0.061, which is where a ring starts to read. */
const GLOW_BANDS = 12;

/** Where a weapon drop's element badge sits, in local px, and how big its glyph is.
 *  Lower-LEFT: weapon art in this repo is authored socket-upper-left / tip-lower-right
 *  (`render/weaponSkins.ts`'s baseline convention), so the lower-left quadrant is the one a
 *  diagonal silhouette leaves empty — the badge covers no part of the weapon it labels. It
 *  stays inside `GLOW_RADIUS` (offset magnitude ~10.6 of 13) so the glow still reads as
 *  "this object, glowing" rather than as a disc with something hanging off it. */
const WEAPON_BADGE_X = -8;
const WEAPON_BADGE_Y = 7;
const WEAPON_BADGE_GLYPH_R = 3;

// Pickup view — an in-run drop (health / coin / weapon). Pure presentation:
// the engine owns the drop roll and collection; the hover bob here is render-only
// eye candy (it is NOT part of the sim, which is why PickupItem has no z). Position
// lerps like any other view; z is the local bob. Each kind gets a distinct silhouette so
// a player reads "new gun" vs "heal" at a glance — a per-kind sprite since 2026-08-20,
// with the original flat Graphics shapes kept as the never-blocks-gameplay fallback.
export class Pickup extends Entity {
  private bob: number;
  private readonly glow: Graphics;
  readonly kind: PickupKind;

  /** `id` is the engine entity id, used only to spread the hover's start phase (see
   *  GOLDEN_ANGLE) — the view stays a pure function of it, so two clients drawing the
   *  same drop still agree frame-for-frame. Defaults to an in-phase 0 for callers that
   *  don't care (tests, one-off previews). */
  constructor(kind: PickupKind, weaponId?: string, id = 0) {
    super();
    this.kind = kind;
    this.bob = id * GOLDEN_ANGLE;
    // A soft additive glow behind the shape (design/10 legibility fix, 2026-08-02): an
    // ~18px silhouette reads as a plain dot against a dark/busy floor — the glow gives
    // every pickup a bit of "pop" at a glance. Kept after the art landed: it is also why
    // no drop sprite needs a baked halo of its own (design/13's "environment desaturated,
    // hazards saturated" pop is this layer's job, not the file's). A separate Graphics
    // (not the crisp shape below) so only the glow itself blends additively — the art on
    // top stays a normal, non-washed-out fill.
    const glow = new Graphics();
    const bandW = GLOW_RADIUS / GLOW_BANDS;
    for (let i = 0; i < GLOW_BANDS; i++) {
      // t: 0 at the centre, → 1 at the rim. Squared, so the glow keeps its bright core and
      // reaches nothing at the edge instead of ending on a visible boundary.
      const t = (i + 0.5) / GLOW_BANDS;
      const r = (i + 0.5) * bandW; // a bandW-wide stroke here spans i*bandW..(i+1)*bandW
      glow.circle(0, 0, r).stroke({
        color: PICKUP_GLOW[kind],
        width: bandW,
        alpha: GLOW_ALPHA_PEAK * (1 - t) ** 2,
      });
    }
    glow.blendMode = 'add';
    this.addChild(glow);
    this.glow = glow;

    const gfx = new Graphics();
    // Real art for every kind but `weapon` (which mounts the weapon's own business-end
    // art below instead of a generic loot icon). Anchored at its centre and scaled by its
    // LONG axis, so the file's own aspect decides the other one — the same rule the pillar
    // sprite follows, for the same reason: the aspect is the art's to choose, the extent
    // is the game's. Falls through to the flat Graphics silhouettes below whenever the
    // texture isn't resolvable (not preloaded, fetch failed) — art never blocks gameplay
    // (design/02/12).
    // Resolved before the kind dispatch because BOTH the weapon branch below and the
    // rarity/element overlays after it need it (design/13's two channels + the icon).
    const sim = kind === 'weapon' && weaponId ? WEAPON_SIM_BY_ID[weaponId] : undefined;
    const art = kind === 'weapon' ? undefined : getPickupTexture(kind);
    if (art) {
      const sprite = new Sprite(art);
      sprite.anchor.set(0.5);
      sprite.scale.set(ART_LONG_AXIS / Math.max(art.width, art.height));
      this.addChild(sprite);
    } else if (kind === 'heal') {
      const color = THEME.colors.pickupHeal;
      // A small plus sign reads as "heal" without art.
      gfx.roundRect(-3, -9, 6, 18, 2).fill({ color });
      gfx.roundRect(-9, -3, 18, 6, 2).fill({ color });
    } else if (kind === 'weapon') {
      // The weapon's own real business-end art (same texture WeaponCard/Forge mount,
      // render/weaponSkins.ts) — reads as "that specific gun/blade", not just "a new
      // weapon". Falls back to the old double-chevron ("gear / new weapon") when the
      // texture isn't resolvable (unknown id / not yet loaded) — a ground item, unlike
      // WeaponCard's chip, has no adjacent name text to fall back on, so it must always
      // draw *something*.
      const texture = getWeaponTexture(weaponId, sim?.kind ?? 'ranged');
      if (texture) {
        const icon = new Sprite(texture);
        icon.anchor.set(0.5);
        const box = 22;
        icon.scale.set(Math.min(box / texture.width, box / texture.height));
        // Element hue on the drop, the same way `Skin.setWeaponTint` puts it on the MOUNTED
        // copy of this exact texture (design/13's locked colour channel). It was untinted
        // here, so one weapon read as two different objects depending on whether it was on
        // the floor or in your hand — and a fire rifle lying on the ground was
        // indistinguishable from a poison one.
        if (sim) icon.tint = elementColor(sim.damageType);
        this.addChild(icon);
      } else {
        const color = THEME.colors.pickupWeapon;
        gfx.poly([-8, -7, 0, -1, -8, 5, -5, -1]).fill({ color });
        gfx.poly([0, -7, 8, -1, 0, 5, 3, -1]).fill({ color });
      }
    } else if (kind === 'buff') {
      // An upward chevron in a diamond — "power up / run buff" (design/14).
      const color = THEME.colors.pickupBuff;
      gfx.poly([0, -9, 9, 0, 0, 9, -9, 0]).fill({ color, alpha: 0.35 });
      gfx.poly([-6, 3, 0, -6, 6, 3, 0, 0]).fill({ color });
    } else if (kind === 'energy') {
      // A bolt in a ring — "weapon energy" (design/03/05, ENGINE_VERSION 59). No sprite
      // ships for this kind yet, so this Graphics silhouette is the drawn form, not a
      // fallback; `getPickupTexture('energy')` picking one up later needs no change here.
      // Shaped rather than tinted on purpose: design/13's dual-channel rule (colour AND
      // form) is what keeps it apart from the material crystal for a colourblind player.
      const color = THEME.colors.pickupEnergy;
      gfx.circle(0, 0, 8).stroke({ color, width: 2, alpha: 0.8 });
      gfx.poly([1, -8, -5, 1, -0.5, 1, -1, 8, 5, -1, 0.5, -1]).fill({ color });
    } else if (kind === 'coin') {
      // A struck disc with a rim and an off-centre highlight — "money" (design/05 "Shops").
      // Drawn rather than sprited for the same reason `energy` is: no coin art ships yet,
      // and the staged rollout walls/pillars/doors/chests each went through starts here. The
      // rim is what does the work against `material`'s crystal at a glance — same warm band,
      // different silhouette, which is design/13's dual-channel rule applied the one way
      // round it can be when the colour genuinely should not move.
      const color = THEME.colors.pickupCoin;
      gfx.circle(0, 0, 7).fill({ color });
      gfx.circle(0, 0, 7).stroke({ color: 0xfff6d5, width: 1.5, alpha: 0.85 });
      gfx.circle(-2, -2, 2).fill({ color: 0xfffbe6, alpha: 0.75 });
    } else if (kind === 'crate') {
      // A plain square outline — "unknown," contents unresolved (design/15 anti-cheat
      // loot reveal). Flips to one of the shapes above the instant it resolves.
      const color = THEME.colors.pickupCrate;
      gfx.rect(-7, -7, 14, 14).stroke({ color, width: 2 });
    } else if (kind === 'schematic') {
      // A rolled scroll — a blueprint schematic (design/14, ENGINE_VERSION 68). No sprite
      // ships for this kind yet, same "Graphics is the drawn form, not a fallback" note as
      // `energy`/`coin` above. Shaped distinctly (a cylinder, not a disc or crystal) since
      // design/13's dual-channel rule still applies and this is the one drop in the set that
      // should never be mistaken for routine loot at a glance — at most one exists per run.
      const color = THEME.colors.pickupSchematic;
      gfx.roundRect(-8, -3, 16, 6, 3).fill({ color });
      gfx.circle(-8, 0, 3).fill({ color: 0xfff0f6, alpha: 0.85 });
      gfx.circle(8, 0, 3).fill({ color: 0xfff0f6, alpha: 0.85 });
    } else {
      // material — a small crystal (the run's carry-out currency, design/14)
      const color = THEME.colors.pickupMaterial;
      gfx.circle(0, 0, 7).fill({ color });
      gfx.circle(0, 0, 3.5).fill({ color: 0xfffbe6, alpha: 0.7 });
    }
    this.addChild(gfx);

    // Both channels design/13 requires of a WEAPON, on the one object in the game that had
    // neither: a drop on the floor. Rarity as a COUNT of additive marks on the top arc
    // (`rarityOverlay.ts` has the spec and the hue-collision numbers behind it), element as
    // the locked icon badge. `WeaponPickupPrompt`/`CompareCard` still spell both out in text,
    // but only once you are already standing on the drop — this is what decides whether it is
    // worth walking to, which is the decision design/14's loot loop actually turns on.
    if (kind === 'weapon' && sim) {
      const marks = new Graphics();
      drawRarityPips(marks, sim.rarity, 0, 0, GLOW_RADIUS);
      marks.blendMode = 'add'; // the "emissive" half of design/13's overlay clause
      this.addChild(marks);
      const badge = new Graphics();
      drawElementBadge(badge, sim.damageType, WEAPON_BADGE_X, WEAPON_BADGE_Y, WEAPON_BADGE_GLYPH_R);
      this.addChild(badge);
    }

    this.makeShadow(9);
  }

  /** Half-width/height of the drawn body in world px — the same shape `Actor.bodySilhouette`
   *  exposes, and read by the same occlusion x-ray (`scene/occlusion.ts`, `GameLoop.updateFx`).
   *  Measured off the assembled art at rest rather than restated, same reason `Skin.bodyDrawnH`
   *  is measured and not derived: the glow ring, the rarity pips and the element badge all
   *  reach different amounts past the shape they decorate. */
  get bodySilhouette(): { halfW: number; bodyH: number } {
    const b = this.getLocalBounds();
    return { halfW: Math.max(-b.x, b.x + b.width), bodyH: Math.max(-b.y, b.y + b.height) };
  }

  override interpolate(alpha: number, frameDt: number): void {
    this.bob += frameDt * BOB_RATE;
    const swing = Math.sin(this.bob);
    // The glow breathes with the hover rather than on its own clock: one slow cue
    // instead of two competing ones, and it keeps the drop's "pop" now that the motion
    // alone is too gentle to catch the eye. Scaling the Graphics' alpha (not refilling
    // it) keeps this a per-frame property write, no geometry rebuild.
    this.glow.alpha = 1 - (GLOW_BREATHE * (1 - swing)) / 2;
    const z = BOB_REST_Z + swing * BOB_AMPLITUDE;
    this.applyTransform(
      this.prevX + (this.curX - this.prevX) * alpha,
      this.prevY + (this.curY - this.prevY) * alpha,
      z,
    );
  }
}
