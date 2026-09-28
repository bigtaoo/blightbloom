import { Graphics, type Container } from 'pixi.js';
import type { BoneDef, ResolvedBoneTransform, WorldPositions } from './types';

// Split out of RigSkin.ts (2026-08-19, 500-line convention): the glowing energy tether every
// orbiting bone hangs off. Same category as `rigShading.ts` — a mark the rig DRAWS on top of
// its authored art rather than a bone sprite — and moved for the same reason: RigSkin was at
// 488 lines and the volume pass needed room for the module contact shades.
//
// design/13's "two weapon modules that orbit it on glowing energy tethers", design/12's "each
// of the two sockets orbits the core on a tether". Drawn, not authored, because the tether's
// length and angle are pure rig geometry: it spans a bone's pivot (the core's centre) to its
// tip (where that bone's module sprite sits), so it has to follow FK every frame. A bone opts
// in by declaring the `outerW`/`innerW` stroke widths the editor's own skeleton view already
// uses for a tubular bone (orb-core's socket_l/socket_r, boss-core's ring_a/ring_b); every
// other bone (shell/eye/belly, an enemy's single body bone) leaves them undefined and draws
// no tether.
const TETHER_COLOR = 0x8fe9ff;
/** Perpendicular sag of the tether's arc, as a fraction of its length — the concept
 *  turnaround draws it as a slack curve bowing away from the core, not a straight rod. */
const TETHER_SAG = 0.22;

/** Whether this rig has any tethered bone at all, i.e. whether to allocate the Graphics. */
export function hasTetheredBone(boneDefs: readonly BoneDef[]): boolean {
  return boneDefs.some((b) => b.outerW && b.innerW);
}

/** A tether is rebuilt only when its length moves by more than this (authoring px). */
const TETHER_REBUILD_EPS = 0.05;

/** What one tether Graphics last BUILT — its geometry, not where it sits. */
interface BuiltTether {
  len: number;
  side: 1 | -1;
}
const built = new WeakMap<Graphics, BuiltTether>();

/**
 * Pose the glowing tether of every orbiting bone: an arc from the bone's pivot on the core out to
 * the module sitting at its tip. `layer` holds one child Graphics per tethered bone, in
 * `boneDefs` order, created on first use.
 *
 * **Geometry once, transform per frame (2026-09-28).** A tether's SHAPE depends only on its length
 * and which side it bows to: the sag is a fixed fraction of the length and the bow follows the
 * segment's own normal. So each arc is built in a local frame, pivot at the origin and tip at
 * `(len, 0)`, and the pose is its position and rotation. A bone's length does not change under FK,
 * so an orbiting module rebuilds nothing; the old version cleared and re-stroked both curves
 * every frame a clip moved the sockets (every frame of the idle hover, in practice), and that was
 * the single largest source of per-frame garbage in a run (~41 KB a frame on the player alone).
 *
 * The endpoints are still signed so a pose that did not move skips even the transform writes;
 * returns the signature to remember, and `lastSignature` is the previous one.
 */
export function drawTethers(
  layer: Container,
  boneDefs: readonly BoneDef[],
  worldPose: WorldPositions,
  transforms: Map<string, ResolvedBoneTransform>,
  lastSignature: string,
  tint: number,
): string {
  layer.tint = tint;
  let signature = '';
  for (const bone of boneDefs) {
    if (!bone.outerW || !bone.innerW) continue;
    const pose = worldPose.get(bone.id);
    if (!pose) continue;
    const alpha = transforms.get(bone.id)?.alpha ?? 1;
    signature += `${pose.sx.toFixed(1)},${pose.sy.toFixed(1)},${pose.ex.toFixed(1)},${pose.ey.toFixed(1)},${alpha.toFixed(2)};`;
  }
  if (signature === lastSignature) return signature;

  let i = 0;
  for (const bone of boneDefs) {
    if (!bone.outerW || !bone.innerW) continue;
    const g = tetherAt(layer, i++);
    const pose = worldPose.get(bone.id);
    const alpha = transforms.get(bone.id)?.alpha ?? 1;
    const dx = pose ? pose.ex - pose.sx : 0;
    const dy = pose ? pose.ey - pose.sy : 0;
    const len = Math.hypot(dx, dy);
    if (!pose || alpha <= 0 || len < 1) {
      g.visible = false;
      continue;
    }
    // The bow goes to one consistent side (down, in the rig's own y-down space) whichever way the
    // bone points — the segment's normal is (-dy, dx)/len, so that side is the sign of dx.
    const side: 1 | -1 = dx / len >= 0 ? 1 : -1;
    const b = built.get(g);
    if (!b || b.side !== side || Math.abs(b.len - len) > TETHER_REBUILD_EPS) {
      buildTether(g, len, side, bone.outerW, bone.innerW);
      built.set(g, { len, side });
    }
    g.visible = true;
    g.position.set(pose.sx, pose.sy);
    g.rotation = Math.atan2(dy, dx);
    g.alpha = alpha;
  }
  return signature;
}

/** The `i`th tether Graphics of `layer`, created if this is the first time it is needed. */
function tetherAt(layer: Container, i: number): Graphics {
  while (layer.children.length <= i) layer.addChild(new Graphics());
  return layer.children[i] as Graphics;
}

/** One tether in its local frame: pivot at the origin, tip at `(len, 0)`, control point the
 *  midpoint pushed `TETHER_SAG * len` along the normal. Two passes over the same curve: a wide
 *  soft halo, then the bright core line. Alpha is the Graphics' own, so a fading module fades
 *  both passes without a rebuild. */
function buildTether(g: Graphics, len: number, side: 1 | -1, outerW: number, innerW: number): void {
  const cx = len / 2;
  const cy = side * len * TETHER_SAG;
  g.clear();
  g.moveTo(0, 0).quadraticCurveTo(cx, cy, len, 0)
    .stroke({ color: TETHER_COLOR, width: outerW, alpha: 0.3, cap: 'round' });
  g.moveTo(0, 0).quadraticCurveTo(cx, cy, len, 0)
    .stroke({ color: TETHER_COLOR, width: innerW, alpha: 0.9, cap: 'round' });
}

/** The tether hue, exported so `RigSkin` can keep its untinted default in sync with the
 *  colour the strokes are actually drawn in. */
export { TETHER_COLOR };
