import { describe, it, expect, vi } from 'vitest';
import { formatSnapshot, PerfOverlay } from './PerfOverlay';
import type { PerfSnapshot } from './PerfMonitor';

function snapshot(over: Partial<PerfSnapshot> = {}): PerfSnapshot {
  return {
    window: {
      fps: 60,
      frames: 120,
      windowMs: 2000,
      busyRatio: 0,
      frame: { p50: 16.7, p95: 20, max: 40 },
      longFrameRatio: 0,
      update: { p50: 1.3, p95: 4, max: 9 },
      render: { p50: 5.1, p95: 12, max: 30 },
      discarded: false,
      ...over.window,
    },
    gl: { draws: 0, programs: 0, textures: 0, framebuffers: 0, ...over.gl },
    filterPasses: over.filterPasses ?? 0,
    scene: { nodes: 900, visible: 860, filtered: 11, capped: false, ...over.scene },
    gpuTextures: over.gpuTextures ?? 52,
    heapMB: over.heapMB === undefined ? 82 : over.heapMB,
    tickerListeners: over.tickerListeners ?? 5,
  };
}

describe('formatSnapshot', () => {
  it('leads with the live fps and the window fps, which are not the same number', () => {
    // The live figure is this instant; the window figure is the 2s average the warnings
    // are computed from. Showing only one of them makes a spiky frame time unreadable.
    const text = formatSnapshot(snapshot(), 58.6);
    expect(text.split('\n')[0]).toBe('fps 59  (win 60)');
  });

  it('marks a window the tab was hidden through, rather than showing it as a real reading', () => {
    // A backgrounded tab reports ~1fps for reasons that have nothing to do with the game.
    const text = formatSnapshot(snapshot({ window: { ...snapshot().window, discarded: true } }), 1);
    expect(text).toContain('hidden');
  });

  it('always shows the update/render split', () => {
    const text = formatSnapshot(snapshot(), 60);
    expect(text).toContain('update 1.3');
    expect(text).toContain('render 5.1');
  });

  it('shows frame percentiles, not just the median', () => {
    const text = formatSnapshot(snapshot(), 60);
    expect(text).toContain('p95 20.0');
    expect(text).toContain('max 40.0');
  });

  it('omits the GL lines entirely when the probe is off', () => {
    // Zeros would read as "this frame issued no draw calls", which is never true.
    const text = formatSnapshot(snapshot(), 60);
    expect(text).not.toContain('draws');
    expect(text).not.toContain('filter passes');
  });

  it('shows draw calls and the implied filter passes when the probe is on', () => {
    const text = formatSnapshot(snapshot({ gl: { draws: 179, programs: 105, textures: 177, framebuffers: 29 }, filterPasses: 14 }), 60);
    expect(text).toContain('draws 179');
    expect(text).toContain('prog 105');
    expect(text).toContain('filter passes ~14');
  });

  it('omits the long-task line where the API is unavailable', () => {
    expect(formatSnapshot(snapshot(), 60)).not.toContain('longtask');
    const busy = formatSnapshot(snapshot({ window: { ...snapshot().window, busyRatio: 0.62 } }), 60);
    expect(busy).toContain('longtask 62%');
  });

  it('marks a capped node walk so the number is not read as a total', () => {
    const text = formatSnapshot(snapshot({ scene: { nodes: 100_000, visible: 90_000, filtered: 3, capped: true } }), 60);
    expect(text).toContain('nodes 100000+');
  });

  it('omits the heap line off Chromium instead of printing null', () => {
    expect(formatSnapshot(snapshot({ heapMB: null }), 60)).not.toContain('heap');
    expect(formatSnapshot(snapshot(), 60)).toContain('heap 82MB');
  });

  it('always reports the filtered-node count — it is the number this renderer lives or dies by', () => {
    expect(formatSnapshot(snapshot(), 60)).toContain('filtered 11');
  });
});

// The class around `formatSnapshot`. Pixi's `Text` measures on a canvas this plain-node
// vitest does not have, and `Graphics` needs no GPU but plenty of Pixi machinery, so both
// are partial-mocked out of `pixi.js` — what is under test here is the CADENCE and the
// positioning, i.e. the parts that decide whether the overlay is itself a cost.
vi.mock('pixi.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('pixi.js')>();
  // Both fakes extend the REAL Container: the overlay parents them, and Pixi's `addChild`
  // rejects anything that is not one. Only the canvas-dependent parts are replaced.
  class FakeText extends orig.Container {
    text: string;
    style: unknown;
    constructor(opts: { text?: string; style?: unknown } = {}) {
      super();
      this.text = opts.text ?? '';
      this.style = opts.style;
    }
    // A fixed measured size, so the bottom-right layout maths has something to work with.
    override get width(): number { return 120; }
    override set width(_v: number) { /* measured, not settable */ }
    override get height(): number { return 90; }
    override set height(_v: number) { /* measured, not settable */ }
  }
  class FakeGraphics extends orig.Container {
    clear() { return this; }
    roundRect() { return this; }
    fill() { return this; }
  }
  return { ...orig, Text: FakeText, Graphics: FakeGraphics };
});

