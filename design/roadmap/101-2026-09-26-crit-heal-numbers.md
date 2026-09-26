# Work log — 2026-09-26

Volume 101. See [`design/ROADMAP.md`](../ROADMAP.md) for the index and the phase spine.

## Crits and heals get their numbers (2026-09-26, engine + ui + test + docs, no engine change to the hash)

Volume 95 shipped floating damage numbers and listed crits and heals as still missing, on the
grounds that the engine's events did not carry them. The owner's correction: a potion is a heal
with an amount, and a player with the crit buff lands crits. The data existed inside the sim;
it just never reached an event.

**Engine: two facts, announced.**

- **Crit.** The roll lives where design/07's "one frozen payload" puts it: once per pellet in
  `WeaponFireSystem.spawnBullet`, once per swing in `HitResolveSystem.meleeArc`. The flag is
  frozen beside it: `Projectile.crit` (only ever `true` or absent) and
  `WeaponState.swingCrit`. `applyHit` passes it to `takeDamage`, which sets `crit: true` on
  the `hit` event. A hit without a crit has no `crit` key at all, so an uncritted build emits
  exactly the events it always did. A deflect clears the flag: the deflector rolled nothing.
- **Heal.** A new `heal` event `{ target, gx, gy, amount, pool: 'hp' | 'shield' }` comes from
  two helpers in `systems/combat.ts`, `restoreHp` and `restoreShield`. They are now the only
  way a player-visible restore lands. Callers: the heal and shield pickups (`PickupSystem`),
  the shop's heal and shield lines (`ShopSystem`), and lifesteal (`HitResolveSystem`). `amount`
  is what went in after the clamp, so a potion at 9/10 HP reports 1. A restore that changed
  nothing emits no event.

  Deliberately not wired: the shield's idle regen (+1 every few ticks would print forever), a
  revive (it has its own fx), and `flat_hp` buffs (they raise the cap, not the pool).

Neither flag is in `serializeState`, and no later system reads either one. The golden hashes did
not move, checked before deciding, so there is **no `ENGINE_VERSION` bump**. That is the same
reasoning that keeps `damageType` out of the hash: the roll's outcome is already hashed through
`damage` and the `combatPrng` cursor.

**Client: two styles, one sheet.**

- **The atlas gained two glyphs.** `tools/digit-atlas/gen_damage_digits.py` now renders
  `0-9 + !` (720x62, 16 kB). The shared cell is still measured over the digits alone, so no
  digit moved, and an assert holds both marks inside that cell. The narrow "!" gets its own
  `bangAdvance` (21 atlas px against a digit's 45); at the tabular advance "48!" read as
  "48 !".
- **A crit** prints as "N!", in gold `0xffb020`, 1.4x bigger. Gold sits apart from lightning's
  pale yellow and fire's orange, but the size and the "!" carry the signal on their own. That
  is design/13's two-channel rule, for a player who cannot tell the hues apart. A crit that
  lands on you or into a shield keeps red or cyan, still big and still with its "!": which pool
  it hit is the more urgent half of the news.
- **A heal** prints as "+N", heal green for health and shield cyan for a battery, over the
  **local seat only**. It is news to the one whose bar moved. A teammate's potion or lifesteal
  trickle is already on the ally row, and printing it would bring back the column of someone
  else's numbers that `showsHitNumber` already keeps off co-op teammates.
- **Style is part of the merge key.** A crit never folds into the plain stream beside it, even
  in the same colour. Two potions inside 150 ms still add into one "+2".

**Verified in the running client**, not only in the suite. A dungeon run with four `crit_up`
buffs held fire on a pinned enemy and drank a potion. The frame, pulled out through
`renderer.extract`, shows a gold "2!" over the enemy and a green "+2" over the player, at the
sizes and spacing the tests assert.

**Tests.** Engine 1781 → 1791; the new ones are in `systems/healCritEvents.test.ts` plus
pickup and shop cases:

- The restore clamp and what it reports.
- Lifesteal's event.
- Crit tagging, checked by sweeping real rolls rather than forcing one. A bullet or swing is
  flagged crit exactly when its damage carries the multiplier, and every hit of one swing
  carries that swing's roll.
- The deflect clearing the flag.

Client 7536 → 7554: glyph sequences and variable-advance layout, the style merge key, crit and
heal layout on real sprites, the tint priority, heal local-only, and `EventReactor` routing.

A 13-mutant battery killed all 13. The one that first survived was run against the wrong file:
at 5/6 HP a potion restores exactly its face value, so the pickup test cannot tell `amount`
from the clamped `gained`. The restore-helper test can, and it kills it.

**Still open.** Other heal sources that are not player actions stay silent by choice (regen,
revive). The "+1 HP" pickup toast still appears alongside the new "+N". The toast is the
HUD's feed and the number is the world's; whether one should go is a call for a playtest.
