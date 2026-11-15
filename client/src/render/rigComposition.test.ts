/// <reference types="node" />
/**
 * Assembly invariants over every SHIPPED skin bundle — "is the character put together
 * correctly", checked against the real files in `client/public/skins/`.
 *
 * WHY THIS FILE EXISTS. The hero rig rendered visibly disassembled for ~3 weeks (art drawn
 * at each bone's pivot instead of its tip, and rotated by the bone's raw world angle) while
 * 1272 client tests stayed green and a full coverage audit passed. Two reasons the existing
 * tests could not see it, both of which this file is built to avoid:
 *
 *   1. They asserted the ONE number a past bug taught someone to assert — the weapon
 *      socket's aim rotation — and nothing about where any sprite actually SAT.
 *   2. `RigSkin.test.ts`/`Actor.test.ts` run on a FAKE bundle (`Texture.WHITE`, every
 *      binding scale 1) and hardcode expected coordinates. That pins the renderer against
 *      the same mental model that produced the bug, and says nothing about the real
 *      `animation.json` files the game actually loads.
 *
 * So: real bundles, real rigs, real `RigSkin`, and RELATIONSHIPS rather than restated
 * coordinates — a part is on the body, an arm is off it, no two parts occupy one point, art
 * is scaled to the bone it's bound to. Every check here is mutation-verified: reverting
 * either half of the 2026-08-17 placement fix fails a named subset of them (see the counts
 * in ROADMAP's entry), and they hold for all 7 shipped bundles rather than one.
 *
 * Deliberately NOT here: anything requiring real pixels (is the eye inside the shell's
 * painted eye socket, does the art LOOK right). That still needs a live render — see
 * design/12. These are the strongest checks that survive in a canvas-free vitest run.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Texture } from 'pixi.js';
import { BASIC_ENEMY, BLASTER_SIM, PLAYER_BASE } from '@dd/engine';
import { fpToPx } from '../game/coords';
import { BODY_FILL, BODY_FILL_DEFAULT, RIG_DEFS } from './skinRegistry';
import { CHAR_BUNDLES } from './preloadArt';
import { RigSkin } from './RigSkin';
import { deserializeClip, type AnimationJson } from './taoBundle';
import { sampleClip } from './interpolate';
import { KIND_DEFAULTS, WEAPON_DEFS, MODULE_SCALE, type WeaponVisualDef } from './weaponSkins';
import { ACTIVE_WEAPON_SOCKET, HELD_MOUNT_R, barrelReach, resolveWeaponMount } from './rigWeaponMount';
import { preloadWeaponSkins } from './weaponSkins';
import { RECOIL_BODY_PX, RECOIL_MODULE_PX } from './rigAttackMotion';
import { ATTACK_CLIP, DEATH_CLIP, HURT_CLIP, SPAWN_CLIP } from './rigClipLayer';
import { DISSOLVE_MS } from '../game/scene/actorFilters';
import type { Rig } from './Rig';
import type { RigSkinBundle } from './taoBundle';
import type { AnimationClip, BoneDef, ResolvedBoneTransform, SpriteBinding, WorldPose } from './types';

// `Assets.load` would hit the network. Stubbed the way `muzzleParity.test.ts` stubs it —
// spread over the real module so every other pixi export (this file builds real `Texture`s and
// real `RigSkin`s) stays real. Needed at all because `getWeaponTexture` returns undefined
// until a weapon is in the preload cache, and an unmounted module cannot be checked for being
// attached to anything; caching it is also what makes `weaponSkins.resolve()` hand back the
// weapon's OWN calibration instead of falling back to the kind default.
//
// `Texture.WHITE` rather than the PNG's real size, unlike muzzleParity's stub: a module's
// POSITION — the only thing the assembly sweep below asserts — is its mount's, and the texture
// only sets what is drawn AT that point (anchor, scale, and the barrel reach measured from it).
// Anything texture-derived is muzzleParity's subject, and it must be a real `Texture` here
// because this one is assigned to a live `Sprite`, which a size-only stand-in cannot be.
const mocks = vi.hoisted(() => ({ assetsLoad: vi.fn() }));
vi.mock('pixi.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('pixi.js')>();
  return { ...actual, Assets: { ...actual.Assets, load: mocks.assetsLoad } };
});

const PUBLIC = new URL('../../public/', import.meta.url);
const read = (path: string): Buffer => readFileSync(new URL(path, PUBLIC));
const readJson = <T>(path: string): T => JSON.parse(read(path).toString('utf8')) as T;

/** A PNG's real pixel width, straight out of its IHDR chunk (offset 16 after the 8-byte
 *  signature + the chunk's own length/type) — the whole point is to use the art's ACTUAL
 *  size on disk, so this deliberately does not trust any recorded number. */
function pngWidth(path: string): number {
  return read(path).readUInt32BE(16);
}

/** A PNG's real pixel height, from the same IHDR chunk as `pngWidth`. */
function pngHeight(path: string): number {
  return read(path).readUInt32BE(20);
}

/** The (skinName → bundle directory) pairs the GAME preloads. Taken from the real table so
 *  a character added there cannot quietly skip every check in this file. */
function preloadedBundles(): Array<{ name: string; dir: string }> {
  // Imported, not scraped. This used to regex `main.ts`'s source for a `CHAR_BUNDLES`
  // literal, which silently produced an EMPTY list the moment that table moved (it moved
  // to render/preloadArt.ts when the WeChat entry started sharing it) — every
  // `describe.each` below would then have vanished with nothing failing except the
  // length assertion in the next describe, which is the only reason the hole was visible.
  // The table is a real exported constant now, so read it as one.
  return CHAR_BUNDLES.map(([name, baseUrl]) => ({ name, dir: baseUrl.replace('/skins/', '') }));
}

interface Assembly {
  rig: Rig;
  bodyBone: BoneDef;
  bodyR: number;
  parts: BoneDef[]; // every sprite-bearing bone that is NOT the body
  skin: RigSkin;
  restPose: ReadonlyMap<string, WorldPose>;
  clips: Map<string, AnimationClip>;
  /** Rendered width in rig authoring-px: the art's real pixel width × the scale RigSkin
   *  actually applied this frame. */
  footprint: (boneId: string) => number;
  centre: (boneId: string) => { x: number; y: number };
}

function load(name: string, dir: string): Assembly {
  const entry = RIG_DEFS[name];
  expect(entry, `main.ts preloads '${name}' but skinRegistry has no RigDef for it`).toBeDefined();
  const rig = entry.rig;

  const animation = readJson<AnimationJson>(`skins/${dir}/animation.json`);
  const frames = readJson<Record<string, string[]>>(`skins/${dir}/frames.json`);
  const bindings = new Map<string, SpriteBinding>(Object.entries(animation.bindings));
  const clips = new Map(Object.entries(animation.animations).map(([n, c]) => [n, deserializeClip(c)]));
  const textures = new Map<string, Texture>();
  for (const [slot, variants] of Object.entries(frames)) {
    for (const variant of variants) textures.set(variant === 'default' ? slot : `${slot}__${variant}`, Texture.WHITE);
  }
  const bundle: RigSkinBundle = { bindings, clips, textures };

  // `bodyFill` is passed exactly as the game passes it (`Skin.ts`: `new RigSkin(loaded.rig,
  // loaded.bundle, loaded.bodyFill)`). Omitting it defaulted to 1, i.e. "the art fills its
  // whole declared bodyR" — which is true for four of the seven bundles and silently wrong for
  // critter-core (0.70), whose held gun then mounts 15 authoring px further out here than in
  // the game. It only reaches `drawnBodyR`, so nothing above depended on it.
  const skin = new RigSkin(rig, bundle, BODY_FILL[name] ?? BODY_FILL_DEFAULT);
  skin.setBodyFacing(0);
  skin.setAim(0);
  skin.update();
  // Read back what the real renderer computed (private, same cast every sibling test uses).
  const sprites = (): Map<string, { x: number; y: number; scale: { x: number } }> =>
    (skin as unknown as { sprites: Map<string, { x: number; y: number; scale: { x: number } }> }).sprites;

  // The body bone: the one hanging directly off the root that carries a bodyR circle
  // (orb-core `shell`, critter `body`, boss `core`). Every rig here has exactly one.
  const bodyCandidates = rig.boneDefs.filter(b => b.parent === 'root' && b.bodyR !== undefined);
  expect(bodyCandidates, `${name}: expected exactly one root-level body bone`).toHaveLength(1);
  const bodyBone = bodyCandidates[0];

  const widthCache = new Map<string, number>();
  const artWidth = (boneId: string): number => {
    if (!widthCache.has(boneId)) widthCache.set(boneId, pngWidth(`skins/${dir}/${boneId}.png`));
    return widthCache.get(boneId)!;
  };

  return {
    rig,
    bodyBone,
    bodyR: bodyBone.bodyR!,
    parts: rig.drawOrder.filter(id => id !== bodyBone.id).map(id => rig.boneMap.get(id)!),
    skin,
    restPose: rig.computeFK(0, 0, new Map()),
    clips,
    footprint: (boneId) => artWidth(boneId) * Math.abs(sprites().get(boneId)!.scale.x),
    centre: (boneId) => ({ x: sprites().get(boneId)!.x, y: sprites().get(boneId)!.y }),
  };
}

const dist = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.hypot(a.x - b.x, a.y - b.y);
const isOrbiting = (bone: BoneDef): boolean => bone.outerW !== undefined && bone.innerW !== undefined;

/** One authoring px of this rig, in world px on THIS bundle's actor — `Skin`'s own
 *  normalization (`radius / referenceRadius`), before the room camera's further ~4x. The three
 *  reference radii in play are 40 / 50 / 70 against actors of 15-16 world px, so the same
 *  authored delta arrives on screen at 0.214x on the boss and 0.400x on a hero. */
const toWorld = (name: string): number =>
  fpToPx(name.startsWith('char_') ? PLAYER_BASE.radius : BASIC_ENEMY.radius) / RIG_DEFS[name]!.referenceRadius;

