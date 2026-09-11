// Split out of doorLights.ts 2026-09-11 (500-line convention, CLAUDE.md form 1 — independent
// function modules): WHERE a door's floor-level decals lie and what SHAPE they are, as free
// functions over one passage rect. No shared private state with the light and shade layers left
// behind in doorLights.ts, which imports `fillFloorPool`/`thresholdPlane` from here and re-exports
// every name below so the pre-split import paths (`./doorLights` and, through it, `./doorRender`)
// stay valid for `doorFx.ts` and the four door test files.
//
// The pool RATIOS and the ring ASPECT live here rather than next to `drawGlow`: they are the
// radius family of the plane, shared by both lock states and by the travelling rings in doorFx.ts.
import { Graphics } from 'pixi.js';
import type { RectPx } from './wallGeometry';

/** Pool rings, widest first: `rx` as a multiple of `DoorFloorPlane.span`, all at `doorLights.GLOW_RING_ALPHA`.
 *  Graduated for the same reason `wallRender.CAST_PASSES` is — one ellipse at one alpha shows its
 *  own hard edge and reads as a painted rug on the floor, which is what the first version looked
 *  like; five rings still showed three of their edges. Nine at a third of the alpha each ramps
 *  smoothly and lands in the same place: A/B'd against the same frame with the layer hidden, the
 *  pool moves a 200x90 px region by a MEAN of +4.0 luma (max +27, 41% of pixels moving more than
 *  3/255) — real, unlike the wall relief filter this project measured at 0.06% and deleted. */
export const GLOW_POOL: readonly number[] = [1.35, 1.2, 1.05, 0.9, 0.76, 0.62, 0.5, 0.38, 0.28];
/** The foreshortening every round thing in this view shares, and a `south` plane's ring aspect.
 *  Since 2026-09-11 a plane carries its own (`DoorFloorPlane.aspect`) — a `sides` door's rings run
 *  along the wall instead, and this is the floor under that. */
export const GLOW_POOL_SQUASH = 0.46;

/**
 * Where a door's floor-level decals lie, and which part of them is on real floor.
 *
 * **WHY THIS EXISTS (2026-09-03d).** Every floor-level layer `doorLights.ts` and `doorFx.ts` draw — both
 * states' pools, the travelling pulse ring, the lock-change burst — was drawn from the threshold
 * SOUTHWARD, on the assumption that what lies in front of a doorway is room floor. True for a door
 * in an east-west wall; false for one in a north-south wall, where the ground south of the
 * fixture's own base line is **the same wall continuing** — `wallRuns.bordersDoorNorth`'s case,
 * which `doorSpillCoverage.test.ts` already measured 12 times across the five shipped floors for a
 * different symptom of it (that run's cap swallowing the door's ART).
 *
 * Measured over all 24 shipped doors (`doorFloorPlaneCoverage.test.ts` re-measures it, and is the
 * test that would have caught this): the 13 whose passage is 64x128 each have runs standing on
 * their south edge, 32-320 px deep, covering all 64 px of the fixture's width — and `blockCapTop`'s
 * `doorClip` puts that run's cap top EXACTLY on the door's threshold. The pool reaches 39.7 px
 * south (`GLOW_POOL[0] * GLOW_POOL_SQUASH * 64`) and the pulse 38.3 px, so **100% of both landed
 * inside that cap**, which Y-sorts after the door (`Entity.zIndex` is the ground y, and the run's
 * is its own south edge) and painted over them. On a live frame that read as a ring with its middle
 * bitten out, which is how it was reported — two arcs flanking the doorway and nothing between.
 *
 * The unifying rule, and why this is one plane rather than an orientation branch per layer: **a
 * floor decal lies on the floor the fixture's own stone is not standing on.** For an east-west wall
 * that is the strip south of the threshold — today's shape, unchanged, and what every swept number
 * in this file was measured on. For a north-south wall it is the floor EAST and WEST of the wall,
 * beside the arch the player walks through. Travel is along the passage's SHORT axis (it is a hole
 * in a wall), the same discriminator `floorRender.drawDoorWear` uses for the worn patch across a
 * doorway, so the two floor-level door decals now agree about which way a door faces.
 *
 * **Where along that floor, and how big (2026-09-04).** Both answers come from the DRAWN opening —
 * `openingW` x `drawH` — and not from the passage AABB, because the passage is not what the player
 * sees. Live report on the first version, with a screenshot circling a `sides` door's ring:
 * *"位置有点偏上了...而且有的门大，有的小，最好那个圈能跟随门的大小进行缩放"* (a bit too high; and
 * doors come in different sizes, so the ring should scale with the door).
 *
 *   centre — a `sides` ring sat at `-r.h / 2`, half the PASSAGE's 128 px depth up-screen, while the
 *            arch standing on that threshold is `leafDrawH` = 94.5 px tall (`RoomBuilder` builds
 *            every door at `DOOR_H`, and 217 rows of leaf art fitted to a 64 px opening want 94.5
 *            of height). So the ring floated 16.8 px above the middle of the fixture the eye reads
 *            as the door, on all 13 of them. It is now the drawn opening's own mid-height, clamped
 *            into the passage. `south` is untouched: there the drawn opening meets its floor at
 *            the threshold, which is already where its ring is centred.
 *   size   — every radius was a multiple of `openingW` alone, which is proportional to the door
 *            and still much too big to read as part of one: 2.7 door widths across. `doorSpan`
 *            below is the multiple instead — a fraction of the drawn opening's own size.
 */
