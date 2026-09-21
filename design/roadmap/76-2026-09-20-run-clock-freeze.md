# Work log — 2026-09-20 → 09-21

Volume 76. See [`design/ROADMAP.md`](../ROADMAP.md) for the index and the phase spine.

## The tutorial froze, and the seam every green suite stubbed (2026-09-20 → 09-21, client + test + docs, no engine change)

Written 2026-09-21, after the code had already landed and merged (PR #31) with no work-log entry
of its own — the fix, the test that followed it and the doc pass that closed it are one pass and
are recorded here as one.

### The report, and the one screenshot that contained the whole shape of it

*"新手教程，点进去就卡住了。有时候是好的，有时候不行"* — the tutorial freezes on entry,
intermittently. The screenshot answered most of it before any code was read: the arena's ground and
walls were drawn, there was **no player and no portal in them**, and the HUD still held the
PREVIOUS run's chips (floor 2/2, score 140, coins 5, buffs 1) with its extraction popup still open.
A room built and then abandoned, over a HUD nothing had reset.

### One boolean, read once a frame, routing the whole frame

`GameLoop.update` reads `run.online` once per frame and sends that frame to one of two loops: the
local fixed-step sim, or the confirmed net stream. `OnlineMatch.beginSoloQueue` sets the flag
**before any screen is shown**, so by the time the PvP preview is on screen the run is already
declared online — and the preview's BACK was wired straight to `nav.showMenu`
(`gameWiring.wireScreens`). Backing out walked to the lobby with the declaration still standing.

The next OFFLINE run — any of them; the report's route was the lobby's TUTORIAL row — then entered
`advanceOnline`, found no session, held the scene and returned. So the room
`RunLifecycle.enterPrimedRun` had just built stayed on screen with nothing alive in it, the sim
never ticked, `updateHud` never ran, and — `keydownAction` and `HudView.onPause` are gated on the
same flag — **Escape and the pause button were dead too**. No error in the console, no way out but
a reload. Intermittent exactly as reported, because it takes a visit to the preview first and the
lobby looks identical either way.

### Fixed at both levels, because either alone is a patch

- **BACK leaves the QUEUE, not the screen.** `pvpPreview.onBack` now calls
  `OnlineMatch.onCancelled` — the verb the Matchmaking screen's CANCEL already used, which clears
  the flag and the party id and routes to the lobby by itself (`matchmakingReturnPhase` is `'menu'`
  on the solo-queue path, so one method serves both callers and BACK still lands where the button
  says it does).
- **The clock is declared once, where every run passes.** `RunLifecycle.resetRenderState` now sets
  `run.online = false` by default and `finalizeOnlineRun` — the single online entry point —
  re-declares it immediately after. No offline caller had ever set it; the point is that a future
  screen cannot reintroduce this by forgetting to.

### The green suites, and why not one of them could have caught it

This is the transferable half. Every piece of the broken path had unit coverage the whole time:
`OnlineMatch.test.ts` proves `beginSoloQueue` sets the flag, `gameWiring.test.ts` proves BACK calls
what it is wired to, `RunLifecycle.test.ts` proves each entry point stands an engine up. **The flag
is written by one controller, read by a second, and leaked by a screen owned by a third — and each
of those suites stubs the other two.** A seam owned by nobody is invisible to every test that
mocks its neighbours, however green.

So `client/src/game/gameRunClock.test.ts` drives the REAL `Game` on a fake app through the REAL
screen callbacks (PVP SOLO QUEUE → BACK → TUTORIAL) and asserts what a player can see: the sim
advanced, and **there is somebody standing in the room it built**. Deliberately not `run.online` —
that is the mechanism, and asserting the mechanism is what left the gap. `Scene.reconcile` only
ever creates the player's view inside a sim step, so that second assertion is the half of the
reported screenshot a tick counter cannot express.

Four cases, three of them controls rather than repetitions: the reported route (fails without the
fix); the tutorial reached straight from the lobby, which always worked (without it the first case
could pass for an unrelated reason); SOLO PvE → START RUN after the same trip, because the leak
reached every offline route out of the lobby and not the tutorial row specifically; and the
opposite direction — once `finalizeOnlineRun` has adopted a session the local engine must STOP
being stepped, which is what pins the re-declaration rather than leaving it a line nothing would
miss. Verified against the pre-fix code with both halves reverted: 3 of the 4 fail and the control
passes; reverting only the `finalizeOnlineRun` re-declaration fails the fourth alone.

### The one test that changed rather than being added had been leaning on the gap

`gameReplaySave.test.ts` pressed F9 after `finalizeOnlineRun` to prove the recorder had been ended
— which only ever reached `saveReplay` because the flag was unset at that point. F9 is offline-only
by design, so it now presses the HUD's record button instead: the surface that is genuinely
ungated, and therefore the one that guard exists for. A test that passes *because* of the bug is
the cheapest early warning there is, and it took a deliberate revert to notice this one.

### What the docs say now

- **`design/10`'s shipped-preview bullet** records that this screen's two exits are not symmetrical
  the way the buttons look: QUEUE goes further in, BACK has to undo a declaration made before the
  screen was drawn.
- **`design/18` gained Layer 7** (2026-09-21, this pass) — the assembly axis. The nine
  `client/src/game/game*.test.ts` files have been driving a real `Game` through real screen
  callbacks since 2026-08-25, and the strategy doc had never named them or said what they are for,
  so the layer that catches a cross-controller seam existed as a habit and not as a rule.

### Also

`.claude/launch.json` gained a `client-dev-alt` entry on port 5183, for a session that finds 5173
taken by another checkout's dev server.
