# Walls

How stone is built and shaded: standing runs, the measurement that judged them, the north-south case, and pillars.

One part of the rendering architecture doc. The index, the fidelity roadmap and the quality
tiers live in [../01-rendering.md](../01-rendering.md).

## Standing walls (2026-08-18)

For most of this project's life the "walls show a small front face" line in [View](01-foundations.md#view) was **only
true of pillars**. Every wall was drawn as its own collision footprint, flat, on the
`ground` layer (`RoomBuilder`) — no height, no face, no participation in the Y-sort — so a
room's entire sense of volume rested on the ≤2 round pillars a level-1 room happens to
have, and a character could never be occluded by a wall. Fixed by drawing a wall as an
extruded block on the `entities` layer — `scene/wallRender.ts` owns the drawing,
`scene/wallGeometry.ts` the height rule:

- **Geometry is forced by `screen.y = gy - z`.** The segment's container sits on the wall's
  **south edge**, so `Entity.place` gives it `zIndex = that edge` and it Y-sorts against
  actors as one object standing on that line. The **front face** then occupies local
  `-height .. 0` and the **top cap** the footprint depth above that. Union: the footprint
  plus one wall height of intrusion northward, which is exactly what makes a wall look like
  a wall.
- **Two assets, both already per-biome.** `wallface_<element>.png` is the front elevation
  (`art/biome/prompts.md`); `wall_<element>.png` — the pre-existing top-down swatch — is
  reused as the cap. The face tiles **horizontally only**, at a uniform
  `tileScale = height / texture height`, because its top rows are a lit coping and its
  bottom rows a dark base. A missing swatch falls back to Graphics banding and still stands.
- **Every wall stands, at one of three heights** (`wallGeometry.wallTier`/`wallHeight`). A
  room's boundary (`WALL_H_PERIMETER`, 104) towers over the blocks inside it
  (`WALL_H_INTERIOR`, 70 — deliberately the pillars' height, so everything standing in a
  room agrees on how tall "tall" is), and a wall with a room's **floor immediately north of
  it** drops to a low lip (`WALL_H_KERB`, 22) because a full-height wall there would stand
  between the camera and the player it is framing. A kerb is provably safe: a wall is 32 px
  thick and the player cannot overlap it, so their ground point is always at least that far
  north of the south edge. Height *variety* is itself the cue — a room where everything
  vertical is the same size gives the eye no relative measure.
- **A free-standing block's north face reserves an extra body radius** (`config.WALL_NORTH_BRIM`,
  ENGINE_VERSION 47, widened in 48). The height model above has a consequence the collision model
  has to answer for: a standing shape paints its footprint *plus one drawn height of walkable
  floor to its north*, so how deep a character sinks into that art is `drawn height - the floor
  the shape reserves`. The two standing shapes in a room used to disagree about the second term —
  a pillar reserves `radius + solidRadius` (48 px) against 88 px of art and sinks a character
  40 px, an interior block reserved `solidRadius` alone (16 px) against 70 px and sank them
  **54 px**, which is more than the whole silhouette. The live report was exactly that pair, seen
  side by side: *"角色整个跑到墙里面了"* against *"柱子...只有半个身子被覆盖"*.
  `MovementSystem.resolveWalls` v47 pulled a `freeStanding` block's north edge out by 16 px,
  putting its sink at 38 px — the pillar's number, within 2 px.

  **v48 widened the brim again, and this time deliberately did NOT chase the pillar.** A second
  live report, circled screenshot, on the v47 result itself: *"角色被挡住的部分...大概当前角色的一
  半可以进入墙...改为1/4的位置"* — even matching the pillar still read as "sunk in." The brim moved
  from 16 to 23 px, dropping the sink to 31 px; 23, not a naive double to 32, is the largest value
  `launchArena.test.ts`'s route-connectivity sweep measures as safe on the shipped map before a
  single-cell gap seals shut — a ceiling set by room geometry, not a target. A wall now covers
  noticeably LESS of a character than a pillar standing beside it does; nobody has filed the
  pillar version of this report, so that gap was left open rather than pulling the pillar down to
  match. Same version, **enemies stopped opting out of the widened clearance entirely**
  (`content/enemies.ts`, live report *"怪物也要遵守同样的规则"*) — every blueprint now stops at its
  own body radius against a wall or pillar, the same rule the player has had since v43, rather
  than the old feet-circle answer that let a mob stand visibly closer than any player ever could.

  Only the block's own NORTH face gets the brim, and only blocks flagged free-standing at
  authoring time: a perimeter ring is what door passages are carved through, and a kerb's whole
  point is that a character CAN stand tangent to it. The rect itself never moves — the drawn
  footprint, `blockedCells`, spawn placement and the projectile/LOS queries all still see the
  authored numbers. The x-ray below is unchanged and still fires at that pose, exactly as it does
  for a pillar; what moved is where the character (and now the enemy) is allowed to stand, not
  when the fade helps. `geom.clampToWalkable` (where a dropped pickup or a spawned crate lands)
  was widened to respect the same brim in the same version — a drop clamped only against the bare
  footprint could settle inside a band no actor's own collision would ever let them enter. In
  ENGINE_VERSION 50 those drop sites also stopped clamping by the pickup's own collect padding
  (`SIM.pickupRadius`, 15 px) and now use the PLAYER's clearance (`dropClearance()`, 16 px): the
  question a placement clamp is really asking is "can a player's body be here", so a drop now
  comes to rest somewhere a player could stand rather than merely somewhere they could reach.
  - **The kerb rule is about where a wall STANDS, not about whose wall it is** (generalized
    2026-08-20). It used to read "the room's own **south** boundary", resolved against the one
    room the wall's centre falls in — and where two rooms stack vertically the boundary between
    them is *two* walls, one grid row apart, authored by two different rooms. The upper room's
    own south wall kerbed correctly; the lower room's north wall answered "I am my room's north
    edge" and stood at 104 px, one row south of the exact floor the kerb exists to keep clear.
    A block's art rises from its own north edge, so it reached a measured **72 px into the room
    above** — 22 runs of it, on all five shipped floors, and the single biggest source of "the
    player is invisible" in the level (see "The occlusion x-ray" below, which is what measured
    it). `wallTier` now asks *"does any room's floor lie immediately north of me"*, which is one
    predicate covering both halves of a shared boundary and strictly generalizes the old test.
    Nothing has to be split apart afterwards: every room authors its own four perimeter walls,
    so a boundary arrives as two rects that are tiered independently, and `RoomBuilder` tiers
    **before** it merges — a collinear north boundary shared by two side-by-side rooms, only one
    of which has a room above it, therefore keeps its tall half (floor 2's `r5_bastion` beside
    `r4_furnace`; under the old rule those were one 32-cell perimeter run). Across level 1,
    19 runs moved from perimeter to kerb: 105 → 86 perimeter, 37 → 53 kerb.
  - **This replaced an orientation rule, and that is the whole point** (superseded
    2026-08-18, same day, after the user reported the walls *still* reading as
    *"一张图贴在地上"*). The first version of this pass only stood up an **east-west run that
    was not its room's south perimeter**, on the grounds that a long north-south run "reads
    as a defect — nearly all you see is its cap band sitting 70 px off its own footprint".
    That exclusion is what kept rooms looking painted on: level 1's shipped content is
    almost entirely disqualified by it (`ember_l1_gallery`'s east and west sides are 1×16
    grid runs; `ember_l1_kiln`'s four interior solids are 2×2 **squares**, so `w <= h` for
    every one of them), and a player could cross a whole room seeing nothing stand up but
    its north edge. The fix was not to hide those walls but to draw the volume properly —
    see the next bullet. Orientation now changes nothing about how tall a wall is.
