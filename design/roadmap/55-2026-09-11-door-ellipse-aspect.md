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

## The kill table stops paying in guns (2026-09-14, engine + client + content, `ENGINE_VERSION` 63→64)

A design call from the game's owner, in four sentences:

> 怪物是不掉落武器的。要获得武器，只有 boss 掉落和开箱子。有些房间还会有商店，怪物的掉落里加一个金币。

Everything below follows from the first sentence. The other three are what had to exist for it
to be survivable, and the second half of the pass is mostly about that.

### What a floor's weapons ARE now

Three sources, and they differ in kind rather than in rate: a **chest** is a find, a **boss**
drops one guaranteed on its body, and a **shop** sells one. `weapon` left `DROP_TABLE`
structurally rather than as a zero weight — a zero is one edit from being reachable again by
accident, and a zero nobody can see is how a decision quietly un-decides itself.

**The per-floor weapon allowance went with it, and that deletion is the interesting half.** It
existed (v57, nine days) because the table alone produced 0-5 weapons a floor, so a quota set
the COUNT while the weight set the pacing, with the shortfall paid at the capstone to make 2-3
a guarantee in both directions. With the table out of the weapon business there is no per-kill
rate for it to cap — and keeping the make-up payment would have been actively worse than
useless, because loot that materialises at a floor's exit is exactly what makes a search not
worth doing. Gone: `FLOOR_WEAPON_QUOTA_MIN`/`_SPAN`, `GameState.floorWeaponQuota` /
`floorWeaponsDropped`, `DungeonRoomRuntime.weaponDropped`, `DropOpts.weaponAllowed`, the whole
of `systems/floorLoot.ts`, and both of its trigger sites.

**PvP was deliberately left alone**, and it is worth saying why since "apply it everywhere" is
the obvious wrong generalisation: an arena has no chest, no boss and no shop, so its loot pool
IS its whole power curve (design/15). Deleting the weapon entry there would not relocate
weapons, it would delete them. `ARENA_DROP_TABLE` excludes `coin` for the mirror-image reason —
nothing in an arena could spend one.

### The number that is a trade, not a side effect

`coin` took the weapon entry's 5 points plus **15 out of `material`**, landing at 20/84 (23.8%
of kills), with the total held at 84 so `heal`/`buff`/`energy` keep the odds they have had since
v59 — the discipline both earlier re-weights used, and what keeps each pass readable as one
change.

That costs the carry-out currency 55/84 → 40/84, i.e. **roughly a 27% cut in the rate a run
banks materials**, which slows forge progression. Recorded here rather than discovered later:
it is the trade this design makes (value moves from the meta ramp to the in-run one, where the
search verb and the shop now live), and it is one number to reverse — raise the table's total
instead of moving points inside it — if a measured sweep says the forge went dry.

### The shop, and the four decisions inside it

- **The composition is fixed, only the contents roll.** Weapon / buff / supply, in that order,
  every counter. Three independent draws from one pool was the alternative and it fails the
  shop's whole job: this is the recoverable half of taking weapons off the kill table, and a
  counter that can roll three potions cannot recover anything. Fixed slots also give each line
  one price instead of a band, which is what lets the numbers be set against measurement.
- **The gesture is a tap on a row, not a held INTERACT.** That button has two consumers already
  (the revive channel, a chest) and a third would need a third arbitration rule — but the real
  argument is that buying is not that shape of verb. It is *choosing which line*, and the game
  already taught "a list of things in reach, tap one" for floor weapons (v32). A shop tap is the
  same one-shot latch on its own command field (`shopBuyId`), which also means no new
  arbitration exists to get wrong.
- **A bought weapon lands on the floor; a bought buff/heal/energy goes straight to the buyer.**
  Not a new rule — design/05's own pickup split. A weapon is a choice (which slot to overwrite)
  and stays click-driven; the other three are pure upside, and dropping them as pickups would
  have let a teammate walk off with something somebody else paid for.
- **An instant item that would do nothing is refused before the coins move**, through the same
  `pickupWouldApply` the floor uses, so the counter and the floor cannot disagree about what
  "would do something" means. A buff is exempt here exactly as it is exempt there.

Prices (weapon 45 / buff 30 / supply 12) are first-pass and sized against the measured floor —
34.6 kills on floor 0, 52 on floor 2, so ~40-60 coins a floor. A floor's whole income buys the
gun, OR the buff and two supplies. Not being able to afford everything is the design.

### `arsenal` had nothing left to add to

The floor card `arsenal` was "+1 weapon on every remaining floor", i.e. +1 to an allowance that
no longer exists. It became **`windfall`** (coins worth ×2) rather than being deleted, because a
coin multiplier is its closest honest successor: it buys the same loosening of weapon scarcity
by the same route — through the shop — except the loosening is no longer automatic and you have
to decide what to spend it on. `FloorCardEffect`'s `weapon_quota` arm became `coin_mult`, which
re-orders nothing in `FLOOR_CARDS` and so leaves the card offer's own draw sequence alone. One
behavioural difference, pinned by a test because it is the kind of thing that reads as a bug: a
count adds and a multiplier multiplies, so two picks are ×4 and not ×3.

The multiplier is applied in `DeathDropsSystem`, **outside** `rollDrop`, which is the one
structural difference from `potion_flow` next to it: that card changes the table's WEIGHTS and
has to be inside the draw, this one changes a payload and must stay outside it. A multiplier
folded into the roll would make the card's presence part of the dropPrng stream for nothing.

### A repair found on the way: `state.chests` was never hashed

`fixtures/chestRoomFloor.ts` says in prose that *"`state.chests` joining the hashed payload"* is
what reaches the golden gate. It never did — `replay.ts` has no chest field at all, and did not
when that sentence was written. Nothing failed, and the reason is the familiar one: a divergence
in `opened` surfaces one tick later as a weapon pickup that exists on one client and not the
other, so it would have been caught eventually, later, and attributed to the wrong system.
Chests and shops are both hashed now — `opened`/`sold` and the mechanisms' `occupied` flags,
which are recomputed every tick and carry real information; the plate POSITIONS stay out,
because they are derived with integer trig from already-hashed inputs.

### And a second one, in the renderer

`RoomBuilder.build` destroys every child of `layers.ground` on its first line, and a door
unlocking triggers a build. `ShopLayer` found that immediately and loudly — its mat is a
`Graphics` on that layer, and a destroyed Pixi object nulls its own `position`, so the first
room rebuild threw. **`ChestLayer` has had the same exposure since v63 and was failing
silently**: a destroyed `Container` reports an empty `children`, so its per-mechanism loop found
nothing and skipped, and a big chest simply lost its plates for the rest of the floor. Only a
big chest has plates and the shipped level has one per floor, which is why nobody saw it. Both
layers now rebuild a view whose containers have been destroyed under them, and both have a test
that asserts the thing is drawn AGAIN — not merely that nothing threw, since a guard that
swallowed the destroyed view without replacing it would pass a crash test while reproducing the
defect exactly.

### The golden gate, run BEFORE the bump

Per the v51/v54/v61 rule. Eleven assertions moved across six scenarios, and each was read rather
than re-recorded on sight:

- **`arena-waves`** moved `prngCursors` and nothing else. It is a flat config, so it rolls the
  PvE table; the drop KINDS and their draw costs changed, the behaviour did not.
- **The four dungeon scenarios** moved their witnesses, through the deleted quota draw rather
  than through combat. `ember-dungeon-floor1` reads 208 `bullet_fired` against 170 and 85
  `melee_swing` against 67, which looks alarming and is a knock-on: one fewer `dropPrng` draw at
  floor placement shifts the whole later sequence, so a different set of `energy` drops means a
  different number of shots the pool can pay for, and the rest is the player falling back on
  melee. `death: 16` and `pickup: 5` are unchanged.
