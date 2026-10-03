// A deterministic ally for local co-op (ROADMAP 3.1 — making the SECOND player visible
// and live). It produces a normal PlayerCommand for a non-local seat each sim tick, so
// the engine treats the ally exactly like a networked teammate: the command goes through
// the same input-edge quantization (quantizeMove → integer brad/mag) and the same
// ApplyInputSystem path. Nothing here decides outcomes — it only decides an INPUT, which
// the deterministic engine then simulates (design/08 "render only produces input").
//
// Behaviour: revive a downed teammate (volume 118, `ai/revive.ts`: the rule the arena bot
// ships), else engage the nearest enemy (fire in range, hold spacing — facing is engine-
// decided, design/10 v33), and when the floor is quiet, regroup toward the local player
// so the two stay together through room transitions. When the player stands on a big
// chest's plate, the ally takes another (`ai/chestPlate.ts`), and when a squadmate opens the
// portal it confirms at once (ENGINE_VERSION 87): a bot never holds its player back. All from the engine's fp state, no
// wall-clock / RNG — a bot is just another command source, and keeping it state-derived
// makes the run reproducible.
import { Button, makeCommand, quantizeMove, type GameState, type PlayerCommand } from '@dd/engine';
import { engageNearest, idleCommand, gridFp, FIRE_RANGE_FP, type Point } from './ai/engage';
import { reviveMove } from './ai/revive';
import { plateMove } from './ai/chestPlate';

/** Whichever portal button the floor reads; the engine ignores the other one. */
const PORTAL_CONFIRM = Button.CONFIRM_DESCEND | Button.CONFIRM_EXTRACT;

const REGROUP_FP = gridFp(3); // when idle, only close to the leader if further than this

export class AllyController {
  /** `revives: false` is the co-op revive sim's control (`sim/coopRevive.sim.ts`): the ally as it
   *  fought before volume 118 gave it the revive rule. */
  constructor(private readonly opts: { revives?: boolean } = {}) {}

  /** Build the ally seat's command for this tick. `leaderOwner` is the seat to regroup on. */
  build(s: GameState, owner: number, leaderOwner: number, tick: number): PlayerCommand {
    const cmd = this.fight(s, owner, leaderOwner, tick);
    const me = s.players[owner];
    // A squadmate opened the portal: confirm on whatever this tick is doing anyway.
    if (s.portalCountdownTicks > 0 && me && me.alive && !me.downed && !me.portalReady) return { ...cmd, buttons: cmd.buttons | PORTAL_CONFIRM };
    return cmd;
  }

  private fight(s: GameState, owner: number, leaderOwner: number, tick: number): PlayerCommand {
    const me = s.players[owner];
    if (!me || !me.alive || me.downed) return idleCommand(owner, tick);

    const enemies: Point[] = [];
    for (const e of s.enemies) if (e.alive) enemies.push(e);
    // A co-op revive is free (no bandage), so the rule never walks to a floor one and the aim
    // flag it takes for that is moot. It does not start a channel while an enemy has a clear
    // shot in fire range (the reviver cannot shoot back, ENGINE_VERSION 86), and holds one
    // already running.
    const rescue = this.opts.revives === false ? undefined : reviveMove(s, me, enemies, false);
    if (rescue) return makeCommand({ owner, tick, ...rescue.move, buttons: rescue.interact ? Button.INTERACT : 0 });
    // A plate before the fight, unless the fight is in range: `engageNearest` chases the
    // nearest live enemy anywhere on the floor, rooms not yet entered included, so "no enemy
    // left" almost never comes in a dungeon.
    const plate = plateMove(s, me);
    if (plate && !enemies.some((e) => Math.hypot(e.gx - me.gx, e.gy - me.gy) <= FIRE_RANGE_FP)) return makeCommand({ owner, tick, ...plate, buttons: 0 });
    const engaged = engageNearest(owner, tick, me, enemies);
    if (engaged) return engaged;

    // No enemies: regroup on the leader so the pair traverses rooms together.
    const leader = s.players[leaderOwner];
    if (leader && leader.alive) {
      const dx = leader.gx - me.gx;
      const dy = leader.gy - me.gy;
      if (Math.hypot(dx, dy) > REGROUP_FP) {
        const move = quantizeMove(dx, dy);
        return makeCommand({ owner, tick, moveBrad: move.moveBrad, moveMag: move.moveMag, buttons: 0 });
      }
    }
    return idleCommand(owner, tick);
  }
}
