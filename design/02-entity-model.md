# Entity model: Actor / Skin / Weapon

Core principle: **offensive depth is not tied to the character.** A character contributes its **defensive identity** — a `(maxHp, maxShield)` pair plus one **shield-break passive** — and, since `ENGINE_VERSION` 60, exactly one non-defensive stat: `maxEnergy`, its weapon-energy capacity (`03`). All moment-to-moment power is still the weapon.

That one exception is worth stating precisely rather than waving at, because it is the only place a character touches the offensive side at all. **Capacity buys BURST and provably cannot buy SUSTAIN**: energy regen is a flat shared constant, so on an empty bar every character in the game fires at exactly `ENERGY_REGEN_PER_SEC / energyCost` regardless of pool size. A deeper bar is a longer opening, never a higher dps ceiling — a pacing knob, not an offensive stat. That is what keeps this principle intact and what lets the stat cross `15`'s PvP fairness wall; `14` records the side-grade consequences. There is **no cosmetic skin-swap layer**: the game ships a flat **roster of distinct characters** (themed orb-cores, `13`), each its own look + those two-ish defensive knobs — not a base body with reskins, and not a stat sheet. (`05` locks the two-pool survivability model these knobs feed; `14` the roster + monetization.)

## Three-layer responsibilities

| Layer | Responsibility | Carries gameplay? |
|-------|----------------|-------------------|
| **Actor** | Logical entity: `gx/gy`, `facing`, movement, `hp/maxHp`, **`shield/maxShield` + `ticksSinceHit`**, faction | Yes (core) |
| **Skin (character)** | Appearance: the shared orb-core rig + this character's own part atlas (its theme — shell / eye / spikes / belly, `13`). Carries the character's `(maxHp, maxShield, maxEnergy)` and its **shield-break passive** | Defensive identity, plus `maxEnergy` — a burst-length knob, never dps (see above) |
| **Weapon** | First-class citizen: stats, ballistics, socket mount, muzzle position, fire/deflect behavior | **Yes (all offensive depth)** |

## Key constraints

1. **The weapon is a first-class entity**, not a property of the character. Gameplay depth comes from weapons; the system is built around swapping them (see `03-weapon-system.md`).
2. **Characters decouple animation from texture:** animation data (frame timing, anchors, events) is authored once on the shared orb-core rig, separate from texture assets; each character is that rig + its own part atlas. Adding a character = a new atlas + stat row, no new animation logic. Build it this way from the start, or adding characters later hurts.
3. **The weapon socket follows the animation frame:** the weapon mount tracks the character's orbiting socket (its aim rotation + facing) every frame (`12`/`13`); it is never hard-coded. There is no hand — the socket is a universal, arm-agnostic mount (`03`).
4. **Weapon local z switches by facing** (see `01-rendering.md`).

## Data structure sketch

```
Actor {
  gx, gy               // ground position (2D — no height; jump removed, 07)
  vx, vy               // velocity
  facing: number       // brad in the engine (06); radians only in this sketch
  hp, maxHp            // hard floor; 0 = death; recovered ONLY by items (05/07)
  shield, maxShield    // soft buffer, absorbed before hp (incl. DoT); auto-regens (05/07)
  ticksSinceHit        // idle timer; any damage → 0; drives shield regen (07/08)
  faction              // 'player' | 'enemy' — WHICH SIDE this actor is on
  teamId: number       // WHO on that side this actor allies with (15) — independent of
                       //   faction; PvE never needed it (faction alone was a sufficient
                       //   2-faction model), PvP does: a solo seat gets its own teamId,
                       //   a SQUAD shares one across its seats (shipped, ENGINE_VERSION 30 —
                       //   teamIdForOwner in pvpConfig.ts is the single source of truth both
                       //   Matchmaker and the engine config derive it from), enemies share a
                       //   reserved ENEMY_TEAM_ID hostile to every player. Confirmed: no
                       //   schema change was needed when squads actually shipped.
  skin: Skin
  slots: [Weapon?, Weapon?]  // two weapon slots; either may be empty
  activeSlot: 0 | 1    // which slot fires / receives a pickup; SWAP toggles it
}

Skin {                 // "the character": defensive identity + look (no cosmetic reskin layer)
  atlasKey             // this character's part atlas (its theme; shares the orb-core rig)
  anim                 // shared animation-data reference (the one orb-core rig)
  socketAnchor(slot)   // orbiting weapon-socket pose for the current frame (weapon mount, 12/13)
  // maxHp, maxShield, and the shield-break passive are authored on the character
  //   blueprint (SkinDef / PLAYER_BASE, 09); the Actor is constructed from them.
}

Weapon (abstract) {
  name, kind           // 'ranged' | 'melee'
  view: Container      // render node
  cooldown
  onEquip(actor)
  onUnequip()
  update(dt)           // position to the active weapon socket, facing, local z
  use(ctx, firing)     // fire behavior (subclass); melee 'use' = a swing whose arc
                       //   both damages enemies AND deflects bullets in it (03/07).
                       //   No blocking state — parry is the swing, not a held key.
}
```

## Weapon-slot system (locked, `05`)

- **Two slots, one active.** `SWAP_WEAPON` (`08`) toggles `activeSlot`; the fire button/left-click fires whatever is in the active slot (there is no second stick — `10` v33 removed aim input entirely, and this line said "the right stick fires" until 2026-09-03). The two on-screen weapon buttons each name a slot and resolve to that same toggle only when the named slot is not already active (`10`). Firing an **empty** active slot does nothing — "no weapon → can't attack" just means you switched to an empty slot; switch back (or pick one up) to fire.
- **Pickup replaces the slot holding the SAME KIND; the replaced weapon drops to the ground.** A floor weapon within reach is listed by a non-blocking panel and **tapping its row is the pickup** (`ENGINE_VERSION` 32) — not a walk-on-and-press-`INTERACT` gesture, and not into whichever slot happens to be active (`ENGINE_VERSION` 46). This bullet described both of those older designs until 2026-09-03, and the active-slot half had become the opposite of the rule: picking up a saber with the gun in hand destroyed the gun, leaving two blades and a swap button toggling between two of the same thing (`03` has the live report and the full history). Matching by kind is what keeps the one-gun-and-one-melee invariant true through any number of floor weapons. Fallbacks, in order: a genuinely FREE slot, then the active slot if both slots are somehow the other kind. When a slot's weapon is replaced, **the old weapon is dropped back onto the floor** as a pickup (you can grab it again, or swap back and forth between two candidates before committing). There is **no manual drop button** — replacement is the only trigger, but it *does* leave the old weapon on the ground rather than destroying it.
- **You always have both kinds.** Entering a run you may bring 0–2 crafted weapons; every free slot is filled from `PLAYER_BASE.startWeapons` **by kind**, so a run always spawns with one gun and one melee weapon and the swap verb always has a second slot (`resolveLoadout`, `ENGINE_VERSION` 45). This bullet used to say "bringing none auto-grants a starter **pistol**" — that fallback was reachable on *every* ordinary run (a fresh save stages `[]`, and a crafted weapon is consumed after one run) and left the player with a single gun, no melee, and no parry. Carried count is 2 in practice, never 1.
- **All weapons are ephemeral.** Nothing in the slots survives run end (`05`); only materials extract. Swapping/holding is purely in-run.
- The demo starts with two slots pre-filled (ranged gun / melee sword) and the switch button, to validate the structure before pickups exist.
