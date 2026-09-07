/**
 * The TWO-PHASE boot, driven end to end against a WeChat-shaped runtime (design/12, "the first
 * download is code only").
 *
 * `wechatAssetLoad.test.ts` proves that every shipped asset can load on this platform, through
 * the all-at-once `preloadCoreArt()`. It cannot see the thing that changed on 2026-09-01,
 * because there every pack is fetched before anything is asked of it: what a phased boot adds
 * is a WINDOW during which the lobby is live and the run art is not, and every claim about that
 * window is a claim about ORDER.
 *
 * The fake runtime is what makes order observable: a path inside a subpackage that
 * `wx.loadSubpackage` has not been called for names no file, exactly as on the device. So
 * "the UI is dressed and the rigs are not" is not asserted by reading a flag — it is the
 * consequence of only one pack having been fetched, and it would fail if `preloadLobbyArt`
 * quietly loaded everything.
 *
 * What this therefore pins:
 *   - phase one fetches the `lobby` pack and NOTHING else, and every UI texture resolves after
 *     it while every rig/weapon/biome/environment texture does not;
 *   - the run gate's `ensureRunArt()` fetches every `run`-phase pack and fills in every
 *     remaining loader — i.e. re-running a loader after its pack lands really does work, which
 *     is the property the whole design rests on;
 *   - `music` is fetched without anything awaiting it, and its arrival invalidates the music
 *     director's memo (the deck cannot retry a path whose pack was missing);
 *   - nothing is fetched twice, however many gates ask.
 *
 * What it cannot pin is everything `wechatRuntimeFake.ts`'s header lists — base-library
 * behaviour, and the GL upload. This is a strong regression net for the ORDERING, which is the
 * part that is cheap to get wrong and invisible when you do.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import type { AudioBus, MusicTrack } from '../platform/types';
import { setMusicAudio } from '../game/musicDirector';
import { packsForPhase, SUBPACKS } from './assetManifest';
import { installWeChatRuntimeFake, type WeChatRuntimeFake } from './wechatRuntimeFake';
import {
  beginDeferredArt,
  ensureRunArt,
  isRunArtReady,
  preloadLobbyArt,
  resetPreloadArt,
  runArtUnitCount,
  CHAR_BUNDLES,
} from './preloadArt';
import { getRigSkin } from './skinRegistry';
import { getFloorTexture } from './biomeTiles';
import { UI_ASSETS, getUiTexture } from './uiSkins';
import { getDoorCurtainTexture } from './environmentSprites';
import { getWeaponTexture } from './weaponSkins';

/** A bus that records nothing but the one call this file is about. */
function recordingBus(invalidations: { n: number }): AudioBus {
  return {
    preload: async () => {},
    play: () => {},
    setSfxVolume: () => {},
    setMusicVolume: () => {},
    updateMusic: (_track: MusicTrack | null, _dtMs: number) => {},
    invalidateMusic: () => {
      invalidations.n++;
    },
    resume: () => {},
  };
}

let fake: WeChatRuntimeFake;
const invalidations = { n: 0 };
/** Every pack load seen up to the end of phase one, captured before phase two starts. */
let afterLobby: string[] = [];
/** ...and every image the runtime was asked for in that same window. */
let imagesAfterLobby: string[] = [];
/** The progress ticks the run gate would have driven its bar with. */
const runTicks: Array<[number, number]> = [];

beforeAll(async () => {
  fake = installWeChatRuntimeFake();
  setMusicAudio(recordingBus(invalidations));

  await preloadLobbyArt();
  afterLobby = [...fake.packLoads];
  imagesAfterLobby = [...fake.imageRequests];
  // Deliberately read BEFORE the run phase starts — these are the assertions about the window.
  lobbyOnly = {
    ui: Object.keys(UI_ASSETS).filter((k) => getUiTexture(k) !== undefined).length,
    rigs: CHAR_BUNDLES.filter(([name]) => getRigSkin(name) !== undefined).length,
    floor: getFloorTexture('fire') !== undefined,
    weapon: getWeaponTexture('scattergun', 'ranged') !== undefined,
    curtain: getDoorCurtainTexture() !== undefined,
    readyBeforeKick: isRunArtReady(),
  };

  beginDeferredArt();
  readyAfterKick = isRunArtReady();
  await ensureRunArt((done, total) => runTicks.push([done, total]));
});

