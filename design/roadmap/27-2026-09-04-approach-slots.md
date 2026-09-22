# Work log — 2026-09-04: a mob walks to its own spot

Volume 27, and the direct sequel to 20. That pass gave a mob a size for standing still; this one
is what the reporter said the next day, once they had watched it.

Indexed from [`../ROADMAP.md`](../ROADMAP.md).

## The standing volume becomes the destination (2026-09-04, engine, `ENGINE_VERSION` 56)

Live report, 2026-09-04: *"the standing volume you gave the mobs in pathfinding yesterday works well overall. One detail: I want it taken into account when setting
the pathfinding destination. Today the mobs run together first and then spread out; I want it right in one step."*

v55 shipped the standing volume (`standoffRadius`) and a pass that drifts two arrived mobs apart
(`MovementSystem.resolveStandingSpacing`). What it did not do is tell any mob where it was going.
`AIDecideSystem.chaseAndEngage` aimed every mob at the same point — the player — and stopped it
wherever it happened to cross the engage ring, so a garrison still converged into one silhouette
and then unpacked over the following half second. The volume was a correction applied to the
destination and never an input to choosing it. That half second is the whole report.

### Every mob gets its own point on the ring

`engine/systems/approachSlots.ts` (new, 330 lines, form ① of CLAUDE.md's split order — free
functions, no state, no class) computes one destination per chasing mob per tick. Mobs are
bucketed by `roomId`, the same aggro unit the fire budget already uses, and placed in priority
order; each takes its own bearing from the target if nothing has claimed it, and the nearest free
angle otherwise. Four rules keep it a spot rather than a slot number:

- **A mob keeps the angle it already has unless someone else has claimed it.** There is no global
  slot grid on purpose: quantizing to one would make a LONE mob slide half a slot sideways on
  arrival for no reason a player could see. One mob against one player walks in exactly the
  straight line it walked in v37, which `approachSlots.test.ts` states as its first assertion.
- **Arrived mobs claim first** (`holding`, then array order = ascending id = spawn order), so a
  mob standing somewhere keeps standing there and the newcomer routes around it, rather than the
  two swapping places because the newcomer happened to spawn earlier.
- **A spot is never further from the target than the mob already is.** The ring is a place to
  stop closing, not a place to retreat to; otherwise a mob the player walks up to backs off to
  its engage range, and this is not the pass that adds kiting.
- **A mob never walks round the player, or into a wall, to find room.** The search is bounded to
  a quarter circle either side of the mob's own bearing — past 90° the straight line to the
  destination starts cutting across the player rather than curving around them — and past that
  the mob is placed one ring further out, so a crowd forms an arc and then a second arc behind
  it. And `pathIsClear` refuses a spot the mob cannot reach in a straight line, falling back to
  the radial approach.

That last fallback is not a nicety, it is what keeps **v55's own example** working. A mob standing
in the mouth of a 1.5-body slit claims the bearing straight through it, so the mob behind is
offered a spot 21° off — and the straight line to that spot ends in the wall. Without the check
the traveller presses against stone forever and the slit is impassable, which is the exact
regression the previous report was filed about. `enemySpacing.test.ts`'s 45 px gap case caught it
before it could ship.

### Two things fell out of the measurement, not out of the design

**Arrival is hysteretic.** A spot is anchored to the target, so it moves when the player does, and
with a single one-step tolerance every arrived mob shadows the player step for step at its engage
range. That is a different game and a measurably harder one: `test:pve-sim` put the careful bot's
average floor at **0.5** against a 1.3 baseline before the deadband went in. A mob that is already
stopped and in range now only sets off again once its spot has moved a whole standing volume away;
one already walking carries on to within a step of it. Keyed off the mob's own `vx`/`vy`, so no new
state field and nothing new to serialize.

**"Stop and shoot" stays literal.** Since v56 a mob can be inside its engage range and still
sliding round to its spot, so in range and stopped are no longer the same thing. Only a stopped mob
contends for a fire slot; the alternative is a garrison opening fire while it is still arranging
itself, which is v40/v41's alpha strike in a new costume.

