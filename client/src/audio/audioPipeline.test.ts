/**
 * The whole audio path, end to end, from a `GameEvent` to a buffer source: real
 * `EventReactor` → real `WebAudio` → real `CueMixer`/`SampleBank`/`VoiceBudget`/catalogue.
 * The only fakes are the ones that cannot exist under plain-node vitest — the `AudioContext`
 * and the asset host's byte read.
 *
 * Why this file exists on top of the per-unit tests. Every link here is already covered
 * individually, and that is exactly the problem: the failure this pass was built to end is
 * *silent*. Delete the preload call, drift a catalogue path, break the sample branch, and the
 * game keeps making noise — the synth voices carry it — while the shipped files quietly
 * stop being used. No unit test fails, and nobody hears the difference without knowing what
 * to listen for. This file asserts the property no unit owns: **that a real frame of engine
 * events reaches the SHIPPED samples and not the fallback.** It is the automated form of the
 * browser measurement recorded in design/11's status block (27 sample voices, 0 synth).
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { GameEvent, GameState } from '@dd/engine';
import { EventReactor, type EventReactorHost } from '../game/controllers/EventReactor';
import type { FxController } from '../game/fx/FxController';
import { HudView } from '../game/ui/HudView';
import { Layers } from '../game/scene/layers';
import { WebAudio } from '../platform/web/WebAudio';
import { Button } from '../game/ui/widgets';
import { setUiAudio, playUiCue, type UiCue } from './uiSound';
import { DEFAULT_CAP, coalesceBoost } from './CueMixer';
import { ALL_CUES, CUE_CATALOGUE, variantPaths } from './cueCatalogue';
import type { AudioCue } from '../platform/types';

// Bytes come from the asset host, which is a `fetch` on web. The path is echoed back through
// the fake decoder so every voice can be traced to the exact variant file that produced it.
vi.mock('../render/assetHost', () => ({
  readBinaryAsset: vi.fn(async (path: string) => {
    const bytes = new ArrayBuffer(8);
    PATH_OF.set(bytes, path);
    return bytes;
  }),
}));
const PATH_OF = new Map<ArrayBuffer, string>();

/** A decoded buffer that remembers the file it came from — undefined means "synthesised". */
type Decoded = AudioBuffer & { fromPath?: string };

// ---------------------------------------------------------------------------------------
// A WebAudio-API-shaped fake, complete enough for BOTH paths: the sample path (buffer
// source) and the real `audioSynth` voices (oscillators, noise buffers, filters). `playCue`
// is deliberately NOT mocked here — telling the two paths apart is the point of the file.
// ---------------------------------------------------------------------------------------
function param(value = 0) {
  return { value, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() };
}
const node = () => ({ connect: vi.fn((dest: unknown) => dest) });

interface Played {
  buffer: Decoded | null;
  /** Cut short by the voice cap (CueMixer.steal). A sample that plays out never stops. */
  stopped: boolean;
}

let ctx: FakeCtx;
type FakeCtx = ReturnType<typeof fakeCtx>;

function fakeCtx() {
  const played: Played[] = [];
  const oscillators: unknown[] = [];
  const gains: ReturnType<typeof param>[] = [];
  return {
    state: 'suspended' as 'suspended' | 'running',
    destination: {},
    currentTime: 0,
    sampleRate: 44100,
    played,
    oscillators,
    gains,
    resume: vi.fn(async function (this: FakeCtx) {
      this.state = 'running';
    }),
    createGain: vi.fn(() => {
      const g = { ...node(), gain: param(1) };
      gains.push(g.gain);
      return g;
    }),
    createOscillator: vi.fn(() => {
      const o = { ...node(), type: 'sine', frequency: param(), start: vi.fn(), stop: vi.fn() };
      oscillators.push(o);
      return o;
    }),
    createBufferSource: vi.fn(() => {
      const rec: Played = { buffer: null, stopped: false };
      return {
        ...node(),
        playbackRate: { value: 1 },
        start: vi.fn(() => played.push(rec)),
        stop: vi.fn(() => { rec.stopped = true; }),
        set buffer(b: Decoded | null) {
          rec.buffer = b;
        },
        get buffer() {
          return rec.buffer;
        },
      };
    }),
    // The synth's noise burst builds its own buffer — untagged, which is what distinguishes
    // a synthesised voice from a decoded sample below.
    createBuffer: vi.fn((_c: number, length: number) => ({
      duration: length / 44100,
      getChannelData: () => new Float32Array(length),
    })),
    createBiquadFilter: vi.fn(() => ({ ...node(), type: 'lowpass', frequency: { value: 0 } })),
    decodeAudioData: vi.fn(async (data: ArrayBuffer) => {
      const path = PATH_OF.get(data);
      return { duration: 0.12, fromPath: path } as Decoded;
    }),
  };
}

