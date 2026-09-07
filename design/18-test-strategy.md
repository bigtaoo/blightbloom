# Test strategy: keeping the logic in sync with itself

> Status: **all four PLANNED layers shipped**, 2026-08-30, at `ENGINE_VERSION` **49**, and since
> 2026-09-03 **measured and gated** — see "Layer 4: coverage as a gate" below. Two layers have been
> added since, neither in the original six-gap plan: **5** the content axis (2026-09-04) and **6**
> the deploy axis (2026-09-07). The table below is the current list. Repo-wide
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
> Every gap below was measured against the tree, not remembered.

## What shipped

| Layer | Files | State |
|---|---|---|
| **−1** one boundary, one function | `engine/systems/solidBounds.ts`, `engine/state/actorRadius.ts` | ✅ G3 closed; three copies of the brim rule became one |
| **0** contract gates | `goldenHash.test.ts` + `fixtures/golden.json` + `scripts/recordGolden.mjs`, `versionContract.test.ts`, `determinismLint.test.ts`, `stepOrder.test.ts` + `build/checkDocPaths.mjs` (both 2026-09-03) | ✅ G1, G2 closed; the last two close the two mechanically-checkable gaps the `roadmap/16` doc audit found, outside this doc's own six |
| **1** unit tests | `solidBounds.test.ts`, `MovementSystem.test.ts`, `WeaponFireSystem.test.ts`, `ProjectileStepSystem.test.ts` | ✅ the last three had **no test file at all** before this |
| **2** parity sweeps | `boundaryParity.test.ts`, `clearanceParity.test.ts`, `client/.../simRenderParity.test.ts`, `client/src/render/muzzleParity.test.ts`, `client/.../pickupProximity.test.ts` (v50) | ✅ G4, G5, G6 closed; v50 adds the panel-offers-vs-sim-accepts pair, the one gap that straddles the sim boundary |
| **3** smoke + CI | `engine/smoke.test.ts`, root `npm run check:full`, `.github/workflows/check.yml` | ✅ 5 real runs, 7 invariants, every tick (v50 added the two loot/monster placement rules) |
| **4** coverage as a gate | `build/coverageLib.mjs` + `checkCoverageThreshold.mjs` + `coverageReport.mjs`, `build/coverageScope.test.mjs`, `client/src/game/pureLayerBoundary.test.ts` | ✅ 2026-09-03 — 90% lines **and** 90% branches over each package's whole tree, plus the two guards that keep the scope honest |
| **4** the gates, by name | `build/logicConsistency.mjs` + its manifest test | ✅ 2026-09-03 — the 12 gates above as a named CI job, failing closed when one is renamed away |
| **5** the content axis | `engine/content/weapons.test.ts`, `engine/systems/rangedCatalog.test.ts`, `engine/balance/weaponProfile.ts` + `weaponBalance.test.ts`, `client/sim/weaponSweep.sim.ts` | ✅ 2026-09-04 — every weapon, not every system; see "Layer 5" below for the four gaps it closed and the three dead-content findings it turned up |
| **6** the deploy/build axis | `server/test/deploy.bundle.test.ts`, `server/test/deploy.manifests.test.ts`, `client/src/platform/crazygames/portalBuild.test.ts` | ✅ 2026-09-07 — the artifact that actually runs in production, the five manifests no compiler compares, and (client side) the build config that decides which entry module a portal upload even loads; see "Layer 6" below |

`check:full` = `check` + the `.sim.ts` suites. `.github/workflows/check.yml` runs both in CI —
until it existed, `.github/workflows/` held only deploy workflows, so nothing ran the tests on
a push and every gate in the repo was a gate only for whoever remembered to run it locally.
Since 2026-09-03 it is four independent jobs — `logic`, `check`, `coverage`, `sims` — all on
every push and pull request.

## Layer 4: coverage as a gate, and the two things a percentage cannot say (2026-09-03)

The layers above answer "does the logic agree with itself". This one answers a different
question — "is there any of it nothing runs" — and it was added because the answer had never
been measured. There was no coverage provider installed, no script, and no CI step.

The measurement, taken before anything was built, is the reason the pass turned out the way it
did:

| Package | Lines | Branches | Functions |
| --- | --- | --- | --- |
| client | 96.52% | **90.03%** | 92.06% |
| engine | 97.70% | 92.95% | 98.75% |
| server | 85.23% | **78.27%** | 79.74% |

