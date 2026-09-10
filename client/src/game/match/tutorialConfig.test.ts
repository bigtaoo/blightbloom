/**
 * tutorialConfig (design/10 screen-flow gap — the standalone tutorial level). Pure data
 * + a determinism check: same seed → byte-identical sim state, the same guarantee every
 * other fixed-seed config in this repo relies on (design/06/08).
 */
import { describe, it, expect } from 'vitest';
import { Button, createGameEngine, hashState } from '@dd/engine';
import { makeCommand } from '@dd/engine/state/input';
import type { Brad } from '@dd/engine/math/trig';
import { buildTutorialConfig } from './tutorialConfig';
import { totalFloorCount } from './floorCount';

const idle = (tick: number) =>
  makeCommand({ owner: 0, tick, moveBrad: 0 as Brad, moveMag: 0, buttons: 0 });

describe('buildTutorialConfig', () => {
  it('is a flat, 2-floor config (floor 0 not last, floor 1 the last floor)', () => {
    const eng = createGameEngine(buildTutorialConfig({ skinId: 'vanguard' }));
    expect(eng.state.dungeonEnabled).toBe(false);
    expect(eng.state.floorsEnabled).toBe(true);
    expect(eng.state.extraFloors.length).toBe(1); // 1 extra floor beyond floor 0 → 2 total
  });

  it('carries the fixed 2-weapon loadout: one ranged, one melee (swap has something real to switch to)', () => {
    const eng = createGameEngine(buildTutorialConfig({ skinId: 'skirmisher' }));
    const p = eng.state.players[0]!;
    expect(p.weapons.map((w) => w.spec.kind)).toEqual(['ranged', 'melee']);
  });

  it('is fully deterministic: two engines from the same config stay byte-identical over many idle ticks', () => {
    const cfg = buildTutorialConfig({ skinId: 'vanguard' });
    const a = createGameEngine(buildTutorialConfig({ skinId: 'vanguard' }));
    const b = createGameEngine(cfg);
    for (let t = 1; t <= 60; t++) {
      a.step([idle(t)]);
      b.step([idle(t)]);
    }
    expect(hashState(a.state)).toBe(hashState(b.state));
  });
});

/**
 * What the tutorial's two checkpoints actually offer (ENGINE_VERSION 61, design/05 "Only the
 * boss floor ends a run").
 *
 * This exists because the level's own header comment was WRONG for a while. It described floor
 * 0's checkpoint as "Bank-and-Extract vs Descend" — a real two-way choice, and the stated
 * reason the lesson was put on a non-last floor — and v61 removed that choice without anything
 * turning red, because nothing tested what the tutorial's floors offer. The level still works;
 * the prose describing it did not.
 *
 * So these are content assertions, not engine ones (`extraction.test.ts` owns the rule). They
 * pin the SHAPE the teaching relies on: two floors, the first teaching DESCEND, the second
 * teaching EXTRACT. A one-floor tutorial would type-check, pass every other test here, and
 * leave a first-time player meeting DESCEND for the first time in a real run.
 */
describe('the tutorial teaches descend then extract, in that order', () => {
  /** Drive the given floor to its checkpoint the way `atCheckpoint` does in the engine's own
   *  extraction tests — the flat-mode condition is `wavesExhausted && no enemies`. */
  function atCheckpoint(floorIndex: number) {
    const eng = createGameEngine(buildTutorialConfig({ skinId: 'vanguard' }));
    eng.state.floorIndex = floorIndex;
    eng.state.wavesExhausted = true;
    eng.state.enemies.length = 0;
    return eng;
  }

  const press = (tick: number, buttons: number, cardVote = 0) =>
    makeCommand({ owner: 0, tick, moveBrad: 0 as Brad, moveMag: 0, buttons, cardVote });

  it('floor 0 descends, and refuses to end the run', () => {
    const eng = atCheckpoint(0);
    eng.step([press(1, Button.CONFIRM_EXTRACT)]);
    expect(eng.state.phase, 'the tutorial let a player extract on floor 0').not.toBe('gameover');
    expect(eng.state.floorIndex, 'an ignored EXTRACT must not double as a descend').toBe(0);

    eng.step([press(2, Button.CONFIRM_DESCEND, 1)]);
    expect(eng.state.floorIndex).toBe(1);
  });

  it('floor 1 extracts, and there is nowhere left to descend to', () => {
    const eng = atCheckpoint(1);
    eng.step([press(1, Button.CONFIRM_DESCEND, 1)]);
    expect(eng.state.floorIndex, 'the tutorial descended past its last floor').toBe(1);

    eng.step([press(2, Button.CONFIRM_EXTRACT)]);
    expect(eng.state.phase).toBe('gameover');
    expect(eng.state.winner).toBe(0);
  });

  it('so the level shows BOTH buttons across its two floors — which one floor could not', () => {
    // The reason the two-floor shape is load-bearing, stated as an assertion rather than only
    // in the header: `totalFloorCount` is what the client's own `isLastFloor` reads, and the
    // portal draws Extract on the last floor and Descend on every other one.
    const eng = createGameEngine(buildTutorialConfig({ skinId: 'vanguard' }));
    const total = totalFloorCount(eng.state);
    expect(total).toBe(2);
    const offers = [0, 1].map((f) => (f + 1 >= total ? 'extract' : 'descend'));
    expect(offers).toEqual(['descend', 'extract']);
  });
});
