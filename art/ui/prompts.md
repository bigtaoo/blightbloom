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
| `edge` | shard **b** | **a** — its glow is a hairline outline, and the body is near-black on a near-black card, so at 43px only the outline survived. `b` puts a lit edge INSIDE the blade, which is what reads |
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

**Known weak one: `edge`.** It is a dark shard on a dark card, and only its lit edge really
carries at 43px. Kept because it is the better of the two generations and it does read — but
if it is re-rolled, ask for a body two or three values lighter than `#2d2a42`, not a brighter
glow.
