<!-- Split from design/18-test-strategy.md (2026-09-21): why the doc was written, the BEFORE
     snapshot, the six named gaps G1–G6, and the Layer −1–3 plan that closed them.
     What each of those layers became is in
     [01-the-layers-as-built.md](01-the-layers-as-built.md).
     The index is [../18-test-strategy.md](../18-test-strategy.md). -->

# Test strategy, part 2 — the six gaps, and the plan that closed them

Part 2 of [`design/18-test-strategy.md`](../18-test-strategy.md). This is the original
2026-08-30 document: the state of the tree before any of it, the six gaps `G1`–`G6` that code
comments cite by number, and Layers −1 through 3 as planned.

## Why this doc exists

Two changes prompted it, and they are the same shape:

- changing how far a wall or a pillar blocks an actor (`WALL_NORTH_BRIM` 16 → 23 px, and
  enemies moving from `footprintRadius` to `radius` for wall clearance — both in v48);
- changing where a bullet is born (`muzzleOffset` in the sim, the drawn barrel tip in the
  renderer).

Both are one-line edits to a constant. Both are read by code that does not import that
constant, or that re-derives the same rule independently, or that only agrees with it by
a comment. "不同步" means two different things here and this doc treats both:

1. **Replay / netcode divergence** — two clients on different builds compute different
   states from the same inputs. The engine's defence is `ENGINE_VERSION` + the
   `ReplayInputSource` mismatch guard. The bump itself is a human judgement call today,
   backed by no test.
2. **Internal disagreement** — two systems in the *same* build answer "is this blocked"
   differently, or the renderer draws a boundary the sim does not enforce. This is the
   larger and less visible half.

## Where we were before this work

The BEFORE snapshot, kept as the baseline the sections below are measured against. Current
numbers are in the status block at the top.

| Workspace | Test files | Tests | Wall clock |
|---|---|---|---|
| `engine` | 55 | 885 | 1.9 s |
| `client` | 193 | 3739 | 11.6 s |
| `server` | 13 | — | — |
| `tools/*` | 51 | — | — |

`npm run check` = `typecheck` → `check:filelength` → `check:wechatpackage` → `test`.
Three suites are **outside** that: `test:pvp-sim`, `test:pve-sim`, `audit:arena` (the
`.sim.ts` suffix is invisible to the default glob, deliberately — they run real
multi-minute bot games).

Real strengths worth keeping and copying:

- **The `*Coverage.test.ts` sweep idiom** (8 files in `client/src/game/scene/`): build
  the *real shipped content* through the *real pipeline*, rasterize at 8 px, compare the
  unit under test against an **independently derived oracle**, assert two-sided aggregate
  bounds, and always assert the sweep was non-empty (`expect(pairs).toBeGreaterThan(50)`)
  so it cannot pass vacuously. Failures accumulate into a `string[]` and land as
  `expect(list.slice(0, 8)).toEqual([])` so the message is readable.
- **Cross-package constant imports already happen — in tests.**
  `client/src/game/scene/occlusion.test.ts`, `occlusionCoverage.test.ts` and
  `arenaWallCoverage.test.ts` all import `PLAYER_BASE` and `WALL_NORTH_BRIM` from
  `@dd/engine` and close a loop the source files leave open. The mechanism exists; it is
  just not applied systematically.
- **A real end-to-end level sim** (`client/sim/pve/levelSim.ts`) that plays the five
  shipped ember floors with a bot, and asserts reproducibility (`runLevel(seed)` twice →
  `toEqual`).

## The six gaps

