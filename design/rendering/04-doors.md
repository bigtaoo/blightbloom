# Doors

The one fixture a player has to read at a glance: is this thing passable, and from where.

One part of the rendering architecture doc. The index, the fidelity roadmap and the quality
tiers live in [../01-rendering.md](../01-rendering.md). Split out of `03-occlusion.md`
on 2026-09-21, at 1,046 lines, with the x-ray left in [03-occlusion.md](03-occlusion.md) — the
nine sections below are that file's door half, verbatim and in the same order.

## A door is a wall block whose face is an opening (2026-08-20)

Every standing thing in a room had been through the volume passes — [walls](02-walls.md#standing-walls-2026-08-18),
[pillars](02-walls.md#a-pillar-is-a-sprite-now-2026-08-20), [the character](06-character-and-objects.md#grounding-the-character-2026-08-18)
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
  [The floor a door lights is not always south of it (2026-09-03d)](#the-floor-a-door-lights-is-not-always-south-of-it-2026-09-03d)): `GLOW_POOL`'s nine
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
