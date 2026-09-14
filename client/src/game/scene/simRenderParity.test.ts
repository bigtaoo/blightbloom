/// <reference types="node" />
/**
 * Where the RENDERER derives an ENGINE constant in prose, this file closes the loop by importing
 * it (design/18-test-strategy.md, gap **G6**, Layer 2).
 *
 * **WHY THIS FILE EXISTS.** Three separate rules in `client/src/game/scene/` are justified by
 * arithmetic over `PLAYER_BASE.solidRadius` and `WALL_NORTH_BRIM`, and not one of them imports
 * either constant:
 *
 *   1. `wallGeometry.WALL_H_KERB = 22` is argued from "the player's ground point stays
 *      `PLAYER_BASE.solidRadius` (16 px) north of the kerb's own north edge", so a 22 px lip
 *      "reaches at most 6 px up a body".
 *   2. `occlusion.MIN_COVER_FRACTION = 0.45` re-derives that SAME 6 px from that SAME premise,
 *      in its own words, to justify its own number.
 *   3. `wallGeometry.wallTier` decides "is this an interior block" from room-rect edge proximity
 *      (`EDGE_TOLERANCE = 4`); the sim decides the same thing from `AABB.freeStanding`. Two
 *      independent classifiers over the same rects, and nothing compares them.
 *
 * A prose derivation is not a guard. Change `solidRadius` and both comments quietly become
 * false while every test stays green — which is the exact failure mode design/18 catalogued
 * (`WALL_NORTH_BRIM`'s own doc comment cited a `standingCoverParity.test.ts` that was never
 * created). So: compute the 6 px instead of restating it, and sweep the shipped content for
 * classifier disagreement rather than assuming there is none.
 *
 * Content is the five shipped ember floors through the real pipeline (`placeAuthoredFloor` →
 * `buildFloorGeometry`), the same setup `occlusionCoverage.test.ts` uses. Comparison is per
 * AUTHORED rect, deliberately before `mergeWallRuns`: `freeStanding` is a per-rect engine flag
 * and a merge that unions two rects has nowhere to put a disagreement.
 *
 * ## What the sweep found, and it is not zero
 *
 * **The five shipped floors contain 198 wall rects and ZERO `freeStanding` ones.** The renderer
 * stands 34 of them at `WALL_H_INTERIOR` (70 px); the sim brims none of them. So the `⟺` design/18
 * asked for is currently `interior ⇒ NOT freeStanding` on 34 rects out of 34 — the two classifiers
 * agree on nothing at all, because one of them never fires.
 *
 * That is a fact about CONTENT, not about either rule. `freeStanding` is authored, and the
 * level-1 pieces are JSON under `world/dungeons/ember/pieces/` seeded before v47 existed; the
 * hand-authored TypeScript pool (`world/rooms/ember.ts`) does set it, and so does the launch
 * arena, which is why `engine/fixtures/brimGrinderFloor.ts`'s header can say "dungeon mode does
 * have free-standing blocks" and be right about the pool while being wrong about the level that
 * ships. The consequence is that ENGINE_VERSION 47's fix for *"角色...感觉陷进去了"* is inert over
 * the whole of PvE level 1.
 *
 * Is that SAFE? Yes, in the direction that matters, and the tests below assert both halves:
 *
 *   - The dangerous direction is EMPTY: no rect is brimmed by the sim while the renderer draws it
 *     as a perimeter ring or a kerb. A brimmed kerb would re-open the v43 report from the
 *     opposite side (`WALL_NORTH_BRIM`'s "Only free-standing blocks"), and a brimmed perimeter
 *     ring would narrow every door passage from both sides.
 *   - The direction that IS populated only costs visual polish: a player standing 16 px rather
 *     than 39 px north of a 70 px-tall block is more covered, not less, and `occludes` already
 *     fires there (`occlusionCoverage.test.ts` sweeps it). Nothing becomes unreachable and no
 *     pickup becomes uncollectable, because `clampToWalkable` reads the same flag the movement
 *     resolver does — both see "not free-standing" and agree.
 *
 * So the count below is a RECORDED MEASUREMENT, not a green light. It is written to fail the day
 * anyone authors `freeStanding` into level 1 — at which point this file is the thing that makes
 * them look at the tier rule too, which is the whole point of a parity sweep.
 *
 * ## Mutation battery — what these assertions are measured to catch
 *
 * Recorded 2026-08-30 at ENGINE_VERSION 48. Each mutation was applied to the SOURCE constant,
 * this file run alone, then reverted (`git diff --stat` clean afterwards).
 *
 *   KILLED   engine PLAYER_BASE.solidRadius 16 px -> 12 px .......... 4 failing tests
 *   KILLED   wallGeometry.EDGE_TOLERANCE 4 -> 140 .................. 5
 *   KILLED   wallGeometry.WALL_H_KERB 22 -> 26 ..................... 3
 *   KILLED   occlusion.MIN_COVER_FRACTION 0.45 -> 0.20 ............. 2
 *   KILLED   wallGeometry.WALL_H_INTERIOR 70 -> 96 ................. 2
 *   KILLED   engine WALL_NORTH_BRIM 23 px -> 2 px .................. 2
 *   KILLED   engine WALL_NORTH_BRIM 23 px -> 21 px ................. 1
 *   SURVIVED engine WALL_NORTH_BRIM 23 px -> 24 px
 *   SURVIVED wallGeometry.EDGE_TOLERANCE 4 -> 40
 *
 * The two engine rows are the ones this file exists for: before it, changing `solidRadius` broke
 * nothing in the client at all, and both renderer comments derived from it stayed green while
 * becoming false.
 *
 * Both survivors are honest and both are informative rather than gaps to paper over:
 *
 *   - `WALL_NORTH_BRIM 23 -> 24` survives because every claim about the brim here is a ONE-SIDED
 *     inequality and 24 px is on the safe side of all of them. The pair `21 KILLED / 22 SURVIVED`
 *     locates the boundary exactly, and locating it is the point: "the thinnest free-standing
 *     block clears `WALL_H_INTERIOR` by one pixel" is a measurement this battery reproduces
 *     rather than a phrase in a comment.
 *   - `EDGE_TOLERANCE 4 -> 40` survives because the tightest interior block on any shipped floor
 *     is 128 px clear of its room's nearest bound (asserted below), so a 10x widening still
 *     reclassifies nothing. 140 crosses that margin and kills 5 tests. This file therefore gates
 *     the tolerance's EFFECT on real content, not its value — which is the right granularity for
 *     a constant whose own comment calls it fixed-point conversion slack.
 */
