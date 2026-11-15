# Categorical value distributions

Source: `get_game_telemetry_event_analytics` **with `fieldName` passed**. This
matters and is easy to lose: the tool returns a field's `values` array ONLY when
`fieldName` names that field. Without it you get cardinality and nothing else —
which is why `03-event-field-summaries.md` can say "card. 7" but not name the
seven. Every call below reports `values_approximate: false`, so these are exact
counts, not sketches.

Range `2026-11-06` .. `2026-11-14`, the whole telemetry life. Each row is
**events / sessions / users**.

**Build strings.** The real stored value is `0.0.1+<short-sha>` — verified
directly on `session_start.build`, e.g. `0.0.1+ee9465b8`. The tables below print
the short-sha part alone for width; prefix `0.0.1+` to recover the stored
string. `unknown` is a literal stored value, not a gap.

**The 11-12 split.** Two builds shipped on 2026-11-12, the second at
`2026-11-12T09:54:32Z`. No figure spanning that moment means anything unsplit;
see `README.md`.

---

## Builds

### `session_start.build` — 14 values, 555 events

| build | ev | sess | users |
|---|---|---|---|
| ee9465b8 | 162 | 162 | 126 |
| 4e30e5f5 | 126 | 126 | 96 |
| 4f9804f3 | 92 | 92 | 85 |
| 99cba6ee | 73 | 73 | 71 |
| 9403aaf9 | 72 | 72 | 55 |
| a6febbce | 16 | 16 | 15 |
| 5e325436 | 3 | 3 | 3 |
| 935340c | 2 | 2 | 2 |
| 14af20b3 | 2 | 2 | 2 |
| 6d2ae6b5 | 2 | 2 | 2 |
| `unknown` | 2 | 2 | 1 |
| 40382ff8 | 1 | 1 | 1 |
| f63ae5fa | 1 | 1 | 1 |
| 21e5b74f | 1 | 1 | 1 |

Sessions equal events on every row (one `session_start` per session, by
construction). `935340c` is seven characters, not eight — a real short-sha of
that length, not a truncation.

### `run_start.build` — 13 values, 436 events

| build | ev | sess | users |
|---|---|---|---|
| ee9465b8 | 115 | 106 | 84 |
| 4e30e5f5 | 94 | 88 | 69 |
| 4f9804f3 | 77 | 67 | 65 |
| 99cba6ee | 73 | 64 | 64 |
| 9403aaf9 | 47 | 43 | 37 |
| a6febbce | 15 | 14 | 13 |
| 935340c | 4 | 2 | 2 |
| 14af20b3 | 3 | 2 | 2 |
| 5e325436 | 3 | 3 | 3 |
| `unknown` | 2 | 2 | 1 |
| 40382ff8 | 1 | 1 | 1 |
| f63ae5fa | 1 | 1 | 1 |
| 21e5b74f | 1 | 1 | 1 |

### `performance_sample.build_version` — 12 values, 1,267 events

| build | ev | sess | users |
|---|---|---|---|
| 4e30e5f5 | 298 | 35 | 33 |
| 99cba6ee | 290 | 53 | 53 |
| ee9465b8 | 248 | 53 | 52 |
| 4f9804f3 | 183 | 39 | 39 |
| a6febbce | 120 | 8 | 7 |
| 9403aaf9 | 97 | 22 | 22 |
| 14af20b3 | 12 | 2 | 2 |
| 5e325436 | 9 | 1 | 1 |
| 935340c | 7 | 1 | 1 |
| 40382ff8 | 1 | 1 | 1 |
| f63ae5fa | 1 | 1 | 1 |
| 21e5b74f | 1 | 1 | 1 |

Note the field is named `build_version` here and `build` everywhere else.
`a6febbce` is the warning case: 120 samples from **7 people**. Any per-build
performance comparison must be made on sessions, never on sample counts.

### `run_wait.build` — 3 values, 357 events

| build | ev | sess | users |
|---|---|---|---|
| ee9465b8 | 162 | 153 | 120 |
| 4e30e5f5 | 124 | 119 | 91 |
| 9403aaf9 | 71 | 67 | 54 |

### `run_end.build` — 9 values, 76 events

| build | ev | sess | users |
|---|---|---|---|
| 4f9804f3 | 21 | 16 | 16 |
| ee9465b8 | 19 | 15 | 15 |
| 99cba6ee | 17 | 13 | 13 |
| 4e30e5f5 | 7 | 3 | 2 |
| 9403aaf9 | 5 | 5 | 5 |
| 935340c | 3 | 2 | 2 |
| 14af20b3 | 2 | 1 | 1 |
| a6febbce | 1 | 1 | 1 |
| 21e5b74f | 1 | 1 | 1 |

---

## Who arrived — `session_start`, 555 sessions

