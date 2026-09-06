# Content & data model

The data-driven backbone: **where every gameplay number and every piece of content lives, and in what shape.** `06`/`08`/`07` decide *how the engine behaves*; this doc decides *what data it reads to behave that way*. It is the single source of truth for the `@dd/engine` config layout, the weapon/enemy/skin/rarity/run-buff schemas (`02`/`03`/`14`), the room & dungeon formats (`05`), and the collision geometry deferred from `07`.

It exists because `03`, `05`, `07`, and `08` all say "numbers live in one place" and repeatedly defer their concrete formats here.

> **funny mapping.** funny keeps *all* balance in `server/engine/src/config.ts` (single source), blueprints as plain `Record<Type, Blueprint>`, PvE levels as pure-data `LevelDefinition`s driven by a `WaveDirector`, and affixes as an `AFFIX_FIELD_MAP` mutating blueprints in place. Blightbloom reuses the discipline and the fairness wall wholesale. It **⟂ diverges** on world data: funny levels are fully hand-scripted with a fixed seed; Blightbloom's PvE is **hybrid** — hand-authored room *pieces* stitched by a **seeded procedural layout** (`05`) — so the level format is a piece library + assembly rules, not one scripted timeline.

## The decisions (locked)

- **All numbers live in `@dd/engine` config; prose only snapshots them with a date.** Client and server read the same module (webpack alias / workspace dep, `06`). No balance constant is ever duplicated into a doc, a UI file, or the render layer — funny's ADR-001 rule, the fix for "same number, four values across four docs."
- **Author in human units, convert once at construction.** Config is written in seconds, grid-units/second, degrees, and percent — *readable*. The engine converts to ticks/`Fp`/brad exactly once, when a blueprint is instantiated, using a fixed truncation so every client converts identically (funny: `attackInterval_s → round(s·TICK_RATE)`, `speed grid/s → toFp(speed)`). **Raw floats never survive past construction** into stored state (`06`).
- **Content is plain data keyed by type.** Weapons, enemies, skins, rooms, drop tables are all serializable records — no code, no Pixi, no closures. Special behavior is a *tagged field* the engine interprets (funny's `traits`/`projectile`/`onDeathSpawn`), never an inline function. This is what lets the same data drive engine, headless re-judge, and (later) a data editor.
- **The PvP *weapon* wall is structural, not disciplinary.** ⟂ The builder that produces arena specs takes **no weapon / material / blueprint parameter at all**, so it is *compile-time impossible* to leak a crafted weapon into PvP (funny's `buildPvpBlueprints()` signature has no equipment arg, guarded by hard-wall tests). Crafted weapons only reach the *run* builder. This is the concrete enforcement of `05`'s "PvP normalizes gear" / `06`'s casual-first. **The one exception is character choice** — `buildArenaSpecs` *does* take a `skinId` (`14`), so the chosen character's `(maxHp,maxShield)`+passive apply in PvP (and `maxEnergy`, carried through UNSCALED — `15`); that axis is held fair by **balance discipline + tests** (every character is a side-grade), not by the type wall.
- **Forward-compatible by default.** An unknown weapon / skin / trait / field is **silently ignored**, not a crash (funny). New content can ship to data before the engine understands it, and an old replay won't explode on a field it doesn't know — but any change that alters *outcomes* still bumps `ENGINE_VERSION` (`08`).
- **No display strings in engine data.** Names/descriptions are **i18n string keys** (plain strings in the engine; the client re-narrows to typed keys at the render boundary — funny's koan). Engine data is logic + keys only.

## Config module layout

Mirror funny's `@nw/engine` structure:

```
@dd/engine/
  config.ts            // global constants: TICK_RATE, i-frame defaults, world scale (no gravity — z/jump removed, 07/08)
  math/{fixed,prng,trig}.ts   // 06 (trig = the new brad/fp-trig module)
  content/
    weapons.ts         // WEAPON_SPECS: Record<WeaponId, WeaponSpec>   (03)
    damage.ts          // DamageType, StatusState, resist + status tuning (03/07)
    enemies.ts         // ENEMY_BLUEPRINTS: Record<EnemyType, EnemyBlueprint>
    skins.ts           // SKIN_DEFS: Record<SkinId, SkinDef>           (02)
    ballistics.ts      // BALLISTIC_SHAPES: straight/arc/homing/…       (03/07)
    drops.ts           // DROP_TABLES                                    (05)
    floorCards.ts      // FLOOR_CARDS (in balance/, beside runbuffs.ts)   (05)
  balance/
    rarity.ts          // RARITY_TIERS: base-quality tiers per weapon    (03/14)
    runbuffs.ts        // RUN_BUFFS: in-run buff catalogue (replaces affixes) (14)
    presets.ts         // ARENA_PRESETS (PvP loadouts)                   (05)
    build.ts           // buildRunSpecs() / buildArenaSpecs() — the wall
  world/
    rooms/*.ts|json    // RoomPiece library (hand-authored)             (05/07)
    dungeon.ts         // DUNGEON_CONFIGS: assembly rules per biome     (05)
    arenas/*.ts|json   // PvP arena maps                                (05)
```

## Entity blueprints

Author in human units; the constructor converts (as funny's `Unit` ctor does).

### `WeaponSpec` (`03`)

```
WeaponSpec = { id, kind, nameKey, skinRef, cooldownSec }  &  (RangedSpec | MeleeSpec)
  // The weapon renders as a module plugged into one of the character's two orbiting
  //   weapon sockets — a universal, arm-agnostic mount (02/03/12/13). No 'grip'/hold pose:
  //   the socket aims the weapon; melee's swing is the socket sweeping its arc. Render-only,
  //   never read by the sim (06).

RangedSpec = {
  kind: 'ranged'
  fireRateSec        // → cooldownTicks
  // emission — how shots leave per trigger (03 Frame axis); all orthogonal to ballistic
  bullets            // pellets per shot (spread frame)
  spreadDeg          // → brad half-angle; jitter drawn from combatPrng (07). ≈360 = radial
  burstCount?        // shots per trigger for the burst frame (03); omitted = 1
  burstGapTicks?     // spacing between burst shots
  bulletSpeed        // grid/s → fp/s
  damage             // integer
  damageType?        // 'physical'|'fire'|'ice'|'lightning'|'poison' (07); omitted = physical
  ballistic: BallisticId   // per-tick MOTION rule; see BALLISTIC_SHAPES catalog below (03 Frame axis)
  // ballistic params — each shape reads only its own (unset = shape unused / default).
  // Shipped ROADMAP 1.1 (ENGINE_VERSION 15): turnRateBrad, blastRadius, returnAfterTicks,
  // beamTicks/beamTickInterval/beamRange (beamRange added beyond this original sketch —
  // a beam is a frozen line, not a traveling bullet, so it needs its own max reach).
  // arcHeight/orbitRadius/orbCount remain unshipped (orbit is the 1.1 follow-up; the
  // fake-3D arc peak was simplified away — lob's xy motion is identical to straight).
  turnRateBrad?      // homing: max turn toward nearest enemy per tick
  blastRadius?       // lob: AoE grid radius on land
  returnAfterTicks?  // boomerang: tick at which vel reverses
  beamTicks?         // beam: total damage-window length
  beamTickInterval?  // beam: ticks between damage applications
  beamRange?         // beam: max reach along the frozen facing
  arcHeight?         // lob: peak of the fake-3D arc (bulletZ) — not shipped
  orbitRadius?       // orbit: grid radius of the circling bodies — not shipped
  orbCount?          // orbit: number of orbiting bodies — not shipped
  lifespanSec        // → lifespanTicks
  piercing?: bool
  bulletZ?           // cosmetic muzzle height for the fake-3D render (01); NOT a hit gate
}

MeleeSpec = {
  kind: 'melee'
  arcDeg, rangeGrid  // swing sector (→ brad half-angle + fp range)
  damage, knockback
  damageType?        // 'physical'|'fire'|'ice'|'lightning'|'poison' (07); omitted = physical
  swingSec           // → swingTicks (active-hit window, 07) — clamped into [1, cooldownTicks]
  deflect: bool      // does the swing deflect bullets in its arc (03) — ranged-vs-melee trade-off gate
  deflectSpeed       // grid/s of a redirected bullet (07). The swing's arcDeg/rangeGrid
                     //   IS the deflect sector — there is no separate blockArc.
}
```

### `BallisticId` catalog (`03` Frame axis)

`content/ballistics.ts` maps each `BallisticId` to a **per-tick velocity rule** + the params it reads (the params above). All integer/brad — no float survives a tick (`06`); `homing` uses squared-distance nearest + a brad turn cap (no trig beyond the shared `math/trig` table, `06`). **Shipped 2026-07-24 (ROADMAP 1.1, `ENGINE_VERSION` 15): `straight`/`homing`/`lob`/`beam`/`boomerang`.** `orbit` + radial `pattern` remain `03`'s landing-order tier-4 follow-up.

| id | per-tick rule | reads |
|----|---------------|-------|
| `straight` | `pos += vel` (shipped) | — |
| `lob` | fake-3D arc via `bulletZ`; on land, AoE hit in `blastRadius` | `arcHeight`, `blastRadius` |
| `homing` | rotate `vel` toward nearest enemy, ≤ `turnRateBrad`/tick | `turnRateBrad` |
| `boomerang` | reverse `vel` at `returnAfterTicks`; re-hits on the way back | `returnAfterTicks` |
| `beam` | hitscan the facing line; apply damage every `beamTickInterval` for `beamTicks` | `beamTicks`, `beamTickInterval` |
| `orbit` | `orbCount` bodies circling the actor at `orbitRadius` | `orbitRadius`, `orbCount` |

**Emission (single/spread/burst/radial) is not a `BallisticId`** — it is the `bullets`/`spreadDeg`/`burstCount` fields on `RangedSpec`, orthogonal to the motion rule, so any emission composes with any ballistic (spread-of-homing, burst-of-lobs). Melee has no ballistic; its frame is `arcDeg`×`rangeGrid`×`swingSec` (`03`).

### `EnemyBlueprint` (mirrors funny `UnitBlueprint`)

```
EnemyBlueprint = {
  type, nameKey, skinRef
  hp, armor          // integers; takeDamage = max(1, raw-armor) (07)
  moveSpeed          // grid/s → fp/s
  radius             // grid → radius_fp (07 collision)
  weapon?: WeaponId  // enemies fire through the same weapon system (02/03)
  resist?: Partial<Record<DamageType, number>>  // per-type per-mille mult (07); 1000=normal, missing=neutral
  tint?              // render-only body colour (01); the sim never reads it
  element?           // render-only element identity (13's dual-channel law); the sim never reads it
  bodyRig?           // render-only rig/atlas key (13); the sim never reads it — undefined = shared 'critter-core' body
  aiProfile: AiId    // behavior selector read by the AI system (08 step 2)
  traits?: Trait[]   // tagged behaviors: aura_heal, enrage, shielder, …  (funny traits)
  onDeathSpawn?: { type, count }   // boss adds (funny)
  isBoss?: bool
}
```

> **Shipped 2026-07-10 (`ENGINE_VERSION` 8).** `content/enemies.ts` holds `ENEMY_BLUEPRINTS: Record<type, EnemyBlueprint>` (basic + elemental variants emberling/frostling/galvanist/ironclad). A wave spawn entry is `[x, y]` (basic) or `[x, y, type]` (`SpawnSpec`), resolved through the registry by `SpawnSystem`; a bare `[x, y]` and any unknown type fall back to basic — a forward-compatible content add (new ids + optional field), so it did **not** bump the version on its own. The elemental status runtime (`StatusState`: burn/chill/poison fields) lives on every `Actor`, constructed via `freshStatus()`; it is plain data mutated only by `StatusEffectSystem` (`07`/`08`).

> **Boss shipped 2026-07-11 (no version bump).** `blightlord` — a durable finale (`maxHp 40`, 2× radius) that exists to *show* the combat systems: its big HP pool lets poison stacks ramp to full and lingering burn/chill/poison auras persist, while a broad `resist` (physical ×0.4, fire/ice/lightning ×0.8, **poison ×2.0**) forces the right tool — venom melts it. `boss?: bool` is the shipped form of the aspirational `isBoss` but **render-only** (like `tint` — the sim never reads it): the view draws a floating HP bar so the poison melt is legible. Added as a `blightlord` finale wave; another new id + optional render field, so still no version bump.
>
> **`onDeathSpawn`/`enrage` shipped (`ENGINE_VERSION` 27).** The two aspirational traits above are real, on the Blightlord only so far: `enrage` (below 30% HP, +50% damage/+50% fire rate, a one-way latch + fx-only `enrage` event) and `onDeathSpawn` (2 `basic` adds ring-spawned around its death position on death, clamped into walkable space). Both are plain `EnemyBlueprint` fields, not the funny-style open `Trait[]` array sketched above — `traits?: Trait[]`'s generic tag-dispatch shape stays aspirational; each concrete trait got its own typed field instead (`enrage?: EnrageSim`, matching the rest of this codebase's "typed data over an open behavior tag" convention). `content/enemies.ts`'s `buildEnemyActor` is now the ONE EnemyActor factory — SpawnSystem (waves/dungeon/arena) and DeathDropsSystem (adds) both call it, so a new blueprint field never needs hand-duplicating into three separate object-literal call sites again.

> **`element` shipped (2026-08-25, no version bump) — the icon half of `13`'s locked dual-channel colour law.** A third render-only field in the same family as `tint`/`bodyRig`/`boss`: authored on the blueprint, copied onto `EnemyActor` by `buildEnemyActor`, never read by the sim, and absent from `serializeState`/`hashState` like the rest of them. It names which of the five elements a variant IS, so the view can draw the ICON channel (`client/src/game/elementIcons.ts`) alongside the COLOUR channel `tint` already carried — until this, `13`'s "told apart by colour + icon alone" was half-built, with the icon half existing nowhere in the codebase.
>
> **Authored, deliberately not derived from `resist`.** A "the type it shrugs off hardest is its element" rule is one line, needs no schema change, and is wrong on two of the blueprints that must NOT be badged: `brute` resists physical (700) without being the physical variant, and `blightlord` — the boss whose entire flavour is poison, and which is *weak* to poison at 2000 — resists physical hardest (400), so it would have been badged as the physical mob. Exactly the four locked elemental variants carry the field (`emberling`→fire, `frostling`→ice, `galvanist`→lightning, `ironclad`→physical); `content/enemies.test.ts` sweeps the registry to assert both that list and that the derived rule would have been wrong, so the reasoning is recorded as a test rather than as a comment.

> **`stalker`/`ravager` shipped (2026-09-05, `ENGINE_VERSION` 59) — the roster's first MELEE mobs, and the schema change that had been quietly forbidding them.** Every roster addition above was forward-compatible because a blueprint only ever gained ids and optional fields. This one is not: `EnemyBlueprint.weapon` was TYPED `RangedSimSpec`, so a melee mob was not a content gap — it was unrepresentable, and "all eight blueprints are ranged" looked like a decision when nobody had made one. Widened to the full `WeaponSimSpec` union, with two new mob loadouts (`enemyclaw`/`enemymaul`, excluded from `WEAPON_SIM_BY_ID` alongside `enemygun` via `MOB_WEAPON_IDS`, so neither can roll as a drop). The AI needed nothing — `AIDecideSystem` never reads a weapon's kind; it walks a mob to its `engageRangeFp` ring and `WeaponFireSystem` branches — but `HitResolveSystem`'s melee pass looped `state.players` only, which is the second half of the same constraint: a melee mob authored against the widened type alone would have swung and dealt nothing. `stalker` is the first blueprint to author `aggroRangeFp` (wider than the roster default — a rusher woken at a shooter's distance spends its whole approach inside the notice delay); both author `engageRangeFp`, which for a melee mob is the one number deciding whether it can reach you at all, and `meleeEnemies.test.ts` asserts each stops INSIDE its own blade's reach. Neither carries `deflect` — see `03`. Why the ammo economy is what motivated them: `05`.

> **`brute`/`floater` shipped (2026-07-28, no version bump) — body-form variety, not elemental.** `13`'s "roster variety beyond the base body: a heavy brute, a floating ranged form" landed as two more `EnemyBlueprint`s: `brute` (armoured bruiser — bigger `radius`/`maxHp`, a flat `resist:{physical:700}` rather than an elemental weak/resist pair) and `floater` (a fragile, lower-`maxHp` form). Neither introduces new AI — both fire through the same shared enemy gun/chase behavior every variant above uses; the differentiation is silhouette + stats only, exactly like the elemental re-tints. This is also where `bodyRig?: string` enters the schema: a render-only field (copied onto `EnemyActor` at spawn, same convention as `tint`/`boss` — the sim never reads it) naming which `render/skinRegistry.ts` rig-and-art bundle draws the body. Every pre-existing blueprint leaves it `undefined` and keeps drawing the shared `'critter-core'` body (`game/scene/Actor.ts`'s existing fallback); `brute`/`floater` are the first to point elsewhere (`'brute-core'`/`'floater-core'`) — new art bundles, but reusing `critter-core`'s own one-bone `Rig`/reference-radius rather than a new rig definition (the "one Rig, many skins" pattern `02`/`12` already established for the 3 orb-core characters). New ids + one new optional field, so — like every roster addition before it — forward-compatible, no `ENGINE_VERSION` bump.

`PLAYER_BASE` holds the stats **shared by all characters** (collision radius, move speed, `WEAPON_SLOTS = 2`, `startWeapons` — the auto-granted starter PAIR, one gun + one melee weapon, which is also the per-kind default table `resolveLoadout` fills a crafted loadout's free slots from, so a run always spawns able to swap (`ENGINE_VERSION` 45; it used to be a single pistol and every ordinary run got only that), `SHIELD_REGEN_DELAY`/`SHIELD_REGEN_INTERVAL`, revive channel length & restored HP); the **chosen `SkinDef`** supplies the per-character `(maxHp, maxShield, maxEnergy)` + `shieldBreak`. At match start the two are merged into the `PlayerActor`; in-run buffs then modify a *copy* via the build layer below — never the shared constant.

### `SkinDef` (`02`)

Skins are content too, and `02`'s "animation data separate from texture" is a data-format decision. A skin **is** the character, so it also carries the character's entire gameplay contribution: its `(maxHp, maxShield, maxEnergy)` stat triple and its shield-break passive (`02`/`05`/`07`):

```
SkinDef = {
  id, nameKey             // i18n key only (added 2026-08-15, matching every other
                          //   content type's own nameKey — see design/17-i18n.md);
                          //   this schema originally had no display-name field at all
  atlasKey                // texture atlas to swap (02)
  animRef: AnimId         // shared animation-data reference (frame timing, events)
  maxHp                   // integer hard-floor HP (05); recovered only by heal items
  maxShield               // soft buffer, absorbed before HP; auto-regens (05/07). NOT required
                          //   to be an integer — the shipped vanguard is 3.2 on purpose (07's
                          //   two-pool decision explains why that is safe and what it costs)
                          //   NOT balanced to equal EHP: 11/0 juggernaut vs 3/6 skirmisher (05)
  maxEnergy               // weapon-energy capacity (03, ENGINE_VERSION 60). The roster's third
                          //   axis and the only one that is not defensive, so it is NOT part of
                          //   the equal-worth budget band (14) — energy is not denominated in
                          //   hit points and summing them would be an invented exchange rate.
                          //   It IS part of the Pareto side-grade rule, which makes that rule
                          //   stricter. Spreads OPPOSITE the body: skirmisher 130 / vanguard
                          //   BASE_MAX_ENERGY 100 / juggernaut 70. Legal on an axis that crosses
                          //   the PvP wall only because regen is a flat shared constant, so
                          //   capacity buys burst length and provably not sustained dps (03).
                          //   Carried into the arena UNSCALED, unlike maxHp/maxShield (15).
  shieldBreak?: ShieldBreakPassive  // fires the instant shield hits 0 (07); the concrete
                          //   form of 02's "minor passive". Omitted for 0-shield characters.
}
ShieldBreakPassive =      // tagged data, interpreted by combat (07) — no inline code
  | { kind: 'aoe';   radiusGrid; damage; damageType? }   // burst on nearby enemies
  | { kind: 'knock'; radiusGrid; impulse }               // shove nearby enemies back
AnimData = {
  clips: Record<ClipName, { frames: Frame[]; fps; loop }>
  socketAnchors: Record<frameIndex, { x, y }[]>  // 02/13 orbiting weapon-socket poses per
                                                  //   frame (one entry per mount) — weapon mount
}
```

`socketAnchors` is what `02`/`07` mean by "the weapon mount tracks the character's orbiting socket every frame": it is *data*, per animation frame (one entry per socket), not hard-coded. Animation is render-layer data (no fp needed — it never feeds logic), but it lives in the content catalog so a character swap is a pure data swap.

## Rarity & run buffs (`03`/`14`)

The in-run power axis (`05`) is **finding a better weapon + run buffs** — *not* weapon affixes. The **affix system is cut** (`14`, Soul-Knight route): no `Affix`/`AffixId`, no `AFFIX_FIELD_MAP`/`EFFECT_CAPS`/`applyAffixes`, no `AFFIX_DROP_POOL`, and no `elem_*` set-element affix. A weapon is fully defined by **frame + baked-in element + a fixed stat row + intrinsic rarity**. ✅ **Done** — the removal was `ENGINE_VERSION` 9→10 (ROADMAP 0.1); this paragraph called it "tracked as a separate task" until 2026-09-03, and the same sentence also listed "no `k_*` procs" among the things cut. **That last item is wrong**: `k_*` on-hit procs are a shipped, first-class part of a `WeaponSpec` (`ENGINE_VERSION` 28 — `k_lifesteal`/`k_ricochet`, carried by `leech`/`carom`, see `03` and the Frame-content item under "To design"). What the affix cut removed was the *rolled per-instance* proc; a proc baked into one weapon was never an affix.

**Rarity — intrinsic, fixed per weapon (`14`):**

```
RarityTier = 'common'|'fine'|'epic'|'legend'|'legendary'   // 白 蓝 紫 橙 金
RARITY_TIERS: Record<RarityTier, { qualityMult; colorKey; … }>   // small base-quality edge

WeaponSpec = { …frame + element fields…; rarity: RarityTier }    // rarity is a field, not a roll
```

- **Rarity is a property of the weapon, not a per-instance roll and not an upgrade.** A weapon *is* a rarity; it never levels. Higher rarity = a **small** numeric edge + mainly better *handling/usability* (tighter spread, smoother fire rate/ballistic, better arc) — never crushing (`14`).
- **Colour is the primary read** (白→蓝→紫→橙→金); it drives the compare-card border and a per-rarity **ornament/emissive overlay** on the frame sprite (`03`/`12`), while the five element hues stay reserved for combat FX (`13`).

**Run buffs — the in-run layer that replaces affixes:**

```
RunBuff = { id: RunBuffId; value: number }     // run-scoped, player-level; wiped at run end (05)
RUN_BUFFS: Record<RunBuffId, { kind: 'mult_damage'|'mult_firerate'|'flat_hp'|'crit_chance'|'flat_energy'; target }>
BUFF_CAPS: Record<kind, cap>                    // Σ-then-clamp, deterministic apply order
```

> **`flat_energy` — the fifth family, and the first card-only one (2026-09-06, `ENGINE_VERSION` 60, `03`/`05`).** `cell_up` (+30 max energy, cap 120 = four picks exactly, so no pick is ever a fractional dud). It is the second **absolute** family after `flat_hp`, and `PickupSystem.applyBuff` applies both off ONE `sumBuffs` pair — raising the ceiling and the current value together, because a card that moved the cap without filling it would give a player who took it while empty nothing at all until regen caught up. It is deliberately **absent from `BUFF_DROP_POOL`** (`content/drops.ts`'s `CARD_ONLY_BUFF_IDS`, pinned by `drops.test.ts`): capacity is worth nothing to a player on the sustainable starter gun, so as a 1-in-5 floor drop it would dilute four unconditional families to pay for a conditional reward — a pick-one-of-three card is the right home for that. The test requires every catalogue id to be in exactly one of the two lists, so a new family stranded in neither fails rather than shipping unobtainable.

> **The `energy` drop kind shipped (2026-09-05, `ENGINE_VERSION` 59, `03`/`05`).** A sixth `PickupKind`/`DropResult` and the ammo economy's refill: payload-free (the amount is the constant `ENERGY_PICKUP_AMOUNT`, not a per-drop roll), so its branch costs the same single table draw `heal` does and adds no new PRNG consumption to the stream. Weight 16 of 84, taken OUT of `material` and not off the total — the same discipline the 2026-09-05 heal re-weight used, so `weapon` and `buff` keep the exact per-kill odds they had and the two passes stay readable apart afterwards. `ARENA_DROP_TABLE` carries it too (weight 25), because the arena's loot pool is its entire power curve (`15`) and a looted heavy frame would otherwise have no supply line at all.

- Buffs are **found in-run** (chests / rooms / shop is the design; the shipped reality is a 6/84 weight on the flat kill `DROP_TABLE` **plus the floor-card offer at every checkpoint** — `05`'s loot-economy section, `ENGINE_VERSION` 58; five of the seven cards in `balance/floorCards.ts` grant a `RUN_BUFFS` id deliberately rather than defining their own magnitudes, so a card and a floor drop of the same buff are the same strength and `BUFF_CAPS` bounds them together — `ROADMAP` B1/B2) and apply to the player / all held weapons, summed-then-clamped in a fixed order so it stays deterministic (`06`). They are **not** attached to a weapon and never carry out.
- **Unknown weapon / skin / buff id → ignored** (forward-compat).

## The build layer — the fairness wall

Two builders, and the *types themselves* enforce `05`/`06`:

```
// PvE run: chosen character + crafted loadout (from unlocked blueprints, 14) + in-run buffs
buildRunSpecs(skinId: SkinId, loadout: WeaponId[], runBuffs: RunBuff[]): ResolvedSpecs

// PvP arena: a preset id + the chosen character — and NOTHING weapon-side
buildArenaSpecs(presetId: ArenaPresetId, skinId: SkinId): ResolvedSpecs
```

`buildArenaSpecs` physically cannot receive a weapon / material / blueprint — there is no parameter for it (funny's compile-time wall, unit-tested). PvP weapon power comes only from `ARENA_PRESETS[presetId]` + on-map pickups (`05`). The **only** meta input it accepts is `skinId` — the chosen character's `(maxHp,maxShield)`+passive apply (plus `maxEnergy`, unscaled — `15`), held fair by side-grade balance discipline + tests (`14`), *not* by the wall. PvE builds through `buildRunSpecs`, where the crafted loadout is a *known opener* (a crafted weapon = a found weapon, `05`/`14`) and in-run buffs are the power fantasy.

## World data

### Collision geometry — `RoomState` (deferred from `07`) ✅ schema shipped 2026-07-24 (ROADMAP 1.2)

A room's static solids and markers, all on the `gx/gy` grid (`01`). `content/rooms.ts` implements this shape (`RoomPiece`/`Point`/`SpawnPoint`/`AabbGrid`/`PillarGrid`/`ExitDef`/`PropPlacement`/`WaveScript`/`WaveEntry`/`RoomRole`) plus the pure `roomGeometry(piece, offsetXGrid?, offsetYGrid?)` converter to sim `{ walls: AABB[]; obstacles: Obstacle[] }`. `GameState` gained a `walls: AABB[]` array (sourced from `EngineConfig.walls`, parallel to the existing `obstacles`) and `MovementSystem`/`ProjectileStepSystem` resolve against it (`07`) — additive, no `ENGINE_VERSION` bump (every existing config omits `walls`, so it stays empty). ~~**Remaining:** no `RoomPiece` content is authored yet, and nothing places a piece into a live `GameState`.~~ **Both closed long since** (1.3, then the hand-authored level of 2026-08-15): 14 `RoomPiece` files under `world/dungeons/ember/pieces/` plus the seven original `EMBER_ROOMS` fixtures, and `placeAuthoredFloor`/`placeFloor`/`placeFloorGraph2d` all stitch them into a live floor through `buildFloorGeometry`. Struck 2026-09-03 — see the superseded note below, which this line sat two paragraphs above.

```
RoomPiece = {
  id, sizeGrid: { w, h }
  solids: AABB[]              // static collision rects (07 actor–wall / bullet–wall)
  pillars?: { center, radius }[]  // round static solids (07 — implemented as circle push-out)
  spawns: { player: Point[]; enemy: SpawnPoint[] }
  exits: { edge, toTag }[]    // connective openings for dungeon assembly
  props?: PropPlacement[]     // decorative + Y-sortable pillars (01)
  encounter?: WaveScript      // per-room enemy script (see below)
}
```

`solids` are integer-grid AABBs → converted to `Fp` bounds on load. This is the schema `07` said it needed and left to `09`.

`exits` is still not read by the sim's own traversal (room-to-room movement is an automatic
teleport to the next room's spawn on clear, never "walk through a door" — confirmed by grep
2026-08-02) — but `ember.ts`'s `perimeterWalls()` content helper now reads it render-side, to
decide which edge of a room's new perimeter wall (added 2026-08-02, design/10 legibility
pass) gets a door-shaped gap instead of a solid segment. A cosmetic consumer, not the
"connective opening for dungeon assembly" the schema originally named — that remains open.

**Superseded by `05`'s room & door model.** ✅ **Shipped 2026-08-04 (`ENGINE_VERSION` 34).**
PvE floors moved from the single-room-at-a-time swap above to the same co-resident
multi-room graph PvP's `ArenaMap` already uses: every room in a floor stays live in
`GameState` at once. `RoomPiece.exits` itself is unchanged (still just `{edge, toTag?}`
authoring metadata, read by `world/dungeon.ts placeFloor` to validate which pieces can
chain to which) — the real traversable door data is a `content/arenas.ts` `Door{roomA,
roomB, passageGrid}` **reused verbatim**, computed at placement time
(`placeFloor`/`pickDoorAnchor`), never wall-centered. `GameState` gained
`dungeonRooms`/`dungeonDoors`/`dungeonRoomRuntime` (an `activated` + `hasLiveEnemy` pair
per room — activation gates AI logic via `AIDecideSystem`, `hasLiveEnemy` gates each
door's lock via the new `DoorSystem`, step 11.5) /`dungeonRoomRects`/
`dungeonRoomIndexById`/`dungeonBaseWalls`. `world/dungeon.ts` also gained
`placeFloor`/`carveDoorGaps`/`buildFloorGeometry` (a west→east spine placement — still the
MVP shape; a real free-form 2D graph layout stays deferred). ✅ **Client rendering also
shipped 2026-08-04 (same-day follow-up):** `HudView.ts`'s floor/room HUD line was fixed to
the new per-`roomId` schema, and the door sprites
(`art/environment/door_{locked,open}_raw.png`) are now wired — `RoomBuilder` draws one
`Sprite` per `state.dungeonDoors` entry (excluded from the generic wall fill, texture/tint
swappable in place on lock/unlock, no full room rebuild), and `EventReactor` reacts to
`force_regroup` with a camera snap. ✅ **Fully-realized branching shipped 2026-08-05
(`ENGINE_VERSION` 35):** `layout:'branching'` no longer just perturbs the linear pick via
an extra generation-time draw — a floor now gets one real fork-and-reconverge diamond of
distinct, same-width sibling `PlacedRoom`s, placed side-by-side and each with its own
door, a real walk-through-the-door choice (see `05`'s matching section for the full
draw-sequence/placement design). ✅ **PvE minimap adapter shipped the same day:**
`FloorProgress` is retired — PvE now shares PvP's own `Minimap` widget via two new
`minimapLayout.ts` converters (`dungeonToArenaMap`/`dungeonRoomStatus`). See `design/05`'s
"Room & door model" section and `ROADMAP.md` for the full account. ~~**Still open:**
map-editor door placement, same as noted in `05`.~~ **Closed 2026-08-05** — see `05`'s
"Hand-authored PvE floors": `tools/map-editor` gained a third mode ("PvE Dungeon Floor")
that hand-places a `RoomPiece` instance with a door at a chosen position, and level 1's
five floors are authored through it (`world/dungeons/ember/`). This line survived the fix
by 26 days: the same docs-drift shape `ROADMAP.md` records under "the measurement moved on
and the paragraph that quoted it did not".

### Dungeon assembly (`05` hybrid) ✅ generation shipped 2026-07-24 (ROADMAP 1.3, additive — no `ENGINE_VERSION` bump)

⟂ The core divergence from funny. Instead of one scripted level, a **seeded layout stitches hand-authored pieces**. `world/dungeon.ts` implements `DungeonConfig` + the pure `generateFloor(config, floorIndex, roomgenPrng, library)`: draws a room count within `roomsPerFloor`, then that many normal pieces from the `pieceTags`-matched pool, appending the floor's capstone (`extractionPieceId`, or `bossPieceId` on the last floor) — same "pure, unwired" shape as `content/rooms.ts roomGeometry` (1.2). `GameState` gained the `roomgenPrng` stream this doc's schema always named (additive — nothing draws from it yet). `world/rooms/ember.ts` is a first hand-authored library (4 normal + 1 extraction + 1 boss piece, tagged `'ember'`). **Both `layout: 'linear'` and `'branching'` are implemented** (`world/dungeon.ts`, `GameState.ts`, `SpawnSystem.ts`, `dungeon.test.ts`). **Also since ROADMAP 1.4/1.5 (no longer remaining):** a generated floor IS placed into a live run — mutable room geometry, room-to-room transitions, and the encounter `WaveScript` driving spawns are all wired end-to-end, together with the extraction checkpoint and materials banking, into a real, testable dungeon loop (this is what the shipped client actually runs — ROADMAP Phase 1 is fully closed).

```
DungeonConfig = {
  biomeId, nameKey
  floorCount                  // ~5 tentative (05 to-tune)
  roomsPerFloor: { min, max } // 5–10 (05 to-tune)
  pieceTags: RoomTag[]        // which RoomPiece pools this biome draws from
  layout: 'linear'|'branching'|'graph2d'  // 05 reward-choice structure. 'graph2d' (2026-08-05)
                                 //   places a generated floor in real 2D instead of a west→east
                                 //   spine, and is what the shipped EMBER_DUNGEON uses.
  extractionPieceId: RoomPieceId // the per-floor extraction room (descend vs leave, 05)
  bossPieceId: RoomPieceId       // the deepest floor's room; its portal opens post-kill and
                                 //   doubles as that floor's extraction (05)
  branchFactor?: number          // 'branching' only: sibling rooms per fork stage (default 2)
  floorMaps?: Partial<Record<number, DungeonFloorMap>>   // per-floor hand-authored override
                                 //   (05 "Hand-authored PvE floors"); level 1 sets all five
  difficultyCurve: CurveSpec  // scales enemy count/tier by floor depth (05 to-tune)
  // ── NOT ON THE REAL INTERFACE (ROADMAP B4). Both were sketched here and never added
  //    to world/dungeon/types.ts — "unwired schema field" (as this doc and ROADMAP 1.5
  //    both said for a year) overstated it; there is no field. Depth→material quality is
  //    a `tier = floorIndex` identity inside rollDrop instead.
  dropTableByDepth?: DropTableId[]     // better pools deeper — DESIGN ONLY
  materialTierByDepth?: number[]       // material quality shift per floor (05) — DESIGN ONLY
}

RoomPiece.role?: 'normal' | 'extraction' | 'boss'   // extends the RoomPiece schema above;
                 // exactly one non-normal room per floor carries the extract/descend portal
```

- **Floors, not one flat room list.** Each floor is `roomsPerFloor` pieces with exactly one **extraction room** placed among them; its position gates how many rooms are skippable (`05`). The deepest floor's extraction *is* the boss room.
- Generation is driven by the injected **`roomgenPrng` seeded per run** (`06`/`08`), so a run is reproducible from `seed + input stream` — required for co-op determinism and headless re-judge (`06`). Layout/selection reuses funny's PRNG roomgen approach (`05`).
- **Encounter quality stays curated**: pieces are hand-authored; only their *arrangement* and *which enemies/tier* are procedural (`05`).

### Encounters — `WaveScript` (reuse funny's `WaveDirector`)

Per-room enemy timeline, structurally funny's `WaveScript`/`WaveEntry`, adapted from lanes to spawn points:

```
WaveScript = { entries: WaveEntry[] }
WaveEntry  = { atTick; enemyType; spawnPoint; count; spacingTicks?; isBoss? }
```

The `WaveDirector` (funny, ported) pre-expands `count`/`spacing` into a tick-sorted list and emits due spawns per tick via a monotonic cursor (`08` step 10). It reads only `tick` + its static script; its injected `Prng` is reserved for randomized spawn variety so those stay reproducible.

### Arenas & presets (`15` PvP) ✅ shipped — see `15` for the full schema

**Superseded the original symmetric-team-arena sketch below** once `15` locked PvP as an **8-player solo battle royale**: `ArenaMap` is *not* RoomPiece-like/symmetric — it is a **~60-room, simultaneously co-resident map**. *(This used to add "unlike a PvE floor's rooms, which are real but visited sequentially, one live at a time" — false since `ENGINE_VERSION` 34, 2026-08-04: a PvE floor is co-resident too, which is the whole reason its `Door` type is this file's `Door` verbatim and its rooms feed PvP's own `Minimap`. Corrected 2026-09-03; `15` carried the identical stale contrast in its own `ArenaMap` comment.)* `content/arenas.ts` implements the real shape:

```
ArenaMap = { id, sizeGrid, rooms: ArenaRoom[], doors: Door[], spawns: Point[], eyeCandidates: EyeCandidate[] }
ArenaRoom = { id, rectGrid, solids, pillars?, cellTraits?: CellTrait[], encounter?: WaveScript, lootMarkers?: LootMarker[], props? }
Door = { roomA, roomB, passageGrid }        // explicit adjacency — never inferred from rect proximity
CellTrait = { id, rectGrid, kind: 'spike'|'freeze'|…, timed, phase? }   // authored hazard tiles (15)
ARENA_PRESETS: Record<ArenaPresetId, { nameKey; loadout: WeaponId[] }>   // landing_basic ships
```

There is no separate `PICKUP_TABLE` — loot is per-room `LootMarker`s resolved through the same arena-scoped `DropTable` model as PvE (`content/drops.ts`'s `ARENA_DROP_TABLE`/`rollArenaDrop`, `material` structurally absent). The preset supplies only the **weapon loadout**; the player's `(maxHp,maxShield)`+passive+weapon damage come from `buildArenaSpecs(presetId, skinId)` scaled by `PVP_SCALE_FACTOR` (`14`; `maxEnergy` comes from the same `SkinDef` but is deliberately NOT scaled — `15`), and that scaled kit is what `GameState.buildSeat` actually assigns to a PvP seat (`ENGINE_VERSION` 19→20) — the seat's persistent PvE `loadout` is structurally never read for it. The real launch map is `arena_launch` — "The Seven Districts", hand-authored TypeScript content in `engine/world/arenas/` and imported directly by `arenaCatalog.ts`'s `ARENA_CATALOG`, the way PvE imports `EMBER_L1_ROOMS`. (Its predecessor `world/arenas/arena_prototype_60.json` was a generated lattice with no walls and its features in the wrong coordinate space; retired and deleted 2026-08-26.) `landing_basic` remains a small synthetic fixture for the `?arenaDemo=1` dev harness. See `15-pvp-arena.md` for the room-graph shrinking zone, `EnvironmentSystem`, team/hostility model, placement win condition, and anti-cheat checkpoints built on top of this schema.

### Drops, pickups & materials (`05`)

A `Pickup` on the ground is one of these kinds; `DropTable` rolls which drops from a slain enemy (or, in the arena, a loot marker — chests are `ROADMAP` B1, not built):

```
Pickup =
  | { kind: 'weapon';   spec: WeaponId }                     // in-run, ephemeral; rarity is on the WeaponSpec (05/14)
  | { kind: 'buff';     buffId: RunBuffId }                  // run-scoped in-run buff (14)
  | { kind: 'heal' }                                          // flat +1 HP (05/07). NOT collected
                                                              //   at full HP — the item stays on the
                                                              //   floor (05 "only when useful", v54)
  | { kind: 'material'; matId: MaterialId; qty; tier }       // the ONLY carry-out (05); `tier` is the
                                                              //   ROLLED depth quality, keyed via bankKey
  // Added after this block was first written (both listed here since 2026-09-03):
  | { kind: 'bandage' }                                       // PvP-only squad-revive currency (05/15)
  | { kind: 'crate' }                                         // PvP-only UNRESOLVED loot marker: rolls
                                                              //   into a real kind the first tick a
                                                              //   player is within lootRevealRadius, so
                                                              //   its value never sits in shared state
                                                              //   for a camera cheat to read (15)

DropTable = { entries: { itemPool; weight }[] }   // itemPool spans all kinds; weapon rarity is intrinsic to the WeaponId

MaterialDef = { id: MaterialId; nameKey; element: DamageType; tier }
              // 5 elemental kinds (03/14) × tier by depth; feeds forge recipes (14)
```

- **Materials are the run's only carry-out** and the meta-forge input. They are **banked at extraction rooms** (reaching one = a checkpoint, `05`); a run-ending death forfeits the **entire un-extracted carry-out** — this floor's buffer *and* everything banked-but-not-extracted earlier in the run (`05`'s locked wipe rule; this line claimed "only the current floor's" until 2026-09-03). ✅ **Shipped 2026-07-24 (ROADMAP 1.4/1.5, `ENGINE_VERSION` 15, additive):** `state.floorMaterials` (buffer) → `state.bankedMaterials` (carry-out), merged by the new `ExtractionSystem` on EXTRACT/DESCEND; forfeit-on-death is free at both tiers (the buffer is never merged, and the merged bag is never handed to the meta layer — `RunOutcome.lose()` skips `bankRunMaterials`). Gated entirely behind `EngineConfig.floors?` — every config that omits it is untouched.
- **Deeper floors roll better materials** — `dropTableByDepth` / `materialTierByDepth` (below) shift the pools by floor; weapon *finds* stay random at every depth (`05`). ✅ First-pass shipped: `rollDrop(prng, tier)` tags a material drop with a depth signal (`DeathDropsSystem` passes `state.floorIndex` — a straight identity curve). The configurable `materialTierByDepth` array, and `dropTableByDepth` entirely, are **`ROADMAP` B4**: neither is an unwired field, neither was ever added to the real `DungeonConfig`. So depth buys material TIER today and nothing else — a deeper floor rolls from the same drop pool as floor 1.
- Rolled from `dropPrng`; rewards are recomputed/validated server-side, never trusted from the client (funny ADR-006, `06`).

## Loading, validation, versioning

- **Load once, convert once.** At match start the engine resolves blueprints (human units → ticks/fp/brad) and freezes them into `GameState` (funny `state.unitBlueprints`). Nothing re-reads config mid-match.
- **Validate at load, not at use.** Bad data (undefined weapon ref, spawn off-piece, a buff targeting a missing field, a recipe naming an unknown material) fails loudly at load / in a content unit test — never mid-tick.
- **`ENGINE_VERSION` coupling.** A content change that only adds a new id is forward-compatible (ignored by old engines). A change to how existing data is *interpreted* (conversion rule, buff arithmetic, ballistic behavior) can diverge replays → bump `ENGINE_VERSION` (`08`). The affix-system removal (`14`) was exactly such a change — it bumped `ENGINE_VERSION` 9→10 (ROADMAP 0.1). The Phase-0 sync that followed took the engine to **`ENGINE_VERSION` 14**: run-buffs (10→11), two-pool shield (11→12), characters=SkinDef (12→13), pickup vocabulary (13→14); intrinsic rarity was additive (no bump).
- **i18n boundary.** Engine data carries only string keys; the client owns the translation tables.

## Relationship to the other docs

- **`03`:** `WEAPON_SPECS`/rarity/ballistics are the concrete form of its `RangedSpec`/`MeleeSpec` "to design" list and its Frame × Element composition (affixes cut, `14`).
- **`02`:** `SkinDef` + `AnimData.socketAnchors` realize "animation separate from texture" and "the weapon socket follows the frame."
- **`05`:** dungeon assembly, drop tables, arena presets, difficulty curve — the data behind its core loop, economy, and PvP; its open design questions (room count, reward structure, preset set) fill these schemas.
- **`07`:** `RoomPiece.solids`/`pillars` are the collision geometry (both implemented — round-pillar push-out and AABB rect push, the latter since ROADMAP 1.2; this line said "AABB tiles deferred" until 2026-09-03); `WeaponSpec`/`EnemyBlueprint` feed its damage/ballistic bodies.
- **`08`:** the build layer resolves specs into `GameState` at match start; `WaveScript`/`WaveDirector` is step 10; all PRNG-seeded content obeys its determinism contract.
- **`06`:** single-source config, human→fp/brad conversion, injected PRNG, and the fairness wall all originate there.

## To design

*Phase-0 sync (ROADMAP 0.1–0.6) shipped first-pass versions of several items below; each is annotated with what remains.*

- ✅ **Concrete first-pass numbers** for the demo weapons + a starter/elemental enemy set — shipped in `content/*.ts`.
- **Character roster** (`02`/`05`): ✅ done (ROADMAP 2.3). `PLAYER_BASE` + two side-grade `SkinDef`s (vanguard, skirmisher) with `(maxHp, maxShield)` + `shieldBreak` shipped first (ROADMAP 0.5); the full 3-character launch roster — vanguard (6/3.2) / skirmisher (3/6) / **juggernaut** (11HP/0shield, the flat-HP tank) — shipped in Phase 2.3. *(Those are the shipped numbers as retuned 2026-07-28 against `pvpBalanceSim`; this line said "9HP/0shield" until 2026-09-03, and `14`/`05`/`ROADMAP` 2.3 each carried a different stale triple.)* *Remaining:* free-vs-paid split, revive timings. (Regen timings currently live in `config.ts` `SHIELD_REGEN_*`, not `PLAYER_BASE` — a shielded-actor constant shared beyond the player.)
- **Material catalog & forge recipes** — ✅ done (ROADMAP 2.1). The `MaterialDef` shape + a base tier-0 catalog (5 elemental kinds, `content/materials.ts`) shipped (ROADMAP 0.6); first-pass tier-by-depth rolling + the floor-buffer/carry-out bank shipped (ROADMAP 1.4/1.5); the forge outpost, per-weapon `element × qty × min-tier` recipes, and `minTier` enforcement all shipped in Phase 2 — the material bank keys by `(element, rolled tier)` via `content/materials.ts`'s `bankKey`/`parseBankKey` (additive, tier 0 keeps the flat legacy key), so a recipe genuinely demands materials from deep-enough floors; spending is lowest-qualifying-tier-first (`meta/forge.ts`).
- **Rarity tiers & run-buff catalogue** (`14`): first-pass `RARITY_TIERS` (0.2) and `RUN_BUFFS` families/caps (0.3) shipped — all five families now real: `crit_chance` (`ENGINE_VERSION` 26, `07`'s crit sketch) and `flat_energy` (`ENGINE_VERSION` 60, `03`'s ammo economy — the one family a floor drop can never roll, see the note above). *Remaining:* the final base-quality numbers and an actual chest/room/shop offering flow (buffs still only drop off the flat `DROP_TABLE`).
- ~~**`RoomPiece` authoring pipeline**: hand-edit JSON, or a small editor?~~ **(decided, 2026-07-25):** a dedicated map editor, not hand-edited JSON. The same editor also authors PvP's `ArenaMap`/`ArenaRoom`/`CellTrait` (`15`) — one tool, two output schemas (`RoomPiece` for PvE floors, `ArenaMap` for the PvP arena). Format/round-trip tooling details remain open.
- **Difficulty & material curve** (`05`): how enemy count/tier and material quality scale with *floor* depth; extraction-room placement rules; boss-piece rules.
- **Arena preset set** (`15`): win condition (placement, `WinConditionSystem`'s `tickPlacement` path) and per-room loot (`LootMarker`+arena `DropTable`) are shipped and schema-fixed — see the Arenas & presets section above. *Remaining, content-tuning only:* preset count/archetypes beyond the single shipped `landing_basic` (preset supplies weapon loadout only; character stats come from `skinId`, `14`).
- **Character balance-test suite** (`14`): ✅ done (ROADMAP 2.3). A side-grade / no-all-rounder STUB shipped first (`skins.test.ts`, no Pareto domination on `(maxHp, maxShield)`, ROADMAP 0.5); the full suite covering all 3 launch characters — Pareto-non-domination, per-axis spread, equal-worth budget band, no inert passive on a zero-shield body — shipped in Phase 2.3. `ENGINE_VERSION` 60 widened Pareto and the spread check to the `(maxHp, maxShield, maxEnergy)` TRIPLE (stricter: one more column a would-be all-rounder must lose on) while leaving the budget band summing only the two defensive axes, and added a gate pinning the DIRECTION of the new axis by name — deepest pool on the smallest body. *Remaining:* extending it to future purchased characters as they're added.
- ✅ **Frame content & tuning** (`03`) — shipped 2026-07-24 (ROADMAP 1.1, `ENGINE_VERSION` 15): `content/ballistics.ts` implements `homing`/`lob`/`beam`/`boomerang` (+ spread emission in `WeaponFireSystem`), plus melee `hammer`/`spear`. `orbit`/radial `pattern` shipped `ENGINE_VERSION` 16; `k_*` procs (`k_lifesteal`/`k_ricochet`) shipped `ENGINE_VERSION` 28 (see `03`). *Remaining:* tuning the `WeaponSpec` rows per frame × element × rarity (the new frames shipped physical-only showcases).

## Open questions

- **Content format: TS modules or JSON?** TS gives type-checking and lets constants reference each other (funny is all TS); JSON enables a data editor and hot-reload but needs a schema validator. Likely TS for balance, JSON for room pieces (bulky, tool-authored). Decide with the authoring pipeline.
- **Where do arena maps and dungeon pieces physically live** — in-engine (bundled, versioned with code) or fetched (updatable without a client release)? Fetched content complicates the `ENGINE_VERSION`/replay guarantee.
- **Run-buff application order** (mult-then-add vs interleaved) and stacking caps — affects both balance and determinism (`14`; the old affix-order question, re-scoped to run buffs).
- ~~**Shield-break passive scope**~~ **(resolved, `14`):** characters *do* enter PvP via `buildArenaSpecs(presetId, skinId)`, so the break-passive **survives** — the whole character (HP/shield + passive) is kept fair as a side-grade by balance discipline + a test suite, not walled out. This is the disciplinary (not structural) half of the fairness model.
- **Per-room vs per-run seed derivation**: one `roomgenPrng` for the whole run, or a child stream per room? Child streams make a single room re-generable in isolation (useful for tooling) but must derive deterministically from the run seed.
