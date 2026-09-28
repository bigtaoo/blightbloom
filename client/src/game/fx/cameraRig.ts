// Camera follow math, split out of FxController (2026-09-28, motion-comfort pass): the fit zoom,
// the dead-zone follow, the smoothing of both, and the shake waveform. Pure — no Pixi, no clock.

// Cap on the fit zoom. History: 1.8 (design/10's original legibility fix) -> 2.5 (2026-08-12, a
// narrow floor left a void beside it) -> 4.5 (2026-08-17, when the fit target became the ROOM
// and 2.5 bound in every one) -> 3.5 (2026-09-28, user report "玩起来会头晕，类似晕3D"). At 4.5
// the camera magnified every step the player took into a whole-screen slide; 3.5 keeps a room
// filling most of a desktop viewport, and a room that no longer quite covers it shows a sliver of
// its neighbours at the edges, which reads as depth (see FxController.updateCamera).
export const MAX_ZOOM = 3.5;

// How much of the frame the camera looks ABOVE the follow target's ground point, as a fraction of
// the viewport height (user report, 2026-08-17: "镜头往下一些 … 给角色最好的展示"). Every entity
// reports its GROUND position — the point at its feet (Entity.applyTransform) — so a camera
// centred on it puts the whole body in the upper half of the screen. Biasing the look-at point
// upward slides the rendered world DOWN, re-centring the character. A fraction of the viewport,
// not a pixel count, so it scales with the window and with the zoom.
export const CAMERA_BODY_BIAS_R = 0.08;

// Half-size of the dead zone, as a fraction of the viewport's SHORTER side: the player can move
// this far from the look-at point before the camera moves at all. It is what stops a strafe, a
// bump into a wall or a knockback from being replayed 1:1 as a whole-screen jolt.
export const DEADZONE_R = 0.05;

// Time constants of the exponential follow, in ms. `1 - exp(-dt/tau)` per frame, so the result
// is the same at 30, 60 and 144 fps. Pan is quick enough that a sprint never loses the player;
// zoom is slower, because a zoom change moves every pixel on the screen at once.
export const FOLLOW_TAU_MS = 140;
export const ZOOM_TAU_MS = 320;

// A jump of the look-at point farther than this (fraction of the viewport's LONGER side, in
// screen px) is a teleport — a new floor, a respawn, a force-regroup across a room — and is cut
// to rather than swept across: a half-second pan over a whole floor is worse than a cut.
export const SNAP_DISTANCE_R = 0.5;

// Camera-shake offset at full trauma, screen px (design/01 milestone 3). Was 14, re-rolled from
// `Math.random()` every frame — a 60 Hz buzz of the whole screen; now 7 and a smooth waveform.
export const MAX_SHAKE_PX = 7;

/** Something that can report its interpolated ground position — the local player's Actor view,
 *  duck-typed so the camera never needs to import game/Actor.ts. */
export interface CameraTarget {
  interpGroundX(alpha: number): number;
  interpGroundY(alpha: number): number;
}

/** A world-px rect for the camera to fill — the room the local player is standing in
 *  (`GameLoop.updateCamera` resolves it), falling back to the whole floor. */