Two things follow from those numbers, and neither is "write more tests".

**The branch column is the one worth gating.** The client's line coverage was comfortable and
its branch coverage was three hundredths of a point over 90 — one unexercised `if` from
failing. Uncovered branches concentrate in the absent-field fallbacks, the refusal paths and
the lost-race arms: the code that only runs when something has already gone wrong, which is
the code a test is most worth having. `server/src/MatchRoom.ts` was the clearest case in the
repo: **99.08% lines, 83.14% branches**, because every guard's line executes — only the taken
side runs — while every "wrong caller, wrong phase, wrong seat" arm in it was unexercised.
Those guards are trust boundaries fed straight off the wire. Functions is measured and
reported but deliberately **not** gated: it is the metric most easily satisfied by calling a
function once and asserting nothing.

**Scope is the knob that raises every number without a test.** The gate therefore carries a
`scopeShrunk` rule: it fails when the coverage report holds fewer files than the package's
source tree, using the answer vitest's own matcher just produced rather than re-deriving the
globs. It is what lets all three packages keep a whole-tree `coverage.include` instead of the
hand-maintained allow-list the sibling project `funny` needs (its render layer sits at 0–15%
and would drown the number). Verified by mutation, and the mutant is the argument: narrowing
the client's include to `src/game/**` reports **97.68% lines / 92.13% branches — both green**
while measuring 130 of 224 files. Nothing else in the setup would have said a word.

### What the percentage still cannot do

`client/src/game/pureLayerBoundary.test.ts` exists because a gate's headroom is
`covered / 0.9 - total` — at 96% that is hundreds of lines, and it GROWS as the tests improve.
So a module that imports PIXI can be dropped into the pure layer, add untested lines, and
leave the gate comfortably green. What that costs is not coverage; it is the ability to test
the logic at all, which is the entire reason `src/game/runState.ts` was split out of `Game.ts`
in the first place. The guard has two halves — no runtime import may reach a browser-dependent
module, and the file may not touch a browser global itself — because the first alone is a hole
you can drive through: a module needs no imports at all to call `document.createElement`.

### The gates, by name

Every Layer 0 and Layer 2 gate above already ran inside `npm run check`, and that is precisely
the problem `build/logicConsistency.mjs` solves. Rename one, move it out of an `include` glob,
or let its `describe` go empty, and the suite reports one fewer test — nothing anywhere says
which tests were *supposed* to run. The manifest lists all twelve with the reason each
qualifies (it pins an agreement between two separately-maintained things that can drift apart
in silence — not merely an important test), `--run` executes exactly those as a named CI job,
and a named entry that no longer resolves fails closed. Its own test guards the other
direction: it discovers gates from the tree by this document's naming conventions and fails if
one is not on the list, so a new `*Parity.test.ts` cannot quietly skip the step.

## Layer 5: the content axis — every weapon, not every system (2026-09-04)

Layers 0-4 all ask about SYSTEMS. Asked from the other direction — "is every piece of
CONTENT exercised?" — the weapon roster, which `03` calls "the heart of the game", answered
badly. 24 player-facing weapons, and the tests were all either mechanical (does a beam tick,
does a swing window open) or presentational (i18n keys, rarity pips, muzzle parity).

Counted across the whole tree before this pass:

- **`toSimSpec` had no test file.** `content/weapons.ts` was exercised only sideways, by four
  tests that each read the one field they cared about. Its own history is the argument: it
  has silently dropped an authored field **three times** — `piercing` and `ricochetCount`
  (fixed in `ENGINE_VERSION` 28) and `swingSec`, which every melee weapon authored from
  Stage C and nothing converted until v53, so for ~45 versions every blade's hit window was
  one tick and design/03's third melee axis did not exist. All three shipped.
- **Only the MELEE half of the roster was swept.** `meleeWindow.test.ts` drives off
  `WEAPON_SPECS` itself ("so a new blade is covered the day it is authored"). Ranged had no
  counterpart: `ballistics.test.ts` covers each shape once through one showcase weapon and
  names its seven integration weapons by hand. `carom` — the game's only ricochet weapon —
  appeared in exactly ONE test file in the entire tree, `muzzleParity.test.ts`, a render
  sweep. `venomspit` was in the same position.
