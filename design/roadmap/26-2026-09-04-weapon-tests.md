# Work log — 2026-09-04: the weapon roster gets tested

Volume 26. A question — *"does the weapon system have balance tests? is every weapon's play and effect tested?"* (does the
weapon system have balance tests? does every weapon's behaviour and effect have tests?) — whose
honest answer was *the mechanics do, the weapons don't, and the balance nothing does*.

Indexed from [`../ROADMAP.md`](../ROADMAP.md). Design account in
[`../18-test-strategy.md`](../18-test-strategy.md) "Layer 5" and
[`../03-weapon-system.md`](../03-weapon-system.md) "Roster balance".

## The weapon roster gets tested (2026-09-04, tests and one pure module, no engine bump)

### What the count actually showed

Layers 0-4 of [`../18-test-strategy.md`](../18-test-strategy.md) all ask about SYSTEMS. Asked
from the content side, the roster answered badly — 24 player-facing weapons, and four separate
holes:

- **[`../../engine/content/weapons.ts`](../../engine/content/weapons.ts) had no test file.**
  `toSimSpec` was exercised only sideways, by four tests that each read the one field they cared
  about. Its history is the argument: it has silently dropped an authored field **three times** —
  `piercing`, `ricochetCount` (both fixed at `ENGINE_VERSION` 28) and `swingSec`, authored on
  every melee weapon since Stage C and converted by nothing until v53, so for ~45 engine versions
  every blade's hit window was one tick and design/03's third melee axis did not exist.
- **Only the MELEE half of the roster was swept.**
  [`../../engine/systems/meleeWindow.test.ts`](../../engine/systems/meleeWindow.test.ts) drives
  off `WEAPON_SPECS` itself. Ranged had no counterpart — `ballistics.test.ts` covers each shape
  once through one showcase weapon and hand-names its seven integration weapons. Counted across
  the whole tree, `carom` (the game's only ricochet weapon) appeared in **one** test file:
  [`../../client/src/render/muzzleParity.test.ts`](../../client/src/render/muzzleParity.test.ts),
  a render sweep. `venomspit` was in the same position.
- **No test compared two weapons.** Characters have had a full side-grade suite since ROADMAP 2.3
  ([`../../engine/content/skins.test.ts`](../../engine/content/skins.test.ts): Pareto
  non-domination, per-axis spread, equal-worth budget band). Weapons had no analogue of any of it.
- **Neither sim touched the roster.** `pvpBalanceSim` measures character win-rate; `pveLevelSim`
  plays level 1 with the starter loadout only. `RunOptions.loadout` — the hook that makes a
  per-weapon sweep possible — had been there the whole time, unswept. 22 of 24 player weapons had
  never appeared in any simulation.

The shape of that list matters: **coverage was 100% lines and 100% branches on
`content/weapons.ts` the whole time.** A dropped field is a line nobody wrote, and a weapon
nothing fires still has every branch of its data literal "covered".

### Four files

**[`../../engine/content/weapons.test.ts`](../../engine/content/weapons.test.ts)** — a landing
table naming, for every authored field, the sim key it lands on and the formula that produces it,
closed on three sides: every key a shipped weapon sets must be in the table, every key `toSimSpec`
emits must be claimed by one, and every field the *schema* declares must have a line. That last
direction is a TYPE, not a source scan: the tables are `Record<keyof RangedSpec, …>`, so a new
schema field with no landing is a `tsc --noEmit` error. The obvious implementation — regex the
interface bodies out of `weaponTypes.ts` — needs `node:fs`, and
[`../../engine/tsconfig.json`](../../engine/tsconfig.json) withholds node and DOM types from the
sim core on purpose; reaching for `readFileSync` would have meant widening that boundary to write
a weaker check than the compiler gives for free. 48 tests.

**[`../../engine/systems/rangedCatalog.test.ts`](../../engine/systems/rangedCatalog.test.ts)** —
the ranged counterpart of the melee sweep, four passes: the frozen payload on every pellet matches
its spec *and carries no other shape's params*; every weapon of each ballistic moves by its own
authored numbers (so `frostseeker` is exercised beside `seeker` rather than represented by it);
`carom`'s real bounces and `leech`'s real lifesteal fire; and every weapon damages a body placed
inside its own reach envelope through the real `engine.step()`. 79 tests.

**[`../../engine/balance/weaponProfile.ts`](../../engine/balance/weaponProfile.ts) +
[`weaponBalance.test.ts`](../../engine/balance/weaponBalance.test.ts)** — the roster reduced to
comparable axes, then gated. 31 tests, the module at 100% lines and 100% branches.

**[`../../client/sim/weaponSweep.sim.ts`](../../client/sim/weaponSweep.sim.ts)** —
`npm run test:weapon-sim`, folded into `test:sims`. Every weapon plays the shipped level, 8 seeds
each, ~10 s total; reports kills / ticks-per-kill / damage taken / depth.

### The measurement that changed the design: a mechanic has no price

The plan was to copy `skins.test.ts`'s three gates. The data said one of them cannot exist here.

Across the 17 ranged weapons there are **30 pairs** where one Pareto-dominates another on the
numeric axes (dps, per-trigger burst, per-hit damage, reach, blast) — and **every one of the 30**
is justified by a mechanical difference: a different ballistic, pattern, element or proc. Mean dps
by rarity tier runs `fine` 8.41 → `epic` 5.63 → `legend` 3.75, i.e. **downward**. Melee dps spans
a factor of 1.5 while arc spans 3.7x and knockback 4x.

None of that is drift — it is design/03's "variety is combinatorial" and design/05's "better
weapons are the power axis" as measured quantities: **rarity buys a mechanic, not pace**, and a
melee weapon's identity is its swing shape, not its damage. So an equal-worth budget band has no
weapon analogue, because nothing in this repo prices homing, a blast radius, a hitscan beam, a
bounce or a chill; any composite "worth" score would be scoring an invented exchange rate.

What is gated instead is domination **within an identical mechanical signature** — where there is
no mechanic left to appeal to — plus no strictly-worse mechanical duplicate anywhere, no clones,
real per-axis spread, and no orphaned ballistic/pattern/element. Three signature groups have more
than one member (`blaster`/`cannon`/`repeater`/`scattergun`, `saber`/`hammer`/`spear`,
`flamer`/`cinderscatter`), which is 20 ordered pairs actually compared, asserted BY NAME so the
gate cannot quietly become a no-op. Empirical pricing is left to the sim.

### The sim harness invented two weapon findings before it measured one

Both looked like balance results. Both were the harness, and the second took a real measurement
to disprove:

1. **REACH.** The first run reported ZERO kills for `lasercutter`, `gyre` and all seven blades.
   `BOT_PROFILES.careful` holds a 7.5-grid standoff, tuned for the pistol whose bullets reach 30 —
   so the bot stood outside a 3.5-grid beam's range and fired into empty floor for the whole run.
2. **FLIGHT TIME.** Capping standoff by reach alone still left `mortar` at zero kills on four of
   eight seeds. Sweeping *its standoff* 9 → 2 grid took it from 11 kills (three seeds at zero) to
   35 with 4-5 on **every** seed, with nothing about the weapon changed: `PveBotController` does
   not lead its shots, so an 8 grid/s shell with a 1-second flight lands where the target used to
   be, and a 1.3-grid blast does not forgive that.

Standoff is now `min(careful, reach × 0.55, bulletSpeed × 0.5)` floored at 0.8 grid, with
`bulletSpeed === 0` (beam, orbit) skipping the flight bound — so every weapon is measured at a
range it can actually connect from. The gate is **"no weapon is inert — every one kills something
on every seed"**, which no static test can check, and it passes with no exemptions.

Two reporting traps recorded with it. `t/kill` **rewards dying early** (total ticks ÷ total kills:
`lasercutter`/`gyre` led at ~46 on 54-55 kills and floor 0, while `stormglaive` sat mid-table at
~54 on 882 kills and floor 3), so it is never read without the kill total and the floor beside it.
And the pace gate compares each weapon to the SAME run's best rather than a recorded constant,
because these are real runs against the shipped level and the shipped enemy AI and every absolute
number in the file moves when either is retuned.

### Batteries

Every gate shipped with its mutation, per this repo's habit. `content/weapons.test.ts`: 7 mutants,
6 killed — the survivor is `toFpPerTick`'s `Math.trunc` → `Math.round`, which changes **not one
shipped number** (every authored speed is a whole grid/s and `n · 33` is exact for integer n), so
a real-content test provably cannot see it and it is closed by the one assertion in the file that
calls a converter directly. `rangedCatalog.test.ts`: 10 mutants, 8 killed, and both survivors are
content facts rather than weak assertions (see below). `weaponBalance.test.ts`: 7 DATA mutants —
edits to `weaponSpecs/*.ts`, which for a content gate is the mutation that matters — no survivors.

A reporting trap worth keeping: **a compile-time gate reads as a survivor in a battery that only
counts failing tests.** Adding a schema-only field (`chargeSec?: number`, authored by no weapon)
fails `tsc` and breaks zero tests, because no content exercises it. Both columns are recorded.

### Three dead-content findings, pinned rather than fixed

Each is now a live drift check — closing them is content design, not test work:

- **`piercing` ships dead.** Authored, converted, honoured by `HitResolveSystem`, proven by
  `procs.test.ts` on a synthetic bullet — and set by **no** weapon in `WEAPON_SPECS`. `carom`
  deliberately took ricochet instead. Pinned as `UNUSED_BY_CONTENT`. The v28 note in design/03
  said the field was "never converted or read anywhere" and that v28 fixed it; it fixed the
  wiring, not the absence of a carrier.
- **`skinRef` is read by nothing.** `weaponTypes.ts` documents it as "the view swaps by this". The
  view does not — [`../../client/src/render/weaponSkins.ts`](../../client/src/render/weaponSkins.ts)
  is keyed by weapon **id**. All 25 weapons carry the field and share exactly two values between
  them, one per `kind`. A dead field with a stale comment.
- **The Frame x Element grid is sparser than it reads.** No ranged weapon carries `k_lifesteal`
  (only `leech`, which is melee) and no blade carries `poison`. The first was found by a surviving
  mutant: blanking `lifestealPermille` out of `WeaponFireSystem`'s spawn payload kills nothing,
  because the freeze sweep compares `undefined` to `undefined` for all 17 ranged weapons. Both are
  pinned as named cases so neither assertion sits quietly vacuous.

### Verification

158 new engine tests + 5 sim tests, `tsc --noEmit` clean in both packages, `check:filelength` /
`check:logic` / `check:docpaths` green, engine branch coverage 93.09% → 93.50%. Verified in
ISOLATION rather than off a green tree: `D:/daydayup` was shared with a concurrent session
mid-pass on enemy approach (`ENGINE_VERSION` 56), whose in-progress `AIDecideSystem` /
`MovementSystem` / `golden.json` edits made two full-suite runs report failures in files this pass
never touched.
