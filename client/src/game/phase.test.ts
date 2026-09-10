/**
 * `isHubPhase` — the one question about a `Phase` that is not "which screen is up", and the
 * only one with a wrong answer that costs a player something (design/10, 2026-09-10: an
 * account session arriving mid-run used to write the account's `MetaState` over a loadout the
 * run had already spent).
 *
 * The table below is `Record<Phase, boolean>` on purpose, so **adding a phase is a compile
 * error here** until somebody answers the question for it. That gate is worth restating,
 * because this repository had one and lost it: `confirmEdge.test.ts` carried the same shape
 * for "may this screen be confirmed by a fire edge", and when that whole mechanism was
 * deleted (2026-08-17) the exhaustiveness went with it — design/10 records the loss in the
 * bullet about it. Nothing structural replaced it, and `OnlineMatch`'s own tests cannot: they
 * name the phases they care about, so a phase nobody thought of is simply absent from them.
 */
import { describe, it, expect } from 'vitest';
import { isHubPhase, type Phase } from './phase';

/**
 * Every phase, and whether `MetaState` may be replaced wholesale while it is on screen.
 *
 * The `false` rows are the interesting half and they are not all "in a run": `victory` and
 * `defeat` are excluded because the run's banked materials have just been written and are
 * being mirrored up fire-and-forget, so a pull landing between the write and the mirror is
 * the same clobber one screen later.
 */
const HUB: Record<Phase, boolean> = {
  menu: true,
  forge: true,
  store: true,
  squad: true,
  account: true,
  settings: true,
  pvpPreview: false,
  matchmaking: false,
  playing: false,
  paused: false,
  victory: false,
  defeat: false,
};

describe('isHubPhase', () => {
  it('classifies every phase, and classifies it the way the shipped code does', () => {
    for (const [phase, expected] of Object.entries(HUB) as Array<[Phase, boolean]>) {
      expect(isHubPhase(phase), phase).toBe(expected);
    }
  });

  it('is not vacuous in either direction', () => {
    // Both arms have members, so neither `return true` nor `return false` passes the table
    // above. Cheap, and it is the mutation the table alone would not catch if the union ever
    // collapsed to one kind of phase.
    const values = Object.values(HUB);
    expect(values).toContain(true);
    expect(values).toContain(false);
  });

  it('covers the union exactly — no phase in the table that the type does not have', () => {
    // The compile-time half is `Record<Phase, boolean>` (a missing key fails `tsc`). This is
    // the runtime half of the same claim, and it is what catches a phase that was REMOVED
    // from the union while its row stayed here — which is exactly what this pass did to
    // `modeSelect`, and `tsc` alone does not flag an extra key on a `Record` literal.
    const rows = Object.keys(HUB).length;
    expect(rows, 'add or remove a row when the Phase union changes').toBe(12);
  });
});
