# Work log — 2026-09-05: a shot costs something, and something walks at you

Volume 38. One `ENGINE_VERSION` bump covering two halves that are not separable: the ammo
economy, and the melee mobs that keep it from being a trap.

Indexed from [`../ROADMAP.md`](../ROADMAP.md).

## A trigger pull costs energy (2026-09-05, engine + client, `ENGINE_VERSION` 59)

Design call from the game's owner, the day after the loot pass in volume 36:

> I plan to give weapons a concept of ammunition. That way, 1, it solves weapon balance — some high-power weapons would burn
> a lot of ammo at once. 2, it solves the monster-drop problem — after lowering the drop rate, finishing a map with nothing to show for it is no good either.

> give the melee mobs some too.

### Reason 1 was half right, and the half that was wrong mattered

"Solves the weapon balance problem" reads as *big weapons are too strong, tax them*. The
roster says otherwise, and `design/03` had already measured it: mean dps by rarity runs
**downward** — `fine` 8.41 → `epic` 5.63 → `legend` 3.75 — because rarity buys a mechanic,
not pace. A cost indexed on damage would have taxed the slowest guns in the game hardest and
made the starter `blaster` strictly best.

What the roster actually lacked is stated in `design/03` in as many words, as a dead end:
*"a mechanic has no price anywhere in this repo, so any composite 'worth' score would be
scoring an invented exchange rate"* — which is why `balance/weaponBalance.test.ts` can only
gate domination WITHIN an identical mechanical signature. `energyCost` is that missing
exchange rate. Not a nerf to big weapons: **the first price a mechanic has ever had.**

### Reason 2 was right, but not for the reason given

"After lowering the drop rate the map is empty" — except 84.5% of kills still dropped
something. What they dropped was a **material**: auto-vacuumed into a counter, spendable only
in the forge after the run, forfeited whole by a death. It changes nothing about the next ten
seconds. The floor was producing loot that could not be *used*, and that reads as an empty
floor at any drop rate.

### The measurement came first (volume 36's discipline, same reason)

Nothing in the tree had ever measured how many shots a floor takes, so an ammo pool had no
denominator and a per-shot price had no numerator. `client/sim/pve/report.ts` grew
`floorFireStats` / `weaponFireStats`, and `levelSim.ts` grew a `FireRecord` per trigger pull,
BEFORE any engine change landed. Eight careful bot runs of the shipped level:

| floor | complete visits | kills | trigger pulls (avg/min/max) | pulls/kill | melee share |
|---|---|---|---|---|---|
| 0 | 3 | 34.6 | 217 / 237 / 252 | 6.3 | 0% |
| 1 | 2 | 37.7 | 536 / 730 / 760 | 14.2 | 0% |
| 2 | 1 | 52 | 598 / 742 / 742 | 11.5 | 0% |

Two findings decided the design, and neither was in the request.

**Pulls per kill RISES with depth** (6.3 → 14.2), because `difficultyCurve` scales enemy HP
per floor while a drop table pays per KILL. An ammo economy funded only by kill-drops
therefore goes *negative* with depth — tightest on exactly the floors that already kill 100%
of careful bot runs. That is why the pool regenerates on a clock: a time-based refill is
depth-invariant.

**A floor costs 237-760 pulls and hands back only ~35-52 drops.** No per-kill drop can fund a
250-pull floor at a meaningful price per pull. So the baseline gun has to be effectively
free, and the economy has to bite only on the expensive frames — which is the request's own
goal, arrived at from the other end.

Two things the measurement pass had to get right, in the same spirit as volume 36's two:

- **A pull is not a bullet.** A spread frame emits five projectiles from one decision, and a
  cost charged per pellet would tax `scattergun` five times for one press. Both columns are
  recorded so the choice stays checkable rather than assumed.
