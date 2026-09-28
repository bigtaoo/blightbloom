// New 2026-09-03 (CLAUDE.md form 1 — an independent module beside `doorRender.ts`/`doorLights.ts`,
// which is also what kept doorRender.ts under the 500-line convention): everything about a door
// that MOVES. `doorLights.ts` holds the still layers, each drawn once at build time and thereafter
// only toggled by `.visible`; this file holds the clock and the layers that read it.
//
// **WHY.** Three passes (2026-08-30 through/spill/rim, 2026-08-30b the illustrated curtain,
// 2026-09-03 one door height) each added more STILL layers to a fixture the player still read as
// flat — *"目前的形式太死板了"*. The diagnosis that ended that run was not that the cue was weak: a
// door had no per-frame path reaching it at all. `Scene.interpolate` walks `Scene.views`, and a
// door is a fixture `RoomBuilder` adds straight to `layers.entities`, so nothing was ever going to
// animate one. (The same gap had quietly frozen `Portal` — its whole `interpolate` body, four
// animated layers, had no caller. `RoomBuilder.tickFixtures` now drives both.)
//
// **WHAT THE CLOCK BUYS, AND WHY IT IS SPENT ON DIRECTION.** A still image can only say a thing
// with COLOUR and SHAPE, and both were already spent — the two states share one pool shape and
// differ by hue (`doorLights.GLOW_POOL`). Motion adds three more channels, and this file assigns
// them deliberately rather than just making everything wobble:
//
//   direction — the whole read. A LOCKED door's motion is CONTAINED: flame scrolls upward inside
//               the leaf, a scan bar ping-pongs side to side between the jambs, and its floor
//               pulse travels INWARD. Nothing crosses the threshold. An OPEN door's motion CROSSES
//               it: light streams down and out of the passage, motes drift out onto the floor
//               toward the player, and its floor pulse travels OUTWARD. "Can I walk through this"
//               is answered by which way things are moving, at any size, before colour is read.
//   rhythm    — locked is fast and restless (1.7 s / 2.75 s beating against each other, an
//               irrational-ish ratio so they never realign); open is one slow 2.4 s breath that
//               the curtain, the spill pool and the ramp all share, so they read as ONE lit
//               passage rather than three stacked decals.
//   reaction  — the channel a still door could not have at all: `near` brightens a door as the
//               player approaches, and `reject()` flashes it when they walk into a locked one.
//
// **NO NEW ART, AND WHY THAT WAS THE CHEAPER ANSWER.** The obvious way to animate fire is a frame
// sequence, and the obvious way to get one here is to ask an image model for N frames — which is
// exactly what this project has already found does not work (`design/12`: GPT Image 2 "emits one
// flattened raster", the reason the portal is "a split, not a sprite… the file is the half of the
// object that never moves"). So the motion is generated, not prompted: two seamless fields baked
// by `shadeRamp.bakedField` (zero bytes against design/04's package budget, POT + mipmappable,
// readable back by a test) scrolled under the shipped stills. The stills keep supplying the
// MATERIAL, which is what an image model is actually good at.
import { Container, Graphics, Sprite, TilingSprite } from 'pixi.js';
import { activeQuality } from '../../render/quality';
import { redrawnGraphics } from '../../render/staticGraphics';
import {
  GLOW_COLOR,
  ringTravel,
  strokeFloorArc,
  THROUGH_COLOR,
  thresholdPlane,
  type DoorFloorPlane,
} from './doorLights';
import {
  bakeField,
  bakeScanBar,
  breathe,
  FIELD_H,
  flameBandRect,
  MOTE_COUNT,
  motePose,
  OPEN_HOLE,
  PERIODS_MS,
  PHI_FRAC,
  pingPong,
  sawtooth,
  type BandRect,
} from './doorMotion';
import { XRAY_DEEP_LABEL, type FadeLayer } from './occlusion';

// Re-exported so the module boundary is invisible to callers and tests that already reach for
// these through `doorFx` — CLAUDE.md's thin-re-export rule for a file-length split.
export { breathe, flameBandRect, motePose, PERIODS_MS, pingPong, sawtooth, type BandRect };


