/**
 * entities/ split: the actors — the shared `Actor` base and the player/enemy shapes
 * built on it, including the co-op downed state and the boss enrage trait.
 */

import type { Fp } from '../../math/fixed';
import type { Brad } from '../../math/trig';
import type { DamageType, ResistMap, StatusState } from '../../content/damage';
import type { RunBuffId } from '../../balance/runbuffs';
import type { Faction } from './teams';
import type { ShieldBreakSim, WeaponState } from './weapons';

// ── Actors ────────────────────────────────────────────────────────────────────

export interface Actor {
  id: number;
  faction: Faction;
  // Team identity for combat targeting (design/15, ROADMAP 4.2a) — see the note
  // above. Independent of `faction`: two PlayerActors can be mutually hostile
  // (different teamId) while remaining the same `faction` ('player').
  teamId: number;
  gx: Fp;
  gy: Fp;
  z: Fp; // ground height — always 0 for actors (jump removed); a render offset only
  vx: Fp;
  vy: Fp;
  // Knockback velocity (design/07 "persistent-knockback friction"), kept SEPARATE from
  // vx/vy: a player's vx/vy is fully overwritten every tick from input (ApplyInputSystem)
  // and an enemy's is never set by AI at all, so a shove written into vx/vy would either
  // be erased before Movement ever integrates it (player) or drift forever with no decay
  // (enemy, nothing else touches its vx/vy). knockVx/knockVy is an independent external-
  // force channel: MovementSystem adds it into this tick's displacement alongside vx/vy,
  // then decays it by a fixed friction factor every tick (never touched by chill slow —
  // that's a movement-speed modifier, not a force). Zero for an actor that has never been
  // knocked; starts and ends every knock at (0,0).
  knockVx: Fp;
  knockVy: Fp;
  facing: Brad;
  hp: number;
  maxHp: number;
  // Two-pool health (design/02/05/07). Damage absorbs shield-first, overflow to hp;
  // an idle shield regens (StatusEffectSystem step 8). maxShield 0 = no shield pool
  // (the current enemies + the 0-shield starter), so the absorb is a no-op and this
  // stays additive for shieldless actors. Characters (0.5) set these from a SkinDef.
  shield: number;
  maxShield: number;
  // Ticks since this actor last took ANY damage (direct hit or DoT), reset to 0 by
  // takeDamage. Gates shield regen: refill only after SHIELD_REGEN_DELAY idle ticks.
  ticksSinceHit: number;
  radius: Fp; // body circle — bullet/melee hit target and sprite size
  // Ground-plane collision footprint (feet), used for actor↔ACTOR push-out
  // (MovementSystem). Smaller than `radius` so two bodies may visually overlap
  // where their feet don't — the fake-3D depth trick (design/01/07). Bullets/melee
  // still use `radius`, so being shot still targets the whole visible body.
  footprintRadius: Fp;
  // Ground-plane radius used against STATIC solids only — walls and pillars
  // (MovementSystem.resolveWalls/resolveObstacles). Separate from `footprintRadius`
  // because the two overlaps read differently on screen: a body overlapping another
  // body is a crowd, while a body overlapping a wall is a body sunk INTO the wall.
  // See PLAYER_BASE.solidRadius (content/players.ts) for the full account.
  solidRadius: Fp;
  alive: boolean;
  weapon: WeaponState | null;
  firing: boolean; // intent this tick (ApplyInput / AIDecide → WeaponFire)
  // Elemental status runtime (design/03/07). Burn/poison DoT + chill slow live here;
  // StatusEffectSystem is the only mutator after HitResolve applies a hit's status.
  status: StatusState;
  // Per-type damage multiplier (per-mille; missing type = 1000 = normal). Lets an
  // enemy be weak/resistant to an element (design/07). Players carry none.
  resist?: ResistMap;
  // Shield-break reaction (design/02/14): fired by takeDamage when a non-empty shield
  // empties. Set from the character's SkinDef (players); enemies carry none. Kept on
  // the base Actor so the shared takeDamage can read it without narrowing.
  shieldBreak?: ShieldBreakSim;
  // Arena room-membership cache (design/15, ROADMAP 4.2d) — which ArenaRoom (by id)
  // this actor's position currently falls inside; maintained by EnvironmentSystem,
  // which re-checks it only when the actor leaves its cached room's rect (amortized
  // O(1), not a full room scan every tick). Always undefined outside arena mode.
  // Also undefined while standing in a doorway gap no room's rect covers — treated
  // as "not confirmed safe" by the zone check, never as automatically safe.
  roomId?: string;
}

