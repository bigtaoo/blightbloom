# Per-event field summaries

Source: `get_game_telemetry_event_analytics`, `eventKind: "custom"`, range
`2026-11-06` .. `2026-11-14` (the tool reports it as
`from 2026-11-06T00:00:00Z, to_exclusive 2026-11-15T00:00:00Z`), i.e. the whole
telemetry life of the sandbox build. `schema_version: "2"` throughout.
`fields_truncated: false` and `values_approximate: false` on every call below —
no field list was cut short and no count is an estimate.

Hand-transcribed from tool output; exact to the digit. Figures are quoted at the
precision the tool returned them, floating-point tails included, because a
rounded figure cannot be checked against anything later.

Column key, repeated for every table:
- **present** — `present_count`: events in which the field existed at all. It is
  NOT the event count; a field absent from older builds has a smaller `present`,
  and **missing is not zero** (telemetry guide v1.1.2).
- **sess / user** — `unique_sessions` / `unique_users` among those events.
- **card.** — `categorical_cardinality`: how many distinct string values exist.
  The values themselves are in `04-categorical-distributions.md`; this tool only
  returns them when `fieldName` is passed, which is why they live in a separate
  file.
- Numeric rows carry `sum / avg / min / max / p10 / p50 / p90 / p99`.
- Boolean rows carry `true / false` counts only.

---

## `first_input` — 199 events / 199 sessions / 189 users

`payload_bytes` 20,786. First `2026-11-08T16:45:14.188Z`, last
`2026-11-13T08:03:41.157Z`. (It does not exist before 11-08: the event was added
in that build, so its absence on 11-06/11-07 is instrumentation, not behaviour.)

| field | present | sess | user | type | summary |
|---|---|---|---|---|---|
| `build` | 199 | 199 | 189 | string | card. 5 |
| `focus` | 147 | 147 | 137 | bool | true 135 / false 12 |
| `input` | 147 | 147 | 137 | bool | true 114 / false 33 |
| `kind` | 199 | 199 | 189 | string | card. 2 |
| `locale` | 199 | 199 | 189 | string | card. 8 |
| `ms` | 199 | 199 | 189 | number | see below |
| `screen` | 199 | 199 | 189 | string | card. 3 |

`ms` — time from run start to the first input that reached the game:

| count | sum | avg | min | max | p10 | p50 | p90 | p99 |
|---|---|---|---|---|---|---|---|---|
| 199 | 5,608,856 | 28,185.206030150755 | 15 | 600,000 | 2,323 | 7,469 | 47,669 | 600,000 |

Two readings that must not be lost with the data:
- **p50 7,469 ms.** Half of all first touches arrive more than 7.5 s after the
  run has already started shooting. This single number is the entire reason
  `client/src/game/controllers/openingHold.ts` exists.
- **max and p99 are both exactly 600,000** — a 10-minute clamp in the client,
  not a measurement. Anything at 600,000 is "never, within the cap"; the `avg`
  of 28.2 s is dragged by them and should not be quoted as a human latency.
- `focus`/`input` are present on only 147 of 199 events (the later builds). Of
  those, 33 first inputs arrived in a session that had NOT previously been
  marked as having input — i.e. the event is doing its job as the first one.

---

## `run_end` — 76 events / 57 sessions / 53 users

`payload_bytes` 10,806. First `2026-11-06T15:02:04.613Z`, last
`2026-11-13T06:42:09.541Z`.

| field | present | sess | user | type | summary |
|---|---|---|---|---|---|
| `build` | 76 | 57 | 53 | string | card. 9 |
| `chapter` | 75 | 57 | 53 | string | card. 5 |
| `duration_s` | 76 | 57 | 53 | number | see below |
| `floor` | 76 | 57 | 53 | number | see below |
| `focus` | 31 | 23 | 21 | bool | true 30 / false 1 |
| `input` | 31 | 23 | 21 | bool | true 28 / false 3 |
| `install` | 23 | 17 | 16 | string | card. 16 |
| `locale` | 76 | 57 | 53 | string | card. 7 |
| `outcome` | 76 | 57 | 53 | string | card. 3 |
| `session` | 23 | 17 | 16 | string | card. 17 |

| field | count | sum | avg | min | max | p10 | p50 | p90 | p99 |
|---|---|---|---|---|---|---|---|---|---|
| `duration_s` | 76 | 12,081 | 158.96052631578948 | 0 | 843 | 21 | 81 | 519 | 843 |
| `floor` | 76 | 132 | 1.736842105263158 | 1 | 8 | 1 | 1 | 5 | 8 |

