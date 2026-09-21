/**
 * The progress screen (design/12) — the parts that are wrong silently.
 *
 * A spinner that does not spin, a bar that does not move, a scrim that does not stop a tap and a
 * ticker callback that outlives the screen all look identical in a screenshot and identical in a
 * passing suite that only checks the class constructs. Those four are what this file is about.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Container, Graphics, Ticker, type Application } from 'pixi.js';
import { LoadingScreen, showBootLoading } from './loadingScreen';
import { pinTextMeasurementToPaintCanvas } from '../../render/textMetrics';

beforeEach(() => {
  // Pixi memoises its text-measurement canvas on first use (render/textMetrics.ts).
  pinTextMeasurementToPaintCanvas();
});

function make(sizeOf?: () => { w: number; h: number }): { screen: LoadingScreen; ticker: Ticker } {
  const ticker = new Ticker();
  return { screen: new LoadingScreen({ label: 'LOADING', ticker, sizeOf }), ticker };
}

/** The scrim is the first child and the only full-viewport shape. */
function scrimOf(screen: LoadingScreen): Graphics {
  return screen.view.children[0] as Graphics;
}

describe('the spinner', () => {
  it('advances on wall-clock time, not on frame count', () => {
    // A boot slow enough to need a progress screen is a boot whose frame rate is not the thing to
    // trust. Two ticks of 8 ms must move it exactly as far as one of 16. Read off the ANGLE, not
    // the instruction count: `spin` redraws the same four instructions every time, so a count
    // would be identical whether the angle moved or not.
    const twoSteps = make().screen;
    const oneStep = make().screen;
    for (const s of [twoSteps, oneStep]) s.layout(800, 600);
    twoSteps['spin'](8);
    twoSteps['spin'](8);
    oneStep['spin'](16);
    expect(twoSteps['angle']).toBeCloseTo(oneStep['angle'], 10);
    expect(twoSteps['angle']).toBeGreaterThan(0); // ...and it moved at all
    // ...and the arc it drew is real geometry, not an empty redraw.
    expect((twoSteps.view.children[1] as Graphics).context.instructions.length).toBeGreaterThan(0);
    for (const s of [twoSteps, oneStep]) s.destroy();
  });

  it('registers exactly one ticker callback, and removes it on destroy', () => {
    const { screen, ticker } = make();
    expect(ticker.count).toBe(1);
    screen.destroy();
    expect(ticker.count).toBe(0);
  });

  it('leaves the display tree with no trace of the screen', () => {
    const parent = new Container();
    const { screen } = make();
    parent.addChild(screen.view);
    expect(parent.children.length).toBe(1);
    screen.destroy();
    expect(parent.children.length).toBe(0);
  });
});

describe('the bar', () => {
  it('draws nothing at all until a total is known', () => {
    // A caller that never reports progress gets the spinner alone — the right answer for a wait
    // whose length is genuinely unknown, and the reason the bar is a separate Graphics.
    const { screen } = make();
    screen.layout(800, 600);
    const bar = screen.view.children[2] as Graphics;
    expect(bar.context.instructions.length).toBe(0);
    screen.destroy();
  });

  it('draws a track and a fill once there is progress, and only a track at zero', () => {
    const { screen } = make();
    screen.layout(800, 600);
    const bar = screen.view.children[2] as Graphics;
    screen.setProgress(0, 16);
    const atZero = bar.context.instructions.length;
    screen.setProgress(8, 16);
    const halfway = bar.context.instructions.length;
    expect(atZero).toBeGreaterThan(0);
    expect(halfway).toBeGreaterThan(atZero); // the fill is a second rect, not a resized one
    screen.destroy();
  });

  it('survives a progress report that arrives before any layout', () => {
    // `ArtGate` sets the total before it lays out; a bar drawn against a 0-width viewport must
    // not throw or emit a negative-width rect.
    const { screen } = make();
    expect(() => screen.setProgress(3, 16)).not.toThrow();
    screen.layout(844, 390);
    screen.destroy();
  });
});

describe('the scrim', () => {
  it('is interactive, so a tap cannot reach the screen still standing underneath', () => {
    // The run gate returns BEFORE the transition happens, so the screen a player was looking at
    // is still there and still hit-testable. Pixi stops at the topmost interactive target.
    const { screen } = make();
    expect(scrimOf(screen).eventMode).toBe('static');
    screen.destroy();
  });

  it('covers the whole viewport it was laid out against, at every size', () => {
    const { screen } = make();
    for (const [w, h] of [[800, 600], [844, 390], [390, 844]] as const) {
      screen.layout(w, h);
      const b = scrimOf(screen).getLocalBounds();
      expect(b.width, `${w}x${h}`).toBe(w);
      expect(b.height, `${w}x${h}`).toBe(h);
    }
    screen.destroy();
  });
});

describe('a resize mid-wait', () => {
  it('re-lays-out from the live viewport on the next tick', () => {
    // The one-shot `layout()` at construction cannot cover this: on web the renderer follows the
    // window, and a wait worth showing is long enough for the window to change.
    const size = { w: 800, h: 600 };
    const { screen } = make(() => size);
    screen.layout(size.w, size.h);
    size.w = 844;
    size.h = 390;
    screen['onTick'](Object.assign(new Ticker(), { deltaMS: 16 }));
    const b = scrimOf(screen).getLocalBounds();
    expect([b.width, b.height]).toEqual([844, 390]);
    screen.destroy();
  });

  it('does not re-lay-out when nothing changed', () => {
    const { screen } = make(() => ({ w: 800, h: 600 }));
    screen.layout(800, 600);
    screen.setProgress(4, 16);
    const before = (screen.view.children[2] as Graphics).context.instructions.length;
    screen['onTick'](Object.assign(new Ticker(), { deltaMS: 16 }));
    expect((screen.view.children[2] as Graphics).context.instructions.length).toBe(before);
    screen.destroy();
  });
});

