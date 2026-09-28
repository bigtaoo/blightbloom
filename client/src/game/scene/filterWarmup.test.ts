/**
 * `FilterWarmup` — draws one instance of each actor filter while the world is covered, so the
 * shader programs are linked there instead of on the first enemy death (`DissolveFilter`, measured
 * 13 ms of a 36 ms frame) or the first outline. What can be checked without a GPU: that the probes
 * really go into the drawn tree with a filter each, come out after `WARM_FRAMES`, and never twice.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Container, DOMAdapter, Filter, Sprite, type Adapter } from 'pixi.js';
import { FilterWarmup, WARM_FRAMES } from './filterWarmup';
import { DissolveFilter, HeatHazeFilter, OutlineFilter } from '../fx/filters/skinFx';
import { EnergyShieldFilter } from '../fx/filters/shieldFx';

function probesOf(parent: Container): Sprite[] {
  const holder = parent.children.find((c) => c.label === 'filter-warmup');
  return (holder?.children ?? []) as Sprite[];
}

/** Stand in a canvas for the one probe `defaultWarmFilters` makes, and hand `GlProgram` a GL-shaped
 *  context that answers the one precision query it asks. The unit suite has no DOM; the real filters
 *  need nothing else from it to construct. */
function withFakeCanvas(): void {
  const gl = {
    getShaderPrecisionFormat: () => ({ precision: 23, rangeMin: 127, rangeMax: 127 }),
    HIGH_FLOAT: 0, FRAGMENT_SHADER: 0,
    getExtension: () => null,
  };
  const canvas = { getContext: () => gl, width: 1, height: 1 } as unknown as HTMLCanvasElement;
  const real = DOMAdapter.get();
  DOMAdapter.set({ ...real, createCanvas: () => canvas } as Adapter);
  restore = () => DOMAdapter.set(real);
}
let restore = (): void => {};
afterEach(() => {
  restore();
  restore = () => {};
});

describe('FilterWarmup', () => {
  it('warms nothing, and is done, where Pixi cannot make a canvas (no GL: nothing to link)', () => {
    const parent = new Container();
    const w = new FilterWarmup(parent);
    expect(() => w.arm()).not.toThrow();
    expect(parent.children).toHaveLength(0);
    // ...and settled: it does not keep probing on every later build.
    withFakeCanvas();
    w.arm();
    expect(parent.children).toHaveLength(0);
  });

  it('mounts one visible, filtered probe per actor filter — all four of them', () => {
    withFakeCanvas();
    const parent = new Container();
    new FilterWarmup(parent).arm();
    const probes = probesOf(parent);
    const kinds = probes.map((s) => s.filters![0]!.constructor);
    expect(kinds).toEqual([OutlineFilter, DissolveFilter, HeatHazeFilter, EnergyShieldFilter]);
    for (const s of probes) {
      expect(s.visible).toBe(true);
      expect(s.alpha).toBe(1);
      expect(s.width).toBeGreaterThan(0);
      expect(s.filters).toHaveLength(1);
    }
  });

  it('draws each at a strength that actually paints, not a zero that might be skipped', () => {
    withFakeCanvas();
    const parent = new Container();
    new FilterWarmup(parent).arm();
    const [outline, dissolve, , shield] = probesOf(parent).map((s) => s.filters![0]!);
    expect((outline as OutlineFilter).alpha).toBeGreaterThan(0);
    expect((dissolve as DissolveFilter).progress).toBeGreaterThan(0);
    expect(shield).toBeInstanceOf(EnergyShieldFilter);
  });

  it(`stays up for WARM_FRAMES (${WARM_FRAMES}) frames, then removes and destroys everything`, () => {
    const parent = new Container();
    const f = new Filter({});
    const destroy = vi.spyOn(f, 'destroy');
    const w = new FilterWarmup(parent, () => [f]);
    w.arm();
    for (let i = 1; i < WARM_FRAMES; i++) {
      w.tick();
      expect(probesOf(parent)).toHaveLength(1);
    }
    w.tick();
    expect(parent.children).toHaveLength(0);
    expect(destroy).toHaveBeenCalled();
  });

  it('warms once per session — a program, once linked, stays linked', () => {
    const parent = new Container();
    const make = vi.fn(() => [new Filter({})]);
    const w = new FilterWarmup(parent, make);
    w.arm();
    w.arm(); // a second build while still warming: no second set
    for (let i = 0; i < WARM_FRAMES; i++) w.tick();
    w.arm(); // the next floor's build
    expect(make).toHaveBeenCalledTimes(1);
    expect(parent.children).toHaveLength(0);
  });

  it('a cancelled warm-up is NOT done: the next build warms again', () => {
    const parent = new Container();
    const make = vi.fn(() => [new Filter({})]);
    const w = new FilterWarmup(parent, make);
    w.arm();
    w.cancel();
    expect(parent.children).toHaveLength(0);
    w.arm();
    expect(make).toHaveBeenCalledTimes(2);
    expect(probesOf(parent)).toHaveLength(1);
  });

  it('survives its probes having been destroyed out from under it (a run reset sweeps the fx layer)', () => {
    const parent = new Container();
    const w = new FilterWarmup(parent, () => [new Filter({})]);
    w.arm();
    for (const c of [...parent.children]) c.destroy();
    expect(() => w.cancel()).not.toThrow();
    expect(() => w.tick()).not.toThrow();
  });

  it('tick with nothing armed is a no-op', () => {
    const parent = new Container();
    const w = new FilterWarmup(parent, () => [new Filter({})]);
    expect(() => w.tick()).not.toThrow();
    expect(parent.children).toHaveLength(0);
  });

  it('goes UNDER everything already in its layer, so whatever covers the world covers it too', () => {
    const parent = new Container();
    const hud = new Container();
    parent.addChild(hud);
    new FilterWarmup(parent, () => [new Filter({})]).arm();
    expect(parent.children[0]!.label).toBe('filter-warmup');
    expect(parent.children[1]).toBe(hud);
  });
});
