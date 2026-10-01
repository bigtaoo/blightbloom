/**
 * Entity — the base render view. Covers `pushState`'s `bodyFacingRad` param: it
 * defaults to `facingRad` (every entity except a player view — enemies, bullets,
 * pickups — has no separate body orientation, see Actor's upper/lower body split),
 * but can be overridden independently, and both are held (not interpolated) exactly
 * like the pre-existing `facingRad` — angles snap to the current tick's value.
 */
import { describe, it, expect } from 'vitest';
import { Container, Graphics } from 'pixi.js';
import { Entity, SHADOW_SQUASH, SHADOW_SLANT_X, SHADOW_SLANT_Y } from './Entity';
import { AUTO_BATCH_VERTEX_LIMIT } from '../../perf/drawAttribution';

/** Every `ellipse` path instruction drawn into a Graphics, as `[cx, cy, rx, ry]`. Pixi emits one
 *  fill instruction per ring but prefixes all but the first with a `moveTo`, so the ellipse is
 *  not reliably at index 0 of the path. */
function ellipsesOf(g: Graphics): number[][] {
  const out: number[][] = [];
  for (const i of g.context.instructions as Array<{ data: { path?: { instructions: Array<{ action: string; data: number[] }> } } }>) {
    for (const pi of i.data.path?.instructions ?? []) if (pi.action === 'ellipse') out.push(pi.data);
  }
  return out;
}

describe('Entity.pushState — bodyFacingRad', () => {
  it('defaults bodyFacingRad to facingRad when omitted', () => {
    const e = new Entity();
    e.pushState(0, 0, 0, Math.PI / 2);
    expect(e.facingRad).toBe(Math.PI / 2);
    expect(e.bodyFacingRad).toBe(Math.PI / 2);
  });

  it('accepts an independent bodyFacingRad', () => {
    const e = new Entity();
    e.pushState(0, 0, 0, Math.PI, -Math.PI / 2);
    expect(e.facingRad).toBe(Math.PI);
    expect(e.bodyFacingRad).toBe(-Math.PI / 2);
  });

  it('both angles snap to the latest tick — no interpolation/wrap smoothing', () => {
    const e = new Entity();
    e.pushState(0, 0, 0, 0, 0);
    e.pushState(1, 1, 0, Math.PI, Math.PI / 2);
    expect(e.facingRad).toBe(Math.PI);
    expect(e.bodyFacingRad).toBe(Math.PI / 2);
  });
});

// The depth cues added 2026-08-18 (design/01 "Grounding the character"). Entity is where the
// lift-to-shadow relationship lives, and every actor/bullet/pillar/wall inherits it from here,
// so these are the assertions that hold the whole grounding pass together.
describe('Entity — visualZ, the render-only hover lift', () => {
  /** Entity keeps `visualZ` protected (only Actor writes it); tests reach it the same way
   *  RoomBuilder.test reaches private scene state. */
  function setVisualZ(e: Entity, v: number): void {
    (e as unknown as { visualZ: number }).visualZ = v;
  }

  it('is folded in by place(), not only by interpolate()', () => {
    // Both paths go through applyTransform, which is exactly why the lift is applied there and
    // not at each call site — a statically placed entity has to honour it too.
    const e = new Entity();
    setVisualZ(e, 6);
    e.place(100, 200, 0);
    expect(e.y).toBe(194);
  });

  it('adds to the sim\'s own z rather than replacing it', () => {
    const e = new Entity();
    setVisualZ(e, 5);
    e.place(0, 300, 40); // a lifted bullet that also hovers
    expect(e.y).toBe(300 - 45);
  });

  it('never touches the Y-sort key, so a hover cannot reorder the scene', () => {
    // The single most important property of this whole mechanism: `zIndex` is the GROUND
    // coordinate. If lift leaked into it, a hovering actor would flicker in front of and behind
    // a wall it is standing next to, every hover cycle.
    const e = new Entity();
    setVisualZ(e, 9);
    e.place(100, 250, 30);
    expect(e.zIndex).toBe(250);
  });

  it('moving writes the sort key WITHOUT flagging its render group — `ySort.ts` re-sorts', () => {
    // A moving view used to set `zIndex` every frame, and the setter rebuilds the whole enclosing
    // render group each time (~30% of frame work at a 4x CPU throttle). The layer's own
    // `settleYSort` raises the flag instead, and only when the order has actually changed.
    const layer = new Container();
    layer.sortableChildren = true;
    layer.enableRenderGroup();
    const e = new Entity();
    layer.addChild(e);
    layer.renderGroup!.structureDidChange = false;
    layer.sortDirty = false;
    e.place(100, 260, 0);
    expect(e.zIndex).toBe(260);
    expect(layer.renderGroup!.structureDidChange).toBe(false);
    expect(layer.sortDirty).toBe(false);
  });

  it('interpolates the sim z and then applies the lift on top', () => {
    const e = new Entity();
    e.pushState(0, 0, 0, 0);
    e.pushState(0, 0, 20, 0);
    setVisualZ(e, 4);
    e.interpolate(0.5, 16); // z lerps to 10, plus 4 of hover
    expect(e.y).toBe(-14);
  });
});