const BUNDLES = preloadedBundles();

describe('rig composition — every skin the game preloads is covered here', () => {
  it('found the preload list and every entry resolves to a registered rig + a real bundle', () => {
    expect(BUNDLES.length).toBeGreaterThanOrEqual(7);
    for (const { name, dir } of BUNDLES) {
      expect(RIG_DEFS[name], `no RigDef registered for preloaded skin '${name}'`).toBeDefined();
      expect(() => readJson(`skins/${dir}/animation.json`)).not.toThrow();
    }
  });
});

describe.each(BUNDLES)('rig composition — $name ($dir)', ({ name, dir }) => {
  const a = load(name, dir);

  it('the body is drawn at its own hover height (its bone TIP), not down at the ground pivot', () => {
    // The bug: drawn at `sx/sy`, i.e. one body-length below where the rig puts the body,
    // which is what left every child bone stranded above the body's head.
    const tip = a.restPose.get(a.bodyBone.id)!;
    expect(a.centre(a.bodyBone.id).x).toBeCloseTo(tip.ex, 3);
    expect(a.centre(a.bodyBone.id).y).toBeCloseTo(tip.ey, 3);
    expect(tip.ey).not.toBeCloseTo(tip.sy, 3); // the two really are different points for this rig
  });

  it('every sprite renders upright at rest — art is authored in its bone\'s rest orientation', () => {
    // The bug: rotation came from the raw world angle, so a body bone pointing up (rwa -90)
    // rotated its own art 90° — the hero's spikes pointed left, every enemy was on its side.
    const sprites = (a.skin as unknown as { sprites: Map<string, { rotation: number }> }).sprites;
    for (const boneId of a.rig.drawOrder) {
      const rotation = sprites.get(boneId)?.rotation ?? 0;
      expect(Math.abs(rotation), `${boneId} is rotated ${(rotation * 180) / Math.PI}° at rest`).toBeLessThan(1e-6);
    }
  });

  it('art is scaled to the bone it\'s bound to: rendered footprint == 2 × that bone\'s bodyR', () => {
    // Pins every shipped binding's scaleX against the rig, using the art's REAL pixel width
    // — the guard against a re-export/downsample landing a sprite at the wrong size (this
    // repo has shipped a ~15.7x character-scale bug once, and a stale weapon divisor twice).
    for (const boneId of a.rig.drawOrder) {
      const bodyR = a.rig.boneMap.get(boneId)?.bodyR;
      if (bodyR === undefined) continue;
      expect(a.footprint(boneId) / (2 * bodyR), `${boneId}'s art is not sized to its bodyR`).toBeCloseTo(1, 1);
    }
  });

  it('decorative parts sit ON the body; orbiting modules sit OFF it', () => {
    const bodyCentre = a.centre(a.bodyBone.id);
    for (const bone of a.parts) {
      const d = dist(a.centre(bone.id), bodyCentre);
      if (isOrbiting(bone)) {
        // An arm has to be visibly clear of the core, or there is no "two arms" silhouette.
        expect(d, `${bone.id} orbits INSIDE the body`).toBeGreaterThan(a.bodyR);
        expect(d, `${bone.id} orbits absurdly far from the body`).toBeLessThan(a.bodyR * 2);
      } else {
        // A face/belly part has to be contained by the body it decorates.
        const reach = d + a.footprint(bone.id) / 2;
        expect(reach, `${bone.id} hangs off the body`).toBeLessThanOrEqual(a.bodyR * 1.25);
      }
    }
  });

  it('no two parts occupy the same point — the exact shape of the shipped bug', () => {
    // Pre-fix, orb-core's eye, belly and BOTH sockets were all at (0,-46): four sprites and
    // the mounted weapon stacked on one pixel. Any future rig that collapses two parts onto
    // each other fails here, whatever the cause.
    for (let i = 0; i < a.parts.length; i++) {
      for (let j = i + 1; j < a.parts.length; j++) {
        const [p, q] = [a.parts[i], a.parts[j]];
        expect(dist(a.centre(p.id), a.centre(q.id)), `${p.id} and ${q.id} are co-located`)
          .toBeGreaterThan(a.bodyR * 0.2);
      }
    }
  });

  it('all orbiting modules share one orbit radius (a symmetric pair of arms, not a lopsided one)', () => {
    const bodyCentre = a.centre(a.bodyBone.id);
    const radii = a.parts.filter(isOrbiting).map(b => dist(a.centre(b.id), bodyCentre));
    for (const r of radii) expect(r).toBeCloseTo(radii[0], 3);
  });

  it('every orbiting module is connected by a drawn tether — and a rig without arms draws none', () => {
    const internals = a.skin as unknown as { tethers: unknown | null; tetherGeometry: string };
    const orbiting = a.parts.filter(isOrbiting).length;
    if (orbiting === 0) {
      expect(internals.tethers).toBeNull();
      return;
    }
    expect(internals.tethers).not.toBeNull();
    expect(internals.tetherGeometry.split(';').filter(Boolean)).toHaveLength(orbiting);
  });

  it('stays assembled through every shipped animation clip, not just at rest', () => {
    // Sampled across each clip because the FK model does NOT cascade translate/scale to
    // children (design/12): a clip that bobs the body without bobbing its parts would tear
    // the character apart mid-animation, and nothing else in the suite would notice.
    const SAMPLES = 12;
    const sprites = (a.skin as unknown as { sprites: Map<string, { alpha: number }> }).sprites;
    for (const [clipName, clip] of a.clips) {
      for (let i = 0; i <= SAMPLES; i++) {
        a.skin.playClip(clipName, (clip.duration * 1000 * i) / SAMPLES);
        a.skin.update();
        const bodyCentre = a.centre(a.bodyBone.id);
        for (const bone of a.parts) {
          if ((sprites.get(bone.id)?.alpha ?? 1) <= 0.01) continue; // faded out (death/spawn) — nothing to see
          const d = dist(a.centre(bone.id), bodyCentre);
          const where = `${clipName} @${i}/${SAMPLES}: ${bone.id}`;
          if (isOrbiting(bone)) {
            expect(d, `${where} pulled inside the body`).toBeGreaterThan(a.bodyR * 0.9);
          } else {
            expect(d + a.footprint(bone.id) / 2, `${where} slid off the body`).toBeLessThanOrEqual(a.bodyR * 1.6);
          }
        }
      }
    }
    a.skin.playClip('idle', 0);
    a.skin.update();
  });
});

