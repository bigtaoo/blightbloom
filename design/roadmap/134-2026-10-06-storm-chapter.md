# Work log — 2026-10-06

Volume 134. See [`design/ROADMAP.md`](../ROADMAP.md) for the index and the phase spine.

## Chapter 3, the Storm Descent, and its boss Voltreaver (2026-10-06, engine + client + art + audio + sim + docs, no ENGINE_VERSION change)

> 继续pve

The chapter plan ([`design/gameplay/04`](../gameplay/04-chapters.md) "The order") said to build
two chapters and wait for player feedback before the third. The owner asked to carry on the same
day, so chapter 3 was built the way chapter 2 was. Chapter 4 still waits: its garrison leads with
a poison critter that does not exist yet. The design account is
[`04-chapters.md` "Chapter 3, the Storm Descent"](../gameplay/04-chapters.md#chapter-3-the-storm-descent);
this entry records what was built and what was measured on the way.

### Content: a second transform

- **`tools/map-editor/scripts/deriveChapter.mjs` takes the chapter now.** One table holds each
  derived chapter's geometry, roster swap and room names. `frost` is the old transpose.
  `storm` is a **half-turn**: each piece is turned inside its own box (rect `x' = w - x - rw`,
  point `x' = w - x`), and each floor inside its bounding box, which only the source pieces'
  sizes can tell. Re-deriving frost through the new script reproduces its committed JSON
  exactly (the only diff was line endings), so the refactor changed nothing that shipped.
- **`world/dungeons/storm/`**: 17 pieces, 8 floor maps. Emberlings and galvanists trade places
  (23 and 13 in chapter 1), and the boss sentinel names `voltreaver`. Rooms are renamed:
  spire, coil, dynamo, conduit, maelstrom.
- **`engine/world/rooms/storm.ts`** and the catalog entry. `CHAPTER_ORDER` is
  `['ember', 'frost', 'storm']`.
- **`stormLevel1.test.ts`**: the same two halves as frost's. The JSON must still be the
  transform, restated independently of the script, and it must pass the physical passability
  suite. It adds one check frost did not need: no floor places its rooms where chapter 1 or 2
  does. The suite passed first time on the turned geometry, where every north-wall brim now
  sits on what was a south wall.

### Voltreaver: the orbs that never landed

The boss and its loadout (`enemyarcseeker`, homing lightning orbs) were authored first and then
measured. As authored they were harmless. In the bot duel the boss died every time, and the bot
took **zero damage in 40 fights**. The orbs launched in an 80° fan straight down the line the bot
was already firing along, at 5 grid/s, and the bot's own stream of bullets erased every volley
(hostile bullets annihilate). The sweep walked the knobs until the orbs landed:

| Change | Duel (boss alone, 90 HP) |
|---|---|
| 160° fan, so the orbs close from the flanks | still 100% kills, 0 damage |
| + 6 grid/s, 160°/s turn, every 1.4 s | 100% kills, 0 damage |
| + 7 grid/s, 140°/s | 98% kills |
| **+ 7 grid/s, 160°/s (shipped)** | **57% kills, 43% deaths** |
| + 7 grid/s, 180°/s, every 1.6 s | 33% kills, 70% deaths |

At the boss floor's real scale (95 HP) it reads 50% / 50%. That is between Glacimaw (23% kills)
and the chapter-1 bosses whose single aimed bullets never reach the strafing bot. In chapter 1's
room at chapter 1's scale it reads 78% kills, so the fight is the weapon, not the chapter. One
careful full run of chapter 3 got to Voltreaver and won.

### Difficulty: the base is a cliff

Chapter 3 was authored at `base` 1.25, chapter 2's rejected value, on the theory that the third
chapter should be harder again. Runs off floor 0, careful bot, 80 seeds:

| Base | Chapter 3 | For comparison |
|---|---|---|
| 1 | 21 | chapter 1: 20 |
| 1.125 | **13** | chapter 2 at the same base: 10 |
| 1.1875 | 0 | |
| 1.25 | 3 | |

`Math.round(3 × 1.1875) = 4`. Any base above 1.125 gives the commonest mob in the game a fourth
hit point, and the entrance goes straight from chapter 2's difficulty to a wall, with no step in
between. So chapter 3 ships chapter 2's base and a **steeper step**: 0.3125 per floor against
0.25, which puts the boss floor at ×2.375 against ×2.125. On a fresh-start floor-2 trial the bot
makes 14 kills, against 27 in chapter 2 and 23 in chapter 3 at chapter 2's step. Past floor 2
every chapter's trial is 0% clears and single-digit kills, so floor 2 is where the two curves can
be told apart.

`client/sim/chapterSim.sim.ts` now covers chapter 3. The entrance and burst gates loop over both
later chapters. Four new gates:

- chapter 3 is not a wall: at least 1/16 of seeds leave floor 0;
- its floor-2 trial kills are at most 0.75 of chapter 2's (the control at chapter 2's step fails this);
- no chapter-3 floor clears more often than chapter 2's;
- Voltreaver lands damage, kills at least 10% of the time, dies at least 5% of the time, and is
  no deadlier than Pyrefang.

