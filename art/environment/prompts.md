# Environment art prompts (archive) — in-run drops, and the portal arch

Companion to `art/biome/prompts.md`. That file covers the room's surfaces (floor/wall swatches
and the pillar sprite); this one covers the standalone fixtures that stand *in* a room: the five
in-run drop sprites and the extraction portal's masonry arch, generated 2026-08-20.

Why this batch happened: with walls, floor, doors and pillars all carrying real art, the loudest
remaining placeholders were the things drawn on top of them. `Pickup`/`Portal` were still built
from Pixi `Graphics` — `design/12` recorded them as "never planned as sprite art", a judgement
made when the walls were still flat rectangles and worth re-making once they weren't.

Nine generations, six accepted, three rejected and regenerated. Every rejection was measured
rather than judged by eye; the rejects are kept as `pickup_*_alt.png` and
`client/src/game/scene/environmentArt.test.ts` runs its assertions over them too, so a check that
stops discriminating accepted from rejected art fails rather than passing vacuously.

## The locked framing block (paste as context, EVERY time)

Repeating the framing in every individual prompt is not redundancy — `art/biome/prompts.md`
records that later prompts in a batch drift back toward a scene/perspective rendering when the
framing lives only in a shared preamble.

> Style: flat cel-shaded 2D mobile-game art — bold clean thin dark outline on the object's
> silhouette and on its major internal divisions only, flat solid colour fills, simple hard-edged
> cel shading, minimal gradient, no rendering, no painterly texture. One consistent light from the
> UPPER LEFT baked in as flat bands. COARSE detail only — no fine speckle, grain, noise or
> filigree anywhere.
>
> Framing, and this is not negotiable: this is a single standalone game SPRITE of ONE object on a
> fully TRANSPARENT background. It is NOT a scene, NOT a room, NOT an isometric diorama, NOT a
> texture swatch, NOT a tileable pattern, NOT an icon inside a frame or badge, and NOT a product
> shot. There is no floor or ground under it, no other objects, no characters, no text, no border,
> no background of any kind.
>
> The background must be REAL transparency (alpha = 0). Do NOT draw a grey-and-white checkerboard,
> and do NOT draw any other pattern, swatch or colour to *represent* transparency — a painted
> checkerboard is a defect, not a transparent background.
>
> NO cast shadow, NO contact shadow, NO ground shading and NO baked drop shadow of any kind — the
> game draws every shadow itself on a separate layer, so a baked one doubles up. NO outer glow, NO
> bloom, NO halo and NO light rays around the object — the game draws the glow itself as an
> additive layer, so a baked halo doubles up.
>
> Camera: one fixed camera, looking slightly DOWN at the object from the FRONT. A small top
> surface is visible; the body is seen straight-on below it. No perspective convergence, no
> vanishing point, no rotation, no tilt, no dutch angle. Every sprite in this batch must agree on
> this exact camera — the game has one fixed camera and two files drawn from two angles read as a
> bug.

The anti-checkerboard paragraph is new in this batch and is there because the *pillar* generation
came back with the Photoshop transparency pattern drawn as 3.46M opaque pixels. It worked: all
nine generations here came back with a real alpha channel.

## The drop sprites (5)

Drawn at `ART_LONG_AXIS` = 18 px (`client/src/game/scene/Pickup.ts`), scaled by the long axis so
each file keeps its own aspect. `weapon` is deliberately absent — a weapon drop draws that
weapon's own business-end art (`render/weaponSkins.ts`) so it reads as "that specific gun".

Every prompt states **1024 x 1024** and a 6-pixel transparent margin. That is ~57x the drawn size,
against a worst case of 18 x MAX_ZOOM 4.5 x 2 DPR = 162 device px; the shipped files compress to a
192 px long axis. Asking for art at the drawn size is the one defect that cannot be repaired at
import, and it is what got five of the six first-batch pillar generations rejected.

### `pickup_material` — the run's carry-out currency

