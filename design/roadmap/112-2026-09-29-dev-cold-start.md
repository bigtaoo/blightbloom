# Work log — 2026-09-29

Volume 112. See [`design/ROADMAP.md`](../ROADMAP.md) for the index and the phase spine.

## The dev cold start is a second or two as well (2026-09-29, perf + tools + docs, no game code change)

[Volume 108](108-2026-09-29-prod-cold-start.md#still-open) measured the cold start on a
production build and left the **dev** build open. The README's dev figure was still volume 107's:
on a freshly loaded dev page, the first ~30 s at a 4x CPU throttle ran 2–3x slower. This pass
measured the dev build with the same tool. That figure does not reproduce. On a quiet machine the
dev cold start costs **0–4 slow seconds** at the start of the first run, the same size as
production's.

### What was measured

Everything ran on the dev server (`npm run dev`, port 5173) in the separate CDP Chrome from
`tools/perf/README.md`, at 4x. Each run was 60 s of `beginQuickRun` walking a square, with no
descend and the player unkillable. "Slow" means a second under 57 frames.

| Arm | Runs | Slow seconds | Worst second | Work p50 |
| --- | --- | --- | --- | --- |
| Cold reload, run at once (`--warmup 0 --reload`) | 7 | 0, 4, 1, 0, 0, 1, 1 | 50 | 5.7–8.4 ms |
| Cold reload, then 5 s in the lobby | 3 | 1, whole run, 5 | 30 (first second) | 6.1–12.6 ms |
| Dev server just restarted, then a cold reload | 1 | 0 | 58 | 5.8 ms |
| Same page after a 60 s warm-up (control) | 1 | 0 | 59 | 8.0 ms |

- **The reload itself is 1.2–2.2 s** at 4x, until `window.__game` exists. Vite holds its module
  transforms in memory, so the server-restart arm covers the first request of any module that
  loads lazily when a run starts. It was clean as well.
- **Four of the seven immediate runs were sampled against the whole machine's CPU**
  (`typeperf`, every 2 s). The machine averaged 15% busy, 32.5% at most. Those four had 0–1 slow
  seconds each.
- **One lobby run was slow the whole way** (35–61 fps, work p50 12.6 ms, twice the others). This
  is the contention shape from volume 108: it does not fade, and the next run on the same page was
  clean. It is not a cold cost.
- **Five seconds in the lobby did not help here.** In production, volume 108 measured it trimming
  the slow start from 1–8 seconds to 1–3. On dev, the one lobby run with a slow start (41, 30, 43,
  54 fps) was worse than any immediate run. Three runs cannot separate that from noise, and it
  changes nothing below.

### What this changes

- **The "~30 s, 2–3x" claim is retired.** Seven cold dev runs never came near it. Volume 107
  measured it on this shared machine and never repeated it. Volume 108 caught the same machine
  producing a 20–40 s slow stretch from contention. That is the likeliest explanation here too, but it cannot
  be proved after the fact.
- **`accept.mjs` keeps `--warmup 60` as its default.** It is no longer there because of a long
  JIT tail. It absorbs the first-use seconds and costs one minute. Its comment claimed a 30 s
  warm-up had been measured to be insufficient. That was a single spread-6 run, inside the noise
  this pass shows, so the comment now says so.
- **The README's cold-start section** now gives both builds' numbers.

### Numbers

- **Dev build, 4x, run straight after a cold reload:** 0–4 slow seconds, median 1, over 7 runs.
- **Reload to `window.__game`:** 1.2–2.2 s.
- **Steady control:** 59–61 fps, spread 2.
- **Code:** comments in `client/tools/perf/accept.mjs`, and `client/tools/perf/README.md` ("Cold
  start"). No game code and no test change.

### Still open

- **No real phone yet**, which is unchanged from volumes 107 and 108.