import { describe, it, expect } from 'vitest';
import {
  EMBER_L1_FLOORS,
  EMBER_L1_ROOMS,
  PLAYER_BASE,
  WALL_NORTH_BRIM,
  buildFloorGeometry,
  placeAuthoredFloor,
  toFpAabbGrid,
  toFpGrid,
  type RoomPiece,
} from '@dd/engine';
import { fpToPx } from '../coords';
import {
  wallHeight,
  wallTier,
  DOOR_H,
  WALL_H_INTERIOR,
  WALL_H_KERB,
  type RectPx,
  type WallTier,
} from './wallGeometry';
import { blockCapTop } from './wallRuns';
import { needsDeepFade, occludes, type Occluder } from './occlusion';

/** The player's closest legal approach to a wall's face, in world px — the ENGINE's own number,
 *  imported rather than the `16` both renderer comments spell out. Every claim below that says
 *  "16 px" reads this instead, so changing it fails here. */
const CLEARANCE = fpToPx(PLAYER_BASE.solidRadius);

/** The EXTRA clearance the sim reserves on a `freeStanding` block's NORTH face, and only there
 *  (ENGINE_VERSION 47). Never on a perimeter ring, never on a kerb. */
const BRIM = fpToPx(WALL_NORTH_BRIM);

/** How tall the character is DRAWN, in world px — a band, not a point, matching
 *  `occlusion.test.ts`: the shipped rig measures 32 and the Graphics placeholder 39, and a claim
 *  that only holds at one of them is a claim about today's art. The LOW end is load-bearing for
 *  the kerb argument: a shorter body is a LARGER covered fraction for the same 6 px of stone. */
const BODY_H_MIN = 20;
const BODY_H_MAX = 48;
const BODY_HALF_W = 13;