14/14 pass.

### Golden hashes

A new scenario, `storm-dungeon-floor1`, covers floor 1 like the other two chapter scenarios.
The boss is not reached from there, as theirs are not. All existing hashes were checked
**before** recording and are unchanged, so there is no ENGINE_VERSION bump. The new boss and
weapon are content no existing scenario reaches.

### Client

- `theme.ts` maps `storm` to `lightning`. The `biome-lightning` swatch pack had shipped on
  2026-08-25 with no dungeon to draw it; its `assetPacks.json` note and the phase rationale say
  so now.
- The picker's look (`chapter_storm`, slate fill, lightning-yellow frame), and
  `chapter.storm.name` plus `weapon.enemyarcseeker.name` in all eight locales.
- Four client tests had written "frost" where they meant "the last chapter" or "the next
  chapter, cycling forward": `chapterProgress`, `runSave`, `LobbyRoutes`, `MainMenu`. Each now
  says what it meant: the last chapter is `storm`; an unknown chapter is `blight`; going back to
  ember is `cycle(-1)`. `ChapterPicker.test.ts` gains chapter 3: locked behind chapter 2, not
  chapter 1.
- **Checked in the browser.**
  - On a fresh account the picker wraps back from chapter 1 to "The Storm Descent". It shows
    "Clear chapter 2 to unlock", with SOLO and CO-OP dimmed.
  - With chapters 1 and 2 cleared it reads "CHAPTER 3" in its yellow frame.
  - A solo run opens on a galvanist-led room, and the live music deck plays
    `dungeon-storm.mp3` (50 s).
  - The Settings sheet's five credit lines fit at 375x812.
  - The dev account's progress was restored afterwards.
- Server, analytics and the dashboards needed nothing. They all read the engine catalog, which
  was the point of the chapter-2 plumbing.

### Art

`chapter_storm`, generated with Mistral's image edit like the other two banners
(`art/ui/prompts.md`):
- dark slate stone, lemon-yellow crystals at hue 54° (the locked lightning hue is 54°), thin
  arcs on the shaft walls, a white-yellow glow in the depths;
- left-40% label area at luma 55, std 3.2;
- asked for and not drawn: an indigo tint, rain, and bold forked bolts.

38 kB.

**The lightning floor had been drawn as a fire floor, and chapter 3 was the first to show it.**
Starting a storm run in the browser put galvanists on a floor with red-orange crack glow.
`floor_lightning.png` had shipped on 2026-08-02. Its glow measures hue 12°, exactly
`floor_fire`'s, against a prompt asking for a yellow static glow. No dungeon had ever mapped to
`lightning`, so nothing could show it. The fix is a documented mechanical step, with the raw
left as the generator's bytes:
- the warm, saturated pixels (0.70%, the crack glow alone) have their hue set to 54°;
- the result is compressed to 256 px as before;
- the stone's mean colour is unchanged (`art/biome/prompts.md`).

The other two lightning swatches were measured as well: the wall top is cool blue-grey, and the
wall face has a few amber pixels that read as light, not fire. Both were left alone.

### Music

`dungeon.storm` is the chapter's own bed: "Endless Cyber Runner" by Eric Matyas (CC-BY 4.0,
soundimage.org), chosen the way the other four loops were (`art/audio/README.md`):
- **The loop:** 50.0 s from 27.5 s of the composer's own looping version.
- **Measurements:** seam 1.20 dB, mid band -29.99 dBFS. L/R correlation is +0.49, so it is
  mono-safe.
- **Processing:** the 80 Hz / -10 dB shelf, because its sub band sat 6.2 dB over the mids.
- **Two checks beyond the gate:**
  - the overlap between the two decks correlates +0.06 and swells 0.3 dB;
  - at 120 bpm a 50 s loop keeps both decks' beats aligned through the fade.

  The second check is what ruled out "Electric Exodus", the runner-up: its drums flammed 80 ms
  at any round length.
- **The other rejects:** 16 files were measured. Several more repeated (their seams were
  0.0-0.4 dB, the swell problem), one was 13 dB bass-heavy, and one was too short.

The credit joins the Settings sheet's list. The music pack is now 2.85 MB of WeChat's 3.00 MB.
That leaves ~150 kB, so no sixth loop of this kind fits without raising the limit or
re-encoding. `MUSIC_BUDGET_BYTES` is 3,000,000. Nobody has listened to it in the game.

### Not done

- Chapter 4 (blight): needs its poison critter first.
- Chapter 3's entrance is no harder than chapter 2's. The knob for that is the garrison, not
  `base`, and it should wait for a player's verdict on chapter 2.
- Nobody has played chapter 3 by hand. Like chapter 2, it is measured by a bot that never dodges
  on purpose.
