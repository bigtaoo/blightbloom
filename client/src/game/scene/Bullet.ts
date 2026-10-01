import { Graphics, Sprite, Texture } from 'pixi.js';
import type { DamageType } from '@dd/engine';
import { THEME, ELEMENT_COLORS } from '../theme';
import { getBulletTexture } from '../../render/environmentSprites';
import { Entity } from './Entity';
import type { Faction } from './Actor';

// Bullet view. Pure presentation: a projectile sprite with a shadow, positioned by the
// engine each tick. The engine may flip a bullet's faction (melee deflect: enemy →
// player); the view re-reads faction each reconcile and recolours to match.
//
// Per-element polish (design/03/07): an elemental bullet is drawn in its element
// hue with a soft additive glow halo, so a fire/ice/lightning/poison shot reads at a
// glance — distinct from a plain (faction-coloured) physical round. The world-space
// motion trail is spawned by Game (fx layer), keyed off the same element colour.
//
// Since 2026-10-01 each damage type also has its own SHAPE (`bullet_<type>.png`: a slug, a
// fireball, an ice shard, a lightning bolt, a toxic glob), which is design/13's dual-channel
// rule — colour AND form — reaching the projectiles. The flat dot is the fallback for any
// round whose texture has not loaded. The glow, the spawn flare and the trail stay drawn.
/**
 * How far (in world px of TRAVEL, not wall-clock time) a bullet eases from its shooter's
 * drawn muzzle onto its true sim line (setMuzzleOrigin) before the correction is fully spent.
 *
 * Was a fixed 120ms budget until 2026-08-30 (user report *"子弹的弹道，现在会从枪口曲线跑到角色
 * 身前再继续飞向目标"*): at the ~10 grid/s (320 world px/s) most weapons fire, 120ms covers
 * ~38 world px, which read fine — but a slow weapon like frostbrand (`bulletSpeed: 6`, 192
 * world px/s) only covers ~23 px in the same 120ms, so the ~12-14 px offset measured on real
 * shots (the commit that introduced this correction, "most of a body radius") ate over half of
 * its early flight instead of a third. A slow bullet lingered right in front of the shooter
 * while the offset drained, which read as the shot curving there before straightening out
 * toward the target, rather than as leaving the barrel cleanly.
 *
 * Budgeting by distance travelled instead keeps the correction's visual footprint (offset px
 * over budget px) the same fraction of early flight for every `bulletSpeed` — a slow bullet
 * just takes longer, in ms, to cover the same 40 px, instead of spending its whole time budget
 * over a shorter distance.
 */
const MUZZLE_EASE_DISTANCE_PX = 40;
/**
 * How long a bullet's spawn "pop" lasts (2026-08-30, user report *"子弹出现的也很突兀"*).
 *
 * A round used to appear at full size, full opacity, on one frame — nothing about the picture
 * distinguished the frame it came into existence from the frames it merely travelled through,
 * so it read as popping into the air rather than as being fired. Two overlapping cues fix
 * that, both purely temporal: the core is thrown a little OVERSIZE and settles to its true
 * radius, and a bright additive flare rides the round out of the barrel and collapses.
 *
 * ~2.7 sim ticks — comfortably inside how long even the SLOWEST weapon takes to spend
 * `MUZZLE_EASE_DISTANCE_PX`'s own correction, so the whole "leaving the gun" read (barrel-tip
 * origin + pop) is over within the first few frames of flight and the bullet spends the rest
 * of its life drawn exactly as before.
 */
const SPAWN_POP_MS = 90;
/** How much oversize the core starts at, as a fraction of its radius. Small on purpose — this
 *  is a punch, not a growing ball; at much more than this the round reads as changing size
 *  mid-flight, which is a lie about a bullet whose hitbox never changes. */
const SPAWN_POP_SCALE = 0.9;
/** The departure flare's radius, in bullet radii. Bigger than the pop because it is a glow
 *  around the round rather than the round itself. */
const SPAWN_FLARE_R = 3.2;
/**
 * The projectile art's long axis, in bullet radii — twice the dot's diameter. Every file is
 * 2.2-4.4 times as long as it is tall, so at this length the drawn body is about as thick as
 * the dot it replaces and the extra extent all runs along the flight line, where it reads as
 * motion rather than as a bigger hitbox.
 */
const ART_LENGTH_R = 4;

