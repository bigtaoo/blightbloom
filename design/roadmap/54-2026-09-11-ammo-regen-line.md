# Work log — 2026-09-11

Volume 54. See [`design/ROADMAP.md`](../ROADMAP.md) for the index and the phase spine.

## The clock was the whole supply (2026-09-11, engine + client + docs, `ENGINE_VERSION` 61→62)

> *"现在的子弹自动回复速度太快了，地图上掉落的子弹价值变得非常低。"*

The auto-refill is too fast, so the ammo lying on the floor is worth almost nothing. One
constant moved — `ENERGY_REGEN_PER_SEC` 20 → 15, as `+1` every 2 ticks instead of `+2` every
3 — and no price in `content/weaponSpecs/` moved at all. What that does is re-classify the
whole roster against a new line at once: the starter `blaster` (15/s) lands exactly **on** it,
`repeater` (20/s) crosses **above** it, and every other gun's regen-paced floor rate drops by a
quarter.

### The report was right, and it was understating it

Measured before anything changed, over 8 careful bot runs of the shipped level:

| loadout | spend funded by the CLOCK | by the FLOOR |
|---|---|---|
| `blaster` (fresh save) | 97.6% | 2.4% |
| `scattergun` | 97.9% | 2.1% |
| `novaburst` | 98.0% | 2.0% |

**98% of every shot fired came off the clock**, at every point of the roster — the most
expensive gun in the game funded itself out of regen as thoroughly as the starter did. That is
the complaint as a number: the clock was not supplementing the floor's refills, it was the
supply.

**What that ratio is made of is the part that decides what can move it.** It is
`collected × ENERGY_PICKUP_AMOUNT` over a floor's total spend, and *neither term moves with the
regen rate*: a floor drops ~7 refills (~210 energy) against ~2000 energy of pulls, so ~10% is the
ceiling the drop table sets even at perfect collection, and the sim still reads 1-2% after this
change. **Lowering regen does not raise the floor's share of supply.** It changes whether the
shortfall is felt at all. `ENERGY_PICKUP_AMOUNT` stayed 30 for the same reason — at 2% of
supply, the refill's size was never the binding term.

### So the fix is the LINE, because the line is what decides whether a deficit exists at all

At 20/s the clock covered a continuously-firing starter outright, so a refill topped up a bar
that refilled itself in five seconds. At 15/s, holding the starter's trigger down neither drains
nor fills. The floor of the economy stays exactly where a fresh save can live on it, and
everything *on top of* that — a `rof_up` stack, a burst, the first interesting gun the floor
hands you — now comes out of the pool and has to be bought back.

Measured after: **22.6% of live ticks hold a gun the pool cannot pay for**, up from 0.9%, with
the **average floor reached unmoved at 0.75** (kills per run 68.4 → 62, run length 120.7s →
115.6s — the bot spends longer per kill without getting less far).

**10/s was measured and rejected.** Same ~23% dry, but average floor reached fell 0.75 → 0.50.
That is the difference between an economy that paces the player and one that re-tunes the level
from underneath, and only the first was asked for. The other rejected shape was halving regen
*and* halving the starter's price to keep it comfortably sustainable: difficulty came back
identical (0.75) and so did the complaint, because the starter still outran its own drain — with
no deficit there is nothing for a refill to buy back, however slow the clock runs. **Keeping the
starter comfortably free and fixing this are the same decision, and you cannot have both.**

`repeater` crossing the line is deliberate rather than collateral: a drop-pool gun that funds
itself forever is one more gun the floor's refills are worthless to. It is now the cheapest
*paced* weapon instead of a free one, and `balance/energy.test.ts` pins the sustainable list by
NAME (`['blaster']`), because "exactly one is sustainable" would still pass if the one were
`novaburst`.

### The measurement did not exist, so it was built first

The shipped PvE sim could not have answered this. Its bot never swaps weapons, so 100% of its
pulls are the starter — and the starter was, by construction, the one gun with no ammo economy
at all. `reportFire.ts` grew three columns for the pass: `spend` (what the floor's pulls
actually cost), `clock%`/`floor%` (which half of that supply funded them), and
`refills(taken/spawned)`.

`taken` and `spawned` are deliberately separate numbers rather than a single "refills per
floor", because a low floor share has two different causes and only one of them is a drop-table
problem: supply that never reaches the player, versus a drop that is too small when it does.

**And the first thing that pair did was catch a claim this very entry made.** The original
version of it blamed the uncollected refills (12 of 100) on the usefulness gate — a full pool
refuses a refill, so they were "unpickable" — which is a mechanism, stated without a control.
The control is one line away and refutes most of it: `material` has no usefulness gate at all,
so its collection rate is the pure did-the-bot-walk-over-it baseline, and over the same runs it
reads **21.2% (77 of 364) against energy's 12.0%**. The bot misses ~80% of *everything*; most of
those uncollected refills are a bot that does not path to pickups.

