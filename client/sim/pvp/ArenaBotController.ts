/**
 * A PvP bot that uses the weapons it carries — SIM-ONLY, for measuring what the shipped arena
 * bot cannot (design/03 "Still open": "the arena bot neither swaps nor parries").
 *
 * It wraps the shipped `PvpBotController` (zone first, then fight what its gun points at) and
 * adds three behaviours, each behind its own flag so a sweep can switch them on one at a time:
 *
 *   - `loots`: when nothing it aims at is in fire range, walk to an unopened crate (an arena crate
 *     only rolls its contents once a seat is near it) or to a floor gun worth more than the
 *     one held (`gunWorth`, the PvE bot's dps ordering), and click the gun once in reach.
 *   - `meleeWhenDry`: holster a gun the pool cannot pay for and close in with the blade until
 *     `REARM_SHOTS` pulls are back (`drySwapDue`).
 *   - `parries`: draw a READY blade and swing when a hostile bullet will cross its reach
 *     within `PARRY_LOOKAHEAD` ticks, without leaving the gun's spacing; go back to the gun
 *     once nothing is coming.
 *
 * Deliberately NOT the shipped bot. `PvpBotController` fills empty seats in real matches
 * (`server/src/BotClient.ts`) and must stay a pure function of state; this one keeps two
 * fields of memory (the last swap tick, since the engine swaps on a press edge, and why the
 * blade is out). Whether any of this belongs in the shipped bot is a separate decision.
 */
import { Button, FP_SCALE, SIM, WEAPON_SPECS, makeCommand, type GameState, type PlayerActor, type PlayerCommand } from '@dd/engine';
import { nearestHostile } from '@dd/engine/systems/targeting';
import { PvpBotController } from '../../src/game/controllers/PvpBotController';
import { FIRE_RANGE_FP, idleCommand } from '../../src/game/controllers/ai/engage';
import { HOLD, steer } from '../../src/game/controllers/ai/steer';
import { zoneRetreatCommand } from '../../src/game/controllers/ai/zoneRetreat';
import { gunWorth } from '../pve/weaponChoice';

export interface ArenaBotProfile {
  loots: boolean;
  meleeWhenDry: boolean;
  parries: boolean;
}

export const ARENA_PROFILES = {
  shipped: { loots: false, meleeWhenDry: false, parries: false },
  loots: { loots: true, meleeWhenDry: false, parries: false },
  lootsDry: { loots: true, meleeWhenDry: true, parries: false },
  parries: { loots: false, meleeWhenDry: false, parries: true },
  full: { loots: true, meleeWhenDry: true, parries: true },
} as const satisfies Record<string, ArenaBotProfile>;

/**
 * Pulls that must be affordable before a blade drawn for a dry gun goes back. A count of
 * SHOTS, not the PvE bot's share of the pool (`REARM_FRAC`): a pool-share threshold makes a
 * deeper bar wait longer on the blade, which read in the first sweep as "the 130 pool loses"
 * when it was this rule sending the most fragile seat into melee for longest.
 */
export const REARM_SHOTS = 3;

/** How far off its path the bot walks for a better gun. */
export const LOOT_DETOUR_FP = 8 * FP_SCALE;
/** Ticks ahead a bullet is judged against the blade's reach. A swap and a swing start on the
 *  same tick, so this only needs to cover a bullet crossing the reach between two commands. */
export const PARRY_LOOKAHEAD = 4;

export class ArenaBotController {
  private readonly base = new PvpBotController();
  private lastSwapTick = -2;
  /** The blade is out because a bullet was coming, not because the gun ran dry. */
  private bladeForParry = false;

  /**
   * @param startDelay ticks the seat stands idle at the drop. The arena is one fixed map and
   * the bot is deterministic, so without a per-seat offset a match is fixed by its seating
   * alone: two seats have two seatings, and 30 seeds of a spread-free gun were two matches.
   */
  constructor(
    private readonly profile: ArenaBotProfile,
    private readonly startDelay = 0,
  ) {}

