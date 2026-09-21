# Work log — 2026-09-04: the ring belongs to the door

Volume 24, and the direct sequel to 23. That pass made a door's floor rings visible on all 24
shipped doors; this one is what the reporter said once they could see them.

Indexed from [`../ROADMAP.md`](../ROADMAP.md).

## A door's ring belongs to the door it lights (2026-09-04, client only, no engine bump)

Live report, screenshot of the same locked doorway with the ring circled in red: *"the circles do all show
now, they just sit a little high — can you put them at the door's centre? And some doors are big and some small, so the ring had better follow the door's size
and scale with it"* — the circles all show now, they just sit a bit high; can they go at the centre of the
door, and scale with the door's size?

Two complaints, one root cause. Every number that placed or sized a door's floor decals came from
the **passage AABB**, and the passage is not the thing on screen. The passage is a hole in a wall,
`64x128` or `128x64`; what the player calls "the door" is the arch drawn standing on its southern
edge, `openingW` wide and `leafHeight` tall.

### The centre: half a passage is not half a door

`doorFloorPlane`'s `sides` branch centred its decals at `-r.h / 2` — half the passage's 128 px
depth, 64 px up-screen from the threshold. That is the geometric middle of the hole, and it is not
where the door looks like it is:

| what | value |
| --- | --- |
| passage depth (`r.h`) | 128 px → old centre at **-64.0** |
| drawn leaf height (`leafHeight(64, DOOR_H, leaf)`) | **94.5** px → its middle at **-47.24** |
| the gap | **16.8 px**, on all 13 `64x128` doors |

94.5 rather than the wall's own height because `RoomBuilder` builds every door at `DOOR_H` and
`doorLeafFrame` fits the art by width without squashing: 217 rows of leaf art at a 64 px opening
want 94.5 px of height, and the lintel takes the rest. A sixth of the fixture's height, which at
the reporter's zoom is some 60 screen px — comfortably "sitting high".

`cy` is now `-min(drawH, r.h) / 2`, the drawn opening's own mid-height, clamped into the passage so
an arch taller than the hole it stands in cannot push its decals out the far side of it. The
`south` plane is untouched: for a door in an east-west wall the drawn opening meets its floor AT
the threshold, which is exactly where its ring was already centred, and every swept constant in
`doorLights.ts` was measured there.

### The size: proportional, and still far too big

The second half of the report is the more interesting one, because the rings **were** already
proportional to the door. Every radius was a multiple of `openingW`, so a 64 px arch and a 128 px
one got the same multiple — what varied was only what they were multiples of:

| ring | multiple | across, in door widths |
| --- | --- | --- |
| widest `GLOW_POOL` fill | 1.35 | **2.7** |
| `doorFx.drawPulse` at full travel | 1.30 | 2.6 |
| `doorFx.drawBurst` at full travel | 1.65 | 3.3 |

A ring two and a half door-widths across is out in the middle of the room, far enough from its own
fixture that the eye stops attaching the two — and the explanation a viewer reaches for is "it must
be a fixed size". So the wrong quantity was being defended: the proportion was right, the **reach**
was not. Rather than guess, three reaches were put to the reporter (1.4, 2.0, keep 2.6 and only
re-base the size on the drawn box); they picked **1.4**.

`doorSpan(openingW, drawH)` is now the multiple every ring is taken against:

```ts
RING_REACH * Math.min(w, Math.sqrt(w * drawH))   // RING_REACH = 0.55
```

- **The fraction** is the whole of the fix the reporter asked for. 0.55 puts the widest pool ring
  at ~1.49 door widths on a `64x128` door and ~1.34 on a `128x64` one.
