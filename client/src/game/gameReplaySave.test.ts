/**
 * Saving a replay, end to end through `Game` — both entry points, against a real run.
 *
 * Written for the same reason `gameWeaponSwap.test.ts` was: every PIECE of this verb had
 * unit coverage and was green while the verb itself was broken. `MatchRecorder.test.ts`
 * proves the recorder packs a faithful file, `replayFile.test.ts` proves the file
 * round-trips, `HudView.test.ts` proves the button fires its callback — and none of them
 * touch the two lines in `Game.ts` that connect a keypress or a tap to a run's own engine.
 * That gap is not hypothetical: the `?replay=` path shipped yesterday with `this.engine`
 * never assigned, and the whole suite stayed green because every test injects its own
 * engine.
 *
 * So this file asserts the only observable that matters: after the press (or the tap), the
 * bytes handed to the browser reconstruct the run that was actually being played.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { Container, type Ticker } from 'pixi.js';
import { hashState, parseReplayFileText, runReplay, type GameState } from '@dd/engine';
import { t } from '../i18n';
import { installFakeTextCanvas } from './screens/fakeTextCanvas';
import { Game } from './Game';
import type { MetaState } from '../meta';

installFakeTextCanvas();

const NO_TOUCH = {
  active: false, stickRadius: 0, move: null,
  fire: { cx: 0, cy: 0, r: 0, pressed: false },
  weapon1: { cx: 0, cy: 0, r: 0 }, weapon2: { cx: 0, cy: 0, r: 0 },
  interact: { cx: 0, cy: 0, r: 0, pressed: false },
};

interface Saved { name: string; text: string }

/**
 * The browser surface `downloadReplayFile` needs, faked at the same seam a real browser
 * provides it — an anchor with a `download` attribute, a Blob, and an object URL. Faking
 * `downloadReplayFile` itself would prove nothing about Game: the point is to capture the
 * actual bytes that would reach the disk.
 */
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

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function newGame(opts: { canDownload?: boolean } = {}) {
  const win = installFakeWindow();
  // `canDownload: false` leaves the host WITHOUT a document/Blob — which is the WeChat
  // shape (design/04: no DOM at all), and the path where the control has to say so.
  const dl = opts.canDownload === false
    ? { saved: [] as Saved[], restore: () => {} }
    : installFakeDownload();
  cleanups.push(win.restore, dl.restore);

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
    run: {
      phase: string;
      engine: { state: GameState } | null;
      replayStop: number | null;
      meta: MetaState;
      setMeta(m: MetaState): void;
    };
    hud: {
      replayBtn: { onTap: (() => void) | null };
      onSaveReplay: (() => void) | null;
      toast(text: string, color?: number): void;
    };
    nav: { showForge(): void };
    runs: { beginRun(): void; beginTutorialRun(): void; beginArenaDemoRun(): void; finalizeOnlineRun(session: unknown): void };
    // The other two offline entry points, and the online transition — all private, all
    // reached here exactly the way a player reaches them (a ModeSelect button / a match
    // starting), because the thing under test is whether each one leaves an exportable
    // stream behind.
  };
  let ms = 0;
  const frames = (n: number) => {
    for (let i = 0; i < n; i++) { ms += 16.7; for (const cb of frameCbs) cb({ deltaMS: 16.7, lastTime: ms } as Ticker); }
  };
  const pressF9 = () => { for (const cb of win.keydown) cb({ code: 'F9' }); };
  // The toast is the ONLY thing the player sees, so it is an observable in its own right:
  // a control that saved nothing while saying "saved" is worse than one that does nothing.
  const toasts: string[] = [];
  const realToast = inner.hud.toast.bind(inner.hud);
  inner.hud.toast = (text: string, color?: number) => { toasts.push(text); realToast(text, color); };
  return { game, inner, frames, pressF9, saved: dl.saved, toasts };
}

