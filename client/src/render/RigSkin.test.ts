/**
 * RigSkin — the `.tao` runtime renderer's facing model (design/12), extended with
 * the upper/lower body split: `setBodyFacing` drives the whole-rig L/R flip + front/
 * back hemisphere, `setAim` drives ONLY the weapon-socket aim-tracking rotation, and
 * the two must stay independent of each other. Uses a minimal fake bundle over the
 * real `ORB_CORE_RIG` (has both weapon sockets) — Pixi Sprite/Container construct
 * fine under plain vitest with no renderer attached (same finding Forge.test.ts/
 * Screens.test.ts made), so no real texture asset is needed, just `Texture.WHITE`.
 */
import { describe, it, expect, vi } from 'vitest';
import { Container, Graphics, Texture } from 'pixi.js';
import { Rig, type RigDef } from './Rig';
import { ORB_CORE_RIG } from './orbCoreRig';
import { CRITTER_CORE_RIG } from './critterCoreRig';
import { BOSS_CORE_RIG } from './bossCoreRig';
import { RigSkin, barrelReach } from './RigSkin';
import {
  DEFAULT_SWING, RECOIL_BODY_PX, RECOIL_CLIMB_DEG, RECOIL_MODULE_PX, RECOIL_MS,
  SWING_ARC_DEG, swingSchedule,
  type SwingShape,
} from './rigAttackMotion';
import type { RigSkinBundle } from './taoBundle';
import type { AnimationClip, SpriteBinding } from './types';

function fakeBundle(rig: Rig): RigSkinBundle {
  const bindings = new Map<string, SpriteBinding>();
  const textures = new Map<string, Texture>();
  for (const boneId of rig.drawOrder) {
    bindings.set(boneId, { anchorX: 0.5, anchorY: 0.5, flipX: false, zOrder: 0, rotation: 0, scaleX: 1, scaleY: 1 });
    textures.set(boneId, Texture.WHITE);
  }
  return { bindings, clips: new Map(), textures };
}

function makeSkin(def = ORB_CORE_RIG, clips?: Map<string, AnimationClip>): RigSkin {
  const rig = new Rig(def);
  const bundle = fakeBundle(rig);
  if (clips) for (const [name, clip] of clips) bundle.clips.set(name, clip);
  return new RigSkin(rig, bundle);
}

/** Like `makeSkin`, but with an explicit `bodyFill` — the fraction of its declared `bodyR` a
 *  bundle's art actually paints. `makeSkin` leaves it at the default of 1, which makes
 *  `bodyR * bodyFill` and `bodyR` indistinguishable; the held mount is defined in terms of the
 *  former, so a fill of exactly 1 cannot tell the two apart (the mutation battery walked
 *  through a `drawnBodyR()` -> `bodyR` edit for precisely that reason). */
function makeSkinWithFill(def: RigDef, bodyFill: number, clips?: Map<string, AnimationClip>): RigSkin {
  const rig = new Rig(def);
  const bundle = fakeBundle(rig);
  if (clips) for (const [name, clip] of clips) bundle.clips.set(name, clip);
  return new RigSkin(rig, bundle, bodyFill);
}

function spritesOf(skin: RigSkin): Map<string, { x: number; y: number; rotation: number }> {
  return (skin as unknown as { sprites: Map<string, { x: number; y: number; rotation: number }> }).sprites;
}

function socketRRotation(skin: RigSkin): number {
  skin.update();
  const sprites = (skin as unknown as { sprites: Map<string, { rotation: number }> }).sprites;
  return sprites.get('socket_r')!.rotation;
}

describe('RigSkin — body facing drives the flip, independently of aim', () => {
  it('setBodyFacing alone flips the rig by ITS OWN horizontal sign', () => {
    const skin = makeSkin();
    skin.setBodyFacing(Math.PI); // facing left
    expect(skin.view.scale.x).toBe(-1);
    skin.setBodyFacing(0); // facing right
    expect(skin.view.scale.x).toBe(1);
  });

  it('setAim never changes the body flip, even when it disagrees with body facing', () => {
    const skin = makeSkin();
    skin.setBodyFacing(0); // body faces right → unflipped
    skin.setAim(Math.PI); // but aiming left
    expect(skin.view.scale.x).toBe(1); // still unflipped — flip is body-only

    skin.setBodyFacing(Math.PI); // body now faces left → flipped
    skin.setAim(0); // aiming right
    expect(skin.view.scale.x).toBe(-1); // still flipped — unaffected by aim
  });
});

describe('RigSkin — weapon-socket rotation tracks aim, independent of body flip', () => {
  it('unflipped body: the socket rotates straight to the aim angle', () => {
    const skin = makeSkin();
    skin.setBodyFacing(0); // unflipped
    skin.setAim(Math.PI / 3);
    expect(socketRRotation(skin)).toBeCloseTo(Math.PI / 3, 10);
  });

  it('flipped body: the socket still renders at the true aim angle (mirror-compensated)', () => {
    // This is the exact case an upper/lower split needs to get right: the body is
    // flipped by ITS OWN (movement) direction, not the aim, so the local rotation fed
    // to a mirrored socket must be the mirror image of the aim for the flip to cancel
    // out and land on the real aim angle — see RigSkin.canonicalSocketAngleRad.
    const skin = makeSkin();
    skin.setBodyFacing(Math.PI); // body faces left → flipped
    skin.setAim(0); // but still shooting due right
    // canonical local rotation = PI - aim = PI; mirrored by scale.x=-1 it renders as
    // 0 (the true aim) — this test only pins the LOCAL rotation RigSkin computes
    // (documented contract), not Pixi's full transform composition.
    expect(socketRRotation(skin)).toBeCloseTo(Math.PI, 10);
  });

  it('aim keeps tracking through a body flip change (independent state)', () => {
    const skin = makeSkin();
    skin.setBodyFacing(0);
    skin.setAim(Math.PI / 4); // NOT the π - x fixed point (π/2 mirrors onto itself)
    const before = socketRRotation(skin);
    skin.setBodyFacing(Math.PI); // only the body direction changes
    // With the body now flipped, the same aim needs the mirrored local angle again —
    // the socket rotation is expected to CHANGE (still correctly tracking aim), while
    // the raw aim angle itself (what setAim was called with) never did.
    const after = socketRRotation(skin);
    expect(after).not.toBeCloseTo(before, 5);
    expect(after).toBeCloseTo(Math.PI - Math.PI / 4, 10);
  });
});

/**
 * Placement model (RigSkin's "Placement model" doc block). These pin the exact two
 * mistakes that shipped a visibly disassembled hero for three weeks — art drawn at the
 * bone PIVOT instead of its TIP, and rotated by the bone's raw world angle instead of
 * its angle relative to rest. Both were invisible to every pre-existing test, since all
 * of them asserted the socket's aim rotation and nothing else.
 */
describe('RigSkin — a bone\'s art sits on its TIP, in its authored orientation', () => {
  it('the body bone draws its art on the tip (the hover height), not at the ground pivot', () => {
    const skin = makeSkin();
    skin.update();
    const shell = spritesOf(skin).get('shell')!;
    // ORB_CORE_RIG: shell is len 46 straight up (rwa -90) from the root at (0,0).
    expect(shell.x).toBeCloseTo(0, 6);
    expect(shell.y).toBeCloseTo(-46, 6);
  });

  it('the decorative bones spread across the body instead of piling up on one point', () => {
    const skin = makeSkin();
    skin.update();
    const s = spritesOf(skin);
    const at = (id: string) => [s.get(id)!.x, s.get(id)!.y].map(n => Math.round(n));
    // The eye is centred on the shell (-46) but slid along the default aim (east, so
    // +EYE_TRACK_R in x and nothing in y) by the eye-tracking pass — see its own describe
    // block below. Every other bone sits exactly on its bone tip.
    expect(at('eye')).toEqual([14, -46]);
    expect(at('belly')).toEqual([0, -26]); // 20 down from centre → the shell's lower half
    expect(at('socket_l')).toEqual([-52, -46]); // orbiting left of the core...
    expect(at('socket_r')).toEqual([52, -46]); // ...and right — 104 apart, not co-located
  });

  it('art authored upright renders upright, despite the bone pointing up (rwa -90)', () => {
    const skin = makeSkin();
    skin.update();
    const s = spritesOf(skin);
    expect(s.get('shell')!.rotation).toBeCloseTo(0, 6);
    expect(s.get('belly')!.rotation).toBeCloseTo(0, 6); // rwa +90, also cancelled
  });

  it('holds for an enemy rig too — one bone, same convention', () => {
    const skin = makeSkin(CRITTER_CORE_RIG);
    skin.update();
    const body = spritesOf(skin).get('body')!;
    expect(body.y).toBeCloseTo(-40, 6); // CRITTER_CORE_RIG's body len
    expect(body.rotation).toBeCloseTo(0, 6);
  });

  it('a clip\'s bone rotation is applied ONCE, not twice', () => {
    // Rig.computeFK already folds a bone's animated rotation into pose.wa; adding the
    // same keyframe value again on top of it doubled every authored rotation.
    const clip: AnimationClip = {
      duration: 1,
      loop: false,
      keyframes: [{ time: 0, bones: new Map([['belly', { rotation: 30 }]]) }],
    };
    const skin = makeSkin(ORB_CORE_RIG, new Map([['idle', clip]]));
    skin.playClip('idle', 0);
    skin.update();
    expect(spritesOf(skin).get('belly')!.rotation).toBeCloseTo((30 * Math.PI) / 180, 6);
  });
});

describe('RigSkin — orbiting bones get a drawn energy tether', () => {
  const tetherOf = (skin: RigSkin) => (skin as unknown as { tethers: Container | null }).tethers;

  it('orb-core gets one (its sockets declare tether widths), painted behind the body', () => {
    const skin = makeSkin();
    const tethers = tetherOf(skin);
    expect(tethers).not.toBeNull();
    expect(tethers!.zIndex).toBeLessThan(0);
    expect(skin.view.children).toContain(tethers);
  });

  it('a rig with no orbiting bones builds no tether graphics at all', () => {
    expect(tetherOf(makeSkin(CRITTER_CORE_RIG))).toBeNull();
  });

  it('the geometry signature is reused frame to frame, so an idle hover skips the rebuild', () => {
    const skin = makeSkin();
    skin.update();
    const signature = (skin as unknown as { tetherGeometry: string }).tetherGeometry;
    expect(signature).not.toBe('');
    // Both socket bones, each contributing one pivot→tip pair.
    expect(signature.split(';').filter(Boolean)).toHaveLength(2);
    skin.update();
    expect((skin as unknown as { tetherGeometry: string }).tetherGeometry).toBe(signature);
  });
});

/**
 * Both arms carry a module (design/13's "two weapon modules that orbit it"; the concept
 * turnaround draws both) — the active one tracks aim, the idle one points outward along its
 * own tether. `weaponSkins` is mocked because the real one loads textures over the network:
 * `getWeaponTexture` returning undefined would hide both modules and make these vacuous.
 */
vi.mock('./weaponSkins', () => ({
  getWeaponTexture: () => Texture.WHITE,
  getWeaponAnchor: () => ({ x: 0.2, y: 0.44 }),
  getWeaponScale: () => 0.25,
  getWeaponRotationOffset: () => 0,
}));

