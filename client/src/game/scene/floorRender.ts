// New 2026-08-20 (the scene pass after walls/characters/doors): what makes one room's FLOOR
// different from another's. Sibling of `wallRender.ts`/`doorRender.ts`/`roomLight.ts` — free
// functions over rects, no scene state — and, like `Particles.ts` and `pillarRender.ts`, it adds
// no new art: everything here is the shipped swatch plus Graphics.
//
// **WHY.** Measured on a live full-floor extract of level 1 (`renderer.extract` over
// `layers.world`, luma 0-255): three 256x256 patches of open floor, 512 px apart, in three
// DIFFERENT rooms, came back with identical statistics (mean 38.6, sd 4.6, min 21, max 105) and
// only 2.9% of their bytes differing — and that 2.9% was `roomLight.ts`'s corner falloff, not the
// floor. The whole game was one `TilingSprite` of a 256 px swatch: an exact 8-grid-cell period,
// the same in every room, on every floor, with a swatch whose own contrast is sd 5.2. That is
// what makes five rooms read as one sheet with furniture standing on it, and it is the reason
// `roomLight.ts` had to exist at all — before it, nothing in the frame distinguished one room's
// ground from another's.
//
// Four layers, cheapest first, each one addressing a different scale of the problem:
//
//   0. **The floor stops at the rooms** (`stampFloor` takes a ROOM, and `RoomBuilder` calls it per
//      room). The old TilingSprite covered the world's BOUNDING BOX, which on a `graph2d` floor is
//      much bigger than the union of its rooms — 29-56% of the old floor across the five shipped
//      floors (`floorCoverage.test.ts`), on floor 0 one 1500x430 featureless field with no walls
//      and no room light in it. That single change does more for "five rooms, not one sheet" than
//      any decal.
//   1. **The stamp** (`stampFloor`) — one Sprite per tile instead of one TilingSprite, each
//      MIRRORED from a deterministic hash of its own grid position. Flips are the only transform
//      used, because a seamless tile stays seamless under a mirror (its left edge equals its right
//      edge by definition, so a mirrored copy still matches its neighbour) and does NOT under a 90°
//      rotation, whose edges come from the tile's other axis. This breaks the SHAPE repetition.
//   2. **Mottle** (`drawFloorMottle`) — soft blobs at 1.5-3 tile diameters, dark and light, so the
//      floor has AREAS. The eye reads large-scale value variation long before it reads a repeated
//      cobble, which is why this matters more than the stamp does.
//   3. **Per-room wash** (`drawRoomWash`) — one warm-or-cool multiply per room, chosen by a hash of
//      its index. Room identity, kept inside `13`'s "environment desaturated" band: the strongest
//      wash here moves the floor's mean by a few luma, not into a colour.
//   4. **Wear** (`drawFloorDecals`, `drawDoorWear`) — stains, rubble specks lit from the same
//      upper-left key light as everything else in the room, and a worn light patch across each
//      doorway along its travel axis. This is the layer that gives an empty 512x512 room anything
//      to look at.
//
// Determinism is by hash, never `Math.random` — same reason `Pickup`'s bob phase is a golden angle
// times its entity id (design/06's spirit applied to the render layer): two clients, and two
// visits to the same room, must draw the identical floor.
import { Graphics, Sprite, Texture, Rectangle, type TextureSource } from 'pixi.js';
import type { RectPx } from './wallGeometry';
import { boxInsideRect, fillClippedEllipse, insetRect } from './floorClip';
import { PX_PER_GRID } from '../coords';

/**
 * **There is deliberately no per-tile tint.** The first version dimmed each tile by a hashed
 * 0.93..1.0 — and a 7% step between two adjacent 256 px squares is a *flat rectangle*, so the
 * result painted the tile grid onto the floor far more legibly than the repeated cobble ever had.
 * Measured over a 512x480 region of open floor, it also barely paid for itself: the per-tile tint
 * moved the sd of 64 px patch means by about 1 luma (and in the wrong direction), while the mottle
 * below moved it 2.43 -> 6.96 with a 32.6 luma spread. Value variation belongs at a scale that has
 * nothing to do with the tile grid.
 */

/** Mottle: blob radius as a multiple of the tile size, alpha per band, and how much floor one blob
 *  is worth. Three bands per blob for the same reason `wallRender.CAST_PASSES` has four — a single
 *  ellipse at one alpha shows its own edge. */
const MOTTLE_R_MIN = 0.7;
const MOTTLE_R_SPAN = 1.1;
/** Five bands with the alpha RAMPED by band index, not five bands at one alpha: at a flat alpha
 *  the outermost band's own edge is a visible arc on the floor (seen at 2x on the first version's
 *  three bands), because the step from nothing to full alpha happens in one ellipse. */
