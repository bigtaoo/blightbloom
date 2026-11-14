# Per-day event breakdown

Source: `get_game_telemetry_analytics`, one call per calendar day with
`dateFrom == dateTo` and `eventLimit: 100`. Per-day calls are the only way to
get the breakdown split by day; the full-range call returns one combined
`top_events`.

`omitted_event_types: 0` on every day below — no event type was cut from any
table, so each day's list is complete.

Each row is **events / sessions / users** for that day. Per-event
`payload_bytes` and per-event first/last timestamps are dropped for width; the
day bounds them, and the totals are in the overview line. `event_kind` is noted
only where it is not `custom`: **(s)** = `standard`.

The `sessions` block is the platform's own session measure, not the game's —
the game's `session_end` fired once in nine days (see `03-`). `p50 = 0` on a day
means the median session had no measurable duration at all.

**Day boundaries are UTC.** 2026-11-13 is a half day (last event
`2026-11-13T12:13:18.435Z`) and 2026-11-14 holds only stragglers.

---

## 2026-11-06 — 189 events / 10 sessions / 5 users / 17 event types

`payload_bytes` 23,096. `processed_at` `2026-11-07T02:00:50.284Z`.

| event | ev | sess | users |
|---|---|---|---|
| screen_view | 40 | 8 | 3 |
| core_session_end (s) | 25 | 10 | 5 |
| active_time | 21 | 8 | 3 |
| core_ping (s) | 20 | 6 | 3 |
| performance_sample | 17 | 5 | 3 |
| run_start | 11 | 8 | 3 |
| core_initialization_started (s) | 10 | 10 | 5 |
| platform_message_game_ready (s) | 10 | 10 | 5 |
| session_start | 8 | 8 | 3 |
| run_end | 6 | 4 | 3 |
| gameplay_30s (s) | 6 | 6 | 3 |
| advertisement_interstitial_closed (s) | 4 | 2 | 2 |
| advertisement_interstitial_opened (s) | 4 | 2 | 2 |
| gameplay_60s (s) | 3 | 3 | 3 |
| floor_reached | 2 | 2 | 2 |
| ad_offer_shown | 1 | 1 | 1 |
| advertisement_interstitial_failed (s) | 1 | 1 | 1 |

sessions: count 8, identified_users 3, avg 989.6137500000001 s,
p50 1,161.85205078125, p95 2,292.68603515625, max 2,292.686,
latest_session_end `2026-11-06T17:50:22.523Z`.

First telemetry of the whole dataset: `core_session_end`
`2026-11-06T13:57:08.122Z`. Day one is the developer's own testing — 5 users —
and its session durations (p50 19.4 min) are the longest in the archive for
exactly that reason. **Do not read day one as player behaviour.**

---

## 2026-11-07 — 500 events / 48 sessions / 43 users / 16 event types

`payload_bytes` 63,341. `processed_at` `2026-11-08T02:00:50.174Z`.

| event | ev | sess | users |
|---|---|---|---|
| core_ping (s) | 82 | 22 | 22 |
| performance_sample | 72 | 18 | 18 |
| screen_view | 62 | 23 | 23 |
| core_session_end (s) | 58 | 45 | 40 |
| core_initialization_started (s) | 48 | 48 | 43 |
| active_time | 41 | 15 | 15 |
| platform_message_game_ready (s) | 39 | 39 | 37 |
| run_start | 24 | 21 | 21 |
| session_start | 24 | 24 | 23 |
| gameplay_30s (s) | 20 | 20 | 20 |
| gameplay_60s (s) | 11 | 11 | 11 |
| floor_reached | 8 | 5 | 5 |
| run_end | 5 | 4 | 4 |
| advertisement_interstitial_failed (s) | 3 | 2 | 2 |
| advertisement_interstitial_opened (s) | 2 | 2 | 2 |
| advertisement_interstitial_closed (s) | 1 | 1 | 1 |

sessions: count 24, identified_users 23, avg 529.7626250000001 s,
p50 10.017000198364258, p95 1,621.9420166015625, max 9,357.834,
latest_session_end `2026-11-07T23:36:12.428Z`.