const FLAME_A_PERIOD_MS = PERIODS_MS.flameA;
const FLAME_B_PERIOD_MS = PERIODS_MS.flameB;
const SCAN_PERIOD_MS = PERIODS_MS.scan;
const LOCKED_BREATHE_MS = PERIODS_MS.lockedBreathe;
const STREAM_A_PERIOD_MS = PERIODS_MS.streamA;
const STREAM_B_PERIOD_MS = PERIODS_MS.streamB;
const OPEN_BREATHE_MS = PERIODS_MS.openBreathe;
const PULSE_PERIOD_MS = PERIODS_MS.pulse;

/** How long a lock-state change takes to play. A door used to flip six layers' `.visible` in one
 *  frame — at the single most meaningful moment in a room (the last enemy dies and the way out
 *  opens), which is the worst possible place for an instant cut. Long enough to read as an event,
 *  short enough that a player already walking at the door is not held up by it. */
const TRANSITION_MS = 350;
/** The bounce-off flash when a player walks into a locked door (`reject()`). Shorter than the
 *  transition on purpose: this is an impact, not an event. */
const REJECT_MS = 260;

/** Base alphas of the animated layers. Kept at or below 0.8 so the proximity ramp below has room
 *  to push a door the player is standing at up to full without clipping. */
const FLAME_A_ALPHA = 0.5;
const FLAME_B_ALPHA = 0.3;
const SCAN_ALPHA = 0.3;
const STREAM_A_ALPHA = 0.34;
const STREAM_B_ALPHA = 0.2;
const MOTE_ALPHA = 0.7;
const PULSE_ALPHA = 0.3;
const REJECT_FLASH_ALPHA = 0.5;

/** The proximity ramp: a lit layer's alpha multiplier from `near` = 0 (across the room) to 1
 *  (standing in the doorway). Deliberately narrow — this is meant to be felt as the door noticing
 *  you, not seen as a light switch. Clamped to 1 after the multiply. */
const NEAR_MIN = 0.8;
const NEAR_SPAN = 0.3;

/** Additive tints. The flame pair sits over the shipped hazard leaf, which is already orange-red,
 *  so the overlay is what the FIRE is doing rather than a second colour: a hot core tone and a
 *  paler tip tone. The open state's layers all take `THROUGH_COLOR`, the warm white every other
 *  open-door light in `doorLights.ts` already uses. */
const FLAME_A_TINT = 0xff9a40;
const FLAME_B_TINT = 0xffd070;
const SCAN_TINT = 0xffc9a0;

/** How wide the scan bar is, as a fraction of the band it sweeps. */
const SCAN_BAR_W = 0.24;

/**
 * How much of the flame band the SECOND flame layer covers, measured up from the band's floor.
 *
 * This is where "fire is densest low" lives. It used to be a vertical bias baked into the field
 * itself, which was wrong twice over: it is not periodic in y, so it put a seam in a field whose
 * whole job is to wrap (`doorMotion.bakeField`), and it is a screen-space property, so baked in it
 * would have travelled with the scroll instead of staying at the base of the doorway. Stacking the
 * two layers instead pins the dense end where the fire actually is and leaves the bake wrappable.
 */
const FLAME_B_OF_BAND = 0.62;

/** One layer this controller owns the alpha of: its own base intensity, and whether the proximity
 *  ramp reaches it (the lit layers) or not (the base recess/floor, which must not brighten when a
 *  player walks up — it is what makes the opening a hole). */
interface FxLayer {
  node: Container;
  base: number;
  lit: boolean;
}

/** What `buildDoorBlock` hands over: the outgoing-leaf sprite a crossfade needs, and the still
 *  layers of each state, split by whether the proximity ramp reaches them. This controller owns
 *  every one of their `alpha`/`visible` from here on — `buildDoorBlock` sets none of them. */
export interface DoorFxParts {
  leafGhost: Sprite;
  lockedBase: Container[];
  lockedLit: Container[];
  openBase: Container[];
  openLit: Container[];
}

/**
 * One door's motion. Built by `buildDoorBlock`, stepped by `RoomBuilder.tickFixtures`.
 *
 * `behind` mounts where `drawThroughLight` does — under the leaf, so the arch art's own stone
 * masks it and the light shows through the transparent middle and nowhere else. `over` mounts
 * above every other opening layer, because the flame overlay has to reach an opaque leaf and
 * because a mote crossing the threshold has to draw over the floor pool it is lit by.
 */
