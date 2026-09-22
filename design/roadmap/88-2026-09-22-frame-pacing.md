# Work log — 2026-09-22

Volume 88. See [`design/ROADMAP.md`](../ROADMAP.md) for the index and the phase spine.

## The frame rate was fine and the frames were not (2026-09-22, client + monitoring + docs, no engine change)

> *"我感觉现在游戏的帧率有问题啊。我在电脑上玩20分钟左右就头晕。你有相关的统计吗"*
> — *"I think there's something wrong with the frame rate. About twenty minutes on my PC and
> I get dizzy. Do you have any statistics on this?"*

**The honest answer to the question that was actually asked was no, and that is the finding
this volume starts from.** `src/perf` has run in every session since 2026-08-24. It samples a
window every 2 s, splits each frame into update and render, and has a documented seam
(`onWarn`/`onSnapshot`) where a backend would attach. It could not have produced the number in
question even in principle, for two independent reasons:

- **Its only sink was a `console.warn` behind a threshold nothing normal reaches** — five
  consecutive windows under 25 fps. The machine in the report was holding ~58.
- **A window carried no metric for judder at all.** fps, p50, p95, max: an average and a
  percentile both miss a defect that is 3% of frames, because at 3% the bad ones are inside the
  5% the percentile discards. A frame-rate number is a claim about how MANY frames arrived; the
  complaint was about WHEN.

So the work is one mechanism found by reading, two more found beside it, and the telemetry that
should have found all three.

### `Ticker.maxFPS` is not a rate, it is a gate — and it drops frames on an ordinary 60 Hz panel

The desktop in the report is 1920x1080 @ 60 Hz (Intel Arc Pro, panel maximum 100 Hz). The frame
cap added on 2026-09-08 for battery (volume 81, *the frame nobody sees and the 120 Hz nobody
asked for*) applies on every platform, so a run there writes `ticker.maxFPS = 60` every frame.
Pixi stores that as `_minElapsedMS = 1000 / maxFPS` and gates on it like this:

```js
const delta = currentTime - this._lastFrame | 0;   // truncated to whole milliseconds
if (delta < this._minElapsedMS) { return; }        // the whole frame is skipped
this._lastFrame = currentTime - delta % this._minElapsedMS;
```

Two properties of those three lines, neither documented by Pixi:

1. **The truncation costs up to a full millisecond.** A 60 Hz interval is 16.67 ms, which
   truncates to 16 and loses to a `_minElapsedMS` of 16.667.
2. **A fractional `_minElapsedMS` makes the carried-forward phase drift**, because `delta` is an
   integer and the remainder is not — the residual grows on every pass until it crosses an
   interval and a frame goes.

With perfectly spaced timestamps the second effect hides the first. **That is exactly what
`powerBudget.test.ts` was driving** when it pronounced the cap healthy in September: `t += stepMs`
produces vsync timestamps no display has ever produced, and the case asserted a COUNT (`ran >=
118` of 120) rather than a cadence. Real timestamps are not perfectly spaced. At ±0.2 ms of
jitter — less than the noise in any real rAF timestamp — the same gate against the real `Ticker`
drops **103 frames a minute: a doubled frame about 1.7 times a second, indefinitely**. Twenty
minutes of that is roughly 2,000 hitches, and judder is what makes people ill; a steady 58 fps
is not.

`tickerCapFor` replaces the raw number with the cap the gate can actually honour:

- a display **already at or below the target is left uncapped** (`0`), because a gate can only
  remove frames the display was going to show anyway — this is the case in the report, and the
  1.02 slack on the comparison is because a "60 Hz" panel is routinely 59.94 or 60.02 and the
  rule must not be decided by the third decimal of a measurement;
- an **unknown** display rate is capped at the target's own whole millisecond — better than not
  capping, since the 120 Hz waste the power budget exists to stop is real;
- a **faster** display has the target snapped to a whole number of vsyncs per frame first,
  because that is the only kind of rate a vsynced display can deliver evenly at all.

Measured against the real `Ticker`, uneven frames as a share of frames drawn:

| display | target | shipped 2026-09-08 | after |
| --- | --- | --- | --- |
| 60 Hz | 60 | 58.3 fps / 2.9% | **60 fps / 0%** |
| 120 Hz | 60 | 58.3 fps / 5.7% | 60 fps / 0.2% |
| 144 Hz | 60 | 58.8 fps / 44.7% | 73.5 fps / 4% |
| 90 Hz | 60 | 58.2 fps / 45.5% | 44.9 fps / 7% |
| 60 Hz | 30 | 29.6 fps / 3% | 30 fps / 0.1% |

