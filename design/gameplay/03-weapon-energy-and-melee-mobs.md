# Weapon energy, and the melee mobs that make it fair

Part 3 of the gameplay doc (index: [`design/05-gameplay.md`](../05-gameplay.md)). The cost side of
firing, and the roster change that had to land with it.

## Weapon energy, and the melee mobs that make it fair ✅ (2026-09-05, `ENGINE_VERSION` 59)

The follow-up to the loot pass above, from the same source, and the reason it belongs in
this doc rather than only in `03`: half of it is a **loot-economy** change.

> 我打算给武器加一个子弹的概念。这样1，能解决武器平衡性问题，有些大威力的武器一次就要消耗
> 大量子弹。2，能解决怪物掉落的问题。毕竟降低了掉率之后打完地图空空如也也不好。

> 近战的怪也加上一些。

### What "打完地图空空如也" actually was

Not an absence of drops. After the re-weight above, **84.5% of kills still dropped
something** — a material. What was missing is that a material changes nothing about the
next ten seconds: it is auto-vacuumed into a counter, spendable only in the forge after
the run, and forfeited whole by a death. The floor was producing loot that could not be
*used*, which reads as an empty floor even while the drop rate is high.

An energy refill is the opposite shape: frequent, immediately spendable, and worth walking
three steps for. `energy` takes **16 of the table's 84 points** (19% of kills) — out of
`material`, not off the total, the identical discipline the heal re-weight used, so
`weapon` and `buff` keep the exact odds they had and the two passes stay readable apart.
Measured over the same 8-run sweep: **6.6 refills on floor 0, 6.7 on floor 1**. Materials
fall from 30.1 to 22.1 a floor — the carry-out is rarer per kill, not smaller in kind.

The mechanic itself, its pricing rule, and why it is a shared regenerating pool rather
than magazines all live in `03`. Two consequences belong here:

- **It is collected under this doc's own locked "auto-apply, but only when useful" rule**
  (`PickupSystem.pickupWouldApply`) — the second instant item that rule was written in
  anticipation of, and the first one added since it was implemented in `ENGINE_VERSION` 54.
  A full player leaves it on the floor.
- **The arena carries it too** (`ARENA_DROP_TABLE`, weight 25). The arena's loot pool IS
  its entire power curve (`15`), so a missing kind there is not a smaller version of the
  PvE gap — it is the only supply line a looted heavy frame has.

### Melee mobs: the roster had none, and it was a TYPE that said so

`EnemyBlueprint.weapon` was typed `RangedSimSpec` and all eight blueprints carried
`ENEMY_GUN_SIM`. "The roster is all ranged" was therefore not a content choice anybody had
made — it was a constraint nobody had noticed, of exactly the kind `03` records elsewhere
("three fields this doc's schema implies are live, and are not").

It became load-bearing the moment energy landed. A player who runs an expensive frame dry
falls back on melee, and against an all-ranged garrison that fallback means walking into
every gun on the floor while the shield's idle regen — the sustain THIS doc chose over
potions, one section up — cannot tick, with heal drops at 2.4%. The chain is: run dry →
forced to close → certain to be hit → shield never recovers → no potions. **A melee mob is
the mob you keep the gun for**, and it is what makes both halves of `03`'s ranged-vs-melee
trade-off have something they are the right answer to.

| mob | shape | the threat is |
|---|---|---|
| `stalker` | 2 HP, 67% of player speed, wider perception, narrow 90° claw | **arriving** — punishes standing still |
| `ravager` | 8 HP, armoured, roster-default speed, 150° maul, heaviest knockback in the game | **being near it** — punishes standing close |

Neither **deflects**. A mob that parries your bullets back inverts `03`'s core mechanic
(parry is the player's) and would make the ranged half strictly worse against exactly the
mobs it exists to counter — a deliberate no, with its own assertion rather than left as the
absence of one.

**Content: 18 spawns CONVERTED, never added.** `floater` → `stalker` and `brute` →
`ravager`, both same-silhouette swaps, across 10 of the 14 room pieces — so every room's
garrison SIZE is untouched and the room-encounter gates measure a change in *composition*
and nothing else. Density is graded by depth: the entrance `cell` gets none at all, floor
1's other rooms get one each, the deep-only pieces take the heavier share. Never `basic`
(the mob a player learns the game on) and never an elemental variant (each is half of a
resist/weakness pair the elemental weapons are balanced against).

### What the re-run measured

Every balance gate in `client/sim/pveLevelSim.sim.ts` still passes, with the starter
loadout's numbers barely moved — which is the claim `balance/energy.test.ts` makes by
construction (the two baseline guns are sustainable forever), now confirmed empirically
rather than only asserted. Floor 0: 217 → 189 trigger pulls, 3 of 8 complete visits either
side, `r4_forge` clearing 38% either side. Average floor reached slips 0.8 → 0.6, which is
the melee mobs, and stays well inside the "at least 2 of 8 careful runs descend" floor.
*(That floor has since been restated as a RATE over 40 seeds — see immediately below — so
"well inside" was a weaker claim at the time than it reads.)*

**The gate that was passing on luck (2026-09-14).** `pveLevelSim`'s descend gate ran 8 seeds
and demanded 2 descents. The measured descent rate is 15-20%, so that is a Bernoulli(0.17)
sample of eight against a threshold of two: **it passed with probability ~0.34**. The first
content change to shift `dropPrng`'s stream re-rolled it — and every content change shifts
that stream. It was found by a change that made the level slightly EASIER and turned the gate
red: paired over 40 seeds, 6/40 before and 8/40 after, while the 8-seed gate went 3/8 → 0/8.
The seed set is now 40 and the threshold is a tenth of them. Nothing about the level moved;
what moved is whether the gate can tell. The general shape is worth keeping: **a threshold set
near a measured rate needs a sample that can resolve it**, and a gate nobody has computed the
power of is a gate that will eventually fail for a reason that is not its own sentence.

**The bot's melee share is still 0%**, so the "melee is the free fallback" half of the
design is *unmeasured*, not verified — the careful bot never swaps to its blade (the
existing gate comment already says so) and, running the sustainable starter gun, it never
runs dry either. A bot that swaps under pressure is the instrument this pass would need
next, and changing it mid-pass would have made this A/B unreadable.