// ---- the rest of the render shell EventReactor talks to (same fakes as its own test) ----
function fakeFx(): FxController {
  return {
    flash: vi.fn(),
    muzzleFlare: vi.fn(),
    addShake: vi.fn(),
    addHitStop: vi.fn(),
    pulseChromatic: vi.fn(),
    particles: {
      muzzleFlame: vi.fn(), shellCasing: vi.fn(), explosionDebris: vi.fn(), shieldShards: vi.fn(),
    },
  } as unknown as FxController;
}

function fakeHost(): EventReactorHost {
  return {
    localOwner: 0,
    activeState: () => ({ players: [{ id: 1, gx: 0, gy: 0 }] } as unknown as GameState),
    addScore: vi.fn(),
    onRoomEnter: vi.fn(),
    onDoorStateChange: vi.fn(),
    onForceRegroup: vi.fn(),
    onWeaponPickup: vi.fn(),
    actorAt: vi.fn(() => undefined),
  };
}

/** A live shell with the SFX set preloaded and the autoplay gate cleared. */
async function bootedShell() {
  const audio = new WebAudio();
  await audio.preload();
  audio.resume();
  await Promise.resolve();
  const hud = new HudView();
  hud.build(new Layers(), { w: 1280, h: 720 });
  return { audio, reactor: new EventReactor(fakeFx(), hud, audio, fakeHost()) };
}

/** Which cue each voice played this frame: the sample's file → its cue, or null for synth. */
function voices(): (AudioCue | null)[] {
  return ctx.played.map((p) => {
    const path = p.buffer?.fromPath;
    if (!path) return null;
    return ALL_CUES.find((cue) => variantPaths(cue).includes(path)) ?? null;
  });
}

const EVENTS: Record<string, GameEvent> = {
  muzzle: { type: 'bullet_fired', gx: 0, gy: 0, facing: 0 } as GameEvent,
  impact: { type: 'hit', target: 7, faction: 'enemy', gx: 0, gy: 0, damage: 1, damageType: 'physical' } as GameEvent,
  deflect: { type: 'deflect', gx: 0, gy: 0 } as GameEvent,
  clash: { type: 'clash', gx: 0, gy: 0 } as GameEvent,
  'shield.break': { type: 'shield_break', gx: 0, gy: 0 } as GameEvent,
  'status.burn': { type: 'status', effect: 'burn', gx: 0, gy: 0 } as GameEvent,
  'status.chill': { type: 'status', effect: 'chill', gx: 0, gy: 0 } as GameEvent,
  'status.shock': { type: 'status', effect: 'shock', gx: 0, gy: 0 } as GameEvent,
  'status.poison': { type: 'status', effect: 'poison', gx: 0, gy: 0 } as GameEvent,
  swing: { type: 'melee_swing', ownerId: 3, gx: 0, gy: 0, facing: 0 } as GameEvent,
  // A SECOND `hit`, aimed at the local seat (`fakeHost` seats it as id 1) where the `impact`
  // fixture above is aimed at somebody else. Both produce `impact`; only this one also
  // produces `hurt`, which is the whole gate on that cue and the reason the two fixtures
  // cannot be one.
  hurt: { type: 'hit', target: 1, faction: 'enemy', gx: 0, gy: 0, damage: 1, damageType: 'physical' } as GameEvent,
  'death.enemy': { type: 'death', id: 9, faction: 'enemy', gx: 0, gy: 0, r: 480 } as GameEvent,
  'death.player': { type: 'death', id: 1, faction: 'player', gx: 0, gy: 0, r: 480 } as GameEvent,
  'pickup.heal': { type: 'pickup', kind: 'heal', gx: 0, gy: 0 } as GameEvent,
  'pickup.weapon': { type: 'pickup', kind: 'weapon', weaponId: 'repeater', gx: 0, gy: 0 } as GameEvent,
  'pickup.material': { type: 'pickup', kind: 'material', materialId: 'mat_fire', qty: 1, gx: 0, gy: 0 } as GameEvent,
  'pickup.buff': { type: 'pickup', kind: 'buff', buffId: 'dmg_up', gx: 0, gy: 0 } as GameEvent,
  'wave-clear': { type: 'wave_clear' } as GameEvent,
  // `winner` is not decoration: `EventReactor` plays the jingle only for a win the LOCAL
  // seat's side took, and the run-ending fall otherwise (2026-09-02). This host's state has
  // no `zoneEnabled`, so it is a PvE run, where anything but `'enemies'` is the party's win.
  win: { type: 'win', winner: 0 } as GameEvent,
};