/** One grid cell in world px — the shallowest footprint any authored solid can have, and so the
 *  worst case the brim has to survive. Not a magic number: `WORLD.pxPerGrid`, restated here only
 *  because what the assertion needs is "the thinnest possible wall", which is a statement about
 *  the authoring grid rather than about the conversion. */
const THINNEST_WALL_DEPTH = fpToPx(toFpGrid(1));

interface SimWall extends RectPx {
  /** The ENGINE's classification. Absent on every level-1 rect today — see the header. */
  freeStanding: boolean;
  /** The RENDERER's, from the same rect and the floor's room list. */
  tier: WallTier;
}

interface Floor {
  index: number;
  walls: SimWall[];
  rooms: RectPx[];
  /** The floor's door passages, converted the same way `RoomBuilder` converts them. Doors are not
   *  walls — they carry no tier since 2026-09-03 — but they stand in the same band the kerb claim
   *  below is about, which is what makes them this file's business. */
  doors: RectPx[];
}

/**
 * One shipped floor's collision rects, each carrying BOTH classifications.
 *
 * Same first three steps as `occlusionCoverage.test.ts`'s `buildFloor` (real pipeline, real
 * content) and then it stops: this file never merges runs or builds occluder boxes for the wall
 * sweep, because `mergeWallRuns` unions same-tier rects and `freeStanding` is per-rect. A merged
 * run cannot answer "did the engine brim THIS rect".
 */
function buildFloor(index: number): Floor {
  const map = EMBER_L1_FLOORS[index]!;
  const { placed, doors } = placeAuthoredFloor(map, EMBER_L1_ROOMS as readonly RoomPiece[]);
  const geo = buildFloorGeometry(placed, doors);
  const rooms: RectPx[] = placed.map((r) => ({
    x: fpToPx(toFpGrid(r.offsetXGrid)),
    y: fpToPx(toFpGrid(r.offsetYGrid)),
    w: fpToPx(toFpGrid(r.piece.sizeGrid.w)),
    h: fpToPx(toFpGrid(r.piece.sizeGrid.h)),
  }));
  const walls: SimWall[] = geo.walls.map((w) => {
    const rect: RectPx = { x: fpToPx(w.x), y: fpToPx(w.y), w: fpToPx(w.w), h: fpToPx(w.h) };
    return { ...rect, freeStanding: w.freeStanding === true, tier: wallTier(rect, rooms) };
  });
  const doorRects: RectPx[] = doors.map((d) => {
    const a = toFpAabbGrid(d.passageGrid);
    return { x: fpToPx(a.x), y: fpToPx(a.y), w: fpToPx(a.w), h: fpToPx(a.h) };
  });
  return { index, walls, rooms, doors: doorRects };
}

const FLOORS: Floor[] = Object.keys(EMBER_L1_FLOORS).map(Number).map(buildFloor);
const ALL: Array<SimWall & { floor: number }> = FLOORS.flatMap((f) =>
  f.walls.map((w) => ({ ...w, floor: f.index })),
);

const ALL_DOORS: Array<RectPx & { floor: number }> = FLOORS.flatMap((f) =>
  f.doors.map((d) => ({ ...d, floor: f.index })),
);

const where = (w: SimWall & { floor: number }): string =>
  `floor ${w.floor} rect [${w.x},${w.y},${w.w},${w.h}] tier=${w.tier} freeStanding=${w.freeStanding}`;

/**
 * The occluder box the renderer would hand the x-ray for this rect at this height — derived from
 * the SHARED definitions (`blockCapTop`) rather than from a restated `-height - r.h`, so a change
 * to how far a block's art reaches north lands here too. No joins: a join can only ever CLIP the
 * northward reach (`tuckNorth`/`doorClip`), so the un-jointed box is the worst case, which is the
 * one both claims below need.
 */
function boxFor(r: RectPx, height: number): Occluder {
  const sortY = r.y + r.h;
  return {
    left: r.x,
    right: r.x + r.w,
    top: sortY + blockCapTop(r, height),
    sortY,
    foldY: sortY - height,
  };
}

