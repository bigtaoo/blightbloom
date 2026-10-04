# Work log — 2026-10-04

Volume 128. See [`design/ROADMAP.md`](../ROADMAP.md) for the index and the phase spine.

## The juggernaut's PvP lead is the bot's (2026-10-04, tools + docs, no ENGINE_VERSION change)

Volume 127 found the bot-vs-bot juggernaut winning about 1.4x its seat share in FFA, in every
block and with either bot. It left the owner a choice: playtest or tune. Before either, one
question could be answered from a sim: is the lead the character's, or the bot's?

### Why the bot was the suspect

The juggernaut is the pure-HP body: PvP pools of 75 HP and no shield, against vanguard's
30 + 16 and skirmisher's 15 + 30 (`content/skins.ts`). A shield refills only while its owner
takes no damage: 90 ticks idle, then +1 every 60 (`SHIELD_REGEN_DELAY`, `SHIELD_REGEN_INTERVAL`).
The shipped `PvpBotController` never disengages, so in its matches a shield is a single-use pool
and the only thing the two shielded characters buy with their smaller bodies is never paid out.
The skin comments say the shield was always meant to be the renewable half.

### The measurement

`pvp/ShieldRetreatBot` is the shipped bot, except that a seat whose shield is spent walks away
from the nearest opponent until the shield is back to half, or to full. The zone still comes
first. `test:pvp-shield` plays `test:pvp-sim`'s own matches (same config, same two
deconfoundings, now shared through `pvp/matchSetup.ts`, at 2 to 6 seats) three ways. Six blocks
of 150, block 0 being `test:pvp-sim`'s seeds, which reproduce its 0.84 / 1.07 / 1.18:

| bot | vanguard | skirmisher | juggernaut | avg ticks |
|---|---|---|---|---|
| shipped | 320 / 367.0 = 0.87 | 290 / 322.5 = 0.90 | 278 / 198.4 = **1.40** | 1891 |
| backs off to half | 410 / 371.0 = 1.11 | 298 / 326.0 = 0.91 | 189 / 200.0 = **0.94** | 2393 |
| backs off to full | 405 / 371.3 = 1.09 | 286 / 326.3 = 0.88 | 207 / 200.3 = **1.03** | 2583 |

Wins over fair share, 1.00 being par (`pvp/fairShare.ts`). The shipped juggernaut is over par
in all six blocks, at 1.18 to 1.55. Backing off to full, its six blocks run 0.87 to 1.30.

- **The lead is the bot's.** A bot that lets its shield refill takes the juggernaut from 1.40 to
  par, at either threshold. Nothing about the character changed.
- **What it hands on is smaller.** Vanguard moves to about 1.10 and skirmisher to about 0.90,
  each 2 to 3 standard deviations off par at this sample, where the juggernaut's 1.40 was
  about 6. That spread is inside what a better bot or real play could move either way.
- **Matches run longer,** 1891 ticks to 2583 at full, and every one still ends: no timeouts.

### What this does not change

- **No character is tuned.** The finding is about how the bot plays a shielded character, not
  about the characters.
- **The shipped bot is untouched.** Backing off is a stateful rule here (whether it is mid-retreat)
  and the shipped bot is a pure function of state. It also fills real PvP matches through
  `BotClient`, so teaching it to disengage is a change to what players fight, not a sim fix. It
  is listed below.
- `test:pvp-sim`'s output is unchanged: moving the two deconfoundings into `pvp/matchSetup.ts`
  left it at 59 / 68 / 52 raw and 0.84 / 1.07 / 1.18 over share.

### Files

- `client/sim/pvp/ShieldRetreatBot.ts`: the sim-only bot.
- `client/sim/pvpShieldRetreat.sim.ts` (`npm run test:pvp-shield`, own config, not in
  `test:sims`): 2 blocks by default, `PVP_SHIELD_BLOCKS=6` for the table above. It asserts no
  timeouts, that each retreating condition really regained shield, and that backing off to full
  takes more than 0.2 off the juggernaut's share (1.33 to 0.98 at 2 blocks).
- `client/sim/pvp/matchSetup.ts`: `deconfoundSkinSeating`, `startDelays` and `MAX_START_DELAY`,
  out of `pvpBalanceSim.sim.ts` unchanged.

### Still open

- **Whether the shipped PvP bot should disengage to refill its shield.** It would make
  backfilled matches play more like people do, and would end the juggernaut's lead in the
  sims. It would also make bots harder to finish off. The owner's call.
