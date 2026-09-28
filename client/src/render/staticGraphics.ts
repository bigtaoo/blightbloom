// Batch-mode policy for `Graphics` whose geometry is authored once and thereafter only moved.
//
// Pixi v8 decides per `GraphicsContext` whether a Graphics joins the sprite batcher or gets a
// draw call of its own: `GraphicsContextSystem.updateGpuContext` marks a context batchable when
// `batchMode === 'auto'` and its geometry is under 400 floats, or unconditionally when
// `batchMode === 'batch'`. A NON-batchable Graphics makes `GraphicsPipe.addRenderable` call
// `batch.break()` and then submit the object on its own — one draw call, one switch to the
// graphics program, and one switch back for whatever sprite follows it.
//
// That 400-float threshold is far below what this project's hand-banded shading produces: a
// room's shared wall-shadow Graphics is ~24k floats, the floor's decal pass ~50k, an actor's
// ground shadow ~830. Every one of them was costing a draw call plus (where it sat between
// sprites) two program switches. Measured on the level-1 start room, 8 live enemies, 1920x855:
// the ground and shadow layers alone were 27 draw calls of the frame's 161.
//
// The catch, and why this is a POLICY rather than a blanket default: a batched Graphics has its
// vertices packed into the shared batcher, and that packing is redone whenever the render group's
// instruction set is rebuilt. Pixi rebuilds a group's instructions whenever any descendant's
// `zIndex` is written (`sortMixin.depthOfChildModified` sets `structureDidChange`), and this game
// writes a `zIndex` per actor per frame — that is what the Y-sorted `entities` layer IS. So inside
// a render group that holds moving actors, forcing `batch` on big geometry trades ~50 draw calls
// for a per-frame repack of every vertex, which measured NET SLOWER (+0.7 ms of a 2.4 ms render
// on the wall shading alone). Outside such a group — `layers.ground`, `layers.shadow`, which
// `Layers` gives their own render groups precisely so an actor's zIndex cannot dirty them — the
// instruction set is cached across frames, the packing happens once, and the same change measured
// -24 draw calls for -0.08 ms.
//
// Hence the rule this module encodes: use `staticGraphics()` for authored-once geometry that lives
// in a render group WITHOUT moving Y-sorted children. Leave everything else on Pixi's `auto`.
//
// One measured caveat, recorded rather than hidden: `layers.shadow` is only static in the sense that
// it does not RESORT. Bullets and actors put a shadow on it when they spawn and take it away when
// they die, and a spawn/removal does invalidate the group — so during sustained fire that layer is
// dirty most frames and its batched geometry is repacked. Interleaved A/B while holding fire put the
// cost at about **+0.12 ms**, against -22 draw calls and the -0.08 ms this buys the rest of the time.
// Shipped on that balance, not because the cost is zero. Note also that the harness resolves about
// ±0.3 ms, so anything smaller than this is not measurable here: wrapping the room's shared wall
// shadow in a second render group to isolate it from that churn was tried and came out WORSE, which
// is most likely to mean "below the noise floor" rather than a real effect either way.
import { Graphics } from 'pixi.js';
// Installs the no-batch fix `redrawnGraphics` depends on — see that module.
import './graphicsPipeFix';

/**
 * A `Graphics` that always joins the sprite batcher, however large its geometry.
 *
 * Only for geometry that is drawn once at build time and afterwards only transformed, and only on
 * a layer whose render group is not rebuilt every frame — see the module header for the
 * measurement behind both conditions.
 */
export function staticGraphics(): Graphics {
  const g = new Graphics();
  g.context.batchMode = 'batch';
  return g;
}

/**
 * A `Graphics` that never joins the sprite batcher — for geometry REDRAWN every frame.
 *
 * The opposite case, found 2026-09-28 (steady-load pass): Pixi's `GraphicsPipe.validateRenderable`
 * answers "rebuild the whole render group" for ANY batched Graphics whose context changed, because
 * its vertices live in the group's shared batch. So one small ring redrawn per frame — a door's
 * floor pulse, 168 floats — made the root render group re-collect and re-batch every entity, wall
 * and effect bracket on every frame it was on screen. A non-batched Graphics is submitted on its
 * own and its changed geometry is simply re-uploaded: one draw call instead of a rebuild.
 *
 * The draw call is not free (it breaks the batch it sits in), so a caller should also hide the
 * Graphics while it has nothing to draw, the way `doorFx.clearOnce` does.
 */
export function redrawnGraphics(): Graphics {
  const g = new Graphics();
  g.context.batchMode = 'no-batch';
  return g;
}
