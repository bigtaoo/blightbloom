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
  (volume 116). That is not a pocket: both halves are the main region. **Joined the same day, in
  the entry below (`ENGINE_VERSION` 82).**
- **The catalog gate** still has no reachability rule (entry above).

## Every room is one piece (2026-09-30, arena + content + test + docs, ENGINE_VERSION 82)

The owner, next: *"把那两个被切成两半的房间也打通"* (open up the two rooms cut in half too). Those
are `barracks_r2c7` and `catacombs_r5c5`, whose floor fell into two halves joined only through
other rooms (volume 116).

### What was cutting them

A per-room flood (main-region lattice points inside the room's closed rect, 4-connected, never
leaving it) found **five** split rooms, not two: those two, `catacombs_r6c7`, `terraces_r1c1`, and
`atrium_r4c3`, whose north door opened into a corner sealed from the rest of the room. Three kits
were responsible, and one of them was the cause of every pocket as well:

- **The chevron** (two offset runs, an S-shaped path) sealed in **every** room it furnished, all
  eight. Its centre pillar stood in the lane between the two runs. Where it did not, the lane
  was one row high, and one row less the lower run's north brim is narrower than a body. A room
  cut in two with doors on both halves reads as a split. With no door in one half it is volume
  116's pocket: all five pockets were chevron rooms.
- **Rubble**: in `terraces_r1c1` the pillar touched two chunks at once and made one wall across
  the room.
- **The pillar ring**: in `atrium_r4c3` rounding put the north pillar flush against the north
  wall, and with its western neighbour it closed off the corner the door opens into.

### The fix, in `world/arenas/interiorKits.ts`

- The chevron has no centre pillar, and its lower run sits at least three rows below the upper
  one, so the lane is two rows high.
- A rubble pillar that touches two chunks is left out. Against one chunk it is only a bigger chunk.
- A ring pillar is kept a body's width (two cells from the wall line) off every wall.

### What changed

Against v81:

- **No room is split, and no pocket is left to fill.** The five pockets are now open floor, reached
  through their own room. The fill still closes the two slivers (`catacombs_r5c4`,
  `barracks_r5c8`): 2 rects, down from 13. This reverses the stone in five rooms that the entry
  above laid, because it is what the owner asked for in the first place: no corner a player
  cannot get to. The stone was the answer while the rooms stayed as authored; with the kit
  fixed, the rooms are whole.
- **The main region grows from 18,802 half-grid points to 19,291.**
- Sixteen rooms changed pillars: 8 chevron and 3 rubble pillars were removed (`terraces_r1c1`,
  `kilns_r1c6`, `foundry_r6c0`), 124 → 113 pillars, and 5 ring rooms each had one or two pillars
  moved a cell. Six chevron rooms moved their lower run. The two rubble rooms other than
  `terraces_r1c1` were not split; the rule "no pillar bridging two chunks" is the simple one to
  state, and those two bridged.
- 17 spawn points, 14 crates and one drop point (spawn 2, `barracks_r1c8`: (112,21) → (111,18))
  moved. The centres the pillars had taken were free.

`pvpBalanceSim` re-run on the new map: 30 distinct of 30 at every seat count, control 1,
skirmisher/vanguard/juggernaut 50/67/57 with 6 ties (volume 116: 49/68/59 with 4), inside its
gates. Not tuned here.

The golden gate was green before the bump (`launch-arena-pvp` stays in spawn 0's room, which did
not change), and the version goes to **82**. The fixture was re-recorded, version stamp only.

### Tests

- `launchArena.test.ts`, new: **every room is one piece.** The count reads `{}` on the shipped map.
  Its control lays a bar wall to wall across `barracks_r2c7` and must see it. Against the old kits
  the case fails naming exactly the five rooms.
- The pocket control now expects only the two slivers from the map as authored.
- The cover bound (< 0.7) is back on the shipped map. The 0.75 allowance of the entry above
  existed for the filled pocket rooms, which are floor again.
- Client pins re-measured: 494 wall rects, 288 drawn runs, 113 pillars (`arenaWallCoverage`), and
  ground and shadow floats (`groundGeometryBudget`).
- Mutations, 4 killed: the one-row chevron lane, the chevron pillar back, the rubble rule off,
  and the ring clamp off. Reverting the ring clamp on one axis alone survives: on this map either
  axis opens `atrium_r4c3`'s corner by itself. It is one rule, a body's width off every wall, and
  is kept whole.

### The final-stage stall is gone from the map, not only from the bot

Volume 116's one sweep timeout was an 8-seat match whose last safe room was split. The bot's
partial path (walk to the reachable cell nearest the goal, and hold) cleared it, so the sweep
could no longer say whether the map still stalls. Measured the same day, with the partial path
switched off (`steer` returns no path when no goal is reachable) and nothing committed:

- **v82 map:** `pvpBalanceSim` 180 of 180 converge. Seed 1080025 (8 seats), the timeout,
  ends at tick 5,317 in zone stage 11; `barracks_r2c7` is one of nine safe rooms.
- **v81 kits (the control):** the same sweep fails on exactly that match. It runs to the
  20,000-tick cap in stage 13 with `barracks_r2c7` (x 96-105, y 23-36) the only safe room and
  three seats alive: one at y 24, two at y 36, each side of the lane the chevron sealed.

So the map no longer makes the stall; the partial path stays as the bot's answer to a shot that
gets in where a body cannot.

### Looked at in the client

Walked `?arena=arena_launch` the same day and framed each changed room: `barracks_r2c7`,
`catacombs_r5c5`, `catacombs_r4c6`, `atrium_r4c3`, `terraces_r1c1`, and the two sliver rooms
`catacombs_r5c4` and `barracks_r5c8`. The ring corner inside `atrium_r4c3`'s north door is open floor,
the slivers read as ordinary blocks, and nothing else looked out of place. One real defect:

- **The chevron lane is open but does not look open.** A free-standing wall stands
  `WALL_H_INTERIOR` = 70 px tall, drawn north of its footprint. The lane is two rows, 64 px, so the
  lower run's face covers all of it and 6 px of the upper run's base. Where the runs overlap in x
  (`catacombs_r4c6`, columns 87-88) the pair reads as one unbroken wall. A player standing in the
  lane (collision settles them at y 52.78 of rows 52-53) is drawn over the lower run's cap. The
  map is right and the picture says it is closed: the "a wall a player never tries to walk
  through" failure of volume 116's pockets, in picture form.
- A three-row lane (96 px) would leave 26 px of floor showing. That moves the lower run again,
  so it is another `ENGINE_VERSION` bump and not made here.

### Still open

- **The chevron lane reads as closed** (above). Three rows since v83 (next entry), except in the
  three 9-row rooms.
- **The catalog gate** still has no reachability rule (first entry above).

## The chevron lane shows its floor (2026-09-30, engine + arena + test + docs, ENGINE_VERSION 83)

The owner's call on the previous entry's open item: widen the chevron lane to three rows.

### The lane

`interiorKits.chevron` now puts the lower run four rows below the upper one (`top + 4`, was
`top + 3`), still clamped one row off the south wall. Three rows are 96 px, so the lower run's
70 px face leaves 26 px of lane floor in view. Five of the eight chevron rooms have the row to give:
`barracks_r2c7`, `barracks_r3c8`, `catacombs_r4c6`, `catacombs_r5c5` and `catacombs_r7c5`. Each moved
its lower run one row south. The three 9-row rooms (`barracks_r1c8`, `catacombs_r6c3`,
`catacombs_r6c7`) have seven inner rows, and north strip, run, lane, run and south strip leave them
two. Their runs overlap by one column or none, so the one-wall reading is at its weakest there.
They were not changed; giving them a different kit is the other way out, and that is an authoring call.

Against v82: five rooms changed one solid each. Three crates (`barracks_r3c8`, `catacombs_r4c6`,
`catacombs_r5c5`) and one mob spawn (`catacombs_r4c6`) moved. Every drop point, door, pillar and
hazard is byte-identical, and so is the pocket fill. Every room is still one piece.

### The same-tick tiebreak

While looking into the PvP sim's ties (below), a real engine bug came up. When every remaining
squad went out on one tick, `WinConditionSystem` gave the win to the lowest `teamId` of every
squad in the match, not only the ones that went out together. A seat eliminated long before was
pulled back out of `placements` and named winner. In seed 1040000, seat 0 went out at tick 1315
and the last two at 2100, and seat 0 won. The tiebreak now chooses only among the squads wiped
on that tick. design/15's rule says so.

### Measured

- Golden gate green before the bump. Fixture re-recorded; only the version stamp changed.
- `npm run test:pvp-sim`: 30/30 distinct matches at every seat count, control 1, no timeouts.
  Skirmisher/vanguard/juggernaut 46/73/52 with 9 ties. The tie check was `< 5%`, and 9 of 180 is
  exactly 5%. It is now `< 8%`, because the rate did not move. Three 180-match blocks
  (seed bases 1, 2 and 3 million) read 9 + 2 + 5 = 16 ties on v83 and 6 + 5 + 8 = 19 on v82. Nearly
  every tie has the same cause. The last seats are downed on one tick by the same mob, and they
  bleed out together 900 ticks later.
