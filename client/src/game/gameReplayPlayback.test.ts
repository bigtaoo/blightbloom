/**
 * Watching a recording, end to end through `Game` — the `?replay=<url>` half of the
 * feature (`match/replayPlayback.ts`), against a real recorded file.
 *
 * This is the function that SHIPPED BROKEN. `beginReplayRun` built an engine and never
 * assigned `this.engine`, so the client booted into a black screen, and the whole suite
 * stayed green: `replayPlayback.test.ts` proves `loadReplayFile`/`replayStopTick` are
 * right, `GameLoop.test.ts` proves the loop freezes at a stop tick — and both inject
 * their own engine, which is exactly the field that was missing. Same lesson as
 * `gameReplaySave.test.ts`, one function over: every piece was covered and the verb was
 * not, because nothing in the suite ever went through the real wiring.
 *
 * So the observable here is the run itself: after the boot, is the engine inside `Game`
 * the recorded stream, does it advance, does it hold at the marked moment, and is
 * everything that belongs to a LIVE run switched off.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { Container, type Ticker } from 'pixi.js';
import {
  Button,
  LocalInputSource,
  hashState,
  makeCommand,
  packReplayFile,
  parseReplayFileText,
  quantizeMove,
  runReplay,
  type GameState,
} from '@dd/engine';
import { t } from '../i18n';
import { installFakeTextCanvas } from './screens/fakeTextCanvas';
import { buildDungeonRunConfig } from './match/offlineConfig';
import { Game } from './Game';

installFakeTextCanvas();

const NO_TOUCH = {
  active: false, stickRadius: 0, move: null,
  fire: { cx: 0, cy: 0, r: 0, pressed: false },
  weapon1: { cx: 0, cy: 0, r: 0 }, weapon2: { cx: 0, cy: 0, r: 0 },
  interact: { cx: 0, cy: 0, r: 0, pressed: false },
};

const RECORDED_TICKS = 300;
/** Two marks, so "the LAST one" is a real choice rather than "the only one". */
const FIRST_MARK = 40;
const LAST_MARK = 120;

const RECORDED_CONFIG = buildDungeonRunConfig({
  seed: 0xda1d,
  coop: false,
  localSeat: { skinId: 'vanguard', loadout: [] },
  allySkinId: 'skirmisher',
});

/** A genuine recording, packed exactly the way the F9 hotkey packs one. */
function recordedFileText(): string {
  const live = new LocalInputSource();
  for (let tick = 1; tick <= RECORDED_TICKS; tick++) {
    const { moveBrad, moveMag } = quantizeMove(Math.sin(tick * 0.03), Math.cos(tick * 0.021));
    live.submit(makeCommand({ owner: 0, tick, moveBrad, moveMag, buttons: Button.FIRE }));
  }
  return JSON.stringify(packReplayFile({
    config: RECORDED_CONFIG,
    commands: live.recorded(),
    ticks: RECORDED_TICKS,
    label: 'dungeon',
    marks: [{ tick: FIRST_MARK, note: 'first press' }, { tick: LAST_MARK, note: 'the moment' }],
    recordedAtMs: 1_700_000_000_000,
  }));
}

interface Saved { name: string; text: string }

/** Same fake browser download surface as `gameReplaySave.test.ts` — the point of having it
 *  here is the NEGATIVE assertion: during playback, nothing must reach it. */
function installFakeDownload(): { saved: Saved[]; restore: () => void } {
  const g = globalThis as Record<string, unknown>;
  const before = { document: g.document, Blob: g.Blob, URL: g.URL };
  const saved: Saved[] = [];
  const blobText = new Map<object, string>();

  class FakeBlob {
    constructor(parts: string[]) { blobText.set(this, parts.join('')); }
  }
  const urls = new Map<string, object>();
  let n = 0;

  g.Blob = FakeBlob;
  g.URL = {
    createObjectURL: (b: object) => { const u = `blob:fake/${n++}`; urls.set(u, b); return u; },
    revokeObjectURL: (u: string) => { urls.delete(u); },
  };
  g.document = {
    createElement: (tag: string) => {
      if (tag !== 'a') throw new Error(`unexpected createElement(${tag})`);
      const el = { href: '', download: '', click: () => {
        const blob = urls.get(el.href);
        saved.push({ name: el.download, text: blob ? blobText.get(blob) ?? '' : '' });
      } };
      return el;
    },
  };

  return {
    saved,
    restore: () => { g.document = before.document; g.Blob = before.Blob; g.URL = before.URL; },
  };
}

