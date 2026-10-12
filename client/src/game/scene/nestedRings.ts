// Nested-shape ramps (2026-10-12): the alphas that make a set of NESTED translucent shapes composite
// to a chosen darkness profile, shared by the room light (`roomLight.ts`) and the wall's cast shadow
// and base hug (`wallRender.ts`).
//
// Why nested and not side by side. A graduated darkening drawn as adjacent bands, each at its own
// alpha, puts two shape edges on every band boundary. Where that boundary falls inside a pixel both
// shapes are antialiased to PARTIAL coverage there, and two partial coverages composite to less than
// either band alone — a bright hairline on every boundary; and where the bands do not quite meet,
// as the base hug's 3 px strokes on 1.5/4/7/10.5/14 px centres did not, a real gap of bare floor.
// On the light warm-stone floor both read as seams, parallel to every wall, rooted in the world and
// crawling against the player as the camera moved ("缝隙特别多，移动的时候缝隙抖动"). With every shape
// anchored at the same source edge, each boundary is ONE shape's edge, so its antialiasing blends one
// step into the next and nothing brighter than either side can appear.

/**
 * Alphas for `targets.length` nested shapes, smallest first, so that band `j` — the region covered
 * by shapes `j..n-1` and by no smaller one — composites to `targets[j]`. `targets` is darkness
 * (0 = untouched, 1 = black), band 0 nearest the source, and must not increase outward.
 *
 * Peeling from the outermost band inward: band `j` is band `j + 1` with shape `j` laid on top, so
 * `1 - targets[j] = (1 - targets[j + 1]) * (1 - a_j)`.
 */
export function nestedAlphas(targets: readonly number[]): number[] {
  return targets.map((c, j) => {
    const outer = j + 1 < targets.length ? targets[j + 1]! : 0;
    return 1 - (1 - c) / (1 - outer);
  });
}