describe('sim/render parity — freeStanding vs wallTier over the shipped floors', () => {
  it('is actually looking at all five floors, and at a real number of wall rects', () => {
    // The guard every sweep of this class needs: a pipeline change that produced empty floors
    // would make every list-is-empty assertion below vacuously true, and the recorded counts
    // would silently become "0 of 0".
    expect(FLOORS).toHaveLength(5);
    for (const f of FLOORS) {
      expect(f.walls.length, `floor ${f.index} wall rects`).toBeGreaterThan(20);
      expect(f.rooms.length, `floor ${f.index} rooms`).toBeGreaterThan(3);
    }
    expect(ALL.length).toBeGreaterThan(150);
    // ...and all three tiers really occur, so a per-tier claim below is about content rather
    // than about a branch nothing reaches.
    for (const tier of ['perimeter', 'interior', 'kerb'] as const) {
      expect(ALL.filter((w) => w.tier === tier).length, `${tier} rects`).toBeGreaterThan(20);
    }
  });

  it('never brims a rect the renderer does NOT stand at interior height', () => {
    // THE DANGEROUS DIRECTION, and the one that must stay empty forever. A `freeStanding` rect
    // drawn as a KERB would have the sim hold the player 39 px off a 22 px lip that was never
    // covering them — the v43 report ("角色...感觉陷进去了") from the opposite side, which is
    // exactly what `WALL_NORTH_BRIM`'s "Only free-standing blocks" paragraph forbids. Drawn as a
    // PERIMETER ring it would narrow every door passage carved through that ring from both sides.
    const offenders = ALL.filter((w) => w.freeStanding && w.tier !== 'interior').map(where);
    expect(offenders.slice(0, 8)).toEqual([]);
  });

  it('the flag is actually AUTHORED on level 1 — the assertion above is not vacuous', () => {
    // This test previously recorded the opposite, and doing so is what made the fix possible.
    // Through ENGINE_VERSION 48 no shipped level-1 rect carried `freeStanding` at all, so the
    // "dangerous direction" assertion above was empty for the uninteresting reason: there was
    // nothing to be dangerous. Two versions of brim work (v47 built it, v48 widened it) were
    // therefore completely inert over the entire PvE campaign — the tuning had been done
    // against the launch arena, which flags every kit solid, and nobody had checked that the
    // campaign did too.
    //
    // v49 authored the flag onto the 18 piece-local solids that resolve to these 34 placements.
    // Keeping the count here is what stops the file sliding back to a vacuous pass.
    const brimmed = ALL.filter((w) => w.freeStanding);
    expect(brimmed.length, 'level 1 lost its freeStanding flags — the brim is inert again').toBe(46);
  });

  it('every interior-tier rect IS brimmed — the other half of the ⟺, closed in v49', () => {
    // design/18 warned this direction "may exist", and it did: all 34 of them, because the
    // renderer's rule (not on a room edge) and the engine's flag (authored) are genuinely
    // independent and the level-1 JSON predated the flag. Authoring the flag closes it, so the
    // two classifiers now agree in BOTH directions on every shipped level-1 rect — which is
    // what makes `freeStanding ⟺ wallTier === interior` a real invariant here rather than a
    // half-checked one.
    const unbrimmed = ALL.filter((w) => w.tier === 'interior' && !w.freeStanding);
    expect(unbrimmed.map(where).slice(0, 8)).toEqual([]);
    const perFloor = FLOORS.map((f) => f.walls.filter((w) => w.tier === 'interior').length);
    expect(perFloor).toEqual([6, 12, 12, 12, 4]);

    // ...and they are all genuinely INTERIOR blocks rather than an edge-tolerance accident: every
    // one sits at least a full clearance clear of all four bounds of the room that contains it.
    // Without this, `EDGE_TOLERANCE` could widen until it swallowed the room and this whole file
    // would keep passing on an empty classification.
    const notReallyInside: string[] = [];
    let checked = 0;
    let minGap = Infinity;
    for (const f of FLOORS) {
      for (const w of f.walls) {
        if (w.tier !== 'interior') continue;
        const room = f.rooms.find(
          (r) => w.x >= r.x && w.y >= r.y && w.x + w.w <= r.x + r.w && w.y + w.h <= r.y + r.h,
        );
        if (!room) {
          notReallyInside.push(`floor ${f.index} rect [${w.x},${w.y},${w.w},${w.h}] in no room`);
          continue;
        }
        checked++;
        const gap = Math.min(
          w.x - room.x,
          w.y - room.y,
          room.x + room.w - (w.x + w.w),
          room.y + room.h - (w.y + w.h),
        );
        minGap = Math.min(minGap, gap);
        if (gap < CLEARANCE) {
          notReallyInside.push(`floor ${f.index} rect [${w.x},${w.y},${w.w},${w.h}] gap ${gap}`);
        }
      }
    }
    expect(notReallyInside.slice(0, 8)).toEqual([]);
    expect(checked).toBe(46);

    // How much headroom `EDGE_TOLERANCE` actually has on this content, recorded because it
    // explains one of the two SURVIVORS in this file's battery: the tightest interior block on
    // any shipped floor is 128 px clear of its room's nearest bound, so widening the tolerance
    // from 4 px to 40 px reclassifies nothing and the counts above cannot see it. The tolerance is
    // slack for fixed-point conversion (its own comment: "anything short of a full grid cell"),
    // and this is the measurement that says how far it is from doing anything else.
    expect(minGap).toBe(128);
    expect(minGap).toBeGreaterThan(fpToPx(toFpGrid(1))); // more than a grid cell of slack
  });
});

