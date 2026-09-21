# Work log — 2026-09-21

Volume 79. See [`design/ROADMAP.md`](../ROADMAP.md) for the index and the phase spine.

## Loot that accelerates into the body, and the floor that was backwards (2026-09-21, client + docs, no engine change)

> *"拾取物品时的飞行特效，特效的飞行给个加速度，越靠近角色越快，然后整体时间也对应缩短。"*

The collected-drop flight ([volume 60](60-2026-09-15-pickup-flight.md)) fed `t` to its cubic Bézier
raw and let the control-point spacing *be* the speed curve. That is a real curve, but a flat one,
and flatness costs at **both** ends of the same animation. Traced out of the running game at
60 fps, the 120 px flight moved 6.1 px in its first frame, peaked at 5.4 px/frame in the middle,
and arrived at **1.1**. The 28 px flight — the one auto-collection actually produces, so the one
players see most — arrived at **0.3 px/frame**. It did not fly into the body; it crept in.

`flightPose` now reads the clock exactly once, as **`u = t ** ACCEL`** with `ACCEL = 2`, and feeds
`u` to everything spatial. **The exponent is not a taste knob**: `s = ½at²` *is* constant
acceleration, so the drop leaves the floor at rest and gains speed at a steady rate the whole way
in — the request stated in the one form a later reader can check against physics instead of
against how it looked on the day. Half the clock now buys the first quarter of the path and the
last third buys three quarters of it, which is what paid for **`FLIGHT_MS` 600 → 420**: the
stretch that needed the time is the one the acceleration deletes.

### The time warp alone would have made the arrival *slower*

A cubic's speed at the end is `3·(p3 − p2)`. The old second control point sat **on** the collector,
which pins the arrival speed at **zero** for any flight the sideways bow does not shape — and an
east–west flight bows by exactly 0, because volume 60 deliberately bows only the ground
perpendicular's X component (the bow and the hop are one screen axis otherwise). So the two halves
of the mechanism cancel in the worst available place: the warp says *fastest at the end*, the
geometry says *stopped at the end*, and what gets drawn is a fast middle and a crawl into the
body — precisely the stretch the change exists to speed up.

`LEAD` pulls p2 back along the travel direction so the curve has a real tangent to arrive on.
Measured as final speed over the flight's own average: **0.26–0.75× without it, 1.8–2.5× with
it** — i.e. without the lead the drop is *decelerating* into the body while the time warp believes
it is accelerating. This is the transferable half of the pass: **a speed curve and a control
polygon are separately capable of setting the arrival speed, and neither one can see the other
disagreeing with it.**

Two more constants followed from `u` being the parameter rather than the clock, and both are the
same question asked twice — *is this quantity a place on the path, or a moment in time?*

- The **hop's apex** is a place. 38% of the path is 61% of the time now, so keyed to the clock the
  drop would already be falling out of its arc while it still sat over the floor it came from, and
  would come in flat.
- The **fade** is a place. Keyed to the clock it starts while the drop is still 45% of the way
  out — a drop going transparent in open air. `FADE_FROM` came down 0.78 → 0.62 to pay for the
  same choice from the other side: the tail of the path is now the *fast* part, so 0.78 *of the
  path* is only the last 49 ms, a blink rather than a dissolve.
- The **tilt** is a moment, and is the one curve still read off the clock. A wobble's whole job is
  to be 0 at both ends and lean over in between; on `u` it would lean out slowly and then whip
  upright over the last third, which is the part that should read as a clean dive.

### A floor that was right everywhere else and backwards here

`LEAD` first shipped with the same fraction/floor/cap shape as every other offset in the file —
`POP_BACK_MIN` 8 px, `BULGE_MIN` 16 px, `HOP_BASE` 14 px — on volume 60's reasoning that the
typical flight is ~28 px and a purely proportional arc collapses at that size. **For this one
offset that reasoning is inverted, and a probe across a 1–120 px ladder is what said so.**

p1 already sits `POP_BACK_MIN` = 8 px *behind* the drop. A lead longer than the flight puts p2
behind it as well, and a cubic whose middle two control points are **both** behind its start is not
an arc into a body — it is a backwards excursion with a snap on the end. With the 14 px floor:

| flight | turned around at | closes in monotonically after half-time |
| --- | --- | --- |
| 120 px | t = 0.31 | yes |
| 28 px | t = 0.39 | yes |
| 10 px | t = 0.58 | **no** |
| 1 px | **t = 0.74** | **no** |

