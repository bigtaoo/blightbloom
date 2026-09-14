# NPC prompts

The game's two NPCs, both stationary and both on the shared orb-core body plan (`design/13`):

| Subject | Where it stands | Shipped copy |
|---------|-----------------|--------------|
| **Forger** (2026-08-02) | the Outpost/hub screen, corner-anchored UI sprite | `client/public/ui/npc_forger.png` |
| **Shopkeeper** (2026-09-14) | behind a shop counter IN a dungeon room, Y-sorted against the actors | `client/public/environment/npc_shopkeeper.png` |

They ship to different directories on purpose — see the last paragraph of the shopkeeper
section for why.

## Forger

`design/13`'s last open "NPCs are still open" gap — the Outpost/hub is otherwise fully
dressed (`hub_bg`, icons). This is the stationary Forger NPC that stands in the hub,
concept approved in-chat 2026-08-01 (blocky/industrial orb-core variant, tool-mount instead
of weapon-mount). Code plumbing for it already shipped in `Forge.ts` (`npcSprite`, key
`npc_forger`, corner-anchored bottom-right, hidden until the texture exists) — this prompt
is the only remaining piece.

Generated with **GPT Image 2**.

### `npc_forger` — stationary Outpost Forger

> 2D game character concept art, flat cel-shaded mobile game style, matching this game's
> locked hero art direction exactly: bold clean uniform black outlines, flat solid colour
> fills, simple soft cel shadows, minimal internal detail, strong readable silhouette.
> Deliberately FLAT — like a modern 2D mobile game sprite, NOT a 3D render, no realistic
> metal, no heavy gradients.
>
> The subject is a STATIONARY blocky/industrial floating robot-core, the "Forger" NPC who
> staffs the game's crafting outpost — same body-plan family as the game's hero orb-core
> (no legs, no arms, it hovers in place) but heavier and more angular/industrial than the
> hero's smooth sporty silhouette: a thicker, more block-like rounded body, single large
> expressive glowing eye/lens as its whole face, and a transparent crystal chamber in its
> belly filled with glowing crystal light. Instead of weapon modules, two TOOL attachments
> orbit it on the same glowing energy tethers the hero's weapons use, plugged into the same
> universal mount-socket design: a stone smith's HAMMER on one tether and a pair of
> crystal-tipped TONGS on the other, both clearly plugged into round mount-sockets identical
> in shape to the hero's weapon sockets (same lore, different tool). No weapons, no combat
> pose — calm, sturdy, at-rest stance, like it's standing over a forge waiting for the
> player.
>
> Palette: warm neutral stone/beige/gold (matching the hub background's palette), with a
> small warm ember-orange glow accent in the eye/belly crystal (justified as reflected
> forge-light) — explicitly NOT cyan/ice-blue, NOT any of the game's five reserved combat
> element hues (fire orange-red, ice cyan, lightning yellow-violet, poison green, physical
> white) as a DOMINANT colour; the ember accent is a small warm highlight only, the body
> stays in the stone/beige/gold family.
>
> Tilted 3/4 game camera view (slightly forward-leaning, not top-down), bright hopeful
> plucky mood not grim, plain neutral grey background, single character only, no text.

### Workflow reminder (Forger)

Save the accepted generation as `art/npc/npc_forger_raw.png`, rejects as
`art/npc/npc_forger_alt.png` (same convention as every other `art/<category>` batch). After
judging: decode with `tools/png-pipeline/pngCodec.mjs`'s `decodePNG` to confirm real alpha,
then `node tools/png-pipeline/compress.mjs --long-axis=256 <file>` and drop the result into
`client/public/ui/npc_forger.png`. `Forge.ts`'s `npcSprite` already points at texture key
`npc_forger` via `getUiTexture()` — no code change needed once the file lands.

## Shopkeeper

### `npc_shopkeeper` — the shop counter's merchant (2026-09-14)

design/05 "Shops" shipped a counter and no shopkeeper, and the game's owner named the gap the
same day: *"商店是通过房间里的 npc 打开的，不是随时可以打开的。"* That sentence has two halves, and
this art answers only the first. **A room with a merchant standing in it** is a rendering
change and shipped here; **a shop that needs an explicit gesture to open** is a change to the
VERB, which design/05 deliberately withheld from `INTERACT` (already carrying the revive
channel and a chest), and it stays filed rather than built. Nothing in `@dd/engine` moved —
no `ENGINE_VERSION` bump, no golden re-record.

Generated with **GPT Image 2**. Accepted on the first generation; there is no `_alt` reject.

Two things in this prompt are not in the Forger's above, and both were written from what the
earlier art passes cost:

- **The anti-checkerboard paragraph.** `pillar_neutral_raw.png` came back with zero
  transparent pixels and a transparency checkerboard *painted into it* as opaque squares,
  which no preview can distinguish from a real alpha channel (`art/README.md`, 2026-08-20).
- **The no-glow / no-cast-shadow sentence.** Both are drawn by the game — `ShopLayer` gives
  the keeper its own ground ellipse — and a baked one double-exposes.

Neither instruction made the generator obey the *alpha* rule: it came back at 253 inside a
veil of 1-10, the 2026-08-24 defect class, and needed `alphaClamp.mjs` exactly as every prop
did. Asking for clean alpha in the prompt is worth doing and is not a substitute for measuring.

> Flat-cel game art asset for a top-down-tilted 2D dungeon crawler. Orthographic
> projection, fixed camera looking down at roughly 60 degrees from horizontal, so the
> subject shows a large top surface and a small front face. Key light from the UPPER
> LEFT; the right and lower-right sides fall into shadow.
>
> Bold clean uniform black outlines, flat solid colour fills, simple soft cel shadows,
> minimal internal detail, strong readable silhouette. Deliberately FLAT — a modern 2D
> mobile game sprite, NOT a 3D render, no realistic metal, no heavy gradients.
>
> The background must be REAL transparency (alpha = 0). Do NOT draw a grey-and-white
> checkerboard or any other pattern to represent transparency — a painted checkerboard
> is a defect. No drop shadow, no ground plane, no cast shadow: the game draws the
> shadow itself. NO outer glow, bloom, or halo of any kind — the game draws all glow
> itself.
>
> A single character, centred, with at least 8% transparent margin on every side.
> Nothing else in the frame: no floor, no wall, no room, no counter, no shelves, no
> scene, no second object.
>
> This is displayed in game at about 28 pixels wide, so the SILHOUETTE has to carry it:
> bold simple shape, strong value contrast between the top surface and the front face.
> Do not rely on any detail finer than one sixth of the subject's width — thin lines
> vanish completely at display size.
>
> Subject: the SHOPKEEPER who staffs a trading counter in a dungeon room — a stationary
> floating merchant robot-core. Same body-plan family as this game's hero orb-core and
> its hub "Forger" NPC (no legs, no arms, it hovers in place; a single large glowing
> lens is its whole face), but it must read instantly as a TRADER rather than a fighter
> or a smith: a rounder, softer, slightly top-heavy body, wrapped in a worn travelling-
> cloth mantle with a strapped bandolier of small stowed goods across it. Where the hero
> carries weapons on glowing energy tethers plugged into round mount-sockets, this one
> carries MERCHANT gear on the same tethers and the same universal socket design: a
> small brass hanging SCALE on one tether and a stub-nosed LANTERN on the other, both
> clearly plugged into round mount-sockets identical in shape to the hero's weapon
> sockets — same lore, different tools. No weapons of any kind, no combat pose. Calm,
> patient, welcoming at-rest stance, leaning very slightly forward as if over a counter,
> facing the camera.
>
> Proportions: slightly TALLER THAN WIDE, width:height about 28:38.
>
> Palette: this character stands behind a cool slate-blue counter (RGB 63,77,99) with a
> muted terracotta awning (RGB 192,90,74), in a dim fire-lit stone room, so the body
> sits in that family — desaturated slate and canvas-grey with worn leather brown, and
> ONE warm terracotta accent on the mantle so it is findable across a dark room. The
> single lens eye is a soft warm amber. Explicitly NOT cyan/ice-blue, and NOT any of
> this game's five reserved combat element hues (fire orange-red, ice cyan, lightning
> yellow-violet, poison green, physical white) as a DOMINANT colour — it must never be
> mistaken for an enemy or for a pickup.
>
> Bright hopeful plucky mood, not grim. Plain neutral grey background, single character
> only, no text.

