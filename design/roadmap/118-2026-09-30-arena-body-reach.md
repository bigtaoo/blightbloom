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

*(Superseded the same day: the gate checks it per room, [last entry](#the-catalog-gate-checks-a-body-2026-09-30-arena--test--docs).)*

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
  every tie has the same cause. The last seats are downed on one tick, and they
  bleed out together 900 ticks later. *(The cause given here was "by the same mob". That was
  wrong: traced the same day, [below](#why-the-ties-went-to-none), 13 of the 16 are the two
  seats shooting each other down on one tick.)*
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
  seat count (2 seats: 1,747 -> 1,580 ticks). The ties went to none because two seats no longer
  fire at each other on the same ticks ([below](#why-the-ties-went-to-none)).

### Why the ties went to none

Traced the same day. Each of the three 180-match blocks (seed bases 1, 2 and 3 million) was run
twice, with the rule off and on.

- **Off: 16 ties. In all 16 the last two seats were downed on the same tick.** In 13 of them
  the last hit on both seats came from a seat's bullet. In a 2-seat match (1020022, 1020025,
  2020006, 3020005, 3020026) that can only be the two shooting each other down on one tick. In
  the other 3, one seat was downed by a mob on the tick the other was shot. The entry above
  blamed "the same mob". That was a guess, and it was wrong: in none of the 540 does a mob down
  both seats.
- **On: 0 ties.** Every one of the 16 seeds ends with a winner. Two bots with the same gun
  fired on the same ticks. Most pairs of bullets met and cancelled, but when both landed, they
  landed on the same tick. Once only one of the two fires at a time, the hits are never
  simultaneous, and neither is the downing.
- Across the 540 matches, clashes fell from 50,225 to 10,935, and total match length fell 8%
  (1,144,811 ticks to 1,037,855).

A tie is still a real outcome, since two humans can trade a last shot. The rule for one is
pinned by `placement.test.ts` (above), not by this sim, and the sim's `< 8%` tie check now
guards a rate of 0 against a spike.

### Tests

- `fireYield.test.ts`: who holds on which turn, and the four reasons not to (no trigger, a
  different target, a blade, a mob or teammate). Two bots 3.75 grid apart in the open both lose
  health within four turns and did clash. That case fails with the rule switched off: seat 0
  keeps all 10 of its health and shield.

### Still open

- **The three 9-row chevron rooms** keep a two-row lane.
- **The catalog gate** still has no reachability rule. *(Closed the same day, next entry.)*

## The catalog gate checks a body (2026-09-30, arena + test + docs)

The owner's call on the open item above: hold every catalog map, not only `arena_launch`, to the
body-reach rule.

### Why per room

The first entry kept the rule out of the gate because its fixture maps wall every room solid
and give doors only in the graph. A flood of the whole map from its largest region strands all
but one room of each. That flood asks whether the doors open, which is the door graph's question
(`door_gates_nothing`, `undoored_leak`). What shipped wrong was inside the rooms, and a room shows
it alone: floor sealed off by a brim with mobs spawned on it, and floors in two halves joined only
through other rooms. So nothing in the fixtures had to change.

### The rules

New `engine/content/arenaBodyAccess.ts`, `measureBodyAccess(map)`, reuses `measureBodyReach`'s
standable lattice and floods it per room, inside the room's closed rect (a doorway on the edge
counts with the room). Two new `defect` rules in `auditArenaQuality`, 23 in all:

- **`room_split`**: a room's standable floor is more than one piece.
- **`content_unreached`**: loot, an enemy spawn or a drop point that no body on its room's largest
  piece gets within one grid of (the slack `BodyReach.reaches` allows). Content outside its own
  room is left to `content_outside_room`, a drop point outside every room to `spawn_outside_room`.

What it still does not see: a room with no open door at all. That needs the whole-map flood, and
the fixtures would need real openings first.

### Measured

- `arena_launch` clears both. Built without its pocket fill, it fails the gate on `room_split`
  alone, in exactly the two sliver rooms (`barracks_r5c8`, `catacombs_r5c4`): the real-content
  control.
- The dense-cover fixture now also fires `content_unreached`, since its drop point sits in stone.
  Correct, and nothing asserted its full list.

### Tests

- `arenaBodyAccess.test.ts`, 4 cases: a room whose halves meet only through its neighbour splits,
  and its smaller half's loot is reported; a sealed room is held to its own floor, with a
  wall-flush corner spawn reached; content outside its room and a drop point outside every room
  are left to other rules; a drop point buried in stone is reported.
- `arenaQuality.test.ts`, 4 cases: a wall-to-wall bar fires `room_split` and one two grid short
  does not; loot inside a block fires `content_unreached` and loot against its face does not; a
  sealed pocket with a mob in it fires both; a buried drop point is named. The completeness sweep
  lists both rules.
- `launchArena.test.ts`, 1 case: the control above.
- Mutations, 8 killed of 8: the flood leaving the room's rect; a split needing three pieces; no
  slack; the smallest piece kept; drop points or enemy spawns not checked; content outside its
  room checked; the room offset dropped.

### Still open

- **The three 9-row chevron rooms** keep a two-row lane.
- **A room with no open door** passes the gate (above). *(Closed the same day, next entry.)*

## Every door lets a body through (2026-09-30, arena + test + docs)

Continuing from the open item above, unprompted beyond "继续" (continue): a doorway walled back up
passed the gate. The two rules above ask each room about itself, and the graph rules ask the door
list, so a shut door between two rooms that still meet the long way round tripped nothing.

### The rule

`measureBodyAccess` gains `shutDoors`, and `auditArenaQuality` a 24th rule, **`door_shut`**
(`defect`). Per door, it floods each room's largest floor piece inside that room plus the door's
passage, never the other room, and calls the door open when the two floods meet inside the
passage. Asking about the passage and not the room pair matters: the first draft flooded both
rooms together, and a second gap between the same two rooms opened a walled one
(`arenaBodyAccess.test.ts` caught it). A door naming a missing room is left to the graph rules.

### The fixtures got real doors

The gate's fixtures gave doors only in the graph, which is why the first entry stayed per room.
`arenaQuality.test.ts` now has `opened(map)`: each door's passage is stretched from one room's
facing wall to the other's, keeping its span across, and cut out of both walls. The jambs stay,
so `door_gates_nothing` still sees a wall. Two of `healthyMap`'s doors, `b-e` and `d-e`, turned
out to join rooms that meet only at a corner; `e` is now 11x20 at (40, 5), so it faces both.
`healthyMap(size)` replaces the stamped fixtures' re-walled 10x10 rooms, which lost the openings
(12x20 is a size that keeps every door facing a wall). The bogus-door case now emits
`door_gates_nothing` and `door_shut`: a passage in open floor is also a door into nothing.

### Measured

- `arena_launch`: 74 doors, none shut, with or without the pocket fill. Walling any one passage
  (tried doors 0, 30 and 73) reports exactly that door, and `room_split` and `content_unreached`
  stay silent, which is the gap this closes.
- Cost: the whole `measureBodyAccess` on `arena_launch` runs in about 65 ms.

### Tests

- `arenaBodyAccess.test.ts`, 1 case: walling `r`'s north gap shuts the `l-r` door while its
  south gap keeps `r` whole; a door naming a missing room is skipped. The `pair` fixture's
  passage now spans the wall and the floor behind it, as `slotGrid.doorBetween` does.
- `arenaQuality.test.ts`, 1 case: one doorway of `healthyMap` walled fires `door_shut` alone
  (the rooms still meet via `a-c-d-b`); walling one of its two rows does not, since a body is
  one grid wide. The completeness sweep lists the rule.
- Mutations, 6 killed of 8. Two are equivalent and recorded in the code: dropping the passage
  from one side's flood, and scanning the passage box open-ended.

### Still open

- **The three 9-row chevron rooms** keep a two-row lane. *(Closed the same day, next entry.)*

## No 9-row room is a chevron (2026-09-30, engine + arena + test + docs, ENGINE_VERSION 84)

The owner's call on the open item above, the first of three offered: give the three 9-row
chevron rooms a different kit, rather than drop the chevron's strip against a wall or accept the
two-row lane.

### The kits

`barracks_r1c8`, `catacombs_r6c3` and `catacombs_r6c7` have seven inner rows, and north strip,
run, lane, run and south strip leave the lane two rows, all covered by the lower run's 70 px face.
Each candidate kit was built into all three rooms and run through the quality gate; all passed.
Chosen, for the district and the neighbours:

| Room | Inner | Kit | Why |
|---|---|---|---|
| `barracks_r1c8` | 11x7 | rubble | The barracks' one rubble room. `r1c7` and `r2c8` next door are stubs already. |
| `catacombs_r6c3` | 7x7 | four pillars | The smallest room; four discs break every line across it and cost no row. |
| `catacombs_r6c7` | 8x7 | stubs | A corner to clear at every door, the centre open. |

Vault was ruled out because it changes the room's loot table, and so the economy. The ring's
discs ran together in both catacombs rooms, and the colonnade's two rows would stand two rows
apart, touching.

Against v83: only the three rooms changed. Six chevron runs came out; four rubble blocks, four stubs
and four pillars went in. Their mob spawns and crates are placed again from the new free cells,
and `barracks_r1c8`'s drop point moves from (111, 18) to (112, 17). In `catacombs_r6c3` the
pillars leave free cells mostly along the north wall, so its three mobs and its crate now all
stand on the first row. Every other room, door, pillar,
hazard and drop point is byte-identical, and every room is still one piece.

### Measured

- The golden gate was green before the bump: no scenario enters the three rooms.
  `ENGINE_VERSION` 84, because a recorded match that did enter one diverges.
- Client geometry pins: walls 494 → 496 rects, 288 → 290 drawn runs, pillars 113 → 117; the
  ground's additive half 228,136 → 228,060 floats and `rest` 232,434 → 232,342; the largest
  shadow piece 48,384 → 48,720.
- `test:sims` green, every one. PvP sim: 29-30 distinct matches of 30 per seat count (two
  seats read 29), control 1, no timeouts, 0 ties of 180, wins s/v/j 56/75/49.
  `test:pvp-capacity` has no timeouts in any condition. `npm run audit:arena` is clean.

### Tests

- `launchArena.test.ts`: the chevron-lane case now names the five chevron rooms and holds every
  one to three rows. It fails on v83, which has eight. The brim-pinch case reads 2 and not 1:
  `barracks_r1c8`'s rubble adds a second one-cell corner notch, the same shape as the first
  (`kilns_r1c6`, also rubble), and the "no overlap past one cell" assertion still holds.

### Still open

- Nothing from this volume.

## A bullet turns back once (2026-09-30, engine + tools + test + docs, ENGINE_VERSION 85)

The owner's call on [volume 117](117-2026-09-29-pvp-capacity.md)'s parry stalemate: change the
deflect rule, not the bot. Of the two fixes that volume named, a rebound that cannot be parried
back was chosen over one that decays. It is the simpler rule, and it ends the rally at the
second swing, not after several.

### The rule

`DeflectSystem` latches `Projectile.deflected` on a bullet's first deflect, and a latched bullet
is no candidate for any later swing, the shooter's own included. Before, the shooter's swing
turned the rebound again, at half damage (`PVP_DEFLECT_DAMAGE_PERMILLE`, floored at 1), and two
frame-perfect parriers could keep one bullet between them until the tick limit. The weakened
shot never landed, because it was parried again. The answer to a rebound is now to dodge it, or
to cancel it with a shot of your own (a `clash`).

PvE does not change. Only a player deflects, and in co-op every seat is one team, so no bullet a
player owns is hostile to another player. The latch is hashed in `serializeState`, appended
only to a bullet that has it, so a bullet nobody parried hashes as before.

The capacity sim's bot (`bulletIncoming`) no longer counts a latched bullet as a reason to
swing, since a swing cannot turn it.

### Measured

- The golden gate, run before the bump, failed in `launch-arena-pvp` alone. Its witness reads
  `deflect` 3 -> 2, every other count equal: one rebound in that run used to be parried back.
  `ENGINE_VERSION` 85, golden fixture regenerated.
- `test:pvp-capacity`, same seeds, before -> after:

  | condition | parries | mean ticks | timeouts |
  |---|---|---|---|
  | `parries` | 14,508 -> 3,238 | 2,428 -> 2,041 | 0 -> 0 |
  | `full` | 9,792 -> 3,037 | 2,046 -> 1,954 | 0 -> 0 |
  | `full pool100` | 9,843 -> 3,009 | 2,039 -> 1,908 | 0 -> 0 |
  | `full pool30` | 6,483 -> 1,792 | 2,037 -> 1,908 | 0 -> 0 |

  About three parries in four were a rebound turned back again. The conditions without a parry
  read the same (`shipped` and `loots` are byte-identical). The timeouts were already 0 before
  this pass: the fire yield above made two seats rarely shoot at each other on one tick, which
  is what started a rally. The rule removes the rally itself, so the 2% allowance goes.
- `npm run check` green; every `test:sims` gate green.

### Tests

- `teamHostility.test.ts`: a rebound goes through the shooter's own live swing, keeping its team,
  course and damage, while a fresh shot meets the same swing and is turned. It fails on the old
  rule (`expected 1 to be 0`: the rebound changed team).
- `replay.test.ts`: the latch appends one value to a bullet's hashed row and changes the hash;
  an unlatched bullet's row is unchanged.
- `pvpCapacity.sim.ts`: every condition must end every match. The parrying ones were allowed 2%.

### Still open

- Nothing from this volume. Whether a human parries well enough to feel the change is still a
  playtest question, and the shipped arena bot still never parries.

## A squad starts together (2026-09-30, arena + test + docs)

The owner's call on [volume 115](115-2026-09-29-arena-spawns.md)'s open item: squadmates started
in separate districts. `assignArenaStarts` gave every seat of every match one plain shuffle of
the eight authored spawns, so an 8-seat match (two squads of four) opened as eight lone fights
spread over the map. Squadmates should start on neighbouring spawns, and the two squads apart.

### The rule

`client/src/game/match/pvpConfig.ts`, client-side like the rest of the spawn assignment (no
engine change, no `ENGINE_VERSION` bump; replays embed their config):

- `spawnRingOrder` sorts the spawns by angle round their centroid, in integer arithmetic (the
  client and the server build the config independently, and an `atan2` that rounds differently
  on one JS engine would seat a squad elsewhere). On `arena_launch`, one spawn per outer
  district, the ring reads E, SE, S, SW, W, NW, N, NE.
- In a match with squads (`squadSizeForPlayerCount` > 1), each squad takes a run of neighbouring
  ring spawns, the runs spaced evenly round the ring.
- Of the ways to turn that cut round the ring, the **tightest** is used, the one with the least
  summed squared distance between squadmates. On `arena_launch` that is the west half
  {S, SW, W, NW} against the east half {N, NE, E, SE}. It is also the tightest of all 35 ways to
  split the eight spawns in two, and the only one that starts no seat nearer the enemy than its
  own squad. The other three ring cuts each end a run beside an enemy spawn and leave one or two
  such seats. A seeded rotation, tried first, did exactly that: seed 1 started the north seat
  38 grid from an enemy and 79 on average from its own squad.
- The seed picks among equally tight cuts (which squad takes which half) and shuffles the members
  within their run: 2 x 4! x 4! seatings.
- A free-for-all match keeps the plain shuffle, seat for seat, on the same stream.

### Measured

- Every match without squads starts where it did: `test:pvp-capacity` (2, 4 and 6 seats) is
  byte-identical, and `test:pvp-sim`'s 2-6 seat rows read the same.
- `test:pvp-sim`, 8 seats: mean length 2,033 -> 1,860 ticks, highest zone stage 6 -> 5,
  30 distinct matches of 30 as before, 0 ties. Win split 56/75/49 -> 54/73/53 (skirmisher /
  vanguard / juggernaut, all 180 matches).
- `test:voice-sim`, 8 seats: `hurt` cues 246 -> 772 over the same 10 matches. The squads meet as
  squads, where the scattered seats used to fight one at a time and die to mobs and the zone.
  Voice demand fell (peak 20 -> 18, p99 15 -> 13); at the shipped cap of 16 the 8-seat rows lose
  3 `muzzle` voices and nothing from `impact` up.
- `npm run check` green; `npm run coverage` gate green.

### Tests

`pvpConfig.test.ts`, 6 new cases:

- the ring order on a scrambled square, a tie on one ray, and due west against due east (only the
  half-plane split orders those two);
- the launch arena's ring, pinned;
- on synthetic circles (8 spawns / 8 seats, 12 / 8, 12 / 12), each squad is a run of neighbouring
  spawns, and spare spawns go between the squads, not all on one side;
- on the launch arena, over 64 seeds, no seat starts nearer the enemy than its squad (by mean
  distance); the control is the plain shuffle, which strands more than one seat per seed;
- the seed chooses which squad takes which half, and varies the seating within it;
- every free-for-all seat count (2-7) over 64 seeds matches the plain shuffle exactly.

Mutations killed: the plain shuffle for squads, the loosest cut, no seeded side, no member
shuffle, the half-plane edge, and runs packed together instead of spaced.

### Still open

- The cut is chosen for the map's spawn ring. A map whose spawns do not ring it (a line, a
  cluster) would need its own rule; `arena_launch` is the only real map.
- Whether squads want to start even closer (one district) is a playtest question. With one spawn
  per district it would need more spawns authored.

## The capacity sim plays squads (2026-09-30, tools + test + docs)

`test:pvp-capacity` played 2, 4 and 6 seats, so no match in it had squads. The squad spawns above
were measured by `test:pvp-sim` and `test:voice-sim` only, and no gate in `test:sims` would turn
red if a squad match stopped ending, or started its squads mixed. Eight seats is the only count
with squads (`squadSizeForPlayerCount`).

### What changed

- `client/sim/pvp/arenaMatch.ts`: each seat records its squad (`team`), where it started
  (`startGx`, `startGy`, grid units) and whether it was alive at the end (`survived`); a match
  records the surviving squad (`winnerTeam`, -1 for a tie). `winner` is unchanged: the skin of
  the first surviving seat, which in a squad match is just whichever member comes first.
- `client/sim/pvpCapacity.sim.ts`: the seven conditions run as two blocks. The solo block
  (2, 4 and 6 seats) is the old test, unchanged. The squad block plays the same seven conditions
  at 8 seats over the same 30 seeds, kept apart so a squad-only failure cannot hide under the
  solo matches. It runs the same instrument gates, and two of its own on every match: the two
  squads start on opposite halves (every spawn of one squad west of every spawn of the other),
  and no seat outside the winning squad is left standing. Its win split is keyed by the half the
  winning squad started on.

### Measured

- The solo block's printed rows are byte-identical to before.
- The squad block (7 conditions x 30 matches): no timeouts; 1 tie (`full pool100`). The dry
  counter moves as in the solo block (`loots` 8.51% dry against `shipped` 0.87%; 66 against 6
  emptied bars of 240), the blade fallback holds (`full` 0.10%), and a pool of 30 shows (55
  against 19 emptied). Mean length 1,916-2,074 ticks.
- Win split by starting half, west/east: from 11/19 (`shipped`) to 20/10 (`loots`), 15/15 for
  `full`. Thirty matches cannot tell a half advantage from noise, so it is printed, not asserted.
- `test:pvp-capacity` grows from ~126 s to ~207 s.

### Tests

- `arenaMatch.test.ts`: an 8-seat match records the config's squads, the engine's start
  positions (eight distinct spawns), survivors all of the winning squad, and a `winner` who is one
  of them; a 2-seat match gives each seat its own squad.
- Mutations killed, each by the squad block: seating squads by the plain shuffle (the half gate,
  on the first match), and naming squad 0 the winner every time (the survivor gate).

### Still open

- **No bot revives a squadmate.** Neither `PvpBotController` nor `ArenaBotController` ever holds
  `INTERACT` for a downed seat, so in every simulated squad match a downed seat bleeds out. The
  revive channel and the bandages it spends are measured by no sim.

## A sim bot revives a squadmate (2026-09-30, tools + test + docs)

The last section's open item. No bot ever held `INTERACT` over a downed squadmate, so in every
simulated squad match a downed seat bled out, and the revive channel (`REVIVE_CHANNEL_TICKS`,
450), the bleedout (`DOWNED_BLEEDOUT_TICKS`, 900) and the bandage supply had never been measured.

### What changed

- `ArenaBotController` gains a `revives` flag (profile `fullRevives`: `full` plus it). With a
  bandage it walks to the nearest downed squadmate within `REVIVE_DETOUR_FP` (12 grid), holds
  `INTERACT` once inside the channel's reach, and keeps closing until `REVIVE_SNUG_FP` inside it;
  the gun keeps firing throughout, since `ReviveSystem` asks only for range and the hold. With no
  bandage it walks to a floor one within `LOOT_DETOUR_FP` when nothing is in fire range. The zone
  retreat still wins over it. Every existing profile has the flag off.
- `runArenaMatch` counts, per seat: downs, times revived, bleedouts, bandages picked and spent,
  channel ticks while down, and channels that reset short of done. `MatchSetup.bandages` starts
  every seat with that many, so the channel can be measured apart from the supply.
- New sim `pvpRevive.sim.ts` (`npm run test:pvp-revive`, folded into `test:sims`, ~50 s): the
  capacity sim's eight-seat seeds, four conditions. Gates, on the instrument only: downs happen
  in every condition; without the flag nobody is revived, no channel starts and no bandage is
  spent, bandage in hand or not; with it and a bandage each, seats are revived; every revive
  spends exactly one bandage; no seat is revived more often than it went down; no timeouts; one
  squad standing at the end.

### Measured

30 eight-seat matches per condition:

| condition | downs | revived | bled out | broken channels | bandages picked | winning-squad seats standing |
|---|---|---|---|---|---|---|
| `full` (no revive) | 190 | 0 | 186 | 0 | 56 | 1.80 / match |
| `full`, a bandage each | 190 | 0 | 186 | 0 | 56 | 1.80 |
| `fullRevives` | 190 | 15 | 171 | 23 | 125 | 2.30 |
| `fullRevives`, a bandage each | 234 | 55 | 162 | 46 | 56 | 2.60 |

- **The first cut of the bot broke its own channels.** It stopped walking at the edge of the
  reach, and 30 of 76 broken channels were a reviver shoved a hair outside it, at a median of 25
  of the 450 ticks. Closing to `REVIVE_SNUG_FP` removed that class: of the 46 left, 42 are the
  reviver itself going down and 4 are two revivers on one seat where the other finished first.
- **The floor supply arrives late, not short.** Reviving bots pick up 125 floor bandages over
  30 matches but spend 15; handed one each at the drop they spend 55. The bandage is there
  after the fights it was needed in.
- **Why a bandage-carrying squad still bleeds out** (the bandage-each run, 162 bleedouts, by the
  best help each downed seat ever had): 73 had a mate with a bandage who was never within 12
  grid, 44 had one within it at some point and still bled out, 30 had no squadmate up, 15 had mates up with no bandage left.
- **The revive count is a property of the bot as much as of the game.** With the detour at 40
  grid instead of 12 (a probe, not shipped): 38 and 90 revives in the two reviving conditions,
  but 205 broken channels in the second, since the walk crosses the fight, and the winning squad
  keeps 2.63 seats standing against 2.60. So these counts are no verdict on the channel, the
  bleedout or the drop weight; what they do show is that a revive keeps about 0.5-0.8 more of
  the winning squad standing, and that the channel, not the bandage, is where revives die.
- The capacity sim's printed rows are byte-identical (the flag is off in all its profiles).

### Tests

- `ArenaBotController.test.ts`: the walk, the hold once in reach, the stop once snug; a rival, a
  mate beyond the detour and a seat with no bandage are passed over, and the flag off never
  holds `INTERACT`; a seat with no bandage walks to a floor one within the detour; and, through
  the engine, a bot next to a downed mate brings it up after the full channel and spends its
  bandage.
- `arenaMatch.test.ts`: every counter, on a match with no reviver and one with.
- Mutations killed, each by the sim: the bot never holding `INTERACT` (no revives), and spent
  bandages never counted (15 revives against 0 spent).

### Still open

- **The reviver may move.** design/07 says the channel is interruptible, "the reviver moving /
  being downed cancels it", but `ReviveSystem` checks only range and the held button: a reviver
  can walk inside the reach and keep shooting through all 450 ticks. Either the doc or the
  engine is wrong; changing the engine is a rule change and an `ENGINE_VERSION` bump, so it is
  left for a decision.
- The shipped arena bot (`PvpBotController`, which fills empty seats in real matches) still
  never revives.
