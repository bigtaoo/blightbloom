/**
 * A deterministic PvE bot that can actually play a level start-to-finish: clear a
 * room, walk through the door to the next one, and confirm the portal at the
 * checkpoint. It exists for the level simulator (`levelSim.ts`) — the thing that
 * turns "is floor 1 room 1 survivable?" from a question you answer by playing into
 * one you answer by running a sweep.
 *
 * It is a strictly bigger job than the two bots already in `client/src/game/
 * controllers/` (`AllyController`, `PvpBotController`, both single-purpose "engage
 * the nearest hostile, else idle/regroup" seats — see `ai/engage.ts`): those never
 * have to navigate a room graph or press a portal button, because a human is always
 * the one driving the run forward. That extra half is why this lives here in `sim/`
 * rather than beside them: nothing shipped needs a bot that plays the game FOR the
 * player. It still produces nothing but a normal `PlayerCommand` per tick (design/08
 * "render only produces input"), so the engine cannot tell it from a human seat.
 *
 * Skill profile (`BOT_PROFILES`) is a first-class knob, not a detail: a balance
 * number that only holds for a perfect kiter is not a balance number. `careful`
 * holds the range an enemy's own `engageRangeFp` cannot reach and backs off when
 * crowded; `aggressive` walks into the mob's face like a new player does. Reading
 * both rows of the report is how you tell "this room is hard" from "this room is
 * impossible".
 *
 * Deliberately NOT a pure function of state (unlike `PvpBotController`, which has
 * to be — `server/src/BotClient.ts` recomputes it from confirmed state): this one
 * keeps a little memory (which room it thinks it is in, a stuck-timer) because the
 * engine's own room state is genuinely ambiguous while standing in a door passage.
 * A run is still fully reproducible, since that memory only ever advances from
 * state the engine already decided.
 */
import { Button, makeCommand, quantizeMove, FP_SCALE, RARITY_ORDER, SIM, WEAPON_SPECS, type Brad, type GameState, type PlayerCommand } from '@dd/engine';
import { profileForWeaponId } from './weaponStandoff';
import { checkpointReached, totalFloorCount } from '../../src/game/match/floorCount';
import { bfsPath, capstoneRoomId, doorCentre, pointInRect, rectCentre, roomIdAt, roomRect, roomRuntime, type Vec } from './pveNav';

const g = (grid: number): number => grid * FP_SCALE;

export interface BotProfile {
  /** Distance the bot tries to hold from its target while shooting. */
  standoffFp: number;
  /** Dead zone around `standoffFp` — stops a bot oscillating one tick in, one out. */
  hysteresisFp: number;
  /** Opens fire once the target is this close (its gun's own reach is unlimited;
   *  this is the bot's discipline, not the weapon's). */
  fireRangeFp: number;
  /** Break off toward a heal pickup below this fraction of total effective HP. */
  healSeekFrac: number;
  /**
   * Wait in a cleared room for the shield pool to refill before opening the next
   * one (config.ts `SHIELD_REGEN_DELAY`/`SHIELD_REGEN_INTERVAL`). This is the single
   * biggest difference between careful and reckless play in a room-by-room game, and
   * it has to be modelled or the sim cannot see the effect of any regen tuning at
   * all: a bot that walks straight on always fights at whatever HP the last room
   * left it with.
   */
  restsBetweenRooms: boolean;
  /**
   * Walk to a better GUN lying in a quiet room and take it (2026-09-26). Without this the bot
   * fought every floor with the starter blaster, so `weaponFireStats` read `blaster 100%` on
   * every sweep and the energy economy's whole reason to exist — a strong frame running its
   * pool dry — was never exercised by play, only by staged `loadout` runs. "Better" is a
   * strictly higher intrinsic rarity; ranged only, since the bot never swings its blade. The
   * bot then stands where the new gun can connect from (`weaponStandoff.ts`).
   */
  swapsWeapons: boolean;
}

