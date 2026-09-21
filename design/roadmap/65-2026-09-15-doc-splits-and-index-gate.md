# Work log — 2026-09-15

Volume 65. See [`design/ROADMAP.md`](../ROADMAP.md) for the index and the phase spine.

## The two docs over the ceiling, and the index check becomes a gate (2026-09-15, docs + build, no engine change)

Volume 64 ended with two named gaps and *"两个没做的也都做了"* is the whole prompt. Both are closed
here: `design/05` and `design/19` are split behind indexes, and the per-volume *"is every dated
`##` heading indexed by date"* check is `build/checkRoadmapIndex.mjs`, in `npm run check`.

### `design/05-gameplay.md`: 1,190 lines → a 158-line index and three parts

Thematic, following `01-rendering.md`'s precedent rather than the log's by-date one, because a
decision doc is grouped by subject already:

| | |
| --- | --- |
| [`gameplay/01-the-run-and-its-rooms.md`](../gameplay/01-the-run-and-its-rooms.md) | 610 lines — the loop, floor assembly, the room & door model, and every pass that retuned the shape of a fight |
| [`gameplay/02-what-a-floor-hands-you.md`](../gameplay/02-what-a-floor-hands-you.md) | 395 — survivability, pickups, chest rooms, the loot economy, shops, floor cards |
| [`gameplay/03-weapon-energy-and-melee-mobs.md`](../gameplay/03-weapon-energy-and-melee-mobs.md) | 101 — the cost side of firing, and the roster change that had to land with it |

**What stays in the index is the interesting decision.** The locked-decisions list stays, as the
part of the doc a reader meets first. So do the six short cross-mode sections at the bottom (PvP,
the economy table, parry positioning, controls, the doc relationships, To design, Open questions):
each is a summary whose full form lives in `15`/`03`/`10`, so filing them under a part would put a
pointer inside a pointer.

**And a map of headings would not have been enough.** 192 source files cite this doc, and the
citation style is `design/05 "Section title"` — but the single most-cited title,
**`design/05 "Only the boss floor ends a run"` (~20 comments), is a BOLD BULLET inside `## Core
loop`, not a heading at all.** A heading-only map sends every one of those readers to the index and
stops. It is named in the map explicitly now, with the one other bullet code cites the same way
("An unfinished single-player run can be saved and continued"). The lesson generalises past this
doc: **before splitting, grep how the code actually cites it**, because the citation vocabulary is
not always the heading vocabulary.

**Ten cross-file references.** `"Chest rooms" below`, `what "Survivability model" below says`,
`the "Room encounter budget" pass below`, `("Only the boss floor ends a run", above)`,
`see the co-op wipe decision in Open questions` — sentences that were true while this was one file
and became silently wrong the moment it was three. Each now names its part as a link. They are
invisible to every checker in this repo because they are prose, not links; the sweep that finds
them is `grep -noE '"[^"]{4,60}" (above|below)'` plus a title→file map, run before finishing.

### `design/19-server-platform.md`: 1,039 lines → a 257-line index and four parts

The same job with a different address space: code cites this doc by **section number**
(`design/19 §4`, `design/19 §7, ROADMAP 8.5`), so the map is keyed by number and the numbers become
a contract — the index says outright that a section is never renumbered and a new one takes the
next free number.

| | |
| --- | --- |
| [`serverplatform/01-the-planes-and-the-trust-seam.md`](../serverplatform/01-the-planes-and-the-trust-seam.md) | §1–§3, 268 lines |
| [`serverplatform/02-billing.md`](../serverplatform/02-billing.md) | §4–§5, 199 |
| [`serverplatform/03-topology-and-operations.md`](../serverplatform/03-topology-and-operations.md) | §6–§7, 219 |
| [`serverplatform/04-observability.md`](../serverplatform/04-observability.md) | §10, 169 |

§8 (*Deliberately not built*) and §9 (*Open questions*) stay in the index — 150 lines, the doc's
live scheduling surface and the shortest thing anyone comes here for. The consequence is that §10
sits in a part *below* two sections that are in the index, which the map says plainly; keeping
numeric order at the cost of moving the open questions out of reach would have been the wrong
trade.

One real defect fell out: a part is one directory deeper than the doc was, so the body's one
relative link — to `roadmap/33-2026-09-05-ladder-mode-gate.md` — stopped resolving and needed a
`../`. That one the link checker did catch, and it is the *only* relative link in either doc's
body, which is why the ten prose references above matter more than it does.

### The control said 1,033/1,033 and 905/905