const MOTTLE_BANDS = 5;
const MOTTLE_DARK_ALPHA = 0.055;
const MOTTLE_LIGHT_ALPHA = 0.05;
const MOTTLE_LIGHT_COLOR = 0x6b6259; // warm grey: additive, so this lifts without shifting hue much
const MOTTLE_PX_PER_BLOB = 260_000; // ~one blob per 510x510 of floor, per polarity

/**
 * How far inside a room the blob clip RAMPS (`floorClip.ts`, 2026-08-27).
 *
 * `PX_PER_GRID`, and not as a coincidence: every shipped room rect includes its own perimeter wall
 * exactly one grid cell deep, measured rather than assumed — 2/16/30 px inside every room edge of
 * `arena_launch` and all five PvE floors is 100% wall footprint or authored passage and 0% bare
 * floor (`floorClipCoverage.test.ts`). So a cut anywhere inside this depth is a cut under stone. It
 * is the ONE distance that is free everywhere except a doorway, which is what the per-band ramp
 * below exists for.
 */
const CLIP_FEATHER_PX = PX_PER_GRID;

/** Per-room wash: the two directions a room can lean, and the alpha band. Deliberately narrow —
 *  `13` "environment desaturated, hazards saturated": a room that reads as a different COLOUR
 *  competes with the element FX and the loot glow, so what varies is nearer to temperature. */
const WASH_WARM = 0x6d4a30;
const WASH_COOL = 0x2f3d55;
const WASH_ALPHA_MIN = 0.035;
const WASH_ALPHA_SPAN = 0.045;

/** Stains: dark patches, a few overlapping ellipses each. */
const STAIN_PX_PER = 150_000; // ~one per 390x390
const STAIN_BLOBS = 3;
const STAIN_R_MIN = 16;
const STAIN_R_SPAN = 44;
const STAIN_ALPHA = 0.1;

/** Rubble: a speck of debris and its key-light highlight. `SHADOW_SLANT`-consistent direction —
 *  lit from the upper left, like every other surface in the room. */
const RUBBLE_PX_PER = 14_000; // ~one per 118x118
const RUBBLE_R_MIN = 1.8;
const RUBBLE_R_SPAN = 2.6;
/** The dark body carries the speck and the highlight only tips it: at 0.34/0.22 the body vanished
 *  into a floor of the same value and only the white dot survived, which reads as a dirty pixel
 *  rather than as a chip of stone. */
const RUBBLE_DARK_ALPHA = 0.46;
const RUBBLE_LIGHT_ALPHA = 0.13;

/** Door wear: a worn patch on the floor across a passage, elongated along the direction people
 *  actually walk (the passage's SHORT axis — its long axis is the width of the gap in the wall). */
const WEAR_ALONG = 1.9; // × the passage's short side, each way from its centre
const WEAR_ACROSS = 0.42; // × its long side
const WEAR_BANDS = 4;
const WEAR_ALPHA = 0.05;
const WEAR_COLOR = 0x7a6f63;

/**
 * A deterministic 32-bit hash of two integers. Not cryptographic and not trying to be: it needs to
 * be stable across clients and cheap enough to call a few hundred times per room build.
 */
export function hash2(a: number, b: number): number {
  let h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) | 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** `hash2` as a 0..1 float. `salt` lets one (a, b) pair produce a whole series of independent
 *  values — position, radius, alpha — without the caller inventing new coordinates. */
export function unit(a: number, b: number, salt = 0): number {
  return hash2(Math.imul(a | 0, 31) + salt, b) / 4294967296;
}

/** How the tile at grid `(i, j)` is drawn: mirrored on either axis or not. Exported for tests —
 *  the flip SET is the load-bearing part (mirrors only, never a rotation: a seamless tile stays
 *  seamless mirrored and does not rotated, since a rotation brings the other axis's edges to the
 *  seam). */
export function tileVariant(i: number, j: number): { flipX: boolean; flipY: boolean } {
  const h = hash2(i, j);
  return { flipX: (h & 1) === 1, flipY: (h & 2) === 2 };
}

/**
 * Stamp `region` with `tile`, one Sprite per tile of a WORLD-aligned grid, and return them for
 * mounting.
 *
 * The grid is aligned to world (0,0), not to the region, so neighbouring regions' stone lines up
 * exactly as one continuous quarry — the same reason `wallRender.capTile` puts a wall cap's swatch
 * in world space rather than at each block's own origin.
 *
 * `region` is one ROOM, not the world: until 2026-08-20 the floor was one `TilingSprite` over the
 * world's bounding box, which on a `graph2d` floor is far larger than the union of its rooms —
 * 29-56% of the old floor across the five shipped floors (`floorCoverage.test.ts`) — on floor 0
 * one featureless 1500x430 field with no walls, no room light and no decals in it, which is a large
 * part of why "the whole floor reads as one sheet". Outside the rooms belongs to the backdrop.
 *
 * A tile only partly inside the region is CROPPED to the part that is (source frame offset to
 * match, so its stone still lines up) and left unflipped — the crop already ends its seam, and
 * mirroring it too would put a mismatched edge where the floor meets the void.
 *
 * `mirror: false` for a seamless swatch — see the comment at the flip.
 */