First day with outside traffic. The shape that holds for the rest of the
archive is already here: `core_initialization_started` 48 but
`platform_message_game_ready` 39 and `session_start` 24 — half the arrivals
never reach the game's own first event. `max_duration_seconds` 9,357.8 (2 h 36)
against a p50 of 10.0 s is the tab-left-open artifact that makes every mean in
this dataset unusable on its own.

---

## 2026-11-08 — 1,707 events / 131 sessions / 105 users / 18 event types

`payload_bytes` 246,417. `processed_at` `2026-11-09T02:00:42.33Z`.

| event | ev | sess | users |
|---|---|---|---|
| core_ping (s) | 394 | 55 | 53 |
| performance_sample | 352 | 45 | 44 |
| screen_view | 173 | 61 | 59 |
| core_session_end (s) | 148 | 125 | 100 |
| core_initialization_started (s) | 131 | 131 | 105 |
| active_time | 122 | 31 | 31 |
| platform_message_game_ready (s) | 114 | 114 | 96 |
| run_start | 68 | 61 | 59 |
| session_start | 68 | 68 | 64 |
| gameplay_30s (s) | 49 | 49 | 48 |
| gameplay_60s (s) | 33 | 33 | 32 |
| floor_reached | 22 | 12 | 12 |
| run_end | 13 | 10 | 10 |
| advertisement_interstitial_opened (s) | 8 | 7 | 7 |
| advertisement_interstitial_failed (s) | 6 | 4 | 4 |
| advertisement_interstitial_closed (s) | 4 | 4 | 4 |
| first_input | 1 | 1 | 1 |
| session_end | 1 | 1 | 1 |

sessions: count 68, identified_users 64, avg 530.355205882353 s,
p50 28.788999557495117, p95 2,519.9580078125, max 17,985.395,
latest_session_end `2026-11-08T21:02:17.944Z`.

Two instruments are born and die on this day. `first_input` ships at
`2026-11-08T16:45:14.188Z` and fires once; it is the instrument the whole
opening-hold design rests on, so **everything before 16:45 on 11-08 has no
first-input measurement at all**. `session_end` fires its **one and only event
in the entire dataset** at 05:09:44 and is never heard from again — the game
has no working view of its own session length anywhere in this archive.
`active_time` is on its last day (ends 11:51:09.662).

`max_duration_seconds` 17,985 s = 5 h 0 m, i.e. a tab left open overnight; the
avg of 530 s is that one session.

---

## 2026-11-09 — 730 events / 62 sessions / 55 users / 16 event types

`payload_bytes` 68,990. `processed_at` `2026-11-10T07:56:09.667Z`.

| event | ev | sess | users |
|---|---|---|---|
| screen_view | 133 | 53 | 50 |
| core_ping (s) | 107 | 22 | 22 |
| performance_sample | 91 | 20 | 20 |
| core_session_end (s) | 83 | 61 | 54 |
| core_initialization_started (s) | 62 | 62 | 55 |
| session_start | 58 | 58 | 54 |
| platform_message_game_ready (s) | 54 | 54 | 51 |
| run_start | 45 | 39 | 37 |
| first_input | 29 | 29 | 29 |
| gameplay_30s (s) | 20 | 20 | 20 |
| gameplay_60s (s) | 17 | 17 | 17 |
| run_end | 11 | 8 | 8 |
| run_death | 8 | 5 | 5 |
| floor_reached | 7 | 3 | 3 |
| advertisement_interstitial_opened (s) | 3 | 3 | 3 |
| advertisement_interstitial_closed (s) | 2 | 2 | 2 |

sessions: count 58, identified_users 54, avg 64.07863793103449 s,
**p50 0**, p95 486.3210144042969, max 526.085,
latest_session_end `2026-11-09T22:56:25.395Z`.

The paid campaign starts at `2026-11-09T08:32:14.675Z` and the first event of
the day lands 88 seconds later — everything from here on is bought traffic, and
`p50_duration_seconds` goes to **0** and mostly stays there. `run_death` ships
today. `active_time` is already gone. `floor_reached` collapses to 3 sessions
out of 39 that started a run.

