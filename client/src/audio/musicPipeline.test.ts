/**
 * The whole WEB music path, end to end: real `musicDirector` -> real `WebAudio` -> real
 * `MusicPlayer` -> real `WebMusicDeck` -> a real WebAudio-shaped graph. The only fakes are the
 * two things that cannot exist under plain-node vitest: the `AudioContext` and the `Audio`
 * element.
 *
 * WHY THIS FILE EXISTS ON TOP OF THE UNIT TESTS, which is the same argument
 * `audioPipeline.test.ts` makes for cues and a stronger one here. Music has NO fallback. A cue
 * that fails to load still sounds, because `CueMixer` drops to a procedural voice — that is what
 * made the SFX failure mode silent. Music's failure mode is silence itself, and silence is
 * exactly what the game sounded like for the whole month before this pass: `setMusicVolume` was
 * `(_v) => {}`, `assetPacks.json` already declared a `music` subpackage, both loops passed their
 * Python gate, `art/audio/README.md` documented them — and nothing played, with every test green.
 * No unit test in this repo could have failed on that, because every link existed and none of
 * them were connected.
 *
 * So the properties asserted here are the CONNECTIONS, in the order a player meets them:
 * a track reaches a real element's `src`; the level reaches the music bus and not the deck; the
 * autoplay gate opens by itself; the situation changes the file; the loop closes; a tab-away
 * holds it. Plus a source-level guard on the two lines of boot wiring nothing else can see.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { WebAudio } from '../platform/web/WebAudio';
import {
  invalidateMusicTrack,
  setMusicAudio,
  updateMusicForFrame,
  type MusicSituation,
} from '../game/musicDirector';
import { MUSIC_CATALOGUE, XFADE_S } from './musicCatalogue';
import { parseMp3 } from './mp3Frames';

// `WebAudio` reaches the asset host for both halves; music only needs the URL resolver, which on
// web is the identity function. Echoed through so a rewrite would be visible in `src`.
vi.mock('../render/assetHost', () => ({
  readBinaryAsset: vi.fn(async () => new ArrayBuffer(8)),
  resolveAssetUrl: vi.fn((path: string) => path),
}));

// ---------------------------------------------------------------------------------------
// A fake `Audio` element that behaves like a stream: `src` assignment loads, `play()` starts,
// and `currentTime` only advances while playing. The test drives the clock, because that is what
// the loop wrap is decided from.
// ---------------------------------------------------------------------------------------
class FakeAudioElement {
  static all: FakeAudioElement[] = [];
  loop = false;
  preload = '';
  private _src = '';
  currentTime = 0;
  playing = false;
  plays = 0;
  pauses = 0;
  srcHistory: string[] = [];

  constructor() {
    FakeAudioElement.all.push(this);
  }
  /** A real element reports an ABSOLUTE url back, which is why `WebMusicDeck` compares by
   *  suffix rather than by equality — replicated here or that branch is never exercised. */
  get src(): string {
    return this._src === '' ? '' : `http://localhost${this._src}`;
  }
  set src(v: string) {
    this._src = v;
    this.srcHistory.push(v);
    this.currentTime = 0;
  }
  async play(): Promise<void> {
    this.plays++;
    this.playing = true;
  }
  pause(): void {
    this.pauses++;
    this.playing = false;
  }
}

interface FakeGain {
  gain: { value: number };
  connect: ReturnType<typeof vi.fn>;
  connectedTo: unknown;
}

let ctx: FakeCtx;
type FakeCtx = ReturnType<typeof fakeCtx>;

