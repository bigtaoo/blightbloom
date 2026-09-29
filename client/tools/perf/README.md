# `client/tools/perf` — live frame measurements

Two scripts that drive the real game in a real Chrome and measure it, the ones the 2026-09-28
steady-load pass was held to. They are **measurements, not gates**: they need a GPU, a visible
window and a quiet machine, so CI does not run them. What CI does run is the structural half —
`src/game/controllers/steadyFrame.test.ts`, which fails when a frame starts rebuilding render groups
it does not need to, and needs no browser at all. Run these when you change anything that runs
every frame, and read the numbers against the ones recorded below.

| command | what it answers |
| --- | --- |
| `npm run perf:accept --prefix client` | Does every second of a real run hold the same frame rate — including the second a floor descends — on a slow CPU? |
| `npm run perf:cull-ab --prefix client` | Does the off-screen cull change a single pixel? |
| `npm run perf:gpu-cost --prefix client` | What does each render pass, floor layer and quality tier cost the GPU? |

`src/perf/README.md` has the in-page probes (`window.__perf`) for finding *where* a frame's time
goes; these scripts only say *whether* it is good enough.

## Setup

1. A dev server (`npm run dev --prefix client`, port 5173), or better a production build
   (`npm run build --prefix client && npm run preview --prefix client`, port 4173 — pass
   `--page localhost:4173`). A production build is closer to what a phone runs.
2. A Chrome of its own, with a debugging port, a throwaway profile and background throttling off:

   ```bash
   "C:/Program Files/Google/Chrome/Application/chrome.exe" --remote-debugging-port=9333 --user-data-dir="$TEMP/dd-perf-chrome" --no-first-run --window-size=1280,800 --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling http://localhost:5173/
   ```

   The three `--disable-*` flags are not optional. Without them, a Chrome window covered by any
   other window counts as hidden, Chrome stops drawing it, and a run records no frames at all
   (`accept.mjs` says so rather than reporting zeros). A separate profile keeps the debugging port
   off your everyday browser.

All three scripts take `--port` (default 9333) and `--page` (a substring of the tab's URL, default
`localhost:5173`; `gpuCost.mjs` defaults to `localhost:4173`, the production build). They start a
quick run themselves if the game is not already in one.

## `accept.mjs` — the frame-rate acceptance run

```bash
node tools/perf/accept.mjs --throttle 4 --secs 60 --descend-at 30 --warmup 60
```