**All six are closed.** They are written in the present tense of 2026-08-30, *before* the work,
and kept that way on purpose: the evidence is what makes each one re-checkable, and rewriting
them into the past would leave a list of claims with nothing behind them. What closed each is
in `What shipped` in [the index](../18-test-strategy.md) and in
[What v49 fixed](03-what-each-version-fixed.md#what-v49-fixed).

### G1 — "Golden replay" never compares against a recorded value

Every determinism assertion in the repo builds **two runs in the same process** and
compares them to each other: `engine/replay.test.ts` (4 sites), `dungeonrun.test.ts`
(2), `netinput.test.ts`, `framebroadcast.test.ts`, `coopsession.test.ts`,
`tutorialConfig.test.ts`, `GameEngine.test.ts`'s `snap()`. There is no
`__snapshots__` directory and no recorded-hash fixture anywhere in the tree.

`replay.ts`'s own comment states the consequence plainly, as a reason a field was safe to
add: *"the golden-replay test compares two independent runs, so a new always-equal field
never breaks it."*

So: **change `WALL_NORTH_BRIM`, `solidRadius`, `muzzleOffset`, or the step order, and
every one of those tests still passes.** They catch nondeterminism. They cannot catch a
behaviour change, which is exactly what obliges an `ENGINE_VERSION` bump.

### G2 — Nothing ties `ENGINE_VERSION` to anything

`versionHistory.ts` exports `48`. `ENGINE_VERSION_HISTORY.md` has a `## v48:` heading.
Nothing asserts the two correspond, in either direction. Observed drift right now:

- `engine/README.md:35` says "currently **39**".
- `engine/content/enemies.ts:283` says "ENGINE_VERSION 43/49" three lines above a comment
  that says "Reversed in v48". There is no v49. *(Snapshot taken at v48. v49 and v50 have
  shipped since; that comment now reads "v43, reversed in 48, floored in 50".)*
- `design/ROADMAP.md:8` says 47, and concedes "The number in this heading has drifted
  before and is not the authority."

### G3 — The wall-boundary rule is implemented three times

`engine/systems/geom.ts:53-107` (`clampToWalkable`) and
`engine/systems/MovementSystem.ts:126-162` (`resolveWalls`/`resolveObstacles`)
independently implement, line for line: the brim-widened broadphase
(`+ WALL_NORTH_BRIM`), the brimmed top edge
(`w.freeStanding ? w.y - WALL_NORTH_BRIM : w.y`), the closest-point push, the
inside-the-rect `Math.min(pushLeft, pushRight, pushTop, pushBottom)` tie-break, and the
concentric-pillar `+x` nudge. `geom.ts`'s comment says *"Same push-out shape as
MovementSystem's resolveWalls/resolveObstacles"* — an admission, not a call.

A third copy lives in a test: `engine/world/arenas/launchArena.test.ts:350` re-derives
`(w.freeStanding ? w.y - brim : w.y)` for its flood-fill.

Two of the three non-test `WALL_NORTH_BRIM` read sites, and two of the three non-test
`freeStanding` read sites, are this one duplication.

### G4 — Four radii answer "am I blocked", and two of them are wrong on purpose-by-accident

| Site | Radius used | What actually displaces the actor |
|---|---|---|
| `MovementSystem.resolveWalls` / `resolveObstacles` | `solidRadius` | itself |
| `geom.clampToWalkable` callers (pickups, arena loot) | `SIM.pickupRadius` | n/a — items don't move |
| `DoorSystem.inLockingDoorway` | `footprintRadius` | `solidRadius` |
| `DeathDropsSystem` minion spawn clamp | `footprintRadius` | `solidRadius` |
| `EnvironmentSystem.applyTraitDamage` | body `radius` | n/a |
| `MovementSystem.resolveActorPairs` | `footprintRadius` | itself (deliberate, design/07) |

The two middle rows are live inconsistencies, and both carry a comment asserting the
opposite:

- `DoorSystem.ts:131` — *"Uses `footprintRadius` (the feet circle solids actually push
  out, design/07), not `radius` — the test has to match the thing that would displace
  them."* Solids have not pushed out `footprintRadius` since **v43** (players) / **v48**
  (enemies). The comment states a rule that became false two versions ago, and the code
  faithfully follows the comment.
