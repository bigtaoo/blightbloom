import { describe, it, expect } from 'vitest';
import { ENGINE_VERSION } from '@dd/engine/config';
import { Button, LocalInputSource, type PlayerCommand } from '@dd/engine/state/commands';
import { makeCommand, quantizeMove } from '@dd/engine/state/input';
import { hashState, runHeadless, runReplay, serializeState } from '@dd/engine/replay';
import {
  packReplayFile,
  parseReplayFile,
  parseReplayFileText,
  replayFileName,
  REPLAY_FILE_KIND,
  REPLAY_FILE_VERSION,
} from '@dd/engine/replayFile';
import type { EngineConfig } from '@dd/engine/state/GameState';
import { EMBER_DUNGEON } from '@dd/engine/world/rooms/ember';
import { EMBER_L1_ROOMS } from '@dd/engine/world/rooms/emberLevel1';

// The real shipped PvE config — the mode every "无法拾取" report has come from. Using
// the real one is the point of these tests: it is the config with the most structure
// in it (an authored 14-piece room library plus five floor maps), so it is the config
// most likely to hold something JSON cannot carry.
const DUNGEON: EngineConfig = {
  seed: 90210,
  worldW: 800,
  worldH: 800,
  waves: [],
  skinId: 'vanguard',
  dungeon: { config: EMBER_DUNGEON, library: EMBER_L1_ROOMS },
};

// A flat config too, so a failure can be attributed to the envelope rather than to
// dungeon content.
const FLAT: EngineConfig = {
  seed: 4242,
  worldW: 800,
  worldH: 800,
  playerStart: [400, 400],
  waves: [[[520, 400], [280, 400]], [[400, 280]]],
};

function scriptedCommand(tick: number): PlayerCommand {
  const { moveBrad, moveMag } = quantizeMove(Math.sin(tick * 0.07), Math.cos(tick * 0.05));
  let buttons = Button.FIRE;
  if (tick % 37 === 0) buttons |= Button.SWAP_WEAPON;
  if (tick % 53 === 0) buttons |= Button.INTERACT;
  return makeCommand({ owner: 0, tick, moveBrad, moveMag, buttons });
}

/** Record a live headless run, exactly the way the client's recorder does. */
function record(config: EngineConfig, ticks: number) {
  const live = new LocalInputSource();
  for (let t = 1; t <= ticks; t++) live.submit(scriptedCommand(t));
  const engine = runHeadless(config, live, ticks);
  const file = packReplayFile({
    config,
    commands: live.recorded(),
    ticks,
    label: 'dungeon',
    marks: [{ tick: 123, note: 'here' }],
    recordedAtMs: 1_700_000_000_000,
  });
  return { engine, file };
}

describe('replay file envelope (a seed is not a repro — the input stream is)', () => {
  it('a real dungeon run survives JSON text and replays to the same state', () => {
    const { engine, file } = record(DUNGEON, 600);

    // Through actual text, not a structural clone: this is what catches anything the
    // config carries that JSON cannot (a Map, a class instance, a function, undefined).
    const round = parseReplayFileText(JSON.stringify(file));
    const replayed = runReplay(round.replay, 600);

    expect(serializeState(replayed.state)).toEqual(serializeState(engine.state));
    expect(hashState(replayed.state)).toBe(hashState(engine.state));
    // And the run actually did something — a hash match on two empty runs proves nothing.
    expect(replayed.state.tick).toBe(600);
    expect(engine.state.dungeonRooms.length).toBeGreaterThan(0);
  });

  it('a flat config round-trips too, so a dungeon failure is attributable', () => {
    const { engine, file } = record(FLAT, 400);
    const replayed = runReplay(parseReplayFileText(JSON.stringify(file)).replay, 400);
    expect(hashState(replayed.state)).toBe(hashState(engine.state));
  });

  it('carries the metadata a reader needs, and the marks a human supplied', () => {
    const { file } = record(DUNGEON, 200);
    const round = parseReplayFileText(JSON.stringify(file));
    expect(round.kind).toBe(REPLAY_FILE_KIND);
    expect(round.fileVersion).toBe(REPLAY_FILE_VERSION);
    expect(round.engineVersion).toBe(ENGINE_VERSION);
    expect(round.replay.version).toBe(ENGINE_VERSION);
    expect(round.ticks).toBe(200);
    expect(round.label).toBe('dungeon');
    expect(round.marks).toEqual([{ tick: 123, note: 'here' }]);
    expect(round.recordedAtMs).toBe(1_700_000_000_000);
  });

  it('records every submitted tick, sparsely — a held key is one command per frame', () => {
    const { file } = record(FLAT, 400);
    expect(file.replay.commands).toHaveLength(400);
    expect(file.replay.commands[0]!.tick).toBe(1);
    expect(file.replay.commands[file.replay.commands.length - 1]!.tick).toBe(400);
    // Ticks are ascending: ReplayInputSource buckets by tick, so a shuffled stream
    // would still replay, but a reader looking for "what happened at tick N" could not
    // trust the order it reads.
    for (let i = 1; i < file.replay.commands.length; i++) {
      expect(file.replay.commands[i]!.tick).toBeGreaterThanOrEqual(file.replay.commands[i - 1]!.tick);
    }
  });

  it('the file a real report would carry is small enough to hand over', () => {
    // 3600 ticks is a minute of play at 60 Hz. Two separate budgets, because the two
    // halves fail for different reasons and a single total would hide both.
    //
    // The config is embedded whole on purpose (see replayFile.ts's header). Measured
    // 17.7 kB for the real dungeon — the budget is set to catch someone embedding
    // something that is not level geometry (a texture, a manifest, a baked field),
    // which is the failure that would force the descriptor tradeoff to be revisited.
    const { file } = record(DUNGEON, 3600);
    const configBytes = JSON.stringify(file.replay.config).length;
    expect(configBytes).toBeLessThan(64 * 1024);

    // The stream is linear in run length, so its cost is per tick, not per file:
    // measured ~100 B/tick, i.e. ~360 kB/minute, ~7 MB for a 20-minute run. A widened
    // PlayerCommand would show up here first.
    const streamBytes = JSON.stringify(file.replay.commands).length;
    expect(streamBytes / 3600).toBeLessThan(150);
  });
});