/**
 * `careful` sits just outside `DEFAULT_ENEMY_ENGAGE_RANGE_FP` (5.6 grid — the range
 * a mob stops and shoots from, content/enemies.ts), so a competent player's spacing
 * is represented, not just a brawl. `aggressive` closes to the same 4-grid spacing
 * `ai/engage.ts`'s shipped `KEEP_DIST_FP` uses for the co-op ally, i.e. what the
 * game's own existing bot considers normal.
 */
export const BOT_PROFILES: Record<'careful' | 'aggressive', BotProfile> = {
  careful: { standoffFp: g(7.5), hysteresisFp: g(1), fireRangeFp: g(11), healSeekFrac: 0.7, restsBetweenRooms: true, swapsWeapons: true },
  aggressive: { standoffFp: g(4), hysteresisFp: g(1), fireRangeFp: g(11), healSeekFrac: 0.5, restsBetweenRooms: false, swapsWeapons: true },
};

/** Enemies further than this are somebody else's problem — keeps the bot from
 *  trying to shoot through a wall at a neighbouring room's garrison. */
const ENGAGE_SCAN_FP = g(14);
const HEAL_SCAN_FP = g(12);
const WAYPOINT_REACHED_FP = g(1);
/** Stuck = intended to move but covered less than this over `STUCK_WINDOW` ticks. */
const STUCK_WINDOW = 24;
const STUCK_EPSILON_FP = g(0.4);
const UNSTICK_TICKS = 20;
/** Upper bound on one between-rooms breather (~20s) — see `shouldRest`. */
const REST_CAP_TICKS = 600;
/** No kill in this long while engaged (~4s) → start circling (see `orbiting`). */
const STALL_KILL_TIMEOUT = 120;

/** The bot's own view of its seat, in the one coordinate vocabulary this file uses
 *  (`x`/`y` Fp, like every rect/waypoint here) instead of the actor's `gx`/`gy`. */
interface Self extends Vec {
  hp: number;
  maxHp: number;
  shield: number;
  maxShield: number;
}

export class PveBotController {
  /** Last room the bot was unambiguously inside — a door passage belongs to no room
   *  rect, so `roomIdAt` goes undefined mid-crossing and this carries it across. */
  private currentRoom: string | undefined;
  private stuckSince = 0;
  private restedTicks = 0;
  private lastAliveCount = -1;
  private lastKillTick = 0;
  private lastPos: Vec = { x: 0, y: 0 };
  private unstickUntil = -1;
  private unstickSign = 1;
  private readonly spacingCache = new Map<string, BotProfile>();
  /** The gun in hand the first time the bot fought — the one that keeps the base spacing. */
  private startingWeapon: string | undefined;

  constructor(private readonly profile: BotProfile = BOT_PROFILES.careful) {}

