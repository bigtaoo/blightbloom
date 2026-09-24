/**
 * Melee sector parity — the drawn arc against the swing that actually connects.
 *
 * Same shape, and the same reason, as `render/muzzleParity.test.ts`: the melee sector exists
 * TWICE and nothing cross-checked the two.
 *
 *   SIM    `arcDeg`/`rangeGrid` per weapon (`engine/content/weaponSpecs/*.ts`) → `MeleeSimSpec
 *          .arcHalf`/`.range` (brad + fp) → `HitResolveSystem`'s melee arc, and `DeflectSystem`'s
 *          parry, which read the identical two fields.
 *   RENDER `EventReactor.slashSector` converts those same two fields (brad→rad, fp→px) into a
 *          `SlashArcPose` → `SlashArc`'s triangle strip → the light the player actually judges
 *          their reach by.
 *
 * Nothing errors when they disagree, and the failure is the worst kind: the fx would be
 * confidently, precisely wrong. A player reads the drawn edge, steps to it, swings, and misses —
 * or backs off a bullet they could have parried, since the deflect sector is this same arc. Every
 * existing test covers one side (`slashArc.test.ts` the geometry, engine `systems.test.ts` the
 * hit) and the conversion in between was asserted only against numbers restated by hand.
 *
 * ## The two boundaries, and why only one of them is exact
 *
 * ANGULAR: the engine tests the angle to the target's CENTRE against `arcHalf` with no slack, so
 * the drawn edge and the hit edge are the same line. Asserted as such below — a probe a degree
 * inside connects, a degree outside does not, and the drawn wedge's own edge sits between them.
 *
 * RADIAL: `meleeArc` reaches `spec.range + target.radius` (bodies, not points), while the arc is
 * drawn at `range` alone — the reach from the actor's centre, which is what the spec's own field
 * means. So the drawn edge is deliberately CONSERVATIVE by exactly one target radius: a player
 * standing at the lit edge always connects. This file pins that gap to the target's radius rather
 * than to a number, so the arc can never quietly start over-promising.
 */
import { describe, it, expect } from 'vitest';
import { toFp } from '@dd/engine/math/fixed';
import type { Brad } from '@dd/engine/math/trig';
import { createGameState, type GameState } from '@dd/engine/state/GameState';
import { ENEMY_TEAM_ID, type EnemyActor, type MeleeSimSpec } from '@dd/engine/state/entities';
import { makeWeapon, openSwing, WEAPON_SIM_BY_ID } from '@dd/engine/content/weapons';
import { HitResolveSystem } from '@dd/engine';
import { pxToFp } from '@dd/engine/content/convert';
import { freshStatus } from '@dd/engine/content/damage';
import { BASIC_ENEMY } from '@dd/engine/content/enemies';
import { fpToPx, bradToRad } from '../coords';
import { SlashArc, ARC_SEGMENTS, type SlashArcPose } from './slashArc';
import { RigSkin } from '../../render/RigSkin';
import { Rig } from '../../render/Rig';
import { ORB_CORE_RIG } from '../../render/orbCoreRig';
import { facingFromAngle } from '../../render/facing';
import { swingSchedule } from '../../render/rigAttackMotion';
import { swingShapeOf } from '../controllers/attackShapes';
import { Texture } from 'pixi.js';
import type { RigSkinBundle } from '../../render/taoBundle';
import type { SpriteBinding } from '../../render/types';

const MELEE = Object.entries(WEAPON_SIM_BY_ID)
  .filter((entry): entry is [string, MeleeSimSpec] => entry[1].kind === 'melee');

const CFG = { seed: 7, worldW: 1600, worldH: 1200, waves: [] as const };
/** Where `createGameState` puts seat 0, in px — every probe below is polar from here. */
const ORIGIN_PX = { x: 800, y: 600 };

/** Hand-built like `engine/systems/systems.test.ts`'s own fixture, for direct control over the
 *  spawn position — which is the entire point of a probe. */
function addEnemy(s: GameState, xpx: number, ypx: number): EnemyActor {
  const e: EnemyActor = {
    id: s.nextId(), faction: 'enemy', teamId: ENEMY_TEAM_ID,
    gx: pxToFp(xpx), gy: pxToFp(ypx), z: toFp(0), vx: toFp(0), vy: toFp(0),
    knockVx: toFp(0), knockVy: toFp(0),
    facing: 0 as Brad, hp: 99, maxHp: 99, shield: 0, maxShield: 0,
    ticksSinceHit: 0, radius: BASIC_ENEMY.radius,
    footprintRadius: BASIC_ENEMY.footprintRadius, solidRadius: BASIC_ENEMY.radius,
    alive: true, weapon: null, firing: false, status: freshStatus(), enraged: false, armorBroken: false, aggroed: false, holding: false,
  };
  s.enemies.push(e);
  return e;
}

/**
 * Does one swing of `spec` connect with a body at polar (`rPx`, `angleRad`) from the swinger?
 *
 * The real `HitResolveSystem`, not a restatement of its predicate — a copied inequality would
 * agree with the drawn arc and with itself while both drifted away from the shipped sim.
 */
