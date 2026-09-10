import { describe, it, expect } from 'vitest';
import {
  Button,
  createGameEngine,
  hashState,
  makeCommand,
  parseReplayFileText,
  quantizeMove,
  runReplay,
  type EngineConfig,
  type ReplayFile,
} from '@dd/engine';
import { MatchRecorder } from './MatchRecorder';
import { saveMarkedReplay } from './replayDownload';
import { buildDungeonRunConfig } from './offlineConfig';

const DUNGEON = buildDungeonRunConfig({
  seed: 0xda1d,
  coop: false,
  localSeat: { skinId: 'vanguard', loadout: [] },
  allySkinId: 'skirmisher',
});

/**
 * Drive an engine the way GameLoop does — `engine.submit(...)` then `engine.advance(f)`
 * — so what these tests exercise is the real submit path, not a hand-fed source.
 */
function play(config: EngineConfig, recorder: MatchRecorder, ticks: number) {
  const engine = createGameEngine(config, recorder.begin('dungeon', config));
  for (let f = 1; f <= ticks; f++) {
    const { moveBrad, moveMag } = quantizeMove(Math.sin(f * 0.11), Math.cos(f * 0.07));
    engine.submit(makeCommand({ owner: 0, tick: f, moveBrad, moveMag, buttons: f % 5 ? Button.FIRE : 0 }));
    engine.advance(f);
  }
  return engine;
}

describe('MatchRecorder (an offline run records itself, for free)', () => {
  it('packs a file that replays the live run exactly', () => {
    const recorder = new MatchRecorder();
    const live = play(DUNGEON, recorder, 400);

    const file = recorder.pack(live.state.tick, 1_700_000_000_000)!;
    expect(file).not.toBeNull();

    // Through text, like the download: a client-side regression (a config the recorder
    // holds by reference and the run then mutates, say) shows up as a hash mismatch.
    const replayed = runReplay(parseReplayFileText(JSON.stringify(file)).replay, 400);
    expect(hashState(replayed.state)).toBe(hashState(live.state));
    expect(live.state.tick).toBe(400);
  });

  it('records the commands the engine was actually driven with', () => {
    const recorder = new MatchRecorder();
    play(DUNGEON, recorder, 120);
    const file = recorder.pack(120, 0)!;
    expect(file.replay.commands).toHaveLength(120);
    expect(file.label).toBe('dungeon');
    expect(file.ticks).toBe(120);
  });

  it('has nothing to pack before a run, or after one is dropped', () => {
    const recorder = new MatchRecorder();
    expect(recorder.recording).toBe(false);
    expect(recorder.pack(10, 0)).toBeNull();
    expect(recorder.mark(10, 'x')).toBe(false);

    play(DUNGEON, recorder, 10);
    expect(recorder.recording).toBe(true);

    recorder.end();
    expect(recorder.recording).toBe(false);
    expect(recorder.pack(10, 0)).toBeNull();
  });

  it('a fresh run drops the previous one entirely', () => {
    const recorder = new MatchRecorder();
    play(DUNGEON, recorder, 200);
    recorder.mark(50, 'first run');
    play(DUNGEON, recorder, 30);

    const file = recorder.pack(30, 0)!;
    expect(file.replay.commands).toHaveLength(30);
    expect(file.marks).toEqual([]); // the first run's mark did not survive
  });

  it('accumulates marks in the order they were made', () => {
    const recorder = new MatchRecorder();
    play(DUNGEON, recorder, 100);
    expect(recorder.mark(30, 'a')).toBe(true);
    expect(recorder.mark(90, 'b')).toBe(true);
    expect(recorder.pack(100, 0)!.marks).toEqual([
      { tick: 30, note: 'a' },
      { tick: 90, note: 'b' },
    ]);
  });
});

describe('saveMarkedReplay (the save verb, without a host)', () => {
  it('marks the tick, saves the file, and reports the name back', () => {
    const recorder = new MatchRecorder();
    play(DUNGEON, recorder, 250);

    let saved: ReplayFile | null = null;
    const r = saveMarkedReplay(recorder, 250, 1_700_000_000_000, (f) => {
      saved = f;
      return 'ddreplay-dungeon-1700000000000.json';
    });

    expect(r).toEqual({ ok: true, name: 'ddreplay-dungeon-1700000000000.json', tick: 250 });
    // The mark is what tells the harness where to look — the whole point of the control.
    expect(saved!.marks).toEqual([{ tick: 250, note: 'hotkey at tick 250' }]);
    expect(saved!.ticks).toBe(250);
  });

  it('reports no-run when there is no offline run, instead of doing nothing', () => {
    const recorder = new MatchRecorder();
    let called = false;
    const r = saveMarkedReplay(recorder, 10, 0, () => {
      called = true;
      return 'x';
    });
    expect(r).toEqual({ ok: false, reason: 'no-run' });
    expect(called).toBe(false);
  });

  it('reports unsupported when the host cannot download (WeChat: no Blob, no anchor)', () => {
    const recorder = new MatchRecorder();
    play(DUNGEON, recorder, 20);
    expect(saveMarkedReplay(recorder, 20, 0, () => null)).toEqual({ ok: false, reason: 'unsupported' });
  });

  it('every reason is distinguishable — a caller can localise all three outcomes', () => {
    // The whole reason this returns a result instead of a sentence: two failures that
    // read the same to a player ("nothing happened") need different words, and the
    // module that writes the file has no business choosing them.
    const empty = new MatchRecorder();
    const live = new MatchRecorder();
    play(DUNGEON, live, 5);
    const outcomes = [
      saveMarkedReplay(empty, 1, 0, () => 'n'),
      saveMarkedReplay(live, 5, 0, () => null),
      saveMarkedReplay(live, 5, 0, () => 'n'),
    ];
    expect(outcomes.map((o) => (o.ok ? 'ok' : o.reason))).toEqual(['no-run', 'unsupported', 'ok']);
  });
});