export interface PlayerActor extends Actor {
  faction: 'player';
  // Render-only character atlas ref (design/02/12/13), set once at spawn from the
  // resolved SkinDef.atlasKey (content/skins.ts) — the sim never reads it, like
  // EnemyActor's `tint`. Lets the view pick which of the 3-character roster's rig
  // skins to draw. Undefined = the Graphics placeholder (or resolveSkin's default).
  atlasKey?: string;
  prevButtons: number; // last tick's button bitfield, for rising-edge detection
  // Loadout: up to two carried weapons (any mix of ranged/melee). SWAP toggles
  // the active slot; each slot keeps its own cooldown, so switching does NOT
  // refresh a weapon that is mid-cooldown. `weapon` (base Actor) mirrors
  // weapons[activeSlot] — systems only ever read the active pointer.
  weapons: WeaponState[];
  activeSlot: number;
  // Run-scoped buff stack (design/05/14) — the in-run power layer that replaced the
  // deleted `affixes` slot. Player-level, applies to the player + all held weapons,
  // summed-then-clamped (balance/runbuffs.ts), wiped at run end (never carries out).
  // Stores buff ids; magnitude/kind live in the RUN_BUFFS catalogue.
  buffs: RunBuffId[];

  /** Weapon energy — the shared ammo pool every RANGED trigger pull is charged
   *  against (design/03/05, `balance/energy.ts`, ENGINE_VERSION 59). Player-level and
   *  weapon-agnostic on purpose: a magazine would have to ride a weapon onto the
   *  floor and back on every drop-on-replace swap, while a pool means a swap moves
   *  nothing. Melee costs nothing at all, which is what makes the always-owned melee
   *  half (`03`'s ranged-vs-melee trade-off) the fallback when the pool is empty.
   *  Regenerated unconditionally on a global cadence by StatusEffectSystem, topped up
   *  by the `energy` drop. Enemies carry neither field and are never charged. */
  energy: number;
  maxEnergy: number;

  /** Coins — the in-run currency a shop room spends (design/05 "Shops", 2026-09-14).
   *
   *  **Per-seat, not a shared purse**, on the owner's call. It is the same rule the big
   *  chest already runs on: what a party shares is the coordination, never the wallet.
   *  A shared purse would need a deterministic arbitration for "who spent it" the frame
   *  two seats buy at once, and would let one player spend the squad's floor; per-seat
   *  needs neither, and a seat's own balance is the one number its own HUD can show
   *  without asking anyone else.
   *
   *  Run-scoped like `buffs` and `energy`: wiped at run end, never banked, never merged
   *  at a checkpoint, never handed to the meta layer. `bankedMaterials` stays the only
   *  carry-out (design/05/14) — a coin cannot become account value by any path. */
  coins: number;