- **No test compared two weapons.** Characters have had a real balance suite since ROADMAP
  2.3 (`skins.test.ts`: Pareto non-domination, per-axis spread, equal-worth budget band).
  Weapons had no analogue of any of it.
- **The sims never touched the roster.** `pvpBalanceSim` measures character win-rate;
  `pveLevelSim` plays level 1 with the starter loadout only. The `RunOptions.loadout` hook
  that makes a per-weapon sweep possible had been there the whole time, unswept. 22 of the
  24 player weapons had never appeared in any simulation.

Note the shape of that list: **coverage was 100% lines and 100% branches on
`content/weapons.ts` throughout.** A dropped field is a line that was never written, and a
weapon nothing fires still has every branch of its data literal "covered". This is the third
entry in this doc's running theme that a percentage cannot see a whole bug class.

### What closed it

**`engine/content/weapons.test.ts`** — a LANDING TABLE naming, for every authored field, the
sim key it lands on and the formula that produces it, closed on three sides: every key a
shipped weapon sets must be in the table; every key `toSimSpec` emits must be claimed by one;
and every field the *schema* declares must have a line, enforced by typing the tables
`Record<keyof RangedSpec, …>` so a new field with no landing is a `tsc` error. That last
direction is deliberately a type and not a source scan — `engine/tsconfig.json` withholds
node and DOM types from the sim core on purpose, and `readFileSync` here would have meant
widening that boundary to write a weaker check than the compiler already gives for free.

**`engine/systems/rangedCatalog.test.ts`** — the ranged counterpart of the melee sweep, in
four passes: the frozen payload on every pellet matches its spec (and carries no OTHER
shape's params); every weapon of each ballistic moves per its own numbers (so `frostseeker`
is exercised beside `seeker`, not represented by it); `carom`'s real bounces and `leech`'s
real lifesteal fire; and every weapon damages a body placed inside its own reach envelope
through the real `engine.step()`.

**`engine/balance/weaponProfile.ts` + `weaponBalance.test.ts`** — the roster reduced to
comparable axes, then gated. The gates are narrower than `skins.test.ts`'s on purpose, and
the reason is the interesting part: **a mechanic has no price in this repo.** Measured while
building it — across 17 ranged weapons there are 30 numeric Pareto dominations, and every
one is justified by a mechanical difference; mean dps by tier runs fine 8.41 → epic 5.63 →
legend 3.75, i.e. DOWN. Rarity buys mechanics, not pace. So an equal-worth budget band has no
weapon analogue, and any composite "worth" score would be testing an exchange rate someone
invented. What is gated instead: no weapon may dominate another with an identical MECHANICAL
SIGNATURE (the claim with no mechanic left to appeal to), no strictly-worse mechanical
duplicate anywhere, no clones, real spread per axis, and no orphaned ballistic/pattern/element.

**`client/sim/weaponSweep.sim.ts`** (`npm run test:weapon-sim`, folded into `test:sims`) —
the empirical half: every weapon plays the shipped level, 8 seeds each, ~10 s total. Two
false readings had to be designed out of the harness first, and both are worth recording
because both looked like weapon findings:

1. The first cut reported ZERO kills for `lasercutter`, `gyre` and all seven blades.
   `BOT_PROFILES.careful` holds a 7.5-grid standoff, tuned for a pistol that reaches 30 — so
   the bot stood outside a 3.5-grid beam's range and fired into empty floor all run.
2. Capping standoff by reach alone still left `mortar` at zero kills on four of eight seeds.
   Sweeping its standoff 9 → 2 grid took it from 11 kills to 35, with 4-5 on every seed, and
   nothing about the weapon changed: the bot does not lead its shots, so an 8 grid/s shell
   with a 1 s flight lands where the target used to be.

So the standoff is capped by reach AND by half a second of flight time, and each weapon is
measured at a range it can actually connect from. The gate is "no weapon is inert — every one
kills something on every seed", which is the failure a static test cannot see.

### Three dead-content findings, each now pinned

Falling out of the sweeps, and each recorded as a live drift check rather than fixed silently
(fixing them is content design, not test work):