- **`floor` p50 = 1 and p90 = 5.** The median run ends on the floor it started
  on. The distribution is not a slope, it is two populations: runs that end
  almost at once, and a thin tail that goes deep.
- **`duration_s` min = 0.** Zero-second runs are real rows here, not nulls.
- `install` and `session` are per-install / per-session identifiers: cardinality
  (16, 17) is ~= present count, so they carry no distribution worth tabulating
  and are deliberately NOT expanded in `04-`. They are present on only 23 of 76
  events because the fields were added late.
- `focus`/`input` present on only 31 events, same reason.

---

## `run_start` — 436 events / 394 sessions / 330 users

`payload_bytes` 56,556. First `2026-11-06T14:01:06.486Z`, last
`2026-11-13T08:04:06.294Z`.

| field | present | sess | user | type | summary |
|---|---|---|---|---|---|
| `build` | 436 | 394 | 330 | string | card. 13 |
| `chapter` | 434 | 394 | 330 | string | card. 5 |
| `character` | 436 | 394 | 330 | string | **card. 1** |
| `focus` | 256 | 237 | 187 | bool | true 228 / false 28 |
| `input` | 256 | 237 | 187 | bool | true 42 / **false 214** |
| `install` | 85 | 73 | 67 | string | card. 67 (identifier) |
| `locale` | 436 | 394 | 330 | string | card. 8 |
| `session` | 85 | 73 | 67 | string | card. 73 (identifier) |
| `wait_ms` | 255 | 237 | 187 | number | see below |

| field | count | sum | avg | min | max | p10 | p50 | p90 | p99 |
|---|---|---|---|---|---|---|---|---|---|
| `wait_ms` | 255 | 102,960,062 | 403,764.94901960786 | 250 | 42,434,681 | 946 | 2,146.875 | 38,425 | 4,765,117 |

Three things this table says that a later reader will want:
- **`character` has cardinality 1.** Every one of the 436 runs was
  `char_vanguard`. Not a preference — nobody ever reached, or ever chose, a
  second hero. Any hero-balance question asked of this dataset is unanswerable.
- **`input` is false on 214 of 256 run starts (83.6%).** The run begins while the
  session has registered no input at all. This is the autostart, measured.
- **`wait_ms` max is 42,434,681 ms — 11.8 hours.** A backgrounded tab, not a
  player. `avg` (403.8 s) is meaningless; `p50` 2,146.875 ms and `p90` 38,425 ms
  are the readable ones, and even `p99` (4,765,117 = 79 min) is tab-away.
  The per-build split of this field is the only genuine before/after measurement
  in the whole dataset — see `05-funnel-and-findings.md`.

---

## `run_wait` — 357 events / 339 sessions / 261 users

`payload_bytes` 29,637. First `2026-11-10T09:42:41.036Z`, last
`2026-11-13T12:13:18.435Z` — the event only exists from the 11-10 build onward,
so it covers four of the nine days and **cannot be compared with 11-06..11-09**.

| field | present | sess | user | type | summary |
|---|---|---|---|---|---|
| `art` | 357 | 339 | 261 | string | card. 2 — **pending 335 / ready 22** |
| `build` | 357 | 339 | 261 | string | card. 3 |
| `focus` | 357 | 339 | 261 | bool | true 278 / false 79 |
| `input` | 357 | 339 | 261 | bool | true 29 / **false 328** |
| `locale` | 357 | 339 | 261 | string | card. 8 |

- **`art: pending` on 335 of 357 (93.8%).** The wait screen is nearly always
  waiting on art, not on anything else. Of all the single figures in this
  archive this is the one with the clearest fix attached to it.
- `focus: false` on 79 (22.1%) — a fifth of waits happen in a tab nobody is
  looking at, which also inflates the `wait_ms` tail above.

---

## `run_death` — 32 events / 25 sessions / 25 users

`payload_bytes` 3,688. First `2026-11-09T10:34:11.861Z`, last
`2026-11-13T05:42:54.463Z`. Added in the 11-09 build.

**32 events is below the telemetry guide's reliability floor of 30 unique
sessions (25 here).** Every figure in this section is a sample, not a rate.