---

## 2026-11-10 — 1,791 events / 123 sessions / 111 users / 22 event types

`payload_bytes` 193,931. `processed_at` `2026-11-11T02:00:49.788Z`.

| event | ev | sess | users |
|---|---|---|---|
| core_ping (s) | 342 | 60 | 58 |
| screen_view | 290 | 107 | 98 |
| performance_sample | 245 | 52 | 52 |
| core_session_end (s) | 154 | 118 | 106 |
| core_initialization_started (s) | 123 | 123 | 111 |
| session_start | 118 | 118 | 107 |
| platform_message_game_ready (s) | 110 | 110 | 101 |
| run_start | 93 | 83 | 80 |
| run_wait | 82 | 76 | 69 |
| first_input | 62 | 62 | 61 |
| gameplay_30s (s) | 53 | 53 | 53 |
| gameplay_60s (s) | 35 | 35 | 35 |
| floor_reached | 30 | 12 | 12 |
| run_end | 22 | 17 | 17 |
| run_death | 15 | 12 | 12 |
| advertisement_interstitial_opened (s) | 6 | 5 | 5 |
| advertisement_interstitial_closed (s) | 5 | 4 | 4 |
| ad_offer_shown | 2 | 1 | 1 |
| ad_completed | 1 | 1 | 1 |
| advertisement_rewarded_closed (s) | 1 | 1 | 1 |
| advertisement_rewarded_opened (s) | 1 | 1 | 1 |
| advertisement_rewarded_rewarded (s) | 1 | 1 | 1 |

sessions: count 118, identified_users 107, avg 199.7459237288135 s,
p50 5.007999897003174, p95 451.3059997558594, max 14,250.216,
latest_session_end `2026-11-10T23:32:33.735Z`.

Busiest day of the archive by events, and the widest event inventory (22).
`run_wait` ships at `2026-11-10T09:42:41.036Z` — the instrument that later shows
the loading art was `pending` for 93.8% of waits — so **the 11-10 run_wait
numbers cover only the back two thirds of the day**. The one complete rewarded-ad
funnel in the whole dataset happens here at 18:36:12.415:
`ad_offer_shown` → rewarded opened → rewarded → closed → `ad_completed`, one
session, one user. That is the entire evidence base for rewarded ads.

---

## 2026-11-11 — 1,161 events / 107 sessions / 77 users / 18 event types

`payload_bytes` 115,423. `processed_at` `2026-11-12T02:02:52.496Z`.

| event | ev | sess | users |
|---|---|---|---|
| screen_view | 187 | 96 | 68 |
| core_ping (s) | 134 | 38 | 37 |
| performance_sample | 115 | 28 | 27 |
| core_session_end (s) | 115 | 100 | 70 |
| core_initialization_started (s) | 105 | 105 | 76 |
| run_wait | 103 | 99 | 72 |
| session_start | 103 | 103 | 75 |
| platform_message_game_ready (s) | 99 | 99 | 72 |
| run_start | 69 | 65 | 46 |
| first_input | 41 | 41 | 38 |
| gameplay_30s (s) | 31 | 31 | 30 |
| gameplay_60s (s) | 22 | 22 | 21 |
| floor_reached | 15 | 6 | 6 |
| run_end | 8 | 7 | 7 |
| run_death | 5 | 4 | 4 |
| advertisement_interstitial_opened (s) | 4 | 4 | 4 |
| advertisement_interstitial_closed (s) | 3 | 3 | 3 |
| advertisement_interstitial_failed (s) | 2 | 2 | 2 |

sessions: count 104, identified_users 75, avg 110.13194230769233 s,
**p50 0**, p95 426.093994140625, max 3,804.953,
latest_session_end `2026-11-11T21:39:36.208Z`.

