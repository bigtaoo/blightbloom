# Work log — 2026-09-21

Volume 85. See [`design/ROADMAP.md`](../ROADMAP.md) for the index and the phase spine.

## The health bar stops riding the hover (2026-09-21, client + test + docs, no engine change)

> *"角色头上的血条能不跟着角色上下晃动吗？眼睛都被晃花了"* — with a screenshot of the hero mid-hover,
> the bar circled in red.

One term, added back: `Actor.applyTransform` positions the bar at `this.y + visualZ + offsetY`
instead of `this.y + offsetY`. `Entity.applyTransform` draws a body at `y - (z + visualZ)`, so
a bar synced to `this.y` inherited **every** term of the body's height — including the one that
is not height at all but an idle animation (`actorLift.ts`'s `HOVER`, 2026-08-18's depth pass).
Engine `z` is deliberately still honoured: it is 0 for every actor today (design/01, *"`z` never
gates gameplay"*), but a real knock-up is the actor being somewhere else, and a bar left behind
on the floor would be the worse bug. The body's own `idle` clip bobs bones inside `skin.view`
and never reached the bar to begin with, so that one term is the whole of the fix.

**The complaint is sharper than "it moves".** A hovering archetype's `amp` is 1-2 world px, so
the bar travelled 2-4 px peak to trough; `setHealth` draws the track **4 px tall**, so on the
hero it crossed a full bar height twice per 2.4 s cycle, and a room is cover-fitted at 3.4-4.1x
(`FxController`), which puts that at **14-16 screen px** of travel on a readout **16 px** tall.
Nothing was tuned wrong — the swing is inside the `[6, 10]` band the 2026-08-21 pass measured
and locked. It was applied to the wrong object.

**Which is the reusable half.** The hover exists to say *this body left the floor*, and the way
it says it is the shadow: `Entity.applyTransform` shrinks, fades and slides the shadow with the
lift, which is precisely what the authored clip could not do and why the runtime term exists at
all. That argument is about the BODY and its shadow. It was never an argument for moving a HUD
readout, and the readout is the one piece of an actor's furniture the eye is asked to hold still
and read a fraction off. The bar had simply been mounted on the body's transform since it was a
child of it, and stayed on it through the 2026-08-21 move onto `layers.hud` — *"owned but not
parented"* re-derived the bar's position from `this.y` faithfully, hover and all.

Everything else in the lineage is untouched, on purpose: the hover table, the `idle` clips, the
shadow's response, and the **status aura**, which wraps the body and should ride with it. What
inverts is which quantity is constant — the bar now holds a fixed screen height and its
clearance above the head breathes by the hover's own 2-4 px instead. At `radiusPx * 1.3` (26 px
for a 20 px hero) against a peak that rises 2, the gap narrows but never closes.

### Two cases, one of them a control

`Actor.test.ts` 126 → **128**. The first samples 40 frames — two full cycles of the vanguard's
2400 ms bob — and asserts the bar's y spread is **0** while the body's is **> 2**. That second
assertion is the whole test: without it, the case passes just as well on an actor that never
moved, which is the shape design/18 Layer 4 keeps finding — an absence that was never a
presence. It also pins the bar to `ground y + offsetY` rather than to "some constant", so a
future edit cannot satisfy it by freezing the bar in the wrong place, and re-asserts x, which
was never the complaint. The second case drives `place(0, 400, 30)` on a grounded critter and
requires the bar to rise by exactly 30 — the difference between stripping `visualZ` and
stripping height, which nothing else in the file would notice.

`client/src/game/scene` 1,511 → **1,513** green, `tsc --noEmit` clean, no production behaviour
outside the one term, no `ENGINE_VERSION` bump.

`render` `test` `docs`
