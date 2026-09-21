# The floor, the arena, the void

The ground plane, what it costs on a real GPU, and what is drawn beyond where the stone ends.

One part of the rendering architecture doc. The index, the fidelity roadmap and the quality
tiers live in [../01-rendering.md](../01-rendering.md).

## The floor stops at its rooms (2026-08-20)

The floor was one `TilingSprite` of a 256 px swatch over the world, and measured on a live
full-floor extract of level 1 that had two separate defects in it.

**One: 29-56% of it was painted where no room exists.** `worldW/worldH` are the bounding box of a
floor's co-resident rooms, and a `graph2d` layout's rooms do not fill their own bounding box —
across the five shipped floors the box is 1.41-2.26x the rooms' area (`floorCoverage.test.ts`). On
floor 0 that surplus is a single featureless 1500x430 field with no walls, no room light and no
decals in it, which the eye reads as one enormous room the level happens to have wall-lines drawn
across. Everything outside a room now belongs to the backdrop, and the frame reads as five rooms
connected by doors instead.

That is only safe because a PvE floor's rooms *are* its walkable space, which is asserted rather
than assumed: `floorCoverage.test.ts` flood-fills each shipped floor's grid from every room centre
through non-wall cells and requires every reachable cell to be inside a room rect (0 outside, all
five floors). "Not inside a wall" would have been the wrong test — a floor's bounding box contains
large enclosed regions that no room occupies and nothing walls off; they are simply unreachable.
**A PvP arena used to be the opposite case, and that stopped being true when the map changed.**
The same sweep over `arena_prototype_60` found 5240 of its 11,524 non-wall cells (45%) reachable
and outside every room rect *and* every door passage — that map had `solids: []` everywhere, so it
had no walls to stop anyone — and a per-room floor there would have left a player walking over the
backdrop. `groundLayer.floorRegionsPx` was a branch on map KIND because of it. `arena_launch`
(2026-08-25) walls every room, so 2026-08-26 that branch became a MEASUREMENT
(`scene/floorPartition.roomsCoverReachableSpace`, one rasterize + one BFS at room-build time):
`arena_launch` reports 0 cells outside and its floor now stops at its 60 rooms — 322 stamp sprites
covering 9,246,720 px of a 11,770,880 px world box, the 2465 cells of deliberately-empty slots and
outer margin no longer painted — while `landing_basic`, three wall-less rooms in open world, still
gets the whole-world floor. Every room keeps its own wash/mottle/light either way.

**Two: the floor had no variation at all.** Three 256x256 patches of open floor, 512 px apart, in
three DIFFERENT rooms, came back with identical statistics (mean 38.6, sd 4.6, min 21, max 105) and
97% of their bytes equal — the 3% that differed was `roomLight.ts`'s corner falloff, not the floor.
An exact 8-grid-cell period, the same in every room, on every floor, from a swatch whose own
contrast is sd 5.2. `floorRender.ts` adds four layers, and the order they are listed in is the order
of how much they actually did:

| layer | what it does | measured |
|---|---|---|
| per-room floor (above) | the floor stops at the rooms | 29-56% of the old floor was surplus |
| per-room wash | one warm-or-cool multiply per room, hashed from its world position | room floor means now span **40.6-54.2** luma; they were identical |
| mottle | dark and additive blobs at 1.4-3.6 tiles across, deliberately incommensurate with the tile grid | 64 px patch-mean sd **2.69 → 4.23**, spread 10.7 → 14.9 (A/B on one frame) |
| stamp | one Sprite per tile, mirrored from a hash of its grid position | two rooms' patches went from 97% byte-identical to 57% of bytes differing |
| wear | stains, rubble specks lit from the same upper-left key light, and a worn patch across each doorway along its travel axis | — |

Three things this pass got wrong first, all of them found by looking at a 2x crop rather than by
reasoning:

- **A per-tile tint paints the tile grid.** The stamp originally dimmed each tile by a hashed
  0.93..1.0, and a 7% step between two adjacent 256 px squares is a *flat rectangle*: the floor came
  out as a visible checkerboard of slightly different greys, i.e. more legible as a grid than the
  repeated cobble ever was. Removed. Value variation belongs at a scale unrelated to the tiles.
- **Mirrors only, never rotations.** A seamless tile stays seamless mirrored (its left edge equals
  its right edge, so a mirrored copy still matches its neighbour) and does not rotated, where the
  other axis's edges arrive at the seam. `tileVariant` therefore offers flips and nothing else, and
  a test says so, because "add a rotation for more variety" is the obvious next idea.
- **A blob at one alpha shows its own rim.** Three mottle bands at a flat alpha drew visible arcs on
  the floor; five with the alpha ramped by band index do not. Same lesson as `CAST_PASSES` and the
  door bloom's nine rings, for the third time in this document.

Everything here is hashed, never `Math.random` — a room must draw the identical floor on every visit
and on every client (design/06's rule applied to the render layer, as with `Pickup`'s golden-angle
bob phase).

---

## The same sweeps, on the arena (2026-08-26)