describe('RigSkin — two orbiting weapon modules, one active, one idle', () => {
  const modulesOf = (skin: RigSkin) =>
    skin as unknown as {
      weaponSprite: { x: number; y: number; rotation: number; visible: boolean } | null;
      idleModuleSprite: { x: number; y: number; rotation: number; visible: boolean } | null;
    };

  function armed(): RigSkin {
    const skin = makeSkin();
    skin.setWeaponKind('ranged', 'repeater');
    skin.setBodyFacing(0);
    skin.setAim(0);
    skin.update();
    return skin;
  }

  it('each module sits on its own socket\'s tip — 104 authoring-px apart, not stacked on the core', () => {
    const m = modulesOf(armed());
    expect(m.weaponSprite!.x).toBeCloseTo(52, 6);
    expect(m.weaponSprite!.y).toBeCloseTo(-46, 6);
    expect(m.idleModuleSprite!.x).toBeCloseTo(-52, 6);
    expect(m.idleModuleSprite!.y).toBeCloseTo(-46, 6);
  });

  it('the active module tracks aim; the idle one points outward along its tether instead', () => {
    const skin = armed();
    skin.setAim(Math.PI / 3);
    skin.update();
    const m = modulesOf(skin);
    expect(m.weaponSprite!.rotation).toBeCloseTo(Math.PI / 3, 10);
    expect(m.idleModuleSprite!.rotation).toBeCloseTo(Math.PI, 10); // socket_l's rest angle: away from the core
    expect(m.idleModuleSprite!.visible).toBe(true);
  });

  it('unarmed hides BOTH modules, not just the active one', () => {
    const skin = armed();
    skin.setWeaponKind(null);
    skin.update();
    const m = modulesOf(skin);
    expect(m.weaponSprite!.visible).toBe(false);
    expect(m.idleModuleSprite!.visible).toBe(false);
  });

  // muzzleLocal (2026-08-17): where the bullet view is spawned so shots leave the barrel
  // tip rather than mid-housing. The mocked weaponSkins above give a 1x1 Texture.WHITE at
  // anchor.x 0.2, scale 0.25 and rotationOffset 0 — so the reach past the socket tip is
  // (1 - 0.2) * 1 * 0.25 = 0.2 authoring-px. Small, but it is the same arithmetic the
  // real 320px textures go through, and `barrelReach` is covered on its own below.
  it('the muzzle sits past the ORBITED module, along the aim direction', () => {
    const skin = armed();
    skin.setAim(0);
    skin.update();
    // Aim east is the socket's own rest angle, so this is also where the module sat when it
    // was pinned to the bone tip (`rigWeaponMount`'s GROUND-PLANE ORBIT note) — which is why
    // every calibration taken in this pose survived the change.
    expect(skin.muzzleLocal()).toEqual({
      x: expect.closeTo(52.2, 6), y: expect.closeTo(-46, 6), heightPx: expect.closeTo(46, 6),
    });

    // Straight down-screen. The module ORBITS there (2026-09-02): the whole 52 px of socket
    // reach goes into +y and the barrel's own 0.2 follows it, instead of the module staying
    // out at x=52 and merely spinning — which is what put the drawn gun off the line its own
    // bullets fly along, and drew the arc out of the barrel.
    skin.setAim(Math.PI / 2);
    skin.update();
    expect(skin.muzzleLocal()).toEqual({
      // The HEIGHT is unchanged: the module orbited across the ground, it did not climb.
      x: expect.closeTo(0, 6), y: expect.closeTo(-46 + 52.2, 6), heightPx: expect.closeTo(46, 6),
    });
  });

  // The height half of that same point, which `Scene` needs separately (see the method's doc):
  // the module orbits IN a plane, and how high that plane is does not change with the aim.
  it('reports the muzzle HEIGHT as the plane the module orbits in, at any aim', () => {
    const skin = armed();
    for (const aim of [0, Math.PI / 2, Math.PI, -Math.PI / 2, 0.7]) {
      skin.setAim(aim);
      skin.update();
      expect(skin.muzzleLocal()!.heightPx, `aim ${aim}`).toBeCloseTo(46, 6); // orb-core's shell len
    }
  });

  // The height rides ALONG with the point rather than being its own call, so "is there a
  // muzzle at all" can only ever have one answer — the two were always asked together.
  it('reports no muzzle at all when nothing is mounted, height included', () => {
    const skin = armed();
    skin.setWeaponKind(null);
    skin.update();
    expect(skin.muzzleLocal()).toBeNull();
  });

  it('mirrors with the rig — a left-facing body puts the muzzle on the left, still ahead of the socket', () => {
    const skin = armed();
    skin.setBodyFacing(Math.PI);
    skin.setAim(Math.PI);
    skin.update();
    const m = skin.muzzleLocal()!;
    expect(skin.view.scale.x).toBe(-1);
    expect(m.x).toBeCloseTo(-52.2, 6); // past the socket tip on the mirrored side
    expect(m.y).toBeCloseTo(-46, 6);
  });

  it('is null with no module mounted — nothing for a caller to correct toward', () => {
    const skin = armed();
    skin.setWeaponKind(null);
    skin.update();
    expect(skin.muzzleLocal()).toBeNull();
  });

  it("is null on a rig that mounts nothing at all (boss-core's weaponMount: 'none')", () => {
    const skin = makeSkin(BOSS_CORE_RIG);
    skin.setWeaponKind('ranged', 'enemygun');
    skin.update();
    expect(skin.muzzleLocal()).toBeNull();
  });

  // Was asserted as `toBeNull()` until 2026-08-21, which is the defect this pass fixed: an
  // enemy having no muzzle followed from an enemy never mounting a weapon at all. Now that
  // the held path mounts one, a mob's bullets get the same barrel-tip spawn correction the
  // hero's have (Scene.reconcile), so the muzzle has to be real.
  it('is NOT null on a held-mount rig — an enemy has a barrel tip to correct toward', () => {
    const skin = makeSkin(CRITTER_CORE_RIG);
    skin.setWeaponKind('ranged', 'enemygun');
    skin.setAim(0);
    skin.update();
    const m = skin.muzzleLocal();
    expect(m).not.toBeNull();
    // body tip (0,-40) + drawnBodyR 50 along +x, then barrelReach 0.2 past that.
    expect(m!.x).toBeCloseTo(50.2, 6);
    expect(m!.y).toBeCloseTo(-40, 6);
  });
});

/**
 * The held mount, WIRED — `rigWeaponMount.test.ts` covers the geometry as a pure function;
 * these cover RigSkin actually feeding it the right inputs, which is a separate failure
 * surface and the one the mutation battery found uncovered.
 */
describe('RigSkin — the held weapon mount (the enemy body forms, 2026-08-21)', () => {
  const moduleOf = (skin: RigSkin) =>
    (skin as unknown as { weaponSprite: { x: number; y: number; visible: boolean } | null }).weaponSprite;
  const idleOf = (skin: RigSkin) =>
    (skin as unknown as { idleModuleSprite: { visible: boolean } | null }).idleModuleSprite;

  // critter-core's own measured fill. The mount has to follow the ART, so this number moving
  // has to move the gun — that is what makes one rule fit critter (0.70) and brute/floater
  // (1.00) off a single shared rig.
  it("scales the mount by the bundle's measured bodyFill, not by the declared bodyR", () => {
    const armedAt = (bodyFill: number) => {
      const skin = makeSkinWithFill(CRITTER_CORE_RIG, bodyFill);
      skin.setWeaponKind('ranged', 'enemygun');
      skin.setAim(0);
      skin.update();
      return moduleOf(skin)!.x;
    };
    const partial = armedAt(0.7);
    const full = armedAt(1);
    expect(partial).toBeLessThan(full);
    expect(full / partial).toBeCloseTo(1 / 0.7, 6);
    // And concretely: critter-core's body bone declares bodyR 50, so 0.70 of it is 35.
    expect(partial).toBeCloseTo(35, 6);
  });

  it("mounts exactly one module — a mob does not get the hero's decorative second arm", () => {
    const skin = makeSkinWithFill(CRITTER_CORE_RIG, 0.7);
    skin.setWeaponKind('ranged', 'enemygun');
    skin.update();
    expect(moduleOf(skin)!.visible).toBe(true);
    // Either never created, or created and hidden — both are "not drawn"; what must not
    // happen is a second gun appearing on a creature with one.
    expect(idleOf(skin)?.visible ?? false).toBe(false);
  });

  it('rides the body bone through a clip translation — the gun does not hang in the air', () => {
    // `computeFK` folds a clip's rotation into a bone's tip but NOT its translation, so this
    // is the plumbing that keeps a held module attached through the idle bob. Asserted here
    // and not just in the pure-function test because RigSkin has to pass `transforms` down at
    // all — dropping that argument is invisible to any fixture whose bundle has no clips.
    const clip: AnimationClip = {
      duration: 1,
      loop: false,
      keyframes: [{ time: 0, bones: new Map([['body', { translateX: 4, translateY: -9 }]]) }],
    };
    const still = makeSkinWithFill(CRITTER_CORE_RIG, 0.7);
    still.setWeaponKind('ranged', 'enemygun');
    still.setAim(0);
    still.update();
    const restX = moduleOf(still)!.x;
    const restY = moduleOf(still)!.y;

    const bobbing = makeSkinWithFill(CRITTER_CORE_RIG, 0.7, new Map([['idle', clip]]));
    bobbing.setWeaponKind('ranged', 'enemygun');
    bobbing.setAim(0);
    bobbing.playClip('idle', 0);
    bobbing.update();
    expect(moduleOf(bobbing)!.x).toBeCloseTo(restX + 4, 6);
    expect(moduleOf(bobbing)!.y).toBeCloseTo(restY - 9, 6);
  });

  it("mounts nothing on a 'none' rig, however it is armed", () => {
    const skin = makeSkin(BOSS_CORE_RIG);
    skin.setWeaponKind('ranged', 'enemygun');
    skin.update();
    expect(moduleOf(skin)?.visible ?? false).toBe(false);
    expect(idleOf(skin)?.visible ?? false).toBe(false);
  });

  it('mirrors with the body, so a left-facing mob holds its gun on its left', () => {
    const skin = makeSkinWithFill(CRITTER_CORE_RIG, 0.7);
    skin.setWeaponKind('ranged', 'enemygun');
    skin.setBodyFacing(Math.PI);
    skin.setAim(Math.PI);
    skin.update();
    expect(skin.view.scale.x).toBe(-1);
    // Canonical (pre-mirror) space puts it at +x; the whole-rig flip renders that on the left.
    expect(moduleOf(skin)!.x).toBeCloseTo(35, 6);
  });
});

