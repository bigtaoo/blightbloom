/**
 * `rigTethers` — the glowing energy tether every orbiting bone hangs off (design/12/13). Split out
 * of `RigSkin.ts` on 2026-08-19 to make room under the 500-line convention; `RigSkin.test.ts`
 * covers how it is wired into a rig, this file covers the free function's own contract.
 *
 * Two optimisations with a correctness face are pinned here. The SIGNATURE memoization: wrong one
 * way, a hovering idle does work every frame for nothing; wrong the other, a tether freezes where
 * it was while the module it connects to keeps orbiting. And GEOMETRY ONCE (2026-09-28): each arc
 * is built in a local frame and posed by transform, so these tests check where the drawn curve
 * actually LANDS (its local tip pushed through its transform), not only that something was drawn.
 */
import { describe, it, expect, vi } from 'vitest';
import { Container, type Graphics } from 'pixi.js';
import { drawTethers, hasTetheredBone, TETHER_COLOR } from './rigTethers';
import { Rig } from './Rig';
import { ORB_CORE_RIG } from './orbCoreRig';
import { CRITTER_CORE_RIG } from './critterCoreRig';
import { BOSS_CORE_RIG } from './bossCoreRig';
import type { ResolvedBoneTransform, WorldPositions } from './types';

const NO_TRANSFORMS = new Map<string, ResolvedBoneTransform>();

function poseOf(def = ORB_CORE_RIG, transforms = NO_TRANSFORMS): WorldPositions {
  return new Rig(def).computeFK(0, 0, transforms);
}

interface Instr {
  action: string;
  data: { style?: { color: number; alpha: number; width: number } };
}
/** The tethers that are showing. */
const tethersOf = (layer: Container): Graphics[] => (layer.children as Graphics[]).filter((g) => g.visible);
/** Every stroke of every showing tether, with the Graphics' own alpha folded in — what reaches the
 *  screen, since a tether's clip alpha now lives on its Graphics rather than in its strokes. */
const strokes = (layer: Container): Array<{ color: number; alpha: number; width: number }> =>
  tethersOf(layer).flatMap((g) =>
    (g.context.instructions as Instr[])
      .filter((i) => i.action === 'stroke')
      .map((i) => ({ ...i.data.style!, alpha: i.data.style!.alpha * g.alpha })),
  );

/** Where a tether's LOCAL point lands in rig space, through its own position and rotation. */
function landed(g: Graphics, x: number, y: number): { x: number; y: number } {
  const c = Math.cos(g.rotation);
  const s = Math.sin(g.rotation);
  return { x: g.x + x * c - y * s, y: g.y + x * s + y * c };
}
/** A tether's drawn tip in rig space. Locally the curve runs from the origin to `(len, 0)`, so its
 *  bounds reach `len` plus half the widest stroke; read back rather than recomputed. */
function tipOf(g: Graphics): { x: number; y: number } {
  const widest = Math.max(...(g.context.instructions as Instr[]).filter((i) => i.action === 'stroke').map((i) => i.data.style!.width));
  return landed(g, g.context.bounds.maxX - widest / 2, 0);
}

/** A transform map with only `alpha` set for one bone, the rest at their neutral values. */
function alphaOnly(boneId: string, alpha: number): Map<string, ResolvedBoneTransform> {
  return new Map([[boneId, { rotation: 0, scaleX: 1, scaleY: 1, translateX: 0, translateY: 0, alpha }]]);
}

describe('hasTetheredBone — which rigs pay for a tether Graphics at all', () => {
  it('is true for the rigs whose bones declare the tube widths, false for the rest', () => {
    // A bone opts in by declaring `outerW`/`innerW`: orb-core's two sockets, boss-core's two
    // rings. A one-bone critter has no orbiting anything and must not allocate a Graphics.
    expect(hasTetheredBone(new Rig(ORB_CORE_RIG).boneDefs)).toBe(true);
    expect(hasTetheredBone(new Rig(BOSS_CORE_RIG).boneDefs)).toBe(true);
    expect(hasTetheredBone(new Rig(CRITTER_CORE_RIG).boneDefs)).toBe(false);
  });

  it('needs BOTH widths — a half-declared bone is not a tether', () => {
    const half = new Rig({
      ...ORB_CORE_RIG,
      bones: ORB_CORE_RIG.bones.map((b) => (b.outerW ? { ...b, innerW: undefined } : b)),
    });
    expect(hasTetheredBone(half.boneDefs)).toBe(false);
  });
});

