# Playgama sandbox telemetry archive — Blightbloom, 2026-11-06 .. 2026-11-14

This directory is a **salvage copy**. The sandbox application and its traffic test are about to be
deleted, and with them every number below: the Playgama console exposes telemetry only as
preaggregated views behind MCP tools, there is no export endpoint, and nothing here can be fetched
again once the application is gone. These files exist so that a later question about this test
("what did the funnel look like before the opening hold shipped?", "how did `wait_ms` move across
builds?") can still be answered.

## Provenance, and what "faithful transcription" means here

Every figure in these files was read from the Playgama developer-console MCP tools on
**2026-11-14**, in the session that wrote them. The tools return JSON to the agent but **cannot
write files**, so each number was transcribed by hand from a tool result into these tables. They
are transcriptions, not a machine export: exact to the digit as returned, but hand-copied. Where a
tool returned a long float (`227.1540825852783`), it is reproduced unrounded; rounded forms appear
only in the derived analysis file, and are marked as derived.

Tools used, all against `applicationId = cmw50x3v701x1pz0h001x2abi`:

| Tool | Used for |
|---|---|
| `get_game_telemetry_analytics` | full-range overview; per-day overview (one call per day) |
| `get_game_telemetry_timeseries` (`granularity: "1d"`) | daily totals |
| `get_game_telemetry_event_analytics` (no `fieldName`) | per-event numeric / boolean field summaries |
| `get_game_telemetry_event_analytics` (with `fieldName`) | categorical value distributions |
| `get_application`, `get_sandbox_state`, `get_sandbox_traffic` | build list, publish revision, campaigns |

A string field's `values` array is returned **only** when `fieldName` is passed — a summary taken
without it reports `categorical_cardinality` and nothing else. Both shapes were pulled, which is
why `03-` and `04-` are separate files.

## Files

| File | Contents |
|---|---|
| `00-application-and-builds.md` | the application record, all 16 uploaded archives with timestamps, the live revision, both traffic campaigns |
| `01-daily-totals.md` | per-day event volume, payload bytes, sessions, users; per-day session-duration statistics |
| `02-per-day-event-breakdown.md` | each day's full per-event breakdown (count / sessions / users), the day's session statistics, and a cross-day funnel in unique sessions |
| `03-event-field-summaries.md` | numeric and boolean field summaries per event (sums, mins, maxes, p10/p50/p90/p99), `performance_sample` included |
| `04-categorical-distributions.md` | every bounded string field's value distribution |
| `05-funnel-and-findings.md` | **derived**: the funnel, the eight sections of findings and caveats, and the ranked directions — analysis, not raw data |

## Reading rules that apply to every number here

From the Playgama telemetry guide, v1.1.2, which governs these tools:

1. **Fewer than 30 unique sessions makes a performance conclusion unreliable.** Say so rather than
   reporting the mean as fact.
2. **A missing or null field is unavailable, never zero.** `present_count` below the event count
   means the field was absent, not that it was absent-and-therefore-nothing-happened.
3. **`event_count` is not a session or user count.** Each row carries its own denominators; use
   them.
4. **These are sample distributions, not session distributions.** `performance_sample` aggregates
   every 30-second sample in the period, so a long session contributes many samples and weights the
   mean. There is no per-session FPS here.
5. **The tools do not link performance to progression.** Nothing here establishes that low-FPS
   sessions quit earlier; do not read that into it later.

## Confounders baked into this window

- **Two builds on 2026-11-12.** The live revision changed at `2026-11-12T09:54:32Z` (archive
  `blightbloom-2026-11-12-4e30e5f5-run-gate-payload`). Any day-level figure spanning that moment
  mixes two builds. Split on `build` / `build_version` — see `04-`, where every event that carries
  one has its build distribution.
- **Paid-shaped traffic, not organic.** A FREE traffic campaign (`cmw906b1t27fdmt0hzvv5ony1`,
  budget $12) ran from `2026-11-09T08:32:14.675Z` to `2026-11-14T15:35:40.190Z`, and an earlier one
  (`cmw6n5dse0n5zmt0h4a9c8oul`, $3) from 11-07 to 11-08. Most sessions in this window arrived by ad
  click. `session_start.source` recorded a referrer for only 26 of 555 sessions, all
  `ref:playgama.ai`.
- **11-13 is a half day.** The last `run_start` is at `2026-11-13T08:04:06.294Z`; the last
  `session_start` of the whole window is `2026-11-14T09:36:10.347Z`, a single session with no
  recorded duration. Do not compare 11-13 or 11-14 totals against a full day.
- **`active_time` only exists for 11-06 .. 11-08.** It was replaced; treat its absence afterwards as
  an instrument change, not a behaviour change.
- **`run_wait` starts on 11-10** (`first_event_at 2026-11-10T09:42:41.036Z`) — earlier days have no
  wait measurement at all.

## Telemetry life of this application

`first_event_at 2026-11-06T13:57:08.122Z` .. `latest_session_end 2026-11-14T09:36:10.347Z`.
Nine calendar days, 8,636 events, 673 unique sessions, 518 unique users, 25 event types,
`omitted_event_types: 0` on every call (nothing was truncated away).