export class DoorFx {
  readonly behind = new Container();
  readonly over = new Container();

  /**
   * The occlusion x-ray's fade for everything this controller owns, as the single `FadeLayer` the
   * fixture hands to `occlusion.fadeableBlock` in place of those layers.
   *
   * **Why a proxy and not the layers themselves.** `occlusion.fadeGroup` captures each layer's
   * alpha ONCE and thereafter writes `base * fade`; this class rewrites those same alphas every
   * frame. Two writers, and the fx pass runs AFTER the x-ray in `GameLoop.updateFx`, so this class
   * would win — silently disabling the fade on a door's own layers, one of which
   * (`buildOpenFloorTile`'s tile) is fully opaque and would then hide the character standing in the
   * doorway. That is the exact defect the x-ray exists to prevent. So the x-ray fades this object,
   * and `apply` folds its value into every alpha it writes: one writer per property, both effects
   * intact.
   */
  readonly xrayLayer: FadeLayer = { alpha: 1, label: XRAY_DEEP_LABEL };

  private t: number;
  private locked: boolean;
  /** Counts down through a lock-state change; 0 when settled. */
  private transMs = 0;
  private rejectMs = 0;
  /** The one-shot ring a lock-state change throws off, counting down over `TRANSITION_MS`. */
  private burstMs = 0;
  private near = 0;

  private readonly lockedLayers: FxLayer[] = [];
  private readonly openLayers: FxLayer[] = [];
  private readonly leafGhost: Sprite;
  private readonly flameA: TilingSprite | null = null;
  private readonly flameB: TilingSprite | null = null;
  private readonly scan: Sprite | null = null;
  private readonly rejectFlash: Graphics | null = null;
  private readonly streamA: TilingSprite;
  private readonly streamB: TilingSprite;
  // Redrawn every frame they are showing, so never batched: a batched one would rebuild the whole
  // enclosing render group each time (`redrawnGraphics`).
  private readonly motes = redrawnGraphics();
  private readonly pulse = redrawnGraphics();
  private readonly burst = redrawnGraphics();

  constructor(
    private readonly openingW: number,
    private readonly openingH: number,
    private readonly band: BandRect,
    parts: DoorFxParts,
    index: number,
    locked: boolean,
    /** Where this door's two floor rings lie — see `doorLights.DoorFloorPlane`. Defaults to the
     *  threshold, i.e. a door in an east-west wall, which is what a fixture built with no passage
     *  rect to hand (the unit tests) means. */
    private readonly plane: DoorFloorPlane = thresholdPlane(openingW, openingH),
  ) {
    this.locked = locked;
    this.leafGhost = parts.leafGhost;
    // Start phase spread by index, so two doors in one room never breathe together.
    this.t = index * PHI_FRAC * OPEN_BREATHE_MS;

    // --- the open state's own motion, behind the leaf (the arch's stone is the mask) ---
    this.streamA = this.buildField('stream', 3, openingW, openingH, STREAM_A_ALPHA, THROUGH_COLOR, 1);
    this.streamB = this.buildField('stream', 3, openingW, openingH, STREAM_B_ALPHA, THROUGH_COLOR, -0.7);
    this.behind.addChild(this.streamA, this.streamB);

    // --- the locked state's own motion, over the leaf, inside the measured fire band ---
    if (band.h > 0) {
      const bH = band.h * FLAME_B_OF_BAND;
      this.flameA = this.buildField('flame', 4, band.w, band.h, FLAME_A_ALPHA, FLAME_A_TINT, 1);
      this.flameB = this.buildField('flame', 4, band.w, bH, FLAME_B_ALPHA, FLAME_B_TINT, -0.62);
      this.flameA.position.set(band.x, band.y);
      this.flameB.position.set(band.x, band.y + band.h - bH); // bottom-anchored: the dense end

      const scan = new Sprite(bakeScanBar());
      scan.width = Math.max(2, band.w * SCAN_BAR_W);
      scan.height = band.h;
      scan.position.set(band.x, band.y);
      scan.blendMode = 'add';
      scan.tint = SCAN_TINT;
      this.scan = scan;

      const flash = new Graphics();
      flash.rect(band.x, band.y, band.w, band.h).fill({ color: 0xffffff });
      flash.blendMode = 'add';
      flash.tint = GLOW_COLOR;
      flash.alpha = 0;
      this.rejectFlash = flash;

      this.over.addChild(this.flameA, this.flameB, scan, flash);
    }

    for (const g of [this.motes, this.pulse, this.burst]) g.blendMode = 'add';
    this.over.addChild(this.pulse, this.motes, this.burst);

    const push = (into: FxLayer[], nodes: Container[], lit: boolean): void => {
      for (const node of nodes) into.push({ node, base: node.alpha, lit });
    };
    push(this.lockedLayers, parts.lockedBase, false);
    push(this.lockedLayers, parts.lockedLit, true);
    push(this.openLayers, parts.openBase, false);
    push(this.openLayers, parts.openLit, true);
    if (this.flameA) this.lockedLayers.push({ node: this.flameA, base: FLAME_A_ALPHA, lit: true });
    if (this.flameB) this.lockedLayers.push({ node: this.flameB, base: FLAME_B_ALPHA, lit: true });
    if (this.scan) this.lockedLayers.push({ node: this.scan, base: SCAN_ALPHA, lit: true });
    this.openLayers.push({ node: this.streamA, base: STREAM_A_ALPHA, lit: true });
    this.openLayers.push({ node: this.streamB, base: STREAM_B_ALPHA, lit: true });
    this.openLayers.push({ node: this.motes, base: MOTE_ALPHA, lit: true });

    this.leafGhost.visible = false;
    this.apply();
  }