  build(s: GameState, owner: number, tick: number): PlayerCommand {
    if (tick <= this.startDelay) return idleCommand(owner, tick);
    const cmd = this.base.build(s, owner, tick);
    const me = s.players[owner];
    if (!me || !me.alive || me.downed) return cmd;
    const opponents = s.players.filter((p) => p !== me && p.alive && !p.downed && p.teamId !== me.teamId);
    // What the gun points at, mob or seat (`ApplyInputSystem` faces the nearest hostile): the
    // body the blade swings at and the dry rule reacts to, as the shipped bot's fire does.
    const aim = nearestHostile(s, me, me.gx, me.gy) ?? undefined;
    const inRange = aim !== undefined && dist(me, aim) <= FIRE_RANGE_FP;

    const active = me.weapon;
    const bladeOut = active?.spec.kind === 'melee';
    const blade = me.weapons.find((w) => w.spec.kind === 'melee');
    const bladeSpec = blade?.spec.kind === 'melee' ? blade.spec : undefined;
    // A holstered weapon's cooldown is frozen (`ApplyInputSystem.swap`), so drawing a blade
    // that is still recovering from the last swing parries nothing: only a ready one counts.
    const bladeReady = blade !== undefined && (bladeOut || blade.cooldownTicks === 0);
    const threat = this.profile.parries && bladeSpec?.deflect === true && bladeReady && bulletIncoming(s, me, bladeSpec.range);
    const dry = this.profile.meleeWhenDry && drySwapDue(me, inRange);

    // Which slot this tick wants in hand. A blade drawn to parry goes back once nothing is
    // coming — unless the gun cannot be paid for, and then it is the dry rule's blade.
    if (bladeOut && this.bladeForParry && !threat && this.profile.meleeWhenDry && !gunAffordable(me)) this.bladeForParry = false;
    // It also waits out the blade's recovery first: a holstered weapon's cooldown is frozen,
    // so a blade put away mid-recovery would never be ready for the next bullet.
    let wantBlade = bladeOut;
    if (threat) wantBlade = true;
    else if (bladeOut && this.bladeForParry) wantBlade = blade!.cooldownTicks > 0;
    else if (dry) wantBlade = !bladeOut;
    const midSwing = (active?.swingTicksLeft ?? 0) > 0;
    const swap = wantBlade !== bladeOut && blade !== undefined && tick - this.lastSwapTick >= 2 && !(bladeOut && midSwing);
    if (swap) this.bladeForParry = wantBlade && threat;

    let { moveBrad, moveMag, buttons } = cmd;
    let pickupTargetId = 0;
    const retreating = zoneRetreatCommand(s, owner, tick, me, opponents) !== null;

    // Loot: an unopened crate is walked to (it only turns into something within the reveal
    // radius, `PickupSystem.resolveCrates`), a better gun is walked to and clicked.
    const loot = this.profile.loots ? lootToSeek(s, me) : undefined;
    if (loot?.kind === 'weapon' && dist(me, loot) <= (SIM.lootRevealRadius as number)) pickupTargetId = loot.id;
    if (loot && !retreating && !inRange) ({ moveBrad, moveMag } = steer(s, me, [loot]) ?? HOLD);

    const bladeInHand = swap ? !bladeOut : bladeOut;
    if (bladeInHand && bladeSpec) {
      // Swing at a bullet about to cross the reach, or at a body inside it. Only the dry
      // blade closes in: a parry blade keeps the gun's spacing, since it goes back in a moment.
      const closing = !this.bladeForParry && !threat;
      if (closing && aim && !retreating) ({ moveBrad, moveMag } = steer(s, me, [aim]) ?? HOLD);
      buttons = threat || (aim !== undefined && dist(me, aim) <= bladeSpec.range) ? Button.FIRE : 0;
    } else if (swap) {
      buttons &= ~Button.FIRE;
    }
    if (swap) {
      this.lastSwapTick = tick;
      buttons |= Button.SWAP_WEAPON;
    }
    return makeCommand({ owner, tick, moveBrad, moveMag, buttons, pickupTargetId });
  }
}