- `DeathDropsSystem.ts:42` — *"a spawned actor needs its own solid clearance"*, then
  clamps by `footprintRadius` (7 px) and hands the minion to a `MovementSystem` that will
  push it out by `solidRadius` (15–30 px). Any minion clamped tight teleports on its
  first tick.

### G5 — `circleOverlapsAabb` is brim-blind, so three consumers disagree with collision

`geom.ts:25` tests the **bare** rect and never looks at `freeStanding`. Its three callers
— `ProjectileStepSystem.ts:112`, `DoorSystem.ts:137`, `EnvironmentSystem.ts:84` — all see
a free-standing block's boundary 23 px south of where `resolveWalls` puts it.

For bullets this is intended (`resolveWalls`' own comment: the index is shared with the
projectile queries, "which must keep hitting the real stone"). For the other two it is
unexamined. **The intent is nowhere asserted**, so the day someone "fixes" the
inconsistency, nothing tells them which side was deliberate.

Adjacent, same family: `EnvironmentSystem.pointInAabb` uses half-open `<`,
`circleOverlapsAabb` uses closed `<=`. An actor exactly on `rect.x + rect.w` is outside
the room for zone damage and touching the wall for collision.

### G6 — The renderer derives sim constants in prose, and the muzzle is authored twice

- `client/src/game/scene/wallGeometry.ts:30` justifies `WALL_H_KERB = 22` from "the
  player's ground point stays `PLAYER_BASE.solidRadius` (16 px) north of the kerb's own
  north edge". `occlusion.ts:49` re-derives the same 6 px from the same premise.
  **Neither file imports `PLAYER_BASE`.** Only the test files close the loop.
- `wallTier` (`wallGeometry.ts:94`) decides "is this an interior block" from room-rect
  edge proximity (`EDGE_TOLERANCE = 4`) rather than reading `freeStanding`. The sim's
  brim rule and the renderer's height rule can therefore disagree about the same rect.
- The bullet muzzle is authored in **two unconnected tables**: `muzzleGrid` in
  `engine/content/weaponSpecs/*.ts`, and `anchor` / `rotationOffsetRad` / `scale` in
  `client/src/render/weaponSkins.ts`. `Bullet.setMuzzleOrigin` eases the difference away
  over the first 40 px of flight, so a large mismatch does not error — it just renders a
  bigger correction. `Bullet.test.ts` exercises the ease with a hardcoded `(30, -18)`,
  never with a real weapon's numbers. **Closed by `muzzleParity.test.ts` (2026-08-30).**

  **A second edition of the same gap, found 2026-09-02 (live report: bullets drift in an
  arc out of the muzzle before flying straight).** The parity table closed the two tables'
  disagreement as a SCALAR — measured at aim 0, the one pose where the whole chain is a
  single reach along the aim ray. That pose is exactly where the gap is almost entirely
  ALONG the shot, which only makes a round look fast or slow. The component ACROSS it — the
  one that has to be spent by moving the drawn round sideways while it flies forward, i.e.
  the one that draws a curve — was invisible to every measurement in the file, and was
  20.8 world px on the reported shot. **The lesson is the pose, not the axis:** a harness
  that evaluates a rotationally-dependent chain at one angle has measured one angle. The
  file now sweeps 24 aim angles × every weapon × every carrying body, bounds the
  perpendicular component at 0.1 px, carries a control that fires the same measurement on
  the old geometry, and flies a real `Bullet` through the reported shot end to end.

  **And a second gap, one layer up, which the FIX walked straight into.** The first version of
  it moved the weapon module to the aim and left everything else hanging off the same bone
  behind — the socket ring, the tether drawn out to it, the contact shade on the core — so the
  gun floated 71 px from its own mount. That passed the whole suite, the new 24-angle sweep and
  a four-mutation battery; one live frame caught it. Every check in the suite asserted where
  the module **is**, and none that it is still **attached** to the thing that holds it, because
  a rig's parts have that relationship by construction — right up until one is moved out of the
  FK chain, which is the moment the construction stops being the guarantee. `rigComposition
  .test.ts` now carries the attachment invariants (module == its own ring, through every clip;
  the drawn tether's own endpoint reaches the module; a held gun the same distance from its
  body in every direction; plus a control that the module actually travels). Re-applying the
  regression kills 9 of them. **Generalised: when a change moves one part of an assembled
  thing, the test belongs on the RELATIONSHIP, not on the moved part's coordinates.**