let lobbyOnly: {
  ui: number;
  rigs: number;
  floor: boolean;
  weapon: boolean;
  curtain: boolean;
  readyBeforeKick: boolean;
};
let readyAfterKick = false;

afterAll(() => {
  setMusicAudio(null);
  fake.restore();
  resetPreloadArt();
});

describe('phase one — the only wait a player sees', () => {
  it('fetched the lobby pack and nothing else', () => {
    expect(afterLobby).toEqual(['lobby']);
  });

  it('dressed every menu-shaped screen', () => {
    // The whole point of the `lobby` pack: a login screen with no art is what this replaces.
    expect(lobbyOnly.ui).toBe(Object.keys(UI_ASSETS).length);
  });

  it('asked the runtime for nothing outside the lobby pack', () => {
    // The harness check under the two assertions below: "absent" has to mean "never requested",
    // not "requested and quietly failed". If a loader in phase one reached for run art, its path
    // shows up here — and the absence assertions would then be passing for the wrong reason.
    expect(imagesAfterLobby.length).toBeGreaterThan(10);
    for (const packed of imagesAfterLobby) expect(packed.startsWith('packs/lobby/'), packed).toBe(true);
  });

  it('left every run texture genuinely absent, not merely unused', () => {
    // Not a flag: the rig sidecars live in `packs/run`, which `wx.loadSubpackage` had not been
    // called for, so `readFileSync` threw and the registry stayed empty. If `preloadLobbyArt`
    // ever starts loading run art, these numbers move.
    expect(lobbyOnly.rigs).toBe(0);
    expect(lobbyOnly.floor).toBe(false);
    expect(lobbyOnly.weapon).toBe(false);
    expect(lobbyOnly.curtain).toBe(false);
  });

  it('arms the gate on the kick, and not one moment before', () => {
    // `isRunArtReady()` answers TRUE until something has actually deferred, which is what keeps
    // the gate out of every caller (and every test) that never opted in — and is exactly why the
    // kick has to happen before `new Game(...)` rather than after `start()`. See main.ts.
    expect(lobbyOnly.readyBeforeKick).toBe(true);
    expect(readyAfterKick).toBe(false);
  });

  it('is kicked before any entry point can enter a run', () => {
    // The hole this closes: `Game.start()` enters a run on its own first pass when `?replay=` is
    // set, so a kick placed after `start()` would let that run begin with placeholder art and no
    // gate. A source-order assertion because there is no way to observe it from inside a module
    // — same technique as audio/musicPipeline.test.ts's check that GameLoop calls the director.
    for (const entry of ['main.ts', 'main.wechat.ts', 'main.crazygames.ts']) {
      const src = readFileSync(new URL(`../${entry}`, import.meta.url), 'utf8');
      const kick = src.indexOf('beginDeferredArt();');
      const construct = src.indexOf('new Game(app, input, audio)');
      expect(kick, `${entry}: no beginDeferredArt call`).toBeGreaterThan(-1);
      expect(construct, `${entry}: no Game construction`).toBeGreaterThan(-1);
      expect(kick, `${entry}: the gate is armed too late`).toBeLessThan(construct);
    }
  });

  it('brackets the WeChat boot wait with the screen that covers it', () => {
    // Only `main.wechat.ts` mounts a Pixi progress screen: web already has one that paints before
    // the WebGL context exists (`index.html`'s `#boot-loading`). So this is a one-entry check, and
    // a source-order one for the same reason as the case above — `showBootLoading` takes an
    // `Application`, which cannot be constructed here.
    //
    // Both orderings are load-bearing and both fail silently. A `showBootLoading` after the await
    // shows a spinner for the frame AFTER the only wait it exists to cover; a `done()` after
    // `new Game(...)` leaves an opaque, tap-swallowing, full-viewport scrim above the whole game
    // (see loadingScreen.ts's scrim note) — and on this platform the wait is real, because
    // `lobby` is a subpackage `wx.loadSubpackage` has to fetch before any `/ui/` path names a
    // file at all.
    const src = readFileSync(new URL('../main.wechat.ts', import.meta.url), 'utf8');
    const at = (needle: string): number => {
      const i = src.indexOf(needle);
      expect(i, `main.wechat.ts: no ${needle}`).toBeGreaterThan(-1);
      return i;
    };
    expect(at('showBootLoading(app)')).toBeLessThan(at('await preloadLobbyArt('));
    expect(at('await preloadLobbyArt(')).toBeLessThan(at('loading.done();'));
    expect(at('loading.done();')).toBeLessThan(at('new Game(app, input, audio)'));
  });
});

