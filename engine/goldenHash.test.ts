/**
 * The golden-hash gate (design/18-test-strategy.md, G1 / Layer 0).
 *
 * ## What this catches that `replay.test.ts` cannot
 *
 * `replay.test.ts` is excellent at what it does — but every one of its assertions builds two
 * runs IN THE SAME PROCESS and compares them to each other. That proves the engine is
 * deterministic. It cannot prove the engine still does what it did yesterday, because a
 * behaviour change moves both runs identically. `replay.ts`'s own comment says so, as the
 * reason a field was safe to add: *"the golden-replay test compares two independent runs, so a
 * new always-equal field never breaks it."*
 *
 * So before this file, changing `WALL_NORTH_BRIM`, an actor's `solidRadius`, a weapon's
 * `muzzleOffset`, or the `step()` order left the entire 885-test engine suite green while
 * silently breaking replay compatibility with every recorded stream in the wild. The
 * `ENGINE_VERSION` bump that is supposed to catch that was a human habit backed by nothing.
 *
 * ## What a failure here means
 *
 * It is NOT "you broke something". It means the sim's observable behaviour moved, and that is
 * a decision, not an accident to be papered over:
 *
 *   - **Intended?** Bump `ENGINE_VERSION` in `versionHistory.ts`, add a `## vN:` entry to
 *     `ENGINE_VERSION_HISTORY.md` saying what diverges and why, then `npm run record:golden`.
 *   - **Unintended?** You just found a real regression, in the cheapest possible way.
 *
 * The recorder is deliberately a separate command rather than a `-u` flag: re-recording should
 * cost a conscious keystroke, because the whole value of this file is that it is annoying to
 * dismiss. `versionContract.test.ts` closes the loophole of re-recording without bumping.
 *
 * ## Why the witness is asserted too
 *
 * A hash says a number moved. `witness` says which way the world moved (enemies alive, shots in
 * flight, floor index, summed PRNG cursors), so a red gate is diagnosable from the diff alone —
 * and, just as important, a scenario that quietly stopped spawning anything cannot go on
 * "passing" its hash while testing an empty room. The `assertScenarioDidSomething` block is the
 * anti-vacuity guard the `*Coverage.test.ts` suites already use (`expect(pairs)
 * .toBeGreaterThan(50)`), applied to a whole run.
 *
 * ## Mutation battery — what this gate is measured to catch, and what it is not
 *
 * Recorded 2026-08-30 at ENGINE_VERSION 48. Re-run it after adding or retuning a scenario; a
 * gate whose kills are assumed rather than measured is the failure mode this whole file exists
 * to prevent.
 *
 *   KILLED   extraction gate: interior CONFIRM_EXTRACT honoured again .. 3
 *   KILLED   extraction gate: last floor stops honouring it ........... 2
 *   KILLED   WALL_NORTH_BRIM 23px -> 24px .......................... 1 failing test
 *   KILLED   enemy solidRadius: bp.radius -> bp.footprintRadius ..... 4
 *   KILLED   starter muzzleGrid 0.9375 -> 1.0 ...................... 7
 *   KILLED   step order: deflect <-> hitResolve ..................... 2
 *   KILLED   step order: weaponFire <-> movement ................... 9
 *   SURVIVED step order: statusEffect <-> zone
 *   SURVIVED step order: movement <-> projectileStep
 *   SURVIVED step order: deathDrops <-> pickup
 *
 * The two extraction-gate rows were added 2026-09-10 with the `extraction-gate` scenario and
 * are the reason it exists: before it, BOTH of those mutants survived the entire gate. Each
 * kill is also diagnosable from the witness alone, which is the property the `witness` field is
 * for — the first shows `floorIndex 1 -> 0` with `descend` gone (the run stopped on floor 0),
 * the second shows `tick 245 -> 400, phase gameover -> playing` (nothing ever ended it).
 *
 * The three survivors are all reorderings of systems that never interact WITHIN these
 * scenarios — no bullet in the set happens to depend on whether its shooter moved first, and no
 * drop is ever collected on the tick it spawns. They are honest coverage gaps, recorded rather
 * than papered over: this gate is strong on constants and content, partial on step order. If
 * step-order coverage matters more later, the fix is a denser scenario (simultaneous
 * melee+drop+pickup in one tick), not a wider sweep of the existing ones.
 *
 * The first version of `WALL_NORTH_BRIM`'s row above read SURVIVED, against four scenarios built
 * from shipped content. That is what produced `fixtures/brimGrinderFloor.ts` — read its header
 * before assuming a scenario exercises what its name suggests.
 */
import { describe, expect, it } from 'vitest';
import { ENGINE_VERSION } from './config';
import { GOLDEN_SCENARIOS, runScenario, type GoldenScenario, type Witness } from './fixtures/goldenScenarios';
import { goldenPath, isRecording, readGolden, writeGolden, type GoldenEntry } from './fixtures/goldenFile.mjs';

const results = GOLDEN_SCENARIOS.map((sc) => ({ sc, ...runScenario(sc) }));

const HOWTO = [
  '',
  'The sim behaved differently than the recorded fixture.',
  '',
  '  Intended change?  1. bump ENGINE_VERSION in engine/versionHistory.ts',
  '                    2. add a `## vN:` entry to engine/ENGINE_VERSION_HISTORY.md',
  '                    3. npm run record:golden   (-w engine)',
  '  Unintended?       you just caught a replay-breaking regression.',
  '',
  `  fixture: ${goldenPath()}`,
  '',
].join('\n');

