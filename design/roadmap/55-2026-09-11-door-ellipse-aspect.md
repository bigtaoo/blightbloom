# Work log — 2026-09-11 → 09-14

Volume 55. See [`design/ROADMAP.md`](../ROADMAP.md) for the index and the phase spine.

## A door's halo runs the way the door does (2026-09-11, client only, no engine bump)

> *"这个椭圆的长边要和门的长边保持一致。"*

A screenshot of a passable door, with its floor halo circled: the ellipse's long axis has to run
the same way the door's does. It did not — and only on the 13 doors cut through a north-south
wall, which is 13 of the 24 shipped.

### What was wrong, as the two boxes

Every floor decal a door draws — both states' nine-ring pools, `doorFx`'s travelling pulse, the
lock-change burst — was an ellipse squashed by `GLOW_POOL_SQUASH = 0.46`, the foreshortening every
round thing in this view shares. That constant is correct for a circle lying on the ground, and it
is what the 11 east-west doors want: their opening is 128 x 104, wider than it is tall, and their
widest pool ring is 171 x 79 — long axis along the door's long edge, rule already satisfied.

The other 13 are holes in a north-south wall. Their drawn arch is **64 x 94.5** (`doorLeafFrame`
fits 217 rows of leaf art to a 64 px opening), i.e. half again as tall as it is wide — and they
were wearing the same 0.46: a widest pool ring of **95 x 44**, lying across the door. The one shape
the player is asked to attach to a doorway was elongated along that doorway's SHORT edge.

### The fix is the door's own proportion, and it is also the content's ceiling

`DoorFloorPlane` now carries an `aspect` — the y semi-axis per unit x semi-axis of every ring on
that plane. `south` keeps `GLOW_POOL_SQUASH` exactly, so none of the numbers swept on those doors
(the ramp's alpha, the pool's +4.0 luma) moves by a pixel. `sides` gets `ringAspect(openingW,
drawH)` = the drawn opening's own height over its width, **1.48** on every shipped door of that
shape: widest pool ring **95 x 140**, long axis along the door.

The x semi-axis is deliberately untouched. A `sides` ring narrower than the wall's own
half-thickness draws literally nothing (`floorArcSpans`), so the aspect is spent entirely on
height — the reach onto the flanking floor, and every clamp measured against it (`ringTravel`'s
start at the wall face), is exactly as it was.

**The ceiling was measured, not assumed.** A taller `sides` ring spends its extra height running
ALONG the wall it comes out of, where the hazard is not that wall — the lobes are drawn clear of
its thickness — but the PERPENDICULAR run at the end of it, and the content decides how far away
that is. Swept over the five shipped floors at the widest radius anything strokes (1.65 x span):

