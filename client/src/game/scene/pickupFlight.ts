// Collection flight — the arc a collected drop flies along on its way to whoever picked it
// up (design/10 feedback legibility). Split out of `Scene.ts` per CLAUDE.md's form ②: its own
// class over a typed pair of containers, with no state shared with the view mirror — `Scene`
// launches a flight and never looks at it again, and nothing here reads `GameState`.
//
// Why the effect exists at all: `PickupSystem` collects on overlap and compacts the item out
// of `state.pickups` the same tick, so the drop's view simply STOPPED EXISTING on the next
// reconcile. What that costs is not prettiness — it is the answer to "did that go to me?",
// which in co-op/PvP is a real question (two players standing on one drop) and which the
// `fx.flash()` left behind at the drop's own position cannot answer, because it is drawn at
// the loot, not at the collector. The arc IS the answer: it ends on a body.
//
// Everything here is render-only and reads no engine state: the sim has already applied the
// pickup by the time a flight starts, so the arc is pure after-the-fact feedback and may be
// dropped, shortened or interrupted (see `PickupFlightLayer.clear`) without consequence.
import type { Container } from 'pixi.js';
import type { Entity } from './Entity';

/** How long a drop takes to reach the collector. 600 ms is slow enough that the curve reads as
 *  a path rather than a jump cut, and short enough that a chest paying six items at once has
 *  cleared the screen before the player has walked out of the room. */
export const FLIGHT_MS = 600;

/** How far the collector may move between two render frames before the flight gives up on them
 *  (world px). Re-asking the target every frame is what makes a flight follow a running player;
 *  it is also what would drag a drop across the whole floor when the player does not RUN there
 *  but is TELEPORTED — and the sim can do exactly that in the same tick it collects, twice over:
 *  `PickupSystem` is step 10, `DoorSystem`'s force-regroup is 11.5 and `ExtractionSystem`'s
 *  descend is 12 (`GameEngine.step`). Taking a heal on the tick you tap DESCEND is an ordinary
 *  thing to do, and the drop would then streak from the old floor's geometry to the new floor's
 *  spawn point.
 *
 *  120 px cannot be reached honestly: `PLAYER_BASE.speedPerTick` is 6.4 px/tick (192 px/s), so a
 *  legitimate 120 px step would need a 625 ms render frame — and during a stall that long nobody
 *  is watching a 600 ms arc anyway. A flight that trips this is FINISHED, not re-anchored: the
 *  item is already collected, and the player is somewhere else with no arc that could honestly
 *  connect the two points. */
const TARGET_TELEPORT_PX = 120;

/** Ceiling on simultaneous flights. A big chest pays a handful at once and a PvP scramble can
 *  stack a few more on top, so this is generous — it exists to bound a pathological frame
 *  (a room-clear payout landing on one tick), not to shape the normal case. The OLDEST flight
 *  is the one dropped when it binds: it is the closest to arriving, so cutting it short is the
 *  least visible cut available. */
const MAX_FLIGHTS = 32;

/** A world point in the renderer's three coordinates: ground (x, y) plus height above it.
 *  `Entity.place` takes exactly these, and the Y-sort reads `y` — which is why the height is
 *  carried separately rather than folded into a screen y (a drop flying at chest height must
 *  still sort by the ground point it is over, same rule `Entity.applyTransform` documents). */
export interface FlightPoint {
  x: number;
  y: number;
  z: number;
}

/** Where the flight is heading, re-asked EVERY frame rather than captured at launch: the
 *  collector keeps running while their loot is in the air, and a drop that curves toward where
 *  they used to be reads as a miss. `null` means the view is gone (the collector died, or the
 *  run/floor was torn down mid-flight) — the flight then finishes against the last point it
 *  resolved instead of snapping to the origin. */
export type FlightTarget = () => FlightPoint | null;

/** The drawn pose at one instant of a flight — position plus the three container properties
 *  that sell it (see `flightPose`). Returned as a value object so the whole curve is a pure
 *  function that a test can sample without a renderer. */
export interface FlightPose extends FlightPoint {
  scale: number;
  alpha: number;
  rotation: number;
}

