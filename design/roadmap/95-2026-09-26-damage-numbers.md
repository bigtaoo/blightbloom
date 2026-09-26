# Work log — 2026-09-26

Volume 95. See [`design/ROADMAP.md`](../ROADMAP.md) for the index and the phase spine.

## Floating damage numbers, from a generated digit atlas (2026-09-26, ui + render + art + tools + test + docs, no engine change)

Step 3 of the plan agreed after [volume 92](92-2026-09-26-backlog-resync.md). That volume recorded
the owner's decision (*"damage numbers should use an atlas; drawing them live is more than
performance can take"*) and the finding that went with it: **no floating damage number existed at
all.** `EventReactor` handled `hit` without reading `e.damage`, and two comments describing "the
damage number" described nothing. Asked whether the atlas should be generated in code or drawn by
an image model, the owner answered *"generate the digit atlas in code."*

### The atlas

`tools/digit-atlas/gen_damage_digits.py` (Python + Pillow, run by hand) renders the ten digits of
**Rubik Bold** (SIL OFL 1.1) into `client/public/ui/damage_digits.png`. The sheet is 600x62 and
15 kB: white fill under a 5 px near-black outline, with one shared 52x54 cell and one baseline.
The script also writes the glyph table beside it as `client/src/render/damageDigitAtlas.ts`
(cell size, each digit's x, and an advance of 45 px, so neighbouring outlines overlap by most of a
stroke). Both outputs are committed, so the build and CI need neither Python nor the font. The
generated module records the font's and the sheet's SHA-256, so a re-run with a different font
file shows up in the diff.

The atlas is generated rather than drawn for the reasons volume 92 gave:

- Ten glyphs must share an advance and a baseline, or a merged hit that rewrites "38" to "41" in
  place jitters.
- Every damage type is the same sheet under a runtime `tint`, so the fill must be exactly white.

Rubik was chosen because the counters of 0/6/8/9 stay open under a thick outline at ~20 px, where a
narrow grotesque closes them. It ships with LibreOffice, so it was already installed on this
machine. The raster is not the Font Software under the OFL, so no licence file travels with it.

It is registered in `UI_ASSETS` as `damage_digits`, so it rides the `lobby` pack (`/ui/` rule)
and is resident long before the first hit. A missing file draws nothing, which is the same
fallback every other piece of UI art has.

### The numbers

The feature is three modules, split the way `pickupReactions.ts` was, so both files that carry a
rule are pure and listed in `pureLayerBoundary.test.ts`:

- **`controllers/damageNumberReactions.ts`** decides which hit gets a number, in what colour and
  where. A number is drawn:
  - on every enemy;
  - on this seat;
  - on another player only when a player hit them. A PvP rival taking fire is numbered; a co-op
    teammate taking an enemy's fire is not, because a column of numbers over each teammate reports
    a fight that is not yours, and the ally row already summarises it.

  Colour, in priority order:
  1. shield cyan when the shield absorbed the whole hit (`shieldRemaining > 0`);
  2. red for damage this seat took;
  3. slate for the zone and hazard tiles;
  4. otherwise the weapon's `elementColor`.

  A number starts 2.2 body radii above the target's interpolated ground point, which puts it at
  the top of the head, just under the health bar it then rises past.
- **`fx/damageNumberModel.ts`** holds the merge window, the cap and the curve. Its rules:
  - A second hit on the same target in the same colour within **150 ms** adds into the number
    already rising and pops it again. A stream reads as a ticking total, and a slow weapon as
    separate hits.
  - A number lives 750 ms: an ease-out rise of 26 px, then a fade over the last 250 ms.
  - Everything is sized in **screen** px (22 px per digit, up to 1.35x for a four-digit hit),
    because the world is zoomed 3-4.5x and a world-sized number would fill a small room.
  - Successive new numbers cycle through five fixed side offsets, so two hits just outside the
    window do not print on top of each other.
  - At the cap, the **oldest** number is reused for the new hit. The newest hit is never dropped,
    because it is the one the player is looking for.