  /** Which slot of the open floor-card offer this seat has voted for: 1..3, or 0 for
   *  "has not chosen" (design/05, ENGINE_VERSION 58). Sim state rather than a one-tick
   *  latch, unlike `confirmExtract`/`confirmDescend`, for two reasons: a vote is
   *  CHANGEABLE right up to the moment someone descends, and every client renders the
   *  live tally off it, which it can only do if the vote persists in shared state.
   *  Reset to 0 for every seat when a descend consumes the offer. */
  cardVote: number;
  // This tick's INTERACT hold state (mirrors `firing`'s FIRE mirror), set by
  // ApplyInputSystem. Read by ReviveSystem (sustained channel) — no longer by
  // PickupSystem (weapon collection is click-driven now, see `pickupTargetId` below)
  // or ExtractionSystem, see below.
  interacting: boolean;
  // This tick's portal-popup choice (mirrors `firing`, set by ApplyInputSystem from
  // Button.CONFIRM_EXTRACT/CONFIRM_DESCEND). Already a one-tick pulse by construction
  // (CommandBuilder latches then clears the bit, same as SWAP_WEAPON), so
  // ExtractionSystem (design/05, ROADMAP 1.4) reads these directly — no edge detection
  // needed, unlike INTERACT's continuous hold.
  confirmExtract: boolean;
  confirmDescend: boolean;
  // The PickupItem.id this tick's command asked to collect (design/03, ENGINE_VERSION
  // 32 — replaces the old "tap INTERACT while overlapping" ground-weapon gesture with
  // an explicit click on a HUD panel row). 0 = none. Set by ApplyInputSystem straight
  // from PlayerCommand.pickupTargetId — already a one-tick pulse (CommandBuilder
  // latches then clears it, same convention as confirmExtract/confirmDescend above),
  // so PickupSystem reads it directly with no edge detection of its own.
  pickupTargetId: number;
  // The ShopOffer.id this tick's command asked to buy (design/05 "Shops", 2026-09-14).
  // 0 = none. Same one-tick-pulse convention as `pickupTargetId` above and read the same
  // way by `ShopSystem`; a separate field because the two id SPACES are separate (see
  // `GameState.nextShopId`).
  shopBuyId: number;
  // Co-op downed/revive (design/05/07, ROADMAP 3.2). A lethal hit sends a player
  // `downed` (frozen, 0 HP, `alive` stays true) instead of dead; a teammate revives
  // it via a sustained INTERACT channel. `alive` becomes false only on a permanent
  // death (bleedout expiry). "Up" = `alive && !downed` (see isDowned / WinCondition).
  downed: boolean;
  bleedoutTicks: number; // counts down while downed & not being revived; 0 → dead
  reviveProgressTicks: number; // channel progress (0..REVIVE_CHANNEL_TICKS); resets if interrupted
  // PvP squad revive (design/05/15's squad follow-up) — reviving a downed SQUADMATE
  // (never a rival, see ReviveSystem's teamId check) consumes one of these, unlike
  // PvE's free channel. Picked up from the arena's `{kind:'bandage'}` drop (PvP-only,
  // content/drops.ts). Always 0 in PvE — nothing grants or reads it there.
  bandages: number;
  // ── Per-seat carry-out (design/05/14, ENGINE_VERSION 68) ────────────────────
  // Materials and the boss's one-time schematic used to be a single SHARED bag on
  // `GameState` — every seat's client applied the same total to its own account
  // regardless of who physically walked over which drop. Moved per-seat: whichever
  // player's actor overlaps a `material`/`schematic` pickup is the one whose own bag
  // grows, matching how `coins` (above, already per-seat) and every weapon pickup
  // (click-driven, always the clicking player's own loadout) already worked. A run
  // that ends in defeat forfeits every seat's bags identically — the merge simply
  // never runs, same mechanism as before, just per-seat now.
  /** This floor's un-banked material buffer (materialId+tier bank-key → qty), auto-
   *  collected by `PickupSystem`, merged into `bankedMaterials` on EXTRACT/DESCEND
   *  (`ExtractionSystem`), forfeited on a run-ending death. */
  floorMaterials: Partial<Record<string, number>>;
  /** This seat's carry-out bag — the ONLY thing (besides `blueprintPickup`) that
   *  leaves a run for this seat. Never wiped by death; only ever grows, at an
   *  extraction checkpoint. */
  bankedMaterials: Partial<Record<string, number>>;
  /** The weaponId of the boss's one-time schematic drop, if THIS seat is the one who
   *  walked over it — `null` otherwise, including for every other seat in the same
   *  run. At most one exists per run (one boss, one roll), so a plain nullable field
   *  is enough; forfeited on a run-ending death exactly like `bankedMaterials`. */
  blueprintPickup: string | null;
}

/** A player who is downed (incapacitated, revivable) — not a valid target and cannot act.
 * Safe on any Actor: enemies never carry the field, so it reads false for them. */
export function isDowned(a: Actor): boolean {
  return (a as PlayerActor).downed === true;
}