export interface DoorFloorPlane {
  /** Local x of the decals' centre — the middle of the drawn opening either way. */
  readonly cx: number;
  /** Local y of that centre: 0 (the threshold) for `south`, half the DRAWN opening's height
   *  up-screen (i.e. the middle of the arch the player sees) for `sides`. */
  readonly cy: number;
  /** Which part of a ring centred there is on floor. `south` — the fixture's stone stands north of
   *  the centre, so the southern half is drawn. `sides` — the wall runs north-south THROUGH the
   *  centre, so the two side lobes are drawn and `cx` doubles as the half-thickness they clear. */
  readonly floor: 'south' | 'sides';
  /** The radius unit: every floor ring this door draws — the nine pool fills, `doorFx`'s travelling
   *  pulse, its lock-change burst — is a multiple of this. See `doorSpan`. */
  readonly span: number;
  /** The y semi-axis of every one of those rings, per unit x semi-axis — what makes each of them an
   *  ellipse rather than a circle. `south` gets `GLOW_POOL_SQUASH`, the foreshortening every round
   *  thing in this view shares; `sides` gets the drawn opening's own aspect, so the ellipse's long
   *  axis lies along the door's long edge rather than across it. See `ringAspect`. */
  readonly aspect: number;
}

/**
 * The aspect of a `sides` door's rings: the DRAWN opening's own height over its width.
 *
 * **Why a `sides` door does not get the foreshortening (2026-09-11).** Live report, a screenshot
 * circling one of these doors' rings: *"这个椭圆的长边要和门的长边保持一致"* — the ellipse's long axis
 * has to run the same way the door's does. It did not, and only on these 13: at `GLOW_POOL_SQUASH`
 * the widest pool ring is 95 x 44 px lying across a 64 x 94.5 px arch, so the one shape the eye is
 * asked to attach to the doorway is elongated along the doorway's SHORT edge. The 11 `south` doors
 * already satisfy the rule and are untouched — their opening is 128 x 104, wider than it is tall,
 * and so is their 171 x 79 pool.
 *
 * Read as a screen-space rule, which is what every other number on this plane already is (`cy` is
 * the drawn arch's mid-height, not a ground offset): these decals sit beside a north-south wall,
 * where the floor a door's light reaches is a strip ALONG that wall, so a shape that runs with the
 * wall is also the more physical of the two. What it costs is that the foreshortening no longer
 * applies to one of the two plane kinds — a `sides` ring is not a circle on the ground seen at this
 * view's tilt, it is a slot of light lying along the wall, and its ends run a little past the gap
 * the door is cut into (the widest pool ring reaches 70 px from a centre 47 px north of the
 * threshold, against the passage's own 64). Both are why this is a `sides`-only rule.
 *
 * `x` is the axis that may NOT shrink: a ring narrower than the wall's own half-thickness draws
 * literally nothing (`floorArcSpans`), so the aspect is spent on height — the x reach onto the
 * flanking floor, and every clamp measured against it (`ringTravel`), is exactly as it was.
 *
 * The floor clamp is the degenerate-art guard: art with a zero dimension gives `doorLeafFrame` a
 * `drawH` of 0, which would collapse every ring on the plane into a horizontal line.
 */