Volume 64's lesson, applied as the first thing rather than the last: concatenate the parts' bodies
plus whatever stayed in the index, drop blank lines, compare to the original and print every
differing line. `design/05` came back **1,033 against 1,033 with 0 differences** before the
cross-reference rewrites, `design/19` **905 against 905 with 1** (the `../roadmap/` fix). Both
files were read as bytes with only `\r\n` normalised, so a lone CR would have survived.

### `build/checkRoadmapIndex.mjs` — six rules, no allowlist

`indexed` is the one volume 36 needed: for every `## ` heading in a numbered volume that carries a
date, is there a by-date bullet whose link anchor is that heading's slug? Five more ride along,
each a drift the log has actually suffered — every roadmap link names a real volume and a real
heading; the *"same N entries"* total equals the by-date count; each `*(N)*` equals the bullets
under it; a by-theme entry is a bare link; a blank line precedes every tag header.

**The date filter is what made it gateable.** `checkDocPaths` needed a 26-entry allowlist to get
its false-positive rate down. Here, requiring `(20NN-NN-NN` in the heading separates a pass from a
volume's structural sections (`Numbers`, `After`, `Still open`) **exactly** — 157 dated sections,
zero exemptions. When a sweep's noise looks fatal, the fix is usually a sharper definition of the
thing being checked, not a list of things to ignore.

**The evidence is not the green run.** Over the tree at `563d25b` — the commit before volume 64's
tidy — it reports **14 violations**: volume 36's two missing by-date entries, the total that was
one behind, nine by-theme entries carrying their whole by-date paragraph, and two tag headers
whose blank line an append had eaten. Every one had been found by hand the day before. That is not
a test (CI checks out shallow, so `git show` of an old commit is unavailable there), but it is
what the test file records as the reason to believe the gate.

`build/checkRoadmapIndex.test.mjs` — 16 tests: the real repo as the control **plus an explicit
scope-is-not-empty assertion**, a fixture asserted clean so every failure below is the rule and not
the fixture, one synthetic violation per rule, a passing case for a volume gaining an undated
structural section, and the slug function against the three shapes this log produces (an
apostrophe dropped, a doubled hyphen where `✅` was, and a CJK heading kept).

Wired into `npm run check` after `check:docpaths`, and into the root `test` script.
`design/README.md` and `ROADMAP.md`'s *Appending to the log* were rewritten to match: rule 1 used
to say **"a new pass goes at the end of the highest-numbered volume"**, which is precisely the
instruction that produced volume 55, and now says a pass gets its own volume and how to find the
next free number across branches.

**And it caught me violating its sibling's rule while writing it**, the same way `checkDocPaths`
did on its own first run in 2026-09-03: citing `build/checkRoadmapIndex.mjs` in `design/18` failed
that gate until the file was `git add`ed. Two for two — a gate's first real user is the pass that
adds it.

### Named gaps

- **`design/rendering/03-occlusion-and-doors.md` is 1,046 lines**, found by this pass's own
  `wc -l` and not by volume 64. Its boundary is obvious (the x-ray, 333 lines; nine door sections,
  713) but the split is not free: `rendering/` is numbered thematically, so an honest
  `03-occlusion` + `04-doors` renumbers `04-floor-arena-void` → `05` and
  `05-character-and-objects` → `06`, which touches ~25 links across `README.md`,
  `design/01-rendering.md`, `design/README.md` and three roadmap volumes. Mechanical, but its own
  pass, and deliberately not bolted onto this one.
  > **Closed 2026-09-21** — done exactly as described, in the tidy pass of
  > [volume 77](77-2026-09-21-doc-tidy.md): `03-occlusion.md` (334) + `04-doors.md` (723), with
  > `04-floor-arena-void` → `05` and `05-character-and-objects` → `06`. The one thing the plan did
  > not predict is that the same sweep found `design/01`'s map missing a whole `##` section (the
  > 2026-09-11 door halo) and thirteen `###` subsections, against a doc that says outright it
  > carries every one.
- **`design/ROADMAP.md` is ~1,850 lines and grows by two index lines per pass** — structural, not
  drift, since it is the index. The eventual answer is moving the two log indexes into
  `roadmap/index-by-date.md` / `index-by-theme.md` and leaving the phase spine here, which is
  where ~40 `ROADMAP 3.1`-style comments land. Not yet worth the churn.
- **What the gate cannot do**, stated so nobody reads green as more than it is: it is arithmetic
  and anchors. It cannot tell whether an entry is filed under the RIGHT tag — volume 43 filed two
  entries into `audio` and `tools`, blocks it had nothing to do with, with every counter it
  touched correct — and it says nothing about whether a summary is true.
