# Test strategy: keeping the logic in sync with itself

> Status: **all four PLANNED layers shipped**, 2026-08-30, at `ENGINE_VERSION` **49**, and since
> 2026-09-03 **measured and gated** — see [Layer 4: coverage as a gate](testing/01-the-layers-as-built.md#layer-4-coverage-as-a-gate-and-the-two-things-a-percentage-cannot-say-2026-09-03). Three layers have been
> added since, none of them in the original six-gap plan: **5** the content axis (2026-09-04),
> **6** the deploy axis (2026-09-07) and **7** the assembly axis (named 2026-09-21, tests since
> 2026-08-25). The table below is the current list. Repo-wide
> `npm run check` was green at 5,885 tests when they landed (engine 885 → 1064), and at
> **7,190** (engine **1164**, client **4,810**, server **285**) when last measured, 2026-09-03
> (the day's last pass was the coverage gate + the Game.ts split, +151 client and +96 server
> tests) — both figures dated on purpose, because an undated count in a status block is this
> doc set's most reliable way of going stale (see the design-docs conventions memory).
> Coverage at that same measurement: **client 97.70% lines / 92.12% branches, engine 97.67% /
> 92.86%, server 99.32% / 95.44%**, each over its whole source tree, each gated at 90/90.
> Two more Layer 0 gates landed the same day:
> `engine/stepOrder.test.ts` and `build/checkDocPaths.mjs`. Both `.sim.ts` balance suites pass,
> including the level-1 no-stall gate that a geometry change is most likely to break.
>
> The findings the new tests turned up were then **fixed**, which is what the v49 bump is
> — see `ENGINE_VERSION_HISTORY.md`. The Layer −1 refactor was *not* part of that bump:
> the golden fixture recorded before it still matched after it, which is what proves the
> extraction was byte-identical rather than merely believed to be. That is the whole
> workflow this document exists to install, and it paid for itself on its first use.
>
> Every gap in [part 2](testing/02-the-six-gaps-and-the-original-plan.md) was measured against the tree, not remembered.

## What shipped

| Layer | Files | State |
|---|---|---|
| **−1** one boundary, one function | `engine/systems/solidBounds.ts`, `engine/state/actorRadius.ts` | ✅ G3 closed; three copies of the brim rule became one |
| **0** contract gates | `goldenHash.test.ts` + `fixtures/golden.json` + `scripts/recordGolden.mjs`, `versionContract.test.ts`, `determinismLint.test.ts`, `stepOrder.test.ts` + `build/checkDocPaths.mjs` (both 2026-09-03), `build/checkRoadmapIndex.mjs` (2026-09-15) | ✅ G1, G2 closed; the last two close the two mechanically-checkable gaps the `roadmap/16` doc audit found, outside this doc's own six |
| **1** unit tests | `solidBounds.test.ts`, `MovementSystem.test.ts`, `WeaponFireSystem.test.ts`, `ProjectileStepSystem.test.ts` | ✅ the last three had **no test file at all** before this |
| **2** parity sweeps | `boundaryParity.test.ts`, `clearanceParity.test.ts`, `client/.../simRenderParity.test.ts`, `client/src/render/muzzleParity.test.ts`, `client/.../pickupProximity.test.ts` (v50) | ✅ G4, G5, G6 closed; v50 adds the panel-offers-vs-sim-accepts pair, the one gap that straddles the sim boundary |
| **3** smoke + CI | `engine/smoke.test.ts`, root `npm run check:full`, `.github/workflows/check.yml` | ✅ 5 real runs, 7 invariants, every tick (v50 added the two loot/monster placement rules) |
| **4** coverage as a gate | `build/coverageLib.mjs` + `checkCoverageThreshold.mjs` + `coverageReport.mjs`, `build/coverageScope.test.mjs`, `client/src/game/pureLayerBoundary.test.ts` | ✅ 2026-09-03 — 90% lines **and** 90% branches over each package's whole tree, plus the two guards that keep the scope honest |
| **4** the gates, by name | `build/logicConsistency.mjs` + its manifest test | ✅ 2026-09-03 — the 12 gates above as a named CI job, failing closed when one is renamed away |
| **5** the content axis | `engine/content/weapons.test.ts`, `engine/systems/rangedCatalog.test.ts`, `engine/balance/weaponProfile.ts` + `weaponBalance.test.ts`, `client/sim/weaponSweep.sim.ts` | ✅ 2026-09-04 — every weapon, not every system; see [Layer 5](testing/01-the-layers-as-built.md#layer-5-the-content-axis--every-weapon-not-every-system-2026-09-04) for the four gaps it closed and the three dead-content findings it turned up |
| **6** the deploy/build axis | `server/test/deploy.bundle.test.ts`, `server/test/deploy.manifests.test.ts`, `client/src/platform/crazygames/portalBuild.test.ts` | ✅ 2026-09-07 — the artifact that actually runs in production, the five manifests no compiler compares, and (client side) the build config that decides which entry module a portal upload even loads; see [Layer 6](testing/01-the-layers-as-built.md#layer-6-the-deploybuild-axis--the-artifact-is-not-the-thing-you-tested-2026-09-07) |
| **7** the assembly axis | the nine `client/src/game/game*.test.ts` files (67 cases), oldest `gameQuality`/`gameViewport` 2026-08-25, newest `gameRunClock` 2026-09-20 | ✅ named 2026-09-21 — a real `Game` on a fake app, driven only through the real screen callbacks; the only layer that can see a value written by one controller, read by a second and leaked by a screen owned by a third; see [Layer 7](testing/01-the-layers-as-built.md#layer-7-the-assembly-axis--the-seam-every-unit-suite-stubs-2026-09-21) |

`check:full` = `check` + the `.sim.ts` suites. `.github/workflows/check.yml` runs both in CI —
until it existed, `.github/workflows/` held only deploy workflows, so nothing ran the tests on
a push and every gate in the repo was a gate only for whoever remembered to run it locally.
Since 2026-09-03 it is four independent jobs — `logic`, `check`, `coverage`, `sims` — all on
every push and pull request.


## Where each section lives

Split 2026-09-21, at 1,072 lines, on the same 1,000-line ceiling `design/05` and `design/19` were
split against (`roadmap/65`). Nothing was rewritten: the three parts below hold the sections
verbatim, and this file keeps the status block, the table above and the doc relationships.

**Code cites this doc by GAP NUMBER and by LAYER NUMBER** (`design/18 G4`, `design/18 Layer 0`,
`design/18 "Layer 4"` — 73 citations across the tree), and those two vocabularies land in
different parts: `G1`–`G6` and Layers −1–3 are in part 2, where they were planned; Layers 4–7
are in part 1, where they were built. The map below is keyed by both.

**[`testing/01-the-layers-as-built.md`](testing/01-the-layers-as-built.md)** — Layers 4–7 — the axes added after the original plan, each as it was actually built

- [Layer 4: coverage as a gate, and the two things a percentage cannot say (2026-09-03)](testing/01-the-layers-as-built.md#layer-4-coverage-as-a-gate-and-the-two-things-a-percentage-cannot-say-2026-09-03)
  - [What the percentage still cannot do](testing/01-the-layers-as-built.md#what-the-percentage-still-cannot-do)
  - [The gates, by name](testing/01-the-layers-as-built.md#the-gates-by-name)
- [Layer 5: the content axis — every weapon, not every system (2026-09-04)](testing/01-the-layers-as-built.md#layer-5-the-content-axis--every-weapon-not-every-system-2026-09-04)
  - [What closed it](testing/01-the-layers-as-built.md#what-closed-it)
  - [Three dead-content findings, each now pinned](testing/01-the-layers-as-built.md#three-dead-content-findings-each-now-pinned)
- [Layer 6: the deploy/build axis — the artifact is not the thing you tested (2026-09-07)](testing/01-the-layers-as-built.md#layer-6-the-deploybuild-axis--the-artifact-is-not-the-thing-you-tested-2026-09-07)
- [Layer 7: the assembly axis — the seam every unit suite stubs (2026-09-21)](testing/01-the-layers-as-built.md#layer-7-the-assembly-axis--the-seam-every-unit-suite-stubs-2026-09-21)

**[`testing/02-the-six-gaps-and-the-original-plan.md`](testing/02-the-six-gaps-and-the-original-plan.md)** — the original 2026-08-30 document — the BEFORE snapshot, `G1`–`G6`, and Layers −1–3 as planned

- [Why this doc exists](testing/02-the-six-gaps-and-the-original-plan.md#why-this-doc-exists)
- [Where we were before this work](testing/02-the-six-gaps-and-the-original-plan.md#where-we-were-before-this-work)
- [The six gaps](testing/02-the-six-gaps-and-the-original-plan.md#the-six-gaps)
  - [G1 — "Golden replay" never compares against a recorded value](testing/02-the-six-gaps-and-the-original-plan.md#g1--golden-replay-never-compares-against-a-recorded-value)
  - [G2 — Nothing ties `ENGINE_VERSION` to anything](testing/02-the-six-gaps-and-the-original-plan.md#g2--nothing-ties-engine_version-to-anything)
  - [G3 — The wall-boundary rule is implemented three times](testing/02-the-six-gaps-and-the-original-plan.md#g3--the-wall-boundary-rule-is-implemented-three-times)
  - [G4 — Four radii answer "am I blocked", and two of them are wrong on purpose-by-accident](testing/02-the-six-gaps-and-the-original-plan.md#g4--four-radii-answer-am-i-blocked-and-two-of-them-are-wrong-on-purpose-by-accident)
  - [G5 — `circleOverlapsAabb` is brim-blind, so three consumers disagree with collision](testing/02-the-six-gaps-and-the-original-plan.md#g5--circleoverlapsaabb-is-brim-blind-so-three-consumers-disagree-with-collision)
  - [G6 — The renderer derives sim constants in prose, and the muzzle is authored twice](testing/02-the-six-gaps-and-the-original-plan.md#g6--the-renderer-derives-sim-constants-in-prose-and-the-muzzle-is-authored-twice)
- [The plan](testing/02-the-six-gaps-and-the-original-plan.md#the-plan)
  - [Layer −1 (prerequisite) — one boundary, one function](testing/02-the-six-gaps-and-the-original-plan.md#layer-1-prerequisite--one-boundary-one-function)
  - [Layer 0 — contract gates (closes G1, G2)](testing/02-the-six-gaps-and-the-original-plan.md#layer-0--contract-gates-closes-g1-g2)
  - [Layer 1 — unit tests of the logic itself](testing/02-the-six-gaps-and-the-original-plan.md#layer-1--unit-tests-of-the-logic-itself)
  - [Layer 2 — parity sweeps (closes G5, G6)](testing/02-the-six-gaps-and-the-original-plan.md#layer-2--parity-sweeps-closes-g5-g6)
  - [Layer 3 — smoke: invariants over real runs (closes what none of the above can)](testing/02-the-six-gaps-and-the-original-plan.md#layer-3--smoke-invariants-over-real-runs-closes-what-none-of-the-above-can)
  - [Every new gate ships with its mutation](testing/02-the-six-gaps-and-the-original-plan.md#every-new-gate-ships-with-its-mutation)
- [Cost and phasing](testing/02-the-six-gaps-and-the-original-plan.md#cost-and-phasing)

**[`testing/03-what-each-version-fixed.md`](testing/03-what-each-version-fixed.md)** — every finding — what `ENGINE_VERSION` 49/50/51 fixed, and what building the gates turned up

- [What v49 fixed](testing/03-what-each-version-fixed.md#what-v49-fixed)
- [What v50 added, and what it did NOT find](testing/03-what-each-version-fixed.md#what-v50-added-and-what-it-did-not-find)
- [What v51 found, in the sentence v50 wrote about it (2026-09-01)](testing/03-what-each-version-fixed.md#what-v51-found-in-the-sentence-v50-wrote-about-it-2026-09-01)
- [Findings from building it](testing/03-what-each-version-fixed.md#findings-from-building-it)
  - [The lesson that cost the most](testing/03-what-each-version-fixed.md#the-lesson-that-cost-the-most)
- [Docs drift found while writing this](testing/03-what-each-version-fixed.md#docs-drift-found-while-writing-this)

## Relationship to the other docs

- **`06`** owns the determinism rules Layer 0 makes enforceable.
- **`07`** owns the collision boundary Layers −1/1/2 consolidate, and carries the swept-vs
  -endpoint claim G6 contradicts.
- **`08`** owns the step order the golden fixture pins.
- **`09`** owns the content tables the parity sweeps read.
- `CLAUDE.md`'s 500-line convention is why Layer −1 splits rather than grows `geom.ts`.