| aspect | doors stroking into stone |
|---|---|
| 1.48 (the drawn door's own) | none |
| 1.60 | none |
| 1.65 | 3 of 13, at 2.4-4.8% of their points |

So the literal reading of the report is also inside what these floors allow, with ~8% to spare.
Both sides of that bound are now a test, so a future "make it taller" lands on a red check rather
than on a ring crossing masonry.

### The gap a mutation battery found — in the layer the report was pointing at

13 mutants, 0 survivors at the end. The one that mattered was a survivor first:

**`drawPulse` handed `{ ...this.plane, aspect: GLOW_POOL_SQUASH }` left all 1383 scene tests
green.** The travelling pulse and the lock-change burst ARE the two arcs the screenshot circled,
and the fixture-level tests around them measured only their horizontal reach — the 2026-09-04 pass
pinned how far a ring travels and nobody had asked how tall it is. `doorFx.test.ts` now reads the
y-reach back off the stroked geometry and holds it to an equality: a ring's own `rx` is the widest
`|x - cx|` it draws, and its y-reach is then fixed at `ry * sin(acos(cx / rx))` on a `sides` plane
(the lobes are cut off before the ellipse's extreme y, which is where the wall stands) and at `ry`
itself on a `south` one. Every Graphics that strokes a ring is checked, not the widest — the pulse
and the burst are separate ones — with a `south` fixture as the control, so "just stretch every
ring" fails too.

Two more mutants worth naming, both killed: the aspect read off the **passage AABB** instead of the
drawn opening (2 instead of 1.48 — the exact confusion the 2026-09-04 report was about), and the
pulse stretched by a **constant** 1.9 rather than by the door's own proportion, which would look
right on this door and wrong on the next size.

Honest note on the battery itself: its first run reported all six mutants SURVIVED, and that was
the harness — `--reporter=basic` does not exist in vitest 4, so every run died before any test and
a missing summary line was scored as a survivor. The tell was that the **baseline** survived too.
The harness now throws when it cannot parse the baseline.

### Verified by looking, not only by the gates

Per this repo's standing rule for anything visual, the frame was pulled out of the running game
(`extract.canvas` on `layers.root`, POSTed to a scratch receiver) rather than reasoned about: a real
open door on floor 0, player in the doorway, pulse mid-flight. The two arcs now run vertically down
both jambs instead of bulging sideways.

### The 500-line convention paid for itself here

`doorLights.ts` reached 534 lines with the new rule documented, so the floor-plane block came out
into `doorFloorPlane.ts` (CLAUDE.md form 1 — independent function modules): where a door's floor
decals lie and what shape they are, with `doorLights.ts` down to 299 lines and re-exporting every
moved name, so `doorFx.ts`, `doorRender.ts` and the four door test files see no change at all.

`render` `test` `docs`

## Chests, and the id that retuned a floor (2026-09-14, engine + client + content, `ENGINE_VERSION` 62→63)

> *"并不是所有房间都是有怪物的，有些房间会有一个小宝箱，一个人即可打开。有些房间有大宝箱，宝箱周围根据地图进入的玩家人数有对应的机关，需要每个机关上站一个玩家才能打开"* — and, separately, *"图纸在打完boss之后有概率掉落。概率先定位5%"*.

Both of `ROADMAP`'s two oldest backlog items, decided and built in one pass, because they are
the two halves of the same question: the loop had no reason to look into a room, and no reason
to run it again.

### The search verb

design/05 has said **search**-fight-extract since it was written. The game did not have the
first verb — every room held enemies, every drop came off a corpse, so a room was a thing to
survive rather than a thing to look into (`B1`, filed 2026-09-03).

A **small chest** opens for one player holding INTERACT in reach and pays one weapon whatever
the party size. Deliberately not a proximity trigger: a chest that opened by being walked past
spends the floor's loot without the player ever choosing to spend it, and the whole point of the
verb is that finding something is a decision. A **big chest** is ringed by one MECHANISM per
seat and opens only while EVERY plate has a player on it, paying **one weapon per seat** — so
the per-capita reward is flat and what scales with the party is the coordination cost. That
property is the one worth naming: a big chest is never a reason to bring more players or to
play alone, which keeps it out of the party-size balancing problem entirely.

Plate positions are **derived, never authored** (`content/chests.ts mechanismRing`). The count
is the run's seat count, which no room piece can know at authoring time, so authoring the
positions would be authoring a number that is wrong for every party size but one. Integer trig,
evaluated per index, and **zero PRNG draws** — a chest's plates are geometry, not a roll, and
drawing them would have put chest placement into `dropPrng`'s stream, where how many chests a
floor holds would silently shift every later loot roll on that floor.

Three rules that are about something other than chests, each one a branch whose line runs every
tick while only one side is normally taken, and each pinned in `systems/chests.test.ts`:

- **A chest may only be worked from inside its own ACTIVATED room.** A floor is co-resident, so
  without this a player could stand against a shared wall and work a chest in the room next door
  through the stone.
- **A revive out-ranks a chest for the same INTERACT.** `INTERACT` already drives the revive
  channel, so a chest beside a downed teammate would otherwise be opened by the very hold trying
  to rescue them. `ChestSystem.isReviving` mirrors `ReviveSystem.findReviver` from the reviver's
  side; reordering the two systems could not express this, because the question is what the
  BUTTON meant, not which system ran first.
- **A chest's payout counts against `floorWeaponsDropped`**, so a chest opened mid-floor leaves
  the capstone's shortfall payment correspondingly smaller.

Content: five shipped level-1 pieces carry a chest — a big one in `ember_l1_extraction` (the only
room in the level with no enemy spawns, and the capstone of four of the five floors) and a small
one in `alcove`/`court`/`rampart`/`gallery`, which works out at roughly two small and one big per
floor. `ChestLayer` draws bodies into the Y-sorted entity layer and plates into the ground layer,
owned by `Scene` rather than plumbed through `GameLoop` — `Scene` is already the class whose job
is "mirror `GameState` into the display list", and a chest is the one object that draws into two
layers at once, which `views`/`spawn` cannot express. Procedural Graphics, no art yet: the same
staged rollout walls, pillars, doors, drops and props each went through.

**Writing its test found a real bug**, and it is the render-layer bug this repo keeps shipping:
the per-plate redraw cache was seeded with a boolean, so a plate that STARTS occupied was never
drawn until somebody stepped off it. Both sentinels are values the real state cannot equal now.

### The reward for finishing, and the pool it was blocked on

A boss kill rolls a blueprint at `BLUEPRINT_DROP_PERMILLE` (50 = 5%, a first-pass number). It
lands on the **carry-out bag**, not the floor: a blueprint is account-level, so it must bypass
the "weapons are ephemeral" rule, and it is not a material either — but since 2026-09-10 the
boss kill IS the extraction, so the roll happens at the one moment a run already hands its
carry-out to the meta layer. `state.runBlueprint` rides that same handover, and is forfeited by
a death by the same mechanism the materials are: nothing hands it over unless the run is won.
`Game.bankRunMaterials` became `bankRunCarryOut` and does both, because there is exactly one
moment either may leave a run and the rules governing them are identical.

**The content call it was blocked on shipped with it.** `STARTER_BLUEPRINTS` was *computed* as
every `source: 'drop'` entry — all five — and granted at account creation, which made the
free-at-signup set and the earnable set **the same set by construction**: a 5% roll against it
would have had nothing to award, forever, with no error. It is an explicit two-opener list now
(one gun, one melee: a fresh account already carries `blaster` + `saber` for free, so the
grant's job is to show what crafting DOES, not to supply a loadout), leaving
flamer/scattergun/spear as the derived earnable pool, and `validateBlueprints` refuses an empty
pool outright. One known dud recorded rather than fixed: the roll is account-blind — account
state may never enter the sim — so a player who owns all three earnable blueprints can win a
roll that grants nothing.

`EnemyActor.boss` stopped being render-only in the same change, and its doc comment says so:
setting it on a blueprint is now a content decision with a gameplay consequence.

### A chest id is not an entity id, and the golden witness pointed the WRONG WAY

The first version took chest ids from `GameState.nextId()`. That reads as obviously correct — a
chest is a thing in the world and that is the world's allocator — and it shipped a difficulty
regression.

Chests are built when a floor is PLACED, before any of that floor's enemies spawn, so three
chests on level 1 shifted every later enemy id by three. **An enemy id is not inert**:
`AIDecideSystem.hasNoticed` staggers a woken garrison's opening volley by
`noticeDelayTicks(e.id)`. The re-staggered first volley took `client/sim/pveLevelSim.sim.ts`
from *"at least 2 of 8 careful runs descend off floor 0"* to **8 of 8 dying there**. CI's `sims`
job is what failed; `check`, `coverage` and `logic consistency` were all green.

**How it was nearly missed is worth as much as the fix.** The golden gate DID see it, and read
it backwards: `ember-dungeon-floor1`'s witness moved to 170 shots → 167, 59 hits → 56, four
shield-breaks → one, and the player finishing on 4.2 HP instead of 2.4 — i.e. it looked EASIER —
and the version entry was first written from exactly that, calling the shift a "pure bookkeeping
ripple". It is ONE 1500-tick scripted run that never leaves its spawn room. Eight bot-driven
runs of the whole level said the opposite and were right.

Fixed with `GameState.nextChestId()`, a separate id space, so a chest can never perturb an actor
id. Safe because nothing looks a chest up in the shared entity maps — `Scene` keys `views` by
actor/pickup id, and chests are drawn out of `ChestLayer`'s own map. The rule its doc comment
now carries: **adding a prop to a room must not retune the room's difficulty.** With it,
`ember-dungeon-floor1`'s witness is byte-identical to the pre-chest recording again, and the
only thing still moving its hash is `state.chests` joining the hashed payload — which is what an
added state field is supposed to do.

Two method notes out of the bisect, both general. The suspect files were copied into a
**detached worktree at the last-good commit** and reverted group by group there; the live
checkout gave a false negative first (reverting the content JSON appeared not to help, because a
stale vite cache was still serving the old import), and the isolated tree answered it in one
run. And the confirmation that the mechanism really was the id shift was a one-line patch
allocating chest ids from a local counter — cheaper and more conclusive than reasoning about it.

### The golden gate, and the two blind spots it was told about

Run BEFORE the bump, per the v51/v54/v61 rule: the engine addition alone moved nothing, because
`ChestSystem` is a strict no-op with no authored chest.

`chest-room` (`fixtures/chestRoomFloor.ts`) is the third purpose-built fixture in the
`brimGrinderFloor`/`extractionGateFloor` lineage, and exists for the same structural reason — no
shipped scenario opens a chest. Two seats spawning **on their own plates** (with the chest at
the room's centre, two seats put the ring due east and west, so the open happens by construction
rather than by wandering), a small chest one grid from seat 0, a new `chest` input flag pulsing
INTERACT every 3 ticks against the ordinary flag's 53, and `chest_open: 2` in the witness.
Deleting `ChestSystem.open` outright would have left the other six scenarios green.

The blueprint roll got the OTHER treatment, also deliberately: **no golden scenario kills a
boss**, and a 5% roll is a poor thing to pin with one recorded run — a fixture would record "no
drop" and stay green with the roll deleted. It is covered by `systems/blueprintDrop.test.ts`
instead, including the rate itself over 2000 seeds, and the blindness is recorded in the version
entry rather than left to be rediscovered.

### What the live run corrected, and what is still open

Verified in a real browser against the shipped level: floor 1 instantiates two small chests and
one big one at the authored points with a correctly derived plate, the small chest renders, and
the big chest opens by standing on its plate and pays out. That run also **measured a claim in
this pass's own docs wrong**: both `ChestSystem`'s header and design/05 said a chest's payout
counting against the allowance keeps chests from inflating the floor's loot. True for a chest
opened mid-floor; false for the shipped big chest, which sits in the CAPSTONE room, whose
shortfall is normally already paid by the time anyone stands on a plate — the floor ended at 4
weapons against a quota of 3. Recorded as intended rather than fixed: the quota is a FLOOR, not
a ceiling, because a find that only re-routed loot the floor already owed would pay nothing for
having searched.

Still open, and filed rather than implied: **rooms that are not fights**. Chests are authored
into pieces that still hold their garrisons, so design/05's "a floor mixes combat rooms with
chest rooms" is half-shipped — the one no-fight chest room in the level is the extraction room
that already had no spawns. A dedicated chest-room piece placed into the floor maps is content
work, not engine work. `B2` (what a chest OFFERS — the run-buff choice) is unblocked by this and
still unanswered.

### The nine claims that shipped unpinned (2026-09-14, same day, tests only)

An audit of the week's work, asked for directly (*"看看上周做的内容有没有测试可以加"*). Everything
else the week shipped came with its own suite — `runSave` even with a measured 21-mutant battery —
and the gaps were all in the pass above, all of the same shape: **a line that runs on every call
with only one side of it exercised**, which is the column CLAUDE.md already says is the one that
bites. Nine of them, fixed in order.

**The id-space fix had no test at all, and that is the one worth reading.** `nextChestId` exists
because of the regression three sections up, and nothing in the repo could have failed if it were
reverted:

- **coverage** was green over it — the line runs on every floor placement, so the first test that
  placed a chest floor covered it;
- **the golden gate** moved and pointed the wrong way, which is the account already recorded above;
- **`systems/chests.test.ts`** hand-builds its chests with `s.nextId()` in a helper, deliberately,
  because it is a test about the system and not about the placement. It could never have noticed.

Only the PvE bot sim disagreed. A sim is not a gate — minutes, and a distribution rather than a
pass — so the rule it discovered is now `engine/systems/chestPlacement.test.ts`, and the form is
the point: **a twin.** The same floor, the same seed, placed once with chests and once without,
asserting the enemy id sequence and the `noticeDelayTicks` values are identical. That pins the
property (*adding a prop to a room must not retune the room's difficulty*) rather than today's id
numbers, which any legitimate spawn-order change is allowed to move. Reverting the fix now fails
three tests.

**The shipped level's five chests were checked by nothing.** `world/rooms/emberLevel1.test.ts`
holds every other authored placement to a rule — spawn clearance, room size, door passability by
flood fill — and chests arrived after it. What makes a chest *less* safe than a spawn point is
that `SpawnSystem` CLAMPS it instead of failing on it: one authored into a pillar slides somewhere
else, possibly out of its own room, silently. Now: the content decision itself (five pieces, one
big, in the capstone), piece bounds, distance from a player spawn, the plate ring at one through
four seats, per-floor counts, and — through the existing flood fill — every chest and every
derived plate on reachable, walkable ground. Moving one chest into a wall in the JSON fails three
of these; pushing the big chest against one so a plate lands in stone fails five.

The other seven, briefly: `chests.test.ts` counted the payout and never looked at it (pool
membership, `spawnTick` — the one-tick gap `PickupSystem`'s guard stands on — one `dropPrng` draw
per weapon, same-seed determinism, the clamp off a wall, one pile), and was missing three
arbitration arms (a downed **enemy** not blocking the INTERACT, a PvP reviver *with* a bandage
still blocking it, a known room id with no runtime row). `floorLoot.test.ts` did not know chests
exist although they spend the same allowance — both directions are now pinned, including the
**quota-is-a-floor** case this volume recorded three paragraphs up as prose only.
`blueprints.test.ts` gained the fourth fail-loud case and a note on why the empty-pool refusal
cannot be driven by a test at all (it is gated on the real catalog by identity). `Scene.test.ts`
covers the chest *wiring*, since `ChestLayer` is owned by `Scene` and its own suite stays green if
`reconcile`/`clear` stop calling it. And `EventReactor.test.ts` turns five scattered "not wired up
yet" comments — `chest_open`, `blueprint_drop` and the zone's three — into **one list derived from
the event union**, so a new engine event lands as a red test with two honest ways out. That last
one meets `build/logicConsistency.mjs`'s own criterion (two halves maintained in different
packages that drift in silence) and is deliberately NOT in that manifest yet: every entry there is
a dedicated file, and promoting this one means splitting it out and moving the "12 named gates"
count in CLAUDE.md with it. Filed as the cheap follow-up it is, not done at the end of a pass.

Every gate was verified by mutation rather than assumed, which is the discipline this repo already
paid for twice: reverting `nextChestId`, dropping the chest's `floorWeaponsDropped` line, the
`teamId` term, the walkable clamp, the `spawnTick` stamp and the room-runtime guard; commenting
out `Scene`'s two calls; moving a chest and a plate into stone; and adding a fake engine event —
each fails exactly the tests that name it, and nothing else. engine 1534 → **1572**, client
6211 → **6216**.

**One finding was left as a report rather than a gate**, and the reason is the assertion craft and
not the finding: `ember_l1_court`'s small chest sits **0.71 grid** from an enemy spawn point, so a
mob's body (radius ≈ 0.47 grid) covers the chest. No design doc states a rule for chest-vs-mob
spacing, and a threshold reverse-engineered from the content that happens to pass is a test that
asserts nothing. Whether to move it is a content call, filed here beside the no-fight-rooms item
above.
