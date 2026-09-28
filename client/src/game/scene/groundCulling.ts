// Split out of `groundLayer.ts` 2026-08-26 (CLAUDE.md form (1) — independent functions over rects,
// no shared private state): which pieces of the ground layer the camera can actually see.
//
// WHY THIS EXISTS. `buildGroundLayer` paints a per-room wash/mottle/decal/light-pool stack, and
// until this pass every room's share of it accumulated into ONE `Graphics` per stage. On the
// 60-room PvP arena that came to 285k + 266k floats, all of it batched and resident every frame
// however far away it was. The camera fits ONE room (`GameLoop.cameraFrame`), so at zoom 4.29 the
// viewport covers 448x199 px of a 3744x2912 px map — 0.8% of its area — and the other 99% was being
// packed into the batcher's buffer and drawn.
//
// The fix is not to draw less; it is to make what is drawn CULLABLE. `buildGroundLayer` mounts one
// piece per room (per region, per door) instead of one per stage, tags each with the rect it
// actually paints, and this module switches the off-screen ones off once per frame from
// `FxController.updateCamera`.
//
// WHAT IT ACTUALLY BOUGHT, measured rather than assumed (2026-08-26, `perf/README.md`'s fifth
// measurement — read it before extending this, because it is mostly a correction):
//
//  - **The submission really does collapse.** Standing in `arena_launch`'s first room, the ground
//    group's batcher packs **101,304 floats / 49,962 indices** instead of **1,730,364 / 845,796**:
//    13 of 374 pieces, a 17x cut in vertex data and triangles, and ~6.5 MB less in the batch buffer.
//  - **The GPU frame did NOT measurably move.** Interleaved A/B on a real GPU, cull on vs every
//    piece forced visible, 13 samples each: 4.07 ms vs 4.28 ms, with the min/max bands OVERLAPPING.
//    By this repo's own standard for a quotable reading that is a null result, not a 5% win.
//  - So the layer's ~2 ms of that frame is **not** vertex or triangle work, and the earlier
//    "resolution-independent, therefore geometry submission" diagnosis does not survive contact
//    with a 17x cut that changed nothing. `perf/README.md`'s SIXTH measurement (2026-08-27) closed
//    the rest of the elimination: it is not the covered area either (scaling this layer to a
//    quarter of the viewport, byte-identical submission, costs MORE), and not the filter passes
//    above it (1.92 ms with the scene-light pass, 1.80 ms without). What is left is per-primitive
//    fragment work on a lot of small blended primitives.
//
// WHAT THAT LEFT, AND WHAT CLOSED IT (2026-08-27). The cull was exact and the pieces it kept were
// the right ones — and 45% of the floor's cost was the three NEIGHBOURING rooms whose mottle spilled
// onto the screen (they painted 1.31 + 1.91 extra viewports). That is fixed upstream, in what
// `groundLayer.ts` paints: `floorClip.ts` stops a room's blobs painting outside the room at all, so
// the tagged rects shrank to the room rects and THIS CULL — unchanged, still an exact intersection —
// now drops a neighbour's halves on its own. Standing in `arena_launch`'s first room, 13 pieces on
// screen became 7, and the GPU frame moved 0.53-0.93 ms across three counterbalanced sessions
// (`perf/README.md`'s seventh measurement). Note what did NOT change here: shrinking the tagged rect
// is still the pop-at-the-screen-edge bug the note below exists to prevent. The rect got smaller
// because the PAINTING got smaller, which is the only way it is allowed to.
//
// Shipped on that footing: it costs nothing measurable, it removes the "one 285k-float Graphics"
// shape the batch policy in `render/staticGraphics.ts` was never measured at, it cuts real memory,
// and vertex throughput is the half that gets relatively WORSE on a phone (design/04's open
// on-device question). It is not shipped as a frame-time win, and nothing here should be quoted as
// one.
//
// TWO THINGS THAT LOOK LIKE DETAILS AND ARE NOT:
//
//  - **The tagged rect is what the piece PAINTS, not the room it belongs to.** A mottle blob is
//    centred inside its room but is up to 1.8 tiles (460 px) across, so a room's dark pass measures
//    838x446 px for a 448x384 room. Culling against the room rect would pop those blobs off at the
//    screen edge. `buildGroundLayer` therefore reads the bounds back off the built geometry
//    (`getLocalBounds`) rather than deriving them from the room, which also means it stays correct
//    if the blob constants change. It is also why a viewport-sized view still keeps ~13 pieces and
//    not 5: the spill reaches several rooms out.
//  - **`culled`, not `visible`/`renderable`.** All three clear the same display bit, but `culled` is
//    the one Pixi's own `Culler` uses, so nothing else in the client competes for it — a quality
//    tier that wants to hide the whole grid can still use `visible` on the same node without the two
//    fighting over one flag.
//
// It is safe for the ground layer to stay ONE render group through all of this, which is worth
// stating because the 2026-08-26 GPU pass says the opposite about the old shape. Toggling a child
// invalidates its render group and repacks the batched geometry that survives the rebuild — which
// was ruinous when a single hidden floor sprite meant repacking ~550k resident floats (measured
// SLOWER than not hiding it at all), and is nothing now that a rebuild only ever repacks what is on
// screen (~100k floats, and only on the frames the visible set changes).
import type { Container } from 'pixi.js';
import type { RectPx } from './wallGeometry';

