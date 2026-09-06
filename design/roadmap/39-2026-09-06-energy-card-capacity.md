# Work log — 2026-09-06: the three things volume 38 wrote down and did not do

Volume 39. One `ENGINE_VERSION` bump (60) closing two of the three gaps volume 38 named for
itself, and — later the same day, once the owner ran the prompts this pass wrote — the third
one too, render-only and bumping nothing.

Indexed from [`../ROADMAP.md`](../ROADMAP.md).

## The energy card, and the first buff a floor can never drop (2026-09-06, engine + client, `ENGINE_VERSION` 60)

Volume 38's own words: *"a fifth buff family touches `RUN_BUFFS`/`BUFF_CAPS`/`applyBuff` and
wants its own measured pass."* This is that pass.

The mechanical half is small and follows `flat_hp` exactly. `RunBuffKind` grew `flat_energy`,
`RUN_BUFFS` grew `cell_up` (+30), `BUFF_CAPS` grew a ceiling of 120 — four picks exactly, so
no pick is ever a fractional dud — and `FLOOR_CARDS` grew `capacitor`, which grants it.
`PickupSystem.applyBuff` now reads ONE `sumBuffs` pair and applies both absolute families off
it, so the two deltas cannot disagree about which stack they were computed from, and it grows
the current value alongside the ceiling for energy exactly as it already did for HP.

That last part is the one thing in this half worth arguing about, and the argument decided it:
a card that raised the cap without filling it would hand a player who took it *while empty*
nothing at all until regen caught up — which is precisely the moment they picked it for.

### The interesting half: it is deliberately undroppable

`cell_up` is the only id in the catalogue that `BUFF_DROP_POOL` cannot roll.

The reason is that it is the first **conditional** reward in the set. The other four families
are worth something to every player in every run; capacity is worth exactly nothing to a
player still on the starter blaster, which volume 38 deliberately priced *below* the regen
line, so a fresh save's bar never empties at all. As a fifth entry in the drop pool that would
spend a fifth of a run's buff drops on a reward most players cannot yet use — paid for by
diluting four families that always do something.

A pick-one-of-three offer is the right home for a reward whose value depends on what you are
currently holding. The player carrying a 26-cost frame takes `capacitor`; the player carrying
a blaster takes `edge`; neither pick is wasted, which is not true of a drop.

`content/drops.ts`'s new `CARD_ONLY_BUFF_IDS` names the exclusion rather than leaving it as an
absence, and `drops.test.ts` requires every catalogue id to appear in **exactly one** of the
two lists. Without that, "deliberately undroppable" and "somebody forgot to add it to the
pool" look identical from outside, and the second one ships a buff no player can ever obtain.

### One bug this pass created and caught in the same breath

`floorCardDescVars`' absolute arm was keyed on the literal `'flat_hp'`. `capacitor` fell
through to the per-mille branch, and a 30-point buff rendered as **"+3 max energy"** — in
eight locales, with nothing in the tree failing. It is keyed on the `flat_` prefix now, and
the test that pins it says what it is for.

## `MAX_ENERGY` becomes a character stat (same version)

Volume 38 deferred this with a real reason, not a shrug: making capacity a character trait
*"would put a raw ammo ladder on the one meta axis that reaches PvP."*

What resolves it is a property of the pool rather than a compromise about it:

> **Capacity buys burst. It provably cannot buy sustain.** Energy regen is a flat shared
> constant, so on an empty bar every character in the game fires at exactly
> `ENERGY_REGEN_PER_SEC / energyCost` shots per second no matter how big their pool is. A
> deeper bar is a longer opening, never a higher ceiling.

So the worst a paid character could ever be sold on this axis is *front-loaded*, not
*stronger* — which is the thing `design/14`'s side-grade rule actually forbids.

`MAX_ENERGY` is now `BASE_MAX_ENERGY`, documented as what it always really was: the reference
pool the whole `energyCost` table was priced against, and the default character's own. That
identity is pinned — if `vanguard`'s capacity drifts off it, every price in
`content/weaponSpecs/` is silently re-based and nothing else in the tree would say so.

### The roster spreads opposite to the body

| character | body | pool | why |
|---|---|---|---|
| `skirmisher` | 3 HP / 6 shield | **130** | cannot win a long trade, so it gets the longest short one |
| `vanguard` | 6 / 3.2 | **100** | the reference pool, by definition |
| `juggernaut` | 11 / 0 | **70** | its fights are long by construction, and length is the regime where capacity stops mattering |

`skins.test.ts` pins that DIRECTION by name — deepest pool on the smallest body — not merely
that the three differ. A pass that flipped it would still satisfy Pareto non-domination and
the per-axis spread check while making the fragile character strictly worse in both regimes.