export class Bullet extends Entity {
  private glow = new Graphics(); // additive halo, behind the core (elemental only)
  private gfx = new Graphics(); // the flat-dot fallback, drawn only while `art` has no texture
  private art = new Sprite(Texture.EMPTY); // the projectile sprite, pointed along the velocity
  private flare = new Graphics(); // one-shot departure glow (see SPAWN_POP_MS)
  private artScale = 0; // texture px → world px; 0 = no art, the dot is drawn
  // -1 while flying leftward: the sprite is mirrored as well as rotated, so the light baked
  // into the art (upper left) stays on top instead of flipping under the round.
  private artFlipY = 1;
  private popScale = 1;
  private popMs = SPAWN_POP_MS; // remaining spawn-pop time; 0 = drawn at its true size
  private radiusPx: number;
  private faction: Faction | null = null;
  private damageType: DamageType = 'physical';
  private originDx = 0; // muzzle-origin correction (see setMuzzleOrigin)
  private originDy = 0;
  private originRemainingPx = 0; // world px of travel left to spend; 0 = drawn exactly at the sim position
  // Last-seen un-offset (sim-interpolated) position, for measuring how far the bullet has
  // actually travelled since `setMuzzleOrigin` — seeded there from curX/curY, not lazily on
  // the first interpolate() call, so a fast-forwarded catch-up (several sim ticks landing
  // before the view's first render frame) is measured too instead of read as "no travel yet".
  private lastBaseX = 0;
  private lastBaseY = 0;

  constructor(radiusPx: number) {
    super();
    this.radiusPx = radiusPx;
    this.glow.blendMode = 'add';
    // The flare's geometry never changes (it is sized off the radius alone, which is fixed for
    // a given bullet), so it is drawn once here — only its scale and alpha animate. Drawn in
    // white rather than in `color`, because `setFaction`/`setElement` land AFTER construction
    // and a departure flash is a value spike either way.
    this.flare.circle(0, 0, radiusPx * SPAWN_FLARE_R).fill({ color: 0xffffff, alpha: 0.5 });
    this.flare.circle(0, 0, radiusPx * SPAWN_FLARE_R * 0.45).fill({ color: 0xffffff, alpha: 0.5 });
    this.flare.blendMode = 'add';
    this.art.anchor.set(0.5);
    this.art.visible = false;
    this.addChild(this.glow, this.gfx, this.art, this.flare);
    this.makeShadow(radiusPx * 0.8);
  }

  setFaction(faction: Faction): void {
    if (faction === this.faction) return;
    this.faction = faction;
    this.redraw();
  }

  setElement(type: DamageType): void {
    if (type === this.damageType) return;
    this.damageType = type;
    this.redraw();
  }

  /** The bullet's fx colour: its element hue, or the faction colour if physical. */
  get color(): number {
    return (
      ELEMENT_COLORS[this.damageType] ??
      (this.faction === 'enemy' ? THEME.colors.bulletEnemy : THEME.colors.bulletPlayer)
    );
  }

  /**
   * Point the sprite along the round's ground velocity (world px per anything — only the
   * direction is read). Re-sent every reconcile rather than once at spawn, because a deflect
   * reverses a round in flight. A zero velocity leaves the last heading, since it has none.
   */
  setHeading(vx: number, vy: number): void {
    if (vx === 0 && vy === 0) return;
    this.art.rotation = Math.atan2(vy, vx);
    this.artFlipY = vx < 0 ? -1 : 1;
    this.applyScale();
  }

  private redraw(): void {
    const color = this.color;
    const r = this.radiusPx;
    const elemental = ELEMENT_COLORS[this.damageType] !== undefined;
    this.gfx.clear();
    const tex = getBulletTexture(this.damageType);
    if (tex) {
      this.art.texture = tex;
      // An elemental file carries its own colours; the physical one is greyscale and takes
      // the faction colour here, which is what keeps a deflected round recolouring.
      this.art.tint = elemental ? 0xffffff : color;
      this.artScale = (r * ART_LENGTH_R) / Math.max(tex.width, tex.height);
      this.art.visible = true;
    } else {
      this.art.visible = false;
      this.artScale = 0;
      this.gfx.circle(0, 0, r).fill({ color });
    }
    this.applyScale();

    // Elemental rounds get a halo; physical rounds stay clean.
    this.glow.clear();
    if (elemental) {
      for (let i = 3; i >= 1; i--) {
        this.glow.circle(0, 0, r * (1 + i * 0.5)).fill({ color, alpha: 0.12 });
      }
    }
  }

  private applyScale(): void {
    const s = this.popScale;
    this.gfx.scale.set(s);
    this.glow.scale.set(s);
    this.art.scale.set(this.artScale * s, this.artScale * s * this.artFlipY);
  }

