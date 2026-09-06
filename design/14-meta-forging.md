# Meta & forging

The persistent layer **between runs**: what carries across, what materials buy, how the outpost forge works, and how monetization stays fair without breaking PvP. This is the "meta doc" deferred from `05` (economy), `09` (materials / forging / build layer) and `13` (outpost). It is the single source of truth for **blueprints, crafting, rarity, the character roster, and monetization**, and must stay consistent with `06`'s casual-first / PvP-fairness and `05`'s ephemeral-in-run rule (weapons are wiped every run; materials are the only carry-out).

## The decisions (locked)

### Forging & blueprints

- **Blueprint = permanent account unlock; a crafted weapon = one run.** Forging has two layers. You first **unlock a blueprint** (the *right* to make a weapon) — permanent, account-level, never lost. Then each run you **craft an instance** from an unlocked blueprint by spending materials, and that instance can enter **exactly one** run: like every weapon it is wiped at run end (`05`). Want it again next run → craft it again.
- **Blueprint sources: drops / purchase / events.** **2–3 common blueprints drop from runs** (permanent the moment you obtain them). The rest are **bought (RMB) or earned from time-limited events**. A blueprint is *not* a material — it is account-level and never forfeited on death.
  - ⚠️ **The "drop from runs" half is not built (`ROADMAP` B5).** `Pickup` has no blueprint kind and no drop table can roll one, so nothing in a run ever grants a blueprint. What ships instead is `STARTER_BLUEPRINTS` — *every* `source: 'drop'` entry, **5** of them today (repeater, flamer, scattergun, hammer, spear), unlocked at account creation so the forge has something to craft. `content/blueprints.ts` says as much in its own comment (*"a full build would grant them on the actual in-run drop"*). Two consequences worth naming: the count is 5, not "2–3", and a blueprint is not something a player can *earn by playing* — only bought, or given free at the start.