/** How far the drop first pops AWAY from the collector, as a fraction of the distance to them,
 *  floored and capped in px. The pop is what makes the arc read as an object being thrown
 *  rather than slid: it puts the eye on the item before the item moves, and it is the reason
 *  the curve needs no ease on its time parameter — the control point alone makes the first
 *  third slow and the last third fast.
 *
 *  The FLOOR is the load-bearing half, and it is there because of a number outside this file:
 *  everything but a weapon is auto-collected on overlap (`SIM.pickupRadius`, 15 px of padding
 *  past the player's own ~16 px body), so the typical flight is barely 30 px long. Sized purely
 *  as a fraction of that, the arc collapses to a few px and 600 ms of it reads as a drop
 *  sliding in slow motion. Floored, the same 600 ms reads as the item swinging up and out of
 *  the floor and curling into the body — the motion carries the duration instead of the
 *  distance having to. A weapon click from across the reveal ring (80 px) is the case the
 *  FRACTION is for. */
const POP_BACK_R = 0.25;
const POP_BACK_MIN = 8;
const POP_BACK_MAX = 18;
/** Sideways bow of the curve, same floor/fraction/cap shape and the same reason for each.
 *
 *  **It is applied to the ground perpendicular's X COMPONENT ONLY, and that is the whole
 *  geometry of this file.** The renderer's projection is the shear (x, y, z) → (x, y − z)
 *  (`Entity.applyTransform`), so a bow in ground Y and a rise in Z are THE SAME SCREEN AXIS,
 *  pointing opposite ways. Bowing the full perpendicular therefore cancels the hop below on any
 *  east–west flight — measured on a live 28 px pickup before this was split out, the drawn path
 *  deviated from a straight screen line by 0.5 px, i.e. the "curve" was a slide. Bowing only in
 *  X leaves the two free of each other: an east–west flight curves purely as a thrown arc (the
 *  bow is 0 there), a north–south one swings sideways as well, and neither can flatten the
 *  other. `pickupFlight.test.ts` asserts this in SCREEN space for both directions, because the
 *  ground plane is not where the player is looking. */
const BULGE_R = 0.45;
const BULGE_MIN = 16;
const BULGE_MAX = 34;
/** How much of that bow is still there at the collector's end, so the drop arrives on a curve
 *  instead of straightening out into the last few px. */
const SWING_IN = 0.35;

/** The hop: extra height, over and above the interpolation from the drop's hover to the
 *  collector's chest. Sized partly off the distance travelled so a drop collected from across
 *  the room arcs more than one taken underfoot.
 *
 *  This is the half of the arc that carries an EAST–WEST flight (see `BULGE_R`), which is why
 *  the base is large enough to be worth seeing on its own: the 28 px auto-collect flight bows
 *  by nothing at all in that direction, and a hop that only cleared the drop's own hover height
 *  would leave it a straight diagonal slide into the body. It still ends well under the
 *  collector's chest height, so the drop never arcs over their head. */
const HOP_BASE = 14;
const HOP_R = 0.08;
const HOP_MAX = 28;
/** Where the hop peaks, as an exponent on the time parameter: `t ** HOP_SKEW` reaches 0.5 at
 *  t = 0.5 ** (1 / HOP_SKEW), i.e. ~0.31 here. Early on purpose — the drop should be at the
 *  top of its arc while it is still near where it lay, and spend the rest of the flight
 *  diving in. A symmetric hop (skew 1) reads as a lob, which is a different, lazier motion. */
const HOP_SKEW = 0.7;

/** Scale: a small swell on the pop (the item "notices" it has been taken), then down to
 *  `1 - SHRINK` as it reaches the body, which is what sells the drop entering the character
 *  rather than landing on top of them. */
const POP_SCALE = 0.25;
const SHRINK = 0.5;
/** The last stretch of the flight fades out, so the drop dissolves into the collector instead
 *  of popping out of existence one frame short of them. Deliberately late: fading from the
 *  start would hide the curve this whole file exists to draw. */