/** The cues an ENGINE event can produce: exactly the keys of `EVENTS` above.
 *
 *  The `ui.*` cues are not here and must not be. They are fired by the screen layer
 *  (`audio/uiSound.ts`) in response to the player's own finger, have no `GameEvent` at all,
 *  and so cannot appear in any frame this file consumes — which is why every assertion below
 *  that used to range over `ALL_CUES` now ranges over this. The exhaustiveness test right
 *  after it is what keeps that from turning into silently reduced coverage: a NEW engine cue
 *  with no fixture event here would otherwise just quietly not be exercised. */
const ENGINE_CUES = Object.keys(EVENTS) as AudioCue[];
const UI_CUES = ALL_CUES.filter((c) => c.startsWith('ui.'));
/** The third origin, and the only member of it: `spawn` is driven by a `GameState` DIFF that
 *  `Scene` computes, not by any event, so it reaches the reactor as a count argument and can
 *  never appear in `EVENTS`. It is listed rather than inferred so the exhaustiveness case
 *  below still fails on a new cue that belongs to no origin at all. */
const DIFF_CUES: AudioCue[] = ['spawn'];

beforeEach(() => {
  vi.clearAllMocks();
  PATH_OF.clear();
  ctx = fakeCtx();
  vi.stubGlobal('AudioContext', function () { return ctx; } as unknown as typeof AudioContext);
  vi.stubGlobal('window', undefined);
});