First full day with `run_wait` on from midnight. The step that costs the most
is visible without any derivation: 105 initializations → 99 `game_ready` → 103
`session_start` → 99 `run_wait` sessions → **65** `run_start` sessions → **41**
`first_input` sessions. A third of the people who waited for the game never saw
a run start, and a third of those who did never touched anything.
`floor_reached` 6 sessions of 65 that started a run.

The opening-hold build (`cfd3fdb8`, the 2026-11-11f publish) lands during this
day, so 11-11 is a mixed day for anything the hold touches.

---

## 2026-11-12 — 1,022 events / 95 sessions / 74 users / 23 event types

`payload_bytes` 101,025. `processed_at` `2026-11-13T02:03:46Z`.
Widest inventory of the archive (23 types).

| event | ev | sess | users |
|---|---|---|---|
| screen_view | 164 | 77 | 64 |
| core_ping (s) | 132 | 35 | 34 |
| core_session_end (s) | 107 | 89 | 69 |
| performance_sample | 103 | 25 | 25 |
| core_initialization_started (s) | 94 | 94 | 74 |
| session_start | 85 | 85 | 68 |
| run_wait | 82 | 79 | 65 |
| platform_message_game_ready (s) | 78 | 78 | 65 |
| run_start | 59 | 56 | 50 |
| first_input | 34 | 34 | 34 |
| gameplay_30s (s) | 30 | 30 | 29 |
| gameplay_60s (s) | 17 | 17 | 17 |
| floor_reached | 10 | 4 | 4 |
| advertisement_interstitial_failed (s) | 6 | 4 | 4 |
| advertisement_interstitial_opened (s) | 6 | 6 | 6 |
| run_end | 4 | 4 | 4 |
| advertisement_interstitial_closed (s) | 4 | 4 | 4 |
| run_death | 2 | 2 | 2 |
| ad_completed | 1 | 1 | 1 |
| ad_offer_shown | 1 | 1 | 1 |
| advertisement_rewarded_closed (s) | 1 | 1 | 1 |
| advertisement_rewarded_opened (s) | 1 | 1 | 1 |
| advertisement_rewarded_rewarded (s) | 1 | 1 | 1 |

sessions: count 86, identified_users 68, avg 134.76706976744188 s,
**p50 0**, p95 887.4409790039062, max 5,148.103,
latest_session_end `2026-11-12T19:42:19.676Z`.

**The day the headline came from, and the day it falls apart.** The mean rose
from 110.1 s to 134.8 s while the session count fell 104 → 86, and the single
`max_duration_seconds` of 5,148.1 s is 44.4% of the day's whole total. p50 is
still 0. See `01-daily-totals.md` for the ex-max arithmetic (74.3 → 75.8 s).

Two builds run on this day, split at `2026-11-12T09:54:32Z` — **no figure in
this table means anything unsplit**, because the before and after are different
games. The rewarded-ad chain at 09:39:43 → 09:40:13 is the second and last
complete one in the archive.

---

## 2026-11-13 — 1,533 events / 97 sessions / 67 users / 23 event types

`payload_bytes` 200,680. `processed_at` `2026-11-14T02:03:37.293Z`.

| event | ev | sess | users |
|---|---|---|---|
| core_ping (s) | 310 | 27 | 25 |
| performance_sample | 272 | 24 | 22 |
| screen_view | 227 | 81 | 56 |
| core_session_end (s) | 111 | 93 | 63 |
| core_initialization_started (s) | 97 | 97 | 67 |
| run_wait | 90 | 85 | 60 |
| session_start | 90 | 90 | 63 |
| platform_message_game_ready (s) | 85 | 85 | 60 |
| run_start | 67 | 61 | 43 |
| floor_reached | 43 | 8 | 6 |
| first_input | 32 | 32 | 29 |
| gameplay_30s (s) | 27 | 27 | 25 |
| gameplay_60s (s) | 20 | 20 | 18 |
| advertisement_interstitial_failed (s) | 13 | 11 | 10 |
| advertisement_interstitial_opened (s) | 13 | 7 | 6 |
| advertisement_interstitial_closed (s) | 12 | 6 | 5 |
| run_end | 7 | 3 | 2 |
| ad_completed | 3 | 1 | 1 |
| ad_offer_shown | 3 | 1 | 1 |
| advertisement_rewarded_closed (s) | 3 | 1 | 1 |
| advertisement_rewarded_opened (s) | 3 | 1 | 1 |
| advertisement_rewarded_rewarded (s) | 3 | 1 | 1 |
| run_death | 2 | 2 | 2 |

