/**
 * The WeChat music path, driven end to end against a WeChat-SHAPED runtime, with the paths it
 * produces checked against the REAL shipped files on disk.
 *
 * The music counterpart of `wechatAudioLoad.test.ts`, and it exists for a sharper version of that
 * file's reason. A cue that fails to load on this target is inaudible but harmless — the
 * procedural voice plays instead. Music has no fallback at all: every WeChat-specific difference
 * below is a way to ship 0.84 MB of dead weight and hear nothing, with no error anywhere.
 *
 *   - **The src is a SUBPACKAGE path.** `/audio/music/menu.mp3` really lives at
 *     `packs/music/audio/music/menu.mp3` (`render/assetPacks.json`'s `music` pack, which the byte
 *     gate forced into existence a day before the runtime did). A deck handed the public path
 *     names nothing.
 *   - **There is no audio graph, so there is no bus node.** The settings volume has to be
 *     multiplied into each stream's own `.volume` together with its crossfade level — the one
 *     method whose two platform implementations can never be shared.
 *   - **Music must NOT depend on `createWebAudioContext`**, which is the API design/11 records as
 *     unverified on the lowest base library. If it did, the platform's least certain audio call
 *     would be able to take the bed down with the samples.
 *   - **There is no autoplay gate on this path**, so the bed starts on the first frame rather than
 *     on the first tap — the opposite of both the web music path and this platform's own cues.
 *   - **Interruption arrives as `wx.onAudioInterruptionBegin`**, not `visibilitychange`. There is
 *     no DOM here, so it is the only signal there is.
 *
 * What it CANNOT pin, and still needs a device (design/04's checklist): that a real base library
 * has `createInnerAudioContext` at all, that it accepts a path inside a loaded subpackage, that
 * its decoder takes these two 24 kHz stereo files, and anything about how `currentTime` behaves
 * across a real interruption. A strong regression net, not a substitute for running it.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WeChatAudio } from '../platform/wechat/WeChatAudio';
import { packedPathFor } from '../render/assetManifest';
import { MUSIC_CATALOGUE, XFADE_S, musicPaths } from './musicCatalogue';
import type { MusicSituation } from '../game/musicDirector';
import { invalidateMusicTrack, setMusicAudio, updateMusicForFrame } from '../game/musicDirector';

const PUBLIC = new URL('../../public/', import.meta.url);

/** Undo the pack rewrite: the file on disk a code-package path must name. */
function diskPathFor(packed: string): URL {
  const root = 'packs/music/';
  return new URL(packed.startsWith(root) ? packed.slice(root.length) : packed, PUBLIC);
}

// ---------------------------------------------------------------------------------------
// An `InnerAudioContext`-shaped fake. Deliberately NOT a media element: `stop()` rewinds,
// `currentTime` is read-only from the caller's side, and level is one `volume` number.
// ---------------------------------------------------------------------------------------
class FakeInner {
  static all: FakeInner[] = [];
  loop = true; // starts WRONG on purpose, so the deck setting it false is observable
  obeyMuteSwitch = false;
  volume = 1;
  currentTime = 0;
  duration = 0;
  paused = false;
  playing = false;
  srcHistory: string[] = [];
  plays = 0;
  stops = 0;
  pauses = 0;
  errorCb: ((res: { errMsg?: string }) => void) | null = null;
  private _src = '';

  constructor() {
    FakeInner.all.push(this);
  }
  get src(): string {
    return this._src;
  }
  set src(v: string) {
    this._src = v;
    this.srcHistory.push(v);
    this.currentTime = 0;
  }
  play(): void {
    this.plays++;
    this.playing = true;
    this.paused = false;
  }
  pause(): void {
    this.pauses++;
    this.playing = false;
    this.paused = true;
  }
  stop(): void {
    this.stops++;
    this.playing = false;
    this.currentTime = 0;
  }
  destroy(): void {
    this.playing = false;
  }
  onError(cb: (res: { errMsg?: string }) => void): void {
    this.errorCb = cb;
  }
}