| field | present | sess | user | type | summary |
|---|---|---|---|---|---|
| `build` | 32 | 25 | 25 | string | card. 4 |
| `burst_pct` | 32 | 25 | 25 | number | see below |
| `focus` | 16 | 14 | 14 | bool | **true 16 / false 0** |
| `hits` | 32 | 25 | 25 | number | see below |
| `input` | 16 | 14 | 14 | bool | true 13 / false 3 |
| `killer` | 32 | 25 | 25 | string | card. 7 |
| `locale` | 32 | 25 | 25 | string | card. 6 |
| `room` | 32 | 25 | 25 | string | card. 8 |

| field | count | sum | avg | min | max | p10 | p50 | p90 | p99 |
|---|---|---|---|---|---|---|---|---|---|
| `burst_pct` | 32 | 1,699 | 53.09375 | 30 | 100 | 30 | 50 | 80 | 100 |
| `hits` | 32 | 649 | 20.28125 | 10 | 71 | 10 | 14 | 30 | 71 |

- **`focus` is true on all 16 events that carry it.** Nobody died in a
  backgrounded tab — deaths are what happens to players who are *watching*.
  Which also means death is not what ends most sessions: 32 deaths against 436
  run starts.
- `hits` p50 = 14: the median death takes 14 hits. At 1 damage a hit this is a
  long, legible decline, not a one-shot.

---

## `floor_reached` — 137 events / 52 sessions / 48 users

`payload_bytes` 14,569. First `2026-11-06T15:04:02.061Z`, last
`2026-11-13T08:12:39.806Z`.

| field | present | sess | user | type | summary |
|---|---|---|---|---|---|
| `build` | 137 | 52 | 48 | string | card. 8 |
| `chapter` | 136 | 51 | 47 | string | card. 5 |
| `floor` | 137 | 52 | 48 | number | see below |
| `focus` | 88 | 23 | 20 | bool | **true 88 / false 0** |
| `input` | 88 | 23 | 20 | bool | **true 88 / false 0** |
| `install` | 30 | 18 | 18 | string | card. 18 (identifier) |
| `locale` | 137 | 52 | 48 | string | card. 5 |
| `session` | 30 | 18 | 18 | string | card. 18 (identifier) |

| field | count | sum | avg | min | max | p10 | p50 | p90 | p99 |
|---|---|---|---|---|---|---|---|---|---|
| `floor` | 137 | 424 | 3.0948905109489053 | 2 | 8 | 2 | 3 | 5 | 8 |

- **137 events over only 52 sessions — 2.6 floors per progressing session.** The
  progression that exists is concentrated in a handful of people; 52 sessions of
  394 that started a run (13.2%) ever left floor 1.
- `floor` min is 2 because the event fires on *arriving* at a new floor; floor 1
  is the start, not a reach.
- `focus` and `input` are true on 88/88 — every floor reached was reached by a
  watching, playing human. There is no bot traffic inside this funnel stage.

---

## `gameplay_30s` / `gameplay_60s` — **`eventKind: "standard"`, not `"custom"`**

Both return `event_count: 0` when queried as `custom`. They live in the
`standard` namespace (the tool accepts exactly `standard | custom | system`).
Anyone re-running these queries against another game must pass the right kind or
they will read a real event as absent.

| event | kind | events | sessions | users | payload_bytes | first | last |
|---|---|---|---|---|---|---|---|
| `gameplay_30s` | standard | 236 | 236 | 223 | 0 | `2026-11-06T14:01:06.486Z` | `2026-11-13T08:04:06.294Z` |
| `gameplay_60s` | standard | 158 | 158 | 150 | 0 | `2026-11-06T14:01:15.516Z` | `2026-11-13T08:04:38.76Z` |

`fields: []` on both — standard events carry no payload, so there is nothing to
break down. Exactly one per session, which is what makes them usable as funnel
stages.

**Timestamp caveat, important.** `gameplay_30s.first_event_at` is identical to
`run_start.first_event_at` to the millisecond, and `gameplay_60s` follows it by
9 s, not 30 s. A 30-second milestone cannot fire 9 s after a 30-second one, so
these timestamps are flush/batch times, not moments of occurrence. Use the
counts; do not use standard-event timestamps to measure elapsed play.

---

## `active_time` — 184 events / 54 sessions / 48 users

`payload_bytes` 28,061. First `2026-11-06T14:01:06.486Z`, last
`2026-11-08T11:51:09.662Z`. **The event was removed after 11-08** and covers
only the first three days — its `processed_at` is `2026-11-09T02:00:42.33Z`,
while every other event here reads `2026-11-14T02:03:37.293Z`. The preaggregate
froze when the event stopped arriving.