describe('the audio pipeline — a real frame of events reaches the SHIPPED samples', () => {
  it('has a fixture event for every cue an engine event can fire', () => {
    // Guards the fixture, not the code. Every cue is either engine-driven (and needs an
    // event here, or the coverage below shrinks without failing) or a UI cue (and cannot
    // have one). Nothing may be in neither set.
    expect([...ENGINE_CUES, ...UI_CUES, ...DIFF_CUES].sort()).toEqual([...ALL_CUES].sort());
    expect(ENGINE_CUES.some((c) => c.startsWith('ui.'))).toBe(false);
    // A diff-driven cue must not also have a fixture event, or the origin split is a fiction.
    expect(DIFF_CUES.some((c) => ENGINE_CUES.includes(c))).toBe(false);
  });

  it('plays a decoded file for every cue that has one, and the synth voice only for the one that does not', async () => {
    // The whole point of the pass, as one assertion. `status.burn` is the single deliberate
    // synth keep (no fire crackle exists in any of the six CC0 packs, `credits.json`), so a
    // frame containing every engine cue must produce a sampled voice for each and exactly one
    // synthesised. (`spawn` is absent here by construction — it has no event; the case below
    // is its counterpart.)
    const { reactor } = await bootedShell();
    reactor.consume(Object.values(EVENTS));
    const sampled = voices().filter((c): c is AudioCue => c !== null);
    expect(new Set(sampled)).toEqual(new Set(ENGINE_CUES.filter((c) => CUE_CATALOGUE[c].variants > 0)));
    expect(ctx.oscillators).toHaveLength(0); // nothing pitched was synthesised...
    // ...and the one synth voice that DID play is `status.burn`'s noise burst: a buffer this
    // context built itself rather than one the decoder returned.
    expect(ctx.createBuffer).toHaveBeenCalledTimes(1);
  });

  it('a spawn count reaches the SHIPPED spawn samples, with no event to carry it', async () => {
    // The one cue whose whole path is a number rather than an event, end to end: a count from
    // `Scene` through the reactor's coalescing map, the catalogue, the bank and the mixer, out
    // as a decoded `/audio/spawn_NN.mp3`. Nothing about it can be exercised by the all-cues
    // frame above, because there is no `GameEvent` to put in that frame.
    const { reactor } = await bootedShell();
    reactor.consume([], 9);
    expect(voices()).toEqual(['spawn']);       // one voice, not nine
    expect(ctx.oscillators).toHaveLength(0);   // and it is the sample, not the synth voice
    // Nine coalesced into one is a gain decision, and this is the only place it is visible for
    // this cue: catalogue gain 1.0 x the log-shaped boost, capped.
    expect(ctx.gains.at(-1)!.value).toBeCloseTo(coalesceBoost(9));
  });

  it('a DEFEAT reaches the shipped death-player file, not a synth voice', async () => {
    // `win` is the only event whose cue depends on the STATE as well as on the event
    // (design/11, `localSeatWon`), so it is the only one the all-cues frame above cannot cover
    // in both directions — that frame's fixture is a win. `fakeHost` seats us at owner 0 in a
    // state with no `zoneEnabled`, i.e. a PvE run, where `'enemies'` is the party's loss.
    //
    // What this adds over the unit gate: the losing branch resolves to a real decoded
    // `/audio/death-player_NN.mp3` through the catalogue, bank and mixer instead of quietly
    // falling through to a synth voice. `death.player` and `win` are peers at the top of the
    // ladder (118 and 120), so a defeat is no more stealable than a victory, and neither of
    // them should ever be the cue that gets synthesised.
    const { reactor } = await bootedShell();
    reactor.consume([{ type: 'win', winner: 'enemies' } as GameEvent]);
    expect(voices()).toEqual(['death.player']);
    expect(ctx.oscillators).toHaveLength(0);
  });

  it('...and a win the local side took still reaches the jingle', async () => {
    // The other half, on the same path: the pair is the assertion, since a branch stuck on
    // either answer would pass one of these two cases on its own.
    const { reactor } = await bootedShell();
    reactor.consume([{ type: 'win', winner: 0 } as GameEvent]);
    expect(voices()).toEqual(['win']);
    expect(ctx.oscillators).toHaveLength(0);
  });

  it('a firing burst plays samples only — no cue silently falls back', async () => {
    // The automated form of the browser measurement in design/11 (27 sample voices, 0 synth).
    const { reactor } = await bootedShell();
    for (let frame = 0; frame < 20; frame++) {
      ctx.currentTime = frame * 0.033; // ~30 Hz, so voices retire between frames
      reactor.consume([EVENTS.muzzle!, EVENTS.impact!]);
    }
    const v = voices();
    expect(v.length).toBeGreaterThanOrEqual(20);
    expect(v.filter((c) => c === null)).toEqual([]); // not one synthesised voice
    expect(new Set(v)).toEqual(new Set(['muzzle', 'impact']));
  });

  it('never repeats a variant back-to-back over a long burst', async () => {
    // Variant choice is unit-tested with an injected RNG; here it runs on the real
    // `Math.random`, which is the version that actually ships.
    const { reactor } = await bootedShell();
    for (let frame = 0; frame < 60; frame++) {
      ctx.currentTime = frame * 0.033;
      reactor.consume([EVENTS.impact!]);
    }
    const paths = ctx.played.map((p) => p.buffer?.fromPath);
    expect(paths.length).toBeGreaterThan(40);
    for (let i = 1; i < paths.length; i++) expect(paths[i]).not.toBe(paths[i - 1]);
  });

  it('turns a repeated event into ONE voice at a higher gain', async () => {
    const { reactor } = await bootedShell();
    reactor.consume(Array.from({ length: 10 }, () => EVENTS.impact!));
    expect(ctx.played).toHaveLength(1);
    // impact's catalogue gain is 1.0, so the voice gain IS the coalesce boost: ×1.5 capped.
    expect(ctx.gains.at(-1)!.value).toBeCloseTo(1.5);
  });
});

