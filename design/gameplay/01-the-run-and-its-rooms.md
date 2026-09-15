# The PvE run, and the rooms it is made of

Part 1 of the gameplay doc (index: [`design/05-gameplay.md`](../05-gameplay.md)). The run's
structure and its space: the loop itself, how a floor is assembled, what a room and a door are,
and every pass that retuned the shape of a fight.

## Core loop (PvE search-fight-extract run)

One run, floor-based push-your-luck:

```
Loadout (bring up to 2 weapons; every free slot filled by kind — a run always carries a gun + a melee weapon)
   → enter floor 1 (seeded)
      → work through (some of) its rooms — not all of them are fights:
         · combat rooms: kill, pick up materials, coins, buffs and supplies
           (never a weapon — since 2026-09-14 a kill cannot drop one)
         · chest rooms: open a small chest solo, or a big chest with the
           whole party standing on its mechanisms
         · a shop counter: spend this run's coins on a weapon, a buff or a supply
      → reach this floor's EXTRACTION ROOM
         → DESCEND (materials so far are locked into the carry-out bag — deeper
           = better; the bag is still forfeited whole by a later death)
         (…or SAVE & QUIT from the pause menu, and CONTINUE the run another day)
   → repeat for ~5 floors; the last floor's boss room IS its extraction room
      (portal opens only after the boss dies — and this is the ONLY floor whose
       portal offers EXTRACT, i.e. the only way a run ends with its materials)
   → run ends (extracted / dead)
      → all weapons wiped; banked materials kept; meta advances via forging
   → back to loadout
```

- **Weapons are FOUND, and all of it is ephemeral.** Since 2026-09-14 a kill never drops one:
  a run's weapons come from a chest, from the boss, or from a shop counter ("Weapons are found,
  not dropped", below). The kit you build this run — a better weapon (higher rarity, or a frame×element that counters the room, `03`) plus **run-scoped buffs** (the in-run power layer, Soul-Knight style; there are no weapon affixes, `14`) — is wiped at run end. This is `06`'s "in-run resources/drops are engine state, wiped each match."
- **Materials are the only carry-out**, and the deeper you go the better they get. Coins are
  the in-run currency a shop spends and are wiped with everything else (below); nothing turns
  one into account value. Weapon *finds* stay random at every depth — depth buys material quality, not guaranteed weapons.
- **Only the boss floor ends a run.** ✅ **Changed 2026-09-10, `ENGINE_VERSION` 61.** A floor's checkpoint used to offer a real two-way choice — **extract** (end the run, keep everything) or **descend** — and the extract half is gone on every floor but the last. An interior checkpoint now offers descend and nothing else; the boss floor offers extract and nothing else. `ExtractionSystem` ignores whichever button the floor does not offer, and `PortalPrompt` draws only the one it does, so the two ends of the decision cannot disagree.

  What that costs, stated plainly: **materials can no longer be banked without beating the boss.** Descending still folds this floor's buffer into the run's carry-out bag, and that bag is *still* forfeited whole by a death (the locked wipe rule above) — so the bag is now at risk for the entire run rather than up to the next checkpoint. The carry-out became the boss's reward instead of a per-floor withdrawal.

  **Why the option went away rather than being retuned.** The push-your-luck pillar was carried entirely by this choice, and the choice was doing two jobs at once. A player who wanted to *stop playing for the evening* had to spend the run's whole carry-out decision to do it, because quitting from the pause menu forfeits everything — so the early bank was also the save button, and it was the worse of the two things it was being used for. Splitting them is what this version is: the run's only exit is the boss, and an unfinished single-player run is **saved and resumed** instead (below). "Leave with what I have" became "come back to it".

- **An unfinished single-player run can be saved and continued.** ✅ **Shipped 2026-09-10** (`client/src/game/match/runSave.ts` + `runSaveStore.ts`, the other half of the decision above). SAVE & QUIT on the pause menu keeps the run; CONTINUE RUN in the forge resumes it. Plain QUIT still forfeits it, and the two are separate buttons on purpose.

  **A save is a seed, a command stream and an `ENGINE_VERSION` — no state at all.** That is the same property `06`/`08` already build replay on: a fresh engine on the same seed, fed the same inputs, reconstructs every frame bit-for-bit, so resuming is "replay the recording, then keep playing". A save therefore cannot desync from the sim, because there is no second description of the sim for it to disagree with — which a field-per-field snapshot would have been, going stale silently on every version that added a field.

  Two things can invalidate one, and each is refused rather than replayed. **`ENGINE_VERSION` mismatch** — the sim's arithmetic moved, so the same inputs no longer describe the same run (`08`'s "fail loud, never replay garbage", applied to a save instead of a recording). **Content drift** — the floor library was edited under the save, which `ENGINE_VERSION` does not cover at all; the run config is rebuilt from today's content on resume and its content half is fingerprinted, so an edited level is a refusal rather than a player spawned inside a wall. Either way the save is dropped and the button goes away.

  Scope, and the reason for each exclusion: **single-player, offline, real dungeon runs only.** An online run's authoritative stream is the server's, not this client's. A co-op run's second seat is generated by the bot ally at submit time and is not in the recorded stream, so replaying the stream alone would not reproduce it. The tutorial is a flat level whose quit already means "skip". One slot, replaced rather than accumulated — starting a fresh run discards it, and so does winning, dying, or quitting.