  /** One `TilingSprite` of the shared field, sized so exactly ONE copy spans the layer's width —
   *  the field's own faded left/right edges are then the layer's edges, and it never repeats
   *  horizontally, so there is no vertical seam to hide. `dir` is signed: its magnitude scales the
   *  tile vertically (so two copies of one bake read as different flame lengths) and its sign
   *  chooses whether the field scrolls up (locked, contained) or down and out (open). */
  private buildField(
    key: string,
    tongues: number,
    w: number,
    h: number,
    alpha: number,
    tint: number,
    dir: number,
  ): TilingSprite {
    const tex = bakeField(key, tongues);
    const s = new TilingSprite({ texture: tex, width: w, height: h });
    s.tileScale.set(w / tex.width, (w / tex.width) * Math.abs(dir));
    if (dir < 0) s.tileScale.x = -s.tileScale.x; // mirrored, so the pair never draws one shape twice
    s.blendMode = 'add';
    s.tint = tint;
    s.alpha = alpha;
    return s;
  }

  /** Which state the door is currently PLAYING toward. */
  get isLocked(): boolean {
    return this.locked;
  }

  /**
   * Start a lock-state change. `animate` false snaps (a room build, where there is no previous
   * state to come from); true crossfades over `TRANSITION_MS` and throws off a ring — inward and
   * red when a fight seals a room, outward and warm when the last enemy dies and the way opens.
   */
  setLocked(locked: boolean, animate: boolean): void {
    if (locked === this.locked && this.transMs <= 0) return;
    this.locked = locked;
    this.transMs = animate ? TRANSITION_MS : 0;
    this.burstMs = animate ? TRANSITION_MS : 0;
    if (!animate) this.leafGhost.visible = false;
    this.apply();
  }

  /** The player walked into this door and did not get through it (`GameLoop`'s client-side
   *  derivation — the sim is not asked, and nothing here reaches it). No-op on an open door. */
  reject(): void {
    if (this.locked) this.rejectMs = REJECT_MS;
  }

  /** Advance one render frame. `near` is 0 across the room, 1 standing in the doorway. */
  tick(dt: number, near: number): void {
    this.t += dt;
    this.near = near;
    if (this.transMs > 0) this.transMs = Math.max(0, this.transMs - dt);
    if (this.rejectMs > 0) this.rejectMs = Math.max(0, this.rejectMs - dt);
    if (this.burstMs > 0) this.burstMs = Math.max(0, this.burstMs - dt);
    this.apply();
  }

