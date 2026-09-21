/**
 * `pinTextMeasurementToPaintCanvas` guards a defect that is invisible to every other test
 * in this repo: Pixi MEASURES text on an `OffscreenCanvas` but PAINTS it on a DOM canvas,
 * and Chrome resolves the CSS generic font families differently between the two, so
 * `Text.width` can come back ~2x the painted width (see textMetrics.ts).
 *
 * Neither canvas kind exists in this Node-only test env, so both are faked — and faked
 * with the ACTUAL advance widths measured in Chrome/Windows on 2026-08-15 for
 * `bold 15px monospace`, which is what makes the second describe block a real regression
 * test rather than a tautology: the "offscreen" fake is ~2x wider for Cyrillic and the
 * "DOM" fake is not, exactly the discrepancy the user's Russian settings screen hit.
 * `document.createElement` is stubbed because that is what Pixi's `BrowserAdapter`
 * (`DOMAdapter.get().createCanvas()`) calls, and `CanvasRenderingContext2D` because
 * Pixi probes its prototype for letter-spacing support on the first measurement.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// `?raw` (see src/vite-env.d.ts): the entries' TEXT, since importing them runs `boot()`.
import webEntrySource from '../main.ts?raw';
import wechatEntrySource from '../main.wechat.ts?raw';
import { CanvasTextMetrics, DOMAdapter, TextStyle, Text } from 'pixi.js';
import { Button } from '../game/ui/widgets';
import { Settings } from '../game/screens/Settings';
import { defaultSettingsState } from '../settings';
import { LOCALES, resetLocaleForTests } from '../i18n';
import { disableBrokenLetterSpacing, pinTextMeasurementToPaintCanvas } from './textMetrics';
import { useLocale } from '../i18n/loadLocale';

// Per-character advance at 15px, as Chrome reported for `bold 15px monospace`:
// 'AAAAA' → 41.2px / 'ААААА' → 41.2px on a DOM canvas, 45px / 85px on an OffscreenCanvas.
const DOM_ADVANCE = { latin: 8.25, cyrillic: 8.25 };
const OFFSCREEN_ADVANCE = { latin: 9, cyrillic: 17 };

const FONT_SIZE = 15;
const RU_LABEL = 'ЯЗЫК: Русский'; // the reported string, Settings.ts's language button
const EN_LABEL = 'LANGUAGE: English';

type Advance = { latin: number; cyrillic: number };
type FakeContext = ReturnType<typeof fakeContext>;

function isCyrillic(cp: number): boolean {
  return cp >= 0x0400 && cp <= 0x04ff;
}

/** A 2D context stub that measures with a per-script fixed advance and paints nothing.
 * `getImageData` returns a blank buffer — Pixi derives ascent/descent from a readback of
 * it, which leaves the reported height at 0; every assertion here is about width. */
function fakeContext(advance: Advance) {
  const ctx = {
    font: '',
    fillStyle: '',
    strokeStyle: '',
    textBaseline: '',
    lineWidth: 0,
    letterSpacing: '',
    canvas: { width: 10, height: 10 },
    getContextCalls: [] as unknown[][],
    measureText(text: string) {
      let w = 0;
      for (const ch of text) w += isCyrillic(ch.codePointAt(0) ?? 0) ? advance.cyrillic : advance.latin;
      return { width: w };
    },
    getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    fillText: () => {},
    strokeText: () => {},
    clearRect: () => {},
    fillRect: () => {},
    save: () => {},
    restore: () => {},
    translate: () => {},
    scale: () => {},
  };
  return ctx;
}

/** A canvas stub whose `getContext` hands back `context` (or null, to model a host with
 * no 2D support) and records the args Pixi asked for. */
function fakeCanvas(context: FakeContext | null) {
  const calls: unknown[][] = [];
  return {
    canvas: {
      width: 0,
      height: 0,
      getContext: (...args: unknown[]) => {
        calls.push(args);
        return context;
      },
    },
    calls,
  };
}

