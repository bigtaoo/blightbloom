# Biome art prompts (archive) — floor/wall swatches, and the pillar sprite

`design/13`'s still-open "other biomes' looks" — the room ground/walls were a code-only
palette tint (`game/theme.ts`'s `biomePalette()`) until now. This batch is the first real
ART pass: **tileable swatches**, not illustrated rooms — `RoomBuilder.ts` now lays these
down as a `TilingSprite` covering the whole room/wall rect (see `render/biomeTiles.ts`).

**Two prior prompt attempts for this exact asset failed the same way** (noted in
`design/13`'s "To design" list before this file existed): they came back as painterly
isometric ROOM ILLUSTRATIONS — a complete drawn scene with a camera angle and composed
lighting — instead of a small repeatable material swatch. That art is unusable here no
matter how good it looks, because `TilingSprite` repeats the image edge-to-edge; a scene
with perspective and baked shadows creates an obvious seam and a fake sense of a "room
within a room" when tiled. Every prompt below is written to avoid that failure mode
explicitly, not just by omission.

Generated with **GPT Image 2**.

## Locked swatch style, in one paragraph (paste as context, EVERY time)

A small SQUARE TEXTURE SWATCH ONLY — a flat material sample meant to be repeated
edge-to-edge in a tiling grid, like a game texture atlas tile. This is NOT an illustration
of a room, NOT a scene, NOT a camera view, NOT isometric, has NO characters, NO furniture,
NO horizon, NO perspective, NO vanishing point, NO directional lighting or cast shadows —
just a flat, straight-down orthographic view of a small patch of ground/wall material,
lit evenly. The four edges of the image must match up so the pattern repeats seamlessly
when placed in a grid next to copies of itself. Style: flat cel-shaded 2D mobile-game
texture, bold clean thin outlines on individual stone/tile seams only (not a border around
the whole image), flat solid colour fills, minimal gradient, matching a dark charcoal-navy
stone dungeon floor base (hex approximately #161A24 for floor, #2A3140 for wall) with only
a SMALL, SUBTLE tint of the biome's element colour mixed in — the environment stays
desaturated and dark (`design/13`'s "environment desaturated, hazards saturated" rule); the
raw saturated element hue is reserved for bullets/status FX/loot, not the floor itself.

## Floor swatches (4)

### `floor_neutral` — entry-zone / default floor
> [paste style paragraph above] The floor is dark charcoal-navy stone flagstone, cut into
> roughly even rectangular slabs with thin dark seam lines between them, no colour tint at
> all — this is the game's default, un-themed floor.

### `floor_fire` — ember biome floor
> [paste style paragraph above] The same dark charcoal-navy stone flagstone base, but with
> a subtle warm orange-red undertone (a small tint only, the stone should still read as
> dark grey-navy first) and a few thin cracked seams with a faint warm ember glow inside
> the cracks, like heat-baked stone near a fire source.

### `floor_ice` — ice biome floor
> [paste style paragraph above] The same dark charcoal-navy stone flagstone base, but with
> a subtle pale cyan-blue undertone (a small tint only, the stone should still read as dark
> grey-navy first) and a faint thin frost/rime pattern dusted across the seams, like cold
> stone in a frozen zone.

### `floor_lightning` — lightning biome floor
> [paste style paragraph above] The same dark charcoal-navy stone flagstone base, but with
> a subtle pale yellow undertone (a small tint only, the stone should still read as dark
> grey-navy first) and a few thin hairline cracks with a faint yellow static-charge glow
> inside them, like stone charged with latent electricity.

**Shipped off-hue for two months, recoloured 2026-10-06.** The generator drew the crack glow
red-orange, not yellow: measured median hue **12°**, exactly `floor_fire`'s, against the
lightning hue's 54°. Nothing could show it, because no dungeon mapped to `lightning` until
chapter 3 (the Storm Descent). Its first run looked like a dimmer ember run. The fix is one
mechanical step between the raw and the compress, so `floor_lightning_raw.png` stays the
generator's bytes:
- every pixel whose hue is warm (345°-45°) with saturation above 0.25 has its hue set to 54°,
  keeping its saturation and value;
- that was 0.70% of the raw's pixels, the crack glow and nothing else;
- the stone's mean colour is unchanged to the third decimal;
- then `compress.mjs --long-axis=256` as usual.

Seamlessness is untouched, since no pixel moved. `wallface_lightning`'s few glow pixels read
amber (hue ~40°, 0.1% of the image) and were left alone: at wall scale they read as warm light
rather than as fire.

## Wall swatches (4)

### `wall_neutral` — entry-zone / default wall
> [paste style paragraph above] A dark slate-grey vertical wall panel texture, blocky
> rectangular masonry blocks stacked in a simple running-bond pattern, thin dark mortar
> seams, no colour tint at all — this is the game's default, un-themed wall.

### `wall_fire` — ember biome wall
> [paste style paragraph above] The same dark slate-grey blocky masonry wall base, but with
> a subtle warm orange-red undertone (a small tint only) and a couple of the mortar seams
> showing a faint warm ember glow, like heat-scorched masonry.

### `wall_ice` — ice biome wall
> [paste style paragraph above] The same dark slate-grey blocky masonry wall base, but with
> a subtle pale cyan-blue undertone (a small tint only) and a faint frost rime dusted along
> the top edge of each block, like cold masonry in a frozen zone.

### `wall_lightning` — lightning biome wall
> [paste style paragraph above] The same dark slate-grey blocky masonry wall base, but with
> a subtle pale yellow undertone (a small tint only) and a couple of the mortar seams
> showing a faint yellow static-charge glow, like masonry charged with latent electricity.

## Wall FRONT ELEVATION swatches (4) — the standing-wall pass, 2026-08-18

A second, separate wall asset. The `wall_*` swatches above are the wall's TOP surface, seen
straight down; these are the wall's **front face**, seen straight on. Both are used at once:
`RoomBuilder` draws a standing wall as `wallface_<element>` rising `WALL_HEIGHT` px from the
wall's south edge, with `wall_<element>` as the top cap lifted above it (`scene/wallGeometry.ts`
decides which walls stand). Only the south face and the top are ever visible — the camera is
fixed and never rotates (`design/01`) — so there is no side/end-cap art to generate, one image
per element covers it.

**The seam rule is DIFFERENT from every other swatch in this file, and saying so explicitly is
what made these come back usable on the first try:** an elevation tiles **left-right only**, and
its top and bottom must NOT match — the top is a lit coping edge, the bottom meets the floor.

### The elevation style paragraph (paste as context, EVERY time)

> A single SQUARE TEXTURE SWATCH of a dungeon wall's FRONT ELEVATION — the vertical face of a
> low stone wall seen straight-on, orthographic, no perspective and no vanishing point. This is
> NOT a room, NOT a scene, NOT isometric, NOT a top-down floor tile; no characters, no props,
> no floor, no sky, no cast shadows on the ground. IMPORTANT — seam rule differs from a normal
> tile: the LEFT and RIGHT edges must match so the image repeats seamlessly side-by-side, but
> the TOP and BOTTOM must NOT match. The top ~12% is a brighter lit coping/cap edge (the wall's
> top rim catching light from the upper left); the bottom ~15% is a darker band where the wall
> meets the floor. Vertically this image is used exactly once, never tiled. Style: flat
> cel-shaded 2D mobile-game texture, bold clean thin outlines on individual stone-block seams
> only (no border around the whole image), flat solid colour fills, minimal gradient, one
> consistent light direction from the UPPER LEFT. Base colour is dark charcoal-navy stone (hex
> approximately #2A3140) with only a SMALL, SUBTLE tint of the biome element colour mixed in.

### Per-element line

- **`wallface_neutral`** — no element tint at all, plain dark charcoal-navy blocks.
- **`wallface_fire`** — a faint warm orange-red tint (`#FF7043`) in the mortar seams and a few
  cracked blocks, as if heat-scorched; no visible flame, no lava, no glow.
- **`wallface_ice`** — a faint pale-blue tint (`#81D4FA`), a thin frost rime along the coping
  edge only.
- **`wallface_lightning`** — a faint yellow tint (`#FFF176`) in the seams, a few blocks with
  hairline fracture lines; no arcs, no sparks, no glow.

### What the accepted batch needed on top of the prompt

All four came back on-style and genuinely seamless left-to-right (measured, not eyeballed:
mean per-channel difference between the wrap columns was 1.6–7.2 vs. an adjacent-column
baseline of 0.6–1.9). Two mechanical fixes were still needed, both done at import time rather
than by regenerating:

1. **Crop the band above the coping.** Each image had a strip of flat background above the
   wall's top edge (9–48 px of 1920). Found by scanning for the first row with real horizontal
   variance — a uniform band has near-zero row std-dev — not by eye.
2. **Crop to the top ~50% and re-darken its new bottom edge.** The full image is ~9 courses of
   brick; squashed into a 70 px wall those read far finer than the floor stones next to them.
   Keeping the top half puts coping + ~4 courses in the same 70 px, which matches the floor's
   scale, and a linear darkening ramp over the bottom 20% of the crop restores the base shadow
   the crop threw away. **This is the step to redo if `WALL_HEIGHT` ever changes.**

Note the three generations delivered as `.webp`, which this repo's pure-Node PNG pipeline
cannot decode; they were converted at import (Pillow, outside the repo's own tooling — a
one-time boundary step, not a new dependency) and archived as `wallface_*_raw.png`.

## The poison biome (3) — the last element without a look, 2026-08-25

The 2026-08-02 batch deliberately skipped `poison`, on the reasoning that it isn't floor 1 and
has no dedicated critter either. That left the fifth element of a **locked** five-colour language
on the flat-fill fallback while the other four carry real stone — half a rule, not a nice-to-have,
which is why it came off the parked queue.

Three files, matching the two sections above exactly in kind: `floor_poison` (top-down swatch,
tiles all four edges), `wall_poison` (top-down cap swatch, tiles all four edges), `wallface_poison`
(front elevation, tiles LEFT-RIGHT ONLY — top and bottom must not match).

### The poison-specific constraint paragraph (paste into ALL THREE, in addition to the style paragraph)

This one is not a style note. `design/13`'s "environment desaturated, hazards saturated" rule has a
hard clause for exactly this biome — *"the poison biome's ambient green must be dialled down … or
green FX/enemies camouflage against a green floor"* — and it is the whole reason this asset is
harder than the other four.

> IMPORTANT — the green in this image must be dialled down further than any other colour in this
> texture set. In this game a saturated yellow-green (hex #9CCC65) is reserved for poison bullets,
> poison status auras and poison-tinted enemies. If the stone itself reads as green, those objects
> camouflage against it and the player cannot see what is shooting at them — that is a gameplay
> defect, not a matter of taste. So: NO bright green, NO glowing or luminous green, NO green light
> source, NO bubbling slime pools, NO vivid moss, NO acid puddles. The tint is a dull, desaturated,
> slightly sickly grey-green stain in the stone, the colour of dried residue, not of liquid.
>
> Concrete numeric targets, because "subtle" is not measurable: MEDIAN brightness about {MEDIAN}
> out of 255 and no higher than {MEDIAN_MAX}; the brightest pixels no higher than about {P95}.
> Averaged over the whole image the BLUE channel must still be the highest of the three channels
> (the stone is dark charcoal-NAVY first), and the green channel must be no more than about 10
> points out of 255 above the red channel. A tint the viewer has to look for is correct here. A
> green floor is a defect. Output the image at {SIZE} pixels.

### `floor_poison` — blighted-zone floor

> [paste the swatch style paragraph from the top of this file] The same dark charcoal-navy stone
> flagstone base as the other floors in this set, cut into roughly even rectangular slabs with thin
> dark seam lines between them, but for a contaminated zone: a dull desaturated grey-green stain
> settled into the seams and creeping a little way onto the slabs beside them, like dried toxic
> silt that has soaked into porous stone. A few slabs are lightly pitted/eaten at their edges. The
> stone is unlit and matte — nothing on this floor emits light. [paste the poison-specific
> constraint paragraph, with MEDIAN = 36, MEDIAN_MAX = 45, P95 = 60, SIZE = 1024 x 1024]

### `wall_poison` — blighted-zone wall TOP CAP

> [paste the swatch style paragraph from the top of this file] The same dark slate-grey blocky
> masonry as the other walls in this set, rectangular blocks in a simple running-bond pattern with
> thin dark mortar seams, seen straight down onto the wall's top surface, but for a contaminated
> zone: a dull desaturated grey-green stain in the mortar seams and a faint dry crust along a few
> block edges. No growth standing up off the surface, no drips, no glow. [paste the poison-specific
> constraint paragraph, with MEDIAN = 46, MEDIAN_MAX = 54, P95 = 70, SIZE = 1024 x 1024]

### `wallface_poison` — blighted-zone wall FRONT ELEVATION

Note this one takes the **elevation** style paragraph (the left-right-only seam rule), not the
tile-all-four-edges one.

> [paste the elevation style paragraph from the section above] The same dark charcoal-navy blocky
> masonry as the other elevations in this set, but for a contaminated zone: a dull desaturated
> grey-green stain in the mortar seams, heaviest in the lower third and fading out before it
> reaches the coping, as if it has wicked up out of the floor. The lit coping course at the top
> stays clean stone with no green in it at all — it is the wall's brightest band and green there
> would be the most visible green in the room. No drips running down the face, no glow, no growth.
> [paste the poison-specific constraint paragraph, with MEDIAN = 48, MEDIAN_MAX = 56, P95 = 140,
> SIZE = 1024 x 1024]

Note `wallface_*`'s P95 is far higher than the other two on purpose: this swatch legitimately
contains a bright lit coping course (the shipped four measure p95 80-166), where a top-down swatch
is evenly lit and has no highlight at all (they measure p95 34-67).

### The numbers those targets came from

Measured off the twelve shipped swatches with `tools/png-pipeline/pngCodec.mjs`, so a poison file
lands in the same tonal family as the biome it will sit next to rather than being judged by eye:

| asset | median (fire / ice / lightning / neutral) | p95 |
|---|---|---|
| `floor_*` | 39 / 45 / 31 / 34 | 41 / 52 / 34 / 36 |
| `wall_*` | 42 / 49 / 45 / 47 | 47 / 67 / 57 / 48 |
| `wallface_*` | 49 / 43 / 45 / 53 | 128 / 80 / 166 / 130 |

### What the accepted batch needed on top of the prompt

**All three came back usable on the first generation — no reroll.** Worth recording why, because the
poison brief was the hardest in this file (it is the only asset in the game with a gameplay clause
attached to its colour) and it is the third batch in a row where stating the target as a NUMBER and
naming what a wrong value would be mistaken for is what did it:

| measured | `floor_poison` | `wall_poison` | `wallface_poison` | asked for |
|---|---|---|---|---|
| median | 31 | 40 | 42 | 36 / 46 / 48 |
| p95 | 43 | 42 | 97 | <=60 / <=70 / <=140 |
| mean G - mean R | 4.0 | 3.3 | 6.3 | <= 10 |
| blue the highest channel | yes | yes | yes | required |
| greenest single pixel (`g - max(r,b)`) | 5 | 4 | 7 | `#9CCC65` scores 48 |

All three landed slightly DARKER than asked, which is the safe direction here and puts them beside
the existing family (shipped floors run 31-45, walls 42-49, faces 43-53). The green is dialled down
harder than the brief required — `wall_ice` actually measures a higher mean G-R (10.3) than any
poison swatch does.

**One real defect, fixed at import rather than by regenerating: the elevation came back with a
1-2 px near-black frame drawn around all four sides**, despite the style paragraph's "no border
around the whole image". Row 0 measured luma 2.4 against a coping of 95-107, and column 0 measured
5.1. Cropped at a 4 px inset, chosen by MEASURING the horizontal wrap at each candidate inset rather
than by picking a round number — 0 px reads as trivially seamless (both edges are the same black
line) while actually tiling as a doubled dark stripe; 4 px measured 5.89 against an adjacent-column
baseline of 2.02, and the shipped 256 px file ends up at 3.55 against a baseline of 3.91, i.e. the
wrap difference is *lower* than the difference between two neighbouring columns.

**Identifying which file is which, when the generator returns three UUIDs.** Row-profile first, and
only then look: the elevation is the one whose ten vertical bands run `69 38 42 42 43 43 46 48 47 34`
(bright coping, brick, dark base) where both top-down swatches are flat (`32 33 33 34 ...` and
`40 40 40 ...`), and of those two the darker is the floor (base `#161A24`) and the lighter the wall
cap (`#2A3140`). Confirmed afterwards by eye — flagstone slabs vs running-bond masonry — which is
what looking is actually good for here.

**Verified in situ by compositing the room OFFLINE** from the shipped swatches at the real render
scales (floor stamped 1:1, cap 1:1, face at `WALL_HEIGHT / face.height` with `FACE_TINT` and the
coping suppression applied), with a poison bullet, its glow and a poison-tinted mob body drawn at
their real sizes on top. That is the check the whole "dial the green down" clause exists for, and it
passes with room to spare: floor 33.1 luma against the FX green's 186.4. Rendering the same
composite for `fire` and `ice` first is what made it trustworthy — the fire room came out matching
the known shipped look, so the poison one can be believed.

### Import steps (same as the batches above — do not skip)

1. If the generation arrives as `.webp`, decode to PNG first (Pillow; `pngCodec.mjs` cannot read
   webp), and rename off the generator UUID to `<id>_raw.png` in the same step.
2. `wallface_poison` only: crop the flat band above the coping, then crop to the top ~50% and
   re-darken the new bottom edge — see "What the accepted batch needed on top of the prompt" above.
   This is a `WALL_HEIGHT`-scale fix, not a taste one.
3. `compress.mjs` down to a 256 px long axis (the shipped swatches are all 256 wide).
4. Re-measure median/p95/channel means and check them against the table above before shipping.
5. Add the measured crown row for `poison` to `FACE_CROWN_ROWS` in `scene/wallTone.ts` — the
   darkest row in the swatch's top third, over the total row count. Every element's differs
   (ice's is a third shallower than fire's), and an element with no entry falls back to the
   conservative shallowest-of-all default.

   **Done: `[26, 128]`. And poison is the one case where that rule's operational form and its own
   prose description disagree.** `wallTone.ts` describes the value as "the joint between the coping
   course and the first brick course"; poison's coping ends at row 11 in a smooth 97 -> 72 -> 51
   gradient with no dark mortar line under it at all, and the first real dark horizontal is row 26,
   between its FIRST and SECOND brick courses. Row 26 is still the right answer, because what the
   value is actually for is the longest unbroken horizontal near the top of the wall — the line the
   eye reads a back wall by — and its fraction (0.203) lands within 0.01 of fire, lightning and
   neutral anyway. Recorded in `wallTone.ts` rather than left as a surprise for the next element.

## Pillar SPRITE (1) — the pillar pass, 2026-08-20

A third kind of asset in this file: not a swatch at all, but one whole OBJECT. `design/ROADMAP`'s
"pillars read as smooth cans next to the walls" item — their cap was a flat hand-toned gradient
where a wall cap is a real swatch, and `pillarRender.ts` records an earlier attempt at texturing
them FROM the wall swatches that came out worse (a ~35 px cap window onto a 256 px swatch lands on
one arbitrary dark patch; the brick elevation on the shaft read as an open-topped well).

**One file for every biome, not one per element.** A pillar is a fixed-size object (`radius: 1` in
every shipped room, drawn 84x98), so the fix is art authored AT pillar scale; the biome's hue
arrives as a `Sprite.tint` (`pillarRender.pillarTint`), which is also how the hand-toned version
got it. `pillar_fire_alt.png` is a real per-element attempt that was NOT taken — see the rejects
below.

### The accepted prompt

> A single game SPRITE of one short round stone PILLAR (a squat stone column drum), drawn as a
> standalone object on a fully TRANSPARENT background. Output the image at 768 x 896 pixels. Leave
> a 4-pixel fully transparent margin on all four sides — no part of the pillar may touch the image
> edge, and the top ellipse must not be cut flat by the frame.
>
> This is NOT a scene, NOT a room, NOT isometric, NOT a texture swatch and NOT a tileable pattern.
> There is no floor or ground under it, no other objects, no characters, no background of any kind,
> and NO cast shadow on the ground — the game draws the shadow itself on a separate layer, so a
> baked shadow would double up.
>
> Camera: fixed, looking slightly down at the pillar from the FRONT. The top of the pillar is a
> shallow ellipse whose height is about 42% of its width; the shaft is seen straight-on below it.
> No perspective convergence, no vanishing point, no rotation, no tilt.
>
> Proportions, which matter because the game draws this at a fixed size: the whole object is about
> 0.86 as wide as it is tall. The top ellipse spans the full width of the object and occupies the
> top 36% of its height. The shaft runs from the middle of that ellipse straight down to the bottom
> of the object, with straight vertical sides all the way — no taper.
>
> Construction: a squat round stone drum of THREE courses of stone, each course separated by a
> single joint line, and every joint line must CURVE downward following the same ellipse as the top
> surface — never a straight horizontal line, because a straight line makes a cylinder read as a
> flat board. Nothing is carved or ornamented on it; no capital, no fluting, no runes, no cracks.
>
> IMPORTANT — the top is a SOLID CLOSED disc of stone. This is not a well, not a hollow tube, not a
> barrel, not a drum you could open, not an urn, vase, jar, pot, cauldron or basin. There is no
> opening, no hole, no inner rim and no lip on top. The top surface must stay the BRIGHTEST plane in
> the whole image, clearly brighter than any part of the shaft, because it is the surface facing the
> sky; if any part of the shaft out-shines it, the object reads as an open-topped well instead of a
> solid column.
>
> Lighting: one consistent light from the UPPER LEFT, baked in as flat cel-shaded bands, in this
> order from the left edge of the shaft: a lit band at approximately #4E555F ending about 36% of the
> way across, a mid band at approximately #424954 out to about 74%, and a dark limb at approximately
> #141720 for the remaining right-hand strip. The top surface sits at approximately #5B6472. Keep
> those relationships — a top clearly brighter than the lit band, and a dark right limb doing the
> work of the curve.
>
> Do NOT put a white or light-grey rim highlight anywhere on the top edge or the silhouette: a
> bright rim reads as polished metal or chrome, and this is dull, unpolished dungeon stone. Do NOT
> add a base plinth, a wider flared foot, or a darkened band at the very bottom — the game draws the
> pillar's ground contact itself.
>
> Style: flat cel-shaded 2D mobile-game art, bold clean thin dark outline on the object's silhouette
> and on the stone joints only, flat solid colour fills, minimal gradient. Dark charcoal-navy stone
> throughout, desaturated — this is the same stone as a dark dungeon wall, not concrete, not marble,
> not sandstone, and not grey. COARSE detail only: three courses on the whole shaft and no fine
> speckle, grain or noise, because the sprite is displayed at about 84 x 98 pixels in game and any
> fine pattern turns to colour mush at that size.
>
> No element tint at all in this version — plain dark charcoal-navy stone. This is the default,
> un-themed pillar.

### What the accepted generation needed on top of the prompt

`pillar_neutral_raw.png` is the KEYED result, not the generator's own bytes — the two mechanical
steps below were both necessary, and neither is visible by looking at the image:

1. **It came back with a painted transparency CHECKERBOARD.** 1664x2080, 3.46M opaque pixels,
   **zero** transparent ones: the generator drew the grey-and-white "this is transparent" pattern as
   real pixels. Keyed out by luma (background 233-255 against an object whose brightest plane is
   101 — a huge gap), then one erosion pass over light pixels bordering transparency (972 px), then
   cropped to the object (1307x1541, aspect 0.848 against the 0.857 asked for). Verified with a
   flood fill from the border: **0 interior holes**, and `alpha-audit.mjs` reports the shipped file
   as the only clean PNG in `client/public/biome`.
2. **Its SHAFT was twice as bright as the wall face beside it** — measured live in level 1's gallery
   room at zoom 1: lit limb 71.6 against a wall face's 27.3-27.5, while its top surface was already
   on target (87.3 against wall caps of 72-81). A pillar and a wall are the same stone under the
   same light, and a uniform multiply could not fix it: darkening the shaft would drag the top down
   with it. `tools/png-pipeline/lumaCurve.mjs` (new, and the reason it exists) scales RGB by a factor
   keyed off each pixel's own luma — `--lo=85 --hi=95 --lo-gain=0.68 --hi-gain=1` leaves the top
   surface untouched and pulls the three shaft bands from 84/59/30 down to 57/40/20. On screen after
   `pillarTint`'s own ~0.887 multiply: top **87.3**, lit limb **50.4**, mid **35.8**, dark limb
   **16.7**, foot **25.0**, against a floor of 48.5. **Redo this step if the art is regenerated** —
   `client/src/game/scene/pillarArt.test.ts` measures the shipped file and fails if it is skipped.

Pipeline, in order: `art/biome/pillar_neutral_raw.png` (keyed source of truth, untouched by the
curve) → copy to `client/public/biome/pillar_neutral.png` → `lumaCurve.mjs` → `compress.mjs
--long-axis=384` (326x384 shipped). 384 rather than 256 because `FxController.MAX_ZOOM` is 4.5 and
the renderer runs at up to 2x device pixel ratio: level 1's gallery room actually renders at zoom 4,
so the sprite is MAGNIFIED, not minified, in real play.

### The rejects, and what each one cost

Seven generations, six rejected — all six kept as `pillar_*_alt*.png`. Measured, not judged by eye:

| file | why it was rejected |
|---|---|
| `pillar_neutral_alt.png`, `pillar_neutral_alt2.png`, `pillar_fire_alt2.png`, `pillar_ice_alt.png`, `pillar_lightning_alt.png` | **all generated at exactly 84x98** — the game size, so zero headroom against a 4x camera zoom. This is why the accepted prompt states an output resolution. |
| `pillar_lightning_alt.png` | reads as an **open-topped barrel** — the exact drift the prompt's negative constraint is aimed at, and it still happened at 84x98. |
| `pillar_ice_alt.png` | top surface at luma **125**, the brightest thing in the room by a wide margin — a repeat of the defect design/01's "Volume, measured" pass fixed on 2026-08-19. |
| `pillar_fire_alt2.png` | no warm tint at all (R−B = −14.9 against the neutral's −18.5, i.e. inside the noise), cap only 23% of the height, and the art touched all four frame edges. |
| `pillar_fire_alt.png` | the one real near-miss, and the reason there is no per-element pillar art: it followed the canvas/margin/aspect spec exactly, but its course joints came back **straight** (centre-vs-edge sag of −2 px against the accepted file's +53) and its top surface occupies **21%** of the height against the accepted file's 30% — two files that would ship as two different camera angles. A `Sprite.tint` gets the warmth without either defect. |

## The warm-stone ember swatches (3) — the new direction, 2026-10-10

The ember chapter's three swatches were replaced outright when the environment's direction changed
from "dark, desaturated stone under a game that carries the colour" to the key frame
`art/concept/direction-2026-10-10/4_hybrid_a.png`: **a light warm flagstone floor, a dark grey wall
top, warm brown brick on the face, torches on the walls, dark room edges** (design/13 "Environment:
warm stone, dark edges, light pools"). Two of the first family's tonal rules are inverted on purpose:
the floor is now the lightest stone in the room and the wall top the darkest. So
`biomeSwatchArt.test.ts` measures only the first generation, and `warmStoneArt.test.ts` measures these.

Generated with Mistral (`D:/standing/tools/generate_image.sh <out> <promptfile>`, which returns 1024x768).

### Three things that are new with this family

- **Masters and JPEG.** A painted 512 px stone swatch is ~55 KB as JPEG and several times that as
  PNG, and these ride in the WeChat main package, so `client/public/biome/<key>.jpg` ships (q90).
  Nothing in the test environment decodes JPEG. Every measurement therefore reads the lossless
  `art/biome/<key>_master.png` the JPEG was encoded from, and `warmStoneArt.test.ts` pins the
  JPEG's frame-header size to the master's. **Re-encode from the master, never from the JPEG.**
- **Seamless by construction.** `tools/png-pipeline/makeTileable.mjs` cuts each wrap seam along a
  minimum-error path through the dark mortar both sides share (image quilting, applied to an image
  against itself). The swatch then wraps EXACTLY and is never mirrored on the floor
  (`SwatchMeta.seamless`). A crossfade ghosts the outlines into double lines, and mirror-tiling
  turns irregular flagstones into a kaleidoscope.
- **Graded, not re-rolled.** The model treats a hex colour as a suggestion: a floor asked for at
  #B8A38C came back at median luma 187 with twice the chroma. `tools/png-pipeline/colorGrade.mjs`
  flattens low-frequency drift, desaturates, applies a per-channel gain, and lands the MEDIAN luma
  on a target number. It uses the median so a thin dark mortar tail does not move it.

### `floor_fire` — the accepted prompt (`floor_fire_warm_raw.png`)

> A single seamless TEXTURE SWATCH ONLY, filling the entire image edge to edge, a flat material
> sample meant to be repeated like a game texture tile. NOT a room, NOT a scene, NO perspective, NO
> characters, NO props, NO walls, NO border, NO frame, NO vignette, NO darker corners, NO
> spotlight, lit perfectly evenly from straight above. Straight-down orthographic top view.
> Style: hand-painted 2D cartoon dungeon floor for a polished top-down action RPG, clean and
> readable. Material: FLAT CRACKED FLAGSTONE PAVING laid in a RANDOM CRAZY-PAVING pattern: about 12
> to 16 large flat irregular polygon slabs of different sizes, fitted tightly together, every seam
> is short and changes direction. IMPORTANT: there are NO long straight lines, NO seam runs across
> the whole image, NO grid, NO rows, NO square tiles, NO 2x2 or 4-panel layout. The slabs are FLAT
> with very low relief: no bulging pillow shapes, no thick bevels, no rounded cobbles. Seams are THIN
> dark-brown lines (2-3 px), never wide black gaps. Slab faces are smooth light warm beige-grey
> (around #BDAA92), each slab a slightly different shade, with soft painterly tone and one or two
> thin hairline cracks. Low contrast, calm surface. NO pebbles, NO gravel, NO moss, NO lava, NO glow.

This batch needed the "NO long straight lines / NO 2x2" paragraph. Without it, two of seven
candidates came back as a 2x2 panel grid, and the cross reads as a lattice once the tile repeats.
The first accepted floor was kept as `floor_fire_warm_alt.png`. Its chunky rounded cobbles and wide
black mortar read as busy gravel under the actors, and it was replaced the same day.

Pipeline:

1. Crop `(128, 0, 896, 768)`.
2. `makeTileable.mjs --overlap=0.2 --jump=2` gives 614².
3. `colorGrade.mjs --flatten=0.25 --desat=0.2 --gain=1.02,0.98,1.0 --median=172`.
4. Lanczos to 512, giving `floor_fire_master.png`.
5. Encode JPEG q90.

Density is 2.56 (`biomeTiles.SWATCH_META`): 512 px over 200 world px, so a slab is about two
hero-widths across. At 96 world px per tile the slabs read as cobbles the hero's own size; at 245
they read as paving three heroes across. A `--gain` of 1.06/0.96 read pink in the frame.

### `wall_fire` (top cap) and `wallface_fire` (front elevation)

> Cap: A single seamless TEXTURE SWATCH ONLY [... the floor's framing ...]. Material: the flat TOP of
> a thick castle wall seen from directly above: chunky rectangular dark grey stone blocks in a
> running bond pattern, about 4 blocks across and 5 rows, clean bevelled edges with a lighter
> top-left bevel. Colour: cool-to-neutral dark grey stone (block tops around hex #5A5658 to
> #6A6566), mortar near-black #1E1A1A. NO lava, NO glow, NO moss.

> Face: A flat seamless TEXTURE SWATCH: the vertical FRONT FACE of a stone wall, filling the ENTIRE
> image edge to edge, seen perfectly straight-on, orthographic, completely flat like a scanned
> texture. The wall face is the ONLY thing in the image: NO floor, NO ground, NO side walls, NO
> corners, NO room, NO door, NO torch, NO light source, NO glow, NO spotlight, NO vignette, NO
> border. Lit perfectly evenly. Material: rectangular brown stone bricks in running bond, 6 courses
> tall and about 5 bricks across, each brick slightly different in tone, warm brown stone (brick
> faces hex #7A5A46 to #8E6A52), dark mortar #2A1E18, a few chipped corners. Style: hand-painted 2D
> mobile game texture, clean bold dark-brown outlines on the brick seams only, soft cel shading on
> each brick (slightly lighter top edge, darker bottom edge), polished cartoon fantasy quality.

**Cap pipeline:**

1. Square crop.
2. `makeTileable.mjs`.
3. `colorGrade.mjs --flatten=0.2 --median=75`.
4. Resize to 512 and encode JPEG.

Density is 8: 512 px over one 64 px cap cell.

**Face pipeline:**

1. `makeTileable.mjs --axes=x`. It wraps left-right only, because the top is the coping course and
   the bottom meets the floor.
2. `colorGrade.mjs --flatten=0.2 --gain=1.08,1,0.92 --median=95`.
3. Resize to 512x256 and encode JPEG.

Density is 1: the face is stretched to the wall height. `wallTone.FACE_CROWN_ROWS.fire` is measured
off this master's courses.

The masters, measured:

| swatch | median luma | mean RGB |
|---|---|---|
| floor | 170.7 | 171/149/130 |
| cap | 75.4 | 62/66/69 |
| face | 93.9 | 100/81/60 |

`warmStoneArt.test.ts` does not pin these exact numbers. It holds the masters to the key frame's
rules:

- the floor is light (median luma 150-195) and lighter than the face;
- the cap is under 0.6x the floor;
- the floor is warm beige but not orange (R−B < 60), because the torches are the orange in the frame;
- the cap is cool;
- the brick is warm.

## Workflow reminder

Save accepted generations as `art/biome/<name>_raw.png`. The warm-stone family saves
`<key>_warm_raw.png` plus its graded `<key>_master.png`. Save rejects as `art/biome/<name>_alt.png`,
the same convention as `art/weapon`/`art/ui`.

**Verify tileability, not just style**: the image models have no seamless mode. For a new swatch,
run `tools/png-pipeline/makeTileable.mjs` instead of eyeballing the edges. Use `colorGrade.mjs`
instead of re-rolling for colour (see the warm-stone section above).

The first-generation PNG swatches went through `node tools/png-pipeline/compress.mjs
--long-axis=256 <file>` into `client/public/biome/<name>.png`. The warm-stone family ships JPEG
encoded from its master. `render/biomeTiles.ts`'s asset table names every key's file. A swatch
whose world-px size is not "one texel per px" declares it in `SWATCH_META`.
