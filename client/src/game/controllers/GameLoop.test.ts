/**
 * GameLoop (extracted from Game.ts 2026-08-12, CLAUDE.md "500-line file convention")
 * — the fixed-step sim + interpolated render main loop. Rendering/Pixi collaborators
 * (scene/fx/hud/touchControlsView/portalPrompt/roomBuilder/partyScreen/events/
 * runOutcome/tutorialHints) are faked (same "avoid a real renderer" convention
 * EventReactor.test.ts already uses for FxController) so this file tests GameLoop's
 * own orchestration logic — what it calls, with what arguments, in which branch —
 * against a REAL `createGameEngine` for the offline sim-stepping tests (same
 * convention as controllers/ally.test.ts), never against Game.ts, which this file,
 * by design, never imports.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createGameEngine, createGameState, buildEnemyActor, makeCommand, quantizeMove, ReplayInputSource, toFp, toReplay, EMBER_DUNGEON, EMBER_ROOMS, type DungeonConfig, type GameState } from '@dd/engine';
import type { CoopSession } from '../../net/CoopSession';
import type { InputSource, InputState, TouchVisual } from '../../platform/types';
import { CommandBuilder } from './CommandBuilder';
import { AllyController } from './AllyController';
import { GameLoop, type GameLoopDeps, type GameLoopHost } from './GameLoop';
import { setMusicAudio } from '../musicDirector';
import type { AudioBus, MusicTrack } from '../../platform/types';
import { MAX_WALL_HEIGHT } from '../scene/wallGeometry';
import type { PickupDebugOverlay } from '../scene/PickupDebugOverlay';

const CFG = { seed: 3, worldW: 1600, worldH: 1200, waves: [] as const };
// A single sim tick's worth of render dt (matches GameLoop's own internal SIM_DT_MS,
// duplicated here as a plain literal since the constant itself is module-private).
const SIM_DT_MS_FOR_TESTS = 1000 / 30 + 1; // +1 to clear any floating-point rounding short

function fakeInput(initial: Partial<InputState> = {}): InputSource & { state: InputState } {
  const state: InputState = { moveX: 0, moveY: 0, firing: false, interacting: false, ...initial };
  const touchVisual: TouchVisual = {
    active: false, stickRadius: 40, move: null,
    fire: { cx: 0, cy: 0, r: 0, pressed: false },
    weapon1: { cx: 0, cy: 0, r: 0 }, weapon2: { cx: 0, cy: 0, r: 0 },
    interact: { cx: 0, cy: 0, r: 0, pressed: false },
  };
  return {
    state,
    onSwitchWeapon: null,
    attach: vi.fn(),
    read: () => state,
    getTouchVisual: () => touchVisual,
  };
}

function fakeScene() {
  return {
    // `prevX`/`prevY` are the interpolation buffers every real `Entity` carries; `doorTick`'s
    // refusal derivation reads them (a blocked player's `cur` stops leaving `prev`), so a fake
    // without them would make that whole path unreachable from here.
    player: undefined as
      | { curX: number; curY: number; prevX: number; prevY: number; bodySilhouette: { halfW: number; bodyH: number } }
      | undefined,
    enemies: [] as ReadonlyArray<{ curX: number; curY: number; bodySilhouette: { halfW: number; bodyH: number } }>,
    pickups: [] as ReadonlyArray<{ curX: number; curY: number; bodySilhouette: { halfW: number; bodyH: number } }>,
    interpolate: vi.fn(),
    reconcile: vi.fn(),
    positionLocal: vi.fn(),
    // The spawn count  forwards to the reactor (design/11). Mutable on the fake so
    // a case can say what the reconcile reported.
    spawnedActors: 0,
  };
}

function fakeFx() {
  return {
    consumeHitStop: vi.fn().mockReturnValue(false),
    updateFx: vi.fn(),
    updateCamera: vi.fn(),
    trailDot: vi.fn(),
    addShake: vi.fn(),
    // This frame's visible world rect, which `DoorFxDriver` culls the animated fixtures against
    // (`scene/doorTick.ts`). Generous enough to contain any test floor, so the cull is never what
    // makes an assertion here pass or fail — this file is about GameLoop's wiring, and
    // `doorTick.test.ts` owns the cull rule itself.
    worldView: { x: -1e4, y: -1e4, width: 2e4, height: 2e4 },
    lights: { addPersistent: vi.fn(), removePersistent: vi.fn() },
  };
}

function fakeHud() {
  return { update: vi.fn(), weaponPickupPrompt: { isOpen: false } };
}

function fakeRoomBuilder() {
  return {
    setPortalOpen: vi.fn(),
    updateOcclusion: vi.fn(),
    tickFixtures: vi.fn(),
    doorFootprint: vi.fn().mockReturnValue(null),
    rejectDoor: vi.fn(),
    portalPx: null as { x: number; y: number } | null,
  };
}

function fakePortalPrompt() {
  return { update: vi.fn(), isOpen: false };
}

/** `extra` overrides a dep for the one test that needs a non-default: `pickupDebugOverlay` is
 *  null in every normal session (`?pickupDebug=1` only), so null is what the shared default is. */
function buildDeps(extra: Partial<GameLoopDeps> = {}) {
  const scene = fakeScene();
  const fx = fakeFx();
  const hud = fakeHud();
  const roomBuilder = fakeRoomBuilder();
  const portalPrompt = fakePortalPrompt();
  const floorCardPrompt = fakePortalPrompt(); // same shape: an `update` spy plus `isOpen`
  const touchControlsView = { update: vi.fn() };
  const partyScreen = { update: vi.fn() };
  const input = fakeInput();
  const builder = new CommandBuilder(input);
  const ally = new AllyController();
  const events = { consume: vi.fn() };
  const runOutcome = { handle: vi.fn() };
  const tutorialHints = { consume: vi.fn(), reset: vi.fn() };

  const deps: GameLoopDeps = {
    scene, fx, hud, touchControlsView, portalPrompt, floorCardPrompt, roomBuilder, partyScreen,
    builder, ally, input, events, runOutcome, tutorialHints,
    pickupDebugOverlay: null,
    ...extra,
  } as unknown as GameLoopDeps;

  return { deps, scene, fx, hud, roomBuilder, portalPrompt, floorCardPrompt, touchControlsView, partyScreen, input, builder, ally, events, runOutcome, tutorialHints };
}

function buildHost(overrides: Partial<GameLoopHost> = {}): GameLoopHost & { localOwner: number } {
  return {
    getPhase: () => 'playing',
    isOnline: () => false,
    isCoop: () => false,
    isArenaDemo: () => false,
    isTeaching: () => false,
    replayStopTick: () => null,
    localOwner: 0,
    getEngine: () => null,
    getSession: () => null,
    activeState: () => null,
    currentScore: () => 0,
    selectedSkinId: () => 'vanguard',
    allySkinId: () => 'skirmisher',
    screenSize: () => ({ w: 800, h: 600 }),
    markTutorialSeen: vi.fn(),
    confirm: vi.fn(),
    ...overrides,
  };
}

/** A bus that records only what music asks of it. Everything else on `AudioBus` is unused
 *  here — the cue path reaches the bus through `deps.events`, which is already faked. */
function recordingMusicBus(): { calls: { track: MusicTrack | null; dtMs: number }[]; bus: AudioBus } {
  const calls: { track: MusicTrack | null; dtMs: number }[] = [];
  return {
    calls,
    bus: {
      preload: async () => {},
      play: () => {},
      setSfxVolume: () => {},
      setMusicVolume: () => {},
      updateMusic: (track, dtMs) => calls.push({ track, dtMs }),
      invalidateMusic: () => {},
      resume: () => {},
    },
  };
}