describe('golden hash — the sim still behaves the way ENGINE_VERSION says it does', () => {
  if (isRecording()) {
    it('re-records the fixture', () => {
      writeGolden({
        engineVersion: ENGINE_VERSION,
        scenarios: results.map(
          ({ sc, hash, witness }): GoldenEntry => ({
            name: sc.name,
            pins: sc.pins,
            ticks: sc.ticks,
            hash,
            witness,
          }),
        ),
      });
      expect(results.length).toBe(GOLDEN_SCENARIOS.length);
    });
    return;
  }

  const golden = readGolden();

  it('the fixture covers exactly the scenarios that exist', () => {
    // Guards the boring failure mode where someone adds a scenario and forgets to record it,
    // which would otherwise silently test nothing at all.
    expect(golden.scenarios.map((s) => s.name)).toEqual(GOLDEN_SCENARIOS.map((s) => s.name));
  });

  for (const { sc, hash, witness } of results) {
    describe(sc.name, () => {
      const recorded = golden.scenarios.find((s) => s.name === sc.name);

      it(`pins: ${sc.pins}`, () => {
        expect(recorded, `no recorded entry for "${sc.name}" — run npm run record:golden`).toBeDefined();
        expect(recorded!.ticks, 'scenario length changed; that alone moves the hash').toBe(sc.ticks);
      });

      it('the witness matches', () => {
        // Asserted BEFORE the hash on purpose: when both move, this is the one whose failure
        // message tells you what actually happened.
        expect(witness, HOWTO).toEqual(recorded!.witness);
      });

      it('the state hash matches', () => {
        expect(hash, HOWTO).toBe(recorded!.hash);
      });
    });
  }
});

/**
 * A scenario that ends on tick 3, or wanders an empty room for 1500 ticks, still produces a
 * perfectly stable hash — and pins nothing. This block is what stops the suite above from
 * being a very elaborate way to compare two constants.
 *
 * The measure is EVENT COUNTS, not PRNG cursors. `Prng.peek()` returns the LCG's internal
 * state, ~1e10 on a fresh engine, so the obvious-looking `prngCursors > 1000` guard is true
 * before a single tick runs — it was in the first draft of this file and proved nothing. What
 * the engine emits per tick is the honest signal.
 *
 * Bounds are deliberately loose and one-sided: they say "a real game happened", not "the
 * balance is X", so ordinary tuning never trips them while a scenario collapsing into a no-op
 * always does.
 */
describe('anti-vacuity — every scenario actually exercised the engine', () => {
  const assertScenarioDidSomething = (sc: GoldenScenario, w: Witness): void => {
    expect(w.seats, `${sc.name} lost a seat`).toBe(sc.seats);
    // Either it used its whole budget, or it stopped early because the run was DECIDED. A run
    // that stops early for any other reason is a broken scenario.
    if (w.tick < sc.ticks) {
      expect(w.phase, `${sc.name} stopped at tick ${w.tick}/${sc.ticks} without reaching gameover`).toBe('gameover');
      expect(w.winner, `${sc.name} ended with no winner`).not.toBe('null');
    }
    expect(w.events.bullet_fired ?? 0, `${sc.name} never fired a shot`).toBeGreaterThan(20);
    expect(w.events.hit ?? 0, `${sc.name} never landed a hit`).toBeGreaterThan(0);
  };

  for (const { sc, witness } of results) {
    it(`${sc.name} ran a real game`, () => assertScenarioDidSomething(sc, witness));
  }

  it('between them the scenarios reach combat, geometry, the dungeon and the arena', () => {
    const by = (n: string): Witness => results.find((r) => r.sc.name === n)!.witness;

    // Combat resolved all the way to a decided outcome.
    expect(by('arena-waves').events.death ?? 0, 'nothing ever died').toBeGreaterThan(0);
    expect(by('arena-waves').winner).toBe('0');

    // Dungeon mode really engaged: rooms were entered and doors really locked/unlocked.
    const dungeon = by('ember-dungeon-floor1');
    expect(dungeon.events.room_enter ?? 0, 'roomgen/room entry never ran').toBeGreaterThan(0);
    expect(dungeon.events.door_locked ?? 0, 'no door ever locked — DoorSystem was inert').toBeGreaterThan(0);
    // Recorded, not aspirational: a scripted stick does not clear rooms, so this run never
    // reaches a checkpoint. If a change ever makes it descend, this fails and the scenario's
    // `pins` line needs updating rather than the run silently meaning something new.
    expect(dungeon.floorIndex, 'this scenario is not supposed to descend — see its `pins`').toBe(0);

    // The extraction gate really resolved, on the floor it is supposed to resolve on. Every
    // number here is a way the scenario could stop meaning what its `pins` line says while
    // still producing a stable hash: a run that never descends is testing one floor, a run
    // that never wins is testing a stalemate, and a run that wins on floor 0 is testing the
    // rule INVERTED — which is precisely the pre-v61 behaviour this exists to catch.
    const gate = by('extraction-gate');
    expect(gate.floorIndex, 'the interior CONFIRM_EXTRACT was honoured — the v61 rule is gone').toBe(1);
    expect(gate.events.descend ?? 0, 'the run never left floor 0').toBe(1);
    expect(gate.events.win ?? 0, 'the boss floor never honoured CONFIRM_EXTRACT').toBe(1);
    expect(gate.phase, 'the run did not end').toBe('gameover');
    expect(gate.events.room_enter ?? 0, 'both floors should have been entered').toBe(2);

    // The arena is a genuinely hostile two-seat match, not two allies sharing a map.
    const arena = by('launch-arena-pvp');
    expect(arena.seats).toBe(2);
    expect(arena.events.zone_warn ?? arena.events.zone_close ?? 0, 'the zone never moved').toBeGreaterThan(0);
  });
});