describe('barrelReach — how far a weapon texture extends from its anchor', () => {
  const anchor = { x: 0.25, y: 0.5 };

  it('measures to the far edge for canonical art (socket left, business end right)', () => {
    // rotationOffset 0 = already pointing +x, so the ray leaves through the right edge.
    expect(barrelReach(320, 160, anchor, 0)).toBeCloseTo(240, 6); // (1 - 0.25) * 320
  });

  it('measures the OTHER way for art baked pointing backwards', () => {
    // A 180° offset is what cancels art drawn "socket right, business end trailing left"
    // (the GPT Image 2 composition habit weaponSkins.ts documents) — the reach is then
    // the anchor's own short side, not the long one.
    expect(barrelReach(320, 160, anchor, Math.PI)).toBeCloseTo(80, 6); // 0.25 * 320
  });

  it('leaves through whichever edge the ray hits first, not always a horizontal one', () => {
    // Straight up in texture space: the vertical edge is much nearer than either
    // horizontal one, so a naive "(1 - anchor.x) * width" would overshoot ~3x.
    expect(barrelReach(320, 160, anchor, Math.PI / 2)).toBeCloseTo(80, 6); // 0.5 * 160
  });
});

describe('RigSkin — front/back hemisphere follows body facing, not aim', () => {
  it('showBack is driven by setBodyFacing only', () => {
    const skin = makeSkin();
    skin.setBodyFacing(-Math.PI / 2); // body facing away from camera (up-screen)
    skin.setAim(Math.PI / 2); // aiming toward the camera — would flip showBack if aim drove it
    expect((skin as unknown as { showBack: boolean }).showBack).toBe(true);
  });
});

// Eye tracking (2026-08-18): the two-hemisphere billboard gives four discrete body poses,
// which is not enough direction read for a body plan that is mostly one eye (design/13).
// The eye slot slides inside the shell along the aim, turning those four into a continuum
// — with no new art, which is the whole point.
describe('RigSkin — the eye slides inside the shell along the aim', () => {
  function eyePos(skin: RigSkin): { x: number; y: number } {
    skin.update();
    const s = spritesOf(skin).get('eye')!;
    return { x: s.x, y: s.y };
  }

  it('moves right when aiming right and left when aiming left, around the same rest point', () => {
    const skin = makeSkin();
    skin.setBodyFacing(0); // unflipped, so canonical space IS screen space
    skin.setAim(0);
    const right = eyePos(skin);
    skin.setAim(Math.PI);
    const left = eyePos(skin);
    expect(right.x).toBeGreaterThan(left.x);
    // Symmetric about the authored rest position — no net drift in either direction.
    expect((right.x + left.x) / 2).toBeCloseTo(0, 5);
  });

  it('moves DOWN (toward the camera) when aiming down, by a squashed amount — this is a tilted view', () => {
    const skin = makeSkin();
    skin.setBodyFacing(0);
    skin.setAim(Math.PI / 2); // straight down-screen
    const down = eyePos(skin);
    skin.setAim(-Math.PI / 2); // straight up-screen
    const up = eyePos(skin);
    expect(down.y).toBeGreaterThan(up.y);
    // The vertical TRAVEL (up↔down) is deliberately smaller than the horizontal one.
    skin.setAim(0);
    const right = eyePos(skin);
    skin.setAim(Math.PI);
    const left = eyePos(skin);
    expect(down.y - up.y).toBeLessThan(right.x - left.x);
  });

  it('mirrors with the rig: a flipped body aiming left still looks left on screen', () => {
    const flipped = makeSkin();
    flipped.setBodyFacing(Math.PI); // body faces left → view.scale.x = -1
    flipped.setAim(Math.PI); // aiming left
    const local = eyePos(flipped);
    // Local +x renders as screen -x under the flip, so the local offset must be POSITIVE
    // for the eye to appear on the left. (Computing it in screen space instead would put
    // the eye on the wrong side of the shell for every left-facing pose.)
    expect(local.x).toBeGreaterThan(0);
    expect(flipped.view.scale.x).toBe(-1);
  });

  it('shrinks the eye as the aim turns away from the camera, and not when it turns toward it', () => {
    const skin = makeSkin();
    const scaleOf = (aim: number): number => {
      skin.setAim(aim);
      skin.update();
      return (spritesOf(skin).get('eye') as unknown as { scale: { x: number } }).scale.x;
    };
    const toward = scaleOf(Math.PI / 2); // aiming at the camera
    const away = scaleOf(-Math.PI / 2); // aiming away
    const side = scaleOf(0);
    expect(away).toBeLessThan(side);
    expect(toward).toBeCloseTo(side, 5); // no growth on the near side, only shrink on the far
  });

  it('leaves every other bone on its authored position (only the eye tracks)', () => {
    const skin = makeSkin();
    skin.setBodyFacing(0);
    skin.setAim(0);
    skin.update();
    const b = spritesOf(skin).get('belly')!;
    const bellyRight = { x: b.x, y: b.y }; // read the accessors; spreading a Pixi Sprite copies neither
    skin.setAim(Math.PI);
    skin.update();
    const bellyLeft = spritesOf(skin).get('belly')!;
    expect(bellyLeft.x).toBeCloseTo(bellyRight.x, 5);
    expect(bellyLeft.y).toBeCloseTo(bellyRight.y, 5);
  });
});

// design/01's "Per-weapon local z-order" — documented since the rendering doc was written,
// but the mounted module was pinned in front until 2026-08-18.
// The module's depth follows the MODULE, not the body (2026-09-02): it orbits to the aim now,
// so where it actually is decides whether it is on the far side of the core (design/01's
// "per-weapon local z-order"). These drive `setAim` for that reason — they used to drive
// `setBodyFacing` alone, from when the gun was pinned beside the body and the only thing that
// could put it behind was the body turning around.
describe('RigSkin — the mounted module draws behind the body when it swings to the far side', () => {
  function moduleZ(skin: RigSkin): number {
    skin.update();
    return (skin as unknown as { weaponSprite: { zIndex: number } }).weaponSprite.zIndex;
  }

  it('is in front while aiming toward the camera and behind while aiming away', () => {
    const skin = makeSkin();
    skin.setWeaponKind('ranged', 'blaster');
    skin.setBodyFacing(Math.PI / 2);
    skin.setAim(Math.PI / 2); // toward the camera — the module orbits south of the core
    expect(moduleZ(skin)).toBeGreaterThan(0);
    skin.setBodyFacing(-Math.PI / 2);
    skin.setAim(-Math.PI / 2); // away — it orbits north, i.e. behind the core
    expect(moduleZ(skin)).toBeLessThan(0);
  });

  // The case the two rules disagree on, and the reason this one is keyed off the aim: the body
  // turn is rate-limited (`facing.BODY_TURN_PER_TICK`, ~0.4 s for an about-face) while the gun
  // is already pointing at the new target. Keyed off `showBack` the gun would be drawn ACROSS
  // the core's face for those frames, having visibly swung behind it.
  it('follows the gun, not the body, while the body is still turning', () => {
    const skin = makeSkin();
    skin.setWeaponKind('ranged', 'blaster');
    skin.setBodyFacing(Math.PI / 2); // body still facing the camera...
    skin.setAim(-Math.PI / 2); // ...aim already snapped away from it
    expect(moduleZ(skin)).toBeLessThan(0);
  });

  it('re-evaluates every frame, so turning around mid-play actually restacks it', () => {
    const skin = makeSkin();
    skin.setWeaponKind('ranged', 'blaster');
    skin.setAim(-Math.PI / 2);
    const behind = moduleZ(skin); // sprite is CREATED while aiming away
    skin.setAim(Math.PI / 2);
    expect(moduleZ(skin)).toBeGreaterThan(behind); // and moves back in front on the next update
  });

  it('puts it behind the tether too, not between tether and body', () => {
    const skin = makeSkin();
    skin.setWeaponKind('ranged', 'blaster');
    skin.setBodyFacing(-Math.PI / 2);
    const tethers = (skin as unknown as { tethers: Container | null }).tethers;
    skin.setAim(-Math.PI / 2);
    expect(tethers).not.toBeNull();
    expect(moduleZ(skin)).toBeLessThan(tethers!.zIndex);
  });
});

// Sphere shading (2026-08-18 depth pass). `rigShading.test.ts` covers the marks themselves;
// this block covers how RigSkin wires them onto a rig — which bone, which z, and the one
// thing that is easy to get backwards: the key light must NOT mirror with the body.
describe('RigSkin — sphere shading over the body bone', () => {
  function shadeOf(skin: RigSkin): Graphics | null {
    return (skin as unknown as { sphereShade: Graphics | null }).sphereShade;
  }
  function shadeBoneOf(skin: RigSkin): string | null {
    return (skin as unknown as { shadeBoneId: string | null }).shadeBoneId;
  }

  it('picks the rig\'s body bone, not a decorative one', () => {
    // orb-core: shell (bodyR 40) is shaded; eye (16) and the sockets (13) are not.
    expect(shadeBoneOf(makeSkin(ORB_CORE_RIG))).toBe('shell');
    expect(shadeOf(makeSkin(ORB_CORE_RIG))).not.toBeNull();
  });

  it('shades a one-bone enemy body too — the whole roster gets the same light', () => {
    const skin = makeSkin(CRITTER_CORE_RIG);
    expect(shadeBoneOf(skin)).toBe('body');
    expect(shadeOf(skin)).not.toBeNull();
  });

  it('rides the body bone\'s drawn position, including whatever the clip translates it to', () => {
    // The idle clip bobs this bone; the shading has to follow it or it detaches from the art.
    const clips = new Map<string, AnimationClip>([
      ['bob', {
        duration: 1,
        loop: false,
        keyframes: [{ time: 0, bones: new Map([['shell', { translateY: -20 }]]) }],
      }],
    ]);
    const skin = makeSkin(ORB_CORE_RIG, clips);
    skin.update();
    const rest = shadeOf(skin)!.y;
    skin.playClip('bob', 0);
    skin.update();
    expect(shadeOf(skin)!.y).toBeCloseTo(rest - 20, 5);
  });

  it('sits immediately over the body art and under everything drawn after it', () => {
    const rig = new Rig(ORB_CORE_RIG);
    const bundle = fakeBundle(rig);
    // Give the bones distinct zOrders, as a real animation.json does (orb-core: 0..4).
    let z = 0;
    for (const boneId of rig.drawOrder) bundle.bindings.get(boneId)!.zOrder = z++;
    const skin = new RigSkin(rig, bundle);
    const shade = (skin as unknown as { sphereShade: Graphics }).sphereShade;
    expect(shade.zIndex).toBeGreaterThan(bundle.bindings.get('shell')!.zOrder);
    expect(shade.zIndex).toBeLessThan(bundle.bindings.get('belly')!.zOrder);
  });

  it('counter-flips so the key light stays put while the body mirrors', () => {
    // The single thing this could get wrong: the light is fixed in SCREEN space. If the
    // shading mirrored with the rig, the highlight would jump sides every time the player
    // turned around — which reads as the light source teleporting, not as a body turning.
    //
    // Read after `update()` because that is where the counter-flip is written since 2026-09-02:
    // the quad's scale now carries the body bone's clip squash as well (`placeSphereShade`), and
    // one property is written in one place. So this asserts the net transform on a RENDERED
    // frame rather than mid-way through the facing setters, which is the stronger claim anyway.
    const skin = makeSkin(ORB_CORE_RIG);
    skin.setBodyFacing(0); // facing right, no flip
    skin.update();
    expect(skin.view.scale.x * shadeOf(skin)!.scale.x).toBe(1);
    skin.setBodyFacing(Math.PI); // facing left, whole rig flips
    skin.update();
    expect(skin.view.scale.x).toBe(-1);
    expect(skin.view.scale.x * shadeOf(skin)!.scale.x).toBe(1); // net transform unchanged
  });

  it('leaves the shading in exactly the same place on screen when the body flips', () => {
    // The scale product above was a sufficient check while the marks WERE the geometry: cancel the
    // transform and the marks land where they landed. Since 2026-08-24 the marks live in a texture
    // and the geometry is one symmetric quad, so a cancelled transform no longer implies a
    // cancelled *look* — the field mirrors with the quad only because it is sampled in the quad's
    // own local space (`textureSpace: 'local'`), and the quad mirrors in place only because it is
    // centred on the body. Get either wrong and the shading either double-flips or slides sideways,
    // with the scale product still reading 1.
    //
    // So this asserts the thing that actually matters: the overlay occupies the same world rect
    // whichever way the body faces.
    const skin = makeSkin(ORB_CORE_RIG);
    skin.setBodyFacing(0);
    skin.update();
    const right = shadeOf(skin)!.getBounds().rectangle.clone();
    skin.setBodyFacing(Math.PI);
    skin.update();
    const left = shadeOf(skin)!.getBounds().rectangle;
    expect(left.x).toBeCloseTo(right.x, 6);
    expect(left.y).toBeCloseTo(right.y, 6);
    expect(left.width).toBeCloseTo(right.width, 6);
    expect(left.height).toBeCloseTo(right.height, 6);
    expect(right.width).toBeGreaterThan(0); // not vacuous
    // And the quad really is centred, which is the premise that makes a mirror a no-op in position.
    const local = shadeOf(skin)!.getLocalBounds();
    expect(local.minX).toBeCloseTo(-local.maxX, 6);
    expect(local.minY).toBeCloseTo(-local.maxY, 6);
  });
});

