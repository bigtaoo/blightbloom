<!-- Split from design/18-test-strategy.md (2026-09-21): the findings, in the two forms they
     took — what each ENGINE_VERSION bump fixed (v49/v50/v51), and what building the gates
     turned up. The gates themselves are in
     [01-the-layers-as-built.md](01-the-layers-as-built.md) and
     [02-the-six-gaps-and-the-original-plan.md](02-the-six-gaps-and-the-original-plan.md).
     The index is [../18-test-strategy.md](../18-test-strategy.md). -->

# Test strategy, part 3 — what each bump fixed, and what building it found

Part 3 of [`design/18-test-strategy.md`](../18-test-strategy.md). A recorded defect nobody
schedules is a comment with a test around it, so every finding below became a fix, a gate, or a
written-down reason not to change anything.

## What v49 fixed

Every finding below was turned into a fix in the same pass, because a recorded defect that
nobody schedules is just a comment with a test around it. All five move sim outcomes, so they
share one `ENGINE_VERSION` bump:

1. **PvE level 1 finally gets the brim.** The 34 interior blocks across the five shipped ember
   floors now carry `freeStanding`. Route safety measured per floor the way the arena's is:
   regions unchanged, every room still reachable, 0.3–1.6% of floor area lost.
2. **`MovementSystem.reseparateFromSolids`** re-runs the solid passes after the pair push.
3. **`clampToWalkable`** iterates walls → obstacles → world clamp to a fixed point.
4. **`DeathDropsSystem`** clamps a spawned minion by `blockingRadius`.
5. **`DoorSystem.inLockingDoorway`** tests the passage by `blockingRadius`.

One finding was deliberately NOT fixed: `novaburst`'s `muzzleGrid: 0.5`, where the rest of the
ranged catalog is `0.9375`, giving it the only sim/render muzzle gap outside budget (25.8 px vs
a derived 20 px bound). It is the only `pattern: 'radial'` weapon in the game — a ten-pellet
ring has no single barrel direction, so a tighter emission radius is a defensible authoring
choice rather than an obvious slip. `muzzleParity.test.ts` fences it from both sides: it fails
if the gap grows, and it fails if the weapon is ever changed upstream, so the exception cannot
rot.

## What v50 added, and what it did NOT find

The third round of *"无法拾取"* (2026-08-31) arrived with its own diagnosis attached:
*"怪物不能跑进阻挡区域，掉落物品也不能掉在阻挡区域"* — monsters must not run into the blocking
region, and drops must not land in it. Both rules are right. Neither turned out to be the bug.

**What the measurement said, before anything was changed.** Two sweeps, both new:

- Static: every death cell on shipped floor 1 and on the launch arena, clamped and then checked
  for a reachable player-standable point in the player's own connected region. Zero unreachable.
- Real runs: 903 drops across 16 bot-driven runs of all five floors, re-checked at drop time
  *and* again on every change to the wall set. Zero unreachable, zero embedded in stone; the
  nearest standable point to any drop was never further than 116 fp against a 969 fp collect
  reach. **The wall-set trigger reported zero because the case never arose, not because it
  held** — see "What v51 found" below, where a door locking over an existing drop turned out to
  be a live bug. This bullet read "(so a door locking over an existing drop is covered)" until
  2026-09-01.

A first pass reported 14.5% of drops "hidden under wall art" and that number was wrong — it
assumed `WALL_H_PERIMETER` for every non-`freeStanding` rect. Re-run against the renderer's own
`wallTier`, where a wall with room floor immediately north of it is a 22 px kerb, the figure is
**0 of 796**. Recorded here because the wrong version was believed for an afternoon, and the
thing that corrected it was calling the real tier function instead of re-deriving its answer —
G6's lesson arriving a second time.

**What shipped anyway.** Both of the reporter's rules, as constructions rather than margins:

1. **Every enemy's `solidRadius` is floored at the player's.** v48 gave mobs the player's RULE
   and left them their own NUMBER, which for four of eight blueprints is smaller — so a mob
   could stand, die and drop inside a 31 fp band no player could enter. This is a real defect
   the smoke suite now catches; it is also far too small to be the report.
