/**
 * `staticGraphics` — and, more importantly, the Pixi v8 rule it exists to override.
 *
 * The factory itself is one line, so a test that only checked `batchMode === 'batch'` would be
 * restating the implementation. What actually needs pinning is the *premise*: that Pixi auto-batches
 * a `Graphics` only below 400 floats of geometry, that the comparison is strict, and that `'batch'`
 * overrides it however large the geometry gets. Every doc comment in this module, `scene/layers.ts`'s
 * render-group split, `perf/drawAttribution.ts`'s `AUTO_BATCH_VERTEX_LIMIT` and the whole 2026-08-24
 * draw-call pass rest on that rule holding — and it lives in Pixi, where a version bump can move it
 * without any of our types noticing.
 *
 * So the rule is exercised against the REAL `GraphicsContextSystem`, driven by the smallest fake
 * renderer it will accept (it wants only a uid, a texture limit and a GC hash registry).
 */
import { describe, it, expect } from 'vitest';
import { Graphics, GraphicsContextSystem } from 'pixi.js';
import { redrawnGraphics, staticGraphics } from './staticGraphics';
import { AUTO_BATCH_VERTEX_LIMIT } from '../perf/drawAttribution';

/** Pixi's own batching decision, run for real. */
function contextSystem(): GraphicsContextSystem {
  const renderer = {
    uid: 1,
    limits: { maxBatchableTextures: 16 },
    gc: { addResourceHash: () => undefined, now: 0 },
  } as never;
  return new GraphicsContextSystem(renderer);
}

/** `n` axis-aligned rects — 4 vertices, i.e. 8 floats, each. */
function rects(g: Graphics, n: number): Graphics {
  for (let i = 0; i < n; i++) g.rect(i, 0, 5, 5).fill(0xffffff);
  return g;
}

describe('Pixi v8 auto-batching — the premise this module overrides', () => {
  it('batches under 400 floats and stops AT 400, not after it', () => {
    // The strictness matters: `updateGpuContext` compares `vertices.length < 400`, so 400 floats
    // exactly is already unbatched. A test written as `<= 400` would pass today and mis-describe the
    // boundary for whoever tries to shrink a Graphics to fit under it.
    const sys = contextSystem();
    const under = sys.updateGpuContext(rects(new Graphics(), 49).context);
    const at = sys.updateGpuContext(rects(new Graphics(), 50).context);
    expect(under.geometryData.vertices.length).toBe(392);
    expect(at.geometryData.vertices.length).toBe(AUTO_BATCH_VERTEX_LIMIT);
    expect(under.isBatchable).toBe(true);
    expect(at.isBatchable).toBe(false);
  });

  it('counts FLOATS, not vertices and not fills', () => {
    // A 400-*vertex* or 400-*fill* reading of the same constant would put the cliff four to eight
    // times further out, which is the difference between "the wall shading is fine" and the finding
    // the 2026-08-24 pass was built on. One rect is 8 floats, so 50 rects is the cliff.
    const sys = contextSystem();
    const g = rects(new Graphics(), 50);
    const gpu = sys.updateGpuContext(g.context);
    expect(gpu.geometryData.vertices.length).toBe(50 * 8);
    expect(gpu.batches).toHaveLength(50); // 50 fills, far fewer than 400 — and already unbatched
  });

  it('AUTO_BATCH_VERTEX_LIMIT is the number Pixi actually applies', () => {
    // If a Pixi upgrade moves the cutoff, this is the test that says so — the census would keep
    // reporting the right verdict (it reads Pixi's own flag) while every comment quoting 400 went
    // stale, which is the silent half of that upgrade.
    const sys = contextSystem();
    const justUnder = rects(new Graphics(), (AUTO_BATCH_VERTEX_LIMIT - 8) / 8);
    expect(sys.updateGpuContext(justUnder.context).isBatchable).toBe(true);
    const justAt = rects(new Graphics(), AUTO_BATCH_VERTEX_LIMIT / 8);
    expect(sys.updateGpuContext(justAt.context).isBatchable).toBe(false);
  });
});

describe('staticGraphics', () => {
  it('overrides the cutoff — batched at 20x the auto limit', () => {
    // The whole point: geometry this size is exactly what Pixi refuses to batch, and what the
    // room's shared wall shadow and the floor's decal pass actually are.
    const sys = contextSystem();
    const g = rects(staticGraphics(), 1000);
    const gpu = sys.updateGpuContext(g.context);
    expect(gpu.geometryData.vertices.length).toBeGreaterThan(AUTO_BATCH_VERTEX_LIMIT * 19);
    expect(gpu.isBatchable).toBe(true);
  });

  it('is a real, empty, usable Graphics — not a wrapper', () => {
    const g = staticGraphics();
    expect(g).toBeInstanceOf(Graphics);
    expect(g.context.instructions).toHaveLength(0);
    g.rect(0, 0, 4, 4).fill(0x112233);
    expect(g.context.instructions).toHaveLength(1);
  });

  it('does not change Pixi\'s default for anything else', () => {
    // `batchMode` is per GraphicsContext, so a factory that reached for a global or a prototype
    // default would silently opt the Y-sorted entities layer in too — the one place the 2026-08-24
    // measurement says must stay on 'auto'.
    staticGraphics();
    expect(new Graphics().context.batchMode).toBe('auto');
  });
});

describe('redrawnGraphics', () => {
  it('never batches, however small — a redraw must not rebuild the enclosing render group', () => {
    const g = rects(redrawnGraphics(), 1); // 8 floats: Pixi would auto-batch this
    expect(contextSystem().updateGpuContext(g.context).isBatchable).toBe(false);
    expect(contextSystem().updateGpuContext(rects(new Graphics(), 1).context).isBatchable).toBe(true); // control
  });
});
