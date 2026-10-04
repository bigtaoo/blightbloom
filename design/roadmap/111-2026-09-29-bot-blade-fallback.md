# Work log — 2026-09-29

Volume 111. See [`design/ROADMAP.md`](../ROADMAP.md) for the index and the phase spine.

## The PvE bot swings its blade when the gun runs dry, and stops trusting rarity (2026-09-29, tools + test + docs, no engine change)

`design/03`'s "Still open" said the PvE bot never swaps off the starter gun, so nothing could
measure an expensive frame running dry. That sentence was out of date:
[volume 99](99-2026-09-26-pvp-balance-bot-guns.md) had already taught the bot to open chests and
take a better gun. What the bot still could not do was the other half of design/03's plan, a
swap **under pressure**. A gun it could not afford left it holding FIRE on a refused trigger,
with a blade in the other slot it never touched. So "melee is the free fallback" had never been
exercised by play.

Building that turned up a second problem, which was the bigger one. The bot's idea of a better
gun was wrong.

### Rarity is not a reason to swap

Volume 99's bot took a floor gun if its rarity was strictly higher than the one it held. Over
400 careful runs, paired by seed against a bot that never swaps:

| Ordering | Avg floor | Reached floor 2 | Kills | Runs that swapped |
| --- | --- | --- | --- | --- |
| never swap | 0.468 | 68 | 52.4 | 0 |
| rarity (volume 99) | **0.390** | **46** | 45.8 | 67 |
| authored dps | 0.458 | 58 | 51.8 | 39 |
| sustained dps (energy-capped) | 0.455 | 60 | 51.8 | 20 |
| sustained dps × reach fit | 0.472 | 64 | 53.4 | 11 |

A rarity swap left the run worse on **46 of the 67 seeds** it happened on. By gun, the worst
were `seeker` (8 of 8 worse), `scattergun` (5 of 5) and `lasercutter` (5 of 7). `teslagun`,
`repeater` and `flamer` came out ahead.

The repo already says why. `design/03` measures mean dps **falling** with rarity (`fine` 8.41,
`epic` 5.63, `legend` 3.75): rarity buys a mechanic, not pace. A bot that kites and holds the
trigger can only use pace. So "strictly rarer" walked it, again and again, from a common gun to
a slower one.

The bot now orders guns by their authored `dps` axis (`weaponProfile`). None of the orderings
made a swap *pay*: each dps-based one reads level with never swapping. `dps` was picked
because it is neutral and exercises the most looted frames (39 swapping seeds, against 20 and
11 for the energy-aware variants). That is what the flag is for.

### The blade when the gun is dry

`BotProfile.meleeWhenDry`, on for both profiles:

- **To the blade** when the gun in hand cannot pay for a pull and an enemy shares the bot's
  room. A quiet room is not a reason to holster.
- **Back to the gun** once the pool holds half its size, or one pull if that is more. Half a
  bar is a volley. A one-pull threshold would redraw, fire once and holster every few ticks.
- The swap is a one-tick `SWAP_WEAPON` pulse with FIRE masked off. It never goes out on two
  ticks in a row, because the engine swaps on a press edge and would read that as one press.
- With the blade out, the bot spaces for the blade's own reach (`rangeGrid`), not the gun's
  standoff. `profileForWeaponId` now answers for a melee id too.

What it measured, 400 careful runs at the shipped pool:

- Dry ticks on floors 1 and 2 fall from **21% and 23%** of live ticks to **0.5% and 0.8%**.
- The blade takes about 1.3% of all pulls. The shipped sim's `melee%` column reads **4 / 3 / 8%**
  on floors 1–3. It had read 0 on every sweep since the column existed.
- **Outcome does not move.** The blade alone reads avg floor 0.43, against 0.44 without it,
  over 96 seeds. With the dps ordering too, it reads 0.458, against 0.453 for the old bot.

So the fallback is now measured, and for a kiter at the shipped pools it is neutral. It is not
a free power-up, and it is not a trap.

### The capacity table, re-run

`design/03`'s v60 table found capacity to be "a texture stat, not a power stat". That table
came from 8 runs of a bot that never swapped. Here it is at 400 runs, `vanguard`'s pool
varied, all else fixed:

| Pool | Old bot: avg floor | Old bot: dry f1 / f2 | New bot: avg floor | New bot: dry f1 / f2 | New bot: melee % of pulls |
| --- | --- | --- | --- | --- | --- |
| 30 | 0.372 | 38% / 46% | **0.270** | 1.5% / 2.5% | 0.6 |
| 70 | 0.463 | 26% / 31% | 0.432 | 0.8% / 1.4% | 1.4 |
| 100 (shipped) | 0.453 | 21% / 23% | 0.458 | 0.5% / 0.8% | 1.3 |
| 130 | 0.455 | 19% / 18% | 0.430 | 0.2% / 0.8% | 1.1 |

- **Across the roster's own pools (70, 100, 130) capacity is still texture**, with either bot.
- **Below them it is power.** At 30, both bots lose depth. The new bot loses more, and on floor
  0 (71 of 400 runs descend, against 87). A bar that small sends it to the blade, and a kiter
  that has to close in takes the hits kiting avoided. No shipped character has a pool under
  70, so this bounds how far a future character can go rather than describing one.
- `dry%` no longer measures pressure on its own once the bot holsters. That pressure now shows
  as blade share. Read the two columns together.

### The weapon sweep had been measuring the bot since 2026-09-26

`weaponSweep.sim.ts` builds its bot from `BOT_PROFILES.careful`, so it inherited volume 99's
`swapsWeapons`. It then inherited this pass's `meleeWhenDry` too. A per-weapon sweep has to
finish the run holding the weapon it staged. Both flags are now pinned off there (`PINNED`).
Against the same sweep run just before this pass, the swept numbers moved:

| Weapon | Kills, inheriting the swap | Kills, pinned |
| --- | --- | --- |
| `frostbrand` | 428 | 630 |
| `flamer` | 662 | 837 |
| `teslagun` | 296 | 267 |
| `blaster`, `carom`, `seeker`, `mortar`, `novaburst` | unchanged | unchanged |

With `meleeWhenDry` inherited as well, `frostbrand` read 52: a blade loadout redrew the starter
gun at half a bar. Treat any sweep reading from 2026-09-26 to this pass as confounded for a
weapon the bot could swap away from.

### Tests

`client/sim/pve/PveBotController.test.ts` adds 11 cases:

- one for the dps ordering, with a control;
- ten for the blade: the affordability boundary, the quiet-room refusal, the press-edge guard,
  blade spacing (including with `swapsWeapons` off), the half-bar redraw on both sides, a
  quiet-room redraw, the flag off, and no blade to swap to.

The fixture now carries each gun's real spec, so `energyCost` is real.

Both rules (`gunWorth` and `bladeSwapDue`) live in a new `sim/pve/weaponChoice.ts` of pure
functions, which keeps `PveBotController.ts` under 500 lines. The split is byte-identical: the
shipped PvE sim reads the same 2734 average ticks and 50.2 kills before and after it.

A mutation battery of 8 ran over the new logic: the boundary operator, the edge guard,
`REARM_FRAC`, the room gate, the FIRE mask, rarity ordering restored, and the blade's spacing
and reach. All 8 are killed. The spacing mutant first **survived**, because every case ran with
both flags on. The `swapsWeapons`-off case is what killed it.

`npm run test:pve-sim` passes all 11 of its gates. `npm run test:weapon-sim` passes all 5.

### Still open

- **The PvP bot still never parries.** `PVP_DEFLECT_DAMAGE_PERMILLE` is still unmeasured, per
  volume 99. This pass gave the *PvE* bot a blade, and only as a fallback; it swings at mobs,
  not at bullets. *(The capacity sim's bot parries since [volume 117](117-2026-09-29-pvp-capacity.md);
  the shipped arena bot still does not.)* **Closed 2026-10-03, [volume 122](122-2026-10-03-pvp-bot-parry.md):
  the shipped bot parries one bullet in two, and 180 sim matches see 2,579 rebounds land.**
- **No ordering made a looted gun pay** for this bot. Whether that is the bot (it cannot use a
  mechanic) or the roster (the frames really are side-grades for anyone who kites) is a
  question a person playing can answer and this harness cannot.
