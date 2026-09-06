# Art & animation pipeline

How pixels get onto the screen: **skins** (the `02` appearance layer made concrete), the **spritesheet/atlas + animation-data format**, the **asset-loading path** (web and WeChat), and the **art constraints the tilted view imposes** (`01`). It builds on the Actor/Skin/Weapon split (`02`), the rendering/depth model (`01`), the WeChat asset constraints (`04`), and the events channel (`08`). This doc is the source of truth for **what an art asset looks like, how it loads, and the hard rule that art is pure presentation — it never feeds the engine**.

> **Status (2026-08-02): the pipeline defined here is built and carrying real art.** The
> `.tao` rig runtime ships in the game (`render/`), `tools/animator` authors it, and the
> bound roster is the full 3 characters + boss/critter/brute/floater enemies + a distinct
> sprite for every ranged/melee weapon id + biome floor/wall art + UI/NPC art. The original
> Graphics-only slice (procedural rectangles/ellipses/glows in `Skin.ts`) survives only as
> the fallback drawn when a skin has no atlas entry, and for BULLETS, whose few world px make a
> sprite pointless. (Until 2026-08-20 this sentence also named pickups and the portal as
> "never planned as sprite art" — a judgement made while the walls were still flat rectangles.
> Both now ship real art; see the Update at the bottom of this doc.) The dated Update notes at the bottom of this doc record
> how each piece landed. **Update (2026-08-03): ROADMAP 5.3/5.4 are both closed too** — the
> GPT-Image-2 art this pipeline generates is now treated as final production art (not a
> placeholder awaiting an authored replacement), which also unblocked dynamic/normal-map
> lighting (shipped as a shader-derived approximation, no normal-map asset needed) and the
> four fidelity-roadmap custom shaders. What remains open is only `04` (WeChat device
> verification, blocked on hardware) and real authored SFX/music (`11`, a sourcing/licensing
> task, unrelated to this pipeline). **Update (2026-08-17): the runtime was assembling that
> art wrong** — bone sprites drawn at each bone's pivot instead of its tip, and rotated by the
> bone's raw world angle — which disassembled every rigged character on screen (the hero read
> as a bare ball with a gun on its head) while every individual asset was fine. Fixed, plus the
> energy tether is now actually drawn; see the dated update at the bottom of this doc. The
> module-proportion call that used to be listed here as remaining was settled the same day —
> `MODULE_SCALE = 0.75` (`render/weaponSkins.ts`), the user's own pick between matching the
> concept's ~0.5 ratio and keeping every weapon frame's silhouette readable at gameplay
> scale. **Update (2026-08-18): the facing model got two real corrections** (aim-driven body
> + continuously-tracking eye, see "Facing model" below) and `01`'s per-weapon front/back
> z-order rule — documented since `01` was written, never implemented — now actually runs.
> The one art gap left in this pipeline WAS the **back set beyond the eye**; the half of it that
> mattered in play is closed as of 2026-08-24, with no new art. A character facing away used to
> keep drawing the transparent `belly` chamber set into its FRONT, which is the second of the two
> fixes offered under "Facing model" below — hide it rather than paint a `belly__back`.
> `RigSkin`'s new `FRONT_ONLY_BONES` set does exactly that, and only when no `${boneId}__back`
> texture exists, so shipping the PNG later supersedes the hide for free. `shell__back` remains
> genuinely optional: design/13 chose a radially-ish-symmetric body partly so front/back sets
> nearly collapse, and the shell reads the same from either side.

## The decisions (locked)