2. **All three drop sites clamp by `dropClearance()`** (the player's own `solidRadius`) instead
   of `SIM.pickupRadius`. The clamp now asks "can a player's body be here", which is the
   question a placement site is actually answering.

**The new gates, and which one catches what.** Worth spelling out, because two of the three
were green before the fix as well as after:

| Gate | Discriminates? |
|---|---|
| `smoke.test.ts` "no enemy stands where a player could not follow" | **Yes** — reverting the floor reports a mob 31 fp inside a solid at t326 of the ember run |
| `smoke.test.ts` "every alive pickup sits where a player body could stand" | **No, by measurement** — a CONTENT gate. Shipped rooms are authored on a 1000 fp lattice and 1000 fp is exactly two player radii, so no pocket exists that separates the two radii |
| `clearanceParity.test.ts` "the real death drop comes to rest somewhere a player body can stand" | **Yes** — on a 970 fp slot built to separate them, run end-to-end through `DeathDropsSystem` |
| `client/.../pickupProximity.test.ts` "the panel never offers a pickup the sim will refuse" | **Yes** — doubling the panel radius names the exact fp distances that betray the click |

That last one is the gap none of this doc's six covered, because it straddles the sim boundary:
the render layer decides whether to SHOW a clickable weapon row, `PickupSystem` independently
decides whether to HONOUR the click, and each half can be correct while the pair is not. Both
packages' suites stay green through it. It is also the only *shape* of "I can see it and cannot
pick it up" that the engine measurements above cannot rule out.

**The honest limit.** `clampToWalkable` separates, it does not escape: in a pocket narrower than
the clamp radius each wall pushes the point into the other, the pass makes no net movement, and
the early exit reports "settled" on a point still inside stone. So v50 is not a proof — what
keeps drops standable is that no shipped room has such a pocket, which is a content property,
which is why it is the smoke suite and not a unit test that enforces it. `clearanceParity.test.ts`
pins the limit itself, and pins that one authored grid cell is *exactly* two player radii — so
raising `PLAYER_BASE.solidRadius` by one fp seals every single-cell corridor in the game.

**Closed, from the other end (2026-09-07).** The reporter played several days of builds carrying
v51 and the symptom has not recurred, so the report is resolved by the mechanism v51 fixed (see **Answered (2026-09-07)**
in "What v51 found" below — the section this sentence used to call "Still open, restated"). Worth recording *how* it closed: not by a
measurement and not by a replay, but by the absence of the symptom over real play — which is the
only instrument that was ever going to settle it, since four rounds of sweeps had each returned a
correct zero. The sweeps were not wasted; they are what made v51's mechanism the one remaining
candidate instead of one guess among many.

**And "the seed and floor" was the wrong ask (2026-08-31).** A seed does not reproduce a drop
position — a monster dies where the player pushed it to, so the whole run's input stream is the
repro. The engine could always replay one (`Replay = seed + config + input stream`, Stage E) and
nothing outside a test had ever recorded one. Now it does: **F9** in any offline run writes a
`ddreplay-*.json` marked at that tick, `?replay=<url>&pickupDebug=1` plays it back through the real
renderer and holds at the mark, and `DD_REPLAY=<path> npm run replay:inspect` reports every drop's
closest approach, swept path, gate and `pickup` event. See `design/08`'s "Getting a replay OUT of a
live session" and ROADMAP's entry — including the two ways the harness lied on its first run, both
of the shape this document exists for.

## What v51 found, in the sentence v50 wrote about it (2026-09-01)

The section above says the v50 sweep re-checked every drop *"again on every change to the wall
set (so a door locking over an existing drop is covered)"*. The trigger was real. The
parenthesis was not: **the case never once occurred in those runs**, so "covered" described the
harness rather than the content, and a zero came back that nobody had a reason to doubt.

It was a live bug. `DoorSystem.rebuildWalls` pushes each locked door's `passageAabb` into
`state.walls`; nothing re-clamped a pickup already lying there. Nothing touches a pickup after
its drop tick, and `PickupSystem` collects on a radius test that never consults walls — so
whether the item stayed reachable came down to whether a player's body could get within
`pickupRadius + p.radius` of a point buried in a passage rect. Fixed in v51 by re-clamping every
alive pickup at `dropClearance()` after the rebuild.

**The lesson is about the shape of the measurement, not the arithmetic.** v50's whole discipline
was to replace margins with constructions, and it did that for the two rules the reporter named.
But both of those rules — and every gate built for them — are about the moment of the drop. The
wall set changing *underneath* a resting item is a different question, and the sweep that
appeared to ask it only ever asked it of runs where the answer was trivially yes. A trigger that
fires 142 times and encounters the case zero times reports the same zero as a trigger that
works.

So: **a sweep's zero is only as strong as its evidence that the case arose.** The v50 write-up
recorded its per-drop counts, which is what made this checkable at all; what it lacked was a
count of the interesting sub-case. `client/sim/dropReachability.sim.ts` now reports both — 796
drops and 142 wall-set changes under live loot — and it is written to say plainly that neither
v50's clamp nor v51's re-clamp changes a single position on today's content. Its value is the
next tighter room piece, not this fix.

**Which gate discriminates v51**, in the format of the table above:

| Gate | Discriminates? |
|---|---|
| `systems/doors.test.ts` "a door that locks over a dropped item must not seal it inside stone" | **Yes** — three cases on a 2-room fixture: the sealed item is re-seated, an item across the room does not move by one fp, and the re-seated item is not parked on the far side of the closed door |
| `sim/dropReachability.sim.ts` | **No, by measurement** — a content gate, like the smoke pickup invariant it extends; no door in 16 bot-driven runs ever closed over a drop |

**Answered (2026-09-07).** v51 was *the* report. It named a mechanism that produces exactly the
reported symptom from an ordinary sequence (a mob dies on a threshold, or a weapon is swapped in a
doorway, and then the room activates), and the reporter confirmed after several days of play on
builds carrying it that the symptom is gone. The replay ask stands as the right ask for the NEXT
report of this shape — it just was not what closed this one.

**A gate-reading gotcha, recorded because it inverts what the gate appears to say.**
`goldenHash` passed with the v51 fix applied and `ENGINE_VERSION` still at 50 — that, and only
that, is the evidence the change moves no shipped scenario. The moment the version is bumped
every scenario's hash changes, dungeon or not, because `serializeState` hashes `version` itself.
Run the hash gate BEFORE the bump, or it tells you nothing at all.


## Findings from building it

These came out of the new tests, not out of reading. Each is recorded as a live assertion
in the file named, so fixing it turns that test red and forces the `ENGINE_VERSION`
decision rather than slipping through.

**1. An actor can sit 6 px inside a wall for 3.4 seconds.** (`engine/smoke.test.ts`.)
`MovementSystem.tick` resolves walls *before* `resolveActorPairs`, so a pair shove is the
last thing in a tick and can push an actor back into stone. The tradition around that
ordering says it is "corrected on the following tick", and for a glancing shove it is —
but when two bodies are pinned together against a wall the pair push re-applies every
tick and the wall pass never gets the last word. Measured on the arena scenario: **one
episode of 103 consecutive ticks at up to 189 fp (6.05 px)**. That is the same order as
the v47/v48 reports that produced this doc. Bounded by `WALL_PENETRATION_ALLOWANCE` so it
cannot deepen unnoticed; the real fix (a second wall pass after pair resolution, or
splitting the pair push so neither side enters a solid) moves outcomes and needs a bump.

**2. `clampToWalkable`'s world clamp can undo its own wall push-out.**
(`engine/systems/boundaryParity.test.ts`.) The function pushes out of walls and pillars,
*then* clamps to `[radius, worldW - radius]` — and the clamp wins. In dungeon mode the
world bounds are the floor extent, whose edge IS the perimeter wall, one grid cell
(1000 fp) thick; the clamp parks the point at exactly `radius` (500 fp) from the edge,
inside that wall. 247 of 23,509 standable samples on shipped floor 1 come back
unstandable. **Not reachable today** — every caller passes a position at least one
room-interior cell from the floor edge — but a live trap for the next one that does not.

**3. Two placement sites clamp by the wrong radius, and both say so in a comment.**
(`engine/systems/clearanceParity.test.ts`.) `DeathDropsSystem` clamps a spawning minion
by `footprintRadius` under a comment saying "a spawned actor needs its own solid
clearance"; `DoorSystem.inLockingDoorway` tests the passage by `footprintRadius` under a
comment calling it "the feet circle solids actually push out". Both comments state the
rule correctly and cite the wrong radius, because the rule moved underneath them in v43
(players) and v48 (enemies). Measured consequence: a minion's first tick is a visible
teleport, scaling with body size.

**4. `hp` and `shield` are fractional in the replay hash.** (`engine/smoke.test.ts`.)
design/06 bans "native float in stored state"; shield regen produces 3.2, healing 4.2.
**Not a desync risk** — IEEE 754 specifies `+ - * /` as correctly rounded, so the same
operations in the same order are bit-identical everywhere, and the fields that would
*compound* error tick over tick (positions, velocities) are integers. Recorded as a
documented-rule-vs-code divergence, in the same family as design/07's swept-bullet claim,
so nobody "fixes" it into a pointless bump.

**5. `EngineConfig.walls` cannot express `freeStanding`.** It is a flat
`[x, y, w, h]` tuple, so no flat-config scenario or test can ever exercise the north brim.
This is why `engine/fixtures/brimGrinderFloor.ts` has to build a one-room dungeon.

### The lesson that cost the most

The golden gate's first version had four scenarios built from shipped content and looked
thorough. Its mutation check found that changing `WALL_NORTH_BRIM` from 23 px to 24 px
moved **none** of their hashes — the gate could not see the constant that motivated the
entire document. Two structural reasons (finding 5 above, plus a pseudo-random stick that
wandered past the one face under test for 1500 ticks) and one wrong instinct: the second
attempt used a smoothly *rotating* stick, which toured most of a 21×21 room and still
spent **0 of 800 ticks** near the target face, because a smooth orbit traces a circle and
a circle is very good at going around things. Only a deliberately *held* direction made
contact. **Emergent motion cannot be relied on to reach a specific target; measure that a
scenario touches what it claims to, and never infer it from how thorough it looks.**

## Docs drift found while writing this

All fixed in the same pass. Verified against the tree:

- `engine/README.md:35` — "currently **39**", actual 48.
- `engine/content/enemies.ts:283` — "ENGINE_VERSION 43/49"; there is no v49, should be 48.
  *(Snapshot taken at v48 — v49 and v50 exist now, and the comment was rewritten in v50.)*
- `engine/state/entities.ts:421` — `AABB`'s doc says *"The ONE thing that reads it is
  `MovementSystem.resolveWalls`… Nothing else may branch on it"*. `geom.ts` branches on
  it; so does `floorGeometry.ts`.
- `engine/systems/DoorSystem.ts:131` — the `footprintRadius` rationale (see G4) has been
  false since v43.
- `design/07-collision-combat.md:141` — claims swept bullet tests; the code is an endpoint
  test and says so.
- `client/src/game/scene/floorPartition.ts:47` — comment claims its rasterization
  "match[es] how the engine's own collision sees a cell"; the engine is circle-vs-rect
  with radius and brim, this is cell-centre vs bare rect.
- Commit `14e693b` (v47) cited `client/.../standingCoverParity.test.ts` as the guard for
  `WALL_NORTH_BRIM`. That file was **never created**; the equivalent assertion actually
  lives in `client/src/game/scene/occlusion.test.ts`. The v48 rewrite of that comment
  deletes the citation rather than correcting it.