function connects(spec: MeleeSimSpec, rPx: number, angleRad: number): boolean {
  const s = createGameState(CFG);
  const p = s.players[0]!;
  p.weapon = makeWeapon(spec);
  // `openSwing`, not a bare `justSwung = true`: since ENGINE_VERSION 53 a swing is a WINDOW
  // (`swingTicksLeft`, design/07 step 7) and the latch alone opens nothing, so a hand-staged
  // swing that sets only the latch silently connects with nobody — which is what this probe
  // read as "the sector does not hit" for all seven weapons.
  openSwing(p.weapon);
  p.facing = 0 as Brad; // due east, so a probe's angle IS its offset from the facing
  const target = addEnemy(
    s,
    ORIGIN_PX.x + Math.cos(angleRad) * rPx,
    ORIGIN_PX.y + Math.sin(angleRad) * rPx,
  );
  new HitResolveSystem().tick(s);
  return target.hp < 99;
}

/** The pose `EventReactor.slashSector` builds, for a weapon and an aim. */
function poseOf(spec: MeleeSimSpec, facingRad: number): SlashArcPose {
  // The shipped conversion (`EventReactor.swingShapeOf`), not a restatement of it — this file
  // exists to catch two tables drifting apart, so it must not carry a third copy of one.
  const schedule = swingSchedule(swingShapeOf(spec));
  return {
    x: 0, y: 0,
    facingRad,
    arcHalfRad: bradToRad(spec.arcHalf),
    innerPx: fpToPx(pxToFp(16)),
    outerPx: fpToPx(spec.range),
    color: 0xffffff,
    flipX: facingFromAngle(facingRad).flipX,
    delayMs: schedule.strikeStartMs,
    sweepMs: schedule.strikeEndMs - schedule.strikeStartMs,
    fadeMs: (schedule.strikeEndMs - schedule.strikeStartMs) * 2,
  };
}

/** The sector a fully-swept arc actually covers, read off its own vertex buffer. */
function drawnSector(spec: MeleeSimSpec, facingRad = 0): { edges: number[]; outerPx: number } {
  const pose = poseOf(spec, facingRad);
  const arc = new SlashArc(pose);
  arc.advance(pose.delayMs + pose.sweepMs);
  const p = arc.geometry.positions;
  const at = (i: number): { ang: number; r: number } => ({
    ang: Math.atan2(p[i * 4 + 3]!, p[i * 4 + 2]!),
    r: Math.hypot(p[i * 4 + 2]!, p[i * 4 + 3]!),
  });
  const first = at(0), last = at(ARC_SEGMENTS);
  return { edges: [first.ang, last.ang].sort((a, b) => a - b), outerPx: last.r };
}

describe('the drawn sector and the sector that hits are the same sector', () => {
  it.each(MELEE)('%s: a body a degree inside the drawn edge connects, a degree outside misses', (_id, spec) => {
    const { edges } = drawnSector(spec);
    const rPx = fpToPx(spec.range) * 0.6; // comfortably inside the reach — this probes the ANGLE
    const nudge = (2 * Math.PI) / 180;
    for (const edge of edges) {
      const inward = Math.sign(-edge) || 1; // toward the facing (0), whichever side this edge is
      expect(connects(spec, rPx, edge + inward * nudge)).toBe(true);
      expect(connects(spec, rPx, edge - inward * nudge)).toBe(false);
    }
  });

  it.each(MELEE)('%s: the drawn edge is exactly the weapon own arcHalf, both sides of the aim', (_id, spec) => {
    // The conversion this pins is brad→rad. It has one plausible wrong answer that looks right on
    // screen (half the sector, i.e. forgetting that `arcHalf` is ALREADY half) and this catches it.
    const { edges } = drawnSector(spec);
    const half = bradToRad(spec.arcHalf);
    // 5 decimals, not more: the vertex buffer is a `Float32Array`, so ~7 significant digits is
    // the precision that physically exists here. Still three orders of magnitude tighter than
    // the "half of the sector" mistake this is aimed at.
    expect(edges[0]!).toBeCloseTo(-half, 5);
    expect(edges[1]!).toBeCloseTo(half, 5);
  });

  it.each(MELEE)('%s: the drawn reach under-promises by exactly one target radius, never over', (_id, spec) => {
    // The one place the two are deliberately NOT equal (see this file's header). Asserted as a
    // relationship, so it stays true if either the reach or the enemy body is retuned.
    const drawn = drawnSector(spec).outerPx;
    const slack = fpToPx(BASIC_ENEMY.radius);
    expect(drawn).toBeCloseTo(fpToPx(spec.range), 3); // Float32 positions — see the note above
    // A body centred just inside the DRAWN edge always connects — the direction of the error that
    // matters, since this is the line the player reads.
    expect(connects(spec, drawn - 1, 0)).toBe(true);
    // ...and the hit boundary sits one target radius further out, not somewhere else entirely.
    expect(connects(spec, drawn + slack - 1, 0)).toBe(true);
    expect(connects(spec, drawn + slack + 1, 0)).toBe(false);
  });

  it('a swing behind the actor connects with nothing, however wide the weapon', () => {
    // The 220° hammer's sector is wide enough that "the arc is basically a circle" would pass
    // every per-edge case above and still be wrong. Directly behind is outside every weapon here.
    for (const [id, spec] of MELEE) {
      expect(connects(spec, fpToPx(spec.range) * 0.5, Math.PI), id).toBe(false);
      const { edges } = drawnSector(spec);
      expect(edges[1]! - edges[0]!, id).toBeLessThan(2 * Math.PI * 0.62); // 220° is the widest
    }
  });
});