export interface EnemyActor extends Actor {
  faction: 'enemy';
  // Render-only body tint from the blueprint (design/01); the sim never reads it,
  // like `z`. Lets the view distinguish elemental variants. Undefined = default palette.
  tint?: number;
  // Which of design/13's five elements this variant IS — render-only, copied from the
  // blueprint like `tint`; the sim never reads it. The COLOUR half of that doc's locked
  // dual-channel element law is `tint` right above; this is what lets the view draw the
  // ICON half (`game/elementIcons.ts`). Undefined = not one of the four locked elemental
  // variants, and the view draws no badge at all.
  element?: DamageType;
  // Render-only body rig atlas key (design/13 "roster variety beyond the base body"),
  // copied from the blueprint like `tint`/`boss`; the sim never reads it. Undefined =
  // the shared 'critter-core' body (Actor.ts's existing fallback).
  bodyRig?: string;
  // The boss marker (design/01/14). Render-only until ENGINE_VERSION 63 — the view draws a
  // health bar for one, so a durable boss's HP ramp-down (poison melt) stays legible — and
  // now ALSO read by the sim: `DeathDropsSystem.rollBlueprint` rolls the blueprint drop on a
  // boss's death. So this is no longer a cosmetic flag like `tint`; setting it on a blueprint
  // changes what that enemy's death is worth, and changing it is a content decision with a
  // gameplay consequence.
  boss?: boolean;
  // Boss AI depth (design/09 aspirational `traits`, ENGINE_VERSION 27). Config, copied
  // from the blueprint at spawn (SpawnSystem/DeathDropsSystem, same convention as
  // tint/boss/resist above); undefined = no enrage trait. `enraged` is the RUNTIME
  // flag WeaponFireSystem sets the tick hp first crosses the threshold — one-way,
  // never clears (enemies have no self-heal today), required (not optional) on every
  // enemy so the field always has a stable false default.
  enrage?: EnrageSim;
  enraged: boolean;
  // Boss AI depth, a THIRD axis alongside enrage/onDeathSpawn (Task 2's boss pass,
  // ENGINE_VERSION 70). Config, copied from the blueprint at spawn like enrage above;
  // undefined = no armor-break trait. `armorBroken` is the RUNTIME flag
  // `WeaponFireSystem.latchArmorBreak` sets the tick hp first crosses the threshold —
  // one-way like `enraged`, but it REPLACES `resist` (below) with `armorBreak.resist`
  // rather than granting a buff, so a broken boss's new resist profile is read by
  // every later hit through the SAME `resist` field every other enemy uses — no
  // separate "is this armor broken" branch anywhere damage gets resolved.
  armorBreak?: { hpThresholdPermille: number; resist: ResistMap };
  armorBroken: boolean;
  // Boss AI depth (design/09 aspirational `onDeathSpawn`). Config, copied from the
  // blueprint at spawn; DeathDropsSystem reads it the tick this enemy dies to spawn
  // `count` minions of `type` around its death position. undefined = no adds.
  onDeathSpawn?: { type: string; count: number };
  // Movement AI (design/09, ENGINE_VERSION 37 — enemies used to stand rooted at spawn,
  // only ever turning to fire; see AIDecideSystem's module doc). Copied from the
  // blueprint at spawn like tint/resist above; undefined (any hand-built EnemyActor
  // that bypasses `buildEnemyActor`, e.g. most unit tests) falls back to
  // AIDecideSystem's own default constants, same convention as `resist` defaulting
  // to a neutral multiplier.
  moveSpeedPerTick?: Fp; // fp displacement per tick while closing distance to its target
  engageRangeFp?: Fp; // stop closing once within this fp distance of the target
  // Perception radius (ENGINE_VERSION 42): how close the target has to get before this
  // mob reacts AT ALL. Room activation (design/05's room-as-the-aggro-unit) is still the
  // outer gate — this is the inner one, so an activated room's far side stays idle until
  // the player actually comes near instead of the whole garrison marching at once.
  // Undefined falls back to DEFAULT_ENEMY_AGGRO_RANGE_FP, same convention as the two above.
  aggroRangeFp?: Fp;
  // Latched the tick the target first enters `aggroRangeFp` — one-way, like `enraged`.
  // Without the latch a mob sitting exactly at the boundary would flip between chasing
  // and idling every tick as its own movement carried it back and forth across it.
  // Required (not optional) so the field always has a stable false default.
  aggroed: boolean;
  // Has this mob ARRIVED — reached engage range and stopped to shoot (ENGINE_VERSION 55)?
  // Written by AIDecideSystem, read by MovementSystem, and the single switch behind the
  // standing-spacing rule: a holding mob claims `standoffRadius` of personal space against
  // OTHER holding mobs (state/actorRadius.ts), a travelling one claims nothing beyond its
  // body, so mobs disperse where they stop without any gap in the level becoming narrower
  // than the mob walking through it. NOT a latch, unlike `aggroed` — a mob that loses its
  // target is moving again and must stop reserving space — but sticky in one direction
  // (`HOLD_RELEASE_PERMILLE`), since the spacing push moves a holding mob outward and a
  // bare threshold would have it re-chase the instant a neighbour nudged it.
  holding: boolean;
}

/** A boss's enrage trait (design/09 `traits`, ENGINE_VERSION 27): below `hpThresholdPermille`
 * of maxHp (‰, e.g. 300 = 30%), the bonuses below apply — same per-mille "bonus amount"
 * shape as a RunBuffDef's `value` (composed through the identical BuffSums/buffedDamage/
 * buffedCooldown machinery in WeaponFireSystem, not a separate damage-scaling path). */
export interface EnrageSim {
  hpThresholdPermille: number;
  bonusDamagePermille: number;
  bonusFireratePermille: number;
}