function fakeCtx() {
  const gains: FakeGain[] = [];
  const mediaSources: { el: FakeAudioElement; connectedTo: unknown }[] = [];
  const destination = { id: 'destination' };
  const self = {
    state: 'suspended' as 'suspended' | 'running',
    destination,
    currentTime: 0,
    sampleRate: 48000,
    gains,
    mediaSources,
    resume: vi.fn(async () => {
      self.state = 'running';
    }),
    createGain: vi.fn(() => {
      const g: FakeGain = {
        gain: { value: 1 },
        connectedTo: null,
        connect: vi.fn((dest: unknown) => {
          g.connectedTo = dest;
          return dest;
        }),
      };
      gains.push(g);
      return g;
    }),
    createMediaElementSource: vi.fn((el: FakeAudioElement) => {
      const rec = { el, connectedTo: null as unknown };
      mediaSources.push(rec);
      return {
        connect: vi.fn((dest: unknown) => {
          rec.connectedTo = dest;
          return dest;
        }),
      };
    }),
    // Enough of the cue path to let `preload()`/`play()` exist without being the subject here.
    createOscillator: vi.fn(() => ({ connect: vi.fn(), frequency: { value: 0 }, start: vi.fn(), stop: vi.fn() })),
    createBufferSource: vi.fn(() => ({ connect: vi.fn(), playbackRate: { value: 1 }, start: vi.fn(), stop: vi.fn(), buffer: null })),
    createBuffer: vi.fn(() => ({ duration: 0, getChannelData: () => new Float32Array(1) })),
    createBiquadFilter: vi.fn(() => ({ connect: vi.fn(), type: 'lowpass', frequency: { value: 0 } })),
    decodeAudioData: vi.fn(async () => ({ duration: 0.1 }) as AudioBuffer),
  };
  return self;
}

/** The two long-lived music decks' gain nodes: gains[0] is the SFX bus, gains[1] the MUSIC bus,
 *  then one per deck in construction order. */
const deckGains = (): FakeGain[] => ctx.gains.slice(2);
const musicBus = (): FakeGain => ctx.gains[1]!;
const sfxBus = (): FakeGain => ctx.gains[0]!;

const FRAME_MS = 1000 / 60;
const MENU = { phase: 'menu', state: null, localOwner: 0 } satisfies MusicSituation;

/** Drive `ms` of real frames through the real director, advancing every playing element's clock
 *  like a stream would. */
function run(sit: MusicSituation, ms: number): void {
  const frames = Math.round(ms / FRAME_MS);
  for (let i = 0; i < frames; i++) {
    updateMusicForFrame(sit, FRAME_MS);
    for (const el of FakeAudioElement.all) if (el.playing) el.currentTime += FRAME_MS / 1000;
  }
}

/** Which file each element is currently streaming, for elements that are actually playing. */
function playingFiles(): string[] {
  return FakeAudioElement.all.filter((e) => e.playing).map((e) => e.srcHistory.at(-1)!);
}

let visibilityListener: (() => void) | null = null;
let hidden = false;

beforeEach(() => {
  vi.clearAllMocks();
  FakeAudioElement.all = [];
  visibilityListener = null;
  hidden = false;
  ctx = fakeCtx();
  vi.stubGlobal('AudioContext', function () {
    return ctx;
  } as unknown as typeof AudioContext);
  vi.stubGlobal('Audio', FakeAudioElement as unknown as typeof Audio);
  vi.stubGlobal('window', undefined);
  // Enough `document` for the focus handler to register — the DOM half of design/11's
  // "Focus/blur & interruption", which had never been wired on either platform.
  vi.stubGlobal('document', {
    get hidden() {
      return hidden;
    },
    addEventListener: (type: string, cb: () => void) => {
      if (type === 'visibilitychange') visibilityListener = cb;
    },
  });
});

afterEach(() => {
  setMusicAudio(null);
  vi.unstubAllGlobals();
});

/** A live backend with the autoplay gate cleared and music attached to the director. */
function bootedAudio(): WebAudio {
  const audio = new WebAudio();
  audio.resume();
  ctx.state = 'running';
  setMusicAudio(audio);
  return audio;
}