- **Three surfaces, a faked side, a cast shadow and a dark silhouette** (`wallRender.ts`) —
  four cues whose absence, not the geometry, is what made a standing wall look printed on:
  - **Tonal separation** — *retuned 2026-08-19 against a measured frame; see "Volume, measured"
    below for the numbers that replaced these.* The first version kept the cap at ~95% of the
    swatch's own value, dropped the face to ~50%, and put 50% black over both for the east
    band, on the belief that the two swatches start from very different values (light grey
    stone vs dark charcoal brick). Measured, they start from almost the same value (~46), and
    separating the pair around that midpoint left BOTH of them darker than the floor.
  - **A faked side.** A block's east/west sides project to exactly **zero** width under
    `screen.y = gy - z` (this projection has no horizontal skew), so the east side is drawn
    as an **inset** dark band — inset, not extruded, so it can never cross into the
    neighbouring segment of the same perimeter run.
  - **A ground shadow.** Each wall sweeps its footprint down-right by
    `height × SHADOW_SLANT_*` and fills the convex hull of the two rects — four graduated
    passes since 2026-08-19, two before that, because two alphas over hard-edged quads let you
    see both quads. One shared `Graphics` on `layers.shadow` carries a whole room's set. Walls
    were the one tall thing in a room *not* using what this doc already calls "the cheapest 3D
    cheat". The alphas are higher than they look like they should be because the ember floor is
    near-black: what a shadow has to modulate on that biome is the floor's lava cracks, the only
    bright thing on the ground. The original also filled a **contact pass at the footprint
    itself**, which could never be seen — a block's art covers its whole footprint and then
    intrudes a wall height north of it, so every pixel of that fill was behind the block casting
    it. Replaced 2026-08-19 by an ambient-occlusion band hugging the footprint from the
    **outside**, which is both visible and where the crease physically belongs.
  - **A dark silhouette.** The outline was `palette.wallEdge` — a light salmon/steel,
    authored as the highlight edge of a wall lying **flat**, where a light rim is right. On a
    standing block, magnified by the room camera, it read as a bright wireframe box drawn
    over the art, and in the first live render it was the loudest thing in the frame.
    design/13 asks for a flat-cel silhouette, and a silhouette is dark.
- **The camera frame grew with it, and its CLAMP had to open too.** `GameLoop.cameraFrame`
  returns the room rect extended `MAX_WALL_HEIGHT` px upward (bottom edge unchanged), or the
  north wall's face would sit off the top of the viewport — the one thing this whole pass exists
  to show. It has to track the **maximum** tier, since the perimeter is both the tallest and the
  thing bordering that rect. That extension was **silently cancelled until 2026-08-19**:
  `updateCamera`'s vertical pan clamped to `[vh − effH, 0]`, an upper bound of the world's own
  top edge, while a wall on the floor's northern boundary draws its cap and the top of its face
  at *negative* world y. Confirmed live — `layers.world.y === 0`, the room's north wall showing
  face only, no cap, top of the face cut. The bound is now `overscanTop = max(0, −frame.y) × zoom`,
  i.e. the frame is the authority on how much above the world it asked to see, and a frame that
  asks for none (an interior room, or no frame at all) still gets exactly zero.