describe('parseReplayFile fails loud rather than replaying garbage (design/08)', () => {
  const good = () => JSON.parse(JSON.stringify(record(FLAT, 30).file)) as Record<string, unknown>;

  it('rejects a foreign JSON on identity, not on a missing field', () => {
    expect(() => parseReplayFile({ hello: 'world' })).toThrow(/Not a Blightbloom replay/);
    expect(() => parseReplayFileText('[]')).toThrow(/not an object/);
    expect(() => parseReplayFileText('{oops')).toThrow(/not valid JSON/);
  });

  it('rejects an envelope version it cannot read', () => {
    expect(() => parseReplayFile({ ...good(), fileVersion: REPLAY_FILE_VERSION + 1 })).toThrow(
      /Replay file version/,
    );
  });

  it('rejects a file that disagrees with itself about the engine version', () => {
    const f = good();
    (f.replay as Record<string, unknown>).version = ENGINE_VERSION + 1;
    expect(() => parseReplayFile(f)).toThrow(/disagrees with itself/);
  });

  it('rejects a malformed command instead of replaying it as idle', () => {
    const f = good();
    const cmds = (f.replay as Record<string, unknown>).commands as Record<string, unknown>[];
    cmds[5]!.tick = 'soon';
    expect(() => parseReplayFile(f)).toThrow(/replay\.commands\[5\]\.tick is not an integer/);

    const g = good();
    const gcmds = (g.replay as Record<string, unknown>).commands as Record<string, unknown>[];
    delete gcmds[2]!.type;
    expect(() => parseReplayFile(g)).toThrow(/replay\.commands\[2\]\.type is not "input"/);
  });

  it('rejects a commands field that is not an array, by name', () => {
    // Without the guard `.map` still throws, so the mutant survived on "it throws at all".
    // What the guard buys is a message that names the field instead of "map is not a
    // function", which is the difference between a two-minute and a twenty-minute diagnosis.
    const f = good();
    (f.replay as Record<string, unknown>).commands = { 0: 'nope' };
    expect(() => parseReplayFile(f)).toThrow(/replay\.commands is not an array/);
  });

  it('rejects an out-of-range brad instead of letting trig read past its table', () => {
    const f = good();
    const cmds = (f.replay as Record<string, unknown>).commands as Record<string, unknown>[];
    cmds[0]!.moveBrad = 70000;
    expect(() => parseReplayFile(f)).toThrow(/is not a brad/);
  });

  it('rejects a config with no seed — the one field a replay cannot do without', () => {
    const f = good();
    delete (f.replay as Record<string, unknown> as { config: Record<string, unknown> }).config.seed;
    expect(() => parseReplayFile(f)).toThrow(/seed is not a number/);
  });

  it('tolerates absent optional metadata, deriving ticks from the stream', () => {
    const f = good();
    delete f.recordedAtMs;
    delete f.label;
    delete f.ticks;
    delete f.marks;
    const parsed = parseReplayFile(f);
    expect(parsed.ticks).toBe(30); // highest tick in the stream
    expect(parsed.marks).toEqual([]);
    expect(parsed.label).toBe('');
  });
});