const FADE_FROM = 0.78;
/** Peak tilt (radians) at mid-flight, returning to 0 on arrival — a wobble, not a tumble. A
 *  full spin would turn a weapon drop's element badge and rarity pips (`Pickup`'s two design/13
 *  channels) upside down, which is the one thing on a drop that must stay readable. */
const SPIN = 0.5;

/**
 * The drawn pose `t` of the way through a flight from `from` to `to` — the whole curve, as one
 * pure function of the two endpoints.
 *
 * Ground path: a cubic Bézier whose first control point sits BEHIND the drop (away from the
 * collector) and bowed to one side, and whose second sits beside the collector. `t` is fed in
 * raw, with no easing: the control-point spacing is the speed curve, and adding an ease on top
 * of it is how a "pop then swoop" turns into two fights over the same 600 ms.
 *
 * `sign` (+1/-1) flips which side the bow is on. `Scene` derives it from the drop's engine id,
 * for the reason `Pickup`'s own `GOLDEN_ANGLE` phase spread exists: a chest paying six items at
 * once must not send six identical arcs, and this render layer draws no random numbers.
 *
 * Degenerate case: a drop collected from exactly underfoot has no direction to bow around, so
 * the bézier collapses to its endpoints and only the hop/scale/fade curves do anything —
 * which is the right answer, not a special case (there is no arc to draw across zero px).
 */
export function flightPose(t: number, from: FlightPoint, to: FlightPoint, sign: number): FlightPose {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  // Unit vector toward the collector, and its perpendicular. Both zero for a zero-length
  // flight, which zeroes every offset below without branching on it twice.
  const ux = dist > 0 ? dx / dist : 0;
  const uy = dist > 0 ? dy / dist : 0;
  // Both floors are gated on `dist > 0`: a drop taken from exactly underfoot has no direction
  // to pop back along or bow around, so the floor would only add jitter in an arbitrary one.
  const back = dist > 0 ? Math.min(POP_BACK_MAX, Math.max(POP_BACK_MIN, dist * POP_BACK_R)) : 0;
  const bulge = (dist > 0 ? Math.min(BULGE_MAX, Math.max(BULGE_MIN, dist * BULGE_R)) : 0) * sign;
  // The ground perpendicular is (-uy, ux); only its X component is used — see `BULGE_R` for
  // why bowing in ground Y would fight the hop instead of adding to it.
  const bowX = -uy * bulge;
  const p1x = from.x - ux * back + bowX;
  const p1y = from.y - uy * back;
  const p2x = to.x + bowX * SWING_IN;
  const p2y = to.y;
  const s = 1 - t;
  const b0 = s * s * s;
  const b1 = 3 * s * s * t;
  const b2 = 3 * s * t * t;
  const b3 = t * t * t;
  const hop = Math.min(HOP_MAX, HOP_BASE + dist * HOP_R) * Math.sin(Math.PI * t ** HOP_SKEW);
  return {
    x: b0 * from.x + b1 * p1x + b2 * p2x + b3 * to.x,
    y: b0 * from.y + b1 * p1y + b2 * p2y + b3 * to.y,
    // Height interpolates on t² rather than t: the drop hangs near its hover height through
    // the pop and only climbs into the body at the end, so the hop above stays the shape of
    // the arc instead of being added to a ramp already halfway up.
    z: from.z + (to.z - from.z) * t * t + hop,
    scale: 1 + POP_SCALE * Math.sin(Math.PI * t ** HOP_SKEW) - SHRINK * t * t,
    alpha: t < FADE_FROM ? 1 : Math.max(0, (1 - t) / (1 - FADE_FROM)),
    rotation: SPIN * Math.sin(Math.PI * t) * sign,
  };
}

interface Flight {
  view: Entity;
  from: FlightPoint;
  /** A COPY of the last point `target` resolved to — see `FlightTarget` for why a flight keeps
   *  flying at a remembered point rather than ending the instant its collector's view
   *  disappears. Copied rather than held by reference because a resolver is free to hand back a
   *  live object it keeps mutating, and then "the last point I saw" would silently be "the
   *  current point", which is also the reading that makes the teleport guard below a no-op.
   *
   *  `null` until the first `update`, never after: at LAUNCH time the collector's view may not
   *  have been drawn yet (`Scene.spawn` pushes state and snaps, but only `interpolate` writes
   *  the transform), so a view created on the same reconcile still reads (0, 0) — and resolving
   *  then would hand the teleport guard a jump it must not act on. */
  to: FlightPoint | null;
  target: FlightTarget;
  sign: number;
  elapsed: number;
}