function makeRigSkin(): RigSkin {
  const rig = new Rig(ORB_CORE_RIG);
  const bindings = new Map<string, SpriteBinding>();
  const textures = new Map<string, Texture>();
  for (const boneId of rig.drawOrder) {
    bindings.set(boneId, { anchorX: 0.5, anchorY: 0.5, flipX: false, zOrder: 0, rotation: 0, scaleX: 1, scaleY: 1 });
    textures.set(boneId, Texture.WHITE);
  }
  const bundle: RigSkinBundle = { bindings, clips: new Map(), textures };
  return new RigSkin(rig, bundle);
}

/** The blade's WORLD angle this frame: the aim-tracking socket's own rotation, un-mirrored by the
 *  rig's `scale.x` the way the screen does it (`facing.canonicalAimRad`'s inverse). */
function bladeWorldAngle(skin: RigSkin, boneId = 'socket_r'): number {
  skin.update();
  const sprites = (skin as unknown as { sprites: Map<string, { rotation: number }> }).sprites;
  const local = sprites.get(boneId)!.rotation;
  return skin.view.scale.x === 1 ? local : Math.PI - local;
}

describe('the drawn sector sweeps the same way the blade does', () => {
  // The half of the fx a screenshot cannot check and a live measurement can only check one side
  // of: the arc takes `flipX` from `facingFromAngle`, while the rig applies its swing in canonical
  // (pre-mirror) space and lets `view.scale.x` reverse it. Those are two independent paths to one
  // decision, so they are exactly the pair `rigComposition.test.ts` would call "did the parts that
  // belong together move together". If they disagree, every left-facing swing has the light
  // running one way and the blade the other.
  const spec = WEAPON_SIM_BY_ID.hammer as MeleeSimSpec;

  /** Which way (in world radians) the arc's leading edge travels over its sweep. */
  function arcDirection(facingRad: number): number {
    const pose = poseOf(spec, facingRad);
    const arc = new SlashArc(pose);
    arc.advance(pose.delayMs + pose.sweepMs * 0.25);
    const early = arc.geometry.positions;
    const head = (p: Float32Array): number => {
      // The blade is the last column whose angle still differs from its neighbour's — beyond it
      // every column is collapsed onto the head (`SlashArc.writeSweep`).
      let best = 0;
      for (let i = 1; i <= ARC_SEGMENTS; i++) {
        const a = Math.atan2(p[i * 4 + 3]!, p[i * 4 + 2]!);
        const prev = Math.atan2(p[(i - 1) * 4 + 3]!, p[(i - 1) * 4 + 2]!);
        if (Math.abs(a - prev) > 1e-6) best = i;
      }
      return Math.atan2(p[best * 4 + 3]!, p[best * 4 + 2]!);
    };
    const from = head(early.slice() as Float32Array);
    arc.advance(pose.sweepMs * 0.5);
    const to = head(arc.geometry.positions.slice() as Float32Array);
    return Math.sign(((to - from + 3 * Math.PI) % (2 * Math.PI)) - Math.PI) || 1;
  }

  /** Which way the RIG's blade travels over the same window. */
  function bladeDirection(facingRad: number): number {
    const skin = makeRigSkin();
    skin.setBodyFacing(facingRad);
    skin.setAim(facingRad);
    skin.attack('melee', swingShapeOf(spec));
    const schedule = swingSchedule(swingShapeOf(spec));
    skin.advanceClips(schedule.strikeStartMs);
    const from = bladeWorldAngle(skin);
    skin.advanceClips((schedule.strikeEndMs - schedule.strikeStartMs) * 0.75);
    const to = bladeWorldAngle(skin);
    return Math.sign(((to - from + 3 * Math.PI) % (2 * Math.PI)) - Math.PI) || 1;
  }

  it('runs with the blade for a right-facing swing', () => {
    expect(arcDirection(0)).toBe(bladeDirection(0));
  });

  it('runs with the blade for a left-facing swing — the mirrored case', () => {
    // The whole reason `flipX` is in `SlashArcPose`. Drop it and this is the case that breaks,
    // while the right-facing one above keeps passing.
    expect(arcDirection(Math.PI)).toBe(bladeDirection(Math.PI));
  });

  it('and the two directions really are opposite between the two facings', () => {
    // A control: if `arcDirection` returned a constant, both cases above would pass for nothing.
    expect(arcDirection(0)).toBe(-arcDirection(Math.PI));
  });
});