describe('phase two — the run gate', () => {
  it('fetched every declared subpackage exactly once, across both phases', () => {
    expect([...fake.packLoads].sort()).toEqual(SUBPACKS.map((p) => p.name).sort());
    expect(new Set(fake.packLoads).size).toBe(fake.packLoads.length);
  });

  it('filled in every loader that phase one had left empty', () => {
    // This is the property the design rests on: a loader re-run after its pack lands resolves
    // the textures that were missing the first time (they are idempotent map-fillers, and Pixi
    // memoises by URL).
    for (const [name] of CHAR_BUNDLES) expect(getRigSkin(name), name).toBeDefined();
    expect(getFloorTexture('fire')).toBeDefined();
    expect(getWeaponTexture('scattergun', 'ranged')).toBeDefined();
    expect(getDoorCurtainTexture()).toBeDefined();
  });

  it('reports ready once, and stays ready', () => {
    expect(isRunArtReady()).toBe(true);
  });

  it('ticked progress once per unit, in order, to a total the bar can be sized from', () => {
    // The leading 0 is the replay `ensureRunArt` gives a listener as it registers: a gate that
    // opens partway through a background download must draw its bar where the download IS. Here
    // the gate registered before the first unit settled, so the replay is 0 and the ticks run
    // 1..total with no gap — which is also what says the progress is a BROADCAST and not a
    // callback the background kick swallowed (it started the download with no listener at all).
    const total = runArtUnitCount();
    expect(total).toBe(packsForPhase('run').length + CHAR_BUNDLES.length + 3);
    expect(runTicks.map(([done]) => done)).toEqual(Array.from({ length: total + 1 }, (_, i) => i));
    for (const [, t] of runTicks) expect(t).toBe(total);
  });

  it('is memoised: a second gate re-runs no download and no loader', async () => {
    // The name claimed "and no loader" while only the DOWNLOAD was counted, which made
    // `runArt ??= ...` → `runArt = ...` a survivor: `packLoader` memoises each pack on its own,
    // so the pack count is flat either way. The loaders are what a repeat costs — and
    // `preloadRigSkin` is the one this module's header flags as NOT free, because it re-reads its
    // two JSON sidecars per bundle rather than skipping a bundle it already holds. Seven bundles,
    // fourteen reads, every time a gate opens.
    const before = {
      packs: fake.packLoads.length,
      json: fake.jsonRequests.length,
      images: fake.imageRequests.length,
    };
    expect(before.json).toBeGreaterThan(0); // the first pass really did read them
    await ensureRunArt();
    await ensureRunArt();
    expect(fake.packLoads.length).toBe(before.packs);
    expect(fake.jsonRequests.length).toBe(before.json);
    expect(fake.imageRequests.length).toBe(before.images);
  });
});

describe('music — fetched, never awaited', () => {
  it('fetched the music pack without the run gate depending on it', () => {
    // It is in `packLoads` because `beginDeferredArt` kicked it, and NOT in the run phase's
    // await list — the two lists are what say so.
    expect(fake.packLoads).toContain('music');
    expect(packsForPhase('run').map((p) => p.name)).not.toContain('music');
  });

  it('told the director to forget its answer once the pack had landed', () => {
    // Without this the menu bed is silent for the session: the deck was handed a path inside a
    // pack that did not exist yet, played nothing, and `MusicPlayer` recorded the track as
    // current anyway. See MusicPlayer.invalidate.
    expect(invalidations.n).toBe(1);
  });
});

describe('the harness itself', () => {
  it('had more than one pack to phase, so none of the above passes vacuously', () => {
    expect(SUBPACKS.length).toBeGreaterThanOrEqual(6);
    expect(packsForPhase('run').length).toBeGreaterThanOrEqual(2);
  });
});