- **Attribution is by SLOT, not by the active pointer.** `bullet_fired` can only come from
  the ranged slot and `melee_swing` only from the melee one, so which weapon fired is never a
  guess about `activeSlot`. The one real ambiguity — a tick that also collected a weapon,
  since `PickupSystem` runs five steps after the fire — is recorded as an unattributed pull
  and printed, rather than charged to the gun that replaced the one that shot.

### What shipped

A shared regenerating **energy pool** (`balance/energy.ts`): `MAX_ENERGY` 100, +2 every 3
ticks (20/s), unconditional — unlike the shield's idle timer, deliberately, because a regen
that paused under fire would take the one weapon you always have below break-even in exactly
the moments it is the only thing you have.

Magazines were considered and rejected on three counts, all properties of this repo rather
than general taste: a RELOAD verb has nowhere to live in `design/10`'s button cluster and
lockstep cannot pause for one player; magazine state rides on a WEAPON, so a gun on the floor
would have to carry its rounds through `PickupItem` and back out on every drop-on-replace
swap; and per-weapon ammo TYPES would waste a third of a floor's whole weapon output on a gun
you cannot feed, since a floor hands out 2-3.

**Exactly two guns are sustainable on regen alone** — `blaster` (15/s vs 20) and `repeater`
(20/s, exactly break-even, the designated pace weapon). `balance/energy.test.ts` pins that
list BY NAME rather than by count, plus the blaster's headroom against a `rof_up` stack. That
is what keeps the shipped level's difficulty unmoved for a fresh save: the ammo economy is
something you meet when you pick up your first *interesting* weapon.

**Running dry is a pace, not a disarm.** A refused pull leaves the cooldown untouched, so the
trigger retries every tick and fires the instant regen covers the next shot. Enemies are
structurally never charged — `asEnergyUser` keys on `faction`, so a hand-built mob carrying an
`energy` field still cannot be silenced by an economy it has no bar for.

