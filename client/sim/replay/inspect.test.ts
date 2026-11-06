/**
 * The replay analysis (`inspect.ts`) — in the DEFAULT suite even though the harness that
 * uses it (`sim/replayInspect.sim.ts`) is not, because the harness will be pointed at a
 * real bug report exactly once and has to be right the first time. The important test
 * here is the control: a detector that has never been shown to FIRE, on a case where the
 * answer is known, is not evidence (design/18, and this repo's recurring
 * "the gate could not see the constant it was built for" failure).
 */
import { describe, it, expect } from 'vitest';
import {
  Button,
  LocalInputSource,
  SIM,
  createGameEngine,
  hashState,
  makeCommand,
  packReplayFile,
  pxToFp,
  quantizeMove,
  runHeadless,
  runReplay,
  type Fp,
  type GameState,
  type PickupItem,
} from '@dd/engine';
import { fpToPx } from '../../src/game/coords';
import { pickupDebugGate } from '../../src/game/scene/PickupDebugOverlay';
import { buildDungeonRunConfig } from '../../src/game/match/offlineConfig';
import {
  APPARENT_CONTACT_PX,
  formatInspectReport,
  inspectReplay,
  markCollected,
  observePickups,
  selectSuspects,
  type InspectReport,
  type PickupTrace,
} from './inspect';

// Just enough state for `pickupDebugGate` + `observePickups`: the player's ground point
// and radius, and the drops. `radius` 16 px is PLAYER_BASE's own solidRadius, so the
// auto-collect gate here is the real ~31 px.
//
// `hp`/`maxHp` are here because distance stopped being the only gate at ENGINE_VERSION 54:
// a heal is not collectible at ANY distance while the player is at full HP (design/05
// "only when useful"), and `pickupDebugGate` asks the engine's own predicate. Omitting them
// left both `undefined`, so `hp < maxHp` was false and every heal below read as
// never-collectible — which is what these two tests caught. Damaged on purpose, since what
// this file measures is the DISTANCE rule.
function stateAt(playerPx: [number, number], pickups: Partial<PickupItem>[], tick = 1): GameState {
  return {
    tick,
    players: [{ id: 1, alive: true, hp: 1, maxHp: 6, gx: pxToFp(playerPx[0]), gy: pxToFp(playerPx[1]), radius: pxToFp(16) }],
    pickups: pickups.map((p, i) => ({ id: i + 1, alive: true, kind: 'heal', gx: 0 as Fp, gy: 0 as Fp, ...p })),
  } as unknown as GameState;
}

const trace = (states: GameState[]): PickupTrace[] => {
  const traces = new Map<number, PickupTrace>();
  // One shared map across the sequence, exactly as inspectReplay does — that is what
  // makes each observation see the segment the player just walked.
  const prev = new Map<number, [number, number]>();
  for (const s of states) observePickups(s, traces, prev);
  return [...traces.values()];
};

