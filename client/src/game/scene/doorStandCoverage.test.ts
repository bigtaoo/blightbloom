/// <reference types="node" />
/**
 * Does the STANDING door fixture (2026-08-20, `doorRender.ts`) actually work on the shipped
 * content — and does every door really present the SAME way?
 *
 * **What this file used to hold, and why it changed (2026-09-03).** Until this pass a door
 * inherited the height of the shortest wall abutting its passage (`doorFlankTier`), and this
 * sweep's job was to prove that rule fired on real content. It did, and the measurement it
 * printed is what condemned the rule: 24 doors across the five shipped floors, 13 standing at
 * `WALL_H_PERIMETER` (a 64x128 passage through a room boundary, travel east-west) and 11 at
 * `WALL_H_KERB` — a 128x64 passage through the low boundary between two vertically stacked
 * rooms, drawn as a 128 x **22** letterbox under 64 px of its own cap stone, showing 12% of its
 * own leaf art. Nearly half the doors in the game were a fixture whose own lintel was three times
 * its opening. Live report
 * with a screenshot of one: *"有些门会被墙盖住... 我希望门的表现是单独的，统一的，不管墙有多厚"*.
 * So the height is now one constant, `wallGeometry.DOOR_H`, for every door — see there for what
 * that spends against the clearance rule `WALL_H_KERB` exists for.
 *
 * The sweep itself stays, because the risk it was written against is unchanged and this repo has
 * shipped it once already (`wallGeometry`'s old `w > h` guard left 1 wall standing where 32
 * should): a geometric claim that reads correctly, passes on hand-built fixtures, and matches
 * nothing in the real level. So this runs the REAL five shipped floors through the REAL pipeline
 * (`placeAuthoredFloor` → `buildFloorGeometry` → `wallTier` → `mergeWallRuns` → the doors' own
 * `wallJoins` pass, RoomBuilder's own sequence) and asserts that BOTH passage shapes still occur
 * — the uniformity claim is empty if the content only ever produces one of them.
 */
import { describe, it, expect } from 'vitest';
import {
  buildFloorGeometry,
  EMBER_L1_FLOORS,
  EMBER_L1_ROOMS,
  placeAuthoredFloor,
  toFpAabbGrid,
  toFpGrid,
  type RoomPiece,
} from '@dd/engine';
import { fpToPx } from '../coords';
import { wallHeight, wallTier, DOOR_H, DOOR_TIER, WALL_H_PERIMETER, type RectPx } from './wallGeometry';
import { blockCapTop, doorCapless, doorFlankHeight, mergeWallRuns, wallJoins, type WallRun } from './wallRuns';
import { faceCrownFraction } from './wallTone';
import { doorLeafFrame } from './doorRender';
import { readFileSync } from 'node:fs';

/** A shipped PNG's real pixel size, straight out of its IHDR — the same "measure the shipped
 *  bytes, not a fixture" route `rigComposition.test.ts` uses for the rig bundles. */
