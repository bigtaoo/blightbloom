# Work log — 2026-10-10

Volume 139. See [`design/ROADMAP.md`](../ROADMAP.md) for the index and the phase spine.

## Warm stone, dark edges, light pools: a new environment direction, ember first (2026-10-10, client + art + tools + test + docs, no ENGINE_VERSION change)

> 现在的游戏场景看起来质量很低，相对于大厅，这画面看起来就像demo

The report compared the in-run frame with the hub. The hub is a painted, lit scene; a room was a
dark, near-uniform floor under a 64 px grid, charcoal walls, and no light that came from anywhere.
Each part had been measured and was correct by its own rules (design/13's "environment desaturated,
hazards saturated"). Together they read as a prototype.

### Direction first, then art

Five concept frames were generated and two of them mixed
(`art/concept/direction-2026-10-10/`); the user chose the clean, bright variant,
`4_hybrid_a.png`. Its rules:

- the floor is a light warm-beige flagstone, the lightest stone in the room;
- the wall top is dark grey;
- the wall face is warm brown brick;
- torches hang on the perimeter walls and cast real pools of light;
- the room's edges and corners fall into shadow.

Two of these are the INVERSE of the first-generation swatch family's rules, so design/13 now records
the direction ("Environment: warm stone, dark edges, light pools"), and the old bullet carries a
dated revision: low chroma still holds, low value does not.

The ember chapter is the pilot. Every other chapter keeps its first-generation art until its own
stone is painted. `torches.TORCH_ELEMENTS` and `SwatchMeta.authoredTone` are the two switches, so a
cold room never gets a warm torch.

### The swatches (`art/biome/prompts.md` has the prompts and every number)

There are three new ember swatches: floor, wall cap and wall face. They ship as 512 px JPEG
(`client/public/biome/*_fire.jpg`, ~160 KB together). Each is encoded from a lossless
`art/biome/<key>_master.png`, because nothing in the test environment decodes JPEG.
`warmStoneArt.test.ts` reads the masters and pins each JPEG's frame-header size to its master.

Two new tools in `tools/png-pipeline`:

- `makeTileable.mjs` cuts each wrap seam along a minimum-error path through the mortar both sides
  share (image quilting against itself), so a swatch wraps exactly. The floor is no longer mirrored
  per cell to hide a mismatch (`SwatchMeta.seamless`), which on irregular flagstones had read as a
  kaleidoscope.
- `colorGrade.mjs` flattens low-frequency drift, desaturates, applies a gain, and lands the median
  luma on a target. The model treats a prompt's hex colour as a suggestion, and re-rolling for
  colour also re-rolls the composition.

`render/biomeTiles.ts` gained `SWATCH_META`, which gives each texture three properties:

- **density**: texels per world px, loaded as the texture's `resolution`, with mipmaps;
- **seamless**;
- **authoredTone**: the art is graded onto its own target, so the first-generation `FACE_TINT`, the
  baked cap lift and the 64 px floor grid are all skipped for it.

The floor is 512 px over 200 world px (power-of-two for WebGL1's wrap), so a slab is about two
hero-widths across. A wall face's courses now continue across block boundaries (`tilePosition.x =
-r.x`) instead of restarting at every split of a straight run.

The floor took two passes. The first accepted floor was chunky cobbles with wide black mortar. In
the frame it read as gravel under the actors, so it was regenerated as flat crazy paving with thin
seams. The prompt then needed an explicit "no long straight lines, no 2x2" paragraph, because two
of seven candidates came back as a four-panel grid.

### The torches (`scene/torchPlacement.ts`, `scene/torches.ts`)

`planTorches` is pure geometry over the wall plan `RoomBuilder` already computes:

- Only perimeter runs carry torches.
- Torches are spaced evenly (target spacing 224 px) along whatever is left after corners and passages
  are cleared.
- North walls hang them on the face; side walls hang them on the inner edge.
- A run that `mergeWallRuns` joined across two rooms gives torches to both rooms. When a run was
  credited only to the room its centre fell in, the other room's north wall was left bare. This was
  found live.

`TorchSet` turns each spot into a sconce sprite (`environment/torch_wall.png`, prompt in
`art/environment/prompts.md`), a small additive halo, and a point light in the scene pass. Only
the torches whose light reaches the view are registered: at most `MAX_LIT_TORCHES` (6), nearest
the view centre first. `MAX_SCENE_LIGHTS` went from 8 to 12, so a torch-lit fight keeps five slots
for its impacts. The flicker is two incommensurate sines at a few per cent, with each torch at its
own phase. A room whose brightness visibly pumps is whole-screen motion, which this project treats
as a bug.

Problems found live, in order:

1. Six 250 px lights at 0.85 washed the whole frame orange. With the lights removed the orange went
   too, which confirmed the cause.
2. The north sconces sat above the top of the screen.
3. The side sconces were invisible. A side wall is one entity sorted at its south end, so the torch
   now takes that sort key (`TorchSpot.sortY`).
4. The side sconces then stood ON the cap. They are now pushed inward by half their width.

### Dark edges (`scene/roomLight.ts`)

`WARM_STONE_ROOM_LIGHT` darkens a room's edges much more than the default: 0.45 against 0.26, over
32% of the room against 20%, and at most 180 px. The ramp now starts at the foot of the room's own
walls (`insetByWalls`). Walls are authored inside the room rect, so before this the darkest third
of the ramp was painted under stone nobody sees.

0.62 was tried first. The light pass multiplies, so edges that dark crushed the torch pools with
them. 0.45 with torch intensity 1.2 is where the pools read against the edges and the edges still
read as shadow.

### Tests

- `torchPlacement.test.ts` (16): spacing, sides, merged runs, shared dividers, passages, short
  stretches.
- `torches.test.ts` (15): the fixture, side offsets, culling and the nearest-six budget, withdrawal,
  flicker bounds and phase, rebuild and clear never leaving a stale light.
- `warmStoneArt.test.ts` (19): the key frame's tonal rules on the masters, the seams (with a control
  that proves the ratio would catch an unwrapped swatch), JPEG-equals-master.
- `roomLight` (insetByWalls, the warm style, and a "still leaves floor to see" bound where it stacks
  with a wall's crease and cast shadow).
- `groundLayer`: no grid on an authored floor, no mirroring, harder edges starting below the wall.
- `makeTileable.test.mjs` and `colorGrade.test.mjs` on synthetic fixtures.

The existing art tests now split by generation. `biomeSwatchArt.test.ts` measures the first family
only, and requires every chapter to ship wholly one generation. `wallComposition.test.ts` measures
warm faces off their master, and `texturePowerOfTwo.test.ts` reads JPEG dimensions.
The `RoomBuilder` suites' mocks of `biomeTiles` and `environmentSprites` gained `swatchMeta` and
`getTorchTexture`.

### What is next

The other chapters in the same direction, each with its own stone. A chapter's torches turn on when
its swatches are `authoredTone`.

## Frost, storm and blight in warm stone: every chapter in the new direction (2026-10-10, client + art + test + docs, no ENGINE_VERSION change)

> 继续把其他章节也换成新美术风格

The ember pilot above left the other three chapters on first-generation art. They follow it here,
the same day, with the same rules and the same pipeline. Each chapter gets its own stone, so the four
floors do not read as one place in four tints:

| chapter | floor | wall top | wall face |
|---|---|---|---|
| ember | warm beige crazy paving | dark grey blocks | warm brown brick |
| frost | pale cold-grey flagstone, rime in the seams | dark slate, snow in a few joints | blue-grey blocks with frosted edges |
| storm | neutral granite in random ashlar | dark charcoal basalt | slate ashlar with a riveted bronze band |
| blight | ashen violet-grey flagstone, cracked | dark grey-plum blocks | dusty plum-brown brick |

All nine swatches are 512 px JPEG encoded from masters in `art/biome`, graded onto the ember
targets: floor median luma about 170, cap about 75, face about 92-100. `art/biome/prompts.md` has
the prompts, which candidate each came from, and every pipeline flag.

### Decisions

- **One warm torch in every chapter, frost included.** `torches.TORCH_ELEMENTS` is now exactly
  `theme.WARM_STONE_ELEMENTS`. Warm light on cold stone reads as a lit room, which is the key
  frame. A pale-blue pool would also tint every actor toward `statusChill`, the colour that means
  "this one is chilled". `neutral`, a PvP arena's stone, is the one element left on the first
  generation, and it gets no torches.
- **Blight carries design/13's poison clause by hue, not value.** The first-generation version held
  dark stone far below the `#9CCC65` FX green's luma. A light floor cannot do that. So green is the
  lowest channel in all three blight swatches, the opposite side of the wheel from the poison bullet,
  aura and blightling. In the frame the green blightlings stand out against the floor.
- **Violet-grey, not mauve.** The first blight floor was mauve (mean 164/139/152). Under the warm
  torch light it read pink. It was regraded to 158/141/157.

### Found on the way

- **The storm floor's first tiling cut through stone.** `makeTileable.mjs` at its defaults left a
  sawtooth where the seam path crossed slabs. `--overlap=0.25 --jump=3 --mortar=2` routed it
  through the mortar.
- **The blight floor's left-right seam failed the 2.5x ratio** (10.9 against 7.3). `--overlap=0.3`
  fixed it (1.6).
- **The first blight face grade came out bright magenta.** `--flatten` lifted a large pink patch
  in the source. A different candidate, desaturated 0.75, fixed it. Its mortar was then too light for
  the crown-row check (joint 37 against 90 brick), so a levels pass (black point 34) went in before
  the median grade.
- **The crown rows moved.** The warm faces have no lit coping, so `FACE_CROWN_ROWS` is each face's
  darkest joint in its top third:
  - ice 34/256;
  - lightning and poison 63/256, because their first joints are faint or partial and the third is
    the one that runs the full width.

  `FACE_CROWN_FRACTION_MIN` is now ice's 34/256.
- **The dev server served the shared tree.** `client-dev-alt` runs `--prefix client` from
  `D:/daydayup`, so it showed the OLD frost art. The worktree was checked from a temporary launch
  entry with an absolute `--prefix`, removed afterwards.
- **Mistral workspace A's key expired on 2026-10-08,** and after about twenty generations every
  other key was rate-limited for fifteen minutes.

### Tests

`warmStoneArt.test.ts` now runs over all four chapters:

- JPEG equals master, and the package budget;
- density;
- the key frame's tonal rules;
- every floor not green;
- every tiled swatch wraps, and every face wraps left-right only. The face check now compares
  against the face's mean adjacent-row step, because storm's top bevel makes row 0 to row 1 one of
  its largest steps.

Per-chapter hue rules:

- frost: blue over red by 10-45, cold grey and not the chill blue;
- storm: neutral, and not yellow;
- blight: green the lowest channel, and no pixel a green mark.

A pairwise check keeps the four floors at least 12 apart in mean colour; storm and blight are the
closest pair, at about 14.

Other suites:

- `biomeSwatchArt.test.ts` measures `neutral` alone, and its poison block moved into the warm test
  as the hue clause.
- `torches.test.ts` hangs torches in all four chapters and none on `neutral`.
- `wallComposition`, `texturePowerOfTwo` (ice and lightning left the non-power-of-two list),
  `biomeTilesLoad`, `assetManifest` and `wechatAssetLoad` follow the new files.

The asset-pack rules name `.jpg`. Each chapter's pack is now 0.14-0.17 MB.

### What is next

`neutral`, the PvP arena's stone, in the same direction.
