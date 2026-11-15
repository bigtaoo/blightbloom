# Daily totals and session duration

Two independent tools, two different session denominators. Keep them apart.

## Event volume per day

`get_game_telemetry_timeseries`, `granularity: "1d"`, 2026-11-06 .. 2026-11-14.
`unique_sessions` here means *sessions that emitted at least one event that day*.

| day | events | payload bytes | unique_sessions | unique_users |
|---|---|---|---|---|
| 2026-11-06 | 189 | 23,096 | 10 | 5 |
| 2026-11-07 | 500 | 63,341 | 48 | 43 |
| 2026-11-08 | 1,707 | 246,417 | 131 | 105 |
| 2026-11-09 | 730 | 68,990 | 62 | 55 |
| 2026-11-10 | 1,791 | 193,931 | 123 | 111 |
| 2026-11-11 | 1,161 | 115,423 | 107 | 77 |
| 2026-11-12 | 1,022 | 101,025 | 95 | 74 |
| 2026-11-13 | 1,533 | 200,680 | 97 | 67 |
| 2026-11-14 | 3 | 188 | 1 | 1 |
| **sum** | **8,636** | **1,013,091** | 674 | — |

The event and byte sums match the full-range overview exactly (8,636 / 1,013,091). The session
column sums to 674 against an overview `unique_sessions` of **673** — one session crossed midnight
and is counted on both of its days. Users do not sum at all (518 unique over the window); the same
person returning on a second day is one user and two rows.

## Session duration per day

`get_game_telemetry_analytics`, one call per day, `sessions` block. `count` here means *sessions
with a recorded duration*, which is why it is consistently lower than the column above: a session
that fired events but never produced a `core_session_end` has no duration to report. All durations
in seconds.

| day | count | identified_users | avg | p50 | p95 | max |
|---|---|---|---|---|---|---|
| 2026-11-06 | 8 | 3 | 989.61375 | 1161.85205 | 2292.686 | 2292.686 |
| 2026-11-07 | 24 | 23 | 529.762625 | 10.017 | 1621.942 | 9357.834 |
| 2026-11-08 | 68 | 64 | 530.355205882353 | 28.788999557495117 | 2519.958 | 17985.395 |
| 2026-11-09 | 58 | 54 | 64.07863793103449 | 0 | 486.321 | 526.085 |
| 2026-11-10 | 118 | 107 | 199.7459237288135 | 5.007999897003174 | 451.306 | 14250.216 |
| 2026-11-11 | 104 | 75 | 110.13194230769233 | 0 | 426.093994140625 | 3804.953 |
| 2026-11-12 | 86 | 68 | 134.76706976744188 | 0 | 887.4409790039062 | 5148.103 |
| 2026-11-13 | 90 | 63 | 216.65763333333337 | 0 | 656.7570190429688 | 9753.662 |
| 2026-11-14 | 1 | 1 | 0 | 0 | 0 | 0 |

Full range, from the same tool without a day filter:
`count 557, identified_users 443, avg 227.1540825852783, p50 0, p95 937.1300048828125,
max 17985.395, latest_session_end 2026-11-14T09:36:10.347Z`. The daily counts sum to 557 exactly.

### Derived (not tool output): total seconds played per day

`avg x count`, computed here, rounded to 0.1 s. Included because the mean alone is unreadable in
this dataset.

| day | total seconds | mean | note |
|---|---|---|---|
| 2026-11-06 | 7,916.9 | 989.6 | 8 sessions, 3 of them identified: developer testing, not players |
| 2026-11-07 | 12,714.3 | 529.8 | |
| 2026-11-08 | 36,064.2 | 530.4 | includes the window max, 17,985.4 s (5.0 h) |
| 2026-11-09 | 3,716.6 | 64.1 | first day of the $12 campaign |
| 2026-11-10 | 23,570.0 | 199.7 | |
| 2026-11-11 | 11,453.7 | 110.1 | |
| 2026-11-12 | 11,590.0 | 134.8 | two builds, split at 09:54:32Z |
| 2026-11-13 | 19,499.2 | 216.7 | half day; last `run_start` 08:04:06Z |
| 2026-11-14 | 0 | 0 | one session, no duration |

**The headline trap in this table.** 11-11 to 11-12 looks like a 22% improvement in mean session
length (110.1 to 134.8 s). It is not. Total seconds moved 11,453.7 to 11,590.0, **+1.2%**, while
the denominator fell from 104 sessions to 86. On 11-12 a single session of 5,148.1 s is 44.4% of
the whole day. Strip each day of its longest session and the means are 74.3 s (11-11) and 75.8 s
(11-12) — flat. `p50` is **0 on four of the nine days**, 11-11 through 11-14 included: more than
half of all sessions, on most days, never registered a measurable duration at all.
