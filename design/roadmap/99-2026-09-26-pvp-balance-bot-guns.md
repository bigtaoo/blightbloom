# Work log — 2026-09-26

Volume 99. See [`design/ROADMAP.md`](../ROADMAP.md) for the index and the phase spine.

## The PvP balance pass, and a bot that swaps guns (2026-09-26, engine + tools + test + docs, `ENGINE_VERSION` 77)

Step 4's balance item. The plan had two asks:

- make "a strong weapon runs its energy dry" measurable in PvE;
- retune PvP (`PVP_SCALE_FACTOR`, zone parameters, and a new damage multiplier for a parried
  player's bullet) on sim data.

Both instruments had to be fixed before either could answer. One of the two fixes turned out to be
an engine bug, not a bot one.

### PvE: a bot that opens chests and takes a better gun

`client/sim/pve/PveBotController.ts` fought every floor with the starter blaster, so
`weaponFireStats` read `blaster 100%` on every sweep. It had three blind spots:

- it never walked up to a chest;
- the capstone was often nearer than the dead-end chest room;
- it had no notion of a better gun.

Now it does these, all behind `BotProfile.swapsWeapons`, and with it off the bot is byte-for-byte
the old one:

- **Chests.** It opens a small chest in its own quiet room. For a big chest, it stands on the
  chest's free plate.
- **Better guns.**
  - It takes a floor weapon only if it is **ranged and of strictly higher rarity**, so the gun a
    swap drops can never lure it back.
  - It walks to the gun and clicks it through `pickupTargetId` once inside `SIM.lootRevealRadius`,
    the same reach the pickup panel uses.
  - It fights first, and loots only when the room is quiet.
- **Spacing.** After a swap it re-spaces for the new gun. The rule moved out of
  `weaponSweep.sim.ts` into `sim/pve/weaponStandoff.ts`, so the sweep and the bot share it.
  - The gun it started with keeps the base spacing.
  - The first attempt re-spaced the starter too, and the careful profile's average floor fell from
    0.5 to 0, with no swap involved.
- **Room order.** `nextObjectiveRoom` leaves the capstone for last while other rooms remain.

The tracker adds held and dry ticks per weapon, and `reportFire` adds a `dry%` column:

| Weapon | Dry % |
|---|---|
| blaster | 5 |
| repeater | 12 |
| flamer | 33 |
| mortar | 49 |
| carom | 56 |
| frostseeker | 59 |

That is the measurement the plan asked for. The strong frames run their pool dry about half the
time they are held. The careful profile's average floor is 0.4 (it was 0.5), with 47.3 kills, and
the gates pass.

### PvP: the zone was measuring itself

The first sweep said the zone dealt about 74% of all damage and that 39% of deaths were zone kills.
That made the character win rates mostly a measure of who survives standing in the storm. There
were two causes.

1. **The bot.**
   - `PvpBotController` chased the nearest opponent wherever that led. It now calls
     `controllers/ai/zoneRetreat.ts` first. That does a BFS over the door graph to the nearest room
     that stays safe, counting a WARN's closing rooms as unsafe. It walks to the passage centre,
     then to the next room's centre, and fires at anyone in range on the way.
   - It also stops the chase at the edge of the safe area. It shoots at an opponent standing in the
     storm but does not follow.
   - The same bot fills empty seats in real matches (`server/src/BotClient.ts`), so this is a
     live-play improvement too.
2. **The engine.**
   - A trace of the "stuck in the zone" seats showed they were **downed**: alive, frozen, HP at −1
     and falling to −46.
   - "Downed = invulnerable" (design/07, 3.2) held for bullets, blades and status effects, but
     `EnvironmentSystem` still ticked zone damage and hazard-tile damage on a downed body for its
     whole 900-tick bleedout, with a floating number each tick.
   - It changed no outcome, because only bleedout ends a downed player. But it owned the damage
     total.
   - A downed player is now skipped. Their `roomId` is still tracked, since a revive stands them
     up where they lie.

With both fixed, the zone deals about 2.5% of all damage and almost no deaths.

### PvP: the numbers

The sample is 540 matches: 2, 3, 4, 5, 6 and 8 seats × 90 seeds, with skins shuffled per seed to
remove the seat confound.

| Pools (vanguard, skirmisher, juggernaut) | Vanguard | Skirmisher | Juggernaut | Ties | Timeouts |
|---|---|---|---|---|---|
| shipped: 30/16, 15/30, 55/0 | 36% | 46% | 17% | 1 | 0 |
| **juggernaut 75/0** | 35% | 44% | **21%** | 1 | 0 |
| juggernaut 85/0 | 34% | 43% | 21% | 5 | 2 |
| juggernaut 85/0, skirmisher 15/26 | 35% | 42% | 21% | 6 | 2 |

The 180-match pass also tried juggernaut 65/0 and 95/0. They read 16% and 21%.

- **Juggernaut's arena pool goes 55/0 → 75/0.** Beyond 75 it bought nothing but ties and timeouts.
  - The plateau is the character's identity, not its size: no shield means no regen, and a
    multi-fight FFA rewards regen.
  - Changing that is a design question, not a number.
  - The PvE ordering the roster test demands still holds: highest HP, zero shield. A new
    `skins.test.ts` case pins that the three arena budgets (46 / 45 / 75) stay distinct.
- **`PVP_SCALE_FACTOR` stays 5.**
  - 4 and 6 gave identical win rates, although damage per shot really did change (verified at 4
    and 8).
  - Outcomes are set by shots-to-kill breakpoints, not the absolute scale.
- **The zone parameters stay.** Once the bot walks out, the zone no longer decides matches, so
  there is nothing on this data to tune it against.
- **A parried rival player's bullet keeps half its damage.**
  - The rule is `PVP_DEFLECT_DAMAGE_PERMILLE` 500 and `deflectedPlayerDamage` (rounded, never
    below 1), in `balance/build.ts`.
  - `DeflectSystem` scales the bullet before its faction flips. An enemy's bullet is untouched, so
    PvE and co-op are unchanged.
  - **The 500 is the owner's starting number, not a measured one.** The bot never swings its
    blade, and all 540 matches recorded zero deflects.
  - Pricing the parry needs a bot that parries, or real play.

### Tests

- **`engine/systems/zone.test.ts`**: a downed player in a closed room takes nothing and raises no
  `zone_damage` or `hit`, yet its `roomId` is still tracked. As a control, the same body stood
  back up is hit on the next tick.
- **`engine/systems/teamHostility.test.ts`**:
  - a rival's parried shot comes back at the per-mille rate, while a mob's parried in the same
    swing stays at full damage;
  - the rounding and floor of `deflectedPlayerDamage`.
- **`engine/content/skins.test.ts`**: arena budgets are distinct.
- **`client/src/game/controllers/ai/zoneRetreat.test.ts`**, new: every early return, the one-hop
  heading, gate-then-centre, WARN versus stale `closing`, the fire-range boundary, and
  `roomIsUnsafe`.
- **`client/src/game/controllers/pvpBot.test.ts`**:
  - the bot walks out, away from the opponent it would otherwise chase;
  - it holds fire position rather than follow an opponent into the storm, with a control where
    the room is safe.
- **`client/sim/pve/PveBotController.test.ts`**: chests, plates, better guns, the reach gate, the
  strictly-better rule, never-melee, fight-first, the `swapsWeapons` off switch, starter versus
  swapped spacing, and capstone-last.

### Replays

Every arena replay diverges: a downed seat's HP, a parried shot's damage, and the juggernaut's
seat. The golden fixture was regenerated. The hashes moved and the witness columns did not.