- **You need not clear a floor** — *design intent, not shipped behaviour (`ROADMAP` B3, filed 2026-09-03).* How many rooms you can skip is meant to depend on where that floor's extraction room sits: an extraction room mid-floor lets you leave one or two rooms unfought, a natural "greed for the last chest vs. leave safe" micro-decision. *(This micro-decision survived the 2026-09-10 change above: it is about how much of a floor you fight through before descending, not about whether you may leave the RUN there.)* **Today the number of skippable rooms on the way down is still zero** — the 2026-09-14 side rooms
are dead ends, so a player may skip one, but skipping it routes around no garrison and shortens no
path to the capstone — for two reasons that each suffice on their own: the capstone is always the LAST room of a floor (`generateFloor` appends it; `placeAuthoredFloor` and the editor's save gate require it at `rooms[last]`), and a room's doors lock as a unit while it holds a live enemy — so on a chain floor every room between spawn and capstone has to be cleared to walk through it. Level 1's floors are chains with no alternate route (see "Open, deliberately left for editor tuning" below). Fixing this needs both halves: a capstone that may sit at an interior index, *and* a floor with a genuine bypass.
- **Floor count is tentatively 5**, each with **5–10 rooms**; the deepest floor's challenge is a boss whose room doubles as the final extraction (portal after the kill). Exact counts are to-tune (below).
- **Co-op:** same run, cooperative, latency-tolerant, AI-only threat. Starts single-player on `LocalInputSource` to validate feel, then the same `NetInputSource` broadcast for co-op (`06`). Enemy/boss AI runs inside the deterministic engine off injected PRNG, identical on every client. **Downed teammates can be revived** — a free, ~15 s stationary channel by another player (`07`/`08` interaction); revive/team-wipe edge rules in open questions. **Outside combat, squadmates need not share a room** — a floor's rooms are co-resident (below), so the party can split up to loot/scout different rooms in parallel; entering combat instantly regroups everyone into the triggering room (below).

### Dungeon generation

- **Hybrid: hand-authored room pieces stitched by a seeded procedural layout.** Reuse funny's PRNG roomgen for the layout/selection; keep encounter quality controlled by curating the room pieces. Standard roguelite answer — full-procedural risks uneven quality, fully hand-built kills replayability. The per-floor **extraction room** is one of the placed pieces, and its position within the floor is what gates how many rooms are skippable.
- Generation is driven by an **injected `Prng` seeded per run** (`06`), so a run is fully reproducible from `seed + input stream` (needed for co-op determinism and headless re-judge).
- ✅ **Selection shipped 2026-07-24 (ROADMAP 1.3, `09`):** `world/dungeon.ts generateFloor` draws a floor's room count + normal-piece sequence from `roomgenPrng`, always ending in the floor's extraction/boss capstone. Placing a generated floor into a live, traversable run (the room-to-room "which rooms are skippable" experience this bullet describes) is 1.4/1.5.

### Room & door model (locked 2026-08-04)

Supersedes `09`'s "automatic teleport to the next room's spawn, never walk through a door" note: a floor's rooms are now a real door graph, not a strict single-room sequence.

✅ **Engine shipped 2026-08-04 (`ENGINE_VERSION` 34, see `09` for the schema):** everything below is live — `world/dungeon.ts` `placeFloor`/`carveDoorGaps`/`buildFloorGeometry` place a generated floor's rooms along a west→east spine (the MVP placement shape; a real 2D graph layout stays a follow-up) and stitch them into one co-resident world; the new `DoorSystem` (step 11.5) owns activation, lock/unlock, and force-regroup.

✅ **Client rendering shipped 2026-08-04 (same-day follow-up):** `HudView.ts`'s floor/room
line was fixed first (reads `roomId` via `dungeonRoomIndexById`, no more single global
"current room"). The actual scene render followed: `RoomBuilder` already drew a whole
floor's stitched geometry in one pass (camera-cull did the rest, see the corrected bullet
below), so the real gap was doors — they now render as a real fixture per
`state.dungeonDoors` entry (`art/environment/door_{locked,open}_raw.png`, loaded via
`render/environmentSprites.ts`), excluded from the generic wall fill by reference identity,
leaf-swappable in place on `door_locked`/`door_unlocked` (no full room rebuild).
**Standing since 2026-08-20** (`scene/doorRender.ts`): those two files are front elevations and
were being laid flat on `layers.ground`, so a door was the only thing left in the room painted on
the floor. A door is now built as a wall block whose face is an opening — cap continuous with the
runs either side, the leaf standing in that opening at the height of the wall it is cut into, and
the whole fixture registered with the occlusion x-ray like any other standing block. See
`01-rendering.md` "A door is a wall block whose face is an opening".
`EventReactor` also reacts to `force_regroup` (`Scene.player.snap()` so the camera cuts to
the teleport instead of panning).

✅ **Fully-realized branching shipped 2026-08-05 (`ENGINE_VERSION` 35):** `layout:'branching'`
no longer resolves its candidate at generation time via a wraparound-offset PRNG perturbation
(the scope cut both passes above deferred) — a `'branching'` floor now gets **one real
fork-and-reconverge diamond**: `world/dungeon.ts generateFloor` draws which interior
normal-stage transition forks (never the very first room, so spawn stays a single ordinary
room), then resolves that stage to `branchFactor` DISTINCT, same-width sibling `RoomPiece`s
(clamped to however many the pool actually offers — a graceful degrade to a plain single room,
not a throw, when the pool has no same-width match). `placeFloor` places those siblings
**side-by-side** (same X, stacked in Y with a gap, centered on the fork point's own vertical
center) directly east of the fork-point room, and connects each sibling's own door onward
into the very next stage's room (an ordinary room or the capstone) — the reconvergence, with
no separate merge-room concept needed in the data model. This is a real walk-through-the-door
choice now: both siblings are real, simultaneously-live `PlacedRoom`s with their own
`DoorRuntime`/combat-lock/force-regroup state, exercised through the unmodified `DoorSystem`/
`RoomBuilder`/`EventReactor` (all already topology-agnostic — this pass needed zero client
changes). Deliberate scope cuts, not data-model limits (`Door`/`PlacedRoom` already support an
arbitrary graph, same as PvP's `ArenaMap`): only one fork per floor (no fork-into-fork
chaining), and a fork's siblings must share their pool piece's exact width (so their shared
east boundary lines up with one merge-room X, reusing `pickDoorAnchor`'s existing adjacency
assumption unmodified). No shipped content used `'branching'` at the time this shipped
(`EMBER_DUNGEON` was `'linear'`) — authoring same-width `EMBER_ROOMS` variants to make a fork
visible in the shipped biome was left as a content task. **Update, 2026-08-05 same day, "graph2d
content" pass below:** `EMBER_DUNGEON` switched to `'graph2d'` instead, so `'branching'` still
stays unused by this config — see that pass's own note on why (`ember_atrium`'s deliberately
unique width). The known side effect it
introduced — the client's `FloorProgress` HUD track computed done/current/upcoming purely
from `dungeonRooms` array index, which wasn't meaningful once a floor has siblings — is
resolved by the minimap adapter below, same-day.