> [framing block] A single game SPRITE of one small floating CRYSTAL SHARD cluster — the refined
> crystal a player carries out of a run. Output the image at 1024 x 1024 pixels, with a 6-pixel
> fully transparent margin on all four sides; no part of the object may touch the image edge.
>
> Construction: three or four faceted angular crystal spikes of unequal length growing out of one
> common base, the tallest pointing up and slightly left, the whole cluster roughly as wide as it
> is tall. Hard flat facets with straight edges — this is cut, contained, refined crystal, not a
> rough rock and not a rounded gem. Between 6 and 10 visible facets in TOTAL across the whole
> cluster; any more and it turns to colour mush at the size this is displayed.
>
> This object FLOATS — it never touches the ground. It must therefore have NO base plinth, NO
> rubble, NO dirt, NO socket, NO pedestal and no flat cut-off bottom edge: the underside is
> faceted crystal like every other side.
>
> Colour: warm saturated golden yellow, base fill approximately #F6E05E, lit facets up to about
> #FFF6C2 and shadowed facets down to about #A88A1E, with a thin near-black outline. It must read
> clearly BRIGHTER and MORE SATURATED than a desaturated dark charcoal stone floor, because it is
> the one interactive thing in the frame.
>
> It is displayed at about 14 x 14 pixels in game, so: no engraving, no inner reflections, no
> sparkle stars, no facet-line hatching.

Accepted on the first generation, with two deviations recorded and not chased: the aspect came
back 0.60 rather than the ~1.0 asked for (so it draws 11 x 18, a taller silhouette than the shape
it replaced — an improvement, kept), and it is lit frontally rather than from the upper left
(measured thirds 164 / **193** / 166, brightest in the middle). At 18 px on a gold chip that is
invisible; any future crystal art must agree with the upper-left key light instead.

### `pickup_heal` — regenerated once

The first attempt asked for a "healing VIAL" and got a wide-lidded **jar** — the free-standing-
object drift `art/README.md` warns about, in a new costume. Its top fifth measured luma **50**,
inside the ember floor's own 39-49 band, so a quarter of the object would have read as a hole in
the floor. It also had essentially no cel shading (thirds 139 / 144 / 132). Rejected as
`pickup_heal_alt.png`. The regeneration names the failure modes:

> [framing block] A single game SPRITE of one small floating HEALING FLASK. Output the image at
> 1024 x 1024 pixels, with a 6-pixel fully transparent margin on all four sides.
>
> This is NOT a jar, NOT a mason jar, NOT a tub, NOT a canister, NOT a screw-top pot and NOT a
> bottle with a wide flat lid. It is a small round-bellied glass flask.
>
> Construction, and the proportions are the point: a round bulbous glass belly making up the
> BOTTOM 78% of the object's height, narrowing into a SHORT straight neck above it. The whole
> object is about 0.75 as wide as it is tall. A single thin dark stopper caps the neck, and that
> stopper plus neck together must occupy NO MORE than the top 18% of the object's height — a large
> dark lid is a defect, because at display size it reads as a hole in the floor rather than as
> part of the object.
>
> The belly is filled with glowing green fluid up to a straight flat surface at about 70% of the
> belly's height; the small empty glass above the fluid is a paler, less saturated version of the
> same green.
>
> Lighting, which the last attempt lacked entirely: one light from the UPPER LEFT, baked as flat
> cel bands. The fluid must show three distinct flat tones — a lit left band at approximately
> #A8ECC0, a mid body at approximately #68D391, and a shadowed right limb at approximately
> #2F7A55 — plus ONE small flat highlight shape on the upper-left of the glass. The lit left band
> and the dark right limb must be clearly different, not a subtle gradient.
>
> The stopper is a dark desaturated charcoal, NOT pure black. Thin near-black outline on the
> silhouette and on the neck/stopper joint only.
>
> This object FLOATS — no base, no stand, no rack, no flat cut-off bottom; the belly's underside is
> a closed round curve. Do NOT draw a cross, a plus sign, a heart, a syringe, bubbles, or any
> medical symbol. It is displayed at about 18 x 18 pixels in game.

Result: top band 50 -> **146**, thirds 192 / 177 / **129** (a real upper-left key light), aspect
0.53 -> 0.71. Its neck came back longer than the stated 18% (roughly the top 38%), accepted as
drawn — the thin-stem silhouette reads better at 18 px than the squat version would.

### `pickup_buff` — regenerated once

The first attempt drew the inner arrowhead as an *outline*: measured across the object's middle it
was four opaque runs of <=15.5% of the width, the marks themselves **5.8%** — one pixel at display
size. It measured as a correct shape and disappeared in game. Rejected as `pickup_buff_alt.png`.