sessions: count 90, identified_users 63, avg 216.65763333333337 s,
**p50 0**, p95 656.7570190429688, max 9,753.662,
latest_session_end `2026-11-13T15:25:25.157Z`.

**A half day.** The last `run_start` is `2026-11-13T08:04:06.294Z` and the last
`run_wait` `12:13:18.435Z`; what follows to 15:25 is session bookkeeping with no
gameplay in it. Do not compare this day's totals with a full one.

`floor_reached` 43 events but only **8 sessions / 6 users** — one or two people
went deep and the ratio says nothing about the population. Same shape in the ad
rows: 9 rewarded events, all **one session, one user**. Interstitial *failures*
(11 sessions) outnumber interstitial *opens* (7 sessions) for the first time.

---

## 2026-11-14 — 3 events / 1 session / 1 user / 3 event types

`payload_bytes` 188. `processed_at` `2026-11-14T14:02:31.107Z`.

| event | ev | sess | users |
|---|---|---|---|
| session_start | 1 | 1 | 1 |
| core_initialization_started (s) | 1 | 1 | 1 |
| core_session_end (s) | 1 | 1 | 1 |

sessions: count 1, identified_users 1, all durations 0,
latest_session_end `2026-11-14T09:36:10.347Z`.

One arrival, all three events at the same millisecond, no run. This is the last
telemetry the game ever produced. Not a data point — the tail of the archive.

---

## Cross-day funnel, in unique sessions

Derived: every cell is the `unique_sessions` column of the day tables above,
nothing else. **Sessions, not events** — the event counts in the tables are
inflated by repeats (a session reaches several floors, plays several runs).
`—` means the event did not exist yet, not zero.

| day | init | ready | sess_start | run_wait | run_start | first_input | 30s | 60s | floor | run_end |
|---|---|---|---|---|---|---|---|---|---|---|
| 11-06 | 10 | 10 | 8 | — | 8 | — | 6 | 3 | 2 | 4 |
| 11-07 | 48 | 39 | 24 | — | 21 | — | 20 | 11 | 5 | 4 |
| 11-08 | 131 | 114 | 68 | — | 61 | 1 | 49 | 33 | 12 | 10 |
| 11-09 | 62 | 54 | 58 | — | 39 | 29 | 20 | 17 | 3 | 8 |
| 11-10 | 123 | 110 | 118 | 76 | 83 | 62 | 53 | 35 | 12 | 17 |
| 11-11 | 105 | 99 | 103 | 99 | 65 | 41 | 31 | 22 | 6 | 7 |
| 11-12 | 94 | 78 | 85 | 79 | 56 | 34 | 30 | 17 | 4 | 4 |
| 11-13 | 97 | 85 | 90 | 85 | 61 | 32 | 27 | 20 | 8 | 3 |
| 11-14 | 1 | — | 1 | — | — | — | — | — | — | — |

Three things this table says that no single day does:

1. **`session_start` can exceed `ready`** (11-09, 11-10, 11-11, 11-13). The two
   are counted by different systems — the platform's and the game's — over
   session ids that do not have to agree. Do not compute a ratio across that
   boundary and call it a drop-off.
2. **`run_start` → `first_input` never gets better.** 83→62, 65→41, 56→34,
   61→32: roughly a third of the people who got a run never touched anything,
   on every day the instrument existed, before and after the opening hold
   shipped on 11-11.
3. **`floor_reached` is single-digit sessions on six of nine days.** Whatever
   the second floor costs, almost nobody in this traffic paid it. Every
   per-floor, per-chapter and per-killer number in `03-`/`04-` rests on this
   handful of sessions and is below the guide's 30-session reliability floor.