const originals: Record<string, unknown> = {};
function stashAndDelete(name: string): void {
  originals[name] = (globalThis as Record<string, unknown>)[name];
  delete (globalThis as Record<string, unknown>)[name];
}

let interruptBegin: (() => void) | null = null;
let interruptEnd: (() => void) | null = null;

/** The `wx` a mini-game actually provides. `webAudio` is a parameter because whether
 *  `createWebAudioContext` exists is the platform's least certain fact, and music must not care. */
function installWx(opts: { inner?: boolean; webAudio?: boolean } = {}): void {
  const withInner = opts.inner !== false;
  (globalThis as Record<string, unknown>).wx = {
    ...(withInner ? { createInnerAudioContext: () => new FakeInner() } : {}),
    ...(opts.webAudio ? { createWebAudioContext: () => ({ state: 'suspended' }) } : {}),
    onAudioInterruptionBegin: (cb: () => void) => {
      interruptBegin = cb;
    },
    onAudioInterruptionEnd: (cb: () => void) => {
      interruptEnd = cb;
    },
  };
}

beforeAll(() => {
  // Same strip as `wechatAudioLoad.test.ts` / `render/wechatAssetLoad.test.ts`: a mini-game has
  // none of these, and code that quietly reaches for one passes under vitest's node env and is a
  // `ReferenceError` on a handset. `Audio` matters most here — its presence is exactly what
  // `WebAudio` keys its deck construction off, and a WeChat backend that somehow built one would
  // be reaching for a DOM this runtime does not have.
  for (const g of ['fetch', 'document', 'window', 'Audio', 'AudioContext', 'createImageBitmap']) {
    stashAndDelete(g);
  }
});

afterAll(() => {
  for (const [k, v] of Object.entries(originals)) {
    if (v === undefined) delete (globalThis as Record<string, unknown>)[k];
    else (globalThis as Record<string, unknown>)[k] = v;
  }
  delete (globalThis as Record<string, unknown>).wx;
  setMusicAudio(null);
});

const FRAME_MS = 1000 / 60;
const MENU = { phase: 'menu', state: null, localOwner: 0 } satisfies MusicSituation;

function run(sit: MusicSituation, ms: number): void {
  const frames = Math.round(ms / FRAME_MS);
  for (let i = 0; i < frames; i++) {
    updateMusicForFrame(sit, FRAME_MS);
    for (const inner of FakeInner.all) if (inner.playing) inner.currentTime += FRAME_MS / 1000;
  }
}

const live = (): FakeInner[] => FakeInner.all.filter((i) => i.playing);

beforeEach(() => {
  FakeInner.all = [];
  interruptBegin = null;
  interruptEnd = null;
  installWx();
});