| field | present | sess | user | type | summary |
|---|---|---|---|---|---|
| `active_s` | 184 | 54 | 48 | number | see below |
| `build` | 184 | 54 | 48 | string | card. 7 |
| `install` | 184 | 54 | 48 | string | card. 48 (identifier) |
| `locale` | 184 | 54 | 48 | string | card. 4 |
| `session` | 184 | 54 | 48 | string | card. 54 (identifier) |

| field | count | sum | avg | min | max | p10 | p50 | p90 | p99 |
|---|---|---|---|---|---|---|---|---|---|
| `active_s` | 184 | 38,659 | 210.10326086956522 | 1 | 960 | 34 | 122 | 480 | 900 |

This is the only *active* (as opposed to wall-clock) time measure the sandbox
ever had, and it does not overlap the builds that matter. p50 122 s of active
play on 11-06..11-08 is not comparable with anything later in this archive.

---

## `ad_offer_shown` — 7 events / 4 sessions / 3 users

`payload_bytes` 534. First `2026-11-06T17:43:21.584Z`, last
`2026-11-13T04:06:08.662Z`. Far below any reliability floor; recorded for
completeness only.

| field | present | sess | user | type | summary |
|---|---|---|---|---|---|
| `build` | 7 | 4 | 3 | string | card. 4 |
| `focus` | 6 | 3 | 2 | bool | true 6 / false 0 |
| `input` | 6 | 3 | 2 | bool | true 6 / false 0 |
| `install` | 1 | 1 | 1 | string | card. 1 |
| `locale` | 7 | 4 | 3 | string | card. 2 |
| `session` | 1 | 1 | 1 | string | card. 1 |

---

## `ad_completed` — 5 events / 3 sessions / 2 users

`payload_bytes` 330. First `2026-11-10T18:36:12.415Z`, last
`2026-11-13T04:06:39.356Z`.

| field | present | sess | user | type | summary |
|---|---|---|---|---|---|
| `build` | 5 | 3 | 2 | string | card. 3 |
| `focus` | 5 | 3 | 2 | bool | true 5 / false 0 |
| `input` | 5 | 3 | 2 | bool | true 5 / false 0 |
| `locale` | 5 | 3 | 2 | string | card. 2 |

Seven offers, five completions, **two distinct humans**, over nine days. The
monetisation surface was never exercised enough to be measured, and no
conclusion about ad placement can honestly be drawn from this dataset.

---

## `session_end` — **1 event, ever**

`payload_bytes` 168. Both first and last are `2026-11-08T05:09:44.682Z`.
`processed_at` `2026-11-09T02:00:42.33Z` — frozen along with `active_time`.

| field | present | summary |
|---|---|---|
| `active_s` | 1 | all percentiles = 21 |
| `build` | 1 | card. 1 |
| `duration_s` | 1 | all percentiles = 21 |
| `install` | 1 | card. 1 |
| `locale` | 1 | card. 1 |
| `session` | 1 | card. 1 |

**This is the single most consequential gap in the whole dataset.** The game's
own end-of-session beacon fired exactly once across 673 sessions. Everything
this archive says about session length therefore comes from the platform's
`sessions` block and `core_session_end` (802 events), never from the game — so
the game's own view of how long people played does not exist. A `pagehide` /
`visibilitychange` beacon is the fix, and it was never shipped during this test.

---

## `session_start` — 555 events / 555 sessions / 443 users

`payload_bytes` 89,891. First `2026-11-06T14:01:06.486Z`, last
`2026-11-14T09:36:10.347Z` — the last event of any kind in the dataset.
`processed_at` `2026-11-14T14:02:31.107Z`, the freshest preaggregate here,
because this is the only event still arriving on 11-14.

| field | present | sess | user | type | summary |
|---|---|---|---|---|---|
| `aspect` | 126 | 126 | 96 | string | card. 2 |
| `boot_ms` | 473 | 473 | 373 | number | see below |
| `browser` | 555 | 555 | 443 | string | card. 6 |
| `build` | 555 | 555 | 443 | string | card. 14 |
| `device` | 555 | 555 | 443 | string | card. 3 |
| `focus` | 360 | 360 | 272 | bool | true 270 / false 90 |
| `input` | 360 | 360 | 272 | bool | **true 0 / false 360** (card. 1) |
| `install` | 82 | 82 | 74 | string | card. 74 (identifier) |
| `locale` | 555 | 555 | 443 | string | card. 8 |
| `os` | 555 | 555 | 443 | string | card. 6 |
| `pointer` | 126 | 126 | 96 | string | card. 2 |
| `session` | 82 | 82 | 74 | string | card. 82 (identifier) |
| `source` | **26** | 26 | 24 | string | **card. 1** |
| `storage` | 555 | 555 | 443 | string | card. 2 |

