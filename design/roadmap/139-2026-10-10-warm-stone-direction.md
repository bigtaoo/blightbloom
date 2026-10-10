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