describe('WeChat music — the path a stream is actually given', () => {
  it('points the deck at the SUBPACKAGE path, and that path names a real shipped file', () => {
    // The link that makes music reachable on this target at all, and the one that the design/11
    // pass predicted would be "a prefix rule, not a loader change". Asserted against the
    // filesystem rather than against `packedPathFor` alone, so a pack rename that keeps the
    // function honest and the files where they were still fails.
    setMusicAudio(new WeChatAudio());
    updateMusicForFrame(MENU, FRAME_MS);
    const packed = live()[0]!.srcHistory.at(-1)!;
    expect(packed).toBe(packedPathFor(MUSIC_CATALOGUE.menu.path));
    expect(packed).toBe('packs/music/audio/music/menu.mp3');
    expect(existsSync(fileURLToPath(diskPathFor(packed))), `${packed} names no file`).toBe(true);
  });

  it('produces a package-relative path for every catalogued loop — never a leading slash', () => {
    // WeChat's own docs allow `a/b/c` and `/a/b/c` and reject `./a/b/c`; the relative form is what
    // every sample uses and what `createImage`/`readFileSync` already take here.
    for (const path of musicPaths()) {
      const packed = packedPathFor(path);
      expect(packed.startsWith('/')).toBe(false);
      expect(packed.startsWith('./')).toBe(false);
      expect(existsSync(fileURLToPath(diskPathFor(packed))), `${packed} names no file`).toBe(true);
    }
  });

  it('opens exactly two long-lived streams, never one per track', () => {
    setMusicAudio(new WeChatAudio());
    run(MENU, 3000);
    run({ phase: 'playing', state: null, localOwner: 0 }, 3000);
    expect(FakeInner.all).toHaveLength(2);
  });

  it('turns native looping OFF on every stream', () => {
    // The fake starts `loop = true` so this cannot pass by default. MP3 frame padding denies the
    // sample-exact wrap `loop` performs, and it would also fight the second deck the player
    // starts for its own crossfade.
    setMusicAudio(new WeChatAudio());
    run(MENU, 1000);
    for (const inner of FakeInner.all) expect(inner.loop).toBe(false);
  });

  it('obeys the phone mute switch', () => {
    // A player who flicked the hardware switch means it, and a 69 s bed is the loudest thing the
    // game does. The runtime default is already true; set explicitly so it cannot drift.
    setMusicAudio(new WeChatAudio());
    run(MENU, 1000);
    for (const inner of FakeInner.all) expect(inner.obeyMuteSwitch).toBe(true);
  });
});

describe('WeChat music — no audio graph, so volume is a product', () => {
  it('multiplies the settings volume into each stream, alongside its crossfade level', () => {
    // The structural difference from web in one assertion: there is no `GainNode` to write once,
    // so `.volume` carries both numbers. If either factor were dropped the symptom would be a bed
    // at full level regardless of the slider, or one that the next crossfade resets.
    const audio = new WeChatAudio();
    setMusicAudio(audio);
    audio.setMusicVolume(0.4);
    run(MENU, XFADE_S * 1000 + 500);
    const inner = live()[0]!;
    expect(inner.volume).toBeCloseTo(0.4 * MUSIC_CATALOGUE.menu.gain, 5);
    // Mid-fade the product moves with the fade, not with the slider.
    audio.setMusicVolume(0.8);
    expect(inner.volume).toBeCloseTo(0.8 * MUSIC_CATALOGUE.menu.gain, 5);
  });

  it('applies a volume set BEFORE the decks exist', () => {
    // `settingsBinding.load()` runs at boot, ahead of the first frame — the shape of the bug
    // where a setting applies on change but not at load.
    const audio = new WeChatAudio();
    audio.setMusicVolume(0.2);
    setMusicAudio(audio);
    run(MENU, XFADE_S * 1000 + 500);
    expect(live()[0]!.volume).toBeCloseTo(0.2 * MUSIC_CATALOGUE.menu.gain, 5);
  });

  it('keeps the stream running at volume 0 when muted', () => {
    // If mute stopped the stream, unmuting would restart the bed from the top rather than reveal
    // where it had reached.
    const audio = new WeChatAudio();
    setMusicAudio(audio);
    run(MENU, XFADE_S * 1000 + 500);
    audio.setMusicVolume(0);
    expect(live()).toHaveLength(1);
    expect(live()[0]!.volume).toBe(0);
  });

  it('crossfades both streams through their own volume', () => {
    setMusicAudio(new WeChatAudio());
    run(MENU, XFADE_S * 1000 + 500);
    const first = live()[0]!;
    first.currentTime = MUSIC_CATALOGUE.menu.lengthS - XFADE_S - 0.05;
    run(MENU, XFADE_S * 500); // halfway through the wrap
    expect(live()).toHaveLength(2);
    const [a, b] = live() as [FakeInner, FakeInner];
    // Equal power means the two FADES square-sum to 1, and each volume is bus x fade — so the
    // volumes square-sum to bus^2. The default bus is 0.5, hence 0.25: the product survives the
    // fade rather than the fade replacing the setting.
    expect(a.volume ** 2 + b.volume ** 2).toBeCloseTo(0.5 ** 2, 2);
    run(MENU, XFADE_S * 1000);
    expect(live()).toHaveLength(1);
  });
});

