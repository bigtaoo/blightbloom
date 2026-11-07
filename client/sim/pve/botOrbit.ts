// PveBotController split: the stall orbit — circle a target nothing is killing, reversing when blocked.
import { quantizeMove, type Brad } from '@dd/engine';
import type { Vec } from './pveNav';

/**
 * Circles the target perpendicular to it, and goes the other way round once the circling has
 * gone nowhere for `window` ticks (net distance under `epsilon` from where the count began).
 * A seat sliding a pixel to and fro on a wall block moves every tick, so the controller's
 * per-tick unstick never fires for it (seed 31, coop-revive: the leader orbited into one
 * block until the run timed out).
 */
export class BotOrbit {
  private sign = 1;
  private anchor: Vec = { x: 0, y: 0 };
  private still = 0;

  constructor(
    private readonly window: number,
    private readonly epsilon: number,
  ) {}

  move(me: Vec, dx: number, dy: number): { moveBrad: Brad; moveMag: number } {
    if (Math.hypot(me.x - this.anchor.x, me.y - this.anchor.y) >= this.epsilon) {
      this.anchor = { x: me.x, y: me.y };
      this.still = 0;
    } else if (++this.still >= this.window) {
      this.sign = -this.sign;
      this.still = 0;
    }
    return quantizeMove(-dy * this.sign, dx * this.sign);
  }
}