export interface CameraFrame {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CameraInput {
  vw: number;
  vh: number;
  worldW: number;
  worldH: number;
  /** The room to fill, or null — see FxController.updateCamera. */
  frame: CameraFrame | null;
  /** The follow target's interpolated GROUND point, world px. */
  px: number;
  py: number;
  /** Render time since the last step. Omitted = nothing to smooth over: the pose is cut to. */
  dtMs?: number;
}

/** Where the world layer goes, before shake: its scale and its screen offset. */
export interface CameraPose {
  zoom: number;
  x: number;
  y: number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** Cover-fit zoom of a `w`x`h` rect into the viewport, floored at 1 and capped at MAX_ZOOM. */
export function fitZoom(vw: number, vh: number, w: number, h: number): number {
  return Math.min(MAX_ZOOM, Math.max(1, vw / w, vh / h));
}

/** The smooth shake waveform: two incommensurate sines per axis (~7-12 Hz), bounded by `mag`.
 *  A rumble rather than the per-frame white noise it replaced — same peak budget, no buzz. */
export function shakeOffset(tMs: number, mag: number): { x: number; y: number } {
  return {
    x: mag * (0.6 * Math.sin(tMs * 0.0461 + 1.3) + 0.4 * Math.sin(tMs * 0.0747 + 4.1)),
    y: mag * (0.6 * Math.sin(tMs * 0.0523 + 2.7) + 0.4 * Math.sin(tMs * 0.0689 + 0.4)),
  };
}

/**
 * The follow camera's state between frames. Three things it smooths, each for a reported cause
 * of motion sickness (2026-09-28):
 *
 * - **Zoom** eases toward the fit of the current room instead of being recomputed from scratch
 *   every frame. A door passage belongs to no room, so the player's `roomId` clears there; the
 *   camera used to fall back to fitting the whole FLOOR for those frames, i.e. ~4x -> ~1x -> ~4x
 *   in a single frame each way through every door. It now keeps fitting the last room it had.
 * - **Pan** follows a dead-zone anchor rather than the player: small moves do not move the
 *   camera at all, and large ones are eased in.
 * - **Clamping** is applied to the anchor AND to the eased point, so the camera never shows past
 *   the world edge while its zoom is still easing.
 */
export class CameraRig {
  /** 0 = no pose yet: the next step is a cut. */
  private zoom = 0;
  private lookX = 0;
  private lookY = 0;
  private anchorX = 0;
  private anchorY = 0;
  /** The last room fitted — held through a door passage, where there is none. */
  private lastFrame: CameraFrame | null = null;

  /** Forget everything — the next step cuts. For a fresh run (FxController.resetForNewRun). */
  reset(): void {
    this.zoom = 0;
    this.lastFrame = null;
  }

  step(inp: CameraInput): CameraPose {
    const { vw, vh, worldW, worldH, dtMs } = inp;
    if (inp.frame) this.lastFrame = inp.frame;
    const frame = inp.frame ?? this.lastFrame;
    const targetZoom = frame ? fitZoom(vw, vh, frame.w, frame.h) : fitZoom(vw, vh, worldW, worldH);

    let cut = this.zoom === 0 || dtMs === undefined;
    if (!cut) {
      const k = 1 - Math.exp(-dtMs! / ZOOM_TAU_MS);
      this.zoom = Math.exp(Math.log(this.zoom) + (Math.log(targetZoom) - Math.log(this.zoom)) * k);
    }
    const zoom = cut ? targetZoom : this.zoom;

    const tx = inp.px;
    const ty = inp.py - (vh * CAMERA_BODY_BIAS_R) / zoom;
    const far = SNAP_DISTANCE_R * Math.max(vw, vh);
    if (!cut && Math.hypot(tx - this.lookX, ty - this.lookY) * zoom > far) cut = true;

    // The legal look-at range at this zoom: the inverse of the world-edge clamp on the offset.
    // A world narrower than the viewport is simply centred on that axis.
    const overscanTop = frame ? Math.max(0, -frame.y) * zoom : 0;
    const effW = worldW * zoom;
    const effH = worldH * zoom;
    const [xLo, xHi] = effW <= vw ? [worldW / 2, worldW / 2] : [vw / 2 / zoom, worldW - vw / 2 / zoom];
    const [yLo, yHi] = effH <= vh ? [worldH / 2, worldH / 2] : [(vh / 2 - overscanTop) / zoom, worldH - vh / 2 / zoom];

    if (cut) {
      this.zoom = targetZoom;
      this.anchorX = this.lookX = clamp(tx, xLo, xHi);
      this.anchorY = this.lookY = clamp(ty, yLo, yHi);
    } else {
      const dz = (DEADZONE_R * Math.min(vw, vh)) / zoom;
      this.anchorX = clamp(clamp(this.anchorX, tx - dz, tx + dz), xLo, xHi);
      this.anchorY = clamp(clamp(this.anchorY, ty - dz, ty + dz), yLo, yHi);
      const k = 1 - Math.exp(-dtMs! / FOLLOW_TAU_MS);
      this.lookX = clamp(this.lookX + (this.anchorX - this.lookX) * k, xLo, xHi);
      this.lookY = clamp(this.lookY + (this.anchorY - this.lookY) * k, yLo, yHi);
    }
    return { zoom, x: vw / 2 - this.lookX * zoom, y: vh / 2 - this.lookY * zoom };
  }
}