- **Art is pure presentation and never decides an outcome.** Animation, textures, and particles read `GameState` + the per-frame `events` queue (`08`) and draw. They **never** write back to engine state, never gate a hit, never advance a tick. A frame event may *trigger* a muzzle flash, but the engine already decided the shot (`08`'s "events are the only engine→render channel"). This keeps determinism intact (`06`): two clients can run different art/quality tiers and stay byte-identical in simulation.
- **Skin = animation-rig + swappable atlas, decoupled (`02`).** Animation data (frame timing, anchors, event frames) is authored **once per rig** and shared; a skin is just "which atlas fills this rig." Swapping a skin swaps the texture atlas key, not the animation logic (`02`'s "build it this way from the start, or adding skins later hurts").
- **A skin is a character with balanced stats (`14`), but its *art* is still pure presentation.** Each skin carries its own `(maxHp, maxShield, maxEnergy)` + break-passive (`05`/`09`/`14`) — there is no cosmetic-only reskin layer, and unlike the earlier plan the character (incl. passive) **does apply in PvP**, kept fair as a side-grade by balance discipline (`14`), not normalized out. What stays true for *this* doc: the **art** never decides an outcome (above) — the stat differences live in `SkinDef` data (`09`), the pixels just draw the character. Silhouettes should telegraph the character's archetype (`13`).
- **Tilted-view-native art (`01`).** Every actor/prop is drawn with a small front face (not a pure top-down sprite), authored for `screen.y = gy - z` and Y-sort by `gy`. Sprites have a defined **ground anchor** (feet at `gy`) and a **height extent** so shadows and occlusion read correctly (`01`).
- **Placeholder-first, atlas-later.** Systems consume a `Skin`/texture interface; the *slice* fills it with `Graphics`, real art fills it with atlas frames — same interface. Gameplay is never blocked on art (`02`/`03`'s data-driven intent).
- **Animation = funny's skeletal editor + `.tao`, copied in and locally maintained.** Reuse `funny/tools/animator` (2D skeletal, PixiJS) and its `.tao` format rather than a new tool or DragonBones/Spine; files save to **local disk only** (no shared workspace). Full rationale + model in the Animation section below.

## Animation: reuse funny's skeletal editor (`.tao`)

**Decision (locked, 2026-07-23):** DayDayUp does **not** build a new animation tool and does **not** adopt DragonBones/Spine. It **reuses funny's home-grown 2D skeletal editor** (`funny/tools/animator`, PixiJS) and its `.tao` runtime format. Rationale: the engine already mirrors funny (`06`), the editor's runtime math is dependency-free and *designed to be copied into the game* (below), it already supports weapon mounting, and it has no third-party runtime or licence. This is the concrete answer to this doc's old "animation-data source of truth" open question, and the implementation of `02`'s `Skin { rig, atlasKey, socketAnchor() }` (the weapon mount is the orbiting socket, not a hand — `13`).

- **The rig is our own, purpose-built for the orb-core** (`13`) — a tiny hierarchy: `root → shell → eye + belly-fill + 2× orbiting weapon-socket`. **No arms, no legs → no humanoid skeleton and no walk cycle**; motion is hover-bob, lean into travel, and squash-stretch on `root`. funny's fixed 11-bone humanoid `Skeleton` is **not** adopted — we take only its dependency-free FK / `sampleClip` runtime math and the `.tao` format, and author our own small rig defs (one per body archetype: orb-core, crystal critter, boss core). The rest pose faces the camera; left/right is a flip. The editor is rewritten for this project (below), so it holds **multiple rig definitions**, not one hardcoded humanoid.
- **Two-layer params = `02`'s "skin = rig + atlas".** **Binding** is the static per-skin rest pose (`anchorX/Y`, `rotation`, `scaleX/Y`, `flipX`, `zOrder`); **Keyframe** is the per-frame delta (`rotation`, `translate`, `scale`, `alpha`). A skin is the same skeleton with its **own part PNGs + Binding** — swapping a skin swaps the parts, never the animation clips.
- **The runtime is pure and render-only.** `Skeleton.computeFK` (forward kinematics) and `interpolate.sampleClip` (keyframe interpolation) are **no-DOM / no-Pixi / no-dependency** pure functions — ported straight into `@dd/engine`'s **render side**. They read `GameState` + the `events` queue (`08`) and draw; they **never** feed the sim (`06`) — the locked "art never decides an outcome" rule, made literal.
- **Weapons mount to the two orbiting weapon-socket bones — for the body plan that HAS them.**
  Since 2026-08-21 the mount is a declared property of the rig (`RigDef.weaponMount`, resolved by
  `render/rigWeaponMount.ts`) with three values, because the roster turned out to need three:
  `'socket'` is the rule below (orb-core, the hero); `'held'` mounts a single module on the body
  art's own measured edge, for the enemy body forms, which have no socket bone and no arms to hang
  one off; `'none'` draws no weapon at all (boss-core, whose shard rings are its armament, `13`).
  The default for a rig that declares nothing is deliberately conservative — `'socket'` only if the
  socket bone exists, else `'none'` — so a new body plan has to ASK for a weapon rather than sprout
  one. The rest of this bullet describes the `'socket'` path. A `.tao` declares attachment points (bone + offset); each of the two sockets orbits the core on a tether and **rotates to the exact aim angle** — the weapon module (barrel / blade) is a sprite parented to a socket, following its FK pose every frame (`13`'s universal mount, `02`'s "the mount follows the frame, weapon tracks it"). Swapping the active weapon slot (`03`) swaps the sprite at that socket; front/back z by facing is the attachment draw order (`01`). There is **no `gear_hand` and no per-weapon `grip`/arm-clip** — a socket is arm-agnostic, so one mount holds any frame, ranged or melee; melee's swing is the socket sweeping its arc (the deflect sector, `03`/`13`) and the tether length sets melee reach. **Rarity reads off the mounted weapon** via a per-rarity ornament/emissive overlay on the frame sprite (not a separate sprite per rarity — that would multiply `03`'s frame×element production); the overlay uses the rarity border palette (白→蓝→紫→橙→金, `14`), kept distinct from the element-FX colour language (`13`).
- **No per-frame animation events.** FX (muzzle flash, impact) are triggered by the engine `events` queue (`08`) — "events are the only engine→render channel" — **not** by animation frames, so the visual can never drift out of sync with the sim hit window (this retires the old event-alignment worry). Purely-cosmetic cues (a footstep puff) derive from the run clip's own time, render-side only.
- **Shadow is program-drawn** (funny's shipped approach): a `shadow` attachment point carries only position + ellipse size — the runtime draws one shared soft ellipse, zero texture, always flat on the ground. No shadow is ever baked into a sprite (`01`).
- **Formats:** `.tao` (a zip of `animation.json` + packed `spritesheet.png/json`) is the runtime asset; `.editortao` (source PNGs + edit state) is the working file — a single dot-segment extension (not the old compound `.tao.editor`, which OS file associations and some save dialogs don't round-trip reliably). **Files are saved to local disk only — no shared/online workspace** (funny's Supabase/Workers/GitHub-sync bridge is dropped for this project). The editor's IndexedDB autosave is a local convenience; the disk `.editortao` is the source of truth, committed to the repo alongside the exported `.tao`.
- **The tool is copied in and maintained here.** `tools/animator` is lifted into DayDayUp and **owned/maintained per-project** (it will diverge — rig defs, export tiers, etc.) — not a live dependency on funny.

### Facing model (twin-stick 360° aim)

funny is a lane auto-battler (units only face left/right); DayDayUp aims in **360°**, and a 2D bone rig gives L/R flip + part rotation, **not** a true 3D turn. Chosen model — **two-hemisphere billboard + aim-driven sockets + a continuously-tracking eye**. The orb-core makes this cheap: it is radially-ish symmetric, so the front/back sets nearly collapse.

> **Two corrections shipped 2026-08-18, both from the same root cause: the billboard's four
> discrete states (L/R flip × front/back) were carrying the whole 360° read, and they were
> being driven by the wrong angle.**
>
> 1. **The body follows AIM, not movement.** The implementation had put `setBodyFacing` on
>    the movement vector, as a humanoid "upper body aims, lower body walks" split inherited
>    from funny. The orb-core has no lower body, so there was nothing for that split to
>    describe: strafing left while firing right pointed the eye away from the target, and
>    standing still held whatever direction the player last walked. `Scene.reconcile` now
>    turns the body toward the aim through `render/facing.ts`'s `turnToward`, rate-limited to
>    `BODY_TURN_PER_TICK` (0.27 rad/tick ≈ a 0.4 s about-face) — the limit matters because
>    auto-aim-to-nearest (`10`) makes the aim angle jump the instant a closer enemy appears,
>    and snapping the body to it read as a twitch. `Scene.positionLocal` (the co-op predicted
>    -pose path, which runs at render rate) deliberately carries the value forward instead of
>    re-deriving it, or the body would turn at double speed.
> 2. **The eye tracks continuously, with no new art.** For a body plan that is mostly one big
>    eye (`13`), the direction cue nobody has to be taught is where the eye is *looking*, so
>    the `eye` slot now slides inside the shell along the aim on an ellipse (`EYE_TRACK_R` =
>    14 authoring px, vertical travel squashed to 45% because this is a tilted view, `01`),
>    shrinking up to 15% as the aim turns away from the camera. Computed in **canonical
>    (pre-mirror) space** like the sockets, so it lands on the correct side of the shell after
>    `view.scale.x` flips the rig. That turns four poses into a continuum using `eye.png`
>    exactly as it already ships.
>
> ~~Still open, and the only part of this that would need new art:~~ **Closed 2026-08-24** by the
> second option this paragraph already named. When the back set shows, the eye swaps to
> `eye__back` and the front-facing `belly` chamber is now HIDDEN rather than drawn as though the
> character were still facing the camera — `RigSkin`'s `FRONT_ONLY_BONES`, gated on there being no
> `${boneId}__back` texture, so a future `belly__back` PNG takes over with zero code change. Note
> what that set is keyed off: what the art DEPICTS, not which bones lack back art. `shell` lacks
> it too, and hiding the shell would delete the character.

> **Update (2026-08-18, later the same day): a *volume* pass on top of the facing pass.** The
> user's reply to the above was that the character did now read as having direction — *"眼睛和手
> 能按方向变化了"* — but still not as having **form**: *"我希望能再强化一下立体效果"*. The facing
> model was doing its job; what was missing was lighting and grounding, neither of which any
> amount of facing work produces. Three additions, all render-only and all free of new art:
>
> 1. **Sphere shading** (`render/rigShading.ts`) — marks over the rig's body bone, pinned to the
>    key light's *screen-space* direction so they do **not** mirror with `view.scale.x`. This is
>    what makes a flat-cel shell read as a sphere: the eye travels, the light does not. Applied to
>    any rig whose body bone has a `bodyR` worth shading, so enemy and boss bodies get it too.
>    Nothing is masked (a mask per actor would be 30 stencil passes in a busy room), so every mark
>    has to stay inside the body — `rigShading.test.ts` pins that invariant, since it is the one a
>    tuning change could silently break.
>
>    **Both halves of this were wrong and were rebuilt 2026-08-19** (see `01` "Volume, measured").
>    The marks were a white specular plus four concentric dark arcs: measured, the specular is
>    arithmetically a no-op over design/13's near-white shells and the arcs put their darkest band
>    on the rim with hard angular cut-offs, reading as dirt rather than as a turning surface. They
>    are now a smooth chord-band ramp with a reflected-light rollback, plus a warm wash for the lit
>    side (hue is the only channel white art leaves available). And "strictly inside `bodyR`" was
>    the wrong bound: `bodyR` is a *declared* radius, the art paints 0.68-1.00 of it, so the marks
>    were spilling onto the transparent background — see "A bone's `bodyR` is a declared radius"
>    below.
> 2. **Far-side depth cues on the modules** — the per-weapon z-order flip (item 2's sibling,
>    shipped hours earlier) reads on its own as "the module changed layer". A depth scale and a
>    depth tint on top of it read as an orbit around a sphere. Recomputed against the current
>    `showBack` every frame, not in `setWeaponTint`, which only knows the element hue.
> 3. **Hover + a shadow that responds to it** — see `01` "Grounding the character". Worth
>    noting *here* because it is the one place an authored clip and the runtime overlap: the
>    `idle` clips already bob the body's bones, but a clip cannot move the shadow, so the
>    height half of the hover now lives in `Entity.visualZ` and the two stack.

- Body plays its hover/idle authored facing the camera; **L/R mirror** by the horizontal sign of the aim/move vector.
- A **front and a back body set**: aim toward the bottom of the screen (toward camera) draws the front (the eye), toward the top (away) draws the back (a lens/vent where the eye would be — the concept turnaround). Picked by the aim vector's **vertical hemisphere**, so all 360° reads correctly. For the orb this back set is a **single swapped part** (eye→vent), not a whole second body.
- The **two orbiting socket bones rotate to the exact aim angle**; the mounted weapon module follows, so the muzzle (or the blade's sweep) always points at the reticle. **Since 2026-09-02 the ACTIVE socket bone is also *turned* to the aim before FK runs** (`rigWeaponMount.orbitActiveSocketToAim`), so the whole assembly — bone tip, socket ring, the tether drawn out to it, its contact shade on the core, and the mounted module — travels around the core together. It used to stay at its rest angle with only the module spinning in place, which put the drawn gun up to a socket-length off the line its own bullets fly along and drew a visible arc out of the barrel (`01`'s bullet-spawn section has the measurement, the fix, and why orbiting the module alone is not enough). The idle socket still hangs on its own bone, pointing outward. This is what `13`'s "two weapon modules that orbit it" always described.
- **Shippable in stages:** front-only first (sockets aim + L/R flip); the back part-swap is a trivial content add, **no engine change**.

### Render clock

Animation is time-driven on the **render clock**, not the sim clock. Sim is 30 Hz (`08`); art plays at any authoring fps and interpolates via `sampleClip`. Which clip plays is a pure function of `GameState` (moving? attacking? `hp<=0`?) each render frame — it holds no authoritative data.

### Attacking: one rule, two layers (2026-09-02)

From a live question — *"角色现在有攻击动画吗？射击的和拿刀时的"* — whose honest answer was
"half a shooting one, and nothing at all for a blade". **Every attack now drives the same two
layers**, whether it is a shot or a swing, on every one of the seven shipped rigs:

| layer | file | what it owns | why it cannot be the other layer |
|---|---|---|---|
| authored `attack` clip, layered **additively** over `idle`/`move` | `render/rigClipLayer.ts` | squash/stretch, the body's jolt, a boss's shard rings flaring — everything statable in the rig's own bone space, per body plan | it is per-character art; there is nothing to compute |
| aim-relative envelope | `render/rigAttackMotion.ts` + `render/attack/{swingShape,shotShape}.ts` | a gun's kick back along the BARREL + body lean + **muzzle climb**; a blade's sweep or **thrust**, plus a forward lunge — every magnitude and every duration **derived from the weapon that attacked** (2026-09-02, both kinds — see below) | it is a function of the live aim angle AND of the weapon — neither is authorable |

Both are started by one call, `Actor.onAttack(kind, shape)`, from one place: `EventReactor`, off
`bullet_fired` or `melee_swing`. Only the envelope's SHAPE differs by kind. The `shape` is the
attacking weapon's own numbers, converted out of the sim spec at that one read site
(`controllers/attackShapes.ts`) — the render layer holds no engine units.

**Why the aim-relative half cannot be authored data**, which is the part worth remembering:

1. a clip's `translateX` is applied in RIG space (`RigSkin.update`: `sprite.x = pose.ex +
   transform.translateX`), so an authored `-10` slides the gun LEFT, not backwards along its own
   barrel — that is exactly what the hero's original `attack` clip did; and
2. the weapon sockets are **aim-tracking bones** — `RigSkin` overwrites their rotation with the
   aim angle every frame — so an authored swing arc is discarded in silence. A blade can only be
   swung procedurally.

### The swing is the weapon's, and so is the sector on the ground (2026-09-02b)

The envelope above shipped with ONE hardcoded sweep — 22° behind the aim to 46° past it, 260 ms —
for every melee weapon in the game, because the trigger carried only `kind`. The authored sectors
run from the spear's 60° to the hammer's 220° (`engine/content/weaponSpecs/*.ts`), so the spear's
animation was wider than the sector it can hit in and the hammer drew 31% of its own. `DeflectSystem`
parries bullets in that same `arcHalf`, which is what made it worth fixing rather than a flourish:
the animation was misinforming the player about their own parry.

`swingSchedule(shape)` now derives both numbers from the weapon — travel `= arcDeg × (68/162)`
clamped to [26°, 104°], envelope `= recovery × (260/366.7)` clamped to [130, 400] ms. **Both factors
are defined as the ratio between the starter saber's shape and the constants hand-tuned against
it**, so the starter weapon's look is unchanged by construction rather than by luck, and a caller
with no weapon (the `Graphics` placeholder, any enemy — none carry melee) gets that same default.
The clamps are about the BODY: the blade hangs off an aim-tracking socket, so past ~100° it sweeps
through the character rather than around it.

*(The envelope half of that paragraph was superseded twice the same day: first by `ENGINE_VERSION`
53, which moved the STRIKE onto the weapon's real hit window, and then by "the weapon decides how
heavy it is" below, which put the FOLLOW-THROUGH on the recovery. The travel half stands as
written, with a thrust term added. See both sections.)*

**The sector itself is now drawn** (`client/src/game/fx/slashArc.ts`), at the weapon's true
`arcHalf` and `range` — unclamped, because that fx exists to state the reach, where the envelope's
clamps exist to keep a body legible. It is this renderer's only `Mesh`: the look needs alpha varying
radially AND along the sweep at once, and a `Graphics` can carry only a one-dimensional ramp
(`render/shadeRamp.rampFill` maps a gradient through a texture matrix, and a matrix cannot express a
polar mapping).

**Its brush is the second confirmed case of this doc's generate-it-don't-prompt-it rule** (the first
was the shield's scale tile). The asset is a radial profile times a tail profile — a parametric
alpha field you converge on by editing a number, with a hard requirement (additive-clean at any arc
width) that an image model is bad at and no material for it to be good at. So it is baked at boot
through `shadeRamp.bakedField`: 256×64, POT + mipmapped, premultiplied white, tinted per element,
**zero bytes** against `04`'s package budget. One bake covers 60° through 220° because the angular
span lives in the geometry while the brush is parametrised on FRACTIONS — sweep fraction along `u`,
radius fraction along `v` — so nothing stretches at any width. Reach for the image model here only
if the swing wants a MATERIAL (ink grain, a hammered edge); that would multiply into the same baked
field and change no geometry.

### The weapon decides how heavy it is — both kinds (2026-09-02d)

From a live report on the pass above: the sector fx reads well, but the MOTION did not match it —
*"能将动作幅度也匹配上吗？而且武器的攻击间隔也不同，最好也能对应调整一下动作的播放时间，这样
对于重型武器和轻型武器的感觉就能区分开了。然后再看看开枪的动作也做些优化。"* Three asks:
amplitude, pacing, and the gun. Four channels were still constants shared by the whole roster.

**Melee — the follow-through is the recovery, not the window.** v53 anchored `strikeEndMs` on the
active hit window, correctly, and that half is untouched. But it then sized the WHOLE envelope as
`windowMs / 0.55`, so the tail was a fixed 82% of the window for every weapon: the hammer snapped
back to guard in 164 ms and then stood still for the remaining ~300 ms of its own recovery. The two
segments now come from the two quantities that describe them —

| segment | input | why only that field can say it |
|---|---|---|
| wind-up + strike | `swingTicks` (the hit window) | the ticks `HitResolveSystem` can connect on |
| follow-through | `swingCooldownTicks` (the recovery) | how long until you may swing again |

— and `FOLLOW_SHARE` is **defined as the value that reproduces the pre-existing saber tail exactly**,
so this is the roster spreading out around the reference rather than a retune of it. Envelopes go
from 182-364 ms (a 2.0× spread, tracking only the window) to 194-418 ms (2.16×, against the
recovery's own 2.22×). "The stroke fits inside its own recovery" also stops being a tuned clamp and
becomes **structural**: `window + (recovery − window)·s ≤ recovery` for any `s ≤ 1`, and `toSimSpec`
guarantees `window ≤ recovery`.

**Melee — a narrow sector is a THRUST, not a small sweep.** The 26° floor above is where a
rotation-only motion stops being honest: the spear's 60° sector derives 25°, gets clamped up, and
draws a miniature swing of a sector that is not an arc — while its 2.1-grid reach, the longest in
the roster, goes unstated. Under 145° the motion trades rotation for a slide down its own barrel,
linearly to a pure thrust at 60°. The channel already existed and is the gun's recoil with the sign
reversed (`AttackMotion.modulePx` is now signed for both kinds), so this cost no new plumbing. The
knee is deliberately 145 and not 150 — 150 is the stormglaive's authored sector, and a knee sitting
on a shipped weapon is decided by brad quantization (75° round-trips to 74.998°).

**Melee — the body commits as hard as the swing shoves.** `knockback` is the only field in the sim
that states how hard a swing hits (hammer 12 grid/s, saber 6, leech 3), so the lunge scales with it,
`√(k/6)` clamped to [0.6, 1.8]. Sub-linear because `knockback` spans 4× and this is a body offset in
authoring px. Its fp round trip is **lossy by ~1%** — `toFpPerTick` truncates, so 6 grid/s reads back
as 5.94 — which is the one input on which the reference does not reproduce to the bit; recorded
rather than papered over.

**Ranged — the kick fits the cadence, and it was a real defect that it did not.** Every gun kicked
for 150 ms, tuned against the blaster's 200 ms cadence and applied to all eighteen. The repeater and
the flamer fire every 100 ms, so the next shot restarted the envelope halfway out and **the gun
never came back** — permanently displaced for the whole of a held trigger, snapping home on release.
The envelope is now `interval × 0.75` (again, the ratio that reproduces the blaster exactly) clamped
to [70, 380] ms. The ceiling was chosen by measuring how much of the roster it swallows: at 260 ms
thirteen of eighteen guns pinned to one value, which is the same "every gun feels the same" defect
moved rather than removed.

**Ranged — magnitude off the shot, and a third channel that is actually visible.** `punch` is damage
per TRIGGER PULL (`damage × bullets`), so the scattergun's five pellets kick like a slug rather than
like five blasters; `√punch` clamped to [0.7, 2.2], the upper bound catching the novaburst's
ten-bullet ring, which is radial and has no direction to be shoved away from anyway. And the recoil
now **rotates the muzzle up** as well as sliding it back. That matters more than it sounds: the
slide is foreshortened to nothing when firing toward or away from the camera — half of all aim
angles — while the rotation reads at every one of them. It goes through the socket-angle channel the
melee sweep already used, which is why `AttackMotion.swingDeg` is now `weaponDeg`.

`rigAttackMotion.ts` became a three-file module under the 500-line convention: the two pure
derivations are siblings (`attack/swingShape.ts`, `attack/shotShape.ts`) and the shell keeps the
clock and re-exports them, so no import path moved.

Both halves are cross-checked against the sim rather than against restated numbers:
`client/src/game/fx/meleeArcParity.test.ts` drives the real `HitResolveSystem` and pins the drawn
edge to `arcHalf` exactly, the drawn reach to `range` with the hit boundary exactly one target
radius further out (bodies, not points — so the lit edge always connects), and that the arc sweeps
the same way the blade does in both facings. See roadmap volume `15`.

**The additive contract** the clip layer runs on: `rotation`/`translate` ADD, `scale`/`alpha`
MULTIPLY, and a bone the attack clip does not name is left on its base clip untouched. That is
what makes an `attack` playable at all (see the superseded note below). It puts one real rule on
the art: **an `attack` clip must start and end at identity**, or the layer steps the pose on the
frame it triggers and again on the frame it expires. `rigComposition.test.ts` asserts that per
bundle, plus that every bundle carries the full six-clip vocabulary and that every looping clip
returns to its own first pose.

**The enemy bundles gained `move` and `attack` in the same pass** (`boss-core`, `brute-core`,
`critter-core`, `floater-core` — they had only `idle`/`hurt`/`death`/`spawn`). The missing `move`
was a live bug on its own, not just a gap: `Actor` has always asked for `'move'` while an actor
is moving, and `playClip` resolves an unknown name to NO clip, so a walking mob fell back to a
bare rest pose and lost even its idle bob.

**The melee half needed an engine change** (`ENGINE_VERSION` 52): there was no signal at all that
a swing had happened. `deflect` only fires when a swing catches a bullet and `hit` only when it
connects, so a sword swung at empty air reached the render layer as nothing. `WeaponFireSystem`
now emits `melee_swing` with the identical field list to `bullet_fired`. It is an EVENT rather
than a render-side read of `weapon.justSwung` — which is already hashed sim state — because
`justSwung` is a one-tick latch and `GameLoop.advanceOnline` drains every confirmed frame the
server has ready before reconciling the scene ONCE; any swing on an intermediate frame would
simply not be in the state the render layer sees. See `ENGINE_VERSION_HISTORY.md` v52.

> **Superseded: "Firing is NOT a clip" (2026-08-30, user report *"角色射击时，没有射击动画...
> 看起来非常死板"*).** Kept because its reasoning is still the reason the layer above is ADDITIVE.
> At the time, `attack` was authored in the three `char_*` bundles and had never been played, and
> that was structural rather than an oversight: clips are sampled WHOLE, `RigSkin.playClip`
> swapped `this.clip` outright with no additive layer, and the four ENEMY bundles shipped no
> `attack` clip at all. So playing it would (a) do nothing for any mob, and (b) for a hero, drop
> every bone the clip does not track back to rest for its duration — orb-core's `attack` touched
> only `socket_r`, so the shell/eye/belly hover bob authored into `idle` snapped to 0 the instant
> a shot went out and snapped back 350 ms later; and the starter blaster's 6-tick (200 ms)
> cooldown is shorter than the clip, so held fire pinned the body at bob 0 and release popped it.
> That note ended by saying the clips were "still the right home for a real per-character firing
> pose, once every rig has one and there is a blend to play it through" — 2026-09-02 supplied
> both. The envelope did not go away; it became the aim-relative layer of the table above.

> **`hurt`/`death`/`spawn` were listed as still-unplayed when this section was written.**
> They landed the same day; see the section directly below, which is also where the reason the
> additive contract could not carry two of the three is written down.

### The rest of the vocabulary: hurt / death / spawn (2026-09-02)

The other half of the same pass, and the entry that closes the "still open, deliberately" note the
attack section left behind. All six clips have shipped in all seven bundles since 2026-09-02; three
of them had been played by the end of it. `hurt`, `death` and `spawn` had not, and the reason was never the art
— it was that `Actor` received no signal for any of them. All three signals already existed:

| clip | signal | who owns it |
|---|---|---|
| `hurt` | the `hit` event's `target` (`08`) | `EventReactor` → `Actor.onHurt` |
| `death` | the actor's id dropping out of the engine's alive list | `Scene.reconcile` → `Actor.onDeath` |
| `spawn` | a new id appearing, i.e. the view being created | `Scene.spawn` → `Actor.onSpawn` |

Note the split: **two of the three are diffs of `GameState`, not events.** `Scene` is the only
thing that computes those diffs, so it drives them, and `EventReactor`'s host interface deliberately
does not carry them. Nothing new reaches the client for any of the three, and no engine change was
needed — this is a pure client pass, `ENGINE_VERSION` untouched.

**Which LAYER each clip lands on is decided by the DATA, not by taste**, and this is the part worth
remembering. The attack section's additive contract says an overlay contributes its own first pose
on the frame it triggers and its own last pose on the frame it expires. Read that in the negative
and it becomes a test the shipped keyframes either pass or fail:

- **`hurt` starts and ends at identity** on all seven bundles → it can be an additive overlay, on
  exactly the same path as `attack`. It also *should* be one: being hit must not interrupt walking
  or firing, and a flinch belongs on top of whatever the body was doing.
- **`spawn` opens at scale 0.2 / alpha 0**, and **`death` ends at scale 0.4×0.3, translateY 18,
  alpha 0** → neither can be an overlay. Layer them and a spawning body pops to 20% on the trigger
  frame, and a corpse pops back to full size the instant its collapse finishes.

So the base layer stopped being an idle/move pick and became a small state machine —
**spawn → idle/move → death** — inside `render/rigClipLayer.ts`. A lifecycle clip *outranks* the
caller's ground clip for its duration; `spawn` then releases it back, and `death` **holds its last
frame**, because there is nothing for a corpse to return to. `Actor` still asks for `'idle'`/`'move'`
every frame and never has to know which of the four one-shots is in flight. The one-shot overlay slot
became a SET rather than a second named field, which is free: both channel operations (add, multiply)
are commutative, so two live overlays compose to the same pose in either order and no priority rule
is needed.

**Death is absorbing** — it refuses every later trigger and clears whatever overlays were live: a
corpse does not flinch. The rule is stated at the layer that owns it, and it is **currently
unreachable from the one live caller**, which the gap audit that followed this pass established
rather than assumed. `GameLoop` reconciles the scene BEFORE it consumes the tick's events (both
loop paths), so on the tick an actor dies its view has already left `Scene.views`, and `actorAt` —
the only way an event reaction finds an actor — searches nothing else. A killing blow's `hit`
therefore reaches no view at all, and neither does a splash hit on an actor already mid-dissolve.
That is a reason to stop calling the guard load-bearing, not a reason to delete it: it is tested as
a property of `ClipLayers`, and each of the three facts that make it moot is asserted in its own
suite (the order, `actorAt` refusing a dying view, and the dying list still receiving its frame dt
so the collapse plays). Widen `actorAt` or reorder the tick and it becomes the live guard.

**Who owns what, on death.** Two mechanisms run at once and the boundary is load-bearing:

- the authored `death` clip owns **the body's own collapse** — squash, sink, fade, per body plan;
- `ActorFilters` owns **the dissolve shader and the clock that ends the view** (`isDissolved`, which
  `Scene` destroys on). Art gets no vote on view lifetime.

Because the clip (900 ms) is deliberately longer than `DISSOLVE_MS` (700), the corpse is always
destroyed while still visibly collapsing, so the two read as one continuous motion instead of a
collapse followed by a static body being eroded. Both numbers are asserted as a relationship rather
than restated. `Actor.onDeath` keeps hiding the weapon/aura/health bar, because those are its own
children; the rig-**mounted** weapon module is not one of them and fades on its own (below).

**The drawn marks had to learn to follow the body**, and which ones already did was only settled
by asking what `spawn`'s alpha and `death`'s scale actually reach. The tether and the module
contact shade already read their bone's clip alpha; two did not:

- the **mounted weapon module** is a sprite parented to the rig, not a bone, so nothing faded it.
  `ModuleMount` now carries its mount bone's own clip alpha. Without it a spawning character mounts
  a fully-opaque gun on an arm that has not arrived, and a corpse leaves one hanging crisp over the
  dissolve. The tether out to the module and its contact shade on the core already read that same
  bone's alpha, so the module was the only one of the three still unwired.
- the **sphere shading** took only the body bone's position and alpha, never its scale — fine for a
  60 ms squash accent, not fine for a body collapsed to a third and *held* there for the whole
  dissolve, which read as a dark plate lying beside a shrinking corpse. `rigShading.placeSphereShade`
  now takes position, alpha and scale off that one bone, times the screen-space counter-flip (the
  key light must not mirror with the body — that is the one property that deliberately does *not*
  come from the bone).

**One real authoring bug fell out of the layer decision**, and it is the kind this pipeline should
expect. The three `char_*` bundles' `death` clip named `belly`/`socket_l`/`socket_r` **only in its
final keyframe**, at alpha 0. `sampleClip` resolves a bone with no keyframe at-or-before `t`
straight to its earliest FUTURE keyframe with no interpolation — so on frame ONE of the collapse a
hero's belly and both weapon modules vanished outright, while the shell collapsed over the next
900 ms. Invisible in any still, invisible to source-level tests, and the clip's own last keyframe
looked entirely correct. Fixed by giving those bones the eye's own alpha ramp. The general rule is
now asserted for every clip in every bundle: **every bone a clip animates must have a keyframe at
`t = 0`**, or it cuts instead of ramping.

**Two seams the shipped data still has, both accepted.** The frame `death` takes over, the ground
clip's pose is dropped, so a body caught at the top of its idle bob steps up to 6 authoring px
(~2 world px); same for the frame `spawn` releases. That is the same order as the step every
existing idle↔move swap already takes (one monotonic clock, two different clips), so it is not new
and not worth a cross-fade — and the death case is covered by a shake, a debris burst and a
dissolve all starting on the same frame.

## Atlas / spritesheet format

- **Packed texture atlases** (Pixi spritesheet JSON + a single page image per skin, multi-page if it overflows max texture size). One atlas per skin keeps swaps to a single texture bind.
- **Power-of-two pages, trimmed frames, documented max size.** Low-end WeChat/Android GPUs cap texture size (verify on device, `04`); pick a page cap (e.g. 2048) and pack within it. Trim transparent margins but **keep the ground/socket anchors in original (untrimmed) frame space** so `02`'s mounting math stays stable.
- **Premultiplied alpha**, consistent across pages, matching the renderer's blend setup (the fx layer already uses additive, `01`).
- **Props & environment** (pillars, crates, walls, floor decals) are atlas frames too, authored tilted (front face + top cap, like the slice's procedural pillar in `Game.ts:buildPillars`) with a ground anchor and height extent for Y-sort/shadow (`01`).

## Asset loading (web + WeChat)

- **Pixi `Assets` is the single loader**, fed a manifest of atlas bundles keyed by skin/room-set. Load a **core bundle** at boot (player, common enemies, UI, current room set); lazy-load per-biome/enemy bundles between rooms (`05`) so the initial download stays small.
- **WeChat path (`04`) — shipped 2026-08-25, and not the way this bullet predicted.** It used to say real art "requires extending the adapter's `fetch` → `wx.request` / `wx.downloadFile`". It did not: Pixi falls back to `DOMAdapter.createImage()` whenever `globalThis.createImageBitmap` is missing, which is exactly the WeChat case, so the PNG path needed no network primitive at all — only a package-relative path. What genuinely could not work was the JSON sidecars (`taoBundle` called the *global* `fetch`), now read with `FileSystemManager.readFileSync`. Both sit behind `render/assetHost.ts`; the five loaders kept their public shape. `04`'s "Asset loading" table is the reference. The lowest-base-library question this bullet raises is still open and is still the right question — it is now narrowed to two facts (`wx.createImage()` filling `width`/`height` before `onload`, and `readFileSync(..., 'utf8')` returning a string), because everything above them is covered by `wechatAssetLoad.test.ts` — and both were then confirmed in the real simulator on 2026-08-25, along with `wx.loadSubpackage` and WebGL2. Note the scope of that: the ART pipeline reaches this target now, but the game does not yet START on it (boot never reaches `Game.start()`, `04`'s checklist item 10), so nothing here has been seen RENDERED on a WeChat surface.
- **Bundle with code vs. fetch at runtime** interacts with `09`/`06`: bundled assets version with the client and the `ENGINE_VERSION`/replay guarantee; runtime-fetched content can update without a release but must not carry anything the engine reads (it doesn't — art is presentation, so fetched art is safe for determinism; only fetched *config/rooms* touches `09`'s versioning concern).
- **No runtime canvas texture generation on WeChat** beyond the adapter's `createCanvas` (`04`); procedural looks are done with Pixi `Graphics` (portable, as the slice's glow already is) or shaders — subject to `04`'s no-`eval` shader-upload constraint.

## Tilted-view art requirements (from `01`)

Authoring rules so 2D art produces the fake-3D feel and doesn't hit `01`'s known break cases:

- **Front face + implied top**, fixed camera angle — every sprite drawn as if seen slightly forward-leaning (`01`).
- **Ground anchor at the feet** → `gy`; **height extent upward** → the sprite occupies `gy-height .. gy`, so Y-sort and the separate shadow layer work (`01`).
- **Shadows are a separate layer element** (`01`), not baked into the sprite — drawn at ground coords, shrinking/fading with `z`. Author sprites without a baked shadow.
- **Avoid `01`'s break cases:** don't author one giant sprite that must be simultaneously in front of and behind a tall prop; split tall objects into Y-sortable segments; keep occlusion silhouettes clean.
- **Fidelity roadmap alignment (`01`):** art must be authorable for later normal-map lighting (milestone 2) — keep a consistent light direction in hand-painted shading, or author flat + normal maps, so the lightmap pass composites cleanly.

## Naming & authoring conventions

- **Stable ids, not filenames, in data.** Rig states, frame refs, atlas keys, and event tags are the contract with `02`/`08`; renaming a source file must not break a skin. Map files→ids in the manifest.
- **Kebab-case, namespaced keys:** `enemy.critter.run`, `player.socket-anchor`, `fx.muzzle.small`. Event tags are a small closed vocabulary shared with fx/audio (`11`, when it lands): `footstep`, `muzzle`, `hit-active`, `impact`, `death`.
- **One rig per body archetype**, many skins per rig — enforced so a new character is a new atlas + manifest row + a `SkinDef` stat row (`09`/`14`), no new animation code (`02`).

## Relationship to the other docs

- **`02`:** character/animation decoupling, socket mounting, "characters are a balanced roster, not cosmetic skins" — this doc is that model's concrete data format.
- **`01`:** depth/Y-sort/shadow/height and the fake-3D limits art must respect; the fidelity roadmap art must stay compatible with.
- **`04`:** WeChat asset loading (the two mechanisms), the package budget and its gate, and the WebGL1 silent-degradation rules that make shipped art dimensions a rendering concern, not just a size one.
- **`08`:** the `events` queue that triggers animation events / fx; the render-vs-sim clock split.
- **`06`/`09`/`14`:** determinism (art never feeds logic); the PvP fairness wall keeps *crafted weapons* out of the arena structurally, while *characters* (skin stats + passive) do enter PvP as balanced side-grades — art is still never a power source, the stats live in `SkinDef` data.
- **`10`:** UI art (HUD icons, buttons) shares this pipeline but is authored for the `ui` layer and screen space, not world tilt.
- **`13`:** the worldview + art *direction* (style, the element colour law, biome looks, tone) this pipeline renders; `13` sets *what* the world looks like, this doc sets *how* the assets are built and animated.
- **`11` (audio, reserved):** animation event frames are the shared trigger vocabulary for sound.

## To design

- ~~**Bundle boundaries**~~ — **designed and shipped 2026-08-25.** `client/src/render/assetPacks.json` is the single pack table, read by the runtime (`assetManifest.ts`), the build (`build/wechatAssetSync.mjs`) and the byte gate (`build/checkWeChatPackage.mjs`). The boot core bundle is `main` (3.31 MB / 4.00 MB); four subpackages hold what a fresh run cannot reach — the ice/lightning/poison swatches (no authored dungeon maps to those elements) and `skins/boss-core` (floor 5 only). `brute-core`/`floater-core` deliberately stay in main: both spawn on floor 1. All four load once at boot rather than per-room, which satisfies WeChat's first-download rule without paying for an `await` on the way into a room; making one genuinely lazy is `ensurePack(name)` at the point of use plus dropping it from the boot set, with no loader change. See `04`'s "Package budget".

  The sizing answer was the opposite of what this list assumed. It queued "bundle boundaries" and "atlas packing" together, as if the 13.66 MB of `client/public` were a packing problem. It was not: `orb-core`'s bone textures were still 1254² while the two sibling characters on the *same rig* had shipped at 256² for months, and six byte-identical 650 KB `socket_*.png` copies were 3.9 MB on their own. Downsampling alone took it to 3.20 MB. **Atlas packing would have saved almost none of those bytes** — merging RGBA PNGs removes no pixels — so it stays queued for its real benefit (draw calls) rather than for size, and it is not urgent while render p50 is 2.1 ms of 16.7.

  **Half of this is superseded as of 2026-09-01** — see "the first download is code only" at the bottom of this doc. The table, the three consumers and the reachability arguments all still stand; what changed is WHEN a pack is fetched. `main` is now code alone, `lobby` is awaited at boot behind a progress screen, and everything a run draws is downloaded in the background and awaited at the run boundary. The paragraph above describing the boot core bundle as `main` at 3.31 MB is history.

  Two rules the pass established for re-encoding shipped art:
  - **Never trim a rig bone's canvas.** `animation.json` binds it as `scale = authoringPx / sourceWidth` with the pivot at the canvas centre, so cropping the transparent margin resizes AND re-pivots the bone. `processPNG`'s `trim: false` (and `compress.mjs --no-trim`) exist for this; untrimmed output also happens to be *smaller*, since fully transparent rows cost almost nothing once deflated.
  - **Prefer exact 2:1 steps.** 320 → 160 and 256 → 128 make every output texel the mean of exactly four inputs, with no resampling phase error. Measured through the live renderer at real on-screen size, the exactly-halved families (UI icons, weapons) came back essentially pixel-identical to the originals (p50 ≤ 0.2/255, p95 ≤ 3.3/255); the rig art's non-integer 1254 → 256 step reads p50 0.7–4.5 and p95 15–21, concentrated on silhouette edges.
- ~~Placeholder→final swap process~~ — moot as of 2026-08-03: this pipeline's GPT-Image-2 output is now the final art, so there is no later swap to design for. The `Skin` interface (Graphics slice vs. `.tao`-driven atlas) stays exactly as documented above regardless — that decoupling was never specific to a placeholder/final distinction.
- **Normal-map / lighting authoring** for `01`'s milestone-2 lightmap — flat+normal vs. pre-shaded.
> Resolved by the Animation decision above: **animation-data source** (funny's editor + `.tao`) and **atlas tooling** (the editor packs the spritesheet via shelf bin-packing; anchors are authored in-tool as Bindings/attachment points) — no longer open.

> **`animator` port done (2026-07-26):** `tools/animator` (own package, Vite + vitest, mirrors `tools/map-editor`'s scaffolding) now holds the editor. Lifted verbatim: `interpolate.ts`'s `sampleClip`/`interpolateBone`, the `.tao`/`.editortao` JSZip I/O, the timeline/renderer/interaction plumbing (all rig-agnostic already). Rewritten: funny's static 11-bone-humanoid `Skeleton` class → an instantiable `Rig` (`skeleton/Rig.ts`) built from a `RigDef`, so the tool can hold more than one skeleton (a crystal-critter or boss-core rig is new data, not new code). The orb-core's own rig ships as the first `RigDef` (`skeleton/rigs/orbCore.ts`): 6 bones — `root → shell → eye + belly + 2 orbiting weapon-socket bones` — no arms/legs/walk-cycle anywhere. Preset clips replaced funny's six humanoid ones with `idle` (hover-bob), `move` (lean-into-travel, renamed from `walk`), `attack`, `hurt`, `death`, `spawn` — all squash-stretch/translate-driven since rotation doesn't cascade translate/scale/alpha to child bones in this FK model. Supabase/Workers/GitHub workspace-sync bridge dropped entirely (local-disk `.tao`/`.editortao` + IndexedDB auto-save only, per the locked decision above). **Deliberately out of this pass** (game-render-side work, needs the `.tao` schema to exist first): wiring the ported FK/`sampleClip` math into `@dd/engine`'s render pipeline / `Skin.ts`, aim-driven weapon-socket rotation at runtime, and the front/back eye texture swap-by-hemisphere (the `eye` bone/image-slot exists; the swap itself is content+render logic, not editor work).

> **Real orb-core art bound + editor gains multi-variant image support + a second rig verified (2026-07-27):** AI-generated placeholder art (`art/units/`: shell, belly, eye front/back, weapon-socket, a base enemy critter, a boss core — GPT Image 2) is now bound into a real seed project (`tools/animator/projects/orb-core.editortao`), not just loose PNGs — built programmatically (Node + the project's own `jszip` dependency, no manual drag-and-drop) and verified live against the running dev server (all 5 bone slots bound with correct z-order, all 6 preset clips intact, no console errors). Closes the "eye front/back texture swap" editor-side gap called out above: `ImageController` now supports **named image variants per bone slot** (`setVariantBlob`/`setActiveVariant`/`getVariantIds`), not just one texture — a slot's binding (anchor/scale/rotation) stays shared across variants (same footprint, so it drops into the identical socket, per this doc's own facing-model rule), only the texture differs; `.editortao` persists every variant (`images/<slot>__<variantId>.png` + an `activeVariantIds` label map) and `.tao` export bakes every variant into the spritesheet (`<slot>` = active frame, `<slot>__<variantId>` = alternates) for a future renderer to pick from by aim hemisphere — the render-side picking logic itself was still the deliberately-deferred item below at the time this paragraph was written; it shipped in the 2026-07-27 update two paragraphs down (`RigSkin.ts`'s `showBack`/`facingFromAim`), so only history, not a current gap. Along the way, found and fixed a real latent bug (pre-dating this session): `loadEditorBlob` never cleared `ImageController` before restoring a new project, so images/variants could leak from whichever project was open before — surfaced by a live two-project-load test, not spotted by inspection. Also: `.tao.editor` renamed to **`.editortao`** throughout (single dot-segment — the old compound extension wasn't reliably recognized by OS file associations / some save dialogs). Separately, verified this doc's "a crystal-critter or boss-core rig is new data, not new code" claim for real: added `skeleton/rigs/bossCore.ts` (`root → core → 2 orbiting shard-ring bones`, structurally distinct from the orb-core — no eye/belly/sockets) and an opt-in `?rig=boss-core` dev toggle in `App.ts` (same convention as this project's other query-param dev harnesses); loaded a boss seed project (`projects/boss-core.editortao`, `boss.png` bound to `core`) against the live app with zero changes to `Rig`/`ImageController`/`IOController`/`ImagePanel` — confirmed the tool genuinely generalizes to a second body archetype. This is a verification harness, not a production multi-rig project switcher — IndexedDB project auto-save/switching wasn't rig-aware yet at the time (**fixed 2026-07-27, later still**: `ProjectMeta` gained an optional `rigId`, stamped on every create/rename/autosave and checked before ever opening a project, so a project saved under one `?rig=` can no longer silently load under another and blank the character). `enemy_critter.png`/further boss atlas art remain real-art-production work, same as the orb-core parts before this pass.
>
> Design-decision note: the concrete per-element/per-biome hex palette this doc's "To design" list still calls out was NOT locked as part of this pass — the placeholder art above used first-pass suggested hex values consistent with `13`'s colour LAW (fire/ice/lightning/poison/physical), not officially chosen final values.
>
> **Update (2026-07-27):** the per-element hex half of that note is resolved — `13`'s "Element palette (locked)" table writes down the values `client/src/game/theme.ts` already ships (per-biome background palettes are still open). Same pass: two more character orb-cores bound (`skirmisher`/`juggernaut` — `projects/skirmisher-core.editortao` / `juggernaut-core.editortao`, same rig/bindings/clips as `orb-core.editortao`, only shell/belly/eye art differs, scale-corrected for their 1024px source vs the base's 1254px); the game's `RigSkin` renderer wired to pick a character's bundle by `SkinDef.atlasKey` (`skinRegistry.ts`'s `RIG_DEFS` keyed `char_vanguard`/`char_skirmisher`/`char_juggernaut`, all sharing one `Rig` instance since it's the same skeleton) instead of a single hardcoded `'orb-core'`; the two previously-deferred render gaps this doc calls out above — **aim-driven weapon-socket rotation** and **weapon mounting** — are done (`RigSkin.ts`: `socket_l`/`socket_r`'s rendered rotation now tracks the live aim angle every frame instead of only the authored clip, and a neutral `gun_default`/`sword_default` sprite mounts on the active socket by equipped weapon kind — one sprite per KIND, not per weapon frame, since `content/weapons.ts` doesn't yet give ranged/melee frames distinct `skinRef`s); and a minimal one-bone `critter-core` rig (`skeleton/rigs/critterCore.ts`, `projects/critter-core.editortao`) binds the existing neutral `enemy_critter.png` so it can be previewed/animated in the editor.
>
> **Update (2026-07-28): per-weapon-id art superseded the "one sprite per KIND" placeholder above.** `client/src/render/weaponSkins.ts` now keys business-end art by `WeaponSimSpec.name` (falling back to the `ranged`/`melee` kind default for the two ids without dedicated art) — 9 of 11 weapon ids (`scattergun`/`seeker`/`mortar`/`lasercutter`/`tomahawk`/`novaburst`/`gyre`/`hammer`/`spear`) ship their own AI-placeholder sprite (alpha-trimmed, box-downsampled, hand-rolled-PNG-codec-encoded — no image lib on the Node side). Because most of this art was composed "socket on the right" rather than `gun_default`/`sword_default`'s own "socket upper-left" convention, each texture carries a measured (not eyeballed) `rotationOffsetRad` that cancels its own baked pointing direction so `RigSkin`'s aim-tracking rotation still points the mounted sprite at the reticle. `blaster`/`repeater`/`cannon`/`enemygun`/`saber`/`emberblade`/`frostbrand`/`stormglaive`/`carom`/`leech` still share the generic housing (no mechanically distinct silhouette to justify unique art). True texture-atlas packing was deliberately not built — loose per-weapon PNGs match the existing skinRegistry convention, and 9 icon-sized sprites don't justify a hand-rolled packer.
>
> **Update (2026-09-06): the two mob melee weapons got their own art, and the useful part is what the calibration had to do differently.** `enemyclaw` and `enemymaul` (`ENGINE_VERSION` 59) borrow the player spear's and hammer's PNGs. That is a deliberate placeholder rather than a fallback — pointing them at `sword_default.png` would trip `muzzleParity`'s "never the kind default" rule, and a path with no PNG behind it would ship a missing texture — but it means a raider's claw currently reads on screen as **player gear**, i.e. as loot you could pick up, which is the opposite of what a mob's weapon should signal. What actually carries that signal at a ~40 px on-screen body is not the silhouette but the PALETTE, and the mob roster already has one, established by `gun_enemygun.png` and sampled off its pixels: dark blue-grey housing (`#202030`–`#404050`) with a **violet** crystal (`#402080`, `#502090`, `#7030B0`) and pale-lilac highlights, against the player's white-and-gold. Two GPT Image 2 prompts stating that palette explicitly (kept in `art/weapon/prompts.md`) landed both on the first attempt. Three calibration findings came out of wiring them, and only the first was expected: **(1)** `rotationOffsetRad` had to be re-measured, since the borrowed near-180° values were cancelling the SPEAR's and HAMMER's baked pointing direction, a property of those files and not of these weapons — the new ones are -47.1°/-53.8°. **(2)** `scale` could not be carried over either, and for a reason the shipped gate cannot see: this art is composed on a DIAGONAL where the archived batch produced flat strips, so the object's own long axis runs ~200 px inside a ~160 px-wide texture. `rigComposition.test.ts`'s module-proportion band measures texture WIDTH, so equal divisors would have passed it while rendering these ~40% longer than the placeholders they replace; the divisors are chosen against the ALONG-AXIS length instead (55.7 vs 55.6 authoring px, and 65.6 vs 65.5). **(3)** Measuring the ANCHOR too — the centroid of the alpha mass in the first 12% of the long axis, i.e. the middle of the connector nub — rather than eyeballing it as every previous batch did, is worth the ten lines: driven live, both new entries put the weapon's tip **0.0°** off the direction of the target, against **18.2°** for the shipped `enemygun` measured the same way in the same frame. That 18.2° is the standing cost of the eyeballed-anchor convention, now quantified rather than assumed.

> **Update (2026-07-27, later still): critter-core wired into the real game render, closing the gap above.** `client/src/render/critterCoreRig.ts` ports the rig into the client bundle (mirrors `orbCoreRig.ts`'s pattern, its own `CRITTER_CORE_REFERENCE_RADIUS`); `Skin.ts`/`skinRegistry.ts` were generalized to carry a per-rig reference radius instead of one hardcoded orb-core constant, and `RigSkin` gained `setTint()` — a Pixi multiply-tint over every bone sprite, the actual mechanism for "one neutral-grey critter body, re-tinted per elemental variant at runtime" (`13`) rather than one art file per variant. `Actor.ts` passes an enemy's already-resolved blueprint tint straight through. Enemies kept their old Graphics gun-barrel/blade weapon indicator at the time (critter-core has no socket bones to mount a weapon sprite on) — **superseded 2026-08-21**: a socket bone was measured and rejected, and enemies now mount the real sprite on a second, socket-less mount path. See the 2026-08-21 update at the end of this section. `enemy_critter.png` turned out to have the same opaque-magenta-background/no-alpha-channel bug as orb-core's original art (real-art-production work, not a code gap) — critters render at the correct size and tint, just with a visible matte patch until that's regenerated with transparency.

> **Update (2026-08-17): the assembled character was wrong on screen for three weeks — a
> two-line placement bug in the runtime, not an art problem.** User report: "角色的形象实际
> 看起来和最初的设计不符" (the character doesn't look like the original design), pointing at a
> plain white ball with a gun stuck to the top of its head, with no eye, no crystal belly and
> none of `13`'s two orbiting weapon modules on tethers. Every piece of art was correct and
> loaded; `RigSkin.update()` placed it wrong in two compounding ways. **(1) Sprites were drawn
> at each bone's PIVOT instead of its TIP.** Every rig here hangs its body off a pivot at the
> actor's feet via one upward body bone whose `len` IS the hover height (`shell` 46, critter
> `body` 40, boss `core` 60) and whose `bodyR` body circle sits at the tip — which is also
> where the editor's own skeleton view draws it. Drawing at the pivot put the shell a full
> body-length below its own children, so `eye`/`belly`/`socket_l`/`socket_r` (all parented to
> `shell`, all measured from its tip) landed on ONE point above the shell's head: four sprites
> plus the mounted weapon stacked on each other, the shell's painted eye socket left empty,
> and the two 52-px socket orbits collapsed to zero separation. **(2) Rotation used the bone's
> raw world angle**, so every body bone's rest angle leaked into its art — the body bones point
> up (`rwa -90`), so the hero's crystal spikes pointed left and every critter/boss body was 90°
> off too. Fixed: art centres on `pose.ex/ey` and rotates by `pose.wa - rwa` (the delta from
> rest), so art authored the way it reads on screen stays upright and only animation/aim turns
> it. Two smaller things came out of the same pass: a bone's animated `rotation` was applied
> TWICE (once folded in by `Rig.computeFK`, once again in `update()`), and `Actor`'s own
> `BODY_LIFT_R` lift is now placeholder-only — a rig already carries its hover height in that
> body bone, so lifting again double-counted; the status aura and floating health bar moved
> onto the body's measured centre accordingly. The **energy tether** is now drawn (it never
> was): any bone declaring the `outerW`/`innerW` widths the editor already uses for a tubular
> bone gets a two-pass glowing arc from its pivot to its tip, which covers orb-core's two
> sockets and boss-core's two shard rings without either being special-cased. `tools/animator`
> got the identical placement change (`rendering/Renderer.ts` + a `bones` field on
> `RenderData`) — the editor previewing a different layout than the game ships is exactly how
> this got authored and shipped in the first place. The mounted module was ~2x the concept's
> module-to-core ratio (`art/concept/02_weapon_mount_ranged.png`) and covered the eye — now
> `weaponSkins.ts`'s single `MODULE_SCALE = 0.75` factor (the user's explicit middle between
> matching the concept and keeping every weapon frame's silhouette readable), applied in
> `getWeaponScale` so the per-texture measured sizes stay untouched — and the idle arm carries
> a decorative second module pointing outward along its own tether, so the silhouette finally
> matches the concept's two-armed read.
>
> **The testing law this establishes** (asked for directly: "之前好像也是这么反馈的，结果没修好。
> 你能加上测试保证正确吗" — and fair, because the 2026-08-12 shield-centring pass had this bug's
> own symptom in a comment and read it as the rig's design). A placement/assembly claim is only
> pinned when it is checked against the **real shipped bundle**, as a **relationship** rather
> than a restated coordinate, for **every** rig — `rigComposition.test.ts` (85 cases) loads
> `client/public/skins/*/animation.json` + `frames.json` + each PNG's real IHDR width, resolves
> skin → rig exactly as the game does (`skinRegistry.RIG_DEFS` × the preload pairs parsed from
> `main.ts`, so a new character cannot skip it), runs the real `RigSkin`, and asserts: body on
> its own hover height; every sprite upright at rest; **rendered footprint == 2 × that bone's
> `bodyR`** (every shipped binding satisfies this exactly — treat it as the authoring law when
> re-exporting art, and it's the guard against the ~15.7x scale class of bug); decorative parts
> contained by the body vs orbiting modules clear of it; no two parts co-located; one shared
> orbit radius; a tether per orbiting bone; and all of it re-checked across every shipped clip
> at 12 samples (this FK model doesn't cascade translate to children, so a body-only hover bob
> would tear the character apart). Every check is mutation-verified: reverting tip placement
> fails 22, reverting rest-relative rotation fails 10, reverting `MODULE_SCALE` fails 14 — while
> the pre-existing 1272-test suite passed straight through the original bug. That band also
> immediately caught a **second real bug**: `KIND_DEFAULTS`' `104/1536` scale divisor was stale
> after its art was downsampled to 320px, so the never-invisible fallback silhouette rendered at
> ~0.2x the core (a nub); fixed to `90/320`.

## A bone's `bodyR` is a declared radius, not what the art paints (2026-08-19)

`rigComposition.test.ts`'s **rendered footprint == 2 x bodyR** law above is about the *sprite box*,
and every shipped binding satisfies it exactly. What it deliberately does not say is how much of
that box is opaque — and decoding the shipped PNGs' alpha bounding boxes shows the answer varies a
lot per bundle:

| skin | opaque half-width / `bodyR` |
|------|-----------------------------|
| `char_juggernaut` | 0.87 |
| `char_vanguard` | 0.81 |
| `char_skirmisher` | 0.69 |
| `critter-core` | 0.70 |
| `brute-core` | 1.00 |
| `floater-core` | 1.00 |
| `boss-core` | 0.68 |

So `bodyR` (and the gameplay radius, which equals it for every rig here since every
`referenceRadius` IS the body bone's `bodyR`) can be up to ~45% wider than the creature inside it.
**Anything sized against the character's silhouette has to use the opaque extent instead**, and two
things were silently getting this wrong until it was measured: the sphere shading painted a
hard-edged dark disc onto the background around `critter-core`, and every ground shadow was scaled
to the box rather than to the art (see `design/01`'s "Volume, measured"). Neither is visible in the
source of either file.

The measurement is recorded as `skinRegistry.BODY_FILL`, one entry per preloaded skin, and
`rigComposition.test.ts` **re-decodes the real PNGs on every run** (via the repo's own
`tools/png-pipeline/pngCodec.mjs`) and fails if a recorded number drifts from the pixels —
mutation-verified by falsifying one entry (`critter-core` 0.70 → 1.00) and watching it go red. The
plumbing is pinned separately (`skinRegistry.test.ts`: the three orb-core characters share a Rig but
must NOT share a fill, since their shells paint 0.81, 0.69 and 0.87 of the same declared radius), so
a silent fallback to 1.0 fails too. That is
the same shape of guard as the assembly invariants above, applied to the same class of failure:
**when art changes, every hand-tuned number that was sized against the OLD art is now wrong and
nothing in either file shows it.** Re-cropping or replacing a body texture must move the table.

## Update (2026-08-20): the drops and the gate leave the Graphics slice

The Status block at the top of this doc used to name three things as "never planned as sprite art":
bullets, pickups and the portal. That was written while `RoomBuilder` still drew every wall as a flat
rectangle on the ground layer — once the walls stood up, the floor was a real swatch, the doors were
fixtures and the pillars were sprites, those three were simply the loudest placeholders left in the
frame. Two of the three now ship real art. **Bullets do not, and the reason is worth writing down
rather than re-deciding later: a bullet is drawn at ~5 world px, where a texture buys nothing a
tinted additive dot does not already give, and costs a sampler per projectile in the busiest part of
the frame.**

**Five drop sprites, one per `PickupKind` except `weapon`.** A weapon drop already drew that weapon's
own business-end art, which is the whole point of the universal mount — a generic "loot" icon would
have thrown that away, so `getPickupTexture` has no `pickup_weapon` key at all and `Pickup` never asks
for one. Drops are scaled by their LONG axis to one shared 18 px extent, so each file keeps its own
aspect (the crystal ships 116x192, the bandage 192x100) while a floor of mixed loot still reads as one
size class.

**The portal is a split, not a sprite.** Only the masonry arch is art; the ground bloom, the two
counter-rotating rings, the bright core and the infalling motes stay program-drawn, because they
animate every frame and GPT Image 2 emits one flattened raster. That split is also why the arch is
authored as NEUTRAL stone with COLOURLESS crystal: a single `Sprite.tint` cannot tint the shards
without tinting the masonry, so the checkpoint's green arrives from the code-drawn layers instead.
This is the first asset in the project deliberately authored to be *incomplete* — the file is the half
of the object that never moves.

**Two pipeline facts this batch adds to the loading path described above.**

1. **`environmentSprites.ts` was loading every texture with no mip chain**, including the door pair,
   which has shipped that way since 2026-08-04. A door is a 156 px source drawn at 64 px; a drop is a
   192 px source drawn at 18 px, a 10:1 minification — worse than the 4:1 that made the pillar sprite
   need mipmaps and the same class of defect as the 2026-08-12 rig-art colour noise. Fixed for all of
   them; `autoGenerateMipmaps` has to be passed at LOAD time, since setting it on an
   already-uploaded texture provably does nothing.
2. **The generator now emits `.webp`.** `tools/png-pipeline/pngCodec.mjs` is a PNG codec and cannot
   read it, so decoding to PNG (losslessly, via Pillow) is a new first step before the repo's own
   pipeline can touch a generation at all. Everything after that is unchanged: `lumaCurve.mjs` where a
   file's tonal placement needs a fold, `compress.mjs` to trim and downsample, `alpha-audit.mjs` to
   verify.

Full account, including the three rejected generations and what each one cost, is in
`art/environment/prompts.md`; the render-side geometry is in `design/01`'s "The drops and the gate".

## Update (2026-09-01): the first download is code only

The pack table shipped on 2026-08-25 satisfied WeChat's 4 MB rule and bought **nothing else**,
because `preloadCoreArt` called `ensureAllPacks()` — all six packs, at boot, in parallel. That is
defensible as far as the rule goes (the 4 MB ceiling is about the FIRST download, so a pack fetched
one moment later is compliant) and it is what the previous section argued. What it left in place was
a **byte tax on code**: art occupied 2.49 MB of a 4.00 MB main package, so `js/game.js` had 2,729
bytes of headroom on 2026-08-31, and the next code change of any size — the music runtime, as it
happened — failed the gate. The `oversized` pack (one file, the 606 kB door curtain) was that
failure being paid off by moving a byte, and its own note said so.

This pass makes the deferral real. **The main package is now code and nothing else.**

| pack | contents | files | bytes | when |
| --- | --- | --- | --- | --- |
| `main` | `js/game.js` | 1 | 995 kB | the first download |
| `lobby` | `/ui/` | 17 | 387 kB | awaited at boot, behind a progress screen |
| `music` | `/audio/music/` | 2 | 1,115 kB | background, never awaited |
| `forge` | `/weapons/` | 27 | 443 kB | background, awaited at the run boundary |
| `run` | everything unmatched: `/skins/`, `/biome/` fire+neutral, `/environment/`, SFX | 104 | 2,335 kB | background, awaited at the run boundary |
| `biome-ice` / `biome-lightning` / `biome-poison` / `boss` | unchanged, still justified by unreachability | 14 | 654 kB | background, awaited at the run boundary |

First download: **3.42 MB → 0.95 MB** (measured after this pass's own code landed; it was
3.42 MB with 2,729 bytes free before it), and the headroom that matters is now 3.05 MB of room
for code rather than two and a half kilobytes. Total is unchanged at 5.72 MB / 30 MB — this moves bytes in TIME, it
does not remove any, and the win is "the lobby appears after 0.95 MB + 387 kB instead of after
3.42 MB", not a smaller game.

`oversized` is **deleted**, as its note asked. The curtain lands in `run` by domain (it is a floor-1
door fixture) rather than by size, so the re-encode question that note raised is now a plain
"should the player download 606 kB for one fixture" call with no gate pressing on it. Nothing
about that decision changed except its urgency — **settled the same day, in the negative: see
"the curtain re-encode, settled" below.**

### The rule that keeps this from becoming a bug farm

**The set of available textures may change only at a phase boundary.** Before this pass
`getUiTexture`/`getWeaponTexture`/`getBiomeTexture`/`getEnvTexture` were total within a session:
every pack was in before the first frame, so any call site could assume its texture either existed
forever or never. Deferral makes availability a function of TIME, which is the bug class this
codebase has the worst record with — the curtain's own first bug was correct size, correct
visibility, correct blend mode and a default (0, 0) position, with green tests and a live report.

So there are exactly **two art phases**, not per-asset laziness:

- **LOBBY** — `preloadLobbyArt()`: `Assets.init`, then the `lobby` pack, then `preloadUiArt()`.
  Awaited by both entries before `new Game(...)`, behind a Graphics-drawn progress screen
  (`game/ui/loadingScreen.ts` — no art in it, because there is no art yet). Login, main menu, mode
  select, settings, party and account screens are UI chrome only and are fully dressed here.
- **RUN** — `ensureRunArt()`: every remaining `run`-phase pack, then the four remaining loaders
  (`preloadRigSkin` per bundle, weapons, biome tiles, environment sprites) exactly once. Memoised,
  so it is one transition per session no matter how many gates ask for it.

Re-running a loader after its pack lands is safe and nearly free by construction: the four sprite
loaders are idempotent map-fillers over a static path table with a per-item `try/catch`, and Pixi's
`Assets` memoises by URL, so a second run re-resolves the already-decoded textures and fills in the
ones that were missing. That property is why this works without touching a single loader. The rig
loader is the one that is not free — `preloadRigSkin` re-reads its two JSON sidecars rather than
skipping a bundle it already has — which is precisely why it is called in the run phase and not in
the lobby one, where it would be paid for twice.

The RUN phase deliberately includes the packs that are unreachable today (`biome-ice` and friends,
654 kB). Gating on only what the next room needs would mean re-running `preloadBiomeTiles` once per
pack and reasoning about a map that is partially filled — the exact partial-availability state the
rule above exists to forbid. One transition costs a bounded 654 kB of art the player may not see;
it buys "either the run has all its art, or the player is still looking at a spinner".

### The gate, and why it is invisible almost always

Entering the **forge** is the boundary, not START RUN. The forge is where a player *chooses* using
weapon art, so weapons must be dressed before it paints — and by then the background load has had
the whole login/menu/mode-select sequence to finish. Gated sites: `showForge`, `showPvpPreview`,
`showMatchmaking`, `beginTutorialRun`, `beginArenaDemoRun`, `beginReplayRun`. Everything left
ungated (`showMenu`, `showModeSelect`, `showAccount`, `showSquad`, settings) draws from the `lobby`
pack alone.

`controllers/ArtGate.ts` owns it, and it has two properties worth stating because they are what
keep the change small:

1. **Synchronous when the art is in.** The gate asks `isRunArtReady()` first and reports "not
   deferred" if so, leaving the caller's transition exactly as synchronous as it was. Only a
   genuine wait defers, and then the spinner goes up and the same transition re-runs on the other
   side.
2. **Inert unless something actually deferred.** `isRunArtReady()` answers `true` until
   `beginDeferredArt()` has been called, and only the two entry points call it. Every unit test
   that drives `Game` therefore sees the pre-2026-09-01 behaviour with no changes, and the gate
   cannot silently swallow a transition in a test that never opted into deferral.

`beginDeferredArt()` is called BEFORE `new Game(...)` in both entries, and that ordering is
load-bearing rather than tidy: the call is what ARMS the gate, and `Game.start()` can enter a run
on its own first pass (the `?replay=` path does). Placed after `start()`, as it was first written,
that run begins with placeholder art and no gate at all. `render/wechatPhasedBoot.test.ts` pins the
order in both entry files by reading their source, because there is no way to observe it from
inside a module.

The spinner lives on a new `Layers.overlay` — a third screen-space sub-layer of `ui`, above `menu`,
unscaled. Pinned in `layers.test.ts` for the same reason the `hudOverlay`/`menu` split was: paint
order that comes from add-order is a landmine here, and a progress screen that renders *under* the
forge's full-viewport hub Panel would be invisible in exactly the way the forge's own SETTINGS
button was for months.

### Music is loaded but never awaited

`audio/MusicPlayer.ts` hands a deck a path; on WeChat a path inside an unfetched subpackage names no
file, and the deck reports an error and plays nothing. Nothing retries — `musicDirector`'s per-frame
derivation is a no-op once `current` already names the track it asked for. So a background `music`
pack would have meant permanent silence in the menu.

`music` still is not in the blocking path (it is 1,115 kB, and the assetPacks note's argument that
music is the one asset class a game can start without has not changed). Instead it is the FIRST
background pack kicked, and when it resolves the loader calls `MusicPlayer.invalidate()`, which
clears `current` so the next frame's derivation starts the bed it already wanted. That is one hook
at one place, which is the smallest thing that can work here — and `musicDirector`'s "nothing to
hook, so no moment can be missed" property survives it, because the hook decides nothing; it only
forgets a failed answer.

### `mainPack` and `defaultPack` had to stop being the same field

`assetPacks.json` used one field for two ideas: "the package whose root is `''`, which WeChat
downloads first" and "where a path no rule matches ends up". They were both `main` and the
distinction never came up. Now `mainPack: "main"` and `defaultPack: "run"`, because the flip is the
whole safety property: **a new asset added with no rule can no longer silently enlarge the first
download** — it lands in the background pack, and a rule is required to opt INTO `main`. `SUBPACKS`
(the list `wx.loadSubpackage` is called for, and the list that becomes `game.json`'s `subpackages`)
now filters on `mainPack`, which is what it always meant.

Each pack also declares a `phase` (`main` | `lobby` | `background` | `run`) so the boot code cannot
drift from the table: `packsForPhase('run')` is what `ensureRunArt` awaits, and adding a pack means
adding a row, not editing TypeScript.

### The build had to learn to clean up after a pack move

`build/wechatAssetSync.mjs` prunes `platforms/wechat` to match the plan, and it derived the
directories to sweep FROM the plan — every `dest`'s first path segment, plus every pack root. That
works for a renamed texture and fails for exactly this change: once no `dest` begins with `ui/` or
`skins/`, the sweep never visits those directories, and the previous build's full copy of the old
main package stays on disk — inside the FIRST download, the one place bytes are actually capped.
The byte gate cannot see it either, because it weighs `client/public` through the rules and never
looks at the built tree.

The sweep is now derived by EXCLUSION: everything in the target is plan-owned except the bundle
(`game.js`, `js/`) and the appid config (`project.config.json`, `project.private.config.json`).
A top-level directory left empty by the sweep is removed too, so `ui/` does not sit hollow beside
`packs/lobby/ui/` inviting the question of which one is live. `build/wechatAssetSync.test.mjs` is
new and covers this against a temp repo — including the fresh-checkout case, where the directory
being swept does not exist yet and a bare `readdirSync` is an ENOENT out of the first build anyone
runs.

### What this does NOT claim, and the device questions it adds

Three of these were measured in the real simulator on 2026-09-01, about half an hour after the
phases shipped — DevTools 2.01.2510280, **base library 3.17.1**, appid `wx25a3b18a3e83ffce`, 844x390
landscape. Four runs: two with `beginDeferredArt()` and two matched controls with the call
skipped. The method and the full numbers are in `04`'s **The phased boot on the real base
library**; what each bullet claimed before, and what is left, is below.

- **The phased boot works on the real base library** (was: untested). Every breadcrumb stage
  fired with no `fatal`, and the two things a device-less test cannot see both hold: after
  `preloadLobbyArt()` **17/17** `UI_ASSET_KEYS` resolve through `getUiTexture` at real
  dimensions, and after the run phase **7/7** `CHAR_BUNDLES` reach `getRigSkin` with all five
  biome floors, both sampled weapon textures and both sampled environment sprites defined. The
  specific fear — `wx.loadSubpackage` resolving while a `/ui/` path still names nothing for a
  frame — did not reproduce. Nor did the other half of it: the `run` packs settled ~850 ms
  **after** `game.start()`, so their loaders ran against a live render loop, and everything
  still resolved. `isRunArtReady()` was false for the first 1.4–1.7 s of the menu and then
  flipped, which is also the first direct evidence that the gate arms on this platform.
- **Concurrent `wx.loadSubpackage` works, and stays undocumented.** All seven `background` +
  `run` packs were in flight at once (the instrumented `inFlightAtStart` climbed 1→7, the calls
  issued within 6 ms of each other) and all seven reported `success`, 885–951 ms later, with
  every texture resolving afterwards. So `ensurePacks` is **not** being serialised. The 分包 docs
  still do not promise this — it is now a measurement rather than an assumption, which is a
  different thing from a guarantee, and a handset is still unmeasured.
- **The background download does not hitch the lobby** — measured, not eyeballed, and the
  control is what makes it an answer. Over an 8 s window from the first menu frame the two
  deferring runs delivered *more* frames than the two controls (324/313 vs 298/304) at a lower
  mean (24.4/24.8 ms vs 26.9/26.5) and a much lower median (19.9/19.8 vs 30.2/29.8), with p95
  identical (~31.8 ms). Their only excess is two extra frames over 33 ms per window, all inside
  the first 1.7 s, where both controls carry long frames too. So there is nothing to serialise
  and nothing to de-prioritise. Two caveats keep this simulator-only: the median inversion is
  unexplained and says the simulator's frame pacing is not stable enough to read absolute
  numbers off, and **there is no real download here** — packs come off local disk in ~900 ms, so
  what was measured is the decode-and-loader cost on the main thread (the mechanism the risk
  named) and not a slow network or a slow CPU.
- **Progress stays per-pack, not per-byte — and that is now a decision, not a gap.**
  `wx.loadSubpackage`'s `LoadSubpackageTask` and its `onProgressUpdate` are typed in
  `platform/wechat/wx.d.ts` as of this pass, because the API is real: the return value is an
  object, the handler registers without throwing, and it fires. But its numbers are unusable.
  Each pack fires **exactly one** event, always `progress: 50`, with
  `totalBytesExpectedToWrite` between 3,750 and 3,833 — for payloads spanning 118 kB (`boss`) to
  2.39 MB (`run`), whose generated stubs are 403 bytes. The figure describes neither the pack nor
  anything in it and never reaches 100, so a bar fed it would fill to half of 3.7 kB and stop.
  `packLoader.ts` therefore keeps counting completed units, and `wechatRuntimeFake.ts` now
  reproduces the useless event rather than an idealised one. What a device would have to show for
  the byte-accurate bar to be worth wiring: more than one event per pack, and an expected-bytes
  figure that tracks the pack's real size.
- **Web gets the same tiering for free and has nothing to verify.** There are no subpackages there;
  `AssetHost.loadPack` is absent and `ensurePack` resolves immediately, so on web this pass is
  purely "which `Assets.load` calls happen before the first paint" — a real first-paint win
  (0.95 MB of code instead of code plus 3.42 MB of art) with no new failure mode.

## Update (2026-09-01b): the curtain re-encode, settled — it stays at 468x832

The question the section above handed forward ("should the player download 606 kB for one
fixture", now that no gate presses on it) was put to the owner as a render comparison and
**answered: leave it alone.** `client/public/environment/door_curtain_raw.png` ships unchanged at
468x832 RGBA, 606,730 bytes, 1.56 B/px. Written down here so it is not re-litigated by whoever
next notices that this file is 12x the next-largest door state.

**There was never a free lever.** A lossless re-encode at the source resolution returns a
byte-identical file — `pngCodec.mjs`'s encoder is already what produced it. The alpha bounding box
is the FULL canvas (only 14.9% of pixels are fully transparent, *none* are fully opaque, mean alpha
122), so `trimAlphaBoundingBox` reclaims nothing and `--no-trim` is belt-and-braces here rather
than load-bearing. The only thing that moves the number is pixel count:

| long axis | source | file | vs. 592 kB |
| --- | --- | --- | --- |
| 832 (shipped) | 468x832 | 592 kB | — |
| 512 | 288x512 | 250 kB | -59% |
| 416 | 234x416 | 174 kB | -71% |
| 320 (pipeline default) | 180x320 | 110 kB | -81% |

**Why that is not a free win either, and why it needed an eye rather than a number.** The curtain
is fit by width into the door opening (`doorLeaf.fitArtToOpening`, overflow cropped off the top),
the room camera zooms 4.29, and the renderer runs at resolution 2 — so on a perimeter door the
sprite occupies 549x788 DEVICE px against a 468x672 source band, about 1:1. Every variant below
832 is therefore an *upscale* of an additively blended translucent gradient, which is the
combination where softening and banding show most. And this asset exists to carry exactly one cue:
it was authored because procedural gradients had already been tried and the report was
*"依然不行...被阻挡时的火焰很明显，但是可以通过的效果太弱了"*. The acceptance test is "does this still read
as 'you can pass here' at a glance", which no measurement answers.

**How the comparison was produced** (reusable — this is the honest form for any "can we shrink this
asset" question): variants built into a scratch directory, then swapped into the LIVE scene through
the real `fitArtToOpening`, and each frame pulled with `renderer.extract.canvas` at 1:1 device
pixels. No flat image files, no mock-up: same door, same camera, same blend, only the source file
differs — the drawn rect is identical geometry in all four. Both shipped door shapes were covered.
One trap worth knowing: `layers.lit` carries a `filterArea` set from the previous camera frame, so
moving the world transform by hand without running the loop clips the entire world out of the
extract and yields a confidently blank frame.

Measured over the curtain's own 549x788 rect on a perimeter door — `detail RMS` is the Laplacian
energy, i.e. how much fine filament structure survives:

| | source | detail RMS | vs A | mean abs diff vs A | mean luma |
| --- | --- | --- | --- | --- | --- |
| A | 468x832 | 15.71 | 100% | — | 105.23 |
| B | 288x512 | 12.39 | 79% | 2.29 | 105.48 |
| C | 234x416 | 11.46 | 73% | 1.78 | 105.51 |
| D | 180x320 | 10.80 | 69% | 2.66 | 105.62 |

Three findings, all of which survive the decision and are worth keeping:

1. **Mean luma is flat across every variant** (105.23 -> 105.62). Downsampling costs the asset no
   brightness at all — the "you can pass" cue itself is untouched. What degrades is only the fine
   filament and sparkle structure. So the 592 kB is being spent on *texture*, not on the signal,
   which is precisely why this was a taste call and not an arithmetic one.
2. **416 is an exact 2:1 halving of the master** (832->416, 468->234), so its box average lands on
   whole pixel boundaries; it measures *closer* to the original per-pixel (1.78) than the larger
   512 variant does (2.29), at 30% fewer bytes. 512 (1.625x) and 320 (2.6x) land on fractional
   ratios and phase-shift the filaments. **General rule for this pipeline: when downsampling matters
   visually, prefer an integer ratio of the source over the next size up.**
3. **The kerb door does not discriminate and must not be used to judge this class.** It is the
   *harder* upscale (128 world px = 1098 device px from the same 468-wide source, 2.35x), yet all
   four variants land within 3% of the original (detail RMS 7.85 -> 7.62-7.70), because
   `doorLeafFrame` crops it to the curtain's blown-out bottom bloom, which has half the detail
   energy to lose in the first place. The perimeter door is the deciding case.

**What would reopen this**: byte pressure returning to the `run` pack, or a second illustrated
overlay of this class landing (one 606 kB additive sheet is a fixture; four are a policy). Neither
is true today — `run` is background-loaded and awaited at the run boundary, and total is 5.72 MB of
30 MB. The 3.9 MB master at `art/environment/door_curtain_raw.png` stays either way, so the
downsample remains a one-command change if that day comes:
`node tools/png-pipeline/compress.mjs --long-axis=<N> --no-trim client/public/environment/door_curtain_raw.png`
— followed by updating `doorCurtainCoverage.test.ts`'s `CURTAIN_ART_W`/`CURTAIN_ART_H`, which
hardcode 468/832 and would otherwise stay green against a fiction.

## Open questions

- **Texture format & max page size on the lowest base library** — must be measured on a real device (`04` checklist), not chosen from docs; affects atlas packing.
- **`ImageBitmap` availability in the WeChat loader** — if unreliable, which decode path does `Assets` take, and does it force a specific image format? (`04` flags this as surfacing "once real assets land" — this is that moment.)
- **Bundled vs. fetched art** — fetched art is determinism-safe (presentation only) but complicates release/versioning; where's the line, and does it share `09`'s content-delivery decision?
- ~~**Non-biped rigs.**~~ **(resolved 2026-07-23, `13`):** the humanoid diver is dropped. The hero is a floating **orb-core** and enemies are **single-eyed crystal critters** — all simple non-humanoid shapes. We author **our own small rig defs** (root + a few attachment/socket bones per body archetype), not funny's fixed 11-bone humanoid, and the rewritten editor holds **multiple rig definitions**. This removes the whole "humanoid vs quadruped" tension — nothing is humanoid.
- **Rig granularity** — do all characters share the one orb-core rig (max animation reuse — likely, since they differ only by parts/theme) or do some themed cores get bespoke bone tweaks (silhouette variety)? **Partially answered:** `brute`/`floater` (shipped 2026-07-28, `13`) reuse `critter-core`'s single one-bone rig — new art bundles, not new rig definitions — so reuse has not yet hit a wall through 6 body variants (3 orb-core characters + critter/brute/floater). (`02`)