describe('the music pipeline — a frame of the real director reaches a real stream', () => {
  it('plays the shipped menu loop on the very first frame of the menu', () => {
    // The single assertion this whole pass exists for: a frame of the game, with nothing but the
    // situation as input, ends with a real element streaming a real shipped file.
    bootedAudio();
    updateMusicForFrame(MENU, FRAME_MS);
    expect(playingFiles()).toEqual([MUSIC_CATALOGUE.menu.path]);
    // And it is a file that actually exists and is really decodable audio — a path that 404s
    // would look identical to this test through a fake element otherwise. (Note what it is NOT:
    // these two loops carry no ID3v2 tag, unlike every shipped cue, so a byte-0 check copied
    // from the cue gate would be testing the wrong container.)
    const bytes = readFileSync(new URL(`../../public${MUSIC_CATALOGUE.menu.path}`, import.meta.url));
    const info = parseMp3(new Uint8Array(bytes));
    expect(info.channels).toBe(2);
    expect(info.durationMs / 1000).toBeCloseTo(MUSIC_CATALOGUE.menu.lengthS, 1)
  });

  it('builds the graph design/11 specifies: element -> deck gain -> MUSIC bus -> destination', () => {
    // Not a shape for its own sake. Every link here is a way for music to be inaudible or
    // unmixable: a deck wired to the destination bypasses the settings volume, and a deck wired
    // to the SFX bus makes the two sliders one slider.
    bootedAudio();
    updateMusicForFrame(MENU, FRAME_MS);
    expect(ctx.mediaSources).toHaveLength(2); // two long-lived decks
    const decks = deckGains();
    expect(decks).toHaveLength(2);
    for (const rec of ctx.mediaSources) expect(decks).toContain(rec.connectedTo);
    for (const g of decks) expect(g.connectedTo).toBe(musicBus());
    expect(musicBus().connectedTo).toBe(ctx.destination);
    expect(sfxBus().connectedTo).toBe(ctx.destination);
    expect(decks.some((g) => g.connectedTo === sfxBus())).toBe(false);
  });

  it('creates each deck ONCE and re-points it, never a media source per track', () => {
    // `createMediaElementSource` may be called only once per element, so a deck built per track
    // would throw on the first loop wrap — a minute into the menu, in production only.
    bootedAudio();
    run(MENU, 3000);
    run({ phase: 'playing', state: null, localOwner: 0 }, 3000); // same 'menu' answer, no change
    expect(ctx.createMediaElementSource).toHaveBeenCalledTimes(2);
    expect(FakeAudioElement.all).toHaveLength(2);
  });

  it('settles at the track gain and leaves exactly one element streaming', () => {
    bootedAudio();
    run(MENU, XFADE_S * 1000 + 500);
    expect(playingFiles()).toEqual([MUSIC_CATALOGUE.menu.path]);
    const live = deckGains().filter((g) => g.gain.value > 0);
    expect(live).toHaveLength(1);
    expect(live[0]!.gain.value).toBeCloseTo(MUSIC_CATALOGUE.menu.gain, 5);
  });
});

describe('the music pipeline — the autoplay gate', () => {
  it('plays nothing while the context is suspended, and starts by itself once it is running', () => {
    // The reason the director is a per-frame derivation rather than an event: there is no queue
    // and no retry here. The same call does nothing, then works.
    const audio = new WebAudio();
    setMusicAudio(audio);
    run(MENU, 1000);
    expect(FakeAudioElement.all.some((e) => e.playing)).toBe(false);

    audio.resume();
    ctx.state = 'running';
    run(MENU, 100);
    expect(playingFiles()).toEqual([MUSIC_CATALOGUE.menu.path]);
  });

  it('does not construct decks before anything asks for music', () => {
    // A `<audio>` element per deck allocated at construction, in a session where the player never
    // clears the gate, is two idle streams for nothing.
    new WebAudio();
    expect(FakeAudioElement.all).toHaveLength(0);
  });
});

