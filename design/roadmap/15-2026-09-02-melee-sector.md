# Work log — 2026-09-02 (the melee sector)

Volume 15. Same day as `14`, split off it because that volume reached 964 lines
(`ROADMAP.md` "Appending to the log": past ~1000 lines, start the next number; splitting one
busy day across two volumes is fine).

## The swing shows the sector it actually hits (2026-09-02, client only, no engine bump)

From a live question in two parts — is the melee attack animation's amplitude tied to the
weapon's own attack sector, and can there be an fx that shows that sector. The honest answer to
the first was **no, the two were completely unrelated numbers**, and that turned out to be the
more interesting half.

**What the two sides actually said.** `HitResolveSystem.meleeArc` hits every hostile inside
`arcHalf` of the facing and within `range` of the actor's centre; `DeflectSystem` parries bullets
in the identical sector, off the identical two fields. The authored roster spans **60° (spear) to
220° (hammer)** and 1.3–2.1 grid of reach. The animation was one hardcoded sweep: `-22°` behind
the aim to `+46°` past it, 68° total, 260 ms, for every weapon in the game — the trigger chain
carried a single bit (`onAttack(kind)`) and no spec at all. So the spear's animation was **wider
than the sector it can hit in**, the hammer drew **31% of its own**, and because the parry reads
that same `arcHalf`, the gap was not a missing flourish: it actively misinformed the player about
which bullets their swing could bat away.

### Half one: the weapon sizes and paces the swing

`render/rigAttackMotion.ts` gained `SwingShape` (the weapon's `arcDeg` + its recovery in ms) and
`swingSchedule()`, which derives the travel and the timing:

- sweep = `arcDeg × (68/162)`, clamped to **[26°, 104°]**
- envelope = `recovery × (260/366.7)`, clamped to **[130, 400] ms**

Both factors are **defined as the ratio between the starter saber's own shape and the constants
that were hand-tuned against it** (`DEFAULT_SWING` = 162°, 11 ticks @ 30 Hz), not typed in — so
`swingSchedule(DEFAULT_SWING)` reproduces the pre-pass envelope exactly rather than approximately,
and a drifted factor fails a test instead of quietly changing the starter weapon. A caller with no
spec (the `Graphics` placeholder; any enemy, none of which carry a melee weapon) gets that same
default. The spear now pokes at 25° in 213 ms, the hammer heaves 92° over 400 ms.

The clamps are about the body, not the reach: the blade hangs off an **aim-tracking socket**, so a
sweep much past ~100° swings it *through* the character rather than around, and a sector narrow
enough to derive under ~26° stops reading at the 13–20 px an actor occupies. The **fx is
unclamped** — it draws the true sector — which is the division of labour worth remembering here.

The shape reaches the envelope through the chain that already existed, one argument wider:
`EventReactor` → `Actor.onAttack(kind, swing)` → `Skin.attack` → `RigSkin.attack` →
`AttackMotion.kick`. Three of those four hops have no observable behaviour of their own, which is
why each is now asserted individually (below).

### Half two: the sector, drawn

New `client/src/game/fx/slashArc.ts` — the weapon's real arc, at its real radius, swept once per
swing, scheduled off `swingSchedule`'s own strike window so the light on the ground and the blade
in the air are one motion rather than two effects that overlap.

**Why it is a `Mesh`, the only one in this renderer.** The look needs alpha varying along two axes
at once: radially (transparent at the body, a bright rim at the reach limit, so the edge is a
*stated* boundary) and along the sweep (hot at the blade, fading through the wake). Pixi's
`Graphics` can only carry a **one-dimensional** ramp — `render/shadeRamp.rampFill` maps a linear
gradient through a texture matrix, and a matrix cannot express a polar mapping — so the Graphics
version of this is N adjacent constant-alpha sub-wedges, i.e. exactly the banded, draw-call-heavy
shape `shadeRamp.ts` exists to have deleted. A textured mesh gets both axes from its own UVs in
one draw call: 32 columns across the arc, `u` running back from the blade's current angle, `v`
from the actor's edge out to the reach limit.

**Why the brush is baked in code rather than generated art.** This is the second confirmed
instance of design/12's own rule (the first was the shield's scale tile): reach for the image model
when the asset needs a MATERIAL, generate it when it needs a parametric field. Here it is a radial
profile times a tail profile, converged on by editing a number, and it has to be additive-clean at
any arc width — so it goes through `shadeRamp.bakedField`: 256×64, POT and mipmapped (WebGL1 on
WeChat silently disables mips on NPOT), premultiplied white, **zero bytes** against design/04's
package budget, and readable back by a test. One bake serves 60° through 220° because the angular
span lives in the geometry and the brush is parametrised on *fractions* — sweep fraction and radius
fraction — so nothing stretches. Each swing tints it by element (`swordGlow` for physical, since
`ELEMENT_COLORS` deliberately omits that entry and the faction colour would read as a team marker).