describe('the suspect rule fires on the case it exists for, and only on it', () => {
  it('a heal 50px away is a SUSPECT: inside apparent contact, outside its own gate', () => {
    // 50 px is the shape of the whole report — visibly at the character's feet, and
    // 19 px outside the 31 px the sim actually requires.
    expect(APPARENT_CONTACT_PX).toBeGreaterThan(50);
    const t = trace([stateAt([100, 100], [{ kind: 'heal', gx: pxToFp(150), gy: pxToFp(100) }])]);
    expect(t[0]!.closestPx).toBeCloseTo(50, 1);
    expect(t[0]!.everCollectible).toBe(false);
    expect(selectSuspects(t)).toHaveLength(1);
  });

  it('a heal 20px away is not: the sim would have collected it', () => {
    const t = trace([stateAt([100, 100], [{ kind: 'heal', gx: pxToFp(120), gy: pxToFp(100) }])]);
    expect(t[0]!.everCollectible).toBe(true);
    expect(selectSuspects(t)).toHaveLength(0);
  });

  it('a WEAPON 50px away is not, and that asymmetry is the thing to look at', () => {
    // Same distance, different verdict: a weapon is claimable from the panel's 80 px
    // ring while a heal at the identical apparent distance is refused. Two drops that
    // look equally underfoot behave differently — which is a legibility defect whether
    // or not it turns out to be THE report.
    const t = trace([stateAt([100, 100], [{ kind: 'weapon', gx: pxToFp(150), gy: pxToFp(100) }])]);
    expect(t[0]!.everCollectible).toBe(true);
    expect(selectSuspects(t)).toHaveLength(0);
  });

  it('a drop the player never approached is not a suspect either — it was never claimed to be underfoot', () => {
    const t = trace([stateAt([100, 100], [{ kind: 'heal', gx: pxToFp(900), gy: pxToFp(900) }])]);
    expect(t[0]!.everCollectible).toBe(false);
    expect(selectSuspects(t)).toHaveLength(0);
  });

  it('remembers the CLOSEST approach and its tick, not the last one', () => {
    const t = trace([
      stateAt([300, 100], [{ gx: pxToFp(100), gy: pxToFp(100) }], 1),
      stateAt([150, 100], [{ gx: pxToFp(100), gy: pxToFp(100) }], 2),
      stateAt([500, 100], [{ gx: pxToFp(100), gy: pxToFp(100) }], 3),
    ]);
    expect(t[0]!.closestPx).toBeCloseTo(50, 1);
    expect(t[0]!.closestTick).toBe(2);
    expect(t[0]!.firstTick).toBe(1);
    expect(t[0]!.lastTick).toBe(3);
  });

  it('one collectible tick clears a drop for good, however far it was the rest of the time', () => {
    const t = trace([
      stateAt([900, 900], [{ gx: pxToFp(100), gy: pxToFp(100) }], 1),
      stateAt([110, 100], [{ gx: pxToFp(100), gy: pxToFp(100) }], 2), // within 31 px
      stateAt([900, 900], [{ gx: pxToFp(100), gy: pxToFp(100) }], 3),
    ]);
    expect(t[0]!.everCollectible).toBe(true);
    expect(selectSuspects(t)).toHaveLength(0);
  });

  it('ignores crates and dead drops — neither has a collect gate of its own', () => {
    const t = trace([
      stateAt([100, 100], [
        { kind: 'crate', gx: pxToFp(140), gy: pxToFp(100) },
        { kind: 'heal', gx: pxToFp(140), gy: pxToFp(100), alive: false },
      ]),
    ]);
    expect(t).toHaveLength(0);
  });
});

describe('markCollected attributes an event to the right drop', () => {
  // No shipped run puts two different-kind drops on one fp point, so the `kind` half of the
  // match is unreachable from a real replay — a battery kills it only against this fixture.
  const twoAtOnePoint = () => {
    const traces = new Map<number, PickupTrace>();
    observePickups(
      stateAt([900, 900], [
        { kind: 'heal', gx: pxToFp(100), gy: pxToFp(100) },
        { kind: 'material', gx: pxToFp(100), gy: pxToFp(100) },
      ]),
      traces,
    );
    return traces;
  };

  it('matches on kind as well as position', () => {
    const traces = twoAtOnePoint();
    markCollected(traces, { kind: 'material', gx: pxToFp(100), gy: pxToFp(100) }, 42);
    const byKind = new Map([...traces.values()].map((t) => [t.kind, t.collectedTick]));
    expect(byKind.get('material')).toBe(42);
    expect(byKind.get('heal')).toBeNull();
  });

  it('leaves everything alone when nothing matches the position', () => {
    const traces = twoAtOnePoint();
    markCollected(traces, { kind: 'heal', gx: pxToFp(500), gy: pxToFp(500) }, 42);
    expect([...traces.values()].every((t) => t.collectedTick === null)).toBe(true);
  });

  it('attributes one event to one drop, not to every match', () => {
    const traces = twoAtOnePoint();
    markCollected(traces, { kind: 'heal', gx: pxToFp(100), gy: pxToFp(100) }, 7);
    markCollected(traces, { kind: 'heal', gx: pxToFp(100), gy: pxToFp(100) }, 9);
    expect([...traces.values()].filter((t) => t.collectedTick !== null)).toHaveLength(1);
  });
});