describe('what the parser tolerates ON PURPOSE — an old file is still readable', () => {
  const good = () => JSON.parse(JSON.stringify(record(FLAT, 30).file)) as Record<string, unknown>;

  it("reads a file recorded by an OLDER engine instead of refusing it", () => {
    // Deliberate, and stated in parseReplayFile's doc comment: reading an old file's
    // METADATA is legitimate — it is how you find out which version a report came from —
    // and `ReplayInputSource` is the thing that refuses to REPLAY it. Nothing pinned that
    // tolerance, only the self-agreement check next door, so adding a strict
    // `engineVersion !== ENGINE_VERSION` throw here survived the suite: every existing
    // fixture is packed at today's version and so never exercises the older-file path.
    const old = ENGINE_VERSION - 1;
    const f = good();
    f.engineVersion = old;
    (f.replay as Record<string, unknown>).version = old;

    const parsed = parseReplayFile(f);
    // Round-trips as recorded, not silently normalised to today's version — a report
    // relabelled with the reader's version is a report that lies about its own origin.
    expect(parsed.engineVersion).toBe(old);
    expect(parsed.replay.version).toBe(old);
  });

  it('derives ticks from the HIGHEST tick in the stream, not from how many commands there are', () => {
    // The round-trip fixtures above submit exactly one command per tick, so
    // `max(tick)` and `commands.length` are the same number there and a
    // `return commands.length` mutant is invisible. A sparse two-owner stream separates
    // them: three commands, highest tick 9. (An ascending stream also kills the
    // comparison being reversed — with `<` the running max never leaves 0.)
    const f = good();
    delete f.ticks;
    (f.replay as Record<string, unknown>).commands = [
      makeCommand({ owner: 0, tick: 5, ...quantizeMove(1, 0), buttons: 0 }),
      makeCommand({ owner: 1, tick: 5, ...quantizeMove(0, 1), buttons: 0 }),
      makeCommand({ owner: 0, tick: 9, ...quantizeMove(-1, 0), buttons: 0 }),
    ];

    const parsed = parseReplayFile(f);
    expect(parsed.replay.commands).toHaveLength(3);
    expect(parsed.ticks).toBe(9);
  });

  it('a file with no recordedAtMs reads as 0, not as "now"', () => {
    // A `Date.now()` fallback survives everything else in this file: no test asserted the
    // value, and a wall-clock default would silently re-date every old file to the moment
    // it was READ — destroying the one field that tells two reports of the same bug apart.
    const f = good();
    delete f.recordedAtMs;
    expect(parseReplayFile(f).recordedAtMs).toBe(0);
  });

  it('rejects a mark whose tick is not an integer, rather than carrying it into a report', () => {
    // Marks are the whole reason the format has them (a bug report is a tick, not a run),
    // and `replayStopTick` does arithmetic on this value: a string tick would freeze
    // playback at NaN, which is the "replay garbage" outcome design/08 forbids.
    const f = good();
    f.marks = [{ tick: 'later', note: 'here' }];
    expect(() => parseReplayFile(f)).toThrow(/marks\[0\]\.tick is not an integer/);
  });
});

describe('packReplayFile snapshots what it is handed', () => {
  it('copies the marks array — the recorder goes on mutating its own', () => {
    // `MatchRecorder.pack` hands over its LIVE `marks` array and keeps collecting into it
    // after the save (that is what makes F9 pressable twice). Passing `opts.marks` straight
    // through would alias it into the already-packed file, so the SECOND press would
    // retroactively add a mark to the FIRST file's bytes — for a format whose only job is
    // to say "it happened here", a mark that appears after the fact is the worst defect
    // available. Copying each mark, not just slicing the array, is the same argument one
    // level down.
    const marks = [{ tick: 10, note: 'first' }];
    const file = packReplayFile({
      config: FLAT, commands: [], ticks: 10, label: 'x', marks, recordedAtMs: 0,
    });

    marks.push({ tick: 20, note: 'second' });
    marks[0]!.note = 'edited';

    expect(file.marks).toEqual([{ tick: 10, note: 'first' }]);
    expect(file.marks[0]).not.toBe(marks[0]);
  });

  it('packs an empty mark list when none was supplied', () => {
    const file = packReplayFile({
      config: FLAT, commands: [], ticks: 0, label: 'x', recordedAtMs: 0,
    });
    expect(file.marks).toEqual([]);
  });
});

describe('replayFileName', () => {
  it('is filesystem-safe and carries the label and the clock', () => {
    expect(replayFileName('dungeon', 1700000000000)).toBe('ddreplay-dungeon-1700000000000.json');
    expect(replayFileName('arena/../demo 1', 7)).toBe('ddreplay-arenademo1-7.json');
    expect(replayFileName('', 7)).toBe('ddreplay-run-7.json');
  });
});
