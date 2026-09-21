<!-- Split from design/18-test-strategy.md (2026-09-21): the six layers as they were actually
     built and measured — 4 coverage, 5 content, 6 deploy, 7 assembly. Layers −1–3 are in
     [02-the-six-gaps-and-the-original-plan.md](02-the-six-gaps-and-the-original-plan.md),
     where they were planned. The index is [../18-test-strategy.md](../18-test-strategy.md). -->

# Test strategy, part 1 — the layers as built

Part 1 of [`design/18-test-strategy.md`](../18-test-strategy.md), which holds the status block,
the `What shipped` table and the map of which part every section is in.

## Layer 4: coverage as a gate, and the two things a percentage cannot say (2026-09-03)

The layers in [part 2](02-the-six-gaps-and-the-original-plan.md) answer "does the logic agree
with itself". This one answers a different
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

The branch column has a **second** use, found 2026-09-17 (`roadmap/72`): read per-file, over
only the files a pass touched, it is the cheapest way to find a test that pins nothing. An
uncovered arm sitting directly under an assertion whose comment names that arm is the signature
of a tautology — there, `m.mode ?? 'coop'` was uncovered beside
`expect(brainFor('coop')(state, 1, 5)).toEqual(ally)`, where `ally` was the same call, green
forever and claiming to be the fallback's test. It takes one command
(`vitest run --coverage --coverage.include='src/<file>.ts'`) and it is not something a mutation
battery will do for you: a battery only mutates what somebody thought to list, so it cannot
find the arm nobody knew was bare.

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