- **A brought-in weapon = a found weapon.** A crafted weapon you bring in is mechanically identical to one found on the floor — no stripped-down baseline, no bring-in bonus. Bringing one just guarantees a known opener; the floor can still hand you something better. (Matches `05`'s economy table.)
- **Crafting cost = elemental materials, per-weapon recipe.** Materials come in **five elemental kinds** matching the five damage types (`03`/`13`: physical / fire / ice / lightning / poison), each **tiered by depth** (`09` `MaterialDef.tier` — deeper floors roll higher-tier crystal). Every weapon's recipe names which kinds, how much, and a minimum tier; recipes differ per weapon. Materials are the run's only carry-out (`05`) and the **sole** crafting currency — there is no separate soft currency.

### Rarity — intrinsic, no upgrades

*Shipped: ROADMAP 0.2 (`balance/rarity.ts` — `RarityTier` white→gold, `RARITY_TIERS` per-mille quality mult + colour key, applied at weapon convert time; additive, no `ENGINE_VERSION` bump). The five base-quality numbers remain first-pass, tuning per 09.*

- **Rarity is a fixed property of the weapon, not a roll and not an upgrade.** A weapon *is* its rarity; it never levels up, and there is **no weapon-upgrade system**. This replaces `09`'s old "rarity = number of affix rolls."
- **Higher rarity = slightly stronger, and mainly more *usable* — never crushing.** The rarity axis is primarily a *handling / quality* gradient (tighter spread, smoother fire rate, better ballistic, more generous arc) with only a small numeric edge. You reach for a high-rarity weapon because it *feels good to use*, not because it deletes the screen. This keeps even PvE power off a hard ladder.
- **Five tiers; colour is the primary read:**

  | 档位 | rarity | 颜色 | 定位（fixed base quality） |
  |------|--------|------|--------------------------|
  | 普通 | common | 白 white | baseline，能用 |
  | 精良 | fine | 蓝 blue | 数值略升、手感更顺 |
  | 史诗 | epic | 紫 purple | 明显好用 |
  | 传说 | legend | 橙 orange | 强且顺手 |
  | 传奇 | legendary | 金 gold | 顶：数值最好 + 最好用，但不碾压 |

- **Rarity reads off the weapon sprite + a border colour; element stays on FX.** Higher-rarity weapons look visibly more elaborate — an **ornament / emissive overlay layered on the frame sprite** (not a separate sprite per rarity, which would multiply `03`'s frame×element production). The five element hues (`13`) stay reserved for combat FX / trails / status auras; rarity lives on the border + sprite ornament, so the two colour languages never fight for the same pixels. (Border yellow/gold and orange sit near lightning/fire hues — the channel split, not distinct hues, is what keeps them legible.)

### No weapon affixes — the Soul-Knight route

- **The affix modifier layer is cut.** No `m_/s_/k_` affixes, no `applyAffixes` / `EFFECT_CAPS`, no element-changing `elem_*` affix. *(This also said "no `k_*` procs" until 2026-09-03. Wrong, and `09` carried the same sentence: `k_lifesteal`/`k_ricochet` are shipped since `ENGINE_VERSION` 28, baked into `leech`/`carom`'s own stat rows. What the cut removed was the per-instance ROLL; a proc that is a fixed property of one weapon is a frame trait, not an affix.)* A weapon is fully defined by **frame + element + a fixed stat row + its intrinsic rarity** — `03`'s composition model shrinks from **Frame × Element × Affix** to **Frame × Element**. Element is **baked into the weapon** (a "fire rifle" and an "ice rifle" are two different weapons / blueprints), never swapped by a drop.
- **In-run power axis = better weapons + run buffs.** With affixes gone, the moment-to-moment power fantasy (`05`) is *finding a better weapon* (higher rarity, or a frame×element that counters the room) plus **run-scoped generic buffs** — player-level, Soul-Knight style, wiped at run end. *Shipped: ROADMAP 0.3 (`balance/runbuffs.ts` — `RUN_BUFFS` `mult_damage`/`mult_firerate`/`flat_hp` + `BUFF_CAPS`, Σ-then-clamp, a `'buff'` pickup; `ENGINE_VERSION` 10→11). The catalogue is first-pass. `crit_chance` shipped too (`ENGINE_VERSION` 26 — this line said `crit` "remains to-design" until 2026-09-03); richer families are still open, and so is the offering flow (`ROADMAP` B2 — a buff still only falls off the kill table).*
- **Elemental *status* stays — only affixes go.** The damage-type + status system (burn / chill / chain / poison-stack + resist/weakness, `03`/`07`, shipped `ENGINE_VERSION 8`) is untouched and core to the fiction (`13` element=colour, elemental biomes). Only the affix layer is removed — including the `elem_*` set-element affix that shipped at `ENGINE_VERSION 9`. **DONE** (ROADMAP 0.1, `ENGINE_VERSION` 9→10): the entire affix layer (~22 engine/content files) is deleted; element now comes only from a weapon's baked-in `damageType`.

### Characters (the "skin" layer)

*Shipped: ROADMAP 0.4–0.5, then 2.3. Two-pool health (shield + idle regen + `shield_break`) is `ENGINE_VERSION` 11→12 (`07`/`08`); `content/skins.ts` `SkinDef` + `ShieldBreakPassive` (aoe/knock) + `PLAYER_BASE`, merged into the PlayerActor at match start, is `ENGINE_VERSION` 12→13. **The full 3-character launch roster ships** (ROADMAP 2.3): vanguard (6HP/**3.2**shield), skirmisher (3HP/**6**shield), juggernaut (**11**HP/0shield, the flat-HP tank); the break-passive fires in-combat on `shield_break`. *(All three numbers were retuned against `pvpBalanceSim` on 2026-07-28 — vanguard's shield 4→3.2 and skirmisher's 8→6 trimmed, juggernaut's HP 9→11 raised to pay for having no regen at all. `15` recorded that pass; this line still quoted the pre-retune triple until 2026-09-03, as did `09` and `ROADMAP` 2.3 with two other variants. `content/skins.ts` is the source of truth, and its comments carry the reasoning per character.)* The full side-grade balance suite (`skins.test.ts`) covers all three: Pareto-non-domination, per-axis spread, equal-worth budget band, no inert passive on a zero-shield body.*

- **A skin *is* a character, with real but balanced stats.** There is **no cosmetic-only reskin layer.** Every skin is a distinct character carrying its own `(maxHp, maxShield, maxEnergy)` + shield-break passive (`05`/`09`) — e.g. the shipped **3 HP / 6 shield** skirmisher vs the **11 HP / 0 shield** juggernaut. *(This example read "3 HP / 10 shield vs 8 HP / 0 shield" until 2026-09-03, and claimed to match `05`/`09`; no character has ever had either pair — see the roster note above.)* This overrides `13`'s earlier "skins are cosmetic / power-neutral."
- **Characters are side-grades — no all-rounder (万金油).** The roster is balanced as *playstyle trade-offs*, never a power ladder: no character is strictly better than another (a huge regenerating shield buys fragility to burst; high flat HP buys no regen buffer, `05`).
  - **A third axis since `ENGINE_VERSION` 60: `maxEnergy`** (`03`'s weapon-energy pool; skirmisher 130 / vanguard 100 / juggernaut 70). It joined the Pareto non-domination rule, which makes that rule **stricter** — a would-be all-rounder now has one more column it must lose on. It deliberately did **not** join the equal-worth budget band, which still sums only `(maxHp + maxShield)`: energy is not denominated in hit points, so adding them would be an invented exchange rate of exactly the kind `03` refuses to make up, and at ~100 it would swamp a 9-point body budget outright. The axis spreads OPPOSITE the body — the character that cannot win a long trade gets the longest short one — and `skins.test.ts` pins that DIRECTION by name, not merely that the three differ.
  - What makes it a legal axis for a *purchasable* character, given the bullet below about PvP fairness being disciplinary: capacity buys burst and provably cannot buy sustain, because energy regen is a flat shared constant and every character's rate of fire on an empty bar is identical regardless of pool size (`03`). A deeper bar is a longer opening, never a higher ceiling — so the worst a paid character could be sold here is *front-loaded*, not *stronger*.
- **Character sources: free + purchase.** Some characters are free (default / earned); some are bought (RMB) or event-earned.

### Fairness & PvP

- **Weapons never enter PvP — the structural wall stays.** `buildArenaSpecs` still takes **no** weapon / material / blueprint parameter, so it is *compile-time impossible* to carry a crafted weapon into the arena (`09` hard-wall, `06`). The wall itself is unchanged. What sits behind it is **not** "100% the fixed presets", as this line said until 2026-09-03: a seat starts on the assigned `landing_basic` pair and its real power curve comes from **looting the arena** — weapons/buffs/heals rolled from `ARENA_DROP_TABLE`, which is arena-scoped content with no connection to any account (`05`/`15`). Both halves are still account-independent, which is the property that matters here.
- **Characters DO enter PvP — and here fairness is *disciplinary*, not structural.** The one meta thing that reaches the arena is *which character you picked*: `buildArenaSpecs(presetId, skinId)` receives the chosen character so its `(maxHp,maxShield)` + break-passive apply; the preset supplies only the **weapon loadout**. `maxEnergy` reaches the arena too (`ENGINE_VERSION` 60) but is carried through **unscaled**, unlike the other two — see `15`. Because characters can be *purchased*, fairness here is enforced by **balance discipline + tests**, not by the type system — a rule + a balance-test suite assert every character (including paid ones) is a genuine side-grade. **A "strictly better" character is a bug, not a product.**
- **The free roster must stay PvP-competitive.** Every playstyle archetype has at least one free character good enough for ranked play, so paying buys *more options*, never *the only viable options*. This is the concrete guard that "pay to pick a character" is not pay-to-win.
- **Net:** a paying player's PvP edge is **breadth of choice, not power.** This resolves `05`'s open "shield-break passive in PvP" question (it survives normalization, kept balanced) and `09`'s mirror skin-passive question.

### Monetization

- **Sell breadth, not power.** RMB buys **weapon blueprints** (PvE-only impact — weapons never touch PvP) and **characters** (PvP-relevant but side-grades only). It never buys raw stats, boosts, or any edge that breaks PvP fairness.
- **Bounded, direct-purchase, no gacha.** All purchasable content is **directly buyable and finite** — no loot boxes, no random blueprint pulls, no energy/stamina gates, no pay-per-craft. A committed player tops out around **a few thousand RMB** and then there is nothing left to buy.
- **Mass-DAU / word-of-mouth model.** Revenue leans on a broad, casual player base rather than whales. This deliberately caps ARPU in exchange for a fair, casual-friendly game (`06`) — and it is precisely that bounded, fair shape that *lets* PvP stay clean. Reputation first; a player who spends thousands is a happy bonus, not the plan.
- ✅ **Shipped: grant-scaffolding (ROADMAP 2.4).** `meta/forge.ts`'s `acquireBlueprint`/`grantCharacter`/`purchasableBlueprints` are the direct-purchase/grant APIs a platform's real billing flow would call after its own payment step — no gacha, no in-engine pricing logic. Real billing integration is deliberately out of scope; these are the seam a payment adapter plugs into, not a payment implementation.

## The forge outpost (to design — `13`)

- A safe hub between runs: **forge** (unlock / craft weapons), **character select**, cosmetics. The outpost's look and any NPCs are `13`'s to-design.
- Screen-flow: sits in `10`'s menu → loadout state machine, ahead of a run's loadout pick (bring up to 2 crafted weapons — **at most one per kind**, since 2026-09-03 the forge refuses to stage a second gun or a second blade; each replaces the starter weapon of its own kind, and any free slot keeps its starter default — so never a one-weapon run and never a parry-less one, `05`/`03`).

## Relationship to other docs

- **`05`:** fills the deferred "materials → forging" and the meta economy; the ephemeral-weapon / materials-only-carry-out rules originate there and are unchanged.
- **`09`:** blueprints, recipes and character stats are concrete `@dd/engine` content; the **affix removal** and the **`buildArenaSpecs(presetId, skinId)`** change are applied there.
- **`03`:** composition shrinks to **Frame × Element**; rarity becomes intrinsic; the rarity-appearance overlay rule.
- **`13`:** skins = characters (not cosmetic, carry balanced stats); outpost look.
- **`06`:** casual-first / PvP fairness — weapons walled *structurally*, characters guarded by *discipline*; the monetization shape is chosen to keep this true.

## To design

- ~~**Material recipes:** exact kind × qty × min-tier per weapon.~~ **Resolved, shipped (ROADMAP 2.1):** each blueprint names its element(s)/qty/min-tier; `content/materials.ts`'s `bankKey(materialId, tier)` keys the bank by `(element, rolled tier)` so `minTier` is actually enforced, and `meta/forge.ts` spends lowest-qualifying-tier-first. *Remaining:* how many distinct materials exist per element/tier is still a content-tuning question, not a schema one.
- **Blueprint catalogue:** which 2–3 are common drops, which are sold, which are event-only; pricing.
- **Run-buff catalogue** (the affix replacement as the in-run power layer): families, how offered (chest / room / shop — **none of the three exists**; a buff only ever falls off the flat kill drop table, `ROADMAP` B1/B2), stacking caps. (`05`/`09`)
- ~~**Character roster:** the actual `(maxHp, maxShield)` + break-passive set, which are free vs paid, and the **balance-test suite** that enforces side-grade / no-all-rounder.~~ **Resolved, shipped (ROADMAP 2.3):** the 3-character launch roster (vanguard/skirmisher/juggernaut) + the full `skins.test.ts` side-grade suite — see the Characters section above. *Remaining:* free-vs-paid split is the store's job, not decided here.
- **Rarity numbers:** the five base-quality stat multipliers (the "small edge"), and the ornament / emissive overlay spec (`12`).
- **Outpost / hub UX + NPCs** (`13`).
- **Event structure:** how time-limited blueprint / character acquisition works, staying inside the no-gacha rule.
