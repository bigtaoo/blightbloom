/**
 * Local-player prediction (ROADMAP 3.3 follow-up, design/06 "client-side prediction of the
 * local player only"). A pure RENDER-LAYER latency-hiding layer: it draws the local seat's
 * own sprite/camera ahead of the confirmed frame stream so twin-stick movement responds
 * instantly under network latency. It NEVER touches the deterministic sim — the confirmed
 * path stays byte-identical (design/06 "slots on top without changing the confirmed path"),
 * so there is zero desync risk. Scope is the local player's MOVEMENT only; firing stays
 * sim-confirmed (bullets are sim entities — predicting them would need sim rollback, the
 * costly path design/06 rejects for casual/WeChat). Weapon-facing is NOT predicted either
 * (design/10 v33): it's no longer player input at all — the engine auto-faces the nearest
 * hostile, else the movement direction (ApplyInputSystem) — so predicting it here would mean
 * re-deriving that same target-lock client-side, just to get it wrong the instant it
 * disagreed with the confirmed engine. Game.ts reads it straight off confirmed state.
 *
 * Model (rewritten 2026-10-01): the drawn position is the CONFIRMED position plus the local
 * input the confirmed stream has not caught up with yet. Each render frame dead-reckons the
 * live input (at the sim's own speed, against the same static solids) and keeps that step in
 * a short trail; `settle` then eases toward `confirmed + the trail's last <delay> ms`, the
 * delay being what `net/inputDelay.ts` measured. Steady motion therefore has nothing to
 * correct, and a stop has nothing to slide onto. The model before it eased toward the bare
 * confirmed position, which while moving decays the lead to zero — the local player carried
 * the full latency once running, and slid on by all of it after letting go.
 *
 * What remains is the server's batching: it lands each command on the last frame of a 100 ms
 * window, so the real run is up to one window longer or shorter than the stick was held, and
 * the drawn position eases over that difference after a stop. A large gap (a teleport, a room
 * transition, a real desync) snaps instead. Working in float px is fine here — this is the
 * render layer, downstream of `fromFp`, and its output never re-enters the sim.
 */
import { blockingRadius, clampToWalkable, pxToFp, type GameState, type PlayerActor } from '@dd/engine';
import { bradToRad, fpToPx } from '../coords';

export interface PredictorConfig {
  /** Local player top speed in px/sec — MUST match the sim (fpToPx(speedPerTick) × simHz). */
  speedPxPerSec: number;
  /** Drawn-vs-target error (px) above which we snap instead of easing. */
  snapPx: number;
  /** Fraction (0..1) of the error closed per sim tick (`TICK_MS`) when it is below `snapPx`. */
  correctionGain: number;
}

export interface Pose {
  x: number;
  y: number;
  // Radians — predicted movement direction, held while idle. NOTE: since 2026-08-18 this
  // no longer drives the rendered body facing (the orb-core turns toward its AIM instead,
  // see render/facing.ts); `Scene.positionLocal` ignores it and only takes the position.
  // Kept because it is a correct, tested output of the dead-reckoner.
  bodyFacing: number;
  /** Was this frame's predicted movement nonzero? `Scene.positionLocal`'s snap collapses
   *  the interpolation buffer every frame, so the render layer can't derive idle/move
   *  from position deltas the way it does for every confirmed (non-predicted) entity —
   *  this is that signal, straight from the same input `predict()` already reads. */
  moving: boolean;
}

/** Where a body centred at (x, y) px would be pushed to by the static solids. */
export type Walkable = (x: number, y: number) => { x: number; y: number };

const FREE: Walkable = (x, y) => ({ x, y });

/** The sim's own wall response for `player` (`geom.clampToWalkable`, the radius Movement
 *  uses), in px. Static solids only: other bodies push too, and that part is left to `settle`. */
export function walkableFor(state: GameState, player: PlayerActor): Walkable {
  const r = blockingRadius(player);
  return (x, y) => {
    const gx = pxToFp(x);
    const gy = pxToFp(y);
    const at = clampToWalkable(gx, gy, r, state);
    // Untouched: hand back the float input, not its fp rounding (1 fp = 0.032 px).
    return at.gx === gx && at.gy === gy ? { x, y } : { x: fpToPx(at.gx), y: fpToPx(at.gy) };
  };
}

export const DEFAULT_PREDICTOR: Omit<PredictorConfig, 'speedPxPerSec'> = {
  snapPx: 48, // ~1.5 grid — a real desync / teleport, not normal RTT drift
  correctionGain: 0.25, // gentle ease; converges in a handful of confirmed frames
};

const MOVE_MAG_MAX = 255; // PlayerCommand.moveMag range (state/commands.ts)
/** The sim tick `correctionGain` is stated per — the engine's 30 Hz (design/06). */
const TICK_MS = 1000 / 30;
/** Trail kept. Past a second a delay reading is a stall, not latency. */
const MAX_LEAD_MS = 1000;
/** The lead is walked toward the walls in steps no longer than this (px), the way the sim
 *  moves in 6.4 px ticks — one long push could come out on the far side of a thin wall. */
const LEAD_STEP_PX = 8;