  build(s: GameState, owner: number, tick: number): PlayerCommand {
    const me = s.players[owner];
    if (!me || !me.alive || me.downed) return this.idle(owner, tick);

    const self: Self = { x: me.gx, y: me.gy, hp: me.hp, maxHp: me.maxHp, shield: me.shield, maxShield: me.maxShield };
    const here = roomIdAt(s, self.x, self.y);
    if (here !== undefined) this.currentRoom = here;

    // Checkpoint: walk into the capstone room and confirm the portal. Descend while
    // floors remain, extract on the last one (ExtractionSystem ignores DESCEND there).
    if (checkpointReached(s)) {
      const capstone = capstoneRoomId(s);
      const rect = capstone === undefined ? undefined : roomRect(s, capstone);
      if (rect && pointInRect(self.x, self.y, rect)) {
        const last = s.floorIndex >= totalFloorCount(s) - 1;
        return makeCommand({
          owner,
          tick,
          moveBrad: 0 as Brad,
          moveMag: 0,
          buttons: last ? Button.CONFIRM_EXTRACT : Button.CONFIRM_DESCEND,
          // A descend is held until the squad picks a floor card (ENGINE_VERSION 58),
          // so without this the bot presses DESCEND forever and every run in the sweep
          // times out on a cleared floor. The bot always takes the FIRST slot rather
          // than evaluating the offer: this harness measures how much damage a room
          // deals and how much loot a floor hands out, and a bot that drafted cards
          // well would quietly turn every one of those numbers into a statement about
          // its own drafting instead. A card-evaluating bot is its own tool, if the
          // question ever becomes "which cards are too strong".
          cardVote: 1,
        });
      }
      return this.travel(s, self, owner, tick, capstone);
    }

    const target = this.nearestEnemy(s, self, here);
    if (target) {
      this.restedTicks = 0;
      return this.fight(s, self, owner, tick, target, here);
    }
    // Nothing left to fight here: top the shield off before opening the next room,
    // unless there is a heal on the floor worth walking to first (`fight` handles
    // that case; here the room is quiet, so seek it directly).
    const heal = this.healToSeek(s, self, here);
    if (heal) return this.withUnstick(owner, tick, self, quantizeMove(heal.x - self.x, heal.y - self.y), 0);
    const chest = this.chestToOpen(s, here);
    if (chest) return this.withUnstick(owner, tick, self, quantizeMove(chest.x - self.x, chest.y - self.y), 0);
    const upgrade = this.weaponToTake(s, owner, here);
    if (upgrade) {
      const close = Math.hypot(upgrade.x - self.x, upgrade.y - self.y) <= (SIM.lootRevealRadius as number);
      // Walk onto it, and click it once inside the panel's reveal radius — exactly the
      // tap a player makes (`PlayerCommand.pickupTargetId`); the swap itself is the sim's.
      return this.withUnstick(owner, tick, self, quantizeMove(upgrade.x - self.x, upgrade.y - self.y), 0, close ? upgrade.id : 0);
    }
    if (this.shouldRest(self)) {
      this.restedTicks++;
      return this.idle(owner, tick);
    }
    this.restedTicks = 0;
    return this.travel(s, self, owner, tick, this.nextObjectiveRoom(s));
  }

  // ── Combat ───────────────────────────────────────────────────────────────────

  private fight(s: GameState, me: Self, owner: number, tick: number, target: Vec, room: string | undefined): PlayerCommand {
    const heal = this.healToSeek(s, me, room);
    const dx = target.x - me.x;
    const dy = target.y - me.y;
    const dist = Math.hypot(dx, dy);
    const spacing = this.spacingFor(s.players[owner]?.weapon?.spec.name);
    const buttons = dist <= spacing.fireRangeFp ? Button.FIRE : 0;

    // A heal on the floor outranks spacing discipline — it is the only in-run
    // sustain there is (design/05 power ramp), and walking over it is free damage
    // avoided later.
    const move = heal
      ? quantizeMove(heal.x - me.x, heal.y - me.y)
      : this.orbiting(s, tick)
        ? quantizeMove(-dy, dx) // perpendicular: circle the target to clear the shot
        : this.spacingMove(spacing, dx, dy, dist);
    return this.withUnstick(owner, tick, me, move, buttons);
  }

  /** The profile re-spaced for the gun in hand (`weaponStandoff.ts`), cached per weapon id —
   *  but only once the bot has actually SWAPPED. The gun a run starts with keeps the base
   *  profile, so a run that never swaps plays exactly as before the bot could. (Re-spacing the
   *  starter blaster too pulled the careful bot in from 7.5 to ~6 grid and took its average
   *  depth from floor 0.5 to 0 with no swap at all — measured, 2026-09-26.) */
  private spacingFor(weaponId: string | undefined): BotProfile {
    if (weaponId !== undefined && this.startingWeapon === undefined) this.startingWeapon = weaponId;
    if (!this.profile.swapsWeapons || weaponId === undefined || weaponId === this.startingWeapon) return this.profile;
    let p = this.spacingCache.get(weaponId);
    if (!p) {
      p = profileForWeaponId(this.profile, weaponId);
      this.spacingCache.set(weaponId, p);
    }
    return p;
  }

