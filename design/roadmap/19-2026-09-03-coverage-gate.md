# Work log — 2026-09-03: coverage becomes a gate, and Game.ts stops being the shell that holds everything

Volume 19, and the fourth pass of the same day. The ask: *"follow funny's approach to test coverage: the client's
tests must be over 90%. Split the logic out and test it separately. Run the logic-consistency test on every CI run."* — adopt funny's coverage
approach, get the client over 90%, split the logic out and test it on its own, and run the
logic-consistency tests on every CI event.

Indexed from [`../ROADMAP.md`](../ROADMAP.md).

## The client was already over 90%, and nothing had ever measured it (2026-09-03, build + client + server + engine, no engine bump)

### The measurement came first, and it moved the plan

Before writing anything, `@vitest/coverage-v8` went in and every package was measured over its
whole source tree. The result changed what the pass was for:

| Package | Lines | Branches | Functions | Scope |
| --- | --- | --- | --- | --- |
| client | **96.52%** (8047/8337) | **90.03%** | 92.06% | all 217 source files, none missing |
| engine | 97.70% | 92.95% | 98.75% | whole package |
| server | 85.23% | 78.27% | 79.74% | whole package |

So the client's "over 90%" was already true, and true over the WHOLE tree rather than over a
flattering subset. The sibling project `funny`, whose approach the ask names, cannot say that:
its client scopes coverage to a hand-written allow-list of `src/game/**` plus ~50 individual
files, because its render layer sits at 0–15% and would drown the number. That list is
explicitly transitional there and carries its own guard test, because every way it breaks is
silent — a stale entry matches nothing, one fewer file is measured, and the percentage goes UP.

What was actually missing here was not coverage. It was three things:

1. **Nothing measured it.** No provider installed, no script, no CI step. The number was true
   by accident and could stop being true with nothing to say so.
2. **Branches sat 0.03 percentage points over the bar.** The next unexercised `if` would have
   taken the client under a 90% branch gate — and every "back-fill" note in this repo quotes LINE
   coverage, which is the column that was comfortable.
3. **Nothing stopped the scope from being narrowed.** The one edit that raises every number
   without adding a test.

### The gate, and the rule funny does not have

`build/coverageLib.mjs` + `checkCoverageThreshold.mjs` + `coverageReport.mjs`, ported from
funny's three-script shape: one shared `evaluate` so the report and the gate cannot disagree,
**90% lines AND 90% branches**, functions reported but never gated (it is the metric most
easily satisfied by calling a function once and asserting nothing), fail-closed on a missing
`coverage/`, and an empty-package-list canary so the gate cannot retire itself by turning
green.

Two deliberate departures:

- **No exemption list.** funny had one as a bounded transition device and retired it with the
  reasoning this repo inherits up front: leaving a working way to be exempt is a standing
  invitation to reach for it. `server` is on the gated list because it was brought over the
  bar in this same pass, not because it was excused.
- **A `scopeShrunk` rule, which funny has no equivalent of.** It fails when the coverage report
  holds fewer files than the package's source tree — i.e. when `coverage.include` has been
  narrowed. It is the rule that lets this repo hold a whole-tree include where funny needs an
  allow-list, and it uses the answer vitest's own matcher just produced rather than re-deriving
  the globs. Verified by mutation, and the mutant is the argument: narrowing the client's
  include to `src/game/**` reports **97.68% lines / 92.13% branches — both green** while
  measuring 130 of 224 files. Every other signal in the setup says that edit is fine.

`build/coverageScope.test.mjs` is the static half (an include entry naming an individual file
fails outright — the inverse of funny's guard, because the risk here is a whitelist APPEARING,
not one rotting) and `checkCoverageThreshold.test.mjs` is the gate's own suite: 23 cases over
synthetic package trees, including both failure KINDS kept apart, the `TESTS_OK` hand-off, and
a typo'd `COVERAGE_THRESHOLD` falling back to 90 rather than to `NaN` (every `pct < NaN` is
false, so a typo would silently pass everything).