interface Step {
  /** Render clock at the end of the step. */
  t: number;
  dt: number;
  dx: number;
  dy: number;
}

export class LocalPredictor {
  private x = 0;
  private y = 0;
  private bodyFacing = 0;
  private moving = false;
  private active = false;
  /** The last two confirmed positions — the drawn base interpolates between them. */
  private px = 0;
  private py = 0;
  private cx = 0;
  private cy = 0;
  private clock = 0;
  private readonly trail: Step[] = [];

  constructor(private readonly cfg: PredictorConfig) {}

  get isActive(): boolean {
    return this.active;
  }
  get pose(): Pose {
    return { x: this.x, y: this.y, bodyFacing: this.bodyFacing, moving: this.moving };
  }

  /** Anchor prediction to a known confirmed pose (px/radians): match start, first frame,
   *  or any deliberate snap. Activates prediction. `bodyFacing` seeds from the confirmed
   *  facing (no distinct movement direction known yet, matching Scene.ts's own fresh-spawn
   *  default). */
  reset(x: number, y: number, bodyFacing: number): void {
    this.x = this.px = this.cx = x;
    this.y = this.py = this.cy = y;
    this.bodyFacing = bodyFacing;
    this.moving = false;
    this.active = true;
    this.trail.length = 0;
  }

  /** Suspend prediction (local player downed/dead) — the caller falls back to confirmed. */
  deactivate(): void {
    this.active = false;
  }

  /**
   * Dead-reckon one render frame from the live local command: the sim's per-second speed
   * scaled by move magnitude, pushed out of the solids the way Movement would. bodyFacing
   * follows the move direction while moving and holds while idle, mirroring Scene.ts's own
   * "no snap-to-zero" rule for the confirmed path. The step joins the trail `settle` reads.
   */
  predict(moveBrad: number, moveMag: number, dtMs: number, walkable: Walkable = FREE): void {
    if (!this.active) return;
    this.clock += dtMs;
    const mag = Math.max(0, Math.min(MOVE_MAG_MAX, moveMag)) / MOVE_MAG_MAX;
    const v = this.cfg.speedPxPerSec * mag * (dtMs / 1000);
    this.moving = v > 0;
    let dx = 0;
    let dy = 0;
    if (v > 0) {
      const dir = bradToRad(moveBrad);
      dx = Math.cos(dir) * v;
      dy = Math.sin(dir) * v;
      const to = walkable(this.x + dx, this.y + dy);
      this.x = to.x;
      this.y = to.y;
      this.bodyFacing = dir;
    }
    this.trail.push({ t: this.clock, dt: dtMs, dx, dy });
    while (this.trail.length > 0 && this.trail[0]!.t <= this.clock - MAX_LEAD_MS) this.trail.shift();
  }

  /** Hand over a newly confirmed position. Call ONCE per newly-confirmed frame (never on a
   *  stall); `settle` does the rest. */
  reconcile(confirmedX: number, confirmedY: number): void {
    if (!this.active) return;
    this.px = this.cx;
    this.py = this.cy;
    this.cx = confirmedX;
    this.cy = confirmedY;
  }

  /**
   * Ease the drawn position toward where the sim will have it once the input in flight lands:
   * the confirmed position at the playout's `alpha`, plus the trail's last `delayMs + one tick`.
   * The tick is the interpolation's own: a frame stepped `delayMs` after its input is drawn
   * fully only one tick later. `delayMs` null (no change has made the round trip yet) leads by
   * nothing, i.e. eases onto the confirmed position.
   */
  settle(alpha: number, delayMs: number | null, dtMs: number, walkable: Walkable = FREE): void {
    if (!this.active) return;
    // A confirmed jump is a teleport: interpolating across it would draw the gap between rooms.
    const a = Math.hypot(this.cx - this.px, this.cy - this.py) > this.cfg.snapPx ? 1 : Math.max(0, Math.min(1, alpha));
    let tx = this.px + (this.cx - this.px) * a;
    let ty = this.py + (this.cy - this.py) * a;
    const [lx, ly] = this.lead(delayMs === null ? 0 : delayMs + TICK_MS);
    const n = Math.ceil(Math.hypot(lx, ly) / LEAD_STEP_PX);
    for (let i = 0; i < n; i++) ({ x: tx, y: ty } = walkable(tx + lx / n, ty + ly / n));
    const ex = tx - this.x;
    const ey = ty - this.y;
    if (Math.hypot(ex, ey) > this.cfg.snapPx) {
      this.x = tx;
      this.y = ty;
      return;
    }
    const k = 1 - Math.pow(1 - this.cfg.correctionGain, dtMs / TICK_MS);
    this.x += ex * k;
    this.y += ey * k;
  }

  /** The trail's displacement over its last `ms`, a partly covered step pro rata. */
  private lead(ms: number): [number, number] {
    const from = this.clock - ms;
    let x = 0;
    let y = 0;
    for (let i = this.trail.length - 1; i >= 0; i--) {
      const s = this.trail[i]!;
      if (s.t <= from) break;
      const f = s.dt > 0 ? Math.min(1, (s.t - from) / s.dt) : 1;
      x += s.dx * f;
      y += s.dy * f;
    }
    return [x, y];
  }
}