/**
 * `resume` / `runConfig` / `recordedCommands` — what save-and-continue needs from the
 * recorder (design/05 "Only the boss floor ends a run", ENGINE_VERSION 61).
 *
 * The load-bearing property is that a resumed run keeps recording as ONE stream rather than
 * a fragment starting at the resume. Two things depend on it: saving again later has to
 * produce a save that replays from tick 1 (a save that only replays from the middle is not a
 * save), and F9 after a resume has to export a repro of the whole run.
 */
describe('MatchRecorder — resuming a saved run', () => {
  it('pre-loads the stream, so the source can drive the fast-forward', () => {
    const first = new MatchRecorder();
    play(DUNGEON, first, 20);
    const stream = first.recordedCommands()!;

    const resumed = new MatchRecorder();
    const source = resumed.resume('dungeon', DUNGEON, stream);
    // The commands are IN the source before any engine exists — which is what lets
    // `resumeSavedRun` build an engine on it and advance straight to the saved tick.
    expect(source.take(1)).toHaveLength(1);
    expect(source.take(20)).toHaveLength(1);
    expect(source.take(21)).toEqual([]); // and nothing beyond it
  });

  it('a resumed engine replayed off that source lands on the original state', () => {
    const first = new MatchRecorder();
    const original = play(DUNGEON, first, 30);

    const resumed = new MatchRecorder();
    const source = resumed.resume('dungeon', DUNGEON, first.recordedCommands()!);
    const engine = createGameEngine(DUNGEON, source);
    for (let f = 1; f <= 30; f++) engine.advance(f);
    expect(hashState(engine.state)).toBe(hashState(original.state));
  });

  it('keeps recording into the SAME stream, so a second save replays from tick 1', () => {
    // The failure this prevents: a resume that began a fresh recording would save a stream
    // starting at tick 31, which replays 30 ticks of idle-hold into a completely different
    // run. Nothing else would notice — the file would parse, and the version would match.
    const first = new MatchRecorder();
    play(DUNGEON, first, 30);

    const resumed = new MatchRecorder();
    const source = resumed.resume('dungeon', DUNGEON, first.recordedCommands()!);
    const engine = createGameEngine(DUNGEON, source);
    for (let f = 1; f <= 30; f++) engine.advance(f);
    for (let f = 31; f <= 40; f++) {
      const { moveBrad, moveMag } = quantizeMove(0.5, 0.5);
      engine.submit(makeCommand({ owner: 0, tick: f, moveBrad, moveMag, buttons: 0 }));
      engine.advance(f);
    }

    const combined = resumed.recordedCommands()!;
    expect(combined).toHaveLength(40);
    expect(combined[0]!.tick).toBe(1);
    expect(combined.at(-1)!.tick).toBe(40);
  });

  it('and F9 after a resume exports a replay of the whole run, not of the tail', () => {
    const first = new MatchRecorder();
    play(DUNGEON, first, 12);
    const resumed = new MatchRecorder();
    resumed.resume('dungeon', DUNGEON, first.recordedCommands()!);
    const file = resumed.pack(12, 0)!;
    expect(file.replay.commands).toHaveLength(12);
    expect(file.replay.commands[0]!.tick).toBe(1);
  });

  it('drops whatever was being recorded before, like `begin` does', () => {
    const recorder = new MatchRecorder();
    play(DUNGEON, recorder, 25);
    recorder.resume('dungeon', DUNGEON, []);
    expect(recorder.recordedCommands()).toEqual([]);
  });
});

describe('MatchRecorder — runConfig / recordedCommands', () => {
  it('answers null for both when nothing is being recorded', () => {
    const recorder = new MatchRecorder();
    expect(recorder.runConfig).toBeNull();
    expect(recorder.recordedCommands()).toBeNull();
  });

  it('exposes the config the run was BUILT from — the only surviving copy of its loadout', () => {
    // `beginRun` spends the account's crafted loadout at run start, so this is where the save
    // path reads back what the run is carrying. A `null` here would silently pack a save
    // with an empty loadout, and the resumed run would spawn with the starter kit instead.
    const config = buildDungeonRunConfig({
      seed: 7, coop: false, localSeat: { skinId: 'juggernaut', loadout: ['cryobolt'] }, allySkinId: 'skirmisher',
    });
    const recorder = new MatchRecorder();
    play(config, recorder, 3);
    expect(recorder.runConfig).toBe(config);
    expect(recorder.runConfig!.loadout).toEqual(['cryobolt']);
  });

  it('goes back to null once the run ends', () => {
    const recorder = new MatchRecorder();
    play(DUNGEON, recorder, 5);
    recorder.end();
    expect(recorder.runConfig).toBeNull();
    expect(recorder.recordedCommands()).toBeNull();
  });

  it('reports the stream in tick order, matching what `pack` embeds', () => {
    const recorder = new MatchRecorder();
    play(DUNGEON, recorder, 15);
    const bare = recorder.recordedCommands()!;
    expect(bare.map((c) => c.tick)).toEqual(recorder.pack(15, 0)!.replay.commands.map((c) => c.tick));
  });
});