Two related facts about bullet birth, both currently unasserted:

- `WeaponFireSystem.spawnBullet` does **no wall test at all**. A shooter flush against a
  wall spawns the projectile `muzzleOffset` along the aim ray, wherever that lands.
- `ProjectileStepSystem` is an **endpoint** test, not swept — its own comment says
  "(swept test is 07)". design/07's determinism checklist claims *"✅ Swept tests (no
  float endpoint check) so behavior is speed-independent and can't tunnel."* That claim
  is false in shipped code, and a fast bullet can pass a thin wall.

---

## The plan

Four layers, cheapest and highest-leverage first. Each layer names the gap it closes.

### Layer −1 (prerequisite) — one boundary, one function

Parity tests over duplicated code mostly re-prove the copy-paste. Delete the duplication
first; the tests then guard a real contract instead.

**`engine/systems/solidBounds.ts`** (new) — the single definition of where a solid blocks:

```ts
/** The rect an actor of clearance `r` is kept out of. The ONLY place the brim rule lives. */
export function blockingRect(w: AABB): { left: Fp; top: Fp; right: Fp; bottom: Fp };
/** Broadphase radius a caller must ask with to see brim-only overlaps. */
export function queryRadiusFor(r: Fp): Fp;
/** The shared closest-point push + inside-the-rect tie-break. */
export function pushOutOfWall(x: Fp, y: Fp, r: Fp, w: AABB): { x: Fp; y: Fp };
export function pushOutOfObstacle(x: Fp, y: Fp, r: Fp, o: Obstacle): { x: Fp; y: Fp };
```

`resolveWalls`, `resolveObstacles` and `clampToWalkable` all call these. Closes G3.
Behaviour-preserving, so **no `ENGINE_VERSION` bump** — and the golden fixture from
Layer 0 is what proves that claim rather than asserting it.

**`engine/state/actorRadius.ts`** (new) — one answer to "which radius blocks":

```ts
/** The radius any static-solid question about `a` must use. */
export const blockingRadius = (a: Actor): Fp => a.solidRadius;
```

`DoorSystem` and `DeathDropsSystem` either adopt it (a behaviour change → bump) or opt
out with a comment *and* a test that pins the opt-out as intentional. Closes G4.

### Layer 0 — contract gates (closes G1, G2)

Small, fast, and the only layer that makes the `ENGINE_VERSION` discipline mechanical.

**`engine/goldenHash.test.ts` + `engine/fixtures/golden.json`**

```
{ "engineVersion": 48,
  "scenarios": [ { "name": "arena-waves",  "config": {...}, "ticks": 500, "hash": 3141592653 },
                 { "name": "ember-floor1", "config": {...}, "ticks": 900, "hash": ... },
                 { "name": "coop-2seat",   "config": {...}, "ticks": 600, "hash": ... } ] }
```

Each scenario replays a scripted command stream through `runHeadless` and compares
`hashState` to the recorded number. On mismatch the failure message says:

> Sim behaviour changed. If intended: bump ENGINE_VERSION, add a `## vN:` entry to
> ENGINE_VERSION_HISTORY.md, then `npm run record:golden`.

A tiny `engine/scripts/recordGolden.mjs` regenerates the file. This is the single highest
-value test in the plan: it turns "remember to bump the version" from discipline into a
gate, and it is the thing that would have gone red for both changes that prompted this
doc.

**`engine/versionContract.test.ts`**

