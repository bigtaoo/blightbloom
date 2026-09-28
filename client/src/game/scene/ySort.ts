// The Y-sort of `layers.entities`, written so that a MOVE does not cost a rebuild (2026-09-28,
// steady-load pass). Its own module (CLAUDE.md form 1): two free functions, no state.
//
// Pixi's own mechanism is `zIndex` on a `sortableChildren` parent, and its setter calls
// `depthOfChildModified`, which flags the enclosing render group's instruction set for a full
// rebuild. Every moving actor, bullet and pickup writes a new ground y every frame, so the root
// render group — the entities, the terrain, the fx layer, every filter's effect bracket — was
// re-collected and re-batched on every single frame: measured under a 4x CPU throttle, the
// rebuild (`_buildInstructions` plus the batcher's `break`) was ~30% of all frame work.
//
// But a rebuild is only needed when the ORDER changes, and between two frames it almost never
// does: two things swap only at the moment their ground lines cross. So a view writes its sort key
// without the notification (`writeSortKey`), and once per rendered frame `settleYSort` walks the
// layer — one comparison per child — and raises the notification itself, only if some pair is now
// out of order. Pixi then sorts by the same `_zIndex` field it always has, so everything that reads
// `zIndex` (tests, occlusion's `sortY`, the chests and shops that write theirs the normal way) sees
// exactly what it did before.
import type { Container } from 'pixi.js';

/** Set `c`'s Y-sort key without flagging its render group. Only for a child of a layer that
 *  `settleYSort` runs on — anywhere else the new key would never be acted on. */
export function writeSortKey(c: Container, y: number): void {
  c._zIndex = y;
}

/** Flag `layer` for a re-sort if, and only if, its children are no longer in key order. Returns
 *  whether it did. Ties are in order: Pixi's sort is stable, so equal keys keep their current
 *  order and re-sorting them would change nothing. */
export function settleYSort(layer: Container): boolean {
  const kids = layer.children;
  for (let i = 1; i < kids.length; i++) {
    if (kids[i]!._zIndex < kids[i - 1]!._zIndex) {
      kids[i]!.depthOfChildModified();
      return true;
    }
  }
  return false;
}
