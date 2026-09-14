# Art

> **Audio lives alongside this, under [`art/audio/`](audio/README.md)** — same convention (source
> and licence paperwork here, the processed copy under `client/public/`), different medium. As of
> 2026-09-02 it holds the source behind **61 shipped SFX/UI assets and 2 music loops**, plus
> `credits.json` / `packs.json`. All of it **plays** — the "nothing loads them yet" this box used
> to say stopped being true on 2026-08-28 (`design/11`). Two of its conventions differ from art's:
> one source (BigSoundBank) is licensed and hashed per SOUND rather than per pack, and the music
> masters are AI-generated rather than CC0 library material.

> **Direction locked (2026-07-23):** flat-cel orb-core hero + universal-mount weapons +
> crystal-mirror enemies. See `design/13-worldview-art-direction.md` for the direction and
> the per-subject `prompts.md` files below for the generation prompts.
>
> **Status (2026-08-02):** production assets exist and the game loads them — the client is
> no longer Graphics-only. This directory holds the **source** art (full-resolution
> generator output, `.xcf` edits, rejected attempts kept for reference); what the game
> actually ships is the alpha-trimmed, downsampled, re-encoded copy under `client/public/`.
> Nothing in `art/` is loaded at runtime. **Update (2026-08-04, recounted 2026-08-18):** every
> shipped PNG under `client/public/` (**82 files**) was decoded and its alpha channel audited
> (`tools/png-pipeline/alpha-audit.mjs`) — no opaque-matte-background bug and no
> translucent-haze bug found. All sprite art (characters/weapons/icons/NPC) is clean bimodal
> alpha; the only fully-opaque files are the ones meant to be (`ui/hub_bg.png` and the **12**
> `biome/floor_*`/`wall_*`/`wallface_*` tiles, which are full-bleed backgrounds/tileables with
> no transparency by design). This closes the last open caveat below. **Update (2026-08-20):** the
> pillar sprite (`biome/pillar_neutral.png`) is the 13th file in that directory and the only one
> there with real transparency — the generation it came from had **zero** transparent pixels and a
> transparency CHECKERBOARD painted into it as opaque grey-and-white squares, which no preview can
> distinguish from a real alpha channel. Keyed by luma at import; the audit reports the shipped file
> clean. Re-run `alpha-audit.mjs` after any art batch rather than trusting the picture.
> **Update (2026-08-24):** three more shipped files — the room-prop trio (`props/`, see the new
> row below) — bringing `client/public/` to **92 PNGs**, and one genuinely new alpha defect class
> alongside them. All three generations decoded as *clean bimodal alpha* and were not: the body sat
> at 252-253 rather than 255, inside a veil of alpha 1-10 reaching 50-140 px past the object. Both
> ends are invisible (99% and 4% opacity) and `alpha-audit.mjs` reads the pair as one "suspicious"
> file with no opaque pixels at all — but `trimAlphaBoundingBox` keeps any pixel with `alpha !== 0`,
> so the veil became part of the object: the rubble trimmed to aspect 2.95 against its real 3.67
> (a prop is scaled by width with the art's aspect setting its height, so it would have stood 25%
> too tall) and the trim kept 123 empty rows underneath it, which a bottom-anchored sprite turns
> into clearance above the floor. New `tools/png-pipeline/alphaClamp.mjs` snaps both plateaus and
> runs BEFORE `compress.mjs`; every file shipped before this pass measures identically at
> `alpha > 0` and `alpha > 25`, so the `alpha !== 0` trim had simply never been handed a file where
> it mattered. Also closed here, from a loader audit rather than a report: `weaponSkins.ts` and
> `uiSkins.ts` were the last two loaders still passing a bare url to `Assets.load`, i.e. with no
> mip chain — a mounted weapon measures **5.3:1** minification live (320 px source, 60 px on
> screen), worse than the 4:1 that made the pillar need one, on the object every actor carries.
> **The `door_open_raw.png` haze flagged below was fixed in 2026-08-21's props/follow-ups pass** and
> the whole `environment/` directory now audits clean (11/11).
>
> **Update (2026-09-14):** the **shopkeeper** (`npc/npc_shopkeeper_raw.png` →
> `client/public/environment/npc_shopkeeper.png`, see `npc/prompts.md`) — the first NPC that stands in a
> ROOM rather than on a menu screen, which is why it ships to `environment/` beside the doors and props
> rather than to `ui/` where `npc_forger.png` lives. `client/public/` now holds **99 PNGs**.
>
> **It arrived with the 2026-08-24 veil defect, inside a prompt written specifically to prevent it.** The
> brief carried the anti-checkerboard paragraph this box has been recommending since 2026-08-20 AND a
> no-baked-glow/no-cast-shadow one, and the generation still came back with its body at 253 wrapped in a
> veil of alpha 1-10 — exactly the room-prop class. Measured either side: bbox at `alpha > 0` was
> 1058x1393 (aspect **0.760**), bbox at `alpha > 25` was 864x928 (**0.931**). Since `trimAlphaBoundingBox`
> keeps any pixel with `alpha !== 0`, shipping it unclamped would have put the sprite **22% wrong in
> aspect** and left empty rows under a bottom-anchored figure. `alphaClamp.mjs` then `compress.mjs`, in
> that order, as this directory's convention already says; the trimmed file measures 298x320 = **0.931**,
> which is the check that proves the clamp ran — *the trimmed bbox must equal the bbox measured at
> `alpha > 25` on the original*, not merely "the audit says clean". The lesson for the next batch is the
> direction, not the fix: **prompting for clean alpha is worth doing and is not a substitute for
> measuring it.** No generator instruction has yet produced a file that skipped this step.

