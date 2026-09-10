/**
 * A synthetic two-floor dungeon whose only job is to make the **extraction gate** observable
 * in a golden hash — that is, `ExtractionSystem`'s rule about WHICH floor a run may end on
 * (`ENGINE_VERSION` 61, design/05 "Only the boss floor ends a run").
 *
 * ## Why this exists (read before deleting it as redundant)
 *
 * Same shape of hole `brimGrinderFloor.ts` was written for, and found the same way. When v61
 * removed mid-floor extraction, the change was measured against the golden fixture BEFORE the
 * bump and **not one scenario diverged**. That is not coverage, it is a structural blind spot,
 * and v61's history entry recorded it as one:
 *
 *   - no golden scenario ever pulses `CONFIRM_EXTRACT`, so the button the rule is about was
 *     never pressed;
 *   - `ember-dungeon-floor1` could not help even if it did. Its own note says a scripted stick
 *     does not clear rooms reliably, so it never reaches a checkpoint at all — it pins
 *     `floorIndex === 0` for all 1500 ticks on purpose.
 *
 * So deleting the whole of `ExtractionSystem.tick`'s last-floor branch left the gate green.
 * The fix is not a wider sweep or a longer run; it is a floor and an input script chosen so
 * that reaching a checkpoint and pressing both buttons is guaranteed rather than lucky.
 *
 * ## The shape, and why each piece of it is the way it is
 *
 * **Two floors, one room each, authored** (`layout: 'graph2d'` + `floorMaps`, exactly as the
 * brim grinder does it) so nothing is left to `generateFloor`'s room-count draw. One room means
 * the room the player spawns in IS the capstone, so the checkpoint needs no walking through a
 * door — which is the step a scripted stick cannot be trusted with.
 *
 * **Three enemies, ringed close around the spawn.** Not decoration: the capstone has to be
 * CLEARED before its checkpoint opens, so the run has to actually kill them — and the golden
 * gate's own anti-vacuity guard separately requires every scenario to fire and to hit. Ranged
 * aim is automatic (`WeaponFireSystem` picks the nearest hostile), so point-blank enemies plus
 * the standard mostly-firing script kill them inside a couple of seconds. This is a FIXED seed
 * and a FIXED script, so "likely" is not the standard being met here: the kills either happen
 * or they do not, and `goldenHash.test.ts` asserts the run got past them. The COUNT was
 * measured, not picked — see the `enemy` array's own note.
 *
 * **Floor 0's capstone is `role: 'extraction'`, floor 1's is `role: 'boss'`.** The two roles
 * are what make the pair of floors mean opposite things to `ExtractionSystem`, which is the
 * entire subject.
 *
 * ## What the scenario built on this actually pins
 *
 * With `extract: true` pulsing `CONFIRM_EXTRACT` every 7 ticks and `descend: true` pulsing
 * `CONFIRM_DESCEND` + a card vote every 61, the run must:
 *
 *   1. clear floor 0's capstone and open its checkpoint (~tick 10-40);
 *   2. **ignore** every `CONFIRM_EXTRACT` pulse there — the first one lands long before the
 *      first descend, so if the interior gate ever re-opens the run ends on floor 0 at a
 *      fraction of the tick count, with `floorIndex: 0`;
 *   3. descend on the first `CONFIRM_DESCEND` that has a vote behind it;
 *   4. clear floor 1's capstone and **honour** `CONFIRM_EXTRACT` there, winning.
 *
 * So the witness separates the two failure directions by inspection rather than by hash:
 * an interior extract that starts working drops `floorIndex` to 0, and a last-floor extract
 * that stops working leaves `phase: 'playing'` at the full tick budget. Either is a one-line
 * read in the diff.
 */
import type { RoomPiece } from '../content/rooms';
import type { DungeonConfig, DungeonFloorMap } from '../world/dungeon';

/** Shared geometry, so the two capstones differ only in `id` and `role`. */
function capstone(id: string, role: 'extraction' | 'boss'): RoomPiece {
  return {
    id,
    tags: ['extract_gate'],
    sizeGrid: { w: 21, h: 21 },
    // A plain solid ring. Nothing free-standing: this fixture is about the extraction gate,
    // and a brimmed block would put `WALL_NORTH_BRIM` into its hash for no reason, coupling
    // two unrelated constants into one baseline.
    solids: [
      { x: 0, y: 0, w: 21, h: 1 },
      { x: 0, y: 20, w: 21, h: 1 },
      { x: 0, y: 1, w: 1, h: 19 },
      { x: 20, y: 1, w: 1, h: 19 },
    ],
    spawns: {
      player: [{ x: 10.5, y: 12 }],
      // Three, ringed close around the spawn — inside every starter weapon's reach on tick
      // one, so the kills that open the checkpoint do not depend on where the stick wandered.
      //
      // THREE rather than one, and the count was measured rather than picked. With a single
      // enemy the run wins on tick 98 having fired 11 shots, and the golden gate's own
      // anti-vacuity guard wants more than 20 — correctly: a two-floor run that resolves in
      // three seconds is thin evidence that "a real game happened". The answer is a floor
      // worth clearing, not a lower bar.
      enemy: [
        { x: 10.5, y: 8, type: 'basic' },
        { x: 7, y: 10, type: 'basic' },
        { x: 14, y: 10, type: 'basic' },
      ],
    },
    // One room, no doors: nothing is ever locked, and the run plays inside it (same note as
    // the brim grinder's own `exits: []`).
    exits: [],
    role,
  };
}

export const EXTRACT_GATE_ROOMS: readonly RoomPiece[] = [
  capstone('extract_gate_mid', 'extraction'),
  capstone('extract_gate_boss', 'boss'),
];

const floorMap = (id: string, pieceId: string): DungeonFloorMap => ({
  id,
  rooms: [{ id: 'g1', pieceId, offsetXGrid: 0, offsetYGrid: 0 }],
  doors: [],
});

export const EXTRACT_GATE_DUNGEON: DungeonConfig = {
  biomeId: 'ember',
  nameKey: 'biome.ember',
  // TWO floors is the whole point: floor 0 is interior (descend only), floor 1 is last
  // (extract only). A one-floor version could not express the rule at all.
  floorCount: 2,
  roomsPerFloor: { min: 1, max: 1 },
  pieceTags: ['extract_gate'],
  layout: 'graph2d',
  extractionPieceId: 'extract_gate_mid',
  bossPieceId: 'extract_gate_boss',
  difficultyCurve: { base: 1, perFloor: 0 },
  floorMaps: {
    0: floorMap('extract_gate_f0', 'extract_gate_mid'),
    1: floorMap('extract_gate_f1', 'extract_gate_boss'),
  },
};