  /** Write this instant's transforms and alphas. Split out of `tick` so the constructor can put a
   *  freshly built door into a settled pose without a zero-dt tick. */
  private apply(): void {
    const t = this.t;
    // The x-ray's fade, folded into every alpha below — see `xrayLayer`.
    const fade = this.xrayLayer.alpha;
    // Crossfade weights. The outgoing side is squared so it clears early and the incoming state is
    // what the eye lands on — a linear pair reads as a dissolve between two equal things, and a
    // door swapping states is not that.
    const p = this.transMs > 0 ? 1 - this.transMs / TRANSITION_MS : 1;
    const outW = (1 - p) * (1 - p);
    const nearMul = Math.min(1, NEAR_MIN + NEAR_SPAN * this.near);

    const breatheLocked = 0.82 + 0.18 * breathe(t, LOCKED_BREATHE_MS);
    const breatheOpen = 0.85 + 0.15 * breathe(t, OPEN_BREATHE_MS);
    const lockedW = (this.locked ? p : outW) * breatheLocked * fade;
    const openW = (this.locked ? outW : p) * breatheOpen * fade;

    // A group is MOUNTED while it is the current state or while a transition is still running,
    // and its alpha then carries the crossfade. Visibility cannot be derived from the weight
    // alone: the incoming side's weight is exactly 0 on the frame a change starts, and a door
    // whose two states were both unmounted for that frame would flicker through to bare stone.
    const settling = this.transMs > 0;
    setGroup(this.lockedLayers, lockedW, nearMul, this.locked || settling);
    setGroup(this.openLayers, openW, nearMul, !this.locked || settling);
    this.behind.visible = !this.locked || settling;
    this.over.visible = true;

    this.leafGhost.visible = settling;
    this.leafGhost.alpha = outW * fade;

    // Flame: two fields scrolling UP at beating periods. `tilePosition` is accumulated straight
    // off the clock with no modulo — the field is seamless, so any offset is a valid one, and a
    // room's whole lifetime cannot grow this past float precision.
    if (this.flameA && this.flameB) {
      this.flameA.tilePosition.y = -(t / FLAME_A_PERIOD_MS) * this.flameA.tileScale.y * FIELD_H;
      this.flameB.tilePosition.y = -(t / FLAME_B_PERIOD_MS) * this.flameB.tileScale.y * FIELD_H;
    }
    // Streams: the same field, scrolling DOWN and out of the passage.
    this.streamA.tilePosition.y = (t / STREAM_A_PERIOD_MS) * this.streamA.tileScale.y * FIELD_H;
    this.streamB.tilePosition.y = (t / STREAM_B_PERIOD_MS) * this.streamB.tileScale.y * FIELD_H;

    // The scan bar and the motes are in the state groups for their `visible` alone — `setGroup`
    // writes them a provisional alpha that these two refine, because each has a shape of its own
    // along its travel that a flat group weight cannot express.
    if (this.scan) {
      const sweep = pingPong(t, SCAN_PERIOD_MS);
      this.scan.x = this.band.x + sweep * Math.max(0, this.band.w - this.scan.width);
      // Brightest mid-sweep, so the turnarounds at the jambs are soft rather than a stall.
      this.scan.alpha = Math.min(1, lockedW * SCAN_ALPHA * nearMul * (0.35 + 0.65 * Math.sin(Math.PI * sweep)));
    }
    if (this.rejectFlash) {
      const k = this.rejectMs / REJECT_MS;
      this.rejectFlash.alpha = k * k * REJECT_FLASH_ALPHA * fade;
    }

    this.drawMotes(openW * nearMul);
    this.drawPulse(lockedW, openW, nearMul);
    this.drawBurst(fade);
  }