Three consequences that each needed deciding rather than falling out:

- **The Pareto rule widened to the triple, and got STRICTER doing it** — a would-be
  all-rounder now has one more column it has to lose on. Note which way that cuts: it would
  now be *legal* to hand a character both the biggest body and the biggest shield as long as
  it had the smallest pool. Which is why the equal-worth budget band still sums only the two
  DEFENSIVE axes. Energy is not denominated in hit points; adding them would be an invented
  exchange rate of exactly the kind `design/03` refuses to make up, and at ~100 it would
  swamp a 9-point body budget outright.
- **`ENERGY_PICKUP_AMOUNT` stays a flat 30**, so a refill is worth proportionally more to the
  shallow bar than to the deep one — the juggernaut's compensation, now pinned so a later
  pass cannot quietly turn it into a fraction of `maxEnergy` and hand the deepest bar the
  biggest refill as well.
- **The arena carries it through UNSCALED.** `PVP_SCALE_FACTOR` multiplies `maxHp`/`maxShield`
  *because* it multiplies weapon damage alongside them, which is what preserves relative TTK.
  `energyCost` is not scaled at all, so a ×5 pool would not preserve a ratio — it would delete
  the ammo economy from PvP outright. Asserted against the raw `SkinDef` number rather than
  against "not 5×", so the claim survives a retune of the factor.

The "every gun gets at least two shots off a full bar" gate also moved off the reference pool
onto the roster's **smallest**. At the old bound a 40-cost weapon could have shipped that
`juggernaut` fires once and `vanguard` fires twice — the one asymmetry a shared price table
must not have.

## The A/B came back byte-identical, and that turned out to be the finding

The PvP sim reported **85/36/56** win rates with the per-character pools, and **85/36/56**
with every pool flattened back to v59's constant. Identical to the match.

Volume 38's own lesson says what to do with that: a null result is only evidence the change
is safe if the instrument can see the change at all. A probe over 8 arena matches answered it
— **no seat's bar ever drops more than one blaster shot below full.** The landing kit is
sustainable on regen alone and the bot never swaps to a looted frame, so capacity in PvP is
not "measured and fine", it is *unmeasured*, exactly like the melee-share 0% v59 named.

### So the sim grew the column that can tell those apart

`report.ts`'s fire table gained **`dry%`** — the share of a floor's live ticks on which the
player held a ranged weapon it could not afford to pull. Deliberately not "energy === 0" (a
26-cost frame is already disarmed at 25 while a 3-cost blaster is not disarmed until 2, so a
raw zero-check would report the cheap gun as the constrained one — the exact inversion of what
the economy does), and deliberately denominated in LIVE TICKS rather than in pulls (a player
who cannot afford to fire is not firing, so a pull-denominated version would fall to zero
exactly when pressure is highest).

Holding the character fixed and varying only the pool, 8 careful bot runs of the shipped
level:

| pool | floor 0 | floor 1 | floor 2 | avg floor reached |
|---|---|---|---|---|
| 30 | 0% | 21% | 16% | 0.75 |
| 70 | 0% | 2% | 2% | 0.75 |
| 100 (shipped default) | 0% | 0% | 4% | 0.75 |
| 130 | 0% | 0% | 0% | 0.75 |

Three readings, and only the first was the one being looked for:

- **Capacity is measurable, and it is a texture stat rather than a power stat.** `dry%` moves
  with the pool; average floor reached does not move at all, at any pool, including one less
  than half the shipped floor.
- **It only ever bites deep, and not for the reason the design assumed.** Floor 0 is 0% even
  at a pool of 30, because the starter blaster is below break-even and capacity is by
  construction irrelevant to any weapon that is. What bites on floors 1-2 is a `rof_up` stack
  pushing that same blaster *over* the line — not an expensive frame, which the bot never
  fires. The ammo economy's only live pressure on a fresh save today comes from a buff that is
  supposed to be pure upside.
- The floor-2 inversion between 70 (2%) and 100 (4%) is not a measurement of capacity. A
  refusal changes the tick pattern, so the runs diverge outright — they kill 35.7 and 40
  respectively. Floor 1 is the comparable row.

## After

`npm run check`, `npm run check:logic`, the 90/90 coverage gate and all four sims green. The
golden witness was read BEFORE the bump, which is the only time it is readable at all
(`serializeState` hashes `ENGINE_VERSION` itself, so afterwards every fixture hash has moved):
**exactly one scenario diverged, `launch-arena-pvp`** — the only one that seats a non-default
character. Every PvE fixture still matched, which is the empirical form of the claim that
`vanguard` still carries the reference pool.