describe('WeChat music — independent of the platform’s least certain audio API', () => {
  it('plays with createWebAudioContext entirely absent', () => {
    // design/11's open item 1 is whether that API exists on the lowest base library. The cue
    // samples are lost without it; the bed must not be. `installWx` leaves it out by default,
    // which is why every test above already proves this — asserted explicitly so the property
    // has a name rather than being an accident of the fixture.
    expect('createWebAudioContext' in (globalThis as unknown as { wx: object }).wx).toBe(false);
    setMusicAudio(new WeChatAudio());
    run(MENU, 1000);
    expect(live()).toHaveLength(1);
  });

  it('starts on the first frame, with no gesture and no resume()', () => {
    // The inverse of the web path and of this platform's own cues, both of which wait for a
    // context to reach `running`. `InnerAudioContext` has no such gate, so a mini-game's menu is
    // scored from the moment it appears.
    setMusicAudio(new WeChatAudio());
    updateMusicForFrame(MENU, FRAME_MS);
    expect(live()[0]!.plays).toBe(1);
  });

  it('degrades to a silent bed when createInnerAudioContext is missing, without thrashing', () => {
    installWx({ inner: false });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setMusicAudio(new WeChatAudio());
    expect(() => run(MENU, 2000)).not.toThrow();
    expect(FakeInner.all).toHaveLength(0);
    // And it is not a per-frame log: 120 frames of a missing API must not produce 120 lines.
    expect(warn.mock.calls.length).toBeLessThanOrEqual(1);
    warn.mockRestore();
  });

  it('gives up for the session when construction THROWS, rather than retrying every frame', () => {
    // A different path from the test above, and the one a mutation battery found untested: there
    // the API was absent (an early return), here it exists and fails (the catch). Without the
    // latch in that catch, `player` stays null and the next frame tries again — 60 constructions
    // and 60 console lines a second, which on this platform is also 60 attempts to allocate a
    // system audio resource.
    let attempts = 0;
    (globalThis as Record<string, unknown>).wx = {
      createInnerAudioContext: () => {
        attempts++;
        throw new Error('no audio resource available');
      },
      onAudioInterruptionBegin: () => {},
      onAudioInterruptionEnd: () => {},
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setMusicAudio(new WeChatAudio());
    run(MENU, 2000);
    expect(attempts).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('reports a stream error once, per deck, and keeps the game running', () => {
    // The likely real failure on device: a subpackage that did not land, so the src names
    // nothing. One line each is a real diagnosis; a throw out of the main loop is not.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setMusicAudio(new WeChatAudio());
    run(MENU, 1000);
    const inner = live()[0]!;
    expect(inner.errorCb, 'the deck never registered an error handler').not.toBe(null);
    inner.errorCb!({ errMsg: 'file not found' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('packs/music/audio/music/menu.mp3');
    expect(() => run(MENU, 1000)).not.toThrow();
    warn.mockRestore();
  });
});

describe('WeChat music — the invalidate the phased boot pushes', () => {
  // `WeChatAudio.invalidateMusic` had NO test until this block, on either platform: every
  // `invalidateMusic` the suite exercised was a hand-written fake, so "the phased boot calls it"
  // (`render/preloadArt.ts`, when the `music` pack finishes downloading) and "a player forgets
  // its track when asked" were both pinned, with nothing joining them to a deck that re-points.
  // An empty body survived everything — commit 8cf60e2's shape: every piece passing its own
  // check, and the game silent. This target is where the case is REAL rather than defensive:
  // design/12 defers the `music` pack precisely so the first frame does not wait for it, so a
  // deck genuinely can be handed a subpackage path before that pack has landed.

  it('re-points a deck that was pointed into a pack before it landed', () => {
    // The observable is a second `play()` on a stopped stream rather than a new `src`: the packed
    // path does not change, and re-assigning `src` is what rewinds on this runtime, so the deck
    // stops and starts the same src instead.
    setMusicAudio(new WeChatAudio());
    run(MENU, 1000);
    const inner = live()[0]!;
    expect(inner.plays).toBe(1);

    invalidateMusicTrack();
    expect(live(), 'the invalidate never reached the deck').toHaveLength(0);

    run(MENU, 100);
    expect(FakeInner.all).toHaveLength(2); // the same two long-lived streams
    expect(live()).toEqual([inner]);
    expect(inner.plays).toBe(2);
    expect(inner.srcHistory).toEqual([packedPathFor(MUSIC_CATALOGUE.menu.path)]);
    expect(inner.currentTime).toBeLessThan(0.5); // from the top, not from where it had got to
  });

  it('never opens a stream of its own — the reason it reads `player` and not `ensureMusic()`', () => {
    // The mutation this forbids is one line long and looks like tidying: routing this through
    // `ensureMusic()?.invalidate()` the way `updateMusic` does. On this platform that would
    // ALLOCATE two `InnerAudioContext` streams from inside a `wx.loadSubpackage` completion
    // callback — before any frame has asked for music, possibly in a session where the player
    // never gets a bed at all — and then hand them to a player whose track is null, so nothing
    // would ever stop them. With no player built there is by definition nothing playing to
    // forget, which is why the guard is the right one rather than merely the cheap one.
    const audio = new WeChatAudio();
    expect(() => audio.invalidateMusic()).not.toThrow();
    expect(FakeInner.all).toHaveLength(0);
    setMusicAudio(audio);
    invalidateMusicTrack();
    expect(FakeInner.all, 'the invalidate built the decks itself').toHaveLength(0);
    // ...and the first frame that actually wants music still gets it.
    run(MENU, 100);
    expect(FakeInner.all).toHaveLength(2);
    expect(live()).toHaveLength(1);
  });
});

describe('WeChat music — interruption', () => {
  it('holds the bed on onAudioInterruptionBegin and resumes it mid-stream', () => {
    // There is no `visibilitychange` on this runtime, so this pair is the whole of design/11's
    // "Focus/blur & interruption" here. Registered in the constructor rather than beside the
    // decks, because an interruption can begin before any music has played.
    setMusicAudio(new WeChatAudio());
    run(MENU, XFADE_S * 1000 + 500);
    const inner = live()[0]!;
    expect(interruptBegin, 'onAudioInterruptionBegin was never registered').not.toBe(null);

    interruptBegin!();
    expect(inner.playing).toBe(false);
    expect(inner.paused).toBe(true);
    const at = inner.currentTime;

    interruptEnd!();
    expect(inner.playing).toBe(true);
    // Held, not restarted: an incoming call must not replay the opening bar, and the src is not
    // re-assigned (which on this runtime is what rewinds).
    expect(inner.currentTime).toBe(at);
    expect(inner.srcHistory).toHaveLength(1);
  });

  it('arms the interruption handlers before any music has played', () => {
    // The ordering that matters: a call arriving during the loading screen would otherwise leave
    // the resume half unregistered, and the bed would come back on top of the caller.
    new WeChatAudio();
    expect(interruptBegin).not.toBe(null);
    expect(interruptEnd).not.toBe(null);
    expect(FakeInner.all).toHaveLength(0);
  });

  it('does not wrap on evidence gathered while interrupted', () => {
    setMusicAudio(new WeChatAudio());
    run(MENU, XFADE_S * 1000 + 500);
    const inner = live()[0]!;
    interruptBegin!();
    inner.currentTime = MUSIC_CATALOGUE.menu.lengthS - 0.05;
    run(MENU, 10_000);
    expect(FakeInner.all.reduce((n, i) => n + i.srcHistory.length, 0)).toBe(1);
  });

  it('survives an interruption with no music playing at all', () => {
    const audio = new WeChatAudio();
    setMusicAudio(audio);
    expect(() => interruptBegin!()).not.toThrow();
    expect(() => interruptEnd!()).not.toThrow();
  });
});