// The far-side depth cues stacked on top of the z-flip covered above (2026-08-18).
describe('RigSkin — a far-side module is drawn smaller and darker, not just behind', () => {
  function activeModule(skin: RigSkin): { scale: { x: number }; tint: number; zIndex: number } {
    skin.update();
    return (skin as unknown as { weaponSprite: { scale: { x: number }; tint: number; zIndex: number } }).weaponSprite;
  }

  it('shrinks and darkens it when the body faces away, and restores both when it turns back', () => {
    const skin = makeSkin();
    skin.setWeaponKind('ranged', 'blaster');
    skin.setBodyFacing(Math.PI / 2); // toward the camera
    const front = { scale: activeModule(skin).scale.x, tint: activeModule(skin).tint };

    skin.setBodyFacing(-Math.PI / 2); // away
    skin.setAim(-Math.PI / 2); // ...and the gun with it, which is what the depth cue tracks
    expect(activeModule(skin).scale.x).toBeLessThan(front.scale);
    expect(activeModule(skin).tint).toBeLessThan(front.tint);

    skin.setBodyFacing(Math.PI / 2);
    skin.setAim(Math.PI / 2);
    expect(activeModule(skin).scale.x).toBeCloseTo(front.scale, 6);
    expect(activeModule(skin).tint).toBe(front.tint);
  });

  it('re-derives the depth tint from the CURRENT element colour, not a stale one', () => {
    // setWeaponTint only knows the element hue; the depth shade has to be recombined with it
    // every frame, or swapping to a fire weapon while aiming north keeps the old colour.
    const skin = makeSkin();
    skin.setWeaponKind('ranged', 'blaster');
    skin.setBodyFacing(-Math.PI / 2); // away — the shaded branch
    skin.setWeaponTint(0xffffff);
    const light = activeModule(skin).tint;
    skin.setWeaponTint(0x808080);
    expect(activeModule(skin).tint).toBeLessThan(light);
  });

  it('applies the same treatment to the decorative idle module, so the pair reads as one assembly', () => {
    const skin = makeSkin();
    skin.setWeaponKind('ranged', 'blaster');
    skin.setBodyFacing(Math.PI / 2);
    skin.update();
    const idle = (skin as unknown as { idleModuleSprite: { scale: { x: number }; tint: number } }).idleModuleSprite;
    const frontScale = idle.scale.x;
    skin.setBodyFacing(-Math.PI / 2);
    skin.update();
    expect(idle.scale.x).toBeLessThan(frontScale);
  });
});

describe('RigSkin — rigs that get no sphere shading, and rigs whose body moves', () => {
  function shadeOf(skin: RigSkin): Graphics | null {
    return (skin as unknown as { sphereShade: Graphics | null }).sphereShade;
  }

  it('skips a rig whose largest body is only a decorative nub, and still updates cleanly', () => {
    // Below SHADE_MIN_BODY_R the marks would be sub-pixel noise on screen. The important half of
    // this is the second assertion: `update()` reads `sphereShade`/`shadeBoneId` every frame, so
    // the null path has to be exercised, not just constructed.
    const tinyRig: RigDef = {
      id: 'tiny',
      label: 'Tiny',
      bones: [
        { id: 'root', parent: null, len: 0, rwa: 0, label: 'Root' },
        { id: 'body', parent: 'root', len: 10, rwa: -90, bodyR: 8, label: 'Body' },
      ],
      drawOrder: ['body'],
    };
    const skin = makeSkin(tinyRig);
    expect(shadeOf(skin)).toBeNull();
    expect(() => skin.update()).not.toThrow();
    skin.setBodyFacing(Math.PI);
    expect(() => skin.update()).not.toThrow(); // ...including the counter-flip/squash path
  });

  it('skips a body bone with no bound art, since there is nothing to shade', () => {
    const rig = new Rig(ORB_CORE_RIG);
    const bundle = fakeBundle(rig);
    bundle.textures.delete('shell');
    bundle.bindings.delete('shell');
    const skin = new RigSkin(rig, bundle);
    expect(shadeOf(skin)).toBeNull();
    expect(() => skin.update()).not.toThrow();
  });

  it('shades the boss core too — the whole roster shares one light', () => {
    const skin = makeSkin(BOSS_CORE_RIG);
    expect((skin as unknown as { shadeBoneId: string | null }).shadeBoneId).toBe('core');
    expect(shadeOf(skin)).not.toBeNull();
  });

  it('scales the marks to each rig\'s own body radius', () => {
    // orb-core's shell is 40 authoring px, boss-core's core is 70; the shading is drawn in the
    // rig's own space, so it has to be sized per rig rather than from one constant.
    const orb = shadeOf(makeSkin(ORB_CORE_RIG))!;
    const boss = shadeOf(makeSkin(BOSS_CORE_RIG))!;
    expect(boss.bounds.width / orb.bounds.width).toBeCloseTo(70 / 40, 1);
  });

  it('follows the body bone\'s clip alpha, so it fades out with the body it sits on', () => {
    const clips = new Map<string, AnimationClip>([
      ['fade', { duration: 1, loop: false, keyframes: [{ time: 0, bones: new Map([['shell', { alpha: 0.25 }]]) }] }],
    ]);
    const skin = makeSkin(ORB_CORE_RIG, clips);
    skin.playClip('fade', 0);
    skin.update();
    expect(shadeOf(skin)!.alpha).toBeCloseTo(0.25, 6);
  });

  it('hides itself when the body bone has no pose at all', () => {
    const skin = makeSkin(ORB_CORE_RIG);
    skin.update();
    expect(shadeOf(skin)!.visible).toBe(true);
    // Force the FK result to omit the shaded bone, the way a malformed clip/rig pair could.
    const rig = (skin as unknown as { rig: { computeFK: unknown } }).rig;
    rig.computeFK = () => new Map();
    skin.update();
    expect(shadeOf(skin)!.visible).toBe(false);
  });
});

// The 2026-08-19 volume pass. Two things landed here, and both are the kind of relationship
// that reads as fine in the source of either file on its own:
//
//   1. Everything drawn ON the body — the sphere shading, the module contacts — must be sized
//      against what the ART PAINTS, not against the bone's declared `bodyR`. Nothing in this
//      renderer is masked (deliberately: a mask per actor would be 30 stencil passes in a busy
//      room), so a mark sized to a radius the art does not reach paints straight onto the
//      transparent background. That is what put a hard-edged dark disc around `critter-core`,
//      whose art fills 0.70 of its bodyR.
//   2. The orbiting modules had nothing seating them against the core, so at play scale they
//      read as decals floating in front of the body.
describe('RigSkin — the body art\'s drawn radius, not its declared one', () => {
  function shadeOf(skin: RigSkin): Graphics {
    return (skin as unknown as { sphereShade: Graphics }).sphereShade;
  }
  function makeFilled(fill: number, def = ORB_CORE_RIG): RigSkin {
    const rig = new Rig(def);
    return new RigSkin(rig, fakeBundle(rig), fill);
  }
  /** The shading's own reach from the body centre, in authoring px. */
  function reach(skin: RigSkin): number {
    const b = shadeOf(skin).bounds;
    return Math.max(-b.minX, b.maxX, -b.minY, b.maxY);
  }

  it('defaults to 1, so a caller that knows nothing about fill behaves as before', () => {
    const rig = new Rig(ORB_CORE_RIG);
    const withDefault = new RigSkin(rig, fakeBundle(rig));
    const withExplicitOne = makeFilled(1);
    expect(reach(withDefault)).toBeCloseTo(reach(withExplicitOne), 6);
  });

  it('scales the shading marks by the fill, so they land ON the art', () => {
    // orb-core's shell declares bodyR 40; `char_vanguard`'s shell PNG paints 0.81 of it. Strictly
    // INSIDE, not flush: none of this art is a circle (`critter-core`'s crystal cluster is 35 wide
    // by 38 tall with gaps at its corners), so a ramp sized flush to the painted half-width still
    // shows an arc of shading on the background diagonally out from it.
    expect(reach(makeFilled(0.81))).toBeLessThan(40 * 0.81);
    expect(reach(makeFilled(0.7, CRITTER_CORE_RIG))).toBeLessThan(50 * 0.7);
  });

  it('keeps NOTHING outside the painted radius — the defect this fixes', () => {
    // `critter-core` at 0.70 is the worst case in the shipped roster: at fill 1 the ramp
    // reached 35 authoring px past its own crystal and painted a dark disc on the background.
    const painted = 50 * 0.7;
    expect(reach(makeFilled(0.7, CRITTER_CORE_RIG))).toBeLessThan(painted);
    expect(reach(makeFilled(1, CRITTER_CORE_RIG))).toBeGreaterThan(painted); // ...and would again
  });

  it('is proportional, so the whole roster gets the same treatment', () => {
    expect(reach(makeFilled(0.5)) / reach(makeFilled(1))).toBeCloseTo(0.5, 6);
  });
});