describe('the swept path answers "I walked right over it"', () => {
  it('records the segment minimum, not just the per-tick samples', () => {
    // Two ticks, the drop off to one side of the line walked between them: both sampled
    // distances are 50 px, the path passed at 40.
    const t = trace([
      stateAt([100, 60], [{ gx: pxToFp(130), gy: pxToFp(100) }], 1),
      stateAt([160, 60], [{ gx: pxToFp(130), gy: pxToFp(100) }], 2),
    ]);
    expect(t[0]!.closestPx).toBeCloseTo(50, 1);
    expect(t[0]!.sweptClosestPx).toBeCloseTo(40, 1);
  });

  it('flags the case where the PATH crossed the gate but no sample did', () => {
    // Sampled 42.4 px from both ends, gate 31 px, and the path passed at 30 px. Nothing
    // the sim can see — PickupSystem only runs at tick boundaries — so a player who
    // walked straight over the drop is told nothing happened.
    const t = trace([
      stateAt([100, 60], [{ gx: pxToFp(130), gy: pxToFp(90) }], 1),
      stateAt([160, 60], [{ gx: pxToFp(130), gy: pxToFp(90) }], 2),
    ]);
    expect(t[0]!.everCollectible).toBe(false);
    expect(t[0]!.closestPx).toBeCloseTo(42.4, 1);
    expect(t[0]!.gatePx).toBeCloseTo(31, 1);
    expect(t[0]!.sweptClosestPx).toBeCloseTo(30, 1);
    expect(t[0]!.sweptClosestPx).toBeLessThan(t[0]!.gatePx); // the flagged condition
  });

  it("degenerates to the sampled distance on a drop's first tick", () => {
    const t = trace([stateAt([100, 100], [{ gx: pxToFp(150), gy: pxToFp(100) }], 1)]);
    expect(t[0]!.sweptClosestPx).toBeCloseTo(t[0]!.closestPx, 5);
  });

  it('never reports closer than the walk actually came — the segment is not an infinite line', () => {
    // The player walks AWAY from the drop, so the closest point on the infinite line through
    // their path lies behind where they started. Unclamped, the projection would report that
    // phantom point; the clamp keeps the answer on the segment they actually walked.
    const t = trace([
      stateAt([200, 100], [{ gx: pxToFp(100), gy: pxToFp(100) }], 1),
      stateAt([300, 100], [{ gx: pxToFp(100), gy: pxToFp(100) }], 2),
      stateAt([400, 100], [{ gx: pxToFp(100), gy: pxToFp(100) }], 3),
    ]);
    expect(t[0]!.closestPx).toBeCloseTo(100, 1);
    expect(t[0]!.sweptClosestPx).toBeCloseTo(100, 1); // not 0, and not negative
  });

  it('records the gate the drop was actually judged against, per kind', () => {
    const t = trace([
      stateAt([100, 100], [
        { kind: 'heal', gx: pxToFp(400), gy: pxToFp(100) },
        { kind: 'weapon', gx: pxToFp(400), gy: pxToFp(140) },
      ]),
    ]);
    expect(t[0]!.gatePx).toBeCloseTo(31, 1);
    expect(t[1]!.gatePx).toBeCloseTo(80, 1);
  });
});