What survives is smaller and worth keeping: a gated pickup is collected about half as often as
an identical ungated one over the same runs, and ~21-27% of live ticks sit at a full pool. What
does not survive is using the collection rate to judge this change at all — 12 events before and
5 after, over 8 seeds, is noise. **Report it, never conclude from it.** The numbers this pass
rests on are the supply split and `dry%`, both of which are counted per tick.

Per-pull cost is recorded on the `FireRecord` at fire time rather than looked up from the
weapon name in the report, because a run's whole point is that the gun in the slot changes —
and it is `null` on a weapon-pickup tick for the same reason `weapon` already was: the slot's
occupant after `PickupSystem` is not the one that fired, so charging that pull at the new gun's
price would make a floor that handed out a `cannon` read as if a `cannon` had been firing all
along.

`report.ts` crossed 500 lines doing this and split by TABLE (CLAUDE.md form ①): `reportFire.ts`
takes the two consumption tables, `reportRound.ts` the shared rounding leaf, and `report.ts`
keeps the room/summary/drop tables and re-exports the sibling so every `from './report'` is
unchanged.

### What the pass was pinned by afterwards, and the test that was already lying

Four tests, and the interesting half is what they say about the two that already existed.

`systems/energy.test.ts` had one called *"the starter blaster outruns its own drain over a long
hold"*, ending on `expect(energy).toBe(BASE_MAX_ENERGY)`. **It passes identically at 20/s and at
15/s** — sampling the last tick of a sawtooth says nothing about whether the sawtooth is
climbing, flat or decaying, so the test's own name had stopped being true and nothing noticed.
Rewritten to assert the SHAPE: the trough of the last third equals the trough of the first
(97 = `max - cost`, i.e. stationary rather than merely non-zero), the shot count equals exactly
what the cooldown allows (never regen-paced), and the bar is at the cap for one tick in six —
that last one pinned specifically because the first draft of this very entry claimed the
opposite in prose, and prose is not measured.

The three new ones:

- **`rof_up` takes the starter over the line, and a second one buys nothing.** design/03's
  sentence about the 15/s line, as behaviour. It is also the seconds-vs-TICKS trap:
  `buffedCooldown` rounds 6 ticks to **4**, not 4.29, so the buffed drain is 22.5/s and not the
  21.4/s the per-second arithmetic implies — and a second `rof_up` still rounds to 4, i.e. is
  pure waste on this weapon. Neither fact is visible anywhere the balance layer can see.
- **`repeater` is paced now, not free** — the v62 reclassification as engine behaviour rather
  than as a comparison between two numbers.
- **Break-even survives the conversion to ticks** (`balance/energy.test.ts`). The gate above it
  is an equality in SECONDS; energy is spent in whole ticks and `toTicks` rounds. For every
  other weapon the rounding only nudges it inside its class, but for the one authored to sit
  exactly ON the line it is the difference between the claim holding and not: at 0.22 s the
  blaster would run 6.6 → 7 ticks and quietly become sustainable-with-headroom — the pre-v62
  state — with the seconds equality still green, because seconds do not round.

Each was verified to go red: restoring the 20/s constants turns **five** tests red (three
arithmetic, plus `rof_up` and `repeater`). The rewritten starter test is deliberately NOT one of
them, and that is the point rather than a gap — a fresh save's experience is near-identical
either side, which is the whole safety argument for the change. Its comment says so, so that
nobody later "strengthens" it into a discriminator it cannot be.

### Golden: two of six scenarios, and every witness field identical

Read before the bump, which is the only time it is readable. `walls-and-pillars` and
`ember-dungeon-floor1` diverged; the other four hold a full bar for their whole run, where
regen is a no-op, so they were blind to this **by construction rather than by luck**.

**Both divergences were hash-only.** That is a red gate nobody can read — "something moved",
with no direction — and it happened because the witness carried `hpTotal` and nothing for the
game's other player-visible pool. `Witness.energyTotal` was added in the same pass, so the next
change to this economy is diagnosable from the fixture diff instead of from a pair of 32-bit
integers. It carries an anti-vacuity assertion of its own — at least one scenario must end below
a full pool, or the field is a constant that merely looks like coverage — and a measured
mutation kill in the header's battery block (`p.energy -> p.maxEnergy`, 3 failing tests, the
named diagnostic rather than a bare hash mismatch).

### One argument downstream got weaker, and is left standing on purpose

`CARD_ONLY_BUFF_IDS` keeps `cell_up` (+max energy) out of the buff drop pool, and the reason
written at `ENGINE_VERSION` 60 was that *a fresh save's pool never empties*, so the buff would
be a dead reward a fifth of the time. That premise is now false — the bar empties on 22.6% of
live ticks. The placement stands, because the *conditionality* argument survives on its own (a
capacity buff is worth nothing to a player who is not currently over the line), but it is now a
judgement rather than a near-tautology, and `drops.ts` says so at the definition rather than
leaving a comment that quietly stopped being true. Moving it would change the buff pool's
indexing and therefore the `dropPrng` draw sequence — a version bump, not a tweak.