describe('RigSkin — contact shades seat an orbiting module against the core', () => {
  function aoOf(skin: RigSkin): Container | null {
    return (skin as unknown as { moduleAO: Container | null }).moduleAO;
  }
  /** One child Graphics per mount (`rigShading.drawModuleContacts`); the showing ones. */
  function contactsOf(ao: Container): Graphics[] {
    return (ao.children as Graphics[]).filter((g) => g.visible);
  }
  function fillCount(ao: Container): number {
    return contactsOf(ao).reduce((n, g) => n + (g.context.instructions as Array<{ action: string }>).filter((i) => i.action === 'fill').length, 0);
  }

  it('exists for a rig with orbiting modules, and not for a rig without them', () => {
    // orb-core has two tethered sockets; critter-core is one bone with no module at all, so
    // there is nothing to seat and no Graphics to pay for.
    expect(aoOf(makeSkin(ORB_CORE_RIG))).not.toBeNull();
    expect(aoOf(makeSkin(CRITTER_CORE_RIG))).toBeNull();
  });

  it('sits over the body art and the shading, and UNDER the module it belongs to', () => {
    // If it drew over the module, it would be a dark smear on the gun rather than a shade
    // under it. orb-core's real zOrders are shell 0, belly 1, eye 2, sockets 3/4.
    const rig = new Rig(ORB_CORE_RIG);
    const bundle = fakeBundle(rig);
    let z = 0;
    for (const boneId of rig.drawOrder) bundle.bindings.get(boneId)!.zOrder = z++;
    const skin = new RigSkin(rig, bundle);
    const ao = aoOf(skin)!;
    const shade = (skin as unknown as { sphereShade: Graphics }).sphereShade;
    expect(ao.zIndex).toBeGreaterThan(shade.zIndex);
    expect(ao.zIndex).toBeLessThan(bundle.bindings.get('socket_l')!.zOrder);
    expect(ao.zIndex).toBeLessThan(bundle.bindings.get('socket_r')!.zOrder);
  });

  it('draws one contact per orbiting module, positioned on the body bone\'s tip', () => {
    const skin = makeSkin(ORB_CORE_RIG);
    skin.update();
    const ao = aoOf(skin)!;
    const shade = (skin as unknown as { sphereShade: Graphics }).sphereShade;
    expect(ao.x).toBeCloseTo(shade.x, 6); // same origin as the shading it sits on
    expect(ao.y).toBeCloseTo(shade.y, 6);
    expect(fillCount(ao)).toBeGreaterThanOrEqual(2); // socket_l and socket_r, nested passes each
  });

  it('never accumulates across per-frame updates', () => {
    // It IS updated every frame (the mounts orbit), which makes this the difference between
    // a contact shade and an ever-darkening blob.
    const skin = makeSkin(ORB_CORE_RIG);
    skin.update();
    const first = fillCount(aoOf(skin)!);
    for (let i = 0; i < 5; i++) skin.update();
    expect(fillCount(aoOf(skin)!)).toBe(first);
  });

  it('stays inside the painted body, wherever the socket tip actually is', () => {
    // The socket bones are LONGER than the shell's radius (orb-core: len 52 vs bodyR 40), so an
    // unclamped contact would sit mostly on transparent background — a dark smudge beside the
    // character instead of a shade on it. This is the same invariant the shading holds.
    for (const fill of [1, 0.81, 0.5]) {
      const rig = new Rig(ORB_CORE_RIG);
      const skin = new RigSkin(rig, fakeBundle(rig), fill);
      skin.update();
      const b = aoOf(skin)!.getLocalBounds();
      const painted = 40 * fill;
      expect(Math.max(-b.minX, b.maxX, -b.minY, b.maxY)).toBeLessThanOrEqual(painted);
    }
  });

  it('follows the body bone\'s clip alpha, so it fades with the body it sits on', () => {
    const clips = new Map<string, AnimationClip>([
      ['fade', { duration: 1, loop: false, keyframes: [{ time: 0, bones: new Map([['shell', { alpha: 0.25 }]]) }] }],
    ]);
    const skin = makeSkin(ORB_CORE_RIG, clips);
    skin.playClip('fade', 0);
    skin.update();
    expect(aoOf(skin)!.alpha).toBeCloseTo(0.25, 5);
  });

  it('hides itself when the body bone has no pose at all', () => {
    const skin = makeSkin(ORB_CORE_RIG);
    skin.update();
    expect(aoOf(skin)!.visible).toBe(true);
    // Force the FK result to omit the body bone, the way a malformed clip/rig pair could —
    // same trick the sphere-shading suite above uses for the same branch.
    const rig = (skin as unknown as { rig: { computeFK: unknown } }).rig;
    rig.computeFK = () => new Map();
    skin.update();
    expect(aoOf(skin)!.visible).toBe(false);
  });

  it('tracks a module the clip TRANSLATES, not only one it rotates', () => {
    // `computeFK` folds a clip's rotation into a bone's tip but not its translation — the sprite
    // loop adds that separately. A contact that read only the pose would sit still while the
    // module recoiled away from it, which is precisely the "decal floating in front" look this
    // whole mark exists to remove.
    const clips = new Map<string, AnimationClip>([
      // -44 pulls the module's tip in from 52 to 8 authoring px, i.e. INSIDE the contact's own
      // clamp radius, which is where a distance change is observable at all: past the clamp every
      // mount lands on the same circle by construction (see `drawModuleContacts`).
      ['kick', { duration: 1, loop: false, keyframes: [{ time: 0, bones: new Map([['socket_r', { translateX: -44 }]]) }] }],
    ]);
    const skin = makeSkin(ORB_CORE_RIG, clips);
    // Each contact is built around its own origin and positioned, so its centre IS its x.
    const centres = (): number[] => contactsOf(aoOf(skin)!).map((g) => g.x);
    skin.update();
    const rest = centres();
    skin.playClip('kick', 0);
    skin.update();
    expect(centres()).not.toEqual(rest);
  });

  // Driven by the AIM rather than by a clip rotation of `socket_r` (2026-09-02): the active
  // socket's angle is the aim's to own now — `orbitActiveSocketToAim` overrides it before FK,
  // which is what makes the ring, the tether and the module travel as one assembly — so a clip
  // keyframe on that bone's rotation no longer moves anything. The invariant under test is
  // unchanged: the mounts are re-derived every frame, never cached at creation.
  it('re-derives the mounts every frame, so a module that orbits drags its contact along', () => {
    const skin = makeSkin(ORB_CORE_RIG);
    // Snapshot the NUMBERS, not the Bounds object — Pixi mutates one instance in place, so
    // holding the reference across a redraw would compare it against itself and pass on nothing.
    const snap = (): number[] => {
      const b = aoOf(skin)!.getLocalBounds();
      return [b.minX, b.minY, b.maxX, b.maxY];
    };
    skin.setAim(0);
    skin.update();
    const before = snap();
    skin.setAim(Math.PI / 2); // the module orbits a quarter turn around the core
    skin.update();
    expect(snap()).not.toEqual(before);
  });
});

describe('the front-only bone set — design/12\'s last facing-model gap', () => {
  /** Like `fakeBundle`, but the caller chooses which `__back` variants exist. */
  function bundleWithBacks(rig: Rig, backs: string[]): RigSkinBundle {
    const bindings = new Map<string, SpriteBinding>();
    const textures = new Map<string, Texture>();
    for (const boneId of rig.drawOrder) {
      bindings.set(boneId, { anchorX: 0.5, anchorY: 0.5, flipX: false, zOrder: 0, rotation: 0, scaleX: 1, scaleY: 1 });
      textures.set(boneId, Texture.WHITE);
    }
    for (const boneId of backs) textures.set(`${boneId}__back`, Texture.EMPTY);
    return { bindings, clips: new Map(), textures };
  }

  function visibility(skin: RigSkin): Record<string, boolean> {
    skin.update();
    const sprites = (skin as unknown as { sprites: Map<string, { visible: boolean }> }).sprites;
    return Object.fromEntries([...sprites].map(([id, s]) => [id, s.visible]));
  }

  function skinWith(backs: string[]): RigSkin {
    const rig = new Rig(ORB_CORE_RIG);
    return new RigSkin(rig, bundleWithBacks(rig, backs));
  }

  it('draws every bone while the character faces the camera', () => {
    const skin = skinWith(['eye']);
    skin.setBodyFacing(Math.PI / 2); // toward the camera (front hemisphere)
    const vis = visibility(skin);
    expect(Object.values(vis).every((v) => v)).toBe(true);
    expect(vis.belly).toBe(true);
  });

  it('hides the belly — and ONLY the belly — once the character turns away', () => {
    // The reported shape of the bug: the eye swapped to `eye__back` but the transparent
    // front chamber kept drawing, so a character running away still showed its belly.
    const skin = skinWith(['eye']);
    skin.setBodyFacing(-Math.PI / 2); // away from the camera (back hemisphere)
    const vis = visibility(skin);
    expect(vis.belly).toBe(false);
    for (const [id, v] of Object.entries(vis)) {
      if (id !== 'belly') expect({ id, v }).toEqual({ id, v: true });
    }
  });

  it('never hides the shell, which has no back art either', () => {
    // The failure mode of keying this off "bones missing a __back texture" instead of off
    // what the art depicts: `shell` is missing one too, and hiding it deletes the character.
    const skin = skinWith([]);
    skin.setBodyFacing(-Math.PI / 2);
    expect(visibility(skin).shell).toBe(true);
  });

  it('draws the belly again the moment real `belly__back` art exists, with no code change', () => {
    // The hide is a FALLBACK, not a rule — design/12 offers both fixes and this keeps the
    // other one free. If this test ever fails, shipping the PNG stopped being sufficient.
    const skin = skinWith(['eye', 'belly']);
    skin.setBodyFacing(-Math.PI / 2);
    expect(visibility(skin).belly).toBe(true);
  });

  it('comes back on turning around, rather than latching off for the rest of the run', () => {
    const skin = skinWith(['eye']);
    skin.setBodyFacing(-Math.PI / 2);
    expect(visibility(skin).belly).toBe(false);
    skin.setBodyFacing(Math.PI / 2);
    expect(visibility(skin).belly).toBe(true);
  });
});

/**
 * The fire recoil landing on a real rig (2026-08-30, user report *"角色射击时，没有射击动画"*).
 * `rigAttackMotion.test.ts` covers the envelope and `rigWeaponMount.test.ts` the mount arithmetic;
 * what is only visible HERE is that one `kick()` moves all four things that have to move
 * together — the module sprite, the socket ring it is mounted on, the body, and the muzzle
 * point the bullet and the fx are anchored to — and that all four come back.
 */