describe('the music pipeline — the situation drives the file', () => {
  /** A minimal in-run situation whose room role the test sets. Duck-typed here on purpose: the
   *  real-`GameState` version of this decision is `musicDirector.test.ts`'s job, and what this
   *  file is about is the bytes downstream of the decision. */
  function inRun(role: 'boss' | undefined): MusicSituation {
    return {
      phase: 'playing',
      localOwner: 0,
      state: {
        phase: 'playing',
        players: [{ roomId: 'r1' }],
        dungeonRoomIndexById: new Map([['r1', 0]]),
        dungeonRooms: [{ piece: { role } }],
        dungeonConfig: { biomeId: 'ember' },
      } as never,
    };
  }

  it('crossfades menu -> dungeon -> boss -> dungeon as the player moves', () => {
    bootedAudio();
    run(MENU, XFADE_S * 1000 + 500);
    expect(playingFiles()).toEqual([MUSIC_CATALOGUE.menu.path]);

    run(inRun(undefined), XFADE_S * 1000 + 500);
    expect(playingFiles()).toEqual([MUSIC_CATALOGUE['dungeon.ember'].path]);

    run(inRun('boss'), XFADE_S * 1000 + 500);
    expect(playingFiles()).toEqual([MUSIC_CATALOGUE.boss.path]);

    run(inRun(undefined), XFADE_S * 1000 + 500);
    expect(playingFiles()).toEqual([MUSIC_CATALOGUE['dungeon.ember'].path]);
  });

  it('makes the boss room AUDIBLY different from the dungeon it is in', () => {
    // The reason `dungeon.ember` borrows `menu.mp3` and not `boss.mp3` while it has no master of
    // its own. With one file on both sides of that threshold there would be no change to hear,
    // and "the music never switches" is indistinguishable from "music is broken". This is that
    // decision pinned where it would actually break: at the moment a player crosses the door.
    bootedAudio();
    run(inRun(undefined), XFADE_S * 1000 + 500);
    const before = playingFiles()[0];
    run(inRun('boss'), XFADE_S * 1000 + 500);
    expect(playingFiles()[0]).not.toBe(before);
  });

  it('does not restart the bed while the situation stays the same', () => {
    bootedAudio();
    run(MENU, 3000);
    const srcAssignments = FakeAudioElement.all.reduce((n, e) => n + e.srcHistory.length, 0);
    const plays = FakeAudioElement.all.reduce((n, e) => n + e.plays, 0);
    run(MENU, 5000);
    expect(FakeAudioElement.all.reduce((n, e) => n + e.srcHistory.length, 0)).toBe(srcAssignments);
    expect(FakeAudioElement.all.reduce((n, e) => n + e.plays, 0)).toBe(plays);
  });
});

describe('the music pipeline — the loop closes itself', () => {
  it('crossfades into the second deck at length - XFADE_S and keeps going', () => {
    // The property the two shipped files were MEASURED for: `audit.py`'s `xfade_band_diff`
    // compares exactly this window, so a runtime that wrapped anywhere else would be judging the
    // assets against a seam nobody measured.
    bootedAudio();
    run(MENU, XFADE_S * 1000 + 500);
    const first = FakeAudioElement.all.find((e) => e.playing)!;
    first.currentTime = MUSIC_CATALOGUE.menu.lengthS - XFADE_S - 0.1;

    run(MENU, 200);
    expect(FakeAudioElement.all.filter((e) => e.playing)).toHaveLength(2); // both audible
    const second = FakeAudioElement.all.find((e) => e !== first && e.playing)!;
    expect(second.srcHistory.at(-1)).toBe(MUSIC_CATALOGUE.menu.path);
    expect(second.currentTime).toBeLessThan(0.5); // from its own beginning

    run(MENU, XFADE_S * 1000 + 200);
    expect(FakeAudioElement.all.filter((e) => e.playing)).toEqual([second]);
    expect(first.pauses).toBeGreaterThan(0);
  });

  it('never sets loop on an element', () => {
    // `el.loop = true` is the obvious implementation and the wrong one: MP3 frame padding makes
    // the wrap it performs unavailable at sample accuracy, so it clicks — and it would also fight
    // the deck the player starts for its own crossfade.
    bootedAudio();
    run(MENU, 1000);
    for (const el of FakeAudioElement.all) expect(el.loop).toBe(false);
  });
});