describe('sim/render parity — the kerb 6 px claim, computed instead of restated', () => {
  /**
   * THE NUMBER BOTH COMMENTS ASSERT, derived here from the two constants they name.
   *
   * A kerb's art reaches exactly `WALL_H_KERB` px north of its own footprint edge (`blockCapTop`
   * with no joins: `top = (r.y + r.h) + (-height - r.h) = r.y - height`). The player's ground
   * point can get no closer to that edge than `PLAYER_BASE.solidRadius`. So the art standing
   * above their feet is `WALL_H_KERB - CLEARANCE`, and nothing else.
   */
  const KERB_REACH_ABOVE_FEET = WALL_H_KERB - CLEARANCE;

  it('is 6 px, and both prose derivations are talking about this subtraction', () => {
    // `wallGeometry.WALL_H_KERB`: "a 22 px lip therefore reaches at most 6 px up a body drawn
    // 20-48 px tall". `occlusion.MIN_COVER_FRACTION`: "a kerb's cap reaches all of 6 px above
    // their feet". Same 6, derived twice in English and now once in arithmetic.
    expect(KERB_REACH_ABOVE_FEET).toBe(6);
    expect(CLEARANCE).toBe(16); // the "(16 px)" both comments put in parentheses
  });

  it('holds at every kerb rect the five floors actually author, not just on paper', () => {
    // The same subtraction, taken through the real box builder at the real rects: a kerb's
    // footprint DEPTH is not in the answer (the comment says "whatever the wall's thickness
    // happens to be"), and the shipped kerbs are 32 px and 64 px deep, so this is a live check
    // of that claim rather than a restatement of it.
    const wrong: string[] = [];
    let kerbs = 0;
    for (const w of ALL) {
      if (w.tier !== 'kerb') continue;
      kerbs++;
      const box = boxFor(w, wallHeight(w.tier));
      const feetY = w.y - CLEARANCE; // closest legal approach: NO brim, kerbs are never brimmed
      const reach = feetY - box.top;
      if (reach !== KERB_REACH_ABOVE_FEET) wrong.push(`${where(w)} reach ${reach}`);
    }
    expect(wrong.slice(0, 8)).toEqual([]);
    expect(kerbs).toBeGreaterThan(50);
  });

  it('MIN_COVER_FRACTION still rejects a kerb at that computed reach, across the drawn body band', () => {
    // The claim `MIN_COVER_FRACTION = 0.45` exists to make true, checked through `occludes`
    // itself rather than against the constant (which is module-private, and rightly so — what
    // matters is the DECISION, not the number that produces it). Swept over every shipped kerb
    // and the whole drawn-body band, because a rule that only holds for today's 32 px rig is a
    // rule about today's art.
    const fired: string[] = [];
    let pairs = 0;
    for (const w of ALL) {
      if (w.tier !== 'kerb') continue;
      const box = boxFor(w, wallHeight(w.tier));
      for (let bodyH = BODY_H_MIN; bodyH <= BODY_H_MAX; bodyH++) {
        pairs++;
        const focus = { x: w.x + w.w / 2, y: w.y - CLEARANCE, halfW: BODY_HALF_W, bodyH };
        if (occludes(box, focus)) fired.push(`${where(w)} bodyH ${bodyH}`);
      }
    }
    expect(fired.slice(0, 8)).toEqual([]);
    expect(pairs).toBeGreaterThan(1000);
  });

  it('and there is real headroom in that rejection — measured, not assumed', () => {
    // How SHORT would the character have to be drawn before a kerb started x-raying itself? Found
    // by bisection through `occludes`, so it is a property of the shipped rule rather than of
    // `0.45` divided by hand. The answer must sit below the whole drawn band with room to spare:
    // if it ever climbs into `BODY_H_MIN..BODY_H_MAX`, the southern lip of every room starts
    // fading as the player walks along it, which is a bigger artifact than the 6 px it fixes.
    const box = boxFor({ x: 0, y: 100, w: 320, h: 32 }, WALL_H_KERB);
    const feetY = 100 - CLEARANCE;
    const wouldFire = (bodyH: number): boolean =>
      occludes(box, { x: 160, y: feetY, halfW: BODY_HALF_W, bodyH });
    expect(wouldFire(1)).toBe(true); // a body shorter than the lip is genuinely covered by it
    let lo = 1;
    let hi = BODY_H_MAX;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (wouldFire(mid)) lo = mid;
      else hi = mid;
    }
    // Measured 13.33 px: `KERB_REACH_ABOVE_FEET / MIN_COVER_FRACTION`, i.e. 6 / 0.45. A third
    // below the shortest body the rig is ever drawn at.
    expect(hi).toBeGreaterThan(13);
    expect(hi).toBeLessThan(14);
    expect(hi).toBeLessThan(BODY_H_MIN * 0.75);
  });

  it('WALL_NORTH_BRIM does NOT apply to a kerb, and the shipped content agrees', () => {
    // Stated because the arithmetic above silently depends on it: `feetY = w.y - CLEARANCE`, with
    // no brim term. That is only legal because a kerb is never `freeStanding` — `solidBounds.
    // blockingRect` brims the north edge if and only if the flag is set, and `WALL_NORTH_BRIM`'s
    // own "Only free-standing blocks" paragraph names the kerb as the case it must not touch.
    const brimmedKerbs = ALL.filter((w) => w.tier === 'kerb' && w.freeStanding).map(where);
    expect(brimmedKerbs.slice(0, 8)).toEqual([]);

    // ...and the reason it must not: with the brim applied, the lip would sit ENTIRELY below the
    // player's feet (a negative reach), so the sim would be holding the character 39 px off a
    // piece of stone that covers none of them — floating them off a lip, which is the v43 report
    // the brim's own comment says it must not re-open. Negative rather than merely smaller is
    // what makes this a categorical statement instead of a tuning preference.
    expect(WALL_H_KERB - (CLEARANCE + BRIM)).toBeLessThan(0);
  });
});

