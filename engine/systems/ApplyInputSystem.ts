/**
 * Step 1 — Apply input. Fold each player's confirmed command for this tick into
 * per-tick intent: move vector (fp/tick from moveBrad+moveMag), facing (see below —
 * no longer player input), the firing flag, and the edge-detected weapon-swap action.
 *
 * Facing (design/10, reversed-then-reversed-again 2026-08-03): there is no manual aim
 * input at all anymore. Every tick, a player faces the nearest hostile actor if one
 * exists (any distance — same unlimited-range contract `nearestHostile` already gives
 * homing/deflect), else the direction it's moving, else it holds last tick's facing
 * (idle default, same as before). Because this is engine-decided rather than fought
 * over with a manual aim input, it avoids the earlier "a locking bullet reads wrong"
 * failure mode that got the original auto-aim reverted.
 *
 * Idle default (design/08 open question, pinned here for Stage B): a player with
 * no command this tick holds idle — zero move, not firing — and its prevButtons is
 * left untouched so edge detection stays correct against the next real command.
 * Golden-replay coverage of this default is Stage E.
 *
 * Ports client/src/game/Game.ts updatePlayer() movement + facing, and
 * switchWeapon(), from float/radians to fp/brad. (Block is not a state — it is the
 * melee swing arc, see DeflectSystem; jump was removed.)
 */
import { FP_SCALE } from '../math/fixed';
import type { Fp } from '../math/fixed';
import { atan2Brad, cosFp, sinFp } from '../math/trig';
import type { GameState } from '../state/GameState';
import { Button, type PlayerCommand } from '../state/commands';
import type { PlayerActor } from '../state/entities';
import { PLAYER_BASE } from '../content/players';
import { closeSwing } from '../content/weapons';
import { nearestHostile } from './targeting';

export class ApplyInputSystem {
  tick(state: GameState, commands: readonly PlayerCommand[]): void {
    // Last command per owner wins if duplicates arrive for one tick.
    const byOwner = new Map<number, PlayerCommand>();
    for (const cmd of commands) {
      if (cmd.type === 'input') byOwner.set(cmd.owner, cmd);
    }

    for (let i = 0; i < state.players.length; i++) {
      const p = state.players[i]!;
      // A dead OR downed player can't act (design/05/07): a downed player is frozen in
      // place and cannot move, fire, swap, or revive — only a teammate can act on it.
      if (!p.alive || p.downed) {
        this.idle(p);
        continue;
      }
      const cmd = byOwner.get(i);
      if (cmd) this.apply(state, p, cmd);
      else this.idle(p);
    }
  }

  private apply(state: GameState, p: PlayerActor, cmd: PlayerCommand): void {
    // Move: (dir/1000) × speedPerTick × (mag/255), single truncation → deterministic.
    const cos = cosFp(cmd.moveBrad);
    const sin = sinFp(cmd.moveBrad);
    const speed = PLAYER_BASE.speedPerTick;
    p.vx = Math.trunc((cos * speed * cmd.moveMag) / (FP_SCALE * 255)) as Fp;
    p.vy = Math.trunc((sin * speed * cmd.moveMag) / (FP_SCALE * 255)) as Fp;

    const target = nearestHostile(state, p, p.gx, p.gy);
    if (target) {
      p.facing = atan2Brad(target.gy - p.gy, target.gx - p.gx);
    } else if (cmd.moveMag > 0) {
      p.facing = cmd.moveBrad;
    } // else: no target, not moving — hold last tick's facing.

    const held = cmd.buttons;
    const pressed = held & ~p.prevButtons; // rising edges this tick

    // Firing drives BOTH ranged shots and melee swings; a melee swing is also what
    // parries bullets (DeflectSystem) — there is no separate block input.
    p.firing = (held & Button.FIRE) !== 0;
    // This tick's INTERACT hold state (design/05/08) — read by PickupSystem/ReviveSystem.
    p.interacting = (held & Button.INTERACT) !== 0;
    // Portal-popup choice (design/05, ROADMAP 1.4 follow-up) — ExtractionSystem reads
    // these directly; already a one-tick pulse (CommandBuilder latches then clears),
    // same convention as SWAP_WEAPON below, so no edge detection needed here.
    p.confirmExtract = (held & Button.CONFIRM_EXTRACT) !== 0;
    p.confirmDescend = (held & Button.CONFIRM_DESCEND) !== 0;
    // Ground-weapon click target (design/03, ENGINE_VERSION 32) — already a one-tick
    // pulse (CommandBuilder latches then clears it), so no edge detection needed here,
    // same as confirmExtract/confirmDescend above.
    p.pickupTargetId = cmd.pickupTargetId;
    // Shop tap (design/05 "Shops", 2026-09-14) — the same one-tick pulse, same reasoning.
    p.shopBuyId = cmd.shopBuyId;
    // Floor-card vote (design/05, ENGINE_VERSION 58). Deliberately NOT the one-tick
    // pulse the two lines above are: a zero means "not changing my vote", so the seat
    // KEEPS the slot it picked until the checkpoint consumes the offer. That is what
    // lets a client send one tap instead of re-sending the choice every frame, and what
    // lets every client render a live tally of who has picked what.
    if (cmd.cardVote > 0) p.cardVote = cmd.cardVote;

    if (pressed & Button.SWAP_WEAPON) this.swap(p);

    p.prevButtons = held;
  }

  private idle(p: PlayerActor): void {
    p.vx = 0 as Fp;
    p.vy = 0 as Fp;
    p.firing = false;
    p.interacting = false;
    p.confirmExtract = false;
    p.confirmDescend = false;
    p.pickupTargetId = 0;
    p.shopBuyId = 0;
    // `cardVote` deliberately NOT cleared: an idle frame (a net stall, or a player who
    // simply isn't touching anything) is not a withdrawal of a choice already made.
    // Only a descend consuming the offer clears it, in ExtractionSystem.
    // prevButtons deliberately unchanged (idle-hold semantics above).
  }

  // Toggle the active loadout slot. Each slot keeps its own runtime (cooldown), so
  // switching mid-cooldown does not refresh a weapon. `weapon` mirrors
  // weapons[activeSlot] for the systems that read the active pointer.
  private swap(p: PlayerActor): void {
    if (p.weapons.length < 2) return;
    // A swing you put away is over (ENGINE_VERSION 53): close the outgoing weapon's active
    // hit window before the pointer moves. Only the ACTIVE weapon is ticked (WeaponFireSystem
    // reads `a.weapon`), so an open window on a holstered blade would otherwise freeze
    // mid-swing and re-open — still armed, still frozen damage — the moment the player
    // swapped back, however many seconds later. Cooldown deliberately keeps its old
    // freeze-in-place semantics per the comment above; that one is a *penalty* a player
    // shouldn't be able to shed by swapping, where this is a live attack.
    if (p.weapon) closeSwing(p.weapon);
    p.activeSlot = (p.activeSlot + 1) % p.weapons.length;
    p.weapon = p.weapons[p.activeSlot] ?? null;
  }
}
