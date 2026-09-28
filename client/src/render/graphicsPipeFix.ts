// A one-line fix to Pixi 8.19's `GraphicsPipe.validateRenderable`, installed on import (2026-09-28,
// steady-load pass). Its own module so the patch, its reason and its test live in one place, and so
// `staticGraphics.ts` — whose `redrawnGraphics()` is what the fix makes worth anything — can import
// it for its side effect.
//
// The pipe asks this of every Graphics whose context changed since the last frame: "does the render
// group need its instructions rebuilt?" Pixi's answer is
//
//     const wasBatched = !!graphics._gpuData;
//     return gpuContext.isBatchable || wasBatched !== gpuContext.isBatchable;
//
// and `_gpuData` is a per-renderer map that `ViewContainer` creates in its constructor, so it is
// ALWAYS truthy. `wasBatched` is therefore always true, and a Graphics that does not batch — the one
// kind whose geometry change needs no rebuild at all, because it is drawn on its own straight from
// its context — answers "rebuild" on every change. Measured on a live run: a door's floor pulse,
// redrawn per frame, made the root render group re-collect and re-batch every entity, wall and
// effect bracket on 72% of frames, and marking it `no-batch` changed nothing until this was fixed.
//
// The fix reads the flag the way the rest of the pipe does: batched means this renderer's data for
// the Graphics holds batch elements (`_rebuild` fills them only for a batchable context, and empties
// them otherwise). A batchable context still always answers true — that is Pixi's real rule, since
// its elements live in the group's shared batch.
import { GraphicsPipe, type Graphics } from 'pixi.js';

type PipeThis = { renderer: { uid: number; graphicsContext: { updateGpuContext(c: Graphics['context']): { isBatchable: boolean } } } };
type GpuData = { batches: readonly unknown[] } | undefined;

/** The corrected rule, exported for the test. */
export function validateGraphics(this: PipeThis, graphics: Graphics): boolean {
  const gpuContext = this.renderer.graphicsContext.updateGpuContext(graphics.context);
  if (gpuContext.isBatchable) return true;
  const data = (graphics._gpuData as Record<number, GpuData>)[this.renderer.uid];
  return (data?.batches.length ?? 0) > 0;
}

const proto = GraphicsPipe.prototype as unknown as { validateRenderable: typeof validateGraphics };

/** Pixi's own rule, kept for the test that pins the bug — when a Pixi upgrade fixes it, that test
 *  fails, and this module can go. */
export const pixiValidateRenderable = proto.validateRenderable;

proto.validateRenderable = validateGraphics;