describe('the music pipeline — the settings slider that went nowhere', () => {
  it('lands the music volume on the music bus, leaving SFX and the fades alone', () => {
    // This is the bug in one assertion. `setMusicVolume` was `(_v) => {}` in both backends, so
    // `settingsBinding` computed the value correctly and handed it to nothing.
    const audio = bootedAudio();
    run(MENU, XFADE_S * 1000 + 500);
    audio.setSfxVolume(0.9);
    audio.setMusicVolume(0.25);
    expect(musicBus().gain.value).toBe(0.25);
    expect(sfxBus().gain.value).toBe(0.9);
    // The deck level is the crossfade, NOT the volume: applying the setting there would make the
    // next fade overwrite it two seconds later.
    const live = deckGains().filter((g) => g.gain.value > 0);
    expect(live[0]!.gain.value).toBeCloseTo(MUSIC_CATALOGUE.menu.gain, 5);
  });

  it('applies a volume set BEFORE the context exists', () => {
    // `settingsBinding.load()` runs at boot, before any gesture — the exact shape of the bug
    // where a setting applies on change but not at load.
    const audio = new WebAudio();
    audio.setMusicVolume(0.3);
    setMusicAudio(audio);
    audio.resume();
    ctx.state = 'running';
    run(MENU, 100);
    expect(musicBus().gain.value).toBe(0.3);
  });

  it('clamps out of range and survives having no context at all', () => {
    const audio = new WebAudio();
    expect(() => audio.setMusicVolume(5)).not.toThrow();
    expect(() => audio.setMusicVolume(-1)).not.toThrow();
    setMusicAudio(audio);
    audio.resume();
    ctx.state = 'running';
    audio.setMusicVolume(5);
    run(MENU, 100);
    expect(musicBus().gain.value).toBe(1);
  });

  it('a muted bus still runs the player — silence is a gain, not a stop', () => {
    // `effectiveVolume` returns 0 when muted (design/10). If mute stopped the decks, unmuting
    // would restart the bed from the top instead of revealing where it had got to.
    const audio = bootedAudio();
    audio.setMusicVolume(0);
    run(MENU, XFADE_S * 1000 + 500);
    expect(FakeAudioElement.all.filter((e) => e.playing)).toHaveLength(1);
    expect(musicBus().gain.value).toBe(0);
  });
});

describe('the music pipeline — losing focus', () => {
  it('holds the bed on visibilitychange and resumes it mid-stream', () => {
    bootedAudio();
    run(MENU, XFADE_S * 1000 + 500);
    const live = FakeAudioElement.all.find((e) => e.playing)!;
    expect(visibilityListener, 'no visibilitychange listener was registered').not.toBe(null);

    hidden = true;
    visibilityListener!();
    expect(live.playing).toBe(false);
    const at = live.currentTime;

    hidden = false;
    visibilityListener!();
    expect(live.playing).toBe(true);
    // Held, not restarted: the position survives, so a tab-away and back does not replay the
    // opening bar.
    expect(live.currentTime).toBe(at);
    expect(live.srcHistory).toHaveLength(1);
    // And ONLY the deck that was playing comes back. The other one is stopped, not paused — it
    // sits that way for all but 2 s of every minute — so a resume that ignored which deck was
    // live would start a second stream on top of the bed, at whatever level its last crossfade
    // left it. Both decks audible is the loudest possible way for this to be wrong, and it was
    // invisible until this line existed.
    expect(FakeAudioElement.all.filter((e) => e.playing)).toEqual([live]);
  });

  it('does not wrap on evidence gathered while hidden', () => {
    // A deck held ON the wrap point would otherwise fire the instant it was released, having
    // decided so from a position that stood still for however long the tab was away.
    bootedAudio();
    run(MENU, XFADE_S * 1000 + 500);
    const live = FakeAudioElement.all.find((e) => e.playing)!;
    hidden = true;
    visibilityListener!();
    live.currentTime = MUSIC_CATALOGUE.menu.lengthS - 0.05;
    run(MENU, 10_000);
    expect(FakeAudioElement.all.filter((e) => e.playing)).toHaveLength(0);
    expect(FakeAudioElement.all.reduce((n, e) => n + e.srcHistory.length, 0)).toBe(1);
  });
});