| field | count | sum | avg | min | max | p10 | p50 | p90 | p99 |
|---|---|---|---|---|---|---|---|---|---|
| `boot_ms` | 473 | 1,751,893 | 3,703.7906976744184 | 173 | 474,244 | 527 | 1,784.15625 | 5,517 | 23,065 |

- **`focus: false` on 90 of 360 (25%).** A quarter of sessions start in a tab
  that is not in front. This is the denominator problem in one figure: those
  sessions are counted, and a good share of them never become a player.
- **`boot_ms` p50 1,784 ms, p90 5,517 ms, max 474,244 ms (7.9 min).** The max and
  p99 are backgrounded tabs again, not slow machines; p50/p90 are the honest
  pair, and p90 at 5.5 s is a real load-time problem on top of `run_wait`.
- **`source` is present on only 26 of 555 sessions and has cardinality 1**
  (`ref:playgama.ai`). There is effectively no attribution in this dataset: for
  529 sessions we do not know where the player came from, and **absent is not
  "direct"**. Any traffic-source analysis of this test is impossible.
- `aspect` and `pointer` exist on only 126 sessions (a later build), so the
  desktop/touch split they describe is a sample of ~23%, not the whole.

---

## `screen_view` — 1,276 events / 506 sessions / 409 users

`payload_bytes` 117,717. First `2026-11-06T14:01:06.486Z`, last
`2026-11-13T08:14:37.914Z`.

| field | present | sess | user | type | summary |
|---|---|---|---|---|---|
| `build` | 1,276 | 506 | 409 | string | card. 14 |
| `focus` | 775 | 328 | 250 | bool | true 714 / false 61 |
| `input` | 775 | 328 | 250 | bool | true 263 / **false 512** |
| `install` | 239 | 75 | 69 | string | card. 69 (identifier) |
| `locale` | 1,276 | 506 | 409 | string | card. 8 |
| `screen` | 1,276 | 506 | 409 | string | card. 9 |
| `session` | 239 | 75 | 69 | string | card. 75 (identifier) |

- 1,276 views over 506 sessions = 2.5 screens per session. Not a lot of moving
  about: the `screen` distribution in `04-` shows menu and playing taking 984 of
  the 1,276 between them.
- `input: false` on 512 of 775 (66%) — two thirds of all screen changes happen
  in a session that has still not received an input. Screens are being changed
  *at* the player, not *by* them.

---

## `performance_sample` — 1,267 events / 217 sessions / 206 users

`payload_bytes` 640,348 — 63% of the whole dataset's bytes for 15% of its
events. First `2026-11-06T15:01:31.066Z`, last `2026-11-13T08:14:37.914Z`.

One sample is a ~30 s window (`active_ms` p50 30,008.85). 1,267 samples over 217
sessions = 5.8 windows per sampled session. **These are sample distributions,
not session distributions** (guide v1.1.2): there is no per-session FPS here, and
a session with a long tail of bad windows is counted once per window.

### String fields

| field | present | sess | user | card. |
|---|---|---|---|---|
| `build_version` | 1,267 | 217 | 206 | 12 |
| `gl` | **643** | 110 | 105 | 2 |
| `q` | 1,267 | 217 | 206 | 3 |

`gl` exists on only half the samples (a later build), so the
hardware/software-renderer split in `04-` covers 110 sessions, not 217.

### Numeric fields — all `present_count` 1,267, `count` 1,267