| | v59 | v60 |
|---|---|---|
| floor 0 trigger pulls (avg, careful) | 189.1 | 189.1 |
| floor 0 complete visits (of 8) | 3 | 3 |
| floor 0 energy drops per visit | 6.6 | 6.6 |
| PvP win rate (vanguard/juggernaut/skirmisher of 180) | 85/36/56 | 85/36/56 |

The fresh-save run being byte-identical is the claim, not a null result — `vanguard` keeps the
reference pool, `cell_up` is card-only so the drop stream never moved, and `BUFF_DROP_POOL` is
untouched.

## The third gap: prompts, then pixels, same day

`enemyclaw` and `enemymaul` were the only two entries in `WEAPON_DEFS` pointing at another
weapon's texture — the player spear's and hammer's. No image-generation tool was available in
this session, so on the owner's call the gap was first closed as far as it can be without one:
two complete, copy-paste-ready GPT Image 2 prompts in `art/weapon/prompts.md`. The owner then
ran them and handed back both images, first attempt each, no rejects — so the gap closed the
whole way the same day.

The part that needed working out rather than writing down is what the prompts have to say that
none of the archived ones did. Every prompt in that file is for a PLAYER weapon, and they all
landed in the player palette — white-and-silver housing, warm gold crystal. Sampling
`gun_enemygun.png`'s actual pixels (the only enemy weapon with real art) gives the mob roster
its own: dark blue-grey housing `#202030`–`#404050`, **violet** crystal `#402080`/`#502090`/
`#7030B0`, pale-lilac highlights. At a ~40 px on-screen body the silhouette is barely legible
and colour is what actually says *this is theirs, not yours* — which is the real defect in
borrowing, since a claw that reads as player gear reads as **loot you could pick up**.

### Wiring it up found three things, and only the first was expected

**`rotationOffsetRad` had to be re-measured**, which the prompt file already predicted: the old
~-161°/+174° values were cancelling the SPEAR's and HAMMER's baked pointing direction, a
property of those files. New values -47.1° and -53.8° — not near-zero, because "socket
upper-left, business end lower-right" produces a genuinely DIAGONAL composition while
`gun_default`/`sword_default` run closer to horizontal. The method was validated against five
shipped entries before being trusted on new art; it reproduced their published numbers within a
few degrees.

**`scale` could not be inherited either, and that one nothing would have caught.** The diagonal
composition puts a ~200 px-long object inside a ~160 px-wide texture, where the archived batch's
flat strips were ~165 px long inside 160 px wide. `rigComposition.test.ts`'s module-proportion
band measures `pngWidth × scale × MODULE_SCALE` — so keeping the placeholder's divisor would have
**passed every gate while rendering these ~40% longer** than what they replace. The divisors are
picked against the object's own along-axis length instead: 55.7 vs 55.6 authoring px, 65.6 vs
65.5.

**Measuring the ANCHOR is worth ten lines, and the number that says so is not ours.** Every
previous batch eyeballed it; the table's header says so in as many words. Taking the centroid of
the alpha mass in the first 12% of the long axis instead — the middle of the connector nub rather
than the extreme pixel off the end of it — put both new entries at **0.0°** tip error, driven live
against a real target. The shipped `enemygun`, measured the same way in the same frame, is
**18.2°** off. That is the standing cost of the eyeballed-anchor convention, and it had never
been quantified.

Two things about verifying it that generalize past this batch. `worldTransform` is stale outside
a render pass and hands back the *untransformed* texture angle — the first measurement returned
exactly that, and the only tell was the reference weapon also reading "correct"; compute from the
sprite's own `rotation` and `scale` instead. And always put a SHIPPED weapon in the same frame as
the control: a harness that reports 0° for everything is not measuring anything, and `enemygun`'s
18.2° is what proves this one can fail.

The alpha needed the documented treatment too: both files came back with **zero pixels at alpha
255** — a 250-254 plateau wrapped in a 1-10 veil, exactly what `alphaClamp.mjs` exists for. The
generator also returned WebP, which nothing on the Node side of this repo can decode; Pillow
converts it losslessly (verified pixel-for-pixel, not assumed).

## Still open

- **The PvE bot never swaps off the starter gun** (`weaponFireStats` reads `blaster` 100%),
  which is what leaves the `dry%` table above unable to measure an expensive frame running
  dry, and is the same instrument gap as v59's melee-share 0%. A bot that swaps under
  pressure is the one change that would make both rows real.
- **PvP win rates are skewed and it is not this pass's doing** — vanguard takes 47% of 180
  matches against a 33% fair share, identically before and after. The 2026-07-28 retune left
  it near fair share, so something between then and now moved it; unrelated to capacity, and
  it needs its own pass.
- **`boss-core` still mounts no weapon module**, unchanged from v59.