/** A window that CAPTURES its listeners, so a keydown can be delivered by hand. */
function installFakeWindow(): { keydown: Array<(e: { code: string }) => void>; restore: () => void } {
  const g = globalThis as Record<string, unknown>;
  const before = g.window;
  const keydown: Array<(e: { code: string }) => void> = [];
  g.window = {
    addEventListener: (type: string, cb: (e: { code: string }) => void) => {
      if (type === 'keydown') keydown.push(cb);
    },
    removeEventListener: () => {},
  };
  return { keydown, restore: () => { g.window = before; } };
}

/**
 * The two globals the `?replay=` boot actually reads: `location.search` (parsed in the
 * constructor, so it has to be in place BEFORE `new Game`) and `fetch`. Faked at the host
 * seam rather than by stubbing `loadReplayFile`, for the same reason the save test fakes a
 * Blob instead of the download function — the wiring between the URL and the engine is
 * the thing under test, and stubbing the loader is stubbing out half of it.
 */
function installFakeHost(search: string, body: string | null) {
  const g = globalThis as Record<string, unknown>;
  const before = { location: g.location, fetch: g.fetch };
  const state = { body };
  const fetched: string[] = [];

  g.location = { search };
  g.fetch = (url: string) =>
    Promise.resolve(
      state.body === null
        ? { ok: false, status: 404, text: () => Promise.resolve('') }
        : { ok: true, status: 200, text: () => Promise.resolve(state.body!) },
    ).then((res) => { fetched.push(url); return res; });

  return {
    fetched,
    /** Change what the NEXT fetch answers — `null` = a 404. */
    serve: (next: string | null) => { state.body = next; },
    restore: () => { g.location = before.location; g.fetch = before.fetch; },
  };
}

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

/** One macrotask: `beginReplayRun` awaits a fetch and a `.text()`, both already resolved. */
const flush = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });

function newGame(opts: { search?: string; body?: string | null } = {}) {
  const host = installFakeHost(opts.search ?? '?replay=/r.json', opts.body ?? recordedFileText());
  const win = installFakeWindow();
  const dl = installFakeDownload();
  cleanups.push(host.restore, win.restore, dl.restore);

  const frameCbs: Array<(t: Ticker) => void> = [];
  const app = {
    stage: new Container(),
    renderer: { screen: { width: 1280, height: 720 }, resolution: 1, resize: () => {} },
    ticker: { add: (cb: (t: Ticker) => void) => frameCbs.push(cb), remove: () => {} },
    canvas: {},
  } as unknown as ConstructorParameters<typeof Game>[0];

  const input = {
    onSwitchWeapon: null as ((slot: number) => void) | null,
    attach: () => {},
    read: () => ({ moveX: 1, moveY: 0, firing: true, interacting: false }),
    getTouchVisual: () => NO_TOUCH,
    setControlMirror: () => {},
  };
  const game = new Game(app, input as never,
    { play: () => {}, setSfxVolume: () => {}, setMusicVolume: () => {}, resume: () => {} } as never);
  game.start();

  const inner = game as unknown as {
    run: { phase: string; engine: { state: GameState } | null; replayStop: number | null };
    hud: {
      replayBtn: { view: { visible: boolean } };
      update(...args: unknown[]): void;
      toast(text: string, color?: number): void;
    };
    nav: { showForge(): void };
    runs: { beginRun(): void; beginReplayRun(url: string): Promise<void> };
  };

  let ms = 0;
  const frames = (n: number) => {
    for (let i = 0; i < n; i++) { ms += 16.7; for (const cb of frameCbs) cb({ deltaMS: 16.7, lastTime: ms } as Ticker); }
  };
  const pressF9 = () => { for (const cb of win.keydown) cb({ code: 'F9' }); };

  const toasts: string[] = [];
  const realToast = inner.hud.toast.bind(inner.hud);
  inner.hud.toast = (text: string, color?: number) => { toasts.push(text); realToast(text, color); };
  // How many times the HUD was refreshed — the cheapest proof that the RENDER loop is
  // still running while the sim is held still (a frozen sim and a frozen client look
  // identical from the outside otherwise).
  const counted = { hudUpdates: 0 };
  const realUpdate = inner.hud.update.bind(inner.hud);
  inner.hud.update = (...args: unknown[]) => { counted.hudUpdates++; realUpdate(...args); };

  return { game, inner, frames, pressF9, saved: dl.saved, toasts, counted, host };
}