export function ringAspect(openingW: number, drawH: number): number {
  const w = Math.max(0, openingW);
  if (w <= 0) return GLOW_POOL_SQUASH;
  return Math.max(GLOW_POOL_SQUASH, Math.max(0, drawH) / w);
}

/**
 * How far the widest of a door's floor rings reaches: a fraction of the drawn opening's own size.
 *
 * **The fraction (2026-09-04).** Every ring used to be a multiple of `openingW` itself, so the
 * widest pool ring was 1.35 x the opening's width in RADIUS — an ellipse 2.7 door-widths across,
 * and the travelling pulse 2.6. That is proportional to the door (a 64 px arch and a 128 px one
 * get the same multiple), which is why the live report guessed the ring was a fixed size unrelated
 * to the fixture: *"有的门大，有的小，最好那个圈能跟随门的大小进行缩放"*. What was wrong was not the
 * proportion but the reach — at 2.6 widths the ring is out in the middle of the room, too far from
 * its own doorway for the eye to attach the two. 0.55 puts the widest pool ring about 1.5 door
 * widths across and the pulse about 1.4, chosen by the reporter from that range.
 *
 * The ALPHAS above are untouched and their swept luma figures still hold where they were measured —
 * the pool is the same nine rings at the same alpha each, so its peak (all nine overlapping, at the
 * doorway) is unchanged; what shrank is how far the outermost ones spread.
 *
 * **The size it is a fraction OF.** `openingW` is right for a door whose leaf is taller than the
 * opening is wide — light out of a tall slot pools about as wide as the slot — and wrong for one
 * cropped SHORTER than it is wide, which is what `doorLeafFrame` does to all 11 of the shipped
 * 128 px doorways (217 rows of leaf art fitted to a 128 px width want 189 px of height and get the
 * wall's own 104). Those doors are 23% shorter than they are wide and were wearing the halo of a
 * square one. The geometric mean of the drawn box says so; the `min` clamps it back to the width,
 * so a door that is TALLER than it is wide is sized by the opening the light comes through rather
 * than by how much wall happens to stand above it.
 */
const RING_REACH = 0.55;

export function doorSpan(openingW: number, drawH: number): number {
  const w = Math.max(0, openingW);
  return RING_REACH * Math.min(w, Math.sqrt(w * Math.max(0, drawH)));
}

/**
 * The radius of a TRAVELLING ring (`doorFx`'s pulse and its lock-change burst) partway through its
 * outward journey — `from` and `to` are the multiples of `span` it grows between, `t` runs 0..1.
 *
 * The start is pushed out to the wall's own half-thickness on a `sides` plane, because a ring
 * narrower than that draws literally nothing (`floorArcSpans`) — the wall is standing on it. At the
 * pre-2026-09-04 reach the buried part was under half the travel and the ring still had most of its
 * journey left when it cleared the stone; at 0.55 of a 64 px arch the whole sweep would finish
 * inside the wall and the pulse would vanish on the 13 doors cut through a north-south one. Starting
 * at the face keeps what that clamp is for — a ring that EMERGES from the doorway rather than
 * appearing over it — and spends the travel on floor the player can see.
 */
export function ringTravel(plane: DoorFloorPlane, from: number, to: number, t: number): number {
  const start = Math.max(plane.span * from, plane.floor === 'sides' ? plane.cx : 0);
  const end = Math.max(plane.span * to, start);
  return start + (end - start) * t;
}

/** The plane for one passage AABB and the height its leaf actually draws at (`doorLeaf.leafHeight`).
 *  `w <= h` is `floorRender.drawDoorWear`'s own test for a passage crossed along x (a hole in a
 *  north-south wall); the shipped rects are 64x128 or 128x64 and never square, so the tie-break only
 *  decides a shape no shipped floor has. The `sides` centre is clamped into the passage's own depth,
 *  so an arch taller than the hole it stands in cannot push its floor decals out the far side. */
export function doorFloorPlane(r: RectPx, drawH: number): DoorFloorPlane {
  const span = doorSpan(r.w, drawH);
  return r.w <= r.h
    ? { cx: r.w / 2, cy: -Math.min(Math.max(0, drawH), r.h) / 2, floor: 'sides', span, aspect: ringAspect(r.w, drawH) }
    : { cx: r.w / 2, cy: 0, floor: 'south', span, aspect: GLOW_POOL_SQUASH };
}

