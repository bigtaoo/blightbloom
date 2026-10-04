# Work log — 2026-10-03

Volume 121. See [`design/ROADMAP.md`](../ROADMAP.md) for the index and the phase spine.

## Commands land on their own frame, and the frames between hold (2026-10-03, engine + server + net + test + docs, no ENGINE_VERSION change)

The owner asked for the item volume 119 left open, because it feeds online motion sickness:
`FrameBroadcast.tick` landed every command on the last frame of its 100 ms window, so a run lasted
up to a window longer or shorter than the stick was held, and the local player slid 3-19 px after a
stop. Fixing it turned up a larger bug on the same path.

### Found on the way: online, every seat moved one frame in three

`NetInputSource` filled only each batch's `toFrame` (the 4.5 "held snapshot"); the two frames
between came back `EMPTY`, and `ApplyInputSystem` idles a seat with no command. So in every online
match, every player moved and fired on one frame in three. Measured through the real engine, a
held stick relayed at the shipped 3 frames per batch took one step per batch where the local
run took three. design/15 and the class's own header both said every tick is filled by holding; the
code did not.

Nothing caught it:

- The server relay tests (`BotClient.test.ts`) run at `framesPerBatch: 1`, where there are no
  gaps.
- The loopback tests compared against the frame log replayed as a sparse stream, which idles the
  same frames.
- `predictorPlayout.test.ts` modelled the hold the docs describe, not what the code did.
- Nobody has played a real online match yet.

A second, smaller loss was on the same path. A client sends at its render rate and clears a
one-shot latch (swap, extract/descend confirm, pickup, shop buy) on the very next command. Within
one frame the last command per seat won, so the clear usually overwrote the tap.

### What changed

- **The server reads the clock** (`server/src/windowClock.ts`, `Scheduler.now`; `nodeScheduler`
  uses `performance.now()`). `MatchRoom.submitCmd` passes how far into the open window a command
  arrived, and `FrameBroadcast.submit(cmd, offset)` lands it on that window frame. The offset is
  clamped into the window and never lands a command before an earlier arrival. Without a clock,
  for example in a test's fake scheduler, commands land on the last frame as before.
- **Two commands from one seat on one frame fold** (`foldCommands`, `engine/state/commands.ts`):
  the later one's held state, plus any one-shot part the earlier one carried. The log now holds at
  most one command per seat per frame.
- **Every frame is filled** (`NetInputSource.fillThrough`). A seat's fresh command applies on its
  own frame. Every later frame holds it with the one-shot parts stripped (`heldPart`), so a held
  stick keeps running and a tap still fires once. Frames with nothing new share one array.
- **A frame log is not a sparse replay** (`protocol.ts` `FrameCmds`). `confirmedStream(log,
  toFrame)` expands one into the per-frame stream a client simulates, ready for `toReplay`. The
  server's integrity log needs it before anyone replays it.
- `MatchRoom.ts` would have crossed 500 lines, so the `Scheduler` interface moved to
  `server/src/scheduler.ts`. `MatchRoom` re-exports it, so no caller changed.

Offline play, replays and the golden hashes are untouched: `LocalInputSource` already gives every
frame its command. No `ENGINE_VERSION` bump. There is no protocol version handshake, though, so a
client from before this and one from after cannot share a match. Their sims diverge, and the
checkpoint kick catches it. The client and the server deploy from the same merge.

### Tests

- `framebroadcast.test.ts`:
  - The loopback now compares against the **local** run of the same intent, and is byte-equal:
    one command per frame, and a stick sent once plus a one-shot swap.
  - The control: that log replayed sparse, which is what the client did before, is a different
    run.
  - Unit tests cover landing by offset, clamping, monotonic landing and folding.
- `netinput.test.ts`:
  - Every frame between batches holds.
  - A tap applies on its own frame only.
  - A second resync skips frames already filled.
  - `confirmedStream`.
- Mutation checks:
  - The old `NetInputSource` turns four tests red.
  - A `heldPart` that keeps the one-shots turns the tap test red.
- `server/test/windowClock.test.ts`:
  - `WindowClock` alone.
  - `MatchRoom` with a clocked fake scheduler: thirds of a window land on frames 1/2/3, the window
    restarts at each pulse, a late metronome stays in its window, and without a clock commands
    land on the last frame.
  - `nodeScheduler.now` moves with the timers.
- `server/test/onlineRelay.test.ts`, the whole path at the shipped 3 frames per batch: two real
  `CoopSession`s through a clocked `MatchRoom`, byte-equal to the local run of the same intent,
  with both seats really walking. The control: an unclocked room stays in lockstep but is not the
  run intended. The old `NetInputSource` turns it red. It does not pin repeated one-shots or
  folding; the unit tests above do.
- `predictorPlayout.test.ts`: the server model lands by arrival, the old rule is kept as
  `lastFrame` (the control), and the slide bound tightens from a window to one tick:

| worst slide after a stop, 12 stop phases | last frame (before) | arrival frame (now) |
|---|---|---|
| 60 fps, 40 ms RTT | 19.4 px | 6.6 px |
| 60 fps, 160 ms RTT, 30 ms jitter | 16.2 px | 9.8 px |
| 144 fps, 100 ms RTT | 10.7 px | 9.9 px |
| 30 fps, 100 ms RTT | 12.8 px | 6.4 px |

What is left is one sim tick (6.4 px, where in the tick the stop arrived) plus the predictor's own
3-7 px lag. The model always held the input, so these numbers do not include the one-frame-in-three
bug. That bug was in the real client only.

### Still open

- Still not played in a real online match. It is the first thing to do with two clients, now that
  online movement runs at full speed.
- Nothing else: `npm run check`, `npm run check:logic` and `npm run coverage` (all three packages at or above 90/90) were green.