- `ENGINE_VERSION_HISTORY.md` contains `## v{ENGINE_VERSION}:`.
- `golden.json`'s `engineVersion` equals `ENGINE_VERSION` (so re-recording without
  bumping is caught).
- `engine/README.md`'s stated version matches. Fixes the stale 39 as a side effect.

**`engine/determinismLint.test.ts`** — a source scan over `engine/**/*.ts` (tests
excluded) for `Math.random|Math.sqrt|Math.sin|Math.cos|Math.atan2|Date.now|new Date(|
performance.now`, with an explicit allowlist array carrying a reason per entry. design/06
says these are "(enforced)"; today nothing enforces them. Strip comments before scanning
— a source-text contract test that matches a value quoted in a comment is a known trap in
this repo.

**`engine/stepOrder.test.ts`** (2026-09-03) — not one of the six gaps above; it closes a
seventh, found by the doc audit in `roadmap/16` rather than by this doc's own survey. The step
ORDER is already
enforced by the golden hashes; this enforces that the three places which *describe* it still
agree. Each system's header opens `Step N — …`, `GameEngine.step()` labels every call, and
design/08 lists the whole order; nothing compared them, and they had disagreed for weeks (the
`DeathDrops`/`Pickup`/`Spawn` off-by-one trio, stale since `ENGINE_VERSION` 8; `Zone`/
`Environment` with the number dropped entirely; design/08 not mentioning `DoorSystem` at all).
Four rules: every call carries a label and resolves to a declared field; labels strictly
increase down the body (so a reorder without a renumber fails); each header matches its call
position; and no `*System.ts` is missing from `step()` or called without a file. The label
comparator understands `8a`/`8b`/`11.5` — both escape hatches are deliberate, so that inserting
a pass did not churn every header below it. Parser lives in `fixtures/stepOrder.mjs` so each
rule is also proven against a synthetic violation; the real-tree assertion alone would be
indistinguishable from a test that checks nothing. **It found the comment trap above on its
first run** — `GameEngine.ts`'s own header says "step(commands) is the direct entry
(headless/tests)", and an `indexOf` matched that instead of the declaration, returning the field
list as the step order.

**`build/checkDocPaths.mjs`** + `build/checkDocPaths.test.mjs` (2026-09-03, `npm run
check:docpaths`, folded into `npm run check`) — the other gap `roadmap/16` found: a **decision
doc** may not cite a source file that does not exist. Its design is a scoping decision, not an
algorithm. Run over the whole doc set the sweep produced 36 hits and **35 were correct**, because
`ROADMAP.md`, `roadmap/*` and `README.md` are an append-only historical log where naming a
since-deleted file is right, not stale — so gating them would mean editing the past or growing an
allowlist forever. Scoped instead to `design/**/*.md` minus ROADMAP and the log, plus `CLAUDE.md`:
26 docs and about a thousand references, with a 20-entry allowlist, and the one real defect (design/10 promising a
`confirmEdge.test.ts` gate deleted a month earlier) sits inside that scope. Matching is by
BASENAME — `game/Scene.ts` for `client/src/game/scene/Scene.ts` is house style, and full-path
matching would flag ~200 correct references — against `git ls-files`, so CI and every machine
agree (a filesystem walk would not: `client/dist/version.json` exists only after a build). Each
exemption carries a reason and the list is asserted **minimal**: an entry that stops being cited,
or starts resolving, fails. **What it cannot do:** the exemption is on a token, not a sentence, so
rewording one of the five "cited as deleted" references back into a present-tense claim would pass
— it catches a *new* dangling reference, which is the direction the drift travels.