describe('RigSkin — the fire recoil', () => {
  const modulesOf = (skin: RigSkin) =>
    skin as unknown as { weaponSprite: { x: number; y: number } | null };

  function armed(): RigSkin {
    const skin = makeSkin();
    skin.setWeaponKind('ranged', 'repeater');
    skin.setBodyFacing(0);
    skin.setAim(0);
    skin.update();
    return skin;
  }

  /** Lay the rig out at the peak of the envelope (RECOIL_MS * RECOIL_ATTACK). */
  function atPeak(skin: RigSkin): void {
    skin.attack('ranged');
    skin.advanceClips(RECOIL_MS * 0.22);
    skin.update();
  }

  it('kicks the module, its socket ring and the body back along the aim, together', () => {
    const skin = armed();
    const restModule = modulesOf(skin).weaponSprite!.x;
    const restSocket = spritesOf(skin).get('socket_r')!.x;
    atPeak(skin);
    expect(modulesOf(skin).weaponSprite!.x).toBeLessThan(restModule);
    // The ring goes with the gun, or the gun slides out of its own housing.
    expect(spritesOf(skin).get('socket_r')!.x).toBeLessThan(restSocket);
    expect(skin.view.x).toBeLessThan(0);
  });

  it('leans the body LESS than it kicks the gun', () => {
    const skin = armed();
    const restModule = modulesOf(skin).weaponSprite!.x;
    atPeak(skin);
    const gunKick = restModule - modulesOf(skin).weaponSprite!.x;
    expect(Math.abs(skin.view.x)).toBeLessThan(gunKick);
  });

  // Stated as the EXACT composed distance, not just a direction. A survivor of the 2026-08-30
  // battery is why: `muzzleLocal` dropping `+ view.position` — i.e. reporting a barrel tip that
  // does not carry the body's own lean — left every assertion here passing, because the 10 px
  // module kick swamps the 3 px body shove and the muzzle still moved backwards. The fx and the
  // next shot's spawn correction both read this point, so the ~1 world px it loses is a real
  // (small) mis-anchor, and only the arithmetic can see it.
  it('moves the muzzle by the module kick, the body lean AND the muzzle climb', () => {
    // The third term arrived 2026-09-02 and it is the one a player can always see: the slide is
    // foreshortened to nothing when firing toward or away from the camera, the rotation is not.
    // It shows up here as a barrel tip that RISES and, because a rotated barrel reaches less far
    // along the aim, an along-aim displacement slightly greater than kick + lean.
    const skin = armed();
    const rest = skin.muzzleLocal()!;
    atPeak(skin);
    const kicked = skin.muzzleLocal()!;
    const along = rest.x - kicked.x;
    const rise = rest.y - kicked.y;
    expect(along).toBeGreaterThan(RECOIL_MODULE_PX + RECOIL_BODY_PX);
    expect(rise).toBeGreaterThan(0);
    // Pinned exactly, and independently of the rig's own barrel reach: rotating a barrel of any
    // length R by the climb angle lifts the tip by `R*sin(climb)` and shortens its reach by
    // `R*(1 - cos(climb))`, and the ratio of those two is `tan(climb/2)` with R cancelled out.
    const climbRad = (RECOIL_CLIMB_DEG * Math.PI) / 180;
    const extra = along - (RECOIL_MODULE_PX + RECOIL_BODY_PX);
    expect(extra / rise).toBeCloseTo(Math.tan(climbRad / 2), 6);
  });

  it('follows the aim rather than kicking in a fixed screen direction', () => {
    // Measured in AIM-RELATIVE components, which is what the claim is actually about. It used to
    // be enough to check the whole displacement was along the aim, because the whole recoil was;
    // since the muzzle climb arrived (2026-09-02) the kick has a second, ACROSS-aim term as
    // well — the assembly rotates about the core — and both terms have to turn with the aim
    // rather than pointing at a fixed corner of the screen.
    const relative = (aim: number): { along: number; across: number } => {
      const skin = armed();
      skin.setAim(aim);
      skin.update();
      // Read the fields out rather than spreading: `x`/`y` are prototype accessors on a Pixi
      // Sprite, so a spread copy silently loses them (and every assertion below with it).
      const restX = modulesOf(skin).weaponSprite!.x;
      const restY = modulesOf(skin).weaponSprite!.y;
      atPeak(skin);
      const dx = modulesOf(skin).weaponSprite!.x - restX;
      const dy = modulesOf(skin).weaponSprite!.y - restY;
      return {
        along: dx * Math.cos(aim) + dy * Math.sin(aim),
        across: -dx * Math.sin(aim) + dy * Math.cos(aim),
      };
    };
    const east = relative(0);
    const down = relative(Math.PI / 2); // straight down-screen
    expect(east.along).toBeLessThan(0); // back down its own barrel, not down the screen
    expect(down.along).toBeCloseTo(east.along, 6);
    expect(down.across).toBeCloseTo(east.across, 6);
    // ...and the slide is still the dominant term, so a shot does not read as a swipe.
    expect(Math.abs(east.across)).toBeLessThan(Math.abs(east.along));
  });

  it('returns everything to exactly its rest pose once the envelope is spent', () => {
    const skin = armed();
    const restX = modulesOf(skin).weaponSprite!.x;
    const restY = modulesOf(skin).weaponSprite!.y;
    const restSocketX = spritesOf(skin).get('socket_r')!.x;
    const restMuzzle = skin.muzzleLocal()!;
    atPeak(skin);
    skin.advanceClips(1000);
    skin.update();
    expect(modulesOf(skin).weaponSprite!.x).toBeCloseTo(restX, 10);
    expect(modulesOf(skin).weaponSprite!.y).toBeCloseTo(restY, 10);
    expect(spritesOf(skin).get('socket_r')!.x).toBeCloseTo(restSocketX, 10);
    expect(skin.view.x).toBeCloseTo(0, 10); // closeTo, not toBe: `-cos(0) * 0` is -0
    expect(skin.view.y).toBeCloseTo(0, 10);
    expect(skin.muzzleLocal()!.x).toBeCloseTo(restMuzzle.x, 10);
  });

  // A rig with no `attack` clip must still visibly fire — the aim-relative envelope covers the
  // whole roster on its own, and the clip layer is additive on top of it (rigAttackMotion.ts,
  // rigClipLayer.ts). `makeSkin`'s bundle carries no clips at all, so this IS that case.
  it('kicks a held-mount rig (an enemy) too, with no attack clip in its bundle', () => {
    const skin = makeSkin(CRITTER_CORE_RIG);
    skin.setWeaponKind('ranged', 'enemygun');
    skin.setBodyFacing(0);
    skin.setAim(0);
    skin.update();
    const rest = skin.muzzleLocal()!;
    atPeak(skin);
    expect(skin.muzzleLocal()!.x).toBeLessThan(rest.x);
  });

  it('is inert until something actually fires', () => {
    const skin = armed();
    const restX = modulesOf(skin).weaponSprite!.x;
    skin.advanceClips(16);
    skin.update();
    expect(modulesOf(skin).weaponSprite!.x).toBe(restX);
    expect(skin.view.x).toBeCloseTo(0, 10);
  });
});

/**
 * The MELEE swing landing on a real rig (2026-09-02), and the reason it cannot be an authored
 * clip: `update()` OVERWRITES every aim-tracking bone's rotation with the aim angle, and hands
 * the same angle to the module mount. A swing authored into `attack` would be discarded without
 * a word — `rigClipLayer.test.ts` proves the layer applies the clip, and it still would not turn
 * a blade. What is only visible HERE is that the swing reaches the socket and the mounted
 * sprite, that it leaves the parts it must not touch alone, and that it comes back to the aim.
 */