type Statics = { __canvas?: unknown; __context?: unknown };
const statics = CanvasTextMetrics as unknown as Statics;

const saved = {
  document: Object.getOwnPropertyDescriptor(globalThis, 'document'),
  offscreen: Object.getOwnPropertyDescriptor(globalThis, 'OffscreenCanvas'),
  ctx2d: Object.getOwnPropertyDescriptor(globalThis, 'CanvasRenderingContext2D'),
};

function defineGlobal(name: string, value: unknown) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

function restoreGlobal(name: string, descriptor: PropertyDescriptor | undefined) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else delete (globalThis as Record<string, unknown>)[name];
}

/** Pixi memoises the measurement canvas on first use; each test must start from scratch. */
function resetPixiTextMetrics() {
  statics.__canvas = undefined;
  statics.__context = undefined;
  CanvasTextMetrics.clearMetrics();
}

// Pixi reads `CanvasRenderingContext2D.prototype` to feature-detect letter spacing.
defineGlobal('CanvasRenderingContext2D', class {});

// Both canvas kinds, installed for every test, so an unpinned Pixi picks the offscreen
// one exactly as it does in a browser — that is what makes "pinned" vs "not pinned" a
// real difference here rather than two names for the same fake.
beforeEach(() => {
  defineGlobal('OffscreenCanvas', class {
    getContext() {
      return fakeContext(OFFSCREEN_ADVANCE);
    }
  });
  defineGlobal('document', { createElement: () => fakeCanvas(fakeContext(DOM_ADVANCE)).canvas });
});

afterEach(() => {
  vi.restoreAllMocks();
  resetPixiTextMetrics();
  restoreGlobal('document', saved.document);
  restoreGlobal('OffscreenCanvas', saved.offscreen);
});

/**
 * The WeChat blank-text defect (2026-08-25), reproduced without WeChat.
 *
 * Symptom on device/simulator: every label in the game was empty, while sprites drew fine and
 * the very same wx canvas painted 'ABC' correctly when asked directly. A probe in the running
 * mini-game reported `Text` size "NaNx26" and a 1x64 glyph texture — the WIDTH was NaN, so the
 * canvas Pixi rasterises onto was allocated one pixel wide.
 *
 * Cause: that runtime's `TextMetrics` carries the `actualBoundingBox*` fields but leaves them
 * NaN rather than absent, and Pixi's per-line width is
 * `Math.max(metrics.width, actualBoundingBoxRight - -actualBoundingBoxLeft)`. Its `?? 0` guards
 * a MISSING field, not a NaN one, and `Math.max(43.3, NaN)` is NaN.
 *
 * These run through the real `CanvasTextMetrics` and the real `Text`, so they fail if Pixi ever
 * stops needing the sanitising — which would be the moment to delete it.
 */
