# Work log — 2026-09-15

Volume 60. See [`design/ROADMAP.md`](../ROADMAP.md) for the index and the phase spine.

## Loot that arrives on you (2026-09-15, engine + client + docs, no ENGINE_VERSION bump)

> *"你可以在 worktree 里给拾取物品加一个曲线飞行特效吗？大概 0.6 秒飞到玩家身上。就是其他游戏里普遍有的那种拾取效果。"*

**Followed up 2026-09-21 ([volume 78](78-2026-09-21-pickup-flight-accel.md)): the curve gained an
acceleration and the flight is now 420 ms.** Every number below was true when it was written and
is left alone; what changed is that `t` no longer goes into the bézier raw, which is a decision
this volume argues for at length and that volume overturns with its own measurements.

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
