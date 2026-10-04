# Work log — 2026-10-03

Volume 120. See [`design/ROADMAP.md`](../ROADMAP.md) for the index and the phase spine.

## The minimap marks where to go next (2026-10-03, client + ui + test + docs, no engine change)

The owner's report: unexplored rooms did not read as different on the PvE minimap, so they often
did not know which room to head for next; the boss room, the way down, shops and chests should be
marked too. Before this pass a cleared room and an unexplored one were two dark slates
(`0x2a3140` / `0x384258`) nobody could separate at HUD size.

- **Three PvE statuses that read apart at a glance** (`ui/minimapLayout.ts`, `ui/Minimap.ts`
  `STATUS_STYLE`). `dungeonRoomStatus` now takes the floor's doors and returns `cleared` (lit
  fill), `frontier` (never entered, one door from a room that has been: dark with a bright
  outline), `danger` (in combat) or `unvisited` (dark, dim outline). PvP's `safe`/`closing`/
  `danger` are untouched — cleared is its own bucket so the arena is not repainted. No pulsing on
  the frontier: the owner is motion-sensitive, and a static contrast step answers "where now".
- **Room markers** (`dungeonRoomMarkers`, a new markers layer under the player dots). One glyph
  per room, priority boss > exit > shop > chest. The exit is `role: 'extraction'` or the last
  placed room, the same index `ExtractionSystem` gates on; the last floor's boss room is marked
  as the boss. An opened chest and a sold-out shop lose their marker. A room big enough puts the
  glyph in its top-right corner, clear of the centred dot; a small one centres it under the dot.
  The boss glyph is a horned crown, not a skull — the skull is POISON's locked glyph (design/13).
- **Redraw only on change**, as the other layers already did: the markers layer is flattened and
  compared like the rooms and dots.
- **Tests.** Unit tests on hand-made rooms for every status and marker rule, the Pixi widget's
  layers, corner/centre placement at the shipped room size (~24 px), and redraw-on-change.
  `HudView.test.ts` pins the wiring — that the HUD hands the minimap the doors and the markers;
  removing either was tried and turned it red. `minimapMarkers.content.test.ts` sweeps all eight
  maps level 1 can draw (five floors plus the three branch variants) through the real engine:
  only the capstone carries the exit (boss on the last floor), and every chest and shop
  `SpawnSystem` places is marked on its own drawn room.

### Found by the content sweep

Floor 3's vault (`ember_l1_vault`) holds both the big chest and the run's second shop counter.
One room shows one marker, so it reads shop while the counter has stock, then chest, then
nothing. That is pinned as intended (a room with something left to take stays marked); flipping
it to chest-first is one line in `dungeonRoomMarkers` if the owner prefers.

### Still open

- Coverage (`npm run coverage`) was not run for this pass; `npm run check` was green.
- None of this has been looked at on a handset, where the minimap is smallest.