describe('a measurement context that reports NaN bounding boxes (WeChat)', () => {
  const ADVANCE = 8.25;

  /**
   * A `TextMetrics` the way a browser (and WeChat) actually returns one: getter-ONLY accessors on
   * a prototype, not own data properties.
   *
   * This distinction is not decoration. The first version of the fix built its sanitised copy with
   * `Object.create(metrics)`, which inherits those accessors and so throws on every write — and
   * because a plain-object fake accepts writes happily, the whole suite stayed green while the
   * shipped mini-game died on its first label ("Cannot set property width of [object TextMetrics]
   * which has only a getter"). The fake has to be as unforgiving as the real thing.
   */
  class FakeTextMetrics {
    constructor(private readonly values: Record<string, number>) {}
    get width(): number { return this.values.width!; }
    get actualBoundingBoxLeft(): number { return this.values.actualBoundingBoxLeft!; }
    get actualBoundingBoxRight(): number { return this.values.actualBoundingBoxRight!; }
    get actualBoundingBoxAscent(): number { return this.values.actualBoundingBoxAscent!; }
    get actualBoundingBoxDescent(): number { return this.values.actualBoundingBoxDescent!; }
  }

  /** A context shaped like WeChat's: a real advance width, NaN bounding boxes, real ascent. */
  function wechatShapedContext(fields: Record<string, number>) {
    return {
      ...fakeContext(DOM_ADVANCE),
      measureText: (text: string) => new FakeTextMetrics({ width: text.length * ADVANCE, ...fields }),
    };
  }

  function pinTo(context: unknown): void {
    const browserAdapter = DOMAdapter.get();
    DOMAdapter.set({
      ...browserAdapter,
      createCanvas: () => fakeCanvas(context as FakeContext).canvas as unknown as HTMLCanvasElement,
    });
    try {
      pinTextMeasurementToPaintCanvas();
    } finally {
      DOMAdapter.set(browserAdapter);
    }
  }

  const NAN_BOUNDS = {
    actualBoundingBoxLeft: NaN,
    actualBoundingBoxRight: NaN,
    actualBoundingBoxAscent: 15,
    actualBoundingBoxDescent: 5,
  };

  it('still measures a finite width — the whole of the blank-label bug', () => {
    pinTo(wechatShapedContext(NAN_BOUNDS));
    const width = CanvasTextMetrics.measureText('ABC', new TextStyle({ fontSize: 20 })).width;
    expect(Number.isFinite(width)).toBe(true);
    expect(width).toBeCloseTo(3 * ADVANCE, 5);
  });

  it('gives `Text` a real width instead of NaN — the exact value the probe reported', () => {
    // `Text.width` NaN is what the shipped mini-game showed ("NaNx26"), and it is the value the
    // glyph canvas is sized from, so this is the assertion closest to what the player sees.
    pinTo(wechatShapedContext(NAN_BOUNDS));
    const text = new Text({ text: 'ABC', style: new TextStyle({ fontSize: 20 }) });
    expect(Number.isFinite(text.width)).toBe(true);
    expect(text.width).toBeGreaterThan(0);
  });

  it('is NaN-proof on every bounding-box field, not just the pair WeChat happened to break', () => {
    // One field at a time: whichever the runtime leaves unset must not poison the width, and a
    // fix that special-cased only `Left`/`Right` would pass the tests above and still ship blank
    // text on the next runtime that unsets `width` instead.
    for (const field of ['actualBoundingBoxLeft', 'actualBoundingBoxRight', 'width'] as const) {
      resetPixiTextMetrics();
      pinTo(wechatShapedContext({ ...NAN_BOUNDS, actualBoundingBoxLeft: 0, actualBoundingBoxRight: 3 * ADVANCE, [field]: NaN }));
      const width = CanvasTextMetrics.measureText('ABC', new TextStyle({ fontSize: 20 })).width;
      expect({ field, finite: Number.isFinite(width) }).toEqual({ field, finite: true });
    }
  });

  it('passes a healthy browser measurement through untouched', () => {
    // The sanitising must not become a second source of wrong numbers: where the values are
    // already finite, the width has to be exactly what the context reported.
    pinTo(wechatShapedContext({ actualBoundingBoxLeft: 1, actualBoundingBoxRight: 200, actualBoundingBoxAscent: 15, actualBoundingBoxDescent: 5 }));
    const width = CanvasTextMetrics.measureText('ABC', new TextStyle({ fontSize: 20 })).width;
    expect(width).toBeCloseTo(201, 5); // right - -left, which exceeds the 24.75 advance
  });

  it('still lets Pixi set the font it measures with', () => {
    // Pixi writes `context.font` before every measurement. The wrapper is a Proxy; if its `set`
    // trap failed to reach the real context, every measurement would silently use the default
    // font — wrong widths with no NaN to make it obvious.
    const context = wechatShapedContext(NAN_BOUNDS);
    pinTo(context);
    CanvasTextMetrics.measureText('ABC', new TextStyle({ fontSize: 20, fontFamily: 'monospace' }));
    expect(context.font).toContain('monospace');
  });
});