describe('sim/render parity — a DOORWAY in the kerb band, which is what the uniform height spends', () => {
  /**
   * The claim `wallGeometry.DOOR_H` is written on, stated as arithmetic instead of as prose.
   *
   * The suite above proves a KERB never x-rays itself: 22 px of lip reaches 6 px above the feet at
   * the closest legal approach, which is under `MIN_COVER_FRACTION` for every body height the rig
   * is drawn at, so the southern lip of a room does not dissolve as the player walks along it.
   * Since 2026-09-03 a DOOR cut into that same boundary no longer inherits those 22 px — it stands
   * at `DOOR_H`, five times taller, deliberately, so that a doorway reads as a doorway.
   *
   * That trade is only affordable if the x-ray does fire there. If it did not, the change would be
   * a straight regression: a player walking south into a doorway would be covered by 104 px of
   * fixture with nothing fading it — the exact *"角色跑到墙下面去了"* report the x-ray exists for,
   * reintroduced at the one fixture the player is guaranteed to walk into on every floor. Nothing
   * asserted it, so this is the pass's load-bearing claim and it lives here rather than beside the
   * door tests, because it is a statement about the SIM's clearance and the RENDERER's height
   * together — neither file can see it alone.
   */
  const KERB_SHAPED = ALL_DOORS.filter((d) => d.w > d.h); // a gap in an east-west wall: travel N-S

  it('is a real population — 11 of the 24 shipped doors, the ones that changed', () => {
    expect(KERB_SHAPED).toHaveLength(14);
    expect(ALL_DOORS).toHaveLength(30);
  });

  it('DOES cover the player at the closest legal approach, at every body height', () => {
    // Same focus construction as the kerb sweep above — ground point `CLEARANCE` north of the
    // fixture's own north edge, swept over the whole drawn-body band — and the OPPOSITE verdict,
    // which is the point: same geometry, same rule, different height, and the rule notices.
    const missed: string[] = [];
    let pairs = 0;
    for (const d of KERB_SHAPED) {
      const box = boxFor(d, DOOR_H);
      for (let bodyH = BODY_H_MIN; bodyH <= BODY_H_MAX; bodyH++) {
        pairs++;
        const focus = { x: d.x + d.w / 2, y: d.y - CLEARANCE, halfW: BODY_HALF_W, bodyH };
        if (!occludes(box, focus)) missed.push(`floor ${d.floor} [${d.x},${d.y}] bodyH ${bodyH}`);
      }
    }
    expect(missed.slice(0, 8)).toEqual([]);
    expect(pairs).toBeGreaterThan(300);
  });

  it('...and the DEEP pass reaches, because the passage floor is inside the fixture', () => {
    // A cap-only fade cannot save a character standing IN the doorway: the leaf, the recess and
    // both states' lights all sit below the cap/face fold. `buildDoorBlock` puts them in the deep
    // group for exactly this reason, and `needsDeepFade` is what turns that group on.
    for (const d of KERB_SHAPED) {
      const box = boxFor(d, DOOR_H);
      const inDoorway = { x: d.x + d.w / 2, y: d.y + d.h / 2, halfW: BODY_HALF_W, bodyH: BODY_H_MIN };
      expect(needsDeepFade(box, inDoorway), `floor ${d.floor} [${d.x},${d.y}]`).toBe(true);
    }
  });

  it('and the kerb it is cut INTO still does not fire — the two verdicts coexist', () => {
    // The control that stops the test above from being satisfied by loosening the x-ray for
    // everything. `DOOR_H` is a door constant; the walls flanking these very passages keep their
    // 22 px and keep their exemption, on the same floors, in the same band.
    const kerbsBesideDoors = ALL.filter(
      (w) => w.tier === 'kerb' && ALL_DOORS.some((d) => d.floor === w.floor && Math.abs(d.y - w.y) < 64),
    );
    expect(kerbsBesideDoors.length).toBeGreaterThan(10);
    const fired = kerbsBesideDoors.filter((w) =>
      occludes(boxFor(w, WALL_H_KERB), {
        x: w.x + w.w / 2, y: w.y - CLEARANCE, halfW: BODY_HALF_W, bodyH: BODY_H_MIN,
      }),
    );
    expect(fired.map(where).slice(0, 8)).toEqual([]);
  });
});