- **`piercing` ships dead.** Authored on `RangedSpec`, converted, honoured by
  `HitResolveSystem`, proven by `procs.test.ts` on a synthetic bullet — and set by NO weapon.
  `carom` deliberately took ricochet instead. Pinned as `UNUSED_BY_CONTENT` in
  `weapons.test.ts`; the day a weapon sets it, the test says so.
- **`skinRef` is read by nothing.** Authored on all 25 weapons, and its own comment claims
  "the view swaps by this" — but the render layer resolves by weapon id (`weaponSkins.ts`,
  asserted by `muzzleParity.test.ts`), and 25 weapons share exactly 2 values, one per `kind`.
  A dead field with a stale comment.
- **No ranged weapon carries lifesteal, and no blade carries poison.** The first was found by
  a surviving mutant: blanking `lifestealPermille` out of `WeaponFireSystem`'s spawn payload
  kills nothing, because the freeze sweep compares `undefined` to `undefined` for all 17
  ranged weapons. Both are pinned as named cases so neither assertion stays quietly vacuous.


## Layer 6: the deploy/build axis — the artifact is not the thing you tested (2026-09-07)

Layers 0-5 all test the source. Since 2026-09-07 (ROADMAP 9.0) production runs something else:
three flat ESM bundles that `server/scripts/build.mjs` produced by collapsing the
`@dd/engine` / `@dd/game/*` / `@dd/net/*` workspace graph into one file per process, with `ws`
and `node:sqlite` left external, inside a container whose behaviour is set by four more files.
**None of it was reachable from any test in the repo.** The server tree measured 99.56% lines /
97.93% branches at the time, and that number said nothing about whether the thing being deployed
could start.

The failure mode is the specific reason a build step needs its own layer: a wrong `external`, an
alias esbuild silently failed to resolve, or a dependency missing from the deploy manifest all
leave every test green and produce a container that dies on `ERR_MODULE_NOT_FOUND` seconds after
`docker compose up`. Nothing in `src/` changed, so nothing in `src/`'s coverage could move.

**`deploy.bundle.test.ts` boots the real artifact.** It builds into a scratch directory in the OS
temp tree — never `server/dist`, which is a live deploy artifact — and then links in ONLY what
`server/deploy/package.json` declares, standing in for the image's `npm install --omit=dev`. That
placement is the half that makes it worth running: Node's upward `node_modules` walk from a
bundle in the temp tree finds nothing of this monorepo, so a bundle reaching for anything the
deploy manifest does not list fails here exactly as it would in the container. Each bundle is
then started as a bare `node` process and has to answer its own `/health` with its OWN service
name — `{ok: true}` alone would wave through a mis-mapped entry in `build.mjs`, which is one typo.
Proven by deleting `ws` from `deploy/package.json`: two of the three boots go red with the
production stack trace in the failure message.

**`deploy.manifests.test.ts` cross-checks the five places the same facts are written down** —
`scripts/build.mjs`, `Dockerfile`, `docker-compose.yml`, `deploy/package.json`,
`deploy/ci-deploy.sh`, plus the `tar` list in `.github/workflows/server-deploy.yml`. Bundle names
must agree across build script, compose `command:`, the forced command's payload check and what
CI actually ships; the deploy manifest must declare exactly the non-builtin externals, each at an
exact version; the base image's Node major must be at least `build.mjs`'s `target`; every compose
env var must be a name `src/` actually reads; no secret may be inlined where `env_file: .env`
is the mechanism; each service must expose and healthcheck **its own** port; and every internal
`http://` URL must name a real service at the port that service listens on. `build.mjs` was
refactored to export `entries` / `external` / `target` and take an output directory so both files
read the real values rather than a second copy of them.

Two of those assertions are worth naming, because they are the ones a percentage could never
reach. A **renamed env var** leaves compose quietly passing a value nobody reads while the
process runs on its default — the code is correct, the tests are green, and the deployed
configuration is inert. A **copy-pasted service block** leaves a healthcheck polling its
neighbour's port, which reports a dead container healthy, i.e. worse than having no healthcheck.

The billing guard gets the same treatment from the other direction: the compose file's billsvc
env block is fed to the real `assertBillingStartupSafety`, with a control asserting the same env
flipped to `NODE_ENV=production` throws. Without the control, the first assertion passes just as
happily against a guard that never throws at all.