Everything above this line about walls, doors and the x-ray was measured on `EMBER_L1_FLOORS` — the
five PvE floors — and so were all five of the content sweeps that guard it (`wallComposition`,
`occlusionCoverage`, `doorStandCoverage`, `doorSpillCoverage`, `doorOcclusionCoverage`). The PvP
arena had no walls at all until `arena_launch` was authored, so there was nothing else to sweep;
now there is, and `client/src/game/scene/arenaWallCoverage.test.ts` runs the same pipeline over it
(492 wall rects -> 294 blocks, 124 pillars, 44 stacked-room boundaries, 74 passages, 72,686
standable samples). Three things above are not true there, and they are here rather than only in
ROADMAP because they are statements about the RULES, not about that map:

- **`bordersDoorNorth` used not to run in an arena at all — fixed the same day.** The clip described
  under "The occlusion x-ray" and "A door is a wall block whose face is an opening" was fed from
  `GameState.dungeonDoors` alone, which is populated in dungeon mode only, so an arena passed an
  empty door list: `doorClip`/`effectiveWallHeight` were dead there and 58 of `arena_launch`'s 74
  passages had wall art over them, 36 covered to their full depth. `RoomBuilder.build` now unions
  `s.arenaMap.doors` into that list. The rule needed no change to work on this content — it matches
  44 runs, 21 of them the shallow case, with no spill in either direction — and the residual is 10
  partly-covered passages, worst 40 px of a 96 px gap, none buried. Door FIXTURES stay dungeon-only:
  a fixture is built per `DoorRuntime`, an arena `Door` is an adjacency record with no lock and no
  leaf, and an arena passage is meant to stay open. So the door-height rule never ran there — and as
  of 2026-09-03 there is no such rule to run: every door stands at `wallGeometry.DOOR_H`.
  The passage list feeds `groundLayer`'s worn-floor patch too, which is the cue that a hole in the
  stone is a threshold — without it the courses ran on unbroken and a buried passage read as a wall
  somebody meant to build. That patch is additive, so its visibility is `luma(WEAR_COLOR) * WEAR_ALPHA`
  per band regardless of the floor under it: the faintest band adds 5.62 and the four-band centre 22.49,
  a little under double the bare neutral floor's own 25.9. Both are pinned in `floorRender.test.ts`
  against perceptual bounds (a visible step at 3, a reads-as-a-lamp ceiling at 45) rather than against
  the constants, because the constants only matter through that product — a 2026-08-26 battery found
  all three value mutants surviving the whole suite while every geometry mutant died.
- **"at most two blocks fade at once" is a claim about WALLS.** It holds for walls on the arena too,
  and pillars break it: an interior kit's 2x2 colonnade cluster fades four at one spot (1 sample of
  72,686). A pillar fades whole rather than cap-only, so four of them is a different look from four
  wall caps, and nothing has judged it yet.
- **`FACE_CROWN_ROWS` is consulted per element, and an arena is `neutral`.** A tuck on the arena
  stops under a crown line 20% of the wall's height instead of fire's 21.3%, so the corner geometry
  the four 2026-08-19 reports converged on had never been evaluated at the fraction the arena
  actually draws with. It holds: 24 tucks, no hole opened, no crown crossed.

One number moved rather than broke: the worst block's shading geometry is **208 floats** on the
arena against level 1's 120, which is over `wallComposition.test.ts`'s own
`< AUTO_BATCH_VERTEX_LIMIT / 2` guard and well under Pixi's actual 400-float line. Join-span count
drives it, not width — the map's widest run (1760x32) costs 152.

---

## The arena's frame, measured on a GPU (2026-08-26)

The [wall](02-walls.md) and [occlusion](03-occlusion.md) sections count draw calls, and `perf/README.md` records four CPU numbers. None of them
said what the arena's frame actually *costs*, and the standing assumption in design/04's on-device
list was that a handset was needed to find out. It was not — it needed the right browser surface.
The in-app browser pane here is a software rasterizer (`Microsoft Basic Render Driver`, no
`EXT_disjoint_timer_query_webgl2`), which is where "no GPU timing on this machine" came from; real
Chrome on the same box is an Intel Arc Pro on D3D11 and supports it.

**`arena_launch`, 1920x855, resolution 1.0, camera at zoom 4.29, menus hidden: ~3.8-4.3 ms of GPU
time per frame, 36 draw calls, 20 program switches, 10 framebuffer binds.** Both controls fired —
an empty target costs 0.000 ms, and a 0.5/1.0/2.0 resolution sweep moves 3.20/4.31/5.93 ms with
non-overlapping bands — which is the only reason those are quotable. Method and full caveats live
in `client/src/perf/README.md`; the tooling is `client/src/perf/gpuTimer.ts`.

Two things follow, and both contradict what the draw-call work above would predict.

**The frame is not fill-bound.** *(Falsified 2026-08-26 — see the follow-up below: every filter in
this scene has `resolution: 1`, so a renderer-resolution sweep does not scale the fill inside them.)*
16x the pixels buys 1.85x the time: ~3.0 ms of the frame is
resolution-independent, ~0.7 ms is fill. So the render-quality tiers (2026-08-25), whose whole
mechanism is removing full-viewport passes and halving resolution, are aimed at about a fifth of
this scene's cost. They are still right for the PvE room they were measured on, where 11 filter
passes *were* the frame — this is a statement about the arena.

