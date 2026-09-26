/**
 * Events are the only engine→render channel (design/08). Each step clears and
 * rebuilds state.events; render/audio consume them once per frame. Engine decides
 * outcomes, never the reverse — an event is a transient fact, never read back by a
 * later system this tick.
 */
import type { Fp } from '../math/fixed';
import type { Brad } from '../math/trig';
import type { DamageType } from '../content/damage';
import type { DamageSrc, Faction, PickupKind, Winner } from './entities';

export type GameEvent =
  // `ownerId` is the actor that pulled the trigger. Purely so the RENDER layer can find
  // the shooter's own view: the muzzle fx has to be drawn at the DRAWN barrel tip and the
  // recoil has to be played on that one rig, and `gx/gy` (the sim's flat `muzzleOffset`
  // along the aim ray, on the ground plane) is neither of those. Same field, same reason,
  // as `Projectile.ownerId`, which `Scene` already resolves this exact way for the bullet's
  // own barrel-tip spawn correction. Additive and inert for the sim: events are never read
  // back by a later system and never enter `serializeState`/`hashState`, so no bump.
  | { type: 'bullet_fired'; ownerId: number; faction: Faction; gx: Fp; gy: Fp; facing: Brad }
  // A melee weapon started its swing this tick — `WeaponFireSystem`'s melee branch, the exact
  // counterpart of `bullet_fired`'s ranged one, with the identical field list so the render
  // layer can treat "this actor just attacked" as ONE reaction (see `EventReactor`'s shared
  // `onAttack` path). It carries no damage: the swing's actual hits arrive as `hit` events
  // from `HitResolveSystem` at step 7, and a parry as `deflect` from step 6.
  //
  // Why an event and not a render-side read of `weapon.justSwung`, which is already sim state
  // and already hashed: `justSwung` is a ONE-TICK latch, and the online loop
  // (`GameLoop.advanceOnline`) drains every confirmed frame the server has ready and then
  // reconciles the scene ONCE against the last of them. Every swing on an intermediate tick
  // would be invisible under any latency that made the client drain two frames in a render
  // frame. Events survive that by construction — `session.drive()` returns the whole drained
  // batch — which is design/08's reason for the channel existing in the first place.
  //
  // It deliberately does NOT carry the swinging weapon, not even its ACTIVE HIT WINDOW
  // (`MeleeSimSpec.swingTicks`, design/07 step 7) which the render layer's swing envelope and
  // sector fx are both paced from. An earlier draft of ENGINE_VERSION 53 did add that field
  // here and it was removed the same day: every client already holds the whole `GameState` (the
  // netcode broadcasts inputs, not entities), so `EventReactor.meleeSwinger` resolves the spec
  // from `state.players` and reads the window straight off it. An event field would have been a
  // second source of truth for a number the reader already has — which is exactly the
  // authored-but-unread shape `swingSec` itself spent two months in.
  | { type: 'melee_swing'; ownerId: number; faction: Faction; gx: Fp; gy: Fp; facing: Brad }
  // `faction` is a DamageSrc, not just Faction — zone/hazard-tile damage (design/15,
  // ROADMAP 4.2d) reports 'environment' here, since there is no attacker on the other side.
  | { type: 'hit'; target: number; faction: DamageSrc; gx: Fp; gy: Fp; damage: number; damageType: DamageType; shieldRemaining?: number }
  // A hit (or DoT) that emptied a non-zero shield pool (design/07 two-pool). Render
  // plays a break fx; the sim uses it to fire a character's shield-break passive (0.5).
  | { type: 'shield_break'; id: number; gx: Fp; gy: Fp }
  | { type: 'clash'; gx: Fp; gy: Fp } // two opposing-faction bullets met and cancelled
  | { type: 'deflect'; gx: Fp; gy: Fp }
  // An elemental status was applied or ticked on a target (render plays the fx —
  // burn flames, chill frost, shock arc, poison bubbles). Transient, fx-only (08).
  | { type: 'status'; effect: 'burn' | 'chill' | 'shock' | 'poison'; target: number; gx: Fp; gy: Fp }
  // `r` is the dying actor's DRAWN body radius (`Actor.radius`, not any of the three
  // collision radii — see `state/actorRadius.ts`), carried so the render layer can size the
  // death burst off the corpse instead of off one authored number that fitted a 15 px mob and
  // nothing else (2026-09-03, live report: the burst reads far too big for the body).
  //
  // This is the one lifecycle event that genuinely cannot be answered from state the way
  // `bullet_fired`'s deliberately-omitted fields are: `DeathDropsSystem` compacts the dead
  // enemy out of `state.enemies` in the SAME tick it pushes this, so by the time a frame's
  // events are consumed there is no entity left to read a radius off — and `Scene.actorAt`
  // cannot stand in for it either, because the view has already moved to the dying list by
  // then (`render/rigClipLayer.ts` documents that same ordering). Additive and inert for the
  // sim, so no ENGINE_VERSION bump: see the header above.
  | { type: 'death'; id: number; faction: Faction; gx: Fp; gy: Fp; r: Fp }
  // A boss-tier enemy dropped below its enrage HP threshold (design/09 aspirational
  // `traits`, now real). Fires ONCE, the tick it first triggers — fx/audio only,
  // never read back into sim decisions (the enraged bonus itself lives on the actor).
  | { type: 'enrage'; id: number; gx: Fp; gy: Fp }
  | { type: 'armor_break'; id: number; gx: Fp; gy: Fp }
  // Co-op downed/revive (design/05/07/08, ROADMAP 3.2). A player was incapacitated
  // (revivable, not dead) / brought back up by a teammate's revive channel. fx-only.
  | { type: 'downed'; id: number; gx: Fp; gy: Fp }
  | { type: 'revived'; id: number; gx: Fp; gy: Fp }
  // `by` is the actor id of the player that collected it — the same field, for the same
  // reason, as `bullet_fired`'s `ownerId`: the render layer has to find the COLLECTOR'S OWN
  // VIEW, because the drop flies to their body over ~0.6 s rather than blinking out where it
  // lay (`scene/pickupFlight.ts`), and `gx/gy` is where it lay, which is the one point the
  // animation already has. It cannot be answered from state the way a `bullet_fired` field
  // could: `PickupSystem` compacts the item out of `state.pickups` the same tick it pushes
  // this, and "whoever is standing nearest the drop" is a guess that goes wrong exactly when
  // two players overlap — which is when the flight is most visible. Additive and inert for the
  // sim (events are never read back by a later system and never enter `serializeState`/
  // `hashState`), so no ENGINE_VERSION bump — see the header above.
  | { type: 'pickup'; kind: PickupKind; by: number; gx: Fp; gy: Fp; weaponId?: string; buffId?: string; materialId?: string; skinId?: string; qty?: number; tier?: number }
  // A chest just opened (design/05 "Chest rooms"). `weapons` is how many weapon pickups
  // it paid, so the render layer can size its burst off the event instead of counting
  // pickups that appeared the same tick for other reasons.
  | { type: 'chest_open'; id: number; kind: 'small' | 'big'; gx: Fp; gy: Fp; weapons: number }
  // A shop line was bought (design/05 "Shops", 2026-09-14). `buyer` is the seat's actor id,
  // so a client can tell "you bought this" from "someone else did" — which is the whole
  // difference between a confirmation and an explanation of why the row went grey. `price`
  // rides along rather than being looked back up, because the offer is already marked sold
  // by the time anything reads this.
  | {
      type: 'shop_buy';
      id: number;
      buyer: number;
      kind: 'weapon' | 'buff' | 'heal' | 'energy' | 'shield' | 'emp';
      price: number;
      gx: Fp;
      gy: Fp;
      // Which buff a buff line's buyer chose (ROADMAP B2, 2026-09-26); unset for other kinds.
      buffId?: string;
    }
  | { type: 'wave_clear'; wave: number }
  // A floor's checkpoint resolved to DESCEND (design/05, ROADMAP 1.4) — the floor
  // buffer just banked and the next floor's waves are loading. EXTRACT reuses the
  // existing 'win' event (a successful run end either way).
  | { type: 'descend'; floorIndex: number }
  // A dungeon room just activated (design/05/09, ROADMAP 1.3; reshaped 2026-08-04 for
  // the co-resident room/door model — DoorSystem) — the first tick any player's
  // `roomId` matched it, so its WaveScript just started. Every floor's rooms are all
  // simultaneously live (`state.dungeonRooms`), so there is no single numeric "current
  // room index" left to report — `roomId` alone identifies which room. fx-only,
  // transient, used by the render layer to know a room just became relevant.
  | { type: 'room_enter'; floorIndex: number; roomId: string }
  // A dungeon room's doors locked/unlocked as a unit (design/05, 2026-08-04, DoorSystem)
  // — locked the instant the room has ANY live enemy, unlocked the instant the last one
  // dies (never re-locked after that, since a cleared room never respawns). fx-only.
  | { type: 'door_locked'; roomId: string }
  | { type: 'door_unlocked'; roomId: string }
  // A room's combat rising edge force-regrouped every other online, non-downed player
  // to its entrance (design/05, 2026-08-04, DoorSystem) — not optional, no opt-out.
  | { type: 'force_regroup'; roomId: string; playerIds: readonly number[] }
  // PvP zone (design/15, ROADMAP 4.2d) — render/HUD/minimap-only, never fed back into
  // sim decisions (the `06` render/logic split, unchanged). `zone_warn` telegraphs the
  // NEXT stage's soon-to-close rooms; `zone_close` fires the instant they go live;
  // `zone_damage` mirrors 'hit' for environmental/hazard-tile ticks with no attacker.
  | { type: 'zone_warn'; stage: number; closing: readonly string[] }
  | { type: 'zone_close'; stage: number }
  | { type: 'zone_damage'; target: number; dmg: number }
  | { type: 'win'; winner: Winner };