**Cost and evidence.** `deploy.manifests.test.ts` is 15 cases in ~180 ms (it only reads files);
`deploy.bundle.test.ts` is 6 cases in ~600 ms including the esbuild run and three process boots.
Every assertion was mutation-checked rather than trusted for being green: five separate compose
mutations (healthcheck port, env name, internal port, `NODE_ENV`, bundle name) each killed
exactly one case.

**The client has the same axis, and it opened the same day.** A game-portal upload
(`design/20`) is assembled by `client/vite.crazygames.config.js`, which rewrites `index.html` to
swap the entry module and inject the SDK script — so *which code the page runs at all* is decided
by a build config that no module test can see. `portalBuild.test.ts` therefore imports the real
config and exercises the config's OWN transform against the real `index.html`, never a copy of
either, plus the entry module's source ORDER (the asset host installed before the first preload,
the host declared before `new Game(...)`, no auto-reload installed) — orderings that are
unobservable from inside a module, the technique `render/wechatPhasedBoot.test.ts` already used
for the other two entries.

It earned itself immediately, on the failure mode this layer exists for: the rewrite was on the
wrong hook. `vite:build-html` has already replaced the entry's `src` with the emitted chunk by
the time `transformIndexHtml` runs at `generateBundle`, so a `transformIndexHtml`-only plugin
cannot swap the entry in a production build **at all** — the dev server would have looked
perfect. What caught it was the plugin's own `closeBundle` guard failing the build, and that
guard is now asserted from both sides (a build where no rewrite fired must throw; a build where
one did must not), with a FRESH plugin instance per case, because `applied` is per-build state
and sharing the configured instance let an earlier test's success satisfy a later test's
"nothing happened" case.

**What this layer deliberately does not do** is run Docker. Building the image and starting the
compose project needs a daemon CI would have to provide, and the two properties that actually
break — "the bundle can resolve everything it imports" and "the manifests agree" — are both
reachable without one.


## What v49 fixed

Every finding below was turned into a fix in the same pass, because a recorded defect that
nobody schedules is just a comment with a test around it. All five move sim outcomes, so they
share one `ENGINE_VERSION` bump:

1. **PvE level 1 finally gets the brim.** The 34 interior blocks across the five shipped ember
   floors now carry `freeStanding`. Route safety measured per floor the way the arena's is:
   regions unchanged, every room still reachable, 0.3–1.6% of floor area lost.
2. **`MovementSystem.reseparateFromSolids`** re-runs the solid passes after the pair push.
3. **`clampToWalkable`** iterates walls → obstacles → world clamp to a fixed point.
4. **`DeathDropsSystem`** clamps a spawned minion by `blockingRadius`.
5. **`DoorSystem.inLockingDoorway`** tests the passage by `blockingRadius`.

One finding was deliberately NOT fixed: `novaburst`'s `muzzleGrid: 0.5`, where the rest of the
ranged catalog is `0.9375`, giving it the only sim/render muzzle gap outside budget (25.8 px vs
a derived 20 px bound). It is the only `pattern: 'radial'` weapon in the game — a ten-pellet
ring has no single barrel direction, so a tighter emission radius is a defensible authoring
choice rather than an obvious slip. `muzzleParity.test.ts` fences it from both sides: it fails
if the gap grows, and it fails if the weapon is ever changed upstream, so the exception cannot
rot.

## What v50 added, and what it did NOT find

The third round of *"无法拾取"* (2026-08-31) arrived with its own diagnosis attached:
*"怪物不能跑进阻挡区域，掉落物品也不能掉在阻挡区域"* — monsters must not run into the blocking
region, and drops must not land in it. Both rules are right. Neither turned out to be the bug.

**What the measurement said, before anything was changed.** Two sweeps, both new:

- Static: every death cell on shipped floor 1 and on the launch arena, clamped and then checked
  for a reachable player-standable point in the player's own connected region. Zero unreachable.
- Real runs: 903 drops across 16 bot-driven runs of all five floors, re-checked at drop time
  *and* again on every change to the wall set. Zero unreachable, zero embedded in stone; the
  nearest standable point to any drop was never further than 116 fp against a 969 fp collect
  reach. **The wall-set trigger reported zero because the case never arose, not because it
  held** — see "What v51 found" below, where a door locking over an existing drop turned out to
  be a live bug. This bullet read "(so a door locking over an existing drop is covered)" until
  2026-09-01.