function dist(a: { gx: number; gy: number }, b: { gx: number; gy: number }): number {
  return Math.hypot(b.gx - a.gx, b.gy - a.gy);
}

/**
 * Should the seat swap slots for the dry rule now? To the blade: the gun in hand cannot pay
 * for a pull and what it aims at is in range. Back to the gun: `REARM_SHOTS` pulls are affordable
 * (or a full bar, if that holds fewer).
 */
export function drySwapDue(me: PlayerActor, targetInRange: boolean): boolean {
  const active = me.weapon?.spec;
  const gun = me.weapons.find((w) => w.spec.kind === 'ranged')?.spec;
  if (!active || gun?.kind !== 'ranged' || !me.weapons.some((w) => w.spec.kind === 'melee')) return false;
  if (active.kind === 'ranged') return me.energy < gun.energyCost && targetInRange;
  return me.energy >= Math.min(me.maxEnergy, gun.energyCost * REARM_SHOTS);
}

function gunAffordable(me: PlayerActor): boolean {
  const gun = me.weapons.find((w) => w.spec.kind === 'ranged')?.spec;
  return gun?.kind === 'ranged' && me.energy >= gun.energyCost;
}

/**
 * Will a bullet hostile to `me` enter `reach` of it within the next `PARRY_LOOKAHEAD` ticks?
 * Straight-line, on the bullet's current velocity. A bullet moving away is
 * never a threat, even inside the reach: it has passed. A still bullet is not either (a beam
 * or a landed lob, which a swing cannot turn back).
 */
export function bulletIncoming(s: GameState, me: PlayerActor, reach: number): boolean {
  for (const b of s.projectiles) {
    if (!b.alive || b.teamId === me.teamId) continue;
    const rx = b.gx - me.gx;
    const ry = b.gy - me.gy;
    const v2 = b.vx * b.vx + b.vy * b.vy;
    if (v2 === 0) continue;
    const along = rx * b.vx + ry * b.vy;
    if (along >= 0) continue; // moving away: already past, or never coming
    const c = rx * rx + ry * ry - reach * reach;
    if (c <= 0) return true; // inside the reach and closing
    // The tick it ENTERS the reach: the smaller root of |r + v t| = reach.
    const disc = along * along - v2 * c;
    if (disc < 0) continue; // passes wide
    if ((-along - Math.sqrt(disc)) / v2 <= PARRY_LOOKAHEAD) return true;
  }
  return false;
}

/**
 * Where the loot rule walks: the nearest unopened crate, or floor gun worth more than the one
 * held, within `LOOT_DETOUR_FP`. Strictly more, so the gun a pickup drops can never lure the
 * bot back.
 */
export function lootToSeek(s: GameState, me: PlayerActor): { id: number; kind: 'crate' | 'weapon'; gx: number; gy: number } | undefined {
  const held = me.weapons.find((w) => w.spec.kind === 'ranged');
  const heldWorth = held ? gunWorth(held.spec.name) : -1;
  let best: { id: number; kind: 'crate' | 'weapon'; gx: number; gy: number } | undefined;
  let d = LOOT_DETOUR_FP;
  for (const item of s.pickups) {
    if (!item.alive) continue;
    if (item.kind === 'weapon') {
      if (!item.weaponId || WEAPON_SPECS[item.weaponId]?.kind !== 'ranged' || gunWorth(item.weaponId) <= heldWorth) continue;
    } else if (item.kind !== 'crate') continue;
    const dd = dist(me, item);
    if (dd <= d) {
      d = dd;
      best = { id: item.id, kind: item.kind, gx: item.gx, gy: item.gy };
    }
  }
  return best;
}