describe('the audio pipeline — a frame that asks for more than the voice cap', () => {
  /** Cues whose voice was cut short by the cap (CueMixer.steal), and cues left intact. */
  function stolenAndKept() {
    const v = voices();
    const stolen = new Set<AudioCue>();
    const kept = new Set<AudioCue>();
    ctx.played.forEach((rec, i) => {
      const cue = v[i];
      if (cue) (rec.stopped ? stolen : kept).add(cue);
    });
    return { stolen, kept };
  }

  it('sacrifices only expendable voices when a frame saturates the cap', async () => {
    // Every engine cue in one frame exceeds the 12-voice cap, so something must give — and
    // what gives is worth pinning, because the mechanism is not the obvious one. Over the cap
    // a higher-priority cue does NOT get refused: it STEALS the weakest slot, so every cue
    // still starts, and the loser is faded out 12 ms in. So the assertion is about which
    // voices got cut, not which never played (the first version of this test asserted
    // "12 played" and was wrong about the design, not the code).
    const { reactor } = await bootedShell();
    reactor.consume(Object.values(EVENTS));
    const { stolen, kept } = stolenAndKept();

    // Exactly the overflow is cut short, and the cut is a clean slice down the ladder:
    // every sacrificed cue ranks BELOW every surviving one. Both numbers are derived, because
    // the literal 3 this case used to carry stopped being true the moment the cue set grew,
    // while neither thing it was actually testing changed.
    const sampledCues = ENGINE_CUES.filter((c) => CUE_CATALOGUE[c].variants > 0);
    expect(stolen.size).toBe(sampledCues.length - DEFAULT_CAP);
    const worstKept = Math.min(...[...kept].map((c) => CUE_CATALOGUE[c].priority));
    for (const cue of stolen) {
      expect(CUE_CATALOGUE[cue].priority, `${cue} was cut short`).toBeLessThan(worstKept);
    }
    expect(stolen.has('muzzle')).toBe(true); // fires on every shot — the first to go
    expect(stolen.has('clash')).toBe(true);
    expect(stolen.has('swing')).toBe(true);  // the melee `muzzle`, and just as expendable
    for (const cue of ENGINE_CUES) {
      if (CUE_CATALOGUE[cue].priority > 50 && CUE_CATALOGUE[cue].variants > 0) {
        expect(kept.has(cue), `${cue} (priority ${CUE_CATALOGUE[cue].priority}) lost its slot`).toBe(true);
      }
    }
  });

  it('never sacrifices the once-per-run stingers', async () => {
    const { reactor } = await bootedShell();
    reactor.consume(Object.values(EVENTS));
    const { kept } = stolenAndKept();
    expect(kept.has('win')).toBe(true);
    expect(kept.has('deflect')).toBe(true); // the signature parry (design/03/05)
  });

  it('lets a button press in even when a full frame has just saturated the cap', async () => {
    // The rank the catalogue gives the UI cues (110, above every combat cue) is only visible
    // here. A press the player made is not allowed to be the voice the cap drops — a silent
    // button reads as a missed input, where a dropped `muzzle` reads as nothing at all. The
    // contrast with the case below is the whole assertion: at the SAME instant, on the SAME
    // full cap, `muzzle` is refused and `ui.tap` is admitted by stealing.
    const { audio, reactor } = await bootedShell();
    setUiAudio(audio);
    try {
      reactor.consume(Object.values(EVENTS)); // fills the cap at currentTime 0
      const before = ctx.played.length;
      playUiCue('ui.tap');
      expect(ctx.played).toHaveLength(before + 1);
      expect(voices().at(-1)).toBe('ui.tap');
      // ...and what it displaced came from the bottom of the ladder, not from the top.
      const stolen = voices().filter((cue, i) => cue !== null && ctx.played[i]!.stopped);
      for (const cue of stolen) {
        expect(CUE_CATALOGUE[cue!].priority, `${cue} was cut short`).toBeLessThan(110);
      }
    } finally {
      setUiAudio(null);
    }
  });

  it('refuses a low-priority cue outright when a catch-up frame re-saturates the cap', async () => {
    // design/08's catch-up render frame runs several sim steps at ONE wall-clock instant, so
    // the cap can be full with nothing yet retired. A cue that outranks nothing is then
    // refused rather than stolen-into — the branch the steal path above never reaches.
    const { reactor } = await bootedShell();
    reactor.consume(Object.values(EVENTS)); // fills the cap at currentTime 0
    const before = ctx.played.length;
    reactor.consume([EVENTS.muzzle!]); // same instant, weakest priority in the table
    expect(ctx.played).toHaveLength(before);
  });
});