describe('RigSkin — the melee swing', () => {
  const modulesOf = (skin: RigSkin) =>
    skin as unknown as { weaponSprite: { x: number; y: number; rotation: number } | null };

  /** Pixi's x/y/rotation are prototype ACCESSORS, so `{ ...sprite }` silently copies none of
   *  them and every later comparison reads `undefined` — copy the three by hand. */
  const snap = (s: { x: number; y: number; rotation: number }) => ({ x: s.x, y: s.y, rotation: s.rotation });

  function bladed(aim = 0): RigSkin {
    const skin = makeSkin();
    skin.setWeaponKind('melee', 'saber');
    skin.setBodyFacing(aim);
    skin.setAim(aim);
    skin.update();
    return skin;
  }

  /** The default envelope's real length — the saber's 4-tick hit window over SWING_STRIKE
   *  (ENGINE_VERSION 53), NOT the `SWING_MS` constant, which is only the no-window fallback. */
  const DEFAULT_TOTAL_MS = swingSchedule().totalMs;

  /** Lay the rig out at the far end of the strike (SWING_STRIKE through the envelope). */
  function atStrike(skin: RigSkin): void {
    skin.attack('melee');
    skin.advanceClips(DEFAULT_TOTAL_MS * 0.55);
    skin.update();
  }

  it('sweeps the socket ahead of the aim, by the arc the envelope reports', () => {
    const skin = bladed();
    const rest = spritesOf(skin).get('socket_r')!.rotation;
    atStrike(skin);
    const swung = spritesOf(skin).get('socket_r')!.rotation;
    expect(swung - rest).toBeCloseTo((SWING_ARC_DEG * Math.PI) / 180, 6);
  });

  it('sweeps a WIDE weapon further than a narrow one, from the same trigger', () => {
    // The last hop of the weapon->motion chain, measured where it is finally visible: on the
    // socket the blade is mounted to. `rigAttackMotion.test.ts` pins the envelope's own numbers;
    // what this adds is that `attack`'s second argument reaches it at all — without it both of
    // these sweep the identical 46°, and every other melee assertion in this file still passes.
    const sweep = (shape?: SwingShape): number => {
      const skin = bladed();
      const rest = spritesOf(skin).get('socket_r')!.rotation;
      skin.attack('melee', shape);
      skin.advanceClips(swingSchedule(shape).totalMs * 0.55); // undefined -> DEFAULT_SWING
      skin.update();
      return spritesOf(skin).get('socket_r')!.rotation - rest;
    };
    // The saber's own timing and heft on both, so the ARC is the only thing that differs.
    const rest = { ...DEFAULT_SWING };
    const poke = sweep({ ...rest, arcDeg: 60 });
    const heave = sweep({ ...rest, arcDeg: 220 });
    expect(heave).toBeGreaterThan(poke * 2);
    // ...and no shape at all still lands on the tuned constant, i.e. the fallback is intact.
    expect(sweep()).toBeCloseTo((SWING_ARC_DEG * Math.PI) / 180, 6);
  });


  it('drives a NARROW weapon module out along its barrel — both the ring and the blade', () => {
    // The last hop of the thrust chain, and the bug class this file has already caught once (see
    // `carries the mounted blade around with the socket, not just the ring` below): `modulePx` is
    // read in TWO places — the aim-tracking bone loop and `rigWeaponMount.activeModuleMount` — so
    // a thrust wired into one of them slides an empty housing while the sword stays put, or the
    // reverse. Both are asserted, and neither could be by reading `AttackMotion` alone.
    //
    // Isolating the thrust from the SWEEP is the whole difficulty: a swing rotates the assembly
    // as well as driving it, and the socket orbits about its own JOINT rather than about the rig
    // origin, so no radius or single axis separates the two. The control that does: a rig posed
    // STATICALLY at the angle the swing has reached. Both rigs then have the identical weapon
    // angle and therefore the identical FK pose, and everything left between them is the recoil
    // channel — zero for a weapon that only sweeps, a forward slide for one that thrusts.
    const sample = (skin: RigSkin) => {
      const r = spritesOf(skin).get('socket_r')!;
      const b = modulesOf(skin).weaponSprite!;
      return { ringX: r.x, ringY: r.y, bladeX: b.x, bladeY: b.y };
    };
    /** Mid-swing at `t`, against a rig held still at the angle that swing has reached. */
    const thrustAt = (shape: SwingShape, t: number) => {
      const swung = bladed();
      swung.setWeaponKind('melee', 'spear');
      swung.attack('melee', shape);
      swung.advanceClips(t);
      swung.update();
      const motion = (swung as unknown as { motion: { weaponDeg: number } }).motion;

      const posed = bladed();
      posed.setWeaponKind('melee', 'spear');
      posed.setAim((motion.weaponDeg * Math.PI) / 180); // same weapon angle, no attack in flight
      posed.update();

      const a = sample(swung);
      const b = sample(posed);
      return { ring: a.ringX - b.ringX, blade: Math.hypot(a.bladeX - b.bladeX, a.bladeY - b.bladeY) };
    };

    const spear = { ...DEFAULT_SWING, arcDeg: 60 };
    const strike = thrustAt(spear, swingSchedule(spear).strikeEndMs);
    expect(strike.blade).toBeGreaterThan(0); // the blade is driven OUT, not merely turned
    expect(strike.ring).toBeGreaterThan(0); // ...and its housing goes with it, along the aim

    // A wide weapon at the same point in its own swing ONLY turns: the saber derives no thrust,
    // so mid-swing and posed-at-that-angle are the same rig to the last float.
    const saber = thrustAt(DEFAULT_SWING, swingSchedule(DEFAULT_SWING).strikeEndMs);
    expect(saber.blade).toBeCloseTo(0, 6);
    expect(saber.ring).toBeCloseTo(0, 6);

    // And it comes home: a thrust that settled anywhere but 0 leaves the weapon off its mount.
    const spent = thrustAt(spear, swingSchedule(spear).totalMs);
    expect(spent.blade).toBeCloseTo(0, 6);
    expect(spent.ring).toBeCloseTo(0, 6);
  });

  it('carries the mounted blade around with the socket, not just the ring', () => {
    // Two separate code paths read the angle (the bone sprite loop and `activeModuleMount`), so
    // a swing wired into only one of them turns an empty housing while the sword stays put.
    const skin = bladed();
    const rest = snap(modulesOf(skin).weaponSprite!);
    const restTip = skin.muzzleLocal()!;
    atStrike(skin);
    const swung = modulesOf(skin).weaponSprite!;
    expect(swung.rotation - rest.rotation).toBeCloseTo((SWING_ARC_DEG * Math.PI) / 180, 6);
    // The whole assembly ORBITS: `orbitActiveSocketToAim` rotates the socket BONE before FK, and
    // it is handed the WEAPON angle, so the arc carries the ring, its tether, its contact shade
    // and the module together. The module's own origin travels, and so does its far end.
    expect(Math.hypot(swung.x - rest.x, swung.y - rest.y)).toBeGreaterThan(1);
    const tip = skin.muzzleLocal()!;
    expect(Math.hypot(tip.x - restTip.x, tip.y - restTip.y)).toBeGreaterThan(1);
  });

  it('lunges the body INTO the aim, where a shot shoves it away', () => {
    const swinging = bladed();
    atStrike(swinging);
    const shooting = bladed();
    shooting.attack('ranged');
    shooting.advanceClips(RECOIL_MS * 0.22);
    shooting.update();
    // Aim is +x, so a lunge is +x on screen and a recoil is -x. Opposite signs, one formula.
    expect(swinging.view.x).toBeGreaterThan(0);
    expect(shooting.view.x).toBeLessThan(0);
  });

  it('travels ALONG the arc, never back down the barrel — that is the gun motion', () => {
    // Both attacks move the socket, so "it moved" proves nothing; what tells them apart is the
    // RADIUS. An orbit preserves the module's distance from the body while sweeping it around,
    // and a recoil shortens that distance while holding the angle. This is the assertion that
    // catches a swing wired into `modulePx` — which would drag the blade into the character.
    // Measured from the BODY, not from the rig origin: the socket hangs off the shell's tip, so
    // a radius taken from (0,0) is not the one the orbit preserves (it read 69.4 -> 47.5 and the
    // first version of this test failed on that, which is the useful kind of failure).
    const radius = (skin: RigSkin): number => {
      const s = spritesOf(skin).get('socket_r')!, body = spritesOf(skin).get('shell')!;
      return Math.hypot(s.x - body.x, s.y - body.y);
    };
    const swinging = bladed();
    const restRadius = radius(swinging);
    swinging.attack('melee');
    swinging.advanceClips(DEFAULT_TOTAL_MS * 0.5);
    swinging.update();
    expect(radius(swinging)).toBeCloseTo(restRadius, 6);

    const shooting = bladed();
    shooting.attack('ranged');
    shooting.advanceClips(RECOIL_MS * 0.22);
    shooting.update();
    expect(radius(shooting)).toBeLessThan(restRadius - RECOIL_MODULE_PX * 0.9);
  });

  it('leaves the EYE looking at the target through the whole swing', () => {
    // The eye tracks the aim, not the blade — `canonicalSocketAngleRad` vs
    // `canonicalWeaponAngleRad`. Wiring the swing into the shared angle would make the character
    // stare off into the arc every time it attacked.
    const skin = bladed();
    const rest = snap(spritesOf(skin).get('eye')!);
    atStrike(skin);
    const during = spritesOf(skin).get('eye')!;
    // Only the body's own lunge (`view.x/y`) may have moved it, and that is on the container.
    expect(during.x).toBeCloseTo(rest.x, 10);
    expect(during.y).toBeCloseTo(rest.y, 10);
  });

  it('returns the blade to exactly the aim line once the swing is spent', () => {
    const skin = bladed();
    const rest = spritesOf(skin).get('socket_r')!.rotation;
    const restModule = snap(modulesOf(skin).weaponSprite!);
    skin.attack('melee');
    skin.advanceClips(DEFAULT_TOTAL_MS);
    skin.update();
    expect(spritesOf(skin).get('socket_r')!.rotation).toBeCloseTo(rest, 10);
    expect(modulesOf(skin).weaponSprite!.rotation).toBeCloseTo(restModule.rotation, 10);
    expect(modulesOf(skin).weaponSprite!.x).toBeCloseTo(restModule.x, 10);
    expect(skin.view.x).toBeCloseTo(0, 10);
  });

  it('mirrors with the body — a left-facing swing sweeps the same way it does facing right', () => {
    // Canonical space (`facing.canonicalAimRad`). Without it a left-facing character's blade
    // sweeps backwards through the arc, which reads as the animation playing in reverse.
    const screenSweep = (aim: number): number => {
      const skin = bladed(aim);
      const rest = spritesOf(skin).get('socket_r')!.rotation * skin.view.scale.x;
      atStrike(skin);
      return spritesOf(skin).get('socket_r')!.rotation * skin.view.scale.x - rest;
    };
    const right = screenSweep(0);
    const left = screenSweep(Math.PI);
    expect(Math.sign(left)).toBe(-Math.sign(right)); // mirrored, as the whole rig is
    expect(Math.abs(left)).toBeCloseTo(Math.abs(right), 6);
  });
});

/**
 * The authored `attack` clip reaching the sprites THROUGH `RigSkin` (2026-09-02). `rigClipLayer
 * .test.ts` proves the blend; this proves `update()` actually samples it, and — the regression
 * that blocked playing these clips for a month — that a bone the attack clip does not name keeps
 * the base clip's motion instead of snapping to rest for the clip's whole duration.
 */
describe('RigSkin — the attack clip layers over the base clip', () => {
  const kf = (time: number, bones: Record<string, Record<string, number>>) =>
    ({ time, bones: new Map(Object.entries(bones)) });
  const CLIPS = new Map<string, AnimationClip>([
    // `belly` bobs on idle and is absent from attack — it is the bone the old whole-clip swap
    // dropped to rest. `shell` is in both, so it must end up with the SUM.
    ['idle', { duration: 2, loop: true, keyframes: [
      kf(0, { belly: { translateY: -20 }, shell: { translateY: -20 } }),
      kf(2, { belly: { translateY: -20 }, shell: { translateY: -20 } }),
    ] }],
    ['attack', { duration: 0.4, loop: false, keyframes: [
      kf(0, { shell: { translateY: 0 } }),
      kf(0.2, { shell: { translateY: 7 } }),
      kf(0.4, { shell: { translateY: 0 } }),
    ] }],
  ]);

  function posed(): RigSkin {
    const skin = makeSkin(ORB_CORE_RIG, CLIPS);
    skin.setBodyFacing(0);
    skin.setAim(0);
    skin.playClip('idle', 0);
    skin.update();
    return skin;
  }

  it('adds the attack clip on top of the base clip for a bone in both', () => {
    const skin = posed();
    const rest = spritesOf(skin).get('shell')!.y;
    skin.attack('melee'); // melee: no recoil translate, so the clip is the only thing moving it
    skin.advanceClips(200);
    skin.playClip('idle', 0);
    skin.update();
    expect(spritesOf(skin).get('shell')!.y - rest).toBeCloseTo(7, 6);
  });

  it('leaves a bone the attack clip never names on its base pose — the bug this replaced', () => {
    const skin = posed();
    const rest = spritesOf(skin).get('belly')!.y;
    skin.attack('melee');
    skin.advanceClips(200);
    skin.playClip('idle', 0);
    skin.update();
    // A whole-clip swap put this back at the bone's rest tip, ~20px away, for 400 ms.
    expect(spritesOf(skin).get('belly')!.y).toBeCloseTo(rest, 10);
  });

  it('comes back to exactly the base pose once the clip is spent', () => {
    const skin = posed();
    const rest = spritesOf(skin).get('shell')!.y;
    skin.attack('melee');
    skin.advanceClips(400);
    skin.playClip('idle', 0);
    skin.update();
    expect(spritesOf(skin).get('shell')!.y).toBeCloseTo(rest, 10);
  });


  it('survives being re-triggered faster than its own duration, and still comes home', () => {
    // NOT hypothetical, and worth stating precisely because it is the one part of the attack a
    // weapon does NOT pace. Every shipped bundle authors `attack` at **350 ms** (asserted next
    // door in `rigComposition.test.ts`), while the repeater and the flamer fire every 100 ms and
    // the spear recovers in 300 — so for the fast end of the roster the clip is re-triggered
    // before it can finish, for the whole of a held trigger.
    //
    // That is tolerable only because of a property the ART has to hold: the clip starts AND ends
    // at identity, so a restart re-seeds the same additive contribution rather than stacking onto
    // the last one. This pins the consequence of that property on the drawn sprite — twenty
    // restarts at a cadence well inside the clip's length must not accumulate, and release must
    // return the body to EXACTLY its base pose rather than to a drifted one.
    //
    // The per-weapon fix for the underlying mismatch (a playback rate, or authored clips) is
    // deliberately not taken; this is the guard that makes leaving it safe.
    const skin = posed();
    const rest = spritesOf(skin).get('shell')!.y;
    const CADENCE_MS = 100; // the repeater's, against a 400 ms clip in this fixture
    const seen: number[] = [];
    for (let i = 0; i < 20; i++) {
      skin.attack('melee'); // melee: no recoil translate, so the clip is the only thing moving it
      for (let f = 0; f < 6; f++) skin.advanceClips(CADENCE_MS / 6);
      skin.playClip('idle', 0);
      skin.update();
      seen.push(spritesOf(skin).get('shell')!.y - rest);
    }
    // Every restart lands on the SAME pose — the tenth is not ten times the first.
    expect(seen[19]).toBeCloseTo(seen[1]!, 10);
    expect(Math.abs(seen[19]!)).toBeGreaterThan(0.5); // ...and it was actually displaced
    // Release: once no further trigger arrives the clip runs out and the body returns exactly.
    skin.advanceClips(1000);
    skin.playClip('idle', 0);
    skin.update();
    expect(spritesOf(skin).get('shell')!.y).toBeCloseTo(rest, 10);
  });

  it('a shot and a swing both play it — one clip, one rule, either kind', () => {
    const displacement = (kind: 'ranged' | 'melee'): number => {
      const skin = posed();
      const rest = spritesOf(skin).get('shell')!.y;
      // Split rather than passed through: `attack` is overloaded per kind since the ranged half
      // gained its own shape, so a union `kind` no longer selects one signature.
      if (kind === 'melee') skin.attack('melee');
      else skin.attack('ranged');
      skin.advanceClips(200);
      skin.playClip('idle', 0);
      skin.update();
      return spritesOf(skin).get('shell')!.y - rest;
    };
    expect(displacement('ranged')).toBeCloseTo(7, 6);
    expect(displacement('melee')).toBeCloseTo(7, 6);
  });
});

