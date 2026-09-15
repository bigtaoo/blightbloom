# Work log — 2026-09-11

Volume 55. See [`design/ROADMAP.md`](../ROADMAP.md) for the index and the phase spine.

## A door's halo runs the way the door does (2026-09-11, client only, no engine bump)

> *"这个椭圆的长边要和门的长边保持一致。"*

A screenshot of a passable door, with its floor halo circled: the ellipse's long axis has to run
the same way the door's does. It did not — and only on the 13 doors cut through a north-south
wall, which is 13 of the 24 shipped.

### What was wrong, as the two boxes

Every floor decal a door draws — both states' nine-ring pools, `doorFx`'s travelling pulse, the
lock-change burst — was an ellipse squashed by `GLOW_POOL_SQUASH = 0.46`, the foreshortening every
round thing in this view shares. That constant is correct for a circle lying on the ground, and it
is what the 11 east-west doors want: their opening is 128 x 104, wider than it is tall, and their
widest pool ring is 171 x 79 — long axis along the door's long edge, rule already satisfied.

The other 13 are holes in a north-south wall. Their drawn arch is **64 x 94.5** (`doorLeafFrame`
fits 217 rows of leaf art to a 64 px opening), i.e. half again as tall as it is wide — and they
were wearing the same 0.46: a widest pool ring of **95 x 44**, lying across the door. The one shape
the player is asked to attach to a doorway was elongated along that doorway's SHORT edge.

### The fix is the door's own proportion, and it is also the content's ceiling

`DoorFloorPlane` now carries an `aspect` — the y semi-axis per unit x semi-axis of every ring on
that plane. `south` keeps `GLOW_POOL_SQUASH` exactly, so none of the numbers swept on those doors
(the ramp's alpha, the pool's +4.0 luma) moves by a pixel. `sides` gets `ringAspect(openingW,
drawH)` = the drawn opening's own height over its width, **1.48** on every shipped door of that
shape: widest pool ring **95 x 140**, long axis along the door.

The x semi-axis is deliberately untouched. A `sides` ring narrower than the wall's own
half-thickness draws literally nothing (`floorArcSpans`), so the aspect is spent entirely on
height — the reach onto the flanking floor, and every clamp measured against it (`ringTravel`'s
start at the wall face), is exactly as it was.

**The ceiling was measured, not assumed.** A taller `sides` ring spends its extra height running
ALONG the wall it comes out of, where the hazard is not that wall — the lobes are drawn clear of
its thickness — but the PERPENDICULAR run at the end of it, and the content decides how far away
that is. Swept over the five shipped floors at the widest radius anything strokes (1.65 x span):

| aspect | doors stroking into stone |
|---|---|
| 1.48 (the drawn door's own) | none |
| 1.60 | none |
| 1.65 | 3 of 13, at 2.4-4.8% of their points |

So the literal reading of the report is also inside what these floors allow, with ~8% to spare.
Both sides of that bound are now a test, so a future "make it taller" lands on a red check rather
than on a ring crossing masonry.

### The gap a mutation battery found — in the layer the report was pointing at

13 mutants, 0 survivors at the end. The one that mattered was a survivor first:

**`drawPulse` handed `{ ...this.plane, aspect: GLOW_POOL_SQUASH }` left all 1383 scene tests
green.** The travelling pulse and the lock-change burst ARE the two arcs the screenshot circled,
and the fixture-level tests around them measured only their horizontal reach — the 2026-09-04 pass
pinned how far a ring travels and nobody had asked how tall it is. `doorFx.test.ts` now reads the
y-reach back off the stroked geometry and holds it to an equality: a ring's own `rx` is the widest
`|x - cx|` it draws, and its y-reach is then fixed at `ry * sin(acos(cx / rx))` on a `sides` plane
(the lobes are cut off before the ellipse's extreme y, which is where the wall stands) and at `ry`
itself on a `south` one. Every Graphics that strokes a ring is checked, not the widest — the pulse
and the burst are separate ones — with a `south` fixture as the control, so "just stretch every
ring" fails too.

Two more mutants worth naming, both killed: the aspect read off the **passage AABB** instead of the
drawn opening (2 instead of 1.48 — the exact confusion the 2026-09-04 report was about), and the
pulse stretched by a **constant** 1.9 rather than by the door's own proportion, which would look
right on this door and wrong on the next size.

Honest note on the battery itself: its first run reported all six mutants SURVIVED, and that was
the harness — `--reporter=basic` does not exist in vitest 4, so every run died before any test and
a missing summary line was scored as a survivor. The tell was that the **baseline** survived too.
The harness now throws when it cannot parse the baseline.

### Verified by looking, not only by the gates

Per this repo's standing rule for anything visual, the frame was pulled out of the running game
(`extract.canvas` on `layers.root`, POSTed to a scratch receiver) rather than reasoned about: a real
open door on floor 0, player in the doorway, pulse mid-flight. The two arcs now run vertically down
both jambs instead of bulging sideways.

### The 500-line convention paid for itself here

`doorLights.ts` reached 534 lines with the new rule documented, so the floor-plane block came out
into `doorFloorPlane.ts` (CLAUDE.md form 1 — independent function modules): where a door's floor
decals lie and what shape they are, with `doorLights.ts` down to 299 lines and re-exporting every
moved name, so `doorFx.ts`, `doorRender.ts` and the four door test files see no change at all.

`render` `test` `docs`