export function stampFloor(tile: Texture, region: RectPx, mirror = true): Sprite[] {
  const size = tile.width;
  if (size <= 0 || region.w <= 0 || region.h <= 0) return [];
  const out: Sprite[] = [];
  const i0 = Math.floor(region.x / size);
  const i1 = Math.ceil((region.x + region.w) / size);
  const j0 = Math.floor(region.y / size);
  const j1 = Math.ceil((region.y + region.h) / size);
  for (let j = j0; j < j1; j++) {
    for (let i = i0; i < i1; i++) {
      const tx = i * size;
      const ty = j * size;
      const x0 = Math.max(tx, region.x);
      const y0 = Math.max(ty, region.y);
      const x1 = Math.min(tx + size, region.x + region.w);
      const y1 = Math.min(ty + size, region.y + region.h);
      if (x1 - x0 <= 0.01 || y1 - y0 <= 0.01) continue;
      const full = x1 - x0 >= size - 0.01 && y1 - y0 >= size - 0.01;
      if (full) {
        // An exactly-wrapping swatch is never mirrored: a flip only hides an edge that does not
        // quite match, and on one that does it turns the stone into a kaleidoscope (`biomeTiles`).
        const v = mirror ? tileVariant(i, j) : { flipX: false, flipY: false };
        const sprite = new Sprite(tile);
        // Mirror about the tile's own centre, so a flip never moves the tile off its cell.
        sprite.anchor.set(0.5);
        sprite.position.set(tx + size / 2, ty + size / 2);
        sprite.scale.set(v.flipX ? -1 : 1, v.flipY ? -1 : 1);
        out.push(sprite);
      } else {
        const sprite = new Sprite(cropTile(tile, x0 - tx, y0 - ty, x1 - x0, y1 - y0));
        sprite.position.set(x0, y0);
        out.push(sprite);
      }
    }
  }
  return out;
}

/** The `(dx, dy, w, h)` window of `tile`, sharing the same GPU source. */
function cropTile(tile: Texture, dx: number, dy: number, w: number, h: number): Texture {
  const f = tile.frame;
  return new Texture({
    source: tile.source as TextureSource,
    frame: new Rectangle(
      f.x + Math.max(0, Math.min(f.width - 1, dx)),
      f.y + Math.max(0, Math.min(f.height - 1, dy)),
      Math.max(1, Math.min(f.width, w)),
      Math.max(1, Math.min(f.height, h)),
    ),
  });
}

/**
 * Large-scale value variation over one room: dark blobs into `dark`, light ones into `light` (a
 * separate Graphics because it is additively blended — Pixi tints and normal fills can only
 * multiply down, and a floor that can only ever get darker loses its mean).
 *
 * `tileSize` sets the blob scale so the mottle is deliberately INCOMMENSURATE with the tile grid:
 * blobs land at hashed positions anywhere in the room, at 1.4-3.6 tiles across, so they never
 * reinforce the 256 px period the stamp above is breaking up.
 */
export function drawFloorMottle(dark: Graphics, light: Graphics, room: RectPx, seed: number, tileSize: number): void {
  const count = Math.max(2, Math.round((room.w * room.h) / MOTTLE_PX_PER_BLOB));
  for (let k = 0; k < count * 2; k++) {
    const isLight = k >= count;
    const g = isLight ? light : dark;
    const s = seed * 7919 + k;
    const cx = room.x + unit(s, 1) * room.w;
    const cy = room.y + unit(s, 2) * room.h;
    const r = tileSize * (MOTTLE_R_MIN + MOTTLE_R_SPAN * unit(s, 3));
    const alpha = isLight ? MOTTLE_LIGHT_ALPHA : MOTTLE_DARK_ALPHA;
    const color = isLight ? MOTTLE_LIGHT_COLOR : 0x000000;
    // Where this blob's bands are allowed to stop, staggered by a hashed fraction of a band so two
    // blobs in one room never cut on the same line and their steps cannot add up.
    const stagger = unit(s, 90);
    for (let b = 0; b < MOTTLE_BANDS; b++) {
      const rr = r * (1 - b / (MOTTLE_BANDS + 1));
      // Faintest at the rim, so the blob has no edge of its own — and the same ramp decides the
      // clip: the faintest band may reach the room's own edge, the strongest stops a full grid cell
      // inside it, so the biggest step any cut can make is one band's alpha (`floorClip.ts`).
      const clip = insetRect(room, (CLIP_FEATHER_PX * (b + stagger)) / MOTTLE_BANDS);
      fillClippedEllipse(g, cx, cy, rr, rr * 0.72, clip, { color, alpha: (alpha * (b + 1)) / MOTTLE_BANDS });
    }
  }
}