**`build/checkRoadmapIndex.mjs`** + `build/checkRoadmapIndex.test.mjs` (2026-09-15, `npm run
check:roadmapindex`, folded into `npm run check`) — the fourth Layer 0 doc gate, and the one that
covers the corpus `checkDocPaths` deliberately gave up on. `design/ROADMAP.md` indexes the work log
**twice** (by date, by theme) and nothing cross-checked the two halves: volume 36 landed all six of
its by-theme entries and neither of its by-date ones, and stood that way for ten days. A link sweep
is actively misleading there — that volume was linked from six places, so every reference to it
resolved. The check that sees it runs the other way round, **from the volume to the index**: for
every `## ` heading in a numbered volume that carries a date, is there a by-date bullet whose link
anchor is that heading's slug? The date filter keeps a volume's structural sections (`Numbers`,
`After`, `Still open`) out of the rule **exactly**, with no allowlist at all — which is what made
it gateable where `checkDocPaths` needed a 26-entry exemption list. Five more rules ride along,
each a drift this log has actually suffered: every roadmap link names a real volume and a real
heading; the *"same N entries"* total equals the by-date bullet count; each `*(N)*` tag counter
equals the bullets under it; a by-theme entry is a **bare link** (volumes 47–49 had pasted ~40 KB
of by-date paragraphs into it); and a **blank line precedes every tag header**, since an append
that eats that separator is what makes the *next* one land in the wrong tag section. **The evidence
it works** is not the green run: over the tree at `563d25b`, the commit before the 2026-09-15 tidy,
it reports **14** violations, every one of which had been found by hand. **What it cannot do:** it
is arithmetic and anchors, so it cannot tell whether an entry is filed under the RIGHT tag (volume
43 filed two into `audio` and `tools` with every counter it touched correct), nor whether a summary
is true.

### Layer 1 — unit tests of the logic itself

**`engine/systems/solidBounds.test.ts`** — exhaustive over the small finite space:
4 faces × `freeStanding` on/off × {outside, tangent, overlapping, inside, fully engulfed,
exact corner} × r ∈ {0, small, larger than the rect}. Assert the tie-break order
explicitly (it is a determinism contract, not an implementation detail).

**`engine/systems/MovementSystem.test.ts`** — *this file has no dedicated test today*.
Its behaviour is covered only incidentally by `rooms.test.ts`, `systems.test.ts`,
`enemyChase.test.ts`. Cover: integrate + chill scaling, knockback decay and the snap
threshold, `clampToWorld`'s use of `PLAYER_BASE.margin` on non-player actors, and the
ascending-id resolution order.

**`engine/systems/WeaponFireSystem.test.ts`** — *also missing today*. Cover the muzzle
formula per weapon; pellet count; and specifically the **PRNG draw-count contract**
("a single-pellet pinpoint shot draws nothing… byte-identical to the pre-1.1 baseline") —
that is a determinism claim with no test at all. Assert by reading `combatPrng.peek()`
before and after.

**`engine/systems/ProjectileStepSystem.test.ts`** — pin the *actual* endpoint semantics
and add a test that constructs the tunneling case explicitly, so the known limit is
recorded rather than implied. Then either fix design/07's checklist or implement the
swept test and bump.

### Layer 2 — parity sweeps (closes G5, G6)

This is the layer the question was really about: many consumers, one rule.

**`engine/systems/boundaryParity.test.ts`** — a declared agreement matrix. Every consumer
is registered as a closure:

```ts
const PROBES = [
  { name: 'movement',    blocks: (s, x, y, r) => /* resolveWalls */, brim: true  },
  { name: 'pickup-drop', blocks: (s, x, y, r) => /* clampToWalkable */, brim: true  },
  { name: 'bullet',      blocks: (s, x, y, r) => /* circleOverlapsAabb */, brim: false },
  { name: 'doorway',     blocks: ..., brim: false },
  { name: 'zone-trait',  blocks: ..., brim: false },
];
```

Sweep a synthetic room *and* the shipped floors at 8 px. Assert every `brim: true` probe
agrees with every other, and that each `brim: false` probe differs from them **only**
inside the brim band and nowhere else. An accidental change to a must-agree pair goes red;
an intentional difference is a declared row rather than a comment. Reuse the
`*Coverage.test.ts` idiom wholesale, including the non-empty-sweep guard.