### `browser` — 6 values

| value | ev | sess | users |
|---|---|---|---|
| edge | 268 | 268 | 219 |
| chrome | 228 | 228 | 178 |
| safari | 40 | 40 | 29 |
| opera | 9 | 9 | 7 |
| firefox | 9 | 9 | 9 |
| samsung | 1 | 1 | 1 |

### `os` — 6 values

| value | ev | sess | users |
|---|---|---|---|
| windows | 452 | 452 | 369 |
| ios | 41 | 41 | 30 |
| chromeos | 36 | 36 | 18 |
| android | 15 | 15 | 15 |
| macos | 7 | 7 | 7 |
| linux | 4 | 4 | 4 |

### `device` — 3 values

| value | ev | sess | users |
|---|---|---|---|
| desktop | 499 | 499 | 398 |
| tablet | 42 | 42 | 31 |
| phone | 14 | 14 | 14 |

### `locale` — 8 values

| value | ev | sess | users |
|---|---|---|---|
| en | 425 | 425 | 345 |
| es | 49 | 49 | 33 |
| ru | 26 | 26 | 24 |
| fr | 22 | 22 | 21 |
| de | 14 | 14 | 9 |
| zh | 9 | 9 | 5 |
| pl | 8 | 8 | 5 |
| it | 2 | 2 | 2 |

### `storage` — 2 values

| value | ev | sess | users |
|---|---|---|---|
| new | 443 | 443 | 431 |
| stored | 112 | 112 | 53 |

### `aspect` — 2 values (present on 126 sessions only)

| value | ev | sess | users |
|---|---|---|---|
| wide | 120 | 120 | 91 |
| square | 6 | 6 | 5 |

### `pointer` — 2 values (present on 126 sessions only)

| value | ev | sess | users |
|---|---|---|---|
| mouse | 120 | 120 | 90 |
| touch | 6 | 6 | 6 |

### `source` — 1 value (present on 26 sessions only)

| value | ev | sess | users |
|---|---|---|---|
| `ref:playgama.ai` | 26 | 26 | 24 |

### Reading the audience tables

- **Edge (268) outranks Chrome (228)**, and Windows is 452 of 555 (81.4%). This
  is not a normal web-game mix; it is what the paid Playgama sandbox campaign
  delivered. Nothing in this dataset describes an organic audience.
- **Desktop is 89.9% of sessions, and of the 126 sessions that report
  `pointer`, six are touch.** The mobile build was effectively not tested. Any
  claim about phone performance from this test is unsupported.
- `storage: new` 443 sessions / 431 users against `stored` 112 / 53. Derived:
  431 + 53 - 443 = **41 users who came back after a first session**, 9.3% of
  443. The other 12 "stored" users never registered a `new` session in range.
- `chromeos` 36 sessions over 18 users, two sessions each — a small, repeat-y
  pocket worth remembering if Chromebook traffic ever matters.

---

## What they did

### `screen_view.screen` — 9 values, 1,276 events

| value | ev | sess | users |
|---|---|---|---|
| playing | 514 | 392 | 329 |
| menu | 470 | 455 | 380 |
| paused | 140 | 101 | 88 |
| loadout | 54 | 30 | 27 |
| defeat | 48 | 37 | 36 |
| forge | 32 | 10 | 7 |
| store | 7 | 3 | 2 |
| victory | 7 | 4 | 3 |
| settings | 4 | 4 | 4 |

menu and playing are 984 of 1,276 (77%). `forge` reached 10 sessions and
**7 people**; `store` reached 2. Whole subsystems were built and then seen by
single-digit numbers of humans — which is the cheapest lesson in this archive.

### `run_start.character` — **1 value**

| value | ev | sess | users |
|---|---|---|---|
| `char_vanguard` | 436 | 394 | 330 |

Cardinality 1. Every run, by every player, with one hero.

### `run_start.chapter` — 5 values (present on 434 of 436)

| value | ev | sess | users |
|---|---|---|---|
| ember | 424 | 391 | 330 |
| frost | 4 | 3 | 2 |
| endless | 3 | 2 | 1 |
| blight | 2 | 1 | 1 |
| storm | 1 | 1 | 1 |

### `run_wait.art` — 2 values, 357 events

| value | ev | sess | users |
|---|---|---|---|
| pending | 335 | 335 | 260 |
| ready | 22 | 17 | 14 |

**93.8% of waits are waiting on art.** Of the whole archive this is the single
figure with the most direct fix attached to it.

### `first_input.kind` — 2 values, 199 events

| value | ev | sess | users |
|---|---|---|---|
| pointer | 166 | 166 | 159 |
| key | 33 | 33 | 32 |

### `first_input.screen` — 3 values, 199 events

