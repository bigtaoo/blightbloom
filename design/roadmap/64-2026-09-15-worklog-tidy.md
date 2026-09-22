# Work log — 2026-09-15

Volume 64. See [`design/ROADMAP.md`](../ROADMAP.md) for the index and the phase spine.

## The work log stopped being one volume per pass (2026-09-15, docs only, no engine change)

*"tidy the docs"*, with nothing attached — so it was built as the mechanical checks first, and the
result shape is the finding again: every defect was in the INDEX and in the volume boundaries,
and not one was a wrong description of what the code does. `check:docpaths` and
`check:filelength` were both green before this pass started and are green after it.

### Volume 55 had quietly become nine passes

`55-2026-09-11-door-ellipse-aspect.md` was **1,346 lines** holding **nine** `##` passes across
five days, with a title (`Work log — 2026-09-11 → 09-14`) that named neither the range it
actually covered nor eight of the passes in it. The convention it drifted from is written down
twice — "past ~1000 lines, start the next number", and the one-pass-per-volume form the volumes
have followed since 25 (a couple carry two halves of a single day, and nothing carries more than
two) — and nothing enforces either, so each pass appended to the file that was already open
rather than taking the next number.

The index had been kept honest the whole time, which is why it went unnoticed: `ROADMAP.md`
carried **nine** separate by-date volume headers, all nine pointing at the same file. That reads
correctly and it is what a split has to preserve.

Split into **55–63**, one pass each, 93–227 lines:

| | |
| --- | --- |
| `55-…-door-ellipse-aspect` | a door's halo runs the way the door does (09-11) |
| `56-…-chests` | chests, and the id that retuned a floor (09-14) |
| `57-…-kill-table` | the kill table stops paying in guns (09-14) |
| `58-…-room-types` | rooms that are a search, not a fight (09-14) |
| `59-…-shop-npc` | somebody is standing behind the counter (09-14) |
| `60-…-pickup-flight` | loot that arrives on you (09-15) |
| `61-…-dedicated-box` | the backend gets hardware of its own (09-15) |
| `62-…-chest-interact` | the chest nobody could open (09-15) |
| `63-…-borrowed-box-cleanup` | leaving a borrowed box is a second job (09-15) |

53 links in `ROADMAP.md` were rewritten by mapping each one's **anchor** to the volume that now
owns that heading, so no anchor changed and no link text moved. The one reference from outside
(`rendering/04-doors.md`) points at the door-ellipse pass, which kept its file.

**The part a mechanical split cannot do is the prose that counts sections.** Four sentences
referred across what had become a file boundary — *"the content half the two passes above kept
deferring"*, *"the last open question the pass above left"*, *"is written four sections up in
this same volume"*, *"this volume argued four sections ago"* — and each was rewritten to name the
volume (56, 57, 58, 61). They are invisible to a link checker, because they are not links. The
three *intra*-pass ones (`### The nine claims that shipped unpinned` counting back to its own
subsections) were left alone: they still resolve inside their own volume.

### The split corrupted two bytes, and the memory's own advice is what did it

Caught by the control, not by review: concatenate the nine new files' bodies, drop blank lines,
and diff against the original's — 1,105 lines against 1,105, with exactly the four intended
cross-reference rewrites differing. The first run of that check said **1,107 against 1,105**.

`design/roadmap/55` contained **two lone `
` bytes**, both inside code spans in its last pass —
``tr -d '<CR>' < f | ssh host 'cat > f'`` and ``$'<CR>': command not found``, a section that is
*about* CRLF damage. Python's text mode is universal-newline: it turns a bare CR into `
` on
read, so the split silently broke each of those lines in two and lost the byte the sentence was
about. The doc-conventions memory says "strip `
` on read" — correct for the CRLF checkout this
repo produces, and exactly what destroys a CR that is CONTENT. Read a doc as **bytes** and strip
only `
` when a script is going to write the file back; strip every `
` only when the result
is thrown away (a count, a regex match).

The generalisable half: **a read-modify-write over prose needs a whole-corpus control**, and
"same non-blank line count, and here is every differing line" is cheap enough to run on every
such pass. A link checker reports this file as perfect; it is 2 bytes wrong in a paragraph whose
subject is those 2 bytes.

### Volume 36 had landed six theme entries and zero date entries

The (k) drift from the memory, seen from the other side — that entry records a volume landing its
by-date half and never its by-theme half. `36-2026-09-05-floor-loot-cards.md` did the reverse:
both of its passes were filed under `engine`, `content`, `test`, `ui` and `i18n`, and **neither
appeared in the by-date log at all**, so the only two `ENGINE_VERSION` 57/58 bumps in the project
were unreachable by the index view that is in date order. It had stood ten days.

Nothing can catch this. `check:docpaths` skips `ROADMAP.md` as history, no logic gate counts
entries, and the two halves are never cross-checked — the volume file was linked from six places,
so even a link sweep reports it as referenced. The check that finds it is per-file: **for every
`##` heading in every volume, is there a by-date bullet whose anchor is that heading's slug.**

Both entries were restored, written from the volume's own text rather than summarised from the
code (the allowance's three parts and the PRNG-draw-count degradation; the vote-is-state rule and
the tally-of-0 hold). That moved the by-date total 159 → **161**.

### The by-theme index had ~40 KB of the by-date index pasted into it

Nine entries — volumes 47, 48 and 49, three theme slots each — carried their entire by-date
paragraph instead of a bare link. The memory measured this on 2026-09-09 (351 of 360 bare, nine
not) and named the convention: **the summary lives in the by-date entry, theme entries are bare
links.** Trimmed, in a file that is an index precisely because the log got too big to read.

### Four smaller things, all of them the shapes already written down

- **The stated total was one behind** — *"The same 158 entries"* against 159 real by-date bullets,
  before volume 36's two were restored. Re-derived from the list, not incremented, which is what
  makes the arithmetic self-heal.
- **All fourteen per-tag counters were correct** and are still correct after the theme entries
  were trimmed (nothing was added or removed, only shortened). Worth stating: the memory warns
  about counter drift, and the counters were not where the drift was this time.
- **Two tag headers had lost the blank line above them**, plus one stray blank inside a block —
  the append artifact that eats a separator and then makes the *next* append land in the wrong
  section. Normalised, and asserted: a blank line precedes every tag header.
- **One broken anchor in 365+.** `design/01`'s door list cited
  `#…-2026-09-03d-client-only-no-engine-bump` where the heading is `(2026-09-03d)` — a suffix
  that was never part of the slug. Every other relative link and heading anchor under `design/`
  resolves.

### Named gaps

- **`design/05-gameplay.md` (1,190 lines) and `design/19-server-platform.md` (1,039) are over the
  1,000-line ceiling** the 2026-08-31 split established for this doc set; `ROADMAP.md` itself is
  1,824 and growing by two index lines a pass. Not touched here: `design/05` is cited by 192
  source files and splitting it wants the `01-rendering.md` treatment (a thematic split behind an
  index that keeps every section title reachable in one hop), which is its own pass.
- **Nothing gates any of this.** The checks in this pass are a script in a scratchpad, not a gate.
  The per-volume "is every `##` heading indexed by date" check is the one worth making permanent —
  it is the only one that found a defect a reader could not have seen, and unlike a counter it has
  no false-positive class beyond a volume's non-pass `##` sections (`Numbers`, `After`,
  `Still open`), which a date-in-the-heading test filters exactly.