**`engine/systems/clearanceParity.test.ts`** — for every site that places an entity
(`DeathDropsSystem` minions, `SpawnSystem` arena loot + enemies, `PickupSystem` drops),
assert `clamp radius >= the radius that will later push this entity`. This is the
one-line test that catches the G4 first-tick minion teleport, and it stays true for
placement sites added later.

**`client/src/game/scene/simRenderParity.test.ts`** — for every wall in the shipped
floors: assert `freeStanding ⟺ wallTier === interior`, so the sim's brim rule and the
renderer's height rule cannot drift apart. Compute `WALL_H_KERB`'s "6 px above the feet"
claim from `PLAYER_BASE.solidRadius` instead of restating 16, and assert
`MIN_COVER_FRACTION` still rejects a kerb at the computed value — so a `solidRadius`
change fails here rather than silently invalidating the comment.

**`client/src/render/muzzleParity.test.ts`** — for every weapon in `WEAPON_SPECS`,
compare the sim's `muzzleOffset` (converted to px) against `moduleMuzzleLocal`'s reach for
the same weapon's render entry. Assert the gap the ease has to absorb stays under a
budget, that every sim weapon has a render entry, and that a missing entry degrades to
"no correction" rather than to a wrong one. Rewrite `Bullet.test.ts`'s hardcoded
`(30, -18)` to be derived from a real weapon.

### Layer 3 — smoke: invariants over real runs (closes what none of the above can)

**`engine/smoke.test.ts`** — `runHeadless` over 3–4 real configs (launch arena, ember
floor 1, ember full descent, 2-seat co-op), checking **per tick**:

1. no alive actor's `solidRadius` circle penetrates any wall or pillar (after Movement);
2. every alive pickup sits where `clampToWalkable` would leave it — i.e. every drop is
   reachable (the exact v48 live report, as an invariant instead of a scenario);
3. every bullet's spawn position is on the shooter's side of any wall between them;
4. every Fp in `serializeState` is a finite integer (no NaN, no float leak);
5. every alive actor is inside world bounds;
6. in dungeon mode, no alive enemy carries `roomId === undefined` — the named recurring
   omission in this repo, currently caught only by live play;
7. anti-vacuity: the run really spawned enemies, fired bullets, dropped pickups, opened a
   door. Without this the whole file can pass on an empty run.

This is the "整个逻辑的冒烟测试" half. It is deliberately property-shaped, not
scenario-shaped: a unit test can encode the same wrong assumption as the code it tests,
where an invariant checked over a real run cannot.

**Promote the sim harnesses into a gated tier.** `test:pve-sim` already carries real
balance gates and is fully opt-in. Add `npm run check:full` = `check` + the three
`.sim.ts` suites, and run *that* in CI (`.github/`) even if the local `check` stays fast.

### Every new gate ships with its mutation

Repo habit, and it is load-bearing here: for each gate above, revert the thing it claims
to catch, confirm the suite goes red, and record the failing-test count in the test file's
header. A parity test that would pass against the pre-fix code is worse than no test,
because it reads as coverage. Watch the two recorded traps: a fixture that makes the
mutant equivalent, and a source-text scan that matches a value quoted in a comment.

## Cost and phasing

| Phase | Content | Rough size | Value |
|---|---|---|---|
| 1 | Layer 0 (golden fixture, version contract, determinism lint) | ~3 files, ~250 lines | **Highest.** Makes the version bump mechanical; would have caught both prompting changes |
| 2 | Layer −1 refactor + Layer 1 unit tests | ~2 source files, ~4 test files | Removes the duplication the rest would otherwise re-prove |
| 3 | Layer 2 parity sweeps | ~4 test files | Closes the actual "不同步" question |
| 4 | Layer 3 smoke + CI tier | ~1 large test file + scripts | Catches the class nobody predicted |

Phases 1 and 2 are independent of 3 and 4; 3 is much cheaper after 2.
