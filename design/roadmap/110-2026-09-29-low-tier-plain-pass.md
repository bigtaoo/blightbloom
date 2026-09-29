# Work log — 2026-09-29

Volume 110. See [`design/ROADMAP.md`](../ROADMAP.md) for the index and the phase spine.

## The low tier stops being the most expensive frame on a 1x display (2026-09-29, render + perf + test)

[Volume 109](109-2026-09-29-gpu-cost.md) found that the `low` quality tier cost nearly twice
`high`'s GPU time on a DPR-1 desktop, and listed three options for the owner. The owner picked the
third: **choose low's form by display.** Where the platform renders at resolution 1, `low` now
mounts one passthrough filter on `layers.world`. Everywhere else it stays pass-free, exactly as
before.

### Why a pass makes the frame cheaper

A Pixi filter draws what it covers into a pool texture at resolution 1 with no MSAA. With no
filter at all, the whole world lands in the canvas, which is multisampled (`antialias: true`). On
this desktop GPU that costs 1.6 ms at resolution 1, and the extra pass costs far less. A
tile-based phone GPU charges the other way round: it resolves MSAA on chip and pays a tile flush
for every framebuffer bind, which is what `low` was built to avoid. Phones and tablets report a
device pixel ratio of 2 or more, so the split by resolution keeps them on the pass-free form and
needs no phone to justify. Volume 109 records the argument in full.

### What changed

- **`render/quality.ts`**: `QualityProfile` gains `plainPass`, false on every tier's own profile.
  `resolveProfile(tier, baseResolution)` returns `low` with `plainPass: true` when the base
  resolution is 1 or less, and the tier's own profile otherwise, including when the resolution is
  unknown. `setActiveQuality` takes the same optional second argument.
- **`game/renderQuality.ts`**: `apply` passes the **platform's** resolution, the one captured at
  construction. It does not pass the renderer's current resolution. `low` caps every host at 1, so
  the live renderer reads 1 on a 3x phone as soon as low is applied once, and would put the pass
  there on the next re-apply.
- **`game/fx/FxController.ts`**: a new `AlphaFilter({ alpha: 1 })` field goes on `world` when the
  profile has `plainPass` and `screenFx` is off. It is built once, like the other filters, so a
  tier change never compiles a new program.

The passthrough changes nothing visible except edge antialiasing. A frozen frame rendered at `low`
with and without it differs in 5.2% of pixels, 0.1% of them by more than 32 levels in any channel,
all on edges. Side by side, the two frames look the same. The world now draws exactly as it does
on `medium` and `high`, which also render it into an unmultisampled texture.

### Measured

`perf:gpu-cost` on the same Intel Arc and production build as volume 109: a level-1 room with
8 enemies, in GPU ms saved against `high`. Both runs passed all four trust checks. The no-change
arm read 0.005 and −0.024 ms.

| Arm | Desktop 1264x705 @1 | Phone 844x390 @3 (emulated) | fb binds @1 / @3 |
| --- | --- | --- | --- |
| Base frame (high) | 1.70 | 1.27 | 15 / 15 |
| Medium tier | 0.73 | 0.19 | 3 / 3 |
| **Low tier, now** | **0.73** | 0.11 | **3** / 1 |
| Low tier, before (volume 109) | −1.58 | 0.12 | 1 / 1 |
| Every pass off, resolution unchanged | −1.60 | −3.79 | 1 / 1 |

On a 1x display, `low` has gone from 3.4 ms to 1.0 ms, level with `medium`. The "every pass off"
row reproduces the old form at DPR 1 in the same run, so the change is measured against its own
control rather than against yesterday's numbers. On the phone screen, nothing moved: `low` still
binds one framebuffer, and it saves the same as before.

This also closes the defect volume 109 named. A DPR-1 machine that `'auto'` steps all the way
down now lands on a frame as cheap as `medium`'s, not the most expensive of the three.

### Tests

There are 5 new cases, in `render/quality.test.ts`, `game/fx/FxController.test.ts` and
`game/gameQuality.test.ts`:

- the resolution threshold, on both sides;
- low's other knobs are unchanged;
- no other tier is affected;
- the filter mounted on `world` is a passthrough at alpha 1, and nothing else comes back with it;
- a 1x `Game` gets the pass both from the setting and from the auto ladder;
- a 2x `Game` does not get it, including on a re-apply once its renderer is already at 1.

Two wiring mutations were run against `renderQuality.ts`:

- **Dropping the resolution argument** fails 2 tests.
- **Passing the live renderer's resolution** survived the first round, because no settings path
  re-applies `low` once the renderer is already at 1. It is killed now by a direct second
  `apply('low')` on the 2x game.

### Still open

- **A real phone** is still unchanged from volumes 107 to 109. So is the assumption that no tiler
  runs at a device pixel ratio of 1.