It slows the CPU `--throttle` times (Chrome's own emulation; 4x stands in for a mid-range phone),
plays a discarded `--warmup`, then plays `--secs` more walking a square, descends a floor at
`--descend-at`, and reports frames per wall-clock second. The player is made unkillable for the
run. It prints `PASS` and exits 0 when the slowest and fastest second are within `--max-spread`
(default 3) frames of each other. `--reload` reloads the tab under the throttle before anything
else, so `--warmup 0 --reload` measures a cold page load rather than whatever state the tab was in.

The other numbers in the report:

- `workP50` / `workP99` / `workMax`: scripted time per frame, from the first ticker listener to the
  last. At 60 Hz the budget is 16.7 ms.
- `longFrames`: frames over 20 ms apart. `longScripted` is the subset whose own scripted work was
  over 12 ms. A long frame with short work is the compositor, the GPU or another process, not the
  frame's own code, which is what that split is for.
- `worstLong[].covered`: the frame had a loading cover up (a descend, a run boundary). A hitch
  there is hidden from the player.

**Recorded 2026-09-28** (desktop, dev build, 4x, 60 s, descend at 30 s): 59–61 per second, spread
2, work p50 6.1 ms, p99 15.6 ms. Before that day's passes the same run read 36–54 per second with a
work p50 of 17.1 ms.

### Cold start

The first run after a page load is slower. On a fresh dev page the first ~30 s at 4x took 2–3x the
steady cost (volume 107), which is why `--warmup` defaults to 60.

On a production build it is much shorter. Measured 2026-09-29 (volume 108) with
`--warmup 0 --reload`: the run started straight after a cold load is slow for **1–8 seconds**,
mostly at its start. After 5 s in the lobby, 1–3 slow seconds remain at the run boundary, under the
transition that already waits for them. It is not JIT warm-up: stopping the ticker for 60 s, so no
game code runs, leaves the first run as clean as 60 s of lobby does. What remains is first use, as
the run's textures upload and its render paths run for the first time.

A cold run that stays slow the whole way through is not a cold start, because a cold cost fades.
See the noise section below.

### Noise

This machine is shared with other sessions, builds and test runs, and a 4x throttle multiplies
whatever else is running. On one day, two runs of the same scene read 6.7 ms and 15 ms of work per
frame. Before calling a red run a regression:

- run it again;
- check nothing else is building or testing;
- compare the scene, since the floor seed decides how many enemies are on screen.

One red run on a busy machine means nothing. Three reds on a quiet one is a regression.

## `cullAB.mjs` — the culling pixel A/B

```bash
node tools/perf/cullAB.mjs --grid 4
```

The floor culls its ground pieces and its standing pieces (walls, doors, pillars, props) against
the view (`scene/groundCulling.ts`). A piece culled while any of it is still on screen would be a
hole in the wall, so this proves no such piece exists. At a `--grid` × `--grid` spread of camera
positions over the current floor, it:

1. sets the camera there;
2. runs the shipped cull (`FxController.syncCamera`);
3. renders;
4. un-culls everything, renders again, and diffs the two frames.

It prints `PASS` only if every diff is zero **and** three controls hold:

- The same frame rendered twice diffs to zero. Otherwise the frame is not deterministic and a zero
  diff means nothing.
- The camera positions differ from each other. Otherwise the camera never moved.
- Culling *every* piece changes any frame that had a piece on screen. Otherwise the diff cannot see
  a piece at all. This control failed the first time it ran: a position whose only kept pieces sat
  in the cull's margin, just off screen, showed no change. It now counts only pieces whose real
  bounds are on screen.

**Recorded 2026-09-28** (level 1, 98 tagged pieces): 0 px at all 16 positions. Between 2 and 34
pieces were on screen at a time, and 57–98 were culled.

## `gpuCost.mjs` — the GPU cost of each pass

```bash
node tools/perf/gpuCost.mjs --page localhost:4173 [--viewport 844x390@3] [--rounds 7]
```

Open the page with `?perf=1`, or the draw / program / framebuffer columns stay empty. The script
starts a run, lets enemies come on screen, and stops the ticker so every sample renders the same
frame. Then it switches one thing off at a time (a filter pass, a floor layer, a whole quality tier)
and times the frame with a GPU timer query (`EXT_disjoint_timer_query_webgl2`). The arms are
interleaved with the unchanged frame (base, arm, base, arm, …), so each arm's number is a paired
difference from the base samples either side of it. The first round is thrown away, because the
first samples after a change read high.

`--viewport WxH@DPR` emulates a screen and reloads the page under it, because the renderer picks
its resolution once, at boot. The script reloads the page again when it finishes. Clearing the
emulation alone leaves the renderer at the emulated resolution, and the next run would silently
measure that.

The report has one row per arm:

- `saved ms`: how much GPU time the frame loses when that thing is off. A negative number means
  switching it off made the frame **more** expensive.
- `layers`: the same number in units of one full-screen 50%-alpha layer drawn on the canvas. The
  `fill10` arm measures that unit (ten such layers).
- `draws prog fb`: draw calls, program switches and framebuffer binds for that arm. A tile-based
  phone GPU pays for every framebuffer bind, which this desktop GPU mostly does not.

It prints `TRUSTWORTHY` and exits 0 only when:

- the `noop` arm, which changes nothing, reads under 0.1 ms;
- the fill calibration is above zero;
- rendering an empty container costs under a quarter of the frame;
- no sample was discarded as disjoint.

A run that fails the `noop` check still shows effects much larger than 0.1 ms. Its small rows are
noise.

WebGL makes a query result available only after the page has gone back to its event loop, so the
result poll has to yield. The first version polled synchronously and hung the tab.

**Recorded 2026-09-29** (volume 109; Intel Arc, production build, a level-1 room with 8 enemies,
`saved ms`):

| arm | desktop 1264x705 @1 | phone 844x390 @3 | desktop 1264x705 @2 |
| --- | --- | --- | --- |
| base frame | 1.81 | 1.33 | 3.49 |
| lighting as one pass instead of the MSAA split | 0.51 | 0.13 | 0.63 |
| no lighting at all | 0.67 | 0.25 | 0.70 |
| floor hidden | 0.42 | 0.22 | 0.34 |
| no bloom | 0.18 | 0.15 | noise |
| no vignette + chromatic | 0.11 | −0.08 | −0.27 |
| medium tier | 0.83 | 0.27 | 0.78 |
| low tier | **−1.58** | 0.12 | 0.06 |
| light and bloom off, world pass kept | 0.83 | 0.34 | 0.97 |
| every pass off, resolution unchanged | **−1.58** | **−3.89** | **−8.89** |

The last column's run failed its `noop` check (0.16 ms), so only its large rows are quoted. The
bold rows are what volume 109 is about. Without any filter pass the scene is drawn straight into
the canvas, at the full renderer resolution and multisampled. Every filter pass draws into a 1x
texture with no MSAA. So the low tier, which has no passes, is **slower** than high at DPR 1.