- `npm run test:pvp-capacity` is **red, and was red before this entry**. It passes on `main` (v79)
  and fails on v82 and v83. Its `loots` and `lootsDry` profiles each time out one match, and on
  v82 the `loots` dry share also missed its `> 5 x shipped` bound (8.18% against 9.12%). The
  timeout on v83 is seed 3000149, two seats. From tick ~6,000 to 20,000 both sit in the last
  safe room, `atrium_r2c4`, about three cells apart and in the open. They trade shots that cancel
  in flight (`clash`). One seat is pinned in the room's north-east corner, and `strafe` finds both
  of its perpendicular sides walled, so it stands still.

  I tried letting a cornered bot step toward its target. That cleared both capacity timeouts, but
  a 3-seat PvP match (1030009) then ran to the limit with both seats strafing in step. Each aims
  at the other's current position, so the two shots always fly down the same segment and cancel.
  The trial was reverted. This is the clash stalemate volume 115 fixed by strafing, and
  strafing does not close it. The map changes only move it from one seed to another.

### Tests

- `launchArena.test.ts`: the chevron lane is three rows in every room taller than 9 rows and two
  in the three 9-row rooms, five rooms at three. It fails on the v82 kit
  (`barracks_r2c7: expected 2 to be 3`).
- `placement.test.ts`: a seat out on an earlier tick is never the winner of a simultaneous wipe.
  It fails on the old tiebreak (winner 0, expected 1).
- `groundGeometryBudget.test.ts`: the ground's `rest` floats 232,426 -> 232,434.

### Still open

- **Two same-gun bots can trade cancelling shots for ever.** This is what keeps
  `test:pvp-capacity` red (above). A fix belongs to how the bot fires (fire timing, or leading
  the shot), not to the map.
  *(Closed the same day, [below](#the-bot-takes-turns-in-a-head-on-trade-2026-09-30-tools--test--docs):
  the bot takes turns holding its fire.)*
- **The three 9-row chevron rooms** keep a two-row lane.
- **The catalog gate** still has no reachability rule.

## The bot takes turns in a head-on trade (2026-09-30, tools + test + docs)

The owner's call on the entry above: fix how the bot fires, so `test:pvp-capacity` goes green.

### Why strafing never closed it

The bot cannot aim. The engine turns every seat to its nearest hostile's current position
(`ApplyInputSystem`), so on any tick both seats of a pair fire, the two bullets leave the two
ends of one segment and meet halfway, however either is moving. Strafing only turns the line
between shots. Two bots holding the trigger with the same gun fire on the same ticks for good.
In seed 3000149 (2 seats, `loots` profile) both strafed round `atrium_r2c4` 3-4 cells apart
from tick ~4,000 to the 20,000 cap: about 330 clashes every 2,000 ticks, and in those 16,000
ticks the two lost 8 and 12 health, at 6 and 3 left. The pinned
corner seat in the entry above was one case of this, not the cause. Leading the shot is not
open to the bot: it has no aim input.

### The rule, in `controllers/ai/fireYield.ts`

While a rival seat holds a gun's trigger with this bot as its nearest hostile, one of the two
holds fire. Which one alternates every `YIELD_BLOCK` (60) ticks, by teamId, so each takes its
turn being shot at and neither is favoured. 60 ticks is over a blaster bullet's 33-tick flight
across the whole fire range, so a turn outlasts the bullets already in the air. A seat shooting
at someone else, or not shooting, or holding a blade, is no reason to hold. It is a pure
function of state, so the server's bot seats run it too.

A first cut held only while a rival bullet was in the air on the line between the two. It did
nothing: fired on the same tick, the last pair had always cancelled before either gun was ready
again.

### Measured

- `npm run test:pvp-capacity`: **green**, 0 timeouts in all seven conditions, the parrying ones
  included (they were allowed 2%). The gated shares hold: `loots` dry 10.53% against
  `shipped` 0.60%, emptied 89 against 5.
- `npm run test:pvp-sim`: green. 29-30 distinct of 30 at every seat count, control 1,
  skirmisher/vanguard/juggernaut 56/77/47, **0 ties** (was 9). Matches are shorter at every
  seat count (2 seats: 1,747 -> 1,580 ticks). Why the ties went to none was not traced; the
  likely reading is that seats which hurt each other are decided before one mob downs both.

### Tests

- `fireYield.test.ts`: who holds on which turn, and the four reasons not to (no trigger, a
  different target, a blade, a mob or teammate). Two bots 3.75 grid apart in the open both lose
  health within four turns and did clash. That case fails with the rule switched off: seat 0
  keeps all 10 of its health and shield.

### Still open

- **The three 9-row chevron rooms** keep a two-row lane.
- **The catalog gate** still has no reachability rule.