- **The size it is a fraction of** is the drawn box, not the width. The 11 `128x64` doorways are
  cropped shorter than they are wide (217 rows fitted to 128 px want 189 of height; they get the
  wall's 104), and were wearing the halo of a square door. The geometric mean says so. The `min`
  clamps it back to the width for a TALLER-than-wide door, because there the opening the light
  comes through is what should size the pool, not how much wall happens to stand above it.
- **The alphas are untouched** and their measured luma figures still hold where they were taken:
  the pool is the same nine rings at the same alpha each, so its peak — all nine overlapping, at
  the doorway — is unchanged. What shrank is how far the outermost ones spread.

### The consequence that had to be handled, not accepted

A `sides` ring draws nothing while it is narrower than the wall's own half-thickness (32 px) —
`floorArcSpans`, and the reason volume 23's locked pulse "shrinks into the doorway and dies there".
At the tightened reach a 64 px arch's entire `0.35..1.3` pulse sweep runs from 12.3 px to 45.8 px,
so most of the travel would have finished inside those 32 px and the pulse that volume 23 made
visible would have gone straight back out again. Sampled over 21 steps of the sweep: **9 of 21**
would draw anything at all.

`doorLights.ringTravel` starts a travelling ring at the wall's face where the plane has one:

```ts
const start = Math.max(plane.span * from, plane.floor === 'sides' ? plane.cx : 0);
```

**20 of 21** steps draw now. It moves the start of the journey and not its end — the reach is
unchanged, `ringTravel(plane, 0.35, 1.3, 1) === plane.span * 1.3` — and it keeps exactly what the
`rx <= cx` clamp is for: a ring that EMERGES from the doorway rather than appearing over it.

### Measured on the live fixture, not on a test double

Read back off the running scene graph (`__game.roomBuilder.doorFixtures[0]`, floor 0's locked
`64x128` door at `(1504, 288)`, leaf drawn `64x94`), which is the same instrument volume 23 used
and the only one that can catch a fixture whose parts are individually right:

| what the fixture draws (after: read live; before: the same fixture's old constants) | before | after |
| --- | --- | --- |
| pool ellipse centre | `(32, -64.0)` | **`(32, -47.2)`** — the drawn leaf's own middle |
| pool `rx` / `ry` | `86.4` / `39.7` | **`47.5` / `21.9`** |
| pool across, against a 64 px door | 172.8 px (2.70x) | **95.0 px (1.49x)** |
| pulse lobes' mean y | -64.0 | **-47.22** |

### Tests

`doorFloorPlaneCoverage.test.ts` re-runs its entire sweep at the new radii — the 13 `sides` doors
still put no ring point inside a wall run or over void at any radius from 0.3 to 1.65 of `span`,
and the 11 `south` doors stay inside the bounds volume 23 set (<=19% in stone, <=29% over void, and
point-for-point identical to the pre-plane geometry). Three cases were added for this pass, each
with the superseded value asserted as wrong so none of them can pass against the code that shipped
it:

- the centre, against `-r.h / 2`;
- the reach in door widths (1.25 < across < 1.55), against the old 2.7;
- the travel clamp (>=19 of 21 sampled steps draw, against <10 for the raw multiple).

`doorFx.test.ts`'s north-south-wall case now pins the lobes' mean y on `plane.cy` — the lobes are
symmetric about it, so the mean is exactly the centre — plus `cy === -OPENING_H / 2`.

One shipped claim changed and its test with it. `doorRender.test.ts`'s kerb-door case asserted
that a kerb door gets *"the biggest pool of all, which is what has to carry it"* — true when the
pool was sized by the passage width alone. It is now sized by the drawn opening, so a fixture
whose leaf is cropped to 22 px gets a bit under half the pool the full-height door of the same
width does. The case still holds the part that matters (the pool must still be a pool and not a
hairline: it reaches more than `WALL_H_KERB / 2` south of the threshold) and now also pins the
ratio, so shrinking WITH the door cannot quietly become vanishing with it. Measuring it needed a
different reading, too — `getLocalBounds().width` is the OPENING's width once the pool is narrower
than the doorway, so the assertion reads `maxY`, which only the pool contributes to.

### The battery, and the three survivors that were all one blind spot

25 behaviour mutants over the three files this pass touched (`doorLights.ts`, `doorFx.ts`,
`doorRender.ts`), run against the eleven door/RoomBuilder suites, plus 2 deliberately inert
controls. First run: **18 killed, 7 survived, 0 skipped**. After the tests below, **25/25 killed,
with both controls still surviving** — which is what says the harness was measuring rather than
faking (a battery with no survivors is untrustworthy until an inert mutation proves it can report
one). Baseline green before and after, revert in `finally`, `DEVNULL` on both streams.

**Three of the seven were the same blind spot, and it is a shape worth naming: an oracle that
calls the production function is not an assertion.** `doorRender.test.ts` finds each light layer
by DIGEST — it builds the expected Graphics by calling `drawGlow`/`drawSpill` itself and matches
the fixture's child against it. That pins *which layer is where and whether it is visible*, which
is what it was written for, and it cancels every geometric property out of the comparison: both
sides move together. So the pool — nine ellipses, the layer the reporter was actually looking at,
since the stroked pulse is two thin arcs — had **no assertion on its centre, its radii or its
foreshortening anywhere in the repo**. The mutants that walked through: all nine rings at one
radius, the pool ignoring `plane.cy` (i.e. the reported bug, in the layer that carries it), and
the squash dropped so the pool stands up in the air like a hoop. `doorFloorPlaneCoverage.test.ts`
now reads the `ellipse` calls back off the Graphics and pins all four numbers per ring, that the
radii are strictly graduated, and that both states draw the identical family (the "one symbol,
colour says which state" claim, which nothing had checked either).

The other four:

- **`drawPulse`/`drawBurst` restored to the pre-plane `openingW * (...)` radius survived.** The
  fixture-level tests pinned where the ring is and which way it travels, and the coverage sweep
  computes its own radii before calling `strokeFloorArc` — so nothing anywhere asked what `doorFx`
  chooses, i.e. **the reach this whole pass is about was unpinned at the only layer that ships
  it**. `doorFx.test.ts` now walks a full pulse period and the burst's transition and bounds the
  widest ring drawn by `plane.span * 1.3` / `* 1.65`; the old arithmetic reaches 83.2 and 105.6 px
  on that fixture against 45.8 and 58.1.
- **`ringTravel`'s end guard survived** — a `sides` door whose leaf is cropped shorter than half
  its opening is wide has a span whose 1.3x lands inside the wall's own half-thickness, and
  without the guard its outward pulse runs backwards. No shipped floor can reach it (`DOOR_H` for
  every door), so this is the *missing fixture* ending rather than the missing assertion one:
  `doorFloorPlane(SIDES, 8)` is that door, and the case asserts the case is real before asserting
  the behaviour.
- **`thresholdPlane(w)`'s defaulted `drawH` survived** — the fallback `drawGlow`/`drawSpill` use
  when a caller has no passage rect. Zeroing it collapses all nine rings onto a point with nothing
  else red. Now pinned as `doorSpan(w, w)`, plus the pool a no-plane call actually draws.

Everything else died, including the two that matter most: the shipped bug itself (`cy = -r.h / 2`)
and the fixture handing the plane the passage's depth instead of the leaf's drawn height.

Client suite green at **4842** tests, client `tsc --noEmit` clean, `check:filelength` and
`check:docpaths` clean. (The root `npm run check` is red on `engine/content/weapons.test.ts`, an
untracked file belonging to a concurrent session in this shared tree — no engine file is in this
pass's diff.)