  /**
   * Where to stand to open an unopened chest in the bot's own room (2026-09-26), or null. A
   * small chest opens on approach, so the chest itself; a big one opens while every plate is
   * occupied, so the nearest plate (solo, a big chest has exactly one). Gated on
   * `swapsWeapons`, because a chest pays weapons and a bot that cannot use one has no reason
   * to walk to it — keeping the flag-off bot byte-identical to the one every earlier sweep ran.
   */
  private chestToOpen(s: GameState, room: string | undefined): Vec | null {
    if (!this.profile.swapsWeapons || room === undefined) return null;
    for (const c of s.chests) {
      if (c.opened || c.roomId !== room) continue;
      if (c.kind === 'small') return { x: c.gx, y: c.gy };
      const plate = c.mechanisms.find((m) => !m.occupied) ?? c.mechanisms[0];
      if (plate) return { x: plate.gx, y: plate.gy };
    }
    return null;
  }

  /**
   * A ranged weapon on the floor of the bot's own room whose intrinsic rarity beats the gun
   * it holds, nearest first — or null. Own room only, for the reason `healToSeek` gives: a
   * pickup behind a combat-locked door is not reachable. Strictly higher rarity, so the gun
   * the swap drops back on the floor (always the worse one) can never lure it back.
   */
  private weaponToTake(s: GameState, owner: number, room: string | undefined): (Vec & { id: number }) | null {
    if (!this.profile.swapsWeapons) return null;
    const me = s.players[owner];
    if (!me) return null;
    const held = me.weapons.find((w) => w.spec.kind === 'ranged');
    const heldRank = held ? rarityRank(held.spec.name) : -1;
    let best = Infinity;
    let found: (Vec & { id: number }) | null = null;
    for (const item of s.pickups) {
      if (!item.alive || item.kind !== 'weapon' || !item.weaponId) continue;
      if (WEAPON_SPECS[item.weaponId]?.kind !== 'ranged' || rarityRank(item.weaponId) <= heldRank) continue;
      if (room !== undefined && roomIdAt(s, item.gx, item.gy) !== room) continue;
      const dx = item.gx - me.gx;
      const dy = item.gy - me.gy;
      const d2 = dx * dx + dy * dy;
      if (d2 < best) {
        best = d2;
        found = { x: item.gx, y: item.gy, id: item.id };
      }
    }
    return found;
  }

  /**
   * Is the bot circling its target instead of holding spacing? A mob standing behind
   * a pillar or a decor block soaks every bullet in the wall between them, and a
   * purely radial mover will happily keep shooting that wall until the run times out
   * (the sim caught this too: 2-3 of 8 runs per profile stalled indefinitely in the
   * `blocks2`/`pillars4` rooms). A player sidesteps to clear the shot, so the bot
   * does: if nothing has died for `STALL_KILL_TIMEOUT` ticks while it has a target,
   * strafe perpendicular in bursts until something gives.
   */
  private orbiting(s: GameState, tick: number): boolean {
    const alive = s.enemies.reduce((n, e) => n + (e.alive ? 1 : 0), 0);
    if (alive !== this.lastAliveCount) {
      this.lastAliveCount = alive;
      this.lastKillTick = tick;
      return false;
    }
    return tick - this.lastKillTick > STALL_KILL_TIMEOUT;
  }

  /** Hold `standoffFp`: close when outside the band, back off when inside it. */
  private spacingMove(spacing: BotProfile, dx: number, dy: number, dist: number): { moveBrad: Brad; moveMag: number } {
    const { standoffFp, hysteresisFp } = spacing;
    if (dist > standoffFp + hysteresisFp) return quantizeMove(dx, dy);
    if (dist < standoffFp - hysteresisFp) return quantizeMove(-dx, -dy);
    return { moveBrad: 0 as Brad, moveMag: 0 };
  }