**The walls and pillars are a tenth of the frame; the floor is more than half.** Hiding one
render-group root at a time, against a 4.05 ms frame: `ground` 2.28 ms (56%), `shadow` 0.63 ms
(16%), `entities` — all 294 wall blocks and 124 pillars — 0.39 ms (10%). `ground` measured **flat**
across the full 16x pixel range (2.15/2.17/2.76 ms). *The share is right and the inference is not:*
cutting `ground`'s submitted triangles 17x later changed nothing, so it is neither fill nor
submission — see the follow-up below.

The mechanism is `buildGroundLayer` meeting a map far larger than the one its policy was tuned on.
It paints `drawRoomWash` + `drawFloorMottle` + `drawFloorDecals` **per room** into two
`staticGraphics()` Graphics, and `arena_launch` has 60 room rects over 4485x3462 px of floor, so
those two contexts are **284,966 and 265,566 floats** (1375 and 1343 fills). `staticGraphics.ts`
states the content its rule was measured against — *"a room's shared wall-shadow Graphics is ~24k
floats, the floor's decal pass ~50k"* — and on `ground`/`shadow` forcing `batch` bought -24 draw
calls for -0.08 ms there. Here the same two passes are 5.7x and 11x larger and are submitted whole
every frame regardless of where the camera is. The policy is not wrong; it is running an order of
magnitude outside its measurement. Fixing that is worth roughly **5x** what culling the walls and
pillars would buy, which is the opposite of where "294 blocks resident, no culling" pointed.

Not yet done, and deliberately so: this is one desktop GPU saying the arena is comfortable (~4 ms
of a 16.7 ms budget). It does not answer the on-device question, and the reason is now sharper
rather than vaguer — the dominant cost is geometry submission, which is the half that gets
relatively *worse* on a mobile GPU. *(That last clause did not survive the follow-up below. The
on-device question is still open, and now open for a reason nobody has named yet.)*

**And none of it needed a GPU to see, which is the part worth keeping.** The float counts come out
of the real `GraphicsContextSystem` headlessly - `staticGraphics.test.ts` had been driving it that
way since 2026-08-24 - so "is this pass inside the envelope its batch policy was measured on" was an
offline property the whole time, with no test asking it. `scene/groundGeometryBudget.test.ts` now
does: it sweeps `ARENA_CATALOG` against a per-Graphics budget anchored to `staticGraphics.ts`'s own
~50k measurement, exempts `arena_launch` through an explicit list, and **asserts that the exemption
still FAILS the budget** so the known defect is the gate's own control. It also pins the shipped
aggregates exactly (`ground` 284,966 / 265,566, `shadow` 49,392 - which reproduce the live browser
census byte-for-byte) off the REAL `RoomBuilder.build` rather than off a mirror of it.

Two things fell out of building that gate, both from judging every mutant twice - once against the
new file alone, once against the whole pre-existing scene/render/perf suite:

- **Deleting `drawFloorMottle` entirely survived every test in the suite.** So did a 6th mottle band,
  a doubled rubble density and a doubled stain density. The aggregate simply had no reader.
- **A 2% tolerance is the wrong shape here.** Removing `drawRoomWash` moves the second pass by 480
  floats - **0.18%** - which is the size of change a band is worst at seeing. The pins are exact
  instead: the pipeline is deterministic over fixed content, so a tolerance absorbs no noise and
  only hides drift. Changing the floor art means re-measuring in the same commit, the way
  `arenaWallCoverage.test.ts` already treats its 294/124/74 counts.

One thing the gate deliberately does NOT chase: `MOTTLE_PX_PER_BLOB` is **inert on this map**.
Halving it leaves `arena_launch` byte-identical, because all 60 rooms (82,944-286,720 px, median
143,360) round to the same count of 2 under either constant - the comment promises "~one blob per
510x510 of floor", and on the arena the mottle is a flat 2 blobs per polarity per room whatever the
room's size. Recorded as an asserted equivalence rather than pursued as a coverage hole.

One measurement rule came out of it, recorded because it inverts a result: **attribute by hiding a
render-group ROOT, never a child inside one.** Hiding the 322 floor sprites *inside* `layers.ground`
measured slower than leaving them visible (4.52 vs 4.14 ms) — the toggle invalidates the group and
the batcher repacks ~550k floats, costing more than the geometry removed. That is the same
invalidation hazard `staticGraphics.ts` documents, seen from the measuring end.

### Follow-up: the floor is cullable now, and the diagnosis above was wrong (2026-08-26)

The fix the section above nominates is done. `groundLayer.ts` mounts the ground as one piece per
room (per region, per door) instead of one `Graphics` per stage, each tagged with the rect it
actually paints, and `groundCulling.ts` switches the off-screen ones off once per frame from
`FxController.updateCamera`. The stage order is unchanged and so is the geometry: the two overlay
halves still sum to 284,966 and 265,566 floats, byte-for-byte the pre-split browser census.

