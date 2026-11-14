# Findings — derived analysis, not tool output

Everything in `00-` .. `04-` is a transcription of what the Playgama telemetry
tools returned. **This file is not.** It is the reading made on 2026-11-13/14,
and every number in it is arithmetic over those files. A future reader who
disagrees with a conclusion here can check it against `01-` .. `04-` without
the game existing; a conclusion that cannot be checked that way is marked as
such.

The test did not pass its gates. This file records *why*, so the next attempt
does not rediscover it.

## 0. The one-line verdict

The build did not fail technically — it failed to be started. Across nine days
and 518 unique users, the thing that went wrong was never frame rate, crashes
or load size. It was that **most of the people who arrived never pressed
anything**, and of the few who did, almost none reached the second floor.

## 1. The funnel, 2026-11-09 .. 2026-11-13

Why this window: it is the paid-traffic period (campaign starts
`2026-11-09T08:32:14.675Z`), and `first_input` only exists from 11-08 16:45.
Days 11-06..11-08 are the developer's own testing plus organic trickle and have
a different population. 11-14 is one session.

**Range figures, not per-day sums.** A single range query de-duplicates a session
that crosses midnight; summing the per-day `unique_sessions` of `02-` counts it
twice. Where the two differ the range query is authoritative, and the gap is
one or two sessions:

| step | range query | sum of `02-` | % of run_start |
|---|---|---|---|
| core_initialization_started | 479 | 481 | — |
| platform_message_game_ready | 425 | 426 | — |
| session_start (game's own) | — | 454 | — |
| run_wait | 338 | 339 | — |
| run_start | 304 | 304 | 100% |
| first_input | 198 | 198 | **65.1%** |
| gameplay_30s | 161 | 161 | 53.0% |
| gameplay_60s | 111 | 111 | 36.5% |
| run_end | 39 | 39 | 12.8% |
| floor_reached | 33 | 33 | **10.9%** |

Percentages use the range figure. `session_start` was never pulled as a range
over this window, so only its per-day sum exists.

Read down that column and the shape is unambiguous:

- **34.9% of started runs are never touched.** Not "quit early" — never given an
  input at all. This is the single largest loss in the funnel and it happens
  before any game design has a chance to matter.
- **Of the two thirds who do touch it, only one in six reaches floor 2.**
  33 of 198. `run_end.floor` (`03-`) agrees from the other side: p50 = 1,
  p90 = 5, so the median finished run never left the first floor.
- **`run_end` 39 against `run_start` 304** — seven of eight runs end by the
  player leaving, not by the run finishing. There is no "I lost, one more go"
  loop here because there is barely a "run ended" at all.

### Runs per run-starting session

`run_start` events / `run_start` sessions over the whole range (`03-`):
436 / 394 = **1.11**. Against a design gate of a median of 2 runs per session,
this is the gate missed by the widest margin. Almost nobody played twice.

## 2. What the opening hold did, and did not, change

`OpeningHold` (`client/src/game/controllers/openingHold.ts`) shipped in
`cfd3fdb8`, live from the 2026-11-11f publish. It freezes sim ticks until the
player's first intent or a 20 s fuse, so the dungeon stops shooting at someone
who has not arrived yet. The measurement it was built on — `first_input.screen`
saying most first touches land inside a live run, at a ~7.7 s median — holds up
in the final data: **153 of 199** first inputs, p50 **7,469 ms** (`03-`).

What it did **not** change is the `run_start` → `first_input` ratio. From `02-`:
11-10 (before) 62/83 = 74.7%; 11-11 41/65 = 63.1%; 11-12 34/56 = 60.7%;
11-13 32/61 = 52.5%. The ratio goes **down** across the ship, not up.

Do not read that as the hold making things worse. 11-11 is a mixed day, 11-12
carries two builds, 11-13 is a half day, and the campaign's traffic mix changes
underneath all of it. What can be said is the honest negative: **nothing in
this data shows the hold recovering the untouched third.** Freezing the world
stops the player being killed while they read the screen; it does not tell them
there is something to press. That is the next thing to test, and it was never
tested here.

## 3. The instrument that was missing the whole time

`session_end` fired **once in 673 sessions** — 2026-11-08T05:09:44.682Z, and
never again (`02-`, `03-`). The game therefore has **no measurement of its own
session length anywhere in this archive**. Every duration figure in `01-` and
`02-` is the platform's, computed from its own session bookkeeping, and it is
the figure that produced the false headline on 11-12 (mean up, denominator
down, p50 flat at 0).

The fix is a `pagehide` / `visibilitychange` beacon — the only listener that
reliably survives a tab close. Without it, a portal build cannot answer "how
long did people play", which is the one question a portal asks.

Two more instruments were blind in the same way:

- **`source` is present on 26 of 555 `session_start` events, with cardinality
  1.** Attribution is impossible: there is no way to tell campaign traffic from
  organic in this dataset, on any day, which is why §1 has to use a date window
  as a proxy for a traffic source.
- **`character` has cardinality 1** (`char_vanguard`, 436/436). Nothing about
  hero balance can be asked of this data, ever.

## 4. The build was technically fine

Stated plainly because it is the thing most likely to be wrongly blamed in a
retrospective. Over 1,267 performance windows (`03-`):

- `js_error_count` **0 at every percentile, sum 0**.
- `webgl_context_loss_count` **0 at every percentile, sum 0**.
- `unhandled_rejection_count` sum **1**, in 1,267 windows.
- `boot_ms` p50 1,784 ms, p90 5,517 ms. Slow at the tail, not broken.
- `fps_avg` p50 55.9, p10 27.5 against `target_fps` p50 60.

The one real performance complaint is **hitching, not frame rate**:
`frame_time_max_ms` p90 is 267.8 ms and p99 1,666.3 ms, and
`frames_over_250ms` and `frames_over_500ms` share a maximum of **44** — one
window stalled 44 separate times for over half a second. `long_task_max_ms`
maxes at 7,020 ms. A player on that device did not see a slow game; they saw a
game that stopped.

`q` (`04-`): high 756 windows / low 316 / medium 195, and `gl` hardware 639
against software 4 — the ladder was mostly running at its top rung, so the
hitching is not a low-end-device story.

## 5. The loading screen nobody finished looking at

`run_wait.art`: **pending 335, ready 22** (`03-`/`04-`). 93.8% of recorded
waits happened with the loading art still unresolved. Combined with
`run_start.wait_ms` (p50 2,147 ms, p90 38,425 ms, max 42,434,681 ms — eleven
hours, i.e. a backgrounded tab), the first thing most arrivals saw was an
unfinished screen for two seconds, and the unlucky tenth saw it for most of a
minute.

The 11-12 build (`4e30e5f5`) moved this: per-day `wait_ms` p50 2,559 → 1,033
ms, p90 10,991 → 5,038 ms. That is the one measured improvement in the whole
test, and it is real — but it is an improvement to the wait, not to what
happens after it.

## 6. Ads: not enough data to have an opinion

`ad_offer_shown` 7 events / 4 sessions / 3 users. `ad_completed` 5 / 3 / 2.
Two complete rewarded chains exist in nine days (11-10 18:36, 11-12 09:40) plus
three events from a single user on 11-13. Every rewarded-ad number in this
archive comes from **one or two people**.

Interstitials are better attested and look worse over time: on 11-13,
`advertisement_interstitial_failed` reached 11 sessions against
`advertisement_interstitial_opened` 7. A fill-rate problem, not a placement
one — but with a funnel where only 33 sessions ever reach floor 2, ad
placement was never the binding constraint.

## 7. Ranked directions, as they stood when the test ended

Ranked by how much of the measured loss each one addresses, not by effort.
None of these was validated — the test ended first. They are recorded as the
hypotheses this data generated, so the next attempt starts here rather than at
the beginning.

1. **Tell the player there is something to press.** The untouched third
   (34.9% of started runs) is the largest single loss and the opening hold did
   not move it. The hold buys time; nothing yet spends that time on an
   instruction. A prompt drawn *during* the hold is the obvious experiment.
2. **Make floor 1 survivable, or shorter.** 33 of 198 engaged sessions reached
   floor 2; `run_end.floor` p50 = 1. Whether that is difficulty or length is
   not answerable from this data — `run_death` has 32 events over 25 sessions,
   below the reliability floor — which is itself a reason to instrument it
   before changing it.
3. **Ship the `pagehide` session beacon** (§3). Not a fix for a player
   problem; a fix for being unable to see one. Nothing in rank 1 or 2 can be
   evaluated without it.
4. **Keep the wait where 11-12 put it** (§5) and stop optimizing it. It is the
   one thing already working.
5. **Hitching, scoped to the tail** (§4). Real, but it affects the p90–p99 of
   windows, not the median arrival, and it is not what the funnel is losing.
6. **Ads: do nothing until the funnel moves** (§6).

## 8. What this archive cannot answer

Kept deliberately, because the temptation later will be to try:

- Session length as the game measures it — `session_end` fired once (§3).
- Campaign vs organic — `source` is near-absent, cardinality 1 (§3).
- Anything per-character — cardinality 1 (§3).
- Per-session frame rate — the guide is explicit that performance samples are
  a sample distribution, not a session distribution, and the tools do not link
  performance to progression (`README.md`).
- Any field whose values were never expanded before deletion — the closing
  table of `04-` lists each one by name. Those are gone.
- Anything at raw-event granularity. These are preaggregated views; there was
  never an export.