describe('Game — booting into a recording with ?replay=', () => {
  it('the engine inside Game IS the recorded stream, and it advances', async () => {
    // The shipped bug, stated as an assertion: `this.engine` assigned, non-null, and
    // stepping. Everything below depends on it, so it is checked on its own first.
    const text = recordedFileText();
    const h = newGame({ body: text });
    await flush();

    expect(h.host.fetched).toEqual(['/r.json']);
    expect(h.inner.run.phase).toBe('playing');
    expect(h.inner.run.engine).not.toBeNull();
    expect(h.inner.run.engine!.state.tick).toBe(0); // built, not yet stepped

    h.frames(30);
    const first = h.inner.run.engine!.state.tick;
    expect(first).toBeGreaterThan(0);
    h.frames(30);
    expect(h.inner.run.engine!.state.tick).toBeGreaterThan(first);

    // And it is the RECORDED input driving it, not a live one: the state matches a
    // headless replay of the same file to the same tick, bit for bit. A live command
    // submitted over the top would diverge here (and `ReplayInputSource` is read-only, so
    // it would throw) — this is the assertion that says playback is playback.
    const file = parseReplayFileText(text);
    const at = h.inner.run.engine!.state.tick;
    expect(hashState(runReplay(file.replay, at).state)).toBe(hashState(h.inner.run.engine!.state));
  });

  it('holds at the LAST marked tick while the frame loop keeps running', async () => {
    // A frozen sim under a live render loop is the whole point (replayPlayback.ts's
    // header): the camera still moves and the debug overlay still draws, so the reported
    // moment can be looked at and screenshotted instead of flashing past.
    const h = newGame();
    await flush();
    expect(h.game.replayStopTick()).toBe(LAST_MARK);

    h.frames(600); // far past both the mark and the end of the 300-tick stream
    expect(h.inner.run.engine!.state.tick).toBe(LAST_MARK);

    const before = h.counted.hudUpdates;
    h.frames(60);
    expect(h.inner.run.engine!.state.tick).toBe(LAST_MARK); // still held
    expect(h.counted.hudUpdates).toBeGreaterThan(before); // and the client is not frozen
  });

  it('hides the record button: this run is already somebody else’s file', async () => {
    const h = newGame();
    await flush();
    h.frames(10);
    expect(h.inner.hud.replayBtn.view.visible).toBe(false);
  });

  it('F9 during playback says NOTHING TO SAVE, and drops the previous offline run with it', async () => {
    // Two claims in one, because they are the same line of code (`recorder.end()`): the
    // recording being watched is not re-exportable, AND a run played before switching into
    // playback must not be either. Without the `end()` the hotkey would hand over a file
    // labelled with the old run while the player is looking at a different one entirely —
    // the worst possible bug in a feature whose only job is answering "which run was this".
    const h = newGame({ search: '' }); // no ?replay= — a normal offline boot first
    h.inner.nav.showForge();
    h.inner.runs.beginRun();
    h.frames(60);
    h.pressF9();
    expect(h.saved).toHaveLength(1); // the offline run really was exportable

    await h.inner.runs.beginReplayRun('/r.json');
    h.frames(30);
    h.pressF9();

    expect(h.saved).toHaveLength(1); // nothing new reached the disk
    expect(h.toasts[h.toasts.length - 1]).toBe(t('toast.replayNoRun'));
  });

  it('a foreign JSON lands in a toast carrying the parser’s own words, not a black screen', async () => {
    // The normal way this feature gets used wrong is a wrong path or a file from another
    // ENGINE_VERSION, so the message has to be the one the parser wrote — a generic
    // "replay failed" would send the reader looking in the wrong place.
    const h = newGame({ body: JSON.stringify({ hello: 'world' }) });
    await flush();

    expect(h.game.replayStopTick()).toBeNull();
    expect(h.toasts).toHaveLength(1);
    expect(h.toasts[0]).toContain('Not a Blightbloom replay');
    expect(h.inner.run.phase).not.toBe('playing'); // and it did not half-enter a run
    expect(h.inner.run.engine).toBeNull();
  });

  it('a failed load RELEASES the held tick, so the next run is not frozen at it', async () => {
    // The catch's `this.replayStop = null` — invisible in the failure itself (the toast is
    // identical either way) and lethal one transition later: a stale stop tick makes
    // `GameLoop.stepSim` return early forever, i.e. a run that boots and never moves, with
    // no error anywhere to explain it.
    const h = newGame();
    await flush();
    expect(h.game.replayStopTick()).toBe(LAST_MARK);

    h.host.serve(null); // the next fetch 404s
    await h.inner.runs.beginReplayRun('/missing.json');

    expect(h.game.replayStopTick()).toBeNull();
    expect(h.toasts[h.toasts.length - 1]).toContain('Could not load replay /missing.json');

    // The consequence, asserted rather than assumed: a fresh offline run advances past the
    // tick the abandoned file wanted to hold.
    h.inner.nav.showForge();
    h.inner.runs.beginRun();
    h.frames(300);
    expect(h.inner.run.engine!.state.tick).toBeGreaterThan(LAST_MARK);
  });
});
