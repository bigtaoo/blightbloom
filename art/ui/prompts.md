# UI icon prompts (archive)

Prompts for the remaining button icons (2026-08 pass — LoginScreen/PauseMenu/PartyScreen/
Forge, closing out the icon gap the 2026-08-01 Main Menu/Forge pass left open). Generated
with **GPT Image 2**. Style matches the 6 already-shipped icons (`icon_play`/`icon_squad`/
`icon_account`/`icon_settings`/`icon_result_extract`/`icon_result_wiped`) — bold black
outline, flat cel-shaded badge shape, a glowing bright cyan-white "purified crystal" light
as the signature accent (this is the game's neutral UI-glow convention, distinct from the
five reserved combat-element hues in `design/13`).

## Locked icon style, in one paragraph (paste as context)

Flat cel-shaded 2D mobile-game UI icon, bold clean black outline, simple flat colour fills
with soft cel shading, a glowing bright cyan-white crystal light accent (the game's
"purified crystal" motif — NOT any combat element colour), badge/icon scale (reads clearly
at 32-48px on a dark background), deliberately FLAT like a modern mobile game icon, NOT
painterly, NOT 3D rendered, no gradients beyond a simple two-tone cel shadow, no text or
letters anywhere in the image, plain transparent background, centered composition with
even padding on all sides, a SINGLE icon only (not a sheet or grid).

## Reuse decisions (no new art needed)

Several buttons intentionally reuse an existing icon rather than getting a new one —
cheap, and the semantic overlap is real:
- `icon_account` → LoginScreen's LOGIN button (same "enter your account" action as
  MainMenu's LOGIN/account entry).
- `icon_settings` → PauseMenu's SETTINGS button (identical action to MainMenu's).
- `icon_play` → PauseMenu's RESUME, PartyScreen's START MATCHING, Forge's START RUN — all
  three are "go/begin" actions in different contexts; one glyph reads fine in all three.

## New icons to generate

### 1. `icon_register` — LoginScreen REGISTER
> A hexagonal badge (same silhouette shape as the shipped `icon_account` eye badge),
> containing a small simplified crystal-core creature silhouette (a round smooth shell,
> single eye) with a glowing cyan-white "+" plus symbol floating beside it, signifying
> creating a brand new account/character slot.

### 2. `icon_password` — LoginScreen CHANGE PASSWORD
> A padlock shape built from the same white-and-silver tech material as the shipped
> `icon_settings` gear, with a glowing cyan-white crystal shard as the keyhole, small
> rivets/panel-lines for detail.

### 3. `icon_logout` — LoginScreen LOG OUT
> A simple rounded doorway/archway shape in white-and-silver tech material, with a glowing
> cyan-white arrow pointing OUT through the doorway, signifying leaving/exiting.

### 4. `icon_back` — shared BACK button (LoginScreen, PartyScreen)
> A simple rounded left-pointing chevron/arrow icon, white-and-silver tech material with a
> thin glowing cyan-white outline trim, generic back-navigation glyph, no other elements.

