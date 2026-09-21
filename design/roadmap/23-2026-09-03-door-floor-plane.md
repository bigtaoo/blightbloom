# Work log — 2026-09-03: the floor a door lights

Volume 23, and the fifth pass of the same day — 16 and 17 were doc audits, 18 gave the doors a
clock, 22 stopped the kerb doorways hanging a slab of cap stone over themselves. This one is the
other half of 22's lesson: a door fixture had a second claim about the ground around it that only
held for half the doors.

Indexed from [`../ROADMAP.md`](../ROADMAP.md).

## The floor a door lights is not always south of it (2026-09-03d, client only, no engine bump)

Live report, with a screenshot of a locked doorway and a red circle drawn under it: *"门的这个特效
下面的光圈被挡住了，是故意的，还是层级算错了？"* — the light ring below the door's effect is covered
up; is that deliberate, or is the layering wrong?

Neither, as it turned out, and that is the interesting part. **Nothing in the fixture's paint order
was wrong, and the stone in front of the ring was sorting correctly.** What was wrong was one
sentence's worth of geometry, stated three times over in `doorLights.ts` and `doorFx.ts` and true
for 11 of the 24 shipped doors.

### The claim that was false for 13 doors

Every floor-level layer a door draws — both states' graduated pools (`GLOW_POOL`), the travelling
`drawPulse` ring, the lock-change `drawBurst` — was drawn from the threshold **southward**, on the
assumption that the ground in front of a doorway is room floor. `strokeFloorArc`'s own doc even
argues the case for drawing only the southern half: a full ellipse *"put their northern halves
straight up the door's own stone."* Correct, and it is exactly half the picture.

A door's passage AABB is a hole in a wall, so its short axis is the wall's own thickness. For the
shipped content that is two shapes, and the fixture treats them as one on purpose (see
[`../rendering/04-doors.md`](../rendering/04-doors.md) — a door needs no
orientation branch because a lintel's mass lands where a wall block's cap lands either way):

- **11 doors are `128x64`** — a hole in an EAST-WEST wall, crossed north-south. South of the
  threshold is room floor. The pool belongs there, and every swept constant in `doorLights.ts` was
  measured on one of these.
- **13 doors are `64x128`** — a hole in a NORTH-SOUTH wall, crossed east-west. South of the
  fixture's base line is **the same wall continuing**: `wallRuns.bordersDoorNorth`'s relationship,
  32-320 px deep, covering all 64 px of the fixture's width. `blockCapTop`'s `doorClip` puts that
  run's cap top **exactly** on the door's threshold, and the run Y-sorts after the door
  (`Entity.zIndex` is the ground y; the run's is its own south edge, the door's is the passage's).

So on those 13 the decal was painted onto stone that then drew over it. Measured on the shipped
floors, per sampled ring point: **29-33% of a ring inside a wall run at `rx = w`, and 86-90% of it
at `rx = w/2`** — most of a ring, most of the time. The only part that escaped was the outer lobes
poking past the 64 px-wide wall, which is precisely the pair of arcs the screenshot circled.

**The gap was one section over from a sweep that had already measured this exact relationship.**
`doorSpillCoverage.test.ts` (2026-08-20) walks every run bordering a door to the north and pins
that its art never spills onto the door — 12 real cases across the five floors. Nobody asked the
mirror-image question: what does that run's cap, clipped flush to the threshold, cover *of the
door's own* layers? The fixture's art was safe; its floor decals reached 40 px past the fixture's
footprint into that block's sort band.

### The fix is one plane, not an orientation branch per layer

`doorLights.DoorFloorPlane` — where a door's floor decals lie and which part of them is on real
floor — under one rule: **a floor decal lies on the floor the fixture's own stone is not standing
on.**

- `south` (`w > h`): centre on the threshold, southern half only. **Byte-identical to what
  shipped**, because those 11 doors always read correctly.
- `sides` (`w <= h`): centre at the passage's own mid-depth, and the ring becomes its two side
  lobes with the wall's thickness skipped — physically an interrupted ring, which is what a ring
  around a doorway in a wall you can see the sides of actually looks like.

`w <= h` is the discriminator `floorRender.drawDoorWear` already uses for the worn patch across a
doorway (travel is along the passage's short axis), so the two floor-level door decals now agree
about which way a door faces instead of disagreeing silently.

One property came free and is worth naming: a `sides` ring narrower than the wall's half-thickness
draws **nothing at all**, so a locked door's inward pulse now shrinks into the doorway and vanishes,
and an open door's grows out of it. `doorFx`'s own "locked motion is CONTAINED, open motion CROSSES
the threshold" reads more literally than it did when both were drawn on the room floor regardless.

`strokeFloorArc` moved from `doorFx.ts` to `doorLights.ts` with it: the plane is that file's, three
callers now share it, and it keeps `doorFx.ts` inside the 500-line convention.

### Measured, on the reported door

A live frame of floor 0's `64x128` locked door at `(1504, 288)`, player standing at the passage,
`renderer.extract` A/B'd against the same frame with the fixture's floor layers hidden — mean luma
over 8-10k px regions:

| region | floor alone | old geometry | fixed |
| --- | --- | --- | --- |
| floor west of the wall, mid-passage | 57.96 | **0.00** | **+10.96** |
| floor east of the wall, mid-passage | 49.25 | **0.00** | **+9.44** |
| the band south of the threshold (that run's cap) | 38.98 | **0.00** | 0.00 |
| floor just south-west of the threshold | 39.92 | **+4.85** | 0.00 |

The old pool contributed **zero** everywhere except a 4.85-luma sliver on the floor beside the cap —
the arcs in the screenshot were the whole of its visible output. The fix spends that light on the
two floors the player actually approaches from, and nothing on stone.

Two traps in getting those numbers, both of the "the reader lies rather than errors" kind
`design/01`'s frame-sampling notes are about: `extract.pixels(app.stage)` returns an image of the
**stage's bounds**, not of the screen (5189x2941 here), so a screen-space mapping reads a uniformly
black region and reports a delta of 0 for everything; and Pixi emits a `moveTo(0, 0)` of its own
ahead of every `circle` after the first, so reading a Graphics's path points without filtering to
`stroke` instructions picks up one phantom origin point per mote — which is what the pre-existing
"both rings stay south of the threshold" assertion was passing on.

### Tests

`doorFloorPlaneCoverage.test.ts`, nine cases, on the five shipped floors through `RoomBuilder`'s own
pipeline rather than a fixture:

- every `sides` door, radii swept 0.3w to 1.65w (`drawBurst`'s widest): **not one point** inside a
  wall run, not one outside every room. 13 doors, >5,000 sampled points.
- every `south` door: the plane's geometry `toEqual`s the pre-plane geometry point for point, so
  the 11 that were right did not move. Their own residual is **bounded, not fixed**: a southern
  half-ellipse terminates on the wall line it is cut into, so at most 19% of a ring sits in the
  flanking runs' footprints and at most 29% reaches past the room's floor edge at the burst's
  widest. Clipping a decal that legitimately spans two rooms needs the room rects threaded into the
  fixture — a separate pass; the bound is there so the residual cannot grow unnoticed.
- the inverse run: the old plane's shares (>0.25 at `rx = w`, >0.8 at `rx = w/2`) asserted **as
  failures**, on all 13. Without it every case above passes against the code that shipped the bug,
  because 11 of the 24 doors satisfy them either way.

Plus one `doorFx.test.ts` case that the fixture's own rings read the plane (no assertion on
`strokeFloorArc` can show the wiring), and the `pathPoints` filter above. **152 door tests green,
4,836 client tests green** as of 2026-09-03.