  /** Motes drifting out of the passage onto the floor — the open state's "things come OUT of here".
   *  One `Graphics` redrawn per frame, `MOTE_COUNT` circles: the same cost class as
   *  `Portal.drawParticles`, and the only per-frame redraw a door does. */
  private drawMotes(weight: number): void {
    const g = this.motes;
    if (weight <= 0.001) return clearOnce(g);
    redraw(g);
    // The one per-frame REDRAW a door does, and therefore the one part of this pass with a cost
    // worth a lever. It rides `particleBudget` rather than a new tier field because that is
    // literally what the field means ("multiplier on particle burst counts") and a mote is a
    // particle — the low tier's 0.35 thins five to two, and a tier that disables particles
    // outright still keeps one, since the open state's "things come OUT of here" is a legibility
    // cue and not decoration. Everything else here is transform animation and costs nothing to
    // leave on. Phases stay spread over the full `MOTE_COUNT`, so thinning drops motes rather
    // than bunching the survivors.
    const n = Math.max(1, Math.round(MOTE_COUNT * activeQuality().particleBudget));
    const x0 = OPEN_HOLE.x0 * this.openingW;
    const span = (OPEN_HOLE.x1 - OPEN_HOLE.x0) * this.openingW;
    // From deep in the passage to just south of the threshold, i.e. out toward the player.
    const yTop = -this.openingH * 0.72;
    const yOut = 10;
    for (let i = 0; i < n; i++) {
      const m = motePose(i, this.t);
      const x = x0 + m.u * span;
      const y = yTop + (yOut - yTop) * m.v;
      const r = 1.1 + 1.5 * m.v;
      g.circle(x, y, r).fill({ color: THROUGH_COLOR, alpha: m.alpha });
    }
  }

  /** The floor pulse: one ring per `PULSE_PERIOD_MS`, travelling OUTWARD from the doorway when the
   *  door is open and INWARD toward it when locked. Same ellipse squash as `GLOW_POOL`, so it lies
   *  on the floor with everything else in this view, and cut back to the floor the fixture is not
   *  standing on (`doorLights.strokeFloorArc` over this door's own `plane`). How far it travels is
   *  `doorLights.ringTravel` over that plane's `span`, not a multiple of the raw opening width —
   *  0.35 to 1.3 of the door's own size, from the wall's face where the plane has one. */
  private drawPulse(lockedW: number, openW: number, nearMul: number): void {
    const g = this.pulse;
    const s = sawtooth(this.t, PULSE_PERIOD_MS);
    const fade = Math.sin(Math.PI * s); // 0 at both ends, so the sawtooth's jump is never drawn
    const alphaOf = (weight: number): number => weight * nearMul * PULSE_ALPHA * fade;
    if (alphaOf(openW) <= 0.002 && alphaOf(lockedW) <= 0.002) return clearOnce(g);
    redraw(g);
    const ring = (weight: number, color: number, grow: number): void => {
      const a = alphaOf(weight);
      if (a <= 0.002) return;
      const rx = ringTravel(this.plane, 0.35, 1.3, grow);
      strokeFloorArc(g, this.plane, rx, color, 2, Math.min(1, a));
    };
    ring(openW, THROUGH_COLOR, s);
    ring(lockedW, GLOW_COLOR, 1 - s);
  }

  /** The one-shot ring a lock-state change throws off — the piece that makes "the room is clear"
   *  an event rather than a boolean. Outward and warm on unlock, inward and red on lock. */
  private drawBurst(fade: number): void {
    const g = this.burst;
    if (this.burstMs <= 0) return clearOnce(g);
    redraw(g);
    const k = 1 - this.burstMs / TRANSITION_MS;
    const grow = this.locked ? 1 - k : k;
    const rx = ringTravel(this.plane, 0.3, 1.65, grow);
    strokeFloorArc(g, this.plane, rx, this.locked ? GLOW_COLOR : 0xffffff, 3, (1 - k) * 0.75 * fade);
  }
}

/** Empty `g` unless it already is. Clearing an empty Graphics still marks it dirty, and a dirty
 *  Graphics is rebuilt on its next render — for a settled door that was three rebuilds a frame of
 *  nothing at all. Hidden too: these are `redrawnGraphics`, each its own draw call and a break in
 *  the batch around it, and an empty one would pay both for nothing. */
function clearOnce(g: Graphics): void {
  if (g.context.instructions.length > 0) g.clear();
  g.visible = false;
}

/** Start this frame's drawing of `g`: shown, and emptied of last frame's. */
function redraw(g: Graphics): void {
  g.visible = true;
  g.clear();
}

/** Write one state group's alphas: `weight` is its crossfade share times its breath, `nearMul` the
 *  proximity ramp that reaches only the lit layers. An unmounted group goes `visible = false`
 *  rather than alpha 0, so a settled door submits nothing at all for the state it is not in. */
function setGroup(layers: readonly FxLayer[], weight: number, nearMul: number, on: boolean): void {
  for (const l of layers) {
    l.node.visible = on;
    if (on) l.node.alpha = Math.min(1, l.base * weight * (l.lit ? nearMul : 1));
  }
}