Four things that table settles:

- **The 90 Hz row is a trade, not a regression.** 90/60 is 1.5 vsyncs per frame, which a display
  can only draw as an endless 2,2,3, so the target moves to the nearest whole division — 45. An
  even 45 reads as smooth; a 58 fps average alternating one and two vsyncs per frame reads as a
  stutter. Stated in its own test case so it is a decision someone can find and revisit.
- **`ceil(interval) - 1`, and the `-1` is load-bearing.** `floor` lands ON the interval whenever
  the interval is already whole (100 Hz asked for 60 resolves to 50 fps, i.e. exactly 20 ms), and
  `delta` truncating to 19 against a `_minElapsedMS` of 20 is the shipped bug in miniature.
- **...and then a thousandth of a millisecond below that**, because the value does not survive
  the round trip: `maxFPS`'s setter stores `1 / (fps / 1000)`, so asking for `1000/33` comes back
  as 33.000000000000004 — fractionally above the integer chosen, which an integer `delta` of 33
  then loses to. Measured before that line existed: the 30 fps idle cap on a 60 Hz panel read
  2.7% uneven instead of 0.1%, entirely from the last bit of a double.
- **The residue on 90/100/165 Hz panels cannot be removed through `maxFPS` at all.** Their vsync
  interval is not a whole number of milliseconds, so no integer `_minElapsedMS` divides it
  evenly. Fixing those means taking `app.render` off the ticker and calling it on our own
  schedule, which is larger than the report asked for and is recorded as the follow-up.

The display rate has to be measured because **no browser exposes it**. `perf/displayRate.ts`
times rAF for one second at boot — rAF keeps firing at the display rate whether or not the ticker
runs a frame, since the cap is applied *inside* the ticker callback — takes the median gap rather
than the mean (a GC pause and a compositor hiccup are in every one-second sample; the median
ignores them, the mean reports 58 Hz), and **refuses to answer** rather than answering wrong:
too few samples, a median outside 24-480 Hz, or no single rate in the sample. `tickerCapFor`'s
unknown branch is correct for as long as it says nothing.

**And one of those refusals was missing, which the browser found and no test would have.** Run
against the real client with the pane hidden, the probe reported **30.03 Hz** — a browser
throttles rAF in a hidden tab and not always down to the 1 Hz the plausible band already rejects,
so the reading sailed through every check in the file. `tickerCapFor` then read "the display is
slower than the target" and returned **0 for both the idle and the play target**: no cap at all,
for the whole session, on a device that never asked for it — the 2026-09-08 power budget silently
off, which is precisely the failure mode it was built to stop. The probe takes an injected
`isHidden` now and throws the sample away rather than believing it, restarting instead of giving
up, because opening a game in a background tab and switching to it a minute later is an ordinary
thing to do and rAF not running while hidden means the next callback IS the page coming back.
Verified the same way it was found: before the guard `ticker.maxFPS` read 0 in a hidden pane,
after it reads 30 with a 32.999 ms gate.

### Two more causes in the same report, neither of them a frame rate

A dizziness report has more than one candidate, and only one of them was a bug:

**An online match had no render interpolation.** `Entity.pushState` shifts cur → prev, so
`Scene.reconcile` is only meaningful once per sim tick — and `GameLoop.advanceOnline` called it
every render frame, which collapses prev onto cur and leaves nothing between them. That is why
the online path passed `alpha = 1`, and why an online match moved in **30 Hz steps on a 60 Hz
screen**: every remote actor, every bullet, and the camera whenever the local seat was not being
predicted. It mirrors on the tick boundary now (`controllers/onlineInterpolation.ts`, split out
under the 500-line convention and pure enough to be listed in `pureLayerBoundary.test.ts`), at
the standard cost of entity interpolation — remote entities are drawn up to one tick behind the
newest confirmed frame, the local seat unaffected because the predictor snaps its view after.
Three details worth keeping: a frame carrying **events** mirrors even without a tick advance,
because `drive()` hands back the events of the frames it applied and dropping one loses a pickup
flight or a death for good; `reset()` exists because a match starts at tick 0 and a leftover 0
would read as "already mirrored" and hold the first confirmed frame off the screen entirely; and
the accumulator is floored at 0, because a clock that goes backwards across a tab suspend would
give a negative alpha and draw every remote actor BEHIND where it was last seen — found by the
test that asks for it.

