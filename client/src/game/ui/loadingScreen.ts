// The one screen that cannot use any art, because it is what the art is loading behind
// (design/12, "the first download is code only").
//
// Two callers, one class:
//
//   - BOOT, from `main.ts` / `main.wechat.ts`, via `showBootLoading(app)`. This runs before
//     `new Game(...)` exists, so it takes the Pixi `Application` directly and parks itself on
//     `app.stage`. It is the only thing on screen while the `lobby` pack downloads.
//   - THE RUN GATE, from `game/controllers/ArtGate.ts`, on `Layers.overlay`.
//
// Graphics + Text only, and deliberately so: at boot the `lobby` pack has not landed, so
// `getUiTexture('hub')` is undefined and every art-backed widget (`Panel`, `Button`) would
// paint its fallback anyway. Drawing the fallback shape on purpose is honest and half the code.
//
// The spin is driven by a ticker callback the screen owns and removes on `destroy()`. It is
// wall-clock, not frame-count: a boot that stalls on a slow download must still visibly move.
import { Application, Container, Graphics, Text, Ticker } from 'pixi.js';
import { holdBootMinimum, type BootHoldDeps } from '../../bootHold';
import { t } from '../../i18n';
import { THEME } from '../theme';
import { computeScreenSize } from '../viewport';

/** Full turns per second. Slow enough to read as "working", fast enough that a 200 ms flash of
 *  it does not look like a frozen glyph. */
const SPIN_HZ = 0.75;
const RADIUS = 22;
const ARC_SWEEP = Math.PI * 1.35;
const BAR_W = 220;
const BAR_H = 4;

export interface LoadingScreenOpts {
  /** Which of the two waits this is (`loading.boot` / `loading.art`). */
  label: string;
  /** Ticker to spin on. Both callers have one; passing it in keeps this class free of any
   *  opinion about which `Application` it belongs to. */
  ticker: Ticker;
  /** The live viewport size, re-read on every tick so a resize mid-wait re-lays-out. Cheap
   *  (two property reads and a comparison) and it covers the case a one-shot `layout()` at
   *  construction cannot: on web the renderer follows the window, so a boot slow enough to be
   *  worth a progress screen is also long enough for the window to change. */
  sizeOf?(): { w: number; h: number };
}

export class LoadingScreen {
  readonly view = new Container();
  private readonly scrim = new Graphics();
  private readonly spinner = new Graphics();
  private readonly caption: Text;
  private readonly bar = new Graphics();
  private readonly ticker: Ticker;
  private readonly sizeOf?: () => { w: number; h: number };
  private readonly onTick: (t: Ticker) => void;
  private angle = 0;
  private done = 0;
  private total = 0;
  private w = 0;
  private h = 0;

  constructor(opts: LoadingScreenOpts) {
    this.caption = new Text({
      text: opts.label,
      // No `letterSpacing`: on WeChat any spacing value takes Pixi off its measured fast path
      // (render/textMetrics.ts disables that path there because assigning the property poisons
      // the wx 2D context), and this is the one screen that must paint on a cold boot.
      style: { fill: 0xcbd5e0, fontSize: 13, fontFamily: 'monospace', fontWeight: 'bold', padding: 8 },
    });
    this.caption.anchor.set(0.5);
    this.spinner.pivot.set(0, 0);
    // A modal scrim, not just a backdrop. Pixi's `EventBoundary` hit-tests front-to-back and
    // stops at the topmost interactive target, so a full-viewport interactive Graphics on the
    // overlay layer is what stops a tap reaching the screen still sitting underneath a run
    // gate (the mode-select buttons are still there — the transition has not happened yet).
    // The KEYBOARD is not covered by this and cannot be; `ArtGate.defer` swallows the repeat.
    this.scrim.eventMode = 'static';
    this.view.addChild(this.scrim, this.spinner, this.bar, this.caption);
    this.ticker = opts.ticker;
    this.sizeOf = opts.sizeOf;
    this.onTick = (tk) => {
      const size = this.sizeOf?.();
      if (size && (size.w !== this.w || size.h !== this.h)) this.layout(size.w, size.h);
      this.spin(tk.deltaMS);
    };
    this.ticker.add(this.onTick);
  }

