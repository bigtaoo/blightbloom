# Work log — 2026-09-21

Volume 78. See [`design/ROADMAP.md`](../ROADMAP.md) for the index and the phase spine.

## A design number with a remainder in it: the vanguard's shield becomes an integer (2026-09-21, engine + test + docs, ENGINE_VERSION 66 to 67)

A forge screenshot with a red circle around the character line: **"the vanguard (6 health / 3.2 shield)"**, and
the rule stated with it — *"fixed-point is only for the logic's own arithmetic, never for designing numbers; a final number can only be an integer"*. Fixed point
is how the sim carries a sub-unit quantity; a number a player reads is not where a remainder
belongs. One `grep` over `engine/content` + `engine/balance` says how wide the problem is:
**exactly one fractional gameplay stat in the whole tree**, `vanguard.maxShield: 3.2`. Everything
else fractional there is geometry (`bulletZ: 0.5`, a grid height) or a ratio threshold.

### Where it came from, and why "it's a balance number" was not the answer

`skins.ts` had a nine-line comment defending the fraction as a deliberate choice: every whole
total between 8 and 11 either ties another character's `(hp + shield)` budget — which spikes
simultaneous elimination — or overcorrects. All true, and none of it is why the number was 3.2.

`buildArenaSpecs` derived the PvP pools as `Math.round(pool × PVP_SCALE_FACTOR)`. The 2026-07-28
retune measured its vanguard trim in the **PvP** sim and wanted **16**. With the factor fixed at 5,
the only way to author 16 was to write 16/5 in the PvE column. **The remainder was an artefact of
the derivation, parked in the file the character screen reads.**

### In PvE the fraction did nothing at all — and that is provable, not a guess

Every number that reaches `takeDamage` is a post-resist integer ≥ 1 (`applyResist` rounds a
weakness up and truncates a resistance down, both floored at 1; `critDamage` and `buffedDamage`
are `Math.round` over per-mille sums), and a spent shield overflows into hp. So death depends only
on cumulative integer damage against the TOTAL pool, and `D ≥ 9.2 ⟺ D ≥ 10` for every integer `D`.
6/3.2 and 6/4 are the same character:

| damage | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 9 | 10 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| hits to kill, shield 3.2 | 10 | 5 | 4 | 3 | 2 | 2 | 2 | 2 | 1 |
| hits to kill, shield 4 | 10 | 5 | 4 | 3 | 2 | 2 | 2 | 2 | 1 |

Regen does not separate them either — it is `+1` clamped, so the two pools differ by 0 or 0.8 and
never by a full point, and a brute-force sweep of damage/regen interleavings found no divergence in
hit count or in shield-break timing. **The balance pass that wrote the fraction moved nothing in
PvE.** What the fraction bought was the line in the screenshot, a `hp: 5.2` in the hashed state, and
`hpTotal: 4.2` in the golden witness.

### The change: two authored integer columns instead of one multiplication

`SkinDef` now carries `pvp: { maxHp, maxShield }` — authored, integral, and equal to what the sim
measured (vanguard 30/16, skirmisher 15/30, juggernaut 55/0) — and the PvE pool becomes the 4 it
always effectively was. `PVP_SCALE_FACTOR` keeps its real job, scaling landing-kit and arena-loot
weapon damage. The pairing that preserves relative TTK is "pools and weapon damage scale together",
and two integer columns satisfy it exactly as well as one multiplication did, while letting either
scale be re-tuned without dragging the other with it. The tie constraint the old comment cited is
kept and now gated: budgets 10 / 9 / 11, no two equal.

### The gate was run before the bump, and said something

