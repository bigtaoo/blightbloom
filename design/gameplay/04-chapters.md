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
  2026-10-06 too, built the same way. Then "继续做第四章": chapter 4 shipped as well, with the
  poison critter it was waiting on. All four planned chapters exist; what none of them has yet
  is a player's verdict.
- **Then an endless fifth (owner, 2026-10-06: "能再加一章吗，作为无尽模式，给完全通关的玩家进行
  挑战").** Three calls, all the recommended option: each boss kill offers a cash-out, the floors
  are the four chapters' own in rotation, and the record is a personal best. "The Endless
  Descent" below.

### The order

| # | Chapter (`biomeId`) | Element | Garrison leads with | Boss | State |
|---|---|---|---|---|---|
| 1 | The Ember Descent (`ember`) | fire | emberling | random of blightlord / pyrefang / ironwarden | shipped |
| 2 | The Frost Descent (`frost`) | ice | frostling | **glacimaw** (new) | ✅ this pass |
| 3 | The Storm Descent (`storm`) | lightning | galvanist | **voltreaver** (new) | ✅ same day |
| 4 | The Blight Descent (`blight`) | poison | **blightling** (new) | **rotbloom** (new), not blightlord: see below | ✅ same day |
| ∞ | The Endless Descent (`endless`) | each floor its chapter's | the four chapters' garrisons in turn | every chapter's boss, every fifth floor | ✅ same day |

Poison is last on purpose. [`design/13`](../13-worldview-art-direction.md) keeps it off the first
floor because green effects camouflage against a green floor, and the Blight crystallising the
world is the story's end state, so its own biome is the natural finale. That closes design/13's
open "Biome difficulty/order" question. Chapter 1 keeps its three-boss random pool, blightlord
included: chapter 4 did not claim it after all ("Chapter 4, the Blight Descent" below).

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
The chapter's music bed is `dungeon.storm`, "Endless Cyber Runner" by Eric Matyas (CC-BY 4.0;
design/11).

### Chapter 4, the Blight Descent

**The poison critter first.** `blightling` (`engine/content/enemies.ts`) is the fifth re-tint of
the shared critter, at design/13's locked `#9CCC65`. It shrugs poison and burns to fire. Fire is
the counter because the Blight is rot, and rot burns; it also makes fire the answer to two of the
four elemental critters (frostling and blightling), which is what chapter 4's garrison leans on.
It is badged with the skull like any locked variant, and the element tests now pin five.

**Derived a third way.** `deriveChapter.mjs blight` mirrors chapter 1 across the anti-diagonal,
(x, y) -> (h - y, w - x), the one transform left that runs in a direction no earlier chapter does:
chapter 4 runs bottom-to-top and left. Chapter 1 has no poison mob to trade back, so the roster
swap is one-way: all 23 emberlings become blightlings and everything else stays. Re-deriving
frost and storm through the extended script reproduces both. `blightLevel1.test.ts` restates the
mirror independently, checks no floor places its rooms where any earlier chapter does, and runs
the passability suite on the mirrored geometry. It passed first time, with every north-wall brim
now sitting on what chapter 1 had as an east wall.

**Rotbloom, not Blightlord.** The plan named blightlord as the finale's boss. Two measured facts
said otherwise. Blightlord's single aimed bullets never land on a strafing player: 0 damage in 80
bot duels, which would have made the finale the easiest boss in the game. And it is *weak* to
poison, the one element a poison chapter's boss should shrug. It stays in chapter 1's pool,
unchanged. The finale's boss is new: **Rotbloom**, the "keep your distance" fight, beside
Pyrefang's "keep moving", Ironwarden's "burst to the break", Glacimaw's "don't get pinned" and
Voltreaver's "out-turn it". Its loadout, `enemysporespray`, is a short cone of six poison spores
(~5 grid of reach, the shortest of any boss). Every spore that lands adds a poison stack, the
stacks keep ticking after the hit, and a poisoned actor's shield does not regenerate, so trading
at close range is the losing play. It walks toward you faster than the roster default and slower
than you, so kiting it is always possible and never free. It mirrors the blightling's resists and
enrages below 40% by spraying 40% faster.

