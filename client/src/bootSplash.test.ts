/**
 * bootSplash.ts — the DOM splash's progress bar and, more importantly, the two rules about
 * when it is allowed to come down.
 *
 * `document` is not a global in this project's plain-node vitest environment (no jsdom — see
 * `bootError.test.ts`'s note), so every case here hands in its own `doc`. That is also why
 * the module takes one: the alternative is a module that cannot be tested at all on the one
 * host where it matters.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  BOOT_SPLASH_FADE_MS,
  FIRST_FRAME_TIMEOUT_MS,
  HIDING_CLASS,
  afterFirstRenderedFrame,
  hideBootSplash,
  resetBootSplashForTests,
  setBootProgress,
  type SplashDoc,
  type SplashNode,
} from './bootSplash';
import { MIN_BOOT_SPLASH_MS } from './bootHold';

/** `index.html`'s two ids, as the plain objects this module actually touches. */
class FakeNode implements SplashNode {
  readonly classes: string[] = [];
  removed = false;
  readonly style = { width: '' };
  readonly classList = { add: (c: string): void => void this.classes.push(c) };
  remove(): void {
    this.removed = true;
  }
}

function fakeSplash(present = true): { doc: SplashDoc; splash: FakeNode; bar: FakeNode } {
  const splash = new FakeNode();
  const bar = new FakeNode();
  const byId: Record<string, FakeNode> = { 'boot-loading': splash, 'boot-progress': bar };
  return { splash, bar, doc: { getElementById: (id) => (present ? (byId[id] ?? null) : null) } };
}

beforeEach(() => resetBootSplashForTests());

describe('setBootProgress', () => {
  it('writes the fraction onto the bar as a percentage width', () => {
    const { doc, bar } = fakeSplash();
    setBootProgress(0.2, { doc });
    expect(bar.style.width).toBe('20%');
    setBootProgress(0.755, { doc });
    expect(bar.style.width).toBe('76%');
  });

  it('never walks backwards', () => {
    // Not hypothetical: the fraction is assembled from two sources — the coarse stage marks in
    // each entry point and the `lobby` pack's own per-item ticks — and a bar that retreats
    // reads as something having gone wrong.
    const { doc, bar } = fakeSplash();
    setBootProgress(0.6, { doc });
    setBootProgress(0.2, { doc });
    expect(bar.style.width).toBe('60%');
  });

  it('clamps to the ends of the track', () => {
    const { doc, bar } = fakeSplash();
    setBootProgress(-1, { doc });
    expect(bar.style.width).toBe('0%');
    setBootProgress(4, { doc });
    expect(bar.style.width).toBe('100%');
  });

  it('does nothing, loudly or otherwise, with no splash in the page', () => {
    // A host that removed the element, and the mini-game runtime that never had one. A
    // `ReferenceError` here would be thrown from inside `boot()` and would take the whole
    // boot down — the failure a splash module is the last place that should have.
    expect(() => setBootProgress(0.5, { doc: fakeSplash(false).doc })).not.toThrow();
    expect(() => setBootProgress(0.5, {})).not.toThrow();
  });
});

