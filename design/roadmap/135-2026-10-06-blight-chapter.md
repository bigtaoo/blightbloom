# Work log — 2026-10-06

Volume 135. See [`design/ROADMAP.md`](../ROADMAP.md) for the index and the phase spine.

## Chapter 4, the Blight Descent: blightling, Rotbloom, and the finale (2026-10-06, engine + client + art + audio + sim + docs, no ENGINE_VERSION change)

> 继续做第四章

The owner asked for chapter 4 straight after chapter 3 shipped ([volume 134](134-2026-10-06-storm-chapter.md)).
It had been waiting on content: its garrison leads with a poison critter, and none existed. All
four planned chapters now exist. The design account is
[`04-chapters.md` "Chapter 4, the Blight Descent"](../gameplay/04-chapters.md#chapter-4-the-blight-descent);
this entry records what was built and what was measured on the way.

### The poison critter

`blightling` (`engine/content/enemies.ts`): the shared critter re-tinted to design/13's locked
`#9CCC65`, 4 HP, shrugs poison (×0.4), burns to fire (×1.8). It is the fifth locked elemental
variant and carries the `poison` element badge (the skull), so the tests that pinned exactly four
badged variants now pin five, and the comments and design/09, design/13 sentences that said
"four" or "poison has no dedicated critter yet" were updated with them.

### Content: a third transform

- **`deriveChapter.mjs blight`** mirrors chapter 1 across the anti-diagonal: (x, y) ->
  (h - y, w - x), sizes swapped, west <-> south and north <-> east. Chapter 1 runs left-to-right
  and down, chapter 2 top-to-bottom, chapter 3 right-to-left and up, chapter 4 bottom-to-top
  and left.
- **Roster:** one-way, since chapter 1 has no poison mob to trade back. All 23 emberlings become
  blightlings; the 13 galvanists, 9 frostlings and 19 ironclads stay. The boss sentinel names
  `rotbloom`. Rooms are renamed mire, warren, thicket, sump, canker.
- Re-deriving frost and storm through the extended script reproduces both (line endings aside).
- **`blightLevel1.test.ts`**: the transform restated independently, no floor placing its rooms
  where any of the three earlier chapters does, the poison-led garrison, the branch skips, and
  the physical passability suite. The suite passed first time on the mirrored geometry.

### Rotbloom: why not Blightlord, and the spray that had to be faster

The plan named Blightlord as the finale's boss. Measured, it would have been the easiest boss in
the game: its single aimed bullets never land on a strafing player (0 damage in 80 bot duels).
It is also *weak* to poison, the one element the poison chapter's boss should shrug. It stays in
chapter 1's random pool, unchanged, and the finale got a new boss.

**Rotbloom** fires `enemysporespray`, a short cone of six poison spores: every one that lands adds
a poison stack, the stacks tick on after the hit, and a poisoned actor's shield does not
regenerate. It walks at you (3.4 px/tick, the roster default is 2.6, the player 6.4) and stops 4
grid away, inside its ~5-grid reach. The axis is "keep your distance". It mirrors the
blightling's resists and enrages below 40% by spraying 40% faster.

The duel sweep (careful bot, 40 seeds, boss alone at 105 HP):

| Spore spray | Duel |
|---|---|
| as authored: 6 grid/s, 1.0 s flight, every 1.0 s | 60% kills, 51 s median kill (over the 2x-chapter-1 bound of 40.6 s) |
| 6.5 grid/s | 15% kills, 85% deaths |
| **7 grid/s, every 1.4 s, 0.7 s flight (shipped)** | **35% kills, 65% deaths, 35 s, poisoned 19% of the fight** |
| 8 spores in 80° | 0% kills |

Two things the sweep showed:
- **Speed decides whether the cone lands.** Slower spores are erased by the bot's own fire,
  exactly like Voltreaver's orbs (hostile bullets annihilate).
- **Flight time is not a knob for the bot.** 0.5 s and 2.0 s read identically, 0.3 s lands
  nothing. Every spore that lands does so within ~3.5 grid, after the boss has walked the bot into
  a wall. The bot keeps a 7.5-grid standoff and still loses that distance fight, so a player who
  holds the distance does better than these numbers say.

Staged in chapter 1's room at chapter 1's 80 HP it still reads 30% / 70% (Voltreaver's control
reads 78% kills): the spray is the danger, not the chapter's scaling.

### Difficulty: the content alone was easier

Chapter 4 keeps chapter 3's base (1.125, the cliff volume 134 found) and was first run at chapter
3's step. Fresh-start floor trials, 40 seeds:

| | Floor 1 kills / clears | Floor 2 kills | Rotbloom duel |
|---|---|---|---|
| chapter 3 (0.3125) | 27 / 33% | 14 | |
| chapter 4 at 0.3125 | 48 / 68% | 22 | 95 HP: 35% kills |
| **chapter 4 at 0.375 (shipped)** | **34 / 30%** | **3.6** | **105 HP: 35% kills** |
| chapter 4 at 0.4375 | 36 / 50% | 3.6 | 115 HP: 20% kills |

At chapter 3's step the mirrored layout and the blightling garrison were *easier* than chapter
3 on floor 1, so the finale needs the steeper curve just to match chapter 3 there. Floor 2 is
another rounding edge: at ×1.875 the 3-HP basic mob becomes 6 HP. 0.4375 bought nothing on the
floors (the same 3.6 floor-2 kills) and only made the boss tankier, so 0.375 shipped: boss floor
×2.625. Runs off floor 0 read 15/80 against chapter 3's 13.

`chapterSim.sim.ts` covers chapter 4 and gained a `poisoned%` column (`chapterTrial.ts`), the
counterpart of Glacimaw's `chilled%`. Three new gates, chapter 3's shapes one chapter on:
- not a wall: at least 1/16 of seeds leave floor 0;
- harder past the entrance: floor-2 trial kills at most 0.75 of chapter 3's, and no floor
  clearing more often than chapter 3's (the 0.3125 control fails both);
- Rotbloom lands damage, poisons the player at least 10% of the fight, kills at least 10% and
  dies at least 5% of the time, is no deadlier than Pyrefang, and kills within 2x of chapter
  1's duel lengths either way.

19/19 pass.

### Golden hashes

A new scenario, `blight-dungeon-floor1` (seed 20261008), covers floor 1 like the other three
chapter scenarios. All 38 existing checks passed **before** recording, and the fixture diff is
additions only, so there is no ENGINE_VERSION bump.

**The smoke suite caught a corner, and the bug was in the test.** `engine/smoke.test.ts` drives
every golden scenario with per-tick invariants, and the new one failed "no actor is inside a
solid": an enemy 1.156 fp inside a free-standing block, against an allowance of 1. Replayed to
that tick, it was one wall and the enemy on its corner (dx 294, dy -403), nothing pushing it
back in. At a corner `pushOutOfWall` pushes along the diagonal and truncates x and y separately,
so the residue is under 1 fp on each axis and up to √2 in the measured depth. The allowance was
the face-only figure; the earlier chapters had never put an actor on a corner at the wrong
tick. The same run then put an actor ~1 fp into a round pillar, whose push truncates the same
way. Both checks now share a √2 bound. The engine is unchanged; the bound still fails the
189 fp ordering bug it was tightened against in ENGINE_VERSION 49.

### Client

- `theme.ts` maps `blight` to `poison`. `assetPacks.json`'s notes no longer say poison cannot be
  reached, and the `boss` pack's note names all six bosses on `boss-core` (it still said
  "blightlord only", stale since chapter 1's second boss).
- The picker's look (`chapter_blight`, dark moss fill, poison-green frame), `chapter.blight.name`
  and `weapon.enemysporespray.name` in all eight locales ("The Blight Descent" / 枯潮深渊).
- `ChapterPicker.test.ts` gains chapter 4, locked behind chapter 3. `chapterProgress`'s
  "last chapter" case is now `blight`, and `runSave`'s unknown chapter is `abyss`.

### Art

- **Banner.** `chapter_blight`, made with Mistral's image edit like the other three
  (`art/ui/prompts.md`). Glow hue 92° (`#9CCC65` is 88°), left-40% label area luma 51.8 / std
  2.8, 33 kB. It took five generations. Four prompts asking for neutral or cold stone came back
  mossy, teal or olive (G - R 15-26), and asking for dusky plum-grey stone is what came back
  neutral (G - R 5.8). The plum itself was not drawn.
- **Floor.** Unlike the lightning floor in volume 134, the poison swatches were measured before
  first use and needed nothing: no saturated pixel at all, as design/13's anti-camouflage rule
  asks.

### Music

`dungeon.blight` is the chapter's own bed: "Ominous Goings-On" by Eric Matyas (CC-BY 4.0,
soundimage.org via OpenGameArt), chosen the way the other five loops were (`art/audio/README.md`,
which lists every candidate and why it lost):
- **The loop:** 49.5 s from 15.0 s of the composer's looping version, no low cut needed.
- **Measurements:** seam 0.65 dB; the crossfade overlap correlates +0.05 and swells 0.14 dB;
  L/R +0.28, so it is mono-safe. It is the darkest of the six beds (2-8 kHz sits 25 dB under the
  mids), so it stays under every cue.