✅ **PvE minimap adapter shipped 2026-08-05 (same-day follow-up):** `FloorProgress`/
`floorProgressMath.ts` are deleted — PvE now shares the exact same `Minimap` widget PvP
already had (`client/src/game/ui/Minimap.ts`), via two new pure functions in
`minimapLayout.ts`: `dungeonToArenaMap` converts `PlacedRoom[]`/`DoorRuntime[]` into the
same `ArenaMap` shape `computeMinimapLayout` already consumes (`Door` needs no remapping —
it's the same type PvP uses; room offsets are normalized to a non-negative origin, since a
fork's siblings can have negative `offsetYGrid`), and `dungeonRoomStatus` extends the
existing `safe`/`closing`/`danger` tint with a new `unvisited` bucket — exactly the state an
untaken fork sibling needs, closing the `FloorProgress` gap named above rather than just
working around it. `Minimap.update()` no longer hardcodes PvP's zone semantics: it takes a
`statusOf` resolver the caller supplies, so the one Pixi widget stays mode-agnostic. Also
shows other online players' rooms in PvE now (reusing `Minimap`'s existing player-dot
rendering as-is), which `FloorProgress` never could (it only ever showed the local
player's own linear position). No engine changes, no `ENGINE_VERSION` bump — purely a
client-side adapter over data the engine already exposed.

✅ **Real 2D graph layout shipped 2026-08-05 (ROADMAP "real 2D graph layout"
follow-up, additive, no `ENGINE_VERSION` bump):** closes the one remaining
scope cut the 2026-08-04 engine bullet named above — a *generated* (not
hand-authored) floor is no longer forced onto a west→east spine. A new third
`DungeonConfig.layout: 'graph2d'` (alongside `'linear'`/`'branching'`) pairs
`generateFloor`'s UNCHANGED stage-selection stream (it never forks, so every
stage stays a plain `RoomPiece`, matching `'linear'`'s own selection exactly)
with a new `world/dungeon.ts placeFloorGraph2d` — a sibling to `placeFloor`,
not a variant of it, same precedent as `placeAuthoredFloor`. Each transition
walks out of whichever of the previous room's exits is both unconsumed (not
the one already used entering it) and has a matching opposite exit on the next
piece; `roomgenPrng` draws a direction only when more than one is viable (the
same "only draw when it matters" discipline `combatPrng`'s crit draw already
established) — so a west/east-only content pool places exactly like `'linear'`'s
own spine for every stage after the first, and only a piece with a free
north/south exit (or an ambiguous first room) actually lets the floor bend.
Throws (fail loud, design/09) if a placement would overlap an earlier room —
a real risk once placement can walk in any of 4 directions, unlike
`placeFloor`'s single-axis spine where it structurally cannot happen; this
module does not try to auto-avoid it, same "curated content, not a solver"
contract `placeFloor` itself already assumes. No shipped `DungeonConfig` used
`'graph2d'` at the time this shipped (`EMBER_DUNGEON` was `'linear'`) — authoring
content with real north/south exits to make a shipped biome actually bend was
left as a content task, same "no shipped content exercises it yet" note
`'branching'` and hand-authored floors both shipped with. **Update, 2026-08-05
same day, "graph2d content" pass below: `EMBER_DUNGEON` now IS `'graph2d'`,
closing this gap.** 16 new tests
(`dungeon.test.ts`'s `placeFloorGraph2d`/graph2d-`generateFloor` unit
coverage + a `dungeonrun.test.ts` end-to-end integration block).

**"加测试" follow-up, same day:** closed the coverage gaps a first pass left —
`entranceFromDoor`'s reuse inside `placeFloorGraph2d` itself (not just
`placeAuthoredFloor`, which already covered the function directly) now has
dedicated east/west AND north/south assertions, plus the spawn room's own
inset/size-half fallback when it authors no player spawn; a door-anchor
"not pinned to one position" spread check (`placeFloor`'s own existing
convention) now has a `graph2d` counterpart for both an east- and a
south-going connection; a `roomA`/`roomB` chain-order assertion across a
3-room stretch; and — closing the sharpest gap, since the module doc's own
central claim is "a direction is drawn ONLY when more than one exit is
viable" — a `CountingPrng` test subclass that asserts the EXACT draw count
per door (1 when only one direction is viable, 2 when a real choice exists),
not just that the output varies. `dungeonrun.test.ts` also gained a
forced, seed-independent SOUTH-bending floor (every other dungeon fixture in
that file only ever produces an east-going/vertical door) to prove
`buildFloorGeometry`'s carving and `DoorSystem` activation genuinely handle a
horizontal (north/south-wall) door end-to-end, not just in the pure
placement-function tests above. 8 new tests (6 `dungeon.test.ts` + 2
`dungeonrun.test.ts`) — 1647 total across all 7 workspaces, `tsc --noEmit`
clean.

✅ **"graph2d content" pass shipped 2026-08-05 (same day, additive, no `ENGINE_VERSION`
bump):** closes the "no shipped content exercises it yet" gap both the branching and
graph2d bullets above left open — `EMBER_DUNGEON.layout` switches from `'linear'` to
`'graph2d'`, so a generated Ember floor can now genuinely bend north/south, not just walk
a west→east spine. `world/rooms/ember.ts` gained a 5th normal piece, `ember_atrium` (a
fully open room, all 4 exits, deliberately a unique width so `'branching'` still stays
unused by this config — only same-width normal pieces are fork-eligible), and
`ember_pillars` gained `north`+`south` on top of its existing `west`+`east` — alongside
the pre-existing all-4-exit `ember_cross`, that's 3 of 5 normal pieces now able to bend a
floor. `generateFloor`'s stage-selection stream is unchanged (module doc,
`world/dungeon.ts`), so no past seed's room SEQUENCE changes — only placement.