Every [Layer 0](02-the-six-gaps-and-the-original-plan.md#layer-0--contract-gates-closes-g1-g2) and
[Layer 2](02-the-six-gaps-and-the-original-plan.md#layer-2--parity-sweeps-closes-g5-g6) gate already ran inside `npm run check`, and that is precisely
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
**five** flat ESM bundles (four when this was written; `adminsvc` landed 2026-09-09) that
`server/scripts/build.mjs` produced by collapsing the `@dd/engine` / `@dd/game/*` / `@dd/net/*`
workspace graph into one file per process, with `ws` and `mongodb` left external — it was `ws`
and `node:sqlite` until the MongoDB port on 2026-09-15 — inside a container whose behaviour is
set by four more files. Four of the five are the HTTP planes; the other is the backup worker that
landed later the same day, and it is the one that made this layer's own assertions turn out to be
shaped around "a service answers a route".
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
deploy manifest does not list fails here exactly as it would in the container. Each HTTP bundle is
then started as a bare `node` process and has to answer its own `/health` with its OWN service
name — `{ok: true}` alone would wave through a mis-mapped entry in `build.mjs`, which is one typo.
Proven by deleting `ws` from `deploy/package.json`: two of the three HTTP boots go red with the
production stack trace in the failure message.

**The worker bundle has no route, so it is driven the way compose drives it.** `backup.mjs`
(2026-09-07) is started the same way and then verified through its own OUTPUT: wait for the
`status.json` its first cycle publishes, **gunzip the snapshot it actually wrote and read a row
back out of it**, then ask the same bundle for its health verdict in a second process
(`node backup.mjs --health`), which is literally the container's healthcheck. A second case
asserts it exits non-zero with a named reason when misconfigured — the failure that would
otherwise be a container coming up green and backing up nothing. This is the only place the
snapshot path runs through the built artifact against a real store, which is where it runs. It
was `VACUUM INTO` over `node:sqlite` until 2026-09-15 and is a cursor per collection over the
cluster now; the case survived the port because it asserts on the OUTPUT — decompress the
snapshot and read a row back — rather than on the mechanism.

**`deploy.manifests.test.ts` cross-checks the five places the same facts are written down** —
`scripts/build.mjs`, `Dockerfile`, `docker-compose.yml`, `deploy/package.json`,
`deploy/ci-deploy.sh`, plus the `tar` list in `.github/workflows/server-deploy.yml`. Bundle names
must agree across build script, compose `command:`, the forced command's payload check and what
CI actually ships; the deploy manifest must declare exactly the non-builtin externals, each at an
exact version; the base image's Node major must be at least `build.mjs`'s `target`; every compose
env var must be a name `src/` actually reads; no secret may be inlined where `env_file: .env`
is the mechanism; each service must expose and healthcheck **its own** port; and every internal
`http://` URL must name a real service at the port that service listens on. Since the worker
joined, the file also asserts that a WORKER exposes nothing, healthchecks its own bundle with
`--health` (naming the same file its `command:` runs, so the health rule cannot drift into a
second inline implementation), and mounts every service data directory `:ro`. The HTTP/worker
split is two explicit lists rather than "whatever has a port variable", on purpose: derive it
and an HTTP service that merely forgot its port silently becomes a worker with no port
assertions at all. `build.mjs` was
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

**Every manifest is read LF-normalised, and a guard test pins that** (2026-09-14). These are the
only tests in the tree that pattern-match raw file text, which makes them the only ones a line
ending can break: `core.autocrlf=true` with no `.gitattributes` means each manifest is CRLF in a
Windows worktree and LF in CI, so a regex anchoring on a literal `\n` mid-pattern matches on one
machine and not the other. It cost a real bisect — the backup-mount assertion extracted an empty
block and failed as `expected '' not to be ''`, which reads like a broken deploy manifest rather
than a checkout artifact. Normalising in the `read()` helper rather than spelling `\r?\n` at each
use site is the point: the per-site version has to be remembered every time a regex is added, and
the failure mode of forgetting it is a test that still passes in CI. Worth knowing before trusting
the green column here — most line-anchored patterns survive CRLF *by accident*, because JS counts
CR as a line terminator, so multiline `$` matches in front of one; `deploy.observability.test.ts`
and `heartbeat.test.ts` passed for exactly that reason and are normalised now too, by
construction rather than by luck.

**Cost and evidence.** `deploy.manifests.test.ts` is 27 cases in ~20 ms of test time (it only
reads files; ~1.1 s wall clock, nearly all of it transform and import);
`deploy.bundle.test.ts` is 8 cases in ~1.5 s including the esbuild run, three HTTP boots and the
worker's own cycle.
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

**The hole this layer had for a day, and what it cost to close (2026-09-16).** Everything above
iterates over `build.mjs`'s entries, which makes it blind to something that must run in production
and is not an entry. The MongoDB cutover's one-time migration was exactly that: the runbook told an
operator to run its TypeScript source under `tsx`, inside an image built by `COPY dist/*.mjs ./`
that has no `scripts/`, no TypeScript and no `tsx`. The migration's own suite was at 100% lines
against a real cluster, and this layer could not catch it because there was no bundle for it to
boot — "every bundle boots" is not "everything that must run, runs". The general shape is that **a
step which runs once, by hand, on the day everything is stopped is the step nothing routinely
exercises**: migrations, restores, key rotations. Two moves closed it, and both belong to this
layer rather than to more branch coverage. First, package the one-time tool like a process (a
build entry, so the machinery above covers it) and then RUN it end to end in the runbook's own
order — dry run, real run, and the refusal that stops a second run — against real inputs. Second,
assert the runbook's own command against the filename the build emits: **a command written in a
runbook is deployment configuration**, one more copy of a name no compiler compares, exactly like
a compose `command:` or a CI payload list. The tool is gone; what stayed is `service: true|false`
on each build entry, so the next bundle that no service runs is filtered out of the cross-checks
explicitly instead of being added to an exemption list.

**What this layer deliberately does not do** is run Docker. Building the image and starting the
compose project needs a daemon CI would have to provide, and the two properties that actually
break — "the bundle can resolve everything it imports" and "the manifests agree" — are both
reachable without one.


## Layer 7: the assembly axis — the seam every unit suite stubs (2026-09-21)

The layer was **named** on 2026-09-21; the tests have been there since 2026-08-25. That gap is the
finding. Nine files — `client/src/game/game*.test.ts`, 67 cases — build a real `Game` on a fake
Pixi app and drive it only through the callbacks the real screens expose, and each one says so in
its own header ("end to end through `Game`"). Nothing in this document mentioned them, so the
practice that catches a cross-controller defect was a habit somebody had to already know about.

**What the axis is for.** Layers 1 and 2 test a unit and a pair of units that must agree. This one
tests the WIRING: a value written by one controller, read by a second, and reachable from a screen
owned by a third. Every unit suite on such a path stubs its neighbours, which is exactly the
property that makes each of them green while the assembled thing is broken.

The instance that forced the name (2026-09-20, `gameRunClock.test.ts`, volume
[76](../roadmap/76-2026-09-20-run-clock-freeze.md)): `run.online` decides, once per frame, which of
two loops `GameLoop.update` runs. `OnlineMatch.beginSoloQueue` set it before any screen was drawn,
and the PvP preview's BACK was wired straight to `nav.showMenu`, so backing out of the preview left
the flag standing and the next OFFLINE run entered `advanceOnline`, found no session, and froze —
a built room with nobody in it, a HUD holding the previous run's numbers, and a pause key gated on
the same flag. Three suites covered the three pieces (`OnlineMatch` proves the flag is set,
`gameWiring` proves BACK calls what it is wired to, `RunLifecycle` proves each entry point stands
an engine up) and all three were green throughout.

Two rules this layer carries, both learned from that case:

- **Assert the observable, never the mechanism.** `gameRunClock` asserts that the sim advanced and
  that somebody is standing in the room — not `run.online`, which is the flag whose unit-level
  assertion was already green. A mechanism assertion in an assembly test buys the coverage of a
  unit test at the cost of an assembly test.
- **Ship the control with the case.** Three of that file's four cases exist so the first cannot
  pass for an unrelated reason: the same screen reached without the trip through the preview, a
  second offline route out of the lobby, and the opposite direction (once a session is adopted the
  local engine must STOP being stepped).

**The cost, and why it is not Layer 3.** These run in the client's ordinary vitest suite with a
stubbed `document`/`canvas` (`installFakeTextCanvas`) and a hand-built app object, not in a browser
and not against a server — they are cheap enough to sit beside unit tests. `engine/smoke.test.ts`
(Layer 3) asks whether invariants hold over real RUNS; this asks whether the client's parts are
still connected to each other.