- **Per-stone relief was tried, measured out, and removed** (`LIT_WALLS`, false since 2026-08-19,
  **deleted 2026-08-20**). Each block used to carry a `NormalLitFilter` tuned for stone
  (`WALL_LIT_*`: a much gentler gradient gain than an actor's, since tiled masonry is nothing but
  luminance edges, and an ambient above `1 − key` so the cap brightens instead of the whole wall
  going darker than its own floor) at one render-target pass per segment, 10-32 per room. An A/B
  of the live frame with every wall filter stripped differs by a **mean of 0.48 out of 765
  (0.06%)**, a maximum of 5%, and only 0.05% of pixels move more than 5/255 — the tuning that made
  it safe is also what left it with no visible amplitude. Originally left switched off rather than
  deleted "so the experiment is repeatable," which in practice meant a permanently-false switch,
  an un-scheduled re-tune, and the single most expensive pass in wall rendering surviving in the
  codebase for no visible benefit; removed outright once nobody had a re-tune actually queued up.
  Only the wall-specific look and its `RoomBuilder` call site went at the time; the actor-facing
  look survived until 2026-08-24, when lighting became one screen-space pass over the whole scene
  layer (`SceneLightFilter`) and the per-actor filter went with it. Walls are inside that pass now,
  but it is normalized so a FLAT texel comes out at exactly its painted colour — measured on the
  shipped art, the median wall pixel moves by 0.1/255 — so this paragraph's finding still holds:
  the relief the walls read with is `wallTone.ts`'s, not a shader's.
- **Pillars follow the same language** (`pillarRender.buildPillarBody`, split out of
  `wallRender.ts` 2026-08-19). They were flat fills
  from `palette.pillar`/`palette.pillarTop`, which are **pre-art fallback hues** — the ember
  palette mixes the element's warm hue into a slate base and lands on a pale mauve, nothing
  like the charcoal-navy stone every shipped swatch actually is. Once the walls read as
  stone, four pale-mauve cylinders were the worst thing left in the frame. Texturing them
  from the wall swatches was tried and was worse (a ~35 px cap ellipse windows one arbitrary
  dark patch of a 256 px swatch — no legible pattern, and with the brick elevation on the
  shaft the whole thing read as an open-topped well). What works is hand-toned charcoal-navy
  stone with the shaft shaded across its curve in **colour-interpolated** bands (stacked
  translucent bands step in opacity, not in tone, and showed hard vertical seams at 4×), plus
  the same base crease and the same dark silhouette. The biome palette is back to being only
  what it was meant to be: the no-art-loaded fallback. **Superseded 2026-08-20** — this body is
  now the FALLBACK for a missing texture, not what ships; see "A pillar is a sprite now" below.
  Its account of why sampling the WALL swatches failed still holds, and is exactly why the art
  that replaced it had to be authored at pillar scale.
- **The floor grid stepped back.** A full-strength 64 px lattice across the whole floor is
  the loudest "this is a top-down blueprint" cue available, and it fought every depth cue
  above; it is still drawn (distance judging) but at `GRID_ALPHA`.

---

## Volume, measured (2026-08-19)