A first pass reported 14.5% of drops "hidden under wall art" and that number was wrong — it
assumed `WALL_H_PERIMETER` for every non-`freeStanding` rect. Re-run against the renderer's own
`wallTier`, where a wall with room floor immediately north of it is a 22 px kerb, the figure is
**0 of 796**. Recorded here because the wrong version was believed for an afternoon, and the
thing that corrected it was calling the real tier function instead of re-deriving its answer —
G6's lesson arriving a second time.

**What shipped anyway.** Both of the reporter's rules, as constructions rather than margins:

1. **Every enemy's `solidRadius` is floored at the player's.** v48 gave mobs the player's RULE
   and left them their own NUMBER, which for four of eight blueprints is smaller — so a mob
   could stand, die and drop inside a 31 fp band no player could enter. This is a real defect
   the smoke suite now catches; it is also far too small to be the report.
2. **All three drop sites clamp by `dropClearance()`** (the player's own `solidRadius`) instead
   of `SIM.pickupRadius`. The clamp now asks "can a player's body be here", which is the
   question a placement site is actually answering.

**The new gates, and which one catches what.** Worth spelling out, because two of the three
were green before the fix as well as after:

| Gate | Discriminates? |
|---|---|
| `smoke.test.ts` "no enemy stands where a player could not follow" | **Yes** — reverting the floor reports a mob 31 fp inside a solid at t326 of the ember run |
| `smoke.test.ts` "every alive pickup sits where a player body could stand" | **No, by measurement** — a CONTENT gate. Shipped rooms are authored on a 1000 fp lattice and 1000 fp is exactly two player radii, so no pocket exists that separates the two radii |
| `clearanceParity.test.ts` "the real death drop comes to rest somewhere a player body can stand" | **Yes** — on a 970 fp slot built to separate them, run end-to-end through `DeathDropsSystem` |
| `client/.../pickupProximity.test.ts` "the panel never offers a pickup the sim will refuse" | **Yes** — doubling the panel radius names the exact fp distances that betray the click |

That last one is the gap none of this doc's six covered, because it straddles the sim boundary:
the render layer decides whether to SHOW a clickable weapon row, `PickupSystem` independently
decides whether to HONOUR the click, and each half can be correct while the pair is not. Both
packages' suites stay green through it. It is also the only *shape* of "I can see it and cannot
pick it up" that the engine measurements above cannot rule out.

**The honest limit.** `clampToWalkable` separates, it does not escape: in a pocket narrower than
the clamp radius each wall pushes the point into the other, the pass makes no net movement, and
the early exit reports "settled" on a point still inside stone. So v50 is not a proof — what
keeps drops standable is that no shipped room has such a pocket, which is a content property,
which is why it is the smoke suite and not a unit test that enforces it. `clearanceParity.test.ts`
pins the limit itself, and pins that one authored grid cell is *exactly* two player radii — so
raising `PLAYER_BASE.solidRadius` by one fp seals every single-cell corridor in the game.

**Still open.** The report itself. Nothing in the engine now explains it, which is a result and
not a resolution: the remaining candidates are all on the render side of the boundary.

**And "the seed and floor" was the wrong ask (2026-08-31).** A seed does not reproduce a drop
position — a monster dies where the player pushed it to, so the whole run's input stream is the
repro. The engine could always replay one (`Replay = seed + config + input stream`, Stage E) and
nothing outside a test had ever recorded one. Now it does: **F9** in any offline run writes a
`ddreplay-*.json` marked at that tick, `?replay=<url>&pickupDebug=1` plays it back through the real
renderer and holds at the mark, and `DD_REPLAY=<path> npm run replay:inspect` reports every drop's
closest approach, swept path, gate and `pickup` event. See `design/08`'s "Getting a replay OUT of a
live session" and ROADMAP's entry — including the two ways the harness lied on its first run, both
of the shape this document exists for.

## What v51 found, in the sentence v50 wrote about it (2026-09-01)

The section above says the v50 sweep re-checked every drop *"again on every change to the wall
set (so a door locking over an existing drop is covered)"*. The trigger was real. The
parenthesis was not: **the case never once occurred in those runs**, so "covered" described the
harness rather than the content, and a zero came back that nobody had a reason to doubt.

It was a live bug. `DoorSystem.rebuildWalls` pushes each locked door's `passageAabb` into
`state.walls`; nothing re-clamped a pickup already lying there. Nothing touches a pickup after
its drop tick, and `PickupSystem` collects on a radius test that never consults walls — so
whether the item stayed reachable came down to whether a player's body could get within
`pickupRadius + p.radius` of a point buried in a passage rect. Fixed in v51 by re-clamping every
alive pickup at `dropClearance()` after the rebuild.

**The lesson is about the shape of the measurement, not the arithmetic.** v50's whole discipline
was to replace margins with constructions, and it did that for the two rules the reporter named.
But both of those rules — and every gate built for them — are about the moment of the drop. The
wall set changing *underneath* a resting item is a different question, and the sweep that
appeared to ask it only ever asked it of runs where the answer was trivially yes. A trigger that
fires 142 times and encounters the case zero times reports the same zero as a trigger that
works.

So: **a sweep's zero is only as strong as its evidence that the case arose.** The v50 write-up
recorded its per-drop counts, which is what made this checkable at all; what it lacked was a
count of the interesting sub-case. `client/sim/dropReachability.sim.ts` now reports both — 796
drops and 142 wall-set changes under live loot — and it is written to say plainly that neither
v50's clamp nor v51's re-clamp changes a single position on today's content. Its value is the
next tighter room piece, not this fix.

**Which gate discriminates v51**, in the format of the table above:

| Gate | Discriminates? |
|---|---|
| `systems/doors.test.ts` "a door that locks over a dropped item must not seal it inside stone" | **Yes** — three cases on a 2-room fixture: the sealed item is re-seated, an item across the room does not move by one fp, and the re-seated item is not parked on the far side of the closed door |
| `sim/dropReachability.sim.ts` | **No, by measurement** — a content gate, like the smoke pickup invariant it extends; no door in 16 bot-driven runs ever closed over a drop |

**Still open, restated.** The report is no longer unexplained by anything in the engine — v51 is
a mechanism that produces exactly the reported symptom, from an ordinary sequence (a mob dies on
a threshold, or a weapon is swapped in a doorway, and then the room activates). Whether it is
*the* report is still unknown and still needs a recorded run; a replay is the only thing that can
close it. What changed is that the engine now has one candidate too many rather than none.

**A gate-reading gotcha, recorded because it inverts what the gate appears to say.**
`goldenHash` passed with the v51 fix applied and `ENGINE_VERSION` still at 50 — that, and only
that, is the evidence the change moves no shipped scenario. The moment the version is bumped
every scenario's hash changes, dungeon or not, because `serializeState` hashes `version` itself.
Run the hash gate BEFORE the bump, or it tells you nothing at all.

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
in "What shipped" and "What v49 fixed" above.

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

**`engine/stepOrder.test.ts`** (2026-09-03) — not one of the six gaps below; it closes a
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

## Findings from building it

These came out of the new tests, not out of reading. Each is recorded as a live assertion
in the file named, so fixing it turns that test red and forces the `ENGINE_VERSION`
decision rather than slipping through.

**1. An actor can sit 6 px inside a wall for 3.4 seconds.** (`engine/smoke.test.ts`.)
`MovementSystem.tick` resolves walls *before* `resolveActorPairs`, so a pair shove is the
last thing in a tick and can push an actor back into stone. The tradition around that
ordering says it is "corrected on the following tick", and for a glancing shove it is —
but when two bodies are pinned together against a wall the pair push re-applies every
tick and the wall pass never gets the last word. Measured on the arena scenario: **one
episode of 103 consecutive ticks at up to 189 fp (6.05 px)**. That is the same order as
the v47/v48 reports that produced this doc. Bounded by `WALL_PENETRATION_ALLOWANCE` so it
cannot deepen unnoticed; the real fix (a second wall pass after pair resolution, or
splitting the pair push so neither side enters a solid) moves outcomes and needs a bump.

**2. `clampToWalkable`'s world clamp can undo its own wall push-out.**
(`engine/systems/boundaryParity.test.ts`.) The function pushes out of walls and pillars,
*then* clamps to `[radius, worldW - radius]` — and the clamp wins. In dungeon mode the
world bounds are the floor extent, whose edge IS the perimeter wall, one grid cell
(1000 fp) thick; the clamp parks the point at exactly `radius` (500 fp) from the edge,
inside that wall. 247 of 23,509 standable samples on shipped floor 1 come back
unstandable. **Not reachable today** — every caller passes a position at least one
room-interior cell from the floor edge — but a live trap for the next one that does not.

**3. Two placement sites clamp by the wrong radius, and both say so in a comment.**
(`engine/systems/clearanceParity.test.ts`.) `DeathDropsSystem` clamps a spawning minion
by `footprintRadius` under a comment saying "a spawned actor needs its own solid
clearance"; `DoorSystem.inLockingDoorway` tests the passage by `footprintRadius` under a
comment calling it "the feet circle solids actually push out". Both comments state the
rule correctly and cite the wrong radius, because the rule moved underneath them in v43
(players) and v48 (enemies). Measured consequence: a minion's first tick is a visible
teleport, scaling with body size.

**4. `hp` and `shield` are fractional in the replay hash.** (`engine/smoke.test.ts`.)
design/06 bans "native float in stored state"; shield regen produces 3.2, healing 4.2.
**Not a desync risk** — IEEE 754 specifies `+ - * /` as correctly rounded, so the same
operations in the same order are bit-identical everywhere, and the fields that would
*compound* error tick over tick (positions, velocities) are integers. Recorded as a
documented-rule-vs-code divergence, in the same family as design/07's swept-bullet claim,
so nobody "fixes" it into a pointless bump.

**5. `EngineConfig.walls` cannot express `freeStanding`.** It is a flat
`[x, y, w, h]` tuple, so no flat-config scenario or test can ever exercise the north brim.
This is why `engine/fixtures/brimGrinderFloor.ts` has to build a one-room dungeon.

### The lesson that cost the most

The golden gate's first version had four scenarios built from shipped content and looked
thorough. Its mutation check found that changing `WALL_NORTH_BRIM` from 23 px to 24 px
moved **none** of their hashes — the gate could not see the constant that motivated the
entire document. Two structural reasons (finding 5 above, plus a pseudo-random stick that
wandered past the one face under test for 1500 ticks) and one wrong instinct: the second
attempt used a smoothly *rotating* stick, which toured most of a 21×21 room and still
spent **0 of 800 ticks** near the target face, because a smooth orbit traces a circle and
a circle is very good at going around things. Only a deliberately *held* direction made
contact. **Emergent motion cannot be relied on to reach a specific target; measure that a
scenario touches what it claims to, and never infer it from how thorough it looks.**

## Docs drift found while writing this

All fixed in the same pass. Verified against the tree:

- `engine/README.md:35` — "currently **39**", actual 48.
- `engine/content/enemies.ts:283` — "ENGINE_VERSION 43/49"; there is no v49, should be 48.
  *(Snapshot taken at v48 — v49 and v50 exist now, and the comment was rewritten in v50.)*
- `engine/state/entities.ts:421` — `AABB`'s doc says *"The ONE thing that reads it is
  `MovementSystem.resolveWalls`… Nothing else may branch on it"*. `geom.ts` branches on
  it; so does `floorGeometry.ts`.
- `engine/systems/DoorSystem.ts:131` — the `footprintRadius` rationale (see G4) has been
  false since v43.
- `design/07-collision-combat.md:141` — claims swept bullet tests; the code is an endpoint
  test and says so.
- `client/src/game/scene/floorPartition.ts:47` — comment claims its rasterization
  "match[es] how the engine's own collision sees a cell"; the engine is circle-vs-rect
  with radius and brim, this is cell-centre vs bare rect.
- Commit `14e693b` (v47) cited `client/.../standingCoverParity.test.ts` as the guard for
  `WALL_NORTH_BRIM`. That file was **never created**; the equivalent assertion actually
  lives in `client/src/game/scene/occlusion.test.ts`. The v48 rewrite of that comment
  deletes the citation rather than correcting it.

## Relationship to the other docs

- **`06`** owns the determinism rules Layer 0 makes enforceable.
- **`07`** owns the collision boundary Layers −1/1/2 consolidate, and carries the swept-vs
  -endpoint claim G6 contradicts.
- **`08`** owns the step order the golden fixture pins.
- **`09`** owns the content tables the parity sweeps read.
- `CLAUDE.md`'s 500-line convention is why Layer −1 splits rather than grows `geom.ts`.