/**
 * The other three clips reaching the real sprites (2026-09-02) — `hurt`, `death`, `spawn`.
 *
 * `rigClipLayer.test.ts` proves the layer picks the right clip and holds/releases the base layer
 * correctly; `rigComposition.test.ts` proves the SHIPPED clips permit that layering. Neither can
 * see this half: a clip channel only exists on screen if `RigSkin.update` writes it onto a
 * sprite, and the four channels these three clips use land on four separate lines of that method
 * (`sprite.scale`, `sprite.y`, `sprite.alpha`, and the module mount's own alpha). The bundle here
 * carries hand-built clips rather than the shipped ones, so each case can isolate ONE channel —
 * which the shipped data, moving all of them at once, cannot.
 */
describe('RigSkin — hurt / death / spawn reach the sprites', () => {
  const spriteFieldsOf = (skin: RigSkin): Map<string, { alpha: number; y: number; scale: { x: number; y: number } }> =>
    (skin as unknown as { sprites: Map<string, { alpha: number; y: number; scale: { x: number; y: number } }> }).sprites;

  /** A bundle whose three lifecycle clips each move exactly ONE channel of `shell`, so a test
   *  that reads one property cannot be passing on another clip's account. */
  const lifecycleClips = (): Map<string, AnimationClip> => new Map<string, AnimationClip>([
    ['idle', { duration: 2, loop: true, keyframes: [
      { time: 0, bones: new Map([['shell', { translateY: 0 }]]) },
      { time: 1, bones: new Map([['shell', { translateY: -6 }]]) },
      { time: 2, bones: new Map([['shell', { translateY: 0 }]]) },
    ] }],
    // scale only, identity at both ends — the shipped `hurt`'s shape.
    ['hurt', { duration: 0.3, loop: false, keyframes: [
      { time: 0, bones: new Map([['shell', { scaleX: 1, scaleY: 1 }]]) },
      { time: 0.06, bones: new Map([['shell', { scaleX: 1.5, scaleY: 0.5 }]]) },
      { time: 0.3, bones: new Map([['shell', { scaleX: 1, scaleY: 1 }]]) },
    ] }],
    // translate + alpha only, ending far from identity — the shipped `death`'s shape.
    ['death', { duration: 0.9, loop: false, keyframes: [
      { time: 0, bones: new Map([['shell', { translateY: 0, alpha: 1 }], ['socket_r', { alpha: 1 }]]) },
      { time: 0.9, bones: new Map([['shell', { translateY: 30, alpha: 0 }], ['socket_r', { alpha: 0 }]]) },
    ] }],
    // alpha only, OPENING far from identity — the shipped `spawn`'s shape.
    ['spawn', { duration: 0.35, loop: false, keyframes: [
      { time: 0, bones: new Map([['shell', { alpha: 0 }], ['socket_r', { alpha: 0 }]]) },
      { time: 0.35, bones: new Map([['shell', { alpha: 1 }], ['socket_r', { alpha: 1 }]]) },
    ] }],
  ]);

  function posed(): RigSkin {
    const skin = makeSkin(ORB_CORE_RIG, lifecycleClips());
    skin.setBodyFacing(0);
    skin.setAim(0);
    skin.playClip('idle', 1000); // parked at the idle trough, so the base layer is not neutral
    skin.update();
    return skin;
  }

  it('the hurt flinch squashes the body while the idle bob keeps running underneath', () => {
    // The whole reason it is an overlay: an actor hit mid-walk must not stop walking. Read on the
    // sprite, so it also covers `update()` composing the clip scale with the BINDING scale.
    const skin = posed();
    const restY = spriteFieldsOf(skin).get('shell')!.y;
    const restScaleY = spriteFieldsOf(skin).get('shell')!.scale.y;
    skin.hurt();
    skin.advanceClips(60); // the flinch's peak
    skin.update();
    expect(spriteFieldsOf(skin).get('shell')!.scale.y).toBeLessThan(restScaleY);
    expect(spriteFieldsOf(skin).get('shell')!.y).toBe(restY); // the bob is untouched by it
  });

  it('...and hands the body back exactly as it found it', () => {
    const skin = posed();
    // Read the fields out rather than spreading — `x`/`y` are prototype accessors on a Pixi
    // ObservablePoint, so a spread copy is `{}` and every assertion below it reads `undefined`
    // (which `toBeCloseTo` then fails on with a NaN difference; it did, first run).
    const restX = spriteFieldsOf(skin).get('shell')!.scale.x;
    const restY = spriteFieldsOf(skin).get('shell')!.scale.y;
    skin.hurt();
    skin.advanceClips(60);
    skin.update();
    skin.advanceClips(300);
    skin.update();
    expect(spriteFieldsOf(skin).get('shell')!.scale.x).toBeCloseTo(restX, 10);
    expect(spriteFieldsOf(skin).get('shell')!.scale.y).toBeCloseTo(restY, 10);
  });

  it('the death collapse sinks and fades the body, and drops the idle bob it replaces', () => {
    const skin = posed();
    const restY = spriteFieldsOf(skin).get('shell')!.y;
    skin.die();
    skin.update();
    // Frame ONE of the collapse: the clip is at its own identity, so the sprite has to be at the
    // clip's translateY 0 — NOT at idle's -6. That single number is the difference between the
    // lifecycle clip owning the base layer and merely being added to it.
    expect(spriteFieldsOf(skin).get('shell')!.y).toBeGreaterThan(restY);
    skin.advanceClips(900);
    skin.update();
    expect(spriteFieldsOf(skin).get('shell')!.y).toBeCloseTo(restY + 6 + 30, 6);
    expect(spriteFieldsOf(skin).get('shell')!.alpha).toBe(0);
  });

  it('the collapse holds its last frame for as long as the view outlives the clip', () => {
    // `Actor.onDeath` gives the dissolve shader the say on when the view dies, so this clip can
    // and does run out first on a slow frame or a retuned `DISSOLVE_MS`. Releasing back to idle
    // there would stand the corpse back up at full size, mid-dissolve.
    const skin = posed();
    skin.die();
    skin.advanceClips(900);
    skin.update();
    const held = spriteFieldsOf(skin).get('shell')!.y;
    skin.advanceClips(5000);
    skin.update();
    expect(spriteFieldsOf(skin).get('shell')!.y).toBe(held);
    expect(spriteFieldsOf(skin).get('shell')!.alpha).toBe(0);
  });

  it('the spawn clip materialises the body and then releases it back to idle', () => {
    const skin = posed();
    skin.spawn();
    skin.update();
    expect(spriteFieldsOf(skin).get('shell')!.alpha).toBe(0);
    skin.advanceClips(350);
    skin.update();
    expect(spriteFieldsOf(skin).get('shell')!.alpha).toBe(1);
    // ...and the base layer is idle again, i.e. the bob is running: two frames apart at a phase
    // where the bob is actually moving must give two different y values.
    skin.playClip('idle', 500);
    skin.update();
    const a = spriteFieldsOf(skin).get('shell')!.y;
    skin.playClip('idle', 700);
    skin.update();
    expect(spriteFieldsOf(skin).get('shell')!.y).not.toBe(a);
  });

  it('the mounted module fades with the socket bone it hangs on', () => {
    // A module is a sprite parented to the rig, not a bone, so `sprite.alpha = mount.alpha` in
    // `mountModule` is the ONLY thing that fades it. Without it a spawning character mounts a
    // fully-opaque gun on an invisible arm, and a corpse leaves one hanging over the dissolve.
    const skin = posed();
    skin.setWeaponKind('ranged', 'blaster');
    skin.update();
    const active = (): { alpha: number } =>
      (skin as unknown as { weaponSprite: { alpha: number } }).weaponSprite;
    expect(active().alpha).toBe(1);
    skin.spawn();
    skin.update();
    expect(active().alpha).toBe(0);
    skin.advanceClips(350);
    skin.update();
    expect(active().alpha).toBe(1);
    skin.die();
    skin.advanceClips(900);
    skin.update();
    expect(active().alpha).toBe(0);
  });

  it('the sphere shading collapses with the body rather than staying full size over it', () => {
    // `placeSphereShade` takes the body bone's own scale. The `death` clip is what forced it:
    // it squashes the body to a third and the corpse HOLDS there for the whole dissolve, so a
    // fixed-size shade reads as a dark plate lying beside a shrinking body. Note the flip is
    // still cancelled at the same time — asserted as the absolute value here, since the sign
    // belongs to the counter-flip test above.
    const squash = new Map<string, AnimationClip>([['death', { duration: 1, loop: false, keyframes: [
      { time: 0, bones: new Map([['shell', { scaleX: 1, scaleY: 1 }]]) },
      { time: 1, bones: new Map([['shell', { scaleX: 0.4, scaleY: 0.3 }]]) },
    ] }]]);
    const skin = makeSkin(ORB_CORE_RIG, squash);
    skin.setBodyFacing(0);
    skin.update();
    const shade = (skin as unknown as { sphereShade: Graphics }).sphereShade;
    expect(Math.abs(shade.scale.x)).toBeCloseTo(1, 10);
    skin.die();
    skin.advanceClips(1000);
    skin.update();
    expect(Math.abs(shade.scale.x)).toBeCloseTo(0.4, 6);
    expect(shade.scale.y).toBeCloseTo(0.3, 6);
  });

  it('all three are silent no-ops on a bundle that ships none of them', () => {
    // `makeSkin`'s default bundle has no clips at all, which is also the real state of every
    // actor for the frames before its bundle finishes preloading.
    const skin = makeSkin();
    skin.setBodyFacing(0);
    skin.update();
    const restY = spriteFieldsOf(skin).get('shell')!.y;
    expect(() => { skin.hurt(); skin.spawn(); skin.die(); }).not.toThrow();
    skin.advanceClips(16);
    skin.update();
    expect(spriteFieldsOf(skin).get('shell')!.y).toBe(restY);
    expect(spriteFieldsOf(skin).get('shell')!.alpha).toBe(1);
  });
});
