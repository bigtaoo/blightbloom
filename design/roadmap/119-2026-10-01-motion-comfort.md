# Work log — 2026-10-01

Volume 119. See [`design/ROADMAP.md`](../ROADMAP.md) for the index and the phase spine.

The owner gets 3D motion sickness easily (*"镜头缓动快结束的时候，整个画面都在抖动 … 我非常容易晕3D"*)
and asked for no jitter anywhere. Four entries, one pass. The running account is
`design/rendering/01-foundations.md` "Motion comfort".

## The camera lands, and the player is not rounded (2026-10-01, client + render + test + docs, no engine change)

Snapping the world offset to whole pixels (the shimmer fix before it) left the tails of both camera
eases reaching the screen as lone 1 px jumps of the whole frame, up to a second apart after a stop.

- **Both eases land.** The pan has a speed floor (`MIN_PAN_PX_PER_MS`, never under one screen pixel
  a frame, so 144 Hz is covered); the zoom takes the same floor at the viewport's edge, where its old
  tail rescaled the frame by sub-pixels for 86 frames after a room change (`fx/cameraRig.ts`).
- **The followed player is drawn unrounded.** `updateCamera` hands the world's rounding back to it
  (`Entity.nudge`), which removed a ±0.5 px wobble every frame.
- **The glow sits where the player is drawn**, not at the tick position (`FxController`).
- **Online, the local correction is spread over frames** (`LocalPredictor`): landing whole on each
  confirmed tick, it sawed at 30 Hz against every wall by a full tick's step.

Measured as the per-frame rounded offset sequence over run→stop and a room change, at 30/60/144 fps.

## Online frames play at 30 Hz (2026-10-01, client + net + test + docs, no engine change)

`MatchRoom` sends three frames per 100 ms and the client stepped all three in the render frame they
landed in, so every remote player, enemy and bullet moved in 10 Hz lurches, and only the last frame's
events reached the render layer. `controllers/onlineInterpolation.ts` is now a jitter buffer: it steps
confirmed frames on the sim's own clock, leans the playout rate ±5% on the minimum slack over a second,
holds alpha at 1 when dry and skips a backlog of 15 or more. `CoopSession.steppable()` counts what it
paces against. Every stepped frame now mirrors its own events. Measured at 30/60/144 fps with 20 ms
of arrival jitter: every frame moves a remote entity the same distance to within 6%; the greedy loop
fails three of the new `GameLoop` tests.

## Even frames on every refresh rate (2026-10-01, client + perf + platform + test + docs, no engine change)

Pixi's frame gate truncates elapsed time to whole milliseconds, which on 90/100/165 Hz panels drew
4-9% of frames a vsync late. `game/frameGate.ts` replaces it on both platforms: it takes the same
`maxFPS` `powerBudget.ts` writes and admits a frame once (N - 1/2) vsyncs have passed, N from
`ceil(ratio - 0.25)`; before the display probe answers it estimates the vsync from the callbacks.
Against the real `Ticker` with jitter, every rate from 60 to 240 Hz, both settings and the idle cap
measure 0% uneven (the idle cap's old 2.7% residue too). Pixi's own gate is kept as the control.

## The local player leads by the measured delay (2026-10-01, client + net + test + docs, no ENGINE_VERSION change)

`LocalPredictor` eased toward the bare confirmed position, which while moving decays the lead to
zero: online, the local player carried the whole latency once running and slid on by all of it after
a stop. It now leads the confirmed position by the input still in flight: each frame's dead-reckoned
step joins a one-second trail, and `settle` eases toward the interpolated confirmed position plus the
trail's last (delay + one tick). The delay is measured, not guessed: `net/inputDelay.ts` times each
changed command from send to the first stepped frame that holds it (the server keeps the advisory
`tick` as a tag), and reads the floor of the last eight, since batch phase and jitter only add. The
predictor also pushes out of static solids with the sim's own `geom.clampToWalkable` (newly exported
with `blockingRadius`; nothing in the sim changed), walking the lead in 8 px steps so it cannot exit a
thin wall's far side.

The client also drops `NetInputSource`'s 3-frame cushion (`bufferFrames: 0`): the paced playout keeps
its own slack, so it was 100 ms on every remote entity for nothing.

`controllers/predictorPlayout.test.ts` models the server's timing (commands on the last frame of a
100 ms window, per-leg delay and jitter) at 30/60/144 fps and 40-160 ms RTT:

| | before | after |
|---|---|---|
| running, behind the stick | 34-79 px | 3-7 px |
| slide after a stop | 33-78 px | 3-19 px, forward only |
| per-frame step while running | — | within 2% |

Up to 120 ms of jitter plays the same with or without the cushion.

### Still open

- The 3-19 px after a stop is the server's batching: `FrameBroadcast.tick` lands every command on the
  window's LAST frame, so the real run is up to a window longer or shorter than the stick was held.
  Landing each command on the frame its arrival time falls in would shrink it to a tick. That is a
  server change.
- None of this has been played in a real online match.