  /**
   * Draw this bullet leaving the shooter's actual barrel tip (`Scene` supplies the
   * offset from the engine's spawn point to the drawn muzzle) and ease onto the
   * authoritative sim line over `MUZZLE_EASE_DISTANCE_PX` of travel. Render-only,
   * applied on top of the interpolated sim position — nothing here is ever read back
   * into the sim.
   *
   * A decaying offset rather than just a different starting point, because the two lines are
   * PARALLEL, not merely offset at their origins: the sim places its muzzle `muzzleOffset`
   * along the aim ray, and the rig's own reach out to the barrel tip is a different distance
   * (`muzzleParity`'s table: +9.5 px for the blaster, up to +19.5 across the roster). A round
   * that merely STARTED at the barrel tip would run permanently ahead of its true position by
   * that much. Easing it out instead lets the shot leave the barrel and rejoin its own
   * position within the first `MUZZLE_EASE_DISTANCE_PX` of flight.
   *
   * That gap is a distance along the SHOT, so spending it only ever changes how fast the round
   * appears to travel — it can never bend the path. Both other axes on which the drawn gun and
   * the sim's spawn point used to disagree are now removed at the source rather than eased
   * away here, because easing them was the arc: the SIDEWAYS one by making the module orbit to
   * the aim (`rigWeaponMount`'s GROUND-PLANE ORBIT), the HEIGHT one by `setDrawnHeight` below.
   * The projection in this method is the backstop that keeps it that way.
   *
   * The shadow is deliberately left on the un-offset ground point: it marks where the
   * bullet actually is in the world, which is the sim position, not the drawn one.
   */
  setMuzzleOrigin(dx: number, dy: number, ux: number, uy: number): void {
    // Only the component ALONG the shot survives (`ux, uy` is the round's own unit velocity).
    // A correction perpendicular to the flight direction cannot be spent without moving the
    // drawn round sideways while it flies forward, which IS an arc — it was 20.8 world px and
    // 43° off-aim at the muzzle when the drawn gun sat off the shot's line (user report
    // 2026-09-02, measured off the recorded run; `rigWeaponMount`'s GROUND-PLANE ORBIT note
    // is the fix for the geometry that produced it). Dropping it here makes "a bullet is
    // never bent" a property of this class rather than an outcome of how well the art and the
    // sim happen to agree: whatever is left over, the drawn path is a straight line along the
    // shot. What that costs is that a round starts a hair off the barrel tip when the two
    // disagree sideways — `muzzleParity.test.ts` bounds that gap at every aim angle, which is
    // the honest place to catch it, since it is an art/sim disagreement and not a render bug.
    const along = dx * ux + dy * uy;
    this.originDx = ux * along;
    this.originDy = uy * along;
    this.originRemainingPx = MUZZLE_EASE_DISTANCE_PX;
    this.lastBaseX = this.curX;
    this.lastBaseY = this.curY;
  }

  /**
   * Draw this round at the height the gun that fired it is drawn at (`Actor.muzzleHeightPx`),
   * instead of at the sim's own `bulletZ`. Render-only — `visualZ` never reaches the sim, and
   * `z` itself (which the sim's cover gating reads, design/07) is untouched.
   *
   * The two disagree because they answer different questions: `bulletZ` is a gameplay BAND
   * (0.5 grid = "chest height, clears ground-hug hazards, blocked by tall cover") while the
   * drawn muzzle is wherever the rig hangs the gun — 26.4 vs 16 world px for the hero, i.e. a
   * 10.4 px gap that is straight up the screen, therefore PERPENDICULAR to any horizontal
   * shot, therefore an arc. Correcting it as a height rather than as part of the muzzle offset
   * is what leaves that offset purely along-track (see `setMuzzleOrigin`).
   *
   * Constant for the round's life, so a ballistic that moves its own `z` (a lob's cosmetic
   * arc) still reads as an arc — this shifts the whole curve up, it does not flatten it.
   */
  setDrawnHeight(px: number): void {
    this.visualZ = px - this.curZ;
  }

  override interpolate(alpha: number, frameDt: number): void {
    super.interpolate(alpha, frameDt);
    if (this.popMs > 0) {
      this.popMs = Math.max(0, this.popMs - frameDt);
      const k = this.popMs / SPAWN_POP_MS; // 1 at the shot → 0 once settled
      const ease = k * k; // same ease-out shape as the muzzle correction below
      this.popScale = 1 + SPAWN_POP_SCALE * ease;
      this.applyScale();
      // The flare runs the other way: it starts at full size and collapses into the round.
      this.flare.scale.set(0.25 + 0.75 * ease);
      this.flare.alpha = ease;
      this.flare.visible = this.popMs > 0;
    }
    if (this.originRemainingPx <= 0) return;
    // The GROUND-space interpolated position (same formula `Entity.interpolate` used to write
    // `this.x/y`, computed again here rather than read back off `this.x/y`): the latter is
    // already screen space, `y` shifted up by this frame's `z` lift, which would read every
    // z-height change as extra "travel" and drain the budget for a reason that has nothing to
    // do with how far the bullet has actually flown. Diffing against the same point last frame
    // (or, on the first call, against the spawn position `setMuzzleOrigin` seeded from
    // curX/curY) measures actual world-px travel, not elapsed time, so the budget below drains
    // at the bullet's own speed rather than a fixed wall-clock rate.
    const baseX = this.prevX + (this.curX - this.prevX) * alpha;
    const baseY = this.prevY + (this.curY - this.prevY) * alpha;
    const traveled = Math.hypot(baseX - this.lastBaseX, baseY - this.lastBaseY);
    this.originRemainingPx = Math.max(0, this.originRemainingPx - traveled);
    this.lastBaseX = baseX;
    this.lastBaseY = baseY;
    if (this.originRemainingPx <= 0) return;
    const k = this.originRemainingPx / MUZZLE_EASE_DISTANCE_PX;
    const ease = k * k; // ease-out: most of the correction is spent in the first frames
    this.x += this.originDx * ease;
    this.y += this.originDy * ease;
  }
}
