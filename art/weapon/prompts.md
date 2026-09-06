<!-- Weapon-art generation prompts. Two sections:
     1. Elemental-weapon prompts (archive) - all 6 shipped, kept as the reusable reference.
     2. Mob melee-weapon prompts (SHIPPED) - enemyclaw/enemymaul, written and generated 2026-09-06. -->

# Elemental-weapon prompts (archive)

`engine/content/weaponSpecs.ts` defines 6 player-facing weapon ids that `client/src/render/
weaponSkins.ts`'s `WEAPON_DEFS` table had no entry for: `flamer`, `cryobolt`, `teslagun`,
`venomspit` (the fire/ice/lightning/poison starter-pistol variants), plus `cinderscatter`
(epic scattergun/fire variant) and `frostseeker` (legendary seeker/ice variant). All 6 fell
back to the plain neutral `gun_default.png` housing — re-tinted by element at runtime
(`Actor.ts setWeaponKind`'s `ELEMENT_COLORS[damageType]` tint), but with no distinct silhouette
of their own. This broke the pattern every other elemental weapon in the roster follows:
`emberblade`/`frostbrand`/`stormglaive` (fire/ice/lightning variants of the SAME `saber` melee
frame) each got dedicated art rather than reusing `sword_default.png`.

**Status (2026-08-03): 6 of 6 shipped.** All six now have real art wired into `WEAPON_DEFS`
(`client/public/weapons/gun_{flamer,teslagun,venomspit,cinderscatter,cryobolt,frostseeker}.png`,
sources archived as `art/weapon/<id>_raw.png`). `cryobolt`/`frostseeker` took two rounds: the
first attempt for both came back as a hand-gun with a trigger guard (kept in
`art/weapon/leftover/` as `*ice_weapon_icon*`/`*crystal_tech_rifle_icon*`), which this game's
fiction doesn't support — no hands anywhere in the roster, every existing weapon (including
`gun_default.png`) is a grip-less cylindrical module that plugs straight into the orbiting
socket. The prompts below were rewritten to forbid that explicitly and the second attempt
landed clean for both. Redundant duplicate generations from the whole batch also live in
`art/weapon/leftover/`. The prompts are kept here as the reusable reference for the next batch
(a rarity-tier follow-up, a new element, etc.), not because anything is still missing.

Generated with **GPT Image 2**. Style/orientation must match the existing `weapon/` batch
exactly — see `art/README.md`'s "Convention notes" (socket upper-left, tip lower-right) and
the [[daydayup-art-pipeline-conventions]] memory (bake orientation into the prompt, don't fix
it post-hoc; state the transparent-background requirement explicitly; GPT Image 2 drifts
toward drawing a whole free-standing object unless told not to).

## Shared style paragraph (paste as context for every prompt below)

> 2D game weapon icon art, flat cel-shaded mobile game style, matching this game's locked art
> direction: bold clean uniform black outlines, flat solid colour fills, simple soft cel
> shadows, minimal internal detail, strong readable silhouette, reads clearly at tiny icon
> size. Deliberately FLAT — like a modern 2D mobile game sprite / sticker, NOT a 3D render, no
> realistic metal, no heavy gradients, no photographic texture.
>
> The subject is ONLY the weapon itself — a modular crystal-tech weapon business-end that
> plugs into this game's universal orbiting mount-socket. Do NOT draw the robot body, no
> character, no hands, no background scenery — just the single weapon object, floating in
> isolation, composed **socket end upper-left, business end lower-right** (matching this
> game's `gun_default`/`sword_default` convention exactly — do not compose it pointing any
> other direction). The back (upper-left) end has a small round socket-connector nub,
> identical in shape/size to this game's existing weapon socket connector, clearly the part
> that plugs into the mount. **The weapon is a sealed cylindrical/tapered module with NO hand
> grip, NO pistol handle, and NO trigger guard anywhere on it** — nothing in this game has
> hands or fingers (it plugs into a floating socket, nothing ever holds it), so a grip or
> trigger shape is a fiction-breaking mistake, not just a style nitpick; every existing weapon
> in this game (`gun_default.png` included) is a straight housing with no protruding handle.
> TRANSPARENT background (real alpha, not a grey or white matte fill — this must survive being
> decoded and checked pixel-by-pixel for alpha). No text, no ground/shadow, no character.