> **Update (2026-08-30b):** one more shipped file, `door_curtain_raw.png` — the open door's own
> illustrated additive light effect (see the new row below) — bringing `client/public/` to
> **96 PNGs**. `alpha-audit.mjs` flags it HAZE (15% fully transparent, 40% midtone), which for
> every other file in this directory means a real defect; here it doesn't, because this is the
> first asset in the directory generated to be composited `blendMode: 'add'` rather than normal-
> alpha-blended over a background — a graduated glow IS the content, not a botched cutout. Verify
> that distinction by what the code actually does with the layer before re-running it through the
> checkerboard/haze fixes the rest of this pipeline enforces.
>
> **Update (2026-08-20, same day):** six more shipped files — the five in-run drop sprites and the
> portal arch (`environment/`, see the new row below) — bringing `client/public/` to **88 PNGs**.
> All six came back with a real alpha channel on the first generation, which is the anti-checkerboard
> paragraph in `environment/prompts.md` doing its job. That audit run also turned up ONE
> pre-existing offender the directory had apparently never been swept for:
> `client/public/environment/door_open_raw.png` decodes as **HAZE** (44.7% partial alpha, a 15.4%
> midtone cluster) and has shipped that way since the 2026-08-04 door pass. Flagged, not fixed.

## Layout

