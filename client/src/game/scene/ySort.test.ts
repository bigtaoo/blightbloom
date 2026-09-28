/**
 * `ySort.ts` — the Y-sort key written without a notification, and the per-frame check that raises
 * one only when the order has actually changed. The notification is observed as Pixi's own
 * `sortDirty` on the layer and `structureDidChange` on its render group, so these tests fail if
 * `settleYSort` stops reaching the thing that makes Pixi re-sort and rebuild.
 */
import { describe, it, expect } from 'vitest';
import { Container } from 'pixi.js';
import { settleYSort, writeSortKey } from './ySort';

function layer(...keys: number[]): { layer: Container; kids: Container[] } {
  const l = new Container();
  l.sortableChildren = true;
  l.enableRenderGroup();
  const kids = keys.map((k) => {
    const c = new Container();
    c.zIndex = k;
    l.addChild(c);
    return c;
  });
  l.sortChildren();
  l.sortDirty = false;
  l.renderGroup!.structureDidChange = false;
  return { layer: l, kids };
}

describe('writeSortKey', () => {
  it('sets the key Pixi sorts by, readable as zIndex', () => {
    const { kids } = layer(1);
    writeSortKey(kids[0]!, 42);
    expect(kids[0]!.zIndex).toBe(42);
  });

  it('flags neither the sort nor the render group — the zIndex setter does both (control)', () => {
    const { layer: l, kids } = layer(1, 2);
    writeSortKey(kids[0]!, 5);
    expect(l.sortDirty).toBe(false);
    expect(l.renderGroup!.structureDidChange).toBe(false);
    kids[0]!.zIndex = 6;
    expect(l.sortDirty).toBe(true);
    expect(l.renderGroup!.structureDidChange).toBe(true);
  });
});

describe('settleYSort', () => {
  it('does nothing while every child is still in key order', () => {
    const { layer: l, kids } = layer(1, 2, 3);
    writeSortKey(kids[1]!, 2.5); // moved, but not past a neighbour
    expect(settleYSort(l)).toBe(false);
    expect(l.sortDirty).toBe(false);
    expect(l.renderGroup!.structureDidChange).toBe(false);
  });

  it('treats equal keys as in order — the sort is stable, a re-sort would change nothing', () => {
    const { layer: l, kids } = layer(1, 2);
    writeSortKey(kids[1]!, 1);
    expect(settleYSort(l)).toBe(false);
  });

  it('flags a re-sort and a rebuild once two children have crossed', () => {
    const { layer: l, kids } = layer(1, 2, 3);
    writeSortKey(kids[0]!, 2.5);
    expect(settleYSort(l)).toBe(true);
    expect(l.sortDirty).toBe(true);
    expect(l.renderGroup!.structureDidChange).toBe(true);
    l.sortChildren();
    expect(l.children).toEqual([kids[1], kids[0], kids[2]]);
  });

  it('finds a crossing at the END of the layer, not only the start', () => {
    const { layer: l, kids } = layer(1, 2, 3, 4);
    writeSortKey(kids[3]!, 2.5);
    expect(settleYSort(l)).toBe(true);
  });

  it('is a no-op on an empty or single-child layer', () => {
    expect(settleYSort(layer().layer)).toBe(false);
    expect(settleYSort(layer(7).layer)).toBe(false);
  });
});