**The drop.** A new `energy` `PickupKind`/`DropResult`, weight 16 of 84 (19% of kills), taken
out of `material` and NOT off the total — volume 36's exact discipline, so `weapon` and `buff`
keep the odds they had and the passes stay readable apart. Collected under `design/05`'s
locked *"auto-apply, but only when useful"* rule; it is the second instant item, and the
first added since `pickupWouldApply` was finally implemented in v54, whose own note predicted
it (*"if a shield/temp-buff instant item is ever added, this is the one place it needs a
clause"*). The arena table gets one too, at weight 25 — the arena's loot pool is its entire
power curve, so a missing kind there is the only supply line, not a smaller version of the
PvE gap.

## The roster gets its first melee mobs (same version)

Not a separate request so much as the thing that makes the first half fair.

### It was a TYPE that said the roster was all ranged

`EnemyBlueprint.weapon` was declared `RangedSimSpec` and all eight blueprints carried
`ENEMY_GUN_SIM`. "All ranged" was never a content decision anybody made — it was a constraint
nobody had noticed, of exactly the kind `design/03` records elsewhere ("three fields this
doc's schema implies are live, and are not").

It became load-bearing the moment energy landed. A player who runs an expensive frame dry
falls back on melee, and against an all-ranged garrison that means walking into every gun on
the floor while the shield's idle regen — the sustain volume 36 chose *over* potions — cannot
tick, with heals at 2.4%. Run dry → forced to close → certain to be hit → shield never
recovers → no potions. A melee mob is the mob you keep the gun for.

### Two constraints, each silently holding the other up

Widening the blueprint type was half the fix. `HitResolveSystem`'s melee pass looped
`state.players` only, so a melee mob authored against the widened type alone would have
walked up, played its swing animation, and dealt **nothing** — a silent failure the type
system cannot see, which is why the damage assertions in `systems/meleeEnemies.test.ts` go
through the real step order rather than calling `meleeArc` directly.

Two adjacent things fell out of opening it:

- `meleeArc` hardcoded `'player'` as the damage source, left over from when players were the
  only thing that could swing. A mob's own hit would have coloured its fx as the player's.
- `enrageBuffs` moved out of `WeaponFireSystem` into `balance/runbuffs.ts`, so step 3 and step
  7 scale an enraged mob by the identical numbers. No melee boss exists today, so it is
  identity for every shipped mob — and that is precisely why a second copy would have sat
  looking correct until someone authored one, then made it swing faster without swinging
  harder.

### The two mobs

| mob | shape | the threat is |
|---|---|---|
| `stalker` | 2 HP, 67% of player speed (roster default is 41%), wider perception, narrow 90° claw | **arriving** — punishes standing still |
| `ravager` | 8 HP, armoured, roster-default speed, 150° maul, heaviest knockback in the game | **being near it** — punishes standing close |

Still slower than the player, both of them: the v42 retune's rule is that backing off always
opens a gap, and this pass makes that cost something rather than removing it. Neither
**deflects** — a mob that parries your bullets back inverts `design/03`'s core mechanic and
makes the ranged half strictly worse against exactly the mobs it exists to counter. Recorded
as a deliberate no with its own assertion, not as the absence of one.

### Content: 18 spawns converted, never added

`floater` → `stalker` and `brute` → `ravager`, both same-silhouette swaps, across 10 of the
14 room pieces. Converting rather than adding keeps every room's garrison SIZE unchanged, so
the room-encounter gates measure a change in composition and nothing else — adding bodies
would have moved garrison count, peak shooters and clear time at once and made the result
unreadable. Never `basic` (the mob a player learns on), never an elemental variant (each is
half of a resist/weakness pair the elemental weapons are balanced against). Density is graded
by depth: the entrance `cell` gets none, floor 1's other rooms one each, the deep-only pieces
the heavier share.

## After

Every balance gate in `client/sim/pveLevelSim.sim.ts` still passes, and the weapon sweep and
PvP sim are green.

| | before | after |
|---|---|---|
| floor 0 trigger pulls (avg) | 217 | 189 |
| floor 0 complete visits (of 8) | 3 | 3 |
| `r4_forge` clear rate | 38% | 38% |
| avg floor reached (careful) | 0.8 | 0.6 |
| floor 0 materials / energy per visit | 30.1 / — | 22.1 / **6.6** |
| floor 0 heals per kill | 0.022 | 0.015 |

The starter loadout's numbers barely moving is the point, not a null result: it is the claim
`balance/energy.test.ts` makes by construction, now confirmed empirically. The slip in average
floor reached is the melee mobs, and stays well inside the "at least 2 of 8 careful runs
descend off floor 0" floor.

### What is measured, and what is only asserted

**The bot's melee share is still 0%.** It never swaps to its blade — the existing gate comment
already said so — and, running the sustainable starter gun, it never runs dry either. So the
"melee is the free fallback" half of this design is *unmeasured*, not verified. A bot that
swaps under pressure is the instrument the next pass needs; changing it during this one would
have made the A/B above unreadable, which is the whole reason it was left alone.

### Named gaps

- **No energy floor card and no `flat_energy` run buff.** The `potion_flow`/`arsenal` pair is
  exactly the shape an energy sibling would take, but a fifth buff family touches
  `RUN_BUFFS`/`BUFF_CAPS`/`applyBuff` and wants its own measured pass.
- **`MAX_ENERGY` is a flat constant, not a `SkinDef` stat.** Making capacity a character trait
  would put a raw ammo ladder on the one meta axis that reaches PvP, which needs deciding
  before it is a number.
- **The two mob blades borrow player weapon art** (`enemyclaw` → the spear's silhouette,
  `enemymaul` → the hammer's). Each carries its own calibration entry, so real art is a
  one-line `path` change per mob; pointing them at `sword_default` instead would have tripped
  `muzzleParity`'s "never the kind default" rule, and an invented path would have shipped a
  missing texture.
- **`boss-core` still mounts no weapon module**, so a melee BOSS would reopen the render
  question the old v52 tripwire raised. Both new mobs use rigs that do mount.