The two passes it follows — [Standing walls](#standing-walls-2026-08-18) above and [Grounding the character](06-character-and-objects.md#grounding-the-character-2026-08-18) — were built by *looking*. This one was built by **measuring the frame they
produced** — `renderer.extract` on `layers.world` at zoom 1, sampled per wall entity using the
geometry the renderer itself had just used (cap sprite y/height, face sprite y/height) rather than
coordinates guessed from the level data. That is what turned five look notes into numbers, and the
numbers said something none of the look notes had:

| surface                | was | now   |
|------------------------|-----|-------|
| pillar top             | 105 | 92    |
| wall cap               |  44 | 76-88 |
| **floor**              |  53 | 39-49 |
| wall face, upper       |  23 | 31-41 |
| wall face, at the base |  14 | 14-25 |
| east side band         | 4-6 | 20-28 |

**A top surface raised 104 px above the ground was darker than the ground it stands on.** That one
inversion is the physical cause of *"就像一张图贴在地上"*, and it explains why a north-south run was
the worst case: 100% of what you see of one IS its cap (its face only shows at the run's south
end), so a run was a floor-value ribbon lying on a floor-value floor. Everything below follows from
fixing the ordering. Tuning lives in `scene/wallTone.ts` — numbers only, no Pixi, no geometry, so
`wallRender.ts` (blocks) and `pillarRender.ts` (cylinders) can share it without importing each
other.

- **The cap's key light is ADDITIVE, not a wash** — *and additive alone was still not enough; see
  "A north-south run is not an east-west wall" below for what replaced the flat constant.* Pixi
  tints only multiply, so a cap cannot be lifted above its swatch's own value by tinting at all. A
  translucent white wash reaches the target value but is a lerp toward white, so it compresses the
  swatch's own contrast by its alpha — and at play scale a wall cap is nothing *but* that contrast,
  so the first version came out as smooth brushed concrete.
- **The face art's own coping course had to be pulled back under the cap.**
  `wallface_<element>.png` is a whole elevation — bright coping at the top, brick, dark base —
  used once at the wall's full height, and that coping measured as bright as the cap above it. A
  vertical surface cannot out-shine the horizontal one it meets, and when it does, the wall's
  brightest band sits halfway down its front and the fold stops reading. A uniform tint cannot fix
  it (the art's internal range is ~5:1, so any multiply that tames the coping crushes the brick),
  hence a local ramp over the top 22% of the face.
- **Every ramp is built from NON-OVERLAPPING bands, and the band count follows from the largest
  alpha step the eye may not see.** Stacked translucent shapes step in *opacity*, so their steps
  compound; non-overlapping bands make each band's alpha exactly its ramp value. The count then
  depends on how bright the surface underneath is: 12 bands is fine for the base crease, 5 is fine
  for the side shading, and the same 5 over the (much brighter) coping showed as five hard
  horizontal stripes at 3x — that one needs 18.
- **The cap's depth gradient is bounded to `CAP_GRADIENT_REACH_PX` of the fold.** A north-south
  run's cap *depth is its length*, so spreading the ramp over its whole 450 px turned it into a
  gradient painted down a beam. The physical cue is local to the fold anyway.
- **Adjacent rooms author the same boundary twice, and it has to be drawn once**
  (`scene/wallRuns.ts`). A horizontal luminance scan across what looks like one thick wall crossed
  **two** 32 px segments, each with its own lit west edge and dark east band, i.e. a bright/dark
  seam down the middle of one stone mass. The cause is content, not rendering: each room authors
  its own perimeter wall, so a boundary is two parallel rects (`[184,8,4,27]` and `[188,8,4,27]` in
  grid units, plus four more pairs on that floor). `mergeWallRuns` joins any two rects whose union
  is *exactly* a rectangle, iterating to a fixed point — 32 raw walls become 27 blocks on level 1's
  first floor. Render-only: `s.walls` is untouched, so collision is unaffected. **Same-tier only**,
  and that restriction is load-bearing rather than cautious: adjacent rects of different tiers are
  everywhere (a north perimeter wall with an interior solid flush beneath it; a stacked-room kerb
  against the lower room's east/west perimeter wall, 22 such pairs on the shipped floors), and one
  block cannot be two heights at once. It is also what makes tiering **before** the merge work as
  a splitting mechanism rather than needing one — see the kerb rule above.
- **A room now has a centre and corners** (`scene/roomLight.ts`). Measured, the floor was 39-53
  *everywhere* — every room, corner and centre alike. Two consequences no per-object shading can
  fix: a floor of five rooms reads as one flat sheet, and a black cast shadow has nothing brighter
  to be dark against (which is why a wall's shadow measured a 5% modulation on the near-black ember
  floor). This is the cheap static half of the lightmap milestone below — concentric stroked rects
  fading in from each room's own bounds, no light sources, no second render target. The dynamic
  half stays parked.

### The character, same treatment

- **The sphere shading was sized against a radius the art does not reach.** `RigSkin` passed the
  body bone's declared `bodyR`; decoding the shipped PNGs' alpha bounding boxes shows they paint
  **0.68-1.00** of it (`skinRegistry.BODY_FILL`). Nothing here is masked — that is deliberate, a
  mask per actor would be 30 stencil passes in a busy room — so for `critter-core` (0.70) every
  band outside 0.70 landed on transparent background and painted a hard-edged dark **disc** around
  the crystal. An earlier session looked straight at that disc and recorded it as an over-large
  ground shadow. The hero's 0.81 put a fainter halo just outside its white shell the same way.
  Fixed by passing the drawn radius (`bodyR x bodyFill`); `rigComposition.test.ts` re-measures the
  real pixels every run, so re-cropping a body texture cannot leave the number stale.
- **The ground shadow was sized off the sim radius too**, via a hand-tuned `radiusPx * 0.7`. Every
  rig's `referenceRadius` IS its body bone's `bodyR`, so the gameplay radius already equals the
  rig's declared body radius, and the 0.7 was one uniform fudge across a roster whose art fills
  between 0.68 and 1.00 — which is why it looked acceptable on the hero and made an enemy's shadow
  ~45% wider than the crystal standing in it. `Actor` now sizes it from `Skin.bodyDrawnR`. Its
  per-ring alpha also **ramps** (squared) instead of being flat: a flat alpha makes the outermost
  ring a visible hard rim, which is most of what made a shadow read as a plate.
- **The terminator was rebuilt as a full ramp** (`render/rigShading.ts`). Four concentric arcs put
  the darkest band on the rim with hard angular cut-offs at each arc's ends, so the shadow side
  read as dirt rather than as a turning surface. It is now a smooth chord-band ramp across the
  whole body with a **reflected-light rollback** that keeps the outermost sliver brighter than the
  shadow core — the single change that most restores design/13's crisp flat-cel silhouette.
  Pixi 8's `FillGradient` would be the obvious tool and cannot be used: it calls
  `DOMAdapter.createCanvas()` at `fill()` time, which throws in this repo's canvas-free tests, and
  reading the retained instruction list is exactly how the look is machine-checked here.
- **The light mark is a HUE, not a value.** design/13's shells are near-white — the lit cap of the
  hero's shell measures 255 before any shading — so the old white specular was arithmetically a
  no-op, and the first warm wash at 0.17 alpha was imperceptible for the same reason one step
  further out. At 0.28 it actually tints, and it does real work on the dark re-tinted enemy bodies
  the same code shades.
- **A hover of 3.5 px could not produce the cue it exists for.** `3.5 x SHADOW_SLANT` is
  (1.5, 0.8) world px of shadow offset — under one screen pixel. Raised to 6 (peak 9.5), with the
  rest of the readability bought from a steeper `SHADOW_LIFT_FALLOFF` rather than from lifting the
  body further, because past ~10 px a character stops reading as hovering and starts reading as
  flying.
- **The modules are seated against the core** (`drawModuleContacts`) — nested contact shades at
  each socket bone's tip, clamped so the whole ellipse stays inside the drawn body. A socket tip is
  *outside* the shell (orb-core: len 52 vs bodyR 40), so an unclamped blob would have painted a
  dark smudge beside the character instead of a contact shade on it.
- **A shielded actor lost its grounding entirely.** `EnergyShieldFilter`'s rim band peaked at
  `dist 0.5` of a filter area six body radii wide, i.e. **2.1 body radii** from the actor's centre:
  the ring was more than twice the size of the character it wrapped and blanketed the floor around
  its feet with opaque cyan, hiding the shadow the rest of this work exists to produce. Pulled in
  to peak at 1.2 body radii, with the glow's own alpha over transparent background cut from 0.85
  to 0.7.

**Two of this pass's tests are worth knowing about, because their obvious form does not work.**
Containment of the sphere shading cannot be checked against a Graphics' `bounds`: the ramp runs
diagonally, so its extreme points sit at 45° where an axis-aligned box never reaches, and a bounds
assertion passes with the safety margin deleted. It has to measure each mark's own distance from the
body centre. And the tether repaint's memoization cannot be checked by counting strokes, because
"skipped the redraw" and "cleared and rebuilt to the same count" produce identical counts — it takes
a marker stroke left on the Graphics that `clear()` would remove. Both are the same trap: an
assertion that is true of the fix but *also* true of its absence.

**What is deliberately not physical.** A tucked run's clip (above) hides stone that really is
nearer to the camera than the crown drawn above it. It is a choice, made twice on report, and the
whole reason `screen.y = gy - z` works at all is that this projection is already lying: it draws a
horizontal plane and a vertical one both unforeshortened. Keeping the room's back wall unbroken is
worth one more lie of the same kind.

**What is still deliberately unfixed.** A north-south run's visible cast shadow is only
`height x SHADOW_SLANT_Y` ~ 23 px of hem to the south, because the block's own art covers the rest
of the hull; lengthening it for walls alone would break the one thing every shadow in this project
agrees on (`Entity.SHADOW_SLANT_*` — actors, bullets, pillars and walls share one light). The base
hug carries that job instead. (The other half of this paragraph — "the pillars remain the
smoothest objects in a room... without real pillar art" — was closed on 2026-08-20 by generating
real pillar art; see "A pillar is a sprite now" below.)

---

## A north-south run is not an east-west wall (2026-08-19)

Reported on a screenshot of level 1's start room, circling its west perimeter run:
*"那段墙体看起来很奇怪啊"*. Three defects, and they share one cause: **every number in
`wallTone.ts` had been measured on an east-west wall, where the cap is a 32 px band under a lit
coping — and then applied unchanged to a north-south run, where the cap is 100% of what you see of
the wall.** The wall in question is 64 px wide and 224 px deep (two rooms' perimeter walls merged
by `wallRuns.ts`), so the same constants were being asked to describe a field 7x deeper than the
one they were tuned against. Found by A/B-ing the live scene layer by layer — hide one child of
every wall entity, re-extract, compare — which is cheaper than an edit-reload cycle and isolates a
cue exactly.

1. **A flat additive key light destroyed the stone.** `CAP_LIGHT` reached its target luma and the
   cap still read as pale concrete, because contrast is perceived as a **ratio**, not a difference:
   the swatch's stone-to-mortar range is ~30..60 (2:1), and adding a constant 47 to both ends
   gives 77..107 (1.4:1). The previous pass set out to protect that amplitude and did — in
   absolute terms only. The cap now takes its key light as **the cap swatch drawn a second time in
   `add` mode** (`CAP_BOOST_ALPHA`/`CAP_BOOST_TINT`), which is `value x (1 + alpha)`: the same
   target value with the ratio intact, and the warmth carried on that copy's tint rather than in a
   second draw. Pixi still cannot multiply *up* with a tint; this is how you do it anyway.
2. **The cap tiled from each block's own origin.** A 64 px-wide run therefore windowed the same
   left quarter of a 256 px swatch every time — on ember that is one large stone, i.e. no legible
   pattern at all, however good the swatch is — and an L corner's two blocks met at a mismatched
   seam. `tilePosition = (-r.x, -r.y)` puts every wall top in **world space**, so a room's walls
   read as one continuous quarry and corners join invisibly.
3. **The east band and west chamfer spanned the block's whole art.** That is right for an
   east-west wall: the band is the block's east *end*, and this projection stacks that end's cap
   and face rows on each other. On a north-south run the identical rects are 224 px long and run
   down the block's **length**, so a 13 px stripe at alpha 0.86 was painted along the top of the
   wall — a hard-edged flat grey panel with the stone visibly continuing underneath it, and the
   loudest artifact in a 3x render. Now bounded to `SIDE_CAP_SOLID_PX` (one wall thickness, which
   *is* an east-west cap's whole depth, so that case is unchanged) plus a `SIDE_REACH_TAPER` fade,
   with a narrow ramped bevel (`CAP_EDGE_*`) along the rest of the cap's long edges instead.

Measured after, on the same floor and the same probe geometry: north-south cap **72-78**,
east-west cap **70**, floor **41**, face upper **43** — the hierarchy the flat version reached
(89/78/45) with the masonry visible instead of washed out.

Mutation counts, reverting one half of the fix at a time against
`client/src/game/scene/wallRender.test.ts` (28 tests): world-space tiling **1**, the side band's
bound **1**, the multiplicative key light **4**, the cap-edge bevel **1**.

### The corner: two blocks, one continuous top

Follow-up report on the same wall: *"竖着的墙，直接盖在了横着的墙上面。如果横着的墙是有高度的，竖着
的墙只能到其底部"* — the north-south run looks pasted on top of the east-west one.

**The geometry was right and the drawing was wrong.** For the x range the corner occupies, the
stone mass really is solid from the east-west wall's north edge (y 32) all the way to the run's
south edge (y 288), so the correct picture is ONE continuous top ribbon from screen y −72 to 184,
with no brick face visible in that x range at all — which is what the two blocks together already
produced. (The alternative the report suggests — the run stopping at the far wall's *base* — would
draw the far wall's face in front of stone that stands nearer to the camera than it. Two walls of
equal height meeting at a corner have coplanar tops; the run reaching the far wall's fold is what
that looks like. A visibly stepped corner is a *height* decision, i.e. a different `WALL_H_*`
tier, not a drawing one.)

What was wrong: `mergeWallRuns` merges only pairs whose union is a rectangle, so an L or T corner
is always two blocks — and each of them drew its full "this is where I end" set right in the
middle of that continuous top. Measured down the run's centre line, the junction read **66 → 79**
with a highlight line on it, i.e. a brighter rectangle with a hard 90° corner laid over the brick.
Three cues, all false:

| cue | why it was wrong there |
|-----|------------------------|
| the run's lit coping on its cap's north edge | that edge is buried inside the corner and catches no light |
| the run's dark silhouette on the same edge | an outline drawn across the middle of one surface |
| the east-west wall's cap depth gradient (0 → `CAP_GRADIENT_MAX`) | shades the cap toward a fold that, for those x, does not exist |

`wallRuns.wallJoins` now returns, per block, the local-x intervals along its north and south edges
at which another mass **of at least its own height** carries straight on; `WallJoins` masks all
three cues out of them. Height is load-bearing in the same way `mergeWallRuns`' same-tier rule is:
a *shorter* neighbour (a kerb against a perimeter wall) leaves a real step that must keep its
coping and its gradient.

With the false edges gone, the last thing still reading as "pasted on" was the occlusion itself —
a hard stone/brick boundary with nothing to say which side is nearer. `CORNER_AO_*` creases the far
wall's face outward from each join, stronger on the down-light (east) side. Measured: brick at the
contact **22**, brick 40 px clear of it **33**.

Verified by measurement, not by looking: after the fix the residual step across the junction is
85 → 74, and the swatch's own two rows there are 50 → 45 — the same 1.1 ratio, i.e. what is left is
the stone's pattern and nothing artificial. (That the ratio survives at all is a second check on
the multiplicative key light; a flat additive would have compressed 1.11 to about 1.05.)

Mutation counts against `wallRuns.test.ts` + `wallRender.test.ts` (55 tests): buried-north-edge
mask **1**, buried-south-edge mask **1**, corner crease **1**, the neighbour-height filter **1**,
interval coalescing **1**.

### ...and the corner again: a deep run TUCKS (2026-08-19)

Third report on the same wall, and the one that changed the rule rather than a number:
*"中间的墙体处理的很好，但是上面那段就不对了。我觉得应该是中间的墙要看起来到横着的墙的底部，然后相交的
部分进行立体化处理"* — the run's south END (cap over a brick face) is right; the corner still is not.

Seamless was never the ask. **A block's art intrudes one wall HEIGHT north of its own footprint**,
which is the cheat that makes a wall look like a wall — and it means a deep north-south run climbs
the far wall's brick face and interrupts the one surface in the frame the eye is using as the
room's back wall. Making that overlap seamless only made it a cleaner interruption.

So a **deep** run (`rect.h > its own height`) whose north edge is fully buried now **tucks** under
the wall to its north instead of over it. This is a deliberate **stylisation, not a correction** —
the run's stone really is nearer to the camera than the brick it hides, and the previous pass's depth
arithmetic was right.

**Where exactly it stops took one more round, and that round is the useful part.** Clipping the run
at the far wall's FOOT — everything in the room starts at the back wall's foot, the convention most
top-down games of this shape use — shipped a render and was rejected: *"感觉还是不对，我觉得应该要覆盖
到我标记的区域"*, with a rectangle drawn over the brick immediately above the run. Measured against
the frame, that rectangle's top edge sat at world y **−10**; a row-luma scan of
`wallface_fire.png` puts the underside of its **crown course** (rows 0-31 of 127: lit coping, then
the dark mortar line) at world y **−14.6**. The ask was precise, and it was not "cover more" or
"cover less" — it was *this line*:

> The crown is the longest unbroken horizontal line in a room, so it is the line the eye identifies a
> back wall by. Break it and the wall stops being one wall. Keep it, and every brick course below it
> is fair game for whatever stands in front.

Hence `WallJoins.tuckLiftPx = farHeight × (1 − faceCrownFraction(element))` — taken from the
**shortest** northern neighbour, since the crown that has to survive is that neighbour's own. Three
answers were tried in order and only the third is right: full overlap (breaks the crown), the wall's
foot (hides brick the run is entitled to stand in front of), just under the crown. Visually the run
ends up reading as slightly shorter than the wall it meets, which is what an abutting wall under a
coping course looks like — and the swatch's own mortar line lands on the junction, so the joint comes
out looking authored rather than clipped.

**And the crown line is per ELEMENT, which only the test found.** `FACE_CROWN_FRACTION` shipped for
one round as a single constant measured off `wallface_fire.png`. The first run of
`wallComposition.test.ts` (below) scanned all four shipped face swatches and reported ice's mortar
line at row **17** where the constant said 31: fire and lightning put theirs at 27 of 127, neutral at
25 of 125, and **ice's coping band is a third shorter than the others'**. So two biomes out of four
were being clipped straight through the crown — the exact defect this whole treatment exists to
prevent — invisibly, on content no render of the ember floor could ever have shown. `FACE_CROWN_ROWS`
is now a measured `[row, totalRows]` table keyed by element, `RoomBuilder` looks it up from the room's
own biome, and the fraction rides along on `WallJoins` so the crease that follows a join is sized by
the same number that placed it.

Then the junction is no longer an overlap but a **re-entrant corner**, and gets a crease on both
surfaces (`TUCK_*`) — the *"立体化处理"* half:

| crease | measured |
|---|---|
| `TUCK_CAP_*` on the run's own cap, ramping north into the wall | 73 → **67** at the contact |
| `TUCK_FACE_*` on the far wall's crown, over the run's width | crown 48 → **38** |

The face crease sits on the **crown and nowhere else**, for two reasons that happen to coincide:
every brick course below it is behind the run's own cap now, and the crown is the brightest band on
the wall (~80 after `FACE_TINT`), so it is the only band where the alpha is visible at all. Two
earlier placements are worth recording as the instructive failure — confined to the contact
(`TUCK_FACE_FRACTION = 0.5`) it measured **9 vs 13**: arithmetically present, invisible, because the
bottom 42% of that face is already crushed by `BASE_AO_*`. Same trap as the pre-2026-08-19 contact
shadow. **Always check what value a surface still has where you are about to darken it.**

**`rect.h > height` is load-bearing, not caution.** Two parallel east-west walls stacked
north-south (32 deep, 104 tall) share this exact geometry, and there they are one mass whose top is
drawn by the northern one's cap: the southern one's art *must* keep reaching north of its footprint
or its cap and most of its face would simply be missing. Only a run with a cap to spare may clip.
The clip is otherwise provably safe for any block — it removes exactly the band
`[r.y − height, r.y]`, and the neighbour that authorised the tuck is by definition at least that
tall, so that neighbour's own art always covers exactly that band.

Because a tucked neighbour stops *at* a wall's south edge, that wall's fold there is real — so
`wallJoins` sorts each south-edge join into `south` (buried: mask the fold and the cap gradient) or
`tuckedSouth` (exposed: crease the face), never both. Getting that wrong deletes a real edge.

Mutation counts against `wallRuns.test.ts` + `wallRender.test.ts` (67 tests): the tuck itself **4**,
the cap crease **1**, the crown crease **1**, the `h > height` guard **1**, the whole-width guard
**1**, the `south`/`tuckedSouth` split **2**, re-locking the tile offset after the clip **1**, the
crown lift **2** (computed, and applied), taking it from the shortest neighbour **1**.

### `wallComposition.test.ts` — the assertion class all four rounds were missing

One wall was reported wrong four times, and every round shipped a green suite. The tests written each
round were not wrong, they were the wrong **class**: `wallRender.test.ts` and `wallRuns.test.ts` pin
one block, or one pair of hand-written rects, against numbers chosen by whoever had just chosen them
in the source. Neither can answer the questions the reports were actually about — *does the shipped
content reach this code path at all*, *do the pieces still tile the plane*, *is the constant still
true of the art it was measured from*. This repo has shipped the first of those before: the old
`w > h` height guard left 1 wall standing where 32 should, because level-1's rooms are almost
entirely `w <= h`.

So the new file runs the **real** floors through the **real** sequence (`placeAuthoredFloor` →
`buildFloorGeometry` → `wallTier` → `mergeWallRuns` → `wallJoins`, RoomBuilder's own), and asserts
relationships between blocks rather than restated coordinates:

- every floor produces deep north-south runs *and* tucks them (the `w > h`-class regression);
- a clip never opens a hole — the neighbour that authorised each tuck provably paints the band the
  clip removed, checked against real geometry instead of proved on paper;
- no tucked run crosses its neighbour's crown, measured against that neighbour's **own** height;
- every south-edge join lands in exactly one of `south` / `tuckedSouth`, never both;
- a join only ever exists where a tall-enough neighbour really touches — and the shipped
  kerb-north-of-perimeter-wall pairing (22 of them: a stacked-room boundary sitting directly north
  of the lower room's east or west wall) proves the height filter is load-bearing, not defensive;
- **nothing along a stacked-room boundary reaches further into the room above than one kerb's
  worth** — stated as art geometry against `WALL_H_KERB` rather than as a tier name, so any tier
  whose art clears the floor passes and both `interior` (70) and `perimeter` (104) fail. The
  boundaries are enumerated from the **room rects**, not from the runs, and that detail is the
  whole test: keyed off the runs, the three boundaries whose two halves merge into one 64 px-deep
  kerb (floor 2 `r5_bastion`, floor 3 `r3_crucible`, floor 4 `r5_boss`) matched no run at all and
  were silently skipped — it passed on the other eight and looked green. Rooms cannot merge, so
  the count (11, pinned) cannot fall because the drawing changed. Excluded on purpose, with the
  reason written down: a block starting one row further south is the lower room's east/west wall,
  whose art also pokes 40 px into the room above over a 32 px strip at the corner — a north-south
  run spilling past its own end, which no tier rule can fix and which the occlusion sweep owns;
- its counterweight: a north wall the room above only *partly* covers must keep the uncovered half
  tall (the check that would catch a future move of tiering to after the merge);
- `FACE_CROWN_ROWS` matches the real PNGs: it decodes each `wallface_*.png` (zlib inflate +
  unfilter — ~40 lines, and the alternative is trusting a recorded number, which is the failure mode
  the file exists for), asserts the recorded row IS the darkest row of the swatch's top third, that
  the recorded height IS the image's height, that every shipped swatch has an entry, and that the
  coping above the line really is brighter than the brick below;
- and that `RoomBuilder` is actually **wired** to the per-element lookup — read from source, the same
  trick `render/rigComposition.test.ts` uses on main.ts, because `wallJoins` has a safe default and a
  caller that forgets would just clip every fire room a few px low, forever, silently.

17 tests, and every one of them earns its place: mutation counts are the tuck **3**, the crown lift
**2** applied / **2** computed, the fire row **1**, ice's row **1** (i.e. re-introducing the
single-constant bug), the neighbour-height filter **2**, and RoomBuilder's wiring **1**.

**The generalisable lesson, and it is the third time this repo has hit it:** a constant tuned on
one orientation of one asset is not a constant, it is a special case. The `w > h` guard that used
to disqualify north-south runs from standing at all, the cap gradient that had to be bounded
because a run's cap depth is its whole length, and this pass are all the same mistake at different
scales — so when touching `wallTone.ts`, check the change against **both** a 32 px-deep cap and a
200 px-deep one before believing a number. The corner is the same shape of mistake one level up:
every cue in `wallRender.ts` is a statement about where a block ENDS, and at an L or T corner half
of those statements are false.

**And the cheapest tool this pass produced.** Both rounds were diagnosed by A/B-ing the *live*
scene rather than editing and reloading: `roomBuilder.wallEntities` is a flat list of blocks whose
children are `[face, cap, capLight, shading, edge]`, so hiding one child index across every wall
and re-running `renderer.extract` isolates exactly one cue per frame, three calls per variant and
no rebuild. That is how "the flat additive is the problem" and "the grey stripe is the shading
layer" were each settled in one frame instead of a guess-and-check loop.

---

## A pillar is a sprite now (2026-08-20)

The last item on the scene queue: *"pillars read as smooth cans next to the walls"* — their cap was
a hand-toned gradient where a wall cap is a real swatch under an additive key light, and their shaft
a mathematically perfect colour ramp with seven fixed mottle blobs on it. Closed by generating art
for the object itself (`art/biome/prompts.md`'s "Pillar SPRITE" section has the prompt, the rejects
and the two import steps) and drawing it with `pillarRender.buildPillarSprite`. `buildPillarBody`
stays as the fallback for a missing texture, the same contract every other biome swatch has.

- **One file, every biome.** A pillar is a fixed-size object — `radius: 1` in every shipped room,
  drawn 84x98 — so unlike the walls it needs no tileable swatch, and unlike the walls it does not
  need one file per element: `pillarTint(palette)` mixes `PILLAR_BIOME_MIX` of the biome's wall
  colour into WHITE and multiplies, which is where the hand-toned body already got its biome hue.
  `getPillarTexture` still resolves `pillar_<element>` first, so a per-element file remains a
  file-drop away.
- **Scaled by WIDTH; the art's aspect sets how tall a pillar stands.** Width is the axis the
  footprint has to agree with, so `pillarSpriteMetrics` fits the sprite to `bodyW + 2 x overhang`
  and lets `tex.height / tex.width` decide the rest. That leaves one thing to the file: `WALL_HEIGHT`
  is what every standing thing in a room agrees on, and the shipped art's 0.849 aspect happens to
  land within 4 px of the hand-toned cylinder's own top. Both `pillarRender.test.ts` and
  `pillarArt.test.ts` assert that bound rather than trust it.
- **The occluder box is measured off the sprite, not off the ellipse maths.** The x-ray reads
  `pillarArtExtent`, and the two bodies draw different shapes: an extent describing the other one
  would fade a pillar for a character it does not cover, or leave one solid over a character it
  does. With a texture the extent is `halfW = w/2`, `top = PILLAR_BASE_PX - h` — the sprite's own
  box, bottom-anchored at the ground point.
- **Mipmaps at load time, and no `repeat`.** A 326 px source drawn at 84 px is a ~4:1 minification
  when the camera sits at zoom 1, which is the exact shape of the 2026-08-12 rig-art bug (bilinear
  filtering with no mip chain reads a 2x2 texel neighbourhood and returns colour noise). The sprite
  key in `render/biomeTiles.ts` therefore loads with `data: { autoGenerateMipmaps: true }` —
  confirmed live, `mipLevelCount` 9 after upload — and skips the `addressMode: 'repeat'` every
  tiling swatch gets, which on a lone object would sample the far side of its own silhouette.
- **Nothing the art carries is drawn twice.** The closed top ellipse, the three shading bands, the
  curved course joints and the silhouette are all in the file; the sprite body adds only the base
  contact crease, because the art measures the same value at its foot as up its shaft (58 vs 59) and
  the crease is the only thing grounding it. The hand-toned body's mottle table and white coping
  stroke are deliberately absent from the textured path.

**Measured, in a live frame** (`renderer.extract` over the real level 1 gallery room at zoom 1, UI
and actors hidden, sample rects derived from the sprite's own `getBounds()`):

| surface | hand-toned | first accepted file | shipped |
|---|---|---|---|
| top | ~92 | 87.3 | **87.3** |
| lit limb | ~73 | 71.6 | **50.4** |
| mid band | ~62 | 52.4 | **35.8** |
| dark limb | ~19 | 25.1 | **16.7** |
| foot | — | 36.7 | **25.0** |
| in the same frame | | wall caps 72-81, wall faces 27.3-27.5, floor 48.5 | |

The middle column is why `tools/png-pipeline/lumaCurve.mjs` exists. **A generated sprite can be
right on one surface and wrong on another, and a uniform multiply cannot fix that**: the file's top
surface already landed on design/01's target while its shaft ran at roughly twice the wall face
beside it — the same stone, the same key light, one of them reading as a different material. A
luma-keyed curve (`--lo=85 --hi=95 --lo-gain=0.68 --hi-gain=1`) leaves the top alone and pulls the
shaft down, which is the same fold between a bright top and a much darker face that `wallTone.ts`
already builds for the walls, applied once offline instead of as a per-object filter.