describe('hideBootSplash', () => {
  it('fills the bar, waits out the floor, fades, and only then removes', async () => {
    const { doc, splash, bar } = fakeSplash();
    const order: string[] = [];
    const sleep = (ms: number): Promise<void> => {
      order.push(`sleep ${ms}`);
      return Promise.resolve();
    };

    await hideBootSplash({ doc, elapsed: () => 400, sleep });

    // The bar reaching the end is part of coming down: a splash that fades out at 70% looks
    // like it gave up rather than finished.
    expect(bar.style.width).toBe('100%');
    expect(order).toEqual([`sleep ${MIN_BOOT_SPLASH_MS - 400}`, `sleep ${BOOT_SPLASH_FADE_MS}`]);
    expect(splash.classes).toEqual([HIDING_CLASS]);
    expect(splash.removed).toBe(true);
  });

  it('does not remove the element while the fade is still running', async () => {
    // `el.remove()` without awaiting the fade is the mutant that looks completely fine in
    // source and cuts the splash off mid-transition on screen — a step, not a fade.
    const { doc, splash } = fakeSplash();
    let releaseFade = (): void => {};
    const sleep = (ms: number): Promise<void> =>
      ms === BOOT_SPLASH_FADE_MS ? new Promise((r) => (releaseFade = () => r())) : Promise.resolve();

    const hidden = hideBootSplash({ doc, elapsed: () => MIN_BOOT_SPLASH_MS, sleep });
    await new Promise((r) => setTimeout(r, 0));
    expect(splash.classes).toEqual([HIDING_CLASS]);
    expect(splash.removed).toBe(false);

    releaseFade();
    await hidden;
    expect(splash.removed).toBe(true);
  });

  it('waits the floor out even when there is no splash left to remove', async () => {
    // The floor is about what the PLAYER sees, and on a host whose element is already gone
    // the game behind it is still not ready. Returning early here would let `boot()` finish
    // ahead of the floor on exactly the path that cannot be seen.
    const slept: number[] = [];
    const { doc } = fakeSplash(false);
    const sleep = (ms: number): Promise<void> => {
      slept.push(ms);
      return Promise.resolve();
    };
    await hideBootSplash({ doc, elapsed: () => 0, sleep });
    expect(slept).toEqual([MIN_BOOT_SPLASH_MS]);
  });
});

describe('afterFirstRenderedFrame', () => {
  /** The timeout arm, held open — these cases are about the ticker arm. */
  const NEVER = (): Promise<void> => new Promise<void>(() => {});
  /** Drain the microtask queue. `Promise.race` sits between the tick and the resolution, so a
   *  single `await Promise.resolve()` lands one hop short of the answer. */
  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  /** Pixi's `Ticker`, reduced to the one method this uses, plus a way to drive it. */
  function fakeTicker(): { ticker: { addOnce(fn: () => void): unknown }; tick(): void } {
    let pending: Array<() => void> = [];
    return {
      ticker: { addOnce: (fn) => pending.push(fn) },
      tick: () => {
        const due = pending;
        pending = [];
        for (const fn of due) fn();
      },
    };
  }

  it('resolves on the SECOND tick, not the first', async () => {
    // The whole point, and a one-hop version passes any test that only checks "it resolves".
    // `Application` renders from a ticker listener at `UPDATE_PRIORITY.LOW`, which runs after
    // one added here at the default priority — so the first callback fires BEFORE that tick's
    // render. Resolving there uncovers a canvas the menu has not been drawn onto yet, which
    // is the blank first frame this whole change exists to remove.
    const { ticker, tick } = fakeTicker();
    let resolved = false;
    void afterFirstRenderedFrame(ticker, { sleep: NEVER }).then(() => (resolved = true));

    tick();
    await flush();
    expect(resolved).toBe(false);

    tick();
    await flush();
    expect(resolved).toBe(true);
  });

  it('registers exactly one listener at a time, so nothing is left on the ticker', async () => {
    // `addOnce` twice over is two entries the ticker drops itself; `add` would leave a
    // callback redrawing nothing for the rest of the session (the bug loadingScreen.ts's
    // `destroy()` note records).
    const registered: Array<() => void> = [];
    const ticker = { addOnce: (fn: () => void) => registered.push(fn) };
    const done = afterFirstRenderedFrame(ticker, { sleep: NEVER });
    expect(registered.length).toBe(1);
    registered[0]!();
    expect(registered.length).toBe(2);
    registered[1]!();
    await expect(done).resolves.toBeUndefined();
  });

  it('gives up on a frame that is never going to come', async () => {
    // A tab opened in the BACKGROUND gets no `requestAnimationFrame` at all, so the ticker
    // never runs and neither hop ever fires. Without this arm `boot()` simply never returns
    // — which is what a hidden preview pane did while this was being written.
    const slept: number[] = [];
    const sleep = (ms: number): Promise<void> => {
      slept.push(ms);
      return Promise.resolve();
    };
    await expect(
      afterFirstRenderedFrame({ addOnce: () => undefined }, { sleep }),
    ).resolves.toBeUndefined();
    expect(slept).toEqual([FIRST_FRAME_TIMEOUT_MS]);
  });
});