Standing in the arena's first room the batcher packs **101,304 floats / 49,962 indices** instead of
**1,730,364 / 845,796** — 13 of 374 pieces, 17x less vertex data and 17x fewer triangles, ~6.5 MB
less in the batch buffer. **And the GPU frame did not measurably move**: interleaved A/B, cull on
against every piece forced visible, 13 samples each, 4.07 vs 4.28 ms with the min/max bands
overlapping. By the standard the measurement above set for itself, that is a null result.

Which is the finding. **The floor's ~2 ms is not vertex work, not triangle count, and not draw
calls** (the whole layer is 3 of the frame's 42). And the reasoning that pointed there was resting
on a control that measured the wrong thing: the "16x the pixels for 1.85x the time" sweep varies
`renderer.resolution`, but `layers.lit` (ground + shadow + entities), `layers.fx` and `layers.world`
all carry filters at Pixi's default `resolution: 1`, which does **not** follow the renderer's.
Almost the whole scene is drawn into targets pinned at 1x, so that sweep scales the final blit and
little else. "Resolution-independent" was a property of the filter chain.

So the arena's dominant cost is unattributed again, and it is a better-posed question than it was:
something about having a floor on screen costs 2 ms, and it is insensitive to how much floor. The
next sweep varies the on-screen AREA the blended overlays cover at a fixed resolution, and A/Bs the
`layers.lit` filter off — `perf/README.md`'s fifth measurement records both, plus two harness traps
(a `gl.finish()`-bounded wall clock reads 10x lower and fails its own resolution control; a
background tab's sample loop is clamped to ~1 s per sample).

The per-room split ships on its own merits rather than on a frame-time claim: it costs nothing
measurable, it cuts real memory, it removes the "one 285k-float `Graphics`" shape that
`staticGraphics.ts`'s batch policy was never measured at, and vertex throughput is exactly the half
that gets relatively worse on a phone. `groundGeometryBudget.test.ts` was rewritten around it — the
`arena_launch` exemption is gone (no piece is large any more), and the gate it leaves behind is the
one the old shape had no way to state: **what a single camera submits**, swept over every room of
every catalog map through the real `FxController.updateCamera` (worst 76,646 floats of 574,692, or
13%). Its control runs the other way — pull the camera back past the map and every piece must come
back, or a `groundPieceBounds` returning empty rects would pass everything.

### Both of those experiments came back no, and the floor is half spill (2026-08-27)

Ran. Neither hypothesis survived, and the third thing found on the way is the one with a fix behind
it. Full numbers, controls and traps in `perf/README.md`'s sixth measurement; the shape of it:

- **The `layers.lit` filter is not the amplifier.** Ground on/off costs 1.92 ms with the scene-light
  pass mounted and 1.80 ms with `lit.filters = []` — unchanged within noise. The filter itself is
  0.4 ms, which is 10% of the frame and is what the render-quality tiers are actually aimed at.
- **The cost is not the area it covers.** `layers.ground` is a render-group root, so scaling it
  about the screen origin shrinks its covered pixels with byte-identical submission. A quarter of
  the viewport costs *more* than the whole one (2.51 vs 1.71 ms); a sixteenth still costs 0.92.
  The same session's calibration — ten full-screen alpha quads, ~0.10 ms each, linear in area —
  proves the timer resolves area-proportional fill when it is there.
- So the elimination now reads: not vertex work, not triangle count, not draw calls, not the passes
  above it, not covered area. What is left is per-primitive fragment work on thousands of small
  blended primitives, whose triangle setup and 2x2-quad overshading do not shrink with the area
  they land on. Stated as what the elimination leaves, not as a measured mechanism.
- **What pays: 45% of the floor is rooms the camera is not in.** A mottle blob reaches 460 world px
  past its room — ~1970 screen px at zoom 4.29 — so `groundCulling.ts` correctly keeps four dark and
  four light halves on screen where one room is visible. The room you stand in paints 1.00 of the
  viewport per stage; its three neighbours paint 1.31 (dark) and 1.91 (light) more, all spill.
  Hiding just those six pieces: 4.07 to 3.32 ms. The stage split agrees from the other side — the
  additive light half is 1.03 ms and the dark half 0.68, while the region grid (0.05) and the room
  light pool (0.03) are free.

The fix that follows is a geometry clip on each room's dark/light `Graphics`, the same shape as
`arenaWallCoverage.test.ts`'s wall clip, with 0.75 ms as the number to beat.

A mutation battery over the cull's CALL CHAIN — `groundCulling.ts`, `groundLayer.ts`,
`FxController.ts`, 29 mutants, each judged twice (against the two test files the cull commit added,
and against the whole client suite with those two removed) — came back **26 killed, 3 controls
survived as designed, 1 real survivor**. 17 of the kills were NEW coverage, which is what the added
files bought. The survivor is the one that matters: moving `cullGroundLayer` back **below**
`syncCamera`'s `if (!activeQuality().sceneLight) return` — the exact shape this method had before
2026-08-26 — passed all 3,309 client tests. Correct code, connected, and read by nothing, in the
worst possible place: the low tier is the DEVICE tier, so a phone that drops to it would keep all
374 of `arena_launch`'s floor pieces resident, and the machine that most needs the cull was the only
one that would not get it. Closed by `FxController.test.ts`'s "still culls the ground on the low
tier", which carries the tier as its own control; replaying the mutant with it in place turns
exactly one test red out of 3,310.

A **second battery** then took the layer outside that file set — a battery's survivor count is only
ever scoped to the files it mutates. 20 mutants over what CONNECTS the floor and its cull
(`GameLoop.cameraFrame`, `layers.ts`, `RoomBuilder`, `floorRender.ts`, `roomLight.ts`,
`render/quality.ts`), 3 controls, **2 survivors**, and they are two different kinds of blind spot:

- **A duplicated rule, pinned in one copy and not the other.** `cameraFrame` and
  `groundLayer.roomRectsPx` both choose between the two co-resident room models with "dungeon
  first". `groundLayer.test.ts` pins its copy against a state holding both lists; reversing
  `cameraFrame`'s ternary passed all 3,310 tests. If they ever disagreed the camera would frame a
  room out of one model while the floor beneath it was painted from the other. (`EnvironmentSystem`
  makes it three selectors and it uses a *different* rule, `zoneEnabled` — worth knowing.)
  **Closed 2026-08-27, by deleting the duplication rather than adding a third pin:** all three now
  call `engine/state/roomModel.ts`, and the invariant the two rules could only disagree about — that
  `EngineConfig.dungeon` and `.arena` are alternatives, previously asserted only in their own doc
  comments — is enforced where it is decided (`GameState`'s constructor throws on a config carrying
  both). The two consumer tests above are what made that refactor safe: both passed unchanged, and
  they are still the only thing proving each call site READS the shared rule instead of re-inlining
  its own.
- **An aesthetic constant under a geometry-shaped suite.** `roomLight.ts`'s `EDGE_ALPHA` went 0.26
  to 0.9 — a near-black ring around every room — and nothing failed. Every existing test in that
  file pins the ramp's *geometry* (monotonic, non-overlapping, inside its own room, scaled to the
  short side); the band count is geometry and was covered, the alpha is a look decision and no
  geometry assertion can see one. The new bound is taken from the real `drawWallShadow` rather than
  transcribed — the pool must stay fainter than the base-hug crease it stacks with (0.24 vs 0.34),
  and the three darkenings composited must leave floor to see (0.71 against a 0.8 bound; 0.93 at
  the mutant's value) — so re-tuning the wall moves the gate instead of stranding it.

Each new test turns exactly one test red out of 3,312 when its mutant is replayed.

One method note that outranks all of the above, because everything measured before it was suspect:
**carry a twin control arm.** Two arms that apply no change at all, at opposite ends of the arm
order. A mid-session run had two identically-rendering arms read 3.556 and 5.985 ms while each
sample looked tight; a backgrounded tab degrades gradually over an hour and never says so. If the
twins disagree by more than ~0.1 ms the run is junk, and a `captureScreenshot` that times out is the
same tab saying the same thing.

### The clip that follows, and where a cut on a floor is allowed to land (2026-08-27)

`scene/floorClip.ts`. A room's blobs no longer paint outside the room, so a piece's cull rect is its
room instead of its room plus 460 px of spill, and the cull from the day before then drops a
neighbour's halves on its own — unchanged, still an exact intersection. **0.53-0.93 ms of a ~4.4 ms
arena frame** across three counterbalanced sessions, on-screen ground pieces 13 -> 7, 19.9% fewer
floats on the layer, and 66% less submitted by the worst camera. `perf/README.md`'s seventh
measurement has the arms and the three junk runs that preceded them.

The interesting half is not the millisecond, it is **where a cut on a floor may land**, because
truncating a smooth field leaves a step of the field's own local value and a straight step on a floor
is exactly what `floorRender`'s header rejected the per-tile tint for. A hard clip at the room rect
measures a **29.98 luma** step across a doorway (median 7.24) on a floor whose base luma is 25.9 —
measured before the shape was chosen, not feared afterwards. Two facts about the shipped content
decided the design instead, both swept rather than assumed:

- **A room rect includes its own perimeter wall, exactly one grid cell deep.** Sampled 2 / 16 / 30 px
  inside every room edge of `arena_launch` and all five PvE floors: **100% wall footprint or authored
  passage, 0% bare floor**; at 34 px in it is floor. So `CLIP_FEATHER_PX` is `PX_PER_GRID` because
  that is the depth of stone a room rect contains, and any cut inside it is invisible.
- **The passages are the exception and they are 8-17% of that band.** A doorway is floor on both
  sides, so no depth of clip is hidden there.

So the clip RAMPS: each of a blob's five nested bands is clipped at its own inset, faintest at the
room's edge and strongest a full cell in, with a hashed sub-band offset per blob so two blobs never
cut on the same line. The largest step any single cut can then make is ONE band's alpha — the step
that band's own rim already makes in the shipped art — which is the bound `floorClipCoverage.test.ts`
gates against, derived from the mottle rather than transcribed (re-tuning `MOTTLE_LIGHT_ALPHA` moves
the gate). Measured with the ramp: **2.59 luma** worst, 0.48 median, against a 4.90 bound. Rubble is
the one class dropped rather than cut — a 2-4 px speck at alpha 0.46/0.13 has nothing to ramp over.

And in a live frame, over all 74 passage floors, the clipped doorway is **smoother** than the
unclipped one: worst per-pixel step 36.16 -> 18.51, median 24.23 -> 14.65. What used to be roughest
there was a neighbouring room's rubble speck painted 400 px from home. The 14-18 luma that remains is
the floor swatch's own texel variation.

**And it was finally LOOKED at, 2026-08-27.** Every number above is a luma measurement taken through
`extract.pixels`, because the tab that could have shown a picture never composited — the clip shipped
without a frame behind it, which this repo's own rules say is not finished. Frames now exist: the
floor reads continuous standing in a doorway (including across two DISTRICT seams, where the two
floors are treated differently and a clip edge would show first), and continuous across all 60 rooms
in a single whole-map frame. The measurement was right. See ROADMAP's "The camera list, answered" for
the frames, for the four other verdicts it collected, and for the harness note that matters more than
any of them: a backgrounded Chrome tab gets FROZEN, which leaves synchronous JS working perfectly
while every `await` hangs and `drawImage(app.canvas)` silently returns the last presented frame.

Two mutation batteries, each judging every mutant twice — against the new test file alone and against
the pre-existing suite with that file parked. The first (26 mutants over the call chain:
`floorClip.ts`, `floorRender.ts`, `groundLayer.ts`, `groundCulling.ts`, `RoomBuilder.ts`) came back
21 killed / 2 survivors. The sweeps were then widened from `arena_launch` to all six shipped maps,
which found that the doorway bound had been measured on one of them — PvE floor 2 reads 3.04 luma
against a JND of 3, so the gate is the derived one-band bound (4.90) and the JND claim is
distributional. The second battery (17 mutants over what the clip DEPENDS on: `floorPartition.ts`,
`roomLight.ts`, `render/staticGraphics.ts`, plus the cull's comparison) came back 16 killed / 1
survivor — a confirmed equivalence. See ROADMAP for all four findings, including the one that was a
bug in the test rather than in the code.

---

## The void gets a face (2026-08-27)

The one finding the camera list left open: `arena_launch`'s twelve deliberately-empty grid cells
read from the room next door as **a hard-edged flat black rectangle with no rim, no depth cue and
no far side** — about a fifth of a 16:9 frame. It was recorded as an art call ("give the void's
vertical edges the same treatment as the map's outer boundary, author a pit rim, or accept it"),
with the note that the map's outer silhouette has the same property, so *"fix the twelve"* was not
obviously the right scope.

It was not the right scope. **The defect is one rule, and it belongs to the projection.**
`screen.y = gy - z` has no horizontal component, so a block's east and west sides project to
exactly zero width — the art simply stops at the footprint's edge. Where the next thing along is
another room's floor or more stone, that is correct: the neighbour carries the picture on. Where it
is the void, the stone does not end, it is **cut off**. A void to the SOUTH never reads that way,
because a whole wall height of lit FACE stands between the floor and it. The twelve cells and the
map's outer boundary are the same rule answered at two places, and so is every PvE floor's own
silhouette.

Measured, on a live frame beside empty slot r1c5 (scene-light filter detached, so what is being
read is geometry rather than the light pass darkening the rooms beyond):

| | luma across the boundary, west → east |
|---|---|
| Before | 87 (cap) … 53 → 26 → **6** in three pixels |
| After | 87 (cap) … 53 → 26 (silhouette) → **83** (arris) → 44 → 2 over 30 |

### The rule, and why it is spans and not a boolean

`scene/wallVoidEdge.ts` answers *which parts of a block's east/west sides face nothing at all*,
against what the ground layer actually PAINTS (`floorRegionsPx`, not the room rects — the two
diverge in the fallback case, where a mode with no usable room model paints the whole world box and
therefore has no interior void for a return to face) plus every wall run on the floor. It reports
**spans in footprint-local y**, not two booleans, because a run's side is routinely part void and
part neighbour: `arena_launch`'s east-west runs meet the empty slots END-ON — 32 px of a 64 px side
— and that end head is exactly the shape the finding was about. A boolean would either paint over
the neighbour or drop the case.

Each span also carries the **gap**: how much empty world px is out there, `Infinity` at the map's
own edge. That is the bound on how far a return may reach, because the wall on the far side of the
same void is drawing its own return inward and the two may at most meet. It is not hypothetical
headroom — `ember_l1` floor 2's narrowest void is 32 px, exactly twice `VOID_RETURN_PX`, so shipped
content sits ON the limit with none to spare and the next authored room could cross it silently.
The renderer clamps to `gap / 2`; both sweeps assert both halves (nothing shipped forces the clamp,
and floor 2's margin is exactly zero).

### The return, and why it is the CAP's swatch

`scene/wallVoidReturn.ts` carries the cap's own swatch 16 px past the footprint, **in the same
world-space tiling**, tinted for a vertical surface and ramped out to the backdrop. The tiling is
most of what sells it: the mortar runs straight on over the arris instead of restarting, so it
reads as a solid turning a corner rather than as a stripe painted beside one. The face swatch would
have been the wrong choice — it is an elevation, and its rows are a lit coping over a dark base, a
vertical order that means nothing on a surface seen edge-on.

Three numbers, each argued from a surface that already exists rather than tuned to taste:

- **16 px** — half a grid cell, one course of the cap swatch, 32 screen px at play zoom. Narrower
  and the ramp has nowhere to fall (the cap's existing dark bevel is 5 px and reads as part of the
  void); wider and the wall grows a buttress, which invented mass must not do.
- **The tints** are the key light's own direction. A cap facing straight up takes the swatch
  unmodified and a vertical surface takes `FACE_TINT` (0.78), so a WEST return — turned toward the
  upper-left key — sits between them (0.83) and an EAST return — turned away — sits below both
  (0.42).
- **The falloff is squared**, not linear (`render/shadeRamp.powerRamp`, new). A linear fade across
  16 px is already half gone at its midpoint, which leaves a bright line with a smudge beside it; a
  squared one holds ~75 % to the midpoint and then plunges, which is what a lit face turning into
  shadow does. Measured luma at the midpoint: 20 linear against 32 squared.

Only the EAST side draws a lit **arris**. The west already has `addBlockEdge`'s coping stroke and
`drawSideBands`' chamfer along exactly that line — cues that used to say *"I end here"* and, with a
return outside them, become the fold's own highlight without changing a pixel. The east had only
the dark silhouette, which against a luma-6 backdrop is not an edge at all.

The return is added LAST in `buildWallBlock`, after `addBlockEdge`: it sits outside the footprint,
so it is the block's outermost surface and its arris belongs on top of the dark silhouette rather
than under it. It is tagged with the CAP's x-ray group, not with the silhouette's — a block the
occlusion x-ray is fading has to fade whole, and a solid return beside a dissolved cap reads as a
second object standing there.

### What it fires on

| | runs with a free east side | free west side | spans | of those, partial (end-on) | narrowest gap |
|---|---|---|---|---|---|
| `arena_launch` | 42 | 41 | 83 | 13 | 288 px |
| `ember_l1` floors 0-4 | 8 / 15 / 17 / 11 / 8 | 7 / 14 / 14 / 9 / 5 | 108 | 5 | **32 px** (floor 2) |

So it was never twelve cells: it is 83 free sides on the arena and 108 across the five PvE floors,
and every one of them is the same rule. Not an `interior`-tier block among them, which is the check
that says the scoping is right — an interior block is surrounded by its own room's floor and can
never have a free side.

### Why NORTH is not in this, and how that was checked rather than assumed

A block's north side faces the void just as often (11 runs on `arena_launch`, mostly the map's own
top edge). It is deliberately left alone, for two reasons, and the second is the one that settles
it:

1. There is already art between the floor and that void. A block's cap is drawn one full wall
   height NORTH of its own footprint and its north edge carries a lit coping (`addBlockEdge`'s
   `openNorth`), so the eye gets a stone top ending at a rim — the same thing the south side gets
   from its face, and the reason neither direction was in the report.
2. **The camera cannot get there.** `GameLoop.cameraFrame` grows the framed room upward by exactly
   `MAX_WALL_HEIGHT`, which is the same distance the block's art reaches, so a player standing hard
   against their room's north wall sees that wall's cap filling the top of the frame and nothing
   beyond it. Checked, not reasoned: `foundry_r4c0` at its own north edge (the widest room with an
   empty slot directly above it, so the lowest zoom and the most overscan available) puts the top
   of the viewport at world y 1414 against an art top of 1400 — 14 px, and the frame shows
   unbroken brick.

Which is the honest shape of the rule: **east and west are the directions where this projection
lets you look past a wall into nothing.** If the camera frame ever grows upward by more than a wall
height, (2) stops holding and the north side needs the same treatment — the predicate already has
the shape for it.

### What it costs

`voidEdges` runs once per block at room-build time, against the floor regions and every other run —
0.64 ms for all 294 of `arena_launch`'s blocks, next to `floorPartition`'s 3 ms in the same phase.
Per frame it costs geometry rather than draw calls: a free side adds one `TilingSprite` sampling the
SAME lit cap texture every other block's cap already samples, plus one `Graphics` of a quad and a
line. `arenaWallCoverage.test.ts` gates both halves of that — every return's Graphics under a
quarter of Pixi's auto-batch line, and **one** shared ramp bake for all 83 of them, which is the
part that would quietly break if the falloff's shape ever varied per block.

Nothing here is gated on the quality tier, and that is the existing rule rather than an omission:
`render/quality.ts`'s low tier turns off everything that costs a render-target PASS (scene light,
screen fx, bloom, actor shaders) and leaves scene-graph geometry alone — the same treatment every
other wall cue gets.

---

## The void's far side (2026-08-28)

The rim above answered *"where does the stone end"*. It left the other half open, and the ROADMAP
carried it as an art call with three candidates: a pit, open sky, or ground beyond the wall. The
projection settles it before any of them is built, and the argument is the same one that produced
the rim.

**A pit is unbuildable here, for the reason the original bug existed.** What sells a pit is the far
bank's INNER wall descending from the rim, and across an east/west void that wall faces east or
west — `screen.y = gy - z` gives it exactly zero projected width. The one surface that would carry
the depth is the one this projection cannot draw. A pit FLOOR does draw, being horizontal, but
`z < 0` pushes it DOWN the screen: a pit `d` px deep appears `d` px SOUTH of its own footprint, over
the room below it, while the Y-sort (`zIndex = gy`) puts it BEHIND that room. Visible depth is
therefore bounded by the empty screen space south of the void, which for an interior empty cell with
rooms on all sides is about zero. The deeper it is authored, the less of it is seen.

**Sky works in the projection and breaks the rim.** A backdrop owes the projection nothing, so that
much is free. But `wallVoidReturn` draws the EAST arris LIT precisely because the backdrop is
luma ~6; against a bright field that arris stops separating and has to invert to a dark silhouette,
taking `VOID_RETURN_TINT_EAST`/`_WEST` and the squared falloff with it. It also splits at the two
scopes the rim deliberately unified: an interior cell reads as a light well, but past the map's
outer boundary there is no horizon to key on — `wallVoidEdge` reports `Infinity` for the gap there,
so there is nothing to derive one from.

**Ground is a horizontal plane at z = 0.** It draws the way floor draws, so no surface in it has
zero width; it keeps the backdrop dark, so the lit arris, both tints and the squared ramp stand
unchanged; and it is ONE rule at both scopes — an interior empty cell becomes a courtyard, past the
boundary becomes the surrounding land, and an `Infinity` gap needs no special case because the plane
simply runs to the view's edge.

### What it is, and the two things it does not have to compute

`scene/Terrain.ts` mounts **two display objects on `layers.terrain`**: a `TilingSprite` of
`terrainSwatch.ts`'s generated noise, and a `Sprite` of `Texture.WHITE` tinted `palette.void` at
`TERRAIN_FOG_ALPHA` over it. Two draw calls, fixed, whatever the map.

It computes **no void geometry at all**, and that is the point rather than an omission: the floor
paints over the plane wherever there is floor and the walls paint over it wherever there is stone,
so what is left showing IS the void, exactly and for free. There is no counterpart to
`wallVoidEdge`'s span arithmetic on this side. It also computes no per-pixel distance falloff — the
fog is a flat haze, which is correct rather than lazy, since every part of the void is at the same
"beyond the wall" remove and aerial perspective at one distance is uniform.

**`layers.terrain` is a child of `world` but a SIBLING of `lit`.** That placement is load-bearing.
The frame that closed the camera list found that much of what read as "the void" was the scene-light
pass darkening the rooms beyond, not the void itself; putting this plane inside `lit` hands it
straight back to the pass that was blacking that area out. It is fitted to the camera's visible
world rect each frame from `FxController.syncCamera`, **above** the `activeQuality().sceneLight`
early return — same position and same reason as the ground cull, since the low tier is the device
tier and an unfitted plane is a 1x1 sprite in the corner.

The swatch is **generated, not a PNG**, for two reasons and the second is binding: every shipped
`biome/*.png` is masonry, and the far side must not read as more floor; and the WeChat main package
is at 3.41 MB of a 4.00 MB cap. It goes through `shadeRamp.bakedField` (a `BufferImageSource`), not
`capLight.ts`'s canvas path, so there is no `DOMAdapter`, no 2D context and no canvas-free fallback
to maintain — identical bytes under vitest, in a browser, and on the wx runtime.

### Measured, on a live frame

The void beside `r5_extraction`'s east side, ember biome, scene-light attached:

| | mean | sd | range |
|---|---|---|---|
| Before (backdrop only) | 27.70 | **0** | 27.70 – 27.70 |
| After (terrain + fog) | 30.31 | 1.41 | 23.3 – 33.5 |
| The lit floor, same frame | 47.66 | 19.09 | 4 – 246.9 |

The before row is the finding restated as a measurement: **min = max**, not one pixel of that
rectangle differed from any other. Floor-over-void is 1.57x, so the far side cannot be mistaken for
somewhere to stand, and the floor stays 13x more textured — which is what reads as distance.

Horizontal luma scan across the boundary: cap 76-93 -> **arris 88** -> trough 6 -> terrain 24 -> 28.
Compare the rim's own row above, which fell to 2 and stayed there. The change is the last segment:
the ramp now lands on a surface instead of bottoming out.

### Two defects found on the way, one by the frame and one by a battery

**The frame caught a legible tile repeat.** The first swatch was 64 px with two octaves, and the
dominant octave's period IS the tile, so the eye locked onto a regular grid of identical blobs and
read "texture bug" rather than "ground". Fixed with a 128 px tile and a third octave (4/16/32 cells)
putting detail at 4 px — below the scale the repeat lives at. Nothing in the suite saw it; it is
only visible in a frame.

**A battery caught the biome derivation.** `terrain` was first tinted from the neutral terrain the
way every other biome colour is, but mixing the same absolute amount of a bright element hex into a
darker base lifts it more in relative terms: neutral's terrain/ground sat at 0.75 and ember's at
0.85 — and ember is the only biome that ships. It is now derived from each palette's own `void` and
`ground` (`TERRAIN_MIX`), so the position is invariant by construction. The ASSERTION was wrong too:
any ratio of terrain's luma to ground's drifts toward 1 as the hue brightens, so the bound that
survives a hue is positional, not proportional.
