# Work log — 2026-09-10

Volume 53. See [`design/ROADMAP.md`](../ROADMAP.md) for the index and the phase spine.

## The bank button that was really a save button (2026-09-10, engine + client + docs, `ENGINE_VERSION` 60→61)

> *"把中间层的撤离功能去掉，只有打完boss之后的撤离才能退出。对于单人地图，如果没有打完，可以保存进度，下次继续。其实单纯保存指令和随机种子就行了。重进的时候要比对引擎版本"*

Two asks, and the second is the reason the first is not a nerf.

[`design/05`](../05-gameplay.md)'s push-your-luck pillar was carried entirely by the per-floor
checkpoint: reaching one let you **extract** (bank everything, end the run) or **descend**.
That choice was doing two jobs. A player who wanted to *stop playing for the evening* had to
spend the run's whole carry-out decision to do it, because quitting from the pause menu
forfeits everything — so the early bank was also the save button, and it was much the worse of
the two things it was being used for. Splitting them is what this pass is: the run's only exit
is the boss, and an unfinished single-player run is **saved and resumed** instead. "Leave with
what I have" became "come back to it".

### The engine half is four lines, and it is a replay break

`ExtractionSystem` stops consulting `confirmExtract` on any floor but the last. The pairing is
now exclusive in both directions — an interior portal accepts `CONFIRM_DESCEND` and nothing
else, the boss portal accepts `CONFIRM_EXTRACT` and nothing else — where before only the last
floor ignored a button. An ignored EXTRACT is **dropped, not reinterpreted as a descend**: the
two are different intentions, and turning one into the other would spend a floor card the
player never chose.

That is a replay break, hence `ENGINE_VERSION` 61: a recorded stream that pressed EXTRACT at an
interior checkpoint used to end the run there and now does not, so the run continues into
floors the recording has no input for. It is also **the divergence no other guard can see** —
the states before the press are byte-identical, so nothing moves until the tick the button is
read.

**Measured before the bump, and the measurement is the interesting part: zero golden scenarios
diverged.** Not a reassurance — a coverage gap, and now a recorded one. No golden scenario
presses `CONFIRM_EXTRACT` at all, and `ember-dungeon-floor1` *cannot*: its own note says a
scripted stick does not clear rooms reliably, so it never reaches a checkpoint and pins
`floorIndex === 0` for all 1500 ticks. Closing that properly needs a purpose-built floor the
way `WALL_NORTH_BRIM` needed `brimGrinderFloor.ts`. Until then the rule is pinned by
`systems/extraction.test.ts` in **both** directions, because only the pair pins it: "an interior
press is ignored" alone would also pass if `confirmExtract` had been deleted outright, and "the
last floor still wins" alone would also pass if nothing had changed. Same split v60 made for
`capacitor`'s effect on `rollFloorCardOffer`, for the same reason.

### A save is a seed and an input stream — which is why it cannot go stale against the sim

The report already named the format: *"其实单纯保存指令和随机种子就行了"*. That is exactly right, and
for a reason worth stating — it is the property [`design/08`](../08-simulation-core.md) already
builds replay on. A fresh engine on the same seed, fed the same inputs, reconstructs every frame
bit-for-bit, so resuming is "replay the recording, then keep playing":
`RunLifecycle.resumeSavedRun` advances a fresh engine through the saved stream and hands the
same `LocalInputSource` to the live command builder, which appends to it.

So a save **cannot desync from the sim, because there is no second description of the sim for it
to disagree with**. A snapshot format would have been that second description: one field per
piece of engine state, going stale on every version that added a field — silently, since a
missing field reads as a default rather than as an error.

Two things can still invalidate one, and each is a refusal rather than a replay:

- **`ENGINE_VERSION` mismatch** — the ask's own *"重进的时候要比对引擎版本"*, and `design/08`'s
  "fail loud, never replay garbage" applied to a save instead of a recording.
- **Content drift**, which is the half `ENGINE_VERSION` does not cover at all. `replayFile.ts`
  avoids it by embedding the whole `EngineConfig`; a save cannot afford that (the dungeon
  library is the bulk of the config, and this goes to `localStorage` beside the account, not to
  a developer). So the config is **rebuilt from today's content** and only its content half is
  fingerprinted — an edited floor library is then a refusal, not a player spawned inside a wall.

Either way the save is dropped and the button goes away, rather than being left to fail again.

### Three things the fast-forward had to get right

1. **The last replayed tick is not a frame.** `step()` clears `state.events` at the *top* of
   each tick, so after the loop the final tick's events are still sitting there — and
   `GameLoop` drains whatever it finds on its first real frame, replaying that tick's hit
   flashes, sounds and score at a player who was not watching. Cleared explicitly.