// The music tick (design/11 "Music & ambience", 2026-08-31). GameLoop's only involvement is one
// unconditional call, and that is exactly what needs a test: the decision itself lives in
// `game/musicDirector.ts` with its own suite, but nothing there can see whether the main loop
// actually calls it — and the failure mode is a game with no music and a green suite, which is
// what the whole month before this pass looked like.
describe('GameLoop.update — the music tick', () => {
  afterEach(() => setMusicAudio(null));

  it('drives music in EVERY phase, not only while playing', () => {
    // The bug this forecloses: putting the call inside the `playing` branch, which is where every
    // other per-frame concern in this file lives. The menu bed would then never play, and the
    // dungeon bed would stop the moment the player paused.
    const { deps } = buildDeps();
    const { calls, bus } = recordingMusicBus();
    setMusicAudio(bus);
    for (const phase of ['menu', 'forge', 'playing', 'paused', 'victory'] as const) {
      const loop = new GameLoop(deps, buildHost({ getPhase: () => phase }));
      loop.update(16);
    }
    expect(calls).toHaveLength(5);
  });

  it('passes the render dt through unchanged — music runs on the wall clock', () => {
    // Not the sim clock. `dtMs` is the crossfade envelope's only input, and design/11 puts audio
    // on render/display time precisely so it may lag or drop without touching the match.
    const { deps } = buildDeps();
    const { calls, bus } = recordingMusicBus();
    setMusicAudio(bus);
    const loop = new GameLoop(deps, buildHost({ getPhase: () => 'menu' }));
    loop.update(16);
    loop.update(97); // a stalled frame
    expect(calls.map((c) => c.dtMs)).toEqual([16, 97]);
  });

  it('derives the track from the host situation, not from a stored one', () => {
    // A live dungeon run answers with the run bed; the same loop on a menu phase answers with the
    // menu bed. This is what proves the situation actually reaches the director rather than a
    // constant being passed.
    const { deps } = buildDeps();
    const { calls, bus } = recordingMusicBus();
    setMusicAudio(bus);
    const s = createGameState({
      seed: 1, worldW: 800, worldH: 800, waves: [],
      dungeon: { config: EMBER_DUNGEON, library: EMBER_ROOMS },
    });
    s.phase = 'playing';
    new GameLoop(deps, buildHost({ getPhase: () => 'playing', activeState: () => s })).update(16);
    new GameLoop(deps, buildHost({ getPhase: () => 'menu' })).update(16);
    expect(calls.map((c) => c.track)).toEqual(['dungeon.ember', 'menu']);
  });

  it('reports OUR seat as the situation, not seat 0', () => {
    // `localOwner` is the third field of the situation and the only one every other case in this
    // block leaves at `buildHost()`'s default of 0 — so hard-coding it to 0 here survived. In
    // co-op that is the audible bug: sitting in seat 1, the bed would follow the HOST's room, so
    // a teammate walking into the boss room would score OUR quiet corridor and walking in
    // ourselves would change nothing. The decision itself (`inBossRoom` reads `players[owner]`)
    // has its own tests; what this pins is that the seat reaching it is ours.
    const { deps } = buildDeps();
    const { calls, bus } = recordingMusicBus();
    setMusicAudio(bus);
    const s = createGameState({
      seed: 1, worldW: 800, worldH: 800, waves: [],
      dungeon: { config: EMBER_DUNGEON, library: EMBER_ROOMS },
    });
    // A real boss-role piece from the shipped library, and seat 0 standing in it.
    s.dungeonRooms.push({
      id: 'r1',
      piece: EMBER_ROOMS.find((p) => p.role === 'boss')!,
      offsetXGrid: 0, offsetYGrid: 0, entranceGrid: { x: 1, y: 1 },
    });
    s.dungeonRoomIndexById.set('r1', 0);
    s.phase = 'playing';
    s.players[0]!.roomId = 'r1';
    s.players.push({ ...s.players[0]!, roomId: undefined }); // our seat, between rooms
    const host = buildHost({ getPhase: () => 'playing', activeState: () => s, localOwner: 1 });

    new GameLoop(deps, host).update(16);

    expect(calls.map((c) => c.track)).toEqual(['dungeon.ember']);
  });

  it('runs the frame normally with no audio device attached', () => {
    // Unset is the safe state, and it is the state every other test in this file runs in — so
    // this is the assertion that keeps them honest rather than accidentally passing.
    const { deps, scene } = buildDeps();
    setMusicAudio(null);
    const loop = new GameLoop(deps, buildHost({ getPhase: () => 'menu' }));
    expect(() => loop.update(16)).not.toThrow();
    expect(scene.interpolate).toHaveBeenCalled();
  });
});