describe('Entity.makeShadow — a penumbra, not a die-cut disc', () => {
  it('stacks many faint ellipses rather than one opaque fill', () => {
    // Four graduated rings (the first attempt) showed four visible concentric edges at 7x and
    // read as a targeting reticle. Many faint rings is the same trick at a step size small
    // enough to disappear, so the count matters and so does every ring staying faint.
    const e = new Entity();
    const s = e.makeShadow(20);
    const fills = (s.context.instructions as Array<{ action: string; data: { style: { alpha: number } } }>)
      .filter((i) => i.action === 'fill');
    expect(fills.length).toBeGreaterThanOrEqual(10);
    for (const f of fills) expect(f.data.style.alpha).toBeLessThan(0.12);
  });

  it('ramps the per-ring alpha outward-faint to inward-strong, so the outer edge is not an edge', () => {
    // Retuned 2026-08-19: a FLAT per-ring alpha makes the outermost ring a visible hard rim at
    // that alpha, and an enemy's shadow read as a black plate it was sitting in. Ramping means
    // the outermost ring is nearly transparent (a penumbra's edge) while the contact core still
    // composites to something definite.
    const e = new Entity();
    const s = e.makeShadow(20);
    const alphas = (s.context.instructions as Array<{ action: string; data: { style: { alpha: number } } }>)
      .filter((i) => i.action === 'fill')
      .map((f) => f.data.style.alpha);
    for (let i = 1; i < alphas.length; i++) expect(alphas[i]).toBeGreaterThan(alphas[i - 1]!);
    expect(alphas[0]!).toBeLessThan(0.04); // outermost: all but invisible on its own
    // Composited darkness at the core — what the player actually sees under a body.
    const core = 1 - alphas.reduce((acc, a) => acc * (1 - a), 1);
    expect(core).toBeGreaterThan(0.4);
    expect(core).toBeLessThan(0.6);
  });

  it('steps monotonically inward from wider-than-the-body to a small core', () => {
    const e = new Entity();
    const s = e.makeShadow(20);
    const radii = ellipsesOf(s).map((e) => e[2]!); // rx
    expect(radii[0]).toBeGreaterThan(20); // the outermost ring reaches past the body
    expect(radii[radii.length - 1]).toBeLessThan(20); // ...down to a tight contact core
    for (let i = 1; i < radii.length; i++) expect(radii[i]).toBeLessThan(radii[i - 1]!);
  });

  it('foreshortens every ring by the shared 0.62, so it lies on the floor plane', () => {
    const e = new Entity();
    const s = e.makeShadow(20);
    for (const [, , rx, ry] of ellipsesOf(s)) {
      expect(ry! / rx!).toBeCloseTo(SHADOW_SQUASH, 6);
    }
  });

  it('is a batched Graphics — the ring count puts it past the Pixi auto-batch cutoff', () => {
    // The reason the two are coupled: the same "many faint rings" decision that makes this a
    // penumbra rather than a disc is what pushes its geometry past 400 floats, and past that line
    // Pixi gives a Graphics its own draw call plus a program switch each way. Every actor, bullet,
    // pillar and prop in the room owns one of these, so on the measured start room they were 22 of
    // 165 draw calls. Safe to batch only because the caller mounts it on `layers.shadow`, which has
    // its own render group — see `render/staticGraphics.ts` for why that condition is load-bearing.
    const s = new Entity().makeShadow(20);
    expect(s.context.batchMode).toBe('batch');
    // ...and the geometry really is over the line, i.e. the batch mode is not decoration. A rings
    // count small enough to auto-batch would make this assertion pointless, so it is checked.
    const ellipses = ellipsesOf(s).length;
    expect(ellipses * 4 * 2).toBeGreaterThan(AUTO_BATCH_VERTEX_LIMIT / 8);
  });
});

