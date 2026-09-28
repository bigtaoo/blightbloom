# Foundations

The projection, the coordinate model and the layer stack — the invariants everything else is drawn against.

One part of the rendering architecture doc. The index, the fidelity roadmap and the quality
tiers live in [../01-rendering.md](../01-rendering.md).

## View

- **Tilted (3/4) view:** walls, pillars, and characters show a small "front face" instead of a pure top face, so height and volume read. This is the basis of the 3D feel.
- The camera has a fixed angle and never rotates; it may pan to follow the player.
- **Room zoom-to-cover** (legibility fix, 2026-08-02; cap raised 1.8→2.5 2026-08-12;
  contain-fit → cover-fit 2026-08-12, same day, follow-up; fit target changed from the
  whole floor to the CURRENT ROOM + cap 2.5→4.5 2026-08-17, see "Framing the current
  room" below; cap 4.5→3.5 2026-09-28, see "Motion comfort" below): the fitted rect is
  scaled up so BOTH axes cover the viewport (cover-fit — zoom by whichever axis needs MORE
  zoom, capped at `MAX_ZOOM` so a tiny/degenerate room doesn't blow sprites into blocks) —
  `FxController.updateCamera`, with the math in `CameraRig` (`client/src/game/fx/cameraRig.ts`). Originally contain-fit (zoom by whichever axis
  is TIGHTER), which left a real dark `Backdrop`-filled void on the other axis whenever
  the room's aspect ratio didn't match the viewport's — raising the cap (2026-08-12,
  earlier that day) only shrank that void for a too-small room, it couldn't fix an
  aspect-ratio mismatch. Switched to cover-fit (2026-08-12, user's own pick between that
  and "keep the whole room visible, reposition the void") to close it for good: the
  room can now exceed the viewport on the axis that used to have void, and the camera
  pans/clamps to the player there, same as it already did for a big room/arena. A room
  that already covers the viewport at 1x on both axes is untouched (zoom floors at 1,
  never shrinks). See "Camera cover-fit + weapon-slot HUD chip" in `ROADMAP.md`.
  (`CommandBuilder` used to divide a screen-space mouse aim point by this same zoom
  before converting it to world space — moot since `10` v33 removed manual aim; the
  camera zoom itself is otherwise unaffected.)
- **Framing the current room** (2026-08-17, live report: *"镜头往下一些，尽量视口内只有当前
  房间，或者说给角色最好的展示"*). Two changes to the same function:
  - **The fit target is the player's current ROOM, not the whole floor.** A dungeon floor
    is co-resident — every room stitched into one world by `buildFloorGeometry` — so
    fitting `worldSize` meant fitting a ~2000 px floor into a 1920 px viewport, i.e.
    cover-fit resolved to zoom 1 and the player saw several rooms at once, each small.
    `GameLoop.cameraFrame` now looks the player's cached `roomId` up in whichever of
    `dungeonRoomRects`/`arenaRoomRects` the run is using (`engine/state/roomModel.ts`, the one
    selector the camera, the floor and `EnvironmentSystem` share) and passes that rect as
    `updateCamera`'s `frame`;
    the whole floor stays the fallback for a mode with no room model. (Until 2026-09-28 it
    was also the fallback in a door passage, which belongs to no room — see "Motion comfort".) Level 1's rooms are
    ~480 px square, so this lands at ~4x and the room fills the viewport — which is what
    forced the `MAX_ZOOM` raise, since 2.5 bound in literally every room.
  - **The look-at point is biased above the player's feet** (`CAMERA_BODY_BIAS_R`, 8% of
    viewport height). Every entity reports its GROUND position, so a camera centred on it
    put the character's feet at screen centre and its whole body in the upper half, above
    a band of empty floor. Biasing the look-at point up in world space slides the rendered
    world DOWN and centres the character.
  - **Panning still clamps to the WORLD, not to `frame`.** Clamping to the room would hard-
    stop the camera at a doorway and cut off the corridor the player is walking into. The
    cost is that the room only fills the viewport exactly when the player is near its
    centre; standing off-centre shows a strip of the neighbouring room. A true one-room-
    per-screen lock would mean a jump-cut at every door, which is a separate design call.
- **Motion comfort** (2026-09-28, live report: *"玩起来还是感觉会头晕，类似晕3D的感觉"*; the work
  is [volume 104](../roadmap/104-2026-09-28-camera-comfort.md)). Nothing on the camera was
  eased, and three things moved the whole screen:
  - **Zoom is held through a door passage and eased between rooms.** A passage belongs to no
    room, so the player's `roomId` clears there and the camera used to re-fit the whole floor:
    ~4x → ~1x → ~4x in one frame each way through every door. `CameraRig` keeps the last room it
    fitted and eases toward a new room's fit in log space (`ZOOM_TAU_MS` 320).
  - **The camera follows a dead zone, eased.** It used to sit exactly on the player, so a strafe,
    a wall bump or a knockback was a whole-screen jolt, multiplied by the zoom. The player now moves
    freely inside `DEADZONE_R` (5% of the viewport's shorter side) and the camera eases toward the
    zone's edge (`FOLLOW_TAU_MS` 140). Both eases are `1 - exp(-dt/tau)`, so frame rate does not
    change them. A teleport, the first frame and a new run are cuts. The world-edge clamp is applied
    to both the anchor and the eased point, so an easing zoom never shows past the world.
  - **The shake is a smooth waveform, and a kill does not shake.** It was ±14 px of white noise
    re-rolled every frame and topped up by every kill; it is now `shakeOffset`'s two sines per axis
    (~7-12 Hz) at up to `MAX_SHAKE_PX` 7.
  - **`MAX_ZOOM` 4.5 → 3.5**, so the same step slides less screen. A level-1 room no longer quite
    covers a desktop viewport, and a sliver of its neighbours shows at the edges.
  These constants are a first tuning and sit together at the top of `cameraRig.ts`.

---

## Coordinates & height model

Every entity has two Y values:

- **Ground coordinates `gx, gy`** — used for depth sorting, shadows, and collision.
- **Height `z`** — visual lift for flying bullets / elevated cosmetics (render only). Actors stay grounded (`z=0`) — there is no jump, and `z` never gates gameplay (`07`).

Render transform: `screen.x = gx`, `screen.y = gy - z`. A large part of the 3D feel comes from objects being able to leave the ground.

**Bullets are drawn leaving the barrel tip, not the sim's muzzle point** (2026-08-17, live
report: *"子弹要从枪口打出"*). The engine puts a bullet `muzzleOffset` along the aim ray **on
the ground plane** and lifts it by `bulletZ`; the rig draws the gun wherever its own art
hangs it. `RigSkin.muzzleLocal` reports the mounted module's business end (its mounted
position + a ray/rect measure of how far the texture reaches from its anchor in its own
baked direction), `Actor.muzzlePos` lifts that into world space, and
`Bullet.setMuzzleOrigin` eases the difference out over the first 40 world px of *travel*
(2026-08-30 retune, live report *"子弹的弹道，现在会从枪口曲线跑到角色身前再继续飞向目标"*: a fixed
120ms budget spent itself fine for a normal-paced weapon (~38px covered) but a slow one
(frostseeker's 6 grid/s) only covers ~23px in the same 120ms, so the ~12-14px offset ate
over half its early flight instead of a third, and read as the shot curving in front of the
shooter before straightening out — budgeting by distance instead keeps that fraction the
same for every `bulletSpeed`). Fixed on the VIEW, not by moving the sim's own muzzle: the
sim position stays authoritative for hit detection, and a longer sim muzzle would let a
player standing flush against a wall spawn shots on its far side. Null only for a rig that
mounts nothing at all (`weaponMount: 'none'` — the boss) or before its weapon texture has
preloaded; every enemy has mounted a real module since 2026-08-21.

**That difference is a distance ALONG the shot, and nothing else** (2026-09-02, live report
*"子弹从枪口出去后进行了弧形的漂移，然后才直线运动"*). It has to be, because a correction that is
*across* the shot cannot be spent without walking the drawn round sideways while it flies
forward — which is an arc, however it is eased. Measured off the reported run: firing
straight up the screen, the round left the barrel **43° off-aim** and slid **20.8 world px**
(~79 screen px at the room camera's ~3.8x zoom) over ~150 ms before flying straight. Two
sources, both removed where they arose rather than eased away here:

- **Sideways** — the socket bone sat at its rest angle and only the *module* spun to the aim,
  so the tip it hangs off was a fixed body-local point and firing up or down drew the gun a
  socket-length off the line its own bullets flew along. The **bone** is now turned to the aim
  before FK runs (`rigWeaponMount.orbitActiveSocketToAim`) — i.e. it actually orbits, which is
  what design/13's "two weapon modules that orbit it" describes in the first place — and the
  enemy 'held' mount lost its 0.45 vertical squash for the same reason. Unsquashed and in the
  ground plane is not a taste call: `screen.y = gy - z` maps the ground 1:1, so anything else
  puts the drawn gun off its own bullets' line.

  *Orbiting the module alone was tried first and is wrong*: the socket **ring**, the tether
  drawn out to it and its contact shade on the core all hang off the bone, so the gun ended up
  ~70 px from the ring that holds it with the tether still reaching for where the ring was. It
  took one live frame to see and no test caught it — nothing asserts that a module sits on its
  own mount. Turning the bone instead puts every one of those on the aim for free.
- **Height** — `bulletZ` is a gameplay band (0.5 grid, "chest height, clears ground-hug
  hazards, blocked by tall cover", `07`) while the drawn gun is wherever the art hangs it:
  26.4 vs 16 world px for the hero. That gap is straight up the screen, i.e. perpendicular
  to any horizontal shot. `Bullet.setDrawnHeight` draws the round at the gun's own height
  (`muzzlePos().heightPx`, render-only — `z` itself is untouched and the sim never sees it).

`setMuzzleOrigin` then *projects* what is left onto the shot direction and eases only that,
so "a bullet is never bent" is a property of the renderer rather than an outcome of how well
two tables happen to agree. `muzzleParity.test.ts` bounds the perpendicular disagreement
itself, at 24 aim angles × every weapon × every body — the pose sweep is the point: every
measurement in that file used to be taken at aim 0, the one pose where the gap is almost
entirely along the shot and the component that draws an arc is invisible.

---

## Depth sorting (Y-sort)

- The entity layer sets `sortableChildren = true`, and every view's sort key is its ground `gy`. Since 2026-09-28 the key is written WITHOUT Pixi's `zIndex` setter (`scene/ySort.ts` `writeSortKey`), because the setter flags the whole render group for a rebuild on every write. Once per rendered frame, the layer's own `onRender` (`settleYSort`) asks Pixi to re-sort, and only when two children have actually crossed. The draw order is exactly what the setter produced; the frames with no crossing just stop paying for a rebuild. See "Steady load" at the end of "Layers".
- Lower on screen (larger gy) draws later → occludes objects above it. A character walking behind a pillar is hidden; in front, it hides the pillar.
- **Hidden, but never LOST**: since 2026-08-20 any standing block that is drawing over the local player OR a live enemy x-rays out of the way (see "The occlusion x-ray" above). The sort itself is unchanged — the character really is behind the stone, and the stone is what goes translucent.

---

## Shadows

- A soft shadow is drawn from the **ground coordinates** (`shadow.gy = gy`), so it stays on the floor no matter how high the body is.
- It shrinks, fades, **and slides away from the fixed upper-left key light** as the lift grows → reinforces the sense of height. This is the cheapest "3D cheat". `Entity.SHADOW_SLANT_X/Y` are the one place the slant is defined; actors, bullets, pillars and walls all use them, so nothing in a room disagrees about where the light is.
- Static tall objects (pillars) are drawn *upward* from a grounded origin rather than lifted by the transform, so their `z` is 0 and the displacement has to be supplied by hand (`Entity.shadowOffsetX/Y`).
- See "Grounding the character" above for the shape of the shadow itself (nested ellipses, not one disc) and for the 0.62 foreshortening every round thing lying on the GROUND PLANE shares — and for why the shield, which wraps the body rather than lying under it, is deliberately not among them.
- **Its radius comes from the DRAWN body, not from a collision radius** (`Skin.bodyDrawnR`, 2026-08-19) — see "Volume, measured" for why a number sized off the rig's declared radius made an enemy's shadow ~45% wider than the enemy.

---

## Layers (bottom to top)

| Layer | Contents | Sorting |
|-------|----------|---------|
| ground | floor (stamped per room), its wash/mottle/wear decals, the 64 px grid, the per-room light pool | fixed |
| shadow | all cast shadows | fixed (below entities) |
| entities | characters / enemies / pillars / bullets / **standing wall blocks + door fixtures** | **Y-sort (zIndex = gy)** |
| fx | muzzle flashes, explosions, deflect flashes, per-element bullet trails (additive blend) | overlay |
| ui | HP, weapon, crosshair — split into `hudOverlay` then `menu`, see below | topmost |

> **`ui` is two sub-layers, and only the upper one is scaled (2026-08-25).** `hudOverlay` holds the
> in-run HUD, the touch controls and the minimap; `menu` holds every full-screen screen plus the forge's
> floating SETTINGS button, and paints over `hudOverlay` (which is why a pause menu is legible mid-run).
> `menu` is a `MenuLayer` (`game/ui/menuLayer.ts`): it carries a fit-scale, `min(1, w/760, h/640)`, so a
> viewport shorter than the menus' design space shrinks the whole layer instead of each screen re-flowing
> — a WeChat landscape phone is 390 logical px tall, about half what these screens are laid out for.
> Capped at 1, so it is the identity transform on any desktop viewport. `hudOverlay` is deliberately
> outside it: a thumbstick should be thumb-sized on a phone, not shrunk with the menus. Before the split
> these were bare siblings in `ui` whose order came from *when* `Game` happened to add each one, which is
> also how the SETTINGS button ended up under the forge's own backdrop, invisible at every viewport.
> See design/04-wechat.md's **Viewport** section.

> **Lighting (2026-08-24): shipped, as one screen-space pass rather than a composited lightmap layer.**
> `ground`, `shadow` and `entities` are grouped under a `lit` container (`scene/layers.ts`) that carries a
> single `SceneLightFilter` (`fx/filters/litFx.ts`); `fx` and `hud` stay outside it — a muzzle flash IS
> light, and a floating health bar is a readout, not a surface. The pass derives a per-pixel fake normal
> from the composited layer's own luminance, applies the fixed key light, and then adds every live point
> light with real per-texel direction and falloff, so a flash lights the floor it goes off on. It replaced
> a `NormalLitFilter` attached to EVERY actor, which cost one render-target pass per character and broke
> the sprite batch — measured at render p50 10.4ms of a 16.7ms frame; the one pass is 2.4ms.
> The older cheap static half — a per-room falloff painted on `ground` (`scene/roomLight.ts`) — landed
> 2026-08-19 and is unchanged.

> **Draw calls (2026-08-24, the same day's follow-up): 165 -> 108, program switches 102 -> 98, and the
> render group is no longer thrown away every frame.** The filter pass above cut render p50 to 2.4ms but
> barely touched the batcher — 157 draw calls for a scene of 893 nodes. `perf/drawAttribution.ts` (new,
> and `window.__perf.attribute` / `.census` from a `?perf=1` console) attributed them: **wall blocks 79 of
> 165**, actors 22, the `shadow` layer 22, doors 14, ground 5. Two causes, both structural, both fixed
> without touching the Y-sorted `entities` layer that every occlusion cue depends on:
>
> 1. **The cap's additive key light was a second copy of the cap sprite** (`wallTone.CAP_BOOST_*`, which
>    exists because a Pixi tint cannot multiply *up*). A blend-mode change breaks the sprite batch, so
>    each of the 27 wall runs plus 4 doors cost a draw call for itself and two more for the halves of the
>    batch it split. The lift is a function of the swatch alone — the cap is opaque, so the destination
>    the additive copy reads is exactly the cap drawn before it — so it is now pre-multiplied into the
>    texture once (`scene/capLight.ts`) and the cap is one ordinary sprite. **-29 draw calls, -31 nodes**,
>    and verified by frame read-back rather than by eye: rebuilding the two-layer form in the live scene
>    and diffing the composited frame gives **0 of 1,641,600 pixels different**. All four `wall_*.png`
>    swatches are fully opaque (minimum alpha 255), which is the assumption that makes the identity exact;
>    the brightest pixels clamp (ice: 1.8% of blue) at the same point the additive blend clamped them.
> 2. **Pixi v8 only auto-batches a `Graphics` under 400 floats of geometry**
>    (`GraphicsContextSystem.updateGpuContext`), and nothing this project hand-bands comes close — the
>    room's shared wall shadow is ~24k floats, the floor's decal pass ~50k, one actor shadow ~830. Each was
>    a draw call plus, between sprites, a program switch each way. `render/staticGraphics.ts` forces
>    `batchMode: 'batch'` for authored-once geometry — but only on `ground` and `shadow`, which
>    `scene/layers.ts` now gives their **own render groups**. That second half is what makes the first
>    affordable: writing any descendant's `zIndex` invalidates the whole enclosing render group
>    (`sortMixin.depthOfChildModified`), and `entities` writes one per actor per frame, so before the split
>    the floor, the ground shadows, the health bars and the UI were all re-collected 60 times a second
>    (168 Graphics re-added per frame, 54 of them unchanged since the room loaded). **-24 draw calls**, and
>    render collection 0.60 -> 0.52ms. Also pixel-identical (0 of 1,641,600) against both halves reverted.
>    Caveat, measured and kept: `shadow` is static only in that it never resorts — bullets and actors add
>    and remove a shadow on it, which does invalidate the group, so under sustained fire its batched
>    geometry repacks most frames at about **+0.12 ms**. Shipped on the balance against -22 draws there
>    and -0.08 ms the rest of the time, not because it is free.
>
> **Rejected, with the measurement**: forcing the same batch mode on the wall shading inside `entities`.
> It is the single biggest remaining item — 50 draw calls and 50 program switches for 27 objects — and
> batching it works, but that group *is* invalidated every frame, so the batcher repacks ~18k floats and
> 2247 fills per frame. Measured **+0.7ms on a 2.4ms render** for -50 draws. Not shipped; the draw-call
> count is not the thing being optimised, the frame is.
>
> **What that leaves, and the two ways out** *(both resolved the same day — see the third pass below;
> route 1 shipped, in a form that needed no canvas, and route 2 stayed rejected)*. ~90 of the 98 program
> switches and 90 of the 108 draw calls
> are Graphics inside `entities` (wall shading 50, actor rig shading 22, doors 10) — all of them static
> geometry that is only unbatched because it is too big. Bringing the wall shading under the 400-float
> line was probed live by swapping in a smaller geometry: the frame goes to **52 draws / 43 programs**.
> Two routes there, in preference order:
> - **Replace the hand-banded ramps with `FillGradient`.** `wallShadingSurfaces.ts` draws every ramp as
>   `CAP_GRADIENT_BANDS`/`SIDE_STEPS`/`BASE_AO_BANDS` separate rects at stepped alphas — 65-102 fills per
>   block. A gradient fill is one quad, so the shading would drop under the auto-batch line *and* pack
>   far cheaper than today's unbatched path. It would also be **smoother**, which is the direction the
>   band counts were already being pushed (see `CAST_PASSES`: "at two alphas you see both of them"). Not
>   pixel-identical, so it needs a look before it ships.
> - **Bake each block's shading to a texture at room build.** Removes the per-frame cost entirely, but the
>   camera zooms, so a 1x bake would soften the one surface that has had six rounds of tuning, and it costs
>   ~27 render textures per room. Rejected for now on both counts.
>
> The pass order flagged during the filter work is unchanged and still correct: `SceneLightFilter` shades
> the composite *after* an actor's own overlays (shield glow, hit outline, dissolve). Nothing here moved a
> layer or a filter, and the byte-exact frame diffs above are what proves it rather than inspection.

> **Draw calls, third pass (2026-08-24, same day again): 102 -> 27, program switches 93 -> 17.** The two
> routes the note above left open were the two candidates, and both came out the same way — not by
> overriding Pixi's batching rule but by making the geometry small enough not to trip it. One new module
> does both: `render/shadeRamp.ts`, which builds a shading gradient as a **sampled texture** instead of a
> stack of hand-stepped rects.
>
> The mechanism, because the obvious tool does not work here. `FillGradient` — the route this doc named
> first — calls `DOMAdapter.createCanvas()` at `fill()` time and throws `ReferenceError: document is not
> defined` in this repo's canvas-free test environment, which is where the wall and rig shading are
> machine-checked; `rigShading.ts` has carried a note ruling it out on those grounds since 2026-08-19,
> and that note was right. A `BufferImageSource` needs no canvas. So a ramp is a 256-texel RGBA texture
> painted from a profile function and cached by key, and a cue is one quad sampling it. Two consequences
> worth stating separately from the draw calls:
> - It is **testable**, where a gradient fill would not have been. `readRampFill` inverts the fill's
>   matrix back to the ramp's own segment and `rampProfile` reads its texels, so a test asserts *where a
>   cue starts and ends and what shape its falloff is* — strictly more than the old band comparison,
>   which could only ever see band centres.
> - The ramps are anchored to an explicit **segment** in local space, not to the filled shape's bounds.
>   Half of this project's cues are drawn on a rect that `clampSpan` has already narrowed
>   (`wallShadingJoins.drawCornerAO`), and a ramp bound to the shape would *compress* the whole falloff
>   into whatever slice survived instead of truncating it.
>
> 1. **Wall/door block shading: 50 draw calls and 50 program switches -> 0.** Every ramp in
>    `wallShadingSurfaces.ts` / `wallShadingJoins.ts` is one quad. A block's shading went from 65-116
>    fills and 520-2010 floats to 8-15 fills and ~150 floats — under the 400-float line with two orders
>    of magnitude of room, so all 27 wall runs and 4 doors now batch with the cap and face sprites beside
>    them. Across the room: 2294 fills -> 316.
>    Not pixel-identical, and measured rather than asserted: rebuilding the stepped form in the live scene
>    and diffing the composited 1920x855 frame gives **max 11/255 on 7.0% of pixels, mean 1.62, and 86% of
>    the changed pixels within 2/255** (old-vs-old reproduces at 0 difference, which is what makes the
>    number trustworthy). That is the signature of replacing a step function with its continuous form: the
>    deviation is bounded by half a band step, and the analytic bound for the coarsest ramp on a lit cap
>    (`CAP_EDGE_*`, 5 steps at alpha 0.5) is 13-17/255 — two independent methods agreeing.
>    It is also **visibly better**, which is the point the band counts were already being pushed toward.
>    At a 6x crop the west chamfer's 5 steps are countable as vertical stripes in the old form and gone in
>    the new one; `SIDE_STEPS`' own doc had recorded the same defect ("five hard horizontal stripes") for
>    the coping correction. The per-surface band counts are therefore deleted, not retuned — `RAMP_TEXELS`
>    puts the worst step below 1/255 for every profile at once. `wallTone.ts` keeps the *reasoning* as a
>    comment, since it is the reasoning a future ramp needs.
> 2. **Rig sphere shading: 20 draw calls and 20 program switches -> 3 and 2, and it stops scaling with the
>    enemy count.** `rigShading.drawSphereShading` was 40 chord bands plus 3 ellipses per rig instance —
>    55 fills, 710 floats, one draw call and two program switches per actor on screen, at 8 live enemies
>    where a level-1 room holds 15-30. It is now one quad sampling `sphereShadeField()`, a 256x256 field
>    **normalised by radius**, so it is one bake for the whole game rather than one per (skin, radius) —
>    no renderer needed, and it works in a test. It is still a `Graphics` and not a `Sprite` because
>    `RigSkin` counter-flips it with `scale.x = flipX`, which mirrors a quad's local geometry but would
>    throw away a Sprite's size.
>    The frame diff here is larger and the reason is a **defect in the form it replaced**, found by
>    looking at where the deltas were: every pixel differing by more than 20/255 sat at 0.8-1.0 of the
>    body radius and at one of the two poles of the light axis (537 lit, 474 dark, 38 elsewhere). A chord
>    band took its half-width from whichever edge was *further* from the centre — provably inside the
>    circle, and increasingly conservative toward a pole, where the chord shrinks fastest. The two
>    outermost bands of 40 had a half-width of **exactly zero**: 3.6% of every body circle, in two
>    crescents at the poles, was never painted. That is where the warm wash peaks and where the
>    reflected-light sliver traces the silhouette — the two marks whose whole job is the rim.
>    `rigShading.test.ts` now pins that the shading reaches the rim at both poles.
>
> **Two flaws the tests caught in the new code**, both worth recording because neither is visible by
> inspection: a zero-length ramp segment makes `rampFill`'s matrix singular, and Pixi *inverts*
> `style.matrix` at geometry-build time, so it would have filled with non-finite values and taken every
> other fill in that Graphics down with it (reachable from any cue whose surface collapses); and the
> silhouette feather was originally applied on top of a masked `sphereShadeAt`, which cut the antialias
> off at its own midpoint and made the containment test pass for the wrong reason — there was nothing
> outside the circle left to contain. A 35-mutant battery over both files' constants and ramp directions
> ends at **35 killed, 0 survived**; the first run had 6 survivors, of which 3 were reversible ramp
> directions in the wall shading (a one-character edit that leaves fill count, colours, alphas and covered
> rect all identical) and are now asserted.
>
> **The batching claim is an invariant over shipped content, not a number in this note.**
> `wallComposition.test.ts` runs every wall of all five shipped level-1 floors — **173 blocks** — through
> the real `GraphicsContextSystem` and requires each to come back batchable; the worst is **120 floats
> over 15 fills** (p50 112), against 520-2010 before. Two things that took a second attempt to gate
> properly. A float *budget* does not hold the rule: reverting one cue to five stepped rects costs +32
> floats and survived a headroom bound loose enough to allow a future cue, so the rule is asserted
> structurally instead — every fill in a block's shading is a ramp fill (texture + matrix), and the only
> non-fill is the cap/face fold, which is genuinely one hard line. And texture SHARING had no guard at
> all: batchable blocks only land in one batch if they sample the same few textures, so a profile that
> varied with geometry would split the batch with every other assertion green. Pinned at 3 shared
> profiles across every wall in the game.
>
> One more gap the mechanism change opened without any test noticing: `RigSkin`'s counter-flip was
> asserted as `view.scale.x * shade.scale.x === 1`, which was sufficient while the marks WERE the
> geometry. With the marks in a texture, a cancelled transform no longer implies a cancelled look — the
> field mirrors with the quad only because it is sampled in local space, and mirrors *in place* only
> because the quad is centred. Now asserted end to end (same world rect whichever way the body faces),
> and confirmed by a mutant that de-centres the quad.
>
> (Measured before and after at one fixed point — room built, nothing fired, 27 wall runs and 9 actors,
> 52 children on `entities` both times, `git stash` between the two reads. The per-group deltas below are
> identical in every reading taken this session; only the frame TOTAL moves with how many doors and
> pickups are on screen, which is why the note above records 108 for the same scenario.)
>
> **What is left, and it is no longer wall shading.** 27 draws / 17 programs, with 9 unbatched Graphics:
> a door's recess/glow/sill (2010 and 1434 floats, 10 fills each — stroke-heavy, not banded, so the ramp
> treatment does not apply), the player's tether Graphics (912 floats), and four 496-float objects — which
> were the four PILLAR CREASES in that room, converted 2026-08-26 (see below); on a PvE floor there are
> four of them and on the PvP arena there are 124. None
> of it costs frame time today (render p50 ~2.1ms of a 16.7ms budget); it is headroom for a low-end mobile
> GPU where a program switch is far more expensive than it is here.
>
> **One divergence created on purpose**: `pillarRender` still steps its own copy of the base contact
> crease at `BASE_AO_BANDS` = 12, while the wall's samples a ramp. The two agree to within one band step
> (0.3/12 = 0.025 alpha, which `FACE_COPING_BANDS`' doc calls borderline rather than safe), and converting
> it is not a one-liner — that crease is a `roundRect` whose last band also skirts `PILLAR_BASE_PX` below
> the floor line at a held alpha, so it is two shapes under a ramp, not one. Pillars were not costing a
> draw call, so it is recorded rather than rushed.
>
> **Closed 2026-08-26, and the premise it was parked on was the thing that was wrong.** "Pillars were
> not costing a draw call" was measured on a level-1 PvE floor, which has a handful of them. The PvP
> launch arena has **124**, and they were **245 of that frame's 278 draw calls** — the single most
> expensive object class in the map, while its 294 wall blocks cost 2. Everything else in the note held
> exactly: it is two shapes under a ramp, not one, and for the reason predicted. `rampFill` only
> guarantees no wrapping while the filled shape is a SUBSET of its own ramp segment, so one `roundRect`
> over the whole crease under a ramp anchored at the ground line would sample past the last texel and
> `repeat`-wrap to alpha 0 — a crease that fades out exactly at the foot. Shipped as a plain rect under
> the wall's own `linearRamp()` plus a held `roundRect` skirt, which also keeps the TEXTURE shared with
> every wall face (the alternative, a rises-then-holds baked field, is one fill but keys a bake per
> distinct pillar height and shares nothing). Measured on one commit, same scene, swapping one file:
> **262 draws / 254 programs → 14 / 6**, unbatched `Graphics` in the scene **124 → 0**, the crease
> itself **496 floats / 12 fills → 78 / 2**. `BASE_AO_BANDS` is gone; nothing in this renderer
> hand-steps a gradient any more.
>
> The look is unchanged, and that is provable rather than eyeballed: a stepped ramp fills band *i* at
> its CENTRE value, so a linear ramp over the same span passes exactly through every band's value at
> that band's midpoint and can differ only inside a band — **worst case half a step, 0.01279 alpha
> (3.26/255)**, pinned in `pillarRender.test.ts` along with the skirt's matching half-step. Worth
> stating because no frame diff was obtainable: every canvas reader tried failed its own control (see
> the measurement note below, which now has three more entries).
>
> **Measurement note, since it cost two rounds.** `gl.readPixels` on this canvas returns a stale frame:
> the context is created with `antialias: true` and `preserveDrawingBuffer: false`, so the resolved
> default framebuffer only updates when the page composites — which never happens in a hidden tab, so a
> deliberate "hide everything and re-read" check reported *zero* difference. `renderer.extract.pixels`
> works but has its own trap: the scene's light and post filters are screen-space, so extracting a custom
> frame lights only the region matching the real on-screen position and 25 of 27 wall blocks come back
> pure black (mean luma 0), i.e. a dark overlay on them is a genuine no-op. What is reliable is
> `renderer.render(stage)` followed immediately by `drawImage(app.canvas, …)` into a 2-D canvas, in the
> same task — and then verifying the harness by restoring the original form and requiring the third read
> to match the first exactly. Every number above comes from that, with the restore check at 0.
>
> **Amended 2026-08-26: "in the same task" is exactly what does NOT work, and it fails silently.** The
> pillar-crease pass could not obtain a frame diff at all, and each attempt looked like a different bug:
>
> 1. `render()` + `drawImage(app.canvas)` three times inside ONE evaluation returns the SAME stale
>    composite for all three. The resolved framebuffer updates on a page COMPOSITE, and a synchronous
>    task never yields to the compositor — so the technique above is only sound when its three reads are
>    in three separate tasks. Symptom: blanking the entire world layer "changed" 0 pixels, while a
>    signature stored in a previous evaluation differed by 99%.
> 2. `perf/frameProbe.ts`'s `probeFrames` inherits that: it reported `trustworthy: true` with a real
>    4.6% diff once, then `trustworthy: false` on the next attempt purely because the camera had been
>    pinned in the same evaluation as the probe.
> 3. `extract.pixels({target, frame})` needs a genuine Pixi `Rectangle` (it calls `frame.copyTo`; a
>    plain object throws), and the `frame` is not screen space — a hand-computed screen rect returned
>    **one distinct luma value** across 34,000 samples.
>
> Two rules came out of it. **Carry your own control aimed at the same subtree**, not just the
> harness's: `probeFrames`' built-in control blanks the stage and passed while hiding 124 pillar sprites
> moved 0 pixels, and that mismatch is what exposed ②. And when the quantity is one-dimensional — a
> ramp, an alpha profile — **answer it analytically from the shipped code instead**: sample the ramp
> texture with `rampProfile` and compare it against the formula it replaced. That is what pinned the
> crease conversion at half a band step (0.01279 alpha) when no reader would produce a frame.
>
> Also worth knowing when the subject is a wall or pillar: the occlusion x-ray **fades your subject**.
> A first probe honestly read 0 because every pillar at that camera was faded, and a faded pillar's
> crease contributes nothing. A block only fades when its `sortY` is south of the player, so stand
> NORTH of the cluster to get unfaded subjects on screen.

> **Steady load (2026-09-28): the render group stops rebuilding what did not change.** The work is
> [volume 107](../roadmap/107-2026-09-28-frame-pacing.md). Under a 4x CPU throttle, standing in for a
> phone, a quiet walk cost 17.1 ms of work per frame at p50 and 36–54 frames a second. Most of that was
> not drawing: a render group was re-collecting and re-batching its instructions without needing to.
> Five structural rules came out of it, each with a test:
>
> 1. **The Y-sort key never goes through the `zIndex` setter** — see "Depth sorting" above.
> 2. **A Graphics redrawn every frame is `no-batch`, and hidden while empty**
>    (`render/staticGraphics.ts` `redrawnGraphics`). This only pays because of
>    `render/graphicsPipeFix.ts`. Pixi 8.19's `GraphicsPipe.validateRenderable` tests
>    `!!graphics._gpuData`, a map the constructor always creates, so it asks for a rebuild on every
>    change to ANY Graphics. The patch reads this renderer's batch elements instead. Its test pins the
>    bug, so a Pixi upgrade that fixes it goes red and the patch can go.
> 3. **Churning layers get their own groups too**: `entities`, `fx` and `numbers`, alongside the
>    static ones above. The point is the reverse of the static case: a particle rebuilds a group of
>    particles, not the walls. None of the three ever batched with the others, because each sits under
>    a different filter or none.
> 4. **Every full-screen pass has a `filterArea`.** Without one, Pixi measures the pass region as the
>    container's bounds, a walk over every descendant on every frame. A pass at rest leaves the chain
>    (`filter.enabled = false`), because a zero-strength filter still costs a full render-target pass.
> 5. **Standing pieces are culled with the ground** (`groundCulling.tagStandingPiece`, with a 96 px
>    margin for the door rings drawn after the build). Actors, bullets and pickups are never tagged, so
>    they are never culled.
>
> Result: 59–61 frames every second at 4x over 60 s with a descend, work p50 about 6 ms; unthrottled
> work p50 went from 2.5 to 1.5 ms. `game/controllers/steadyFrame.test.ts` holds rules 1–3 across the
> real `GameLoop`: a rebuild must have a tree change behind it, and a tree change must get a rebuild.
> Rule 5 is held by `client/tools/perf/cullAB.mjs`, a live pixel A/B, since it saves draws rather
> than rebuilds.

---

## Per-weapon local z-order

A weapon is attached to one of the character's orbiting weapon sockets (`02`/`13`) and rendered separately, and must switch front/back by facing:

- Aiming up (dy < 0): weapon renders **behind** the body.
- Aiming down / sideways: weapon renders **in front**.
- The actor container itself has `sortableChildren = true`, with body.zIndex = 0.

Keyed off the AIM since 2026-09-02, not the body's own facing: the module orbits to the aim
now (see the bullet section above), so where it actually *is* decides which side of the core
it is on. The two agree once the body has finished turning — the turn is rate-limited
(`facing.BODY_TURN_PER_TICK`, ~0.4 s for an about-face) and during it the gun has already
swung behind the core while the body has not, which the old rule drew across its face.

Otherwise you get the "gun floating on the chest while facing away" artifact.

> **Implemented 2026-08-18** — this rule was written here when the doc was, but the rig
> renderer never honoured it: `RigSkin.mountModule` pinned the module to `socket zOrder + 1`
> (always in front), and set it once at sprite-creation time rather than per frame, so even
> a correct initial value would not have survived the player turning around. Now recomputed
> every frame from `showBack`: `MODULE_Z_BEHIND` (-2, below every bone binding **and** below
> the tether's own -1) when facing away, `socket zOrder + 1` otherwise.

---

## Limits of fake 3D (honest note)

2D sorting is per-object, not per-pixel. The following cases break and must be avoided or accepted as approximations:

- One large sprite partially in front of and partially behind a tall object (crossing a thick pillar) → judged wholly front or back, artifact at the seam. Mitigation: split tall objects into segments, tune anchors carefully.
- A character standing in the band a standing block's art intrudes over (one wall height north of its footprint) is judged wholly BEHIND it, and a 70 px block is taller than the 32 px body — so "partly hidden" is not available and the player simply disappeared. **Reported live 2026-08-20 and now mitigated by the occlusion x-ray above**, which is a stylisation, not a fix to the sort: the case itself is still a limit of the projection.
- **An east/west side has no projection at all.** `screen.y = gy - z` has no horizontal component, so a
  block's east and west faces are exactly zero px wide and its art simply stops at the footprint's edge.
  Harmless where a neighbour's floor or stone carries on; a cliff where the next thing along is the void.
  Mitigated 2026-08-27 by the void return (above), which is an invention rather than a projection — the
  limit itself does not go away, and anything else that wants to show an east-west drop has the same
  problem.
- Complex multi-layer occlusion → sorting rules must be refined.
- Continuous slopes / height transitions → approximation only.

For this game's scale (rooms, pillars, crates, enemies) these are largely avoidable. If true continuous 3D occlusion is needed → fall back to a Three.js orthographic camera (see the re-evaluation trigger in 00, Decision 1).

---

## Ambient animation rates (idle loops have a Nyquist floor)

Every idle loop in this layer is a sine driven by an accumulated `frameDt` clock in
**milliseconds** — `t += frameDt`, then `sin(t * k)`. The rate constant `k` is therefore in
**rad/ms**, and the frequency it produces is `k * 1000 / 2π` Hz. Getting this wrong by a
decimal place does not look like "a bit fast": once the per-frame phase step `k * 16.7`
approaches π, the loop crosses the display's Nyquist limit and **aliases**, so what renders
is a beat frequency between the animation and the refresh rate — jitter whose apparent speed
changes with the player's monitor, not the motion that was authored.

Keep every ambient loop in the band the scene already uses. Current inhabitants:

| Loop | Rate (rad/ms) | Frequency | Phase per 60fps frame |
|---|---|---|---|
| `Portal` alpha pulse | 0.003 | 0.48 Hz | 0.05 rad |
| `Pickup` hover + glow breathe | `2π/2000` | 0.50 Hz | 0.052 rad |
| `Actor` status aura | 0.008 | 1.27 Hz | 0.13 rad |
| `doorFx` locked flame pair | `2π/1700`, `2π/2750` | 0.59 / 0.36 Hz | 0.062 / 0.038 rad |
| `doorFx` locked scan + breathe | `2π/1400`, `2π/1750` | 0.71 / 0.57 Hz | 0.075 / 0.060 rad |
| `doorFx` open streams | `2π/2600`, `2π/4200` | 0.38 / 0.24 Hz | 0.040 / 0.025 rad |
| `doorFx` open breathe, motes, floor pulse | `2π/2400`, `2π/2800`, `2π/2400` | 0.42 / 0.36 / 0.42 Hz | 0.044 / 0.037 / 0.044 rad |
| *(Nyquist limit at 60fps)* | 0.188 | 30 Hz | π |

**This table is a GATE since 2026-09-03b, not just a record — for the door rows.** Every period in
`scene/doorFx.ts`/`scene/doorMotion.ts` lives in one exported `PERIODS_MS` object that the code
itself aliases, and `doorMotion.test.ts` walks it: each entry must advance by well under the
Nyquist limit in one 60 fps frame and sit inside the 0.2-1.3 Hz band the rows above occupy. The
older three rows are still prose. A new loop that hand-rolls its own period is not in the table the
test reads, which is the point of aliasing rather than duplicating the numbers.

`Pickup`'s hover shipped at `0.12` (19.1 Hz, 2.0 rad/frame) and reached a player as "the
items on the ground flicker far too fast" — it had never been a bob at all. Two rules came
out of it:

- **Prefer a period constant to a rate constant.** `BOB_PERIOD_MS = 2000` with the rate
  derived from it states the intent in a unit a human can sanity-check; a bare `0.12` does
  not, which is how it survived review.
- **Give co-located instances different start phases.** Every pickup started at phase 0 and
  advanced identically, so a whole floor of loot rose and fell in unison and read as one
  synchronised flash rather than many objects. `Pickup` now offsets its start phase by the
  golden angle times its engine entity id — deterministic (no `Math.random`, per `06`), so
  two clients still draw the same drop identically.

Note that a bob is visible on more surfaces than the sprite: `z` also drives the shadow's
scale/alpha (see Shadows above), so a strobing height strobes the shadow too. `zIndex` is
the exception and must stay on **ground y** — routing it through screen y would make a
hovering object flicker in and out of the Y-sort against everything near it.

---

## Text measurement (Pixi's measure canvas is NOT its paint canvas)

Every piece of UI text in this project is a Pixi `Text` on a `fontFamily: 'monospace'`
style. Two independent canvases are involved in drawing one, and **they can resolve the
same font string to different fonts**:

- **Measuring** — `CanvasTextMetrics._canvas` prefers `new OffscreenCanvas(0, 0)` whenever
  the host has one, falling back to `DOMAdapter.get().createCanvas()` only if it doesn't.
- **Painting** — `CanvasTextGenerator` goes through `CanvasPool`, which always uses
  `DOMAdapter.get().createCanvas()` (a real `document.createElement('canvas')` in a browser).

Chrome does not resolve the CSS generic families (`monospace`, `sans-serif`, `serif`, …)
identically in those two contexts — an `OffscreenCanvas` has no document/CSS context to
read the user's configured fixed-width font from, so it falls back to a different family.
Measured on Windows Chrome 2026-08-15 with `bold 15px monospace`:

| string | DOM canvas (painted) | OffscreenCanvas (measured) |
| --- | --- | --- |
| `AAAAA` (Latin) | 41.2px | 45px |
| `ААААА` (Cyrillic) | 41.2px | 85px |

Both canvases are internally consistent (each *paints* what it *measures*, confirmed by
scanning `getImageData` alpha for the first and last non-empty column) — the defect is
purely that Pixi mixes the two. The visible result is a `Text` whose `width` is up to ~2x
its painted width: `anchor.set(0.5)` then centres the oversized measurement and the glyphs
land far left of where they belong. That is what produced the reported "Russian settings
labels sit outside their buttons" bug (`17-i18n.md`), and it silently affects anything else
sized or wrapped from Pixi's metrics.

**Fix:** `render/textMetrics.ts`'s `pinTextMeasurementToPaintCanvas()` overwrites the
statics Pixi memoises its measurement canvas into (`CanvasTextMetrics.__canvas` /
`__context`) with a `DOMAdapter`-created canvas, using Pixi's own `willReadFrequently`
context setting, and clears any font metrics already cached from the offscreen one. Going
through `DOMAdapter` rather than `document` directly is what keeps it correct on WeChat,
where the adapter is weapp-adapter's. Both entries (`main.ts`, `main.wechat.ts`) call it
before anything else, because the canvas is memoised on first use.

`ui/textWidth.ts`'s `estimateMonoWidth` is unaffected and still the right tool for *sizing*
a backing box (it needs no canvas at all, so it works under vitest); this is only about the
measurement Pixi does internally when it lays out and centres the glyphs themselves.

Covered by `render/textMetrics.test.ts`. Node has neither canvas kind, so the test fakes
both — with the real advances from the table above, so an unpinned Pixi picks the
"offscreen" fake exactly as it does in a browser and "pinned vs. not" is a real difference
rather than two names for the same stub. A side effect worth knowing: with a context pinned
this way, `Text.width` becomes computable under vitest at all, which is what lets those
tests assert on label-inside-box geometry that otherwise needs a browser.

**General lesson:** when text is *mis-centred* rather than merely mis-sized, and only in
one script, compare Pixi's measurement canvas against its paint canvas before suspecting
the app's own layout maths.
