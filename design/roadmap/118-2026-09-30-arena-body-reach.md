# Work log — 2026-09-30

Volume 118. See [`design/ROADMAP.md`](../ROADMAP.md) for the index and the phase spine.

## Nothing spawns where no body can go (2026-09-30, engine + arena + content + test + docs, ENGINE_VERSION 80)

Volume 116 left one content issue open. `arena_launch` has five pockets no player can walk
into, two of them sealed only by a free-standing block's north brim, and mobs spawn inside
them. The bot learned to walk away from a mob it cannot reach. A player cannot reach it either,
so the room's encounter never clears. The issue gave two ways out: open the pockets, or stop
spawning into them. This pass takes the second. Opening them changes the map's layout, and that
call is the owner's.

### Why the map builder placed them there

`launchArena.furnish` placed spawns, loot and drop points on cells no solid covers, one room at
a time. That is a bullet-sized question. It never asked whether a body could get there, and
it could not ask whether the free cell it picked was connected to the rest of the map. The
existing `launchArena.test.ts` flood fill ("what the north brim costs the launch map") compares
the map with and without the brim, and counts a room as reached if any of its cells is in the
main region. A room that is part reachable and part pocket passes that test, and each of the
five did.

### The fix

- **`engine/content/arenaBodyReach.ts`** (new): `measureBodyReach(geometry)` floods the
  assembled map on half-grid cells. A cell is standable when a body centred on it touches no
  pillar and no wall's collision rect (`blockingRect`, so the brim counts). The clearance is
  the player's solid radius less a hair (490 fp), the same figure `ai/steer.ts` uses, so the
  bot and the map agree. The largest 4-connected region is the main one. `reaches(point)` is
  true when a main-region cell lies within one grid of the point. The slack is needed because a
  corner spawn at room cell (1,1) sits flush against the perimeter wall, where no body centre
  fits. About 3–10 ms at module load, with each solid marking only the cells near it.
- **`launchArena.buildLaunchArena`** furnishes every room twice. The first pass fixes the
  solids, and solids never depend on content, so its flood is the map's flood. The second pass
  places content with the unreached cells taken out (`freeCellsNear`'s new `reach` argument).
  The drop points go through the same filter.

### What moved

Seven placements, all in the five pocket rooms:

| room | what | before | after |
|---|---|---|---|
| `barracks_r1c8` | encounter spawn 0 (basic) | (2,2) | (4,7) |
| `catacombs_r4c6` | encounter spawn 0 (galvanist) | (2,2) | (2,6) |
| `catacombs_r4c6` | encounter spawn 2 (galvanist) | (13,2) | (12,9) |
| `catacombs_r7c5` | encounter spawn 1 (floater) | (6,8) | (7,4) |
| `barracks_r3c8` | crate | (9,5) | (6,1) |
| `barracks_r3c8` | spawns 1, 2 (no encounter) | (10,7), (7,1) | (7,1), (5,1) |
| `catacombs_r6c3` | spawn 0 (no encounter) | (2,2) | (2,7) |

In `barracks_r3c8` the second spawn only moved because the first took its cell. Every other
room and all eight drop points are byte-identical. That was checked by dumping the map before
and after, not assumed.

### The gate, and ENGINE_VERSION

The golden gate ran green before the bump. `launch-arena-pvp` plays spawn 0's room and never
wakes a pocket room. A recorded arena match that did wake one diverges, because those mobs now
spawn elsewhere. v65 set the precedent that moving authored content bumps the version, so this
bumps to **80**. The fixture was re-recorded, and only the version stamp moved.

### Why the rule is not in `auditArenaQuality`

The catalog-wide gate is where a rule for every future arena would belong. But its fixture maps
(`healthyMap`, `chainMap`) wall every room solid and give doors only in the graph: no body can
cross them, and a reachability rule would fire on every one. Cutting real openings into those
fixtures would move their cover and perimeter numbers under twenty other cases. The rule lives
in `launchArena.test.ts` for now. The gate's own header allows a per-map test to be stricter.

### Tests

- `arenaBodyReach.test.ts`, 5 cases: a one-grid gap passes a body; the same gap closed by a
  free-standing block's brim seals the far side; the larger half is main whichever side it is
  on; a wall-flush point is reached while a point deep in a solid is not; a pillar keeps a body
  off by both radii.
- `launchArena.test.ts`, 2 cases. First, no loot, spawn or drop point is placed where a body
  cannot get to it. Second, the control: the pockets are still in the map, pinned by room.
  Writing it found two slivers volume 116 did not list, `catacombs_r5c4` (9 cells) and
  `barracks_r5c8` (3). Nothing is placed in either.
- Mutations, 4 killed: the builder ignoring reach; the flood ignoring the brim; no slack; the
  smallest region kept as main.

### Still open

- **The pockets themselves.** Five rooms keep floor no one can stand on, which the renderer still
  paints. Opening them, or filling them in as stone, is a map-layout decision. **Filled with
  stone the same day, on the owner's call (next entry, `ENGINE_VERSION` 81).**
- **`barracks_r2c7` and `catacombs_r5c5`** still split into halves joined only through other
  rooms (volume 116). Both halves are reachable, so nothing is stranded. The split is what
  stalls a final zone stage, and it is also the owner's call.
- **The catalog gate** has no reachability rule until its fixtures have real openings (above).

## The pockets are stone (2026-09-30, engine + arena + content + test + docs, ENGINE_VERSION 81)

The entry above stopped placing content in the pockets and left them as painted floor. The owner
chose between opening them and filling them: *"把那些死角直接填成石头"* (fill the dead corners in
as stone). This pass does that.

### What is filled

**`world/arenas/pocketFill.ts`** (new, a free function beside `launchArena.ts`) returns a room's
extra solids from its authored solids, pillars, hazards and the map's body flood:

- a **candidate** is a free cell (no solid, no pillar cell, no hazard) whose stone, north brim
  included, touches no main-region position (`BodyReach.wouldBlockMain`, new);
- a **seed** is a candidate holding stranded floor: a lattice point a body fits on, outside the
  main region;
- the fill is every candidate 4-connected to a seed inside the room, merged into rects (row runs,
  stacked where the rows below repeat them).

The seed rule is what tells a pocket from the band of floor just north of every free-standing
block. No body centre fits on that band either, since the brim reaches into it, but a body
standing north of it still overlaps it. Flagging every cell no body centre fits on, which was
the first draft, marked that band in almost every room. The connectivity rule then takes in
the pocket cells no body centre fits on (brim shadow, corners), so a pocket closes as one mass.
The candidate rule is what keeps the fill from costing anything: stone is only laid where a body
in the main region never stood.

The fill is `freeStanding`, like the kit blocks it grows out of. The renderer stands it at
interior height, so it needs the same north brim, and the candidate test counted that brim.

`buildLaunchArena` does it in the second furnishing pass. `buildLaunchArena({ fillPockets: false })`
builds the map as authored, and exists as the control for the tests below.

### What changed

Seven rooms gained stone: volume 116's five (`catacombs_r4c6`, `barracks_r3c8`,
`catacombs_r7c5`, `barracks_r1c8`, `catacombs_r6c3`) and the two slivers (`catacombs_r5c4`,
`barracks_r5c8`). Against v80:

- **The main region is identical**, lattice point for lattice point: 18,802 half-grid cells.
- **Every spawn, crate, drop point, door, pillar and hazard is byte-identical.** Only the solids
  changed, and each room's authored solids come first, unchanged.
- **No room holds stranded floor.** In `barracks_r1c8`, `catacombs_r6c3` and `catacombs_r7c5`
  a pillar straddles the seal. Its cells are left as they are, and the stone is laid round it.

Bullets now stop on the new stone, so a recorded arena match whose shot crossed a pocket
diverges. The golden gate was green before the bump (`launch-arena-pvp` never shoots into one),
and the version goes to **81**. The fixture was re-recorded, and only the version stamp moved.

### Two tests it moved

- **"Cover without filling it in"** (max cover fraction < 0.7) read 0.7085 for `catacombs_r7c5`.
  The fill is not cover. The < 0.7 bound is now checked on the map as authored, and the shipped
  map is held under 0.75. The five pocket rooms read 0.67–0.71.
- **"Narrows 7 gaps past the player"** read 9. The two new ones were not gaps: one measured a fill
  block against the next room's wall across its own room's north wall, and the other a gap a
  pillar stands in. Filtering out any gap something already stands in removed those two, and six
  of the original seven with them, for the same two reasons. Only one real one-grid pinch was
  ever there, and it is still a corner. The test now reads 1, and its comment says what the 7
  was.

### Tests

- `pocketFill.test.ts`, 5 cases:
  - a brim-sealed pocket is filled, with no stranded floor after, the main region unchanged, and
    at most three merged rects;
  - the same gap without the brim fills nothing;
  - the floor band north of a block in open floor stays floor;
  - a cell whose fill brim would take a standing place stays floor;
  - pillar and hazard cells are never covered, and the pocket round them still is.
- `launchArena.test.ts`: the pocket control is now two cases. First, the shipped map has no
  pocket room, and the map as authored has the seven. Second, against the map as authored:
  the same main region, everything but the solids equal, only the seven rooms grew, and the
  authored solids are kept in front.
- Mutations, 7 killed: no main-region check, no connectivity (seeds only), pillars ignored,
  hazards ignored, no vertical merge, fill not `freeStanding`, and brim left out of the
  candidate test. The last two needed their cases added: the first battery left both alive.

### Still open

- **`barracks_r2c7` and `catacombs_r5c5`** still split into halves joined only through other rooms
  (volume 116). That is not a pocket: both halves are the main region.
- **The catalog gate** still has no reachability rule (entry above).