describe('Entity — the shadow answers to height', () => {
  function setVisualZ(e: Entity, v: number): void {
    (e as unknown as { visualZ: number }).visualZ = v;
  }

  it('sits exactly on the ground point, at full baked opacity, when grounded', () => {
    // alpha is 1 here, NOT the old 0.35: the per-ring alphas are baked into the Graphics now,
    // so multiplying the container by 0.35 as well would flatten the whole penumbra back out.
    const e = new Entity();
    e.makeShadow(20);
    e.place(100, 200, 0);
    expect(e.shadow!.x).toBe(100);
    expect(e.shadow!.y).toBe(200);
    expect(e.shadow!.alpha).toBe(1);
    expect(e.shadow!.scale.x).toBe(1);
  });

  it('slides away from the key light in proportion to TOTAL lift, sim z and hover alike', () => {
    const a = new Entity();
    a.makeShadow(20);
    a.place(0, 0, 12);
    const b = new Entity();
    b.makeShadow(20);
    setVisualZ(b, 12);
    b.place(0, 0, 0);
    // The two are the same height by different routes and must cast identically.
    expect(a.shadow!.x).toBeCloseTo(b.shadow!.x, 9);
    expect(a.shadow!.y).toBeCloseTo(b.shadow!.y, 9);
    expect(a.shadow!.x).toBeCloseTo(12 * SHADOW_SLANT_X, 9);
    expect(a.shadow!.y).toBeCloseTo(12 * SHADOW_SLANT_Y, 9);
  });

  it('shrinks and fades monotonically as the lift grows', () => {
    const e = new Entity();
    e.makeShadow(20);
    let lastScale = Infinity;
    let lastAlpha = Infinity;
    for (const z of [0, 5, 20, 60]) {
      e.place(0, 0, z);
      expect(e.shadow!.scale.x).toBeLessThan(lastScale);
      expect(e.shadow!.alpha).toBeLessThan(lastAlpha);
      lastScale = e.shadow!.scale.x;
      lastAlpha = e.shadow!.alpha;
    }
    expect(lastScale).toBeGreaterThan(0); // never collapses to nothing
  });

  it('adds shadowOffset on top of the lift-driven slide, and independently of it', () => {
    // This is the hook a STATIC tall object needs (a pillar is drawn upward from a grounded
    // origin, so its own z is 0 and the height that throws its shadow is invisible here).
    const e = new Entity();
    e.makeShadow(20);
    e.shadowOffsetX = 30;
    e.shadowOffsetY = 15;
    e.place(100, 200, 0);
    expect(e.shadow!.x).toBe(130);
    expect(e.shadow!.y).toBe(215);
    // ...and it does not change the scale/fade, which only height does.
    expect(e.shadow!.scale.x).toBe(1);
  });

  it('is a no-op for an entity with no shadow at all', () => {
    const e = new Entity();
    expect(() => e.place(10, 20, 5)).not.toThrow();
    expect(e.shadow).toBeNull();
  });
});

describe('Entity.nudge', () => {
  // FxController.updateCamera cancels the camera's whole-pixel rounding on the followed player
  // with this. It has to move the parts placed by hand with the body, and must never pile up.
  it("shifts this frame's pose and its shadow, replaces rather than accumulates, and clears on the next draw", () => {
    const e = new Entity();
    e.shadow = new Graphics();
    e.pushState(100, 50, 0, 0);
    e.snap();
    e.interpolate(1, 16);
    const sx = e.shadow.x;
    const sy = e.shadow.y;

    e.nudge(0.25, -0.125);
    e.nudge(0.25, -0.125); // twice in one frame: still one shift, not two
    expect([e.x, e.y]).toEqual([100.25, 49.875]);
    expect([e.shadow.x, e.shadow.y]).toEqual([sx + 0.25, sy - 0.125]);

    e.interpolate(1, 16);
    expect([e.x, e.y, e.shadow.x, e.shadow.y]).toEqual([100, 50, sx, sy]);
  });
});