describe('the audio pipeline — a UI press reaches the shipped files too', () => {
  // The UI cues arrive by a different road than everything above: no `GameEvent`, no
  // `EventReactor` — a Pixi `pointertap` on a real widget, through `uiSound`'s module sink,
  // into the same backend and mixer. That road has the same silent failure mode (a wrong path
  // or a missing file is indistinguishable from "the synth voice is what plays"), so it gets
  // the same end-to-end assertion: a real Button press must produce a DECODED voice from
  // `/audio/ui-tap_00.mp3`, not an oscillator.
  afterEach(() => setUiAudio(null));

  it('plays the decoded ui.tap file when a real Button is pressed', async () => {
    const { audio } = await bootedShell();
    setUiAudio(audio);
    const btn = new Button('PLAY', { w: 100, h: 40 });
    (btn.view as unknown as { emit: (e: string) => void }).emit('pointertap');
    expect(voices()).toEqual(['ui.tap']);
    expect(ctx.oscillators).toHaveLength(0); // nothing fell back to the synth voice
    expect(ctx.played[0]!.buffer!.fromPath).toBe('/audio/ui-tap_00.mp3');
  });

  it('plays each ui.* cue from its own file — none of them share one', async () => {
    // Four cues, four files, no overlap: a copy-paste in the catalogue's stem rule would
    // otherwise give two different presses the same sound and pass every other test.
    const { audio } = await bootedShell();
    setUiAudio(audio);
    for (const cue of UI_CUES) playUiCue(cue as UiCue);
    expect(voices()).toEqual(UI_CUES);
    expect(new Set(ctx.played.map((p) => p.buffer!.fromPath)).size).toBe(UI_CUES.length);
    expect(ctx.oscillators).toHaveLength(0);
  });

  it('a UI press clears the autoplay gate on a backend nothing else has resumed', async () => {
    // WeChat has no window listeners (WebAudio's constructor registers them; WeChatAudio
    // cannot), so before this the first sound of a mini-game session waited for a
    // `Game.confirm()`. `bootedShell` resumes by hand — this one deliberately does not.
    const audio = new WebAudio();
    await audio.preload();
    setUiAudio(audio);
    expect(ctx.resume).not.toHaveBeenCalled();
    playUiCue('ui.tap');
    expect(ctx.resume).toHaveBeenCalled();
  });

  it('a UI press does not disturb the engine cue path', async () => {
    // Both roads share one mixer and one voice budget. A press mid-fight must add a voice,
    // not steal or reorder the combat ones.
    const { audio, reactor } = await bootedShell();
    setUiAudio(audio);
    reactor.consume([EVENTS.impact!, EVENTS.deflect!]);
    playUiCue('ui.tap');
    expect(voices()).toEqual(['impact', 'deflect', 'ui.tap']);
    expect(ctx.played.filter((p) => p.stopped)).toEqual([]);
  });
});