#### What it actually measured

The one place the generation disagreed with the brief, recorded because it is the number the
renderer reads. **The aspect came back 0.931 (298x320), against the 28:38 = 0.737 asked for**
— squarer and stubbier than specified. `ShopLayer` scales the keeper by WIDTH and lets the art
set its height (the rule every sprite in this scene follows), so the stated 28 px display width
holds and the figure simply stands 30 px rather than 38. That still clears the counter's awning
by ~10 px, which is what `npcArt.test.ts`'s last block measures through the real layer; a file
much wider than tall would file the merchant's head behind the awning, and that is the failure
the test exists to catch.

Everything else measured where it should. Value `p50` 103 sits between the stonework it stands
on (floor/props 42-53) and the drops it must never be mistaken for (a pickup medians 167);
chroma 49.8 is below the hub Forger's own 68.7 and nowhere near an elemental body's 151.5.

#### Workflow, as run

Accepted generation → `art/npc/npc_shopkeeper_raw.png` (rejects would be `_alt`; there are
none). Then, **on a copy, in this order** — the `_raw.png` stays the untouched source:

```bash
cp art/npc/npc_shopkeeper_raw.png client/public/environment/npc_shopkeeper.png
node tools/png-pipeline/alphaClamp.mjs client/public/environment/npc_shopkeeper.png
node tools/png-pipeline/compress.mjs --long-axis=320 client/public/environment/npc_shopkeeper.png
node tools/png-pipeline/alpha-audit.mjs client/public/environment/
```

`alphaClamp` cleared 0.818% of pixels at alpha <= 8 and solidified 27.161% at alpha >= 250;
compress then took 729,650 B → 110,070 B (-84.9%), 1080x1456 → 298x320. The check that says the
clamp actually worked is the one that file's own header names: the **trimmed** bbox must equal
the bbox measured at `alpha > 25` on the ORIGINAL. Both are 0.931 — unclamped the trim would
have kept the veil and produced 0.760, 22% wrong.

Note the destination directory: `client/public/environment/`, not `client/public/ui/` where
`npc_forger.png` lives. The Forger is a corner-anchored sprite on a hub screen; this one stands
in a room and Y-sorts against the actors, so it belongs with the fixtures it shares a loader
and a preload phase with (`render/environmentSprites.ts`, the `run` pack).