- **Why it beat 37 others** (28 from OpenGameArt, 10 from incompetech): it has no beat, so the
  two decks cannot flam across the fade, the failure that ruled out five of the beat-driven
  candidates. The runners-up had a heavy low end (Lightless Dawn), a 0.8 dB crossfade dip
  (Gathering Darkness) or a 1.4 dB seam (They're Here).
- The page's licence field says CC-BY 3.0 and the author's own notice says 4.0; both are allowed,
  the capture records both, and it is credited as 4.0.

**The music pack's limit moved.** It had ~150 kB left under its own 3 MiB `limitBytes`, so a
sixth loop could not fit (volume 134). The `music` pack is a standard WeChat subpackage, which
WeChat caps only through the 30 MB whole-game total, so the 3 MiB was this repo's own guard.
It is now 4 MiB, with the set at 3.26 MiB of it, and `MUSIC_BUDGET_BYTES` is 3,500,000. The whole
game is 8.63 MB of 30. No existing loop was re-encoded. The Settings sheet lists six credit lines.

Nobody has listened to it in the game.

### Not done

- Nobody has played chapter 4 by hand. Its boss is measured by a bot that kites at a fixed
  standoff and never dodges on purpose.
- Hand-authored layouts for chapters 2-4, once players have seen the derived ones.
- Chapter 1's boss pool still includes Blightlord, the boss that never lands a hit on the bot.
  That was already true and is not this pass's to change.