function startedRun(opts: { canDownload?: boolean } = {}) {
  const h = newGame(opts);
  // A player who has already been taught. Since design/20's onboarding pass a first-ever
  // run also runs the teaching beats, whose toasts would otherwise share this harness's
  // `toasts` list with the ones these cases are actually about (`TutorialHintController`
  // owns that behaviour, and `RunLifecycle.test.ts` owns the flag).
  h.inner.run.setMeta({ ...h.inner.run.meta, hasSeenTutorial: true });
  h.inner.nav.showForge();
  h.inner.runs.beginRun();
  h.frames(120); // a real run, long enough that the recorded stream is not trivially short
  return h;
}

describe('Game — saving a replay, from a real run to real bytes', () => {
  it('the HUD record button writes a file that reconstructs the run being played', () => {
    const { inner, saved } = startedRun();
    const live = inner.run.engine!.state;
    expect(live.tick).toBeGreaterThan(50); // the run really advanced

    inner.hud.replayBtn.onTap!();

    expect(saved).toHaveLength(1);
    expect(saved[0]!.name).toMatch(/^ddreplay-dungeon-\d+\.json$/);

    // The claim worth making: these bytes ARE the run. Not "a file was produced".
    const file = parseReplayFileText(saved[0]!.text);
    const replayed = runReplay(file.replay, file.ticks);
    expect(replayed.state.tick).toBe(live.tick);
    expect(hashState(replayed.state)).toBe(hashState(live));
  });

  it('marks the tick the control was pressed on — the reason a report is answerable', () => {
    const { inner, saved } = startedRun();
    const at = inner.run.engine!.state.tick;
    inner.hud.replayBtn.onTap!();
    expect(parseReplayFileText(saved[0]!.text).marks).toEqual([
      { tick: at, note: `hotkey at tick ${at}` },
    ]);
  });

  it('the F9 key reaches the same verb — one save, two entry points', () => {
    const { inner, pressF9, saved } = startedRun();
    const at = inner.run.engine!.state.tick;
    pressF9();
    expect(saved).toHaveLength(1);
    const file = parseReplayFileText(saved[0]!.text);
    expect(file.ticks).toBe(at);
    expect(file.replay.commands).toHaveLength(at);
  });

  it('the two entry points produce the same file at the same tick', () => {
    const { inner, pressF9, saved } = startedRun();
    inner.hud.replayBtn.onTap!();
    pressF9();
    expect(saved).toHaveLength(2);
    const a = parseReplayFileText(saved[0]!.text);
    const b = parseReplayFileText(saved[1]!.text);
    expect(b.ticks).toBe(a.ticks);
    expect(b.replay.commands).toEqual(a.replay.commands);
  });

  it('keeps recording after a save — pressing it twice is not one-shot', () => {
    const { inner, frames, saved } = startedRun();
    inner.hud.replayBtn.onTap!();
    frames(60);
    inner.hud.replayBtn.onTap!();

    const first = parseReplayFileText(saved[0]!.text);
    const second = parseReplayFileText(saved[1]!.text);
    expect(second.ticks).toBeGreaterThan(first.ticks);
    expect(second.replay.commands.length).toBeGreaterThan(first.replay.commands.length);
    // Both presses are remembered, in order.
    expect(second.marks.map((m) => m.tick)).toEqual([first.ticks, second.ticks]);
  });

  it('says SAVED, naming the file, so the player knows what to hand over', () => {
    const { inner, toasts, saved } = startedRun();
    inner.hud.replayBtn.onTap!();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toContain(saved[0]!.name);
    expect(toasts[0]).toBe(t('toast.replaySaved', { name: saved[0]!.name }));
  });

  it('says NOTHING TO SAVE when no run is recording — not a false success', () => {
    const { pressF9, toasts, saved } = newGame();
    pressF9();
    expect(saved).toHaveLength(0);
    expect(toasts).toEqual([t('toast.replayNoRun')]);
  });

  it('says THIS DEVICE CANNOT — the WeChat shape, where a real run cannot be handed over', () => {
    // A run IS recording and the file IS packed; what fails is the host. Reporting that as
    // success would send a player looking for a download that never happened.
    const { inner, toasts } = startedRun({ canDownload: false });
    inner.hud.replayBtn.onTap!();
    expect(toasts).toEqual([t('toast.replayUnsupported')]);
  });

  it('a run that has not started yet saves nothing, and does not throw', () => {
    const { inner, pressF9, saved } = newGame();
    expect(inner.run.engine).toBeNull();
    expect(() => pressF9()).not.toThrow();
    expect(saved).toHaveLength(0);
  });

  it('a fresh run replaces the previous recording rather than appending to it', () => {
    const h = startedRun();
    h.inner.hud.replayBtn.onTap!();
    const first = parseReplayFileText(h.saved[0]!.text);

    h.inner.nav.showForge();
    h.inner.runs.beginRun();
    h.frames(30);
    h.inner.hud.replayBtn.onTap!();
    const second = parseReplayFileText(h.saved[1]!.text);

    expect(second.replay.commands.length).toBeLessThan(first.replay.commands.length);
    expect(second.marks).toHaveLength(1); // the first run's mark did not survive
    // And the second file still reconstructs the second run.
    expect(hashState(runReplay(second.replay, second.ticks).state)).toBe(hashState(h.inner.run.engine!.state));
  });
});