The duel sweep (careful bot, 40 seeds, boss alone at the boss floor's 105 HP):

| Spore spray | Duel |
|---|---|
| as first authored: 6 spores, 60°, 6 grid/s, every 1.0 s | 60% kills, but a 51 s median kill, over the 2x-chapter-1 bound |
| 6.5 grid/s | 15% kills, 85% deaths |
| **7 grid/s, every 1.4 s (shipped)** | **35% kills, 65% deaths, 35 s, poisoned 19% of the fight** |
| 8 spores in 80°, 6 grid/s | 0% kills |

Speed decides whether the cone lands at all: a spore slower than the bot's fire is erased by it,
as Voltreaver's orbs were. The flight time is not a knob for the bot. 0.5 s and 2.0 s read the
same, because every spore that lands does so inside ~3.5 grid, after the boss has walked the bot
into a wall; 0.3 s (~2 grid) lands nothing. So the duel measures the bot losing the distance
fight, and a player who holds the distance does better than these numbers. 35% / 65% puts the
finale a step past Voltreaver's 50% / 50% and short of Pyrefang's 100% deaths. Staged in chapter
1's room at chapter 1's scale (80 HP) it still reads 30% / 70%, where Voltreaver's control reads
78% kills: the danger is the spray, not the chapter's scaling.

**The steepest step, because the content alone was easier.** Chapter 4 keeps the 1.125 base (the
cliff chapter 3 found) and steps 0.375 per floor, so the boss floor scales ×2.625. Fresh-start
floor trials, 40 seeds:

| | Floor 1 kills / clears | Floor 2 kills | Boss duel |
|---|---|---|---|
| chapter 3 (0.3125) | 27 / 33% | 14 | |
| chapter 4 at 0.3125 | 48 / 68% | 22 | 95 HP: 35% kills |
| **chapter 4 at 0.375 (shipped)** | **34 / 30%** | **3.6** | **105 HP: 35% kills** |
| chapter 4 at 0.4375 | 36 / 50% | 3.6 | 115 HP: 20% kills |

At chapter 3's own step the mirrored layout and the blightling garrison read *easier* than
chapter 3 on floor 1, so the finale needs the steeper curve just to match chapter 3 there. Floor
2 is another rounding edge: at ×1.875 the 3-HP basic mob becomes 6 HP (5 at chapter 3's ×1.75),
which is the drop from 22 kills to 3.6. Runs off floor 0 read 15/80 against chapter 3's 13: the
entrance is no harder. `chapterSim.sim.ts` gates chapter 4 the way it gates chapter 3, one
chapter on (not a wall; floor-2 kills at most three quarters of chapter 3's; no floor clearing
more often than chapter 3's; Rotbloom lands damage and poison, is beatable, and is no deadlier
than Pyrefang).

**Art and music.** The poison swatches had shipped on 2026-08-25 with no dungeon to draw them;
`theme.ts` maps `blight` to `poison`. Unlike the lightning floor, they were measured before use
and needed nothing: no saturated glow at all, as design/13's anti-camouflage rule asks. The
picker banner `chapter_blight` was made with Mistral like the other three (`art/ui/prompts.md`;
the model kept tinting the stone green, and asking for plum-grey stone is what came back
neutral). The chapter's music bed is `dungeon.blight`, "Ominous Goings-On" by Eric Matyas
(CC-BY 4.0; design/11), the one beatless loop of the six. It needed the music pack's own 3 MiB
limit raised to 4 MiB, which WeChat allows for a standard subpackage.

### The Endless Descent

> 能再加一章吗，作为无尽模式，给完全通关的玩家进行挑战

A fifth catalog entry, `endless`, unlocked by clearing chapter 4. It is a chapter in every way
the plumbing cares about (the picker cycles to it, the co-op queue and the party carry it, a save
resumes it, analytics tag it) and different in the one way the run cares about: **it has no last
floor.** Three decisions, each the recommended option of the three the owner was shown:

- **A cash-out after every boss.** Every fifth floor is a boss floor, and its portal offers
  EXTRACT (end the run, keep the bag) as well as DESCEND (keep going, the bag still at risk). A
  death still loses the whole bag, as in every chapter ([`01`](01-the-run-and-its-rooms.md) "Only
  the boss floor ends a run"). So endless brings back the push-your-luck choice the chapters gave
  up on 2026-09-10, but only at a boss kill: the rule "no banking without beating a boss" holds.
  Rejected: endless as a record only (nothing to carry out, so nothing to play for past the
  record) and keeping the bag on death (the safest farm in the game, which would empty the
  chapters).
- **The four chapters' floors in rotation.** Floors 1-5 are chapter 1's, 6-10 chapter 2's, 11-15
  chapter 3's, 16-20 chapter 4's, and floor 21 is chapter 1's first floor again, for ever. Each
  floor keeps everything its chapter gives it: map, branch layouts, garrison, boss, palette, tiles
  and music bed, so the run changes biome every five floors. Nothing new had to be authored.
  Rejected: blight's five floors on repeat (no variety) and a random floor each time (the palette
  and music would jump every floor).
- **A personal best.** `MetaState.endlessBestFloor`, synced with the account, shown on the
  picker's endless card ("ENDLESS · BEST FLOOR 27"). Kept apart from `bestFloor`, the lobby
  hero's number, which counts a chapter's five floors and would be buried by the first endless
  run. Rejected for now: a global leaderboard, which needs the server to re-judge a whole run
  before it can trust a number, and is its own project.

**The curve is the endless config's own**, read at the run's global floor index: `base` 1.125,
`perFloor` 0.25, so floor 1 is chapter 4's entrance and floor 20 spawns its mobs at x5.875. Only
enemy HP scales, as everywhere, so a deep floor is a slower fight rather than a one-shot, and
attrition is what ends a run. Material tiers plateau at 4, the deepest any chapter drops (the
chapters' identity curve would hand out tier 20 on floor 21). Weapon rarity reads the default
table, which plateaus at its last row.

**Measured with the forge starter pair.** Nobody clears chapter 4 on the starter kit, and the
bot does not either: on it, endless floor 1 lets 1 run in 40 through. So `client/sim/
endlessSim.sim.ts` carries `repeater` + `hammer`, the two pre-unlocked forge weapons. Careful bot,
40 seeds, floor index reached:

| perFloor | median | top quarter | deepest |
|---|---|---|---|
| 0.1875 | 3 | 19+ | 29 |
| **0.25 (shipped)** | **3** | **14+** | **22** |
| 0.3125 | 3 | 9+ | 19 |
| 0.375 | 3 | 5+ | 18 |

The median does not move: most runs end on lap 1's early floors whatever the step. The step
decides how far the best runs go, and at 0.25 the best few bots reach lap 2. The sim gates that
the entrance is not a wall (most runs leave floor 1), that the curve bites (the median run ends
on lap 1; at most a quarter reach lap 2), that some runs go past the first boss, that nothing
softlocks, and that a bot with its HP pinned walks two whole laps (41 floors, every boss and the
lap wrap) without getting stuck.

**One stand-off, the bot's and not the game's.** Seed 404 never ends: on endless floor 2
(chapter 1's kiln) the bot and two ranged mobs stand on opposite sides of a pillar, everyone
holding position and firing into it. A player walks round the pillar; the bot's spacing keeps it
where it is. The softlock gate reports a timeout inside a live fight and fails one anywhere else.

**The engine half** is one new optional field and one resolver. `DungeonConfig.endless.segments`
lists finite dungeons; `world/dungeon/floorSource.ts` answers, per floor, which segment and which
of its floors it is, which biome it is drawn in, and which buttons its portal offers. On every
finite dungeon each answer is what the call site read before, so all ten existing golden hashes
are unchanged and `ENGINE_VERSION` did not move. An eleventh scenario, `endless-descent`, runs the
extraction gate's two rooms as an endless segment pressing DESCEND only, and reaches floor index 5:
off two boss floors and round the lap twice. The one piece of new state is
`GameState.portalChoice`: on a two-button portal the press that opens it picks the way, and in
co-op only that button confirms after. It is hashed only when set, which no finite floor does.

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

- ~~Chapter 4 (blight)~~: done the same day, with its poison critter and its own boss.
- ~~Chapter music~~: done the same day. Each chapter has its own bed (`dungeon.ember`,
  `dungeon.frost`, `dungeon.storm`, `dungeon.blight`), open-licensed music like the rest of the
  soundtrack (design/11).
- ~~An endless mode~~: done the same day, "The Endless Descent" above.
- A global endless leaderboard, if players want one: the server re-judging a run's replay before
  it accepts the floor, the way PvP results are judged.
- Hand-authored frost, storm and blight layouts in the map editor, once players have seen the derived ones.
- A player's verdict on all of it. Every number above is a bot that never dodges on purpose,
  and endless's curve most of all: the bot carries the cheapest forge kit, and a player who
  cleared chapter 4 carries better.
- Whether chapter 3's entrance should be harder. Not by `base`, which is a cliff; a garrison
  change (fewer 3-HP basics, more galvanists) would be the knob, and it needs a player's
  verdict on chapter 2 first.
