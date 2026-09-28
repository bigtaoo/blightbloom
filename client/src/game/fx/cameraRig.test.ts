import { describe, it, expect } from 'vitest';
import {
  CameraRig,
  CAMERA_BODY_BIAS_R,
  DEADZONE_R,
  MAX_SHAKE_PX,
  MAX_ZOOM,
  fitZoom,
  shakeOffset,
  type CameraInput,
} from './cameraRig';

// The motion-comfort pass (2026-09-28, user report "玩起来会头晕，类似晕3D"). Each case below
// pins one of the three things that used to move the whole screen with nothing easing it.

const VIEW = { vw: 800, vh: 600 };
const ROOM = { x: 800, y: 800, w: 400, h: 400 }; // cover-fits to zoom 2 in VIEW
const BIG = { worldW: 4000, worldH: 4000 };

function inp(px: number, py: number, over: Partial<CameraInput> = {}): CameraInput {
  return { ...VIEW, ...BIG, frame: ROOM, px, py, dtMs: 16, ...over };
}

/** The world point at the centre of the screen for a pose — what the camera is looking at. */
function lookAt(p: { zoom: number; x: number; y: number }): { x: number; y: number } {
  return { x: (VIEW.vw / 2 - p.x) / p.zoom, y: (VIEW.vh / 2 - p.y) / p.zoom };
}

describe('fitZoom', () => {
  it('cover-fits, floors at 1 and caps at MAX_ZOOM', () => {
    expect(fitZoom(800, 600, 400, 400)).toBe(2);
    expect(fitZoom(800, 600, 4000, 4000)).toBe(1);
    expect(fitZoom(800, 600, 10, 10)).toBe(MAX_ZOOM);
  });

  it('caps below the old 4.5, so a desktop room no longer renders at 4x+', () => {
    // Level 1's rooms are ~470-560 px square; cover-fitting one into 1920x911 wants 3.4-4.1x.
    expect(MAX_ZOOM).toBeLessThan(4.5);
    expect(fitZoom(1920, 911, 500, 500)).toBe(MAX_ZOOM);
  });
});

describe('CameraRig — cuts', () => {
  it('cuts straight to the target on the first step', () => {
    const rig = new CameraRig();
    const p = rig.step(inp(1000, 1000));
    expect(p.zoom).toBe(2);
    const at = lookAt(p);
    expect(at.x).toBeCloseTo(1000);
    expect(at.y).toBeCloseTo(1000 - (600 * CAMERA_BODY_BIAS_R) / 2);
  });

  it('cuts on every step with no dt — there is nothing to smooth over', () => {
    const rig = new CameraRig();
    rig.step(inp(1000, 1000));
    const p = rig.step(inp(1300, 1000, { dtMs: undefined }));
    expect(lookAt(p).x).toBeCloseTo(1300);
  });

  it('cuts across a teleport rather than sweeping the whole floor', () => {
    const rig = new CameraRig();
    rig.step(inp(1000, 1000));
    // 1000 world px at zoom 2 = 2000 screen px, far past half the viewport's longer side.
    const p = rig.step(inp(2000, 1000));
    expect(lookAt(p).x).toBeCloseTo(2000);
  });

  it('cuts again after reset()', () => {
    const rig = new CameraRig();
    rig.step(inp(1000, 1000));
    rig.reset();
    const p = rig.step(inp(1100, 1000));
    expect(lookAt(p).x).toBeCloseTo(1100);
  });
});

describe('CameraRig — dead-zone follow', () => {
  it('does not move at all for a move inside the dead zone', () => {
    const rig = new CameraRig();
    const first = rig.step(inp(1000, 1000));
    const dz = (DEADZONE_R * 600) / 2; // world px at zoom 2
    const p = rig.step(inp(1000 + dz * 0.9, 1000 - dz * 0.9));
    expect(p.x).toBe(first.x);
    expect(p.y).toBe(first.y);
  });

  it('eases toward a move past the dead zone instead of snapping to it', () => {
    const rig = new CameraRig();
    rig.step(inp(1000, 1000));
    const p = rig.step(inp(1100, 1000));
    const x = lookAt(p).x;
    expect(x).toBeGreaterThan(1000); // it moved...
    expect(x).toBeLessThan(1100 - 15); // ...but not all the way, not even to the dead-zone edge
  });

  it('settles with the player at the dead-zone edge, and is frame-rate independent', () => {
    const after = (dt: number, totalMs: number): number => {
      const rig = new CameraRig();
      rig.step(inp(1000, 1000));
      let p = rig.step(inp(1100, 1000, { dtMs: dt }));
      for (let i = 1; i < totalMs / dt; i++) p = rig.step(inp(1100, 1000, { dtMs: dt }));
      return lookAt(p).x;
    };
    const dz = (DEADZONE_R * 600) / 2;
    expect(after(16, 1600)).toBeCloseTo(1100 - dz, 1);
    // Mid-ease, the same 160 ms at 62.5 and at 125 fps land within a pixel of each other.
    const mid = after(8, 160);
    expect(mid).toBeLessThan(1100 - dz - 10); // genuinely mid-ease, or the comparison is empty
    expect(Math.abs(after(16, 160) - mid)).toBeLessThan(1);
  });
});