Two real bugs surfaced by testing, not inspection, both now fixed (full account in
`world/rooms/ember.ts`'s own module doc): (1) a **dead end** — the spawn room's
undocumented freedom to walk `'west'` (module doc above) could exhaust a plain
west/east piece's only remaining exit before it ever reached the original `west`-only
capstone, which had no `east` to receive it; fixed by giving `ember_extraction`/
`ember_boss` `east` too. (2) Once (1) was fixed and a 3-room floor became reachable, a
**fold-back overlap** — `ember_boss` (22×18, the pool's largest piece) connecting via
`west` or `east` centers on the previous room's centerline and can overhang past it into
whatever sits on the OTHER side; fixed by giving both capstones full 4-exit symmetry AND
a new engine-side **direction-retry** in `placeFloorGraph2d` (`world/dungeon.ts`): when
the drawn direction's placement would overlap an already-placed room, it now falls back
through every OTHER viable direction (fixed order, no extra PRNG draw) before giving up —
strictly reactive (only ever checks rooms already placed, never looks ahead a stage), so
it changes nothing for any placement that never overlapped in the first place. Verified
both by a real-seed sweep (mirroring `SpawnSystem`'s own `generateFloor`→
`placeFloorGraph2d` draw sequence) AND, since the failure space is small and finite
(`EMBER_DUNGEON.roomsPerFloor` caps a floor at 3 rooms), an EXHAUSTIVE enumeration over
every `(normal1, normal2, capstone)` triple the real pool can produce — confirmed zero
failures, not just "rarer than N seeds." 10 new engine tests (`dungeon.test.ts`'s
EMBER_DUNGEON bend/straight/exhaustive coverage + the direction-retry unit test +
`dungeonrun.test.ts`'s live bending-seed end-to-end check) — 1678 total across all 7
workspace packages, `tsc --noEmit` clean.

✅ **Bug fix pass shipped 2026-08-12 (`ENGINE_VERSION` 36):** two real bugs found from a
live player report ("cleared the room, door's unlocked, still can't walk through it"),
not by inspection — both real replay-affecting changes for `EMBER_DUNGEON` (`'graph2d'`
since the "graph2d content" pass above). (1) `DeathDropsSystem`'s `onDeathSpawn` boss-adds
(e.g. `BLIGHTLORD`'s two basic adds) never inherited the dying boss's own `roomId`, unlike
`SpawnSystem.dispatchDungeonSpawns`'s existing "set `roomId` DIRECTLY, same tick" fix for
the identical class of bug — `DoorSystem`'s `hasLiveEnemy` scan (step 11.5, same tick)
skips any enemy with `roomId===undefined`, so a boss room's door would briefly unlock the
instant the boss died, then re-lock (and force-regroup the player straight back) the very
next tick once `EnvironmentSystem` caught up — a real, if narrow, "door opens, then slams
shut and yanks you back" window. Fixed: the minion now inherits `e.roomId` at spawn time,
same tick, same as the wave-spawn path. (2) `placeFloorGraph2d`'s `'north'`/`'west'` hops
off the spawn room (pinned at the origin) could place the next room at a NEGATIVE offset
— `buildFloorGeometry`'s `worldW`/`worldH` is a running max seeded at 0 (blind to negative
extents) and `MovementSystem.clampToWorld` hard-clamps to `[margin, worldW - margin]` with
no bound below 0, so a player could never physically reach (or fully cross into) a
negative-offset room even though its door had correctly unlocked — the minimap's own
`dungeonToArenaMap` normalization (note above, "room offsets are normalized to a
non-negative origin") had already worked around this for RENDERING, but the actual
walkable-world bounds were never fixed. Fixed: `placeFloorGraph2d` now shifts the WHOLE
floor by the same delta so the minimum offset on each axis lands at exactly 0 — a pure
translation, every relative adjacency stays intact; `'linear'`/`'branching'` never produce
a negative offset and this is a deliberate no-op for them. 2 new regression tests
(`engine/systems/doors.test.ts`, `engine/world/dungeon.test.ts`) — 2631 tests green across
all 7 workspace packages, `tsc --noEmit` clean.

✅ **Bug fix shipped 2026-09-01 (`ENGINE_VERSION` 51):** a door that locks re-seats the loot
it closes over. `DoorSystem.rebuildWalls` pushes each locked door's `passageAabb` into
`state.walls`, and an item already lying in that passage was then inside stone with nothing
re-clamping it — nothing in the engine touches a pickup after its drop tick, and `PickupSystem`
collects on a radius test that never consults walls. So "the door locks you IN the fight"
(above) could also mean "and the loot you were standing on is now in the wall". Reachable from an
ordinary sequence, since a doorway is where fights happen: a mob dies on the threshold
(`DeathDropsSystem`), or a player swaps a weapon while standing in it
(`PickupSystem.applyWeapon`), and then their own step across the line activates the room. Fixed
by re-clamping every alive pickup at `dropClearance()` after `rebuildSpatialIndex()` —
unconditional (the "is this one affected" predicate is the same solid query `clampToWalkable`
already performs, and a no-op on a clear point) and idempotent, so a repeated rebuild cannot walk
an item across the floor. Three regression cases in `engine/systems/doors.test.ts`. This is a
candidate mechanism for the *"依然有掉落的物品无法拾取"* report that v50 closed as unexplained by the
engine — see `design/18`'s "What v51 found, in the sentence v50 wrote about it".

See `ROADMAP.md`'s "Room & door model" section for the full file list — including
hand-authored PvE floor placement (map editor), shipped 2026-08-05, see the
"Hand-authored PvE floors" subsection below.

- **A floor's rooms are all simultaneously live in sim, matching PvP's co-resident `ArenaMap`** — not generated on entry. The tick advances uniformly across every room regardless of who is rendering what (determinism needs the same input → same result everywhere, not "no one is watching so skip it"); what presence gates is enemy AI *behavior*, not the tick. A room that no player has entered yet ("not activated") still ticks forward but runs no walk/attack logic on its enemies — they sit inert until a player activates the room. A cleared room never respawns enemies, including on backtrack.
- **Doors connect rooms bidirectionally and are freely walkable within a floor.** This reuses `content/arenas.ts`'s `Door{roomA, roomB, passageGrid}` shape rather than inventing a separate PvE type — a PvE floor is the same "room graph with explicit door adjacency" primitive PvP already has. Backtracking to an earlier room in the same floor is allowed, at any time, no penalty.
- **"In combat" is derived state, not an authored flag: any room with a live (uncleared) enemy in it.** A combat room's doors lock **as a unit** — every door on that room, not just the one nearest a player — the instant it has a live enemy, and unlock together the instant the last one dies. This generalizes the existing boss-room rule ("portal opens only after the kill" is now just this rule's boss-room instance, not a special case).
- **Entering combat force-regroups the whole online run.** The instant a room's encounter starts, every other online player is teleported instantly to that room's entrance — an immediate placement, not a walk, and not optional; there is no "stay behind" choice. This hard-interrupts whatever a teleported player was doing: an open weapon-pickup panel just closes (the weapon stays on the floor to grab later), an in-progress revive channel cancels and the downed teammate stays down (the same "release INTERACT / move out of range" cancel the revive channel already has — teleport is just one more cancel source). Once the fight clears, ordinary backtracking lets a player return and finish what they were doing.
- **Doors are always-present physical fixtures with exactly two visual states, locked/open** — never a bare gap in the wall. `art/environment/door_{locked,open}_raw.png` are the first accepted pair (`13`'s flat-cel direction: a hazard-saturated glowing barrier when locked, a desaturated inert frame when open). Both are front elevations and are drawn STANDING in the wall's own opening (`01`, 2026-08-20), with the locked state carrying an additive hazard bloom on the floor in front of it — the read a player needs from across the room, and the only read a kerb-height doorway has, since it may not stand tall enough for its silhouette to carry one.
- **Door position is authored freely, not wall-centered.** A door's `passageGrid` is an arbitrary rect along its wall, exactly like PvP's `Door` — "~5 positions per wall" is a snapping aid for the map editor / a safe candidate set `generateFloor` draws from, not a constraint baked into the data shape. The one thing that IS baked in (`ENGINE_VERSION` 44, 2026-08-20): the rect sits on **whole grid cells**, like every `solids` rect already does. Freely-positioned never meant sub-cell — `carveDoorGaps` cuts whatever the rect says, so a half-cell passage leaves the wall run past it half-cell deep, and four runs in shipped level-1 content stood 16 px deep that way under a 104 px-tall perimeter (the worst case for `01`'s standing-wall tones, and the geometry that made the occlusion x-ray need its face-fading pass). Both placement functions snap their drawn anchor (`world/dungeon/doorAnchor.ts`) and the map editor's save gate rejects a hand-typed fractional one.
- **Rendering matches PvP's own approach: the whole co-resident floor is drawn in one pass, not just the local player's current room** (corrected 2026-08-04 — the original "single-room" framing here didn't match what either mode actually does or needs). `RoomBuilder` builds every room's geometry from the floor's stitched `state.walls`/`obstacles` at once; the camera following the local player is what keeps the *screen* showing only their vicinity, exactly like PvP's ~60-room arena. A minimap remains the only place teammates' rooms/clear-state surface at a glance (`10`).
- **Cross-floor transitions are unaffected and stay one-way** — the extraction/descend portal between floors remains irreversible (the "forward-only" decision in the index's Open questions ([`design/05`](../05-gameplay.md#open-questions)) is unchanged); only navigation *within* a floor gained the door graph.
- **Descending abandons the rest of the floor, enemies included** ✅ **(fixed 2026-08-15, `ENGINE_VERSION` 39).** A consequence of co-residency that the original cutover missed. Under the old one-room-at-a-time model, reaching the checkpoint meant the floor was empty by construction; under this model the checkpoint asks only that the **capstone** room be activated-and-clear (`ExtractionSystem.capstoneCleared`), and never asks where the player is standing — so a floor can be holding live enemies elsewhere the tick DESCEND resolves. Two routes reach that state today: a room with a late `atTick` `WaveScript` entry re-populates itself after the player cleared it and walked on (force-regroup drags the player back, but does *not* retract the checkpoint), and an enemy in genuinely un-owned space between rooms has `roomId === undefined`, which `DoorSystem`'s scan skips entirely — so it locks no door and sets no `hasLiveEnemy`. `resolveDescend` used to leave `state.enemies`/`state.projectiles` standing while tearing down every room array around them, so those enemies rode into the next floor holding a `roomId` nothing recognised and a position measured against geometry that no longer existed. With level 1's hand-authored floors (5/6/7/6/5 rooms at 15–30 enemies each) that would be on the order of a hundred enemies per floor for a player who beelined the capstone. *(That worst case is not reachable in the shipped content, and saying so was an over-claim — corrected 2026-09-03: nobody can beeline anything, because the floors are chains and a room's doors lock while it holds a live enemy, so every room on the way must be cleared. `ROADMAP` B3. The two routes named above are real regardless, and are what the fix was actually for.)* Both arrays are now cleared with the rest of the floor, on the same "the geometry it stood on is gone" reasoning that already applied to `pickups`. **They simply vanish — no deaths, no drops, no score**: you get nothing for the rooms you skipped, which is the intended reading of "descend and leave the rest behind", and it keeps `dropPrng` untouched so the run stays replay-stable. See `ROADMAP.md`'s "Stranded enemies rode the DESCEND into the next floor" section.

### Hand-authored PvE floors ✅ (2026-08-05)

Closes the "map-editor door placement" gap named above: before this, the ONLY way a
PvE floor got built was `generateFloor`/`placeFloor` drawing rooms and door positions
from `roomgenPrng` — there was no way to hand-place a specific `RoomPiece` at a
specific position with a door at a specific position, the same way PvP's `ArenaMap`
already lets an author hand-place a room and a door (`content/arenas.ts`). Locked and
shipped same day.

- **A new `DungeonFloorMap` content type, analogous to PvP's `ArenaMap`.**
  `{id, rooms: {id, pieceId, offsetXGrid, offsetYGrid}[], doors: Door[]}` —
  `Door` is the exact same type PvP's `ArenaMap` already uses, so a hand-placed
  PvE door is no different a shape from a hand-placed PvP one. A room entry
  references a piece from the SAME `RoomPiece` library `generateFloor` already
  draws from, by `pieceId` — a hand-authored floor is not a separate content
  vocabulary, just a different way of arranging the existing one.
- **Array order carries meaning, reusing the two single-index assumptions
  already baked into the engine** (`SpawnSystem`'s `placed[0]` for the run's
  initial spawn, `ExtractionSystem`'s `dungeonRoomRuntime[length-1]` for the
  capstone/extraction check) rather than inventing a third, parallel "which
  room is special" mechanism: `rooms[0]` is the entrance/spawn room, `rooms[last]`
  is the capstone (extraction/boss) room. The map editor's validator enforces
  both ends before allowing a save.
- **New `world/dungeon.ts placeAuthoredFloor(map, library)`, a sibling to
  `placeFloor`, not a variant of it.** Resolves each room's `pieceId` against
  the library (fail-loud on a missing piece, same "fail loud, never at use"
  convention as `generateFloor`'s own missing-capstone check), passes `doors`
  straight through unchanged (no PRNG draw — a hand-authored door's position IS
  its authored `passageGrid`, nothing left to roll), and computes each
  non-entrance room's `entranceGrid` from whichever connecting door reaches it
  first in `doors` array order (same tie-break `placeFloor` already uses for a
  fork's merge room), inset into the room along whichever axis the door's
  passage is narrower on — generalizing `ENTRANCE_INSET_GRID`'s existing
  west-only inset, which only worked because a generated floor's spine is
  always west→east; a hand-authored floor's doors can sit on any of a room's
  four walls, matching PvP's own `ArenaCanvas` door tool. Returns the exact same
  `{placed: PlacedRoom[], doors: Door[]}` shape `placeFloor` does, so
  `buildFloorGeometry` and every system downstream of it (`DoorSystem`,
  `RoomBuilder`, `EventReactor`, the minimap adapter) needs zero changes — the
  same "already topology-agnostic" property the branching pass already
  confirmed for those systems.
- **`DungeonConfig` gains an optional `floorMaps?: Partial<Record<number,
  DungeonFloorMap>>`** — a per-floor-index override. `SpawnSystem` checks it
  first; a floor index absent from `floorMaps` still draws from
  `generateFloor`/`placeFloor`'s PRNG stream exactly as today. A biome can mix
  hand-authored and procedural floors in the same run (e.g. a hand-authored
  floor 0 as a tuned opening floor, procedural floors after it) — this is a
  per-floor override, never a per-room patch of an otherwise-generated floor.
- **Map editor gains a third mode, "PvE Dungeon Floor," alongside the existing
  "PvE Room Library"/"PvP Arena" (`tools/map-editor`)** — not a new tool.
  Reuses `ArenaCanvas`'s move/resize-reject-overlap/pan/zoom/door-connect-tool
  machinery as-is; the one real difference is what "place a room" means: an
  `ArenaMap` room is freehand-drawn (its own solids authored inline), a
  `DungeonFloorMap` room is an instance of an already-authored, fixed-size
  `RoomPiece` (picked from whatever's currently open in the "PvE Room Library"
  tab) dropped at a position, never resized. A new `validateDungeonFloorMap`
  (`validate.ts`) is the save-time gate, mirroring `validateArenaMap`: every
  `pieceId` resolves against the open library docs, no two rooms overlap, every
  door sits on a real shared room boundary, the door graph is reachable from
  `rooms[0]`, and `rooms[last]`'s piece has `role: 'extraction'` or `'boss'`.
- **Deliberate scope cuts, matching the branching pass's own precedent**: no
  in-editor encounter/wave authoring beyond what "PvE Room Library" mode
  already offers per-piece (a floor's wave schedule stays generated from each
  room's own authored `WaveScript`, same as today — this pass only changes
  which rooms/doors exist and where, never encounter timing); no mixed
  procedural-with-manual-override *within* one floor (a `floorMaps` entry
  replaces a floor's placement wholesale). No shipped biome uses `floorMaps`
  yet (`EMBER_DUNGEON` is untouched) — authoring one is a content task, not
  part of this pass, same as branching's own "no shipped content forks yet"
  note.

Verified live in the browser, not just unit tests (synthetic `PointerEvent`/`WheelEvent`
dispatch, since the sandboxed Browser pane can't composite Pixi frames for a real
screenshot — see the memory's documented workaround): mode switch, the piece picker,
placing two room instances with overlap rejection, dragging a room, connecting a real
door between two adjacent rooms (`tryConnectDoor` computed the exact expected
`passageGrid`), and the Save button's validation gate correctly blocking a
capstone-convention violation with the right message. No `ENGINE_VERSION` bump (no
shipped config sets `floorMaps`, and it changes nothing for one that doesn't).

**"全部加测试" follow-up, same day:** `DungeonFloorCanvas` — the single most complex new
file this pass (overlap-rejecting placement, the door tool's two-click state machine,
drag-move-with-revert, dangling-piece-reference rendering) — had zero dedicated tests,
matching `ArenaCanvas`/`RoomCanvas`'s own long-standing gap (their `mount()` needs a
real `Application.init()`/canvas, unavailable in plain vitest). Closed it instead of
extending the gap: confirmed empirically that this class's constructor never touches
`host`/`document`/`window` (every field — `app`, `camera`, `world`, `shapes`, `labels`,
`preview` — is a plain, renderer-free Pixi object) and that an unparented `Container`'s
`toLocal()` still applies its own `position` correctly with no render pass ever run —
so skipping `mount()` entirely leaves `toGrid(px,py)` reduced to the clean, predictable
`(px/GRID_PX, py/GRID_PX)`. New `DungeonFloorCanvas.test.ts` (28 tests) drives the real
private `onPointerDown`/`onPointerMove`/`onPointerUp`/`tryConnectDoor`/`roomAt`/`doorAt`/
`nextRoomId` methods directly (bracket-notation access, same convention
`Minimap.test.ts`/`HudView.test.ts` already use) and reads `redraw()`'s actual
`Graphics.context.instructions` output (fill vs. stroke, since every shape here draws
both — unlike `Minimap`'s fill-only rooms) for entrance/capstone tinting, dangling-piece
placeholders, door lines, and selection-stroke highlighting. Not covered, documented
in the file's own header rather than silently skipped: `onKeyDown`'s Delete path (needs
`document`/`HTMLInputElement`/`HTMLTextAreaElement`, not worth stubbing for one path),
and `onWheel`/pan/`fitView`'s exact camera math (cosmetic view-fitting, not authoring
correctness). 28 new map-editor tests (64, was 36) — 1623 total across all 7 workspaces,
`tsc --noEmit` clean.

### Level 1 is now fully hand-authored ✅ (2026-08-15)

Closes the previous subsection's own open end — "No shipped biome uses `floorMaps` yet
(`EMBER_DUNGEON` is untouched) — authoring one is a content task". That content task is
this one, for the whole level rather than a single floor. `ENGINE_VERSION` 38.

- **Shape: 5 floors, 6 / 7 / 8 / 8 / 6 rooms** (the capstone counts as one of them, and so
  does each floor's dead-end side room — 35 rooms total; it was 5 / 6 / 7 / 6 / 5 and 29 until
  the side rooms landed on 2026-09-14, see "Chest rooms" in [`02-what-a-floor-hands-you.md`](02-what-a-floor-hands-you.md)). Floors 0-3 are capped by
  `ember_l1_extraction`, floor 4 by `ember_l1_boss`. A per-floor room count is something `roomsPerFloor`'s `{min, max}`
  range structurally cannot express, which is a large part of why the level is
  authored rather than drawn; the range left on `EMBER_DUNGEON` now describes only the
  procedural fallback a floor would take if its authored map were removed.
- **Room sizes 15x15 to 20x20 grid cells; enemy count ramps with cell count**, 8 at
  225 cells up to 14 at 400 (`enemyCountForArea`), so a bigger room is always the
  bigger fight. 285 enemies across the level — unchanged by the 2026-09-14 side rooms, which
  hold none. (This shipped at 15→30 / 581 enemies and
  was halved on 2026-08-17 — see "Room encounter budget" below for the measurements
  that forced it.) The extraction capstone and the three side rooms are the
  deliberate exceptions at 0 enemies; for the capstone the reason is that `DoorSystem`/`ExtractionSystem` both treat
  "capstone cleared" as the floor's gate, so garrisoning it would turn every
  checkpoint into a second boss fight.
- **`difficultyCurve` drops to `perFloor: 0.5`.** `curveAt` is a plain
  `base + perFloor * floorIndex` multiplier on enemy maxHp, so leaving it at 1 would
  have taken the deepest floor from x3 to x5 purely as a side effect of going 3 floors
  to 5. x0.5 keeps the same x3 ceiling over five floors instead of three.
- **The content is JSON under `world/dungeons/ember/`, not TypeScript** — 17
  `RoomPiece` files plus 5 `DungeonFloorMap` files, in exactly the two shapes
  `tools/map-editor` reads and writes, so the level is tuned in the editor rather than
  in a source literal. `engine/world/rooms/emberLevel1.ts` is a pure loader over them.
  PvP set that precedent first and has since moved the other way: its 60-room arena is
  hand-authored TypeScript (`engine/world/arenas/` `arena_launch`), because a map whose layout
  is a drawing reads better as code than as JSON — the JSON predecessor
  `world/arenas/arena_prototype_60.json` was retired and deleted 2026-08-26. This level stays
  JSON under `world/` so the editor can round-trip it: code only points at it. Seeded
  once by `tools/map-editor/scripts/genEmberLevel1.mjs`, deliberately not wired into
  any npm script — re-running it overwrites editor tweaks, and the JSON is the source
  of truth from the moment it lands.
- **Doors are validated for physical passability, not just declared adjacency.**
  `validateDungeonFloorMap` (the editor's save gate) already covers the structural
  half — no overlaps, doors on a real shared wall, reachability through the door
  GRAPH, capstone last — but a door can satisfy all of that and still be unwalkable:
  it can open onto an interior solid, or cut only one of the two abutting perimeter
  walls. So `engine/world/rooms/emberLevel1.test.ts` runs the real engine path
  (`placeAuthoredFloor` → `buildFloorGeometry`, the same two calls `SpawnSystem`
  makes), rasterises the resulting door-carved Fp wall list back onto the grid, and
  flood-fills from the spawn room — every room's `entranceGrid` and every authored
  spawn point has to come out reachable, and the fill has to physically enter every
  room. `tools/map-editor/src/emberLevel1Content.test.ts` is the matching authoring-side
  gate: the shipped files must pass the editor's OWN validators, or the first
  tweak-and-save would be blocked on a problem the content shipped with. The authoring
  rule that makes the geometry check pass is a 4-cell decor margin off every
  perimeter, so a door carved anywhere along a wall always opens onto clear floor.
- **The old procedural pair is kept, not deleted.** `EMBER_ROOMS` plus a new
  `EMBER_PROCEDURAL_DUNGEON` export (the exact descriptor `EMBER_DUNGEON` was before
  this change) is what `world/dungeon.test.ts`'s graph2d seed sweeps and exhaustive
  pool enumeration still drive — that coverage is the reason those seven pieces' exit
  topology is what it is (the "found NOT by inspection" paragraph above). Nothing in a
  shipped run reads the procedural pair now.
- **Open, deliberately left for editor tuning**: the floors are spanning trees (rooms
  connect in a chain, extra loop doors only appear where rooms happen to end up
  flush — none did on this pass), so no floor currently has an alternate route; enemy
  type mixes are per-piece rather than per-floor, so the same piece fights the same way
  wherever it appears; and every room still spawns its whole garrison at tick 0 (an
  absent `encounter` is the engine's hand-authored default, and it is what makes a room
  genuinely cleared the moment it is empty — a staggered script would let a player
  leave through a door that unlocked between waves).

### Room encounter budget ✅ (2026-08-17, `ENGINE_VERSION` 41)

The third and final round of one live report — *"一进游戏就被集火秒杀"* (I get focus-fired
down the moment I enter). `ENGINE_VERSION` 37 (mobs chase) and 40 (mobs only fire once
inside their own `engageRangeFp`) were both aimed at it and both diagnosed by reasoning
alone; each bought about half a second, because a room's garrison simply CLOSED to
engage range as one blob and opened up together.

**What settled it was building the measurement first.** `client/sim/pveLevelSim.sim.ts`
(`npm run test:pve-sim`) plays the shipped level with `PveBotController` at two skill
profiles and reports, per room: garrison size, reaction window (activation → first
damage taken), peak simultaneous shooters, damage taken, clear rate. On the shipped v40
build it read: **14 of 15 mobs firing on the same tick, first hit 0.6s after the room
woke, worst 1-second window 10 damage against a starter character's 9.2 effective HP,
and death in the entrance room in 100% of runs at both profiles.** No per-enemy number
can fix that shape — 15 mobs each firing a 1-damage shot every 1.5s is 10 damage/second
however reasonable each individual mob is.

So the budget is a property of the **room**, the same unit aggro already lives on:

- **`ROOM_FIRE_BUDGET` = 2** (`engine/balance/encounter.ts`). At most 2 mobs per room may
  have `firing` set on any tick, awarded to the NEAREST contenders; the rest hold
  position inside engage range and take a slot when a shooter dies or the player moves
  and reorders the queue. A room may hold a crowd; it may not alpha-strike.
- **Staggered wake-up** — `noticeDelayTicks(id)` = 18 + `id % 30` ticks (0.6-1.6s) after
  activation, during which a mob may move but not fire. Derived from the enemy id, not
  an `aiPrng` draw: reproducible with no new PRNG draw site and no new field to
  serialize. Per-enemy rather than flat, or the whole simultaneous volley would just
  arrive later.
- **Garrisons halved** — `enemyCountForArea` 15→30 becomes 8→14 (content, no version
  bump). This half is about CLEAR TIME, not incoming damage: the starter blaster does 5
  damage/second, so 15 mobs averaging 3.5 HP is ~11 seconds of uninterrupted shooting
  per room, 29 rooms deep.
- **Authored player-spawn clearance 3 → 6 grid.** `ember_l1_cell` put its nearest mob 3.2
  grid from the spawn point, i.e. inside the 5.6-grid engage range before the run began.
  A room that opens pre-aimed is something no engine-side pacing can undo.
- **`SHIELD_REGEN_INTERVAL` 300 → 60 ticks** (~10s → ~2s per +1). The shield was
  effectively single-use in a run: refilling 3.2 shield took ~32s of taking no damage,
  while a room takes ~8s to clear and the next is seconds away — so a player entered a
  37-enemy floor with one 9.2-point pool and no way to get any of it back except heal
  drops. This makes the two-pool split mean what "Survivability model" in [`02-what-a-floor-hands-you.md`](02-what-a-floor-hands-you.md) says it
  means (shield renewable, HP permanent), and makes disengaging between rooms a real
  tactic. Re-checked against `npm run test:pvp-sim`: arena win rates moved within noise.

### Room feel pass ✅ (2026-08-17, `ENGINE_VERSION` 42)

A separate live report the same day, about how a room full of mobs *reads* rather than how
hard it hits: *"怪物之间要有碰撞。怪物的感知范围弄小一些，移动速度调低."* Three changes,
all in the PvE enemy path (full account in `engine/ENGINE_VERSION_HISTORY.md` v42):

- **Enemy↔enemy push-out re-enabled** (`MovementSystem.resolveActorPairs`). That pair was
  this engine's one documented faction exception, skipped on `07`'s own "Open questions"
  recommendation that packed rooms read better with mobs leaning overlap. In practice a
  garrison converging on the player stacked into a single blob of overlapping sprites, so
  the player could neither count the threat nor tell what they were shooting. There is no
  longer any faction branch in that loop.
- **Perception radius** — `DEFAULT_ENEMY_AGGRO_RANGE_FP` = 320 px (10 grid),
  `AIDecideSystem.hasAggro`. Room activation stays the OUTER aggro gate and is unchanged;
  this is a new inner one. Opening a door used to set the room's whole garrison walking at
  the player from wherever it was authored, so a room read as one converging blob instead
  of a space with pockets of threat in it. An un-noticed mob is fully inert — no movement,
  no fire, and no turning to face. Wider than the 180 px engage range, so a mob that
  notices the player still has ~4 grid to close before it may fire and v40's reaction
  window survives. `EnemyActor.aggroed` latches one-way, like `enraged`: the radius is a
  wake-up trigger, never a leash, and a boundary-straddling mob can't oscillate.
- **Enemy move speed 4 → 2.6 px/tick** (~63% → ~41% of the player's). v37's claim that a
  slower mob means "committing to running away always opens the gap" didn't survive
  contact — the player also has to aim and dodge.

**This made level 1 substantially easier and the sim says so:** the careful bot's average
deepest floor went 0.1 → 1.9 and its worst 1-second damage window 5 → 4 against the same
9.2 effective HP. The `test:pve-sim` gates below still pass, but the "hard overall" target
they encode is now met with much more headroom — a garrison re-tightening pass is open
work, and `ROOM_FIRE_BUDGET` / garrison size are where it should happen, not by undoing
the perception radius.

*Two sim-bot fixes shipped alongside, both the same bug class and neither an engine
change:* `PveBotController.nearestEnemy` and `healToSeek` are now bounded by the bot's own
room rather than by a scan radius. A room's doors are combat-locked while it holds a live
enemy, so a mob or a heal outside the room is unreachable, and with mobs no longer walking
over on their own the bot found no target, fell through to `travel`, and bounced off the
locked door until the run timed out. That is the sim's no-stall gate doing its job.

### Standing room ✅ (2026-09-03, `ENGINE_VERSION` 55)

The same reading problem as the pass above, reported again with a screenshot — three mobs
fused into one silhouette, two health bars drawn across a third body — and this time with
the missing distinction named: *"怪物寻路时要加一个停留体积，最好是两倍于怪物的体型，这样
怪物才会分散。这里是两个概念，一个是寻路体积，一个是终点停留时的体积。"*

Re-enabling the push-out in v42 made mobs stop interpenetrating, and that is all it could
do: it is a COLLISION rule keyed on `footprintRadius` (7 px against a 15 px body), so
"resolved" still means two sprites almost exactly on top of each other. What was missing is
that a mob has two sizes — its body while travelling (it has to fit through the gaps the
level authored) and its personal space while standing.

- **`EnemyActor.holding`** — arrival is now state, written by `AIDecideSystem` the tick a
  mob reaches its engage range and stops.
- **`standoffRadius` = 2 × body `radius`**, spread by `MovementSystem.resolveStandingSpacing`
  (`07` step 4.4), so two arrived mobs settle four body radii apart. **Only between two
  mobs that are both holding** — a travelling mob is judged exactly as it was before, so a
  1.5-body-wide slit stays passable at full speed with a mob standing at its mouth.
- **`HOLD_RELEASE_PERMILLE` = 1500** — "in engage range" became hysteretic, because the
  spread pushes a standing mob outward and a bare threshold would have it re-chase, be
  pushed out again, and shuffle at the ring forever with its gun stuttering behind it.

**Superseded in part by the section below** (`ENGINE_VERSION` 56): the spread is chosen at the
destination now, and `resolveStandingSpacing` is the correction rather than the mechanism.

**This took back most of what the pass above gave away, and the sim says so:** the careful
bot's average deepest floor went 2.5 → 1.5 across a widened 24-seed `test:pve-sim` A/B
(extraction 13% → 4%). Damage taken per second barely moved — a spread arc is a crossfire,
and `ROOM_FIRE_BUDGET`'s two slots rotate among more mobs as the player moves, so the
player kills slower rather than being hit harder. Deliberately not compensated for here:
the garrison re-tightening dial named above is still the right place for that, and it is a
difficulty decision rather than part of a legibility fix.

### Standing room is chosen, not corrected ✅ (2026-09-04, `ENGINE_VERSION` 56)

The next day's report on the pass above: *"整体效果不错。有个细节，我希望的是在设置寻路终点时
就考虑到这个站立体积。现在的做法是怪先跑到一起，然后再分散开。我希望的是一步到位。"* — v55 spread mobs
once they had arrived; it never told them where to go, so a garrison still converged into one
silhouette and unpacked over the following half second.

- **`systems/approachSlots.ts`** — every chasing mob is given its own point on a ring around the
  target, spaced by the same `standoffRadius`. Its own bearing if nothing has claimed it (so a
  lone mob walks the straight line it always did), the nearest free angle otherwise, and a
  second ring one standing diameter further out rather than a walk round the player. Arrived
  mobs claim before travelling ones, and a spot is never further out than the mob already
  stands — the ring stops a mob closing, it does not add kiting.
- **A spot behind a wall is refused** and the mob falls back to the radial approach. That is what
  keeps the 1.5-body slit above passable: a mob standing in its mouth claims the bearing straight
  through it, and without the check the mob behind presses into stone forever.
- **Arrival is hysteretic** — a spot moves with the player, so without a deadband every arrived
  mob shadows the player step for step at its engage range. Found by measurement, not design: the
  careful bot sat at avg floor **0.5** until the deadband went in.
- **Only a stopped mob takes a fire slot.** In range and stopped stopped being the same thing, and
  the alternative is a garrison firing while it is still arranging itself — v40/v41's alpha
  strike again.

Cost, 24 seeds: careful bot avg floor **1.3 → 1.0**, damage taken per second flat (worst 1 s
window 6 both ways). Same crossfire effect as v55, same decision not to compensate for it here.
`MovementSystem.resolveStandingSpacing` stays as the correction layer, now gated on holding AND
stopped. See `roadmap/27-2026-09-04-approach-slots.md`.

**Difficulty target, chosen 2026-08-17: hard overall.** Floor 1 passable by careful play,
a full 5-floor extraction uncommon. After the changes the sim's careful bot clears the
entrance room in 100% of runs, descends off floor 0 in ~37%, and dies spread across
floors 0-3; *(the descent rate was re-measured over 40 seeds on 2026-09-14 and is **15-20%**
— the ~37% above is 3 of 8 seeds, which is the same number read off a sample too small to
resolve it. See "the gate that was passing on luck" in [`03-weapon-energy-and-melee-mobs.md`](03-weapon-energy-and-melee-mobs.md).)* the aggressive profile (walks into the mob's face, never rests) dies on floor
0. Both directions are gated in the sim so a later tuning pass can fail for being too
lethal *or* for overshooting into a walkover. Read the bot as a LOWER bound on a human —
it never swaps to the saber (2 damage, hits everything in the arc, parries bullets) and
never dodges a shot on purpose.

**A second, worse bug fell out of the same sim run: a real softlock.** The tick a player's
step across a threshold activates a room, their body is still in the doorway;
`EnvironmentSystem` had already re-tagged `p.roomId`, so `DoorSystem.forceRegroup`'s
"skip whoever is already inside" test skipped them, and then the restored passage wall
pushed them out — often back the way they came. The room stays in combat behind a
permanently locked door, the floor can never be cleared, and the run can only end in
death. Fixed by `inLockingDoorway`: a player physically overlapping a passage that is
about to lock gets pulled onto the room's entrance like everyone else, which is what "the
door locks you in the fight" was always meant to mean. It wedged 7 of 8 bot runs before
the fix; the sim's no-stall gate is its regression check.