describe('inspectReplay end to end, on a real recorded dungeon run', () => {
  const CONFIG = buildDungeonRunConfig({
    seed: 0xda1d,
    coop: false,
    localSeat: { skinId: 'vanguard', loadout: [] },
    allySkinId: 'skirmisher',
  });
  const TICKS = 900;

  function recorded() {
    const live = new LocalInputSource();
    for (let t = 1; t <= TICKS; t++) {
      const { moveBrad, moveMag } = quantizeMove(Math.sin(t * 0.03), Math.cos(t * 0.021));
      live.submit(makeCommand({ owner: 0, tick: t, moveBrad, moveMag, buttons: Button.FIRE }));
    }
    const engine = runHeadless(CONFIG, live, TICKS);
    const file = packReplayFile({
      config: CONFIG,
      commands: live.recorded(),
      ticks: TICKS,
      label: 'dungeon',
      marks: [{ tick: 600, note: 'hotkey at tick 600' }],
      recordedAtMs: 0,
    });
    return { engine, file };
  }

  it('replays to the same state the live run reached, and reports the marked tick', () => {
    const { engine, file } = recorded();
    const report = inspectReplay(file);

    expect(report.ticks).toBe(TICKS);
    expect(report.finalHash).toBe(hashState(engine.state));
    expect(report.marks).toHaveLength(1);
    expect(report.marks[0]!.tick).toBe(600);
    // The readout is only useful if it actually saw the player.
    expect(report.marks[0]!.players).toHaveLength(1);
  });

  it("a collected drop is attributed from the engine's own pickup event, not guessed", () => {
    // The reason this matters: PickupSystem collects DURING the tick, so the drop is
    // already gone from the post-step state — the one tick it was collectible is the one
    // tick nothing can observe it being collectible. Before the event attribution landed,
    // this harness called four collected drops "never collectible".
    const { file } = recorded();
    const report = inspectReplay(file);
    const collected = report.traces.filter((t) => t.collectedTick !== null);
    expect(collected.length).toBeGreaterThan(0);
    for (const t of collected) expect(report.suspects).not.toContain(t);
  });

  it('every drop that left the run is explained by a pickup event', () => {
    // `vanished` is the anomaly channel: a drop gone with no event behind it would be a
    // different bug entirely, and this asserts the shipped content produces none.
    const { file } = recorded();
    expect(inspectReplay(file).vanished).toEqual([]);
  });

  it('the run it inspects is a real one: enemies died and dropped things', () => {
    // Without this the suspect list being empty would be meaningless — an inspection of
    // a run with no drops in it reports "no suspects" for the wrong reason.
    const { file } = recorded();
    const report = inspectReplay(file);
    expect(report.traces.length).toBeGreaterThan(0);
  });

  it('a stream shorter than the declared tick count ends the run instead of idling on', () => {
    const { file } = recorded();
    const short = packReplayFile({
      config: CONFIG,
      commands: file.replay.commands.slice(0, 100),
      ticks: 100,
      label: 'dungeon',
      recordedAtMs: 0,
    });
    expect(inspectReplay(short).ticks).toBe(100);
  });

  it('does not consult a live input source — playback is read-only by construction', () => {
    // inspectReplay builds its own ReplayInputSource; a regression that submitted a
    // command would throw here rather than silently diverging from the recording.
    const { file } = recorded();
    expect(() => inspectReplay(file)).not.toThrow();
    const a = inspectReplay(file);
    const b = inspectReplay(file);
    expect(b.finalHash).toBe(a.finalHash); // and it is repeatable, which is the point
  });

  /** The same recording, marked at a tick of this test's choosing. */
  function markedAt(tick: number) {
    const { file } = recorded();
    return packReplayFile({
      config: CONFIG,
      commands: file.replay.commands,
      ticks: TICKS,
      label: 'dungeon',
      marks: [{ tick, note: `hotkey at tick ${tick}` }],
      recordedAtMs: 0,
    });
  }

  it('a mark readout carries the real per-drop numbers, measured against the sim itself', () => {
    // Tick 90 MEASURED on this fixture, not chosen: pickup #31 (a heal) is lying on the
    // floor there. A mark at 600 (the fixture above) happens to land on a tick with no live
    // drop, so every existing assertion about `marks` is satisfied by an EMPTY pickup list —
    // which is how the readout's numbers came to be unpinned in the first place.
    //
    // It is measured, so it moves when the sim does: this was tick 70 / pickup #25 until
    // ENGINE_VERSION 56 changed where mobs walk and therefore when each of them dies. If it
    // ever fails on `pickups.length`, re-measure it — the anti-vacuity check above is doing
    // its job, and silently deleting it would put the readout's numbers back to unpinned.
    const MARK_TICK = 90;
    const file = markedAt(MARK_TICK);
    const report = inspectReplay(file);
    // Independent oracle: the same recording replayed to that tick by the engine's own
    // `runHeadless`, judged by the same `pickupDebugGate` the client's overlay uses. Not a
    // restatement of the rule (design/18 G6) — the point is that the readout reports THIS
    // state's numbers rather than a plausible-looking summary of some other tick.
    const oracle = runReplay(file.replay, MARK_TICK).state;
    expect(oracle.tick).toBe(MARK_TICK);

    const m = report.marks[0]!;
    expect(m.tick).toBe(MARK_TICK);
    expect(m.note).toBe(`hotkey at tick ${MARK_TICK}`);
    expect(m.pickups.length).toBeGreaterThan(0); // the tick really does have a drop on it
    expect(m.pickups).toEqual(
      oracle.pickups
        .filter((item) => item.alive && item.kind !== 'crate')
        .map((item) => {
          const { nearestPx, collectible } = pickupDebugGate(oracle, item);
          return {
            id: item.id,
            kind: item.kind,
            x: fpToPx(item.gx),
            y: fpToPx(item.gy),
            nearestPx,
            collectible,
          };
        }),
    );

    // The player row, field by field. `autoGatePx` is the one that had no witness: it is
    // the sim's padding PLUS this player's own radius (~15 px each, ~31 px together), and
    // dropping the radius term leaves the bare padding — a readout that would tell a
    // reader the drop needed to be twice as close as it really did, which is exactly the
    // number this whole investigation turns on.
    expect(m.players).toHaveLength(1);
    expect(m.players[0]!.id).toBe(oracle.players[0]!.id);
    expect(m.players[0]!.x).toBe(fpToPx(oracle.players[0]!.gx));
    expect(m.players[0]!.y).toBe(fpToPx(oracle.players[0]!.gy));
    expect(m.players[0]!.autoGatePx).toBeCloseTo(31, 1);
    expect(m.players[0]!.autoGatePx).toBeGreaterThan(fpToPx(SIM.pickupRadius) * 1.9);
  });

  it('stops where the ENGINE stops — a run that ended is not inspected past its end', () => {
    // A stream that never fires: the player walks east into the entry room's garrison and
    // stays there, and the run is over long before the 6000 ticks the file declares. (Not
    // standing still: since ENGINE_VERSION 89 the entry room's two mobs stand outside
    // their aggro range of the spawn, so a player who never moves is never shot.)
    const idle = new LocalInputSource();
    for (let t = 1; t <= 6000; t++) {
      idle.submit(makeCommand({ owner: 0, tick: t, ...quantizeMove(1, 0), buttons: 0 }));
    }
    const pack = (marks: { tick: number; note: string }[]) => packReplayFile({
      config: CONFIG, commands: idle.recorded(), ticks: 6000, label: 'dungeon-idle', marks, recordedAtMs: 0,
    });

    const oracle = runReplay(pack([]).replay, 6000); // runHeadless has the same break, by design
    expect(oracle.state.phase).toBe('gameover');
    expect(oracle.state.tick).toBeLessThan(6000); // the run really did end early
    const end = oracle.state.tick;

    expect(inspectReplay(pack([])).ticks).toBe(end);
    expect(inspectReplay(pack([])).finalHash).toBe(hashState(oracle.state));

    // The observable that actually needs the `break`, and the reason those two lines above
    // are not enough on their own: `GameEngine.step` NO-OPS once the phase is gameover
    // (design/08 — it does not even clear events), so the tick and the hash freeze whether
    // the loop stops or not. What does not freeze is the mark check: with the run held at
    // its final tick, a mark ON that tick matches again on every remaining frame, and the
    // report would carry ~5800 copies of one moment.
    const marked = inspectReplay(pack([{ tick: end, note: 'the last tick of the run' }]));
    expect(marked.marks).toHaveLength(1);
    expect(marked.marks[0]!.tick).toBe(end);
  });

  it('marks a collected drop as having left the run, and one still lying there as not', () => {
    // `disappeared` was asserted only through `vanished === []`, which an ALWAYS-FALSE
    // value satisfies just as well as the real one — and always-false is precisely the
    // mutation that would blind the anomaly channel this field exists to feed. Both
    // directions are pinned here: what got collected is gone, what nobody took is not.
    const { file } = recorded();
    const report = inspectReplay(file);

    const collected = report.traces.filter((t) => t.collectedTick !== null);
    expect(collected.length).toBeGreaterThan(0);
    for (const t of collected) expect(t.disappeared).toBe(true);

    const untaken = report.traces.filter((t) => t.collectedTick === null);
    expect(untaken.length).toBeGreaterThan(0);
    expect(untaken.every((t) => !t.disappeared)).toBe(true);
  });
});

