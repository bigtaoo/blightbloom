# Rendering & depth architecture

Goal: a fixed tilted view (not pure top-down; slightly forward-leaning, like Soul Knight) that produces playable spatial relationships with 2D techniques.

This file is the **index, the fidelity roadmap, the quality tiers and the power budget**. The mechanisms — how a
wall is built, how the x-ray works, what the arena's frame costs — live in
[`design/rendering/`](rendering/), grouped by subject, each part under 1000 lines. The doc had
reached 2,719 lines in one file.

Code comments cite this path two ways and both still land here: **`design/01 milestone N`** reads
the [Fidelity roadmap](#fidelity-roadmap-by-priority) below, and **`design/01 "Section title"`**
is in the map below. The map carries every `##` and `###` heading; a citation naming something
finer — a bold sub-heading such as *"Every wall stands, at one of three heights"* or *"The shield
is the deliberate exception"* — is inside one of the parts, so grep `design/rendering/` for it.

## The mechanisms

### [Foundations](rendering/01-foundations.md)

The projection, the coordinate model and the layer stack — the invariants everything else is drawn against.

- **[View](rendering/01-foundations.md#view)** — The tilted camera, room zoom-to-cover, and the framing rules a live report set.
- **[Coordinates & height model](rendering/01-foundations.md#coordinates--height-model)** — Two Y values per entity: where it stands and where it is drawn.
- **[Depth sorting (Y-sort)](rendering/01-foundations.md#depth-sorting-y-sort)** — `zIndex = gy`: lower on screen draws later. Hidden, but never lost.
- **[Shadows](rendering/01-foundations.md#shadows)** — Drawn from the ground coordinates, sliding away from the fixed upper-left key light.
- **[Layers (bottom to top)](rendering/01-foundations.md#layers-bottom-to-top)** — ground / shadow / entities / fx / ui, what sits in each, and which of them are lit.
- **[Per-weapon local z-order](rendering/01-foundations.md#per-weapon-local-z-order)** — An orbiting weapon socket has to switch front/back by facing.
- **[Limits of fake 3D (honest note)](rendering/01-foundations.md#limits-of-fake-3d-honest-note)** — 2D sorting is per-object, not per-pixel. What breaks, stated honestly.
- **[Ambient animation rates (idle loops have a Nyquist floor)](rendering/01-foundations.md#ambient-animation-rates-idle-loops-have-a-nyquist-floor)** — A rate constant in rad/ms, and why a decimal place wrong reads as a flicker.
- **[Text measurement (Pixi's measure canvas is NOT its paint canvas)](rendering/01-foundations.md#text-measurement-pixis-measure-canvas-is-not-its-paint-canvas)** — Pixi's measure canvas can resolve the same font string to a different font than its paint canvas.

### [Walls](rendering/02-walls.md)

How stone is built and shaded: standing runs, the measurement that judged them, the north-south case, and pillars.

- **[Standing walls (2026-08-18)](rendering/02-walls.md#standing-walls-2026-08-18)** — "Walls show a front face" had only ever been true of pillars.
- **[Volume, measured (2026-08-19)](rendering/02-walls.md#volume-measured-2026-08-19)** — The wall and character passes were built by looking; this one by measuring the frame they produced.
  - [The character, same treatment](rendering/02-walls.md#the-character-same-treatment)
- **[A north-south run is not an east-west wall (2026-08-19)](rendering/02-walls.md#a-north-south-run-is-not-an-east-west-wall-2026-08-19)** — Every number in `wallTone.ts` had been measured on an east-west wall and applied unchanged.
  - [The corner: two blocks, one continuous top](rendering/02-walls.md#the-corner-two-blocks-one-continuous-top)
  - [...and the corner again: a deep run TUCKS (2026-08-19)](rendering/02-walls.md#and-the-corner-again-a-deep-run-tucks-2026-08-19)
  - [`wallComposition.test.ts` — the assertion class all four rounds were missing](rendering/02-walls.md#wallcompositiontestts--the-assertion-class-all-four-rounds-were-missing)
- **[A pillar is a sprite now (2026-08-20)](rendering/02-walls.md#a-pillar-is-a-sprite-now-2026-08-20)** — "Pillars read as smooth cans next to the walls."

### [Occlusion & doors](rendering/03-occlusion-and-doors.md)

Keeping the character visible through stone, and the one fixture a player has to read at a glance.

- **[The occlusion x-ray: the character is never lost behind a block (2026-08-20)](rendering/03-occlusion-and-doors.md#the-occlusion-x-ray-the-character-is-never-lost-behind-a-block-2026-08-20)** — "角色跑到墙下面去了" — the body read luma 78.4 against cap stone and was simply gone.
  - [The deep pass stops where the body does (2026-08-27)](rendering/03-occlusion-and-doors.md#the-deep-pass-stops-where-the-body-does-2026-08-27)
- **[A door is a wall block whose face is an opening (2026-08-20)](rendering/03-occlusion-and-doors.md#a-door-is-a-wall-block-whose-face-is-an-opening-2026-08-20)** — A door was a flat sprite stretched to its passage box while everything around it had volume.
- **[An open door is lit from beyond (2026-08-30)](rendering/03-occlusion-and-doors.md#an-open-door-is-lit-from-beyond-2026-08-30)** — "You can walk through here" was being rendered as the absence of a signal.
  - [The recess itself is still shared stone, and then it is a whole illustrated curtain (2026-08-30b)](rendering/03-occlusion-and-doors.md#the-recess-itself-is-still-shared-stone-and-then-it-is-a-whole-illustrated-curtain-2026-08-30b)
- **[Every door is the same door, whatever wall it is cut into (2026-09-03)](rendering/03-occlusion-and-doors.md#every-door-is-the-same-door-whatever-wall-it-is-cut-into-2026-09-03)** — 11 of the 24 shipped doors were a 22 px letterbox under 64 px of their own lintel; a door now has one height, not the wall's.
- **[A door has a clock (2026-09-03b)](rendering/03-occlusion-and-doors.md#a-door-has-a-clock-2026-09-03b)** — "太死板": a door measured 0.01 luma of motion because nothing in this project could animate a scene fixture at all. Direction is what now says passable.
- **[...and then only the door, with no wall hanging over it (2026-09-03c)](rendering/03-occlusion-and-doors.md#and-then-only-the-door-with-no-wall-hanging-over-it-2026-09-03c)** — one height for every door left the 11 kerb doorways with a slab of their own cap stone hanging 82 px above the crown line; a door draws a cap only where its flank reaches it.
- **[The floor a door lights is not always south of it (2026-09-03d)](rendering/03-occlusion-and-doors.md#the-floor-a-door-lights-is-not-always-south-of-it-2026-09-03d-client-only-no-engine-bump)** — the light a door lays on the floor was always drawn south of its threshold; on the 13 doors cut through a north-south wall that ground is the same wall continuing, and it drew over it.
- **[A door's ring belongs to the door it lights (2026-09-04)](rendering/03-occlusion-and-doors.md#a-doors-ring-belongs-to-the-door-it-lights-2026-09-04)** — with the rings finally visible, they were centred on the passage rather than the arch and reached 2.7 door widths out; both numbers now come from the drawn opening.

### [The floor, the arena, the void](rendering/04-floor-arena-void.md)

The ground plane, what it costs on a real GPU, and what is drawn beyond where the stone ends.

- **[The floor stops at its rooms (2026-08-20)](rendering/04-floor-arena-void.md#the-floor-stops-at-its-rooms-2026-08-20)** — One `TilingSprite` over the whole world, with two separate defects in one extract.
- **[The same sweeps, on the arena (2026-08-26)](rendering/04-floor-arena-void.md#the-same-sweeps-on-the-arena-2026-08-26)** — Every wall/door/x-ray sweep had measured the five PvE floors and nothing else.
- **[The arena's frame, measured on a GPU (2026-08-26)](rendering/04-floor-arena-void.md#the-arenas-frame-measured-on-a-gpu-2026-08-26)** — It did not need a handset, it needed a browser surface with a timer-query extension.
  - [Follow-up: the floor is cullable now, and the diagnosis above was wrong (2026-08-26)](rendering/04-floor-arena-void.md#follow-up-the-floor-is-cullable-now-and-the-diagnosis-above-was-wrong-2026-08-26)
  - [Both of those experiments came back no, and the floor is half spill (2026-08-27)](rendering/04-floor-arena-void.md#both-of-those-experiments-came-back-no-and-the-floor-is-half-spill-2026-08-27)
  - [The clip that follows, and where a cut on a floor is allowed to land (2026-08-27)](rendering/04-floor-arena-void.md#the-clip-that-follows-and-where-a-cut-on-a-floor-is-allowed-to-land-2026-08-27)
- **[The void gets a face (2026-08-27)](rendering/04-floor-arena-void.md#the-void-gets-a-face-2026-08-27)** — Twelve empty grid cells read as a flat black rectangle, about a fifth of a 16:9 frame.
  - [The rule, and why it is spans and not a boolean](rendering/04-floor-arena-void.md#the-rule-and-why-it-is-spans-and-not-a-boolean)
  - [The return, and why it is the CAP's swatch](rendering/04-floor-arena-void.md#the-return-and-why-it-is-the-caps-swatch)
  - [What it fires on](rendering/04-floor-arena-void.md#what-it-fires-on)
  - [Why NORTH is not in this, and how that was checked rather than assumed](rendering/04-floor-arena-void.md#why-north-is-not-in-this-and-how-that-was-checked-rather-than-assumed)
  - [What it costs](rendering/04-floor-arena-void.md#what-it-costs)
- **[The void's far side (2026-08-28)](rendering/04-floor-arena-void.md#the-voids-far-side-2026-08-28)** — Pit, open sky, or ground beyond the wall — the projection settles it before anything is built.
  - [What it is, and the two things it does not have to compute](rendering/04-floor-arena-void.md#what-it-is-and-the-two-things-it-does-not-have-to-compute)
  - [Measured, on a live frame](rendering/04-floor-arena-void.md#measured-on-a-live-frame)
  - [Two defects found on the way, one by the frame and one by a battery](rendering/04-floor-arena-void.md#two-defects-found-on-the-way-one-by-the-frame-and-one-by-a-battery)

### [The character and the objects on the floor](rendering/05-character-and-objects.md)

The things standing on the ground rather than the ground itself.

- **[Grounding the character (2026-08-18)](rendering/05-character-and-objects.md#grounding-the-character-2026-08-18)** — A 360° facing continuum, and still nothing saying the body was a volume in a space.
- **[The drops and the gate get real art (2026-08-20)](rendering/05-character-and-objects.md#the-drops-and-the-gate-get-real-art-2026-08-20)** — The scene queue closed for surfaces; this closes it for the objects standing on them.


## Fidelity roadmap (by priority)

1. **[verified in demo]** Tilted view + Y-sort + height/shadow + additive-blend FX.
2. **[shipped 2026-08-03]** Dynamic lighting: a per-pixel fake normal derived at shader time from a sprite's own rendered luminance/alpha (a Sobel-style gradient over 4 neighbour-texel taps, the same trick milestone 5's `OutlineFilter` already uses for alpha-edge detection — no normal-map texture asset exists or is needed), shaded against a fixed key light (reusing `RoomBuilder.ts`'s "lit from upper-left" pillar-shading direction) plus a small dynamic point-light registry (`game/fx/lighting.ts`'s `LightRegistry` — the local player's own glow + transient muzzle-flash/impact bursts). This is a scoped equivalent of "normal maps + point lights + lightmap (multiply composite)," not that literal architecture: no `RenderTexture`/deferred-lighting layer exists anywhere in this codebase, and building one would be disproportionate to a fixed-camera 2D sim — a fifth custom `Filter` does the job instead, following the same template as the four milestone-5 shaders below. **Re-shaped 2026-08-24** into `SceneLightFilter`, ONE pass over the `lit` layer instead of one `NormalLitFilter` per actor: the per-actor form cost a render-target pass per character and broke the sprite batch (render p50 10.4ms of a 16.7ms frame, 175 draw calls / 105 program switches for 9 actors; one pass is 2.4ms). The move also upgraded the point lights from one averaged direction per actor (`LightRegistry.strongestAt`) to real per-texel direction and falloff for every light at once, and extended lighting to the floor and walls, which the per-actor form could never reach. Unblocked once ROADMAP 5.3 settled that GPT-Image-2-generated art counts as final production art (no more "normal-map authoring needs real art first" gate) — see ROADMAP's 2026-08-03 updates on both items for the full account.
3. **[shipped 2026-07-26]** Post-processing: bloom-lite (`BlurFilter` on the additive `fx` layer — a cheap approximation, not real multi-pass bloom), custom `VignetteFilter`/`ChromaticAberrationFilter` (`game/fx/filters.ts`, hand-written GLSL, no third-party filter package), hit-stop (brief sim-tick freeze, offline-only) + screen-shake (decaying trauma, `game/Game.ts`).
4. **[shipped 2026-07-26]** Particle system: `game/fx/Particles.ts` — muzzle flames + shell casings (on `bullet_fired`), explosion debris (on enemy `death`), ambient drifting dust. Graphics-only (no textures), same events-queue-driven render-only discipline as the rest of this doc.
   **Re-anchored and re-shaped 2026-08-30** (user report *"枪口也没有射击特效，而且子弹出现的也很突兀"*): the fx for a shot were being burst at the event's own `gx/gy` — the SIM's muzzle, a flat `muzzleOffset` along the aim ray on the ground plane — lifted by a hardcoded 12 px. Measured on real shots in a live room that lands **12–14 world px** from the gun the rig actually draws, i.e. most of a body radius, so an fx that had existed since 2026-07-26 read as absent. They now anchor on `Actor.muzzlePos()`, the same drawn barrel tip the bullet view has spawned from since 2026-08-17 (`bullet_fired` gained an `ownerId` so render can find the shooter; fx-only, no `ENGINE_VERSION` bump). The radial `flash()` at that event was replaced by `FxController.muzzleFlare` — a directional cone + cross-flash + near-white core that COLLAPSES over 85 ms rather than expanding over 170, because at 170 ms a 200 ms-cooldown weapon has one on screen essentially permanently, which reads as a glowing barrel rather than as shots. `muzzleFlame` split into two populations (fast collimated embers, slow wide gas); a single mid-speed spray is the average of the two and looks like neither.
   **The melee counterpart, 2026-09-02** (asked for directly: an fx that shows the attack's
   fan-shaped range): a shot had a flare since 2026-07-26 and a swing had nothing, while the
   sector a swing hits — and parries bullets in — varies 60°-220° across the roster and was on
   screen nowhere. `game/fx/slashArc.ts` sweeps that sector once per swing, at the weapon's own
   `arcHalf`/`range` resolved out of `GameState` (no event field, no `ENGINE_VERSION` bump),
   scheduled off the same `swingSchedule` strike window the blade's own envelope uses. It is the
   **only `Mesh` in this renderer**, and deliberately: the look needs alpha varying radially (a rim
   at the reach limit, transparent at the body) AND along the sweep (hot at the blade, fading
   through the wake), which is two dimensions, where a `Graphics` carries one — `shadeRamp.rampFill`
   maps a linear gradient through a texture matrix and a matrix cannot express a polar mapping, so
   the Graphics form of this is N constant-alpha sub-wedges, the banded shape `shadeRamp.ts` exists
   to have deleted. Its brush is a `bakedField` (256×64 POT, mipmapped, premultiplied, tinted per
   element, zero asset bytes) parametrised on fractions, so one bake serves every arc width without
   stretching; the unswept part of the sector is drawn as zero-area triangles rather than at alpha
   0, which is what gives the leading edge a hard boundary. Verified by an A/B `extract` diff on a
   frozen live frame, not by looking — the arc sweeps around a character already wearing a cyan
   shield shell, and no screenshot separates the two. See `design/12` and roadmap volume `15`.
   **The death burst re-sized 2026-09-03** (live report: the effect itself reads well, but it is
   far too big — make it a circle whose radius comes from the monster's own body): the burst was
   one authored spray for every corpse — each piece rolling its own speed (70-160 px/s) and its
   own lifetime (260-500 ms) under gravity, i.e. a reach of anywhere from 18 to 80 world px,
   drifting downward as it went. Two consequences, and both are the report. Its SIZE had nothing
   to do with the thing dying — up to 5 body radii on a 15 px mob and 2.7 on a 30 px boss, so a
   mob's death was the bigger event of the two — and its SHAPE was a plume rather than a burst,
   because where any one piece ended up was independent of every other and gravity pulled the
   whole thing off-centre. It is now solved from the body instead: every piece travels the same
   `DEBRIS_REACH_R` = 1.6 body radii over one shared lifetime (speed = distance / life, never
   rolled), the jitter is on the angle and on ±12% of the radius so it cannot change how big the
   burst is, the piece count is held proportional to the body so a boss's larger circumference
   keeps the same angular density, and the gravity term is gone — at a mob's 24 px reach its old
   200 px/s² was ~9 px of sag, better than a third of the ring's own radius, which is exactly the
   difference between a circle and a teardrop. The engine carries the radius on the event
   (`GameEvent`'s `death.r`, additive/inert, **no `ENGINE_VERSION` bump**) because this is the one
   lifecycle event that cannot be answered from state: `DeathDropsSystem` compacts the dead enemy
   out on the same tick, and the view has already left `Scene.views` by the time the frame's
   events are consumed. The centre moved with it, from a flat 12 px lift to 0.8 body radii — the
   same 12 px, on the mob it was originally eyeballed on.


5. **[shipped 2026-08-03] Custom shaders — all four items done:** dissolve on death,
   outline, energy shield, heat-haze distortion. All four are hand-written-GLSL custom
   Pixi `Filter`s in `game/fx/filters.ts`, applied to `Skin.view` only (not the whole
   actor container — weapon/aura/hp-bar/local-ring are separate children), composited
   together via `Actor.applySkinFilters()` when more than one is live at once (order:
   heat-haze warp, then shield glow, then outline highlight, then dissolve last). Shipped
   against today's placeholder art with no issues — the "read best against a real sprite
   silhouette, so this likely wants to follow milestone 2" sequencing preference recorded
   here earlier turned out not to matter in practice. Milestone 2 (lighting) has since
   shipped too (2026-08-03, see above) — the "genuinely blocked on real art" note that used
   to live here no longer applies, now that this project's GPT-Image-2 art counts as final.
   - **`EnergyShieldFilter`** — a transparent shell enclosing the character (a rim band until
     2026-08-25, a filled disc with a Fresnel hairline until 2026-08-26, a chord through a
     shell of real thickness with the body between its two hemispheres since; see "The shield
     is the deliberate exception" above and the three bullets after it for the rewrites and what
     each measured), built on the same UV-distance-from-centre technique as `VignetteFilter`
     (not true alpha-edge detection, so it needs no extra per-skin wiring against either the
     Graphics placeholder body or a real `.tao` rig). It is the one filter here that samples a
     SECOND texture — the generated membrane tile, `fx/filters/shieldScales.ts` — and the one
     with a radial cull, which is the only measured perf lever it has. `Actor.setShield` drives `intensity` off the actor's live two-pool shield ratio
     (design/02/05/07) — full glow at a full shield, fading as it drains, and since 2026-08-26
     playing a ~200 ms EXIT of its own once it hits 0 (`shatter`: expanding, wall thinning,
     scales thrown outward, light collapsing to exactly nothing) rather than being dropped
     between two frames. `EventReactor`'s burst and `ParticleSystem.shieldShards` cover the
     same instant in world space. Its UV-distance-from-0.5 assumption DOES need the render area itself to be
     centred and symmetric, though — Pixi's auto-computed filter bounds for `skin.view`
     are not (the placeholder's facing-direction wedge / a real rig's aim-mounted weapon
     sprite both extend outward on one side only), which read as a lopsided glow until
     fixed (2026-08-12): `Actor`'s constructor now pins an explicit, fixed `filterArea`
     on `skin.view`. X stays pinned to the actor's local origin (that asymmetry is
     genuinely facing-dependent). Y is a follow-up fix the same day: a real rig's
     decorative bones hang off the body bone's TIP, not its centre (`orbCoreRig.ts`), so
     the assembled silhouette is consistently top-heavy relative to local `(0,0)` in a
     way that does NOT depend on facing — pinning Y to a flat 0 (the first pass) still
     left the glow hugging the ground with the top of the sprite poking out above it.
     Fixed by measuring `skin.view.getLocalBounds()` once at a neutral rest pose and
     centring Y on that instead — ROADMAP's 2026-08-12 "Shield-centering follow-up" entry
     has the full account, including why the first fix's own test never caught this (it
     only ever exercised the Graphics placeholder, not a real loaded rig). A symmetric
     `filterArea` is necessary but was NOT sufficient — see the `vTextureCoord` gotcha
     below, which is what finally closed this bug out on 2026-08-15.
   - **`OutlineFilter`** — a REAL alpha-edge-detected silhouette outline (samples the
     actual rendered alpha at 4 neighbour texels via Pixi's auto-bound `uInputSize` filter
     uniform), unlike the shield's approximation — needed because an outline must hug
     whatever shape is actually drawn. `Actor.hitFlash()` fires it as a brief "you were
     just hit" flash, wired from `EventReactor`'s `hit` case via a new `Scene.actorAt(id)`
     lookup (added to `EventReactorHost` as a duck-typed `{ hitFlash(): void }`, so
     `EventReactor` still never imports scene/ types) — independent of the existing
     position-anchored `fx.flash()` burst, which reads as "impact happened here" rather
     than "this actor took it".
   - **`DissolveFilter`** — procedural cell noise (a GLSL hash of the UV, no noise
     texture — same "no textures" discipline as `Particles.ts`) burns away in patches as
     death progresses, ember-coloured edge trailing the boundary. Needed a real render-
     side architecture change, not just a new filter: `Scene.reconcile` used to destroy a
     dead entity's view the SAME tick it dropped out of the engine's `alive` list (the
     `seen`-diff cleanup loop). Now, when the vanished view is an `Actor` (not a bullet/
     pickup — those still destroy immediately), `Scene` calls `Actor.startDissolve()`
     (hides weapon/aura/hp-bar/local-ring, leaving only the dissolving body) and keeps it
     in a separate `dying: Actor[]` list, stepped every `Scene.interpolate()` call until
     `Actor.isDissolved` reports the ~700ms animation done, then destroys it for real.
   - **`HeatHazeFilter`** — a cheap sine-based UV wobble (no noise texture, no real
     refraction pass — same "own the code, own the cost" simplification as the vignette).
     Driven by `Actor.setStatus`'s existing `burnTicks > 0` condition (the same signal
     that already drives the burn ring in `AURAS`) — a burning actor's silhouette itself
     shimmers, on top of the ring.
   - **Gotcha hit while building `OutlineFilter`:** redeclaring Pixi's auto-bound
     `uInputSize` filter uniform in a fragment shader without an explicit `highp`
     qualifier fails to link on GL ("Precisions of uniform 'uInputSize' differ between
     VERTEX and FRAGMENT shaders") — the default vertex shader (`defaultFilterVert`)
     implicitly gets `highp` (GLSL ES vertex-stage default for `float`), while a fragment
     shader has no default and Pixi's own precision header pins it to `mediump`. Any
     future filter that reads `uInputSize` (or another Pixi-auto-bound uniform) in its
     fragment stage needs `uniform highp vec4 uInputSize;`, not a bare `uniform vec4`.
   - **`vTextureCoord` is NOT 0..1 — the `FRAME_UV` gotcha (root-caused 2026-08-15, the
     real end of the "lopsided shield ring" saga).** Pixi's default filter vertex shader
     emits `vTextureCoord = aPosition * (uOutputFrame.zw * uInputSize.zw)`, so it spans
     `0 .. (filtered region / allocated texture)`. Those two differ almost always: filter
     inputs come from `TexturePool.getOptimalTexture`, which rounds each dimension up to
     the next power of two, so a 130px-wide region is handed a 256px-wide texture and
     `vTextureCoord.x` never exceeds 0.508. Any shader that treats `0.5` as "the middle"
     is therefore centred on the POOL TEXTURE, not on the sprite — and since a region's
     pixel size is `filterArea × camera zoom × renderer resolution`, crossing a pow2
     boundary flips the effect from correctly centred to entirely off-region with no code
     change. That is what produced the long-reported partial/crescent shield ring, and
     what made it look like "integer camera zoom is fine, 1.5/1.32 is broken" — which got
     misdiagnosed (commit `d5c06db`, since reverted) as Pixi corrupting filters under a
     non-integer ancestor scale, and "fixed" by baking `layers.entities` to a 1:1
     `RenderTexture` every frame. That workaround left the ring still off-centre and cost
     real resolution: the bake texture defaulted to `resolution: 1` with no antialias
     while the renderer runs at `min(devicePixelRatio, 2)`, so every actor/bullet/pillar
     was sampled at roughly `1/(2 × zoom)` of the rest of the frame, and additive children
     (status auras, bullets) lost their blend against the ground. Real fix: the shared
     `FRAME_UV` GLSL prelude in `fx/filters.ts` — `frameUv()` remaps `vTextureCoord` to a
     true 0..1 across the region, `frameOffset()` converts a region-space displacement
     back to texcoord space, `clampToFrame()` keeps displaced samples off the pooled
     texture's stale neighbouring pixels. Used by the shield (ring centre), vignette and
     chromatic aberration (screen centre), dissolve (cell grid), and heat haze (wobble
     frequency + amplitude), and by the scene-lighting pass (each texel's WORLD position,
     `uRegion`). `OutlineFilter` deliberately does NOT use it: it only ever steps by one
     texel, and `uInputSize.zw` is already exactly that. A filter that takes the prelude
     must NOT also declare `uInputSize` itself — that is a hard 'redefinition' compile
     error, and a filter whose program fails to compile renders its whole layer black.
     `EnergyShieldFilter` additionally sets `clipToViewport: false`, because Pixi otherwise
     intersects the region with the viewport (`FilterSystem._calculateFilterBounds`) and
     would re-introduce a lopsided ring for any shielded actor standing at a screen edge;
     that is safe only because `filterArea` already bounds it to a small fixed square, and
     is deliberately NOT done for the two screen-wide post-fx, which need the clip to size
     themselves to the viewport. General lesson: when a filter's symptom flips on and off
     with the camera zoom, suspect the pow2 filter-texture pool before suspecting Pixi.

## Render quality tiers (2026-08-25)

Everything the fidelity roadmap above shipped ran **unconditionally**. There was no quality
setting anywhere in the codebase, and every perf number in this document was measured on a
desktop Chrome — so a device that could not afford the frame had nothing to turn off. That is
the gap this closes, and it is worth stating that it is a DESIGN gap rather than a missing
measurement: `04`'s checklist items 3 and 6 ("frame rate on low-end Android", "lighting
performance on low-end devices") were unanswerable in the only way that matters, because a bad
answer had no remedy attached to it.

`render/quality.ts` holds the tiers and the table that separates them. `render/qualityWatchdog.ts`
holds the `'auto'` policy. `game/renderQuality.ts` applies a tier to the live renderer.

| Knob | high | medium | low | why it is on this list |
|---|---|---|---|---|
| `resolutionCap` | 2 | 2 | 1 | Fill rate. A DPR-3 phone rendering at 2 draws 4x the fragments of one at 1, and **every pass below pays that multiplier again**. The platform's own `min(devicePixelRatio, 2)` still applies on top — the cap only ever lowers it. Unchanged at `medium` on purpose — see the note under the second table. |
| `sceneLight` | on | **on** | off | The one `SceneLightFilter` pass over `layers.lit`. |
| `screenFx` | on | off | off | `VignetteFilter` + `ChromaticAberrationFilter` over `layers.world`. |
| `bloom` | on | off | off | The bloom-lite `BlurFilter` over the additive `layers.fx`. |
| `actorShaders` | on | off | off | The four per-actor skin shaders. One render-target pass **per actor** that currently has a status effect — the cost profile the 2026-08-24 lighting pass existed to remove from the frame, still reachable through the status shaders. |
| `particleBudget` | 1 | 0.6 | 0.35 | Burst counts and ambient dust rate. Each particle is its own `Graphics` node. |

The **`medium` rung landed 2026-09-08** with the power budget below, for the report *"游戏现在运行
在手机和ipad上时耗电量非常高"*. It keeps the one pass that carries the game's look and drops the
three stacked above it, so a frame goes from four full-viewport render-target passes to one — and
on a mobile tiler the pass COUNT is what costs, since each one is a tile flush and a reload of the
whole viewport.

**Measured, in the live scene** (`?perf=1`, a level-1 room with 8 enemies, via
`perf/drawAttribution`'s GL counters):

| | high | low | delta |
|---|---|---|---|
| draw calls | 31 | 23 | -8 |
| **render-target switches** | **11** | **1** | **-10** |
| program switches | 20 | 12 | -8 |
| texture binds | 100 | 90 | -10 |

The render-target line is the one that matters. On a mobile tile-based GPU each of those is a
full-viewport resolve, and the low tier removes ten of eleven — before the resolution halving
quarters the fragments in the one that remains. The A/B was confirmed to be real rather than
a no-op by frame diff: switching tiers moves **48.8%** of the composited frame, against an
independent liveness control (hiding `layers.entities`) at 32.4%.

**And the same three counters with the middle rung in them** (2026-09-08, a separate reading — a
live PvE room on a DPR-1 surface, so these numbers are not comparable with the table above; what
is comparable is the three columns against each other):

| | high | medium | low |
|---|---|---|---|
| draw calls | 41 | 34 | 32 |
| **framebuffer binds** | **11** | **3** | **1** |
| program switches | 18 | 14 | 12 |

`medium` buys 8 of the 11 render-target switches while keeping the lighting, which is why it is a
rung rather than "low with lighting". Its `resolutionCap` deliberately stays at high's 2: Pixi's
`Filter.resolution` defaults to 1 and does **not** follow the renderer's, so everything inside
`layers.lit`/`world`'s filters is already rasterized at 1x on every device, and lowering the
renderer resolution therefore buys only the final composite and the UNFILTERED layers — which are
the HUD and the menu text. Blurring the text to save the cheapest pass in the frame is the wrong
trade at this rung; `low` still makes it, because a device on `low` needs every fragment back.

Two rules the tiers are built around:

- **Quality is presentation-only.** It never reaches the sim (`06`/`12`'s locked "art never
  decides an outcome"), so two clients on different tiers stay byte-identical in simulation. A
  low-tier client sees a flatter scene, never a different fight.
- **`'auto'` never climbs back up.** A device that downgraded is by definition one whose frame
  budget that tier does not fit, so re-enabling would re-measure a slow frame and downgrade
  again — an oscillation the player would read as the game flickering between two looks. An
  explicit `'high'` pick always outranks the watchdog: the player asking for the good-looking
  version beats our guess about their hardware.
- **...but it STEPS, one rung per fresh streak** (2026-09-08, with `medium`). `QualityWatchdog`
  counts downgrades instead of latching a boolean, and its streak restarts after each step:
  "high does not fit" is no evidence about medium, and dropping straight to the cheapest tier on
  the first slow stretch would cost every mid-range phone the lighting it could actually afford.
  Reaching `low` off the real sampler therefore takes ~12s of slow windows rather than 6.

### The one place the tiers are not simply "less"

Neither `medium` nor `low` runs `DissolveFilter`, so a dying actor would stand at full opacity for the whole
`DISSOLVE_MS` and then vanish in a single frame — which reads as a dropped frame, not as a
cheaper effect. `ActorFilters` therefore drives a plain alpha ramp off the same clock
(`ActorFilterHost.setSkinAlpha`). The other three shaders need no such stand-in: they each have a
non-shader companion that still carries the information (the status aura ring, the hit flash's
own positional burst), so dropping them costs detail rather than meaning.

### What a device tester can read without any tooling

The settings screen's quality button reports what `'auto'` actually RESOLVED to, not just that
it is auto: once the frame watchdog steps it reads `AUTO (MEDIUM)` / `AUTO (LOW)` (`自动 (中)` /
`自动 (低)`). That makes `04`'s item 3 answerable by anyone holding the phone — a device reporting
itself, and now reporting WHICH rung it settled on — rather than requiring a remote console
session.

## The power budget (2026-09-08)

A tier decides what a drawn frame contains. This decides **whether the frame is drawn at all, and
how often** — and it exists because the report that prompted it (*"游戏现在运行在手机和ipad上时耗
电量非常高"*) was invisible to every instrument above. `game/powerBudget.ts` is the whole policy,
`GameLoop.update` applies it every frame, and both of its knobs are a function of `phase` alone.

**Nothing in `layers.world` is visible outside `'playing'`, and all of it was being drawn.** Every
menu-shaped screen (main menu, mode select, forge, squad lobby, PvP preview, matchmaking,
settings) *and* the pause menu *and* both result screens are backed by the same opaque
full-viewport panel art, so `GameLoop`'s own "freeze the last frame behind the menu" has never
been visible to a player. `RunLifecycle.resetRenderState` runs when the NEXT run starts, not when
one ends, so a player sitting in the forge after a dungeon paid for a complete in-run frame — 29
ground pieces, 64 live entity views, four filter passes — at the display's refresh rate, for as
long as they sat there. Measured with `?perf=1` at a phone-landscape 844x390 viewport, each phase
reached through its real flow:

| phase | frame | hiding `layers.world` moves | with `layers.ui` hidden |
|---|---|---|---|
| playing | 39 draws / 18 programs | 92.0% of pixels | 99.1% |
| paused | 39 / 18 | **0 px** of 329,160 | 99.1% |
| forge, after a run | 42 / 18 | **0 px** | 99.1% |

The third column is the load-bearing control, and the reason to state it: `perf/frameProbe.ts`'s
default liveness check blanks the whole stage, so it fires whether or not the subtree under test
is on screen. Hiding `layers.ui` instead is what separates "drawn and covered" — which costs
battery — from "not drawn at all", which costs nothing. With the world switched off, the pause
frame is 5 draws / 0 programs / 3 framebuffer binds.

**The ticker had no cap at all** (`maxFPS === 0`), so the render rate was whatever the panel ran
at: a 120 Hz ProMotion iPad drew FOUR frames per 30 Hz sim tick and spent twice the power of the
60 Hz phone beside it on interpolation nobody asked for. Now 60 while playing — two frames per
sim tick, which is what every frame-time number in this document was measured at — 30 on every
other screen, and 30 in a run if the player asks for it (`10`'s FRAME RATE row).

Three rules it is built around:

- **Power is a separate axis from framerate, and that is why the quality tiers could not see
  this.** `'auto'` is chosen by a framerate watchdog; a device that holds 60 fps while drawing an
  invisible dungeon at 120 Hz never trips it and never will. It is not struggling, it is wasting.
- **The idle cap has a floor, and it is not taste.** `PerfMonitor` keeps sampling on a menu and
  the watchdog steps down after three windows under 25 fps, so an idle cap below that would
  downgrade the renderer for anyone who paused for six seconds — with the settings screen still
  reading `auto` and nothing having actually been slow. Measured against the real sampler: 30
  never trips it, 20 does.
- **An idle screen may never cost more frames than the run does.** `maxFpsForPhase` takes the
  lower of the idle cap and the player's own pick, so someone who asked for 30 in a fight does
  not get a menu drawing more frames than the game.

Presentation-only, like the tiers: the sim runs off `GameLoop`'s own fixed 30 Hz accumulator, not
off the render rate, so two clients capped differently stay byte-identical (`06`).

### The premises it rests on, as tests rather than as a measurement

Both halves above were verified once, by hand, in a browser — the kind of evidence that stops
being true without anything turning red. Both are now pinned headlessly:
`game/screens/menuCoversWorld.test.ts` (every screen a menu-shaped phase can show mounts a
full-bleed sprite at `alpha === 1` covering the viewport, from `Panel`'s background art) and a
`game/scene/layers.test.ts` case (every layer a run draws into is under `world`; `backdrop`/`ui`
are not). Deleting `background: 'hub'` from one screen turns the first red — without it, the
world-hiding rule would quietly turn that screen into a hole.