One test needed an exemption: `arenaWallCoverage.test.ts`'s whole-map sweep runs twice and
costs 13x under v8 instrumentation — 623 ms bare, 8.4 s measured — so it times out at vitest's
5 s default the moment coverage is on. It got a 30 s timeout **on that one case**. Raising the
global timeout was the cheaper edit and the wrong one: it would give the other 4,800 cases two
minutes to hang before saying so, and a hang that eventually reports is exactly the failure
this repo's mutation work keeps mistaking for a kill.

### The server: 85.23% → 99.32% lines, 78.27% → 95.44% branches

The gaps were not obscure corners. `POST /find`, `GET /find/:queueId`, all five `/party/*`
endpoints, the join-code generator and the entire PvP bot-backfill block had **no coverage at
any layer** — while the pure cores under them (`Matchmaker`, `PartyService`) were thoroughly
unit-tested the whole time. That is what made the gap invisible: the logic was proven and the
wiring to it was not, so a swapped argument in the HTTP shell would have shipped green.

Two real bugs came out of writing the cases, both found by the FIRST test that touched the
code rather than by review:

- **A bot seat failing to connect took down matchsvc.** `WsTransport` (BotClient.ts) registered
  listeners for `open` and `message` and none for `error`. In Node an `'error'` event with no
  listener is an uncaught exception, so an unreachable gameserver — matchsvc outliving a
  gameserver restart, which is the normal deploy order — killed matchmaking, parties, accounts
  and the ladder along with the one bot. Verified by pointing a bare `ws` client at a dead
  port: `connect ECONNREFUSED`, process gone. The class had been at **0% in every suite in the
  repo**, invisible because `BotClient.test.ts` drives the bot through an injected in-process
  `Transport` and therefore never touches the seam it replaces.
- **`verifyTicket` threw on a validly-signed `null` payload.** `JSON.parse('null')` succeeds and
  the `try` cannot catch what happens next; the very next property read throws, out of a
  function whose own doc comment promises that every malformed token returns `null`. Both call
  sites are request handlers. Forging it needs the real secret, so it is an issuer bug rather
  than an attack — but the crash is the whole process either way.

Three seams were added so the untestable halves could be reached: `MatchsvcServerOptions` gained
`matchmaker` timing overrides (bot backfill is a 30-second wait in production, so `onBotFill`
was unreachable at any sane runtime) and a `spawnBot` injection point; `index.ts`'s `main()` was
exported with injectable port/host/exit, because the SIGTERM path — destroy rooms, then close
the socket layer, then the server — is the one piece of that file with no other way in and a
real consequence (rooms not destroyed first leaves each metronome interval running and the
process never exits on deploy).

The branch pass afterwards is what took 78% → 95%: `MatchRoom.guards.test.ts` alone covers every
early `return` that says "no, not from you, not now". Those lines all EXECUTE — only the taken
side runs — so the file read 99.08% lines / 83.14% branches while every trust boundary in it was
unexercised. That is the argument for the branch bar in one file.

### Game.ts: 1135 lines → 497, and the baseline entry retired

The file's own baseline note had nominated the run-lifecycle boundary **twice** as "the next
real candidate", and twice defended `start()`'s screen-callback wiring as inherently belonging
in the assembly shell. Both were overturned, and the second was overturned by the first: that
wiring argument was right while the verbs it wired also lived in the file (the picture WAS the
file), and became ninety lines of `this.a.b = () => this.c.d()` in a class that owned neither
side once they moved.

The reason the boundary had stalled twice is visible the moment you try it: `beginRun`,
`showForge`, `quitRun`, `finalizeOnlineRun` and `confirm` all read and write the same dozen
fields, so any cut leaves two halves calling each other — which CLAUDE.md names outright as a
sign the boundary is drawn wrong, with the prescribed answer being to extract a shared lower
layer. So that came first:

**(0) `src/game/runState.ts`** — every mutable RUN field (phase, meta, the mode flags, engine,
session, score, runCount, localOwner, replayStop), PIXI-free by construction. With the state
below both, the rest are ordinary form-(2) composition over typed deps objects:

**(1) `controllers/ScreenNav.ts`** every phase→screen transition, the settings/pause overlays,
relayout. **(2) `controllers/RunLifecycle.ts`** the five run entry points, the one exit, the
render reset they share, the replay export. **(3) `controllers/OnlineMatch.ts`** queue mode, the
injected connect function, cancel and lost-connection. **(4) `controllers/ForgeInput.ts`** the
forge key table. And two form-(1) free-function tables with no state at all:
**(5) `controllers/gameWiring.ts`** (the callback table, plus `keydownAction` as a pure function
so "pause and F9 are offline-only" is assertable without a `window`) and
**(6) `controllers/gameAssembly.ts`** (the late-construction order, each step's reason, and the
one deferred back-reference named rather than rediscovered).

Behaviour-preserving, and verified as such: 4,659 client tests green before and after each
stage, `tsc --noEmit` clean, the engine's golden fixture untouched. `client/` now has **zero**
files over 500 lines and an empty file-length baseline.

The split immediately cost coverage — branches fell to **89.89%, under the bar** — because logic
that had been incidentally exercised through `Game` was now its own file with no suite. That is
the gate working: the numbers said out loud what "extracted but not tested" is worth. Five new
suites (`runState`, `ScreenNav`, `RunLifecycle`, `OnlineMatch`, `ForgeInput`, `gameWiring`)
brought the client to **97.70% lines / 92.12% branches**, better than before the split.

`src/game/pureLayerBoundary.test.ts` is what keeps the pure layer pure, and it exists because
the percentage cannot do that job: at ~96% the gate's headroom is hundreds of lines and GROWS as
the tests improve, so a file importing `pixi.js` can be dropped into the pure layer and the gate
stays green. Adapted from funny's version, with the same two halves (no runtime import may reach
a browser-dependent module; the file may not touch a browser global itself) and one calibration
difference recorded in the file. Its own survey found two modules that had qualified all along
and were unlisted — `attackShapes.ts` and `localOutcome.ts` — which is the survey working.

### Logic consistency, by name, on every CI event

`npm run check` already ran every one of these tests, which is exactly the problem:
`goldenHash`, `versionContract`, `determinismLint`, `stepOrder`, `smoke`, the four parity
sweeps, `pickupProximity` and `meleeArcParity` are the highest-value gates in the repo, and any
of them can stop running with nothing turning red. Rename a file and the suite reports one fewer
test; nothing anywhere says which tests were SUPPOSED to run.

`build/logicConsistency.mjs` is the manifest — 12 gates, each with the reason it qualifies (an
agreement between two separately-maintained things that can drift apart in silence, not merely
an important test). `--run` executes exactly those; a named entry that no longer resolves fails
closed. `logicConsistency.test.mjs` guards the manifest the other way: it DISCOVERS gates from
the tree by design/18's own naming conventions and fails if one is not listed, so a new parity
test cannot quietly skip the step.

`.github/workflows/check.yml` grew from two jobs to four — `logic`, `check`, `coverage`, `sims`
— all independent, all on every push and pull request. `coverage` runs the whole suite under
instrumentation and then the gate, uploads the HTML report as an artifact even on failure, and
passes `TESTS_OK` so a missing `coverage/` after a failed test run is reported as the
consequence it is rather than as a second, louder failure.

**Final state: client 97.70% / 92.12%, engine 97.67% / 92.86%, server 99.32% / 95.44%, all three
gated at 90/90 over their whole source trees. 4,810 client tests (+151), 285 server (+96), 1,164
engine. Two production bugs fixed, both found by writing the first test that touched the code.**