- **`launch-arena-pvp` and `walls-and-pillars`** moved their state hash with their witness
  unchanged — the signature of a payload SCHEMA change (the quota fields leaving, `coins` and
  the two prop arrays joining) rather than a behavioural one. That PvP's witness did not move is
  the check that the arena really was left alone.

**Two blind spots, both declared rather than left to be rediscovered.** No golden scenario taps
a counter, for the same reason none opened a chest before `chest-room` existed — a scripted
stick does not walk to a prop and press a row. And no golden scenario kills a boss, so
`BOSS_WEAPON_DROPS` is pinned by `blueprintDrop.test.ts` instead, which now measures the boss's
extra weapon as an exact number of `dropPrng` draws, since that is precisely what a `peek()`
cannot see.

### What is pinned, and what the mutants said

19 cases in `systems/shops.test.ts`, one per refusal, each asserting BOTH halves — nothing
delivered AND nothing charged, because "did not deliver" and "did not charge" are different bugs
and a test checking only the first passes for a shop that takes your money and hands you
nothing. Plus `coinDrop.test.ts` (the payload multiplier, which lives outside `rollDrop` and so
is invisible to both `drops.test.ts` and `floorCards.test.ts`), coin cases in `pickups.test.ts`
(into the COLLECTOR's wallet, asserted against a teammate on the same tile), and on the client
`ShopPrompt.test.ts` / `ShopLayer.test.ts` / `shopProximity.test.ts`.

`shopProximity.ts` exists as its own module for the reason `pickupProximity.ts` records about
itself: **the ring the panel opens on and the ring the sim accepts a tap from are the same
ring**, and that agreement is a thing neither package's suite can see alone. If they ever
diverge the symptom is "I tapped it and nothing happened", which is the hardest class of bug to
get a useful report about.

**11 injected defects, 11 caught** — including the `<=`-for-`<` price boundary, a dropped
`coinMult`, a supply slot that stops rolling `energy`, and a gutted coin weight. Run with the
golden gate EXCLUDED, because a red baseline makes every mutant look killed; the first run of
this battery reported 8/8 against a baseline that was already failing, which is the trap worth
recording.

engine 1572 → **1586**, client 6216 → **6244**.

### What this does NOT do

The shipped counters sit in `ember_l1_forge` and `ember_l1_crucible` — one per floor, mid-chain
so a floor's coins can be spent on the floor that earned them. **No new ROOM was authored**, so
design/05's "a floor mixes combat rooms with chest rooms" is exactly as half-shipped as it was
this morning: every room with a counter in it still holds its garrison. A dedicated no-fight
room placed into the floor maps is still content work nobody has done.

And `ROADMAP` B2 is half-answered, not answered. A buff is now something you can choose and pay
for rather than only something that falls off a table — but one line at one price is an offer,
not the pick-one-of-three a floor card is.

## Rooms that are a search, not a fight (2026-09-14, content + docs, `ENGINE_VERSION` 64→65)

The content half the two passes above kept deferring, asked for as a level-design change:

> 商店放到第四层，多人一起开的宝箱放到第三层。其他每层一个小宝箱。不需要放在必经之路上。
> 具体的房间布局我后期调整玩法的时候会微调，你给房间加几个类型即可。

### The thing that was actually wrong

v63 and v64 authored their new content onto the pieces that already existed. That is the cheap
move when a mechanic lands, and it has a consequence nobody stated at the time: **a piece is
reused across floors, so the reward distribution was a side effect of the piece draw.** Floors
1-3 came out with two small chests, a big one and a counter each; the boss floor came out with
no big chest at all, because the only big chest in the library rode `ember_l1_extraction` and
floor 5 ends at the boss room instead. Neither of those was a decision anyone made.

The ask above is a distribution — one small chest a floor, the co-op chest on floor 3, the run's
shop on floor 4 — and a per-piece placement structurally cannot express it. So the fix is not
"move the chests", it is **move them off the combat pieces entirely**:

| floor | 1 | 2 | 3 | 4 | 5 |
| --- | --- | --- | --- | --- | --- |
| side room | `cache` | `cache` | **`vault`** | `cache` + **`market`** | `cache` |
| holds | 1 small chest | 1 small chest | the big chest | 1 small chest, the shop | 1 small chest |

Three new enemy-free piece types, 15x15 / 17x17 / 16x16, each hung off its floor's chain as a
**dead end** — *"不需要放在必经之路上"*. `alcove` / `court` / `gallery` / `rampart` /
`extraction` / `forge` / `crucible` carry nothing now. Room counts 5/6/7/6/5 → **6/7/8/8/6**.

### What that buys, and what it deliberately does not

design/05's "Chest rooms" header has said *"a floor mixes combat rooms with chest rooms"* since
the day it was written, and until now the only ungarrisoned room in the level was the extraction
capstone — which is empty because it is the checkpoint, not because it is a search. That is
closed (`ROADMAP` B1's content half), and with it comes the first room in this level a player may
simply decline to enter.

**It is not `ROADMAP` B3.** B3 wants rooms left *unfought* on the way down, which needs a route
around a garrison; a dead-end room with nothing in it routes around nothing, and every chain room
between the entrance and the capstone still has to be cleared to walk through it. Two things that
look alike: an OPTIONAL room, which now exists, and a SKIPPABLE one, which still does not.

### The loot number this moves, stated rather than discovered later

A run's weapon supply falls from roughly three chests a floor to **four small chests, one big
chest, one counter line and the boss drop for the whole descent**. That is a real balance change
riding on a placement decision, and it was not measured against `pveLevelSim` first because the
placement was the owner's call, not a balance proposal. The same goes for the counter: coins are
run-scoped and never banked, so a single shop on floor 4 means a run's entire purse is spendable
exactly once — 87 coins buys all three lines against a five-floor income that was priced for
40-60 a floor spent five times. Both are first things to measure once this has been played.

### What the content gates learned

- `world/rooms/emberLevel1.test.ts` grew the per-floor distribution, the dead-end topology
  (a chest room has exactly one door and is never the capstone), a garrison-free assertion, and
  a cross-check that the enemy-ramp EXEMPTION list is exactly the pieces with no enemy spawns —
  an allowlist, so a combat room that loses its garrison in an editor drag fails the ramp instead
  of quietly joining the exempt set. Shops got a content gate **for the first time**: they
  shipped a version after the chests and the chest block was written for chests alone.
- **A speck in a doorway read as a 33-luma clip failure.** `floorClipCoverage.test.ts` measures
  the step the floor clip leaves across every shipped passage, 1 px either side, against a bound
  derived from the mottle. Cutting the first door into `ember_l1_court`'s west wall put a 2.7 px
  rubble speck on the threshold, and `drawFloorDecals` says in its own comment that a speck is
  *dropped rather than clipped* — it is not the clip's step, and the bound was never derived to
  cover it. Filtered out by size (a speck is ≤4.4 px, the next-smallest thing drawn is a 16 px
  stain), with its own test pinning that the filter removes specks and nothing larger.
- Six new doors and six new free-standing blocks moved eleven anti-vacuity population pins across
  five client sweeps (24 doors → 30, 34 brimmed rects → 46, 11 kerb doorways → 14). Each was read
  and updated rather than relaxed.

### The golden gate, read before the bump

Exactly one scenario moved: `ember-dungeon-floor1`, witness first, through the three `dropPrng`
draws `rollShopStock` no longer spends when floor 1 places. The other six are byte-identical in
witness — the committed fixture shows all seven hashes moving only because `serializeState` puts
`ENGINE_VERSION` in the hashed payload. Blind spot unchanged and declared: no golden scenario
walks into a side room, because a scripted stick does not path to a prop.

engine 1586 → **1599**, client 6244 → **6245**.

### CI found the thing the local suite could not: a gate that was passing on luck

`npm run check` was green and the `sims` job went red. `pveLevelSim`'s descend gate — *"at
least 2 of 8 careful runs descend off floor 0"* — read **0/8** against 3/8 before.

The first read was that this pass had made floor 0 harder, and it is the wrong read. The gate
is a Bernoulli sample: the careful bot's real descent rate, measured over 40 seeds, is
**15-20%**, so eight samples against a threshold of two passes with probability **0.34**. It
had been passing on a coin flip since the day it was written, and the thing that re-rolls that
flip is any change to `dropPrng`'s stream — which is every content change, because
`rollShopStock` spends three draws at floor placement and this pass moved the counter off
floor 0.

Measured properly, paired, same 40 seeds either side of the commit: **6/40 before, 8/40
after.** The level got very slightly EASIER and the gate went red for it.

So the fix is the sample, not the content and not the bar: `SEEDS` is 40 now and the threshold
is a tenth of them (4), which sits far enough below the measurement to be stable and far enough
above zero that a level which became a wall still fails. 40 seeds x 2 profiles runs in **4.4
seconds** — the eight were never a cost decision, just the number somebody started with.

Worth carrying past this repo: **a threshold set near a measured rate needs a sample that can
resolve it.** Nobody had computed this gate's power, so it was always going to fail one day for
a reason that was not its own sentence, and the day it did the obvious explanation was going to
be wrong.

## Somebody is standing behind the counter (2026-09-14, client + art + docs, no engine change)

> *"商店是通过房间里的 npc 打开的，不是随时可以打开的。"*

The last open question the pass above left in `design/05` "Shops", filed the same day it was
raised because it looked like a design decision. It is two, and separating them is the whole
of this entry.

### The sentence says two things, and only one of them is a design change

Read as one ask it is a change to the VERB: today the shop panel opens on PROXIMITY — stand
inside `SHOP_INTERACT_RANGE_GRID` and it is live (`ui/shopProximity.ts`), which is also the
rule `ShopSystem` refuses a purchase by — and making it open on a gesture instead means
answering *which* gesture. `INTERACT` already carries the revive channel and a chest, and
"The gesture is a tap on a row" withheld a third on purpose. That decision has an
`ENGINE_VERSION` 65→66 and a golden re-record behind it, and it is still open.

But the sentence also says something with no design content at all: **there is a person in
that room and the game does not draw one.** A counter with nobody behind it is a vending
machine whatever opens it, and that half is a sprite. Asked which one to build, the owner
chose the art — and the reason it is worth writing down is that the choice costs the other
one nothing: a proximity-opened panel and a gesture-opened panel both want a merchant
standing there. Nothing here touches `@dd/engine`. No version, no re-record, no replay.

### The art is the feature, which inverts this repo's usual staging

Every object in this room shipped a Graphics form first and grew a sprite later — walls,
pillars, doors, drops, props, chests, and the shop counter itself, which still has not. So
the default answer to "what does it draw before the art lands" is a procedural shape, and
`ShopLayer`'s own header says in as many words that its slab and awning are *the current
form, not a fallback waiting on a file*.

The keeper is the other way round, and the missing-texture path is where that shows:
**it draws nothing at all.** Not a placeholder body, not a blob. The asymmetry is not
laziness, it is the fallback question having a different answer for a person — a room with a
hole where a wall goes is unplayable, a room with no merchant is exactly the room design/05
described yesterday — and `13` keeps ONE body plan, so a procedural stand-in for a character
would be a second authored design of one. `npcArt.test.ts` and `ShopLayer.test.ts` both pin
the empty path rather than leaving it as a claim in a comment, because "the counter is
untouched" is a stronger statement than "it did not throw", and a half-built keeper container
satisfies the second.

### Where it stands, and why every number is derived

The keeper is its own `Container` in `layers.entities`, **not a child of the counter**, and
that is the one structural decision in the file. A child would inherit the counter's `zIndex`,
and a player walking through the ~9 px gap between the merchant and the slab would sort
against the wrong one of the two. Its own ground point means its own sort key.

- `KEEPER_BACK_PX = BODY_HALF * BODY_ASPECT` — one counter-depth north. Not picked: it is
  exactly half the counter's drawn height, which is this projection's reading of how deep the
  counter is, so the slab crosses the bottom of the silhouette the way a real counter crosses
  a vendor. Retuning the counter moves the keeper with it instead of leaving it embedded in
  the furniture or floating off it.
- `KEEPER_WIDTH_PX = 28` — the art brief's own stated display width, which is what its
  silhouette and its *no detail finer than one sixth of the width* rule were drawn against.
  It sits just under a player's 32 px drawn body (`PLAYER_BASE.radius` × 2), so a shopkeeper
  reads as a person of the same world without out-sizing the player standing at it.
- Height comes from the art's aspect, never from a constant — the rule every sprite in this
  scene follows, because aspect is the art's to choose and a number in the code silently
  re-proportions a replacement file.
- No tint. A prop takes `propTint(palette)` so it reads as part of *this* room; `13` reserves
  runtime re-tinting for the neutral-grey critter body and withholds it from anything carrying
  its own colours, which a character does.

The keeper is also re-asked for every frame until its texture resolves, rather than only at
`create()`. `preloadEnvironmentSprites()` is awaited at the run gate so in practice a shop is
never built ahead of it — but a view is rebuilt only when something destroys it, so a
`create()`-only keeper would have left *that* shop keeperless for its whole floor, invisibly.
Two lines to make impossible; impossible to notice if it ever happened.

And it takes the same `RoomBuilder.build` guard the mat does, one layer over. That sweep
destroys every child of `layers.ground`, which is what `ShopLayer` hit loudly and `ChestLayer`
swallowed for a version (v64's entry above); the keeper lives in `layers.entities` and is no
more the owner of that container than the mat is of its own.

### The generation arrived with the 2026-08-24 defect, in a prompt written to prevent it

The brief carried both hard-won paragraphs: the anti-checkerboard one (`pillar_neutral_raw.png`
came back with a transparency checkerboard *painted in* as opaque squares, which no preview can
tell from an alpha channel) and a no-glow/no-cast-shadow one (the game draws both). Neither
made the generator produce clean alpha. It came back **a body at 253 inside a veil of alpha
1-10**, the exact room-prop defect class, and needed `alphaClamp.mjs` exactly as every prop did.
Asking for clean alpha in the prompt is worth doing and is not a substitute for measuring.

What that veil would have cost, had the clamp not run first: `compress.mjs` trims on
`alpha !== 0`, so the shipped file would have been **1058x1393, aspect 0.760** instead of
864x928, **0.931** — 22% wrong — with a band of empty rows underneath that a bottom-anchored
sprite turns into clearance between the merchant and the floor. The check that proves the
clamp ran is the one `alphaClamp`'s own header names, and it is not "the audit says clean":
**the trimmed bbox must equal the bbox measured at `alpha > 25` on the ORIGINAL.** Both 0.931.

```
alphaClamp: cleared 12866 px (0.818%) at alpha <= 8, solidified 427105 px (27.161%) at alpha >= 250
compress:   729650 B -> 110070 B (-84.9%),  1080x1456 -> 298x320
```

### The one place the art disagreed with the brief, and the rule it broke

The prompt asked for 28:38, i.e. aspect **0.737**. It came back **0.931** — squarer and
stubbier than specified. Recorded rather than regenerated, because the scaling rule absorbs it:
sized by width, the figure simply stands 30 px rather than 38, still clearing the counter's
awning apex by ~10 px. What it does mean is that the composition now depends on a property of
the FILE, so `npcArt.test.ts`'s last block drives the real file's dimensions through the real
layer and measures where the head lands against the real counter's bounds. A replacement much
wider than tall files the merchant's head behind the awning — a defect with no failing test
anywhere else in the repo and none that coverage could ever reach.

### The value band an NPC needs is the opposite of a prop's, on one side

Every tone assertion in `propArt.test.ts` pushes dressing DOWN into the stonework (`p50` 35-60
against the floor's own 39-49) so that `13`'s *environment desaturated, hazards saturated* keeps
a crate from reading as loot. Applied unchanged to a character it produces a smudge behind a
counter. So the keeper is bounded on BOTH sides instead: `p50` **103**, which is 61 above the
barrel it stands near and 64 below the pickup it must never be mistaken for, with saturation
carrying the not-a-hazard half on its own (chroma **49.8**, against an elemental body's 151.5
and the hub Forger's already-accepted 68.7).

**The controls are the part worth copying.** This generation was accepted first time, so unlike
the rubble there is no `_alt` reject to re-measure — and a band with nothing on the wrong side of
it is a band nobody has tested. Both rules are therefore written as PREDICATES and run over
shipped files chosen to fail them: the pickup crate and the stone barrel must both fall outside
the person band, and a skirmisher shell must fail the chroma bound. Plus one in the other
direction, which is why the bound is 80 rather than 55 — `npc_forger.png` must PASS it. A rule
tightened until only one file satisfies it is a rule about that file.

### Gates

All four of the day's required checks green: `npm run check` (typecheck, file length, WeChat
packages, docpaths, all suites), `npm run check:logic`, `npm run test:sims` — run despite nothing
touching the engine or content, because it is a required check — and `npm run coverage`, which is
deliberately NOT part of `check` and is the one that has to be asked for. 12 new tests in
`scene/npcArt.test.ts` and 11 in `scene/ShopLayer.test.ts` (20 in that file now), plus the loader
repairs the battery below forced in `render/environmentSprites.test.ts` and
`render/wechatAssetLoad.test.ts`. The new PNG
lands in the `run` pack by the no-rule-means-`run` default in `assetPacks.json`, which reads
**116 files, 2.43 MB / 4.00 MB** after it. `alpha-audit.mjs` calls `client/public/environment/`
12 clean of 13 — the one flagged file is `door_curtain_raw.png`, which is deliberately additive
VFX and has been the standing exception since 2026-08-30b.

### The battery, and the five things a green suite was not saying (same day, tests only)

Twenty tests across two files, all green, and the only honest way to find out what they pinned was
to break the code on purpose. **17 mutants, 16 live** (the seventeenth stopped existing — see M10)
— green baseline either side, every mutant reverted in a `finally`, and `encoding='utf-8',
errors='replace'` on the subprocess, because on Windows cp1252 cannot decode the box-drawing
characters vitest prints on FAILURE and the whole battery then reports as CRASHED.

**First pass: 10/15 killed. All five survivors were real.**

- **`??=` → `=` on the lazy texture attach.** The keeper is re-asked for every frame; written as
  a plain assignment it rebuilds the container and adds a fresh child to `layers.entities` sixty
  times a second. Nothing failed, because each new keeper draws exactly where the last one did —
  a leak with no symptom. The sibling "reuses the same counter across frames" test had been
  checking `children[0]` only, and the keeper is `children[1]`.
- **`v.keeper = null` at the end of `dispose`.** Deleting it survived everything, and the mutant
  was right: every caller discards the view in the same breath (the teardown loop deletes it,
  `clear()` empties the map, the destroyed-guard sets `v = undefined` before rebuilding), so
  nothing ever reads the field again. It read as defensive and was unreachable. **Deleted rather
  than tested** — a line no test can distinguish is a line making a promise nobody checks.
- **`KEEPER_BACK_PX` doubled.** Every test derived its expectation from the imported constant, so
  the constant's own VALUE was unpinned in both directions. What makes it right is a relation, not
  a number: the counter's slab has to cross the keeper's base, or the merchant stops reading as
  standing *behind* a counter and starts floating above one. That was unstatable while the slab's
  height was a local `h` inside `create()`, so it is now `COUNTER_HEIGHT_PX`, exported for exactly
  the reason `propRender` exports its metrics, and `0 < KEEPER_BACK_PX < COUNTER_HEIGHT_PX` is
  asserted both as arithmetic and against the drawn positions.
- **`getShopkeeperTexture` pointing at the wrong key**, and **the registry row deleted outright.**
  Both survived *the entire repo*. `ShopLayer.test.ts` and `npcArt.test.ts` both `vi.mock` the
  loader module, so nothing anywhere asked the real registry a question, and the shipped symptom
  is the quietest one this pass has: the getter returns `undefined` forever, `ShopLayer` draws no
  merchant *by design*, and the room looks exactly like the room did yesterday.

That last pair is the one worth carrying, because **this file had already been burned by it once**
— `environmentSprites.test.ts`'s own header records that dropping the `prop_` prefix from
`getPropTexture` survived the whole suite, found by mutation, in August. The fix that time was one
more line in a hand-written list, and a hand-written list only covers what somebody remembered to
add. So the fix this time is a structure: a `GETTERS` table pinned **set-equal to
`ENV_SPRITE_ASSET_KEYS`**, which makes a registry row with no getter behind it a failure rather
than a skip, and sweeps every key through its own getter after a real preload.

**The same blindness, one layer out.** `wechatAssetLoad.test.ts`'s *"loaded every environment
sprite"* named the doors and the arch and then looped the `pickup_`/`prop_` **prefixes** — so a
key in neither family was silently not checked, and this pass added exactly one. On that target
the consequence is not cosmetic: it is the sweep that proves a file actually reached its WeChat
package, and it would have reported the same green either way. Rebuilt exhaustive, with the
key-set equality assertion in front of the loop so it cannot go quiet again.

**And one assertion that could never have failed.** `it('every registered key points at a distinct
real path under /environment/')` built its `Set` from the KEYS — which come out of `Object.keys`
and are unique by construction. Its name said paths. Two keys pointing at one file is a real
copy-paste mistake (duplicate a row, change the key, forget the path) and a silent one: both
getters return a texture and one of them is the wrong picture. Now checked on the values.

**Second pass: 16/16.** Plus two mutants the new tests made worth writing — `KEEPER_BACK_PX` → 0
(the merchant standing *inside* the counter) and the registry row pointed at `prop_barrel.png`
(a duplicate path) — both killed. Per-file coverage on `ShopLayer.ts` and `environmentSprites.ts`
went 96.42%/92.30% branches to **100%/100%**, which was a side effect rather than the goal: the
one branch the first battery left uncovered was `dispose` meeting an already-destroyed COUNTER,
the exact case the mat has had a test for since v64 and the body never did.

### What this does NOT do

It does not answer the verb. The panel still opens because you walked near the counter, and
`design/05` now carries that as a named open half rather than as the whole question it was this
morning. Whoever takes it gets to decide whether a third `INTERACT` consumer is finally worth it
or whether the shop wants a gesture of its own — and gets to do it with a merchant already
standing there to attach it to.

## Loot that arrives on you (2026-09-15, engine + client + docs, no ENGINE_VERSION bump)

> *"你可以在 worktree 里给拾取物品加一个曲线飞行特效吗？大概 0.6 秒飞到玩家身上。就是其他游戏里普遍有的那种拾取效果。"*

A drop was collected by ceasing to exist. `PickupSystem` takes it on overlap and compacts it out
of `state.pickups` the same tick, so the next `Scene.reconcile` destroyed the view and that was
the whole event on screen — plus an `fx.flash()` drawn **at the loot**, which is the one place
that cannot answer the question a pickup actually raises in co-op or in PvP: *did that go to me?*
An arc that ends on a body answers it by construction.

### The engine says WHO, in one inert field

`GameEvent`'s `pickup` gained `by`, the collecting player's actor id. Same field, same reasoning,
as `bullet_fired`'s `ownerId`: the render layer has to find the COLLECTOR'S OWN VIEW, and `gx/gy`
is where the drop lay, which the animation already has. It genuinely cannot be answered from
state — the item is compacted out the same tick the event is pushed, so by the time a frame's
events are consumed there is nothing left to read — and the render-side alternative, "whoever is
standing nearest", guesses wrong exactly when two players overlap one drop, which is the case the
flight is most visible in. Additive and inert: events are never read back by a later system and
never enter `serializeState`/`hashState`, so **no `ENGINE_VERSION` bump**, and the golden gate
stayed green (1,599 engine tests, unchanged fixture).

### Everything else is render-only, and two decisions carry it

**Driven by the EVENT, never by the state diff.** The diff cannot tell "this id left `GameState`
because someone took it" from "this id left because its floor did" — and a flight launched off the
diff alone would fling a whole floor's uncollected loot at the player on every descend. That
absence is the load-bearing test in `Scene.test.ts`'s new block, not the presence. The flight also
builds a FRESH `Pickup` view rather than adopting the one on the floor, because under online
catch-up (`GameLoop.advanceOnline`) a drop can spawn and be collected inside one drained batch, so
the view being replaced may never have existed — while the event always arrives. It is launched
LAST in `reconcile`, since the arc is aimed at the collector's view and that same call is what
mirrors it; launching first meant a drop taken on the first frame a seat existed found no body.

**The bow belongs in the one screen axis the shear leaves free — and this is what a green test
got wrong.** `flightPose` bowed the full ground perpendicular and hopped in Z, and
`Entity.applyTransform` draws `(x, y, z)` as `(x, y − z)`: a bow in ground Y and a rise in Z are
the SAME screen axis pointing opposite ways. On a live 28 px pickup, traced out of the running
game, the drawn path left a straight screen line by **0.5 px**. The tests were green the whole
time, because they measured the deviation in the ground plane, where it was a real 12 px — the
plane the player is not looking at. Bowing only the perpendicular's X component decouples them:
an east–west flight curves purely as a thrown arc (its bow is 0), a north–south one swings
sideways as well, and neither can cancel the other. Re-measured off the shipped module: **13.8 px
(28 px east–west), 18.8 (75 px east–west), 8.5 (28 px north–south), 18.0 (75 px north–south)** of
screen deviation, and every bow assertion now runs in screen space, in both directions.

### The number that shapes the whole curve is not in the render layer

Everything but a weapon is auto-collected on overlap — `SIM.pickupRadius`, 15 px of padding past
the player's own ~16 px body — so **the flight the player sees most is about 28 px long**. Sized
purely as a fraction of the distance flown, the arc collapses to a few px and 600 ms of it reads
as a drop sliding in slow motion. So every offset is floored as well as scaled (`POP_BACK_MIN` 8,
`BULGE_MIN` 16, `HOP_BASE` 14): the motion carries the duration instead of the distance having to.
The fractions are for the other case — a weapon claimed by clicking from across
`SIM.lootRevealRadius`, 80 px, which is the only collection in the game that happens at range.

**This is worth saying plainly, because it is the gap between what was asked for and what the
game can currently show:** in the games this effect is borrowed from, loot is MAGNETISED from a
hundred px or more and the flight is the pickup. Here the sim has already taken the item at
touching distance, so the arc is after-the-fact feedback over one body-width. Widening
`SIM.pickupRadius` would give the effect the room it is built for, and it is a sim change with a
balance argument attached (a contested `energy` or `heal` in PvP is decided by who reaches it) —
filed, not taken. Parked deliberately rather than dropped: the reporter asked to play the arc as
shipped first and decide afterwards whether the pickup itself should reach further.

### The chase needed one exception, and reviewing the claim above is what found it

Checking the descend path against the code (`ExtractionSystem` line 198, `state.pickups.length = 0`,
and `SpawnSystem`'s room build doing the same — both silent, no event, exactly as design/05's
"uncollected drops don't carry to the next floor" says) turned up a case the first cut got wrong in
the other direction. The flight re-asks its target every frame so it follows a running player; the
sim can also TELEPORT that player in the same tick it collects, because `PickupSystem` is step 10
while `DoorSystem`'s force-regroup is 11.5 and `ExtractionSystem`'s descend is 12. Taking a heal on
the tick you tap DESCEND would have streaked the drop from the old floor's geometry to the new
floor's spawn point.

A target that jumps more than `TARGET_TELEPORT_PX` (120 px) in one frame now ends the flight
instead of being chased — unreachable honestly at `PLAYER_BASE.speedPerTick` = 6.4 px/tick, which
would need a 625 ms frame. Writing its test found two more defects in the same five lines: the
layer was storing the resolved target **by reference**, so a resolver handing back a live mutated
object made "the last point I saw" mean "the current point" and the guard a permanent no-op; and
resolving the target at LAUNCH reads (0, 0) for a collector view created on the same reconcile
(`Scene.spawn` snaps state, only `interpolate` writes the transform), which tripped the guard on
the first frame of a legitimate flight. The target is resolved on the first `update` now, and
copied on every one.

### Verification

`client/src/game/scene/pickupFlight.ts` (232 lines) and `PickupFlightLayer` are asserted as
SHAPES, not as restated constants — every one of the bow, the pop, the hop and the shrink can be
zeroed on its own without moving either endpoint, so the tests measure screen deviation, "further
from the collector 50 ms in than at rest", "peaks by mid-flight and falls through the last third",
and a moving target the layer must keep re-asking. **+36 tests** (24 in `pickupFlight.test.ts`, 9
in `Scene.test.ts`, 2 in `GameLoop.test.ts`, 1 in `engine/systems/pickups.test.ts`), client
6,270 → 6,305 green, engine 1,599 → 1,600 green, server 1,743 green, `tsc --noEmit` clean, file
length and doc paths clean, and coverage 96.87% lines / 93.17% branches against the 90/90 gate
with the new file at 100% lines / 100% branches. Verified in the running
game as well as in vitest, which is where the screen-space bug was found: the pane starves rAF
~300×, so the ticker was stopped and driven by hand, a `weapon` drop claimed through the real
`CommandBuilder.requestPickup` path from 75 px, and the pose traced frame by frame.

**The mutation battery, because a percentage said nothing about the seams.** Asked whether more
tests were worth adding, the honest way to answer was to measure rather than guess — and the first
pass killed 2 of 8. Six survivors, every one of them a claim this work rests on:

```
  KILLED   pickup.by: the COLLECTOR -> the item id ................ 1  (was SURVIVED)
  KILLED   pickup.by: the COLLECTOR -> the first seat ............. 1  (new mutant)
  KILLED   the flown view loses the weapon it is of ............... 1  (was SURVIVED)
  KILLED   the arc aims at the LOCAL seat, not the collector ...... 1  (was SURVIVED)
  KILLED   GameLoop drops reconcile's events, offline ............. 1  (was SURVIVED)
  KILLED   GameLoop drops reconcile's events, online .............. 1  (was SURVIVED)
  KILLED   every arc bows the same way ........................... 1  (was SURVIVED)
  KILLED   the arc aims at the feet ............................. 2  (was SURVIVED)
  KILLED   the arc aims over their head ......................... 2  (new mutant)
  KILLED   flights never advance ................................ 2
  KILLED   a flight is never given up on a teleport ............. 1
  KILLED   the target is stored by REFERENCE again .............. 1
  KILLED   off the DIFF: every vanishing drop flies ............. 2
```

Three things the survivors say, beyond "add a test":

- **`by` had no test at all, in either package.** The client's Scene cases hand-build their own
  events, so nothing anywhere checked that the engine puts the COLLECTOR in that field — and both
  plausible wrong answers (the item's id, `players[0]`) are indistinguishable from the right one in
  a one-player state, which is every other pickup test in that file. The new engine case uses two
  seats, has the SECOND one collect, and asserts against the item id and the first seat by name,
  with an anti-vacuity assertion that those three ids really are three different numbers.
- **The wiring was the most fragile part and the least tested.** `events` reaches `Scene` as a
  third argument on a call that already existed, and every existing assertion about `reconcile` is
  about whether and when it was CALLED. Dropping that argument deletes the whole feature with
  nothing red, at either of the two call sites. Both are pinned now by identity against the batch
  the reactor receives — "the scene and the reactor see the same tick", not "an array was passed".
- **One survivor was an assertion written as a control and believed.** "the arc aims at the feet"
  passed `expect(drop.y).toBeLessThan(body.y + body.drawnLift - 4)`, because the drop is still
  coming down out of its hop when it arrives and clears the ground point either way. It is a
  fraction of the drawn body now (more than 0.3 of it, less than 1.0), which also catches the
  mutant in the other direction — a drop sailing over the collector's head.

A thirteenth mutant is worth recording as a NON-result: wrapping the launch loop in a condition
that is always true survived, and says nothing at all, because it changes no behaviour. The honest
version — launching a flight for every pickup view the diff destroys, which is the rejected design
in miniature — is killed by the absence test, which is exactly what that test is for.

## The backend gets hardware of its own (2026-09-15, deploy + infra + docs, no engine change)

*"我去给这个游戏买一个专属服务器"* — and the interesting part of this pass is not the move. It
is how much of `server/docker-compose.yml`, `prometheus.yml`, `config.alloy` and
`deploy/ci-deploy.sh` turned out to be describing **the landlord rather than the services**.
Since 2026-09-07 the three planes had run as a guest on a box belonging to somebody else,
borrowed for its idle spare capacity. Four things in the deployment existed only because of
that, and every one of them had a comment explaining itself, which is the only reason they
could be told apart from decisions with live reasons:

- **The reverse proxy was somebody else's.** This project's entire footprint on that machine
  was ONE site block appended by hand to the host's own Caddyfile, a file fronting three
  other site blocks as well as us. It is now `server/caddy/Caddyfile`, a tracked file shipped
  with every deploy — same four-way `handle` split, upstreams named by compose SERVICE
  (`matchsvc:8788`) rather than by container, because our Caddy is inside the project now.
- **The network was theirs.** An `external: true` network existed so that THEIR
  Caddy could resolve OUR container names. Both halves of that arrangement left with the box.
- **Prometheus scraped their exporters.** The host's own cAdvisor and node-exporter —
  the right trade on hardware we did not own (a second privileged cAdvisor mounting `/`,
  `/sys` and `/dev/kmsg` to recompute numbers that already existed one DNS name away), and a
  trade whose stated cost was that another team renaming a container emptied every infra panel
  here. `obs-cadvisor` and `obs-node-exporter` are ours now.
- **Nothing was named after the game** so that nothing about it appeared on a machine
  belonging to someone else. Containers are `bb-*` and the image is `blightbloom:latest`; the
  disguise cost nothing while it was true and reads as somebody else's container on a box
  that is ours.

**What did NOT change is the more useful half.** The `obs-` prefix stays, the Alloy discovery
filter stays, and both now guard something smaller than they were written for — so both say so
in their own comments and in the test that enforces them. A rule whose reason has quietly
expired is one nobody can evaluate later, and `deploy.observability.test.ts` now names which of
the two states it is asserting: the prefix has stopped preventing a DNS collision on a shared
network and started being what makes `docker compose ps` legible and what five other files
spell out. design/19 §10's *"two facts about the host that shaped the deployment"* are both
marked **EXPIRED** in place rather than deleted, for the same reason.

**The cutover was shaped by one fact about Caddy**: it attempts the ACME challenge the instant
its config loads, which on 2026-09-07 cost a ~10 minute backoff when the site block was
reloaded before the DNS record existed. So the order was — ship and start **everything except
`caddy`**, verify from the inside where no hostname is involved (each `/health` over
`docker exec`, `up == 1` on all eight scrape targets, and Loki's own `label/svc/values` to
prove collection works under the new container names), stop the old stack, re-copy the
databases with nothing writing either side, move the A record, and only then start the proxy.
The certificate signed on the first attempt. **It also corrected a claim this pass had written
into three files**: the comments said port 80 must stay open because it is the HTTP-01
challenge path — but the watched issuance solved `tls-alpn-01` on 443 and never touched 80.
Port 80 carries the HTTP→HTTPS redirect and the `http-01` **fallback**, which is worse to get
wrong than it sounds: closing it breaks nothing on the day it is closed and removes the spare
tyre from a renewal two months later.

**A uid, chosen rather than inherited.** The deploy account is `deploy` with **uid 1000** — the
same uid the container's `node` user has — where the borrowed box's `tao` was 1001. That one
number is why `ci-deploy.sh`'s ownership normalisation is a no-op in the steady state instead
of the rite it became on 2026-09-09, when `mkdir data/adminsvc` failed with `Permission denied`
and aborted a deploy. The normalisation stays, because a directory **Docker** creates because
nobody created it first is still `root:root`, and that is the actual 2026-09-08 bug (18 hours of
silently failing backups, CI green throughout).

**The pass's own expensive lesson was line endings.** Three separate edits to
`monitoring/alloy/config.alloy` reported success and changed nothing: the file is CRLF under
Windows `core.autocrlf`, the patterns were LF, and a `str.replace` that matches nothing is not
an error. `server/.gitattributes` now pins every file shipped to the box to LF — not tidiness,
since a CRLF `ci-deploy.sh` dies on the far end as `$'\r': command not found` (the reason
README §2's install line has always piped through `tr -d '\r'`), and a stray `\r` inside a
scrape target resolves to nothing at all.

**New assertions rather than renamed ones.** `EDGE_SERVICES` is its own category in
`deploy.manifests.test.ts` because `caddy` is the first service here to publish a host port and
therefore the first whose misconfiguration is reachable from the internet: exactly three ports,
80 among them, and **no other service publishing anything**. That last clause is the one worth
having — `ufw` cannot catch it, because Docker publishes a port by writing its own iptables
rules ahead of ufw's chain, so a `"9090:9090"` added to `obs-prometheus` during a debug session
puts an unauthenticated metrics browser on the public internet while the firewall still reports
the port closed. cAdvisor also got explicit flags (`--housekeeping_interval=30s`,
`--docker_only`, `--store_container_labels=false`): its defaults housekeep every cgroup once a
second, which on 2 vCPUs makes the monitoring the largest single CPU consumer on the box.

Walked, not assumed: twelve containers (eleven healthy, `bb-alloy` with no health column by
design), every public acceptance row from §4 including `/metrics` and `/admin/health` answering
404 while `/admin/` serves the console, `/client/flags` returning exactly two keys with
`cache-control: no-store` read off the GET, `ss -tlnp` showing only 22/80/443 bound publicly,
a verified backup cycle of all three databases on the new box before the old one was touched,
and a real payload pushed over the forced-command key — which was first proven to restrict by
asking it to run `cat /etc/shadow; id` (it ran the deploy script instead) and by `ssh -tt`
being refused a PTY. A full `--force-recreate` afterwards produced **zero** ACME lines, which
is the check that `caddy-data` is a named volume rather than something a deploy can clear.

The borrowed box is clean: block removed from its Caddyfile with `cp` rather than `mv` (that
file is a single-FILE bind mount, so a rename changes the inode and leaves `validate` and
`reload` both reporting success against the stale one — 2026-09-09's full-day diagnosis), its
four neighbours confirmed still routed by reading Caddy's own loaded config rather than by
guessing at a 404, and the deploy directory with its volumes, image and script backups all
gone. **One thing could not be finished from here**: `~/.ssh/authorized_keys` on that machine
is root-owned, so the retired deploy key's line has to be removed by whoever has its `sudo`
password. It is already inert — its forced command names a script that no longer exists — but
inert is not revoked.

> **"Clean" meant the stack.** A sweep of the box later the same day found what a
> `compose down` does not touch — see "Leaving a borrowed box is a second job" below.

Two things were left open at the end of the move and both were decided the same day, by the
person who has to act on them — recorded because one of the decisions **reshapes the item rather
than closing it**. The off-box copy of the backups was going to want a scheduled pull from
somewhere that is not this VM; the answer instead is that **player data moves off SQLite onto a
database**, which makes "a verified copy that survives the box" a property of that store rather
than something to build here. Good answer to that problem — and not to its twin, which this pass
had paired it with: alerting. A managed database survives the VM; nothing in it notices that the
game stopped answering, and "the whole box is gone" still produces no signal at all, because the
dashboards that would report it are on it. So they stop being one problem with one answer. The
retired deploy key on the old box (root-owned `authorized_keys`, inert but not revoked) is the
box owner's to remove, confirmed. `platform` `test` `docs`

## The chest nobody could open (2026-09-15, engine + client + art + audio + docs, `ENGINE_VERSION` 65→66)

> *"宝箱无法打开。"* — with a screenshot of a player standing on one.

The mechanic was fine. That is the whole finding, and everything below follows from it: a headless
run opens the shipped level-1 cache chest the tick a command carries `INTERACT`, and the running
client opens it on the first frame a `KeyE` reaches `WebInput` — both verified **before** anything
was changed, which is what kept this from becoming a hunt through `ChestSystem` for a bug that was
not there.

What was missing was any way to find out the mechanic existed. A chest had **no art, no sound and
no prompt**, and `INTERACT` is taught nowhere — `tutorial.hint*` covers move, attack, swap and
deflect and stops. **A mechanic nobody can discover is indistinguishable from a broken one**, and
that failure is structurally invisible to a green engine suite: every `ChestSystem` case passed
all day.

### Two fixes, and the second deleted half the first

The first pass added the missing sentence: `ui/ChestPrompt.ts`, a bottom-centre caption naming the
control this device actually has (`E`, or the touch `+` pad). The owner's answer a few hours later
was to **delete the step instead** — *"开普通箱子不要额外操作，玩家靠近后自动打开"* — so a small chest now opens
on APPROACH and its caption is gone with its button, along with three strings in eight locales.
Both halves are worth keeping in mind, because they are different lessons: a step nobody can
discover needs explaining, **and the cheapest way to make a step discoverable is often not to need
it.**

`ChestSystem.openWanted` drops the `interacting` term for a small chest; `CHEST_INTERACT_RANGE_GRID`
became `CHEST_OPEN_RANGE_GRID` (same 1.5 — the word stopped being true). A big chest is untouched:
it never read a button, and still wants every mechanism plate occupied on the same tick. What
survives of the caption is the big chest's live `{on}/{total}` plate count, shown from the
mechanism ring outward so it stays up while the player walks out to a plate to do the thing it
asked for — a rule a ring of discs cannot state on its own.

**v63's argument for the button is recorded rather than erased**, in `ChestSystem`'s own header: a
held `INTERACT` was chosen so that spending a floor's loot was *a decision*. It assumed the player
knew the button existed. The decision a small chest still carries is whether to walk into its
dead-end side room at all, which is the choice that was actually costing something.

**The revive arbitration went with it.** v63 mirrored `ReviveSystem.findReviver` inside this system
so a rescuer's held button could not also spend a chest; no chest reads input now, so the mirror is
deleted rather than kept — a rule that cannot fire is a rule nobody can test. The visible
consequence is intended and pinned by a test: **a small chest beside a downed teammate opens while
you revive them.**

### The golden gate was blind to the rule it is the only witness to

`goldenHash.test.ts` stayed green across the change, before and after, with no re-record. The
`chest-room` scenario pulsed `INTERACT` every 3 ticks — and `tick % 3` includes **tick 0**, so its
small chest opened on the first tick under both rules. The one scenario that can see `ChestSystem`
at all could not tell the two apart.

The fix is the scenario, not the hash: `chest-room` now presses **nothing** (`chest: false`), so
both chests open with no button anywhere in its input stream, and the old rule would finish that
run with `chest_open: 1` instead of 2. The recorded hashes moved on the version stamp only
(`replay.ts` hashes `ENGINE_VERSION`), with **all seven witnesses identical** — which is the check
that the rule change really is invisible to every other fixture.

### Art: four states, and the number that let the pairs ship

Four generations, all accepted first time, measured before being called usable: `chest_small`
(874×629 body, aspect 1.39, median luma **107**), `chest_small_open` (0.94 / 41),
`chest_big` (1.45 / **49**), `chest_big_open` (0.82 / 30).

- **Footprint share** is what decided the pairs could ship at all — the widest opaque run in the
  bottom tenth of the file over the file width, i.e. how much of the picture is the box standing
  on the floor. The two sprites of a pair swap in place on one ground point and are scaled by
  WIDTH, so a smaller share in the open file would visibly shrink the chest at the moment it pays
  out. The four land within **0.026** of each other; `scene/chestArt.test.ts` holds each pair to
  0.05.
- **The long axis is per FILE, not per cue**: 8× the drawn long axis, and for the two open files
  that is the HEIGHT (the lid is up) — 153 and 275, not 144 and 224. Each pair still came out the
  same WIDTH, which is what makes the in-place swap stable, and it fell out of the arithmetic
  rather than being forced.
- **The alpha plateau arrived on all four**, exactly as the 2026-08-24 props batch predicted, and
  `alpha-audit.mjs` calls every one of them clean (haze 0.3-0.8%). What lied was the TRIM: the small
  chest's raw bounding box reads aspect **1.17 against its real 1.39**, a chest that would have
  stood 19% too short. `alphaClamp.mjs` first, measure after.
- `ChestLayer` draws a bottom-anchored sprite scaled by width with the art's aspect setting the
  height (`propRender`'s exact treatment) plus the ground shadow every other body in the scene
  casts; the Graphics form stayed as the fallback and was **re-anchored to the feet** so the two
  stand in the same box. A chest that jumped half its height the frame its texture arrived would
  be a cold-load-only bug nobody could reproduce.
- **Watch item, stated rather than found later:** the big chest reads at median luma 49 against the
  scenery crate's 53 — the comparison the small chest's own prompt spends a paragraph forbidding.
  It ships because SIZE and FORM carry the distinction (28 px domed iron against 18 px flat brass),
  which is design/13's dual-channel rule in the two channels that survive greyscale. If it reads
  wrong in play the fix is a brighter timber on a reroll, not a tint in the renderer.

### Audio: the band metric picks a cue for the third time

`chest.open`, 2 variants, 8.5 kB. Fourteen candidates out of the RPG Audio pack the game already
uses (zip re-fetched and **sha256-verified against `packs.json`** — the record that exists for
exactly this), ranked on the 500-4000 Hz band-vs-peak figure the `hurt` pass introduced, because
that is the band a phone reproduces. `creak1`/`creak2` are the pair that measure as **one action
twice** (centroid 3230/3486 Hz, band 17.1/17.3 dB under peak, level with the shipped
`pickup.weapon` at 17.5 and `spawn` at 17.6); `creak3` was dropped for being a third of the length
and an octave darker — variety, not a variant — and the latch/door/leather families for sitting
24-29 dB down in that one band.

**The cue is the LID, not the reward.** The payout announces itself through `pickup.weapon` a tick
later, and that step-order claim — made in `ChestSystem`'s header since v63 with nothing checking
it — is now a test. `process_reaction.py` grew the cue rather than a fifth driver being written:
what decides which driver a cue belongs to is where its peak reference comes from, and its
docstring now says that instead of naming a category it had outgrown. Re-running it reproduced all
eleven existing files **byte-identically**.

**Verified on the live SFX bus**, which is the only thing that replaces listening here: silence
reads 0.000, the cue fired directly reads **0.0695**, and a chest coming into range with the room
emptied reads the same 0.0695 through the real event path (`pickup.weapon` 0.0625, `wave-clear`
0.0862, `impact` 0.0907). The room has to be emptied first — driving frames by hand fires combat
cues, and the first attempt measured them instead.

### What the tests did, including to themselves

**Four existing gates fired on their own and all four were right**: the cue count, the audio
pipeline's fixture table, the "engine events the client deliberately does not react to" list (which
had carried `chest_open` as *"a chest pays out in silence"* for exactly one day before that silence
was reported as a bug — the list working as designed), and the voice-cap saturation case.

**A test that passed and pinned nothing.** The first version of the one-tick-gap test asked for the
payout's id only once it existed — a tick late by construction — and deleting `PickupSystem`'s
`spawnTick` guard did not make it fail. It now runs twice: once to learn the id (the engine is
deterministic), once with that request **already standing** from tick 1.

**A property defended twice looks like a gap in the test and is not.** With the rewrite, deleting
the `spawnTick` guard alone still leaves it green, and so does swapping step 10 with 10.5 — both
together turn it red. That is recorded in the test, so a future reader does not read a surviving
single mutant as a hole.

**A literal that stopped being true.** The saturation case asserted "every cue above priority 50
keeps its slot"; `chest.open` at 85 pushes `impact` at 60 over the cap edge, so the boundary is now
derived from the ladder — the same repair that case's own comment records for the literal `3` it
used to carry.

New: `scene/chestArt.test.ts` (the shipped PNGs), `ui/chestProximity.test.ts` + `ui/ChestPrompt.test.ts`
(the caption), `controllers/hudContext.test.ts` (the HUD context mapping, split out of `GameLoop`
when that file hit exactly 500 lines and needed one more field), four reactor cases for the cue, and
two engine cases for the gap. engine 1,600 → 1,602; client 6,305 → 6,369.

### Still open

- **The PvE sim's bot never enters a side room**, so the loot instrument reads **0 weapons per
  floor** on a level whose weapons have lived in chests since 2026-09-14. Not introduced here, but
  this pass is what makes it matter: the whole weapon economy is now behind a door the measurement
  never opens.
- **Nobody has listened** to `chest.open`, or to the 61 cues before it. Unchanged, and still the one
  open item on the audio set that measurement cannot close.

## Leaving a borrowed box is a second job (2026-09-15, infra + docs, no engine change)

The ask: the game has its own server now, so delete everything the borrowing left behind — and
the interesting part is that the deployment had already been torn down. "The borrowed box is clean" is written
four sections up in this same volume, and it was true about the thing it was measuring: no
containers, no volumes, no deploy directory, no site block. It was the wrong measurement.

### `docker compose down` removes the deployment, not the project

A sweep of the machine afterwards found, none of it reachable from a compose file:

| left behind | what it actually was |
| --- | --- |
| `~/db-snapshots/` | two SQLite snapshots of **live account and billing data**, taken by hand before the `display_name` migration |
| `~/obs-*.mjs` ×4 | throwaway probe scripts from the observability bring-up, still naming `obs-loki` / `obs-prometheus` |
| 4 images | the version-pinned `alloy` / `loki` / `grafana` / `prometheus` this stack ran; every other tenant used `:latest` or a different major |
| 124 buildx refs | `~/.docker/buildx/refs/…`, each a JSON line recording this project's build paths |
| 761 MB build cache | the shared builder's, dominated by 13× `COPY dist/*.mjs` and 12× this Dockerfile's `mkdir -p /data /backups` |
| 5 `.bash_history` lines | including the deploy key's whole `authorized_keys` line, pasted three times |
| 5 Caddyfile backups | the host's own `Caddyfile.bak-*`, each still carrying the site block and its upstream container names |

The first row is the one that matters. Everything else is litter; that one is player data on
hardware this project no longer has any claim to, and no teardown step would ever have caught it
because nothing created it — a human did, once, and then the file was done being interesting.

**Two traps in the cleanup itself**, both of which would have damaged a neighbour:

- **The buildx refs directory is SHARED.** 124 of the 215 files there were this project's; the
  other 91 belong to the two co-tenants. `rm -rf` on that directory is the obvious move and it
  destroys their build metadata. The refs are one-line JSON naming a `LocalPath`, so the correct
  filter is `grep -l` on the paths and nothing else.
- **`docker buildx prune --filter description~=…` is accepted and does nothing.** `du` takes the
  same filter and returns a correct subset — a nonsense value matched zero entries, which is what
  made the filter look trustworthy — but `prune` with it reclaimed `0B` three times in a row while
  the matching entries sat in `du`'s output. So the cache is all-or-nothing. A full prune was the
  call: it costs the neighbours one cold rebuild and nothing else, and leaving it would have left
  this project's source layers on the disk indefinitely.

**One thing cannot be removed and should be written down rather than quietly dropped**: every log
line this project's containers wrote between 2026-09-07 and the move is in the box owner's Loki,
permanently. Their collector read the Docker socket unfiltered, this stack could never close that
half (`../19-server-platform.md` §10 has the pair), and a retention policy on somebody else's
store is not a thing to go and edit.

### The disguise changes hands

The second half of the ask — rename the co-tenant to the name this project had been using —
only parses once you look at the box: the co-tenant that moved in after this project left was sitting there under its
own project name, in the open, which is exactly the exposure the neutral name was invented to
avoid. So the name was not retired — it was handed over. Directory, compose project, container,
CI script, key file and installer all renamed, and the Caddy block's comment and upstream with
them.

Two things deliberately did **not** move:

- **The public hostname.** It is a live DNS record with a client pointing at it; renaming it is a
  DNS change and a client change, not a change to this machine. The disguise is about what is
  visible with shell access, and a public hostname is not that.
- **The application bundle.** It is CI output from the other repo, overwritten on every deploy,
  and it carries that project's name in a dozen admin strings. Renaming it here would be undone
  by the next push and would break an env var while it lasted.

**The ordering constraint is the part worth keeping.** The live deploy script's path is named
inside `authorized_keys` as an SSH forced command, and `authorized_keys` is root-owned on that
box with no passwordless sudo — so the rename could not be atomic with the thing that points at
it. Renaming the script alone breaks that project's CI deploy silently, at the next push, with an
sshd error nobody is watching for. So the old path stays as a shim and a prepared script does both
edits in one root run. **A rename that needs two privileges is two deploys, and the order is:
create the new name, leave the old one working, switch the pointer, then remove the old name.**

### What "delete the information" means when the information is load-bearing

The repo half was not a `sed`. Four of this deployment's decisions exist *because* the box was
borrowed, and this volume argued four sections ago that they were retirable only because each one
carried a comment saying so. Deleting those comments would have re-created the exact problem the
move solved — a rule with no surviving reason, which nobody can evaluate and therefore nobody can
remove.

So the split is **identity out, shape in**. Gone from the whole tree, roadmap history included:
the hostname, the IP, the neighbours' site names, their Caddyfile path, their container and
network names, the account names, and the neutral name itself. Kept: that the box was
borrowed, that the proxy was somebody else's, that the network was external, that the exporters
were the host's, and that the names were deliberately neutral — every one of which is this
project's own history and none of which identifies anybody. Seventeen files: `server/deploy/`'s
runbook, the compose / alloy / prometheus headers, `matchsvc.ts`, two deploy test files,
`../19-server-platform.md`, the top-level `README.md`, `../ROADMAP.md`, and roadmap volumes 40,
42, 44, 47, 50, 52 and this one.

Two of those edits were corrections rather than scrubs, and they are the reason a sweep like this
should not be done with a regex:

- This volume's own *"the borrowed box is clean"* was false when written, and is now a pointer to
  the section you are reading.
- `server/deploy/README.md` §7 said the retired deploy key was *"owner-confirmed as theirs to
  clean up"*, which had quietly become a way of never doing it. It names the staged script and
  the one command now.

### Still open

- **One root run on the old box**, `sudo sh ~/finish-rename.sh`: it deletes this project's retired
  deploy key, scrubs that key line from the `authorized_keys.bak-*` files beside it, repoints the
  co-tenant's forced command, and removes the shim. Everything else is done; this one needs a
  password no session here has.
- **The other repo has not caught up.** `bigtaoo/e.gamestao` still holds its own copies of the
  deploy script and compose file under the old names. They are inert copies — the live ones on the
  box are what run — but a re-install from that repo would undo half of this.

`platform` `docs`
