# Occlusion

Keeping the character visible through stone.

One part of the rendering architecture doc. The index, the fidelity roadmap and the quality
tiers live in [../01-rendering.md](../01-rendering.md); the doors that used to share this file
are in [04-doors.md](04-doors.md) (split 2026-09-21, at 1,046 lines).

## The occlusion x-ray: the character is never lost behind a block (2026-08-20)

Live report, with the wall circled: *"角色跑到墙下面去了"* — the character walked to the north
side of one of `ember_l1_alcove`'s interior blocks and was **gone**. Not clipped, not half
hidden: measured on the extracted frame, the rect where the body should be read luma **78.4**
while the cap stone right beside it read **77.1**. The character was arithmetically
indistinguishable from the wall.

**Nothing was drawing wrongly.** Every layer was individually correct, and their combination
hides the player:

- A block's art spans `south - height - depth .. south`, i.e. it intrudes one full wall height
  north of its own footprint ([Standing walls](02-walls.md#standing-walls-2026-08-18) says exactly this, and it is what makes a wall
  look like a wall).
- That intrusion lands on **walkable floor**, and the block sorts on its south edge, so it is
  drawn in front of anybody standing there.
- The player's own wall clearance (`PLAYER_BASE.solidRadius`, 16 px) puts them 16 px north of
  the footprint at closest approach, so the cap reaches `70 - 16 = 54` px above their feet —
  and the drawn body is **32** px tall. Fully covered, with 22 px to spare.
- 2D sorting is per-object, so "mostly behind" is not available: the whole character goes.

In real geometry the head would poke over a wall this tall by a few px; the fake-3D
approximation eats that margin, and this doc's own "Limits of fake 3D" section is where this
case had been parked. **Being hidden is not the bug — being hidden with no way to tell is.**

**The fix is an x-ray, not a geometry change** (`scene/occlusion.ts`, driven per render frame
from `GameLoop.updateFx` alongside the dynamic lighting, which already has the local player and
this frame's dt). Any standing block currently drawing over the local player fades to
`XRAY_FADE` (0.34) over 90 ms and back over 220 ms — slower back, so walking along a block
cannot strobe. What was rejected and why:

- **Lowering the interior tier** so the head clears the cap. Physically consistent and needs no
  per-frame state, but it only ever buys back the top few px of the body, and it breaks the
  deliberate `WALL_H_INTERIOR == pillar height` agreement that lets a room's verticals be read
  against each other.
- **Drawing the player OVER the block.** Always visible, but it reads as standing on top of the
  wall — the same spatial confusion, inverted, and it permanently costs the occlusion cue.
- **Growing the collision footprint** so the blind band is unreachable. Invisible walls, and it
  eats a wall height of floor around every block in the room.

**Since 2026-08-20 this also covers every live enemy, not just the local player** — live report
with a screenshot circling a monster gone behind a wall: *"如果只有怪物在墙下面的话，就看不到怪物了"*
(if only a monster is under the wall, you can't see the monster at all). The x-ray used to take a
single `OcclusionFocus` (`GameLoop.updateFx` built it from `scene.player` alone), so a monster
standing in the exact hidden band the fix above closes for the player got no x-ray at all and
rendered fully swallowed by the wall — the very failure this section exists to remove, just for a
different actor. `occlusion.updateOcclusion` now takes a LIST of foci (`Scene.enemies` enumerates
every live enemy view alongside `scene.player`), and a block fades if it hides ANY of them — the
cap and deep-fade decisions are each an OR across the whole list, not "whichever focus happens to
be checked first."

**Since 2026-08-30 a dropped item is a focus too, and unlike the two above it never moves** — live
report *"现在被墙挡住的物品，只有角色走到墙下的时候才显示，改为始终显示"* (an item hidden behind a wall
only showed once the player walked into the block's own hidden band, because that is the only thing
that ever asked the wall to fade). A `Pickup` never enters the band on its own account — it is
simply placed there by the room or the drop table — so gating its visibility on a player/enemy
also standing in that same band left it invisible for however long neither did. `Scene.pickups`
(sibling of `scene.enemies`) feeds every live drop's ground point and drawn `bodySilhouette` into
the same `foci` list `GameLoop.updateFx` already builds, which makes the fade over a drop
**permanent** rather than conditional on anyone being nearby to trigger it — the wall between the
camera and a piece of loot is translucent from the moment the drop lands to the moment it's picked
up, full stop.

**Only the CAP fades — and where that is not enough, the face follows.** Measured both ways on a
live frame: fading the whole block loses the stone and the block reads as a hole in the room, so
the default pass moves the cap layers only (`occlusion.xrayLayers`, tagged in `buildWallBlock`) and
leaves the face, the shading and the silhouette at full strength, with the cast shadow never moving
at all. The result reads as a glass-topped block on a solid brick elevation, which still says "you
are behind this". Layers are tagged by label, not child index, and each layer's authored alpha is
*scaled* rather than replaced, so the cap's additive key light stays proportional on the way down.

For an interior block that is the whole story: 70 px of art over a 64 px footprint means the
engine's own clearance keeps the body's feet 10 px *above* the cap/face fold, so the face never
covers any of the character. It is not the whole story for a **tall wall on a shallow footprint** —
which needs `depth + clearance + bodyH <= height`, and which every 104 px room boundary over a
32 px footprint satisfies. There the body can sit entirely below the fold and fading the cap
achieves *literally nothing*. `occlusion.needsDeepFade` is a second pass for exactly that: when the
FACE alone covers as much of the body as it takes to trigger the x-ray at all (the same
`MIN_COVER_FRACTION`, deliberately not a second number), the face and its shading go too. **Since
2026-08-27 only the BAND of the face a body can reach goes** — the block's base stays opaque through
the fade; see "The deep pass stops where the body does" below for the bound and what it fixed. It costs
something real — dropping a face reveals what is *behind* the wall, and at a room boundary that is
the next wall's own bright cap showing through as a pale band — which is why it is a fallback and
not the default. Swept over the shipped floors it fires on **0.2%** of the standable floor (1.2% before the kerb tier fix below). The two
passes stage naturally as you walk into a wall: the cap goes first, and the face only once the cap
has stopped being the thing in the way.

**A pillar gets the same treatment, and it has no cap/face split at all.** A pillar is
drawn upward from its own ground point, so the surface a character disappears into is its
70 px **shaft**, not the little ellipse on top — its whole body fades. This doc used to call
being hidden behind a pillar intended (see "Depth sorting" below); a body that vanishes
completely is not, whatever shape the thing hiding it is. A pillar is also a *narrower* target,
so the player brushes past its blind side more often, not less.

**What deliberately does NOT trigger it: the south kerb.** A 22 px lip reaches 6 px above the feet
of a player standing flush against it — the character was never hidden, and fading the whole
southern lip of the room every time the player walks along it would be a bigger artifact than the
6 px it fixes. `MIN_COVER_FRACTION` (0.45 of the drawn body height) is what draws that line, and
the *drawn* body is the denominator on purpose: an absolute px threshold is exactly the kind of
number that goes stale the next time the art grows.

**A perimeter run DOES trigger it, and the first version of this section claimed otherwise.** The
claim was that a room's boundary covers floor on the far side of itself, so a player inside the
room is always south of its sort line. True of a room's north wall, false in general — and
`occlusionCoverage.test.ts` found both counterexamples in the shipped content:

- **A long north-south run whose north END is open floor** (a door passage between two rooms). The
  run's art spills one wall height past its own footprint onto ground the player walks over once
  that door unlocks, and standing there they are half swallowed by its cap. **Fixed at the
  geometry, same day, once it turned out to swallow the DOOR too, not just a player who happens
  to stand there** — live report with a screenshot circling the door: *"门不能被高墙挡住了。门应该
  是随时清晰可见的"* (a door must not be blocked by a tall wall — it should be clearly visible at
  all times). The door sprite lives on `layers.ground` (`RoomBuilder.buildDoors`), always behind
  the Y-sorted `entities` the run stands on, so no amount of Y-sort or x-ray fading could ever
  help it — the x-ray only ever protects the local player's silhouette (see below), and a door
  isn't one. `wallRuns.bordersDoorNorth` finds a run whose north edge meets a door passage's south
  edge, and `blockCapTop` clips that run's cap to stop at its own footprint (`doorClip`, zero
  lift) instead of spilling past it — the same clip `tuckNorth` already applies against a
  neighbouring wall's crown, just with nothing left to reveal underneath.

  **The cap-only clip left a SHALLOW run still spilling, and this was recorded as an open
  question rather than measured** — the note here used to read "a SHALLOW run beside a door
  still spills; that residual case is the general doors-have-no-x-ray problem above, not this
  clip's to solve." `doorSpillCoverage.test.ts` (2026-08-20) swept the real pipeline instead of
  guessing and found the shallow shape firing **12 times across all five shipped floors** — not
  hypothetical, and in fact the MORE common shape (`carveDoorGaps`'s ordinary-thickness stub
  walls flanking a door opening are almost all shallower than their tier height; the deep run
  above is the unusual case). Root cause was one layer deeper than the cap: a block's FACE is
  drawn at a fixed tier height regardless of its own footprint depth, which is exactly what lets
  a wall "stand" taller than its own collision thickness — but it means that whenever the
  footprint is shallower than that height, the FACE ALONE already reaches past the run's own
  north edge, with no cap involved at all (measured: a 32 px-deep PERIMETER stub spilled 72 px of
  pure face with the cap-only clip already in place). `wallRuns.effectiveWallHeight` closes it by
  shrinking the height fed to BOTH the face and the cap for a `doorClip`ped shallow run — a
  genuinely deep run is unaffected, `Math.min` returns its tier height unchanged.
- **A wall between two vertically stacked rooms** — much the bigger case, and **since 2026-08-20
  it is fixed at the tier instead of covered up by the x-ray**. Measured on a live frame at floor 0's
  `r4_forge`/`r5_extraction` boundary (vertical luma scan down world x=350, fix stashed and
  unstashed at identical framing): stone used to start at world y **440** — `544 − 104`, the
  perimeter art top — and now starts at **492**, `512 − 22`, the kerb's. 50 px of the room above
  goes back to being floor. `wallTier` classified a wall by
  the one room its centre falls in, so the lower room's north wall stood at 104 px one grid row
  south of the upper room's floor, its art covering a measured 72 px of it; a player standing
  there was **completely invisible** before the x-ray existed, and the x-ray then had to dissolve
  a room boundary on every one of the five floors to keep them visible. Both halves of a shared
  boundary are kerbs now (see "Every wall stands, at one of three heights" above), which removed
  a third of the blind floor on level 1 and two thirds of the deep-fade cases. What the x-ray was
  doing here was real work on a wall that should never have been that tall.

What does still hold — and is what stops a boundary fading while you walk along it — is the
geometry: a perimeter run can only ever fire from **north of its own footprint**, never from the
room floor it borders. Every remaining case measures at most one wall thickness wide (32 or 64 px)
— a north-south run or a door-carved fragment of one; the room-width east-west runs that used to
appear here were the stacked boundaries, and they are gone.

**Measured, before → after** (`renderer.extract`, luma 0-255, the body's own rect derived from the
player view's global position): the character behind the block **78.4 → 105.7**, against **125.8**
standing on open floor — so the x-ray recovers 84% of the body's own value, where before it
recovered none of it (78.4 vs the 77.1 of the stone next to it). The block's face measures 33.8
either way and the floor 39.8 either way: nothing outside the cap moved.

**And measured over the whole of level 1, which is what sized the fix.**
`client/src/game/scene/occlusionCoverage.test.ts` sweeps every position the player can legally
stand at on all five shipped floors — 97,803 samples at 8 px — scoring each against an independent
oracle (rectangle overlap between a block's drawn art and the drawn body, never calling the rule
under test):

The right-hand column is the level as it ships today; the middle column is the same sweep before
the 2026-08-20 kerb fix, i.e. how much of this the x-ray was carrying alone.

| | with the tier bug | as shipped |
|---|---|---|
| at least half the character hidden, before the x-ray | 8.5% | **5.4%** |
| character **completely** invisible, before the x-ray | 5.5% | **3.3%** |
| still more than half hidden, after | **none** (worst case 43.8%) | **none** (worst case 43.8%) |
| needs the deep pass | 1.2% | **0.2%** |
| samples where a *perimeter* run fires | 4,626 | **1,574** |

Two things came out of that sweep that no hand-written fixture was going to produce: the
perimeter-run cases above, and the fact that a cap-only fade left **88 samples 100% hidden** and
another 40 at 75% — which is what the deep pass exists for. (That second number was 561 before the
kerb fix; the 88 did not move, so the deep pass is sized by geometry the tier fix does not reach —
it came down from 148 with the door-alignment fix of the same day, which removed the four 16 px-deep
wall runs that were its worst case.)
It also caught a bad fixture in `RoomBuilder.test.ts`, whose "player standing behind the block"
position was actually inside the stone.

### The deep pass stops where the body does (2026-08-27)

The five places the arena's own sweeps had named as "point a camera here" were looked at on
2026-08-27 and came back acceptable, **with one reservation**: the deep pass "reads as a glass block
with hard edges, since a ghosted rectangle is more *pane* than *x-rayed stone*". This is that
reservation closed, and the cause was not the fade value or the edge — it was the EXTENT.

`needsDeepFade` decides *whether* a block's front face has to go translucent. Nothing decided *how
much of it*, so the whole face went. On the shipped arena's deep case — 70 px of art over a 32 px
footprint — a body standing at the closest legal approach occupies the face's **top 22 px**, and the
projection puts the rest of it, 48 px, over the floor BETWEEN the character and the wall. Measured on
a live frame at the worst sample the sweep knows (`catacombs_r4c6`, a 256x32 run): the lower two
thirds of that rectangle going translucent takes away the block's dark base course, its plinth and
its footing on the floor, and lets the room's own floor read through where the stone met it. That is
the whole of "pane": the block loses its mass everywhere except where losing it was the point.

**`occlusion.deepFadeReach(height, footprintDepth)` bounds it, and the bound is geometry.** A focus
is a character standing NORTH of the block — it cannot overlap the footprint, so its ground point is
at most `sortY - footprintDepth`, and a body is drawn UPWARD from its ground point, never below it.
So the lowest face row any body can reach is `height - footprintDepth` px below the cap/face fold,
full stop. `wallRender.addWallFace` draws the face as two pieces on that row: the band above it keeps
`XRAY_DEEP_LABEL` and fades, and the base below it carries `FACE_BASE_LABEL` — in neither x-ray
group, so it holds full strength through both fades, the same standing the silhouette has. For every
deep block on the launch map that keeps **32 of 70 px, 46% of the face**, opaque.

Four properties make the split honest rather than a tuning knob:

- **It cannot bury anything the old fade revealed.** The band is exactly the reachable-body
  envelope, so `f.y <= foldY + reach` for every focus the rule fires for — checked on the five PvE
  floors, not on the rects the rule was derived from. (**Was also checked on all 778 deep-firing
  samples of the arena's 72,686, and no longer is: v47's north brim took the arena's deep-pass rate
  to ZERO**, because every one of those 778 was an interior kit block — 70 px of art over a
  one-cell footprint, precisely `needsDeepFade`'s shape — and the brim moves the player out of the
  band. `arenaWallCoverage.test.ts` now asserts the zero against a brim-disabled control instead;
  the PvE floors still carry this claim on real content, because their deep cases are on PERIMETER
  runs, which are never free-standing and so never brimmed. See "A free-standing block's north face
  reserves an extra body radius" above.) The x-ray's own acceptance numbers (worst case 43.8% still hidden, the head
  always kept) are unchanged, because nothing that was see-through stopped being see-through.
- **The bound is derived at clearance ZERO on purpose.** The player's own wall clearance means the
  sweep never uses the full band the bound allows, and that leftover margin used to be head-room
  for a real gap this doc had to account for: through v47, `foci` included every live enemy, and
  an enemy kept its FEET circle against solids (`enemies.ts`, `solidRadius: bp.footprintRadius`, as
  low as 6 px) — smaller than the player's own clearance the sweep assumes — so a mob legitimately
  stood closer than anything the sweep could place. **v48 narrowed that gap and v50 closed it.**
  v48 gave enemies the player's RULE — stop at your own body radius against a wall or pillar (see
  "A free-standing block's north face reserves an extra body radius" above) — but left them their
  own NUMBER, and four of the eight blueprints draw a body narrower than the player's (critter
  13 px; basic/emberling/frostling/venom 15 px, against 16). So a 31 fp remnant of exactly this
  asymmetry survived v48, and this paragraph overstated the fix for two versions. v50 floors every
  mob's `solidRadius` at `PLAYER_BASE.solidRadius`, so the sweep's assumption is now literally
  true of every actor in the game and the margin is genuinely unused head-room, the same way it
  always was for the player. `engine/smoke.test.ts`'s "no enemy stands where a player could not
  follow" is what keeps it that way — it judges every mob by the PLAYER's circle, which is the
  assumption this bound actually rests on, rather than by the mob's own.