/**
 * Every drop currently in the air. Owned by `Scene` (which mounts it into the same two
 * containers every other view uses) and stepped from `Scene.interpolate`, so a flight animates
 * at RENDER rate and keeps moving through a pause — the same rule `GameLoop` already applies to
 * fx on a frozen frame, and the reason a flight carries no sim tick of its own.
 *
 * A flown view is deliberately NOT in `Scene.views`: it is no longer mirroring an engine entity
 * (there is no entity left to mirror), so it must not be reconciled, interpolated, or offered to
 * the occlusion x-ray as a focus. Same separation, for the same reason, as `Scene.dying`.
 */
export class PickupFlightLayer {
  private readonly flights: Flight[] = [];

  constructor(
    private readonly entities: Container,
    private readonly shadows: Container,
  ) {}

  /** How many drops are in the air — the count `Scene`'s own tests assert against, and the
   *  only thing this layer reports about itself. */
  get count(): number {
    return this.flights.length;
  }

  /**
   * Send `view` from `from` to whatever `target` resolves to, over `FLIGHT_MS`. The layer takes
   * ownership: the view is mounted here, driven here, and destroyed here when it arrives.
   *
   * The view is placed at `from` immediately rather than at the first `update`, so a flight
   * launched on a frame that renders before the next step never flashes at the origin.
   */
  launch(view: Entity, from: FlightPoint, target: FlightTarget, sign: number): void {
    if (this.flights.length >= MAX_FLIGHTS) this.finish(0);
    this.entities.addChild(view);
    if (view.shadow) this.shadows.addChild(view.shadow);
    view.place(from.x, from.y, from.z);
    this.flights.push({ view, from, to: null, target, sign, elapsed: 0 });
  }

  /** Advance every flight by one RENDER frame (`dtMs` real ms, not a sim tick). */
  update(dtMs: number): void {
    for (let i = this.flights.length - 1; i >= 0; i--) {
      const f = this.flights[i]!;
      f.elapsed += dtMs;
      if (f.elapsed >= FLIGHT_MS) {
        this.finish(i);
        continue;
      }
      const next = f.target();
      if (next && f.to && Math.hypot(next.x - f.to.x, next.y - f.to.y) > TARGET_TELEPORT_PX) {
        this.finish(i); // the collector was teleported out from under it — see TARGET_TELEPORT_PX
        continue;
      }
      if (next) f.to = { x: next.x, y: next.y, z: next.z };
      // No target has ever resolved (the collector's view was gone before the first frame): the
      // drop flies its own arc in place and still lifts, fades and goes, which is the one honest
      // thing left to draw — there is nothing to aim at.
      const pose = flightPose(f.elapsed / FLIGHT_MS, f.from, f.to ?? f.from, f.sign);
      f.view.place(pose.x, pose.y, pose.z);
      f.view.scale.set(pose.scale);
      f.view.alpha = pose.alpha;
      f.view.rotation = pose.rotation;
      // `place()` above rewrote the shadow's own alpha from the height falloff, so the fade has
      // to be folded in after it — otherwise a drop dissolving into the collector leaves its
      // shadow at full strength for the last 130 ms, sliding under them on its own.
      if (f.view.shadow) f.view.shadow.alpha *= pose.alpha;
    }
  }

  /** Drop every flight mid-air — a new run, a floor change, anything that tears the scene down
   *  (`Scene.clear`). Nothing is left to arrive at, so nothing is finished gracefully. */
  clear(): void {
    for (const f of this.flights) f.view.destroy();
    this.flights.length = 0;
  }

  private finish(i: number): void {
    this.flights[i]!.view.destroy(); // takes its shadow with it (`Entity.destroy`)
    this.flights.splice(i, 1);
  }
}
