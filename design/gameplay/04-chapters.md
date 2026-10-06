# PvE chapters

Part 4 of the gameplay doc (index: [`design/05-gameplay.md`](../05-gameplay.md)). How the game
grows past its one dungeon: what a chapter is, the order they come in, and what a second one
actually buys a player.

## PvE chapters: one dungeon becomes a sequence ✅ (2026-10-06)

> 现在我们需要规划pve的地牢章节了，现在只有一张地图。

Until this pass the game had exactly one PvE dungeon, and nothing in the code could have held a
second: no config, save, wire message, queue key, meta field or analytics event carried a
"which dungeon" field, and every PvE path built `EMBER_DUNGEON` by name. Clearing it left
nothing new to play; the only reason to go again was the 5% schematic.

### The decisions (owner, 2026-10-06: "按推荐的来")

- **A chapter is a whole run.** Its own biome, five floors, and its own boss. Chapters are NOT
  chained into one long run. The carry-out bag is handed over only when the last boss dies
  ([`01`](01-the-run-and-its-rooms.md) "Only the boss floor ends a run"), so a three-chapter run
  would put a bag at risk three times as long; the run save holds one slot; and a phone session
  is not getting longer.
- **Sequential unlock, free replay.** Chapter 1 is always open. Clearing chapter N (killing its
  boss) unlocks chapter N+1, permanently. Any unlocked chapter can be replayed. The first clear
  also moves the lobby's pick to the chapter it unlocks, so the unlock is seen rather than
  found; a repeat clear leaves a deliberate replay pick alone.
- **The lobby picks the chapter.** Solo picks for itself; in co-op the player who queues or
  hosts the party picks, and everyone seated in that room plays it. The matchmaker only groups
  players who picked the same chapter.
- **Plan four, build two, then look.** The order below is the plan; this pass ships chapter 1
  (unchanged) and chapter 2. Chapters 3 and 4 wait for player feedback on chapter 2.

### The order

| # | Chapter (`biomeId`) | Element | Garrison leads with | Boss | State |
|---|---|---|---|---|---|
| 1 | The Ember Descent (`ember`) | fire | emberling | random of blightlord / pyrefang / ironwarden | shipped |
| 2 | The Frost Descent (`frost`) | ice | frostling | **glacimaw** (new) | ✅ this pass |
| 3 | storm (planned) | lightning | galvanist | new lightning boss needed | planned |
| 4 | blight (planned) | poison | **a poison critter, which does not exist yet** | blightlord, as the finale's "giant failed core" | planned |

Poison is last on purpose. [`design/13`](../13-worldview-art-direction.md) keeps it off the first
floor because green effects camouflage against a green floor, and the Blight crystallising the
world is the story's end state, so its own biome is the natural finale. That closes design/13's
open "Biome difficulty/order" question. Chapter 1 keeps its three-boss random pool for now;
whether it narrows to pyrefang alone once chapter 4 claims blightlord is a later call.

### What a chapter buys a player today, and what it does not

**Real today:** something new to play after clearing chapter 1 (a new palette, a frost-led
garrison, transposed floors, a boss with a different counterplay), and a progression goal that
is not a 5% drop.

**Not real today, so not claimed:**

- *"Later chapters drop higher-tier materials."* No recipe asks for more than tier 2
  (`stormglaive`), and chapter 1 already rolls tiers 0-4 by floor. A deeper chapter's materials
  would buy nothing. `DungeonConfig.materialTierByDepth` exists for the day recipes ask more.
- *"Farm the frost chapter for ice materials."* A material's element is rolled uniformly
  (`MATERIAL_DROP_POOL`) whatever the biome, and recipes cost 3-5 materials, so biasing the
  element would be nearly inert. Worth doing only together with a forge-economy pass.

### Chapter 2, the Frost Descent

**Content is derived, not drawn.** `world/dungeons/frost/` was seeded by
`tools/map-editor/scripts/deriveChapter.mjs` from chapter 1's tuned JSON:

1. **Transposed** (x↔y on every room, door and floor). A floor that ran left-to-right runs
   top-to-bottom, and every room's interior turns with it.
2. **Roster-swapped**: emberling↔frostling, so the garrison is frost-led, and the boss room
   names `glacimaw` instead of the random-pool sentinel.
3. **Renamed**: `ember_l1_*` → `frost_l1_*`, fire-flavoured room names to frost ones.