| field | sum | avg | min | max | p10 | p50 | p90 | p99 |
|---|---|---|---|---|---|---|---|---|
| `active_ms` | 36,820,015 | 29,060.78531965272 | 10,266 | 30,398 | 30,000 | 30,008.849609375 | 30,025.40625 | 30,065 |
| `window_ms` | 46,433,125 | 36,648.086029992104 | 10,291 | 5,676,934 | 29,648.900390625 | 30,011.96875 | 30,209.58203125 | 86,202 |
| `frame_count` | 1,808,155 | 1,427.115232833465 | 45 | 2,160 | 683.4874877929688 | 1,640.1666259765625 | 1,801 | 2,004 |
| `target_fps` | 76,083 | 60.049723756906076 | 30 | 75 | 60 | 60 | 60 | 71 |
| `fps_avg` | 62,148.999999999985 | 49.05209155485397 | 1.5 | 72 | 27.493751525878906 | 55.918182373046875 | 60 | 66.80000305175781 |
| `fps_p10` | 55,933.600000000006 | 44.14648776637728 | 1.2 | 71.4 | 20 | 55.85972213745117 | 59.900001525878906 | 60 |
| `frame_time_p50_ms` | 30,129.500000000004 | 23.780189423835836 | 13 | 666.4 | 16.700000762939453 | 16.700000762939453 | 33.39125061035156 | 83.30000305175781 |
| `frame_time_p95_ms` | 43,200.5 | 34.09668508287293 | 14 | 916.4 | 16.799999237060547 | 25.754167556762695 | 52.050010681152344 | 116.80000305175781 |
| `frame_time_p99_ms` | 53,383.7 | 42.13393843725335 | 14 | 1,299.2 | 16.799999237060547 | 33.400001525878906 | 83.35750579833984 | 216.60000610351562 |
| `frame_time_max_ms` | 176,261 | 139.11681136543015 | 14.1 | 4,119.1 | 16.92571449279785 | 53.20909118652344 | 267.7833557128906 | 1,666.300048828125 |
| `frames_over_50ms` | 37,798 | 29.832675611681136 | 0 | 408 | 0 | 1 | 98.04386901855469 | 354 |
| `frames_over_100ms` | 1,793 | 1.4151539068666141 | 0 | 192 | 0 | 0 | 2 | 44 |
| `frames_over_250ms` | 384 | 0.303078137332281 | 0 | 44 | 0 | 0 | 1 | 4 |
| `frames_over_500ms` | 215 | 0.1696921862667719 | 0 | 44 | 0 | 0 | 0 | 2 |
| `frames_over_1000ms` | 46 | 0.036306235201262825 | 0 | 5 | 0 | 0 | 0 | 1 |
| `long_task_count` | 5,412 | 4.271507498026835 | 0 | 414 | 0 | 0 | 3 | 134 |
| `long_task_max_ms` | 185,704 | 146.5698500394633 | 0 | 7,020 | 0 | 0 | 517.0377197265625 | 1,998 |
| `long_task_total_ms` | 944,055 | 745.110497237569 | 0 | 97,973 | 0 | 0 | 1,052.275390625 | 10,100 |
| `js_error_count` | **0** | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `unhandled_rejection_count` | **1** | 0.0007892659826361484 | 0 | 1 | 0 | 0 | 0 | 0 |
| `webgl_context_loss_count` | **0** | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

### What the performance table says

- **The build did not crash.** `js_error_count` and `webgl_context_loss_count`
  are zero across all 1,267 windows, and `unhandled_rejection_count` sums to 1.
  Whatever failed this test, it was not stability — which rules out the easiest
  explanation and is worth keeping on record for exactly that reason.
- **The instrument separates wall-clock from active time correctly.**
  `window_ms` max is 5,676,934 (1.6 h) while `active_ms` max is 30,398. A
  backgrounded tab inflates the window and not the active measure, so the FPS
  figures are not diluted by tab-away time. This is the one place in the dataset
  where that distinction was built in.
- **The median machine is fine and the tenth-percentile machine is not.**
  `frame_time_p50_ms` has p50 = 16.700000762939453 — dead on 60 Hz — yet its own
  avg is 23.78 and `fps_avg` p10 is 27.49. The population is two populations.
  A single mean FPS for this game would describe nobody.
- **`fps_p10` p10 = 20.** For a tenth of all windows, the worst tenth of frames
  run at 20 fps. Against `target_fps` whose min is 30, the power-saving tier was
  being entered by real machines, not just offered.
- **`frames_over_50ms` p90 = 98.04** out of a p50 `frame_count` of 1,640: six
  percent of frames janking, in the worst tenth of windows. `long_task_total_ms`
  p90 = 1,052 ms per 30 s window (3.5% of the window blocked) and p99 = 10,100 ms
  (a third of it). The long tasks, not the renderer, are the thing to chase.
- **`frames_over_250ms` and `frames_over_500ms` share a max of 44.** The same
  window contains all of them: one window in the set stalled 44 times for over
  half a second. That is not a frame-rate problem, it is a hitching problem, and
  it is the shape most likely to have made this build feel bad to play.