- **`fx/DamageNumbers.ts`** is the Pixi half. Every digit is a pooled plain `Sprite` cut from the
  one sheet and tinted per number, so a screen of numbers in five colours is still one texture and
  one batch. It deliberately uses neither `Text` nor `BitmapText`:
  - `Text` re-rasterises a canvas on every change, which a number ticking up on each merged hit
    would pay constantly;
  - the `BitmapText` chunk is kept unloaded on purpose (design/12,
    `build/runtimeChunkPreload.mjs`).

  A finished number's container goes back to a pool with its sprites; one that once showed "1204"
  keeps four and hides the ones a "38" does not use.

The numbers get a world layer of their own, **`layers.numbers`**, drawn after `hud`, so a number is
never cut by its target's health bar. It is **not** a render group. `hud` is one precisely because
it almost never changes, and numbers spawning inside it would rebuild every health bar's
instructions on every hit.

The cap is a new quality-ladder knob, `QualityProfile.damageNumbers` (40 / 28 / 16). A tier drop
mid-fight trims the excess at once rather than waiting for it to fade. `FxController` owns the
instance, and its only new work is to mount it, advance it with the current zoom in `updateFx`,
and clear it in `resetForNewRun`.

### The zone, and a comment that was wrong

The plan said the numbers should include `zone_damage`, and they do, without a case of their own.
`EnvironmentSystem.applyZoneDamage` deals the tick through `takeDamage`, which pushes an ordinary
`hit` with `faction: 'environment'`, and only then pushes `zone_damage`. Numbering that event as
well would print every tick twice, so it stays unhandled on purpose. `EventReactor.test.ts` pins
that the pair produces exactly one number.

That also means the comment on `EventReactor`'s `hurt` cue was wrong. It said zone ticks "arrive as
`zone_damage`, which this reactor has never handled", but every zone tick has always reached
`case 'hit'`, and so has always played `hurt` on the local seat. The comment now says so. No
behaviour changed.

### Verified live

Verified in the Browser pane on `?arenaDemo=1`, from this worktree's own dev server. The shared
launch config serves the main checkout, where the atlas does not exist yet: the PNG came back as
the HTML fallback.

- **Real events reach the numbers.** Driving the real run produced a stream of `hit`s on the local
  seat from the zone. They came out shield-cyan while the shield held and red once it broke,
  exactly the priority above.
- **Merging works.** Two synthetic hits of 6 and 5 fed through the real `EventReactor.consume`,
  five frames apart, merged into one red **"11"** just above the health bar.
- **Every colour and size renders.** A staged frame showed all eight cases (physical, fire, ice,
  lightning, poison, self, environment, shield; 1-4 digits) with the outline intact and the
  magnitude scale visible on "1204".
- **No new errors.** The console showed only `ERR_CONNECTION_REFUSED` from the absent local
  backend.

### Tests

- **Client: 7385 → 7440 tests (+55), all passing**:
  - `damageNumberModel.test.ts`: digits, centring, magnitude, the pose curve, merge inside and
    outside the window, never across targets or colours, the drift cycle, steal-oldest at the cap,
    cap 0, `trimTo`, `step`, `clear`;
  - `DamageNumbers.test.ts`: layout and tint, re-layout on merge, screen-px placement under zoom,
    pooling with sprite reuse, the quality cap and a mid-fight tier drop, the unloaded-atlas
    fallback;
  - `damageNumberReactions.test.ts`: which hits, which colour, where, and that the five colours
    stay distinct, because two equal ones would merge two kinds of hit into one number;
  - two cases in `EventReactor.test.ts`;
  - a layer-order case;
  - the quality ladder's monotonicity now covers the new knob, and `low` must keep it above 0.
- **Coverage of the three new modules: 100% lines and 100% branches.**
- `tsc --noEmit` is clean, and `npm run check` is green.

### Not done

- **Critical hits and heals get no number**, because neither exists as an event field. A heal is
  already a toast.
- **Nobody has looked at it on a phone.** 22 px was chosen on a desktop pane; `04`'s device
  checklist is where legibility at 390 logical px gets confirmed.
