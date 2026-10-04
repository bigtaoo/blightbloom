# Work log — 2026-10-04

Volume 127. See [`design/ROADMAP.md`](../ROADMAP.md) for the index and the phase spine.

## The PvP win counts, read against seat share (2026-10-04, tools + test + docs, no ENGINE_VERSION change)

Volume 123 left this open: when the PvP bot learned to loot and draw its blade, wins went from
72 / 57 / 51 (vanguard / skirmisher / juggernaut) to 59 / 68 / 52. That came from one sweep of
180 matches, and a tuning pass would want more seeds first.

### Six blocks, both bots

`test:pvp-sim`'s match harness, unchanged, ran six blocks of 180 matches: the shipped seeds, plus
five fresh blocks at a different seed base. Every block ran with the bot as it ships, and again
with `loots: false, bladeWhenDry: false`, volume 123's "before". Block 0 reproduces volume 123
exactly, both rows. The scratch harness is not kept, since it only looped the shipped
`runMatch`.

| block | before v / s / j | after v / s / j |
|---|---|---|
| 0 (shipped seeds) | 72 / 57 / 51 | 59 / 68 / 52 |
| 1 | 58 / 59 / 63 | 67 / 53 / 59 |
| 2 | 68 / 63 / 49 | 56 / 53 / 67 |
| 3 | 54 / 57 / 68 | 60 / 55 / 64 |
| 4 | 53 / 69 / 58 | 61 / 67 / 51 |
| 5 | 53 / 65 / 60 | 54 / 64 / 59 |
| all | 358 / 370 / 349 | 357 / 360 / 352 |

- **The swing was noise.** Over the same 900 matches at 2 to 6 seats, looting and
  the dry blade move vanguard by +4 wins and skirmisher by −11, each about half a standard
  deviation (~20). Block 0 happened to be vanguard's best "before" block. A single block's
  vanguard count runs from 53 to 72.

### The counts were never comparable

The raw totals look level. They are not a like-for-like count. `buildPvpEngineConfig` gives seat
i the (i mod 3)-th character, and the sim's shuffle only moves characters between seats. So each
match has this many seats per character:

| seats | vanguard | skirmisher | juggernaut |
|---|---|---|---|
| 2 | 1 | 1 | 0 |
| 3 | 1 | 1 | 1 |
| 4 | 2 | 1 | 1 |
| 5 | 2 | 2 | 1 |
| 6 | 2 | 2 | 2 |
| 8 | 3 | 3 | 2 |

The juggernaut never plays a 2-seat match and is the odd one out at 4 and 5 seats. Its fair share
of wins is each match's juggernaut seats over its seats, summed. Over the 900 matches at 2 to 6
seats (8 seats left out: its "winner" is whichever squad member comes first):

| | vanguard | skirmisher | juggernaut |
|---|---|---|---|
| before: wins / fair share | 289 / 371 = **0.78** (z −5.6) | 320 / 326 = 0.98 (z −0.4) | 288 / 200 = **1.44** (z +7.3) |
| after: wins / fair share | 293 / 368 = **0.80** (z −5.1) | 309 / 323 = 0.96 (z −1.0) | 287 / 198 = **1.45** (z +7.5) |

- **The bot-vs-bot juggernaut wins about 45% more than its share, and vanguard about 20% less.**
  It holds with either bot, in every one of the six blocks, and at 3, 5 and 6 seats
  separately. At 3 and 6 seats, where every character has the same seats, the shipped bot's juggernaut
  takes 88 and 91 of about 178 matches, against a par of 59.
- **Skirmisher is at par.**
- **This is a bot reading, not a verdict.** The juggernaut is the pure-HP body (`content/skins.ts`).
  The bot never disengages to let a shield refill, which may favour the build with the least
  shield. The open question for the owner is whether to playtest it or tune it.

### The instrument

`pvpBalanceSim.sim.ts` now prints both lines:

- the raw wins, labelled as not comparable;
- wins over fair share at 2 to 6 seats, with 1.00 as par.

It also asserts the fair shares sum to the decided matches, so a change to the seat count or the
character list cannot quietly break the arithmetic. The arithmetic itself lives in
`client/sim/pvp/fairShare.ts`, with its own test: the share per seat, the absent character owed
nothing, ties and 8-seat matches left out, and the sum. The shipped seeds read vanguard 0.84,
skirmisher 1.07 and juggernaut 1.18. That is one block, the noisiest view; the table above is the
read.

### Still open

- ~~**The juggernaut's lead in bot-vs-bot FFA:** playtest or tune.~~ Answered the same day in
  [volume 128](128-2026-10-04-pvp-shield-retreat.md): it is the bot's, which never lets a shield
  refill. A bot that backs off to refill one puts the juggernaut at par. No character is tuned.