/**
 * `disableBrokenLetterSpacing` — the actual cause of the WeChat blank-label bug.
 *
 * Pixi detects `context.letterSpacing` by looking for the property on the 2D context prototype and,
 * finding it on that runtime, set `letterSpacing = '0px'` before every measurement and every
 * `fillText`. The assignment poisons the context there: a bisect in the running mini-game painted
 * 1058 pixels with the step omitted and 0 with it included, and `measureText` went from 43.33px to
 * a non-finite width. So these tests are written against a context that behaves that way, and the
 * assertions are about what Pixi ends up doing with it.
 */
describe('disableBrokenLetterSpacing', () => {
  const flags = CanvasTextMetrics as unknown as { _experimentalLetterSpacingSupported?: boolean };

  beforeEach(() => {
    // The prototype has to CARRY `letterSpacing`, or Pixi's own detection answers false for a
    // reason that has nothing to do with this fix — which is exactly how the first version of
    // these tests passed with the fix deleted. It is the property's presence on the prototype
    // that puts WeChat on the poisoned path in the first place.
    class WithLetterSpacing {}
    Object.defineProperty(WithLetterSpacing.prototype, 'letterSpacing', { value: '', writable: true });
    defineGlobal('CanvasRenderingContext2D', WithLetterSpacing);
    flags._experimentalLetterSpacingSupported = undefined;
    expect(CanvasTextMetrics.experimentalLetterSpacingSupported).toBe(true); // the premise
    flags._experimentalLetterSpacingSupported = undefined;
  });

  afterEach(() => {
    flags._experimentalLetterSpacingSupported = undefined;
    defineGlobal('CanvasRenderingContext2D', class {});
  });

  /** A context whose `letterSpacing` setter breaks it, exactly as WeChat's does.
   *  Built with `defineProperty`, not `Object.assign` — assign COPIES a getter's value and drops
   *  the accessor, so the setter would never run and the fake would quietly be a healthy host. */
  function poisonedContext() {
    const ctx = fakeContext(DOM_ADVANCE);
    let poisoned = false;
    const measure = ctx.measureText.bind(ctx);
    const target = ctx as unknown as Record<string, unknown>;
    Object.defineProperty(target, 'letterSpacing', {
      get: () => '0px',
      set: () => { poisoned = true; },
      configurable: true,
    });
    target.measureText = (text: string) => (poisoned ? { width: NaN } : measure(text));
    return ctx;
  }

  /** Run boot's two text-setup calls against a host that makes a FRESH context per canvas.
   *  Fresh matters: in production the pinned canvas and the probe's canvas are different objects,
   *  so the probe poisoning its own context must not poison the one Pixi goes on to measure with.
   *  Sharing one context here would make this file fail for a reason production does not have. */
  function pinTo(makeContext: () => unknown): void {
    const browserAdapter = DOMAdapter.get();
    DOMAdapter.set({
      ...browserAdapter,
      createCanvas: () => fakeCanvas(makeContext() as FakeContext).canvas as unknown as HTMLCanvasElement,
    });
    try {
      pinTextMeasurementToPaintCanvas();
      disableBrokenLetterSpacing();
    } finally {
      DOMAdapter.set(browserAdapter);
    }
  }

  it('turns the flag off when a 0px spacing changes what the context measures', () => {
    pinTo(poisonedContext);
    expect(CanvasTextMetrics.experimentalLetterSpacingSupported).toBe(false);
  });

  it('leaves a healthy host on the fast path', () => {
    // The check must not cost a working browser its letter-spacing support: a context whose
    // measurement is unmoved by a 0px spacing has to come out untouched, with the flag still the
    // `true` the premise in beforeEach established.
    pinTo(() => fakeContext(DOM_ADVANCE));
    expect(CanvasTextMetrics.experimentalLetterSpacingSupported).toBe(true);
  });

  it('treats a setter that throws as broken too', () => {
    // A getter-only `letterSpacing` would make Pixi's own assignment throw mid-render, which is a
    // crash rather than blank text — worse, and caught by the same probe.
    const ctx = fakeContext(DOM_ADVANCE);
    Object.defineProperty(ctx, 'letterSpacing', { get: () => '0px' }); // no setter
    pinTo(() => ctx);
    expect(CanvasTextMetrics.experimentalLetterSpacingSupported).toBe(false);
  });

  it('stops Pixi from touching the property at all — the measurement stays right', () => {
    // The end-to-end claim, through the real `CanvasTextMetrics`: with the flag off, Pixi never
    // makes the assignment, so a poisoned context is never poisoned and text measures normally.
    // Without the fix this is NaN, and every label in the game renders blank.
    pinTo(poisonedContext);
    const width = CanvasTextMetrics.measureText('AAAAA', new TextStyle({ fontSize: FONT_SIZE })).width;
    expect(width).toBeCloseTo(5 * DOM_ADVANCE.latin, 5);
  });

  it('survives a host with no canvas', () => {
    const browserAdapter = DOMAdapter.get();
    DOMAdapter.set({ ...browserAdapter, createCanvas: () => { throw new ReferenceError('document is not defined'); } });
    try {
      expect(() => disableBrokenLetterSpacing()).not.toThrow();
    } finally {
      DOMAdapter.set(browserAdapter);
    }
  });
});

