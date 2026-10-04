# Work log — 2026-10-03

Volume 123. See [`design/ROADMAP.md`](../ROADMAP.md) for the index and the phase spine.

## The PvP bot loots, and draws its blade when its gun runs dry (2026-10-03, client + tools + test + docs, no ENGINE_VERSION change)

The owner picked the item volume 122 left open: the shipped arena bot neither looted nor fell back
to its blade when its gun ran dry. Only the sim-only `ArenaBotController` did either, and volume
117 measured both there:

- a looted gun with no fallback ran dry 9% of the time;
- the blade fallback took that under 0.1%.

Neither had reached a real seat.

### The rules

Both live in `client/src/game/controllers/ai/` and are layered into `PvpBotController`. The bot
stays a pure function of state.

- **Loot (`ai/loot.ts`).** While nothing the gun points at is in fire range, the bot walks to the
  nearest unopened crate, or to a floor gun worth more than the one it holds, within
  `LOOT_DETOUR_FP` = 8 grid.
  - "Worth" is authored dps (`gunWorth`, moved here from the PvE sim bot).
  - A gun must be worth strictly more, so the gun a pickup drops never lures the bot back.
  - It clicks a better gun inside the reveal ring whatever else it is doing.
  - The order is the zone retreat, then a revive, then loot, then the fight.
  - Loot it cannot walk to is left alone, and the fight goes on. The sim bot held still for such
    loot instead.
- **Blade when dry (`ai/dryBlade.ts`).**
  - **To the blade:** the gun in hand cannot pay for a pull and what it aims at is in fire range.
    The bot holsters the gun and draws the blade.
  - **With the blade out:** it closes in on what the gun pointed at and swings at a body inside
    the blade's reach.
  - **Back to the gun:** once `REARM_SHOTS` = 3 pulls are affordable, or a full bar if the bar
    holds fewer. The swap waits on the press edge and never cuts a swing short.
  - **Never over a commitment:** the closing walk does not override the zone's walk or a revive's.
- **With the parry (`ai/parry.ts`).**
  - The sim bot remembered *why* its blade was out. The shipped bot reads it off the pool
    instead: a blade out while the gun is not rearmed belongs to the dry rule.
  - So a blade drawn to parry stays out while the bar is low. With nothing coming, the parry rule
    leaves it alone (`parryMove(..., keepBlade)`).
- **The sim bot.** `ArenaBotController` switches all three rules off in its base. Its own flags
  now read the shipped `lootToSeek` and `drySwapDue`, so the two cannot drift apart. Its
  `shipped` profile is still the gun-only bot every capacity sweep measured. The parry stays its
  own frame-perfect rule.

### Measured

`test:pvp-sim`, the same 180 matches. "Before" is this commit with both rules off. It reproduces
volume 122's "after" row exactly.

| | guns looted | blades drawn for a dry gun | seat-ticks holding a dry gun | parries | rebounds landed | wins v / s / j | ties |
|---|---|---|---|---|---|---|---|
| before | 0 | 9 | 4,922 | 4,642 | 2,579 | 72 / 57 / 51 | 0 |
| after | 746 | 435 | 460 | 4,136 | 2,174 | 59 / 68 / 52 | 1 |

- **Dry time falls by 91%.** This is volume 117's finding, now in the shipped bot.
- **Matches are shorter at every seat count:**
  - 2 seats: 1,603 to 1,559 ticks;
  - 6 seats: 2,406 to 2,099 ticks;
  - 8 seats: 2,293 to 1,995 ticks.
- **Vanguard's lead goes.** It drops from 72 wins to 59; skirmisher rises from 57 to 68. Volume
  117 read the opposite with the sim bot (vanguard gained most). That bot also parried
  frame-perfectly, so the two do not compare directly. It is a signal for playtest, not a tuning
  verdict.
- **The "before" swap count is not zero.** Those 9 swaps are the parry rule's own, made while
  the gun happened to be dry.

### The voice cap and a bot that crowds

`test:voice-sim` failed on this change, and only at 8 seats. A bot that walks to crates and closes
in with its blade brings seats together, so more cues overlap:

| 8-seat PvP, 10 matches | cues | uncapped peak / p99 | lost at cap 16 | `impact` lost at 16 / 18 / 20 |
|---|---|---|---|---|
| both rules off | 11,464 | 18 / 14 | 0.08% (9) | 0 / 0 / 0 |
| both rules on | 8,984 | 23 / 16 | 0.39% (35) | 6 / 1 / 0 |

4 and 6 seats lose nothing at cap 16. Asked between cap 20 and the gate, the owner kept the cap at
16: it is a device budget, and whether a low-end phone can mix even that many is still unmeasured.
The gate moved instead (`voiceDemand.sim.ts`, design/11):

- cues above `impact` still lose no voice;
- `impact` may lose at most 0.5% of its voices (it lost 0.22%);
- the overall ceiling goes from 0.25% to 0.5%.

The cap-4 control still breaks all three.

### Tests

`controllers/pvpBotLoot.test.ts`, 15 cases. Each case that acts has a twin that must not, or the
same state with the rule switched off.

- **Loot:**
  - It walks to a better gun or a crate, and the control chases the rival.
  - It passes over a worse gun, a taken gun, a crate past the detour, and `spear`: a melee
    weapon rated above the blaster, which pins the ranged-only filter.
  - It does not detour while a target is in fire range.
  - It clicks a better gun inside the reveal ring mid-fight, but not a worse one.
  - In a running engine match the bot ends up holding the repeater. The control keeps the
    blaster.
- **Blade when dry:**
  - It holsters a dry gun only with a target in range, only on the press edge, and not with the
    rule off.
  - It closes in at 3 grid, where the gun bot strafes instead, and swings inside the reach.
  - It goes back to the gun at `REARM_SHOTS` pulls but not one short, and not mid-swing.
  - A bar too small for three pulls rearms when full.
  - A parry blade stays out while the gun is not rearmed. The control is the rule off, which puts
    it back.
  - A revive walk is never overridden. The control: with nobody to revive, the same blade walks
    at the rivals.
  - A seat with no gun is left alone.
  - In a running match it draws the blade, swings, and goes back to the gun.
- **Mutation battery:** 21 mutations across the four files.
  - The first pass left five alive. Two were real gaps (a taken gun, and the revive-walk guard)
    and now have cases. One was the ranged filter, now pinned by `spear`.
  - The other two were checks with no effect: a `bladeOut` that the parry rule already implies,
    and the no-gun branch of `rearmed`. Both were folded away rather than tested.
  - The control mutation is `REARM_SHOTS` = 99. Every mutation is killed.
- **`pvpBalanceSim.sim.ts`:** it now reports guns looted, dry draws and dry ticks, and gates that
  the bot loots and draws for a dry gun. With both rules off it fails.

### Still open

- Whether a real player finds a bot that charges in with its blade fair. This needs a playtest,
  like the parry share.
- An 8-seat match can now cut an `impact` short at the shipped cap, about one in 450. Whether
  that is audible is a listening call, alongside the rest of the unheard audio.
- ~~The vanguard/skirmisher swing is one sweep of 180 matches.~~ Six blocks say it was noise, and
  that the raw counts were never comparable across characters:
  [volume 127](127-2026-10-04-pvp-character-share.md).