Two details that carry the look. The **unswept part of the sector is not drawn**: every column
ahead of the blade collapses onto the blade's own angle, making those triangles zero-area, which is
what gives the leading edge a hard boundary — a fade there reads as the whole sector lighting up at
once. And the arc **outlives its own sweep** by twice its length: once fully swept, the whole
sector is lit and fading, and that is the frame where the reach is most legible.

Retired arcs are pooled (each one otherwise allocates three GPU buffers for ~230 ms), stepped from
`FxController.updateFx` in a list of their own rather than through the `_life` machinery — that
loop fades alpha *and scales* a child, and scaling this fx would grow it past the reach it exists
to state — and dropped on a run boundary, where a `_life` glow is small enough to be left to
expire.

**Where the weapon comes from, and why no engine change.** `melee_swing` carries `ownerId/gx/gy/
facing` and deliberately nothing else (design/08 keeps events to what the sim announces). The
netcode broadcasts *inputs*, so every client already holds the whole `GameState` —
`EventReactor.meleeSwinger` resolves the swinger's `MeleeSimSpec` from there and converts at the
render edge (brad→rad, fp→px, ticks→ms). No event field, no protocol change, no `ENGINE_VERSION`
bump. A lookup that misses is the normal case for an enemy, not an error: `meleeArc` runs over
`state.players` only.

### Measured, because looking could not answer it

The arc sweeps around a character that already wears a cyan shield shell, and no screenshot
separates the two — so the live check was an **A/B extract diff** (`extract.pixels({target: stage,
frame: viewport})` with `arc.visible` toggled), on a frozen frame with the ticker stopped. A real
hammer swing at 84% of its sweep: **9,747 px lit**, radii **71–125** against a geometric 46–119 plus
bloom (the 71 is the radial profile's own onset — the brush is near-transparent below ~35% of the
radius, by design), lit sector **159° of 220°**, and the head on the *mirrored* side, which is the
only evidence that `flipX` is applied at all.

That measurement also made one tuning decision honestly: at `TAIL_POWER` 3.2 the wake was under 1%
of peak by the time the blade was 80% round, so a 220° weapon only ever showed ~90° of itself and
the fx read as a crescent rather than a sector. **3.2 → 2.4** moved the measured lit arc 143° → 159°.
The pane's own `computer screenshot` returned a stale frame twice during this while `extract` was
correct both times — the same verdict as the standing-wall pass: when they disagree, extract is the
truth.

### The tests, and the parity file that did not exist

**4419 → 4497 (+78)**, in 2 new files and 6 existing; `tsc` clean, `check:filelength` clean.

The one worth naming is `client/src/game/fx/meleeArcParity.test.ts`, the same shape and the same
reason as `render/muzzleParity.test.ts`: the sector is authored once and consumed twice, and
**nothing cross-checked the two**. Each side had tests; the conversion between them was asserted
only against numbers restated by hand. It drives the real `HitResolveSystem` and probes the
boundary for all seven weapons:

- **angular parity is exact** — the engine tests the angle to the target's *centre* with no slack,
  so a body 2° inside the drawn edge connects and 2° outside does not, and the drawn edge is
  `arcHalf` to five decimals (the plausible wrong answer — treating `arcHalf` as the full sector —
  is what that pins);
- **radial parity is deliberately conservative** — `meleeArc` reaches `range + target.radius`
  (bodies, not points) while the arc is drawn at `range`, the reach the spec's field means. The gap
  is pinned *to the target's radius* rather than to a number, so the fx can never quietly start
  over-promising. Standing on the lit edge always connects;
- and the arc **sweeps the same way the blade does**, in both facings — two independent paths to
  one decision (the fx takes `flipX` from `facingFromAngle`; the rig states its swing in canonical
  pre-mirror space and lets `view.scale.x` reverse it), with a control proving the direction really
  does invert between them.