describe('CameraRig — zoom', () => {
  it('eases between rooms of different size instead of jumping', () => {
    const rig = new CameraRig();
    rig.step(inp(1000, 1000)); // zoom 2
    const small = { x: 900, y: 900, w: 250, h: 250 }; // fits to 3.2
    const p = rig.step(inp(1000, 1000, { frame: small }));
    expect(p.zoom).toBeGreaterThan(2);
    expect(p.zoom).toBeLessThan(2.3);
    let q = p;
    for (let i = 0; i < 120; i++) q = rig.step(inp(1000, 1000, { frame: small }));
    expect(q.zoom).toBeCloseTo(3.2, 2);
  });

  it('holds the last room through a door passage, where there is no frame', () => {
    // The old camera re-fit the whole FLOOR here: 2x -> 1x -> 2x through every door.
    const rig = new CameraRig();
    rig.step(inp(1000, 1000));
    let p = rig.step(inp(1000, 1000));
    for (let i = 0; i < 60; i++) p = rig.step(inp(1000, 1000, { frame: null }));
    expect(p.zoom).toBe(2);
  });

  it('fits the whole world when there never was a room (a flat mode)', () => {
    const rig = new CameraRig();
    const p = rig.step({ ...VIEW, worldW: 400, worldH: 400, frame: null, px: 200, py: 200 });
    expect(p.zoom).toBe(2);
  });
});

describe('CameraRig — world clamp', () => {
  it('never shows past the world edge, even while the zoom is still easing out', () => {
    const rig = new CameraRig();
    const small = { x: 3800, y: 3800, w: 200, h: 200 };
    rig.step(inp(3990, 3990, { frame: small })); // zoom 3.5, pinned in the south-east corner
    for (let i = 0; i < 40; i++) {
      const p = rig.step(inp(3990, 3990)); // back to ROOM's zoom 2, easing
      expect(p.x).toBeGreaterThanOrEqual(800 - 4000 * p.zoom - 1e-6);
      expect(p.x).toBeLessThanOrEqual(0);
      expect(p.y).toBeGreaterThanOrEqual(600 - 4000 * p.zoom - 1e-6);
    }
  });

  it('centres a world too small to fill the viewport even at MAX_ZOOM', () => {
    const rig = new CameraRig();
    const p = rig.step({ ...VIEW, worldW: 100, worldH: 100, frame: null, px: 10, py: 10 });
    expect(p.zoom).toBe(MAX_ZOOM);
    expect(p.x).toBeCloseTo((800 - 100 * MAX_ZOOM) / 2);
    expect(p.y).toBeCloseTo((600 - 100 * MAX_ZOOM) / 2);
  });
});

describe('shakeOffset', () => {
  it('stays inside its magnitude', () => {
    for (let t = 0; t < 2000; t += 7) {
      const s = shakeOffset(t, MAX_SHAKE_PX);
      expect(Math.abs(s.x)).toBeLessThanOrEqual(MAX_SHAKE_PX);
      expect(Math.abs(s.y)).toBeLessThanOrEqual(MAX_SHAKE_PX);
    }
  });

  it('is smooth: one 60 fps frame moves it a fraction of its range, never a full re-roll', () => {
    let worst = 0;
    for (let t = 0; t < 2000; t += 16) {
      const a = shakeOffset(t, 1);
      const b = shakeOffset(t + 16, 1);
      worst = Math.max(worst, Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    }
    expect(worst).toBeLessThan(1); // white noise in [-1, 1] reaches ~2
    expect(worst).toBeGreaterThan(0.1); // and it does move
  });
});