describe('pinTextMeasurementToPaintCanvas', () => {
  it('pins Pixi’s measurement canvas/context to a DOMAdapter-created canvas', () => {
    const context = fakeContext(DOM_ADVANCE);
    const { canvas, calls } = fakeCanvas(context);
    defineGlobal('document', { createElement: () => canvas });

    pinTextMeasurementToPaintCanvas();

    expect(statics.__canvas).toBe(canvas);
    // Not `toBe(context)`: since the NaN-metrics fix the pinned object is a thin wrapper AROUND
    // that context (see the describe block above), so identity is the wrong question — what has
    // to hold is that a measurement reaches this context and comes back with its numbers.
    const measured = (statics.__context as { measureText: (t: string) => { width: number } }).measureText('AAAAA');
    expect(measured.width).toBeCloseTo(5 * DOM_ADVANCE.latin, 5);
    // Pixi's own contextSettings for this canvas — font metrics come from a readback.
    expect(calls).toEqual([['2d', { willReadFrequently: true }]]);
  });

  it('actually routes Pixi’s own measurement through the pinned context', () => {
    // The assertion that keeps this fix honest: it fails if a Pixi upgrade renames the
    // `__canvas`/`__context` statics, instead of silently reverting to the offscreen path
    // (which is installed here too, and would report 17px/char for Cyrillic).
    pinTextMeasurementToPaintCanvas();

    const style = new TextStyle({ fontSize: FONT_SIZE, fontFamily: 'monospace', fontWeight: 'bold' });
    expect(CanvasTextMetrics.measureText('ААААА', style).width).toBeCloseTo(5 * DOM_ADVANCE.cyrillic, 3);
  });

  it('survives an adapter that cannot make a canvas at all — a refinement must never fail boot', () => {
    // `boot()` has no error boundary below `reportWeChatBootFailure`, so anything this function
    // throws is a black screen rather than a slightly-mismeasured label. A host with no canvas is
    // reachable in practice: it is what the browser adapter does on a runtime with no `document`.
    const browserAdapter = DOMAdapter.get();
    DOMAdapter.set({
      ...browserAdapter,
      createCanvas: () => {
        throw new ReferenceError('document is not defined');
      },
    });
    try {
      expect(() => pinTextMeasurementToPaintCanvas()).not.toThrow();
    } finally {
      DOMAdapter.set(browserAdapter);
    }
  });

  it('creates the canvas through DOMAdapter, so a swapped adapter (WeChat) is honored', () => {
    // main.wechat.ts calls this too, where DOMAdapter is weapp-adapter's, not the browser's.
    const context = fakeContext(DOM_ADVANCE);
    const { canvas } = fakeCanvas(context);
    const browserAdapter = DOMAdapter.get();
    DOMAdapter.set({ ...browserAdapter, createCanvas: () => canvas as unknown as HTMLCanvasElement });
    try {
      pinTextMeasurementToPaintCanvas();
      expect(statics.__canvas).toBe(canvas);
    } finally {
      DOMAdapter.set(browserAdapter);
    }
  });

  it('replaces an offscreen canvas Pixi already memoised, rather than deferring to it', () => {
    // Models being called after something already measured — the pinned context must win.
    const stale = fakeContext(OFFSCREEN_ADVANCE);
    statics.__canvas = stale.canvas;
    statics.__context = stale;

    pinTextMeasurementToPaintCanvas();

    const style = new TextStyle({ fontSize: FONT_SIZE, fontFamily: 'monospace', fontWeight: 'bold' });
    expect(CanvasTextMetrics.measureText('ААААА', style).width).toBeCloseTo(5 * DOM_ADVANCE.cyrillic, 3);
  });

  it('drops font metrics cached from the previous canvas', () => {
    const spy = vi.spyOn(CanvasTextMetrics, 'clearMetrics');

    pinTextMeasurementToPaintCanvas();

    expect(spy).toHaveBeenCalled();
  });

  it('is safe to call twice — the last pinned context is the one Pixi measures with', () => {
    const first = fakeContext(OFFSCREEN_ADVANCE);
    const second = fakeContext(DOM_ADVANCE);
    const contexts = [first, second];
    defineGlobal('document', { createElement: () => fakeCanvas(contexts.shift() ?? second).canvas });

    pinTextMeasurementToPaintCanvas();
    pinTextMeasurementToPaintCanvas();

    // Identified by what it MEASURES rather than by identity (the pinned object wraps the
    // context): 'ААААА' is 8.25px/char through `second` and 17px/char through `first`.
    const measured = (statics.__context as { measureText: (t: string) => { width: number } }).measureText('ААААА');
    expect(measured.width).toBeCloseTo(5 * DOM_ADVANCE.cyrillic, 5);
  });

  it('leaves Pixi’s own lazy path alone when there is no 2D context', () => {
    defineGlobal('document', { createElement: () => fakeCanvas(null).canvas });

    pinTextMeasurementToPaintCanvas();

    expect(statics.__canvas).toBeUndefined();
    expect(statics.__context).toBeUndefined();
  });
});