### 5. `icon_quit` — PauseMenu QUIT TO FORGE
> A small stone anvil silhouette (matching the "forge/outpost" theme already established
> by `hub_bg`'s warm stone palette) with a glowing cyan-white crystal spark/ember hovering
> just above it, signifying returning to the forge outpost.

### 6. `icon_party_create` — PartyScreen CREATE PARTY
> Three small round crystal-core creatures floating together in a loose triangle (same
> trio pose as the shipped `icon_squad`), with a small glowing cyan-white "+" plus badge
> overlapping the group, signifying starting a brand new squad.

### 7. `icon_party_join` — PartyScreen JOIN WITH CODE
> Two small round crystal-core creatures connected by a glowing cyan-white energy
> tether/link between them (the same tether visual language the hero's orbiting weapon
> modules use), signifying linking up with an existing squad via a code.

### 8. `icon_party_leave` — PartyScreen LEAVE PARTY
> A single small round crystal-core creature (same style as `icon_squad`'s trio, just one)
> with a glowing cyan-white arrow pointing away from it toward the edge of the frame,
> signifying leaving/exiting a group.

### 9. `icon_clear` — Forge CLEAR LOADOUT
> An empty rounded socket/mount shape (the universal weapon-mount socket from the game's
> established weapon lore — a simple round connector ring, no weapon plugged in), with a
> faint glowing cyan-white "reset" swirl/arrow beside it, signifying clearing an equipped
> loadout back to empty.

## Workflow reminder

Save accepted generations as `art/ui/<name>_raw.png`, rejects as `art/ui/<name>_alt.png`
(matching `art/weapon`'s and the earlier `art/ui` batch's naming). After judging: decode
with `tools/png-pipeline/pngCodec.mjs`'s `decodePNG` to confirm real alpha (don't trust an
image viewer's compositing), then `node tools/png-pipeline/compress.mjs --long-axis=256
<file>` and drop the result into `client/public/ui/<name>.png`. `render/uiSkins.ts`'s
`UI_ASSETS` table already has all 9 keys wired — no code change needed once the file lands
at the expected path.

# Floor-card icons (2026-09-21 pass)

One icon per entry in `engine/balance/floorCards.ts` — the seven upgrades the checkpoint
offers three of (`ui/FloorCardPrompt.ts`). Same generator (**GPT Image 2**) and the same
locked style paragraph above; what is different is the FRAME, so read the two extra
constraints in the next section before generating.

A card is 150x96 px and its text now wraps to fill it, so these icons are the one thing on
the card that has to say what the upgrade is before the sentence is read. Two of the seven
(`potion_flow`, `windfall`) change the run's drops rather than a player stat, and that
distinction is worth carrying in the art: the drop cards show the THING that drops, the
stat cards show the hero's own gear reacting.

## Extra constraints for this batch (paste alongside the locked style paragraph)

SQUARE composition on a transparent background, the subject centred and filling roughly
80% of the frame with even padding on all four sides — these sit in a square chip on a
small card, not in a wide button, so a subject drawn off-centre or bled to one edge cannot
be salvaged by the layout. It must still read at 44px: one silhouette, one accent, no
scene, no ground plane, no background elements, no border/frame/ring around the icon
(the card draws its own). No text, letters, numerals or percent signs anywhere — the
number is drawn by the UI from the catalogue and a baked-in "+50%" would be a second copy
of a balance value in an image nobody re-generates when it is retuned.

Colour: the game's neutral cyan-white "purified crystal" UI glow as the accent, as in the
shipped button icons. Deliberately NOT any of the five reserved combat-element hues
(`design/13`: fire `#FF7043`, ice `#81D4FA`, lightning `#FFF176`, poison green, physical
neutral) — a damage icon glowing fire-orange would read as an element these cards do not
grant. The two exceptions are the objects that already own a colour in the world and would
be unrecognisable without it: the health potion's red-pink fluid and the coin's gold.

## The seven icons

### 1. `icon_card_potion_flow` — Vital Flow (potions drop 2x as often)
> A small round-bellied glass vial with a cork stopper, filled with glowing red-pink
> healing fluid, tilted slightly and pouring one bright droplet; two smaller vials behind
> it at half scale to read as "more of them", arranged in a loose triangle. A faint
> cyan-white crystal sparkle where the droplet leaves the lip.

### 2. `icon_card_windfall` — Windfall (coins are worth 2x)
> A stack of three thick round gold coins seen at a slight angle, the top coin lifting off
> the stack and catching the light, with two more coins tumbling above it. A cyan-white
> crystal glint on the top coin's rim. No numerals or currency symbols stamped on the
> coins — a plain crystal-facet motif on the face instead.

### 3. `icon_card_edge` — Edge (+damage)
> A single angular blade-shard of dark tech material seen edge-on, its cutting edge
> running with a hot cyan-white crystal light, with two short impact chevrons breaking off
> the tip. Weapon-agnostic: a shard, not a recognisable sword or gun — this card buffs
> every weapon in the run.

### 4. `icon_card_cadence` — Cadence (+fire rate)
> Three cyan-white energy bolts in flight, stacked in a tight diagonal row with short
> speed-streak tails behind them, the leading bolt brightest. Reads as rhythm and repeat
> rate; no weapon in frame, no muzzle, no target.

### 5. `icon_card_bulwark` — Bulwark (+max HP)
> A rounded heraldic shield plate in white-and-silver tech material with a simple panel
> seam down the middle, and a small solid crystal core set into its centre radiating a
> soft cyan-white glow outward. Solid plate, NOT a hollow outline or a ring — this
> generator drifts toward rings when asked for a badge shape.

### 6. `icon_card_precision` — Precision (+crit chance)
> A simple four-point reticle of thin white-and-silver brackets around a single small
> cyan-white crystal shard at dead centre, one bright spark flaring off the shard's upper
> right to signal the critical hit. No circle, no crosshair ring, no scope body.

### 7. `icon_card_capacitor` — Capacitor (+max energy)
> An upright rounded battery cell in white-and-silver tech material with a cyan-white
> crystal core visible through a window in its casing, filled to the brim so the light
> spills past the top cap, and a small crystal shard fused to its side. Energy storage,
> not a lightning bolt — the bolt glyph belongs to the lightning element this doc reserves.

## What shipped, and what was rejected (2026-09-21)

Twelve generations came back for the seven slots. Kept, as `icon_card_<id>_raw.png`; the five
rejects are in `leftovers/` as `icon_card_<id>_alt_*.webp`, unconverted.

| card | kept | rejected, and why |
| --- | --- | --- |
| `potion_flow` | the three-vial pour | — (single candidate) |
| `windfall` | the coin stack | — |
| `edge` | the 2026-09-22 re-roll (see below) | **a** and **b** — both near-black bodies on a near-black card; `b` shipped for a day and was replaced |
| `cadence` | the three bolts | — |
| `bulwark` | shield **b** | **a** — softer, panel-lined, and its crystal core is a low-contrast inset; `b`'s outlined core holds at icon size |
| `precision` | reticle **a** | **b** — brackets pushed out to the frame corners and a smaller crystal, so it reads as four unrelated marks once it is small |
| `capacitor` | cell **02** | **01** (the spill over the cap reads as foam), **03** (a busier grey chassis crowding the window) |

**The alpha was the documented two-plateau case, both ends.** Decoded rather than eyeballed
(`pngCodec.mjs`): every file had 0.0% fully-opaque pixels (body at 252-253) AND a 0.17-0.98%
veil at alpha 1-15 spreading to all four edges, which a bbox trim would have taken for object.
`alphaClamp.mjs` then `compress.mjs` is exactly the pair that fixes it, in that order — after
the clamp the trimmed boxes matched the boxes measured at alpha>=16 on the originals.

## Workflow for this batch

`art/ui/icon_card_<id>_raw.png` (1920x1920, converted from the generator's WebP), then:

```
node tools/png-pipeline/alphaClamp.mjs client/public/ui/icon_card_*.png
node tools/png-pipeline/compress.mjs --long-axis=128 client/public/ui/icon_card_*.png
```

**128, not the 256 the batch above documents** — every icon already shipped in
`client/public/ui/` is 128 on its long axis, and these draw at ~43px. 256 would have been
108 KB of art at 264 KB, in the LOBBY phase, which is the boot download.

Wired, so nothing is pending: the seven keys are in `render/uiSkins.ts`, `FloorCardPrompt`
looks each one up as `icon_card_${id}` straight off the offer, and `Button.setIcon`'s new
`'top'` placement puts the icon above the label instead of beside it (the card grew 96 -> 108
to hold both). A card with no art still draws as text alone; `uiSkins.test.ts` gates that
every id in `FLOOR_CARDS` has a key, so a new card cannot quietly ship iconless.

## `edge`, re-rolled (2026-09-22)

The first two generations were both a near-black shard on a near-black card, and the fix was
NOT a brighter glow — a glow is an edge, and an edge is what was already carrying the whole
icon. What was missing was a BODY. The re-roll names the body's values in the prompt
(`#d7dbe4` lit face, `#8a93a3` shadow face) and tells the generator what it will sit on
(`#2d2a42`, at 43px), rather than asking for "lighter".

Measured against that card fill, over solid (alpha >= 250) pixels only:

| | median body contrast | solid pixels DARKER than the card |
| --- | --- | --- |
| old (`leftovers/icon_card_edge_alt_b.png`) | **1.27:1** | **59.1%** |
| shipped (`icon_card_edge_raw.png`) | **9.09:1** | 15.5% (the black outline, which is ink) |

1.27:1 is the number worth remembering: over half the old icon's solid art was darker than
the background it was drawn on, which is why only its lit edge survived. Judge a dark-on-dark
icon this way rather than by eye — a generation viewed on the white background it was made
against always looks fine.

# The lobby redesign (2026-09-27 pass)

Nine images for the redesigned lobby (design/10 "The lobby, redesigned"): the painting, two
logos, one portrait per playable character and three route-card banners. Generated with GPT
Image 2; every prompt carries the full style and composition brief on its own, so a batch
cannot drift. The crystal glow, rising motes and the column's vignette are drawn in code and
needed no art.

## `lobby_bg` — the painting (2560x1440, opaque)

```
A wide 16:9 background illustration for a mobile/web game lobby screen, 2560x1440.

STYLE: flat-cel 2D game art — bold clean dark outlines, flat solid colour fills, simple two-tone cel shadows, minimal texture, strong readable shapes. Like a modern stylised mobile game's key art, NOT painterly, NOT a 3D render, NOT isometric. Camera: a slightly elevated front view with gentle perspective.

SCENE: a floating stone outpost platform drifting in an open sky — a circular plaza of worn, pale warm-grey stone with carved rings, the edges breaking into floating rock chunks below. In the plaza's centre sits a round raised dais ringed with softly glowing cyan-white crystal inlays: the mouth of the descent shaft, a calm glowing opening. On the far LEFT, a cosy forge workshop built into a rock outcrop: a canvas awning, an anvil, a hanging crystal lantern, pipes and a round hatch door. On the far right, only distant, low-contrast silhouettes of another floating rock and a thin crane tower, fading into haze. Small pale cyan-white crystals grow from the stonework here and there. A few small rocks float in the sky.

COMPOSITION (strict — UI is placed on top of this image):
- The central dais is centred at about 38% of the image width and 68% of its height. It is the brightest, most focused point in the image, with clear empty space directly above it (a character will float there).
- The right 35% of the image is calm and low-detail: soft sky, haze and the distant silhouettes only. No strong edges, no bright spots, no structures in the foreground there.
- The top-centre is open sky with no detail (a logo goes there). The top-left and top-right corners are simple sky.
- Keep every important element between 12% and 88% of the image height, because wide screens crop the top and bottom.

LIGHT AND COLOUR: bright, clear, mid-to-high key daylight — a warm late-afternoon sun from the upper left, a soft light blue-grey sky with warm haze near the horizon. Overall brightness is mid-tone to light: NOT dark, NOT night, NOT gloomy, NOT moody. The stone and environment are low-saturation warm neutrals (beige, warm grey, sand). The only saturated accent is the cyan-white crystal glow. Do NOT use green, red, orange-fire or purple anywhere as an accent colour.

No characters, no creatures, no text, no letters, no logo, no UI, no frame or border.
```

Accepted first try, mean luma 197. **The dais landed at 33%/72%, not the 38%/68% asked for** —
the code follows the painting (`LobbyBackdrop.DAIS_U`/`DAIS_V`), per the standing rule that a
stated composition is a request, not a spec.

## `lobby_logo_en` / `lobby_logo_zh` (2048x640, transparent)

```
A game logo wordmark reading exactly "BLIGHTBLOOM" — one word, eleven letters, spelled B-L-I-G-H-T-B-L-O-O-M. No other text.

STYLE: flat-cel 2D game logo — chunky, bold, slightly rounded display letters that look carved from pale warm-grey stone, with a thick clean dark outline around the whole word and simple two-tone cel shading. Small bright cyan-white crystal clusters "bloom" out of the letters — sprouting from the top of the two O's and from the tip of the T — and a few thin dark cracks run through the stone, hinting at blight. Flat and graphic like a modern mobile game logo, NOT a 3D render, NOT a metallic bevel, NOT painterly. No gradients beyond the two-tone cel shade.

Horizontal layout, the word centred with even padding on all sides, about 2048x640. It must stay legible at 400px wide over a light sky background.

Background: REAL transparency (alpha = 0) around the logo. Do NOT draw a grey-and-white checkerboard or any other pattern to represent transparency; a painted checkerboard is a defect. No backdrop, no banner, no shadow plate behind the word.
```

The Chinese logo is the same brief with the first paragraph naming the two characters of the
game's Chinese title (left to right, "no pinyin, no English"), the crystals asked for from the three
"sun" components of the second character, and one added sentence: "Both characters must be
written correctly and fully legible, with no extra or missing strokes." Both accepted first
try; every letter and stroke was checked by eye at full size.

## `lobby_hero_*` — portraits (1024x1024, transparent)

One template, `<NAME>` = `the Orb Core` / `the Juggernaut Core` / `the Skirmisher Core`, with
the character's rig art attached as the reference:

```
Using the attached reference image as the EXACT character design, draw this same character as a large, high-resolution showcase illustration for a game lobby. Keep its shape, proportions, colours, markings, eye and crystal belly chamber identical to the reference; do not redesign it, and do not add any accessories that are not in the reference.

Character: <NAME>, a small hovering spherical crystal-core creature. It has no arms and no legs, and it floats in the air.

POSE: hovering, turned in a three-quarter view angled slightly toward the RIGHT of the frame, looking confident and friendly, with its single large eye bright and alert. The crystal in its belly chamber glows cyan-white.

STYLE: flat-cel 2D game art — bold clean dark outline, flat solid colour fills, simple two-tone cel shadows, minimal internal detail, a strong readable silhouette. Flat like a modern mobile game character, NOT painterly, NOT a 3D render. Lit by warm light from the upper left.

Do NOT draw any weapons, tethers, energy arcs, ground, ground shadow, platform, glow halo, background scenery or text.

Centred with about 10% empty margin on every side, 1024x1024.
Background: REAL transparency (alpha = 0). Do NOT draw a grey-and-white checkerboard or any other pattern to represent transparency; a painted checkerboard is a defect.
```

All three accepted first try (they came back 1254x1254). **Use these portraits, not
`skins/<id>/shell.png`, as the reference for any future image of our characters**: the rig's eye
is a separate bone, so `shell.png` has an EMPTY eye socket, and the generator faithfully drew
blank grey eyes from it (`lobby_card_coop_alt2.png` is that rejection).

## `lobby_card_*` — route banners (1536x512, opaque)

```
A wide 3:1 banner illustration used as the background art of a game menu button, 1536x512.

STYLE: flat-cel 2D game art — bold clean dark outlines, flat colour fills, simple two-tone cel shadows, minimal texture. NOT painterly, NOT a 3D render.

LAYOUT (strict): the left 40% of the banner is a calm, simple, low-detail area of soft dark-to-mid tone (a label is placed there), with no objects or bright spots. All the subject matter sits in the right 60%.

SUBJECT: <SUBJECT>

COLOUR: warm, low-saturation stone neutrals, with bright cyan-white crystal light as the only strong accent. Mid-tone overall brightness, not dark.

No text, no letters, no UI, no frame, no border, no rounded corners. The image fills the whole canvas edge to edge.
```

- **descend** — *Looking down into a deep circular stone shaft that spirals downward, ringed with
  glowing cyan-white crystals that get brighter toward the depths, with floating rock fragments
  drifting down into it — a feeling of an inviting descent.* Accepted (left luma 78).
- **pvp** — *Two small hovering spherical crystal-core creatures (round shells, a single large eye
  each, no arms or legs) facing each other from the two sides of the right area, with a bright
  spark burst of crystal shards clashing between them, over a stone arena floor.* Accepted with a
  caveat: generic creatures and a left luma of ~128, which `LobbyCard`'s left-to-right legibility
  shade covers.
- **coop** — the first generation (`lobby_card_coop_alt.png`: a flat tan field at luma 128 with
  generic creatures) was rejected. The re-roll that shipped attached two character references
  and asked for the left 40% to be "a calm, simple, DARK area (a deep blue-grey sky fading into
  shadow)" with "real depth and value variation — NOT a single flat colour": it landed at left
  luma 31. It drew the same character twice where two different ones were asked for, which is
  fine for "two teammates". To get two DIFFERENT characters, name them by position: *"the LEFT
  character is the first reference image, the RIGHT character is the second reference image ...
  do not draw the same character twice."*

## Workflow for this batch

WebP to lossless PNG raws with Pillow (`art/ui/lobby_*_raw.png`, rejected ones as `_alt*`), then:

- **portraits and logos** — drop alpha components that are not the body (the Skirmisher came
  with ~61k faint haze pixels far from it), clamp alpha (floor 8 / ceiling 250, the
  `alphaClamp.mjs` defaults), then `compress.mjs --long-axis=384` (portraits) or
  `--long-axis=768` (logos). Both trim; none of it is rig art, so trimming is right.
- **painting and banners** — opaque, so **JPEG**, not PNG: the painting is 187 kB at 1920x1080
  (q82) and would be several MB as PNG, in the one pack the boot waits for. Banners at 768x256
  (q85, ~30 kB each).

`client/src/game/ui/lobbyArt.test.ts` decodes the shipped files and pins the clamp, the trim, the
sizes and the byte budget; the raw portrait fails its clamp assertions, so the test discriminates.

## The drifting rocks (no generation)

The painting's three floating rocks (two small ones in the blue sky, one large and haze-faded on
the right) were cut out of `lobby_bg_raw.png` rather than generated, so the lobby can drift them:

1. Around each rock, fit a per-channel quadratic surface to an 8 px ring (robustly: drop the ring
   pixels furthest from the fit and refit, because rock b's ring clips a cloud edge).
2. The rock is every pixel far enough from that surface (12/255 in the blue sky, 5/255 for the
   faded one), its largest component plus any component within 14 px (rock c's dangling tip),
   holes filled.
3. Fill the dilated mask harmonically (repeated 4-neighbour averaging) from its own boundary. A
   quadratic fill left a visible ghost at rock b; the harmonic one meets its surroundings exactly.
4. Un-mix the rock's soft edge against that fill (`fg = (pixel - (1 - a) * fill) / a`), so the
   sprite carries no sky fringe and recomposites to the original.

Outputs: `lobby_bg_clean.png` (the painting with the sky whole — the shipped `lobby_bg.jpg` is made
from it, 1920x1080 q82) and `lobby_rock_{a,b,c}_raw.png`, then `alphaClamp.mjs` and
`compress.mjs --long-axis=52/45/88` (the painting's own 0.75 scale). The homes the code reads
(`LobbyBackdrop.SKY_ROCKS`) are the cut-outs' centres as fractions of the painting.

## The orbiting weapon (no generation)

`client/public/ui/lobby_weapon.png` is a byte-for-byte copy of `client/public/weapons/gun_cryobolt.png`
(160x148). A copy rather than a reference because the weapons ship in the `forge` pack, which only
arrives at the run phase; the lobby may only draw what the `lobby` pack holds. If the cryobolt's
art is ever regenerated, copy it again.

# Touch controls (2026-10-01 pass)

The on-screen controls `TouchControlsView.ts` draws as translucent Graphics circles today. A
different job from every icon above: these sit ON TOP of live gameplay for the whole run, so
they must stay readable over any floor while hiding as little of it as possible. The game, not
the art, makes them translucent (sprite alpha about 0.5 idle, 0.9 while held), so each file is
drawn fully opaque where it has paint, with a REAL transparent hole wherever the game should
show through. Drawn sizes, from `TouchControls` (CSS px): stick base 180 across, knob 72, fire
180, the three small buttons 80. Output is 1024 x 1024 and `compress.mjs` brings it down to
2x DPR of the drawn size (base and fire 360, knob 144, small buttons 160).

Colours are the ones the Graphics use, so the swap does not change what the controls mean:
the move stick is the player teal `THEME.colors.player` (#4FD1C5), fire is the muzzle amber
`THEME.colors.muzzle` (#FFE08A), interact is the heal green `THEME.colors.pickupHeal`
(#68D391). The two weapon-swap buttons keep their code-drawn "1" / "2" labels on top of a
shared art disc, so no image may contain a digit.

Issued first: the three controls a phone player touches every second. The swap disc and the
interact button follow in the next batch.

## Extra constraints for this batch (paste alongside the locked style paragraph)

This is a TOUCH CONTROL drawn over a moving game scene, not an icon on a menu. Perfectly
circular and centred, viewed straight on, no perspective, no tilt. Bold but THIN dark outline
(about 1.5% of the image width). Real alpha transparency: everything outside the circle, and
every area described as "hollow" or "transparent", must be fully transparent pixels — do NOT
paint a checkerboard pattern to suggest transparency, do NOT fill the background with white or
grey; if true transparency is impossible, use one flat solid pure white (#FFFFFF) background
and nothing else. No drop shadow, no outer glow, no light spilling past the outline — the game
draws its own highlight while the control is held. No text, no letters, no digits.

## 1. `touch_stick_base` — the movement stick's ring

> [locked style] [extra constraints] Output 1024 x 1024 pixels, an 8-pixel fully transparent
> margin on all sides. A single circular joystick BASE for a mobile game: one flat ring whose
> band is about 9% of the circle's diameter thick, in the player teal — base colour
> approximately #4FD1C5, its upper-left arc lit up to about #8EEDE4, its lower-right arc down to
> about #2C8C84. On the ring, at the four compass points (top, right, bottom, left), four small
> inward-pointing chevrons in the same teal, each about 6% of the diameter wide, sitting on the
> inner edge of the band. Faint crystal facets: the band is subtly cut into 12 equal flat
> facets, each a slightly different shade of the same teal — no other texture. The ENTIRE
> interior inside the band is hollow: fully transparent, nothing drawn there at all, so the game
> scene shows through.

## 2. `touch_stick_knob` — the thumb knob

> [locked style] [extra constraints] Output 1024 x 1024 pixels, an 8-pixel fully transparent
> margin on all sides. A single round joystick THUMB KNOB for a mobile game, filling the canvas
> inside the margin: a solid domed disc in the player teal, approximately #4FD1C5, cel-shaded
> with one flat highlight crescent at the upper-left up to about #B5F5EF and one flat shadow
> crescent at the lower-right down to about #2C8C84. At its centre, one small faceted crystal
> gem about 22% of the disc's diameter, a bright cyan-white approximately #E6FFFC with a single
> darker facet — the game's "purified crystal" accent. Solid, opaque, no hole. Simple enough to
> read at 72 pixels across.

## 3. `touch_fire` — the hold-to-fire button

> [locked style] [extra constraints] Output 1024 x 1024 pixels, an 8-pixel fully transparent
> margin on all sides. A single large round FIRE BUTTON for a mobile shooter, filling the canvas
> inside the margin. A ring band about 7% of the diameter thick in warm amber — base
> approximately #FFE08A, upper-left lit to about #FFF2C4, lower-right shaded to about #C9A23F.
> Inside the ring, a dark disc approximately #2A3140 at its centre, so the button stays legible
> over a bright floor. On that dark disc, centred, one bold amber CROSSHAIR glyph, about 46% of
> the button's diameter: a thin circle with four short ticks at the compass points that stop
> short of the centre, and one small solid amber dot exactly in the middle. Nothing else — no
> bullet, no gun, no flame, no explosion.

## Next batch, prepared (not yet issued): the small buttons

Same extra-constraints paragraph. Both are drawn 80 across, so they must read at that size:
one shape each, no fine detail.

### 4. `touch_swap` — the weapon-swap disc (used twice)

> [locked style] [extra constraints] Output 1024 x 1024 pixels, an 8-pixel fully transparent
> margin on all sides. A single small round BUTTON DISC for a mobile game, filling the canvas
> inside the margin, deliberately plain because the game prints a "1" or a "2" on top of it. A
> flat dark slate disc approximately #2A3140, with a thin cool-grey rim about 6% of the
> diameter thick, approximately #E2E8F0 at the upper-left fading to about #8A94A6 at the
> lower-right. The disc's centre is EMPTY and flat: no symbol, no texture, no gradient beyond
> one very faint lighter crescent along the upper-left inside the rim. No digit, no letter, no
> weapon, no arrow.

### 5. `touch_interact` — the hold-to-revive/interact button

> [locked style] [extra constraints] Output 1024 x 1024 pixels, an 8-pixel fully transparent
> margin on all sides. A single small round SUPPORT BUTTON for a mobile game, filling the
> canvas inside the margin. A ring band about 8% of the diameter thick in heal green — base
> approximately #68D391, upper-left lit to about #B4F0C8, lower-right shaded to about #3F9A62
> — around a dark disc approximately #2A3140. Centred on the disc, one bold green PLUS sign
> with slightly rounded ends, its arms about 50% of the button's diameter, the same green as
> the ring with a flat lighter top face. Nothing else — no heart, no cross outline, no hand.

Code side for these two: `drawButton` / `drawInteractButton` take the same sprite swap as the
three above. The swap disc keeps its "1"/"2" Text on top; the interact button's "+" Text goes
away once its art lands, since the plus is in the art.

## Workflow for this batch

Same pipeline as the environment batches (`art/environment/prompts.md`, "Pipeline, in order"):
keep the generator's file as `<id>_original.*`, decode the alpha channel before believing it,
key a painted checkerboard by border flood-fill if one came back anyway, then
`alphaClamp.mjs` -> `compress.mjs --long-axis=<2x drawn size>` -> `alpha-audit.mjs`. Check each
one composited at its drawn size over a BRIGHT and a dark floor swatch at alpha 0.5 — the
stick base's hollow interior and the fire button's ring are the two places that fail in
opposite directions (a filled interior hides the floor; a ring with no dark edge vanishes on
a bright one).

Baseline for that last step, so a new flag is easy to tell from an old one:
`alpha-audit.mjs client/public/ui` reads **35/37 clean** (2026-10-01). The two flags,
`icon_account` and `icon_card_bounty`, are HAZE at 10.6% / 10.5% midtone, just over the 10%
line. They are not cutout defects: the partial alpha is the painted crystal glow (the bounty
chest's shard, the account badge's light rim), which this icon style asks for.

Code side, wired ahead of the files (2026-10-01): `TouchControlsView` has a sprite per control
(`TOUCH_ART_KEYS`), sized to the Graphics' own radius, alpha 0.5 idle / 0.9 held, and keeps the
Graphics for any control whose texture has not landed. What is left for the day the PNGs
arrive: add the three keys to `UI_ASSETS` in `render/uiSkins.ts` (they load in the `late`
tier, before a run) together with the files in `client/public/ui/` and their
`assetPacks.json` entries. The keys cannot be registered earlier: `wechatAssetLoad.test.ts`
requires every registered file to load.