function pngSize(file: string): { w: number; h: number } {
  const buf = readFileSync(new URL(`../../../public/environment/${file}`, import.meta.url));
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

const FLOOR_INDICES = Object.keys(EMBER_L1_FLOORS).map(Number);


interface FloorGeo {
  runs: WallRun[];
  doorRects: RectPx[];
}

/** One shipped floor converted exactly the way `RoomBuilder.build` converts it at runtime. */
function floorGeo(index: number): FloorGeo {
  const map = EMBER_L1_FLOORS[index]!;
  const { placed, doors } = placeAuthoredFloor(map, EMBER_L1_ROOMS as readonly RoomPiece[]);
  const geo = buildFloorGeometry(placed, doors);
  const roomsPx: RectPx[] = placed.map((r) => ({
    x: fpToPx(toFpGrid(r.offsetXGrid)),
    y: fpToPx(toFpGrid(r.offsetYGrid)),
    w: fpToPx(toFpGrid(r.piece.sizeGrid.w)),
    h: fpToPx(toFpGrid(r.piece.sizeGrid.h)),
  }));
  const doorRects: RectPx[] = doors.map((d) => {
    const aabb = toFpAabbGrid(d.passageGrid);
    return { x: fpToPx(aabb.x), y: fpToPx(aabb.y), w: fpToPx(aabb.w), h: fpToPx(aabb.h) };
  });
  // A locked door's passage is folded into `walls` by DoorSystem at runtime and skipped by
  // RoomBuilder by reference identity; `buildFloorGeometry` here gives the carved (unlocked)
  // wall set already, which is the same list RoomBuilder's wall loop sees.
  const runs = mergeWallRuns(
    geo.walls.map((wall) => {
      const rect: RectPx = { x: fpToPx(wall.x), y: fpToPx(wall.y), w: fpToPx(wall.w), h: fpToPx(wall.h) };
      return { rect, tier: wallTier(rect, roomsPx) };
    }),
  );
  return { runs, doorRects };
}

/** Every run that touches `door` along the gap — a jamb, not a corner kiss. The stone each
 *  doorway is actually cut into, which is what the height USED to be derived from and is now
 *  only what it is measured AGAINST. */
function flanking(door: RectPx, runs: readonly WallRun[]): WallRun[] {
  const overlap = (a0: number, a1: number, b0: number, b1: number): number =>
    Math.min(a1, b1) - Math.max(a0, b0);
  return runs.filter((run) => {
    const r = run.rect;
    const ox = overlap(door.x, door.x + door.w, r.x, r.x + r.w);
    const oy = overlap(door.y, door.y + door.h, r.y, r.y + r.h);
    const touchesX = Math.abs(r.x + r.w - door.x) <= 1 || Math.abs(r.x - (door.x + door.w)) <= 1;
    const touchesY = Math.abs(r.y + r.h - door.y) <= 1 || Math.abs(r.y - (door.y + door.h)) <= 1;
    return (oy > 1 && touchesX) || (ox > 1 && touchesY);
  });
}

describe('every door presents the same — on the real shipped floors', () => {
  it('stands at DOOR_H whatever wall it is cut into, and both passage shapes still occur', () => {
    let doors = 0;
    let unflanked = 0;
    // The two shapes a shipped passage comes in, counted by the flank stone rather than by the
    // door: a rect wider than it is deep is a gap in an east-west wall (travel north-south), and
    // the low boundary between two stacked rooms is exactly where the OLD rule collapsed the
    // fixture to 22 px. Keyed on the SHORTEST flank so the count is directly comparable with the
    // 13/11 split this sweep printed before the change.
    const shapes = new Map<string, number>();
    for (const index of FLOOR_INDICES) {
      const { runs, doorRects } = floorGeo(index);
      for (const door of doorRects) {
        doors++;
        const flanks = flanking(door, runs);
        if (flanks.length === 0) unflanked++;
        const shortest = Math.min(...flanks.map((f) => wallHeight(f.tier)));
        const key = `${door.w}x${door.h} in ${shortest}px stone`;
        shapes.set(key, (shapes.get(key) ?? 0) + 1);
        // What this file can honestly assert about the height is the CONTENT side of it: the
        // stone a door is cut into really does vary (22 px on 11 of them, 104 on the other 13),
        // so "every door stands at one height" is a claim with something to be wrong about. That
        // the fixture actually gets that height is pinned where the production code decides it —
        // `RoomBuilder.test.ts`, over a built fixture, at BOTH flank heights — not restated here,
        // where re-deriving `DOOR_H` from `DOOR_H` would prove nothing.
        expect(shortest).toBeLessThanOrEqual(DOOR_H);
      }
    }
    expect(doors).toBe(30);
    // Every passage is a hole in stone — a door hanging in nothing would make the comparison
    // above vacuous rather than false.
    expect(unflanked).toBe(0);
    // ...and the content really does still produce both shapes, including the one the old rule
    // shrank: 11 doors in a 22 px kerb, which now stand at DOOR_H like the other 13.
    expect(shapes.get(`128x64 in ${wallHeight('kerb')}px stone`)).toBe(14);
    expect(shapes.get(`64x128 in ${WALL_H_PERIMETER}px stone`)).toBe(16);
  });

  it('shows over half of the real leaf art on every shipped door — the reported defect itself', () => {
    // THE assertion this whole pass is about, and the one class of claim the door suite did not
    // have: not "is the leaf there" or "is it positioned right" (both already swept) but HOW MUCH
    // OF IT SURVIVES THE CROP. `doorLeafFrame` fits by width and crops off the top, so the opening
    // height decides what the player actually sees of the door.
    //
    // Measured against the SHIPPED PNGs' own IHDR rather than a fixture, because the numbers only
    // mean anything at the art's real proportions — and because `doorRender.ts`'s header carried
    // "221x320-ish" for two weeks after the same 2026-08-20 pass re-trimmed the margins off, which
    // is exactly the kind of stale constant a fixture would have preserved. At `WALL_H_KERB` the
    // 11 kerb doors showed 25 of `door_locked_raw.png`'s 217 rows: 12%. At `DOOR_H` they show 55%,
    // and the 13 narrow ones show the whole leaf under a band of lintel.
    const art = {
      locked: pngSize('door_locked_raw.png'),
      open: pngSize('door_open_raw.png'),
    };
    expect(art.locked).toEqual({ w: 147, h: 217 }); // the trim this file's numbers are computed at
    expect(art.open).toEqual({ w: 156, h: 224 });

    const shown: number[] = [];
    for (const index of FLOOR_INDICES) {
      for (const rect of floorGeo(index).doorRects) {
        for (const [state, { w, h }] of Object.entries(art)) {
          const { srcH } = doorLeafFrame(rect.w, DOOR_H, w, h);
          const fraction = srcH / h;
          expect(fraction, `${state} leaf on a ${rect.w}x${rect.h} passage`).toBeGreaterThan(0.5);
          expect(fraction).toBeLessThanOrEqual(1);
          shown.push(fraction);
        }
      }
    }
    expect(shown).toHaveLength(60); // 30 doors x 2 states, or the sweep skipped something
    // The bound is not slack in one direction and vacuous in the other: the WIDE passages really
    // are the ones near it (0.55), and the narrow ones really do show the whole leaf.
    expect(Math.min(...shown)).toBeLessThan(0.6);
    expect(Math.max(...shown)).toBe(1);
  });

  it('reaches exactly one height north of its own footprint, and never inverts its cap', () => {
    // A block's cap reaches one height + its own depth north of its footprint. Doors get their
    // own joins pass in `RoomBuilder.buildDoors`, so this checks the result the renderer actually
    // uses, at the height it actually uses (`DOOR_H`, not a tier lookup).
    let tucked = 0;
    for (const index of FLOOR_INDICES) {
      const { runs, doorRects } = floorGeo(index);
      const doorRuns: WallRun[] = doorRects.map((rect) => ({ rect, tier: DOOR_TIER }));
      const joins = wallJoins([...runs, ...doorRuns], faceCrownFraction('fire')).slice(runs.length);
      for (const [i, run] of doorRuns.entries()) {
        const capTop = blockCapTop(run.rect, DOOR_H, joins[i]!);
        const reachNorth = -capTop - run.rect.h; // px of art north of the footprint's own north edge
        if (reachNorth < DOOR_H) tucked++;
        // Never more than one height north of its own footprint — the same bound a wall block
        // has, and the reason a doorway cannot bury the room's back wall.
        expect(reachNorth).toBeLessThanOrEqual(DOOR_H + 0.01);
        expect(capTop).toBeLessThanOrEqual(-DOOR_H); // never an inverted cap
      }
    }
    // The tuck has to fire somewhere or this is only re-proving the unclipped bound. It fires on
    // a passage DEEPER than the door stands tall (`64x128` through a room boundary, whole north
    // edge buried in the perimeter run beside it); a 128x64 kerb passage has open floor north of
    // it and correctly does not tuck — which is precisely why it now stands full height there.
    expect(tucked).toBeGreaterThan(0);
  });

  it('drops its cap where it out-tops the wall it is cut into — the 11 kerb doorways', () => {
    // The pass after `DOOR_H` (2026-09-03, live report with a screenshot circling the result:
    // *"我希望门的位置只有门，不要在入口的两端有墙"*). Standing all 24 doors at one height fixed the
    // letterbox openings and left a second artifact behind on exactly the 11 it fixed: a door's
    // CAP is the wall over its lintel, and it only reads as stone because it continues the crown
    // of the runs either side of it (`wallRender.addCapLayers`). A doorway through a 22 px kerb
    // out-tops those runs by 82 px, so its cap — a full footprint depth of tiled wall swatch —
    // hung in mid-air above the opening with nothing under it on either side.
    //
    // So a door draws a cap only where its flank reaches it (`wallRuns.doorFlankHeight`), and this
    // sweep is the claim that the split lands on the real content the way it is meant to: all 11
    // kerb doorways capless, all 13 perimeter ones keeping the full cap they always had. Built
    // through `RoomBuilder.buildDoors`' own sequence — the doors' second `wallJoins` pass, then
    // the flank measurement folded into it — so a regression in either half shows up here.
    let capless = 0;
    let capped = 0;
    for (const index of FLOOR_INDICES) {
      const { runs, doorRects } = floorGeo(index);
      const doorRuns: WallRun[] = doorRects.map((rect) => ({ rect, tier: DOOR_TIER }));
      const joins = wallJoins([...runs, ...doorRuns], faceCrownFraction('fire')).slice(runs.length);
      for (const [i, run] of doorRuns.entries()) {
        const flank = doorFlankHeight(run.rect, runs);
        expect(flank, `${run.rect.w}x${run.rect.h} doorway has no flank stone`).not.toBeNull();
        // Through `doorCapless` — the production predicate `RoomBuilder.buildDoors` calls, not a
        // second copy of the rule that could agree with the doc and disagree with the renderer.
        const j = doorCapless(run.rect, runs, DOOR_H) ? { ...joins[i]!, capless: true } : joins[i]!;
        if (j.capless) {
          capless++;
          expect(flank).toBe(wallHeight('kerb'));
          // Capless means exactly this in the geometry every cap cue reads: the cap starts and
          // ends on the fold, so `addCapLayers`, the depth gradient and the edge bevel all size
          // to zero and the fixture's topmost row is the top of its own arch.
          expect(blockCapTop(run.rect, DOOR_H, j)).toBe(-DOOR_H);
        } else {
          capped++;
          expect(flank).toBe(WALL_H_PERIMETER);
          // Unchanged from before the pass: real stone over the lintel, landing on the same rows
          // as the flanking runs' own caps. Its DEPTH is the footprint's, less whatever the tuck
          // clips off (all 13 of these are 64x128 passages, deeper than they stand tall, so all
          // 13 tuck — the `toBeLessThan` below is what keeps that from going unnoticed).
          const capDepth = -DOOR_H - blockCapTop(run.rect, DOOR_H, j);
          expect(capDepth).toBeGreaterThan(0);
          expect(capDepth).toBeLessThanOrEqual(run.rect.h);
          if (joins[i]!.tuckNorth) expect(capDepth).toBeLessThan(run.rect.h);
        }
        // The tuck is not what is doing this: a kerb doorway has open floor north of it and never
        // tucked, which is exactly why its cap was free to hang there in the first place.
        if (run.rect.w > run.rect.h) expect(joins[i]!.tuckNorth).toBe(false);
      }
    }
    expect([capless, capped]).toEqual([14, 16]);
  });
});