**A 39-row mutation battery: 39 authored / 39 executed / 35 killed**, and unusually every one of the
four survivors was a real gap rather than an equivalent — all three of the first ones the same
shape, *a test that reads one channel of a multi-channel buffer*:

| survivor | what it breaks | why 19 cases missed it |
|---|---|---|
| radial UV swapped | bright rim on the character, transparent at the reach limit — the fx inverted | every case read `u`, none read `v` |
| quad triangulated along its inner EDGE | overlaps near the body, leaves a wedge hole along the outer rim | nothing read `geometry.indices` |
| buffer never marked dirty | JS arrays correct, GPU copy frozen on frame one | looked untestable headless — and is not: Pixi's `Buffer` is an EventEmitter, and that re-assignment is what makes it emit `update` |
| exponential tail turned linear | a slash becomes a filled pie slice | satisfied every asserted property (1 at the blade, 0 at the end, monotone) |

All four closed and re-killed (the four-mutant subset re-run rather than the whole battery, which
is the cheap way to prove a gap is actually shut). The tail is now held by a **band** whose bounds
are the design statement — faster than linear, still wide enough that the sector reads — not a
snapshot of the current constant.

### Found and spun out, not fixed here

`MeleeSpec.swingSec` is authored on all seven melee weapons (0.1–0.2 s, documented as the "ACTIVE
hit-window, 07 step 7") and **`toSimSpec` never converts it** — it reaches no `MeleeSimSpec` field
and nothing in the repo reads it. Melee damage resolves instantly on the swing tick. Either the
window becomes real (which would also let both the fx and the envelope pace themselves off the
actual active window instead of a fraction of the recovery, and needs an `ENGINE_VERSION` bump with
the golden-hash gate run *first*) or the field is dead data and should go. Left as its own task
rather than decided in passing.


## The weapon decides how heavy it swings, and how hard it kicks (2026-09-02, client only, no engine bump)

From a live report on the two passes above, in three parts: the sector fx reads well, but the
MOTION does not match it; weapons have different attack intervals, so the animation's playback
length should follow, *"that way a heavy weapon and a light one will feel different"*; and then take a look at
optimising the firing motion too.

Two of the three had been half-answered already and the entries above say so — the sweep was tied
to `arcDeg` on 09-02b and the strike to `swingTicks` on 09-02c. What was still one constant for the
entire roster was **everything else**: the follow-through, the body's lunge, and — untouched since
2026-08-30 — the gun's whole recoil, all four channels of it.

### What was actually still shared

| channel | before | inputs it should have had |
|---|---|---|
| melee follow-through | `window × 0.82`, so a 667 ms weapon and a 300 ms one differed only by strike length | `swingCooldownTicks` |
| melee lunge | 5 authoring px, every weapon | `knockback` (3-12 grid/s across the roster) |
| melee module slide | always 0 | `arcDeg` — a 60° sector is a thrust, not a small sweep |
| ranged envelope | 150 ms, all eighteen guns | `fireRateTicks` (100-1500 ms) |
| ranged magnitude | 10 px / 3 px, all eighteen | `damage × bullets` (1-10) |
| ranged muzzle rotation | did not exist | the same |

### The one that was a defect rather than a gap

The blaster's 150 ms recoil was tuned against its own 200 ms cadence. **The repeater and the flamer
fire every 100 ms.** So the next shot restarted the envelope halfway out and the gun never returned
— visibly displaced for the whole of a held trigger, snapping home on release. `AttackMotion`'s
"a shot that lands mid-settle restarts it" rule is right; what was wrong is that for the fastest
third of the roster the settle could not happen at all. Every envelope is now `interval × 0.75`,
which is *defined* as the ratio reproducing the blaster's own 150 ms, so it is one number rather
than two that have to be kept consistent — and being under 1 is what makes "it finishes before the
next shot" structural rather than tuned.

Confirmed on a live run rather than argued: driving the real loop with the repeater equipped and
fire held, `modulePx` traces `0 → 9.97 → 7.12 → 4.27 → 1.42 → 0` and reaches **exactly 0** before
each restart, repeating cleanly for the whole burst.

### Two segments, two inputs — and why this is not a revert of v53

v53 moved melee timing off `recoveryMs` and onto the hit window. That reads like the opposite of
putting the recovery back, and it is not: `strikeEndMs` is still exactly `windowMs`, so the visible
stroke still covers precisely the ticks that can connect. What v53 could not express is the TAIL,
because it sized the whole envelope from one number. The two segments now derive from the two
quantities that describe them — wind-up + strike from the window, follow-through from the recovery
— and `FOLLOW_SHARE` is **defined as the value that reproduces the pre-existing saber tail
exactly**, so the reference weapon is byte-identical and it is the roster around it that spreads.

Envelope lengths: 182-364 ms (2.0×, window only) → 194-418 ms (2.16×), against the recovery's own
2.22× spread. The part a player reads as weight is the tail, and the hammer's is now **2.3× the
spear's** rather than 2.0× by construction.

It also converts a tuned clamp into a proof. `total = window + (recovery − window)·s ≤ recovery`
for any `s ≤ 1`, and design/07 guarantees `window ≤ recovery` (`toSimSpec` clamps `swingTicks` into
`[1, cooldown]`), so "the stroke fits inside its own recovery" no longer needs `SWING_MAX_MS` to
hold the line for the hammer.

### A 60° sector is a thrust

`SWEEP_MIN_DEG` (26°) is where rotation-only stops being honest. The spear derives 25°, gets clamped
up, and draws a miniature swing of a sector that **is not an arc** — while its 2.1-grid reach, the
longest in the roster, goes unstated by the motion entirely. Below 145° the derivation trades
rotation for a slide down the barrel, linearly, to a pure thrust at 60°. No new plumbing: that is
the gun's recoil channel with the sign reversed, so `AttackMotion.modulePx` simply became signed for
both kinds and `rigWeaponMount` needed no change.

The knee is 145 and not 150 on purpose. 150 is the stormglaive's authored sector, and a threshold
sitting exactly on a shipped weapon is decided by brad quantization — 75° round-trips to 74.998° —
so that weapon would derive a hairline thrust or not depending on a rounding direction. The first
draft used 150 and a test caught it at 0.00057 px.

### Heft, and a lossy round trip recorded rather than papered over

`knockback` is the only field in the sim that states how hard a swing shoves (hammer 12 grid/s,
saber 6, spear 4, leech 3), so the body's lunge scales with it: `√(k/6)`, clamped [0.6, 1.8].
Sub-linear because `knockback` spans 4× and the lunge is a body offset in authoring px — linear
would walk the hammer into its own target.

`toFpPerTick` **truncates**, so 6 grid/s is stored as 198 fp/tick and reads back as 5.94. That ~1%
is the one input on which the reference does not reproduce its tuned constant to the bit. It is a
hundredth of a screen pixel and not worth recovering, but the tests state it as a tolerance with the
reason attached rather than rounding it away — rounding to integers would happen to work for the
whole current roster and would be 10% wrong for the first weapon authored at 4.5.

### The muzzle climbs, which is the half a player can always see

The old recoil only slid the gun back down its own barrel — the component that is foreshortened to
nothing when firing toward or away from the camera, i.e. half of all aim angles. A real recoil also
rotates the muzzle up, and that reads at every angle. The channel already existed and was already
read every frame (`RigSkin.canonicalWeaponAngleRad` adds the melee sweep to the socket's aim); it
was simply always 0 for a gun. `AttackMotion.swingDeg` became `weaponDeg` accordingly — a getter
named for one kind, returning the other kind's muzzle climb, would have been wrong in the one place
it is actually read.

`punch` (damage per TRIGGER PULL, not per bullet) scales all three magnitudes, so the scattergun's
five pellets kick like a slug instead of like five blasters. `√punch`, clamped [0.7, 2.2] — the
upper bound catches the novaburst's ten-bullet ring, which is radial and has no single direction to
be shoved away from in the first place.

### The ceiling was chosen by measuring what it swallows

`RECOIL_MAX_MS` started at 260 ms, on the reasoning that a 1.5 s weapon should not spend 1.1 s
leaning away from a shot that already left. A test then measured the consequence: **thirteen of the
eighteen guns pinned to that one value** — the same "every gun feels the same" defect this pass
exists to remove, moved rather than removed. At 380 the derivation stays live out to 15 ticks, which
is where the roster's fast half ends: eight weapons span 75-375 ms in six distinct lengths and the
nine slow ones share the ceiling, still differing from each other in magnitude, which is `punch`'s
independent axis. The test now counts DISTINCT envelope lengths, which also fails against the
pre-pass state where the answer was 1.

### Tests

4,499 → 4,520 client tests. The new coverage is mostly *comparisons between two weapons* rather
than assertions about one, because the constants are still the starter weapons' — a suite that only
exercised `kick('melee')` with no shape would pass identically before and after this pass.

Three test-shape changes are worth naming:

- **A test whose premise this pass invalidated.** "Walks the roster in window order, not in recovery
  order — they disagree" was v53's guard against a silent revert. Both inputs are read now, so it
  became "walks the roster on BOTH axes": the strike ratio is exactly the window's 5/4, and the
  TOTAL is neither 5/4 nor 14/12 — which is precisely what no one-input derivation can produce.
- **Sampling moved off fractions onto the schedule's own marks.** Cases sampling at `total × 0.3`
  and `total × 0.55` were correct only while the envelope was one number long; those are the saber's
  split, not every weapon's. They read `strikeStartMs`/`strikeEndMs` now, which is exact for all.
- **Two RigSkin cases had to be re-derived, not re-tolerated.** The muzzle climb rotates the barrel,
  so the tip both rises and reaches less far along the aim — "the whole displacement is −x" stopped
  being true. Rather than loosening it, the new assertion pins the ratio of the two components at
  `tan(climb/2)`, which cancels the rig's own barrel length and so holds for any rig.

**A 12-mutant battery, all 12 killed**, run against a verified-green baseline with the revert in a
`finally` (the trap volume 14 recorded). They are deliberately the *reverts*: collapse the tail back
onto the window, drop the thrust, drop the heft, drop the sweep scaling, fix the recoil length, drop
the climb, fix the magnitude, drop the shape at the read site, drop the recovery, drop the
knockback, and stop the two new channels reaching their getters.

### Found in passing

- **The players-only lookup.** `EventReactor.meleeSwinger` searched `state.players` only, correctly:
  no enemy in the roster carries a blade. The ranged branch is the other way round — enemies are most
  of what fires — so a players-only lookup would have handed the entire enemy roster the fallback
  blaster kick, and nothing would have looked broken. It walks both lists now.
- **…which then threw on a partial state.** Widening it to a second list made it reach a field that
  half the faked hosts in the suite do not define, and `audio/audioPipeline.test.ts` — an unrelated
  file — was what caught it. A render-layer consumer draining a queue must degrade to "not found",
  never take the frame with it; that is this file's existing stance for the local-seat lookup and is
  now shared by a helper. Pinned by its own case, verified by mutation.
- **`EventReactor.ts` crossed 500 lines** and was split rather than baselined — form ①,
  `controllers/attackShapes.ts`, the four free functions that convert a sim spec into a render shape.

### Verified live, not by looking

The pane could not hold `requestAnimationFrame` (a hidden Browser pane pauses it), so the loop was
driven manually through `window.__game.update(dt)`, which is better evidence anyway — deterministic
steps, real engine, real Pixi, real event pipeline. The tutorial loadout is `repeater` + `hammer`,
which happens to be the roster's fastest gun and its heaviest blade.

- **repeater, fire held**: `modulePx` `0 → 9.97 → 7.12 → 4.27 → 1.42 → 0`, reaching exactly 0
  between every shot at a 100 ms cadence; `weaponDeg` −5.98° at the peak; `bodyPx` 2.99.
- **hammer, one swing**: cocks to **−27.39°**, strikes to **+62.46°** (92° of travel against the
  saber's 68), lunges **−7.03 px** (against 5), `modulePx` 0 throughout — a 220° weapon sweeps, it
  does not stab — and settles to exactly 0 over **26 frames ≈ 433 ms** against a derived 418.

A screenshot was attempted and discarded: the menu backdrop composites over the canvas in that
state, so the frame shows the main menu. Exactly the failure mode `daydayup-visual-bug-blindspot`
records — the numbers above are the evidence, the picture would have been a lie.

### A follow-up coverage pass, and what it found (same day)

Asked directly after the above landed: *"a separate animation per weapon would be the best answer, but it is too much work,
leave it for now. See whether there are tests worth adding"* — per-weapon clips deferred, so look for tests worth adding.

**9 cases (+9).** Stated as a delta rather than an absolute on purpose: a concurrent door pass
was landing its own tests in the same shared tree throughout, so the suite total moves for
reasons that have nothing to do with this work. Measured on `main` at commit time: **client
4,539 / engine 1,137 / server 189, all green.** They were chosen by asking what the pass had wired but not pinned,
and then every one was checked the same way: apply a mutant, run the suites with that ONE new case
`it.skip`ped, and see whether anything else catches it. That distinguishes a test that closes a gap
from a test that agrees with an existing one, and it is worth doing before claiming either.

**Five closed real gaps** — nothing in the repo caught these mutants without them:

| the mutant that survived before | the case that now kills it |
|---|---|
| the thrust never reaches the socket RING (bone loop) | `RigSkin` — thrust, both paths |
| the thrust never reaches the mounted BLADE (`activeModuleMount`) | same case |
| `Actor.onAttack` drops the ranged shape | `Actor` — forwards the GUN too |
| `Skin.attack` drops the ranged shape | `Skin` — the same hop, the other kind |
| `specOf` stops narrowing on kind | `EventReactor` — event/weapon disagreement |

The first two are the bug class this repo has already shipped once and caught once — *`modulePx` is
read in two places*, so a channel wired into one of them slides an empty housing while the sword
stays put. The melee thrust was brand new in this pass and only `AttackMotion`'s getter was pinned;
the last hop onto the drawn sprites was not.

Isolating it needed a control, and the obvious one was wrong. "A rotation preserves radius" is false
here: the socket orbits about its own JOINT, not the rig origin, so no radius or single axis
separates the thrust from the sweep. What works is **a second rig posed statically at the angle the
swing has reached** — identical weapon angle, therefore identical FK, so everything left between the
two rigs is the recoil channel: zero for a weapon that only sweeps, a forward slide for one that
thrusts. Same trick would isolate any aim-relative offset from the rotation it rides on.

The `specOf` gap is a branch this pass deliberately added and never exercised: a player can SWAP
between the tick that emitted `melee_swing` and the frame that drains it, and reading a swing off a
`RangedSimSpec` produces `NaN` in every field rather than a wrong-but-finite arc — the blade would
freeze mid-air.

**One more earned its place on the second attempt.** The sector-fx roster sweep looked redundant —
the obvious mutant (a longer fade) breaks the saber too, and the saber was already pinned. The
mutant it *is* the sole guard against is the plausible one: **`slashSector` scheduling off
`swingSchedule()` instead of the weapon's own shape.** The saber IS `DEFAULT_SWING`, so a saber-only
assertion is structurally incapable of seeing that, while every other weapon's light desyncs from
its own blade. That is this log's recurring "a chain measured at ONE pose has measured one pose",
in the specific form where the one pose is also the default.

**Three are generalisations rather than new gaps, and are kept as such.** The two "every weapon
returns to exact rest within its own cadence" sweeps re-state at the CLOCK what the schedule-level
cases already prove arithmetically, and the attack-clip re-trigger case is covered by
`rigClipLayer.test.ts` for the mutants tried. They stay because they are cheap and they read as the
statement of the pass's central property — but they are labelled here rather than counted as
coverage that was missing.

The clip case is the one to keep an eye on. It exists because of a measurement taken while looking
for tests: **every shipped bundle authors `attack` at 350 ms**, while the repeater and flamer fire
every 100 ms and the spear recovers in 300 — so for the fast end of the roster that clip is
re-triggered before it can finish, for the whole of a held trigger. That is the same shape as the
recoil defect this pass fixed, still live on the authored layer. It is *tolerable* only because the
clip starts and ends at identity, so a restart re-seeds rather than stacks; the new case pins that
consequence on the drawn sprite over twenty restarts. Deferring per-weapon clips is fine — that
property is what makes it fine.

### Still open, deliberately

- The **authored `attack` clip still plays at its authored length for every weapon**, and it is now
  measured: **350 ms on all seven bundles**, against cadences from 100 ms up. Four ranged weapons
  and the spear re-trigger it before it completes. This pass
  moved the aim-relative layer only. A hammer's body jolt lasts as long as a spear's, and closing
  that means either a playback-rate multiplier on `ClipLayers` (cheap, and wrong for a clip with
  authored anticipation) or per-weapon clips (real art work). Neither is obviously right yet.
- The **thrust knee, the heft curve and the punch curve are all first cuts** with no playtest behind
  them. Each is one line in a pure function with tests that pin ratios rather than values, so
  retuning is cheap; what would make it informed is `test:pve-sim` time-to-kill per weapon, not
  another look.
- `RECOIL_MAX_MS` pins the slow half of the ranged roster to one envelope length. Fine while
  magnitude still separates them; it would stop being fine if a weapon slower than the mortar shipped.