A 1 px flight spent three quarters of its own clock moving *away*. And the floor bought nothing at
the size it was meant to protect, because `0.5 × 28` is 14 px exactly — it only ever bound where it
did harm. The floor is gone; 10 px closes in monotonically again, 1 px turns around at t = 0.56,
and 28/120 px are bit-identical either way.

**The reading that makes this obvious in advance**: the other floors exist to keep the arc big
enough to SEE, and this offset is not drawn. It sets a *speed*, not a displacement — `3·lead /
FLIGHT_MS` — and a short flight simply wants a proportionally gentler arrival. A floor on a
visible length and a floor on a derivative are not the same kind of decision.

### What the tests assert, and the one that was measured and then not written

Every new assertion is a **ratio of the flight against itself**, measured on the drawn SCREEN path,
never a restated constant — the same discipline volume 60 arrived at after its bow assertion
passed in the ground plane while the drawn path was 0.5 px off a straight line.

- The **last quarter of the clock covers more ground than the whole first half** (at `ACCEL = 1`
  it reads 0.39 / 0.31, the wrong way round).
- The flight's **fastest instant is its arrival**. Strictly stronger than the next one: "beats its
  own average" still passes for a curve that peaks at 60% and is merely *still* quick at the end.
- **Final speed > 1.5× its own average** — the assertion that catches the warp and the geometry
  disagreeing.
- The drop **has stopped running away by 60% of its clock, at every distance on a 1/5/10/15/28/60/
  120 px ladder**. This is the floor defect above, and the reason it got through the first time is
  worth keeping: no hand-picked "typical" distance covers the sizes where all three floors exceed
  the whole flight.
- **`PickupFlightLayer` drives `flightPose` with the RAW clock fraction.** The acceleration gave
  the layer and the curve a way to disagree that neither sees alone — a layer that also warped what
  it passes would still start at the drop, end on the body and accelerate, with every other
  assertion green, while running a curve nobody designed.

**A sixth was measured and deliberately not written.** Keying `scale` to the clock instead of the
path survives the whole suite. Measuring it is what settled the question: the swell's peak moves by
2–28% of the path, which is not a property anyone can see. A test for it would have pinned the
mutant rather than the motion — the failure mode `design/18` Layer 4 keeps naming, arrived at from
the other direction for once.

Two existing tests had to stop measuring the arc against the wall clock, which under `ACCEL` is a
different statement from measuring it against the path; both now say what they were always about
("at the top of its arc **while still near where it lay**"). One `Scene` case's absolute bound was
loosened and given the ratio it was really asserting — most of its 20-odd px was always the
collector's chest height, and the arc's tail moved when the flight learned to arrive at ~790 px/s.

### Numbers

Nine-mutation battery, all nine killed (tests red): `ACCEL = 1` **18**, `ACCEL = 1.4` **7**,
`LEAD_R = 0` **10**, lead floored at 14 **2**, hop on the clock **6**, fade on the clock **1**,
layer double-warp **1**, `LEAD_MAX = 5` **7**, `u = t` at the source **18**.

Verified in the running game and not only in the pure function: the real `PickupFlightLayer`
driving real `Pickup` views through `Entity`'s own projection, sampled per 60 fps frame, plus a
strobe of both curves drawn into a live room.

| 120 px flight | first | middle | arrival | frames |
| --- | --- | --- | --- | --- |
| before | 6.1 px | 5.4 px | **1.1 px** | 35 |
| after | 0.8 px | 2.2 px | **13.5 px** | 25 |

28 px, the auto-collect case: before 4.2 → 1.3 → **0.3**; after 0.6 → 1.5 → **3.5**. Both new
cases end on their own maximum.

Client 6,822 → **6,835** green; engine 1,599 and server 1,881 untouched. No engine change and no
`ENGINE_VERSION` bump — this is render-only feedback drawn after the sim has already applied the
pickup, the same standing that volume 60 established.

### Still open

- `LEAD_MAX` (55 px) binds only above 110 px, and a flight that long needs the collector to have
  been moved by the sim between the drop landing and the frame being drawn — the case
  `TARGET_TELEPORT_PX` already ends at 120 px. It is a guard rail with almost no reachable ground
  between it and the guard beside it, and it is untested for that reason. Worth deleting if a
  future pass can show the gap is empty rather than merely narrow.
- The residual short-flight wobble (a 1–5 px flight still turns around near t = 0.55) is
  `POP_BACK_MIN` and `BULGE_MIN`, not the lead — pre-existing, deliberate, and the price of floors
  that keep the 28 px case visible. Named here so the next probe does not rediscover it as new.