| Directory | Contents | Shipped copy |
|-----------|----------|--------------|
| `concept/` | Direction/exploration pieces, named after the `prompts.md` prompt that produced them (`01_…`–`05_…`, plus the `retired_…` first direction) | — (reference only) |
| `units/` | Every character and enemy part: the three orb-cores (`shell`/`belly`/`eye_front`/`eye_back`, prefixed `skirmisher_`/`juggernaut_`, unprefixed = the default vanguard), the boss (`boss.png` is an orphaned early attempt, unwired — see `prompts.md` for the real `core`/`ring` pair still needed), and the enemy bodies (`enemy_critter`/`enemy_brute`/`enemy_floater`) + `prompts.md` | `client/public/skins/*/` |
| `weapon/` | Per-weapon-id business-end sprites (`<weaponId>_raw.png`) + `prompts.md` + `leftover/` (picked-over duplicate generations, incl. two rejected grip-pistol ice attempts). All 6 elemental ids now shipped (`flamer`/`teslagun`/`venomspit`/`cinderscatter`/`cryobolt`/`frostseeker`) | `client/public/weapons/` |
| `biome/` | Per element: the top-down floor tile, the top-down wall tile (also reused as a standing wall's top cap), and the wall's front elevation (`wallface_*`, 2026-08-18). Plus one whole-OBJECT sprite, not a swatch: `pillar_neutral_raw.png` (2026-08-20), shared by every biome and tinted per room — six rejected generations kept as `pillar_*_alt*.png`. All with `prompts.md` | `client/public/biome/` |
| `environment/` | Standalone fixtures that stand IN a room rather than surfacing it: the door pair (2026-08-04), the five in-run drop sprites (`pickup_material`/`heal`/`buff`/`crate`/`bandage`), the extraction portal's masonry arch (`portal_arch`, 2026-08-20), and the open door's illustrated curtain-of-light (`door_curtain_raw.png`, 2026-08-30b — additive VFX, not a masked prop; see the update above) + `prompts.md`. Three rejected drop generations kept as `pickup_*_alt.png` — and re-read every test run as negative fixtures, see `client/src/game/scene/environmentArt.test.ts` | `client/public/environment/` |
| `props/` | Room dressing for `RoomPiece.props` (2026-08-24): the crate/barrel/rubble trio (`prop_<kind>_raw.png`) + `prompts.md`. One rejected rubble generation kept as `prop_rubble_alt.png`, re-measured every test run by `client/src/game/scene/propArt.test.ts` on all three axes it failed (aspect, value band, blue lean) | `client/public/environment/prop_*.png` |
| `ui/` | Hub background, button icons, result badges + `prompts.md` | `client/public/ui/` |
| `npc/` | Both NPCs + `prompts.md`: the hub's Forger (2026-08-02) and the shop's **Shopkeeper** (2026-09-14). They ship to different directories, which is the point of the distinction — the Forger is a corner-anchored sprite on a menu screen, the Shopkeeper stands IN a dungeon room and Y-sorts against the actors | `client/public/ui/npc_forger.png`, `client/public/environment/npc_shopkeeper.png` |
| `map/` | The rejected painterly-isometric room backgrounds (`room_*_painterly_rejected`) — kept only as a record of the approach that did not work; the biome look that shipped is the tile art in `biome/` | — (nothing bound) |

Animation data is **not** here: it lives with the rigs (`tools/animator/projects/*.editortao`
and the `RigDef`s in `client/src/render/`), separate from textures, per the skin-decoupling
principle in `design/02-entity-model.md`.

## Pipeline

Source PNG → alpha-trim → box-downsample to a ~320px long axis → re-encode with
`tools/png-pipeline` (a dependency-free pure-Node PNG codec — no image library is available
on the Node side) → commit under `client/public/`. Roughly 20–30× smaller files,
round-trip-verified byte-identical after encode.

Two traps this pipeline exists to catch, both hit for real:

- **Alpha.** A generator that returns an opaque background produces art that looks fine in a
  viewer and wrong in game. Verify the alpha channel by decoding pixels, not by looking.
  `tools/png-pipeline/alpha-audit.mjs` decodes every PNG under a directory and flags an
  opaque-background bug (no transparent pixel at all) or a translucent-haze bug (a midtone
  alpha cluster away from both 0 and 255) — re-run it over `client/public/` after any future
  art batch.
- **Chroma-key fringe.** Keying out a background leaves a halo of near-background pixels;
  defringe it without eroding genuine glow edges.

## Convention notes

- Tilted view: assets are drawn in 3/4 view (with a front face), not pure top-down.
- Each sprite defines a **ground anchor** (the orb's base) for Y-sort and shadows, and **two
  orbiting weapon-socket anchors** for weapon mounting (`13`; no hand — the socket is a
  universal, arm-agnostic mount).
- A new **character** = a new part atlas on the shared orb-core rig (+ its `SkinDef` stats);
  animation data is shared. There is no cosmetic reskin layer.
- Weapon art is composed **socket upper-left, tip lower-right**; `render/weaponSkins.ts`
  carries a per-weapon `rotationOffsetRad` that cancels whatever pointing direction a texture
  actually baked in, measured from real alpha-pixel data rather than eyeballed.
- Source files are named after what they are (`<weaponId>_raw.png`, `belly.png`), never left
  as generator UUIDs. A rejected or superseded attempt keeps the same stem plus `_alt`
  (`_alt2`, …) so it stays next to the version that won.

## Still to come

Nothing open — the list below is now historical (all items closed).

- **(Closed 2026-08-03.)** This directory's art is GPT-Image-2-generated, and the project
  now treats that as final production art rather than a placeholder awaiting an authored
  replacement (`ROADMAP.md` 5.3) — an explicit scope decision, not a pipeline change. The
  caveat this decision did NOT resolve on its own — some assets might still carry the known
  opaque-matte-background bug — was itself audited and closed 2026-08-04 (see the Status
  block above): no shipped asset has the bug.
- Two concrete gaps found by cross-checking the code (not just this doc), both **closed
  2026-08-03**: the boss had no dedicated art/rig at all (it silently fell back to a
  scaled/retinted `critter-core` body) — real `core`/`ring` art now bound via a new
  `boss-core` rig (`units/prompts.md`). All 6 elemental weapon ids that fell back to the plain
  `gun_default` housing now have real art (`weapon/prompts.md`) — `cryobolt`/`frostseeker`
  needed a second generation round each after the first came back as a fiction-breaking
  hand-grip/trigger-guard raygun.
- ~~`normal/` normal maps for the dynamic-lighting milestone~~ — **not needed, per 5.4's
  2026-08-03 update**: lighting derives its per-pixel normal from each sprite's own existing
  diffuse texture at shader runtime (a Sobel-style gradient over rendered luminance/alpha, no
  precomputed normal-map asset), so there is no separate normal-map source-art directory to
  fill. `fx/` particle textures remain unstarted (Particles.ts is still Graphics-only, by its
  own design — no textures needed there either).