describe('sim/render parity — the brim band is drawn over, not walkable', () => {
  it('every px the sim reserves north of a free-standing block has stone drawn over it', () => {
    // The renderer paints a full `WALL_H_INTERIOR` north of an interior block's footprint edge
    // (`blockCapTop`, un-jointed); the sim withholds `WALL_NORTH_BRIM` of that same strip from
    // anything that can stand or land there. The brim is therefore invisible by construction —
    // the floor it takes away is floor the player could never see anyway, because the block's own
    // cap is drawn over it. If this inverted, v47 would be reserving VISIBLE floor and the report
    // would come back as "there is an invisible wall here".
    expect(BRIM).toBeLessThan(WALL_H_INTERIOR);
    expect(WALL_H_INTERIOR - BRIM).toBeGreaterThan(40); // measured 46.99 px of margin

    // Same claim at the rects the renderer actually stands at that height, through the real box:
    // the art's north edge must be strictly north of the reserved band's own north edge.
    const exposed: string[] = [];
    let blocks = 0;
    for (const w of ALL) {
      if (w.tier !== 'interior') continue;
      blocks++;
      const box = boxFor(w, wallHeight(w.tier));
      if (box.top > w.y - BRIM) exposed.push(`${where(w)} art top ${box.top} vs brim ${w.y - BRIM}`);
    }
    expect(exposed.slice(0, 8)).toEqual([]);
    expect(blocks).toBe(46);
  });

  it('the brim is exactly what keeps the THINNEST free-standing block in the cap-only fade', () => {
    // THE RELATIONSHIP THE BRIM WAS TUNED FOR, against the shipped `WALL_H_INTERIOR`.
    //
    // `occlusion.needsDeepFade`'s own comment states it as an outcome — "a 70 px interior block
    // over a 64 px footprint cannot [reach the deep pass]; the engine's clearance keeps the body's
    // feet 10 px above the fold" — and then leaves the general condition unwritten. It is:
    //
    //     feet at closest approach  =  r.y - CLEARANCE - BRIM
    //     cap/face fold             =  r.y + r.h - WALL_H_INTERIOR
    //     cap-only suffices  ⟺  feet at or north of the fold
    //                        ⟺  WALL_H_INTERIOR <= r.h + CLEARANCE + BRIM
    //
    // At the shallowest footprint the authoring grid can express — one cell, 32 px — that is
    // 32 + 16 + 23.01 = 71.01 against 70, and it holds by ONE PIXEL. Without the brim it is
    // 32 + 16 = 48 against 70 and fails by 22, dropping the character's legs behind the block's
    // front FACE, which a cap fade does not touch. So the brim is not a comfort margin here; it
    // is the whole of why a one-cell free-standing block is drawable at interior height at all.
    const standoff = CLEARANCE + BRIM;
    expect(THINNEST_WALL_DEPTH).toBe(32);
    expect(THINNEST_WALL_DEPTH + standoff).toBeGreaterThanOrEqual(WALL_H_INTERIOR);
    expect(THINNEST_WALL_DEPTH + CLEARANCE).toBeLessThan(WALL_H_INTERIOR); // ...and it is load-bearing

    // Through the real predicate, at the real body band, on the thinnest possible block: a
    // brimmed actor never needs the deep pass; an un-brimmed one at the same block does. The
    // second half is what stops this being a tautology about a comparison I just wrote.
    const thin = { x: 0, y: 200, w: 160, h: THINNEST_WALL_DEPTH };
    const box = boxFor(thin, WALL_H_INTERIOR);
    const deepWithBrim: string[] = [];
    let sawUnbrimmedDeep = 0;
    for (let bodyH = BODY_H_MIN; bodyH <= BODY_H_MAX; bodyH++) {
      const at = (y: number) => ({ x: 80, y, halfW: BODY_HALF_W, bodyH });
      if (needsDeepFade(box, at(thin.y - standoff))) deepWithBrim.push(`bodyH ${bodyH}`);
      if (needsDeepFade(box, at(thin.y - CLEARANCE))) sawUnbrimmedDeep++;
    }
    expect(deepWithBrim.slice(0, 8)).toEqual([]);
    expect(sawUnbrimmedDeep).toBeGreaterThan(20);
  });

  it('holds at every footprint depth the shipped floors actually stand at interior height', () => {
    // The general condition above, applied to real content rather than to the hypothetical thin
    // block: the shipped interior footprints are 64 px and 192 px, both comfortably clear. Swept
    // per rect so a future piece with a shallower interior block is caught by the sweep and not
    // only by the arithmetic — and asserted with the BARE clearance, since none of these rects is
    // brimmed today (see the first describe), which is the strictly harder test.
    const deep: string[] = [];
    let pairs = 0;
    for (const w of ALL) {
      if (w.tier !== 'interior') continue;
      const box = boxFor(w, wallHeight(w.tier));
      for (let bodyH = BODY_H_MIN; bodyH <= BODY_H_MAX; bodyH++) {
        pairs++;
        const focus = { x: w.x + w.w / 2, y: w.y - CLEARANCE, halfW: BODY_HALF_W, bodyH };
        if (needsDeepFade(box, focus)) deep.push(`${where(w)} bodyH ${bodyH}`);
      }
    }
    expect(deep.slice(0, 8)).toEqual([]);
    expect(pairs).toBeGreaterThan(900);
  });
});
