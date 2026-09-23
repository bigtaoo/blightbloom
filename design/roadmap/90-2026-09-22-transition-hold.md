# Work log — 2026-09-22

Volume 90. See [`design/ROADMAP.md`](../ROADMAP.md) for the index and the phase spine.

## The loading screen was in front of the wrong door (2026-09-22, client + i18n + test + docs, no engine change)

> *"The loading screen I asked for, held for at least 3 seconds, was about the in-game screen
> switches — entering a map, returning to the lobby, that sort of thing. You put it in front of
> the home page instead. What I want is for players to get to the home page as fast as they
> possibly can. If you think the home page needs loading time, draw a transition page with a
> small amount of code — I'd guess under 1 kB is plenty."*

[Volume 86](86-2026-09-21-boot-splash-and-load-path.md) read *"when entering the game, add a
loading page, held for at least 3 s"* as the boot, and put a floor on the boot splash. The same
sentence's second half said *"I want the first page as small as it can be, and as fast as it can
be to get into"*, and nothing in that pass noticed the two halves were now pulling against each
other: it spent a day making the first screen arrive sooner and then held it up for three seconds
on purpose.

**"Entering the game" meant entering a MAP, not launching the game.** So this pass is one move:
take the floor off the front door and put it where it was asked for.

### What came off the boot

`bootHold.ts` is deleted. `hideBootSplash` fades and removes with nothing waited out in front of
it, `showBootLoading`'s `done()` is synchronous again, and `main.wechat.ts` no longer awaits it.

What stayed is [volume 86](86-2026-09-21-boot-splash-and-load-path.md)'s finding 1, which is the
half that was actually fixing the reported white screen: `afterFirstRenderedFrame` still waits two
ticker hops before the splash comes down, because `game.start()` populates the stage without
drawing it. That is a wait for a **real event**, and it costs a fast boot one frame. The floor was
a wait for a **clock**, and it cost every boot three seconds whether or not there was anything to
cover.

The transition page the request asks for already exists and is already that small: the static
markup in `index.html`, **~1.4 kB** of inline HTML and CSS (1,576 B of CSS with its comments
stripped, 342 B of markup), which paints on the browser's first paint of the document — before a
byte of the bundle has been parsed. Nothing about it changed; it simply comes down when it is done
now.

Two regressions are pinned rather than trusted, because the floor is a thing that looks identical
on screen whether or not it is there:

- `hideBootSplash` is asserted on an **equality** over its injected sleeps — exactly one, the
  fade — so a second wait added anywhere in that function fails rather than merely being slower.
- `showBootLoading(...).done()` is asserted to empty the stage on the statement *after* the call,
  with no microtask given up, and `main.wechat.ts` is asserted not to contain `await
  loading.done()`. An `await` there type-checks either way — awaiting a non-promise is legal — so
  that is precisely how the floor would come back.

### What the floor became

`controllers/ArtGate.ts` → **`controllers/TransitionGate.ts`**, and the rename is the change: it
now holds one screen for two different reasons, and only one of them is art.

`deferRunBoundary('run' | 'hub', retry)` sits beside the existing `defer(retry)`. It waits for
`MIN_TRANSITION_MS` (3 s) **and** for the run art, not whichever finishes first — `Promise.all`,
not `race`, because the case that matters is a cold cache where the floor elapses while the run
art is still downloading. The argument picks the caption (`loading.enteringRun` /
`loading.returningToHub`, eight locales) and nothing else.

Held: `beginRun` — which every route into a fresh run passes through, so START RUN, the portal's
one-click PLAY and the arena demo are all covered by that one call — plus `beginQuickRun`,
`beginTutorialRun`, `beginArenaDemoRun`, `resumeSavedRun`, `beginReplayRun`, and
`ScreenNav.leaveRunTo`, the one exit, called by `quitRun`/`saveAndQuitRun`, by `Game.confirm` on
the victory/defeat screen, and by that screen's MENU button.

**A third property had to be added to make that list safe.** The run entry points nest —
`beginQuickRun` → `beginRun` → `beginArenaDemoRun` — and each one asks the gate, so a naive floor
charges a player three separate three-second screens for one press. The gate now answers "not
deferred" while it is running a released transition's `retry`, which makes nesting free and makes
every existing call site's re-entrant `defer` cheaper as well.

**Two things it deliberately does not hold**, both stated in the code rather than discovered later:

- **`finalizeOnlineRun`.** The far side is a server already ticking. Three seconds here is three
  seconds of confirmed frames arriving for a run nobody can see — including the first one, which
  `GameLoop.resetOnlinePrediction` anchors on. That route has its own transition screen, and
  Matchmaking reports something real while it is up.
- **Plain hub navigation.** `showMenu`/`showLoadout` are also the loadout screen's BACK, the party
  screen's BACK and a cancelled queue. A floor on those makes the menu unusable, which is why the
  exit is a separate verb (`leaveRunTo`) rather than a rule about the destination.