describe('GameLoop.update — top-level phase dispatch', () => {
  it('paused: freezes the sim (no engine.submit) but keeps fx/interpolate animating', () => {
    const { deps, scene, fx } = buildDeps();
    const engine = createGameEngine(CFG);
    const submitSpy = vi.spyOn(engine, 'submit');
    const host = buildHost({ getPhase: () => 'paused', getEngine: () => engine });
    const loop = new GameLoop(deps, host);

    loop.update(16);

    expect(fx.updateFx).toHaveBeenCalled();
    expect(scene.interpolate).toHaveBeenCalledWith(1, 16);
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it('idle (menu/victory/etc.): keeps fx fading and updates partyScreen, but never polls confirm itself', () => {
    // Confirm is driven entirely by Screens.ts's own CONFIRM/MAIN MENU Button taps now
    // (2026-08-17, see GameLoop's class doc comment) — GameLoop's idle branch has no
    // raw-input confirm path left to test; holding fire here must do nothing.
    const { deps, input, partyScreen } = buildDeps();
    const host = buildHost({ getPhase: () => 'victory' });
    const loop = new GameLoop(deps, host);

    input.state.firing = true;
    loop.update(16);
    loop.update(16);

    expect(partyScreen.update).toHaveBeenCalledWith(16);
    expect(host.confirm).not.toHaveBeenCalled();
  });

  it('playing + online routes to the online path (session-driven), never touching engine.submit', () => {
    const { deps } = buildDeps();
    const engine = createGameEngine(CFG);
    const submitSpy = vi.spyOn(engine, 'submit');
    const session = { started: false } as unknown as CoopSession;
    const host = buildHost({ isOnline: () => true, getEngine: () => engine, getSession: () => session });
    const loop = new GameLoop(deps, host);

    loop.update(16);

    expect(submitSpy).not.toHaveBeenCalled(); // offline stepSim never ran
  });
});

describe('GameLoop — offline sim stepping (advanceSim/stepSim)', () => {
  it('steps the engine at the fixed 30Hz cadence, not once per render frame', () => {
    const { deps } = buildDeps();
    const engine = createGameEngine(CFG);
    const advanceSpy = vi.spyOn(engine, 'advance');
    const host = buildHost({ getEngine: () => engine });
    const loop = new GameLoop(deps, host);

    loop.update(16); // < 1 sim tick (33.3ms) accumulated — no step yet
    expect(advanceSpy).not.toHaveBeenCalled();

    loop.update(20); // 36ms total accumulated — one tick's worth
    expect(advanceSpy).toHaveBeenCalledTimes(1);
  });

  it('caps catch-up at MAX_STEPS and drops the backlog after a long stall', () => {
    const { deps } = buildDeps();
    const engine = createGameEngine(CFG);
    const advanceSpy = vi.spyOn(engine, 'advance');
    const host = buildHost({ getEngine: () => engine });
    const loop = new GameLoop(deps, host);

    loop.update(10_000); // a huge stall (e.g. tab backgrounded) — must not spiral-of-death
    expect(advanceSpy.mock.calls.length).toBeLessThanOrEqual(5); // MAX_STEPS

    advanceSpy.mockClear();
    loop.update(16); // backlog was dropped, not carried — a normal frame steps at most once
    expect(advanceSpy.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('stepSim submits the local seat\'s command and advances the engine one frame', () => {
    const { deps, scene } = buildDeps();
    const engine = createGameEngine(CFG);
    const submitSpy = vi.spyOn(engine, 'submit');
    const host = buildHost({ getEngine: () => engine });
    const loop = new GameLoop(deps, host);

    loop.update(SIM_DT_MS_FOR_TESTS);

    expect(submitSpy).toHaveBeenCalledTimes(1);
    expect(submitSpy.mock.calls[0]![0].tick).toBe(1);
    expect(scene.reconcile).toHaveBeenCalledTimes(1);
  });

  it('coop: also submits the bot ally\'s command for every non-local seat', () => {
    const { deps } = buildDeps();
    const engine = createGameEngine({ ...CFG, players: [{ start: [400, 400] }, { start: [420, 400] }] });
    const submitSpy = vi.spyOn(engine, 'submit');
    const host = buildHost({ getEngine: () => engine, isCoop: () => true });
    const loop = new GameLoop(deps, host);

    loop.update(SIM_DT_MS_FOR_TESTS);

    expect(submitSpy).toHaveBeenCalledTimes(2); // local seat + one bot-driven seat
  });

  it('non-coop, non-arenaDemo: never drives the second seat, even if one exists', () => {
    const { deps } = buildDeps();
    const engine = createGameEngine({ ...CFG, players: [{ start: [400, 400] }, { start: [420, 400] }] });
    const submitSpy = vi.spyOn(engine, 'submit');
    const host = buildHost({ getEngine: () => engine }); // isCoop/isArenaDemo both default false
    const loop = new GameLoop(deps, host);

    loop.update(SIM_DT_MS_FOR_TESTS);

    expect(submitSpy).toHaveBeenCalledTimes(1);
  });

  // `?replay=` playback (match/replayPlayback.ts). ReplayInputSource is read-only by
  // design — `submit` THROWS — so "the loop must not submit over the recording" is a
  // claim a real source can enforce rather than a spy having to notice.
  // CFG has no waves, and a wave-less run reaches `gameover` on tick 1 (its tick then
  // stops advancing) — useless for asserting WHERE playback stops. This one keeps running.
  const REPLAY_CFG = { ...CFG, waves: [[[520, 400] as const]] };
  const recordedReplay = (ticks: number) =>
    toReplay(
      REPLAY_CFG,
      Array.from({ length: ticks }, (_, i) =>
        makeCommand({ owner: 0, tick: i + 1, ...quantizeMove(1, 0), buttons: 0 }),
      ),
    );

  it('replay playback: drives the engine from the recording without submitting over it', () => {
    const { deps, scene } = buildDeps();
    const engine = createGameEngine(REPLAY_CFG, new ReplayInputSource(recordedReplay(10)));
    const host = buildHost({ getEngine: () => engine, replayStopTick: () => 10 });
    const loop = new GameLoop(deps, host);

    loop.update(SIM_DT_MS_FOR_TESTS);

    expect(engine.state.tick).toBe(1);
    expect(scene.reconcile).toHaveBeenCalledTimes(1);
  });

  it('replay playback: holds the sim at the marked tick while the render loop keeps going', () => {
    const { deps, scene } = buildDeps();
    const engine = createGameEngine(REPLAY_CFG, new ReplayInputSource(recordedReplay(10)));
    const host = buildHost({ getEngine: () => engine, replayStopTick: () => 3 });
    const loop = new GameLoop(deps, host);

    for (let i = 0; i < 10; i++) loop.update(SIM_DT_MS_FOR_TESTS);

    expect(engine.state.tick).toBe(3); // frozen AT the mark, not run to the stream's end
    expect(scene.interpolate).toHaveBeenCalledTimes(10); // still rendering every frame
  });

  it('THE CONTROL: without the replay guard the same setup throws, so the guard is load-bearing', () => {
    const { deps } = buildDeps();
    const engine = createGameEngine(REPLAY_CFG, new ReplayInputSource(recordedReplay(10)));
    // replayStopTick null = a normal run, so the loop submits a live command — which is
    // exactly what a read-only source refuses.
    const host = buildHost({ getEngine: () => engine, replayStopTick: () => null });
    const loop = new GameLoop(deps, host);

    expect(() => loop.update(SIM_DT_MS_FOR_TESTS)).toThrow(/read-only/);
  });

  // The HUD's record button is only offered when a replay of THIS run could actually be
  // saved, and updateHud is where that gets decided.
  const hudCtx = (hud: { update: { mock: { calls: unknown[][] } } }) =>
    hud.update.mock.calls[0]![2] as { canSaveReplay: boolean };

  it('offers the record button in an ordinary offline run', () => {
    const { deps, hud } = buildDeps();
    const engine = createGameEngine(CFG);
    // `activeState` is what updateHud reads; the default fake host returns null, which
    // would make this assertion vacuous rather than false.
    const loop = new GameLoop(deps, buildHost({ getEngine: () => engine, activeState: () => engine.state }));
    loop.update(SIM_DT_MS_FOR_TESTS);
    expect(hud.update).toHaveBeenCalled();
    expect(hudCtx(hud).canSaveReplay).toBe(true);
  });

  it("does NOT offer it online - the server holds that match's record, not the client", () => {
    const { deps, hud } = buildDeps();
    const engine = createGameEngine(CFG);
    const session = { started: true, state: engine.state, frame: 1, submit: vi.fn(), drive: () => [] };
    const host = buildHost({
      isOnline: () => true,
      getEngine: () => engine,
      getSession: () => session as unknown as CoopSession,
      activeState: () => engine.state,
    });
    new GameLoop(deps, host).update(SIM_DT_MS_FOR_TESTS);
    expect(hudCtx(hud).canSaveReplay).toBe(false);
  });

  it("does NOT offer it while watching a replay - that file is somebody else's already", () => {
    const { deps, hud } = buildDeps();
    const engine = createGameEngine(REPLAY_CFG, new ReplayInputSource(recordedReplay(10)));
    const loop = new GameLoop(deps, buildHost({
      getEngine: () => engine, replayStopTick: () => 10, activeState: () => engine.state,
    }));
    loop.update(SIM_DT_MS_FOR_TESTS);
    expect(hud.update).toHaveBeenCalled();
    expect(hudCtx(hud).canSaveReplay).toBe(false);
  });

  it('feeds this tick\'s events to EventReactor and (while tutorialActive) TutorialHintController', () => {
    const { deps, events, tutorialHints } = buildDeps();
    const engine = createGameEngine(CFG);
    const host = buildHost({ getEngine: () => engine, isTeaching: () => true });
    const loop = new GameLoop(deps, host);

    loop.update(SIM_DT_MS_FOR_TESTS);

    expect(events.consume).toHaveBeenCalledTimes(1);
    expect(tutorialHints.consume).toHaveBeenCalledTimes(1);
  });

  it('does not feed TutorialHintController when the tutorial is not active', () => {
    const { deps, tutorialHints } = buildDeps();
    const engine = createGameEngine(CFG);
    const host = buildHost({ getEngine: () => engine, isTeaching: () => false });
    const loop = new GameLoop(deps, host);

    loop.update(SIM_DT_MS_FOR_TESTS);

    expect(tutorialHints.consume).not.toHaveBeenCalled();
  });
});

describe('GameLoop — the render frame every per-actor clock rides on', () => {
  // The paused and not-yet-online paths above already assert `interpolate(1, 16)`. The RUNNING
  // path — the one a match actually spends its time in — only had `toHaveBeenCalled()`, and a
  // 2026-08-26 battery showed what that costs: `scene.interpolate(alpha, 0)` survived the whole
  // suite. Every clock `ActorFilters` owns rides on that argument (the shield shell's 200ms exit
  // and its shimmer, the hit-flash decay, the death dissolve, the burn heat-haze), so a frozen dt
  // is "no actor ever animates again" with 3000+ tests still green.
  it('hands the scene the real FRAME dt while running, not zero and not the sim step', () => {
    const { deps, scene } = buildDeps();
    const engine = createGameEngine(CFG);
    const host = buildHost({ getEngine: () => engine });
    const loop = new GameLoop(deps, host);

    loop.update(16);

    const calls = (scene.interpolate as ReturnType<typeof vi.fn>).mock.calls as Array<[number, number]>;
    expect(calls.length).toBeGreaterThan(0);
    for (const [, dt] of calls) expect(dt).toBe(16);
  });

  it('passes a LONGER frame straight through, so a hitch advances the clocks by what it cost', () => {
    // The bound that matters for the exit: a 200ms animation stepped by a constant would take a
    // different number of real milliseconds on a stuttering machine than on a smooth one.
    const { deps, scene } = buildDeps();
    const engine = createGameEngine(CFG);
    const loop = new GameLoop(deps, buildHost({ getEngine: () => engine }));

    loop.update(50);

    const calls = (scene.interpolate as ReturnType<typeof vi.fn>).mock.calls as Array<[number, number]>;
    for (const [, dt] of calls) expect(dt).toBe(50);
  });
});

describe('GameLoop — hit-stop', () => {
  it('a consumed hit-stop freezes stepSim for that frame but still renders', () => {
    const { deps, fx, scene } = buildDeps();
    const engine = createGameEngine(CFG);
    const advanceSpy = vi.spyOn(engine, 'advance');
    fx.consumeHitStop.mockReturnValue(true);
    const host = buildHost({ getEngine: () => engine });
    const loop = new GameLoop(deps, host);

    loop.update(SIM_DT_MS_FOR_TESTS);

    expect(advanceSpy).not.toHaveBeenCalled();
    expect(scene.interpolate).toHaveBeenCalled(); // render still animates through the freeze
  });
});

describe('GameLoop — online path (advanceOnline)', () => {
  function fakeSession(overrides: Partial<CoopSession> = {}): CoopSession {
    return {
      started: true,
      frame: 5,
      state: createGameEngine(CFG).state,
      submit: vi.fn(),
      drive: vi.fn().mockReturnValue([]),
      reportResult: vi.fn(),
      ...overrides,
    } as unknown as CoopSession;
  }

  it('not yet started: holds the scene and keeps fx fading, without touching the session', () => {
    const { deps, scene, fx } = buildDeps();
    const session = fakeSession({ started: false });
    const host = buildHost({ isOnline: () => true, getSession: () => session });
    const loop = new GameLoop(deps, host);

    loop.update(16);

    expect(scene.interpolate).toHaveBeenCalledWith(1, 16);
    expect(fx.updateFx).toHaveBeenCalled();
    expect(session.submit).not.toHaveBeenCalled();
  });

  it('started: relays the local command, drives the session, and reconciles the scene', () => {
    const { deps, scene } = buildDeps();
    const session = fakeSession();
    const host = buildHost({ isOnline: () => true, getSession: () => session });
    const loop = new GameLoop(deps, host);

    loop.update(16);

    expect(session.submit).toHaveBeenCalledTimes(1);
    expect(session.drive).toHaveBeenCalledTimes(1);
    expect(scene.reconcile).toHaveBeenCalledTimes(1);
  });

  it('gameover: reports the result hash and hands off to RunOutcome exactly once', () => {
    const { deps, runOutcome } = buildDeps();
    const gameoverState = createGameEngine(CFG).state;
    gameoverState.phase = 'gameover';
    const session = fakeSession({ state: gameoverState });
    const host = buildHost({ isOnline: () => true, getSession: () => session });
    const loop = new GameLoop(deps, host);

    loop.update(16);

    expect(session.reportResult).toHaveBeenCalledTimes(1);
    expect(runOutcome.handle).toHaveBeenCalledTimes(1);
    expect(runOutcome.handle).toHaveBeenCalledWith(gameoverState);
  });
});

/**
 * The order of the two things a tick does to the render layer, which nothing asserted and which
 * decides what a DEATH looks like (2026-09-02).
 *
 * `reconcile` diffs `GameState` and `consumeEvents` hands the tick's events to `EventReactor`.
 * Because reconcile runs FIRST, on the tick an actor dies its view has already left `Scene.views`
 * (moved to the dissolving list, its `death` clip started) by the time the `hit` that killed it
 * reaches the reactor — and `Scene.actorAt` only searches `views`. So a killing blow's hit-flash
 * and `hurt` flinch never land, and `render/rigClipLayer.ts`'s own "a corpse does not flinch" rule
 * is defence at the layer that owns the rule rather than a guard on a live case.
 *
 * Reverse this order and that guard becomes the only thing holding the line, which is exactly why
 * the order is worth a test rather than a comment.
 */
describe('GameLoop — the scene is reconciled BEFORE the tick\'s events are consumed', () => {
  const orderOf = (fn: unknown): number =>
    (fn as { mock: { invocationCallOrder: number[] } }).mock.invocationCallOrder[0]!;

  it('offline (stepSim)', () => {
    const { deps, scene, events } = buildDeps();
    const engine = createGameEngine(CFG);
    const loop = new GameLoop(deps, buildHost({ getEngine: () => engine }));

    loop.update(SIM_DT_MS_FOR_TESTS);

    expect(scene.reconcile).toHaveBeenCalledTimes(1);
    expect(events.consume).toHaveBeenCalledTimes(1);
    expect(orderOf(scene.reconcile)).toBeLessThan(orderOf(events.consume));
  });

  it('online (advanceOnline) — the same order, which is not automatic: it is a second call site', () => {
    const { deps, scene, events } = buildDeps();
    const session = {
      started: true, frame: 5, state: createGameEngine(CFG).state,
      submit: vi.fn(), drive: vi.fn().mockReturnValue([{ type: 'hit' }]), reportResult: vi.fn(),
    } as unknown as CoopSession;
    const loop = new GameLoop(deps, buildHost({ isOnline: () => true, getSession: () => session }));

    loop.update(16);

    expect(scene.reconcile).toHaveBeenCalledTimes(1);
    expect(events.consume).toHaveBeenCalledTimes(1);
    expect(orderOf(scene.reconcile)).toBeLessThan(orderOf(events.consume));
  });
});

describe('GameLoop — reset hooks (run-lifecycle callbacks)', () => {
  it('resetForNewRun zeroes the accumulator, so the very next frame needs a full tick before stepping', () => {
    const { deps } = buildDeps();
    const engine = createGameEngine(CFG);
    const advanceSpy = vi.spyOn(engine, 'advance');
    const host = buildHost({ getEngine: () => engine });
    const loop = new GameLoop(deps, host);

    loop.update(30); // build up some, but not quite a full tick, of accumulator
    loop.resetForNewRun();
    loop.update(10); // would NOT have been enough on its own — confirms the reset actually zeroed it
    expect(advanceSpy).not.toHaveBeenCalled();
  });

  it('resetOnlinePrediction does not throw and leaves the loop usable for a fresh online run', () => {
    const { deps } = buildDeps();
    const host = buildHost({ isOnline: () => true, getSession: () => fakeOnlineSessionForReset() });
    const loop = new GameLoop(deps, host);
    expect(() => loop.resetOnlinePrediction()).not.toThrow();
    expect(() => loop.update(16)).not.toThrow();
  });

  function fakeOnlineSessionForReset(): CoopSession {
    return { started: false } as unknown as CoopSession;
  }
});

// Stuck-portal fix (2026-08-12): dungeon mode's `wavesExhausted` is never set
// (SpawnSystem.tick's dungeon branch returns before the line that sets it), so
// checkpointEligible used to be permanently false on any non-final floor — the
// portal never opened and the extract/descend popup never appeared. `updateHud`
// (private, called from `advanceSim` while `phase === 'playing'`) is exercised here
// via a real dungeon `GameState` from `host.activeState()` — dt stays under one sim
// tick so `stepSim`/`engine.submit` never runs, isolating just the checkpoint gate.
describe('GameLoop — portal/checkpoint eligibility (dungeon mode, 2026-08-12 stuck-portal fix)', () => {
  const TINY_DUNGEON: DungeonConfig = { ...EMBER_DUNGEON, floorCount: 5 };

  function dungeonStateWithRooms(roomCount: number) {
    const s = createGameState({
      seed: 1, worldW: 800, worldH: 800, waves: [],
      dungeon: { config: TINY_DUNGEON, library: EMBER_ROOMS },
    });
    for (let i = 0; i < roomCount; i++) {
      s.dungeonRoomRuntime.push({ activated: false, roomTick: 0, schedule: [], cursor: 0, hasLiveEnemy: false, weaponDropped: false });
    }
    return s;
  }

  it('portal stays closed before the capstone room is cleared', () => {
    const { deps } = buildDeps();
    const s = dungeonStateWithRooms(2);
    const host = buildHost({ getPhase: () => 'playing', activeState: () => s });
    const loop = new GameLoop(deps, host);

    loop.update(16); // under one sim tick — engine.submit/stepSim never runs

    expect(deps.roomBuilder.setPortalOpen).toHaveBeenCalledWith(false);
  });

  it('THE FIX: portal opens once the capstone is cleared, even with a live enemy in another co-resident room', () => {
    const { deps } = buildDeps();
    const s = dungeonStateWithRooms(2);
    s.dungeonRoomRuntime[0]!.activated = true;
    s.dungeonRoomRuntime[0]!.hasLiveEnemy = true; // another room on the floor still has a mob up
    s.dungeonRoomRuntime[1]!.activated = true;
    s.dungeonRoomRuntime[1]!.hasLiveEnemy = false; // the capstone itself is clear
    s.enemies.push(buildEnemyActor(s, toFp(10), toFp(10)));
    const host = buildHost({ getPhase: () => 'playing', activeState: () => s });
    const loop = new GameLoop(deps, host);

    loop.update(16);

    // Before the fix, the old `s.wavesExhausted && s.enemies.length === 0` check was
    // permanently false in dungeon mode — this call would have been `false` here too.
    expect(deps.roomBuilder.setPortalOpen).toHaveBeenCalledWith(true);
  });

  // 2026-08-12 follow-up (live bug report: boss loot never had a chance to be picked
  // up, since ExtractionSystem used to auto-resolve EXTRACT the instant the capstone
  // cleared — no portal, no popup, no time to walk over to the drops). The last floor
  // now opens the same portal as every other checkpoint; only the popup's Descend
  // button is hidden (PortalPrompt.test.ts covers that half).
  it('portal ALSO opens on the LAST floor once its capstone is cleared (no more instant auto-resolve)', () => {
    const { deps } = buildDeps();
    const s = dungeonStateWithRooms(2);
    s.dungeonRoomRuntime[1]!.activated = true;
    s.dungeonRoomRuntime[1]!.hasLiveEnemy = false;
    s.floorIndex = TINY_DUNGEON.floorCount - 1; // the final floor
    const host = buildHost({ getPhase: () => 'playing', activeState: () => s });
    const loop = new GameLoop(deps, host);

    loop.update(16);

    expect(deps.roomBuilder.setPortalOpen).toHaveBeenCalledWith(true);
  });

  it('passes isLastFloor=true through to the popup on the LAST floor, so it can hide Descend', () => {
    const { deps } = buildDeps();
    const s = dungeonStateWithRooms(2);
    s.dungeonRoomRuntime[1]!.activated = true;
    s.dungeonRoomRuntime[1]!.hasLiveEnemy = false;
    s.floorIndex = TINY_DUNGEON.floorCount - 1; // the final floor
    const host = buildHost({ getPhase: () => 'playing', activeState: () => s });
    const loop = new GameLoop(deps, host);

    loop.update(16);

    expect(deps.portalPrompt.update).toHaveBeenCalledWith(s, expect.any(Boolean), true);
  });

  it('drives the floor-card offer off the SAME show condition as the portal popup', () => {
    // Two panels, one condition. If they could disagree, a player would get a card offer
    // over a floor that is not finished, or a portal with no card to pick at it.
    const { deps } = buildDeps();
    const s = dungeonStateWithRooms(2);
    const host = buildHost({ getPhase: () => 'playing', activeState: () => s });
    new GameLoop(deps, host).update(16);

    const portalShow = (deps.portalPrompt.update as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![1];
    const cardCall = (deps.floorCardPrompt.update as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    expect(cardCall[0]).toBe(s);
    expect(cardCall[1]).toBe(portalShow);
  });

  it('tells the card panel which seat is LOCAL, so it highlights the right vote', () => {
    // In co-op the panel draws "your pick" — reading seat 0 instead of the local one
    // would highlight a teammate's choice on every client but the host's.
    const { deps } = buildDeps();
    const s = dungeonStateWithRooms(2);
    const host = buildHost({ getPhase: () => 'playing', activeState: () => s, localOwner: 1 });
    new GameLoop(deps, host).update(16);

    const cardCall = (deps.floorCardPrompt.update as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    expect(cardCall[2]).toBe(1);
  });

  // 2026-09-02 live report — *"附近有可以拾取的武器时，不要阻断了玩家攻击"*. The weapon-pickup
  // panel used to be OR'd into this same call, which meant the player was disarmed for as
  // long as ANY floor weapon sat within SIM.lootRevealRadius — i.e. for most of a fight,
  // since every kill drops one. It swallows its own presses now (WeaponPickupPrompt.
  // onPressStart → CommandBuilder.suppressFireUntilRelease), and the loop leaves fire alone.
  it('does not gate fire on the weapon-pickup panel: the panel is open and FIRE stays live', () => {
    const { deps, hud, builder } = buildDeps();
    const suppress = vi.spyOn(builder, 'suppressFire');
    hud.weaponPickupPrompt.isOpen = true; // standing in loot, mid-fight
    const s = dungeonStateWithRooms(2);
    const host = buildHost({ getPhase: () => 'playing', activeState: () => s });
    const loop = new GameLoop(deps, host);

    loop.update(16);

    expect(suppress).toHaveBeenLastCalledWith(false);
  });

  it('still gates fire on the PORTAL popup, whose buttons sit in a cleared room', () => {
    const { deps, portalPrompt, builder } = buildDeps();
    const suppress = vi.spyOn(builder, 'suppressFire');
    portalPrompt.isOpen = true;
    const s = dungeonStateWithRooms(2);
    const host = buildHost({ getPhase: () => 'playing', activeState: () => s });
    const loop = new GameLoop(deps, host);

    loop.update(16);

    expect(suppress).toHaveBeenLastCalledWith(true);
  });
});

// `cameraFrame` (2026-08-17) — which rect `FxController.updateCamera` is told to FILL.
// A dungeon floor is co-resident, so fitting `worldSize` fitted the WHOLE FLOOR and the
// player saw several rooms at once; the fit target is now the room they're standing in.
// See design/01 "Framing the current room" for the why, and FxController.test.ts for
// what updateCamera then DOES with the rect — this block only covers the lookup.
//
// Every expectation here is the room rect GROWN UPWARD by MAX_WALL_HEIGHT (2026-08-18): the
// room's walls stand instead of lying flat (scene/wallGeometry.ts), so its north wall is
// drawn that far above the rect's own top edge and has to be inside the fitted frame. The
// MAXIMUM tier, not the typical one — a room's perimeter walls are the tall ones, and the
// perimeter is exactly what borders this rect.
describe('GameLoop.updateCamera — the frame rect handed to FxController', () => {
  // The engine converts px -> Fp at construction, so a rect authored in px comes back
  // through fpToPx with the same value; these expectations are in px throughout.
  function stateWithRoomRects(): ReturnType<typeof createGameState> {
    const s = createGameState({ seed: 1, worldW: 2000, worldH: 1000, waves: [], players: [{ start: [100, 100] }] });
    s.dungeonRoomRects.push(
      { id: 'r1', rect: { x: toFp(0), y: toFp(0), w: toFp(15), h: toFp(15) } },
      { id: 'r2', rect: { x: toFp(20), y: toFp(0), w: toFp(10), h: toFp(20) } },
    );
    return s;
  }

  /** The 5th argument of the last updateCamera call — `undefined` if it was never called. */
  function lastFrame(fx: { updateCamera: { mock: { calls: unknown[][] } } }) {
    const calls = fx.updateCamera.mock.calls;
    return calls.length === 0 ? undefined : calls[calls.length - 1]![4];
  }

  it("passes the rect of the room the local player is standing in", () => {
    const { deps, fx } = buildDeps();
    const s = stateWithRoomRects();
    s.players[0]!.roomId = 'r2';
    const loop = new GameLoop(deps, buildHost({ activeState: () => s }));

    loop.update(16);

    // 20/0/10/20 grid units at 32 px per grid.
    expect(lastFrame(fx)).toEqual({ x: 640, y: -MAX_WALL_HEIGHT, w: 320, h: 640 + MAX_WALL_HEIGHT });
  });

  it("follows the LOCAL seat's room in co-op, not whichever player is first", () => {
    const { deps, fx } = buildDeps();
    const s = createGameState({
      seed: 1, worldW: 2000, worldH: 1000, waves: [],
      players: [{ start: [100, 100] }, { start: [900, 100] }],
    });
    s.dungeonRoomRects.push(
      { id: 'r1', rect: { x: toFp(0), y: toFp(0), w: toFp(15), h: toFp(15) } },
      { id: 'r2', rect: { x: toFp(20), y: toFp(0), w: toFp(10), h: toFp(20) } },
    );
    s.players[0]!.roomId = 'r1';
    s.players[1]!.roomId = 'r2';
    const loop = new GameLoop(deps, buildHost({ activeState: () => s, localOwner: 1 }));

    loop.update(16);

    expect(lastFrame(fx)).toEqual({ x: 640, y: -MAX_WALL_HEIGHT, w: 320, h: 640 + MAX_WALL_HEIGHT });
  });

  it('prefers the DUNGEON list when a state carries both — the precedence `roomRectsPx` also uses', () => {
    // Two files pick between the two co-resident room models with the same "dungeon first" rule:
    // `cameraFrame` here, and `scene/groundLayer.ts`'s `roomRectsPx`, which decides which rooms get
    // their own wash/mottle/light pool. `groundLayer.test.ts` pins its copy against a state holding
    // both lists; a 2026-08-27 mutation battery found this copy unread — reversing the ternary
    // passed all 3,310 client tests. If the two ever disagreed, the camera would frame a room out
    // of one model while the floor beneath it was painted from the other.
    //
    // Since 2026-08-27 there is only ONE ternary to reverse: both files call
    // `engine/state/roomModel.ts roomRects`, and a config can no longer carry both models at all
    // (`GameState` throws). This test and `groundLayer.test.ts`'s copy are what prove each call
    // site still READS the shared rule rather than re-inlining its own — they are the reason that
    // refactor was not a leap of faith, since both passed it unchanged.
    //
    // The arena decoy deliberately SHARES the dungeon room's id, because that is the only shape
    // where the wrong list still finds a hit and so fails silently rather than falling back.
    const { deps, fx } = buildDeps();
    const s = stateWithRoomRects();
    s.arenaRoomRects.push({ id: 'r2', rect: { x: toFp(50), y: toFp(50), w: toFp(4), h: toFp(4) } });
    s.players[0]!.roomId = 'r2';
    const loop = new GameLoop(deps, buildHost({ activeState: () => s }));

    loop.update(16);

    // The dungeon r2 (20/0/10/20 grid), not the decoy at 50/50.
    expect(lastFrame(fx)).toEqual({ x: 640, y: -MAX_WALL_HEIGHT, w: 320, h: 640 + MAX_WALL_HEIGHT });
  });

  it('falls back to the arena room list when there are no dungeon rooms (PvP)', () => {
    const { deps, fx } = buildDeps();
    const s = createGameState({ seed: 1, worldW: 2000, worldH: 1000, waves: [], players: [{ start: [100, 100] }] });
    s.arenaRoomRects.push({ id: 'a1', rect: { x: toFp(1), y: toFp(2), w: toFp(8), h: toFp(6) } });
    s.players[0]!.roomId = 'a1';
    const loop = new GameLoop(deps, buildHost({ activeState: () => s }));

    loop.update(16);

    expect(lastFrame(fx)).toEqual({ x: 32, y: 64 - MAX_WALL_HEIGHT, w: 256, h: 192 + MAX_WALL_HEIGHT });
  });

  it('grows the room rect upward by exactly the tallest wall height, and only upward', () => {
    const { deps, fx } = buildDeps();
    const s = stateWithRoomRects();
    s.players[0]!.roomId = 'r1';
    const loop = new GameLoop(deps, buildHost({ activeState: () => s }));

    loop.update(16);

    // r1 is 0/0/15/15 grid = 0/0/480/480 px. x and w are untouched (a standing wall never
    // widens); y moves up by MAX_WALL_HEIGHT and h absorbs exactly that much, so the rect's
    // BOTTOM edge stays put — growing downward instead would push the player off-centre.
    const frame = lastFrame(fx) as { x: number; y: number; w: number; h: number };
    expect(frame.x).toBe(0);
    expect(frame.w).toBe(480);
    expect(frame.y).toBe(-MAX_WALL_HEIGHT);
    expect(frame.y + frame.h).toBe(480);
  });

  it('passes null while the player is in a doorway (roomId cleared) — the camera keeps the whole floor', () => {
    const { deps, fx } = buildDeps();
    const s = stateWithRoomRects();
    s.players[0]!.roomId = undefined; // EnvironmentSystem clears it between rooms
    const loop = new GameLoop(deps, buildHost({ activeState: () => s }));

    loop.update(16);

    expect(lastFrame(fx)).toBeNull();
  });

  it('passes null for a roomId with no rect, rather than throwing (content-bug tolerance)', () => {
    const { deps, fx } = buildDeps();
    const s = stateWithRoomRects();
    s.players[0]!.roomId = 'r_does_not_exist';
    const loop = new GameLoop(deps, buildHost({ activeState: () => s }));

    expect(() => loop.update(16)).not.toThrow();
    expect(lastFrame(fx)).toBeNull();
  });

  it('passes null with no state at all — the camera path must tolerate a run that has not started', () => {
    const { deps, fx } = buildDeps();
    // `playing` with a null state is the one-frame window between beginRun and the
    // engine existing; `menu`/`paused` freeze the last frame and never re-aim the
    // camera at all, so they can't exercise this.
    const loop = new GameLoop(deps, buildHost({ getPhase: () => 'playing', activeState: () => null }));

    expect(() => loop.update(16)).not.toThrow();
    expect(lastFrame(fx)).toBeNull();
  });
});

describe('GameLoop — the animated fixtures are driven every render frame (2026-09-03b)', () => {
  // Exactly the wiring problem the x-ray block below documents, one pass later: `doorFx`,
  // `doorTick` and `RoomBuilder` are each covered by their own tests and every one of them stays
  // green if this call is deleted. Deleting it puts every door back to the still image the live
  // report called 太死板 — and re-freezes `Portal`, which spent three weeks that way because
  // `Portal.interpolate` had no caller at all.
  const SIL = { halfW: 12.96, bodyH: 32 };
  const at = (x: number, y: number, moved = 0) =>
    ({ curX: x, curY: y, prevX: x - moved, prevY: y, bodySilhouette: SIL });
  /** A real `GameState` carrying one locked door — `doorTick` reads only `.locked`, but the state
   *  has to be the real shape because that is what `GameLoop` is typed against. */
  const stateWithLockedDoor = () => {
    const st = createGameState(CFG);
    st.dungeonDoors.push({ locked: true } as unknown as GameState['dungeonDoors'][number]);
    return st;
  };
  /** Prime `CommandBuilder.lastMove` the way a sim step would, without needing an engine: it is
   *  written by `build()`, which is the only thing `doorTick` reads the push out of. */
  const pushInto = (builder: CommandBuilder): void => {
    builder.build(1, 0);
  };

  it("steps the fixtures with this frame's dt and the camera's own world rect", () => {
    const { deps, scene, roomBuilder } = buildDeps();
    scene.player = at(1200, 140.8);
    const loop = new GameLoop(deps, buildHost({ getPhase: () => 'playing' }));

    loop.update(16);

    // The rect is `FxController.worldView` (a Pixi `Rectangle`, width/height) restated in the
    // scene layer's own w/h shape — a conversion that silently culls everything if it is wrong.
    expect(roomBuilder.tickFixtures).toHaveBeenCalledWith(
      16,
      { x: -1e4, y: -1e4, w: 2e4, h: 2e4 },
      { x: 1200, y: 140.8 },
    );
  });

  it('still steps them with no local player, so a door on screen keeps breathing on a menu', () => {
    const { deps, scene, roomBuilder } = buildDeps();
    scene.player = undefined;
    const loop = new GameLoop(deps, buildHost({ getPhase: () => 'victory' }));

    loop.update(16);

    expect(roomBuilder.tickFixtures).toHaveBeenCalledWith(16, expect.anything(), null);
  });

  it('flashes a locked door the player walked into, and shakes the camera once', () => {
    const { deps, scene, roomBuilder, fx, input, builder } = buildDeps();
    // Pressed against the door's south face, pushing north into it, and NOT moving.
    roomBuilder.doorFootprint.mockReturnValue({ x: 100, y: 100, w: 64, h: 20 });
    scene.player = at(132, 128, 0);
    input.state.moveY = -1; // north, into the passage
    pushInto(builder);
    const st = stateWithLockedDoor();
    const loop = new GameLoop(deps, buildHost({ getPhase: () => 'paused', activeState: () => st }));

    loop.update(16);

    expect(roomBuilder.rejectDoor).toHaveBeenCalledWith(0);
    expect(fx.addShake).toHaveBeenCalledTimes(1);
  });

  it('reads the input the SIM was given, not a fresh device poll', () => {
    // `CommandBuilder.lastMove` is written by `build()`, i.e. by a submitted command. A frame that
    // never built one must not resurrect a push into a door however the stick is being held —
    // otherwise a paused game with a finger on the stick flashes every door the player stands at.
    const { deps, scene, roomBuilder, input } = buildDeps();
    roomBuilder.doorFootprint.mockReturnValue({ x: 100, y: 100, w: 64, h: 20 });
    scene.player = at(132, 128, 0);
    input.state.moveY = -1; // held, but never submitted
    const st = stateWithLockedDoor();
    const loop = new GameLoop(deps, buildHost({ getPhase: () => 'paused', activeState: () => st }));

    loop.update(16);

    expect(roomBuilder.tickFixtures).toHaveBeenCalled(); // the fixtures still animate...
    expect(roomBuilder.rejectDoor).not.toHaveBeenCalled(); // ...and nothing was refused
  });

  it('refuses nothing while the player is still moving', () => {
    const { deps, scene, roomBuilder, fx, input } = buildDeps();
    roomBuilder.doorFootprint.mockReturnValue({ x: 100, y: 100, w: 64, h: 20 });
    scene.player = at(132, 128, 3); // the sim moved them 3 px on the tick being drawn
    input.state.moveY = -1;
    pushInto(deps.builder as CommandBuilder);
    const st = stateWithLockedDoor();
    const loop = new GameLoop(deps, buildHost({ getPhase: () => 'paused', activeState: () => st }));

    loop.update(16);

    expect(roomBuilder.rejectDoor).not.toHaveBeenCalled();
    expect(fx.addShake).not.toHaveBeenCalled();
  });

  it('debounces, so holding a direction into a door shoves rather than strobes', () => {
    const { deps, scene, roomBuilder, input } = buildDeps();
    roomBuilder.doorFootprint.mockReturnValue({ x: 100, y: 100, w: 64, h: 20 });
    scene.player = at(132, 128, 0);
    input.state.moveY = -1;
    pushInto(deps.builder as CommandBuilder);
    const st = stateWithLockedDoor();
    const loop = new GameLoop(deps, buildHost({ getPhase: () => 'paused', activeState: () => st }));

    for (let i = 0; i < 12; i++) loop.update(16); // 192 ms, inside the 450 ms cooldown

    expect(roomBuilder.rejectDoor).toHaveBeenCalledTimes(1);
  });

  it('passes an empty door list on a mode with no dungeon doors, rather than throwing', () => {
    // An arena's doors live in `arenaMap` and never in `dungeonDoors`; a menu has no state at all.
    const { deps, scene, roomBuilder } = buildDeps();
    scene.player = at(10, 10);
    const loop = new GameLoop(deps, buildHost({ getPhase: () => 'menu', activeState: () => null }));

    expect(() => loop.update(16)).not.toThrow();
    expect(roomBuilder.tickFixtures).toHaveBeenCalled();
    expect(roomBuilder.rejectDoor).not.toHaveBeenCalled();
  });
});

describe('GameLoop — the occlusion x-ray is driven every render frame', () => {
  // The wiring nothing else can see: `scene/occlusion.ts` and `RoomBuilder` are both covered by
  // their own tests, and both stay green if this call is deleted — only a live look would notice.
  // It rides `updateFx` deliberately, because that wrapper is already called from every render
  // path (playing / paused / menu / offline / online) and already holds the local player.
  const silhouette = { halfW: 12.96, bodyH: 32 };

  it('passes the local player\'s ground point and DRAWN silhouette, with this frame\'s dt', () => {
    const { deps, scene, roomBuilder } = buildDeps();
    scene.player = { curX: 1200, curY: 140.8, prevX: 1200, prevY: 140.8, bodySilhouette: silhouette };
    const loop = new GameLoop(deps, buildHost({ getPhase: () => 'playing' }));

    loop.update(16);

    expect(roomBuilder.updateOcclusion).toHaveBeenCalledWith(
      [{ x: 1200, y: 140.8, halfW: 12.96, bodyH: 32 }],
      16,
    );
  });

  it('passes an empty list with no local player, so a block cannot freeze mid-x-ray on a menu', () => {
    const { deps, scene, roomBuilder } = buildDeps();
    scene.player = undefined;
    const loop = new GameLoop(deps, buildHost({ getPhase: () => 'victory' }));

    loop.update(16);

    expect(roomBuilder.updateOcclusion).toHaveBeenCalledWith([], 16);
  });

  it('includes every live enemy, so one gets its own x-ray even with no player in the room at all (live report *"如果只有怪物在墙下面的话，就看不到怪物了"*)', () => {
    const { deps, scene, roomBuilder } = buildDeps();
    scene.player = undefined;
    scene.enemies = [{ curX: 40, curY: 60, bodySilhouette: silhouette }];
    const loop = new GameLoop(deps, buildHost({ getPhase: () => 'playing' }));

    loop.update(16);

    expect(roomBuilder.updateOcclusion).toHaveBeenCalledWith(
      [{ x: 40, y: 60, halfW: 12.96, bodyH: 32 }],
      16,
    );
  });

  it('passes both the player and every enemy together', () => {
    const { deps, scene, roomBuilder } = buildDeps();
    scene.player = { curX: 1200, curY: 140.8, prevX: 1200, prevY: 140.8, bodySilhouette: silhouette };
    scene.enemies = [{ curX: 40, curY: 60, bodySilhouette: silhouette }];
    const loop = new GameLoop(deps, buildHost({ getPhase: () => 'playing' }));

    loop.update(16);

    expect(roomBuilder.updateOcclusion).toHaveBeenCalledWith(
      [
        { x: 40, y: 60, halfW: 12.96, bodyH: 32 },
        { x: 1200, y: 140.8, halfW: 12.96, bodyH: 32 },
      ],
      16,
    );
  });

  it('includes every live pickup even with no player/enemy in the room at all (live report *"被墙挡住的物品，只有角色走到墙下的时候才显示"*) — a drop can\'t walk into the hidden band itself, so it has to be a focus on its own account', () => {
    const { deps, scene, roomBuilder } = buildDeps();
    scene.player = undefined;
    scene.pickups = [{ curX: 25, curY: 50, bodySilhouette: silhouette }];
    const loop = new GameLoop(deps, buildHost({ getPhase: () => 'playing' }));

    loop.update(16);

    expect(roomBuilder.updateOcclusion).toHaveBeenCalledWith(
      [{ x: 25, y: 50, halfW: 12.96, bodyH: 32 }],
      16,
    );
  });

  it('passes the player, every enemy and every pickup together, pickups last', () => {
    const { deps, scene, roomBuilder } = buildDeps();
    scene.player = { curX: 1200, curY: 140.8, prevX: 1200, prevY: 140.8, bodySilhouette: silhouette };
    scene.enemies = [{ curX: 40, curY: 60, bodySilhouette: silhouette }];
    scene.pickups = [{ curX: 25, curY: 50, bodySilhouette: silhouette }];
    const loop = new GameLoop(deps, buildHost({ getPhase: () => 'playing' }));

    loop.update(16);

    expect(roomBuilder.updateOcclusion).toHaveBeenCalledWith(
      [
        { x: 40, y: 60, halfW: 12.96, bodyH: 32 },
        { x: 1200, y: 140.8, halfW: 12.96, bodyH: 32 },
        { x: 25, y: 50, halfW: 12.96, bodyH: 32 },
      ],
      16,
    );
  });

  it('keeps running while PAUSED — a frozen frame still has to show the character', () => {
    const { deps, scene, roomBuilder } = buildDeps();
    scene.player = { curX: 10, curY: 20, prevX: 10, prevY: 20, bodySilhouette: silhouette };
    const loop = new GameLoop(deps, buildHost({ getPhase: () => 'paused' }));

    loop.update(16);

    expect(roomBuilder.updateOcclusion).toHaveBeenCalledTimes(1);
  });

  it('runs once per RENDER frame, not once per sim tick', () => {
    // A fade measured in ms has to advance on frames where no sim tick happened at all, or it
    // steps in 33 ms jumps at 60 fps and reads as a stutter rather than a fade.
    const { deps, scene, roomBuilder } = buildDeps();
    const engine = createGameEngine(CFG);
    scene.player = { curX: 0, curY: 0, prevX: 0, prevY: 0, bodySilhouette: silhouette };
    const loop = new GameLoop(deps, buildHost({ getEngine: () => engine }));

    loop.update(8); // well under one sim tick
    loop.update(8);
    expect(roomBuilder.updateOcclusion).toHaveBeenCalledTimes(2);
  });

  it('reuses its scratch array across frames without leaking a stale focus when the count shrinks then grows back', () => {
    // `GameLoop.occlusionFociScratch` is written into in place and only truncated (never
    // reallocated) each frame — the same shape of optimization as `Scene.seenScratch` — so the
    // failure mode worth pinning down is specifically a shrink-then-regrow: does a frame with
    // fewer foci than the last one actually drop the extra slots (`foci.length = n`), and does a
    // later frame that grows again get FRESH values rather than whatever a dropped slot's
    // reused object last held?
    const { deps, scene, roomBuilder } = buildDeps();
    scene.player = { curX: 1200, curY: 140.8, prevX: 1200, prevY: 140.8, bodySilhouette: silhouette };
    scene.enemies = [{ curX: 40, curY: 60, bodySilhouette: silhouette }];
    // Phase 'victory' (not 'playing'): three repeated calls just need updateFx wired every
    // frame, not a real sim to step — same reason the "empty list with no local player" test
    // above picks a non-'playing' phase.
    const loop = new GameLoop(deps, buildHost({ getPhase: () => 'victory' }));

    loop.update(16); // 2 foci: one enemy + the player
    expect(roomBuilder.updateOcclusion).toHaveBeenLastCalledWith(
      [
        { x: 40, y: 60, halfW: 12.96, bodyH: 32 },
        { x: 1200, y: 140.8, halfW: 12.96, bodyH: 32 },
      ],
      16,
    );

    scene.player = undefined;
    scene.enemies = [];
    loop.update(16); // shrinks to 0 — must not still report either frame-1 object
    expect(roomBuilder.updateOcclusion).toHaveBeenLastCalledWith([], 16);

    scene.enemies = [{ curX: 5, curY: 6, bodySilhouette: silhouette }];
    loop.update(16); // grows back to 1 — must be this frame's data, not a stale reused slot
    expect(roomBuilder.updateOcclusion).toHaveBeenLastCalledWith(
      [{ x: 5, y: 6, halfW: 12.96, bodyH: 32 }],
      16,
    );
  });
});

// The `?pickupDebug=1` overlay (scene/PickupDebugOverlay.ts). Same argument commit b4b384d
// records for the render-loop line it pinned: the overlay has a thorough suite of its own and
// `gameQueryParams.ts` decides whether it is built at all, but nothing anywhere could see whether
// the loop actually DRIVES it — deleting the one call leaves it mounted and empty, redrawing
// never, with the whole suite green. It rides `updateHud` because that is where the live state has
// already been fetched and where `phase === 'playing'` has already been established.
describe('GameLoop — the pickup debug overlay', () => {
  it('redraws the overlay with this frame\'s live state', () => {
    const overlay = { update: vi.fn() };
    const { deps } = buildDeps({ pickupDebugOverlay: overlay as unknown as PickupDebugOverlay });
    const engine = createGameEngine(CFG);
    const loop = new GameLoop(deps, buildHost({ getEngine: () => engine, activeState: () => engine.state }));

    loop.update(16);

    // The state itself, not a copy: the overlay reads `state.pickups` and every entity id it
    // labels comes out of that object.
    expect(overlay.update).toHaveBeenCalledWith(engine.state);
  });

  it('runs the frame with no overlay at all — which is every normal session', () => {
    const { deps } = buildDeps(); // pickupDebugOverlay is null unless `?pickupDebug=1`
    const engine = createGameEngine(CFG);
    const loop = new GameLoop(deps, buildHost({ getEngine: () => engine, activeState: () => engine.state }));

    expect(() => loop.update(16)).not.toThrow();
  });
});

// The local player's glow is the one PERSISTENT light in the registry, re-registered at the
// player's current position every render frame rather than tracked as a spawn. Since
// 2026-08-24 that registration is ALL `updateFx` does for lighting — the set is uploaded to
// the one scene-lighting pass by `FxController.updateCamera`, not applied per actor here
// (`Scene.applyLighting` is gone). These pin the half that stayed.
describe('GameLoop — the local player glow (design/01 milestone 2)', () => {
  const silhouette = { halfW: 1, bodyH: 1 };

  it('re-registers the glow at the player position every frame under the same id', () => {
    // One id, every frame, is what makes it a replace-in-place rather than an accumulating
    // leak: `LightRegistry.addPersistent` keys on it. A frame-unique id would put a trail of
    // stale glows along the player's path and quietly exhaust the shader's light slots.
    const { deps, scene, fx } = buildDeps();
    const loop = new GameLoop(deps, buildHost());

    scene.player = { curX: 10, curY: 20, prevX: 10, prevY: 20, bodySilhouette: silhouette };
    loop.update(16);
    scene.player = { curX: 90, curY: 40, prevX: 90, prevY: 40, bodySilhouette: silhouette };
    loop.update(16);

    const calls = fx.lights.addPersistent.mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls.every((c: unknown[]) => c[0] === 'local')).toBe(true);
    expect(calls[0]![1]).toMatchObject({ x: 10, y: 20 });
    expect(calls[1]![1]).toMatchObject({ x: 90, y: 40 });
  });

  it('drops the glow when there is no player view, rather than leaving it at a stale position', () => {
    const { deps, scene, fx } = buildDeps();
    const loop = new GameLoop(deps, buildHost());

    scene.player = { curX: 10, curY: 20, prevX: 10, prevY: 20, bodySilhouette: silhouette };
    loop.update(16);
    scene.player = undefined;
    loop.update(16);

    expect(fx.lights.removePersistent).toHaveBeenCalledWith('local');
  });

  it('registers it from every render path, not just `playing`', () => {
    // `updateFx` is the one wrapper every phase goes through (playing / paused / idle /
    // online), which is exactly why the registration lives there and needs no per-path wiring.
    for (const phase of ['playing', 'paused', 'victory'] as const) {
      const { deps, scene, fx } = buildDeps();
      const loop = new GameLoop(deps, buildHost({ getPhase: () => phase }));
      scene.player = { curX: 1, curY: 2, prevX: 1, prevY: 2, bodySilhouette: silhouette };
      loop.update(16);
      expect(fx.lights.addPersistent).toHaveBeenCalledTimes(1);
    }
  });

  it('gives the glow a real radius and a warm colour — a light with neither would be invisible', () => {
    // The shader drops a light with radius or intensity 0 outright (`LightRegistry.snapshot`),
    // so these are not decoration: a regression to 0 here would silently unlight the player.
    const { deps, scene, fx } = buildDeps();
    const loop = new GameLoop(deps, buildHost());
    scene.player = { curX: 0, curY: 0, prevX: 0, prevY: 0, bodySilhouette: silhouette };
    loop.update(16);

    const light = fx.lights.addPersistent.mock.calls[0]![1] as { radius: number; intensity: number; color: number };
    expect(light.radius).toBeGreaterThan(0);
    expect(light.intensity).toBeGreaterThan(0);
    expect(light.color).toBeGreaterThan(0);
  });
});

/**
 * The spawn count's one piece of wiring (design/11, 2026-09-02).
 *
 * `Scene` counts the actor views it built and `EventReactor` turns a count into a cue; both
 * are tested where they live. What only exists here is the ARGUMENT between them, and dropping
 * it is the quietest possible regression: `consume(events)` still compiles, every other test
 * in every file stays green, and the game simply never plays a spawn cue again. So this is
 * about one parameter.
 */
describe('GameLoop — hands the reconcile\'s spawn count to the reactor', () => {
  /** One real sim tick down the offline path — the same shape the stepping cases above use. */
  function stepOnce(deps: GameLoopDeps) {
    const engine = createGameEngine(CFG);
    new GameLoop(deps, buildHost({ getEngine: () => engine })).update(SIM_DT_MS_FOR_TESTS);
  }

  it('passes what THIS frame\'s reconcile reported, not a constant', () => {
    const { deps, scene, events } = buildDeps();
    scene.spawnedActors = 4;
    stepOnce(deps);
    expect(events.consume).toHaveBeenCalledTimes(1);
    expect(events.consume.mock.calls[0]![1]).toBe(4);
  });

  it('passes zero on a frame where nothing materialised', () => {
    // The overwhelmingly common case: a hard-coded 1, or a truthy default, would fire a spawn
    // voice on every frame of the run.
    const { deps, scene, events } = buildDeps();
    scene.spawnedActors = 0;
    stepOnce(deps);
    expect(events.consume.mock.calls[0]![1]).toBe(0);
  });

  it('reads the count AFTER the reconcile that produces it', () => {
    // Order is the whole correctness here, and it is invisible in the source: reading
    // `spawnedActors` before `reconcile()` would report the PREVIOUS frame's spawns forever —
    // one frame late, and permanently wrong on the frame that matters most (a run's first).
    // The fake reconcile sets the count, so a read taken too early sees the initial 0.
    const { deps, scene, events } = buildDeps();
    scene.spawnedActors = 0;
    scene.reconcile.mockImplementation(() => {
      scene.spawnedActors = 7;
    });
    stepOnce(deps);
    expect(events.consume.mock.calls[0]![1]).toBe(7);
  });
});