describe('createGameEngine sanity for the fixture above', () => {
  it('the config used by these tests is the one the client actually ships offline', () => {
    // Guards against the fixture drifting into something synthetic: if beginRun's config
    // changes shape, this test's evidence changes with it rather than silently aging.
    const engine = createGameEngine(
      buildDungeonRunConfig({
        seed: 1,
        coop: false,
        localSeat: { skinId: 'vanguard', loadout: [] },
        allySkinId: 'skirmisher',
      }),
    );
    // The first floor loads on sim tick 1 (SpawnSystem.loadRoom), not at construction.
    engine.step([]);
    expect(engine.state.dungeonRooms.length).toBeGreaterThan(0);
  });
});

describe('formatInspectReport — the text a human actually reads', () => {
  // The harness prints exactly this and nothing else, so every judgement the analysis
  // reached reaches a person through these lines. It had no test at all: a report that
  // labels a collectible drop MISS, or omits the tunnelling flag, is indistinguishable
  // from a correct one to every other test in this file — and it is the ONLY output the
  // person reading a bug report ever sees.
  const lineFor = (text: string, needle: string) =>
    text.split('\n').find((l) => l.includes(needle)) ?? `<no line containing ${needle}>`;

  const report = (over: Partial<InspectReport> = {}): InspectReport => ({
    label: 'dungeon',
    engineVersion: 51,
    ticks: 900,
    finalHash: 1234,
    marks: [],
    traces: [],
    suspects: [],
    vanished: [],
    ...over,
  });

  const suspect = (over: Partial<PickupTrace>): PickupTrace => ({
    id: 1,
    kind: 'heal',
    x: 100,
    y: 200,
    firstTick: 10,
    lastTick: 90,
    closestPx: 50,
    closestTick: 40,
    sweptClosestPx: 50,
    gatePx: 31,
    everCollectible: false,
    collectedTick: null,
    disappeared: false,
    ...over,
  });

  const MARK = {
    tick: 600,
    note: 'hotkey at tick 600',
    players: [{ id: 1, x: 100.25, y: 200.5, autoGatePx: 31.008 }],
    pickups: [
      { id: 7, kind: 'heal' as const, x: 110, y: 200, nearestPx: 12.34, collectible: true },
      { id: 9, kind: 'weapon' as const, x: 400, y: 200, nearestPx: 300.44, collectible: false },
    ],
  };

  it('opens with the file it read and how much of it it saw', () => {
    const text = formatInspectReport(report({ traces: [suspect({ id: 1 }), suspect({ id: 2 })] }));
    const lines = text.split('\n');
    expect(lines[0]).toBe('replay: label=dungeon engineVersion=51 ticks=900 finalHash=1234');
    expect(lines[1]).toBe(
      `drops seen: 2  (auto-collect gate ~31px, apparent-contact band ${APPARENT_CONTACT_PX}px)`,
    );
  });

  it('labels OK vs MISS on the drop each verdict belongs to', () => {
    // Swapping the two labels changes nothing else about the report — same ids, same
    // distances, same line count — and inverts every conclusion drawn from it. #7 is
    // 12.3 px out and collectible; #9 is 300 px out and is not.
    const text = formatInspectReport(report({ marks: [MARK] }));

    expect(lineFor(text, '#7')).toBe('  OK   #7 heal at (110.0, 200.0) nearest=12.3px');
    expect(lineFor(text, '#9')).toBe('  MISS #9 weapon at (400.0, 200.0) nearest=300.4px');
    expect(lineFor(text, 'MARK')).toBe('--- MARK tick 600 (hotkey at tick 600) ---');
    expect(lineFor(text, 'player 1')).toBe('  player 1 at (100.3, 200.5)  autoGate=31.0px');
  });

  it('says so when a marked tick had no live drops, rather than printing nothing', () => {
    // The reported moment with an empty list under it is a real and informative answer
    // ("there was nothing there to pick up"); a marked tick with silence under it reads
    // like the harness failed.
    const text = formatInspectReport(report({ marks: [{ ...MARK, pickups: [] }] }));
    expect(text).toContain('  no live pickups at this tick');
    expect(lineFor(text, 'player 1')).toContain('autoGate=31.0px'); // the player row still prints
  });

  it('flags WALKED-THROUGH-THE-GATE on the suspect whose PATH crossed it, and only that one', () => {
    // #3's swept distance is exactly its gate — the boundary is inside the flag, since a
    // path that grazes the ring is a path the sim should have collected on. #4 passed 14 px
    // outside its gate and was never collectible: a near miss, not a tunnelling.
    const text = formatInspectReport(report({
      suspects: [
        suspect({ id: 3, sweptClosestPx: 31, gatePx: 31, closestPx: 42.4, disappeared: false }),
        suspect({ id: 4, sweptClosestPx: 45, gatePx: 31, closestPx: 50, disappeared: true }),
      ],
    }));

    expect(text).toContain(
      `SUSPECTS (never collected, player got within ${APPARENT_CONTACT_PX}px), closest first:`,
    );
    expect(lineFor(text, '#3')).toContain('  WALKED-THROUGH-THE-GATE');
    expect(lineFor(text, '#4')).not.toContain('WALKED-THROUGH-THE-GATE');
    // And the rest of a suspect line, so the numbers can't quietly go missing with it.
    expect(lineFor(text, '#3')).toBe(
      '  #3 heal at (100.0, 200.0) sampled=42.4px swept=31.0px gate=31.0px at tick 40' +
        '  alive 10..90 (still there)  WALKED-THROUGH-THE-GATE',
    );
    expect(lineFor(text, '#4')).toContain('(gone by the end)');
  });

  it('says "no suspects" in words when there are none — an empty section reads as a crash', () => {
    const text = formatInspectReport(report({ traces: [suspect({})] }));
    expect(text).toContain('no suspects: every drop the player came near was collectible at some point.');
    expect(text).not.toContain('SUSPECTS');
  });
});