/** A ticker stand-in: only the two fields the overlay reads. */
const tick = (deltaMS: number, FPS = 60) => ({ deltaMS, FPS }) as unknown as import('pixi.js').Ticker;

function labelOf(o: PerfOverlay): { text: string } {
  return (o as unknown as { label: { text: string } }).label;
}

describe('PerfOverlay', () => {
  it('starts hidden — `installPerf` is what decides to show it', () => {
    expect(new PerfOverlay().view.visible).toBe(false);
  });

  it('never swallows a tap meant for the game underneath', () => {
    // It sits on top of the whole stage; an interactive overlay would eat clicks on the
    // pause button and the touch stick.
    expect(new PerfOverlay().view.eventMode).toBe('none');
  });

  it('does no work at all while hidden', () => {
    // Every frame passes through `update`. A hidden overlay that still formatted text would
    // be a permanent per-frame cost in a build that never shows it.
    const o = new PerfOverlay();
    o.setSnapshot(snapshot());
    for (let i = 0; i < 100; i++) o.update(tick(16.7), 800, 600);
    expect(labelOf(o).text).toBe('');
  });

  it('rebuilds the text on the refresh cadence, not every frame', () => {
    // The Text re-upload is the overlay's own cost; at 60fps this is ~2 rebuilds a second
    // instead of 60.
    const o = new PerfOverlay();
    o.toggle(true);
    o.setSnapshot(snapshot());
    o.update(tick(100), 800, 600);
    expect(labelOf(o).text).toBe(''); // 100ms < the refresh interval
    for (let i = 0; i < 4; i++) o.update(tick(100), 800, 600);
    expect(labelOf(o).text).not.toBe('');
  });

  it('says it is still sampling rather than showing a blank box before the first window', () => {
    const o = new PerfOverlay();
    o.toggle(true);
    for (let i = 0; i < 5; i++) o.update(tick(100, 58.6), 800, 600);
    expect(labelOf(o).text).toContain('fps 59');
    expect(labelOf(o).text).toContain('sampling');
  });

  it('shows the snapshot once one has arrived', () => {
    const o = new PerfOverlay();
    o.toggle(true);
    o.setSnapshot(snapshot({ gl: { draws: 157, programs: 95, textures: 150, framebuffers: 6 }, filterPasses: 3 }));
    for (let i = 0; i < 5; i++) o.update(tick(100), 800, 600);
    expect(labelOf(o).text).toContain('draws 157');
    expect(labelOf(o).text).not.toContain('sampling');
  });

  it('toggles without an argument, and to an explicit state with one', () => {
    const o = new PerfOverlay();
    o.toggle();
    expect(o.view.visible).toBe(true);
    o.toggle();
    expect(o.view.visible).toBe(false);
    o.toggle(true);
    o.toggle(true);
    expect(o.view.visible).toBe(true);
  });

  it('sits in the bottom-right, the only corner the HUD leaves free', () => {
    // Top-left is the player card, top-right the pause button and minimap, bottom-left the
    // touch stick — all verified on a live frame before this position was chosen.
    const o = new PerfOverlay();
    o.layout(800, 600);
    expect(o.view.x).toBeGreaterThan(400);
    expect(o.view.y).toBeGreaterThan(300);
  });

  it('never positions itself off-screen on a viewport smaller than itself', () => {
    // The measured size comes from a Text this env cannot lay out, so it is forced here —
    // the clamp is the behaviour under test, not the measurement.
    const o = new PerfOverlay();
    Object.defineProperty(o.view, 'width', { value: 500, configurable: true });
    Object.defineProperty(o.view, 'height', { value: 400, configurable: true });
    o.layout(100, 80);
    expect(o.view.x).toBe(0);
    expect(o.view.y).toBe(0);
  });

  it('re-lays out on every refresh, so a resize cannot strand it', () => {
    // Deliberately not wired to a resize event: the overlay has to survive one whether or
    // not the host remembered to tell it about one.
    const o = new PerfOverlay();
    o.toggle(true);
    o.setSnapshot(snapshot());
    for (let i = 0; i < 5; i++) o.update(tick(100), 800, 600);
    const narrow = o.view.x;
    for (let i = 0; i < 5; i++) o.update(tick(100), 1920, 1080);
    expect(o.view.x).toBeGreaterThan(narrow);
  });
});