describe('drawTethers — two passes per orbiting bone', () => {
  it('strokes a wide soft halo and a bright core line per tether, in the tether hue', () => {
    const layer = new Container();
    drawTethers(layer, new Rig(ORB_CORE_RIG).boneDefs, poseOf(), NO_TRANSFORMS, '', 0xffffff);
    expect(tethersOf(layer)).toHaveLength(2); // one per socket
    const s = strokes(layer);
    expect(s).toHaveLength(4); // 2 sockets x (halo + core)
    for (const stroke of s) expect(stroke.color).toBe(TETHER_COLOR);
    // Within each pair the halo is wider and fainter than the core it surrounds.
    expect(s[0]!.width).toBeGreaterThan(s[1]!.width);
    expect(s[0]!.alpha).toBeLessThan(s[1]!.alpha);
  });

  it("runs each tether from its bone's pivot to the module at its tip", () => {
    const layer = new Container();
    const pose = poseOf();
    drawTethers(layer, new Rig(ORB_CORE_RIG).boneDefs, pose, NO_TRANSFORMS, '', 0xffffff);
    const ends = ['socket_l', 'socket_r'].map((id) => pose.get(id)!);
    tethersOf(layer).forEach((g, i) => {
      expect(g.x).toBeCloseTo(ends[i]!.sx, 6);
      expect(g.y).toBeCloseTo(ends[i]!.sy, 6);
      const tip = tipOf(g);
      expect(tip.x).toBeCloseTo(ends[i]!.ex, 1); // within 0.05 px: the round caps pad the bounds only approximately
      expect(tip.y).toBeCloseTo(ends[i]!.ey, 1); // within 0.05 px: the round caps pad the bounds only approximately
    });
  });

  it('bows to the same side in rig space the per-frame version did, whichever way the bone points', () => {
    // The old code pushed the midpoint along the segment normal (-dy, dx)/len, times the sign of
    // that normal's y (= the sign of dx) — so in rig space the bow always lands on +y of the chord.
    for (const rot of [0, 180, 60, -60, 120, -120]) {
      const t = new Map<string, ResolvedBoneTransform>([
        ['socket_r', { rotation: rot, scaleX: 1, scaleY: 1, translateX: 0, translateY: 0, alpha: 1 }],
      ]);
      const layer = new Container();
      const pose = poseOf(ORB_CORE_RIG, t);
      drawTethers(layer, new Rig(ORB_CORE_RIG).boneDefs, pose, t, '', 0xffffff);
      const g = tethersOf(layer)[1]!;
      const p = pose.get('socket_r')!;
      const dx = p.ex - p.sx;
      const dy = p.ey - p.sy;
      const len = Math.hypot(dx, dy);
      const side = dx / len >= 0 ? 1 : -1;
      // Where the old code put the control point, in rig space.
      const want = { x: p.sx + dx / 2 + (-dy / len) * side * len * 0.22, y: p.sy + dy / 2 + (dx / len) * side * len * 0.22 };
      // Where the new tether's local control point lands.
      const got = landed(g, len / 2, side * len * 0.22);
      expect(got.x, `rotation ${rot}`).toBeCloseTo(want.x, 3);
      expect(got.y, `rotation ${rot}`).toBeCloseTo(want.y, 3);
      expect(want.y, `rotation ${rot}`).toBeGreaterThanOrEqual((p.sy + p.ey) / 2 - 1e-9);
    }
  });

  it("applies the caller's tint, so a re-tinted body's tethers read in its own hue", () => {
    const layer = new Container();
    drawTethers(layer, new Rig(ORB_CORE_RIG).boneDefs, poseOf(), NO_TRANSFORMS, '', 0xff3366);
    expect(layer.tint).toBe(0xff3366);
  });

  it('draws nothing for a rig with no tethered bone', () => {
    const layer = new Container();
    drawTethers(layer, new Rig(CRITTER_CORE_RIG).boneDefs, poseOf(CRITTER_CORE_RIG), NO_TRANSFORMS, '', 0xffffff);
    expect(layer.children).toHaveLength(0);
  });

  it('hides a bone the clip has faded to nothing', () => {
    const layer = new Container();
    const t = alphaOnly('socket_r', 0);
    drawTethers(layer, new Rig(ORB_CORE_RIG).boneDefs, poseOf(ORB_CORE_RIG, t), t, '', 0xffffff);
    expect(strokes(layer)).toHaveLength(2); // socket_l only
  });

  it("scales both passes by the bone's clip alpha, so a fading module fades its tether", () => {
    const layer = new Container();
    const t = alphaOnly('socket_r', 0.5);
    drawTethers(layer, new Rig(ORB_CORE_RIG).boneDefs, poseOf(ORB_CORE_RIG, t), t, '', 0xffffff);
    const s = strokes(layer);
    expect(s.filter((x) => x.alpha > 0.5)).toHaveLength(1); // socket_l's core line at 0.9
    expect(s.filter((x) => x.alpha <= 0.5)).toHaveLength(3);
  });
});

