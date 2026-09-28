/**
 * `graphicsPipeFix` — the corrected "does this Graphics change need a render-group rebuild" rule,
 * and the Pixi bug it replaces.
 *
 * Both rules run against the REAL `GraphicsContextSystem` (the same smallest fake renderer
 * `staticGraphics.test.ts` uses), so `isBatchable` is Pixi's own decision and not a restated one.
 * The bug test is the one that matters most: it passes only while Pixi still answers "rebuild" for
 * a never-batched Graphics. When an upgrade fixes that it fails, and this module can be deleted.
 */
import { describe, it, expect } from 'vitest';
import { Graphics, GraphicsContextSystem, GraphicsPipe } from 'pixi.js';
import { pixiValidateRenderable, validateGraphics } from './graphicsPipeFix';
import { redrawnGraphics } from './staticGraphics';

const UID = 1;

function pipeThis(): ThisParameterType<typeof validateGraphics> {
  const renderer = { uid: UID, limits: { maxBatchableTextures: 16 }, gc: { addResourceHash: () => undefined, now: 0 } };
  return { renderer: { uid: UID, graphicsContext: new GraphicsContextSystem(renderer as never) } } as never;
}

const small = (g: Graphics): Graphics => g.rect(0, 0, 4, 4).fill(0xffffff);

describe('the Pixi bug this module exists for', () => {
  it('Pixi answers "rebuild" for a Graphics that has never batched — `_gpuData` is always truthy', () => {
    const g = small(redrawnGraphics());
    expect(g._gpuData).toBeTruthy(); // created by the ViewContainer constructor, not by a render
    expect(pixiValidateRenderable.call(pipeThis(), g)).toBe(true);
  });
});

describe('validateGraphics', () => {
  it('needs no rebuild for a no-batch Graphics that was never batched', () => {
    expect(validateGraphics.call(pipeThis(), small(redrawnGraphics()))).toBe(false);
  });

  it('needs one for a no-batch Graphics that still holds batch elements from when it batched', () => {
    const g = small(redrawnGraphics());
    (g._gpuData as unknown as Record<number, { batches: unknown[] }>)[UID] = { batches: [{}] };
    expect(validateGraphics.call(pipeThis(), g)).toBe(true);
  });

  it('reads the batch elements of THIS renderer only', () => {
    const g = small(redrawnGraphics());
    (g._gpuData as unknown as Record<number, { batches: unknown[] }>)[UID + 1] = { batches: [{}] };
    expect(validateGraphics.call(pipeThis(), g)).toBe(false);
  });

  it('always needs one for a batchable Graphics — its elements live in the shared batch', () => {
    const g = small(new Graphics());
    expect(validateGraphics.call(pipeThis(), g)).toBe(true);
    expect(pixiValidateRenderable.call(pipeThis(), g)).toBe(true); // Pixi's rule agrees there
  });

  it('is installed on the pipe by importing `staticGraphics`', () => {
    expect(GraphicsPipe.prototype.validateRenderable).toBe(validateGraphics);
    expect(pixiValidateRenderable).not.toBe(validateGraphics);
  });
});
