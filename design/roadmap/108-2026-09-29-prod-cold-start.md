# Work log — 2026-09-29

Volume 108. See [`design/ROADMAP.md`](../ROADMAP.md) for the index and the phase spine.

## The cold start is a few seconds, not thirty (2026-09-29, perf + tools + docs, no code change)

[Volume 107](107-2026-09-28-frame-pacing.md#still-open) left the cold start open. On a freshly
loaded **dev** page the first ~30 s at a 4x CPU throttle ran 2–3x slower, and the guess was that V8
was optimising. It had not been measured on a production build. This pass measured it there. The
answer is that the production cold start costs **1–3 seconds** at the start of the first run. The
30-second stretch was another session competing for the same CPU. No game code changed.

### The tool: `accept.mjs --reload`

`client/tools/perf/accept.mjs` gained `--reload`. It reloads the tab after the throttle is on, so
the page load and the first JIT pass also run on the slow CPU. `--warmup 0 --reload` then measures
what a player gets from a cold page.

`Page.reload` returns before the old page is gone. The first version polled for `window.__game`,
found it on the **old** page, and reported the reload as done after 0.9 s. The tool now sets a
marker on the old window first, and treats the new page as ready once the marker is gone and
`__game` exists.

### What was measured

All runs used the production build (`vite preview`) in the separate CDP Chrome from
`tools/perf/README.md`, at a 4x throttle. Each run started `beginQuickRun` and walked a square with
the player unkillable. The table gives frames per second.

| Arm | Runs | Slow seconds (< 57 fps) | Worst second |
| --- | --- | --- | --- |
| Run straight after the reload | 7 | 1–8, and one run slow for all 40 s | 3–56 |
| Ticker stopped for 60 s, then the run | 2 | 0 | 59 |
| 60 s idle in the lobby, then the run | 2 | 0–2 | 52 |
| 5 s idle in the lobby, then the run | 3 | 1–3 at the start, then two runs flat at 56–57 | 2–38 (first second) |

The findings, in the order they were checked:

- **It is not JIT warm-up.** Stopping the ticker for 60 s runs no game code, so it compiles nothing.
  It left the first run as clean as 60 s of lobby rendering did.
- **It is not background work on the main thread either.** A `long-animation-frame` and `longtask`
  log across 40 s of lobby after a cold load shows under 400 ms of long tasks, all in the first
  second: module evaluation, the texture worker's replies and the first frames. Every fetch had
  finished by 0.7 s.
- **What is left is the first second or three of the run.** It happens in every arm that has not
  already sat still for a minute. That is first use: the run's textures upload and its render
  paths run for the first time. It falls inside the run-start transition, which `TransitionGate`
  already holds until frames settle (volume 107).
- **The long slow stretches were contention.** The profiled run that read 28–55 fps for ~20 s, and
  the one immediate run that stayed at 43–58 for all 40 s, have no cold-start shape. A cold cost
  would fade. These stayed flat, and the next run on the same page was clean. This machine is
  shared, and a 4x throttle multiplies whatever else is running.

### Why nothing was changed

A real player spends more than a few seconds in the lobby before starting a run. The 5-second arm
shows what remains after that: 1–3 seconds at the run boundary, under a transition that already
waits for them. Holding the run start any longer would make the loading screen slower for everyone,
to hide a cost that only shows on a 4x-throttled CPU. That is a bad trade until a real phone says
otherwise.

### Numbers

- **Production build, 4x, run straight after a cold reload:** 1–8 slow seconds, most of them at the
  start.
- **After 5 s of lobby:** 1–3 slow seconds, at the run boundary.
- **Lobby after a cold load:** long tasks only in the first second, and no fetch after 0.7 s.
- **Code:** `client/tools/perf/accept.mjs` (`--reload`) and `client/tools/perf/README.md` ("Cold
  start"). No game code, no test change.

### Still open

- **No real phone yet**, which is unchanged from volume 107. A throttle models a slower CPU, not a
  phone's GPU, its texture upload or its thermal limits. First-use costs are the part a phone is
  most likely to make worse.
- **The dev build's cold start was not re-measured.** The README's dev figure is still volume 107's.