`resolveStandingSpacing` is unchanged except for its gate — holding **and stopped**. A mob still
walking to its spot is already resolving its own spacing, and pushing it as well moves it two
walking speeds in one tick, breaking the per-actor cap that is the whole reason that pass is a
shuffle rather than a shove. It is not left with nothing to do: the ring separation is an arc and
two mob centres are a chord apart, so a pair arrives about 14 fp (under half a pixel) inside the
standoff and the correction closes it — plus everything a destination cannot predict, which is
knockback, a player shouldering through a crowd, and mobs steered onto the same bearing because
geometry left no route to a spread one.

### The cost, measured

`test:pve-sim`, 24 seeds (widened from the shipped 8 for the measurement; the 8-seed gates all
still pass on the shipped set):

```
careful bot      avg floor 1.3 → 1.0  ·  avg kills 94.8 → 68.4  ·  extracted 0% both
aggressive bot   avg floor 0   → 0    ·  avg kills 16.7 → 15.8  ·  extracted 0% both
```

Same direction and the same cause as v55: a spread arc is a crossfire where a blob is one bearing
that can be dodged as a unit. Damage TAKEN per second did not move (worst 1 s window 6 both ways,
average 4.5 → 4.2) — the player kills slower and bleeds for longer. Left as measured rather than
compensated for, for the same reason v55 gave: the dial is `ROOM_FIRE_BUDGET`, and moving it is a
difficulty decision rather than part of a legibility fix.

The golden gate's ember scenario says the legibility half out loud: over the same 1500 ticks the
bot fires **19 fewer bullets**, kills **one more mob**, and finishes on more HP. Spread mobs are
individually shootable — an arc and a straight shot both land on one body instead of being spent
on a stack.

### Coverage and the battery

12 new tests in `approachSlots.test.ts` for the cases composition cannot reach or reaches only by
luck (the second ring, the deviation cap, the walled-off fallback, the pillar, the per-room
buckets, the last-resort spot), plus six restagings in `enemySpacing.test.ts` where v55's
assertions described behaviour this pass deliberately changed — most of them because a mob no
longer arrives where it used to. The one worth naming is the traveller test: it used to assert
that a chaser's route past a stander is **bit-identical** to the same route through an empty room,
and that is now false by design. The standing volume is an input to where the chaser is walking.
What it must still cost the chaser is nothing — not a pixel of speed, not a pixel of the
stander's position — and that is what the test measures now.

**17 mutants, golden gate excluded on purpose** (every mutant moves a recorded hash, so including
it reports ALL-KILLED while saying nothing). 15 killed on the first run, and the two survivors
wanted opposite things:

- `radial = Math.min(base, away)` → `base` survived, and it was a real gap: the no-retreat rule is
  enforced on every ring but the LAST-RESORT spot, and nothing tested that path because reaching
  it takes four mobs pressed against the player — each ring's claims are its own, so the second
  takes ring 1 and the third ring 2 before the fourth has nowhere left to go. Now tested; the
  mutant dies.
- The quarter-circle clamp in `halfWidthAt` survived because it is **inert**: `nearestFreeAngle`
  already refuses any candidate further than `MAX_SLOT_DEVIATION` from the mob's own bearing, and
  every candidate a quarter-circle-wide claim generates is past that. Deleted rather than tested —
  a guard that reads as load-bearing and is not invites the next reader to assume `half` is
  bounded when nothing enforces it.

One unrelated fixture moved with the sim: `client/sim/replay/inspect.test.ts` pins a mark at the
tick a recorded run has a live drop on, and mobs dying at different times moves it (70/#25 →
90/#31). The comment now says it is measured and how to re-measure it, because the anti-vacuity
check that caught it is the whole value of that assertion.

See `engine/ENGINE_VERSION_HISTORY.md` v56, `design/05-gameplay.md` "Standing room" and
`design/07-collision-combat.md` step 4.4.
