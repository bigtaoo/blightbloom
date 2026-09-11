# Weapon system

The heart of the game. Design goal: a very large variety of weapons with distinct behavior, where melee can block/deflect bullets.

## Categories

- **Ranged:** pistol, rifle, shotgun, laser, bullet-pattern emitter, … Parameterized: fire rate, bullet count, spread, bullet speed, ballistic shape, damage.
- **Melee:** sword, hammer, spear, … Swing arc/angle, damage, knockback, plus **block/deflect** capability.

## Damage types & status effects (shipped 2026-07-10, `ENGINE_VERSION` 8)

Every weapon carries a `damageType`; a hit is no longer a bare integer. `physical` is the plain flat-damage path, and the four elements each layer an **on-hit status** the combat systems interpret (bodies in `07`, data in `09`):

| type | on hit |
|------|--------|
| **physical** | raw damage only |
| **fire** | **burn** — a refreshing damage-over-time (topped up while you keep hitting) |
| **ice** | **chill** — a movement slow for a duration (Movement scales displacement) |
| **lightning** | **chain** — the hit arcs to the nearest other same-side actor in range |
| **poison** | **stacks** — independent stacks, each aged on its own timer (ramps with uptime) |

Enemies carry a per-type **resist/weakness** multiplier (per-mille; `1000` normal, `2000` weak/×2, `500` resist/×½), so matching the enemy's weakness melts it and hitting its resist floors toward min-1. A hit never rounds below 1. This is the axis that makes the 12-weapon roster a *choice* — plus elemental enemy variants (`emberling`/`frostling`/`galvanist`/`ironclad`) that each resist one element and are weak to a counter (`09`).

The lingering DoT/chill is ticked by a dedicated `StatusEffectSystem` (tick step 8, `08`), on a global `tick % DOT_INTERVAL` cadence so every affected actor ticks in lockstep — no per-actor clock, fully deterministic (`06`). All status math is integer/fp; the chain uses squared-distance nearest (no trig). A deflected bullet keeps its element, so a parried fire bolt burns enemies.

> **Fixed:** `applyResist` (`content/damage.ts`) rounds instead of truncating specifically on the weakness (`mult > 1000`) branch, so a base-1 hit ×1.8 shows as 2, not silently floored back to 1 — resistance (`mult < 1000`) still truncates toward the min-1 floor so it always reduces. Asymmetric on purpose (see the function's own doc comment) — a replay-affecting rounding rule, guarded by an `ENGINE_VERSION` note there.

## Weapon composition: Frame × Element

The concrete answer to this doc's opening goal ("a very large variety of weapons with distinct behavior"): a weapon is **not** hand-built one at a time — it is **composed from two orthogonal axes**, so a large roster grows from a few authored pieces (`09`'s "content is data keyed by type; special behavior is a tagged field").