`serializeState` hashes `version`, so every hash moves the instant `ENGINE_VERSION` does. Measured
first, with the version left alone: **six of the seven scenarios' hashes moved and
`launch-arena-pvp`'s did not** — PvP byte-identical as measured, not merely as argued. Across all
six, every event counter, phase, placement and PRNG cursor was unchanged, and exactly one witness
field moved: `ember-dungeon-floor1`'s `hpTotal: 4.2 → 5`. That is the remainder leaving. Then the
bump to v67, the history entry, the re-record. A v66 stream still diverges at v67 — the recorded
`shield`/`maxShield` differ from tick 0 — which is what the bump is for.

### Three gates, because the roster-only one is how this lasted two months

The detector that eventually fired was a human reading a screenshot. Nothing in the tree would have
caught the same mistake on an enemy's `maxHp`, a weapon's `damage` or a drop amount.

- **`content/skins.test.ts`** — every authored number on every character is an integer at BOTH
  scales; the arena pair is held to the same side-grade rules as the PvE pair plus a per-axis
  ORDERING correspondence (one roster, two scales — the arena must not invert who is tankier); and
  no two characters share an exact budget.
- **`content/authoredNumbers.test.ts`** (new) — the same rule over six catalogs (`SKIN_DEFS`,
  `ENEMY_BLUEPRINTS`, `WEAPON_SIM_BY_ID`, `PLAYER_BASE`, `DROP_TABLE`, `BLUEPRINT_CATALOG`). The one
  legal fraction is `shieldBreak.radiusGrid: 2.5`, a human-unit grid length, so **the exception is
  keyed on the field's NAME** (`*Grid`, `*Sec`, `*PerSec`, `*Deg`, `*Px`, `bulletZ`), never on its
  value or path: a fractional `damage`/`maxHp`/`cost` cannot become legal by being added somewhere
  new, and a real new human-unit field announces itself in its own name. With an anti-vacuity pair
  and a control that the exception is live.
- **`systems/poolIntegrality.test.ts`** (new) — the invariant in two halves, because it is
  maintained in two places: the damage pipeline only ever produces integers (`applyResist` over
  **every resist profile the roster ships** × every type × 12 raw sizes — it had no unit test at
  all before this; crit and damage buffs swept to the buff cap; burn and chain payloads), and the
  pools keep what they are handed whole (absorb, overflow and idle regen, per character). Plus the
  property the fraction hid behind, stated as a rule: **hits to kill is exactly
  `ceil(pool / damage)`**, so the next person reaching for a fraction as a balance lever learns from
  a test what it buys.
- **`smoke.test.ts` flips**: *"the serialized state carries no float except the two that are
  deliberate"* becomes *"no float at all"*. That exemption existed solely because of this pool, and
  its own note warned that the first `*` or `/` on the field would turn it into a real desync.

### Verified by mutation, which is where the interesting result is

| mutant | killed by |
| --- | --- |
| `maxShield` back to `3.2` | 6 files / 13 tests — all four integer gates, smoke, six golden hashes |
| `applyResist` stops rounding | `poolIntegrality` ×5, `elemental` ×3 |
| shield regen adds `0.5` | `poolIntegrality` regen, `shield.test.ts` ×3 |
| a mob gets `maxHp: 3.5` | `authoredNumbers` — the `ENEMY_BLUEPRINTS` arm, proving it is not a `SKIN_DEFS`-only sweep |

**`ceil(pool / damage)` survived the first mutant, and should have.** That is the test stating the
finding rather than contradicting it: the fraction does not change hit counts, which is the whole
reason it could ship for two months in a suite of 1,600 tests.

### Numbers

engine 85 files / 1,630 tests green; `check:logic` 12 gates; `tsc` clean; file-length gate clean;
`test:pvp-sim` 180 matches (vanguard 85 / skirmisher 56 / juggernaut 36, 3 ties).

### Still open

**Vanguard reads 47% in the bot-vs-bot sim against a 33% fair share** — unchanged by this pass (the
PvP numbers are identical) and older than it, so the 2026-07-28 retune did not land where it aimed.
Re-tuning is now a straightforward edit: both columns are integers and neither is a rounding of the
other, so moving one no longer forces a fraction into the other.