/** The threshold plane for a bare opening width: what every call site with no passage rect to hand
 *  (the unit tests, a `DoorFx` built without one) drew before the plane existed. `drawH` defaults to
 *  the width, i.e. to `span === openingW`, so such a call site keeps the pre-span radii exactly. */
export function thresholdPlane(openingW: number, drawH: number = openingW): DoorFloorPlane {
  return { cx: openingW / 2, cy: 0, floor: 'south', span: doorSpan(openingW, drawH), aspect: GLOW_POOL_SQUASH };
}

/** How many segments one arc span is drawn from — 20 for the `south` span, so that plane samples
 *  the exact 21 points the pre-plane ellipse did. */
const ARC_SEGS = 20;

/**
 * A floor ring, stroked, centred on `plane` and drawn only where the fixture's own stone is not
 * standing on it.
 *
 * A full `g.ellipse(cx, 0, ...)` is what the pulse and the burst were first drawn as, and it put
 * their northern halves straight up the door's own stone — a 2 px stroke at 0.3 alpha crossing the
 * hazard leaf and the flanking wall, which on a live frame read as a stray red line through the
 * masonry rather than as a ring on the floor. `GLOW_POOL` gets away with a full ellipse because it
 * is nine FILLS at 0.035; a stroke has nowhere to hide.
 *
 * Segments rather than an arc call: Pixi's `arc` is circular, and the plane's own aspect
 * (`GLOW_POOL_SQUASH` on a `south` plane, the drawn opening's on a `sides` one — see `ringAspect`)
 * is what makes a ring lie on the ground instead of standing up in the air. One `stroke()` over however many subpaths the plane
 * leaves — two for `sides`, and NONE while a `sides` ring is still narrower than the wall's own
 * thickness, which is what makes that pulse emerge from the doorway instead of over it.
 *
 * Lives here rather than in `doorFx.ts` (where the pulse and the burst are) because the plane is
 * this file's and the pool fills below share it.
 */
export function strokeFloorArc(
  g: Graphics,
  plane: DoorFloorPlane,
  rx: number,
  color: number,
  width: number,
  alpha: number,
): void {
  const spans = floorArcSpans(plane, rx);
  if (spans.length === 0) return;
  const ry = rx * plane.aspect;
  for (const [from, to] of spans) {
    for (let i = 0; i <= ARC_SEGS; i++) {
      const th = from + ((to - from) * i) / ARC_SEGS;
      const x = plane.cx + Math.cos(th) * rx;
      const y = plane.cy + Math.sin(th) * ry;
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
  }
  g.stroke({ color, width, alpha });
}

/**
 * The angular spans of that ring which lie on floor.
 *
 * `south` is the half from 0 to pi — screen y grows downward, so that is the southern one, and it
 * is the pre-plane behaviour unchanged. `sides` is the two spans clear of the wall's own thickness:
 * `|cos th| * rx >= cx`, i.e. within `acos(cx / rx)` of 0 (east) and of pi (west), and nothing at
 * all while `rx <= cx`. Exported for tests, which is cheaper than reading spans back out of a
 * Graphics's path to ask "did this ring know where the floor was".
 */
export function floorArcSpans(plane: DoorFloorPlane, rx: number): readonly (readonly [number, number])[] {
  if (plane.floor === 'south') return [[0, Math.PI]];
  if (rx <= plane.cx) return [];
  const a = Math.acos(plane.cx / rx);
  return [
    [-a, a],
    [Math.PI - a, Math.PI + a],
  ];
}

/** The graduated pool both states share: `GLOW_POOL`'s rings, centred on the plane. Unlike the
 *  stroked ring above these are NOT cut back to the floor — nine fills at 0.035 spreading over the
 *  fixture's own stone read as bloom coming off the doorway, the same latitude the pre-plane
 *  version already took over the leaf (and `drawGlow` adds an explicit wash there anyway). */
export function fillFloorPool(g: Graphics, plane: DoorFloorPlane, color: number, alpha: number): void {
  for (const ratio of GLOW_POOL) {
    const rx = plane.span * ratio;
    g.ellipse(plane.cx, plane.cy, rx, rx * plane.aspect).fill({ color, alpha });
  }
}
