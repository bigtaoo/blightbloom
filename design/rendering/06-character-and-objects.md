# The character and the objects on the floor

The things standing on the ground rather than the ground itself.

One part of the rendering architecture doc. The index, the fidelity roadmap and the quality
tiers live in [../01-rendering.md](../01-rendering.md).

## Grounding the character (2026-08-18)

Same pass, same report (*"希望能再强化一下立体效果"*): the character had just gained a 360°
facing continuum, but nothing said it was a **volume standing in a space**.

- **Actors hover, and the shadow knows.** The rigs' `idle` clips already bobbed the art
  (orb-core's bones translate -6 authoring px), but a clip only knows about bones, so the
  shadow stayed exactly as wide and as dark as when the body was on the floor — which reads
  as a sprite sliding up and down a flat backdrop, not as a body leaving the ground.
  `Entity.visualZ` lifts the whole entity instead (render-only; `zIndex` still comes from the
  ground coordinate, so lifting can never reorder anything). `Actor`'s `HOVER` table gives
  the hero and the floating enemy forms a small constant lift plus a slow swing and leaves
  design/13's ground critters alone; phase is spread across actors so a room of floaters
  doesn't pulse in lockstep. The clip and the hover stack deliberately — one animates the
  body's parts, the other the body's height.
- **Shadows displace with height.** `shadow.x/y += lift × SHADOW_SLANT_*` — a body at head
  height does not cast straight down. This is the half of the cue a clip could never produce,
  and it is shared by actors, bullets, pillars (which need it supplied by hand: a pillar is
  drawn upward from a grounded origin, so its `z` is 0) and walls.
- **Shadows are a penumbra, not a disc.** Twelve faint nested ellipses stepping from 1.15× to
  0.3× the body radius, so total darkness ramps smoothly to a definite contact core. Four rings at
  graduated alphas — the first attempt — showed four visible concentric edges at 7× and read as a
  targeting reticle. *Retuned 2026-08-19: it was nine rings from 1.45× at ONE flat alpha, which
  makes the outermost ring itself a visible hard rim — most of what made an enemy's shadow read as
  a black plate it was sitting in. The alpha now ramps (squared) across the rings, so the edge is
  nearly transparent while the core still composites to ~0.45. The other half of that fix was its
  SIZE — see "Volume, measured".*
- **Everything round that lies ON THE GROUND PLANE shares one 0.62 foreshortening**
  (`SHADOW_SQUASH`): the ground shadow and the status auras. Both are flat discs at the
  actor's feet, and the camera tilt compresses a disc — drawing one as a perfect
  screen-space circle is the loudest "this is a decal pasted on" cue a round overlay can
  give in a tilted view.
- **The shield is the deliberate exception, and is a true circle** (2026-08-24, user report
  *"护盾成了一个圆圈"*). It was squashed with the other two for six days on the reasoning that
  "everything round wrapping a body foreshortens the same way"; that is wrong for this one.
  A shield is a SPHERE around the body, not a disc under it, and a sphere's silhouette is a
  circle from every angle. Squashed, it read on screen as a flat hoop threaded through the
  character at gun height — the reported 圆圈 — instead of a bubble enclosing it.
- **2026-08-25: it became a SOLID shell, not a rim band** — superseded 2026-08-26 by the bullet
  below, which found that the "Fresnel limb" this pass shipped is itself a ring by another name.
  Kept because the report it answers is real and the hole it closed has not reopened
  (user report: *"现在的护盾是
  一个圆圈包裹着角色, 我希望的是类似一个透明的蛋壳一样的效果将角色全部包裹, 而不是一个圆环"*).
  Un-squashing it fixed the ellipse but left the other half of "圆圈" standing: the shader drew
  `smoothstep(a, b, dist) * (1.0 - smoothstep(b, c, dist))`, a band with a HOLE in it, so a
  shielded character stood in empty space with a hoop around it. It is now a glass sphere —
  a filled interior plus a Fresnel limb (`1 - nz` off a sphere normal, cubed) and one specular
  glint at ~0.6 of the radius, which is the pair of cues that read as "curved and transparent"
  rather than "decal". Three numbers carry the look, and each is pinned twice — as a source
  contract (`filters.test.ts`, "is a solid shell, not a ring") and as a MEASUREMENT
  (`shieldShellModel.test.ts`, which interprets the shipped GLSL and asserts the profile it
  paints: centre painted, no hole out to the surface, circular at every angle, gone past the
  fade). Text was the wrong evidence for a question about a shape — two shaders can satisfy
  every regex and paint different things — and running it found two real facts the source
  reading had missed: the composite is not quite monotonic (the shimmer bands radially, so a
  ray outward ripples by ~0.03% of peak), and an alpha bound read at `uTime = 0` is a lucky
  sample that a doubled composite knob walks straight through:
  - **No term may rise with `dist`.** That is the whole definition of a ring; every
    `smoothstep` over `dist` in this shader is a negated (falling) one.
  - **The fill is damped by the body's own alpha** (`FILL * (1.0 - 0.55 * color.a)`). Over the
    floor it is the bubble you look through; over the character it is an additive wash on top
    of the art, and undamped it flattened the hero's face — the saturated blue eye came out the
    same pale cyan as the shell around it. Measured live, on screen, at both settings.
  - **The radius grew 1.55 → 1.87 body radii**, because "全部包裹" includes the mounted weapon:
    at the smaller radius the gun barrels stuck out through the shell. It still stops short of
    the feet, where the ground shadow has to stay readable (below). The interior composites at
    ~8% alpha over the floor, so it tints rather than hides it — the failure mode the
    2026-08-19 volume pass fixed by shrinking the old ring.
- **...and since 2026-08-26 it is a shell with THICKNESS, with the character between its two
  halves** (user report: *"没有被蛋壳包裹的感觉 … 边缘的那个圈太过实线了"*). The 2026-08-25 pass
  above had filled the ring's hole and stopped there, and the report that followed named both
  halves of what was still wrong. Neither was a tuning problem:
  - **`pow(1 - nz, 3)` is a ring, whatever the surrounding code calls it.** It equals 1 only AT
    the silhouette, so every version through 2026-08-25 was a flat `FILL` plate with all of its
    energy in a hairline around the edge. Measured on the shipped frame: the profile's maximum sat
    at `b = 1.00` and held above half-peak across **0.10** of the radius. What replaced it is the
    length of the view ray's chord through a shell of real thickness — an outer sphere minus an
    inner one, saturated Beer-Lambert style. That profile peaks at the INNER wall
    (`b = 1 - THICKNESS`, 0.78) and falls away on both sides: measured peak `b = 0.80`, half-peak
    width **0.30**. Same measurement from two independent directions — the GLSL interpreter
    predicts 0.78 / 0.31, and a luma cut read off a real GPU frame says 0.80 / 0.30.
  - **"包裹" is not a shape at all, it is a compositing order.** Every version up to here added
    the whole shell ON TOP of the character, so it read as a decal in front of it however the
    silhouette was tuned — nothing was ever behind. The fix is one multiplication: the back
    hemisphere's contribution is scaled by `(1.0 - color.a)`, so the body occludes it and sits
    between the two halves. This is the single change that produces the enclosure cue; the
    thickness above is what stops the enclosure reading as a hoop.
  - **Refraction, for the price of a UV offset.** The filter already samples the character's own
    texture, so bending the sample point by the sphere normal shows the body THROUGH the glass —
    magnified face-on, smeared toward the limb. Faded with the pool along with everything else
    (found by test, 2026-08-26: left at full strength the character stayed warped while the glow
    drained and then un-warped in a single frame when `ActorFilters` detached the filter, a pop
    landing exactly on the break burst), and bounded to a fraction of a body radius — the
    "grows toward the limb" assertion is a ratio and therefore scale-free, so a displacement ten
    times too strong satisfied it.
  - **A generated membrane, not authored art.** A smooth gradient reads as a filter no matter how
    well shaped; the eye needs a repeating detail element before it accepts a surface. The tile is
    a seamless HEX-CELL field computed at boot (`fx/filters/shieldScales.ts`) — see that
    file's header for why a generator beats an image model here, and `design/04` for the package
    budget it costs nothing against. Sampled twice with different projections, front and back, so
    the two layers do not coincide; the projection is `uv / (nz + k)` rather than true spherical
    coordinates, which foreshortens the pattern toward the limb for one divide instead of four
    transcendentals and a pole singularity.
  - **The membrane ADDS, it does not multiply — and it is drawn on the character's art as well as
    in the light over it** (2026-08-27, report: *"护盾中间的6边形看不清，看起来还是一个圈 … 之前调试
    效果时看起来挺好的，和游戏里实际表现差别有点大"*). Two separate defects, and the pair is the
    general lesson for any per-actor overlay here:
    - The pattern was `density * (1 + k * tile)`, a MULTIPLIER on the shell. The shell's interior
      brightness is deliberately ~0.11 (it composites over `Entity`'s ground shadow and must not
      hide it), so across the whole middle of the disc there was nothing for a multiplier to
      scale: measured on a rendered frame at gameplay zoom, 9 of 255, with the pattern reaching
      ~30 only in a thin annulus at `b ~ 0.8`. A pattern in one ring with nothing inside it is a
      circle. Adding instead decouples the pattern's contrast from the shell's own faintness, and
      the tile's ZERO-MEAN encoding (`paintScaleTile`) makes it free on the brightness budget the
      multiplicative form was protecting — the lines are bright because the cells around them
      gave it up. Verified on the live frame, not argued: mean luma over the shell disc is 83.0
      with the membrane and 83.2 without.
    - Every other term this shader has is additive, and the middle of a shielded actor is not
      empty — it is the hero's near-white silver body, over which the shell's own green and blue
      are already past 255. An additive membrane there is not dim, it is arithmetically ABSENT,
      whatever its gain. **That is the whole of the "looked right in isolation, wrong in the
      game" gap**: the debug view had a dark background where the game has a bright character. So
      the pattern also rides the `veil` MIX toward the shield colour, which has no ceiling; a
      cell border reads as a cyan hex line laid over the character at any base brightness.
  - **Taller than wide, not a true circle** (2026-08-27, report: *"现在的盾是正圆的，改成椭圆或许更
    好，高度上长一点，看起来会更有立体感"*). The 2026-08-24 pass un-squashed this shell to a circle on
    the grounds that *"a sphere reads as a circle from every angle"*. True of a real camera, and
    this renderer is not one: the world grid is drawn UNSQUASHED (`layers.world.scale` is 2.667 in
    both axes) while wall heights are extruded 1:1 upward in px (`wallGeometry.ts`'s `WALL_H_*`
    are "in world px"), which together is the shear `(x, y, z) -> (x, y - z)`. A sphere's
    silhouette under a shear is an ellipse with semi-axes 1 and `sqrt(2)`, so a circle was never
    the projection-consistent shape for "a sphere around the body".
    - Shipped at **1.30**, not the derived 1.414, chosen on rendered frames: past ~1.35 the shell
      reads as a pod the character is suspended in rather than a shell wrapped round it, and the
      hero's drawn silhouette is 74.7 x 32 px — **2.3x wider than tall** — so every unit of extra
      height is empty egg.
    - The stronger reason to go taller at all is this scene's own grammar rather than the shear:
      everything round that lies on the ground is squashed to 0.62 (`Entity.SHADOW_SQUASH` —
      shadows, status auras), which makes a circle the ambiguous middle and a taller-than-wide
      silhouette the only one in the scene that cannot be read as lying flat.
    - **Nothing in the GLSL says "ellipse".** The shader is isotropic in region-normalized `uv`,
      so the shape comes entirely from `Actor` sizing `filterArea` to a rect of aspect
      `SHELL_ASPECT` — every constant the measured suite pins (`SHELL_R`, `THICKNESS`, `CULL`) is
      in that normalized space and unchanged, which is why the ellipse cost one line. The flip
      side is that a square `filterArea` silently reverts the circle with no other symptom, so
      both `Actor.test.ts` and `shieldShellModel.test.ts` pin the composition (mutation-checked:
      a square rect fails 1, `SHELL_ASPECT = 1.0` fails 2).
    - The ONE place the shader must know the aspect is the membrane: a hex cell inherits the
      region's stretch like everything else, and a hexagon stretched 1.3x vertically stops
      reading as one — which would have spent the same day's hexagon fix to buy this one. The
      tile lookup divides it back out; a third test pins that.
    - Cost: the region's aspect change alone would be +30% area, shared by all four per-actor
      filters. The clearance pass below more than pays it back — the region ends up 78.7 x 102.3
      against the original 96 x 96 square, i.e. **13% SMALLER** than before either change.
  - **Sized by a stated CLEARANCE, not by a hand-set region** (2026-08-27, report: *"整体缩小一点，
    类似紧贴着角色，稍微留点缝隙即可。缝隙的大小我感觉和图里枪的直径差不多即可"*). The surface now sits
    `SHELL_CLEARANCE` = 0.53 body radii outside the body's drawn edge, down from 0.87 — a shell of
    1.53 body radii rather than 1.87. `Actor` no longer hand-sets `filterArea` to `radiusPx * 3`;
    it inverts the shader's own geometry to solve for the region that puts the surface there, so
    retuning `SHELL_SURFACE` or `SHELL_ASPECT` keeps the clearance meaning what it says.
    - **0.53 is that gun, measured.** The hero's weapon SPRITE is 24 x 16.35 world px, but the art
      inside it is mostly transparent margin: the opaque box is 15.75 x 8.55, so the visible gun is
      8.55 px thick — against a 16 px body radius, 0.53. Taking the sprite rect would have set the
      clearance at 1.02 body radii and left the shell almost exactly where it already was. This is
      the same class of trap as the `BODY_FILL` mismatch: an art number read off the frame rect
      instead of off the pixels.
    - The clearance is uniform on ONE axis only, and no constant fixes that: the body is round
      (32 x 32 world px) while the shell is a 1.30 ellipse, so 8.5 px at the sides is necessarily
      ~15.8 above and below. It is set on the SIDES — the tight axis, where "稍微留点缝隙" is a
      clearance that must not close up. Trading the two off means lowering `SHELL_ASPECT`.
    - The character's WEAPONS reach outside the shell (~2.5 body radii against a 1.53 surface),
      and did before this too. The claim that the envelope "encloses the WHOLE character, mounted
      weapon included" was in both this doc and two tests and has never been true at any of the
      shell's sizes; enclosing them needs a surface ~3 body radii out, i.e. twice this shell.
    - Two tests were PASSING on a stale literal here — both computed the shell's size as
      `SHELL_R * 6 / sqrt(2)`, the old `radiusPx * 3` region copied in as a `6`, and so reported
      1.87 body radii for a shell that had become 1.53. Both derive the region width now.
    - Anything that resizes the shell has to revisit `MEMBRANE_TILE`: it is in normalized units,
      so the cell COUNT across the shell is fixed and a smaller shell means smaller cells. This
      pass took 20 px cells to 16 and a 4 px border line to 3.3; scaling the tile by the same 0.82
      (0.80 -> 0.66) put both back.
    - Cell SIZE has one honest constraint worth writing down: `uv` goes to zero at the shell's
      pole, so however the tile is projected the middle of the shell gets the fewest cells — and
      the middle is where the character is and where the eye already is. No projection fixes that
      (spherical UVs are linear at the pole too); the only lever is overall density.
  - **The damage state changes the SHAPE.** `design/13`'s dual-channel law, which this filter had
    been violating: as the pool drains, whole scales go out one at a time (the tile's green channel
    is that cell's place in a shuffled extinction order) and the tint shifts from cyan toward a hot
    pale tone. Brightness alone was the entire damage signal before.
  - **The interior still stays under the ground shadow.** `Entity`'s `SHADOW_ALPHA_INNER` is 0.1,
    and a shell interior compositing above about that much stops the actor reading as planted. The
    2026-08-26 rewrite paints the back hemisphere over the floor as well as the front — i.e. more
    light there for the same shape — and holds the same bound anyway, via a contrast curve on the
    chord (`pow(…, 1.6)`, which pulls the interior down harder than the wall) rather than by
    relaxing the bound to fit what the new shader happened to produce.
  - **A hit now dents it.** Until 2026-08-26 the shield had exactly one dynamic — `uIntensity`
    tracking the pool — and did nothing at all when the actor was hit; `ActorFilters.hitFlash`
    drove only the white `OutlineFilter`. The envelope is a damped OSCILLATION (`exp` decay times
    `cos`), so the surface springs back past its rest radius and settles: a fade reads as "the
    glow dimmed", a rebound reads as "something hit it". This is what 20-year-old sprite shields
    did with hand-drawn squash frames, and it is the cheapest item on this list. `EventReactor`'s
    `hit` case already carried the impact position, so the direction cost nothing new to plumb —
    it is handed over as a delta from the target's own centre.
  - **The one lever that pays is the radial cull.** The shell reaches 0.62 of the filtered
    square's half-width, so ~70% of its pixels used to run the whole shader to produce zero. A
    single `if (b > CULL) { … return; }` skips them — CULL is set where the only term still alive
    out there has fallen below one 8-bit step, and `shieldShellModel.test.ts` measures that rather
    than trusting it. Measured on an Intel Arc Pro over a 768 px region: **0.223 ms with the cull,
    0.321 ms without**, against **0.162 ms** for the shader this replaced. So the rewrite is +38%
    for roughly three times the visual information, and without the cull it would have been +100%.
    The membrane's own uniform branch (`uMembrane`, the lever for a cheaper tier) measures as no
    saving at all on desktop — that region is fill-bound and two cached tile fetches are not what
    it spends its time on. It stays because it is correct and free, and because a bandwidth-bound
    mobile GPU is where those fetches would show up; that case is unmeasured (`design/04` item 6)
    and nothing here should be read as a promise about it.
- **...and since 2026-08-26 it has an EXIT** (`EnergyShieldFilter.shatter`, the one item the
  thickness rewrite above left open — and the change that moved this filter out of `skinFx.ts`
  into its own `fx/filters/shieldFx.ts`, since it took that file past the 500-line convention). Until this pass `ActorFilters` dropped the filter from its
  composed list on the frame the pool hit 0: the shell vanished between two frames and
  `EventReactor`'s positional burst had to carry the whole moment. Now a `uShatter` uniform runs
  0 → 1 over `SHATTER_MS` (200 ms) while `ActorFilters` holds the filter ATTACHED — the same
  "keep the view alive past the state change" shape `startDissolve` and `Scene`'s dying-view list
  already use, not a second mechanism.
  - **The surface throws itself open and its wall thins to a rim.** The expansion goes into
    `surface` itself, not into `b` afterwards, which is what keeps the radial cull correct for
    free: `b` is measured in surfaces, so a shell that grew 30% has a cull radius that grew with
    it. Eased OUT — the shell leaps at the break and coasts; the reverse profile reads as a bubble
    inflating. Simultaneously `THICKNESS` is scaled down toward zero, so the bright band migrates
    out to the silhouette and narrows: measured half-peak width 0.265 of the surface radius at
    rest, 0.08 at full shatter. A shell that expanded at constant thickness reads as inflating;
    one whose wall stretches thin reads as a surface being pulled apart.
  - **The whole fade lives in the shader, not in a second clock.** One `energy = uIntensity *
    (1.0 - uShatter)` replaces every use of `uIntensity`, so at `uShatter = 1` the shader hands
    back the source texel unchanged — measured as exact equality, not "small" — and the detach
    that follows is invisible. It also runs the membrane's own extinction (`integrity` is derived
    from `energy`) so whole scales go dark in the tile's shuffled rank order and the tint swings
    hot, i.e. the exit is `design/13`'s dual-channel law played at 5× speed.
  - **`BURST` is bounded by the filter's own area, not by taste.** `Actor` pins that area to 6
    body radii per side, so `dist` beyond `0.5·√2` does not exist along its narrowest axis and a
    shell that grew past it would be cut off FLAT on four sides only. `0.44 · 1.30 · 1.18 = 0.675`
    against a limit of 0.707 — and the suite scans the actual visible edge at every instant rather
    than trusting that arithmetic.
  - **The membrane's scales are thrown outward per cell, off the channel that was already there.**
    The tile's GREEN channel is each cell's place in a shuffled extinction order; the exit reuses
    it as a launch speed, so the scales come apart in pieces instead of sliding off as one sheet.
    Reading a per-cell constant costs a tap of its own (which cell is under this pixel is exactly
    what the tap answers), so the membrane branch goes from two tile fetches to four; at rest the
    offset is exactly zero and the second tap lands on the texel the first already pulled in.
  - **The fragments are `Particles.ts`' job, not the shader's** (`shieldShards`, wired from
    `EventReactor`'s `shield_break` case — whose event position IS the target actor's centre,
    unlike the neighbouring `hit`). The decisive reason is the same fixed `filterArea`: anything
    the shader draws is clipped at ~2.4 body radii, and a shard that flies further would simply
    stop existing. A shader also pays for its fragments at every pixel of the region for the whole
    animation, where 11 shards cost 11 shards — and this file already owns motion, gravity, spin,
    lifetime, alpha decay and the quality budget.
  - **The exit flares to full brightness rather than starting from the pool it died with.** A
    shield that broke from 12% would otherwise play its whole 200 ms at 12% brightness, i.e.
    invisibly. That lifts the refraction for one frame too, which is deliberate: the frame it
    lands on is behind `EventReactor`'s 50 ms hit-stop and a 28 px burst, and a shell bending
    light harder as it lets go is the read we want there.
  - **Perf: the exit is free at rest, and the shipped shader did not get slower.** Measured with
    `EXT_disjoint_timer_query_webgl2` (never `performance.now()`, which reported a 1000×-ALU
    control at 2.35× on this same machine), interleaved A/B/C with that control carried through
    every round — see ROADMAP's "The shell gets an exit" for the table.
- **The body is shaded as a sphere** (`render/rigShading.ts`). A fixed specular highlight
  toward the key light and a curved terminator falling away from it — drawn, not authored,
  because they must stay pinned to the light's **screen-space** direction while the body they
  sit on mirrors and the eye beside them travels. Eye moving while the highlight does not is
  precisely what reads as a sphere turning under a fixed light. Every mark is an ellipse or
  arc strictly inside the body radius, so no mask is needed and nothing can spill past the
  silhouette (a mask per actor would be 30 stencil passes in a busy room). `RigSkin`
  counter-flips it against `view.scale.x` so the light never mirrors with the body. The
  alphas are roughly double what they were first set to: design/13's shells are near-white
  flat-cel art, and a fifth-opacity black arc over white is nothing.
- **A far-side module is smaller and darker, not just behind.** The per-weapon z-order flip
  (shipped earlier the same day) reads on its own as "it changed layer"; adding a depth scale
  and a depth tint turns it into an orbit around a sphere.


Wall height is `WALL_HEIGHT` (70 px), deliberately the same constant the pillars use, so
everything standing in a room agrees on how tall "tall" is.

---

## The drops and the gate get real art (2026-08-20)

The [pillar pass](02-walls.md#a-pillar-is-a-sprite-now-2026-08-20) closed the scene queue for *surfaces*. This one closes it for the objects that
stand on them: the five in-run drop kinds and the extraction portal. Both were still Pixi `Graphics`
— `design/12` had recorded them as "never planned as sprite art", a judgement made while walls were
flat rectangles on the ground layer, and by now they were the loudest placeholders in the frame.
**Render-only, no `ENGINE_VERSION` impact.** Art prompts and the three rejected generations are
archived in `art/environment/prompts.md`.

**A drop is scaled by its LONG axis to one shared 18 px extent** (`Pickup.ART_LONG_AXIS`), so each
file keeps its own aspect — the crystal draws 11x18, the bandage 18x9 — while a floor of mixed loot
still reads as one size class. This is the pillar's "scale by one axis, let the art choose the other"
rule with the axis picked differently, and for a different reason: a pillar's width has to agree with
a collision footprint, whereas a drop has no footprint at all and only has to agree with its siblings.
`weapon` is exempt and always will be: it draws that weapon's own business-end art, so
`getPickupTexture` has no `pickup_weapon` key and `Pickup` never asks for one.

**The gate is split between art and code, along the line "does it move?"** Only the masonry arch is a
sprite — bottom-anchored on the ground point, fitted by width, its height falling out of the file's
aspect (the shipped 576x539 lands within a pixel of `archH`). The ground bloom, the two
counter-rotating rings of arcs, the bright core and the infalling motes stay program-drawn because
they animate every frame. Consequence worth stating: the arch art is authored as NEUTRAL stone with
COLOURLESS crystal, because one `Sprite.tint` cannot tint the shards without tinting the masonry, so
the checkpoint's green comes from the code-drawn layers instead.

**Two numbers moved because real stone has thickness, and they are both measured off the file.** The
vortex's radii were fractions of `archW`, the object's outer half-width — free while the "arch" was a
single stroked ellipse whose stone had no thickness at all. The shipped arch's legs take 22% of the
outer width each, so `ringA`'s authored `0.78 * archW` was drawing the brightest ring straight onto
the masonry. Fixing it needed the right *measurement*, and the first attempt used the wrong one: the
horizontal cross-section of the opening at one height (45.4%) ignores that the vortex is an ellipse
which also extends upward into the narrowing crown. Sweeping the file's alpha for **the largest
ellipse, squashed the way the code squashes it, that touches no opaque pixel** gives the real answer —
and it depends on where the ellipse is centred: only `0.365 * archW` at the arch's mid-height, but
`0.560` with the centre dropped to a QUARTER of the arch's height, where the straight legs become the
only constraint. So `VORTEX_CENTER_OF_ARCH_H` exists now too, and the vortex sits low in the doorway,
which is also where an arch's opening actually is. `environmentArt.test.ts` re-derives both constants
from the shipped alpha every run.

**Three things only a rendered frame could have said**, all found by compositing the sprites at their
real drawn size over the real floor swatch and by pulling frames out of the live client:

- **A one-pixel arrowhead.** The buff sigil's inner mark was generated as an *outline* — 5.8% of the
  object's width per stroke, which is one pixel at 18 px. It measured as a correct shape and was
  invisible in game. The regeneration's solid mark is 27% of the width, about 5 px.
- **An eye.** The bandage came back as a circular end-on roll with concentric rings and a dark centre
  hole. In a game whose hero, every critter and the boss are all single-eyed, a pale disc with a dark
  middle lying on the floor is a fiction-breaking read, and no per-file measurement would ever have
  flagged it. The fix is the silhouette (a side-on capsule, aspect 1.92), which is therefore what the
  test asserts.
- **The glow had become a plate.** Each drop sits on an additive glow that had been ONE flat circle at
  a single alpha since 2026-08-02. Behind a 14 px flat Graphics silhouette that read as "this shape,
  glowing"; behind real art it read as a coloured token the object was standing on. It is now twelve
  non-overlapping annuli on a squared falloff — the same construction as `roomLight`'s room falloff and
  `wallTone`'s coping ramp, and for the same reason (stacked translucent shapes step in OPACITY and
  compound). Ten bands stepped by 0.061 alpha, which still read as a ring; twelve step by 0.052.

**And one defect this pass introduced and then caught in its own frame:** pulling the vortex's radii in
to fit the opening while leaving its stroke widths and mote sizes at their old absolute values took
`ringA` from 26% of its own radius thick to 44%, and the vortex read as a scatter of debris rather
than a spinning ring. One `VORTEX_SHRINK` factor now scales widths and mote sizes with the radii, and
the test bounds the stroke-width-to-radius RATIO rather than an absolute width, so it cannot go stale
the next time the arch art changes.

**Verification. +87 tests (1968 → 2055), 39 mutants, 39 killed** — after four survivors were closed,
and all four were real gaps. Two of them were the same gap: `getPickupTexture`'s `pickup_` key prefix
and `getPortalArchTexture`'s key string are *never executed* under vitest, because no texture ever
enters the registry there — a typo in either silently leaves every drop and every portal on its
Graphics fallback forever, which looks exactly like art that was never generated. That is what
`environmentSpritesLoad.test.ts` is for (stub `Assets.load` to succeed, then assert each getter
resolves to its OWN file), and it is the same split `biomeTilesLoad.test.ts` already keeps from
`biomeTiles.test.ts`. The other two were assertions too loose to discriminate: a mote-size bound that
0.16 satisfied when the shrunk value is 0.11, and a glow-ramp convexity threshold a linear ramp
cleared by 0.007. `environmentArt.test.ts` decodes the six SHIPPED files and measures them (real alpha
with transparent corners, no baked halo, trimmed to content, resolution headroom against
`MAX_ZOOM * DPR`, every band clear of the floor's own 39-49 luma, the crate's top the brightest plane,
the arch in the wall face's tonal family with its shards untouched by the curve) — and runs the same
assertions over the three `_alt` rejects, so a check that stops telling accepted from rejected art
fails instead of passing vacuously.

## A collected drop flies to whoever took it (2026-09-15)

> *"给拾取物品加一个曲线飞行特效…大概 0.6 秒飞到玩家身上，就是其他游戏里普遍有的那种拾取效果。"*

`PickupSystem` collects on overlap and compacts the item out of `state.pickups` **the same
tick**, so until now the drop's view simply stopped existing on the next reconcile. The
`fx.flash()` `EventReactor` leaves behind is drawn at the loot, not at the collector, so nothing
on screen answered the question the flash is standing in for: *did that go to me?* In co-op and
in PvP that is a real question, and the arc is the answer — it ends on a body.

`scene/pickupFlight.ts` owns it: `flightPose(t, from, to, sign)` is the whole curve as one pure
function, and `PickupFlightLayer` mounts, drives and destroys the flown views. `Scene` owns the
layer (like `ChestLayer`/`ShopLayer`) and steps it from `interpolate`, so a flight runs on the
RENDER clock and keeps moving through a pause, the same rule fx on a frozen frame already follow.

### Three things decided the shape, and two of them are this view's geometry

**The engine had to say WHO, and nothing else.** `GameEvent`'s `pickup` gained one field, `by`,
the collecting player's actor id — the same field for the same reason as `bullet_fired`'s
`ownerId`: the render layer needs the collector's own view, and `gx/gy` is where the drop *lay*,
which the animation already has. It cannot be answered from state (the item is gone by the time a
frame's events are read) and "whoever is nearest" guesses wrong exactly when two players overlap,
which is when the flight is most worth watching. Additive and inert — events never enter
`serializeState`/`hashState` — so no `ENGINE_VERSION` bump.

**The flight is driven by the EVENT, never by the state diff.** A floor teardown removes every
uncollected drop with no `pickup` event behind it, and a flight launched off the diff alone would
fling a whole floor's loot at the player on every descend. It also builds a FRESH view rather than
adopting the one on the floor: under online catch-up (`GameLoop.advanceOnline`) a drop can spawn
and be collected inside one drained batch, so the view being replaced may never have existed —
while the event always arrives. The launch is the LAST thing `reconcile` does, because the arc is
aimed at the collector's view and that same call is what mirrors it.

**The bow is applied to the ground perpendicular's X COMPONENT ONLY**, and that is this view's
projection talking. The renderer shears `(x, y, z) → (x, y − z)`, so a bow in ground Y and a rise
in Z are *the same screen axis pointing opposite ways*. The first cut bowed the full perpendicular
and the two cancelled: measured on a live 28 px pickup, the drawn path deviated from a straight
screen line by **0.5 px** — a "curve" the player would have read as a slide, with a green test
behind it that measured the bow in the ground plane, where it was real. Bowing in X only leaves
the two free of each other: an east–west flight curves purely as a thrown arc, a north–south one
swings sideways as well, and neither can flatten the other (13.8 / 18.8 / 8.5 / 18 px of screen
deviation for the 28 px and 75 px cases in each direction). `pickupFlight.test.ts` measures in
SCREEN space for both directions now, because the ground plane is not where the player is looking.

### Why the arc has floors as well as fractions

Every offset is sized as a fraction of the distance flown, and then floored: `POP_BACK_MIN` 8 px,
`BULGE_MIN` 16 px, and a `HOP_BASE` of 14 px. The floors are the load-bearing half, because of a
number outside the render layer entirely — everything but a weapon is auto-collected on overlap
(`SIM.pickupRadius`, 15 px of padding past the player's own ~16 px body), so **the typical flight
is barely 28 px long**. Sized purely proportionally the arc collapses to a few px, and 420 ms of
that reads as a drop sliding in slow motion. A weapon claimed from across the reveal ring
(`SIM.lootRevealRadius`, 80 px) is the case the fractions are for.

The rest of the pose: height interpolates on `u²` under a hop that peaks at ~38% of the path and
then dives, scale swells to 1.2 and ends at 0.5 so the drop enters the body rather than landing on
it, alpha holds until 62% of the path, and the tilt is a ±0.5 rad wobble that returns to 0 — never
a tumble, because a weapon drop's rarity pips and element badge (design/13's two channels) have to
stay the right way up. The shadow's own alpha is multiplied by the pose's *after* `place()`
rewrites it from the height falloff, or a dissolving drop leaves its shadow sliding under the
collector for the last ~90 ms.

### The drop accelerates into the body (2026-09-21)

> *"特效的飞行给个加速度，越靠近角色越快，然后整体时间也对应缩短。"*

The first cut fed `t` to the bézier raw and let the control-point spacing *be* the speed curve.
That is a real curve but a flat one, and flatness costs at both ends of the same animation: the
pop — the thing that puts the eye on the item before the item moves, and so the thing that
actually answers *did that go to me?* — was over in ~60 ms, and the drop then coasted the last few
px into the body at the same pace it crossed the middle.

`flightPose` now reads the clock exactly once, as **`u = t ** ACCEL`** with `ACCEL = 2`, and feeds
`u` to everything spatial. The exponent is not a taste knob: `s = ½at²` *is* constant acceleration,
so the drop leaves the floor at rest and gains speed steadily the whole way in, which is the
request stated in the one form a reader can check against physics instead of against how it looked
on the day. Half the clock now buys the first quarter of the path (the hang) and the last third
buys three quarters of it (the dive) — screen speed on the 120 px case runs ~100 px/s through the
pop and ~790 px/s on arrival. That is what paid for the shortened duration: **`FLIGHT_MS` 600 →
420**, because the stretch that used to need the time was the one the acceleration deletes.

**One constant had to move with it, and it is the half that is easy to leave out.** A cubic's
speed at the end is `3·(p3 − p2)`, so the old second control point — parked *on* the collector —
pinned the ARRIVAL SPEED AT ZERO for any flight the sideways bow does not shape, and an east–west
flight bows by exactly 0 (above). The two halves then cancel in the worst possible place: the time
warp says "fastest at the end", the geometry says "stopped at the end", and what is drawn is a
fast middle followed by a crawl into the body — the one stretch the change exists to speed up.
`LEAD` (0.5 of the distance, floored at 14 px, capped at 55) pulls p2 back along the travel
direction so the curve has a real tangent to arrive on. Measured as final speed over the flight's
own average: 0.26–0.75× without it, 1.8–2.5× with it.

Two more followed from `u` being the parameter rather than the clock. The hop's apex and the fade
are both keyed to the **path**, not to time — 38% of the path is 61% of the time now, and a hop
read off the clock would already be falling while the drop still sat over the floor it came from,
while a fade read off the clock would start going transparent 45% of the way out, in open air.
`FADE_FROM` came down 0.78 → 0.62 to pay for the same choice from the other side: the tail of the
path is the fast part, so 0.78 *of the path* is only the last 49 ms — a blink, not a dissolve.
Only the tilt still reads the clock, because a wobble is not a place on a path.

Every assertion `pickupFlight.test.ts` adds for this is a **ratio of the flight against itself**
measured on the drawn screen path, never a restated constant — the last quarter of the clock
covers more ground than the whole first half, and the final speed beats the flight's own average
by 1.5×. Both statements are false for `ACCEL = 1` and for `LEAD = 0`, which is the point: the two
halves of this mechanism are separately capable of setting the arrival speed, and the failure mode
is them disagreeing silently while every existing "is it a curve?" assertion stays green.

### The chase has one exception, and the step order is what names it

Re-asking the target every frame is what makes a flight follow a running player. It is also what
would drag a drop across the whole floor when the collector does not RUN anywhere but is
TELEPORTED — and the sim can do that in the same tick it collects, twice over: `PickupSystem` is
step 10, `DoorSystem`'s force-regroup is 11.5 and `ExtractionSystem`'s descend is 12
(`GameEngine.step`). Taking a heal on the tick you tap DESCEND is an ordinary thing to do, and the
drop would then streak from the old floor's geometry to the new floor's spawn point.

A target that moves more than `TARGET_TELEPORT_PX` (120) between two frames therefore ENDS the
flight rather than being chased. The number cannot be reached honestly — `PLAYER_BASE.speedPerTick`
is 6.4 px/tick (192 px/s), so a legitimate 120 px step needs a 625 ms render frame, and nobody is
watching a 420 ms arc through a stall that long. Ending rather than re-anchoring is the point: the
item is already collected, and there is no arc that could honestly connect the two points.

Two details that guard has to get right, both found by the test that pins it. The layer stores a
**copy** of each resolved target, not the reference: a resolver is free to hand back a live object
it keeps mutating, and holding it by reference makes "the last point I saw" silently mean "the
current point" — which is also the reading that makes this whole check a no-op. And the target is
resolved on the first `update`, never at launch: `Scene.spawn` pushes state and snaps but only
`interpolate` writes the transform, so a collector view created on the same reconcile still reads
(0, 0), and resolving then would hand the guard a jump it must not act on.

**What this does NOT change: when a drop is collected.** The flight starts the tick the sim
already took the item. It is after-the-fact feedback, interruptible and droppable — 420 ms of
travel is not 420 ms of the pickup being in doubt.
