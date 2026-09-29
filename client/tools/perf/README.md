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

Both scripts take `--port` (default 9333) and `--page` (a substring of the tab's URL, default
`localhost:5173`). They start a quick run themselves if the game is not already in one.

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