describe('every offline entry point leaves an exportable run behind', () => {
  // `startOfflineEngine` exists so a hotkey that "only works if you started the run the
  // right way" cannot happen — but only ONE of the three callers was ever driven here, so
  // that guarantee rested on reading the code. A new offline entry point that built its
  // engine with `createGameEngine` directly would leave F9 silently dead on exactly the
  // mode it was added for, and the whole suite would stay green.
  const ENTRIES = [
    {
      name: 'dungeon (Enter from the forge)',
      label: 'dungeon',
      start: (i: ReturnType<typeof newGame>['inner']) => { i.nav.showForge(); i.runs.beginRun(); },
    },
    {
      name: 'tutorial (ModeSelect’s TUTORIAL button)',
      label: 'tutorial',
      start: (i: ReturnType<typeof newGame>['inner']) => i.runs.beginTutorialRun(),
    },
    {
      name: 'arena demo (?arena=, the dev harness)',
      label: 'arena',
      start: (i: ReturnType<typeof newGame>['inner']) => i.runs.beginArenaDemoRun(),
    },
  ];

  for (const entry of ENTRIES) {
    it(`${entry.name} records, and the file says which mode it was`, () => {
      const h = newGame();
      entry.start(h.inner);
      h.frames(90);

      h.inner.hud.replayBtn.onTap!();
      expect(h.saved).toHaveLength(1);
      expect(h.saved[0]!.name).toMatch(new RegExp(`^ddreplay-${entry.label}-\\d+\\.json$`));

      const file = parseReplayFileText(h.saved[0]!.text);
      // The label is what orients whoever opens the file — a tutorial repro read as a
      // dungeon one sends the reader to the wrong config entirely.
      expect(file.label).toBe(entry.label);
      // And the same claim the dungeon case makes: these bytes ARE the run.
      expect(file.replay.commands.length).toBeGreaterThan(0);
      expect(hashState(runReplay(file.replay, file.ticks).state)).toBe(hashState(h.inner.run.engine!.state));
    });
  }
});

describe('an online match is not exportable — and neither is the run before it', () => {
  it('finalizeOnlineRun drops the offline stream, so F9 cannot hand over a stale file', () => {
    // Online input arrives on the server's confirmed stream (`NetInputSource`), so nothing
    // here records it and the authoritative record is `FrameBroadcast`'s. Without
    // `recorder.end()` on this transition, F9 in an online match would cheerfully save the
    // LAST OFFLINE RUN — a file that reconstructs a match nobody is looking at, labelled
    // and dated as if it were the current one. That is worse than no file: it costs a whole
    // report cycle before anyone notices the repro is of the wrong run.
    const h = startedRun();
    h.inner.hud.replayBtn.onTap!();
    expect(h.saved).toHaveLength(1); // exportable right up to the transition

    h.inner.runs.finalizeOnlineRun({ close: () => {} });

    h.pressF9();
    expect(h.saved).toHaveLength(1); // nothing new reached the disk
    expect(h.toasts[h.toasts.length - 1]).toBe(t('toast.replayNoRun'));
  });
});