| Axis | Decides | Status |
|------|---------|--------|
| **Frame** | *behavior* — how shots leave the muzzle and how they fly (or, for melee, the swing's shape) | **shipped, whole axis** — see the landing order below (`ENGINE_VERSION` 15/16). This cell read "only `straight` shipped — the main gap" until 2026-09-03, twenty lines above the table that closed it. |
| **Element** | *status layer* — burn / chill / chain / poison-stack + resist/weakness (above) | shipped (`ENGINE_VERSION` 8) |

**The bet: variety is combinatorial, not authored per weapon.** `N` ranged frames × 5 elements yields `N×5` distinct-feeling guns from `N+5` pieces. One weapon = one frame id + one **baked-in** element tag + a fixed stat row — nothing hard-coded per weapon. Element is a fixed property of the weapon (a "fire rifle" and an "ice rifle" are different weapons), not swapped by a drop.

> **No affix axis (`14`).** An earlier plan had a third **Affix** axis (roguelite per-instance rolls; rarity = roll count). It is cut — the game takes the Soul-Knight route: weapons are fixed, the in-run power layer is *better weapons + run-scoped buffs*, not weapon modifiers. **Rarity is now an intrinsic, fixed property of each weapon** (a small numeric edge + mainly better "handling/usability", never crushing — `14`), *not* a roll count. **Removed** (ROADMAP 0.1, `ENGINE_VERSION` 9→10) — the shipped affix layer (incl. the `elem_*` set-element affix from `ENGINE_VERSION 9`) is fully deleted; no `affix`/`Affix` symbol remains.

### The Frame axis — ranged

A ranged frame is **emission** (how shots leave per trigger) × **ballistic** (how each shot then moves). The two facets combine — a spread of homing pellets, a burst of lobs.

**Emission** — the `bullets` / `spreadDeg` / `burstCount` fields on `RangedSpec` (`09`), *not* a ballistic id:

| emission | how | fields |
|----------|-----|--------|
| single | one shot (baseline) | — |
| spread | shotgun cone of pellets | `bullets` `spreadDeg` (exist) |
| burst | N shots over a few ticks per trigger | `burstCount` `burstGapTicks` (new) |
| radial | ring / spiral emitter (bullet-hell) | `bullets` + `spreadDeg` ≈ 360 |

**Ballistic** (`ballistic: BallisticId`) — a per-tick velocity rule, integer/brad, deterministic (`06`/`07`). Catalog + params live in `09`. **Shipped 2026-07-24 (ROADMAP 1.1, `ENGINE_VERSION` 15/16):** `straight`/`homing`/`lob`/`beam`/`boomerang`, plus `orbit` + the radial `pattern` (tier 4 below) — the whole Frame axis (tiers 1-4) is closed, no ballistic/pattern remains unshipped:

| ballistic | behavior | params |
|-----------|----------|-----------|
| `straight` | line (baseline) — shipped | — |
| `lob` | flies like `straight`; on natural lifespan end ("landing") detonates an AoE blast through the normal resist/status hit path instead of despawning — shipped (`content/ballistics.ts`) | `blastRadius` |
| `homing` | turns `vx/vy` toward the nearest opposite-faction actor each tick, ≤`turnRateBrad`, speed preserved — shipped | `turnRateBrad` |
| `boomerang` | reverses velocity once at `returnAfterTicks`, hitting each way — shipped | `returnAfterTicks` |
| `beam` | frozen hitscan line at the fire-time origin/facing (does not track the shooter or move); damages every opposite-faction actor on the line on a `state.tick % beamTickInterval` global cadence (same lockstep pattern as DoT, `07`), for `beamTicks` total — shipped | `beamTicks` `beamTickInterval` `beamRange` |
| `orbit` | orbs circling the actor / deployables — shipped (`content/ballistics.ts`'s `orbitStep`) | `orbitRadius` `orbitAngularVelBrad` |

Showcase weapons per new frame (`content/weapons.ts`): `scattergun` (spread emission), `seeker` (homing), `mortar` (lob), `lasercutter` (beam), `tomahawk` (boomerang), `hammer`/`spear` (melee frames below) — all physical, so each frame's own behavior reads clearly independent of the element layer.

### The Frame axis — melee

Melee has no ballistic; its frame is the **swing shape** (`arcDeg` × `rangeGrid` × `swingSec`). That shape doubles as a **parry-frequency axis** — a fast narrow frame parries often (many swings), a wide slow one bats a big sector at once. Every melee frame keeps `deflect: true`, so the ranged-vs-melee trade-off (below) is untouched.

All three of those are now real numbers the sim reads. `swingSec` was the exception until `ENGINE_VERSION` 53 — authored on every melee weapon, converted by nothing, read by nowhere, so the third axis of the "swing shape" did not exist and every blade's hit window was one tick. It is now `MeleeSimSpec.swingTicks`, the active hit window of `07` step 7, and it also **paces the render** (`client/src/render/rigAttackMotion.ts`'s `swingSchedule`), so the hammer's long sweep and the spear's quick poke finally *look* as different as they are authored to be. The render layer reads that window **off the spec in `GameState`**, not off the `melee_swing` event, which deliberately carries no weapon data — only `ownerId`/`faction`/`gx`/`gy`/`facing`. Every client already holds the whole state, so an event field would be a second source of truth for a number the reader has anyway (`08`'s events-are-transient-facts rule; see `07` step 7 and `EventReactor.meleeSwinger`).

| melee frame | feel | parry character |
|-------------|------|-----------------|
| `dagger` | short arc/range, low cd, low dmg | dense small windows |
| `saber` | balanced (shipped) | baseline |
| `hammer` | wide arc, high knockback, slow — shipped (ROADMAP 1.1) | one big deflect sector, crowd control |
| `spear` | narrow arc, long reach — shipped (ROADMAP 1.1) | deflect / poke at distance |

### Landing order

**Shipped 2026-07-24 (ROADMAP 1.1, `ENGINE_VERSION` 15):**

1. ✅ `spread` — emission jitter drawn from `combatPrng`; a single-pellet weapon draws nothing (unchanged baseline).
2. ✅ `homing`, `lob` — tracking + AoE-on-landing.
3. ✅ `beam` — frozen hitscan line, damage on a global tick cadence.
4. ✅ `boomerang`, plus melee `hammer`/`spear` (pure data — `MeleeSimSpec` needed no new mechanic).
5. ✅ `orbit` + radial `pattern` (ROADMAP 1.1 closeout, `ENGINE_VERSION` 16) — the Frame axis itself has nothing left unshipped.

**✅ `k_*` on-hit procs — first concrete batch shipped (`ENGINE_VERSION` 28).** The
placeholder id prefix now has real content, a first-pass design decision (revise
freely — nothing here is locked the way Frame×Element is): `k_lifesteal` (heal the
firing player by a ‰ of damage dealt, works for both ranged and melee since `applyHit`
is the one shared funnel both go through) and `k_ricochet` (a bullet retargets to the
nearest OTHER hostile within range instead of expiring, up to N times, preserving its
speed). Two showcase weapons carry them: `leech` (melee, lifesteal) and `carom`
(ranged, ricochet). Found and fixed a real, adjacent bug while wiring ricochet's
"what happens to a bullet after a hit" branch point: `RangedSpec.piercing` had been
authored since Stage C but never converted or read anywhere — a "piercing" weapon
behaved identically to a non-piercing one this whole time. All three now share one
decision in `HitResolveSystem`: ricochet first, else pierce (remembering hit ids so a
still-overlapping body isn't hit twice), else expire (the original default).

## Roster balance, and what is measurable about it (2026-09-04)

The roster got its first balance gates and its first per-weapon simulation on 2026-09-04.
Until then nothing in the tree compared two weapons — characters had had a full side-grade
suite since ROADMAP 2.3 (`content/skins.test.ts`), weapons had no analogue — and 22 of the
24 player-facing weapons had never appeared in any simulation, because both balance sims run
the starter loadout only. `design/18` "Layer 5" has the full account of the gap and the four
files that closed it.

**The measured shape of the roster, which is worth writing down because it reads like a bug
in a table.** Across the 17 ranged weapons there are 30 pairs where one Pareto-dominates
another on the numeric axes (dps, per-trigger burst, per-hit damage, reach, blast) — and
every single one of those 30 is justified by a MECHANICAL difference: a different ballistic,
pattern, element, or proc. Mean dps by rarity tier runs `fine` 8.41 → `epic` 5.63 → `legend`
3.75, i.e. **downward**. Melee dps spans a factor of 1.5 while arc spans 3.7× and knockback
4×.

None of that is drift. It is what "variety is combinatorial" (above) and `05`'s "better
weapons are the power axis" look like once measured: **rarity buys a mechanic, not pace**, and
a melee weapon's identity is its swing shape, not its damage. The consequence for testing is
that `skins.test.ts`'s equal-worth budget band has **no weapon analogue** — a mechanic has no
price anywhere in this repo, so any composite "worth" score would be scoring an invented
exchange rate. What is gated instead is domination *within an identical mechanical
signature*, where there is no mechanic left to appeal to (`balance/weaponBalance.test.ts`),
and the empirical pricing is left to `client/sim/weaponSweep.sim.ts`, which plays each weapon
through the shipped level and counts what it clears.

### Three fields this doc's schema implies are live, and are not

Found by the sweeps, recorded here rather than quietly fixed — closing them is content design:

- **`piercing` ships dead.** The Landing-order note above says the field "had been authored
  since Stage C but never converted or read anywhere" and that `ENGINE_VERSION` 28 fixed it.
  It fixed the *wiring*: `toSimSpec` converts it, `HitResolveSystem` honours it, and
  `systems/procs.test.ts` proves the mechanic on a synthetic bullet. But **no weapon in
  `WEAPON_SPECS` sets it** — `carom` deliberately took ricochet instead, and nothing else
  claimed it. So a piercing weapon still does not exist in the game.
- **`skinRef` is read by nothing.** `weaponTypes.ts` documents it as "SkinDef id — the view
  swaps by this, not by weapon logic". The view does not: `client/src/render/weaponSkins.ts`
  is keyed by weapon **id**, and `muzzleParity.test.ts` asserts every `WEAPON_SPECS` id
  resolves to its own entry there. All 25 weapons carry the field and share exactly two
  values between them, one per `kind` — a dead field with a stale comment.
- **The Frame × Element grid is sparser than it reads.** No ranged weapon carries
  `k_lifesteal` (only `leech`, which is melee), and no melee weapon carries `poison` — so
  `03`'s "N frames × 5 elements" bet is still only partly cashed. Both are pinned as named
  test cases so the assertions covering them cannot sit quietly vacuous.


## Weapon energy: the price a mechanic finally has ✅ (2026-09-05, `ENGINE_VERSION` 59)

A design call from the game's owner, and the direct answer to the paragraph above it:

> 我打算给武器加一个子弹的概念。这样1，能解决武器平衡性问题，有些大威力的武器一次就要消耗
> 大量子弹。2，能解决怪物掉落的问题。毕竟降低了掉率之后打完地图空空如也也不好。

The section above ends on a stated dead end: *"a mechanic has no price anywhere in this
repo, so any composite 'worth' score would be scoring an invented exchange rate"*, which
is why `balance/weaponBalance.test.ts` can only gate domination WITHIN an identical
mechanical signature. **`energyCost` is that exchange rate** — the first one the balance
layer has ever had.

### A shared regenerating pool, not magazines

`balance/energy.ts` holds the numbers and the full rationale. `BASE_MAX_ENERGY` 100, +1
every 2 ticks (15/s, unconditional — 20/s through `ENGINE_VERSION` 61, see "Why the line
moved" below), spent per **trigger pull** by every ranged weapon and by no melee weapon. A magazine-per-weapon model was considered and rejected on three counts,
all of them properties of this repo rather than general taste: it needs a RELOAD verb that
`10`'s button cluster has no room for and that lockstep cannot pause for (`06`); it puts
state on a weapon, so a weapon lying on the floor has to carry its rounds through
`PickupItem` and back out again on every drop-on-replace swap (above); and per-weapon ammo
TYPES would waste a third of a floor's entire weapon output on a gun you cannot feed, since
a floor hands out only 2-3 (`05`).

**Melee costs nothing**, which is what turns the always-owned melee half of the loadout
(the ranged-vs-melee trade-off above) into the fallback at empty. That is a second, deeper
reading of "both halves are always OWNED": the gun is now the half you can run out of.

### Priced on the MECHANIC, never on damage

This section's own measurement forbids the obvious rule. Mean dps by rarity already runs
**downward** (`fine` 8.41 → `epic` 5.63 → `legend` 3.75) because *rarity buys a mechanic,
not pace* — so a damage-indexed price would tax the slowest guns in the game hardest and
make the starter strictly best. The price is set against what the pull BUYS instead:

| what the pull buys | pays | examples |
|---|---|---|
| nothing but a bullet | at or on the regen line | `blaster` 3 (exactly on it), `repeater` 2 (just over) |
| an element / a status layer | just above it | `flamer` 3, `venomspit` 5, `teslagun` 9 |
| raw per-hit weight | ~1.2× the line | `cannon` 14, `cryobolt` 12 |
| several bodies from one press | ~1.3-1.6× | `scattergun` 14, `carom` 14, `tomahawk` 16 |
| not missing, or an area | ~1.3-1.4× | `seeker` 18, `mortar` 22, `lasercutter` 22 |
| persistent or bullet-hell output | ~1.6-2× | `gyre` 20, `novaburst` 26 |

A spread frame pays **once for the pull, never per pellet** — charging `scattergun`'s five
pellets individually would tax one decision five times over.

**Exactly one gun is sustainable on regen alone — the starter, and it sits exactly ON the
line** (`balance/energy.test.ts` pins that list by name rather than by count). Holding its
trigger down neither drains nor fills, which is what keeps the shipped level's difficulty
unmoved for a fresh save; everything *on top of* that — a `rof_up` stack, a burst, the
first interesting gun the floor hands you — comes out of the pool and has to be bought back.

### Why the line moved 20/s → 15/s (`ENGINE_VERSION` 62, 2026-09-11)

A design call from the game's owner: *"现在的子弹自动回复速度太快了，地图上掉落的子弹价值变
得非常低"* — the auto-refill is so fast that ammo lying on the floor is worth almost nothing.
Measured first, over 8 careful bot runs of the shipped level (the `clock%` / `floor%` /
`refills` columns `client/sim/pve/reportFire.ts` grew for the pass):

| loadout | spend funded by the CLOCK | by the FLOOR |
|---|---|---|
| `blaster` (fresh save) | 97.6% | 2.4% |
| `scattergun` | 97.9% | 2.1% |
| `novaburst` | 98.0% | 2.0% |

**98% of every shot came off the clock**, identically for a fresh save and for the most
expensive gun in the roster. The clock was not supplementing the floor's refills; it was the
supply.

What that ratio is made of decides what can move it: `collected × ENERGY_PICKUP_AMOUNT` over a
floor's spend, and **neither term moves with the regen rate**. A floor drops ~7 refills (~210
energy) against ~2000 energy of pulls, so ~10% is the ceiling the drop table sets even at
perfect collection — and the sim still reads 1-2% after this change. Lowering regen does not
raise the floor's *share* of supply. It changes whether the shortfall is felt at all, which is
the thing the report was really about. `ENERGY_PICKUP_AMOUNT` stayed 30 for the same reason: at
2% of supply, the refill's size was never the binding term.

At 20/s the clock covered a continuously-firing starter outright. At 15/s it covers the unbuffed
starter and nothing else, so a `rof_up` stack, a burst and the first interesting gun the floor
hands you all run a deficit only the pool and the floor can pay: **22.6% of live ticks now hold
a gun the pool cannot pay for** (0.9% before), with the average floor reached **unmoved** at
0.75. 10/s was measured and rejected — the same ~23% dry, but average floor reached fell 0.75 →
0.50, which is re-tuning the level rather than pacing the player.

> **A claim this section made and the control refuted (same day).** The first version blamed the
> uncollected refills (12 of 100) on a full bar refusing them, and called them "unpickable".
> `material` has no usefulness gate, so its collection rate is the pure did-the-bot-walk-over-it
> baseline — and over the same runs it reads 21.2% against energy's 12.0%. The bot misses ~80% of
> *everything*. The gate is real but secondary (a gated pickup is collected about half as often
> as an ungated one; ~21-27% of live ticks sit at a full pool), and at a dozen events over 8
> seeds the collection rate cannot A/B this change. Reported, never concluded from.

`repeater` (20/s) crossed above the line in the same pass and is now the cheapest *paced*
gun rather than a free one — deliberate: a drop-pool gun that funds itself forever is one
more gun the floor's refills are worthless to.

### Capacity is a character stat; the regen rate is not (`ENGINE_VERSION` 60)

`BASE_MAX_ENERGY` is the **reference** pool the table above is priced against, and the
default character's own (`skins.test.ts` pins that identity, so the price table cannot be
silently re-based). Actual capacity is `SkinDef.maxEnergy` — `skirmisher` 130, `vanguard`
100, `juggernaut` 70 — plus whatever `flat_energy` the run has picked up.

The reason this is a legal axis at all, when `14`'s side-grade rule forbids a power ladder
and `15`'s fairness wall carries a player's character into PvP, is a property of the pool
rather than a compromise about it:

> **Capacity buys burst. It provably cannot buy sustain.** Regen is a flat shared constant,
> so on an empty bar every character in the game fires at exactly
> `ENERGY_REGEN_PER_SEC / energyCost` shots per second regardless of pool size. A deeper
> bar is a longer opening, never a higher ceiling.

The roster spreads **opposite to the body** — the 3 HP character that cannot win a long
trade gets the longest short one, the 11 HP character that stands and trades pays here,
because length is exactly the regime where capacity stops mattering. `ENERGY_PICKUP_AMOUNT`
stays a flat 30 rather than a fraction of the pool, so a refill is worth proportionally
more to the shallow bar — the shallow character's compensation, and pinned as such.

Two consequences worth stating because nothing else would catch them:

- The "every gun gets at least two shots off a full bar" gate measures against the roster's
  **smallest** pool, not the reference one. At the old bound a 40-cost weapon could ship
  that `juggernaut` fires once and `vanguard` fires twice.
- **The arena does NOT scale it.** `PVP_SCALE_FACTOR` multiplies `maxHp`/`maxShield`
  because it multiplies weapon damage alongside them, which is what preserves relative TTK
  (`15`). `energyCost` is not scaled at all, so a ×5 pool would not preserve a ratio — it
  would delete the ammo economy from PvP outright.

### Running dry is a pace, not a disarm

A refused pull leaves the weapon's **cooldown untouched**, so the trigger retries every
tick and fires the instant regen covers the next shot. An expensive frame at an empty pool
degrades into a slow one; it never stops being a weapon. Enemies have no pool and are
structurally never charged (`WeaponFireSystem.asEnergyUser` keys on `faction`), so
`enemygun`'s price of 0 is inert data and a garrison can never go quiet for a reason
nothing on screen explains.

### Sized against a measurement, not a guess

`client/sim/pve/report.ts`'s `floorFireStats` was built and read FIRST — over 8 careful bot
runs of the shipped level, a complete floor costs **237-760 trigger pulls** and hands back
only ~35-52 drops, and **pulls per kill RISES with depth** (6.3 on floor 0 → 14.2 on floor
1) because `difficultyCurve` scales enemy HP while a drop table pays per kill. Both
findings are why the pool regenerates on a clock rather than being funded by drops: a
time-based refill is depth-invariant, where a kill-funded one goes negative exactly on the
floors that are already hardest. The full table is in `ENGINE_VERSION_HISTORY` v59.

### What the sim can and cannot see (`ENGINE_VERSION` 60)

`report.ts`'s fire table grew a **`dry%`** column — the share of a floor's live ticks on
which the player held a ranged weapon it could not afford to pull. It exists because the
v60 capacity A/B came back byte-identical and there was no way to tell *"capacity does not
matter"* apart from *"the bar never emptied in the first place"*. What it reads today, on
8 careful bot runs of the shipped level, holding the character fixed and varying only the
pool:

| pool | floor 0 | floor 1 | floor 2 | avg floor reached |
|---|---|---|---|---|
| 30 | 0% | 21% | 16% | 0.75 |
| 70 | 0% | 2% | 2% | 0.75 |
| 100 (shipped default) | 0% | 0% | 4% | 0.75 |
| 130 | 0% | 0% | 0% | 0.75 |

Three things follow, and only the first was intended:

- **Capacity is measurable, and it is a texture stat, not a power stat.** `dry%` moves with
  the pool; average floor reached does not move at all.
- **It only ever bites deep.** Floor 0 is 0% at every pool including 30, because the
  starter blaster is below break-even and capacity is by construction irrelevant to any
  weapon that is. The bite on floors 1-2 is a `rof_up` stack pushing that same blaster
  *over* the line — not an expensive frame, which the bot never fires.
- **In PvP it is currently inert.** An arena seat's bar never drops more than one blaster
  shot below full across 8 sampled matches: the landing kit is sustainable and the bot does
  not swap to looted frames. So the identical PvP win rates either side of this change are
  an unmeasured result, not a verified one — the same shape as the melee-share 0% gap v59
  named. What bounds the risk meanwhile is the burst-vs-sustain rule above, which is a
  property of the arithmetic rather than of the bot.

### Still open

The PvE bot never swaps off the starter gun (`weaponFireStats` reads `blaster` 100%), which
is what leaves the row above unable to measure an expensive frame running dry — a bot that
swaps under pressure is the one change that would make it real. *(The mob melee weapons'
placeholder art was the other item here; both shipped real art on 2026-09-06, see `12`.)*


## Deflect / parry (core mechanic)

Deflect is **part of the melee attack — not a separate state or button.** Pressing attack with a melee weapon produces one swing sector (a fan centered on facing, `arc` half-angle + `range` radius; different weapons have different arc and range). During that swing, within the SAME sector:

- **Enemies** in the sector take the swing's damage (once per swing).
- **Enemy bullets** in the sector are deflected: faction flips to player, velocity is redirected toward the nearest enemy (or mirror-reflected when the arena is clear), and a deflect flash plays (additive on the fx layer).

So there is no `isBlocking`, no block key, no separate `blockArc` — the arc that hits enemies is the arc that bats bullets back. A per-weapon `deflect: bool` gates whether a given melee weapon can parry at all.

**Where the ranged-vs-melee trade-off actually lives (`ENGINE_VERSION` 45).** It used to read "ranged loadouts get no parry" — a BUILD-level choice. That is no longer true, and deliberately so: every loadout now carries one gun and one melee weapon (`resolveLoadout`, `09`; PvP's landing kit is the same pair, `15`), because a one-weapon loadout silently removed the swap verb from the game. **The PvE half of that only became enforceable on 2026-09-03**: `resolveLoadout` fills FREE slots by kind but honours an explicitly-staged same-kind pair verbatim, and the forge checked only the slot count — so `repeater` + `scattergun` (two of the five blueprints a fresh account starts unlocked, both guns) produced exactly the melee-less run this paragraph says cannot happen. `meta/forge.ts craft` now refuses a kind already staged; `resolveLoadout` is unchanged, so a hand-built `EngineConfig` can still ask for two of a kind on purpose. The trade-off is now MOMENT-level: the swap is instant and free, but only the active weapon's arc exists, so you cannot hold the gun's uptime and the saber's parry sector in the same instant — you choose, mid-fight, which one is in your hands when the bullet arrives. Both halves are always OWNED; neither is ever both-at-once.

- Extensible: perfect-swing timing window for a damage bonus, etc.

> This makes "swing your melee through an incoming bullet, and it flies back at the enemy" work — the pivot of the differentiated gameplay. It rewards *timing the swing*, not holding a button. The demo implements a minimal version.

## Parameterization & extension

Weapons should be **data-driven** as much as possible: one shared ranged/melee implementation derives many weapons from config.

```
RangedSpec { fireRate, bullets, spread, speed, damage, damageType, pattern }
MeleeSpec  { arc, range, damage, damageType, knockback, deflect: bool, deflectSpeed }
           // the swing's arc+range is BOTH the damage sector and the deflect sector
           // damageType: 'physical'|'fire'|'ice'|'lightning'|'poison' (omitted = physical)
```

Adding a weapon = adding a config row (+ code only for special behavior), not hard-coding each one.

- **Mounting (universal socket).** A weapon renders as a sprite on one of the character's two **orbiting weapon-socket** attachment points, following that socket's aim rotation every frame (`02`/`12`/`13`); swapping the active slot swaps which socket fires. The socket is a **universal mount** — its base is identical for every weapon, only the business end (barrel / beam emitter / crystal blade / hammer head) differs — so there is **no `grip` and no per-weapon hold pose**: one arm-agnostic mount holds any frame, ranged or melee, and any character holds any weapon (a character's theme lives on the orb, never on the weapon — `13`). A melee frame's swing is the socket **sweeping its `arc`×`range` sector around the core** — that swept sector is the same one that damages enemies and deflects bullets (above) — and the socket's **tether length maps to melee reach** (short = dagger, long = spear). Mounting is render-only — it never touches the sim (`06`).

## Verified in the demo

- Ranged gun: click to fire, emits a straight bullet.
- Melee sword: click to swing; the swing damages enemies in its arc **and** deflects enemy bullets caught in that same arc back at enemies — no separate block input.
- `[1]`/`[2]` swap the active weapon slot. Weapon positions by facing, with local z-order switching.

## Pickup & switch (shipped — see `05`)

Weapons are **not** auto-picked-up (unlike materials/consumables) — swapping your weapon is a choice, so it stays click-driven:

- **Weapon-pickup panel (render-only, click-to-collect) — shipped (ENGINE_VERSION 32, replacing the single-nearest "ground compare card" + tap-INTERACT gesture below).** Standing near one or more floor weapons pops a non-blocking panel listing every one of them (real icon — the same business-end art the rig mounts, `render/weaponSkins.ts` — + name); tapping a row IS the pickup action, closing just leaves them all on the floor. The panel itself is pure client render (`ui/pickupProximity.ts#nearbyWeaponPickups` + `ui/WeaponPickupPrompt.ts`, driven by `HudView`), same non-blocking-overlay shape as the portal popup (`10`) — the run keeps simulating while it's open, never a modal (still impossible under lockstep, `06`). The panel costs the player exactly the clicks that land ON it, and nothing else (2026-09-02): a press anywhere on the panel is swallowed for the length of that press (`WeaponPickupPrompt`'s capture-phase `pointerdown` -> `CommandBuilder.suppressFireUntilRelease`, needed because `WebInput` sets `firing` from a raw `mousedown` independent of what a Pixi button consumed), while every other click still attacks. It used to gate the whole fire button on the panel being OPEN, the way the portal popup (`10`) legitimately does — but the portal only appears in a cleared room, whereas this one opens mid-fight from `lootRevealRadius` away every time anything drops a weapon, so a player standing in their own loot simply could not shoot. The *click itself*, unlike the panel's rendering, does touch the sim: it sets `PlayerCommand.pickupTargetId` (a one-shot latch, `CommandBuilder.requestPickup`, same convention as the portal popup's `CONFIRM_EXTRACT`/`CONFIRM_DESCEND`), and `PickupSystem`'s weapon-kind branch collects only when that id matches an alive item within `SIM.lootRevealRadius` — server-authoritative, exactly like every other pickup kind's overlap check.
- **Swaps it into the slot holding the SAME KIND of weapon** (`ENGINE_VERSION` 46, from the live report *"不能拾取一把刀，却把枪换掉了，导致玩家拿着两把刀"*) and the **replaced weapon drops back onto the floor** (`02`). No manual drop button; `applyWeapon` (`PickupSystem.ts`) pushes the outgoing weapon as a fresh floor `PickupItem` before overwriting the slot, and the picked-up weapon becomes the active one — you hold what you chose.
  - It used to overwrite whichever slot was ACTIVE, which quietly broke this document's own invariant. The one-gun-and-one-melee guarantee above is not a spawn-time nicety: the whole ranged-vs-melee trade-off is *"both halves are always OWNED; neither is ever both-at-once"*, and `resolveLoadout` / `buildArenaSpecs` go to some length to establish it. Picking up a saber with the gun in hand destroyed it on the first floor weapon of the run — two melee weapons, no gun, no route back to one, and a swap button toggling between two of the same thing. Matching by kind restores the invariant by the same test `resolveLoadout` fills slots with (`w.kind === kind`), so a loadout that spawns one-of-each keeps one-of-each however many weapons pass through it.
  - Fallbacks, in order: a FREE slot if this player carries fewer than `weaponSlots` (a seat built past `resolveLoadout` can hold one weapon; filling the gap beats overwriting the only weapon it has), then the active slot if both slots are somehow the other kind.

## To design

The composition model, frame library, and landing order are now locked (above); the affix layer is **removed** (Frame × Element only — ROADMAP 0.1, `ENGINE_VERSION` 9→10) and **intrinsic rarity is shipped** (ROADMAP 0.2 — `RarityTier` white→gold + `RARITY_TIERS` quality mult, applied at weapon convert time; `balance/rarity.ts`). What remains is content + tuning:

- Per-frame numbers and the `WeaponSpec` rows for each frame × element × rarity (values live in `09`'s `content/weapons.ts`). Every weapon already carries a `rarity` (placeholder tiers); the frame library beyond `straight`/`saber` shipped first-pass physical showcases (ROADMAP 1.1) — elemental variants of each new frame (a fire mortar, a lightning beam, …) are still open content work.
- The five rarity base-quality tiers' *final* numbers (first-pass shipped) and the ornament/emissive overlay that makes rarity read off the weapon sprite (`14`/`12`, render-side).
- Config format/loading is `09`'s open question (TS for balance vs JSON for tool-authored data).