- **It is invisible at rest.** Both pieces are the same swatch at the same `tileScale`, and the base
  carries the band's height as its own `tilePosition` so the courses run straight on across the
  join. A live A/B that split all 227 splittable blocks in frame moved pixels **only inside the one
  deep-faded block's base rows** (3.49% of the frame, all of it in one 513x91 box) and nothing
  anywhere else.
- **It costs no draw call.** The extra `TilingSprite` batches: 45 draws before, 45 after, on the same
  frame.

**The new edge, and the bound it is judged against.** A hard join mid-face is a new horizontal step
where there was none, so it was measured rather than eyeballed: 12.99 luma across the seam row
(35.3 → 48.3, row means over a 120 px-wide strip of the block's own face). The same wall unfaded
already carries **22.73** at its own cap/face fold, and the split's worst per-row step anywhere on
the face is 13.62 — which lands 9 px BELOW the seam, on a stone course inside the now-opaque base.
So the join is 57% of a step this surface shows all the time and is not even the loudest thing on it;
no feather was added, and a stack of graduated sub-pieces (the only way to ramp a multiplicative
group's alpha) was not worth that.

**The SHADING is not split, and that is a measurement not an omission.** `drawBlockShading` is one
Graphics for the whole block, so unlike the face it cannot keep the base's share of itself at full
strength; splitting it would double a per-block Graphics that the draw-call passes budget. On a live
frame the base with its shading faded is indistinguishable from the base with it solid — the base
contact crease is the only pass down there and it is subtle against opaque stone. The cast shadow on
the floor (`layers.shadow`) never faded in the first place, so the block's contact with the ground
was never in question.

**A DOOR is deliberately excluded.** `doorRender.buildDoorBlock` passes no reach, so its face stays
one piece with all of it fading. The derivation above assumes the focus is north of the footprint,
and a door's passage floor is INSIDE its own footprint: a character in the doorway stands on exactly
the rows the derivation excludes. Same reason the recess, the leaf and the glow are all in the deep
group there.

#### What the tests were not asked, and the stale oracle among them

The battery above proves the tests that EXIST are load-bearing; it says nothing about where they
were never aimed. Re-reading the pass for that turned up five places, and the first is the one that
was actively wrong:

- **Both 70k-sample coverage oracles still modelled the old behaviour.** `occlusionCoverage` and
  `arenaWallCoverage` compute what a body has behind stone from rectangle overlap, and their model
  of a deep-faded block read *"which leaves nothing"* opaque. That stopped being true the moment the
  face was split, and it was OPTIMISTIC — it credited the x-ray with visibility the renderer no
  longer delivers. An oracle that agrees with the rule for the wrong reason is worse than no oracle.
- **Fixing it was not enough, and measuring that is the point.** With the reach cut by 24 px the
  corrected oracle correctly reports 25% of the body still buried — and the acceptance assertion it
  feeds, bounded at *half* the body, passes anyway. What the split guarantees is not "less than
  half" but EXACTLY NOTHING, because the band is the reachable-body envelope. So both sweeps now
  assert that per (sample, block) pair: a block taking the deep pass leaves zero rows of the body
  behind stone. That is the rectangle-overlap derivation of the same invariant the rule states, and
  it is what makes a reach cut by ONE px fail.
- **The split sat outside every draw-call budget.** The live 45 → 45 measurement holds *because*
  the extra piece is a batchable sprite; nothing in the suite pinned that. A base drawn as a
  `Graphics` fill instead would look identical, pass every other test, and cost a draw call on 227
  blocks — which is exactly how the 2026-08-24 pass found 50 of 107 draw calls in the first place.
  `wallComposition.test.ts` now sweeps the shipped floors for two properties: every child
  `addWallFace` adds is a sprite in the swatch path, and the no-swatch fallback's pieces (which ARE
  a Graphics each, so the split really does add one there) stay inside the auto-batch line.
- **The base holding full alpha through a real fade was covered by accident.** `RoomBuilder`'s deep
  test asserted it via a filter called `silhouette` that happened to include the base — true today,
  and the kind of coverage that evaporates the next time someone renames a variable. Named
  explicitly now, alongside a new check that the occluder box's fold row and the drawn split agree,
  derived from the box's THIRD number (`foldY - top`, the cap's drawn depth) rather than from
  `foldY` twice: `reach = height - depth`, so the base's height IS the footprint depth.