| value | ev | sess | users |
|---|---|---|---|
| playing | 153 | 153 | 150 |
| menu | 40 | 40 | 38 |
| paused | 6 | 6 | 6 |

**153 of 199 first touches land inside a live run** (76.9%). The player's first
act happens in a dungeon that has already been running without them. Together
with `first_input.ms` p50 = 7,469 this is the entire case for the opening hold
shipped in `client/src/game/controllers/openingHold.ts`.

### `floor_reached.chapter` — 5 values (present on 136 of 137)

| value | ev | sess | users |
|---|---|---|---|
| ember | 98 | 48 | 47 |
| endless | 18 | 2 | 1 |
| frost | 8 | 2 | 2 |
| blight | 8 | 1 | 1 |
| storm | 4 | 1 | 1 |

38 of 136 floor-reached events (28%) come from **four people** playing modes
nobody else saw. Strip them and ember's real depth is 98 floors over 48
sessions.

### `run_end.outcome` — 3 values, 76 events

| value | ev | sess | users |
|---|---|---|---|
| loss | 48 | 37 | 36 |
| abandon | 21 | 20 | 19 |
| win | 7 | 4 | 3 |

Seven wins, by three people, in nine days.

### `run_end.chapter` — 5 values (present on 75 of 76)

| value | ev | sess | users |
|---|---|---|---|
| ember | 68 | 55 | 53 |
| frost | 3 | 2 | 2 |
| blight | 2 | 1 | 1 |
| endless | 1 | 1 | 1 |
| storm | 1 | 1 | 1 |

### `run_end.locale` — 7 values, 76 events

| value | ev | sess | users |
|---|---|---|---|
| en | 60 | 46 | 42 |
| es | 6 | 4 | 4 |
| it | 3 | 1 | 1 |
| fr | 2 | 2 | 2 |
| ru | 2 | 2 | 2 |
| de | 2 | 1 | 1 |
| zh | 1 | 1 | 1 |

### `run_death.killer` — 7 values, 32 events

| value | ev | sess | users |
|---|---|---|---|
| basic | 12 | 11 | 11 |
| emberling | 9 | 8 | 8 |
| brute | 5 | 5 | 5 |
| floater | 3 | 3 | 3 |
| galvanist | 1 | 1 | 1 |
| poison_status | 1 | 1 | 1 |
| ravager | 1 | 1 | 1 |

### `run_death.room` — 8 values, 32 events

| value | ev | sess | users |
|---|---|---|---|
| r2_alcove | 11 | 9 | 9 |
| r4_forge | 8 | 8 | 8 |
| r1_cell | 6 | 6 | 6 |
| r1_alcove | 2 | 2 | 2 |
| r3_gallery | 2 | 2 | 2 |
| r3_span | 1 | 1 | 1 |
| r6_crucible | 1 | 1 | 1 |
| r5_boss | 1 | 1 | 1 |

25 deaths out of 32 happen in `r1_*`, `r2_alcove` or `r4_forge` — the first
rooms of the launch arena. 32 events is below the reliability floor, so read
this as a direction, not a rate.

### `performance_sample.q` — 3 values, 1,267 samples

| value | ev | sess | users |
|---|---|---|---|
| high | 756 | 146 | 138 |
| low | 316 | 58 | 57 |
| medium | 195 | 36 | 32 |

58 sessions (27%) spent time on the **low** quality tier. The ladder was doing
real work, not sitting at the top.

### `performance_sample.gl` — 2 values (present on 643 samples / 110 sessions)

| value | ev | sess | users |
|---|---|---|---|
| hardware | 639 | 108 | 103 |
| software | 4 | 2 | 2 |

Software rendering is two sessions. The frame-time tail in `03-` is not a
software-renderer artifact — it is hardware machines hitching.

---

## What this file does NOT contain

The tool returns `values` one field per call. The fields below were seen (their
cardinality is recorded in `03-`) but never expanded, and **once the game is
deleted they are unrecoverable**:

| event | field | card. |
|---|---|---|
| `run_start` | `locale` | 8 |
| `run_wait` | `locale` | 8 |
| `screen_view` | `build`, `locale` | 14, 8 |
| `first_input` | `build`, `locale` | 5, 8 |
| `floor_reached` | `build`, `locale` | 8, 5 |
| `run_death` | `build`, `locale` | 4, 6 |
| `active_time` | `build`, `locale` | 7, 4 |
| `ad_offer_shown` | `build`, `locale` | 4, 2 |
| `ad_completed` | `build`, `locale` | 3, 2 |
| `session_end` | `build`, `locale` | 1, 1 |

They were left out deliberately: `locale` is covered at population level by
`session_start.locale`, and per-event `build` splits below ~100 events cannot
carry a conclusion. Identifier-shaped fields (`install`, `session`) were also
left out — their cardinality equals their row count, so a distribution of them
is a list of ids, not information.