The floor is only safe to sit on because **the sim is already stopped at every call site**: the
pause menu runs at phase `paused`, the outcome screen at `victory`/`defeat`, and every entry point
holds before the engine is built. A hold while the phase was still `playing` would be three
seconds of a player being hit by things they cannot see.

### The property that keeps 7,330 tests synchronous

`isRunArtReady()` has answered `true` until `beginDeferredArt()` is called since 2026-09-01, which
is what kept the art gate out of every unit test. A floor has no equivalent — it is a wait by
definition — so the same switch is now asked as the different question: `isDeferredArtArmed()`,
"is this a real boot". Only the three entry points arm it, so `deferRunBoundary` is inert in a
suite that drives `Game.beginRun()` and `ScreenNav.leaveRunTo()` directly. Without that, this pass
is either a suite that hangs or one that silently swallows every transition it asserts on.

The source sweep that lists the gated transitions now asserts on the **method name**, not on
`transitions.` — a plain `defer` at any of those call sites takes the floor back off the
transition this request was about, and every behavioural test in that file stays green.

### The battery, and the nine things it found

39 mutants over the changed code, judged by nine suites. Two controls (a comment, an equivalent
type spelling) survived as designed, 0 unmeasured, 0 hung — and the first run reported **10
SKIPs**, all of them multi-line find-strings, because a fresh `git worktree add` under
`core.autocrlf=true` hands back CRLF where the shared tree holds LF. That is a number nobody
measured dressed up as a result; the harness normalises to LF for matching and writes back in
whatever the file used.

**9 real survivors.** One was dead code and eight were test gaps.

- **The floor's own VALUE was unpinned.** `MIN_TRANSITION_MS: 3000 → 300` passed everything,
  because every case compared `clock.slept` against the constant — a tautology over the one
  quantity the request actually named. Now asserted as a literal, and as a floor, so a
  deliberate lengthening is not a test edit and a silent shortening is.
- **`Promise.all` → `Promise.race` survived a case written to kill exactly it.** The case
  drained one microtask (`await Promise.resolve()`) and the mutant resolves one link further
  down; the assertion that nothing had happened ran before the thing could happen. An
  assertion about an ABSENCE is only worth its wording if it gave the thing every chance to
  occur — a full macrotask turn here.
- **The bar's opening value was dead code, not an untested one.** `screen.setProgress(0,
  runArtUnitCount())` in front of `ensureRunArt` looked like sizing the bar before the first
  tick. `ensureRunArt` replays where the download already is, *synchronously*, as it registers
  the listener — so the explicit zero was overwritten on the next statement, and in exactly
  the case its own comment described (a gate opening at 12 of 16 units) the zero was the wrong
  number. Deleted; the property it was reaching for is now asserted against a host that
  settles some packs and blocks the rest.
- **`leaveRunTo` could say ENTERING THE DUNGEON on the way out.** The `ScreenNav` stub dropped
  the direction argument, and the direction is the caption — the one half of that call no
  behavioural assertion can see, since both directions hold for the same three seconds and
  land on the same screen. Its two destinations could also be swapped silently; `leaveRunTo`
  had no case at all.
- **Both result-screen exits could be re-wired to the plain `showMenu`/`showLoadout`.**
  `leaveRunTo('menu')` and `showMenu()` land on the same screen, so every phase assertion
  passes either way and what the plain call skips is three seconds of transition. `gameWiring`'s
  stub had no `leaveRunTo` at all, so nothing had ever fired `screens.onMenu`. A new
  `gameRunExit.test.ts` drives the real result-screen buttons through a headless `Game` and
  asserts the VERB, with a control that `confirm()` from the lobby reaches no exit at all.
- **The tutorial's exit flag could be cleared before it is read.** One statement's order:
  clearing first sends every tutorial exit to the loadout screen — a screen the tutorial never
  touched — and neither screen looks wrong when it happens.
- **A floor can be re-added at the CALL SITE.** Both removals are pinned inside the modules
  that owned them, and neither stops `await new Promise((r) => setTimeout(r, 3000))` appearing
  as its own statement in an entry point. So the rule is now stated about the entry points:
  everything `boot()` waits for is a real event — a download settling, a frame the renderer
  drew, an identity answer — and none of those is a duration. All three entries hold to that
  today, which is what makes the absence assertable rather than aspirational.

Re-run against the fixes: **37 of 39 killed, the two survivors both controls.**

### Two things this cost that are worth recording

`Game.ts` and `RunLifecycle.ts` both crossed 500 lines on the first draft (503 and 509). Neither
was baselined: the additions were prose, and the prose was trimmed back. Both now sit at exactly
500, which is the drift gate working — the next edit to either will have to shrink something.

`design/12`'s account of the boot floor is rewritten rather than deleted, and `ArtGate.ts` /
`bootHold.ts` are allowlisted in `checkDocPaths` as names a doc cites *as gone*. A doc that quietly
stops mentioning a decision it reversed is how the next pass makes the same mistake.

Client 7,333 → **7,344** green (7,330 before the battery: `bootHold.ts` went out with its nine
cases, and the pass had put six back; the battery added fourteen more). No `ENGINE_VERSION`
bump.