Both prompts below are **complete, standalone, copy-paste-ready** strings (the shared style
paragraph above is already folded into each one — you don't need to splice anything). Both
failed once already on exactly the grip/trigger-guard point (`art/weapon/leftover/*ice_weapon_
icon*`/`*crystal_tech_rifle_icon*` — real, on-theme ice colours and iconography, but drawn as a
handheld raygun with a trigger guard) — the negative constraint above was added specifically
because of that failure, so don't drop it if you shorten these for a different tool.

## `cryobolt` — ice starter-pistol variant

> 2D game weapon icon art, flat cel-shaded mobile game style, matching this game's locked art
> direction: bold clean uniform black outlines, flat solid colour fills, simple soft cel
> shadows, minimal internal detail, strong readable silhouette, reads clearly at tiny icon
> size. Deliberately FLAT — like a modern 2D mobile game sprite / sticker, NOT a 3D render, no
> realistic metal, no heavy gradients, no photographic texture.
>
> The subject is ONLY the weapon itself — a modular crystal-tech weapon business-end that
> plugs into this game's universal orbiting mount-socket. Do NOT draw the robot body, no
> character, no hands, no background scenery — just the single weapon object, floating in
> isolation, composed socket end upper-left, business end lower-right (matching this game's
> gun_default/sword_default convention exactly — do not compose it pointing any other
> direction). The back (upper-left) end has a small round socket-connector nub, identical in
> shape/size to this game's existing weapon socket connector, clearly the part that plugs into
> the mount. The weapon is a sealed cylindrical/tapered module with NO hand grip, NO pistol
> handle, and NO trigger guard anywhere on it — nothing in this game has hands or fingers (it
> plugs into a floating socket, nothing ever holds it), so a grip or trigger shape is a
> fiction-breaking mistake; every existing weapon in this game (gun_default.png included) is a
> straight housing with no protruding handle. TRANSPARENT background (real alpha, not a grey or
> white matte fill — this must survive being decoded and checked pixel-by-pixel for alpha). No
> text, no ground/shadow, no character.
>
> The weapon is a longer, more angular precision crystal-tech barrel with a narrow focused
> muzzle (reads deliberate/sniper-ish, not a spray weapon) — a straight tapered tube, the same
> family of shape as this game's own `seeker`/`lasercutter` housings, NOT a handgun silhouette.
> A pale-blue (#81D4FA) glowing crystal core sits visible mid-barrel behind a small transparent
> window. Clean flat ice-crystal facets (NOT painterly frost texture) rim the muzzle, with a
> small snowflake icon badge on the housing (this game's element icon-badge convention).

## `frostseeker` — ice variant of the existing `seeker` frame (legendary)

> 2D game weapon icon art, flat cel-shaded mobile game style, matching this game's locked art
> direction: bold clean uniform black outlines, flat solid colour fills, simple soft cel
> shadows, minimal internal detail, strong readable silhouette, reads clearly at tiny icon
> size. Deliberately FLAT — like a modern 2D mobile game sprite / sticker, NOT a 3D render, no
> realistic metal, no heavy gradients, no photographic texture.
>
> The subject is ONLY the weapon itself — a modular crystal-tech weapon business-end that
> plugs into this game's universal orbiting mount-socket. Do NOT draw the robot body, no
> character, no hands, no background scenery — just the single weapon object, floating in
> isolation, composed socket end upper-left, business end lower-right (matching this game's
> gun_default/sword_default convention exactly — do not compose it pointing any other
> direction). The back (upper-left) end has a small round socket-connector nub, identical in
> shape/size to this game's existing weapon socket connector, clearly the part that plugs into
> the mount. The weapon is a sealed cylindrical/tapered module with NO hand grip, NO pistol
> handle, and NO trigger guard anywhere on it — nothing in this game has hands or fingers (it
> plugs into a floating socket, nothing ever holds it), so a grip or trigger shape is a
> fiction-breaking mistake; every existing weapon in this game (gun_default.png included) is a
> straight housing with no protruding handle. TRANSPARENT background (real alpha, not a grey or
> white matte fill — this must survive being decoded and checked pixel-by-pixel for alpha). No
> text, no ground/shadow, no character.
>
> The weapon reuses this game's existing "seeker" frame's own sleek tracking-bolt rifle
> silhouette — a straight tapered barrel, same overall housing shape, NOT a handgun — but
> re-themed ice instead of neutral: a pale-blue (#81D4FA) glowing crystal core visible through
> the housing and a light frost-rime accent at the muzzle, instead of a plain grey housing.
>
> (If your generation tool accepts a reference image, attach `art/weapon/seeker_raw.png`
> alongside this prompt and ask for "the same silhouette, re-themed ice, no grip" instead of
> relying on the shape description alone — this keeps the two frame-siblings visually
> consistent AND reuses `seeker`'s already-correct grip-less silhouette as a hard visual
> anchor.)

## Workflow reminder (art half)

Save each accepted generation as `art/weapon/<id>_raw.png` (rejects/duplicates into
`art/weapon/leftover/`, not `_alt`/`_alt2` — this batch arrived as several independent full
generations per weapon rather than one accepted + numbered rejects, so a flat `leftover/`
folder was clearer than a naming scheme; keep using `_alt`/`_alt2` for a single weapon's own
reject sequence). Decode with `tools/png-pipeline/pngCodec.mjs`'s `decodePNG` to confirm real
alpha (do not trust the preview by eye — several of this batch's PNGs had a translucent, NOT
fully opaque, background baked in, which looks fine by eye and wrong once decoded), then `node
tools/png-pipeline/compress.mjs --long-axis=320 <file>` (matches every other weapon in
`client/public/weapons/`) and drop the result into `client/public/weapons/gun_<id>.png`.

## Workflow reminder (code half — NOT art, do not skip)

All 6 entries already exist in `WEAPON_DEFS` (`client/src/render/weaponSkins.ts`) as of
2026-08-03, done exactly this way — kept here as the reference for the *next* weapon batch:

1. Add an entry: `path: '/weapons/gun_<id>.png'`, an eyeballed `anchor`, and a `scale` (match
   the `78–90 / 320` range the rest of the table uses — this batch used 78–80/320).
2. Measure each `rotationOffsetRad` for real — do not eyeball it. Load the PNG, take the
   alpha-farthest pixel from the (eyeballed) anchor as the tip, `rotationOffsetRad =
   -atan2(tipY - anchorY, tipX - anchorX)` in image space (y-down) — see the `KIND_DEFAULTS`/
   `WEAPON_DEFS` header comment in that file for the method, and this batch's 6 entries for a
   worked example.
3. `preloadWeaponSkins()` already iterates `allDefs()` (both `KIND_DEFAULTS` and `WEAPON_DEFS`)
   — no change needed there when new entries are added.
4. Verify live: `?wpn=<id>` (dev query param), `beginRun()` + `mainMenu.hide()` from the
   console, hover the mouse due right of the player, and confirm the mounted sprite's tip
   points at the cursor — this is how the wrong-rotation class of bug would actually show up,
   a static screenshot at rest doesn't exercise `rotationOffsetRad` at all.

---

# Mob melee-weapon prompts (SHIPPED 2026-09-06)

`enemyclaw` and `enemymaul` (ENGINE_VERSION 59, `engine/content/weaponSpecs/dropOnly.ts`) are the
only two entries in `client/src/render/weaponSkins.ts`'s `WEAPON_DEFS` table that **point at
another weapon's texture**: `enemyclaw` borrows the player spear's `sword_spear.png`, `enemymaul`
the player hammer's `sword_hammer.png`. That is a deliberate placeholder, not a fallback —
pointing them at `sword_default.png` would trip `muzzleParity`'s "never the kind default" rule,
and pointing them at a path with no PNG behind it would ship a missing texture — but it means a
raider's claw currently reads on screen as a piece of player gear, i.e. as **loot you could pick
up**, which is the opposite of what a mob's weapon should signal.

**Status: both prompts written AND generated 2026-09-06, first attempt each, no rejects.** Live in
`client/public/weapons/sword_enemyclaw.png` / `sword_enemymaul.png`, sources archived as
`art/weapon/enemyclaw_raw.png` / `enemymaul_raw.png`, `WEAPON_DEFS` re-pointed and re-calibrated.

Four things this batch learned that the archived one above could not have, all in "Workflow"
below: the generator returned **WebP, not PNG** (Pillow converts it losslessly — verified
pixel-identical, no image library exists on the Node side of this repo); the alpha came back with
**zero pixels at 255** and a 250-254 plateau, i.e. exactly the pathology `alphaClamp.mjs` was
written for; the composition instruction landed but produced a **diagonal** object where the
archived batch produced flat strips, which is a `scale` problem and not a rotation one; and the
anchor is worth MEASURING rather than eyeballing — doing so put both new entries at **0.0°** tip
error live, against the shipped `enemygun`'s 18.2°.

## What makes these different from every prompt above: the MOB palette

Every prompt in the archive above is for a PLAYER weapon, and they all landed in the player
palette — white/silver housing with a warm gold or element-coloured crystal. The mob roster has
its own, established by `gun_enemygun.png` (the only enemy weapon with real art today) and
sampled straight off that file's pixels:

| role | player weapons | mob weapons (`gun_enemygun.png`) |
|---|---|---|
| housing | white / light silver `#FFFFFF`, `#E0E0F0` | dark blue-grey `#202030` → `#404050` |
| crystal | warm gold / element hue | **violet** `#402080`, `#502090`, `#7030B0` |
| highlight | white | pale lilac `#A080C0`, `#FFD0FF` |

That contrast is the whole point of the pass: at a ~40 px on-screen body the silhouette is barely
legible and **colour is what actually says "this is theirs, not yours"**. Both prompts below state
the palette explicitly rather than leaving it to the shared style paragraph.

Both prompts are **complete, standalone, copy-paste-ready** — the shared style paragraph is
already folded into each one, with the composition/no-grip constraints kept verbatim because they
are the two things this repo's earlier batches actually failed on.

## Prompt 1 — `enemyclaw` (the stalker's claw)

The mob it belongs to: 2 HP, 67% of player speed (the roster default is 41%), a narrow 90° lunge
with 1.1 grid of reach and 1 damage. Its threat is *arriving*, not the swing — so the silhouette
should read fast and light, not heavy.

> 2D game weapon icon art, flat cel-shaded mobile game style: bold clean uniform black outlines,
> flat solid colour fills, simple soft cel shadows, minimal internal detail, strong readable
> silhouette, reads clearly at tiny icon size. Deliberately FLAT — like a modern 2D mobile game
> sprite / sticker, NOT a 3D render, no realistic metal, no heavy gradients, no photographic
> texture.
>
> The subject is a MONSTER-FACTION melee weapon module: a compact three-pronged crystal-tech
> CLAW. Three short curved talons splaying forward from a stubby armoured wrist housing — quick
> and light, like a raptor's foot, NOT a big heavy blade. The talons are sharp violet crystal
> (#7030B0 core, #402080 shadow, pale lilac #A080C0 highlight edge); the housing they grow out of
> is dark blue-grey armour plate (#202030 base, #404050 lit faces) with a thin violet energy seam
> running along it. This is a scavenged, hostile-looking counterpart to the player's clean
> white-and-gold weapons — darker, sharper, cruder, but built from the same crystal-tech
> vocabulary.
>
> Draw ONLY the weapon itself — a modular business-end that plugs into this game's universal
> orbiting mount-socket. Do NOT draw the monster, no body, no character, no arm, no hands, no
> background scenery — just the single weapon object, floating in isolation, composed **socket
> end upper-left, business end (the talons) lower-right** — do not compose it pointing any other
> direction. The back (upper-left) end has a small round socket-connector nub, clearly the part
> that plugs into the mount. **The weapon is a sealed module with NO hand grip, NO handle, and NO
> finger holes or knuckle guard anywhere on it** — nothing in this game has hands or fingers (it
> plugs into a floating socket, nothing ever holds it), so a grip or a fist-weapon shape is a
> fiction-breaking mistake, not a style nitpick. TRANSPARENT background (real alpha, not a grey
> or white matte fill — this will be decoded and checked pixel-by-pixel for alpha). No text, no
> ground shadow, no character.

## Prompt 2 — `enemymaul` (the ravager's maul)

The mob it belongs to: 8 HP, armoured, a 150° sweep with the heaviest knockback in the game and
the slowest attack (1.8 s). Its threat is *being near it* — so this one SHOULD read heavy, and
should read heavy at a glance against the claw above.

> 2D game weapon icon art, flat cel-shaded mobile game style: bold clean uniform black outlines,
> flat solid colour fills, simple soft cel shadows, minimal internal detail, strong readable
> silhouette, reads clearly at tiny icon size. Deliberately FLAT — like a modern 2D mobile game
> sprite / sticker, NOT a 3D render, no realistic metal, no heavy gradients, no photographic
> texture.
>
> The subject is a MONSTER-FACTION melee weapon module: a heavy blunt crystal-tech MAUL. A thick
> chunky slab of a hammer head — blocky, top-heavy, obviously massive — on a short stout neck.
> The head is dark blue-grey armour plate (#202030 base, #404050 lit faces) with a raw violet
> crystal block embedded in the striking face (#7030B0 core, #402080 shadow, pale lilac #A080C0
> highlight) and a violet energy seam glowing along the neck. Crude and brutal, with a couple of
> chipped corners — scavenged monster gear, the hostile counterpart to the player's clean
> white-and-gold weapons, built from the same crystal-tech vocabulary. It must read HEAVY at a
> glance, clearly distinct from a light clawed weapon.
>
> Draw ONLY the weapon itself — a modular business-end that plugs into this game's universal
> orbiting mount-socket. Do NOT draw the monster, no body, no character, no arm, no hands, no
> background scenery — just the single weapon object, floating in isolation, composed **socket
> end upper-left, business end (the hammer head) lower-right** — do not compose it pointing any
> other direction. The back (upper-left) end has a small round socket-connector nub, clearly the
> part that plugs into the mount. **The weapon is a sealed module with NO hand grip, NO handle,
> NO pommel and NO long haft** — nothing in this game has hands or fingers (it plugs into a
> floating socket, nothing ever holds it), so a grip or a long two-handed shaft is a
> fiction-breaking mistake, not a style nitpick; keep the neck SHORT, the head is the weapon.
> TRANSPARENT background (real alpha, not a grey or white matte fill — this will be decoded and
> checked pixel-by-pixel for alpha). No text, no ground shadow, no character.

## Workflow (art half) — as actually run, 2026-09-06

1. **The generator returned `.webp`, not `.png`.** Nothing on the Node side of this repo can
   decode WebP (`pngCodec.mjs` is a hand-rolled PNG codec, and there is no image library);
   **Pillow is installed and does**, and the conversion is lossless — verified with a
   pixel-for-pixel array compare, not assumed:

   ```python
   from PIL import Image
   Image.open(src_webp).convert('RGBA').save('art/weapon/<id>_raw.png')
   ```

   The originals were kept, moved into `art/weapon/leftover/` — they are byte-originals, not
   rejects, but that is where the previous batch's `.webp` files already live.

2. **Decode the alpha before trusting it**, and expect this exact shape. Both files came back
   with **zero pixels at alpha 255**: a 250-254 plateau (26-32% of the canvas) wrapped in a
   1-10 veil (~0.5%). That is the pathology `alphaClamp.mjs` was written for, and its defaults
   are correct for it:

   ```bash
   node tools/png-pipeline/alphaClamp.mjs client/public/weapons/sword_<id>.png
   ```

   Verify it the way that tool's own header asks: the post-clamp bbox should match the bbox
   measured at `alpha > 25` on the ORIGINAL. Here it matched within 1 px on every edge, and
   `alpha-audit.mjs` then called both files clean.

3. `node tools/png-pipeline/compress.mjs --long-axis=160 <file>` — **160, not the 320 the
   archived section above says.** Every file in `client/public/weapons/` went 320 → 160 px on
   2026-08-25 for the WeChat package budget, and all 27 `scale` divisors in `WEAPON_DEFS` moved
   with them. Run it AFTER the clamp: compress is what trims, and the point is to fix the alpha
   before the trim reads it. Result here: 1920² → 159×160 and 160×156, ~27 KB each.

## Workflow (code half — NOT art, do not skip)

Both entries already existed in `WEAPON_DEFS` (`client/src/render/weaponSkins.ts`), so this was
an edit. **None of the three calibration fields survived the swap**, and the second and third are
the ones a future batch will otherwise get wrong:

1. **`path`** — the only trivial one.

2. **`rotationOffsetRad`: re-measure, never inherit.** The old values (~-161°, ~+174°) were
   cancelling the SPEAR's and HAMMER's own baked pointing direction, which is a property of those
   files. Load the PNG, take the alpha-farthest pixel from the anchor as the tip, then
   `rotationOffsetRad = -atan2(tipY - anchorY, tipX - anchorX)` in image space (y-down). New
   values: **-47.1°** and **-53.8°** — not the near-zero the prompt's "socket upper-left, business
   end lower-right" instruction suggests, because that instruction produces a genuinely DIAGONAL
   composition while `gun_default`/`sword_default` run closer to horizontal. That is fine; the
   offset exists precisely to absorb it.

   Validate the method before trusting it on new art: run it against five shipped entries and
   check it reproduces their published numbers. It did here, within a few degrees — the residual
   being their own eyeballed anchors, see point 4.

3. **`scale`: choose it against the object's ALONG-AXIS length, not its width.** This is the
   trap. The diagonal composition puts a ~200 px-long object inside a ~160 px-wide texture,
   where the archived batch's flat strips were ~165 px long inside 160 px wide.
   `rigComposition.test.ts`'s module-proportion band measures `pngWidth × scale × MODULE_SCALE`,
   so **keeping the placeholder's divisor would have passed every gate while rendering these
   ~40% longer than what they replaced.** Compute the length as
   `hypot(tip - anchor)` in texture px and pick the divisor that reproduces the previous
   rendered length: 60/160 and 80/160 here, giving 55.7 vs 55.6 and 65.6 vs 65.5 authoring px.

4. **`anchor`: measure it too.** Every previous batch eyeballed this, and the table's header says
   so. Measuring it costs ten lines — take the centroid of the alpha mass in the first 12% of the
   object's long axis from the socket end, i.e. the middle of the connector nub rather than the
   extreme pixel off the end of it — and it is worth it: driven live, both new entries put the
   weapon's tip **0.0°** off the direction of the target, while the shipped `enemygun` measured
   the same way in the same frame is **18.2°** off. Prefer this to eyeballing from now on.

5. `preloadWeaponSkins()` already iterates `allDefs()` — nothing to add there.

6. **Verify live, MOVING** — a static screenshot at rest does not exercise `rotationOffsetRad` at
   all, and at a ~40 px body these modules are ~20 px on screen, which is too small to judge by
   eye. Drive it numerically instead: start a run from the console (`mainMenu.onPlay()` →
   `modeSelect.onSolo()` → `forge.onStart()`, then `gameLoop.stepSim()` in a loop — never await
   rAF), park mobs at known offsets from the player, and compute the mounted tip's screen
   direction from the SPRITE's own `rotation` and `scale` rather than from `worldTransform`
   (which is stale outside a render pass and will silently hand back the untransformed texture
   angle — it did here, and the reference weapon reading "correct" was the only tell). Always
   include a weapon with SHIPPED art in the same frame as the control: a harness that reports 0°
   for everything is not measuring anything, and the shipped entry's 18.2° is what proves it can
   fail. Note that at aim ≈ 180° every weapon including the shipped ones reads ~180° off under
   this model — that is the facing mirror, pre-existing and identical for shipped art, not a
   defect in the new entries.