> [framing block] A single game SPRITE of one small floating POWER SIGIL. Output the image at
> 1024 x 1024 pixels, with a 6-pixel fully transparent margin on all four sides.
>
> TWO parts only, and they never touch each other:
> 1. An outer open DIAMOND RING (a square rotated 45 degrees), drawn as a ring of constant
>    thickness with a hollow transparent centre. The ring's thickness must be about 9% of the
>    diamond's total width — THIN. It is a slim outline, not a chunky bevelled frame.
> 2. Floating unattached inside the hollow centre, ONE SOLID FILLED upward-pointing arrowhead. It
>    is a solid opaque block of colour — a filled triangle-with-a-notch chevron, NOT an outline,
>    NOT a hollow shape, NOT a thin stroke, NOT a line drawing. Its width is about 55% of the
>    diamond's inner width and its solid body must be at least 18% of the whole image's width
>    thick at its thickest point, because a thin stroke disappears at the size this is displayed.
>
> Flat 2D only: NO extrusion, NO 3D side faces, NO isometric depth, NO thickness on the ring's
> edge. This is a flat emblem seen face-on, lit from the upper left by flat cel bands only.
>
> Colour: ring approximately #D6BCFA, its upper-left limb up to about #F0E4FF, its lower-right limb
> down to about #8E6FC4. The solid inner arrowhead a bright near-white violet, approximately
> #F7F2FF, uniform — a single flat fill with no internal shading, so it stays the brightest solid
> mass in the image.
>
> This object FLOATS — no base, no pedestal, no ground contact. Do NOT add wings, laurels,
> sparkles, streaks, a circular frame, or a second symbol. It is displayed at about 18 x 18 pixels
> in game.

Result: three runs across the middle, `[0.137, 0.274, 0.137]` — a solid arrowhead **27%** of the
width, about 5 px in game, with transparent gaps on both sides proving it never touches the ring.
The ring came back 13.6% thick against the 9% asked for; accepted.

### `pickup_crate` — the unresolved arena crate

> [framing block] A single game SPRITE of one small closed supply CRATE, seen resting closed and
> sealed. Output the image at 1024 x 1024 pixels, with a 6-pixel fully transparent margin on all
> four sides.
>
> Construction: a cube-ish crate showing its front face and a shallow visible TOP face (the top
> face's height about 30% of the object's total height, matching the slightly-downward camera),
> plus a narrow darker right-hand side face doing the work of the corner. On the front face, two
> horizontal metal strap bands and a small flat central latch plate. The lid is CLOSED and flush —
> no gap, no opening, no light leaking out, no visible contents.
>
> NO base, NO ground plate, NO dirt, NO rubble around it, and no flat shadow under it.
>
> Colour: cool desaturated slate grey — front face approximately #A0AEC0, top face brighter at
> about #C3CDD9 (it faces the sky and must stay the brightest plane in the image), right side face
> down at about #5A6472, straps and latch near-black charcoal. Thin near-black outline on the
> silhouette and on the face folds and straps only.
>
> Do NOT add a question mark, a logo, stencilled text, numbers, a rarity colour, or any glow — this
> crate is deliberately anonymous, its contents unknown. It is displayed at about 14 x 14 pixels in
> game, so: two straps and one latch, no plank lines, no rivet rows, no wood grain.

Accepted on the first generation. Its top face measures **168** against a front face of 118 — the
sky-facing rule holds, which is worth stating because looking at the file suggested the two were
the same value and the measurement said otherwise. One deviation accepted: the box is drawn as a
three-quarter isometric solid receding to the upper right, not the straight-on-front-with-a-shallow-
top-band camera every other fixture uses. At 14 px it is not readable as an inconsistency; a
stricter pass would regenerate it.

### `pickup_bandage` — regenerated once, and the reject is the interesting one

The first attempt followed the prompt exactly and produced **an eye**: a circular end-on roll, two
concentric wound lines, and a solid black centre hole. In a game whose hero, every critter and the
boss are all single-eyed, a pale disc with a dark middle lying on the floor is a fiction-breaking
read. Nothing in the prompt was wrong; the prompt had asked for the wrong *shape*. Rejected as
`pickup_bandage_alt.png`, and the regeneration changes the object rather than the wording:

> [framing block] A single game SPRITE of one small floating rolled BANDAGE, seen from the SIDE.
> Output the image at 1024 x 1024 pixels, with a 6-pixel fully transparent margin on all four
> sides.
>
> CRITICAL — what this must NOT look like: it must NOT read as an eye. Do NOT draw a circular
> end-on face, do NOT draw concentric rings, and do NOT draw a dark round pupil-like hole at the
> centre. Every character in this game is a single-eyed creature, so a pale disc with a dark centre
> is a fiction-breaking mistake, not a stylistic choice.
>
> Construction instead: a short cloth roll lying on its SIDE, so its silhouette is a wide
> horizontal rounded-rectangle CAPSULE about 1.5 times as wide as it is tall, with the roll's axis
> running left-to-right. Across the capsule's face, three or four gently curved WRAP LINES run
> vertically (following the roll's curvature, top to bottom), showing the cloth wound around it. On
> the right end, a short loose cloth tail lifts up and away and ends in one soft fold — a small
> tail, occupying under 25% of the object's width, not a large spiral.
>
> Lighting: one light from the UPPER LEFT as flat cel bands — a lit upper-left band at approximately
> #FFFBF0, a mid cloth body at approximately #EDE6D6, and a shadowed lower-right band at
> approximately #A99B82. Thin near-black outline on the silhouette and on the wrap lines only.
>
> Colour accent: the loose tail's end is filled SOLID with approximately #68D391 across its whole
> visible area — a solid green tip, not a thin stripe, because a thin stripe is sub-pixel at display
> size. That solid green tip is what marks this as a "restore" item.
>
> Do NOT draw a cross, a plus sign, blood, gauze mesh or weave texture. It is displayed at about
> 16 x 16 pixels in game.

Result: aspect 0.93 -> **1.92**, which is the property that makes the eye read impossible and is
therefore what `environmentArt.test.ts` asserts (a silhouette check, not a "does it have a dark
centre" check — the reject's black dot averaged away under any centre patch big enough to be
robust). It draws 18 x 9. Weakest of the six: its shading reads as top-lit rather than upper-left
(thirds differ by only 7%), and the green came back at `#82d877`, yellower than the `#68D391` asked
for.

## `portal_arch` — the extraction gate's structure

Only the STRUCTURE is art. The ground bloom, the two counter-rotating ring of arcs, the bright core
and the infalling motes stay program-drawn in `Portal.ts`, because they animate every frame — a
split a single flattened raster cannot make. This is also why the arch is authored as NEUTRAL stone
with COLOURLESS crystal: one `Sprite.tint` could not tint the shards without tinting the masonry
too, so the checkpoint's green comes from the code-drawn layers instead.

> [framing block] A single game SPRITE of one standing stone GATEWAY ARCH — an empty doorway-shaped
> ring of stone that a portal's energy will later be drawn inside by the game. Output the image at
> 1024 x 960 pixels, with an 8-pixel fully transparent margin on all four sides.
>
> Construction: a single closed ARCH RING standing upright on the ground — a rounded-topped arch of
> stone blocks, its two legs coming straight down to the ground and ending flat where they meet it.
> The ring's stone thickness is about 12% of the arch's outer width. The opening inside the ring is
> COMPLETELY EMPTY and fully transparent — no fill, no membrane, no swirl, no light, no fog, no
> gate, no doors, no portal surface of any kind inside it. The game draws all of that itself;
> anything painted inside the opening will double up with it.
>
> Proportions, which matter because the game draws this at a fixed size: the whole object is about
> 1.07 as wide as it is tall, and it stands with its two feet flat on the bottom edge of the
> transparent margin (this sprite is anchored at its bottom centre, so the ground line is the
> bottom of the object).
>
> Construction detail: nine to eleven visible stone voussoir blocks around the ring, separated by
> single dark joint lines that run RADIALLY (pointing at the arch's centre), never parallel to the
> ring. On the inner edge of the ring, three or four small angular CRYSTAL shards grow inward out
> of the stone, unequal in size, largest near the top left — they must stay small, occupying under
> 15% of the opening's width each, and must not bridge across the opening.
>
> Colour: the same dull unpolished dark charcoal-navy dungeon stone as a dungeon wall —
> desaturated, not grey concrete, not marble, not sandstone. Lit upper-left blocks at approximately
> #4E555F, mid blocks about #424954, the lower-right limb of the ring down to about #141720. The
> crystal shards are a pale NEUTRAL near-white with the faintest cool cast, approximately #DCE4EC —
> deliberately colourless, because the game tints them to the checkpoint's own colour at runtime;
> do not make them green, blue, purple or any other hue.
>
> Do NOT add a plinth, steps, a wider flared base, a keystone ornament, carvings, runes, glyphs,
> chains, banners, torches, braziers, vines, or any light source. Do NOT put a white or light rim
> highlight along the silhouette — a bright rim reads as chrome, and this is dull stone. It is
> displayed at about 60 x 56 pixels in game, so: eleven blocks and four shards is the entire detail
> budget.

Accepted on the first generation. Aspect came back **1.069** against the 1.07 asked for and the
code's own 1.0698 (`archW * 2 / archH`) — near-exact, which is what lets it drop in with no
re-tuning. Opening genuinely empty (50% of the file is transparent). Two things it needed on top of
the prompt, both recorded below.

## What the accepted generations needed on top of the prompt

1. **`.webp` -> `.png`.** Every generation arrived as WebP, which `tools/png-pipeline/pngCodec.mjs`
   cannot read. Decoded losslessly with Pillow (`python -c "from PIL import Image"`, webp support
   confirmed via `features.check('webp')`) as the only step outside the repo's own pipeline, then
   renamed from the generator's UUIDs to `<id>_raw.png` per `art/README.md`.
2. **The arch's stone was 2.4x too bright.** Its whole mass sat at a mid band of **65** against the
   live wall face's 27.3 — the same "right on one surface, wrong on another" fold the pillar needed,
   and the reason `tools/png-pipeline/lumaCurve.mjs` exists. A uniform multiply would have dragged
   the crystal shards down with it, so the curve is luma-keyed:
   `--lo=100 --hi=170 --lo-gain=0.62 --hi-gain=1`. Result: stone-only p10/p50/p90 went
   28.9/60.7/75.7 -> **19.0/37.6/47.1** (the pillar's family: lit limb 50.4, mid 35.8, dark 16.7),
   thirds 42.0 / 50.6 / 30.8, legs 23.8 against a wall face of 27.3 — while the shards stayed
   untouched at a mean of **204**. Nothing but a measurement of the file can tell whether this step
   was run, which is what `environmentArt.test.ts` is for.
3. **Nothing else.** No keying, no defringing, no alpha repair: `alpha-audit.mjs` reports all six
   clean on the first run.

## Pipeline, in order

```
art/environment/<id>_raw.png                       # keyed source of truth, never edited again
  -> cp to client/public/environment/<id>.png
  -> lumaCurve.mjs --lo=100 --hi=170 --lo-gain=0.62 --hi-gain=1   # portal_arch ONLY
  -> compress.mjs --long-axis=192                  # the five drops (trims the bbox too)
  -> compress.mjs --long-axis=576                  # portal_arch (60 px x 4.5 zoom x 2 DPR = 540)
  -> alpha-audit.mjs client/public/environment      # expect 7/8 clean; see the note below
```

`compress.mjs` trims the alpha bbox as well as downsampling, which matters here: `Pickup` and
`Portal` scale by the TEXTURE's dimensions, so untrimmed margin silently shrinks the object on
screen by however much empty space the generator left (up to 44% on this batch's rejects).

## The second drop batch (4), 2026-10-01 — coin, energy, shield, emp

Why: an audit of every Graphics-drawn visual in the client found these four were the only drop
kinds a player meets in an ordinary run that still had NO art at all — the coin especially, since
it drops from every kill once shops exist. Same framing block, same 1024 x 1024 + 6 px margin,
colours taken from `THEME.colors.pickup*` so the additive glow behind each sprite still matches.
Four generations, four accepted; none regenerated.

Each prompt named its specific failure modes up front rather than waiting to be bitten:

- **`pickup_coin`** — a coin's natural shape is a disc, and the bandage reject above proved a pale
  disc with a dark centre reads as an eye in this game. So: ONE thick coin tilted back ~35 degrees
  (a wide ellipse with its reeded EDGE showing as a darker band along the bottom), a raised rim, and
  a solid four-pointed star at the centre that is the BRIGHTEST part of the face — "do NOT draw a
  dark hole, a dark dot, a dark ring, a square hole or concentric rings at the centre". Also "no
  facets, no spikes", because coin and material share the warm band (`#FFC94A` vs `#F6E05E`) and
  must differ in form. Face `#FFE9A8 / #FFC94A / #D99A1E`, edge `#A8701A`, star `#FFF3C4`.
- **`pickup_energy`** — an upright glass CAPSULE (0.6 wide), dark metal cap bands on the top and
  bottom 14%, teal fill `#A6F3EC / #4FD1C5 / #1F7A72`, and a SOLID filled near-white bolt at least 22%
  of the width thick (the buff reject's outline-arrowhead lesson). A cell, so it never shares a
  silhouette with the material crystal or the shield.
- **`pickup_shield`** — a flat face-on heater shield (0.82 wide), a raised border 11% thick, the face
  split by one vertical line into a lit `#76E4F7` and a shadowed `#2E9DB5` half (that split IS the
  cel shading), and a SOLID near-white upward chevron. Explicitly "NO extrusion, NO 3D side faces",
  since shield and energy are both cyan-family and have to be told apart by form.
- **`pickup_emp`** — a squat round dark-gunmetal grenade (`#6B7685 / #444C58 / #1E232B`), one thick
  glowing `#FFF176` equatorial band with three dark notches, a fuse cap and lever on top; "the body
  must NOT be pure black — the bright band must be the dominant read". No lightning, no hazard sign.

Results, trimmed: coin **192 x 140** (aspect 1.37 against 1.35 asked — the tilt landed, and its
centre patch measures well above its own mean, which `environmentArt.test.ts` now asserts), energy
88 x 192, shield 177 x 192, emp 183 x 192. All four lit from the upper left as asked.

### What these four needed on top of the prompt

1. **WebP -> PNG**, as before (Pillow, lossless), and the generator's UUID names replaced with
   `pickup_<kind>_raw.png`. The UUID's trailing segment is base64 of the generator's own output path
   (`.../gold_coin_sprite_1024`), which is how the four were told apart without opening them.
2. **The alpha veil `alphaClamp.mjs` exists for.** Every file carried a sheet of alpha 1-8 over the
   WHOLE canvas: the `alpha > 0` bbox of the coin was 874 x 996 against a real object of 565 x 411.
   Trimmed as-is, the coin would have drawn at less than half its size. `alphaClamp.mjs` (floor 8)
   brought every bbox onto its `alpha > 8` measurement exactly.
3. **Two dark bands sank into the floor — the heal reject's failure, caught by its test.** The emp's
   lower fifth measured luma **49.5**, inside the floor's own 39-49 band (the grenade's body vanished
   at display size, leaving a floating yellow stripe), and the energy cell's dark caps put its top
   band at 67.6 against the 69 bar. Fixed offline with a luma-keyed LIFT, the inverse of the
   arch's darkening: `lumaCurve.mjs --lo=90 --hi=150 --lo-gain=1.6` (emp) / `--lo-gain=1.35`
   (energy), `--hi-gain=1`, so the bright band, the bolt and the near-black outlines are untouched
   (an outline at ~20 lifted 1.6x is still an outline). Bands after: emp 131 / 154 / **79**, energy
   **105** / 180 / 88.

Pipeline for this batch:

```
art/environment/pickup_<kind>_raw.png
  -> cp to client/public/environment/pickup_<kind>.png
  -> alphaClamp.mjs                                              # all four (default floor 8)
  -> lumaCurve.mjs --lo=90 --hi=150 --lo-gain=1.6 --hi-gain=1    # emp ONLY
  -> lumaCurve.mjs --lo=90 --hi=150 --lo-gain=1.35 --hi-gain=1   # energy ONLY
  -> compress.mjs --long-axis=192
  -> alpha-audit.mjs client/public/environment
```

Still drawn, deliberately not in this batch: `schematic` (at most one per run) and `character`
(boss-only). Both slot in the same way — a file plus one `ENV_SPRITE_ASSETS` row.

## Standing finding, not fixed here

`alpha-audit.mjs` flags **`client/public/environment/door_open_raw.png`** as HAZE: 44.7% partial
alpha with a 15.4% midtone cluster. That is a pre-existing shipped file from the 2026-08-04 door
pass, unrelated to this batch, and the audit has apparently never been run over that directory
before. Flagged, not touched.

## Workflow reminder

The order that works, and the order this batch followed: state the output resolution and derive it
from `FxController.MAX_ZOOM` (4.5) x DPR (2) x the drawn size, never from the drawn size itself —
decode the alpha channel before trusting any claim about transparency — then measure the file
against the live in-frame numbers (floor 39-49, wall face 27.3-27.5, wall cap 72-88) rather than
looking at it. Then composite the sprite at its real drawn size over the real floor swatch and look
at THAT: it is the only step that catches a one-pixel arrowhead or an accidental eye, and both of
this batch's regenerations came from it.