// End-to-end on the widget that actually broke: a settings Button whose label is a
// translated string. `Button` sizes its box from `estimateMonoWidth` (no canvas needed)
// but centres the label via Pixi's `anchor 0.5`, i.e. from Pixi's MEASURED width — so a
// measurement that disagrees with the paint canvas pushes the glyphs outside the box.
describe('Button label vs. box — the Russian settings-screen regression', () => {
  /** Left/right edges of the label as Pixi will place them inside the box. */
  function labelEdges(button: Button) {
    const label = button.view.children[1] as Text;
    return { left: label.position.x - label.width / 2, right: label.position.x + label.width / 2 };
  }

  /** Both canvas kinds are already installed (see `beforeEach`); `pin` is the fix itself. */
  function buildButton(text: string, opts: { pin: boolean }) {
    if (opts.pin) pinTextMeasurementToPaintCanvas();
    return new Button(text, { w: 160, h: 34, autoWidth: true });
  }

  it('WITHOUT the fix, a Cyrillic label is measured wide enough to spill out of its box', () => {
    // The reported bug: text rendered visibly left of (and outside) the button background.
    const button = buildButton(RU_LABEL, { pin: false });
    const { left, right } = labelEdges(button);
    expect(left).toBeLessThan(0);
    expect(right).toBeGreaterThan(button.width);
  });

  it('WITH the fix, the same label sits inside the box and is centred on it', () => {
    const button = buildButton(RU_LABEL, { pin: true });
    const { left, right } = labelEdges(button);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(right).toBeLessThanOrEqual(button.width);
    expect(left).toBeCloseTo(button.width - right, 3);
  });

  it('every locale’s real settings labels fit inside their boxes under truthful metrics', async () => {
    // Settings.test.ts already covers each BOX's width and where it sits; what it cannot
    // check without a canvas is the LABEL inside it. Sizing comes from
    // `estimateMonoWidth`'s 0.6em assumption while the font's real advance is 0.55em, so
    // this also catches a future translation long enough to close that headroom.
    pinTextMeasurementToPaintCanvas();

    const screen = new Settings();
    const buttons = screen as unknown as Record<string, Button>;
    for (const locale of LOCALES) {
      await useLocale(locale);
      screen.show(800, 600, { ...defaultSettingsState(), locale });
      for (const key of ['languageBtn', 'controlLayoutBtn', 'muteBtn', 'backBtn']) {
        const button = buttons[key]!;
        const { left, right } = labelEdges(button);
        expect({ locale, key, left: left >= 0 }).toEqual({ locale, key, left: true });
        expect({ locale, key, right: right <= button.width }).toEqual({ locale, key, right: true });
      }
    }
    resetLocaleForTests();
  });

  it('is wired into both entry points, ahead of the first Text', () => {
    // Neither entry has (or can easily have) a test of its own — importing one runs
    // `boot()`. A source check is the cheap way to keep the call from being dropped:
    // everything above still passes if `main.ts` simply stops calling it.
    for (const [entry, source] of [['main.ts', webEntrySource], ['main.wechat.ts', wechatEntrySource]] as const) {
      const call = source.indexOf('pinTextMeasurementToPaintCanvas()');
      expect({ entry, called: call >= 0 }).toEqual({ entry, called: true });
      // Pixi memoises the measurement canvas on first use, so this has to come first.
      expect({ entry, beforeGame: call < source.indexOf('new Game(') }).toEqual({ entry, beforeGame: true });
      // Same for the letter-spacing repair: Pixi memoises the support flag on first measurement,
      // and a label built before the repair runs is a label rasterised on a poisoned context.
      const repair = source.indexOf('disableBrokenLetterSpacing()');
      expect({ entry, called: repair >= 0 }).toEqual({ entry, called: true });
      expect({ entry, beforeGame: repair < source.indexOf('new Game(') }).toEqual({ entry, beforeGame: true });
    }
  });

  it('is called AFTER the WeChat adapter is installed, not before it', () => {
    // The other half of the ordering, and the half a device fails on. The pin allocates its
    // canvas through `DOMAdapter`, which is still Pixi's BrowserAdapter until
    // `WeChatPlatform.createApp()` swaps in ours — so calling it first (as the entry did until
    // 2026-08-25) means `document.createElement` on a runtime with no `document`: a
    // ReferenceError straight out of `boot()`. The DevTools simulator DOES answer that call,
    // which is exactly why an ordering bug this total could sit there looking healthy.
    const call = wechatEntrySource.indexOf('pinTextMeasurementToPaintCanvas()');
    const createApp = wechatEntrySource.indexOf('platform.createApp()');
    expect(createApp).toBeGreaterThan(0);
    expect(call).toBeGreaterThan(createApp);
  });

  it('a Latin label fits either way — why the Italian/English screens looked fine', () => {
    // The two fonts differ by ~9% on Latin and ~106% on Cyrillic, so only Cyrillic
    // overflowed; this pins down that the fix did not just move the failure elsewhere.
    for (const pin of [false, true]) {
      const button = buildButton(EN_LABEL, { pin });
      const { left, right } = labelEdges(button);
      expect(left).toBeGreaterThanOrEqual(0);
      expect(right).toBeLessThanOrEqual(button.width);
      resetPixiTextMetrics();
    }
  });
});