Why derive rather than re-run the original seeder: everything chapter 1 learned after its first
pass lives only in the JSON (the halved enemy ramp, the three enemy-free side rooms, the branch
variants on floor indices 1-3, the ravager ramp). A transform keeps all of it, and every property
chapter 1's content test proves survives a distance-preserving transform. The physical
passability suite is NOT inherited, because door carving and the north wall brim run on the
transposed geometry: it now lives in `engine/fixtures/floorPassability.ts` and runs over both
chapters. `frostLevel1.test.ts` also pins that the JSON is still exactly the transform; the day
frost is hand-edited in the map editor, that block is deleted and chapter 1's per-piece
assertions are copied across. Hand-authored frost layouts are the obvious follow-up, not a
prerequisite.

**Harder by one knob, set by measurement.** `difficultyCurve.base` is **1.125** against chapter 1's
1.0 (same 0.25 per floor), so every chapter-2 floor scales mob HP an eighth above the same
chapter-1 floor. The garrisons are chapter 1's, mirrored, so this is the only difficulty change.
It was authored at 1.25 and measured down (`client/sim/chapterSim.sim.ts`, careful bot, starter
kit, 80 seeds; a lower bound on a human, since the bot never dodges on purpose):

| Config | Runs past floor 0 |
|---|---|
| chapter 1 (base 1.0) | 25% |
| chapter 2 at base 1.0 (control) | 21% |
| **chapter 2 at base 1.125 (shipped)** | **13%** |
| chapter 2 at base 1.25 (as authored) | 5%, and 0 of the 40 gated seeds |

The control row is the finding: the transposed layout and the swapped roster on their own barely
move difficulty, so the curve is the whole knob. At 1.125 chapter 2's floor 1 clears 28% of fresh
trials against chapter 1's 98%. The sim now gates chapter 2 between 1/16 of seeds and 3/4 of
chapter 1's pass count, which both 1.0 and 1.25 fail.

**Glacimaw** (`engine/content/bosses.ts`). The "don't get pinned" fight, beside pyrefang's "keep
moving" and ironwarden's "burst to the break". Its loadout, `enemyshardfan`, is an aimed cone of
five ice shards. Every shard chills (40% slow), and a slowed player is late leaving the next cone,
so the counterplay is stepping sideways before the volley rather than backing off after it. It
mirrors the frostling's resists (shrugs ice, melts to fire) and enrages below 40% by firing 50%
faster, never by hitting harder. It is not in `BOSS_POOL`: chapter 1's draw is unchanged.
Measured alone against the bot (40 seeds): 23% kills, 78% bot deaths, 25 s median kill, chilled
for 46% of the fight. That sits between blightlord/ironwarden (single aimed bullets the strafing
bot never takes, 0 damage in 80 fights) and pyrefang (100% bot deaths), and the same numbers in
chapter 1's room and scale show the danger is the cone, not the chapter. Left as authored.

**No new art was needed for the run itself.** Every boss is the shared `boss-core` rig tinted,
every critter the shared rig tinted, and all five biome swatch sets already shipped
(the `biome-ice` pack had been waiting since 2026-08-02 for a dungeon to map to it). The lobby
picker's two chapter banners are the only new images.

### The plumbing: one id, read everywhere

- **The chapter id is the config's `biomeId`.** `DungeonConfig` has no id of its own, and a
  second name would be a second thing that can disagree. `engine/world/chapters.ts` is the
  catalog (`CHAPTER_ORDER`, `CHAPTERS`, `isChapterId`, `chapterIdOfConfig`, `nextChapterId`).
  Nothing else enumerates chapters.
- **Chapter 1 stays byte-identical.** The catalog hands out the same `EMBER_DUNGEON` and
  `EMBER_L1_ROOMS` objects, so chapter-1 configs, run-save content hashes, replays and all seven
  existing golden hashes are unchanged; no `ENGINE_VERSION` bump. A new golden scenario,
  `frost-dungeon-floor1`, pins chapter 2's floor 1.
- **Every "absent" means chapter 1**: a save with no chapter, a `match_start` from an older
  server, a fresh account.
- The client, server, meta and analytics specifics are in this pass's roadmap volume.

### Next

- Chapter 3 (storm): a lightning boss, a lightning-led derivation or hand-authored floors.
- Chapter 4 (blight): a poison critter first; it is what the chapter's garrison leads with.
- ~~Chapter music~~: done the same day. Each chapter has its own bed (`dungeon.ember`,
  `dungeon.frost`), open-licensed music like the rest of the soundtrack (design/11).
- Hand-authored frost layouts in the map editor, once players have seen the derived ones.