Found in passing on that path: **`spawnBulletTrails` was running at the render rate online**, so
an online comet tail was twice as dense as the offline one it is meant to match, and denser again
on a 120 Hz panel. Its own doc comment had said "once per sim tick" since it was written.

**There was no reduce-motion setting.** Camera shake is ±14 px of white noise applied to the
entire world layer and re-rolled every render frame — nothing about the game state is readable
from it, and an uncorrelated per-frame translation of everything on screen is the most reliable
way there is to make someone motion-sick. `render/motion.ts` is the mirror, a REDUCE MOTION row
in settings is the control, and it suppresses the shake and the chromatic-aberration pulse and
nothing else: not the vignette (static), not hit-stop (a pause is the opposite of motion), not
any animation attached to an object the player is tracking. The shake is read at the OUTPUT
rather than at `addShake`, so trauma accumulates and decays exactly as before and the setting can
be flipped mid-fight without leaving the controller in a state it could not have reached on its
own. Eight locales, off by default.

### The statistics, finally

`FrameWindow.longFrameRatio` is the metric that was missing: the share of frames markedly longer
than the window's own median — measured against the window rather than against a target, so a
device holding a rock-solid 30 fps reads 0, which is correct. 30 fps is a different complaint and
`fps` is already the field for it.

`perf/perfReport.ts` aggregates a minute of PLAY into one logfmt line and sends it at `info`
level through the client-log channel that already exists (`design/19` §10 → Loki). Decisions
behind that:

- **The log channel rather than the analytics one.** `net/analytics.ts` is a closed vocabulary
  rolled up DAILY into Prometheus gauges to answer "do people come back". This question is
  per-session, wanted within the minute, and the thing you do with a bad number is filter to that
  session and read what else it said. That is the log store — which already has a fixed label
  set and per-IP limits, so this adds a line and not a trust boundary.
- **One line per minute, not one per window.** 30 lines a minute per player for a number that
  barely moves is how a log store gets expensive and a dashboard gets unreadable; a minute of
  aggregate is also the better statistic, since `longFrameRatio` over 30 windows is a rate where
  one window's is a coin-flippy sample of ~120 frames.
- **Only windows from a live run.** Idle screens are capped at 30 fps on purpose, so mixing them
  in would give a dashboard whose frame rate tracks how long players spend in the forge. The
  phase comes from `analyticsTracking`'s mirror, which is maintained whether or not analytics is
  installed — worth stating, because the reverse would report every window as "not in a run" and
  the telemetry would be empty rather than wrong.
- **`DEFAULT_MIN_LEVEL` widened from `warn` to `info`**, rather than passing `minLevel` at each
  of the three entry points. A per-entry pin only exists where somebody thought of it, and the
  failure — one build target silently reporting nothing — looks exactly like nobody playing on
  it. The same argument wired the display probe and the reporter inside `installPerf` rather than
  in `main.ts` ×3, and it is the mistake `clientLog`'s own `host` label made for weeks.

The `Client` dashboard gains a **Frame pacing** row: judder as a percentage, in-run fps with its
worst window beside it, judder split by build target and **by display refresh rate** (the panel
that says whether this rule is working in the field — a tall bar on 90/100/165 Hz is the known
residue, a tall bar on 60 or 120 is a regression), the update/render split, and the raw lines.

**The two ends of that are a string built in the client and a set of LogQL queries in a JSON
file, and nothing connects them** — rename a field and the panel keeps deploying, keeps querying,
and renders "No data", which is indistinguishable from nobody having played. So a client test
reads the real dashboard, extracts every `| unwrap <field>`, and requires each one to be a field
a real emitted line carries; it also requires each perf panel to pin `level="info"` and to do the
`line_format "{{.msg}}" | logfmt` second parse, since the server quotes the whole line into one
`msg` field. Verified by control: renaming `long_pct` in the client turns it red.

### What the tests are worth

The old cap test is the lesson. It drove the real `Ticker`, which is the right instrument, and
asked it the wrong question — how many frames ran, never when. The new cases jitter the
timestamps and measure cadence, and the first of them **reproduces the bug as a fact about Pixi**
so that a future Pixi fixing its own gate turns it red and the whole section can be reconsidered.
The online-interpolation cases were control-run against the old behaviour: 4 of 6 fail against
`alpha = 1`, which is what makes them worth having.

Client 7,288 green. No `ENGINE_VERSION` bump — every line of this is presentation-only, and the
sim still runs off `GameLoop`'s own fixed 30 Hz accumulator, so two clients capped differently
stay byte-identical (`design/06`). `render` `platform` `ui` `test` `docs`