describe('the audio pipeline — degrading', () => {
  it('keeps playing the synth voices when the whole set fails to load', async () => {
    const { readBinaryAsset } = await import('../render/assetHost');
    (readBinaryAsset as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('offline'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { reactor } = await bootedShell();
    reactor.consume([EVENTS.muzzle!, EVENTS.deflect!]);
    expect(voices().filter((c) => c !== null)).toEqual([]); // no samples...
    expect(ctx.oscillators.length).toBeGreaterThan(0); // ...but the game is not silent
    warn.mockRestore();
  });

  it('plays samples for the cues that DID load and synth for the ones that did not', async () => {
    const { readBinaryAsset } = await import('../render/assetHost');
    (readBinaryAsset as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) => {
      if (path.startsWith('/audio/deflect')) throw new Error('404');
      const bytes = new ArrayBuffer(8);
      PATH_OF.set(bytes, path);
      return bytes;
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { reactor } = await bootedShell();
    reactor.consume([EVENTS.impact!, EVENTS.deflect!]);
    expect(voices()).toEqual(['impact']); // deflect has no sample left...
    expect(ctx.oscillators.length).toBeGreaterThan(0); // ...so its synth ping played instead
    warn.mockRestore();
  });
});

describe('the audio pipeline — the boot wiring', () => {
  // A SOURCE-level guard, and deliberately so. Every test above constructs the backend and
  // calls `preload()` itself, so deleting that call from the entry points would leave the
  // whole suite green while the shipped set stopped loading in the actual game — the exact
  // silent failure this module exists to end. Both entries are top-level `boot()` scripts
  // with no seam to test through, and inventing one to hold two lines would be worse than
  // reading them.
  const entry = (name: string): string =>
    readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

  it('every entry preloads the SFX set', () => {
    for (const name of ['main.ts', 'main.wechat.ts', 'main.crazygames.ts']) {
      expect(entry(name), `${name} never calls audio.preload()`).toMatch(/audio\.preload\(\)/);
    }
  });

  it('every entry attaches the UI cue sink to that same device', () => {
    // Same class of guard, and the same reason: `uiSound`'s sink is module state, so a boot
    // that never attaches it leaves every button in the game silent while every unit test
    // that installs its own fake bus still passes. Nothing else in the suite can see this
    // line, because nothing else runs `boot()`.
    for (const name of ['main.ts', 'main.wechat.ts', 'main.crazygames.ts']) {
      expect(entry(name), `${name} never calls setUiAudio(audio)`).toMatch(/setUiAudio\(audio\)/);
    }
  });

  it('no entry AWAITS it — boot must not block on audio', () => {
    // 95 kB behind the first frame would be a bad trade: every cue has a procedural voice to
    // fall back on while it lands (design/11), so the call is fire-and-forget by design.
    for (const name of ['main.ts', 'main.wechat.ts', 'main.crazygames.ts']) {
      expect(entry(name)).not.toMatch(/await\s+audio\.preload\(\)/);
    }
  });

  it('the WeChat entry preloads AFTER installing its asset host', () => {
    // Ordering with teeth: the host swap is what turns '/audio/impact_00.mp3' into a path that
    // runtime can read at all. Reversed, every read fails and the mini-game runs on synth
    // voices — audibly fine, silently wrong.
    const src = entry('main.wechat.ts');
    const host = src.indexOf('setAssetHost(weChatAssetHost)');
    const preload = src.indexOf('audio.preload()');
    expect(host).toBeGreaterThan(-1);
    expect(preload).toBeGreaterThan(host);
  });
});
