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
  *Amended the same day:* the owner asked to carry on ("继续pve"), so chapter 3 shipped on
  2026-10-06 too, built the same way. Chapter 4 is the one still waiting, and it waits on
  content (a poison critter) as much as on feedback.

### The order

| # | Chapter (`biomeId`) | Element | Garrison leads with | Boss | State |
|---|---|---|---|---|---|
| 1 | The Ember Descent (`ember`) | fire | emberling | random of blightlord / pyrefang / ironwarden | shipped |
| 2 | The Frost Descent (`frost`) | ice | frostling | **glacimaw** (new) | ✅ this pass |
| 3 | The Storm Descent (`storm`) | lightning | galvanist | **voltreaver** (new) | ✅ same day |
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

### Chapter 3, the Storm Descent

**Derived again, turned a different way.** `deriveChapter.mjs` now takes the chapter
(`node tools/map-editor/scripts/deriveChapter.mjs storm`) and holds each chapter's choices in one
table. Chapter 3 is chapter 1's JSON **turned half a circle**: every piece inside its own box,
every floor inside its bounding box, north and south swapped, east and west swapped. Chapter 1
runs left-to-right and down, chapter 2 (transposed) top-to-bottom, chapter 3 right-to-left and
up, and `stormLevel1.test.ts` asserts no floor places its rooms where either earlier chapter
does. The roster swap trades emberlings and galvanists (23 and 13 in chapter 1), so the
garrison is lightning-led. The galvanist's lightning also chains between mobs. Re-deriving
frost through the generalised script reproduces its committed JSON exactly. The passability
suite passes on the turned geometry, where every north-wall brim now sits on what chapter 1
had as a south wall.

**Voltreaver, the "out-turn it" fight.** Its loadout, `enemyarcseeker`, fires three **homing**
lightning orbs in a 160° fan. The orbs follow, so neither of the earlier answers clears a volley
on its own: stepping sideways (Glacimaw) or backing off. The answer is a late, hard cut across
their path, since their turn rate (160°/s) is under the player's own seeker's (260°/s).
Alternatively, the player can shoot the orbs that come down the firing line: hostile bullets
annihilate, and these are the fattest bullets in the game and slower than the starter blaster's.
In co-op each hit arcs to the nearest teammate, so a party must also spread out. Its resists
mirror the galvanist's (shrugs lightning, rots to poison). It enrages below 40% by firing 40%
faster, and it is not in `BOSS_POOL`.

The orbs' danger is knife-edged, and the duel sweep (careful bot, 40 seeds, boss alone) walked
it from nothing:

| Arc seeker | Duel |
|---|---|
| as first authored: 80° fan, 5 grid/s, 110°/s, every 1.8 s | 100% kills, **0 damage taken** |
| 160° fan, 6 grid/s, 160°/s, every 1.4 s | 100% kills, 0 damage |
| 160° fan, 7 grid/s, 140°/s, every 1.4 s | 98% kills |
| **160° fan, 7 grid/s, 160°/s, every 1.4 s (shipped)** | 57% kills at 90 HP; **50% / 50% at the boss floor's 95 HP** |
| 160° fan, 7 grid/s, 180°/s, every 1.6 s | 33% kills, 70% deaths |

Under ~7 grid/s the bot's own stream of fire crosses the fan's centre line and erases every
volley. Staged in chapter 1's room at chapter 1's scale it reads 78% kills, so as with
Glacimaw the fight is the weapon, not the chapter.

**Harder past the entrance, not at it.** Chapter 3 takes chapter 2's `base` (1.125) and a
steeper step: 0.3125 per floor against 0.25. Its boss floor scales HP ×2.375 against chapter
2's ×2.125. The base could not move. Runs off floor 0, 80 seeds:

| Chapter 3 at base | Runs off floor 0 |
|---|---|
| 1 (content alone; chapter 1 reads 20, chapter 2 reads 17) | 21/80 |
| **1.125 (shipped; chapter 2 reads 10 at the same base)** | **13/80** |
| 1.1875 | 0/80 |
| 1.25 | 3/80 |

Every base above 1.125 rounds the 3-HP basic mob, the commonest in the game, up to 4. The
entrance therefore has no step between chapter 2's difficulty and a wall. The deeper floors do
have room, and they are where a player who has cleared chapter 2 brings that chapter's gear.
On a fresh-start floor-2 trial the steeper step cuts the bot to 14 kills, against 27 in chapter
2 and 23 in chapter 3 at chapter 2's own step.

`chapterSim.sim.ts` gates chapter 3 on four things:
- it is not a wall: at least 1/16 of seeds leave floor 0;
- its floor-2 trial kills are at most three quarters of chapter 2's (the control at chapter 2's
  step fails this);
- no floor of it clears more often than chapter 2's;
- Voltreaver is beatable, lands damage, and is no deadlier than Pyrefang.

One careful full run reached chapter 3's boss and won.

**Art and music.** The lightning floor swatches had shipped in the `biome-lightning` pack since
2026-08-25 with no dungeon mapped to them; `theme.ts` now maps `storm` to `lightning`. The
picker banner `chapter_storm` was made with Mistral like the other two (`art/ui/prompts.md`).
The chapter's music bed is `dungeon.storm` (design/11).

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

- Chapter 4 (blight): a poison critter first; it is what the chapter's garrison leads with.
- ~~Chapter music~~: done the same day. Each chapter has its own bed (`dungeon.ember`,
  `dungeon.frost`), open-licensed music like the rest of the soundtrack (design/11).
- Hand-authored frost and storm layouts in the map editor, once players have seen the derived ones.
- Whether chapter 3's entrance should be harder. Not by `base`, which is a cliff; a garrison
  change (fewer 3-HP basics, more galvanists) would be the knob, and it needs a player's
  verdict on chapter 2 first.