describe('rig composition — a mounted weapon module reads as a module against the core', () => {
  // The core it mounts on is the hero's: orb-core's shell, 2 × bodyR authoring-px wide.
  const CORE_DIAMETER = 2 * RIG_DEFS.char_vanguard.rig.boneMap.get('shell')!.bodyR!;
  const entries: Array<[string, WeaponVisualDef]> = [
    ...Object.entries(KIND_DEFAULTS),
    ...(Object.entries(WEAPON_DEFS) as Array<[string, WeaponVisualDef]>),
  ];

  it.each(entries)('%s is between 0.4x and 1.0x the core diameter', (_id, def) => {
    // Both bounds are real regressions, not hypotheticals: at 1.0x+ the gun covered the
    // hero's eye and dominated the silhouette (the 2026-08-17 report, fixed by MODULE_SCALE);
    // below 0.4x a module reads as a nub, which is what KIND_DEFAULTS' stale `/1536` divisor
    // was doing (~0.2x) on the never-invisible fallback path. Checked from each texture's
    // REAL on-disk width, so re-exporting the art at a different size fails here.
    const ratio = (pngWidth(def.path.replace(/^\//, '')) * def.scale * MODULE_SCALE) / CORE_DIAMETER;
    expect(ratio).toBeGreaterThan(0.4);
    expect(ratio).toBeLessThanOrEqual(1.0);
  });

  it('the proportion factor is applied uniformly — no per-weapon exception can drift in', () => {
    expect(MODULE_SCALE).toBeGreaterThan(0);
    expect(MODULE_SCALE).toBeLessThanOrEqual(1);
  });
});

/**
 * The cross-layer invariant the 2026-08-19 report was actually about: the sim's wall
 * clearance has to be at least as wide as the body the renderer draws, or the character's
 * silhouette ends up inside the wall it is standing against (`ENGINE_VERSION` 43,
 * `Actor.solidRadius`). Every other check in this file compares the rig against itself;
 * this one compares the shipped rig against a number that lives in the ENGINE, which is the
 * seam the bug actually lived in — the 7 px feet circle was authored before the real 32 px
 * art existed and stayed plausible-looking in both files separately for weeks.
 *
 * Failing here means one of two edits happened without the other: the rig art (or its
 * reference radius) grew, or the clearance shrank.
 */
describe('rig composition — the drawn body fits inside the sim\'s wall clearance (v43)', () => {
  const CHARACTERS = BUNDLES.filter(b => b.name.startsWith('char_'));

  it('every playable character bundle is covered here', () => {
    expect(CHARACTERS.length).toBeGreaterThanOrEqual(3); // vanguard / skirmisher / juggernaut
  });

  it.each(CHARACTERS)('$name\'s body half-width never exceeds PLAYER_BASE.solidRadius', ({ name, dir }) => {
    const a = load(name, dir);
    // What Skin.ts does: normalize the rig's authoring px to the actor's gameplay radius
    // (`rigScale = radius / referenceRadius`), so this is the body's real on-screen half
    // width in WORLD px — the same unit the engine's radii are in once out of fixed point.
    const bodyPx = fpToPx(PLAYER_BASE.radius);
    const halfWidthWorldPx = a.bodyR * (bodyPx / RIG_DEFS[name].referenceRadius);
    expect(halfWidthWorldPx).toBeLessThanOrEqual(fpToPx(PLAYER_BASE.solidRadius));
  });

  it('and the clearance is not wastefully wider than the body either', () => {
    // The other direction is a real failure mode too: a clearance well past the silhouette
    // reads as the character being held off the wall by an invisible cushion, which is the
    // opposite complaint. Tangent is the target — one body radius, no more.
    expect(fpToPx(PLAYER_BASE.solidRadius)).toBeLessThanOrEqual(fpToPx(PLAYER_BASE.radius) * 1.1);
  });
});

/**
 * `skinRegistry.BODY_FILL` against the real pixels (2026-08-19 volume pass).
 *
 * A bone's `bodyR` is the rig's DECLARED body radius; the PNG bound to it is a square canvas
 * whose creature may paint far less of it — measured, between 0.68 and 1.00 of the radius,
 * differing per bundle rather than per rig (`brute-core` fills its canvas edge to edge,
 * `critter-core`'s crystal paints 0.70). Anything sized off `bodyR` is therefore sized off a box
 * up to 45% wider than the art inside it, which is exactly what made an enemy's ground shadow
 * read as a black dinner plate it was sitting in.
 *
 * `BODY_FILL` records the measurement so `Actor` can size its shadow from the art. This is what
 * keeps it honest: re-cropping, rescaling or replacing a body texture changes the number these
 * tests measure, and the table has to move with it. Same class of cross-layer failure as the
 * `footprintRadius` mismatch fixed the same week — a hand-tuned number sized against art that
 * has since changed, with nothing in either file showing it.
 *
 * Decoding is real PNG decoding (`tools/png-pipeline/pngCodec.mjs`, the repo's own codec — the
 * alternative would be a second decoder in test code), so this deliberately reads whole images
 * rather than an IHDR header like its siblings above.
 */
/**
 * The held weapon mount, checked against the REAL shipped content (2026-08-21).
 *
 * `rigWeaponMount.test.ts` covers the geometry as arithmetic and `RigSkin.test.ts` covers the
 * wiring; neither can tell you whether the rule actually works for the art that ships. This
 * does, and it is the check that would have caught the alternative design before it was built:
 * a socket bone on the shared enemy rig could only declare ONE length, and these three bundles
 * paint 0.70 / 1.00 / 1.00 of the same declared `bodyR`, so no single length clears all three.
 *
 * Both bounds are the two ways a mounted gun goes wrong, and each was seen on a real frame
 * during the pass:
 *   - the barrel has to CLEAR the body silhouette, or the gun is a lump inside the creature;
 *   - the housing has to OVERLAP it, or the gun floats detached (which is exactly what a mount
 *     radius of 1.15 did to floater-core, whose `bodyFill` is its widest row and so overstates
 *     its half-width at the mount's own height).
 *
 * Sized from `BODY_FILL` — pinned to the shipped PNGs by the block above — and from the real
 * on-disk width of `gun_enemygun.png`. So re-cropping an enemy body, or re-exporting the gun at
 * a different size, fails here rather than shipping a detached weapon.
 */
describe('rig composition — the held weapon mount works for the art that actually ships', () => {
  const ENEMY_GUN = WEAPON_DEFS.enemygun!;
  const gunW = pngWidth(ENEMY_GUN.path.replace(/^\//, ''));

  /**
   * The mounted gun's extent along the aim, in rig authoring-px, measured the way `RigSkin`
   * and `muzzleLocal` measure it: anchor-to-tip forward, anchor-to-canvas-edge backward.
   *
   * Reads the calibration straight out of `WEAPON_DEFS`, NOT through `getWeaponAnchor`/
   * `getWeaponRotationOffset`. Those resolve through `weaponSkins.resolve()`, which falls back
   * to the KIND default unless the texture is in the preload cache — and under vitest nothing
   * is preloaded, so every one of them silently returned `gun_default`'s calibration instead of
   * `enemygun`'s. The mutation battery found it: moving enemygun's anchor to its barrel tip
   * changed nothing here. The authored table is what ships, so the table is what to check.
   */
  function gunReach(): { forward: number; backward: number } {
    const anchor = ENEMY_GUN.anchor;
    const scale = ENEMY_GUN.scale * MODULE_SCALE;
    const gunH = pngHeight(ENEMY_GUN.path.replace(/^\//, ''));
    const forward = barrelReach(gunW, gunH, anchor, ENEMY_GUN.rotationOffsetRad ?? 0) * scale;
    // Backward: from the anchor to the far canvas edge, i.e. how much housing can tuck in.
    const backward = anchor.x * gunW * scale;
    return { forward, backward };
  }

  it("reads enemygun's OWN calibration, not the kind default it falls back to unpreloaded", () => {
    // Guard on the guard: if these ever coincide, the checks below stop testing enemygun.
    expect(ENEMY_GUN.anchor).not.toEqual(KIND_DEFAULTS.ranged.anchor);
    expect(gunReach().forward).toBeGreaterThan(0);
  });

  const HELD = BUNDLES.filter(({ name }) => resolveWeaponMount(RIG_DEFS[name]!.rig) === 'held');

  it('found the held-mount bundles — critter/brute/floater, all sharing one rig', () => {
    expect(HELD.map(b => b.name).sort()).toEqual(['brute-core', 'critter-core', 'floater-core']);
    // The premise of the whole design: one Rig instance, so one socket length for all three.
    const rigs = new Set(HELD.map(b => RIG_DEFS[b.name]!.rig));
    expect(rigs.size).toBe(1);
  });

  it('the three held bundles do NOT share a drawn body radius — why one socket length cannot fit', () => {
    const radii = new Set(HELD.map(b => RIG_DEFS[b.name]!.rig.boneMap.get('body')!.bodyR! * BODY_FILL[b.name]!));
    expect(radii.size).toBeGreaterThan(1);
  });

  it.each(HELD)('$name: the barrel clears the body and the housing still overlaps it', ({ name }) => {
    const rig = RIG_DEFS[name]!.rig;
    const drawnR = rig.boneMap.get('body')!.bodyR! * BODY_FILL[name]!;
    const anchorAt = drawnR * HELD_MOUNT_R;
    const { forward, backward } = gunReach();

    // The muzzle ends outside the silhouette, by a real margin rather than a rounding error.
    expect(anchorAt + forward, `${name}: barrel tip vs drawn radius ${drawnR}`).toBeGreaterThan(drawnR * 1.2);
    // ...and the back of the housing is inside it, so the gun reads as carried.
    expect(anchorAt - backward, `${name}: housing back vs drawn radius ${drawnR}`).toBeLessThan(drawnR);
  });

  it.each(HELD)('$name: the gun reads as a module against THIS body, not just against the hero core', ({ name }) => {
    // Same proportion question the orb-core block above asks, but per enemy body — the mobs are
    // smaller than the hero, so a gun sized only against the hero's core could swamp them.
    const drawnR = RIG_DEFS[name]!.rig.boneMap.get('body')!.bodyR! * BODY_FILL[name]!;
    const ratio = (gunW * ENEMY_GUN.scale * MODULE_SCALE) / (2 * drawnR);
    expect(ratio).toBeGreaterThan(0.4);
    expect(ratio).toBeLessThanOrEqual(1.2);
  });

  it('every preloaded bundle resolves to a mount mode, and the boss is the only weaponless one', () => {
    const byMode = new Map<string, string[]>();
    for (const { name } of BUNDLES) {
      const mode = resolveWeaponMount(RIG_DEFS[name]!.rig);
      byMode.set(mode, [...(byMode.get(mode) ?? []), name]);
    }
    expect(byMode.get('none')).toEqual(['boss-core']);
    expect(byMode.get('socket')!.sort()).toEqual(['char_juggernaut', 'char_skirmisher', 'char_vanguard']);
    expect(byMode.get('held')!.length).toBe(3);
    // No bundle may be left without a mode — that is how the boss ended up drawing a
    // placeholder bar for months.
    expect(byMode.get('socket')!.length + byMode.get('held')!.length + byMode.get('none')!.length)
      .toBe(BUNDLES.length);
  });
});

/**
 * ASSEMBLY INTEGRITY of the mounted weapon (2026-09-02) — the invariant this whole file is
 * about, applied to the one part of the rig that MOVES independently of its bone.
 *
 * Written because the bullet-arc fix shipped a regression past 4134 green tests, a 24-angle
 * geometry sweep and a 4-mutation battery, and one live frame caught it: the first version
 * orbited the weapon MODULE to the aim and left everything hanging off the same bone behind —
 * the socket ring, the energy tether drawn out to it, the contact shade on the core. Aiming
 * south drew the gun at (0, 6) with its ring still at (52, -49.7), 71 px away, tether reaching
 * for where the ring used to be.
 *
 * Nothing in the suite could see it, and the reason generalises: every test asserted where the
 * module IS — its mount coordinates, its muzzle point, its cross-track geometry, its depth
 * flip. None asserted that it is still ATTACHED to the thing that holds it, because a rig's
 * parts have that relationship by construction... right up until someone moves one of them out
 * of the FK chain, which is the moment the construction stops being the guarantee.
 *
 * So these assert RELATIONSHIPS between things the renderer positions INDEPENDENTLY, over the
 * real shipped bundles, swept across the aim and across every clip. Same family as "no two
 * parts occupy the same point" above, and the same reason for existing.
 */
describe('rig composition — the mounted weapon stays attached to its own mount', () => {
  /** Every preloaded bundle that mounts a weapon at all, with the weapon its carrier fires. */
  const ARMED = BUNDLES
    .filter(({ name }) => resolveWeaponMount(RIG_DEFS[name]!.rig) !== 'none')
    .map(b => ({
      ...b,
      mode: resolveWeaponMount(RIG_DEFS[b.name]!.rig),
      // The hero roster carries the catalog; every enemy body fires ENEMY_GUN_SIM
      // (`content/enemies.ts`), whose render id is `enemygun`.
      weapon: resolveWeaponMount(RIG_DEFS[b.name]!.rig) === 'socket' ? 'blaster' : 'enemygun',
    }));

  /** 16 directions, not the four axes: a mount that is wrong at 90° can be right at 0°, which
   *  is exactly how the arc survived (`muzzleParity.test.ts` carries that lesson in full). */
  const AIMS = Array.from({ length: 16 }, (_, i) => (i * Math.PI * 2) / 16);

  beforeAll(async () => {
    mocks.assetsLoad.mockImplementation(async (arg: string | { src: string }) => {
      void (typeof arg === 'string' ? arg : arg.src);
      return Texture.WHITE;
    });
    await preloadWeaponSkins();
  });

  /** A freshly loaded rig with its weapon mounted. */
  function armed(name: string, dir: string, weapon: string): Assembly {
    const a = load(name, dir);
    a.skin.setWeaponKind('ranged', weapon);
    return a;
  }
  const posed = (a: Assembly, aim: number): void => {
    a.skin.setBodyFacing(aim);
    a.skin.setAim(aim);
    a.skin.update();
  };
  const moduleAt = (a: Assembly): { x: number; y: number } => {
    const sprite = (a.skin as unknown as { weaponSprite: { x: number; y: number; visible: boolean } | null }).weaponSprite;
    expect(sprite, 'no weapon module was mounted at all').not.toBeNull();
    expect(sprite!.visible, 'the mounted module is hidden').toBe(true);
    return { x: sprite!.x, y: sprite!.y };
  };

  it('found the armed bundles — every preloaded body except the boss', () => {
    expect(ARMED.map(b => b.name).sort())
      .toEqual(['brute-core', 'char_juggernaut', 'char_skirmisher', 'char_vanguard', 'critter-core', 'floater-core']);
    expect(ARMED.filter(b => b.mode === 'socket')).not.toHaveLength(0);
    expect(ARMED.filter(b => b.mode === 'held')).not.toHaveLength(0);
  });

  // The anti-vacuity control for everything below: a module that never moved would satisfy
  // every "stays attached" check for free. It has to actually travel with the aim.
  it.each(ARMED)('$name: the module travels with the aim rather than merely spinning', ({ name, dir, weapon }) => {
    const a = armed(name, dir, weapon);
    posed(a, 0);
    const east = moduleAt(a);
    posed(a, Math.PI / 2);
    const south = moduleAt(a);
    // A quarter-turn apart, so they must be at least the mount's own reach apart.
    expect(dist(east, south)).toBeGreaterThan(a.bodyR * 0.5);
  });

  it.each(ARMED.filter(b => b.mode === 'socket'))(
    '$name: the module sits exactly on its own socket ring, at every aim',
    ({ name, dir, weapon }) => {
      const a = armed(name, dir, weapon);
      for (const aim of AIMS) {
        posed(a, aim);
        // The ring is the socket bone's OWN art, placed by the sprite loop; the module is
        // placed by `activeModuleMount`. Two independent paths, one point — 71 px apart in the
        // regression this test exists for.
        expect(dist(moduleAt(a), a.centre(ACTIVE_WEAPON_SOCKET)), 'aim ' + Math.round((aim * 180) / Math.PI))
          .toBeLessThan(0.01);
      }
    },
  );

  it.each(ARMED.filter(b => b.mode === 'socket'))(
    '$name: and through every shipped clip, so the gun rides the hover bob with its ring',
    ({ name, dir, weapon }) => {
      const a = armed(name, dir, weapon);
      const SAMPLES = 8;
      for (const [clipName, clip] of a.clips) {
        for (let i = 0; i <= SAMPLES; i++) {
          a.skin.setAim(1.1); // an off-axis aim, so this is not the rest pose either
          a.skin.playClip(clipName, (clip.duration * 1000 * i) / SAMPLES);
          a.skin.update();
          expect(dist(moduleAt(a), a.centre(ACTIVE_WEAPON_SOCKET)), clipName + ' @' + i + '/' + SAMPLES)
            .toBeLessThan(0.01);
        }
      }
    },
  );

  it.each(ARMED.filter(b => b.mode === 'socket'))(
    '$name: the drawn tether reaches the module, not the point it used to hang at',
    ({ name, dir, weapon }) => {
      const a = armed(name, dir, weapon);
      for (const aim of AIMS) {
        posed(a, aim);
        // `tetherGeometry` is the signature `drawTethers` builds from the endpoints it actually
        // strokes — `sx,sy,ex,ey,alpha;` per tethered bone — so this reads the drawn curve's
        // own far end rather than recomputing where it ought to be.
        const geom = (a.skin as unknown as { tetherGeometry: string }).tetherGeometry;
        const ends = geom.split(';').filter(Boolean).map((row) => {
          const parts = row.split(',').map(Number);
          return { x: parts[2]!, y: parts[3]! };
        });
        expect(ends.length, 'no tether was drawn at all').toBeGreaterThan(0);
        const mod = moduleAt(a);
        const nearest = Math.min(...ends.map((e) => dist(e, mod)));
        // 0.1 rather than 0.01: the signature rounds its endpoints to one decimal place.
        expect(nearest, 'aim ' + Math.round((aim * 180) / Math.PI)).toBeLessThan(0.1);
      }
    },
  );

  it.each(ARMED.filter(b => b.mode === 'held'))(
    '$name: the held gun stays on the body edge at the SAME distance in every direction',
    ({ name, dir, weapon }) => {
      const a = armed(name, dir, weapon);
      const fill = BODY_FILL[name] ?? BODY_FILL_DEFAULT;
      const want = a.bodyR * fill * HELD_MOUNT_R;
      for (const aim of AIMS) {
        posed(a, aim);
        // Constant in every direction is the whole point: the vertical half of this offset was
        // squashed 0.45 until 2026-09-02, which made a mob's gun sit closer to its body when
        // aiming up or down — i.e. off the line its own bullets fly along (`muzzleParity`).
        expect(dist(moduleAt(a), a.centre(a.bodyBone.id)), 'aim ' + Math.round((aim * 180) / Math.PI))
          .toBeCloseTo(want, 6);
      }
    },
  );
});

describe('BODY_FILL — the recorded body art fill matches the shipped pixels', () => {
  /** `alpha > 8` rather than `> 0`: a chroma-keyed PNG carries a rim of near-zero antialiasing
   *  alpha that is invisible on screen and would inflate every measurement. */
  const ALPHA_FLOOR = 8;

  async function opaqueHalfWidth(dir: string, boneId: string, scaleX: number): Promise<number> {
    // The repo's PNG codec is a plain .mjs tool module; `pngCodec.d.mts` (added 2026-08-20 for
    // `scene/pillarArt.test.ts`) is what gives it a type surface here.
    const { decodePNG } = await import('../../../tools/png-pipeline/pngCodec.mjs');
    const img = decodePNG(read(`skins/${dir}/${boneId}.png`)) as { width: number; height: number; data: Uint8Array };
    let minX = img.width;
    let maxX = -1;
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        if (img.data[(y * img.width + x) * 4 + 3]! <= ALPHA_FLOOR) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
    }
    expect(maxX, `${dir}/${boneId}.png has no opaque pixels at all`).toBeGreaterThanOrEqual(0);
    return ((maxX - minX + 1) * scaleX) / 2;
  }

  it('has an entry for every skin the game preloads — a missing one silently means 1.0', () => {
    for (const { name } of BUNDLES) expect(BODY_FILL[name], `BODY_FILL['${name}']`).toBeDefined();
  });

  it.each(BUNDLES)('$name\'s recorded fill is what its body PNG actually paints', async ({ name, dir }) => {
    const a = load(name, dir);
    const animation = readJson<AnimationJson>(`skins/${dir}/animation.json`);
    const binding = animation.bindings[a.bodyBone.id]!;
    const halfWidth = await opaqueHalfWidth(dir, a.bodyBone.id, binding.scaleX);
    // Within 0.02 — the table is rounded to two places, and a real art change moves it far more.
    expect(halfWidth / a.bodyR).toBeCloseTo(BODY_FILL[name]!, 2);
  });

  it('never records more than 1.0 — art wider than its own bodyR is a rig bug, not a fill', () => {
    for (const { name } of BUNDLES) expect(BODY_FILL[name]!).toBeLessThanOrEqual(1);
  });

  it('defaults to 1.0, the conservative direction, for an unregistered skin', () => {
    // A shadow slightly too big is a look note; a missing one is a character that floats.
    expect(BODY_FILL_DEFAULT).toBe(1);
    expect(BODY_FILL['not-a-skin']).toBeUndefined();
  });
});

/**
 * The fire recoil, against the art that actually ships (2026-08-30).
 *
 * `rigAttackMotion.test.ts` pins the envelope and `RigSkin.test.ts` pins what it moves, but both run
 * on a FAKE bundle where every binding scale is 1 — the exact blind spot this file's header
 * describes. What only real data can answer is whether the authored kick DISTANCE is right for
 * these seven bodies: it is one constant in rig authoring-px, applied to bodies whose drawn
 * radii range from 27.6 to 50 of those px and whose rigs range from a 40 to a 70 reference
 * radius. A number that reads well on the hero can be invisible on one rig and bury the gun in
 * another, and no fake-bundle test can see either.
 *
 * Measured in the authored-table space (`WEAPON_DEFS` + the real PNG's IHDR), NOT through
 * `getWeaponAnchor`/`getWeaponScale`, for the reason the held-mount block above documents:
 * unpreloaded, those silently fall back to the KIND default and stop testing the real gun.
 */
describe('rig composition — the fire recoil against every shipped body', () => {
  const ENEMY_GUN = WEAPON_DEFS.enemygun!;
  const gunPath = ENEMY_GUN.path.replace(/^\//, '');
  /** Anchor -> muzzle along the aim, in rig authoring-px, as `muzzleLocal` measures it. */
  const gunForward =
    barrelReach(pngWidth(gunPath), pngHeight(gunPath), ENEMY_GUN.anchor, ENEMY_GUN.rotationOffsetRad ?? 0)
    * ENEMY_GUN.scale * MODULE_SCALE;
  /** Anchor -> back of the housing, i.e. how much gun tucks INTO the body. */
  const gunBackward = ENEMY_GUN.anchor.x * pngWidth(gunPath) * ENEMY_GUN.scale * MODULE_SCALE;

  const HELD = BUNDLES.filter(({ name }) => resolveWeaponMount(RIG_DEFS[name]!.rig) === 'held');
  const SOCKET = BUNDLES.filter(({ name }) => resolveWeaponMount(RIG_DEFS[name]!.rig) === 'socket');

  // Every check here is stated at the PEAK of the envelope, and that is the worst case for all
  // of them: the recoil pulls the module straight back down its own barrel, so the closer the
  // gun gets to the body the more of it is behind the silhouette.
  it.each(HELD)('$name: the barrel still clears the body at the peak of the recoil', ({ name }) => {
    const drawnR = RIG_DEFS[name]!.rig.boneMap.get('body')!.bodyR! * BODY_FILL[name]!;
    const tipAtPeak = drawnR * HELD_MOUNT_R - RECOIL_MODULE_PX + gunForward;
    // A shot has to leave the silhouette on the frame it is fired — that is the one frame the
    // muzzle flare, the sparks and the bullet's own spawn point are all anchored on. A margin,
    // not a hairline: 1.2x is the same bar the rest-pose check next door uses.
    expect(tipAtPeak, `${name}: barrel tip ${tipAtPeak.toFixed(1)} vs drawn radius ${drawnR}`)
      .toBeGreaterThan(drawnR * 1.2);
  });

  it.each(HELD)('$name: the recoil never drives the housing through the body centre', ({ name }) => {
    const drawnR = RIG_DEFS[name]!.rig.boneMap.get('body')!.bodyR! * BODY_FILL[name]!;
    const housingBack = drawnR * HELD_MOUNT_R - RECOIL_MODULE_PX - gunBackward;
    // Still on the near side of the body's own centre. Past 0 the gun would have slid out the
    // FAR side of the creature, and the smallest shipped body (critter-core, drawn radius 35)
    // is the one with the least room — 4 authoring px of it at the peak.
    expect(housingBack, `${name}: housing back at peak, drawn radius ${drawnR}`).toBeGreaterThan(0);
    // ...and still tucked in, so it goes on reading as carried rather than as floating alongside.
    expect(housingBack).toBeLessThan(drawnR);
  });

  it.each(SOCKET)('$name: the orbiting module stays outside the core at the peak', ({ name }) => {
    const rig = RIG_DEFS[name]!.rig;
    const drawnR = rig.boneMap.get('shell')!.bodyR! * BODY_FILL[name]!;
    // The socket path mounts on the bone's TIP, which FK fixes at `len` from the body's own
    // tip; the recoil is the only thing that ever shortens that reach.
    const anchorAtPeak = rig.boneMap.get('socket_r')!.len - RECOIL_MODULE_PX;
    expect(anchorAtPeak, `${name}: module anchor at peak vs drawn radius ${drawnR}`).toBeGreaterThan(drawnR);
  });

  // A recoil smaller than a screen pixel is a recoil nobody sees — which IS the bug this pass
  // exists to fix — and it is invisible to every other test, because they all work in authoring
  // px where the constant is simply whatever it says it is.
  it.each(BUNDLES)('$name: the kick survives the scale down to world px', ({ name }) => {
    if (resolveWeaponMount(RIG_DEFS[name]!.rig) === 'none') return; // boss-core draws no gun
    const actorR = fpToPx(name.startsWith('char_') ? PLAYER_BASE.radius : BASIC_ENEMY.radius);
    // `Skin`'s own normalization: a rig's authoring px are scaled by radius / referenceRadius.
    const toWorld = actorR / RIG_DEFS[name]!.referenceRadius;
    expect(RECOIL_MODULE_PX * toWorld, `${name}: module kick in world px`).toBeGreaterThan(1);
    expect(RECOIL_BODY_PX * toWorld, `${name}: body lean in world px`).toBeGreaterThan(0.3);
    // ...and not so large it reads as the character being shoved rather than as a gun cycling:
    // the kick stays under half the body's own drawn half-width.
    const drawnHalfW = RIG_DEFS[name]!.referenceRadius * (BODY_FILL[name] ?? BODY_FILL_DEFAULT);
    expect(RECOIL_MODULE_PX).toBeLessThan(drawnHalfW / 2);
  });
});

/**
 * The new clips against the art that actually SHIPS (2026-09-02) — the sibling of the recoil
 * block above, and it exists for the same reason that one does.
 *
 * `rigClipLayer.test.ts` and `RigSkin.test.ts` both run on hand-built clips and a fake bundle
 * where every binding scale is 1. They can prove the blend is arithmetically right and prove
 * nothing about whether the authored NUMBERS read on a real body: `move` and `attack` were
 * written once and dropped onto seven bundles whose reference radii are 40 / 50 / 70 and whose
 * actors are 15-16 world px, so the same authoring-px delta arrives on screen at 0.214x on the
 * boss and 0.400x on a hero — nearly a factor of two.
 *
 * Measured on the shipped JSON at 60 samples per clip, world px = `authoring x actorR / ref`
 * (`Skin`'s own normalization), before the room camera's further ~4x:
 *
 *   char_* (x3)     move 5.00ap = 2.00wp   attack 1.96ap = 0.78wp   scale swing 18%
 *   critter/brute/floater  move 5.22ap = 1.57wp   attack 9.06ap = 2.72wp   scale swing 14%
 *   boss-core       move 4.00ap = 0.86wp   attack 3.00ap = 0.64wp   scale swing 12%
 *
 * ## Mutation battery — DATA mutants, which is the only kind that can reach this block
 *
 * Recorded 2026-09-02: eight edits to the SHIPPED `animation.json` files, run against the full
 * client suite, reverted. No source-level test can see any of them.
 *
 *   KILLED   an attack clip stops ending at identity ...................... 2 failing tests
 *   KILLED   a move clip stops looping cleanly ............................ 1
 *   KILLED   a move clip stops looping at all ............................. 2
 *   KILLED   brute-core drifts from critter-core .......................... 1
 *   KILLED   an attack clip changes duration on one bundle ................ 1
 *   KILLED   an attack clip names a bone the rig does not have ............ 1
 *   KILLED   an enemy lunge is authored past its own silhouette ........... 2
 *   KILLED   the enemy lunge shrinks below the readability bar ............ 3  (after the fix below)
 *
 * The last row SURVIVED at first, and the survivor was a real weakness in this block rather than
 * an equivalent: the readability check was a single `or` across three channels, so scaling every
 * enemy translation to 5% — a 2.72 wp lunge reduced to 0.14 wp, invisible — went on passing on the
 * 14% squash alone. The `or` is still there (boss-core genuinely expresses its attack without
 * translating), with a second assertion beside it: a clip that translates AT ALL has to keep that
 * translation above the bar.
 *
 * The two-tier bar below is NOT invented here — it is the one the recoil block already uses and
 * the reason it uses it: a MODULE kick under one world px is "a recoil nobody sees" (>1wp),
 * while a body-level ACCENT is allowed to be subtler (`RECOIL_BODY_PX` is 1.2wp and asserted at
 * >0.3). Every clip here is a body accent, so the 0.3 bar applies to translation — and the
 * boss's real read is not translation at all, which is why the scale/rotation channel is
 * checked as an alternative rather than as an extra.
 */
describe('rig composition — the move/attack clips against every shipped body', () => {
  /** Largest per-bone translation the clip ever reaches, in rig authoring px. */
  const peakTranslate = (clip: AnimationClip): number => {
    let peak = 0;
    for (let i = 0; i <= 60; i++) {
      for (const [, tr] of sampleClip(clip, (clip.duration * i) / 60)) {
        peak = Math.max(peak, Math.hypot(tr.translateX, tr.translateY));
      }
    }
    return peak;
  };
  /** Largest scale departure from 1 and largest rotation, the two non-translation channels a
   *  body plan can express an attack through (boss-core does exactly that). */
  const peakShape = (clip: AnimationClip): { scale: number; rotationDeg: number } => {
    let scale = 0, rotationDeg = 0;
    for (let i = 0; i <= 60; i++) {
      for (const [, tr] of sampleClip(clip, (clip.duration * i) / 60)) {
        scale = Math.max(scale, Math.abs(tr.scaleX - 1), Math.abs(tr.scaleY - 1));
        rotationDeg = Math.max(rotationDeg, Math.abs(tr.rotation));
      }
    }
    return { scale, rotationDeg };
  };
  it.each(BUNDLES)('$name: the attack clip is visible at world scale, on some channel', ({ name, dir }) => {
    const clip = load(name, dir).clips.get('attack')!;
    const wp = peakTranslate(clip) * toWorld(name);
    const shape = peakShape(clip);
    // Either it moves the body a readable distance, or it changes its SHAPE readably. boss-core
    // is the case that forces the "or": its whole attack read is the shard rings, at 0.64 wp of
    // translation but 12% scale and 22 deg of ring rotation.
    const readable = wp > 0.3 || shape.scale >= 0.1 || shape.rotationDeg >= 8;
    expect(readable, `${name}: attack peak ${wp.toFixed(2)}wp, scale ${(shape.scale * 100).toFixed(0)}%, rot ${shape.rotationDeg.toFixed(0)}deg`)
      .toBe(true);
    // ...and a clip that DOES translate has to keep that translation readable, not shrink it to
    // a rounding error while coasting on the scale channel. Found by mutation: scaling every
    // enemy translate to 5% (2.72wp -> 0.14wp, a lunge nobody could see) passed the `or` above
    // on its 14% squash alone. The `> 0` guard keeps this from inventing a rule for a body plan
    // that legitimately expresses its attack without moving — boss-core still would, at 0.64wp.
    if (peakTranslate(clip) > 0) {
      expect(wp, `${name}: attack translates, but only ${wp.toFixed(2)} world px of it`).toBeGreaterThan(0.3);
    }
  });

  it.each(BUNDLES)('$name: the move clip is visible at world scale', ({ name, dir }) => {
    const wp = peakTranslate(load(name, dir).clips.get('move')!) * toWorld(name);
    expect(wp, `${name}: move peak in world px`).toBeGreaterThan(0.3);
  });

  it.each(BUNDLES)('$name: no clip throws the body outside its own silhouette', ({ name, dir }) => {
    // The other end of the band, and the one an eyeball on a still frame cannot judge: a lunge
    // authored for a 50-radius blob applied to a 40-radius hero would read as teleporting, not
    // as attacking. Half the drawn body half-width is the same proportion the recoil block caps
    // `RECOIL_MODULE_PX` at.
    const a = load(name, dir);
    const drawnHalfW = RIG_DEFS[name]!.referenceRadius * (BODY_FILL[name] ?? BODY_FILL_DEFAULT);
    for (const clipName of ['move', 'attack']) {
      const peak = peakTranslate(a.clips.get(clipName)!);
      expect(peak, `${name} ${clipName}: peak ${peak.toFixed(1)}ap vs drawn half-width ${drawnHalfW.toFixed(1)}`)
        .toBeLessThan(drawnHalfW / 2);
    }
  });

  it.each(BUNDLES)('$name: the real overlays over the real idle blank nothing idle animates', ({ name, dir }) => {
    // The end-to-end version of the bug the additive layer exists for, on SHIPPED data and
    // through a real `RigSkin` rather than a hand-built clip pair. Before the layer, playing
    // `attack` dropped every bone it does not name back to rest for the clip's whole duration.
    const a = load(name, dir);
    const rig = a.skin as unknown as { layers: { playBase(n: string, t: number): void; attack(): void; hurt(): void; advance(ms: number): void; sample(): Map<string, ResolvedBoneTransform> } };
    const idleBones = new Set<string>();
    for (let i = 0; i <= 20; i++) {
      for (const [bone, tr] of sampleClip(a.clips.get('idle')!, (a.clips.get('idle')!.duration * i) / 20)) {
        if (tr.translateX !== 0 || tr.translateY !== 0 || tr.rotation !== 0) idleBones.add(bone);
      }
    }
    expect(idleBones.size, `${name}: idle animates nothing, so this test proves nothing`).toBeGreaterThan(0);

    // Park idle at its own extreme (t = half the loop, where every shipped idle is at its peak),
    // then run the attack over it and check each of those bones still carries idle's pose.
    const half = a.clips.get('idle')!.duration / 2;
    // Both overlays, and both at once — the frame a player is shot at while firing, which is the
    // only case where the layer holds two clips and the one no single-overlay test can reach.
    for (const live of [[ATTACK_CLIP], [HURT_CLIP], [ATTACK_CLIP, HURT_CLIP]]) {
      rig.layers.playBase('idle', half * 1000);
      const alone = rig.layers.sample();
      for (const clipName of live) rig.layers[clipName === ATTACK_CLIP ? 'attack' : 'hurt']();
      // Mid-clip on the SHORTER of the live clips, so every one of them is still contributing.
      const shortest = Math.min(...live.map(c => a.clips.get(c)!.duration));
      rig.layers.advance(shortest * 1000 * 0.5);
      const layered = rig.layers.sample();
      for (const bone of idleBones) {
        const before = alone.get(bone)!, after = layered.get(bone)!;
        expect(after, `${name}: ${bone} vanished under ${live.join('+')}`).toBeDefined();
        // The overlay may ADD to it; what it must never do is put the bone back at rest.
        const idleOffset = Math.hypot(before.translateX, before.translateY) + Math.abs(before.rotation);
        const stillCarried = Math.hypot(after.translateX, after.translateY) + Math.abs(after.rotation);
        expect(stillCarried, `${name}: ${bone} was blanked under ${live.join('+')} (idle ${idleOffset.toFixed(2)} -> ${stillCarried.toFixed(2)})`)
          .toBeGreaterThan(idleOffset * 0.4);
      }
      // ...and the next iteration must start from a clean layer, or two rounds pile up.
      rig.layers.advance(10_000);
    }
  });

  it('the three one-bone enemy bundles carry three deliberately different gaits', () => {
    // Until 2026-11-15 this asserted the OPPOSITE — that the three bundles ship byte-identical
    // animations — because `critter-core` is the only one of the three with a build script and
    // the other two were hand-maintained copies of it. What that guarded against (a silent
    // one-sided edit) was real; what it also enforced was that a brute, a critter and a hovering
    // floater all walk the same walk, which is the first thing a player sees and the cheapest
    // cast variety this rig can buy. The three now diverge ON PURPOSE, so the check inverts:
    // each bundle must still differ from the other two, and each must keep the property that
    // makes its gait ITS gait. Everything they genuinely share — the clip vocabulary, the
    // move/attack cadence, the additive-overlay contract, the lifecycle shapes — stays pinned
    // by the sibling cases in this file, which run over all seven bundles rather than these.
    const clipsOf = (dir: string) => readJson<AnimationJson>(`skins/${dir}/animation.json`).animations;
    const dirs = ['critter-core', 'brute-core', 'floater-core'];
    for (let i = 0; i < dirs.length; i++) {
      for (let j = i + 1; j < dirs.length; j++) {
        expect(JSON.stringify(clipsOf(dirs[i]!)), `${dirs[i]} and ${dirs[j]} have collapsed back into one gait`)
          .not.toBe(JSON.stringify(clipsOf(dirs[j]!)));
      }
    }

    // Sampled through `sampleClip`, not read off the keyframes, so these describe what the
    // renderer actually produces rather than how the file happens to be authored.
    const samples = (dir: string, clip: string): ResolvedBoneTransform[] => {
      const c = deserializeClip(clipsOf(dir)[clip]!);
      return Array.from({ length: 601 }, (_, i) => sampleClip(c, (c.duration * i) / 600).get('body')!);
    };
    /** Footfalls per `move` cycle: how many times the body bottoms out and rises again. */
    const footfalls = (dir: string): number => {
      const ty = samples(dir, 'move').map(t => t.translateY);
      let falling = false, count = 0;
      for (let i = 1; i < ty.length; i++) {
        const d = ty[i]! - ty[i - 1]!;
        if (d < -1e-9) falling = true;
        else if (d > 1e-9 && falling) { count++; falling = false; }
      }
      return count;
    };
    const peak = (dir: string, clip: string, pick: (t: ResolvedBoneTransform) => number): number =>
      Math.max(...samples(dir, clip).map(t => Math.abs(pick(t))));

    // critter — SCURRY: three quick patters per cycle, the fastest footfall rate of the three.
    expect(footfalls('critter-core'), 'critter move should patter three times per cycle').toBe(3);
    // brute — LUMBER: one heavy step, and it is the only one of the three whose `move` squashes
    // the body: that widening IS the landing, and it is what makes the step read as weight.
    expect(footfalls('brute-core'), 'brute move should take one heavy step per cycle').toBe(1);
    expect(peak('brute-core', 'move', t => t.scaleX - 1), 'brute move should land with a squash')
      .toBeGreaterThan(0.05);
    for (const dir of ['critter-core', 'floater-core']) {
      expect(peak(dir, 'move', t => t.scaleX - 1), `${dir} move should not squash — only the brute lands`)
        .toBeLessThan(1e-9);
    }
    // floater — DRIFT: it hovers (`actorLift`'s HOVER table gives it a standing 8.5 world px and
    // no grounded archetype any entry at all), so its `move` must not plant a foot. Banking
    // sideways is the whole gait: lateral travel dominates vertical, which is true of neither
    // of the others.
    expect(peak('floater-core', 'move', t => t.translateX), 'floater move should lead with lateral drift')
      .toBeGreaterThan(peak('floater-core', 'move', t => t.translateY));
    for (const dir of ['critter-core', 'brute-core']) {
      expect(peak(dir, 'move', t => t.translateY), `${dir} move should lead with vertical travel`)
        .toBeGreaterThan(peak(dir, 'move', t => t.translateX));
    }
  });

  it('the vocabulary has one cadence across every bundle', () => {
    // The DATA half of "one render-side rule drives all seven rigs": a `move` that loops on six
    // bundles and plays once on the seventh, or an `attack` twice as long on one body plan,
    // would make the shared rule mean something different per rig without any code disagreeing.
    for (const { name, dir } of BUNDLES) {
      const a = load(name, dir);
      const move = a.clips.get('move')!, attack = a.clips.get('attack')!, idle = a.clips.get('idle')!;
      expect([move.duration, move.loop], `${name} move`).toEqual([0.6, true]);
      expect([attack.duration, attack.loop], `${name} attack`).toEqual([0.35, false]);
      expect(idle.loop, `${name} idle`).toBe(true);
    }
  });

  it('an attack clip outlives the fastest weapon that can retrigger it', () => {
    // Not a defect — it is the case the additive layer was built to survive, and it is worth
    // stating as a number so nobody "fixes" it by shortening the clip. The starter blaster
    // fires every 6 ticks (200 ms) against a 350 ms clip, so held fire restarts the overlay
    // before it ends and it is never seen through to its own last frame.
    const attackMs = load(BUNDLES[0]!.name, BUNDLES[0]!.dir).clips.get('attack')!.duration * 1000;
    const blasterMs = (BLASTER_SIM.fireRateTicks * 1000) / 30;
    expect(blasterMs).toBeLessThan(attackMs);
  });
});

/**
 * The shared clip VOCABULARY, and the authoring contract that makes the additive attack layer
 * safe (`render/rigClipLayer.ts`). Both are DATA claims about the seven shipped bundles, and
 * the render layer's one unified rule rests entirely on them — no amount of correct code can
 * rescue a bundle that is missing a clip, or an attack clip that does not start at identity.
 *
 * ## What this block used to assert, and why it was rewritten (2026-09-02)
 *
 * It read "why firing is an envelope and not the authored attack clip", and pinned the two
 * facts that argument stood on: the four enemy bundles shipped NO `attack` clip, and the hero's
 * `attack` tracked only `socket_r`, so a whole-clip swap would have blanked the bones `idle`
 * bobs. Its own header called itself a tripwire — *"if either fact below flips ... that decision
 * deserves re-reading rather than silently standing on a premise that no longer holds"*. Both
 * flipped deliberately in the same pass: every bundle now ships `move` + `attack`, and the
 * overlay is additive instead of a swap, so an untracked bone is untouched rather than blanked.
 * The tripwire did its job — this is the re-read, not a silenced assertion.
 *
 * The envelope did NOT go away, and is still the only path for the aim-relative half; see
 * `rigAttackMotion.ts` for the two reasons a clip cannot express it (rig-space `translateX`,
 * and `RigSkin` overwriting every aim-tracking bone's rotation).
 */
describe('rig composition — the shared clip vocabulary and the additive-overlay contract', () => {
  const clipsOf = (dir: string): Record<string, { keyframes: { time: number; bones: Record<string, Record<string, number>> }[] }> =>
    readJson<AnimationJson>(`skins/${dir}/animation.json`).animations as unknown as
      Record<string, { keyframes: { time: number; bones: Record<string, Record<string, number>> }[] }>;

  it('every bundle — hero and enemy alike — ships the same six clips', () => {
    // The premise of ONE render-side rule for all seven rigs. Before 2026-09-02 the four enemy
    // bundles had neither `move` nor `attack`, which had a live consequence beyond the missing
    // attack: `Actor` has always asked for `'move'` while an actor is moving, and `playClip`
    // resolves an unknown name to NO clip — so a walking enemy fell back to a bare rest pose and
    // lost even its idle bob.
    for (const { name, dir } of BUNDLES) {
      expect(Object.keys(clipsOf(dir)).sort(), `${name} clip inventory`)
        .toEqual(['attack', 'death', 'hurt', 'idle', 'move', 'spawn']);
    }
  });

  it('every bundle\'s OVERLAY clips start AND end at identity — the additive layer pops otherwise', () => {
    // The authoring contract `rigClipLayer.layerAdditive` cannot enforce from code: it ADDS
    // translate/rotation and MULTIPLIES scale/alpha onto the base pose, so a first or last
    // keyframe away from identity is a step change on the frame the overlay starts and on the
    // frame it expires. Asserted on the raw keyframes rather than through a sampler, because
    // this is a claim about what the artist committed.
    //
    // BOTH overlay clips since 2026-09-02. `hurt` was checked against this before it was wired,
    // and it is the reason it could go on the same layer as `attack` rather than needing a
    // mechanism of its own — see the sibling test below for the two clips that failed the check.
    const IDENTITY: Record<string, number> = {
      rotation: 0, translateX: 0, translateY: 0, scaleX: 1, scaleY: 1, alpha: 1,
    };
    for (const { name, dir } of BUNDLES) {
      for (const clipName of [ATTACK_CLIP, HURT_CLIP]) {
        const frames = [...clipsOf(dir)[clipName]!.keyframes].sort((a, b) => a.time - b.time);
        for (const edge of [frames[0]!, frames[frames.length - 1]!]) {
          for (const [boneId, channels] of Object.entries(edge.bones)) {
            for (const [channel, value] of Object.entries(channels)) {
              expect(value, `${name} ${clipName} t=${edge.time} ${boneId}.${channel}`)
                .toBe(IDENTITY[channel]);
            }
          }
        }
      }
    }
  });

  it('every bone a clip animates has a keyframe at t=0 — otherwise it CUTS instead of ramping', () => {
    // Found by the sibling block's identity check on 2026-09-02, in the three char_* bundles'
    // `death`: `belly`/`socket_l`/`socket_r` appeared ONLY in the final keyframe, at alpha 0.
    // `sampleClip` resolves a bone with no keyframe at-or-before `t` straight to its earliest
    // FUTURE keyframe (`resolveOne`, no interpolation), so those three bones went to alpha 0 on
    // frame ONE and stayed there — a hero's belly and both weapon modules popped out of existence
    // the instant it died, while the shell collapsed over the following 900 ms. It is invisible
    // in every still, invisible to a source-level test, and the clip's own last keyframe looked
    // completely correct. Fixed by giving those bones the eye's own alpha ramp; asserted here as
    // the general rule, because the same shape is one forgotten keyframe away in any clip.
    for (const { name, dir } of BUNDLES) {
      for (const [clipName, clip] of Object.entries(clipsOf(dir))) {
        const frames = [...clip.keyframes].sort((a, b) => a.time - b.time);
        expect(frames[0]!.time, `${name} ${clipName} does not open at t=0`).toBe(0);
        const opening = new Set(Object.keys(frames[0]!.bones));
        for (const boneId of new Set(frames.flatMap(k => Object.keys(k.bones)))) {
          expect(opening.has(boneId), `${name} ${clipName}: '${boneId}' has no t=0 keyframe`).toBe(true);
        }
      }
    }
  });

  it('no clip ever touches a bone its own rig does not have', () => {
    // The layer writes whatever a clip names, so a stale bone id would silently create a
    // transform for a bone no sprite reads — invisible on screen and invisible to a sampler test.
    // All six clips, not just `attack`: `hurt`/`death`/`spawn` were authored for seven bundles
    // across three rig families, which is exactly the situation a copy-paste bone id survives.
    for (const { name, dir } of BUNDLES) {
      const known = new Set(RIG_DEFS[name]!.rig.boneDefs.map(b => b.id));
      for (const [clipName, clip] of Object.entries(clipsOf(dir))) {
        const bones = new Set(clip.keyframes.flatMap(k => Object.keys(k.bones)));
        for (const boneId of bones) {
          expect(known.has(boneId), `${name} ${clipName} bone '${boneId}'`).toBe(true);
        }
        expect(bones.size, `${name} ${clipName} animates nothing`).toBeGreaterThan(0);
      }
    }
  });

  it('the hero attack no longer slides the socket — that is the envelope\'s job, and it would double up', () => {
    // The one overlap the two layers could have had. `rigAttackMotion` kicks the module back by
    // RECOIL_MODULE_PX along the BARREL; the hero clip used to carry `translateX: -10` on the
    // same bone, in rig space, which is both the wrong direction and the same magnitude. Playing
    // both would have doubled the kick, so the clip's translate was dropped when the layer landed.
    for (const { name, dir } of BUNDLES.filter(b => b.name.startsWith('char_'))) {
      const socketChannels = new Set(
        clipsOf(dir).attack!.keyframes.flatMap(k => Object.keys(k.bones.socket_r ?? {})),
      );
      expect([...socketChannels].sort(), `${name} attack socket_r channels`).toEqual(['scaleX', 'scaleY']);
      expect(socketChannels.has('translateX'), `${name}: would double the recoil kick`).toBe(false);
    }
  });

  it('a looping base clip returns to its own first pose, so the loop seam does not jump', () => {
    // `move` was authored for four new bundles in one pass; a loop whose last keyframe differs
    // from its first snaps once per cycle, which is exactly the kind of thing that reads as
    // "the animation is broken" and is invisible in a still.
    for (const { name, dir } of BUNDLES) {
      for (const clipName of ['idle', 'move']) {
        const clip = clipsOf(dir)[clipName]!;
        const frames = [...clip.keyframes].sort((a, b) => a.time - b.time);
        expect(JSON.stringify(frames[0]!.bones), `${name} ${clipName} loop seam`)
          .toBe(JSON.stringify(frames[frames.length - 1]!.bones));
      }
    }
  });
});

/**
 * The three clips wired on 2026-09-02, against the art that actually SHIPS — `hurt`, `death`,
 * `spawn`. Sibling of the two blocks above and it exists for the same reason: `rigClipLayer.
 * test.ts` proves the state machine is right on hand-built clips, and can prove nothing about
 * whether the authored NUMBERS read on a real body or whether they even permit the layering the
 * render side chose for them.
 *
 * The FIRST test here is the load-bearing one. It is the measurement the whole design rests on:
 * `hurt` is identity-anchored at both ends and can therefore be an additive overlay; `spawn` and
 * `death` are not, and therefore cannot. If an artist ever re-authors `death` to end at identity,
 * that test fails and the base-layer state machine deserves re-reading rather than standing on a
 * premise that no longer holds — the same tripwire shape the attack block's own header describes,
 * and which did its job once already.
 *
 * ## What is NOT asserted here, deliberately
 *
 * Two seams the shipped data has and nothing can cheaply remove:
 *
 *   - the frame `death` takes over the base layer, the ground clip's own pose is dropped, so a
 *     body caught at the top of its idle bob steps up to 6 authoring px (~2 world px). Same for
 *     the frame `spawn` releases back to idle. That is the same order as the step every existing
 *     idle<->move swap already takes (one monotonic clock, two different clips), so it is not new
 *     and not worth a cross-fade; the death case is additionally covered by a shake, a debris
 *     burst and a dissolve starting on the same frame.
 *   - `death` (900 ms) outlives the dissolve that destroys the view (`DISSOLVE_MS` = 700), so its
 *     last 200 ms are never seen. That is asserted as an intended RELATIONSHIP below rather than
 *     fixed: the clip being cut off mid-collapse is what makes the two read as one motion.
 */
describe('rig composition — the lifecycle clips against every shipped body', () => {
  /** How far the whole pose sits from identity at time `t`: the largest single-channel departure
   *  across every bone, with scale/alpha measured against 1 and the rest against 0. One number,
   *  because the question these tests ask is only "is this pose identity or not". */
  const departure = (clip: AnimationClip, t: number): number => {
    let peak = 0;
    for (const [, tr] of sampleClip(clip, t)) {
      peak = Math.max(
        peak,
        Math.abs(tr.rotation), Math.abs(tr.translateX), Math.abs(tr.translateY),
        Math.abs(tr.scaleX - 1), Math.abs(tr.scaleY - 1), Math.abs(tr.alpha - 1),
      );
    }
    return peak;
  };

  it.each(BUNDLES)('$name: hurt can be an overlay and spawn/death provably cannot', ({ name, dir }) => {
    // The measurement that chose the layers. An additive overlay contributes its own FIRST pose
    // on the frame it is triggered and its own LAST pose on the frame it expires, so a clip whose
    // ends are away from identity steps the character twice.
    const a = load(name, dir);
    const hurt = a.clips.get(HURT_CLIP)!, spawn = a.clips.get(SPAWN_CLIP)!, death = a.clips.get(DEATH_CLIP)!;

    // hurt: both ends AT identity -> layerable. (The raw-keyframe form of this is in the
    // vocabulary block; here it is read through the sampler, which also covers a bone whose last
    // keyframe is earlier than the clip's end and is therefore held rather than returned.)
    expect(departure(hurt, 0), `${name}: hurt does not start at identity`).toBeCloseTo(0, 10);
    expect(departure(hurt, hurt.duration), `${name}: hurt does not end at identity`).toBeCloseTo(0, 10);

    // spawn: opens FAR from identity -> must own the base layer. Ends at identity, which is the
    // separate property that makes releasing back to idle/move safe.
    expect(departure(spawn, 0), `${name}: spawn could have been an overlay`).toBeGreaterThan(0.5);
    expect(departure(spawn, spawn.duration), `${name}: spawn does not settle at identity`).toBeCloseTo(0, 10);

    // death: the mirror image. Starts at identity (so the collapse begins from rest rather than
    // snapping) and ENDS far away -> must own the base layer, and must hold rather than release.
    expect(departure(death, 0), `${name}: death does not start at identity`).toBeCloseTo(0, 10);
    expect(departure(death, death.duration), `${name}: death could have been an overlay`).toBeGreaterThan(0.5);
  });

  it('the three lifecycle clips have one cadence across every bundle', () => {
    // Same claim the move/attack block makes for its two: one render-side rule driving seven rigs
    // means nothing if a `death` is twice as long on one body plan. None of them loops — a
    // looping death would restart its own collapse forever.
    for (const { name, dir } of BUNDLES) {
      const a = load(name, dir);
      expect([a.clips.get(HURT_CLIP)!.duration, a.clips.get(HURT_CLIP)!.loop], `${name} hurt`).toEqual([0.3, false]);
      expect([a.clips.get(DEATH_CLIP)!.duration, a.clips.get(DEATH_CLIP)!.loop], `${name} death`).toEqual([0.9, false]);
      expect([a.clips.get(SPAWN_CLIP)!.duration, a.clips.get(SPAWN_CLIP)!.loop], `${name} spawn`).toEqual([0.35, false]);
    }
  });

  it('the death clip outlives the dissolve that destroys the view', () => {
    // The two clocks that have to agree, and they are owned by different files on purpose:
    // this layer owns the body's collapse, `ActorFilters` owns the dissolve AND the moment the
    // view is gone (`Actor.onDeath`). Because the clip is the LONGER of the two, the corpse is
    // always destroyed while still visibly collapsing, so the two read as one continuous motion.
    // Were it shorter, the body would finish falling and then sit there, held, while the shader
    // kept eroding a static pose.
    const deathMs = load(BUNDLES[0]!.name, BUNDLES[0]!.dir).clips.get(DEATH_CLIP)!.duration * 1000;
    expect(deathMs).toBeGreaterThan(DISSOLVE_MS);
  });

  it.each(BUNDLES)('$name: spawn opens small and death collapses, both readably', ({ name, dir }) => {
    // The readability band, and unlike the move/attack block this one needs no world-px
    // conversion: scale and alpha are dimensionless, so an authored 0.2 reads as 20% of the body
    // on a 40-radius hero and on a 70-radius boss alike. That is also why these two clips could
    // be authored once for three rig families where `move`'s translations could not.
    const a = load(name, dir);
    const minScale = (clip: AnimationClip): number => {
      let min = 1;
      for (let i = 0; i <= 60; i++) {
        for (const [, tr] of sampleClip(clip, (clip.duration * i) / 60)) min = Math.min(min, tr.scaleX, tr.scaleY);
      }
      return min;
    };
    const spawn = a.clips.get(SPAWN_CLIP)!, death = a.clips.get(DEATH_CLIP)!;
    // Materialising: starts invisible and no more than half size, or it reads as a pop-in.
    expect(sampleClip(spawn, 0).get(a.bodyBone.id)!.alpha, `${name} spawn opening alpha`).toBe(0);
    expect(minScale(spawn), `${name} spawn min scale`).toBeLessThanOrEqual(0.5);
    // Collapsing: ends invisible and no more than half size, plus a sink the eye can follow.
    expect(sampleClip(death, death.duration).get(a.bodyBone.id)!.alpha, `${name} death final alpha`).toBe(0);
    expect(minScale(death), `${name} death min scale`).toBeLessThanOrEqual(0.5);
    const sinkWp = sampleClip(death, death.duration).get(a.bodyBone.id)!.translateY * toWorld(name);
    expect(sinkWp, `${name} death sinks ${sinkWp.toFixed(2)} world px`).toBeGreaterThan(0.3);
  });

  it.each(BUNDLES)('$name: the hurt flinch is visible at world scale', ({ name, dir }) => {
    // The sibling of the move/attack readability check, and like the spawn/death one it needs no
    // world-px conversion: `hurt` expresses itself entirely as squash, and scale is dimensionless,
    // so an authored 1.15/0.8 reads as the same 15-20% on a 40-radius hero and a 70-radius boss.
    // The bar is the attack block's own scale bar, because this is the same kind of read.
    const clip = load(name, dir).clips.get(HURT_CLIP)!;
    let peak = 0;
    for (let i = 0; i <= 60; i++) {
      for (const [, tr] of sampleClip(clip, (clip.duration * i) / 60)) {
        peak = Math.max(peak, Math.abs(tr.scaleX - 1), Math.abs(tr.scaleY - 1));
      }
    }
    expect(peak, `${name}: hurt peaks at only ${(peak * 100).toFixed(0)}% of squash`)
      .toBeGreaterThanOrEqual(0.1);
  });

  it('the three character bundles ship byte-identical animations', () => {
    // The hero sibling of the critter/brute/floater check above, and it holds for the same
    // reason: all three `char_*` bundles are the SAME `orb-core` rig with different art, and the
    // clips are authored once. Nothing enforced it, so a retune applied to one character would
    // silently give three characters on one skeleton three different gaits and three different
    // deaths — and `build-character-projects.mjs` writes all three from one source, which is
    // exactly the script that has drifted from its own output before (2026-09-02, earlier).
    const clipsJson = (dir: string): string =>
      JSON.stringify(readJson<AnimationJson>(`skins/${dir}/animation.json`).animations);
    const heroes = BUNDLES.filter(b => b.name.startsWith('char_'));
    expect(heroes.length, 'expected the three-character roster').toBe(3);
    const first = clipsJson(heroes[0]!.dir);
    for (const { name, dir } of heroes.slice(1)) {
      expect(clipsJson(dir), `${name} has drifted from ${heroes[0]!.name}`).toBe(first);
    }
  });

  it.each(BUNDLES)('$name: the real clips reach the real sprites, through a real RigSkin', ({ name, dir }) => {
    // End-to-end, on shipped data and through the public API the game calls — the half no
    // sampler test covers, because a clip channel only matters if `RigSkin.update` puts it on a
    // sprite. Every one of the three moves a DIFFERENT channel onto a different property, and
    // each of those is a separate line in that method.
    const a = load(name, dir);
    const spriteOf = (boneId: string): { alpha: number; y: number } =>
      (a.skin as unknown as { sprites: Map<string, { alpha: number; y: number }> }).sprites.get(boneId)!;
    const body = a.bodyBone.id;
    const restFootprint = a.footprint(body);
    const restY = spriteOf(body).y;
    expect(spriteOf(body).alpha, `${name}: not opaque at rest`).toBe(1);

    // spawn, frame 0: the body is barely there — scale AND alpha, both off the same clip.
    a.skin.spawn();
    a.skin.update();
    expect(a.footprint(body) / restFootprint, `${name} spawn footprint`).toBeLessThan(0.5);
    expect(spriteOf(body).alpha, `${name} spawn alpha`).toBe(0);

    // ...and it hands the body back at full size once it has played out.
    a.skin.advanceClips(a.clips.get(SPAWN_CLIP)!.duration * 1000);
    a.skin.update();
    expect(a.footprint(body)).toBeCloseTo(restFootprint, 6);
    expect(spriteOf(body).alpha).toBe(1);

    // death, at the point the dissolve destroys the view: collapsed, sunk and nearly gone. Read
    // at DISSOLVE_MS rather than at the clip's end because that is the last frame anyone sees.
    a.skin.die();
    a.skin.advanceClips(DISSOLVE_MS);
    a.skin.update();
    expect(a.footprint(body) / restFootprint, `${name} death footprint`).toBeLessThan(0.8);
    expect(spriteOf(body).y, `${name} death sink`).toBeGreaterThan(restY);
    expect(spriteOf(body).alpha, `${name} death alpha`).toBeLessThan(1);
  });

  it.each(BUNDLES)('$name: a mounted module fades with the socket it hangs on', ({ name, dir }) => {
    // A module is not a bone, so nothing else would ever fade it (`ModuleMount.alpha`). Both
    // lifecycle clips make that visible: `spawn` opens every socket at alpha 0, so a module left
    // at 1 materialises a fully-opaque gun beside a body that has not arrived. Skipped for the
    // one rig that deliberately mounts nothing (boss-core, design/13's shard rings).
    const a = load(name, dir);
    if (resolveWeaponMount(RIG_DEFS[name]!.rig) === 'none') return;
    a.skin.setWeaponKind('ranged', 'blaster');
    a.skin.update();
    const active = (): { alpha: number; visible: boolean } =>
      (a.skin as unknown as { weaponSprite: { alpha: number; visible: boolean } | null }).weaponSprite!;
    expect(active(), `${name}: no module mounted, so this proves nothing`).not.toBeNull();
    expect(active().alpha).toBe(1);
    a.skin.spawn();
    a.skin.update();
    expect(active().alpha, `${name}: module did not fade with its mount`).toBe(0);
  });
});