describe('drawTethers — the signature memoization', () => {
  it('returns a signature, and the SAME one for an unchanged pose', () => {
    const bones = new Rig(ORB_CORE_RIG).boneDefs;
    const first = drawTethers(new Container(), bones, poseOf(), NO_TRANSFORMS, '', 0xffffff);
    const second = drawTethers(new Container(), bones, poseOf(), NO_TRANSFORMS, '', 0xffffff);
    expect(first).not.toBe('');
    expect(second).toBe(first);
  });

  it('skips all work when handed back its own signature — a still idle costs one compare', () => {
    // Detected by a MARKER: a pose write would put the tether back on its pivot, so if the
    // displaced position survives, the call really did return early.
    const bones = new Rig(ORB_CORE_RIG).boneDefs;
    const layer = new Container();
    const sig = drawTethers(layer, bones, poseOf(), NO_TRANSFORMS, '', 0xffffff);
    tethersOf(layer)[0]!.x = 999;
    drawTethers(layer, bones, poseOf(), NO_TRANSFORMS, sig, 0xffffff);
    expect(tethersOf(layer)[0]!.x).toBe(999);
  });

  it('DOES follow once the pose moves, which is the half that must not be optimised away', () => {
    const bones = new Rig(ORB_CORE_RIG).boneDefs;
    const moved = new Map<string, ResolvedBoneTransform>([
      ['socket_r', { rotation: 40, scaleX: 1, scaleY: 1, translateX: 0, translateY: 0, alpha: 1 }],
    ]);
    const layer = new Container();
    const sig = drawTethers(layer, bones, poseOf(), NO_TRANSFORMS, '', 0xffffff);
    const pose = poseOf(ORB_CORE_RIG, moved);
    const after = drawTethers(layer, bones, pose, moved, sig, 0xffffff);
    expect(after).not.toBe(sig);
    const tip = tipOf(tethersOf(layer)[1]!);
    expect(tip.x).toBeCloseTo(pose.get('socket_r')!.ex, 1); // within 0.05 px: the round caps pad the bounds only approximately
    expect(tip.y).toBeCloseTo(pose.get('socket_r')!.ey, 1); // within 0.05 px: the round caps pad the bounds only approximately
    expect(strokes(layer)).toHaveLength(4); // not doubled
  });

  it('folds the clip ALPHA into the signature too, not just the endpoints', () => {
    // A module fading out while its bones stay put still has to repaint, or the tether hangs on
    // at full brightness attached to nothing.
    const bones = new Rig(ORB_CORE_RIG).boneDefs;
    const sig = drawTethers(new Container(), bones, poseOf(), NO_TRANSFORMS, '', 0xffffff);
    const t = alphaOnly('socket_r', 0.3);
    const faded = drawTethers(new Container(), bones, poseOf(ORB_CORE_RIG, t), t, sig, 0xffffff);
    expect(faded).not.toBe(sig);
  });
});

describe('drawTethers — geometry once, transform per frame', () => {
  /** Poses socket_r at `rot` degrees; returns the signature. */
  function orbit(layer: Container, rot: number, sig = ''): string {
    const t = new Map<string, ResolvedBoneTransform>([
      ['socket_r', { rotation: rot, scaleX: 1, scaleY: 1, translateX: 0, translateY: 0, alpha: 1 }],
    ]);
    return drawTethers(layer, new Rig(ORB_CORE_RIG).boneDefs, poseOf(ORB_CORE_RIG, t), t, sig, 0xffffff);
  }

  it("an orbiting module rebuilds NO geometry — the whole point: it was the run's biggest garbage source", () => {
    const layer = new Container();
    let sig = orbit(layer, 0);
    const g = tethersOf(layer)[1]!;
    const clear = vi.spyOn(g, 'clear');
    const angles: number[] = [];
    for (let rot = 5; rot <= 60; rot += 5) {
      sig = orbit(layer, rot, sig);
      angles.push(g.rotation);
    }
    expect(clear).not.toHaveBeenCalled();
    expect(new Set(angles).size).toBe(angles.length); // ...while it really did move every time
  });

  it('rebuilds when the bow has to flip sides', () => {
    const layer = new Container();
    const sig = orbit(layer, 0);
    const g = tethersOf(layer)[1]!;
    const clear = vi.spyOn(g, 'clear');
    orbit(layer, 180, sig); // points the other way: the side flips
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it('rebuilds when the length changes, not only when it rotates', () => {
    const bones = new Rig(ORB_CORE_RIG).boneDefs;
    const layer = new Container();
    const pose = poseOf();
    drawTethers(layer, bones, pose, NO_TRANSFORMS, '', 0xffffff);
    const g = tethersOf(layer)[1]!;
    const clear = vi.spyOn(g, 'clear');
    const p = pose.get('socket_r')!;
    const longer = new Map(pose);
    longer.set('socket_r', { ...p, ex: p.sx + (p.ex - p.sx) * 1.5, ey: p.sy + (p.ey - p.sy) * 1.5 });
    drawTethers(layer, bones, longer, NO_TRANSFORMS, '', 0xffffff);
    expect(clear).toHaveBeenCalledTimes(1);
    const tip = tipOf(g);
    expect(tip.x).toBeCloseTo(longer.get('socket_r')!.ex, 1); // within 0.05 px: the round caps pad the bounds only approximately
    expect(tip.y).toBeCloseTo(longer.get('socket_r')!.ey, 1); // within 0.05 px: the round caps pad the bounds only approximately
  });

  it('never accumulates children or strokes across many repaints of a moving rig', () => {
    const layer = new Container();
    let sig = '';
    for (let i = 1; i <= 12; i++) sig = orbit(layer, i * 30, sig);
    expect(layer.children).toHaveLength(2);
    expect(strokes(layer)).toHaveLength(4);
  });
});