/** One room's own tint, warm or cool by hash. See `WASH_*` for why the band is this narrow. */
export function drawRoomWash(g: Graphics, room: RectPx, seed: number): void {
  const h = hash2(seed, 0x5eed);
  const color = (h & 1) === 0 ? WASH_WARM : WASH_COOL;
  const alpha = WASH_ALPHA_MIN + WASH_ALPHA_SPAN * (((h >>> 9) & 0xff) / 255);
  g.rect(room.x, room.y, room.w, room.h).fill({ color, alpha });
}

/**
 * Stains and rubble over one room's floor. `avoid` is the room's wall footprints — a speck drawn
 * inside one would be under stone anyway, but rubble sitting in a doorway or on a wall's own
 * footprint is the kind of thing that reads as a bug when the block beside it fades for the
 * occlusion x-ray, so they are skipped rather than covered.
 */
export function drawFloorDecals(
  dark: Graphics,
  light: Graphics,
  room: RectPx,
  seed: number,
  avoid: readonly RectPx[],
): void {
  const area = room.w * room.h;

  const stains = Math.max(1, Math.round(area / STAIN_PX_PER));
  for (let k = 0; k < stains; k++) {
    const s = seed * 104729 + k;
    const cx = room.x + unit(s, 11) * room.w;
    const cy = room.y + unit(s, 12) * room.h;
    for (let b = 0; b < STAIN_BLOBS; b++) {
      const r = STAIN_R_MIN + STAIN_R_SPAN * unit(s, 13 + b);
      const dx = (unit(s, 21 + b) - 0.5) * r * 1.6;
      const dy = (unit(s, 31 + b) - 0.5) * r * 1.1;
      const clip = insetRect(room, (CLIP_FEATHER_PX * b) / STAIN_BLOBS);
      fillClippedEllipse(dark, cx + dx, cy + dy, r, r * 0.7, clip, { color: 0x000000, alpha: STAIN_ALPHA });
    }
  }

  const specks = Math.max(2, Math.round(area / RUBBLE_PX_PER));
  for (let k = 0; k < specks; k++) {
    const s = seed * 15485863 + k;
    const cx = room.x + unit(s, 41) * room.w;
    const cy = room.y + unit(s, 42) * room.h;
    if (avoid.some((a) => cx >= a.x - 2 && cx <= a.x + a.w + 2 && cy >= a.y - 2 && cy <= a.y + a.h + 2)) continue;
    const r = RUBBLE_R_MIN + RUBBLE_R_SPAN * unit(s, 43);
    // A speck is DROPPED rather than clipped, body and highlight together: at alpha 0.46/0.13 a cut
    // through one is a hard step no ramp can hide, and at 2-4 px across there is nothing to ramp
    // over. The union box is the body's, grown for the highlight's own reach above it.
    if (!boxInsideRect(room, cx - r, cy - r * 0.8, cx + r, cy + r * 0.7)) continue;
    fillClippedEllipse(dark, cx, cy, r, r * 0.7, room, { color: 0x000000, alpha: RUBBLE_DARK_ALPHA });
    // Its lit face, up-light: the same fixed upper-left key light the walls, pillars, shadows and
    // the character all agree on.
    fillClippedEllipse(light, cx - r * 0.35, cy - r * 0.4, r * 0.55, r * 0.4, room, { color: 0xffffff, alpha: RUBBLE_LIGHT_ALPHA });
  }
}

/**
 * The worn patch across a doorway (`light`, additive) — floor that has been walked over.
 *
 * Elongated along the passage's SHORT axis, which is the direction of travel: a passage rect is a
 * hole in a wall, so its long axis is the width of the gap and its short axis is the wall's own
 * thickness. The patch therefore reaches out of the doorway into the rooms on both sides, which is
 * also a second, floor-level cue for where a door is — the one thing a kerb-height doorway
 * (`doorRender.ts`) does not get from its silhouette.
 */
export function drawDoorWear(light: Graphics, door: RectPx): void {
  const alongX = door.w <= door.h;
  const cx = door.x + door.w / 2;
  const cy = door.y + door.h / 2;
  const rAlong = (alongX ? door.w : door.h) * WEAR_ALONG;
  const rAcross = (alongX ? door.h : door.w) * WEAR_ACROSS;
  for (let b = 0; b < WEAR_BANDS; b++) {
    const t = 1 - b / (WEAR_BANDS + 1);
    const rx = (alongX ? rAlong : rAcross) * t;
    const ry = (alongX ? rAcross : rAlong) * t;
    light.ellipse(cx, cy, rx, ry).fill({ color: WEAR_COLOR, alpha: WEAR_ALPHA });
  }
}