describe('the music pipeline — the invalidate the phased boot pushes', () => {
  // `WebAudio.invalidateMusic` had NO test on either platform until this one. Every
  // `invalidateMusic` under test was a hand-written fake (`GameLoop.test.ts`'s recording bus,
  // `musicDirector.test.ts`'s sink), so the suite knew the phased boot CALLS it
  // (`render/preloadArt.ts`, when the background `music` pack lands) and knew `MusicPlayer`
  // FORGETS its track when asked — and nothing joined the two. An empty body on this one method
  // survived the whole suite, which is commit 8cf60e2's failure shape exactly: every piece
  // passing its own check, and the game silent.
  //
  // Reached through `invalidateMusicTrack()` rather than the method directly, because the module
  // sink is what the real caller holds.

  it('re-points a deck that had been handed a path with no file behind it yet', () => {
    // The case design/12 records: on web the `music` pack is a background download, so a deck
    // can be pointed at a URL that 404s while this player goes on believing the track is live.
    // (What does NOT change is `src`: the deck rewinds instead of re-assigning an identical url
    // — `webMusicDeck.ts` avoids re-downloading a megabyte once a minute — so the observable
    // re-point is a second `play()` on a stream that had been stopped.)
    bootedAudio();
    run(MENU, 1000);
    const el = FakeAudioElement.all.find((e) => e.playing)!;
    expect(el.plays).toBe(1);

    invalidateMusicTrack();
    expect(playingFiles(), 'the invalidate never reached the deck').toEqual([]);

    run(MENU, 100);
    // The same two long-lived decks — an invalidate that rebuilt them would throw on the next
    // `createMediaElementSource` for the same element.
    expect(FakeAudioElement.all).toHaveLength(2);
    expect(playingFiles()).toEqual([MUSIC_CATALOGUE.menu.path]);
    expect(el.plays).toBe(2);
    expect(el.currentTime).toBeLessThan(0.5); // from the top of the file, not where it had got to
  });

  it('is harmless before the context or the decks exist', () => {
    // The real ordering on web has no guarantee: a small `music` pack can land before the player
    // has ever cleared the autoplay gate, so this call arrives with no player built at all.
    const audio = new WebAudio();
    setMusicAudio(audio);
    expect(() => invalidateMusicTrack()).not.toThrow();
    expect(FakeAudioElement.all).toHaveLength(0);
    // ...and the frame after the gate opens still starts the bed.
    audio.resume();
    ctx.state = 'running';
    run(MENU, 100);
    expect(playingFiles()).toEqual([MUSIC_CATALOGUE.menu.path]);
  });
});

describe('the music pipeline — the boot wiring', () => {
  // SOURCE-level guards, deliberately, and for the reason `audioPipeline.test.ts` records for
  // `preload`: every test above attaches the sink itself, so deleting that one line from the
  // entries would leave the whole suite green and the game silent. Both entries are top-level
  // `boot()` scripts with no seam, and inventing one to hold a single line would be worse than
  // reading it.
  const src = (name: string): string =>
    readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

  it('every entry attaches music to the same device the cues use', () => {
    for (const name of ['main.ts', 'main.wechat.ts', 'main.crazygames.ts']) {
      expect(src(name), `${name} never calls setMusicAudio(audio)`).toMatch(
        /setMusicAudio\(audio\)/,
      );
    }
  });

  it('the WeChat entry attaches music AFTER installing its asset host', () => {
    // Ordering with teeth, the same one the SFX preload has: the host swap is what turns
    // '/audio/music/menu.mp3' into the packed subpackage path that runtime can read at all.
    const s = src('main.wechat.ts');
    expect(s.indexOf('setMusicAudio(audio)')).toBeGreaterThan(
      s.indexOf('setAssetHost(weChatAssetHost)'),
    );
  });

  it('the main loop drives music every frame, in every phase', () => {
    // The behavioural version of this lives in `GameLoop.test.ts` (which owns the fakes). What is
    // read here is the one thing that test cannot see: that the call sits BEFORE the
    // playing/paused/idle branch, so the menu bed is driven at all.
    const loop = readFileSync(
      new URL('../game/controllers/GameLoop.ts', import.meta.url),
      'utf8',
    );
    const call = loop.indexOf('updateMusicForFrame(');
    const branch = loop.indexOf("if (phase === 'playing')");
    expect(call, 'GameLoop never calls updateMusicForFrame').toBeGreaterThan(-1);
    expect(call, 'the music tick is inside a phase branch').toBeLessThan(branch);
  });
});