describe('the markup it drives — client/index.html', () => {
  /**
   * Every case here exists because THIS MODULE FAILS SILENTLY BY DESIGN.
   *
   * `resolveDoc(...)?.getElementById(...)` answering `null` is a legitimate, tested state — it
   * is the WeChat runtime, which has no DOM at all — so `setBootProgress` and `hideBootSplash`
   * are written to shrug and return. That is correct for the host that has no splash and
   * catastrophic for the host that has one under a different name: rename `boot-progress` in
   * the HTML and the bar stops moving; rename `boot-loading` and the splash stays up over the
   * running game for the rest of the session. Both leave the whole suite green, because every
   * other case in this file hands in its own `doc`.
   *
   * So the contract between the file and the module is asserted from the file's own bytes.
   */
  const INDEX_HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

  it('carries both ids the module looks up', () => {
    expect(INDEX_HTML).toMatch(/id="boot-loading"/);
    expect(INDEX_HTML).toMatch(/id="boot-progress"/);
  });

  it('styles the class the module adds as a fade-out', () => {
    // `HIDING_CLASS` is only half of a fade; the other half is a CSS rule that does something
    // when it lands. Without it the splash is removed after an invisible 320 ms pause — the
    // hard cut the fade was added to remove, with nothing red anywhere.
    expect(INDEX_HTML).toContain(`#boot-loading.${HIDING_CLASS}`);
    expect(INDEX_HTML).toMatch(new RegExp(`#boot-loading\\.${HIDING_CLASS}\\s*\\{[^}]*opacity:\\s*0`));
  });

  it('transitions for exactly as long as the module waits before removing', () => {
    // The two numbers are in different languages and different files, and they have to agree:
    // a CSS transition LONGER than `BOOT_SPLASH_FADE_MS` removes the element mid-fade (a step),
    // a shorter one leaves a fully transparent splash sitting there for the difference. Read
    // out of the stylesheet rather than restated, so this fails on the edit that causes it.
    const declared = INDEX_HTML.match(/#boot-loading\s*\{[^}]*transition:\s*opacity\s+(\d+)ms/);
    expect(declared, 'index.html has no opacity transition on #boot-loading').not.toBeNull();
    expect(Number(declared![1])).toBe(BOOT_SPLASH_FADE_MS);
  });

  it('paints the splash with no script at all', () => {
    // The whole point of the splash being markup: most of the wait it covers is the BUNDLE
    // arriving, so anything that needs the bundle to run cannot be part of it. The spinner,
    // the brand, the bar's track and the slow-connection hint are all static, and the one
    // `<script>` in the file is the entry module itself.
    const scripts = INDEX_HTML.match(/<script[ >]/g) ?? [];
    expect(scripts.length, 'index.html grew a second <script>').toBe(1);
    expect(INDEX_HTML).toMatch(/<script type="module" src="\/src\/main\.ts">/);
    // ...and the body really holds the splash, rather than an empty div a script fills in.
    expect(INDEX_HTML).toMatch(/<div id="boot-loading">[\s\S]*?spinner[\s\S]*?<\/div>/);
  });

  it('reveals the slow-connection hint on the clock rather than on an event', () => {
    // The one case this line exists for is the one where NO script of ours ever runs — a
    // bundle that 404s after a deploy, a dead connection. A hint shown by JavaScript is a hint
    // that is absent exactly when it is needed, and nothing else here would notice.
    const hint = INDEX_HTML.match(/#boot-loading \.slow\s*\{[^}]*animation:[^;]*?(\d+)s\s+forwards/);
    expect(hint, 'the slow hint is no longer revealed by a CSS animation').not.toBeNull();
    expect(Number(hint![1]), 'the hint appears too early to mean anything').toBeGreaterThanOrEqual(5);
  });

  it('is dark before a single byte of CSS-in-JS could run', () => {
    // The first paint of the document is the browser's own, and its default is WHITE. The
    // background has to be in the inline stylesheet on `html, body` — not on the splash alone,
    // which is removed while the canvas underneath is still the thing being looked at.
    expect(INDEX_HTML).toMatch(/html, body \{[^}]*background: #0b0d12/);
  });
});