/** Everything `showBootLoading` touches on the `Application` it is handed: the stage it parks
 *  itself on, the ticker it spins on, and `renderer.screen` — which is all `computeScreenSize`
 *  reads (viewport.ts). No WebGL context is needed for any of that. */
function fakeApp(w: number, h: number): { app: Application; stage: Container; ticker: Ticker } {
  const stage = new Container();
  const ticker = new Ticker();
  const app = { stage, ticker, renderer: { screen: { width: w, height: h } } };
  return { app: app as unknown as Application, stage, ticker };
}

/** `bootHold.ts`'s floor, turned off. Every case below is about what the screen DOES, and a
 *  real three-second hold in each of them would make this file the slowest in the suite. The
 *  floor itself has its own case at the bottom, with an injected clock. */
const NO_FLOOR = { minMs: 0 };

describe('showBootLoading — the boot wait, on the stage', () => {
  it('parks a laid-out screen on the stage, so a cold boot has something on it', async () => {
    // The WeChat entry's ONLY feedback while the `lobby` subpackage downloads: there is no DOM
    // splash to fall back on the way web has (`index.html`'s `#boot-loading`). Dropping the
    // `app.stage.addChild(screen.view)` boots the mini-game to a blank screen with no spinner and
    // no error, for as long as the download takes — and nothing else in this suite looked, because
    // every other case constructs `LoadingScreen` directly and never goes through this function.
    const { app, stage, ticker } = fakeApp(844, 390);

    const loading = showBootLoading(app, NO_FLOOR);

    expect(stage.children.length).toBe(1);
    // Laid out against the viewport BEFORE the first paint, not left 0x0 for a frame — which on a
    // slow boot is a visible flash. Read off the scrim, the only full-viewport shape.
    const view = stage.children[0] as Container;
    const scrim = (view.children[0] as Graphics).getLocalBounds();
    expect([scrim.width, scrim.height]).toEqual([844, 390]);
    // ...and it is really spinning, on the app's own ticker.
    expect(ticker.count).toBe(1);

    await loading.done();
  });

  it('reads the viewport from renderer.screen, at whatever size the device is', async () => {
    // `computeScreenSize`, never `renderer.width / resolution` — see viewport.ts's header for the
    // HiDPI bug that division caused, invisible at devicePixelRatio 1.
    for (const [w, h] of [[390, 844], [1280, 720]] as const) {
      const { app, stage } = fakeApp(w, h);
      const loading = showBootLoading(app, NO_FLOOR);
      const scrim = ((stage.children[0] as Container).children[0] as Graphics).getLocalBounds();
      expect([scrim.width, scrim.height], `${w}x${h}`).toEqual([w, h]);
      await loading.done();
    }
  });

  it('moves the bar through the handle it returns', async () => {
    const { app, stage } = fakeApp(844, 390);
    const loading = showBootLoading(app, NO_FLOOR);
    const bar = () => ((stage.children[0] as Container).children[2] as Graphics);

    expect(bar().context.instructions.length).toBe(0); // no total known yet: spinner alone
    loading.onProgress(0, 2);
    const atZero = bar().context.instructions.length;
    loading.onProgress(1, 2);

    expect(atZero).toBeGreaterThan(0);
    expect(bar().context.instructions.length).toBeGreaterThan(atZero); // the fill is a second rect
    await loading.done();
  });

  it('really destroys on done(), rather than merely being forgotten', async () => {
    // `done: () => {}` in place of `screen.destroy()` is the mutant that survives everything
    // else, and it is the worst-looking bug of the set: the scrim is an OPAQUE full-viewport
    // interactive Graphics, so it would sit above the entire game — swallowing every tap — for
    // the rest of the session, with its ticker callback still redrawing the spinner on top.
    // `main.wechat.ts` calls this immediately before `new Game(...)`.
    const { app, stage, ticker } = fakeApp(844, 390);
    const loading = showBootLoading(app, NO_FLOOR);

    await loading.done();

    expect(stage.children.length).toBe(0);
    expect(ticker.count).toBe(0);
  });

  it('holds the screen for the boot floor before destroying it', async () => {
    // The mutant this kills: `done: () => screen.destroy()`, i.e. the pre-2026-09-21 shape.
    // It passes every other case in this file, because every other case turns the floor off —
    // and on a fast boot it flashes the spinner for a couple of frames, which is the exact
    // thing `bootHold.ts` exists to stop. Asserted on the ORDER of the two effects rather than
    // on wall-clock time: the sleep is injected, so nothing here actually waits.
    const { app, stage } = fakeApp(844, 390);
    const order: string[] = [];
    const loading = showBootLoading(app, {
      elapsed: () => 500,
      sleep: (ms) => {
        order.push(`slept ${ms}`);
        return Promise.resolve();
      },
    });

    const settled = loading.done().then(() => order.push('destroyed'));
    // Still up while the floor is outstanding — the half a bare `destroy()` gets wrong.
    expect(stage.children.length).toBe(1);
    await settled;

    expect(order).toEqual(['slept 2500', 'destroyed']);
    expect(stage.children.length).toBe(0);
  });
});