- **`expect(base.label).toBe(FACE_BASE_LABEL)` was a tautology** — it reads the constant it checks,
  so `FACE_BASE_LABEL = 'xray'` satisfies it while moving the base into the CAP fade. Re-gated as a
  relationship: the value must collide with neither group's marker. Third time this exact shape has
  come up (`EDGE_ALPHA`, `VOID_CROWN_ALPHA`, now this).

**And the hole no fixture in the file could reach.** Feeding the occluder box `wallHeight(run.tier)`
where the block is drawn at `effectiveWallHeight` survived the entire client suite. The reason is
content, not assertions: every fixture in `RoomBuilder.test.ts` is a room *without a door*, and the
two heights are equal everywhere except the 12 shipped shallow runs beside one — so on those
fixtures the mutant is behaviour-identical. Where they differ the consequence is total:
`effectiveWallHeight` returns `min(height, r.h)`, so a door-clipped shallow run stands exactly as
tall as its own footprint is deep, which makes its reach **zero** and its whole face a single
never-fading piece. Drawn at the tier height it would get a band, and the deep pass would dissolve
part of a wall that cannot hide anybody. Closed twice over: a door in the `RoomBuilder` fixture, and
a sweep in `doorSpillCoverage.test.ts` over all 12 real cases which also asserts that the tier height
*would* have produced a band — so the fixture is proved to disagree instead of assumed to.

**Five rounds, 79 mutant runs over 51 distinct mutants, 2 controls intact. 8 survivors, 7 of them
now tests and 1 an equivalent mutant.** The distribution is the lesson: round 1's survivors were all
about the code, and every survivor after it was about **which content the tests run on**.

---