  /** Lay out against a real (CSS-pixel) viewport. Called on every resize, and once before the
   *  first paint — a screen sized 0x0 for one frame is a visible flash on a slow boot. */
  layout(w: number, h: number): void {
    this.w = w;
    this.h = h;
    this.scrim.clear().rect(0, 0, w, h).fill({ color: THEME.colors.ground, alpha: 1 });
    const cx = w / 2;
    const cy = h / 2;
    this.spinner.position.set(cx, cy - 14);
    this.caption.position.set(cx, cy + 30);
    this.drawBar();
  }

  /**
   * How far along the wait is, in the units `render/preloadArt.ts` ticks (packs, then loaders).
   *
   * `total` arrives with every call rather than being fixed up front because the two waits have
   * different unit counts and the run gate may join one already in progress. A caller that
   * never reports progress simply gets the spinner and no bar, which is the right answer for a
   * wait whose length is genuinely unknown.
   */
  setProgress(done: number, total: number): void {
    this.done = done;
    this.total = total;
    this.drawBar();
  }

  private drawBar(): void {
    this.bar.clear();
    if (this.total <= 0 || this.w <= 0) return;
    const x = (this.w - BAR_W) / 2;
    const y = this.h / 2 + 52;
    const frac = Math.max(0, Math.min(1, this.done / this.total));
    this.bar.rect(x, y, BAR_W, BAR_H).fill({ color: THEME.colors.pillar, alpha: 1 });
    if (frac > 0) this.bar.rect(x, y, BAR_W * frac, BAR_H).fill({ color: THEME.colors.player, alpha: 1 });
  }

  private spin(dtMs: number): void {
    this.angle = (this.angle + (dtMs / 1000) * SPIN_HZ * Math.PI * 2) % (Math.PI * 2);
    // Redrawn rather than rotated: an arc drawn once and spun by `rotation` would need its own
    // pivot bookkeeping, and this is four Graphics ops on a screen that has nothing else to do.
    this.spinner
      .clear()
      .circle(0, 0, RADIUS)
      .stroke({ color: THEME.colors.pillar, width: 3 })
      .arc(0, 0, RADIUS, this.angle, this.angle + ARC_SWEEP)
      .stroke({ color: THEME.colors.player, width: 3 });
  }

  /** Remove the tick callback and the display objects. Not optional: a leaked ticker callback
   *  keeps redrawing a Graphics that is no longer on the stage, for the rest of the session. */
  destroy(): void {
    this.ticker.remove(this.onTick);
    this.view.removeFromParent();
    this.view.destroy({ children: true });
  }
}

/** Handle the boot callers hold: the screen is already parked on the stage and spinning. */
export interface BootLoading {
  onProgress(done: number, total: number): void;
  /** Take the screen down once it has been up for `bootHold.ts`'s minimum. Awaited, because
   *  that minimum is a wait — a caller that drops the promise tears the screen down early. */
  done(): Promise<void>;
}

/**
 * The boot wait, mounted on `app.stage` directly — there is no `Game`, and therefore no
 * `Layers`, until the `lobby` pack has landed.
 *
 * Added LAST so it covers whatever the platform put on the stage before it, and removed by
 * `done()` before `new Game(...)` builds the real layer tree.
 */
export function showBootLoading(app: Application, hold: BootHoldDeps = {}): BootLoading {
  // `computeScreenSize`, never `renderer.width / resolution` — see viewport.ts's header for the
  // HiDPI bug that division caused, which is invisible at devicePixelRatio 1.
  const screen = new LoadingScreen({
    label: t('loading.boot'),
    ticker: app.ticker,
    sizeOf: () => computeScreenSize(app),
  });
  const { w, h } = computeScreenSize(app);
  screen.layout(w, h);
  app.stage.addChild(screen.view);
  return {
    onProgress: (done, total) => screen.setProgress(done, total),
    // The same floor the DOM splash obeys on web and the portal (`bootHold.ts`): a boot fast
    // enough to flash this screen for 200 ms reads as a glitch rather than as a load, and on
    // this host there is nothing else on the stage for it to flash against.
    done: async () => {
      await holdBootMinimum(hold);
      screen.destroy();
    },
  };
}
