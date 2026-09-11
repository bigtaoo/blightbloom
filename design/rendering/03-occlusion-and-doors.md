# Occlusion & doors

Keeping the character visible through stone, and the one fixture a player has to read at a glance.

One part of the rendering architecture doc. The index, the fidelity roadmap and the quality
tiers live in [../01-rendering.md](../01-rendering.md).

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

## A door is a wall block whose face is an opening (2026-08-20)

Every standing thing in a room had been through the volume passes — [walls](02-walls.md#standing-walls-2026-08-18),
[pillars](02-walls.md#a-pillar-is-a-sprite-now-2026-08-20), [the character](05-character-and-objects.md#grounding-the-character-2026-08-18)
— and the one fixture the player most needs to read at a glance had not: a door was a
flat `Sprite` on `layers.ground`, stretched to its `passageAabb`.

**The art was never a floor decal.** `door_{locked,open}_raw.png` are front ELEVATIONS: a portrait
stone frame around a hazard-striped slab, and the same frame as an empty arch with a transparent
middle. That is the identical mistake `13` records for the wall swatches before 2026-08-18 ("they
were being laid flat on the wall's own footprint, so the tilted view's promised small front face
existed on pillars and nowhere else"), still live for doors two days later. Measured on a live
full-floor extract of level 1: 221x320 of portrait art squeezed into a 64x128 rect for an
east-west passage — and into a 128x64 **landscape** rect for a north-south one — so the locked
door read as a red rug lying on the floor between two 104 px stone masses and the open one as a
mangled hoop. The two files also carried ~33 px of transparent margin on every side (the leaf
covered 67% of its own width) and, worse, DIFFERENT margins from each other, so the two states
were not even registered against one another. Both are now trimmed to their alpha bbox by the
repo's own `tools/png-pipeline/compress.mjs` — 221x320 → 147x217 and 215x320 → 156x224 — rather
than corrected with a fudge factor in the renderer.

**The geometry needs no orientation branch, which is the good part.** A door's passage rect is a
hole in a wall: its short axis is the wall's own thickness, its long axis the gap. Under
`screen.y = gy - z` the mass ABOVE a doorway therefore lands exactly where a wall block's CAP
lands (the footprint displaced one height north) and the opening lands exactly where that block's
FACE goes. So `scene/doorRender.ts` builds a door as a wall block whose face is an opening, from
the same shell as `wallRender.ts` (`addWallFace`, `addCapLayers`, `drawBlockShading`,
`addBlockEdge`, `drawWallShadow` — all now shared rather than re-implemented), and one
construction covers both orientations:

- **cap** — the wall over the lintel, tiled from the same world-aligned swatch as the runs either
  side, so a room's crown line runs unbroken THROUGH the doorway.
- **face** — the wall's own elevation across the full height, darkened by a recess ramp
  (`RECESS_*`), then the leaf. The first version filled the opening with flat near-black instead
  and that was wrong twice: on a 22 px kerb door it WAS the whole fixture (a black rectangle
  punched in the room), and stone in deep shade reads as a passage where a void reads as a bug.
  Measured after: the open arch's interior sits at luma 19 against a 37 floor and a 75 cap — half
  the floor's value, which is what makes it read as a hole.
- **leaf** — the elevation, fit by WIDTH, bottom-anchored, overflow cropped off the top via a
  source frame (`doorLeafFrame`). Never scaled to fit both axes: an opening is 64x104 on a
  perimeter wall and 128x22 on a kerb, and fitting both would squash the kerb case 8:1. A tall
  door shows the whole leaf under a band of lintel stone; a kerb door shows the leaf's own base —
  frame feet and the bottom hazard stripe — at the same stone scale as everything else in the room.
- **hazard bloom** (locked only, additive) — nine graduated ellipse rings on the floor plus a wash
  over the leaf. Five rings still showed three of their own edges; the pool is worth having, and
  measurably so: A/B'd against the same frame with the layer hidden it moves a 200x90 px region by
  a mean of **+4.0** luma (max +27, 41% of pixels past 3/255) — unlike `LIT_WALLS`, which was
  measured at 0.06% and deleted.

**A door stood exactly as tall as the wall it interrupts** (`wallRuns.doorFlankTier` — the
SHORTEST run abutting the passage along the gap, then `wallHeight`) — the rule that was meant to
keep this fix from re-opening a bug the wall passes had already closed twice, and the rule the
2026-09-03 pass below removed. Its measurement stands and is what condemned it: nearly half the
doors in the shipped game (11 of 24, swept in `doorStandCoverage.test.ts`) are cut into a KERB,
the low boundary between two vertically stacked rooms, and inherited its 22 px. Doors get their
own `wallJoins` pass (against the walls, not folded into the
walls' own pass — every wall tone was measured with doors absent from that list), so a doorway's
cap runs into the flanking caps without either side drawing an "I end here" coping across one
continuous stone top.

**And a door is now an x-ray occluder like everything else that stands** (`occlusion.ts`). It has
to be: the passage floor is entirely inside the fixture's own art, so a character walking through
a doorway is behind it by construction — while a door lived on `layers.ground` it could not
participate at all, which is what forced the separate `bordersDoorNorth` cap clip for the walls
around it (that clip stays: a run south of a door still sorts in front of it). Verified live on
all four doors of level 1's first floor: a focus standing in the doorway takes the fixture to
`XRAY_FADE` 0.34 and it returns to 1 when the focus leaves. The kerb door correctly fades its cap
only — a 22 px opening puts the body above the cap/face fold, where `needsDeepFade` is false.

---

## An open door is lit from beyond (2026-08-30)

The standing-door pass above gave a LOCKED door everything and a passable one nothing. Every cue
the fixture carried was `visible = locked` — the hazard bloom, the red leaf — so "you can walk
through here" was rendered as the *absence* of a signal, and what was left measured as the darkest
thing in view: the arch's interior at luma 19 against a 37 floor, framed by stone the same value as
the wall it is cut into, sitting in the darkest band `roomLight` paints (its falloff darkens toward
a room's edge, and a door is always on one). A black rectangle in a stone frame is what a WALL
looks like. Live report with a screenshot circling one: the fire-door read for the locked state is
good, but *"when it is passable it looks like a black wall — it is hard to tell at once that this
is a door you can walk through."*

**The cue is light, not a second saturated colour.** `13` is "environment desaturated, hazards
saturated": a locked door is allowed to shout because "you cannot leave yet" is urgent, a doorway is
not. A passage leads to a lit room, so light comes OUT of it — one physical claim, three pieces in
`doorRender.ts`, all additive and all `visible = !locked`:

- **through** — the passage's own floor, ramped up from the threshold over the bottom 60% of the
  opening. Drawn BEHIND the leaf, which is the part that needed no fudge factor: the arch
  elevation is opaque stone around a transparent middle, so letting it mask this layer confines
  the light to the opening exactly, with no inset constant keyed to where a particular PNG's jambs
  sit. It is the inverse of `drawRecess`'s ramp and drawn over it — the recess makes the opening a
  hole, this puts a lit floor at the bottom of it.
- **spill** — a pool on the room floor in front of the doorway (south of the threshold for a
  door in an east-west wall; beside the passage for one in a north-south wall — see
  [The floor a door lights is not always south of it (2026-09-03d)](#the-floor-a-door-lights-is-not-always-south-of-it-2026-09-03d-client-only-no-engine-bump)): `GLOW_POOL`'s nine
  graduated rings
  verbatim, in warm white. Deliberately the same SHAPE as the hazard pool, so "a pool at the door"
  is one symbol the player learns once and colour says which state. It is also what carries a KERB
  door, where a 22 px opening leaves no room for the ramp — 11 of the 24 shipped doors.
- **rim** — warm bands up both jambs, brightest at the threshold. What stops the arch reading as
  flush with the flat wall beside it. Not across the lintel's underside: the top of the opening is
  where the recess is deliberately darkest, and a lit line there would flatten the depth cue.

**Every number was swept on a live frame, and the sweep is the argument.** Reach 0.45 lit only the
sill and the fixture still read as mostly-dark; 0.75 looked like haze in the passage rather than
light on its floor; 0.60 puts the bright end on the floor and lets it die by mid-opening. Alpha then
set the value the floor lands at, all else held: 0.15 → 61, 0.20 → 69, **0.22 → 72**, 0.26 → 78,
against a room floor of 49 beside that door and 66 out in the open and a lit cap crown of 56. 0.26
made the doorway the brightest thing in the frame — brighter than the crown, which this document
calls what the eye reads a back wall by; 0.22 clears the near floor by +23 and sits just above the
open floor. That is the read wanted: the brightest thing in the DOORWAY, not in the room. The top of
the opening measures 19.6 in both states, untouched. On the shipped constants, a perimeter door's
opening goes **12.1 → 62.5** at its threshold with the layers hidden and shown.

**Alpha is not the comparable quantity between the two states, and assuming it was is how the first
version came out shouting.** `GLOW_COLOR` is a saturated red at luma 98 and the warm white is 221,
so ring for ring the open pool lands 2.3x harder at the same alpha. A/B'd over the same 200x90
region the hazard pool was measured on, on the same KERB fixture: at 0.024 the open lights moved it
by a mean of **+22.5** luma against the hazard bloom's **+14.8** — the state that is not allowed to
shout was shouting 1.5x louder, and the floor around it went visibly tan. At **0.018** it lands at
+14.4, the same magnitude as the hazard, carried by warmth instead of red, with the floor keeping
its own colour. On a perimeter door the same pair reads +6.1 (open) against +5.0 (hazard).

The rim is the weakest of the three by some distance and is documented as such: at alpha 0.2 it is
not visible on a live frame at 6x, at 0.6 it stops being a lit edge and becomes a bright bar with
its own hard side running down the flanking wall. 0.34 separates the arch from the wall and does
not draw a line.

**What the tests pin is the state machine, not the colours.** The defect here was an ABSENCE — no
per-layer assertion could have caught "the open state has no layers of its own" — so
`doorRender.test.ts` asserts that the open state carries its own lights, that the two states are
mutually exclusive in BOTH directions, that the swap costs no rebuild, that both open layers join
the deep x-ray group, and the one ordering claim the approach rests on: the through-light is behind
the leaf and the spill in front of it. Eight mutants, including a reversed ramp, a swapped draw
order, a height-gated spill that would have silently dropped every kerb door's only cue, and a
`setLocked` that never flips back — all killed. Two assertions elsewhere had to change and were
wrong in the same way: `wallCapLit` counted "exactly one additive child" and `RoomBuilder.test`
called `find(blendMode === 'add')` "the hazard bloom", both of which would have gone on passing
while testing the wrong layer.

### The recess itself is still shared stone, and then it is a whole illustrated curtain (2026-08-30b)

Two more passes the same day, both against the same live complaint: *"可以通过时的门，好了一些，但离我
想要的效果还差很远"* (better, but still far from wanted) followed, once the first fix had shipped, by
*"依然不行...被阻挡时的火焰很明显，但是可以通过的效果太弱了"* (still no good — the locked flame reads
clearly, the passable one doesn't come close).

**Pass one: the recess itself.** Everything above added LIGHT on top of the recess, but the recess's
own base — `drawRecess`'s bands — was still the same near-black used for BOTH states, darkening the
same wall-stone elevation `addWallFace` draws underneath it. An open door and a locked one differed
only in how much warmth was added over an otherwise identical dark tunnel. Fix: the open state now
draws the room's own FLOOR swatch (`DoorSkin.floor`, tiled) across the opening instead of more wall
stone, darkened by the same ramp shape at a far lighter pair of alphas (`OPEN_RECESS_ALPHA_TOP/FLOOR`
0.42/0.04, against the locked pair's 0.72/0.34) — a real floor texture is visible in the passage
rather than a flat tone. No swatch loaded falls back to a flat tone between the room floor and
`RECESS_COLOR`, same optional-swatch contract as everywhere else on `DoorSkin`.

**Pass two: the recess needed to be a whole illustrated thing, not a gradient.** The floor-tile pass
was a real improvement and still wasn't enough — the reason, once named, is structural rather than
tonal: the LOCKED leaf (`door_locked_raw.png`) is a whole hand-illustrated hazard panel, so nothing
built out of alpha ramps over a floor tile was ever going to match its visual weight. The open state
needed an illustrated asset of its own. `door_curtain_raw.png` — a vertical curtain of warm-gold
energy, generated as a VFX overlay rather than a masked prop (its alpha is a genuine soft graduated
glow, which `alpha-audit.mjs` correctly flags as HAZE for a normal prop and just as correctly does
NOT apply to an additive light asset) — sits in the same additive slot `through` occupied and
REPLACES it once loaded, sized by the exact same `doorLeafFrame` fit-by-width/crop-from-top rule the
leaf uses (pulled out into `doorLeaf.fitArtToOpening` so both share one implementation): a kerb door
crops to the curtain's own BOTTOM, which is its brightest, densest band, not an arbitrary slice. No
curtain art loaded falls back to the procedural `through` ramp untouched — same optional-swatch
contract as `leaf`/`floor`.

**A same-day bug this pass is worth naming: a correctly-sized, correctly-visible, correctly-additive
sprite that was still invisible in play.** `fitArtToOpening` sets texture/width/height only, the way
`applyLeaf` always had it — but the leaf sprite is explicitly `position.set(0, -leafDrawH)` BEFORE
that call runs, and the curtain wiring copied the sizing call without copying the position line. The
sprite defaulted to `(0, 0)` and drew from the threshold DOWNWARD into the room floor instead of
upward into the opening — present in the display tree, `visible: true`, additive, the right pixel
dimensions, and completely absent from the rendered frame. No existing assertion could have caught
it: every test here checks size and visibility, none checks *where* a sprite stands. Found by
dumping the live fixture's children on a real frame rather than by the suite, and now pinned two
ways: `doorRender.test.ts` ("stands the curtain on the threshold reaching UP into the opening") on
the one hand-built opening, and `doorCurtainCoverage.test.ts` — sibling of
`doorStandCoverage`/`doorSpillCoverage`/`doorLightCoverage` — sweeping the same position claim
across all 24 shipped doors, since a hand-built opening is a shape *this session chose* and this
repo has shipped a shape-dependent variant of that exact class of bug before. A second, unrelated
gap closed the same pass: nothing proved `RoomBuilder` actually wires `getFloorTexture()`/
`getDoorCurtainTexture()` into the door skin at all — confirmed real by deleting both from the call
site first (the full suite stayed green), then closed in `RoomBuilder.test.ts`.

## Every door is the same door, whatever wall it is cut into (2026-09-03)

Live report, with a screenshot of the shipped `ember_l1_forge → ember_l1_extraction` doorway on
floor 1: *"有些门会被墙盖住，我看看，我希望门的表现是单独的，统一的，不管墙有多厚"* — some doors get
covered by the wall; a door's presentation should be its own and uniform no matter how thick the
wall is.

**The measurement first, because the report and the cause are not the same thing.** "Covered by
the wall" reads as an occluder bug, and the two clips that exist for exactly that
(`bordersDoorNorth` / `effectiveWallHeight`, above) were both working. Sweeping the 24 shipped
doors through the real pipeline instead gave two presentations with almost nothing in common:

| passage | count | drawn opening | its OWN cap stone above it |
|---|---|---|---|
| `64x128` — through a room boundary, travel east-west | 13 | 64 x **104** | 128 px |
| `128x64` — through the low boundary between two stacked rooms, travel north-south | 11 | 128 x **22** | 64 px |

The wall covering the second row's doors was *their own lintel*. `doorFlankTier` handed a door the
shortest run abutting its passage, that boundary is a KERB on both sides, and 22 px of opening
under 64 px of cap is a fixture that is three-quarters stone. The leaf elevation, fit by width and
cropped from the top, was showing its bottom **12%** — 25 of `door_locked_raw.png`'s 217 rows at
the scale a 128 px opening puts it at, and 27 of `door_open_raw.png`'s 224. (Both numbers are
measured off the SHIPPED PNGs' real IHDR, 147x217 and 156x224. `doorRender.ts`'s header still said
"221x320-ish", which is what the art measured before the same 2026-08-20 pass re-trimmed its
transparent margins — a stale number that made this crop look twice as generous as it was, now
corrected there too and pinned in `doorStandCoverage.test.ts` against the real files.) The same
fit at `DOOR_H` shows **55%**. Rendered A/B at identical framing
(`renderer.extract` on the live floor, player parked north of that doorway) the before frame has
no door in it that a player would read as a door — a dark red hairline along a stone lip.

**So a door stops being a course of wall and becomes a fixture with a fixture's constant**:
`wallGeometry.DOOR_H`, one height for every door in the game. It is `WALL_H_PERIMETER` rather than
a fourth independent number, which also keeps `MAX_WALL_HEIGHT` — what `GameLoop.cameraFrame` pads
the framed room rect by — correct by construction. `doorFlankTier` and its `abutsAlongGap` helper
were deleted with the rule (the flank measurement came back one section later, as
`doorFlankHeight` — it decides whether a door has a CAP, never how tall it stands); `RoomBuilder` hands a door to the joins pass as `'perimeter'`
purely because that pass reasons in tiers, and `doorStandCoverage.test.ts` pins
`wallHeight(DOOR_TIER) === DOOR_H` so the two cannot drift.

**What this deliberately spends, and why it is affordable.** `WALL_H_KERB` is 22 because a room's
floor lies immediately north of that boundary and anything tall there stands between the camera
and the player. A door standing 104 there covers ~82 px more of that floor, and a player walking
south into the doorway is behind it. Three things pay for it: a door has been a `fadeableBlock`
x-ray occluder, cap layers and deep layers both, since the day it started standing (see the
section above — "the passage floor is entirely inside the fixture's own art" was already the
reason); it is a 128 px-wide fixture the player is deliberately walking INTO, not a run they walk
along; and it is the same deal the other 13 doors have always run at. Checked on the live frame at
the closest legal approach (the player's ground point stays `PLAYER_BASE.solidRadius` north of the
kerb): the cap fades and the body reads through it. **The kerb itself is untouched** — `DOOR_H` is
a door constant and no wall run reads it, which `RoomBuilder.test.ts` asserts as the control
beside the height itself (without it, "every door stands at `DOOR_H`" is equally satisfied by
deleting the kerb tier).

**What did NOT change, deliberately: the drawn WIDTH.** A door's opening still takes the passage's
own screen footprint — 64 px for an east-west door (the wall's thickness), 128 for a north-south
one (the gap). A single fixed aperture would look more uniform still, but on a 128-wide gap it
would paint stone over floor the player can walk on, which is the same class of defect as a
passage buried under wall art. Uniform height and uniform treatment; honest width.

The sweeps that keyed off the tier now key off the passage SHAPE, which is what still varies and
is what every fit-by-width layer here actually cares about (`doorStandCoverage`,
`doorLightCoverage`, `doorCurtainCoverage`). One of them turned into a direct measurement of what
the change bought: the smallest through-light band on any shipped opening is now taller than a
kerb door's entire fixture used to be. The arena block's standing "`doorFlankTier` would answer
for all 74 passages at all three tiers" test went with the rule it was measuring.

### What the mutation battery said, and the five value survivors it found (2026-09-03)

Asked for directly (*"有测试可以加吗"*), and the battery is the answer rather than a guess at what
to add. **34 mutants** over the whole door path — `DOOR_H`/`DOOR_TIER`, every line of
`RoomBuilder.buildDoors`, `doorRender`'s layer constants, `doorLeaf`'s fit rule, and the
door-adjacent wall clips — with the scene suite as oracle, baseline green, revert in `finally`.
**26 killed, 5 survived, 3 skipped** on anchors that matched twice.

Every survivor was real, and four of them were the same shape — the one `drawDoorWear`'s
`WEAR_ALPHA` taught this repo in 2026-08-26, where a layer's GEOMETRY is covered and its VALUE by
nothing at all:

- `OPEN_RECESS_ALPHA_TOP` set to the LOCKED 0.72 — the open tunnel stops reading as floor and the
  two states differ only in the light added on top, which is the defect the 2026-08-30 pass was
  called in to fix. Every "the open recess is present, ramps, and only shows when open" assertion
  stayed green.
- `SILL_ALPHA`, `GLOW_WASH_ALPHA`, `RIM_ALPHA` each to **0** — the layer is still built, still
  visible, still in the right state, and contributes nothing.
- The fifth: `RoomBuilder` handing the doors the WALLS' joins (`.slice(0, n)`). Invisible because
  no test fixture had a door whose joins actually CLIP its cap — every door's cap sat at the
  unclipped `-height - depth` whatever it was handed.

All five are closed, and each new assertion was itself mutated to prove it has teeth (a linear rim
falloff, a doubled sill, a crop that rounds up to the whole art, and `MIN_COVER_FRACTION` raised
until a doorway stops firing — all killed). The three skipped anchors were re-run uniquely: two
killed, and the third "survived" only because `push(...).valueOf()` still pushes — a harness bug,
killed by 4 tests once the mutant was a real no-op. **38 distinct mutants, 38 killed.**

Two of the new tests are worth naming, because they are assertion CLASSES this suite did not have:

- **How much of the leaf survives the crop**, swept over all 24 shipped doors against the real
  IHDR of `door_locked_raw.png`/`door_open_raw.png`. Every door must show over half its own art.
  At the old height it reports 12% and fails — which makes it the first test in the door suite
  that would have caught the reported bug, rather than one that describes it afterwards. It also
  found the stale "221x320-ish" in `doorRender.ts`'s own header (the art has been 147x217 since
  the margins were trimmed) and this document's first draft of the section above, which had
  repeated it.
- **The x-ray actually fires at a kerb doorway** (`simRenderParity.test.ts`, beside the kerb's own
  exemption): same focus construction, same rule, opposite verdict, over all 11 of them at every
  body height the rig is drawn at — plus the deep pass for a character standing IN the passage,
  and the flanking kerbs still NOT firing as the control. That is the claim `DOOR_H` is written
  on, and until now it was prose.

---

## A door has a clock (2026-09-03b)

Live report, with a screenshot of a doorway: *"我想在门上加点特效，分别表示可以通过和不能通过。目前的形式太死板了"*
— add fx to the doors that say passable / not passable, the current form is too rigid.

**The diagnosis is not that the cue was weak.** Three passes had already added layers to this
fixture: the 2026-08-30 through/spill/rim lighting, the 2026-08-30b floor tile and illustrated
curtain, the 2026-09-03 single door height. Every one of them added a STILL layer — drawn once in
`buildDoorBlock` and thereafter only toggled by `.visible`. **Nothing in this project could animate
a scene fixture at all.** `Scene.interpolate` walks `Scene.views`, which holds actors, bullets and
pickups; a door is added straight to `layers.entities` by `RoomBuilder` and is in no such list.
Measured on a live frame of level 1's locked perimeter door, two extracts 480 ms apart over the
leaf's own bounds: **mean 0.01 luma, 0.2% of pixels moving more than 3/255.** A still image.

The same gap had quietly frozen the **portal**. `Portal.interpolate` — the alpha pulse, two
counter-rotating rings and ten infalling motes, written 2026-08-12 — **had no caller anywhere in
the repo** and had been drawing one static frame ever since. `RoomBuilder.tickFixtures` now drives
both, off the `dt` `GameLoop.updateFx` already has.

### What the clock is spent on: direction, rhythm, reaction

A still image can only speak with COLOUR and SHAPE, and both were already committed — the two
states deliberately share one floor-pool shape and differ by hue. Motion adds three channels, and
`doorFx.ts` assigns them rather than making everything wobble:

- **Direction — the whole read.** A LOCKED door's motion is CONTAINED: flame scrolls upward inside
  the leaf, a scan bar ping-pongs between the jambs, its floor ring travels INWARD. Nothing crosses
  the threshold. An OPEN door's motion CROSSES it: light streams down and out of the passage, motes
  drift onto the floor toward the player, its floor ring travels OUTWARD. "Can I walk through this"
  is answered by which way things move, before colour is read. This matters more than it sounds:
  the shipped locked leaf is a red hazard panel and the shipped open curtain is a gold streaming
  one, and at a glance in a lava biome those are two warm rectangles.
- **Rhythm.** Locked is fast and restless — 1.7 s and 2.75 s beating against each other at a ratio
  that lands on no simple fraction, so the pair has no visible loop. Open is one slow 2.4 s breath
  that the curtain, the spill pool and the ramp all share, so they read as one lit passage rather
  than three stacked decals.
- **Reaction**, which a still door could not have at all: `near` brightens a door as the player
  approaches, and a locked door FLASHES when they walk into it.

### No new art, and why that was the cheaper answer

The obvious way to animate fire is a frame sequence; the obvious way to get one is to ask an image
model for N frames, and this project has already found that does not work (`12`: GPT Image 2 emits
one flattened raster — the reason the portal is *"a split, not a sprite… the file is the half of
the object that never moves"*). So the motion is **generated, not prompted**: two seamless fields
baked by `shadeRamp.bakedField` (zero bytes against `04`'s package budget, POT, mipmappable,
readable back by a test) scrolled under the shipped stills, which keep supplying the material.

Two properties of those bakes are load-bearing and invisible when wrong, so both are asserted:

- **Seamless in y.** Every vertical term is a sine of an INTEGER number of cycles over the tile, so
  the last row meets the first. The first version was not: it carried a `0.35 + 0.65 * (1 - y/h)`
  "fire is densest low" bias, which is not periodic, and scrolled a hard seam up the fire once per
  1.7 s. `doorMotion.test.ts` caught it. The bias is a SCREEN-space property anyway — baked in, it
  would travel with the scroll — so it moved to stacking the second flame layer over the band's
  lower 62%, which pins it at the base of the doorway.
- **Faded at both x edges**, so the band's own sides are not two hard vertical lines. Over `w - 1`,
  not `w`: with `x / w` the last column lands at `sin(0.984π) = 0.05`, a 12/255 hairline down the
  right side and nothing down the left.

The one animated layer that cannot let the art mask it is the flame overlay — the hazard leaf is
opaque, so an overlay behind it would be invisible. It is therefore confined to a **measured** band
(`FLAME_BAND`, x 0.197–0.803, y 0.184–0.816 of `door_locked_raw.png`), re-derived from the shipped
PNG's own pixels by `doorArtBands.test.ts` every run — saturation × value, the fire against a
desaturated stone frame, a plateau stable to ±0.01 across thresholds 0.3–0.4. Same contract
`environmentArt.test.ts` puts on the portal arch. The open state's streams need no such number: they sit
BEHIND the leaf and get the arch's stone as a mask for free, exactly as `drawThroughLight` does.

### The unlock is an event now

A lock flip used to set six layers' `.visible` in one frame — at the single most meaningful moment
in a room, which is the worst possible place for a cut. It now crossfades over 350 ms (the outgoing
side squared so it clears early and the eye lands on the arriving state), with a second leaf sprite
holding the outgoing elevation, and throws off one ring: outward and warm on unlock, inward and red
when a fight seals a room.

### The refusal is client-derived, and never reaches the sim

Walking into a locked door flashes it and adds 0.05 of camera trauma. A `door_blocked` event would
be the cleaner signal and costs an `ENGINE_VERSION` bump plus a golden-hash re-run for something
that changes no simulation state, so `doorTick.isRefused` reads what the client already has. Three
conditions, each independently necessary: the door is locked; the player is within 20 px of the
passage AND their input points into it; and they are **not actually moving**. That third one is
what tells "walked into it and stopped" from "walking past it" — the sim has already resolved the
collision, so a blocked player's `cur` simply stops leaving `prev`. Debounced at 450 ms, so holding
a direction reads as shoving rather than as a strobe. Deliberately NOT paired with `addHitStop`:
freezing the sim over a navigation mistake punishes one.

### What it cost, and what it bought

`RoomBuilder.tickFixtures` steps only the doors whose footprint meets the visible world rect, grown
by 96 px for the one-frame-stale camera (the fx pass runs before `updateCamera`, which needs this
frame's interpolation alpha). Verified live on level 1: with one door on screen and four built,
**60 ticks in 60 frames for the visible one and 0 for the other three**. The whole pass measures
**below the noise floor** of a 120-frame timing on this machine (0.111 ms/frame with it on against
0.144 with it suppressed — i.e. not distinguishable from run-to-run variance).

A/B on a live frame, two extracts 480 ms apart over the leaf's own bounds, the pass suppressed and
then restored:

| | mean luma delta | pixels moving > 3/255 |
|---|---|---|
| locked, before | 0.01 | 0.2% |
| locked, after | 4.11 | 30.3% |
| open, before | 0.56 (the player's own rig crossing the doorway) | 1.2% |
| open, after | 5.30 | 45.0% |

Confinement, measured the same way: inside the fire band the locked door moves by a mean of 7.30
with a max of 64/255; on the stone jamb 6 px to its left, a max of **4/255** — that is the glow's
own ambient breath over the whole leaf, not the overlay leaking. Brightness is essentially
unchanged in both states (open 104.6 → 101.8, locked 71.7 → 73.8), which is the intent: the
2026-08-30 sweep above had already settled what value a doorway is allowed to sit at, and this pass
adds motion, not light.

One defect the frame caught that no test would have: both floor rings were full ellipses centred on
the threshold, so their northern halves drew straight up the door's own stone — a 2 px stroke at
0.3 alpha crossing the hazard leaf and the flanking wall, which read as a stray red line through
the masonry. They are half ellipses now, opening south onto the floor only. `GLOW_POOL` gets away
with a full ellipse because it is nine fills at 0.035; a stroke has nowhere to hide.

### The Nyquist gate `01` asked for, five weeks late

`01`'s "Ambient animation rates" has tabulated every idle loop's rate since `Pickup`'s hover shipped
at 19 Hz and reached a player as *"地上的东西闪得太快了"* — and nothing enforced the band. Every period
in `doorFx`/`doorMotion` now lives in one exported `PERIODS_MS` table that the code itself aliases,
and `doorMotion.test.ts` walks it: each loop must advance by well under the Nyquist limit in one
60 fps frame, and must sit inside the 0.2–1.3 Hz band the scene's existing loops occupy. A new loop
with a hand-rolled period is not in the table and does not get past review; a period the test checks
cannot be a second, unused copy of the one the code uses.

### Two things that had to be settled to make this safe

- **One writer per `alpha`.** `occlusion.fadeGroup` captures each layer's alpha ONCE and thereafter
  writes `base * fade`; `DoorFx` rewrites those same alphas every frame, and the fx pass runs after
  the x-ray — so `DoorFx` would have won, silently disabling the x-ray on a door's own layers, one
  of which (`buildOpenFloorTile`'s tile) is fully opaque and would then hide the character standing
  in the doorway. That is the exact defect the x-ray exists to prevent. Those layers are therefore
  out of the fade group, represented in it by a single `DoorFx.xrayLayer` proxy whose value the
  controller folds into everything it writes. `doorRender.test.ts` asserts the EFFECT (fade the
  group, tick, the layer dims) rather than membership, since membership would now pass on a proxy
  nobody read.
- **`pingPong` never worked.** `((t % p) + p) / p` only rescues a negative clock; it does not wrap a
  positive one, so it returned 1.5 at half a period and swept the scan bar off to `2 - 3 = -1`.
  Caught by the first run of `doorMotion.test.ts`, before a frame was ever looked at.

### What the tier lever is, and what it deliberately is not

Only ONE thing in this pass costs anything per frame: the motes, which are a `Graphics` rebuilt
every frame. Everything else is transform animation — two floats per scrolling layer — and gating
it would buy nothing measurable. So the lever is the mote COUNT, and it rides the `particleBudget`
the quality profile already carries rather than a new tier field, because that is literally what
that field means and a mote is a particle: the low tier's 0.35 thins five to two. It never reaches
zero. A tier that turned the motes off entirely would take the open state's "things come OUT of
here" away from the device tier alone, and that is a legibility cue rather than decoration.

### What the mutation battery said

**70 mutants over the five files this pass touched, 70 killed** — but not on the first run. 55 rows
over `doorFx`/`doorMotion`/`doorTick`/`doorRender` scored 51, and every one of the four survivors
was a claim this document makes that nothing asserted:

- **the motes ACCELERATE out of the passage** (`eased = v * v * (3 - 2 * v)` → `v`). Monotone,
  spanning 0..1 and spread — every existing assertion held for a linear fall.
- **the crossfade clears the OUTGOING state early** (`(1 - p)²` → `1 - p`). The ghost still faded,
  both groups were still mounted, it still settled: the suite could see that the crossfade ran and
  nothing about its shape.
- **the ghost carries the art we left** (deleting the `applyLeaf` onto it). Alpha and visibility
  were asserted, the TEXTURE was not — so the transition would have crossfaded out an empty sprite,
  i.e. put back the instant cut it exists to remove.
- **the degenerate-opening guard** was the fourth, and it is the different verdict: it is
  runtime-EQUIVALENT for height (the clamps already collapse `h` to 0 for every degenerate input,
  divide-by-zero included). What it actually buys is a FINITE `y`; without it the top clamp
  resolves to Infinity. Pinning the finiteness is what makes the line load-bearing rather than
  decorative — the same "judge the survivor, don't just add a test" call the 2026-09-02 battery
  documented.

A second battery over `doorLights.ts` — the file that only MOVED in this pass, and whose only
evidence was "the old assertions still pass" — scored 12/13. The survivor is worth naming because
it predates this pass: **deleting the EAST jamb's rim band** left every spill assertion green,
because they counted bands rather than sides. A doorway lit down one side only is not subtle in the
room; it was simply invisible to the suite. Both sides are now asserted band-for-band.

**Files:** `scene/doorFx.ts` (the per-door controller), `scene/doorMotion.ts` (the pure math and the
two bakes), `scene/doorTick.ts` (the cull, the proximity ramp, the refusal), `scene/doorLights.ts`
(the still layers, split out of `doorRender.ts` to make room), plus `RoomBuilder.tickFixtures`,
`GameLoop`'s one call, `CommandBuilder.lastMove` and `FxController.worldView`. Five new test files
and additions to five existing ones — 103 new tests; **4,659 client tests green** as of
2026-09-03.
## ...and then only the door, with no wall hanging over it (2026-09-03c)

The report immediately after the section above shipped, with a screenshot of a `128x64` kerb
doorway circled: *"我希望门的位置只有门，不要在入口的两端有墙"* — at the door's position I want only
the door, no wall at the entrance.

Standing all 24 doors at `DOOR_H` fixed the letterbox opening and left a second artifact on
exactly the 11 it fixed. A door's **cap** is the wall over its lintel, and the whole reason it
reads as stone is stated in this document's own list above: *"tiled from the same world-aligned
swatch as the runs either side, so a room's crown line runs unbroken THROUGH the doorway."* That
sentence quietly assumes the runs either side reach the cap. Through a 22 px kerb they do not — the
doorway now out-tops them by 82 px — so the cap came out as a full footprint depth of tiled wall
swatch (64 px on those passages) sitting 82 px above the crown line on both sides, with nothing
under it: a slab of wall hanging in mid-air over the opening. Measured on the shipped floors,
every one of the 11 had one; the 13 perimeter doorways never did, because their flanks really are
`WALL_H_PERIMETER` and their cap really is the continuation it claims to be.

**So the cap became conditional on the thing it was always claiming**: `wallRuns.doorFlankHeight`
measures the SHORTEST run abutting the passage (the old `doorFlankTier`'s predicate, restored for
a different question — a cap resting on one flank's crown while floating over the other is still a
floating slab), and `RoomBuilder.buildDoors` folds `capless` into the door's own joins wherever
that flank falls short of `DOOR_H`. `WallJoins.capless` is a caller-set flag exactly like
`doorClip`, and it is read in exactly one place — `blockCapTop`, which is where every cap-shaped
cue already derives its extent from. One flag therefore drops `addCapLayers`, the cap depth
gradient, the cap edge bevel and the coping together, instead of four call sites agreeing by hand;
the fixture's topmost row becomes the top of its own arch, which is what an archway standing in a
low wall looks like. The x-ray occluder follows for free (its `top` is that same `blockCapTop`), so
it stops reserving a band of floor for stone that is no longer drawn.

**The height is untouched, and so is every perimeter doorway.** This is not a partial revert of
`DOOR_H` — all 24 doors still stand at one height, and the 13 through a room boundary draw the same
cap they always have. What varies is whether there is stone above the lintel at all, which is a
property of the WALL, not of the door. `doorStandCoverage.test.ts` sweeps the shipped content for
the 11/13 split through `RoomBuilder.buildDoors`' own sequence; `RoomBuilder.test.ts` asserts it on
a really-built fixture at both flank heights (empty `capLayers` in a kerb, non-empty beside a
perimeter run) because `capLayers` is precisely the group `addCapLayers` fills, so an empty one is
the absence of the slab rather than a proxy for it.

## The floor a door lights is not always south of it (2026-09-03d)

Live report, with a locked doorway's floor circled: *"门的这个特效下面的光圈被挡住了，是故意的，还是
层级算错了？"* — the light ring under the door's effect is covered up; deliberate, or is the layering
wrong? **Neither.** The fixture's paint order was right and the stone in front of the ring was
sorting correctly; what was wrong was a piece of geometry this document states as fact in the
[open-door lighting](#an-open-door-is-lit-from-beyond-2026-08-30) list above — *"a pool on the room
floor south of the threshold"* — which is true for 11 of the 24 shipped doors.

Every floor-level layer a door draws is built from that assumption: both states' `GLOW_POOL` fills,
`doorFx.drawPulse`'s travelling ring, `drawBurst`'s one-shot. `strokeFloorArc` even argues for
drawing the southern half only, because a full ellipse *"put their northern halves straight up the
door's own stone."* Correct, and exactly half the picture — the other half is which side of the
fixture the floor is on.

A passage AABB's short axis is the wall's thickness, so the shipped content is two shapes:

- **`128x64`, 11 doors** — a hole in an east-west wall, crossed north-south. South of the threshold
  is room floor, the pool belongs there, and every swept constant in `doorLights.ts` was measured
  on one of these.
- **`64x128`, 13 doors** — a hole in a north-south wall, crossed east-west. South of the fixture's
  base line is **the same wall continuing**: `bordersDoorNorth`'s own relationship, runs 32-320 px
  deep covering all 64 px of the fixture's width, and `blockCapTop`'s `doorClip` (above) puts that
  run's cap top *exactly* on the door's threshold. The run Y-sorts after the door — `Entity.zIndex`
  is the ground y, the run's is its own south edge — so it painted straight over the decal.

Measured on the five shipped floors, per sampled ring point: **29-33% of a ring inside a wall run at
`rx = w`, 86-90% at `rx = w/2`**. The visible remainder was the outer lobes poking past the 64 px
wall, which is the pair of arcs the screenshot circled. Note how close this sat to work already
done: [the door-clip sweep](#a-door-is-a-wall-block-whose-face-is-an-opening-2026-08-20) pins that
such a run never spills onto the door's ART — 12 real cases — and nobody asked the mirror question
about the door's own decals reaching 40 px past its footprint into that block's sort band.

**`doorLights.DoorFloorPlane`** answers it with one rule rather than a branch per layer: *a floor
decal lies on the floor the fixture's own stone is not standing on.* `south` (`w > h`) is the
shipped geometry byte for byte. `sides` (`w <= h`) centres beside the arch — on the passage's own
mid-depth until [the ring-fit pass below](#a-doors-ring-belongs-to-the-door-it-lights-2026-09-04)
moved it onto the drawn opening's mid-height — and draws
the ring as two side lobes with the wall's thickness skipped — an interrupted ring, which is what a
ring around a doorway in a wall you see the sides of looks like. The discriminator is the one
`floorRender.drawDoorWear` already uses for the worn patch (travel is along the short axis), so the
two floor-level door decals agree about a door's facing instead of disagreeing silently. A `sides`
ring narrower than the wall's half-thickness draws nothing, so a locked door's inward pulse now
shrinks into the doorway and dies there — `doorFx`'s "locked motion is CONTAINED" reads literally.

A live frame of the reported door (floor 0, `64x128` at `(1504, 288)`), `renderer.extract` A/B'd
against the same frame with the fixture's floor layers hidden, mean luma over 8-10k px:

| region | floor alone | old | fixed |
| --- | --- | --- | --- |
| floor west of the wall, mid-passage | 57.96 | 0.00 | **+10.96** |
| floor east of the wall, mid-passage | 49.25 | 0.00 | **+9.44** |
| the band south of the threshold (that run's cap) | 38.98 | 0.00 | 0.00 |
| floor just south-west of the threshold | 39.92 | +4.85 | 0.00 |

The old pool's entire visible output was that 4.85-luma sliver. `doorFloorPlaneCoverage.test.ts`
sweeps all 24 doors through `RoomBuilder`'s pipeline: no `sides` ring point in stone or over void at
any radius up to `drawBurst`'s widest, the `south` doors' geometry unchanged point for point, and an
inverse run asserting the old plane's 29-90% shares **as failures** so the sweep cannot pass against
the code that shipped the bug. The `south` residual is bounded rather than fixed: a southern
half-ellipse terminates on the wall line it is cut into, so <=19% of a ring sits in the flanking
runs' footprints and <=29% reaches past the room's floor edge at the burst's widest — clipping a
decal that legitimately spans two rooms needs the room rects threaded into the fixture, and the
bound exists so the residual cannot grow unnoticed. Full account:
[`../roadmap/23-2026-09-03-door-floor-plane.md`](../roadmap/23-2026-09-03-door-floor-plane.md).


## A door's ring belongs to the door it lights (2026-09-04)

The pass above made those rings visible on all 24 doors. Seeing them, the report on the same
fixture: *"现状圆圈都显示出来了，只是位置有点偏上了，你能将其放在门的中心吗？而且有的门大，有的小，
最好那个圈能跟随门的大小进行缩放"* — the circles all show now, they just sit a bit high; can they go at
the centre of the door, and scale with it? Two separate defects, both of them the same mistake:
**the decals were derived from the PASSAGE AABB, and the passage is not what the player sees.**

- **Centre.** A `sides` plane centred at `-r.h / 2`, half the passage's 128 px depth up-screen. The
  arch standing on that threshold is `leafHeight` = **94.5 px** tall (`RoomBuilder` builds every
  door at `DOOR_H`; 217 rows of leaf art fitted to a 64 px opening want 94.5 of height), so its own
  middle is 47.24 px up. The ring floated **16.8 px** above it, on all 13 of these doors —
  a sixth of the fixture, and at the reporter's zoom some 60 screen px. `cy` is now
  `-min(drawH, r.h) / 2`: the drawn opening's mid-height, clamped so an arch taller than the hole
  it stands in cannot push its decals out the far side. `south` is untouched — there the drawn
  opening meets its floor AT the threshold, which is where its ring already was.
- **Size.** Every radius was a multiple of `openingW`: `GLOW_POOL[0] = 1.35` put the widest pool
  ring **2.7 door widths across**, the pulse 2.6, the burst 3.3. That is already proportional (a
  64 px arch and a 128 px one get the same multiple), which is the interesting part of the report —
  a ring that far out reads as unrelated to its door, so the eye's explanation is "it must be a
  fixed size". The fix is reach, not proportion: `doorSpan` = `RING_REACH` (0.55) x the drawn
  opening's own size, so the widest pool ring lands at ~1.4-1.5 door widths, the value the reporter
  picked from three offered. The size it scales is the geometric mean of the drawn box clamped to
  the width — a door cropped SHORTER than it is wide (the 11 `128x64` doorways, whose leaf wants
  189 px of height and gets the wall's 104) comes in ~10% under a square one, while a taller-than-
  wide door is sized by the opening the light comes out of rather than by the wall above it.

One consequence had to be handled rather than accepted. A `sides` ring draws nothing while it is
narrower than the wall's half-thickness (32 px), and at the tightened reach a 64 px arch's whole
`0.35..1.3` pulse sweep finishes inside those 32 px — the pulse this document's previous section
made visible would have gone straight back out. `doorLights.ringTravel` starts a TRAVELLING ring at
the wall's face where the plane has one: 20 of 21 sampled steps now draw, against 8 for the raw
multiple, with the reach unchanged. It moves the start of the journey, not its end, and keeps what
the clamp was for — a ring that emerges from the doorway instead of appearing over it.

Read off the live scene graph of the reported door (floor 0, `64x128` at `(1504, 288)`, its leaf
drawn 64x94): the pool's ellipses are centred `(32, -47.2)` with `rx = 47.5`, i.e. **95 px across
against a 64 px door** (was 172.8), and the pulse's two lobes have a mean y of `-47.22` — the
drawn leaf's own middle, which is what "put it at the centre of the door" asked for.
`doorFloorPlaneCoverage.test.ts` re-runs its whole sweep at the new radii (no `sides` point in stone
or over void, the `south` residual inside its old bounds) and adds three cases the pass is for: the
centre, with the superseded `-r.h / 2` asserted as WRONG; the reach in door widths, with the old
2.7 as the inverse; and the travel clamp.

A 25-mutant battery over the three files then found seven survivors, and three of them were one
blind spot: `doorRender.test.ts` matches each light layer by a digest of a Graphics it builds by
calling the same production function, which pins WHICH layer is where and cancels every geometric
property out of the comparison — so the pool's centre, its nine radii and its foreshortening had no
assertion anywhere, in the layer the report was actually looking at. Those numbers are now read
back off the `ellipse` calls. The pulse and the burst restored to their pre-plane `openingW`
radius also survived (the reach was pinned in the plane's arithmetic and nowhere in the fixture
that ships it), as did `ringTravel`'s end guard and `thresholdPlane`'s defaulted height. 25/25
after, with two inert controls still surviving. Full account:
[`../roadmap/24-2026-09-04-door-ring-fit.md`](../roadmap/24-2026-09-04-door-ring-fit.md).


## A door's halo runs the way the door does (2026-09-11)

Third report on the same fixture, and the one the previous two made possible — the rings are
visible, they are at the door's centre, they are the door's size, and now their SHAPE is wrong:
*"这个椭圆的长边要和门的长边保持一致"* (the ellipse's long axis has to run the same way the door's
does), over a screenshot of a passable `64x128` door with its halo circled.

Every floor ring on either plane was squashed by `GLOW_POOL_SQUASH` = 0.46 — the foreshortening
every round thing in this view shares, and the right constant for a circle lying on the ground.
What it does NOT know is which way the fixture over it runs:

- **`128x64`, 11 doors** — drawn opening 128 x 104, wider than tall; widest pool ring 171 x 79.
  The rule already held, and every alpha and luma swept on these doors depends on that number, so
  they are untouched.
- **`64x128`, 13 doors** — drawn arch 64 x **94.5**, half again as tall as it is wide; widest pool
  ring **95 x 44**, lying across it. The one shape the eye is asked to attach to a doorway was
  elongated along that doorway's short edge.

`DoorFloorPlane` now carries an `aspect` — the y semi-axis per unit x semi-axis of every ring on
the plane. `south` keeps the constant; `sides` takes `ringAspect(openingW, drawH)` = the drawn
opening's own height over its width, 1.48 on every shipped door of that shape, for a widest pool
ring of **95 x 140**. Read as a screen-space rule, which is what the rest of this plane already is
(`cy` is the drawn arch's mid-height, not a ground offset): these decals sit beside a north-south
wall, where the floor a door's light reaches is a strip ALONG that wall.

**The x semi-axis is untouched on purpose.** A `sides` ring narrower than the wall's own
half-thickness draws literally nothing, so every px of aspect is spent on height and the reach onto
the flanking floor — plus `ringTravel`'s clamp, measured against it — is exactly what the ring-fit
pass left. What it costs is that one of the two plane kinds is no longer foreshortened at all: a
`sides` ring is not a circle on the ground seen at this tilt, it is a slot of light lying along the
wall, and its ends run a little past the gap the door is cut into (70 px from a centre 47 px north
of the threshold, against the passage's own 64).

**How tall it may be is a content question, and it was measured.** A taller ring spends its extra
height running along the wall, where the hazard is the PERPENDICULAR run at the end of that wall.
Swept over the five shipped floors at the widest radius anything strokes (`1.65 x span`):

| aspect | `sides` doors stroking into stone |
| --- | --- |
| 1.48 — the drawn door's own | none |
| 1.60 | none |
| 1.65 | 3 of 13, 2.4-4.8% of their points |

So the literal reading of the report is also inside what the content allows, with ~8% to spare, and
`doorFloorPlaneCoverage.test.ts` now asserts the bound from both sides.

**The mutation battery found the gap in the layer the report was pointing at.** The two arcs a
player sees flanking a doorway are `doorFx`'s pulse and burst, not the pool — and handing
`drawPulse` a plane with the old squash left **all 1383 scene tests green**. The 2026-09-04 pass
pinned how far those rings travel; nobody had asked how tall they are. `doorFx.test.ts` now reads
the y-reach back off the stroked geometry and holds it to an equality — a ring's own `rx` is the
widest `|x - cx|` it draws, and its y-reach is then `ry * sin(acos(cx / rx))` on a `sides` plane
and `ry` itself on a `south` one — for every Graphics that strokes a ring rather than the widest,
with a `south` fixture as the control so "stretch every ring" fails too. 13 mutants, 0 survivors,
including the aspect read off the passage AABB (2, not 1.48) and a constant 1.9 that would look
right on this door and wrong on the next size.

`doorLights.ts` reached 534 lines with the rule documented, so the whole floor-plane block —
`DoorFloorPlane`, `doorSpan`, `ringAspect`, `ringTravel`, `strokeFloorArc`, `floorArcSpans`,
`fillFloorPool` and the two ring constants — moved to **`doorFloorPlane.ts`** (CLAUDE.md form 1),
with `doorLights.ts` re-exporting every name so no caller or test changed. Full account:
[`../roadmap/55-2026-09-11-door-ellipse-aspect.md`](../roadmap/55-2026-09-11-door-ellipse-aspect.md).