2. **The scene has to be primed by hand.** A dungeon run normally builds its geometry from tick
   1's `room_enter`, which the fast-forward has just consumed, so this takes the same
   `enterPrimedRun` path the arena/tutorial/replay entries use.
3. **The score is render-side state the sim cannot reconstruct** — it is accumulated from events
   as they stream past. Saved beside the stream and restored *after* `resetRenderState`, which
   zeroes it for a fresh run.

The loadout is deliberately *not* re-spent: `beginRun` consumed it when the run first started,
and the weapons the save carries are the ones that run is already holding. Which is also why
the save reads its loadout off the **run config** rather than the account — by save time the
account's copy is empty.

### The stream is stored as tuples, and that is a budget rather than a style

A `PlayerCommand` as keyed JSON is ~110 bytes and the sim runs at 30 Hz, so a ten-minute run is
~2 MB against a `localStorage` budget of about 5 MB for the whole origin — which the account
save shares. The fixed-order 7-tuple is ~22 bytes, putting the same run at ~400 KB. A quota
failure is still reachable on a very long run and is **reported**, not swallowed: `saveAndQuitRun`
writes first and *aborts on failure*, leaving the pause menu open and the run live, because the
one unacceptable outcome is telling someone their run was kept and then dropping them in the
Forge with nothing.

### Scope, and why each exclusion is a rule

Single-player, offline, real dungeon runs only. An **online** run's authoritative stream is the
server's, not this client's. A **co-op** run's second seat is generated by the bot ally at
submit time and is not in the recorded stream, so replaying the stream alone would not reproduce
it. The **tutorial** is a flat level whose quit already means "skip", and the arena/replay
harnesses are not runs. One slot, replaced rather than accumulated — and **three** call sites
drop it: `beginRun` (a fresh run replaces it), `quitRun` (you abandoned it), and
`RunOutcome.handle` (it is over). The third is the one that cannot be folded into either, because
nothing routes a victory or a defeat through `RunLifecycle` at all; without it, closing the tab
on a result screen leaves the Forge offering to continue a run that was already won and banked.

### What the UI had to stop doing

`PortalPrompt` becomes a one-button panel: Descend alone on an interior floor, Extract alone on
the boss floor. Both buttons are still constructed and still carry a label even while hidden —
`labelFit.test.ts` reflects over the fields, and a label only set when shown would be measured
as empty and skipped. The Extract label also changed **what it counts**: the whole carry-out
(floor buffer *plus* the banked bag), not just this floor's buffer. That used to be the honest
number while any checkpoint could extract; it is the wrong one now, because this press is the
run's only exit and `design/05`'s wipe rule keeps the bag at risk right up to it.

The pause menu grows a fourth row, SAVE & QUIT, shown only for a savable run. Plain QUIT stays
**beside** it rather than being replaced: the two are different decisions, and one button whose
meaning depends on the mode is how a player loses a run they meant to keep. RESUME and SETTINGS
do not move when the row appears, and QUIT shifts a full row rather than sharing a slot — a tap
aimed at one must never be able to land on the other. The Forge grows CONTINUE RUN in the footer
slot with START RUN pushed a row up, plus an info line naming the saved run's floor and time
played, because two buttons differing only by label are not enough to decide between "resume"
and "discard this" on.

### Two boundaries this pass had to respect rather than route around

`ScreenNav` is in `pureLayerBoundary.test.ts`'s pure list and needs the "may this run be saved"
rule, so the module was **split** the way `replayDownload.ts` is split from `MatchRecorder`:
`match/runSave.ts` holds the format, the two refusals and the rule (pure, no host); the
`localStorage` adapter and the process-wide slot live in `match/runSaveStore.ts`. And the slot is
cached, because `Forge.render` asks "is there a save?" on every keystroke — parsing a ~400 KB
stream per keypress to answer a yes/no is the kind of cost that only shows up on someone else's
machine. Which then makes the cache the place a stale *yes* would survive a clear, so
`runSaveStore.test.ts` spends most of its cases there.

**Verification:** engine 1485 tests, client 6155, `tsc --noEmit` clean, all 12 logic-consistency
gates green, coverage 97.7%/93.2% client and 97.8%/93.5% engine. The load-bearing test is
`runSave.test.ts`'s state-hash equivalence — a 400-tick run, saved, rebuilt from its own
descriptor, replayed, and `hashState`-compared against the original, plus 200 further live ticks
to prove the resume is a run and not a freeze-frame, plus a one-command-short control that
diverges so the two positive cases cannot pass vacuously.

**Worktree note, for whoever hits it next:** a fresh worktree under `core.autocrlf=true` checks
out `#!/usr/bin/env node` as `\r\n`, which Node rejects with `SyntaxError: Invalid or unexpected
token` — four `png-pipeline`/`build` scripts and one YAML-regex server test failed on nothing but
line endings, and both pass in the shared checkout. Normalized locally; zero content diff against
`HEAD`.