/** The tag `buildGroundLayer` writes and `cullGroundLayer` reads. Untagged children are never
 *  culled — that is the fail-safe direction: a piece nobody described stays on screen. */
interface TaggedPiece {
  ddGroundBounds?: RectPx;
}

/** Record the world-px rect `node` paints into, so the camera can switch it off when it is
 *  off-screen. */
export function tagGroundPiece(node: Container, bounds: RectPx): void {
  (node as Container & TaggedPiece).ddGroundBounds = bounds;
}

/**
 * How far past its measured bounds a STANDING piece is kept on (world px). A door's travelling
 * rings are empty Graphics when the fixture is built and reach up to 1.65 x its span (~116 px on a
 * 128 px doorway) once they are drawn, and its open-state layers are hidden while it is locked, so
 * neither is in the bounds read at build time. Generous on purpose: an extra wall kept on for a
 * margin's worth of panning costs one more batched block, a ring popping off at the screen's edge
 * is a visible bug.
 */
export const STANDING_CULL_MARGIN = 96;

/**
 * Tag a standing piece of `layers.entities` — a wall block, a door fixture, a pillar, a prop —
 * with the rect it paints, read off its built geometry, once it has been placed (2026-09-28,
 * steady-load pass). The same tag and the same cull as the ground's: `FxController` runs
 * `cullGroundLayer` over `entities` too, and an untagged child (every actor, bullet and pickup)
 * is never touched.
 *
 * Why it matters there more than it did on the ground: a floor's walls are co-resident, so a
 * floor's every block stood in the Y-sorted layer at once — measured on floor 1, 63 standing
 * pieces and 365 visible nodes, 5 of them on screen. Each one was collected on every rebuild of
 * that layer (every shot fired, every kill) and packed and submitted on every frame.
 */
export function tagStandingPiece(node: Container, margin = STANDING_CULL_MARGIN): void {
  const b = node.getLocalBounds();
  tagGroundPiece(node, {
    x: node.x + b.minX - margin,
    y: node.y + b.minY - margin,
    w: b.maxX - b.minX + 2 * margin,
    h: b.maxY - b.minY + 2 * margin,
  });
}

/** The rect `node` was tagged with, or `undefined` for an untagged (never-culled) piece. */
export function groundPieceBounds(node: Container): RectPx | undefined {
  return (node as Container & TaggedPiece).ddGroundBounds;
}

/**
 * Switch every tagged piece of `ground` on or off against `view` — the camera's rectangle in the
 * ground layer's own coordinate space. Returns how many pieces are on screen, which is what the
 * tests and `perf`'s readout assert against.
 *
 * Exact intersection, no margin: a piece turns on the frame its painted rect touches the viewport,
 * which is one frame before any of it could be seen. A margin would only trade frames of headroom
 * for geometry, and there is nothing to buy headroom for — the toggle is a bit flip.
 */
export function cullGroundLayer(ground: Container, view: RectPx): number {
  const vx1 = view.x + view.w;
  const vy1 = view.y + view.h;
  let visible = 0;
  for (const piece of ground.children) {
    const b = groundPieceBounds(piece);
    if (!b) {
      visible += 1;
      continue;
    }
    const on = b.x < vx1 && b.x + b.w > view.x && b.y < vy1 && b.y + b.h > view.y;
    if (on) visible += 1;
    // Written unconditionally on purpose: Pixi's own setter returns early when the bit is already
    // what you are assigning, and it is the setter that marks the render group's structure dirty.
    // A guard here would only duplicate that check.
    piece.culled = !on;
  }
  return visible;
}