  /**
   * Nearest live enemy worth engaging. Restricted to the bot's OWN room whenever it
   * is unambiguously inside one: a room's walls block bullets, and without this
   * filter the bot happily settles into a standoff with a mob it cannot hit through
   * a wall in the next room and never advances again (the sim caught exactly that —
   * 7 of 8 careful runs stalled forever after clearing the entrance room). While
   * standing in a door passage (`room === undefined`) it falls back to a plain radius
   * scan, which is also the correct behaviour there — both rooms are open to it.
   *
   * Inside its own room there is deliberately NO distance cap (ENGINE_VERSION 42): the
   * room's walls already are the bound, and the enemy perception radius means a mob on
   * the far side of a big room no longer walks over on its own — someone has to close
   * the distance, and it is the player. Capped, the bot would find no target, fall
   * through to `travel`, and bounce off the combat-locked door until the run timed out
   * (which is exactly what the sim reported on the r5 rooms the tick v42 landed).
   * `fight` already handles the approach: `spacingMove` closes while outside the
   * standoff band and `fireRangeFp` still gates the trigger, so this widens who the bot
   * WALKS toward, never who it shoots at from out of range.
   */
  private nearestEnemy(s: GameState, me: Vec, room: string | undefined): Vec | null {
    let best = room !== undefined ? Infinity : ENGAGE_SCAN_FP * ENGAGE_SCAN_FP;
    let found: Vec | null = null;
    for (const e of s.enemies) {
      if (!e.alive) continue;
      if (room !== undefined && e.roomId !== room) continue;
      const dx = e.gx - me.x;
      const dy = e.gy - me.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < best) {
        best = d2;
        found = { x: e.gx, y: e.gy };
      }
    }
    return found;
  }

  /**
   * A heal drop worth walking to, restricted to the bot's OWN room for the same reason
   * `nearestEnemy` is: while a room still holds a live enemy its doors are combat-locked
   * (`DoorSystem`), so a heal left behind in the room next door is not reachable at all,
   * and heal-seeking outranks every other move in `fight`. Unrestricted, a hurt bot in a
   * room whose last mob is still alive would walk at that unreachable heal, into a locked
   * door, until the run timed out — which is exactly what the sim reported on
   * `careful/seed=404/r5_court`. Standing in a door passage (`room === undefined`) falls
   * back to a plain radius scan, same convention as `nearestEnemy`.
   */
  private healToSeek(s: GameState, me: Self, room: string | undefined): Vec | null {
    const frac = (me.hp + me.shield) / Math.max(1, me.maxHp + me.maxShield);
    if (frac > this.profile.healSeekFrac) return null;
    let best = HEAL_SCAN_FP * HEAL_SCAN_FP;
    let found: Vec | null = null;
    for (const item of s.pickups) {
      if (!item.alive || item.kind !== 'heal') continue;
      if (room !== undefined && roomIdAt(s, item.gx, item.gy) !== room) continue;
      const dx = item.gx - me.x;
      const dy = item.gy - me.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < best) {
        best = d2;
        found = { x: item.gx, y: item.gy };
      }
    }
    return found;
  }

  /**
   * Stand still in a quiet room while the shield refills. Capped at `REST_CAP_TICKS`
   * so a character with no shield pool at all (juggernaut, maxShield 0) or a run
   * whose regen is somehow blocked can never wedge the sim on an infinite rest —
   * the cap is a safety net, not a tactic.
   */
  private shouldRest(me: Self): boolean {
    if (!this.profile.restsBetweenRooms) return false;
    if (this.restedTicks >= REST_CAP_TICKS) return false;
    return me.shield < me.maxShield;
  }

  // ── Navigation ───────────────────────────────────────────────────────────────

  /** The room worth walking to next: the nearest one still holding live enemies or
   *  never activated at all, else the capstone (so a fully-cleared floor still
   *  converges on the portal).
   *
   *  The capstone is never that "nearest unvisited room" while any other is left
   *  (2026-09-26). It used to be: entering it ends the floor, and since the chest rooms
   *  hang off the chain as dead ends, the capstone was usually nearer — so the bot never
   *  opened a chest, never saw a weapon, and every sweep read `blaster 100%`. A player
   *  sweeps the floor for its chest before taking the portal, and so does the bot now. */
  private nextObjectiveRoom(s: GameState): string | undefined {
    const from = this.currentRoom;
    if (from === undefined) return undefined;
    const capstone = capstoneRoomId(s);
    const path = bfsPath(s, from, (id) => {
      if (id === from || id === capstone) return false; // never "arrive" where we already are
      const rt = roomRuntime(s, id);
      return rt !== undefined && (!rt.activated || rt.hasLiveEnemy);
    });
    return path?.[path.length - 1] ?? capstone;
  }

  /** Walk toward `goal` one door at a time: aim at the shared passage until we are
   *  standing in it, then at the next room's centre so we actually cross. */
  private travel(s: GameState, me: Self, owner: number, tick: number, goal: string | undefined): PlayerCommand {
    const from = this.currentRoom;
    if (goal === undefined || from === undefined) return this.idle(owner, tick);
    const path = from === goal ? [from] : bfsPath(s, from, (id) => id === goal);
    if (!path) return this.idle(owner, tick);

    let waypoint: Vec | undefined;
    if (path.length >= 2) {
      const gate = doorCentre(s, path[0]!, path[1]!);
      const nextRect = roomRect(s, path[1]!);
      const atGate = gate !== undefined && Math.hypot(gate.x - me.x, gate.y - me.y) <= WAYPOINT_REACHED_FP;
      waypoint = atGate && nextRect ? rectCentre(nextRect) : gate;
    } else {
      const rect = roomRect(s, path[0]!);
      waypoint = rect ? rectCentre(rect) : undefined;
    }
    if (!waypoint) return this.idle(owner, tick);

    const move = quantizeMove(waypoint.x - me.x, waypoint.y - me.y);
    return this.withUnstick(owner, tick, me, move, 0);
  }

  // ── Stuck handling ───────────────────────────────────────────────────────────

  /**
   * The AI in this game walks in straight lines (`AIDecideSystem.chaseAndEngage`'s
   * own doc comment: "a mob can stall against a concave wall") and so does this
   * bot. A pillar or a doorway lip would otherwise pin it there for the whole run
   * and report as a fake "survived forever" result, so: if it wanted to move but
   * hasn't, strafe perpendicular for a fixed burst. Direction alternates off the
   * tick the stall was detected — deterministic, no PRNG (design/06).
   */
  private withUnstick(owner: number, tick: number, me: Vec, move: { moveBrad: Brad; moveMag: number }, buttons: number, pickupTargetId = 0): PlayerCommand {
    const moved = Math.hypot(me.x - this.lastPos.x, me.y - this.lastPos.y);
    if (move.moveMag > 0 && moved < STUCK_EPSILON_FP / STUCK_WINDOW) this.stuckSince++;
    else this.stuckSince = 0;
    this.lastPos = { x: me.x, y: me.y };

    if (this.stuckSince >= STUCK_WINDOW && tick > this.unstickUntil) {
      this.unstickUntil = tick + UNSTICK_TICKS;
      this.unstickSign = -this.unstickSign;
      this.stuckSince = 0;
    }
    if (tick <= this.unstickUntil && move.moveMag > 0) {
      // Rotate the intended direction a quarter turn (brad is a 16-bit circle).
      const turned = ((move.moveBrad + this.unstickSign * 16384 + 65536) % 65536) as Brad;
      return makeCommand({ owner, tick, moveBrad: turned, moveMag: move.moveMag, buttons, pickupTargetId });
    }
    return makeCommand({ owner, tick, moveBrad: move.moveBrad, moveMag: move.moveMag, buttons, pickupTargetId });
  }

  private idle(owner: number, tick: number): PlayerCommand {
    return makeCommand({ owner, tick, moveBrad: 0 as Brad, moveMag: 0, buttons: 0 });
  }
}

/** A weapon id's intrinsic rarity as a rank (`RARITY_ORDER` index); -1 for an unknown id. */
function rarityRank(weaponId: string): number {
  const spec = WEAPON_SPECS[weaponId];
  return spec ? RARITY_ORDER.indexOf(spec.rarity) : -1;
}
