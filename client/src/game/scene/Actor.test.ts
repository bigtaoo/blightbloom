import { describe, it, expect, vi, afterEach } from 'vitest';
import { Graphics, Texture, type Rectangle } from 'pixi.js';
import { freshStatus } from '@dd/engine/content/damage';
import type { DamageType } from '@dd/engine';
import { Actor } from './Actor';
import { drawElementGlyph } from '../elementIcons';
import { THEME } from '../theme';
import { SHADOW_SQUASH } from './Entity';
import { SHELL_ASPECT, SHELL_SURFACE, SHELL_CLEARANCE } from '../fx/filters';
import { HIT_FLASH_MS, SHATTER_MS } from './actorFilters';
import { TICK_RATE } from '@dd/engine';
import { SHIELD_REGEN_DELAY } from '@dd/engine/config';
import { Rig } from '../../render/Rig';
import { ORB_CORE_RIG, ORB_CORE_REFERENCE_RADIUS } from '../../render/orbCoreRig';
import { CRITTER_CORE_RIG, CRITTER_CORE_REFERENCE_RADIUS } from '../../render/critterCoreRig';
import { BOSS_CORE_RIG, BOSS_CORE_REFERENCE_RADIUS } from '../../render/bossCoreRig';
import type { RigSkinBundle } from '../../render/taoBundle';
import type { SpriteBinding } from '../../render/types';
import type { LoadedRigSkin } from '../../render/skinRegistry';
import { resetActiveQuality, setActiveQuality } from '../../render/quality';

// A real rig's decorative bones (orb-core's eye/belly/weapon sockets) hang off the
// body bone's TIP, not its centre (orbCoreRig.ts) — the exact geometry that makes the
// shield-centring fix below non-trivial. Faked bundle over the REAL Rig, same trick as
// Skin.test.ts/RigSkin.test.ts, so this asymmetry is genuinely exercised under plain
// vitest rather than assumed.
const skinRegistryMocks = vi.hoisted(() => ({ loaded: undefined as LoadedRigSkin | undefined }));
vi.mock('../../render/skinRegistry', () => ({
  getRigSkin: (_name: string) => skinRegistryMocks.loaded,
}));

function fakeOrbCoreBundle(rig: Rig): RigSkinBundle {
  const bindings = new Map<string, SpriteBinding>();
  const textures = new Map<string, Texture>();
  for (const boneId of rig.drawOrder) {
    bindings.set(boneId, { anchorX: 0.5, anchorY: 0.5, flipX: false, zOrder: 0, rotation: 0, scaleX: 1, scaleY: 1 });
    textures.set(boneId, Texture.WHITE);
  }
  return { bindings, clips: new Map(), textures };
}

/** char_vanguard's measured body fill (`skinRegistry.BODY_FILL`) — the fraction of its
 *  declared bodyR that the shell PNG actually paints. Restated here rather than imported
 *  because this file MOCKS skinRegistry wholesale; `rigComposition.test.ts` is what pins the
 *  real table against the real art. */
const ORB_CORE_BODY_FILL = 0.81;

function loadedOrbCoreRig(): LoadedRigSkin {
  const rig = new Rig(ORB_CORE_RIG);
  return { rig, bundle: fakeOrbCoreBundle(rig), referenceRadius: ORB_CORE_REFERENCE_RADIUS, bodyFill: ORB_CORE_BODY_FILL };
}

/** The enemy body forms' rig (`critter-core`, shared by brute-core/floater-core) and the
 *  boss's — needed because "who draws the weapon" is decided by the RIG since 2026-08-21,
 *  so orb-core alone can no longer cover the question. Real `RigDef`s over the same fake
 *  bundle; `bodyFill` is critter-core's own measured value. */
function loadedCritterCoreRig(): LoadedRigSkin {
  const rig = new Rig(CRITTER_CORE_RIG);
  return { rig, bundle: fakeOrbCoreBundle(rig), referenceRadius: CRITTER_CORE_REFERENCE_RADIUS, bodyFill: 0.7 };
}

function loadedBossCoreRig(): LoadedRigSkin {
  const rig = new Rig(BOSS_CORE_RIG);
  return { rig, bundle: fakeOrbCoreBundle(rig), referenceRadius: BOSS_CORE_REFERENCE_RADIUS, bodyFill: 0.68 };
}

// EnergyShieldFilter/OutlineFilter/DissolveFilter all build a real WebGL GlProgram at
// construction time — unavailable under plain vitest (no `document`/canvas), same reason
// FxController.test.ts stubs fx/filters.ts. Bare classes with the settable properties
// Actor actually touches are enough to exercise its attach/detach/reuse logic without
// touching the GPU.
//
// Spread over `vi.importActual` (the convention RoomBuilder.test.ts/wechatRoomBuild.test.ts
// already use here): only the filter CLASSES touch GL, while the module also exports plain
// values `Actor` reads — `SHELL_ASPECT`, the shield shell's screen aspect, which sizes
// `filterArea`. Restating one of those in a mock would let it drift away from the shipped
// number, and a mock that must be edited every time the real module gains an export is its own
// trap: adding that one constant broke all 111 tests in this file.
vi.mock('../fx/filters', async () => ({
  ...(await vi.importActual<typeof import('../fx/filters')>('../fx/filters')),
  EnergyShieldFilter: class {
    intensity = 0;
    membrane = 1;
    /** The shell's exit, 0..1 — driven by `ActorFilters` over SHATTER_MS. */
    shatter = 0;
    /** Last impact handed to it, so a test can assert `onHurt` forwards the direction. */
    lastHit: [number, number] | null = null;
    constructor(public color?: number) {}
    hit(dx: number, dy: number) { this.lastHit = [dx, dy]; }
    tick() {}
  },
  OutlineFilter: class {
    alpha = 0;
    constructor(public color?: number) {}
  },
  DissolveFilter: class {
    progress = 0;
  },
  HeatHazeFilter: class {
    intensity = 1;
    tick() {}
  },
  NormalLitFilter: class {
    dirX = 0;
    dirY = 0;
    color = 0;
    intensity = 0;
    setPoint(dirX: number, dirY: number, color: number, intensity: number) {
      this.dirX = dirX;
      this.dirY = dirY;
      this.color = color;
      this.intensity = intensity;
    }
    clearPoint() {
      this.intensity = 0;
    }
  },
}));

// Children are appended in this fixed order in the constructor — indexing into `.children`
// is the only way in for the ones with no public API (same convention as
// TouchControlsView.test.ts: screenshots aren't available in this environment — see the
// daydayup memory notes). `healthBar` itself is public (2026-08-21: it no longer lives in
// this list at all — it rides `layers.hud`, not this container, see Actor.ts's constructor
// doc comment on why — so it's read directly rather than indexed).
const enum Child { StatusAura, SkinView, WeaponGfx }

function healthBarOf(a: Actor): Graphics {
  return a.healthBar!;
}

describe('Actor — floating health bars (design/10 legibility fix, 2026-08-02)', () => {
  it('gives every enemy a floating health bar, not just bosses', () => {
    const mob = new Actor('enemy', 12, undefined, false);
    // NOT a child (2026-08-21) — see Actor.ts's constructor doc comment.
    expect(mob.children.length).toBe(3); // statusAura, skin.view, weaponGfx
    expect(healthBarOf(mob)).toBeDefined();
    expect(mob.children).not.toContain(mob.healthBar);
  });

  it('still gives a boss its (bigger) health bar', () => {
    const boss = new Actor('enemy', 12, undefined, true);
    expect(boss.children.length).toBe(3);
    expect(healthBarOf(boss)).toBeDefined();
  });

  it('gives a player actor a floating health bar too (visible on the map, not just the HUD)', () => {
    const player = new Actor('player', 12, undefined, false);
    expect(player.children.length).toBe(3); // statusAura, skin.view, weaponGfx
    expect(healthBarOf(player)).toBeDefined();
  });

  it('draws a wider/taller bar for a boss than for a regular mob at the same radius', () => {
    const mob = new Actor('enemy', 12, undefined, false);
    const boss = new Actor('enemy', 12, undefined, true);
    mob.setHealth(50, 100);
    boss.setHealth(50, 100);
    const mobBounds = healthBarOf(mob).getLocalBounds();
    const bossBounds = healthBarOf(boss).getLocalBounds();
    expect(bossBounds.width).toBeGreaterThan(mobBounds.width);
    expect(bossBounds.height).toBeGreaterThan(mobBounds.height);
  });

  it('is a no-op with maxHp <= 0 (no divide-by-zero bar)', () => {
    const mob = new Actor('enemy', 12, undefined, false);
    expect(() => mob.setHealth(0, 0)).not.toThrow();
    // No geometry drawn yet — an empty Graphics has zero bounds.
    expect(healthBarOf(mob).getLocalBounds().width).toBe(0);
  });

  it('positions the bar at its own stored offset above the actor\'s screen position, not AT it', () => {
    // `applyTransform` (2026-08-21) has to actually ADD `healthBarOffsetY`, not just track
    // `this.y` alone — a placeholder (no hover) keeps the maths simple: `place(x,y,0)` sets
    // `this.y = y` exactly (lift is the only other term, and BODY_LIFT_R's own lift is folded
    // into `bodyCenterY` already, same value `healthBarOffsetY` was computed from).
    const mob = new Actor('enemy', 12, undefined, false);
    mob.place(40, 200, 0);
    const offsetY = (mob as unknown as { healthBarOffsetY: number }).healthBarOffsetY;
    expect(offsetY).not.toBe(0); // the fixture is meaningless if the offset itself is zero
    expect(healthBarOf(mob).x).toBeCloseTo(mob.x, 5);
    expect(healthBarOf(mob).y).toBeCloseTo(mob.y + offsetY, 5);
  });

  it('redraws when the hp fraction actually changes', () => {
    const mob = new Actor('enemy', 12, undefined, false);
    mob.setHealth(100, 100);
    const fullBounds = healthBarOf(mob).getLocalBounds();
    mob.setHealth(50, 100);
    const halfBounds = healthBarOf(mob).getLocalBounds();
    // The track width is fixed (radius-based); it's the filled portion that changes,
    // but the track itself is redrawn every call that isn't a skip, so this just
    // confirms setHealth doesn't throw across repeated real changes.
    expect(halfBounds.width).toBe(fullBounds.width);
  });
});

// The ground ring this describe block used to cover (a full ellipse around the local
// seat's feet) was dropped 2026-08-14: it shared a cyan-family colour AND on-screen
// space with EnergyShieldFilter's rim-glow, so a live shield and "this is you" read as
// the same effect (see Actor.setLocal's doc comment). The health-bar teal outline below
// is now the marker's only cue — it never overlaps the shield glow's screen area.
describe('Actor.setLocal — "which one is me" marker (design/10 legibility)', () => {
  it('never adds a child — the marker is the health-bar outline alone, not a separate view', () => {
    const mob = new Actor('enemy', 12);
    expect(mob.children.length).toBe(3);
    mob.setLocal(false);
    expect(mob.children.length).toBe(3);
    const me = new Actor('player', 12);
    me.setLocal(true);
    expect(me.children.length).toBe(3);
  });

  // Was asserted via the bar's BOUNDS growing, which only worked because the local outline
  // happened to be a thicker stroke than the default one — an accident of stroke width, not
  // the design intent, and it broke the moment the bar's frame became a filled contour
  // (2026-08-21). What the marker actually is: the same-sized contour, recoloured. Asserted
  // on the drawn fill colours, so it fails if the recolour stops happening.
  it('recolours an already-drawn health bar when the local flag flips', () => {
    const contourColorOf = (a: Actor): number => {
      type Instr = { action: string; data: { style?: { color: number } } };
      const fills = (healthBarOf(a).context.instructions as unknown as Instr[])
        .filter((i) => i.action === 'fill' && i.data.style)
        .map((i) => i.data.style!.color);
      return fills[0]!; // the contour is drawn first, under everything else
    };
    const me = new Actor('player', 12);
    me.setHealth(50, 100);
    const before = contourColorOf(me);
    expect(before).not.toBe(THEME.colors.player);
    me.setLocal(true);
    me.setHealth(50, 100); // same ratio — only the forced redraw makes this repaint
    expect(contourColorOf(me)).toBe(THEME.colors.player);
  });
});

// Uses the default Graphics-placeholder skin (no `.tao` rig registered under plain
// vitest, same as every other Pixi-construction test in this repo) — which makes the
// two facing angles trivial to observe directly: the placeholder's "front" facing
// indicator rotates with the BODY angle, while the separate cosmetic weapon graphic
// always rotates with the AIM angle — exactly the split RigSkin.ts documents for a
// real rig (setBodyFacing vs setAim).
function frontOf(a: Actor): { rotation: number } {
  return (a as unknown as { skin: { front?: { rotation: number } } }).skin.front!;
}
function weaponGfxOf(a: Actor): { rotation: number } {
  return (a as unknown as { weaponGfx: { rotation: number } }).weaponGfx;
}

function skinFiltersOf(a: Actor): unknown {
  return (a as unknown as { skin: { view: { filters: unknown } } }).skin.view.filters;
}
function skinFilterAreaOf(a: Actor): Rectangle {
  return (a as unknown as { skin: { view: { filterArea: Rectangle } } }).skin.view.filterArea;
}
function skinViewOf(a: Actor): { getLocalBounds: () => Rectangle } {
  return (a as unknown as { skin: { view: { getLocalBounds: () => Rectangle } } }).skin.view;
}
// The four skin shaders moved into a composed `ActorFilters` (2026-08-25, 500-line split), so
// these reach one level deeper than they used to. The CLAIMS are unchanged — every test below is
// still about the lazily-built-once, ticked-per-frame contract, which is exactly what a
// behaviour-preserving extraction has to keep true.
function fxOf(a: Actor): Record<string, unknown> {
  return (a as unknown as { fx: Record<string, unknown> }).fx;
}
function shieldFilterOf(a: Actor): { intensity: number; shatter: number } | null {
  return fxOf(a).shieldFilter as { intensity: number; shatter: number } | null;
}

// Lopsided-shield-glow fix (2026-08-12): `EnergyShieldFilter`'s shader hardcodes
// texture-coordinate (0.5,0.5) as the character's centre, but `skin.view`'s
// AUTO-computed bounds are asymmetric (the placeholder's facing-direction "front"
// wedge, or a real rig's mounted weapon sprite, both extend outward on one side only)
// — pinning an explicit, symmetric `filterArea` is what keeps the shield (and every
// other skin-level filter) from drifting sideways as the actor turns to face/aim a
// different direction.
//
// Revised same day: pinning that square's Y to a flat 0 (this test's original
// assertion) turned out to be a DIFFERENT bug wearing the same clothes — a real rig's
// decorative bones hang off the body bone's TIP, not its centre (orbCoreRig.ts's
// eye/belly/weapon sockets all sit ~1 body-length above the shell's own origin), so
// the assembled character is consistently top-heavy relative to (0,0). A live user
// report ("the shield doesn't centre the character") caught
// this: `critter-core`'s single-bone enemies have no such offset and looked fine,
// `char_vanguard`'s orb-core rig does and visibly didn't. Fix: measure the skin's own
// rest-pose bounds once (facing/aim-independent — only the X asymmetry above depends
// on those) and centre Y on THAT, not on an assumed (0,0).
describe('Actor — skin filterArea is a fixed rect centred on the skin\'s own rest-pose centroid (2026-08-12 lopsided-shield fix, revised)', () => {
  afterEach(() => {
    skinRegistryMocks.loaded = undefined;
  });

  it('X stays pinned to the local origin — not offset by facing/weapon geometry', () => {
    const a = new Actor('player', 20);
    const area = skinFilterAreaOf(a);
    expect(area.x + area.width / 2).toBeCloseTo(0);
  });

  it('Y matches the skin\'s own measured rest-pose bounds, not a hardcoded 0 — even the Graphics placeholder is very slightly top/bottom-asymmetric', () => {
    const a = new Actor('player', 20);
    const area = skinFilterAreaOf(a);
    const bounds = skinViewOf(a).getLocalBounds();
    expect(area.y + area.height / 2).toBeCloseTo(bounds.y + bounds.height / 2);
  });

  it('a real rig whose decorative bones sit off the body\'s own centre still gets a correctly-centred shield (repro: orb-core\'s eye/belly/sockets hang off the shell\'s tip, not its middle)', () => {
    skinRegistryMocks.loaded = loadedOrbCoreRig();
    const a = new Actor('player', 20, undefined, false, 'char_vanguard');
    const area = skinFilterAreaOf(a);
    const bounds = skinViewOf(a).getLocalBounds();
    const expectedCenterY = bounds.y + bounds.height / 2;
    expect(area.y + area.height / 2).toBeCloseTo(expectedCenterY);
    // The whole point of the fix: for this top-heavy rig the correct centre is nowhere
    // near 0 — the original "pin to (0,0)" attempt would have failed this assertion.
    expect(Math.abs(expectedCenterY)).toBeGreaterThan(1);
  });

  it('scales with the actor\'s own radius, not a fixed pixel size', () => {
    const small = skinFilterAreaOf(new Actor('enemy', 10));
    const big = skinFilterAreaOf(new Actor('enemy', 30));
    expect(big.width).toBeGreaterThan(small.width);
    expect(big.width / small.width).toBeCloseTo(30 / 10, 5);
    expect(big.height / small.height).toBeCloseTo(30 / 10, 5);
  });

  it('puts the shell surface exactly SHELL_CLEARANCE body radii off the body, at every size', () => {
    // 2026-08-27, report: *"shrink it overall so it sits close to the character, leaving just
    // a small gap — about the diameter of the gun in the picture"*. The gap is one gun: the
    // hero's weapon art has an opaque box 8.55 world px thick against a 16 px body radius,
    // hence 0.53.
    //
    // This is the one piece of real arithmetic in the chain — `Actor` inverting the shader's own
    // geometry (`dist` of `SHELL_SURFACE` lands at `SHELL_SURFACE / sqrt(2) * regionWidth` px
    // from the centre) to solve for the region. Getting it wrong by a factor of sqrt(2), or
    // reverting to the flat `radiusPx * 3` it replaced, changes the shell's size on screen and
    // nothing in the shader suite can see it: those tests measure normalized `dist`, which is
    // unchanged by definition.
    for (const r of [10, 16, 30]) {
      const area = skinFilterAreaOf(new Actor('enemy', r));
      const surfacePx = (SHELL_SURFACE / Math.SQRT2) * area.width;
      expect(surfacePx / r).toBeCloseTo(1 + SHELL_CLEARANCE, 9);
    }
    // ...and that really is TIGHTER than the `radiusPx * 3` region it replaced, not merely
    // different: 1.53 body radii against 1.87.
    expect(1 + SHELL_CLEARANCE).toBeLessThan((0.44 * 6) / Math.SQRT2);
  });

  it('is TALLER than wide, by exactly SHELL_ASPECT — the shell has no other source for its ellipse', () => {
    // 2026-08-27, report: *"the shield is a true circle today; an ellipse, a little taller
    // than it is wide, would look more three-dimensional"*.
    // The shield shader is isotropic in region-normalized uv (measured in
    // shieldShellModel.test.ts), so this rect's aspect IS the shell's screen aspect and nothing
    // else contributes to it. That is what makes the ellipse free — every constant in the shader
    // is unchanged — and what makes this assertion load-bearing: flattening the rect back to a
    // square reverts the shell to the true circle it was before, with no other visible symptom
    // and nothing else in the suite noticing.
    for (const r of [10, 20, 30]) {
      const area = skinFilterAreaOf(new Actor('enemy', r));
      expect(area.height / area.width).toBeCloseTo(SHELL_ASPECT, 6);
      expect(area.height).toBeGreaterThan(area.width);
    }
  });

  it('does not shift when the actor turns to face a different direction', () => {
    const a = new Actor('player', 20);
    const before = skinFilterAreaOf(a);
    const beforeCenter = { x: before.x + before.width / 2, y: before.y + before.height / 2 };
    a.pushState(0, 0, 0, Math.PI, -Math.PI / 2);
    a.snap();
    a.interpolate(1, 16);
    const after = skinFilterAreaOf(a);
    expect(after.x + after.width / 2).toBeCloseTo(beforeCenter.x);
    expect(after.y + after.height / 2).toBeCloseTo(beforeCenter.y);
  });

  it('does not shift when a rig-backed actor turns to face a different direction', () => {
    skinRegistryMocks.loaded = loadedOrbCoreRig();
    const a = new Actor('player', 20, undefined, false, 'char_vanguard');
    const before = skinFilterAreaOf(a);
    const beforeCenter = { x: before.x + before.width / 2, y: before.y + before.height / 2 };
    a.pushState(0, 0, 0, Math.PI, -Math.PI / 2);
    a.snap();
    a.interpolate(1, 16);
    const after = skinFilterAreaOf(a);
    expect(after.x + after.width / 2).toBeCloseTo(beforeCenter.x);
    expect(after.y + after.height / 2).toBeCloseTo(beforeCenter.y);
  });
});

// A rig's body bone already stands its art off the ground point (orb-core's `shell` is
// 46 authoring-px of hover height, and RigSkin draws that bone's art on its tip), so
// Actor's own BODY_LIFT_R lift applies to the Graphics placeholder only — applying both
// double-counts and detaches the body from its shadow. The aura and health bar wrap the
// BODY, so they anchor to its real measured centre rather than to `-lift`.
describe('Actor — vertical anchoring: the placeholder is lifted, a rig carries its own hover height', () => {
  afterEach(() => {
    skinRegistryMocks.loaded = undefined;
  });

  const skinYOf = (a: Actor) => (a as unknown as { skin: { view: { y: number } } }).skin.view.y;
  const auraYOf = (a: Actor) => (a as unknown as { statusAura: { y: number } }).statusAura.y;

  it('the placeholder skin is lifted off the ground anchor', () => {
    const a = new Actor('player', 20);
    expect(skinYOf(a)).toBeCloseTo(-20 * 0.7); // radiusPx * BODY_LIFT_R
    expect(auraYOf(a)).toBeCloseTo(skinYOf(a)); // no rig → aura rides the lift itself
  });

  it('a rig skin is NOT lifted again — the rig\'s own body bone is the hover height', () => {
    skinRegistryMocks.loaded = loadedOrbCoreRig();
    const a = new Actor('player', 20, undefined, false, 'char_vanguard');
    expect(skinYOf(a)).toBe(0);
  });

  it('a rig actor\'s aura and health bar still wrap the body, not the ground point', () => {
    skinRegistryMocks.loaded = loadedOrbCoreRig();
    const a = new Actor('player', 20, undefined, false, 'char_vanguard');
    const bounds = skinViewOf(a).getLocalBounds();
    const bodyCenterY = bounds.y + bounds.height / 2;
    expect(bodyCenterY).toBeLessThan(-1); // the rig really does sit above the anchor
    expect(auraYOf(a)).toBeCloseTo(bodyCenterY);
    // `healthBar` is no longer a child (2026-08-21) — its `.y` only reflects this offset once
    // `applyTransform` has run (`place`/`interpolate`), and `place` would also fold in
    // `char_vanguard`'s own idle hover (`visualZ`, HOVER table) on top of it — a second,
    // unrelated effect this test isn't about. Reading the stored offset directly keeps this
    // test about what it says it's about: the bar wraps the BODY's centre, not the ground.
    const offsetY = (a as unknown as { healthBarOffsetY: number }).healthBarOffsetY;
    expect(offsetY).toBeCloseTo(bodyCenterY - 20 * 1.3);
  });
});

describe('Actor.setShield — energy-shield shader (design/01 fidelity roadmap milestone 5)', () => {
  it('is a no-op with no shield pool (maxShield <= 0) — most enemies never pay for a filter', () => {
    const mob = new Actor('enemy', 12);
    mob.setShield(0, 0);
    // Since 2026-08-24 there is no always-on lighting filter underneath, so "no-op" here
    // means the list is genuinely EMPTY and the mob costs no render-target pass at all.
    expect(skinFiltersOf(mob) as unknown[] ?? []).toEqual([]);
    expect(shieldFilterOf(mob)).toBeNull();
  });

  it('attaches the filter once shield > 0 and drives intensity off the live ratio', () => {
    const a = new Actor('player', 12);
    a.setShield(4, 8);
    expect(skinFiltersOf(a)).toBeTruthy();
    expect(shieldFilterOf(a)!.intensity).toBeCloseTo(0.5);
  });

  it('reuses the same filter instance across updates instead of rebuilding it', () => {
    const a = new Actor('player', 12);
    a.setShield(8, 8);
    const first = shieldFilterOf(a);
    a.setShield(4, 8);
    expect(shieldFilterOf(a)).toBe(first);
    expect(shieldFilterOf(a)!.intensity).toBeCloseTo(0.5);
  });

  it('HOLDS the filter past ratio 0 so the shell can play its exit, then detaches', () => {
    // Until 2026-08-26 this detached on the frame the pool emptied and the shell vanished
    // between two frames. The exit is the reason the filter has to outlive the state change —
    // the same shape `onDeath` and `Scene`'s dying-view list already use.
    const a = new Actor('player', 12);
    a.setShield(4, 8);
    a.setShield(0, 8);
    expect(skinFiltersOf(a) as unknown[]).toHaveLength(1); // still there, now leaving
    a.interpolate(1, SHATTER_MS - 1);
    expect(skinFiltersOf(a) as unknown[]).toHaveLength(1); // ...for the whole duration
    a.interpolate(1, 1);
    expect(skinFiltersOf(a) as unknown[] ?? []).toEqual([]); // and only then gone
  });

  it('re-attaches on regen after a break, without rebuilding the filter', () => {
    const a = new Actor('player', 12);
    a.setShield(4, 8);
    const first = shieldFilterOf(a);
    a.setShield(0, 8);
    a.interpolate(1, SHATTER_MS); // let the exit run out
    expect(skinFiltersOf(a) as unknown[] ?? []).toEqual([]); // back to no filter at all
    a.setShield(2, 8);
    expect(skinFiltersOf(a)).toBeTruthy();
    expect(shieldFilterOf(a)).toBe(first);
  });

  it('skips redundant work when the ratio has not changed', () => {
    const a = new Actor('player', 12);
    a.setShield(4, 8);
    const before = shieldFilterOf(a);
    before!.intensity = 0.99; // tamper — a real update at the same ratio should leave it alone
    a.setShield(4, 8);
    expect(shieldFilterOf(a)!.intensity).toBe(0.99);
  });
});

// 2026-08-26: the shell no longer disappears the frame the pool empties — it plays a ~200ms
// exit (`EnergyShieldFilter.shatter`) that `ActorFilters` drives and holds the filter for. The
// wiring is where this can go wrong invisibly: an exit that never starts, one that restarts
// mid-flight, one that never releases the filter, or one that leaves a reused filter holding a
// finished exit all look like "the shield broke" from the outside.
describe('Actor.setShield — the shell exit (2026-08-26)', () => {
  afterEach(() => resetActiveQuality());

  const shatterOf = (a: Actor): number => shieldFilterOf(a)!.shatter;

  /** A shielded actor whose pool has just emptied — the state every test here starts from. */
  const broken = (): Actor => {
    const a = new Actor('player', 12);
    a.setShield(4, 8);
    a.setShield(0, 8);
    return a;
  };

  it('drives shatter 0 -> 1 across exactly SHATTER_MS', () => {
    const a = broken();
    expect(shatterOf(a)).toBe(0);
    a.interpolate(1, SHATTER_MS / 4);
    expect(shatterOf(a)).toBeCloseTo(0.25, 6);
    a.interpolate(1, SHATTER_MS / 4);
    expect(shatterOf(a)).toBeCloseTo(0.5, 6);
    a.interpolate(1, SHATTER_MS / 2);
    // Reset on release, not parked at 1 — this instance is REUSED by a regenerated shield, and
    // one still holding a finished exit would come back expanded, thinned and invisible.
    expect(shatterOf(a)).toBe(0);
    expect(shieldFilterOf(a)!.intensity).toBe(0);
  });

  it('flares to full brightness at the break rather than exiting from a sliver of pool', () => {
    const a = new Actor('player', 12);
    a.setShield(1, 8); // 12.5% — a shield about to go
    expect(shieldFilterOf(a)!.intensity).toBeCloseTo(0.125);
    a.setShield(0, 8);
    expect(shieldFilterOf(a)!.intensity).toBe(1);
  });

  it('overshoots nothing when a long frame lands mid-exit', () => {
    // A hitch, or the 50ms hit-stop `shield_break` itself queues, can hand `tick` a frame far
    // longer than what is left. `shatter` must not go past 1 (the shader's fade would go
    // NEGATIVE and the shell would come back brighter than it started).
    const a = broken();
    a.interpolate(1, SHATTER_MS * 5);
    expect(shatterOf(a)).toBe(0);
    expect(skinFiltersOf(a) as unknown[] ?? []).toEqual([]);
  });

  it('finishes before shield REGEN could possibly cancel it', () => {
    // A cross-layer invariant that nothing stated. Regen landing mid-exit cancels it (that is
    // deliberate — see `setShield`), and the engine refills the pool `SHIELD_REGEN_DELAY` idle
    // ticks after the last hit. If that delay ever dropped near `SHATTER_MS`, the shell would be
    // cut off mid-flight in real play and every test in this file would still pass — the
    // 2026-08-26 battery confirmed it: `SHIELD_REGEN_DELAY` 90 -> 3 survived the whole suite.
    //
    // Asserted as a MARGIN rather than as the number, so a retune of either constant is only a
    // failure when the two actually collide.
    const regenMs = (SHIELD_REGEN_DELAY / TICK_RATE) * 1000;
    expect(regenMs).toBeGreaterThan(SHATTER_MS * 3);
  });

  it('does not restart when a second break lands inside the exit', () => {
    const a = broken();
    a.interpolate(1, SHATTER_MS / 2);
    expect(shatterOf(a)).toBeCloseTo(0.5, 6);
    a.setShield(0, 8); // a DoT tick on the same actor, or the same event twice
    expect(shatterOf(a)).toBeCloseTo(0.5, 6); // not snapped back to the start
    a.interpolate(1, SHATTER_MS / 2);
    expect(skinFiltersOf(a) as unknown[] ?? []).toEqual([]); // and it still ends on time
  });

  it('cancels the exit when the shield regenerates mid-flight', () => {
    // The exit and the live shell are the SAME filter, so an exit left running underneath a
    // restored shield would keep expanding and thinning it.
    const a = broken();
    a.interpolate(1, SHATTER_MS / 2);
    a.setShield(3, 8);
    expect(shatterOf(a)).toBe(0);
    expect(shieldFilterOf(a)!.intensity).toBeCloseTo(0.375);
    a.interpolate(1, SHATTER_MS * 2); // the cancelled exit must not fire later
    expect(skinFiltersOf(a) as unknown[]).toHaveLength(1);
    expect(shieldFilterOf(a)!.intensity).toBeCloseTo(0.375);
  });

  it('does not shatter an actor that never had a shell on screen', () => {
    // An actor arriving with an already-empty pool reaches ratio 0 from the initial `-1`
    // without ever having been shielded. Playing a bubble bursting there would build a filter,
    // and a render-target pass, around a character that never had one.
    const a = new Actor('player', 12);
    a.setShield(0, 8);
    expect(shieldFilterOf(a)).toBeNull();
    expect(skinFiltersOf(a) as unknown[] ?? []).toEqual([]);
    a.interpolate(1, SHATTER_MS);
    expect(shieldFilterOf(a)).toBeNull();
  });

  it('does not resurrect a shell that is no longer on screen', () => {
    // The subtler half of the guard above: `shieldFilter` outlives the shell it draws (it is
    // reused), so "there is a filter" is not "there is a shell". An exit started for a bubble
    // nobody can see does not show up immediately — the list is not recomposed at that instant —
    // it shows up at the NEXT recompose from any cause at all, which is what makes it the kind
    // of bug that survives review. So the assertion has to be taken after one.
    const a = new Actor('player', 12);
    a.setShield(4, 8);
    a.setShield(0, 0); // the pool itself went away — the shell detached, with no exit
    expect(shieldFilterOf(a)).not.toBeNull(); // ...but the filter instance is still around
    a.setShield(0, 8); // "broken", with nothing on screen to break
    a.interpolate(1, SHATTER_MS / 2);
    a.onHurt(); // ANY recompose — a hit, a burn toggle, a quality flip
    expect(skinFiltersOf(a) as unknown[]).toHaveLength(1); // the outline alone, no shell
  });

  it('drops the shell at once when the pool itself goes away', () => {
    // `maxShield <= 0` is a different statement from "the shield broke" — there is no shield to
    // watch shatter, so any exit in flight is abandoned rather than played out.
    const a = broken();
    a.interpolate(1, SHATTER_MS / 4);
    a.setShield(0, 0);
    expect(skinFiltersOf(a) as unknown[] ?? []).toEqual([]);
    expect(shatterOf(a)).toBe(0);
  });

  it('runs the exit clock on the low quality tier too, which draws no shader at all', () => {
    // `render/quality.ts`'s low tier composes an empty filter list, but the clock still decides
    // WHEN the shell is gone — the same reason `lowTierAlpha` exists for the dissolve. A clock
    // that only ran while something was drawn would leave `shieldActive` stuck true forever, and
    // a tier flip back to high would resurrect a broken shell.
    setActiveQuality('low');
    const a = broken();
    expect(skinFiltersOf(a) as unknown[] ?? []).toEqual([]);
    a.interpolate(1, SHATTER_MS);
    setActiveQuality('high');
    a.refreshQuality();
    expect(skinFiltersOf(a) as unknown[] ?? []).toEqual([]);
  });
});

function outlineFilterOf(a: Actor): { alpha: number } | null {
  return fxOf(a).outlineFilter as { alpha: number } | null;
}

describe('Actor.onHurt — outline shader (design/01 fidelity roadmap milestone 5)', () => {
  it('attaches the outline filter at full alpha on the first hit', () => {
    const a = new Actor('enemy', 12);
    expect(skinFiltersOf(a) as unknown[] ?? []).toEqual([]); // no filter, pre-hit
    a.onHurt();
    expect(skinFiltersOf(a) as unknown[]).toHaveLength(1); // the outline alone
    expect(outlineFilterOf(a)!.alpha).toBe(1);
  });

  it('decays to 0 over HIT_FLASH_MS and then detaches', () => {
    const a = new Actor('player', 12);
    a.onHurt();
    a.interpolate(1, HIT_FLASH_MS / 2);
    expect(outlineFilterOf(a)!.alpha).toBeCloseTo(0.5, 1);
    expect(skinFiltersOf(a)).toBeTruthy();
    a.interpolate(1, HIT_FLASH_MS / 2); // fully decayed
    expect(outlineFilterOf(a)!.alpha).toBe(0);
    expect(skinFiltersOf(a) as unknown[] ?? []).toEqual([]); // back to no filter at all
  });

  it('reuses the same filter instance across repeated hits', () => {
    const a = new Actor('player', 12);
    a.onHurt();
    const first = outlineFilterOf(a);
    a.interpolate(1, HIT_FLASH_MS); // fully decays
    a.onHurt();
    expect(outlineFilterOf(a)).toBe(first);
    expect(outlineFilterOf(a)!.alpha).toBe(1);
  });

  it('coexists with an active shield glow — both filters attach at once', () => {
    const a = new Actor('player', 12);
    a.setShield(4, 8);
    a.onHurt();
    expect(skinFiltersOf(a) as unknown[]).toHaveLength(2); // shield + outline (no lit filter since 2026-08-24)
  });

  // 2026-08-26: a hit now also dents the shell (`EnergyShieldFilter.hit`). Everything above
  // calls `onHurt()` with no arguments, so none of it exercises the direction at all.
  describe('forwards the impact direction to the shell', () => {
    const lastHitOf = (a: Actor): [number, number] | null =>
      (shieldFilterOf(a) as unknown as { lastHit: [number, number] | null } | null)?.lastHit ?? null;

    it('hands the shell the delta it was given, unchanged', () => {
      const a = new Actor('player', 12);
      a.setShield(4, 8);
      a.onHurt(5, -2);
      expect(lastHitOf(a)).toEqual([5, -2]);
    });

    it('does not build a shell for an actor that has no shield pool', () => {
      // An unshielded actor still flashes its outline. Creating a shield filter here just to
      // animate it would wrap a bubble round a character that has no shield — and it would cost
      // a render-target pass per hit for every enemy in the room, which is the exact per-actor
      // cost the 2026-08-24 lighting pass existed to remove.
      const a = new Actor('enemy', 12);
      a.onHurt(5, -2);
      expect(shieldFilterOf(a)).toBeNull();
      expect(skinFiltersOf(a) as unknown[]).toHaveLength(1); // the outline alone
    });

    it('does not dent a shell that has already broken', () => {
      const a = new Actor('player', 12);
      a.setShield(4, 8);
      a.onHurt(1, 0);
      a.setShield(0, 8); // broken — the shell is now playing its exit, not sitting there
      a.onHurt(-1, 0);
      expect(lastHitOf(a)).toEqual([1, 0]); // the second hit did not reach it
      // The shell is STILL ATTACHED here (it is mid-exit, 2026-08-26), so the elastic dent has
      // to be excluded by name rather than by the filter's absence: a shield coming apart that
      // sprang back from a hit would read as it healing.
      expect(skinFiltersOf(a) as unknown[]).toHaveLength(2); // the exiting shell + the outline
    });

    it('dents again once a regenerated shell replaces the one that broke', () => {
      // The other side of the guard above: excluding the exit must not leave the shell
      // permanently deaf to impacts after the first break of a match.
      const a = new Actor('player', 12);
      a.setShield(4, 8);
      a.setShield(0, 8);
      a.interpolate(1, SHATTER_MS);
      a.setShield(4, 8);
      a.onHurt(-1, 0);
      expect(lastHitOf(a)).toEqual([-1, 0]);
    });

    it('defaults to a directionless hit rather than passing undefined through', () => {
      const a = new Actor('player', 12);
      a.setShield(4, 8);
      a.onHurt();
      expect(lastHitOf(a)).toEqual([0, 0]); // `hit()` reads (0,0) as "keep the previous axis"
    });
  });
});

function dissolveFilterOf(a: Actor): { progress: number } | null {
  return fxOf(a).dissolveFilter as { progress: number } | null;
}

describe('Actor.onDeath — death-dissolve shader (design/01 fidelity roadmap milestone 5)', () => {
  it('attaches the dissolve filter and hides the weapon/aura/hp-bar/local-ring', () => {
    const a = new Actor('player', 12);
    a.setLocal(true);
    a.setHealth(50, 100);
    a.onDeath();
    expect(skinFiltersOf(a)).toBeTruthy();
    expect(dissolveFilterOf(a)!.progress).toBe(0);
    expect(a.isDissolved).toBe(false);
    const weaponGfx = (a as unknown as { weaponGfx: { visible: boolean } }).weaponGfx;
    const statusAura = (a as unknown as { statusAura: { visible: boolean } }).statusAura;
    expect(weaponGfx.visible).toBe(false);
    expect(statusAura.visible).toBe(false);
  });

  it('progresses over DISSOLVE_MS and reports isDissolved once fully played out', () => {
    const a = new Actor('enemy', 12);
    a.onDeath();
    a.interpolate(1, 350); // half of the 700ms dissolve
    expect(dissolveFilterOf(a)!.progress).toBeCloseTo(0.5, 1);
    expect(a.isDissolved).toBe(false);
    a.interpolate(1, 400); // past the end — clamps, doesn't overshoot
    expect(dissolveFilterOf(a)!.progress).toBe(1);
    expect(a.isDissolved).toBe(true);
  });

  it('is idempotent — a second call does not rebuild the filter or reset progress', () => {
    const a = new Actor('enemy', 12);
    a.onDeath();
    a.interpolate(1, 350);
    const first = dissolveFilterOf(a);
    a.onDeath();
    expect(dissolveFilterOf(a)).toBe(first);
    expect(dissolveFilterOf(a)!.progress).toBeCloseTo(0.5, 1);
  });
});

function heatHazeFilterOf(a: Actor): unknown {
  return fxOf(a).heatHazeFilter;
}

describe('Actor.setStatus — heat-haze shader on burn (design/01 fidelity roadmap milestone 5)', () => {
  it('is a no-op with no active status at all', () => {
    const a = new Actor('enemy', 12);
    a.setStatus(freshStatus());
    expect(skinFiltersOf(a) as unknown[] ?? []).toEqual([]); // no filter at all
    expect(heatHazeFilterOf(a)).toBeNull();
  });

  it('attaches the heat-haze filter on a burn, alongside the existing status-aura ring', () => {
    const a = new Actor('enemy', 12);
    a.setStatus({ ...freshStatus(), burnTicks: 10 });
    expect(skinFiltersOf(a)).toBeTruthy();
    expect(heatHazeFilterOf(a)).not.toBeNull();
  });

  it('detaches once the burn ends, even if a different status (chill) is still active', () => {
    const a = new Actor('enemy', 12);
    a.setStatus({ ...freshStatus(), burnTicks: 10, chillTicks: 5 });
    expect(skinFiltersOf(a)).toBeTruthy();
    a.setStatus({ ...freshStatus(), burnTicks: 0, chillTicks: 5 }); // burn ends, chill lingers
    expect(skinFiltersOf(a) as unknown[] ?? []).toEqual([]); // no heat-haze/shield/outline/dissolve
  });

  it('does not rebuild the filter on an unrelated aura change while still burning', () => {
    const a = new Actor('enemy', 12);
    a.setStatus({ ...freshStatus(), burnTicks: 10 });
    const first = heatHazeFilterOf(a);
    a.setStatus({ ...freshStatus(), burnTicks: 10, chillTicks: 5 }); // chill joins, burn continues
    expect(heatHazeFilterOf(a)).toBe(first);
  });

  it('coexists with the shield glow — both filters attach at once', () => {
    const a = new Actor('player', 12);
    a.setShield(4, 8);
    a.setStatus({ ...freshStatus(), burnTicks: 10 });
    expect(skinFiltersOf(a) as unknown[]).toHaveLength(2); // shield + heat-haze (no lit filter since 2026-08-24)
  });
});

// Lighting left the Actor entirely on 2026-08-24 (see fx/filters/litFx.ts): it is one
// screen-space pass over `Layers.lit`, not a filter per character. These pin the
// consequence — the thing that made the frame expensive was that this list was NEVER empty.
describe('Actor filters — nothing is attached unconditionally any more', () => {
  it('a freshly constructed actor carries no filter at all', () => {
    const a = new Actor('enemy', 12);
    expect(skinFiltersOf(a) as unknown[] ?? []).toEqual([]);
  });

  it('does not grow a filter list just from being interpolated or re-facing', () => {
    // The old lit filter was attached in the constructor, so "no filters" could regress
    // silently by anything that called applySkinFilters. Drive the ordinary per-frame path.
    const a = new Actor('player', 12);
    a.pushState(0, 0, 0, 0, 0);
    a.snap();
    a.interpolate(1, 16);
    a.setStatus(freshStatus());
    a.setHealth(6, 6);
    expect(skinFiltersOf(a) as unknown[] ?? []).toEqual([]);
  });

  it('drops back to an empty list once every conditional shader has expired', () => {
    const a = new Actor('player', 12);
    a.setStatus({ ...freshStatus(), burnTicks: 10 });
    a.setShield(4, 8);
    a.onHurt();
    expect(skinFiltersOf(a) as unknown[]).toHaveLength(3);
    a.setStatus(freshStatus());
    a.setShield(0, 8);
    a.interpolate(1, 10_000); // long enough for the hit flash to run out
    expect(skinFiltersOf(a) as unknown[] ?? []).toEqual([]);
  });
});

describe('Actor — all four fidelity-roadmap shaders composed at once (design/01 milestone 5)', () => {
  it('stacks heat-haze, shield, outline, and dissolve in a fixed warp→glow→highlight→dissolve order', () => {
    const a = new Actor('player', 12);
    a.setStatus({ ...freshStatus(), burnTicks: 10 });
    a.setShield(4, 8);
    a.onHurt();
    a.onDeath();

    const list = skinFiltersOf(a) as unknown[];
    expect(list).toHaveLength(4); // was 5 — the always-on lit filter is gone
    expect(list[0]).toBe(heatHazeFilterOf(a));
    expect(list[1]).toBe(shieldFilterOf(a));
    expect(list[2]).toBe(outlineFilterOf(a));
    expect(list[3]).toBe(dissolveFilterOf(a));
  });
});

describe('Actor.interpolate — body vs weapon facing (upper/lower body split)', () => {
  it('the body indicator follows bodyFacingRad, the weapon graphic follows facingRad', () => {
    const a = new Actor('player', 20);
    a.pushState(0, 0, 0, Math.PI, -Math.PI / 2); // aim=west, body=north
    a.snap();
    a.interpolate(1, 16);
    expect(frontOf(a).rotation).toBeCloseTo(-Math.PI / 2, 10);
    expect(weaponGfxOf(a).rotation).toBeCloseTo(Math.PI, 10);
  });

  it('the two angles move independently across ticks', () => {
    const a = new Actor('player', 20);
    a.pushState(0, 0, 0, 0, 0);
    a.snap();
    a.interpolate(1, 16);
    expect(frontOf(a).rotation).toBeCloseTo(0, 10);
    expect(weaponGfxOf(a).rotation).toBeCloseTo(0, 10);

    // Body turns to face new movement; aim stays put (player kept shooting the same way).
    a.pushState(1, 0, 0, 0, Math.PI);
    a.snap();
    a.interpolate(1, 16);
    expect(frontOf(a).rotation).toBeCloseTo(Math.PI, 10);
    expect(weaponGfxOf(a).rotation).toBeCloseTo(0, 10);
  });

  it('an enemy (no distinct body facing passed) keeps both angles in lockstep', () => {
    const a = new Actor('enemy', 20);
    a.pushState(0, 0, 0, Math.PI / 2); // bodyFacingRad defaults to facingRad
    a.snap();
    a.interpolate(1, 16);
    expect(frontOf(a).rotation).toBeCloseTo(Math.PI / 2, 10);
    expect(weaponGfxOf(a).rotation).toBeCloseTo(Math.PI / 2, 10);
  });
});

// `movingOverride` (ROADMAP: fixes the local player's walk animation never playing
// under prediction) — `Scene.positionLocal`'s predicted-pose snap collapses prev onto
// cur every render frame, so the default curX/prevX-delta heuristic below would always
// read "stationary" for the local player. Spying on `skin.setFacing` (rather than
// reading the Graphics placeholder's rotation, which is identical for idle/move) is the
// only way to observe which clip name `interpolate()` actually picked.
function skinOf(a: Actor): { setFacing: (...args: unknown[]) => void } {
  return (a as unknown as { skin: { setFacing: (...args: unknown[]) => void } }).skin;
}

describe('Actor.interpolate — movingOverride (idle/move clip selection survives a positionLocal-style snap)', () => {
  it('by default, derives moving from the buffer delta (Scene.reconcile\'s normal per-tick pushState, no snap)', () => {
    const a = new Actor('player', 20);
    const spy = vi.spyOn(skinOf(a), 'setFacing');
    a.pushState(0, 0, 0, 0, 0);
    a.snap();
    a.pushState(10, 0, 0, 0, 0); // moved 10px this tick — no snap, so the delta itself is the signal
    a.interpolate(1, 16);
    expect(spy).toHaveBeenLastCalledWith(0, 0, 16, 'move');
  });

  it('a snap to the same position (no override set) still reads idle, exactly as before this fix', () => {
    const a = new Actor('player', 20);
    const spy = vi.spyOn(skinOf(a), 'setFacing');
    a.pushState(5, 5, 0, 0, 0);
    a.snap();
    a.interpolate(1, 16);
    expect(spy).toHaveBeenLastCalledWith(0, 0, 16, 'idle');
  });

  it('movingOverride=true forces the move clip even though prev==cur — what Scene.positionLocal now sets from LocalPredictor.pose.moving', () => {
    const a = new Actor('player', 20);
    const spy = vi.spyOn(skinOf(a), 'setFacing');
    a.pushState(5, 5, 0, 0, 0);
    a.snap(); // prev == cur, same as positionLocal's own snap()
    a.movingOverride = true;
    a.interpolate(1, 16);
    expect(spy).toHaveBeenLastCalledWith(0, 0, 16, 'move');
  });

  it('movingOverride is reset by the next pushState (e.g. prediction deactivating, back to the confirmed path)', () => {
    const a = new Actor('player', 20);
    const spy = vi.spyOn(skinOf(a), 'setFacing');
    a.pushState(0, 0, 0, 0, 0);
    a.snap();
    a.movingOverride = true;
    a.pushState(0, 0, 0, 0, 0); // Scene.reconcile's ordinary push — no override set afterward
    a.interpolate(1, 16);
    expect(spy).toHaveBeenLastCalledWith(0, 0, 16, 'idle'); // falls back to the (stationary) buffer delta
  });
});

// muzzlePos (2026-08-17) — Actor's slice of the "bullets leave the barrel tip" fix: it
// lifts `Skin.muzzleAnchor`'s skin-local point into the space `Entity.x/y` live in, so
// `Scene` can hand it straight to a Bullet. Skin.test.ts covers the rig -> skin scale
// and RigSkin.test.ts the socket/texture geometry; this is only the last hop.
/**
 * WHO DRAWS THE WEAPON — the 2026-08-21 fix, and the regression test for it.
 *
 * `Actor` owns a cosmetic `Graphics` bar that stands in for a weapon when no real art can be
 * mounted. Deciding when to draw it used to read `hasRig && faction === 'player'`, i.e. it
 * treated mounting as a property of the FACTION. It is a property of the RIG, and the cost of
 * getting that backwards was total: every enemy loads a real rig, so every enemy failed the
 * faction half of that test and kept the placeholder forever. `gun_enemygun.png` shipped
 * calibrated in `WEAPON_DEFS` and was never rendered in the world once; the bar it fell back
 * to draws at the actor's ground origin, 11-28 world px below where a rig body is drawn, so on
 * a real frame it read as a white rectangle lying on the floor beside the creature.
 *
 * The invariant now: exactly one of {rig-mounted sprite, Graphics placeholder} is ever drawn,
 * and which one is the rig's call via `Skin.weaponMount`. Note the boss case — 'none' is NOT
 * the same as 'placeholder', and conflating them is what put a mob's rifle bar on the finale.
 */
describe('Actor.setWeaponKind — the rig decides who draws the weapon, not the faction', () => {
  afterEach(() => {
    skinRegistryMocks.loaded = undefined;
  });

  const placeholderWidth = (a: Actor): number =>
    (a as unknown as { weaponGfx: Graphics }).weaponGfx.getLocalBounds().width;

  it('draws the placeholder when NO rig is loaded — the one case it is for', () => {
    const a = new Actor('enemy', 15);
    a.setWeaponKind('ranged', 'physical', 'enemygun');
    expect(placeholderWidth(a)).toBeGreaterThan(0);
  });

  it('draws the placeholder for a melee kind too, so an unrigged skin is never unarmed-looking', () => {
    const a = new Actor('player', 20);
    a.setWeaponKind('melee', 'fire', 'emberblade');
    expect(placeholderWidth(a)).toBeGreaterThan(0);
  });

  it("draws NOTHING for a socket-mount rig — the sprite IS the hero's weapon", () => {
    skinRegistryMocks.loaded = loadedOrbCoreRig();
    const a = new Actor('player', 20, undefined, false, 'char_vanguard');
    a.setWeaponKind('ranged', 'physical', 'blaster');
    expect(placeholderWidth(a)).toBe(0);
  });

  // THE regression test. This actor is an enemy AND has a rig, which is precisely the
  // combination the old faction gate got wrong.
  it('draws NOTHING for a held-mount enemy rig — the case the faction gate broke', () => {
    skinRegistryMocks.loaded = loadedCritterCoreRig();
    const a = new Actor('enemy', 15, 0xf56565, false, 'critter-core');
    a.setWeaponKind('ranged', 'physical', 'enemygun');
    expect(placeholderWidth(a)).toBe(0);
  });

  it("draws NOTHING for a 'none' rig either — a weaponless body is not a placeholder body", () => {
    skinRegistryMocks.loaded = loadedBossCoreRig();
    const a = new Actor('enemy', 30, 0x8e24aa, true, 'boss-core');
    a.setWeaponKind('ranged', 'physical', 'enemygun');
    expect(placeholderWidth(a)).toBe(0);
  });

  it('still clears the placeholder when the weapon is unequipped', () => {
    const a = new Actor('enemy', 15);
    a.setWeaponKind('ranged', 'physical', 'enemygun');
    expect(placeholderWidth(a)).toBeGreaterThan(0);
    a.setWeaponKind(null);
    expect(placeholderWidth(a)).toBe(0);
  });

  it('does not depend on the faction at all any more — same rig, both factions, same answer', () => {
    skinRegistryMocks.loaded = loadedOrbCoreRig();
    const mine = new Actor('player', 20, undefined, false, 'char_vanguard');
    const theirs = new Actor('enemy', 20, undefined, false, 'char_vanguard');
    mine.setWeaponKind('ranged', 'physical', 'blaster');
    theirs.setWeaponKind('ranged', 'physical', 'blaster');
    expect(placeholderWidth(mine)).toBe(placeholderWidth(theirs));
    expect(placeholderWidth(theirs)).toBe(0);
  });
});

describe('Actor.muzzlePos — the drawn barrel tip, in Entity coordinates', () => {
  afterEach(() => {
    skinRegistryMocks.loaded = undefined;
  });

  type Anchor = { x: number; y: number; heightPx: number };
  const stubMuzzle = (a: Actor, local: Anchor | null) => {
    (a as unknown as { skin: { muzzleAnchor: () => Anchor | null } }).skin.muzzleAnchor = () => local;
  };

  it('is null when the skin reports no mounted module — a placeholder skin, or a preload gap', () => {
    const mob = new Actor('enemy', 12); // no rig registered: the Graphics placeholder
    expect(mob.muzzlePos()).toBeNull();
  });

  it('offsets the skin-local point by the actor\'s own drawn position', () => {
    skinRegistryMocks.loaded = loadedOrbCoreRig();
    const a = new Actor('player', 20, undefined, false, 'char_vanguard');
    a.place(500, 300, 0);
    // A rig-local point with no ground-NORTH component (`heightPx === -y`), i.e. the module
    // is out along a due-east aim: everything the rig draws above the origin is height.
    stubMuzzle(a, { x: 30, y: -18, heightPx: 18 });
    // Stated against the DRAWN baseline (`a.y`) rather than the ground y, because a hovering
    // archetype's `visualZ` is folded into the transform (2026-08-18) — which is exactly the
    // contract this pins down: muzzlePos is wherever the barrel is actually drawn.
    expect(a.muzzlePos()!.x).toBe(530);
    expect(a.muzzlePos()!.y).toBe(a.y - 18);
    // ...and for that pose the reported HEIGHT is exactly how far the barrel tip is drawn
    // above the actor's own GROUND point — hover included, since the gun rides with the body.
    // (2026-09-02: this is what `Scene` lifts a fresh round to, so the round and the gun it
    // came out of are at the same height and nothing is left to bend the shot.)
    expect(300 - a.muzzlePos()!.y).toBeCloseTo(a.muzzlePos()!.heightPx, 10);
    expect(a.muzzlePos()!.heightPx).toBeGreaterThan(18); // 18 + this archetype's hover
  });

  it('tracks the DRAWN position, so a lifted (z > 0) actor\'s muzzle rises with its sprite', () => {
    skinRegistryMocks.loaded = loadedOrbCoreRig();
    const a = new Actor('player', 20, undefined, false, 'char_vanguard');
    a.place(500, 300, 40); // Entity.applyTransform puts the container at y = gy - z
    stubMuzzle(a, { x: 30, y: -18, heightPx: 18 });
    const hover = 300 - a.y - 40; // the hover baseline this archetype rests at
    expect(hover).toBeGreaterThan(0);
    expect(a.muzzlePos()).toEqual({ x: 530, y: 300 - 40 - hover - 18, heightPx: 40 + hover + 18 });
  });

  it('includes the placeholder body lift, so it stays right if a placeholder ever mounts one', () => {
    // `skin.view.y` is 0 for a rig and -radius*BODY_LIFT_R for the placeholder; muzzlePos
    // reads it rather than assuming 0, which is what this pins down.
    const a = new Actor('player', 20); // placeholder: lift = -14
    a.place(0, 0, 0);
    stubMuzzle(a, { x: 10, y: -5, heightPx: 5 });
    // -14 placeholder body lift, -5 local point, and the hover baseline in `a.y`.
    // The body lift SUBTRACTS from the height for the same reason it lowers the point: it
    // drops the drawn body, taking the muzzle down with it.
    expect(a.muzzlePos()).toEqual({ x: 10, y: a.y - 14 - 5, heightPx: a.drawnLift + 5 + 14 });
  });
});

// Idle hover (2026-08-18 depth pass, user report "please strengthen the sense of depth a bit more"). The rigs' own
// `idle` clips already bobbed the ART; what they could not do is move the SHADOW, because a
// clip only knows about bones. `Entity.visualZ` lifts the whole entity instead, so the shadow
// shrinks, fades and slides with it — which is the cue that says the body left the floor.
describe('Actor — idle hover', () => {
  it('rests a hovering archetype off the floor, and a grounded one on it', () => {
    const orb = new Actor('player', 20, undefined, false, 'char_vanguard');
    orb.place(100, 200, 0);
    expect(orb.y).toBeLessThan(200); // drawn above its own ground point

    const critter = new Actor('enemy', 14, undefined, false, 'critter-core');
    critter.place(100, 200, 0);
    expect(critter.y).toBe(200); // design/13's ground critters do not float
  });

  it('leaves the Y-sort key on the GROUND coordinate, so hovering can never reorder anything', () => {
    const a = new Actor('player', 20, undefined, false, 'char_vanguard');
    a.pushState(100, 250, 0, 0);
    a.snap();
    a.interpolate(1, 600);
    const first = a.zIndex;
    a.interpolate(1, 600); // a different point in the hover cycle
    expect(a.y).not.toBe(first); // the sprite really did move...
    expect(a.zIndex).toBe(250); // ...and the sort key really did not
  });

  it('oscillates within a small band, never drifting off into the air', () => {
    const a = new Actor('player', 20, undefined, false, 'char_vanguard');
    a.pushState(0, 0, 0, 0);
    a.snap();
    const lifts: number[] = [];
    for (let i = 0; i < 40; i++) {
      a.interpolate(1, 120);
      lifts.push(-a.y); // ground y is 0, so the drawn y IS the negated lift
    }
    const lo = Math.min(...lifts);
    const hi = Math.max(...lifts);
    expect(lo).toBeGreaterThan(0); // always at least a little off the floor
    expect(hi).toBeLessThan(12); // a hover, not a jump — these are world px at ~4x zoom
    expect(hi - lo).toBeGreaterThan(2); // and it genuinely moves
  });

  it('slides and shrinks the shadow with the lift, not just scales it', () => {
    // The offset is the half the clip could never produce. Without it a hover only ever
    // breathed the shadow in place, which reads as the shadow pulsing rather than the body
    // rising — the exact complaint about the character looking flat.
    const a = new Actor('player', 20, undefined, false, 'char_vanguard');
    a.pushState(300, 400, 0, 0);
    a.snap();
    a.interpolate(1, 0);
    expect(a.shadow!.x).toBeGreaterThan(300); // displaced away from the upper-left key light
    expect(a.shadow!.y).toBeGreaterThan(400);
    expect(a.shadow!.scale.x).toBeLessThan(1); // and lifted off it, so smaller and fainter
    expect(a.shadow!.alpha).toBeLessThan(1);
  });

  it('does NOT carry the health bar up and down with it — the readout stays pinned', () => {
    // Live report 2026-09-21, *"can the health bar above the character stop bobbing up and
    // down with it? my eyes are swimming"*. The hover is a cue about the BODY's weight; the bar
    // is the one piece of furniture the eye has to fixate on and read a fraction off, and this
    // archetype's amp 2 moves it 4 world px peak to trough — one full bar height (`setHealth`
    // draws the track 4 px tall), ~14-16 screen px at a room's cover-fit zoom. `applyTransform`
    // adds `visualZ` back so the bar hangs at a constant height while the body bobs beneath it.
    const a = new Actor('player', 20, undefined, false, 'char_vanguard');
    a.pushState(100, 250, 0, 0);
    a.snap();
    const bodyYs: number[] = [];
    const barYs: number[] = [];
    for (let i = 0; i < 40; i++) {
      a.interpolate(1, 120); // 4.8 s total — two full cycles of this archetype's 2400 ms bob
      bodyYs.push(a.y);
      barYs.push(a.healthBar!.y);
    }
    // The fixture is meaningless unless the body really is bobbing over these samples.
    expect(Math.max(...bodyYs) - Math.min(...bodyYs)).toBeGreaterThan(2);
    expect(Math.max(...barYs) - Math.min(...barYs)).toBeCloseTo(0, 5);
    // Pinned to the GROUND point's own offset, not to some arbitrary constant — and still
    // tracking x, which was never the complaint.
    const offsetY = (a as unknown as { healthBarOffsetY: number }).healthBarOffsetY;
    expect(barYs[0]).toBeCloseTo(250 + offsetY, 5);
    expect(a.healthBar!.x).toBeCloseTo(100, 5);
  });

  it('still carries the health bar with a REAL height change — only the idle bob is pinned', () => {
    // The fix strips `visualZ`, not `z`. Engine z is 0 for every actor today (design/01,
    // "`z` never gates gameplay"), but a knock-up would be the actor genuinely being
    // somewhere else, and a bar left behind on the floor would be the worse bug.
    const grounded = new Actor('enemy', 14, undefined, false, 'critter-core');
    grounded.place(0, 400, 0);
    const resting = grounded.healthBar!.y;
    grounded.place(0, 400, 30);
    expect(grounded.healthBar!.y).toBeCloseTo(resting - 30, 5);
  });

  it('spreads phase across actors so a room full of floaters does not pulse in lockstep', () => {
    const a = new Actor('enemy', 14, undefined, false, 'floater-core');
    const b = new Actor('enemy', 14, undefined, false, 'floater-core');
    for (const e of [a, b]) {
      e.pushState(0, 0, 0, 0);
      e.snap();
      e.interpolate(1, 0);
    }
    expect(a.y).not.toBeCloseTo(b.y, 3);
  });

  it('builds the ground shadow as nested ellipses, not one flat disc', () => {
    // A single uniform ellipse reads as a die-cut sticker under the character; stacking a
    // wide faint ring down to a small dark core fakes a penumbra with no blur filter.
    const a = new Actor('player', 20, undefined, false, 'char_vanguard');
    const b = a.shadow!.bounds;
    expect(b.width).toBeGreaterThan(b.height); // vertically foreshortened for the tilted view
    expect(b.height / b.width).toBeCloseTo(SHADOW_SQUASH, 1);
  });
});

describe('Actor — hover is per body archetype, not per faction', () => {
  it('floats the archetypes design/13 says float, and leaves the walkers alone', () => {
    const lift = (faction: 'player' | 'enemy', key?: string) => {
      const a = new Actor(faction, 16, undefined, false, key);
      a.place(0, 500, 0);
      return 500 - a.y;
    };
    // Hovering: the hero roster and the floating ranged enemy form.
    expect(lift('player', 'char_vanguard')).toBeGreaterThan(0);
    expect(lift('player', 'char_skirmisher')).toBeGreaterThan(0);
    expect(lift('player', 'char_juggernaut')).toBeGreaterThan(0);
    expect(lift('enemy', 'floater-core')).toBeGreaterThan(0);
    expect(lift('enemy', 'boss-core')).toBeGreaterThan(0);
    // Grounded: the squat crystal critter and the heavy brute both walk.
    expect(lift('enemy', 'critter-core')).toBe(0);
    expect(lift('enemy', 'brute-core')).toBe(0);
  });

  it('leaves an unknown skin key grounded rather than guessing', () => {
    // Forward-compat: a new blueprint pointing at a rig with no HOVER entry must not float by
    // accident. `atlasKey` comes from content data, so this is reachable without a code change.
    const a = new Actor('enemy', 16, undefined, false, 'some-future-rig');
    a.place(0, 500, 0);
    expect(a.y).toBe(500);
  });

  it('defaults a player with no key at all to the hovering hero, and an enemy to a walker', () => {
    const p = new Actor('player', 16);
    p.place(0, 500, 0);
    expect(p.y).toBeLessThan(500);
    const e = new Actor('enemy', 16);
    e.place(0, 500, 0);
    expect(e.y).toBe(500);
  });

  it('never advances the hover clock for a grounded actor', () => {
    const mob = new Actor('enemy', 16, undefined, false, 'critter-core');
    mob.pushState(0, 300, 0, 0);
    mob.snap();
    for (let i = 0; i < 10; i++) mob.interpolate(1, 100);
    expect(mob.y).toBe(300); // still flat on the floor after a second of frames
  });
});

describe('Actor.setStatus — the aura wraps a body in a tilted view', () => {
  function auraOf(a: Actor): Graphics {
    return a.children[Child.StatusAura] as Graphics;
  }

  it('draws each ring as a foreshortened ellipse, not a screen-space circle', () => {
    // A true circle is the loudest "flat decal" cue a round overlay can give. An aura is a
    // ring at the actor's FEET, on the ground plane, so it foreshortens with the camera tilt
    // and shares SHADOW_SQUASH with the ground shadow. The shield deliberately does not (a
    // sphere around the body reads as a circle from every angle) — see filters.test.ts.
    const a = new Actor('enemy', 20);
    a.setStatus({ ...freshStatus(), burnTicks: 5 });
    // Read the ellipse's own radii rather than the Graphics bounds, which are inflated by the
    // 3 px stroke — and inflated asymmetrically, since a constant is being added to a squashed
    // axis and an unsquashed one.
    const instrs = auraOf(a).context.instructions as Array<{
      data: { path?: { instructions: Array<{ action: string; data: number[] }> } };
    }>;
    const ellipses = instrs.flatMap((i) =>
      (i.data.path?.instructions ?? []).filter((pi) => pi.action === 'ellipse').map((pi) => pi.data),
    );
    expect(ellipses).toHaveLength(1);
    const [, , rx, ry] = ellipses[0]!;
    expect(ry! / rx!).toBeCloseTo(SHADOW_SQUASH, 6);
  });

  it('still nests one ring per active effect, each wider than the last', () => {
    const one = new Actor('enemy', 20);
    one.setStatus({ ...freshStatus(), burnTicks: 5 });
    const three = new Actor('enemy', 20);
    three.setStatus({ ...freshStatus(), burnTicks: 5, chillTicks: 5, poison: [{ ticks: 5, dmg: 1 }] as never });
    expect(three.children[Child.StatusAura].getLocalBounds().width)
      .toBeGreaterThan(one.children[Child.StatusAura].getLocalBounds().width);
  });
});

// The ground shadow's SIZE (2026-08-19 volume pass). It used to be `radiusPx * 0.7`, and both
// halves of that were wrong at once: every rig's `referenceRadius` IS its body bone's `bodyR`,
// so the gameplay radius already equals the rig's declared body radius — and the PNG bound to
// that bone paints as little as 0.68 of it, differing per bundle. One uniform 0.7 across a
// roster like that looked acceptable on the hero and made an enemy's shadow ~45% wider than the
// crystal standing in it, which is why it read as a black dinner plate. Same class of
// cross-layer mismatch as the `footprintRadius` bug fixed two days earlier: a number sized
// against art that has since changed, invisible in the source of either file.
describe('Actor — the ground shadow is sized from the DRAWN body, not the collision radius', () => {
  /** The shadow's outermost ellipse radius, in world px. */
  function shadowReach(a: Actor): number {
    return a.shadow!.getLocalBounds().width / 2;
  }

  it('shrinks with the art\'s fill, not with the gameplay radius', () => {
    // Two actors of the SAME collision radius whose bundles paint different shares of it must
    // get different shadows. If this ever ties again, the number is back to describing a box.
    skinRegistryMocks.loaded = { ...loadedOrbCoreRig(), bodyFill: 1 };
    const full = shadowReach(new Actor('player', 20, undefined, false, 'char_vanguard'));
    skinRegistryMocks.loaded = { ...loadedOrbCoreRig(), bodyFill: 0.7 };
    const partial = shadowReach(new Actor('player', 20, undefined, false, 'char_vanguard'));
    expect(partial).toBeLessThan(full);
    expect(partial / full).toBeCloseTo(0.7, 2);
  });

  it('never lets the shadow run away from the silhouette it belongs to', () => {
    // The plate. A shadow may reach a little past the body (a penumbra does) but not half again
    // as far — measured, the old sizing put an enemy's at ~1.45x its own crystal.
    for (const fill of [1, 0.81, 0.7, 0.68]) {
      skinRegistryMocks.loaded = { ...loadedOrbCoreRig(), bodyFill: fill };
      const a = new Actor('enemy', 20, undefined, false, 'char_vanguard');
      const drawn = 20 * fill;
      expect(shadowReach(a)).toBeLessThan(drawn * 1.4);
      expect(shadowReach(a)).toBeGreaterThan(drawn * 0.8); // ...and it must still be a shadow
    }
  });

  it('falls back to the full radius for the Graphics placeholder', () => {
    skinRegistryMocks.loaded = undefined;
    const a = new Actor('player', 20);
    expect(shadowReach(a)).toBeGreaterThan(20); // the capsule IS one radius wide; a penumbra exceeds it
    expect(shadowReach(a)).toBeLessThan(20 * 1.4);
  });

  it('keeps the project\'s one foreshortening, whatever the size', () => {
    skinRegistryMocks.loaded = { ...loadedOrbCoreRig(), bodyFill: 0.7 };
    const b = new Actor('player', 20, undefined, false, 'char_vanguard').shadow!.getLocalBounds();
    expect(b.height / b.width).toBeCloseTo(SHADOW_SQUASH, 6);
  });
});

describe('Actor — the hover has to be big enough to actually produce its own cue', () => {
  it('displaces the shadow by more than a screen pixel, everywhere in the bob', () => {
    // The lesson this pins: at the original base of 3.5 world px the offset was
    // `3.5 x SHADOW_SLANT` = (1.5, 0.8) world px, i.e. under one screen pixel at a normal zoom.
    // The whole HOVER table existed to make a shadow separate from its body and could not,
    // however carefully its numbers were tuned — an arithmetic dead end, not a look problem.
    //
    // Sampled across a full bob rather than at one instant. `hoverT` is seeded from a
    // module-level construction counter (`hoverPhaseSeq`, deliberately order-dependent so a
    // room of floaters doesn't pulse in lockstep), so "at rest" is not a state a test can
    // reach: the single-instant version of this assertion silently measured whatever phase the
    // actors constructed earlier in this FILE happened to leave behind, and broke when an
    // unrelated test was added above it (2026-08-21).
    //
    // Retuned again 2026-08-21 (HOVER's own doc comment has the full account): the 08-19 pass
    // quoted only its base-to-peak half, and the TROUGH of `visualZ = base + amp * sin(t)`
    // (which swings across the WHOLE `[base-amp, base+amp]` range) was left at (1.05, 0.55) —
    // under one screen pixel on the Y axis at the game's own zoom floor. Every archetype's
    // swing now stays inside `[6, 10]` world px, so the trough offset is at least (2.52, 1.32)
    // — a real margin, not a near-miss — while the peak stays at or under the pre-existing
    // ~10 px "hovering, not flying" ceiling. Asserted both ways below, so the cue has to
    // survive the bottom of the bob AND actually reach a separation at the top.
    skinRegistryMocks.loaded = { ...loadedOrbCoreRig(), bodyFill: 0.81 };
    const a = new Actor('player', 20, undefined, false, 'char_vanguard');
    a.pushState(500, 500, 0, 0);
    a.snap();
    const dx: number[] = [];
    const dy: number[] = [];
    for (let i = 0; i < 40; i++) {
      a.interpolate(1, 120); // 40 x 120ms = 4.8s, comfortably past the 2.4s period
      dx.push(a.shadow!.x - 500);
      dy.push(a.shadow!.y - 500);
    }
    expect(Math.min(...dx)).toBeGreaterThan(2.4); // the trough clears with real margin now...
    expect(Math.min(...dy)).toBeGreaterThan(1.25);
    expect(Math.max(...dx)).toBeGreaterThan(4); // ...and the peak separates clearly
    expect(Math.max(...dy)).toBeGreaterThan(2);
  });

  it('and by visibly more at the top of the bob than the bottom', () => {
    skinRegistryMocks.loaded = { ...loadedOrbCoreRig(), bodyFill: 0.81 };
    const a = new Actor('player', 20, undefined, false, 'char_vanguard');
    a.pushState(0, 0, 0, 0);
    a.snap();
    const offsets: number[] = [];
    const scales: number[] = [];
    for (let i = 0; i < 40; i++) {
      a.interpolate(1, 120);
      offsets.push(a.shadow!.x);
      scales.push(a.shadow!.scale.x);
    }
    // The offset and the size have to disagree across the cycle: rising slides the shadow out
    // AND tightens it. One without the other reads as the shadow pulsing in place.
    expect(Math.max(...offsets) - Math.min(...offsets)).toBeGreaterThan(1);
    expect(Math.max(...scales) - Math.min(...scales)).toBeGreaterThan(0.05);
  });

  it('still keeps a grounded archetype flat on the floor, shadow undisplaced', () => {
    skinRegistryMocks.loaded = undefined;
    const critter = new Actor('enemy', 14, undefined, false, 'critter-core');
    critter.pushState(300, 300, 0, 0);
    critter.snap();
    critter.interpolate(1, 250);
    expect(critter.shadow!.x).toBe(300);
    expect(critter.shadow!.y).toBe(300);
    expect(critter.shadow!.scale.x).toBe(1);
  });

  it('keeps EVERY hovering archetype\'s whole swing inside [6, 10] world px — not just vanguard\'s', () => {
    // The 2026-08-21 retune's actual invariant, swept across the table instead of pinned on
    // one entry: every archetype's `visualZ` trough must clear the "one screen pixel at the
    // game's own zoom floor" line with real margin (>= 6, giving a Y offset >= 1.32 screen px
    // at zoom 1 — see HOVER's doc comment), and every peak must stay at/under the pre-existing
    // ~10 px "hovering, not flying" ceiling — reading `visualZ` directly (before the shadow's
    // own SLANT/squash math) so this is independent of `Entity`'s shadow-offset constants.
    for (const [faction, key] of [
      ['player', 'char_vanguard'],
      ['player', 'char_skirmisher'],
      ['player', 'char_juggernaut'],
      ['enemy', 'floater-core'],
      ['enemy', 'boss-core'],
    ] as const) {
      const a = new Actor(faction, 16, undefined, false, key);
      a.pushState(0, 0, 0, 0);
      a.snap();
      const zs: number[] = [];
      for (let i = 0; i < 60; i++) {
        a.interpolate(1, 100); // 6s, comfortably past every archetype's own period
        zs.push((a as unknown as { visualZ: number }).visualZ);
      }
      expect(Math.min(...zs)).toBeGreaterThanOrEqual(6 - 0.05); // trough — sampling tolerance only
      expect(Math.max(...zs)).toBeLessThanOrEqual(10 + 0.05); // peak
    }
  });
});

describe('Actor.bodySilhouette — what the occlusion x-ray measures a wall against', () => {
  afterEach(() => {
    skinRegistryMocks.loaded = undefined;
  });

  const PLAYER_R = 16; // the shipped player's gameplay radius in world px (fpToPx(PLAYER_BASE.radius))

  it('reports the DRAWN body, not the collision radius', () => {
    // Same distinction the ground shadow already makes (`Skin.bodyDrawnR`): a rig paints as
    // little as 0.68 of its declared radius, and the x-ray's question — does stone land on
    // pixels of the character — is about the silhouette, not about the collision circle.
    skinRegistryMocks.loaded = loadedOrbCoreRig();
    const a = new Actor('player', PLAYER_R, undefined, false, 'char_vanguard');
    expect(a.bodySilhouette.halfW).toBeCloseTo(PLAYER_R * ORB_CORE_BODY_FILL, 5);
    expect(a.bodySilhouette.halfW).toBeLessThan(PLAYER_R);
  });

  it('measures the height off the skin\'s own rest bounds', () => {
    skinRegistryMocks.loaded = loadedOrbCoreRig();
    const a = new Actor('player', PLAYER_R, undefined, false, 'char_vanguard');
    expect(a.bodySilhouette.bodyH).toBeCloseTo(skinViewOf(a).getLocalBounds().height, 5);
  });

  it('lands inside the band occlusion.test.ts asserts its geometry over, rig or placeholder', () => {
    // The seam between the two files. `occlusion.test.ts` proves an interior wall block covers
    // any body between 20 and 48 px tall (and a kerb covers none of them); this is what keeps
    // that band tied to the character actually shipped — if the art grows past it, the geometry
    // claims over there are no longer about this game and this test says so. (The shipped rig
    // measures 32 and the placeholder 39; the faked bundle here binds 1x1 textures, so it comes
    // out at the low end of the band rather than at the real art's value.)
    skinRegistryMocks.loaded = loadedOrbCoreRig();
    const rig = new Actor('player', PLAYER_R, undefined, false, 'char_vanguard');
    skinRegistryMocks.loaded = undefined;
    const placeholder = new Actor('player', PLAYER_R);
    for (const a of [rig, placeholder]) {
      expect(a.bodySilhouette.bodyH).toBeGreaterThanOrEqual(20);
      expect(a.bodySilhouette.bodyH).toBeLessThanOrEqual(48);
      expect(a.bodySilhouette.halfW).toBeLessThanOrEqual(16);
    }
  });
});

// The ICON half of design/13's locked dual-channel element law, on the two places an Actor
// carries an element: its own variant identity (a badge on the health bar) and any lingering
// status it is under (a glyph on that status's aura ring). Before 2026-08-25 both were hue-only
// — three simultaneous statuses were three rings that differed in nothing but colour.
//
// Every glyph assertion here compares against an INDEPENDENTLY DRAWN reference at the exact
// position and radius the aura should have used, rather than counting shapes. The first version
// of this file counted polys and distinct radii, and a mutation battery walked straight through
// it: "every aura draws the same glyph", "the glyph stops scaling with the ring" and "all the
// glyphs stack at one radius" all survived, because the skull's own circles supplied enough
// distinct radii to satisfy the counting version on their own.
describe('Actor — the element icon channel (design/13, 2026-08-25)', () => {
  const SQUASH = SHADOW_SQUASH;
  const GLYPH_ANGLE = (-Math.PI * 3) / 4;
  const GLYPH_R_RATIO = 0.3;
  const GLYPH_R_MIN = 3;
  /** Aura ring radii, in the order `Actor` nests them (burn, chill, poison). */
  const ringRadius = (radiusPx: number, ring: number): number => radiusPx * (1.15 + ring * 0.22);

  type Ins = {
    action: string;
    data: { style?: { color?: number }; path?: { instructions: Array<{ action: string; data: unknown[] }> } };
  };

  function auraGfx(a: Actor): Graphics {
    return a.children[Child.StatusAura] as Graphics;
  }

  /** Digest with `moveTo` dropped — see WeaponCard.test.ts for why that normalisation matters. */
  function digest(g: Graphics): string {
    return (g.context.instructions as unknown as Ins[])
      .map((ins) => {
        const path = (ins.data.path?.instructions ?? [])
          .filter((pi) => pi.action !== 'moveTo')
          .map((pi) => {
            const nums: number[] = [];
            for (const v of pi.data) {
              if (typeof v === 'number') nums.push(v);
              else if (Array.isArray(v)) for (const n of v) if (typeof n === 'number') nums.push(n);
            }
            return `${pi.action}(${nums.map((n) => n.toFixed(2)).join(',')})`;
          })
          .join('|');
        return `${ins.action} ${ins.data.style?.color ?? ''} ${path}`;
      })
      .join(';');
  }

  /** The glyph `Actor` is supposed to have drawn for `element` on ring index `ring`. */
  function expectedGlyph(radiusPx: number, ring: number, element: DamageType, color: number): string {
    const rad = ringRadius(radiusPx, ring);
    const g = new Graphics();
    drawElementGlyph(
      g,
      element,
      Math.cos(GLYPH_ANGLE) * rad,
      Math.sin(GLYPH_ANGLE) * rad * SQUASH,
      Math.max(GLYPH_R_MIN, rad * GLYPH_R_RATIO),
      color,
    );
    return digest(g);
  }

  it('a burning actor draws the FLAME on its ring, at the ring\'s own radius', () => {
    const a = new Actor('enemy', 20);
    a.setStatus({ ...freshStatus(), burnTicks: 5 });
    expect(digest(auraGfx(a))).toContain(expectedGlyph(20, 0, 'fire', THEME.colors.statusBurn));
  });

  it('a chilled actor draws the SNOWFLAKE, not the flame', () => {
    const a = new Actor('enemy', 20);
    a.setStatus({ ...freshStatus(), chillTicks: 5 });
    const d = digest(auraGfx(a));
    expect(d).toContain(expectedGlyph(20, 0, 'ice', THEME.colors.statusChill));
    expect(d).not.toContain(expectedGlyph(20, 0, 'fire', THEME.colors.statusBurn));
  });

  it('a poisoned actor draws the SKULL, not the flame', () => {
    const a = new Actor('enemy', 20);
    a.setStatus({ ...freshStatus(), poison: [{ ticks: 5, dmg: 1 }] as never });
    const d = digest(auraGfx(a));
    expect(d).toContain(expectedGlyph(20, 0, 'poison', THEME.colors.statusPoison));
    expect(d).not.toContain(expectedGlyph(20, 0, 'fire', THEME.colors.statusBurn));
  });

  it('three simultaneous statuses draw three DIFFERENT glyphs, each on its own ring', () => {
    // The point of the second channel. Burn/chill/poison used to differ only in hue, so a
    // colour-blind player (or one looking through a biome's colour cast) read one ring three
    // times. Each glyph is checked at its own ring index, so a version that drew all three at
    // one radius — or drew the same glyph three times — fails.
    const a = new Actor('enemy', 20);
    a.setStatus({
      ...freshStatus(),
      burnTicks: 5,
      chillTicks: 5,
      poison: [{ ticks: 5, dmg: 1 }] as never,
    });
    const d = digest(auraGfx(a));
    expect(d).toContain(expectedGlyph(20, 0, 'fire', THEME.colors.statusBurn));
    expect(d).toContain(expectedGlyph(20, 1, 'ice', THEME.colors.statusChill));
    expect(d).toContain(expectedGlyph(20, 2, 'poison', THEME.colors.statusPoison));
  });

  it('an actor with no status draws no glyph either (the aura stays a real no-op)', () => {
    const a = new Actor('enemy', 20);
    a.setStatus(freshStatus());
    expect(auraGfx(a).context.instructions).toHaveLength(0);
  });

  it('the aura glyph scales with the ring, so a boss carries a bigger one', () => {
    const mob = new Actor('enemy', 12);
    mob.setStatus({ ...freshStatus(), burnTicks: 5 });
    const boss = new Actor('enemy', 40, undefined, true);
    boss.setStatus({ ...freshStatus(), burnTicks: 5 });
    expect(digest(mob.children[Child.StatusAura] as Graphics)).toContain(
      expectedGlyph(12, 0, 'fire', THEME.colors.statusBurn),
    );
    expect(digest(boss.children[Child.StatusAura] as Graphics)).toContain(
      expectedGlyph(40, 0, 'fire', THEME.colors.statusBurn),
    );
    // …and those really are different sizes, so the assertion above is not scale-blind.
    expect(expectedGlyph(40, 0, 'fire', THEME.colors.statusBurn)).not.toBe(
      expectedGlyph(12, 0, 'fire', THEME.colors.statusBurn),
    );
  });

  it('a tiny actor still gets a minimum-size glyph rather than a speck', () => {
    // `AURA_GLYPH_R_MIN`. At radiusPx 4 the ratio alone would give 1.4 px, which is the
    // invisible-at-gameplay-scale failure `art/props/prompts.md` records.
    const tiny = new Actor('enemy', 4);
    tiny.setStatus({ ...freshStatus(), burnTicks: 5 });
    const clamped = expectedGlyph(4, 0, 'fire', THEME.colors.statusBurn);
    expect(digest(tiny.children[Child.StatusAura] as Graphics)).toContain(clamped);
    // The clamp is genuinely engaged at this size, so the assertion covers it rather than
    // riding on the unclamped path.
    expect(ringRadius(4, 0) * GLYPH_R_RATIO).toBeLessThan(GLYPH_R_MIN);
  });

  it('an elemental variant puts a badge on its health bar; a plain mob does not', () => {
    const plain = new Actor('enemy', 15);
    plain.setHealth(5, 10);
    const ember = new Actor('enemy', 15, 0xff7043, false, undefined, 'fire');
    ember.setHealth(5, 10);
    expect(healthBarOf(ember).context.instructions.length).toBeGreaterThan(
      healthBarOf(plain).context.instructions.length,
    );
  });

  it('the bar badge is the variant\'s OWN element, not a fixed one', () => {
    const ember = new Actor('enemy', 15, 0xff7043, false, undefined, 'fire');
    ember.setHealth(5, 10);
    const frost = new Actor('enemy', 15, 0x81d4fa, false, undefined, 'ice');
    frost.setHealth(5, 10);
    expect(digest(healthBarOf(ember))).not.toBe(digest(healthBarOf(frost)));
  });

  it('a player never gets a badge — element is an enemy-variant identity, not a loadout one', () => {
    const me = new Actor('player', 14);
    me.setLocal(true);
    me.setHealth(7, 10);
    const circles = (healthBarOf(me).context.instructions as unknown as Ins[]).reduce(
      (n, ins) => n + (ins.data.path?.instructions ?? []).filter((pi) => pi.action === 'circle').length,
      0,
    );
    expect(circles).toBe(0); // the bar is all roundRects; a circle would be badge geometry
  });
});

/**
 * The low quality tier draws no per-actor shaders (`render/quality.ts`, 2026-08-25). Four
 * render-target passes per actor is the exact cost profile the 2026-08-24 lighting pass was
 * built to remove from the frame — the status shaders are the last way back into it, and a room
 * where eight mobs are burning pays it eight times.
 *
 * The fixture trap this suite has to avoid: asserting only that the filter LIST is empty. That
 * passes with the whole feature deleted on an actor that has no status at all, which is most
 * actors most of the time. Every case below therefore turns an effect ON first, so an ungated
 * build would have something to show.
 */
describe('Actor filters — quality tier gate', () => {
  afterEach(() => resetActiveQuality());

  it('drops the shield shell on the low tier, on an actor that HAS a shield up', () => {
    setActiveQuality('high');
    const a = new Actor('player', 12);
    a.setShield(50, 100);
    expect(skinFiltersOf(a)).toBeTruthy(); // premise: the high tier really does mount it

    setActiveQuality('low');
    const b = new Actor('player', 12);
    b.setShield(50, 100);
    expect(skinFiltersOf(b)).toBeNull();
  });

  it('drops the hit outline and the burn haze on the low tier', () => {
    setActiveQuality('low');
    const a = new Actor('enemy', 12);
    a.onHurt();
    a.setStatus({ ...freshStatus(), burning: 1 } as ReturnType<typeof freshStatus>);
    expect(skinFiltersOf(a)).toBeNull();
  });

  it('keeps the underlying state truthful, so switching back mid-run restores the shell', () => {
    setActiveQuality('low');
    const a = new Actor('player', 12);
    a.setShield(50, 100);
    expect(skinFiltersOf(a)).toBeNull();

    // The gate is at the composition funnel, not at the setters — which is what makes this
    // recoverable. A build that gated `setShield` itself would have discarded the shield ratio
    // and this would come back empty.
    setActiveQuality('high');
    a.refreshQuality();
    expect(skinFiltersOf(a) as unknown[]).toHaveLength(1);
  });

  it('fades a dying actor out on the low tier instead of leaving it standing', () => {
    setActiveQuality('low');
    const a = new Actor('enemy', 12);
    a.onDeath();
    expect(skinFiltersOf(a)).toBeNull(); // no dissolve shader here
    const alphaOf = () => (a as unknown as { skin: { view: { alpha: number } } }).skin.view.alpha;
    expect(alphaOf()).toBe(1);
    a.interpolate(1, 350); // half of the 700ms
    expect(alphaOf()).toBeCloseTo(0.5, 1);
    a.interpolate(1, 400);
    expect(alphaOf()).toBe(0);
    // Same clock as the shader tier: both agree on WHEN the actor is gone.
    expect(a.isDissolved).toBe(true);
  });

  it('leaves the body fully opaque on the high tier, where the shader owns the fade', () => {
    setActiveQuality('high');
    const a = new Actor('enemy', 12);
    a.onDeath();
    a.interpolate(1, 350);
    // The alpha ramp must NOT stack with the dissolve shader — that would dim the body twice.
    expect((a as unknown as { skin: { view: { alpha: number } } }).skin.view.alpha).toBe(1);
    expect(dissolveFilterOf(a)!.progress).toBeCloseTo(0.5, 1);
  });

  it('restores opacity when a mid-dissolve tier flip hands the fade back to the shader', () => {
    setActiveQuality('low');
    const a = new Actor('enemy', 12);
    a.onDeath();
    a.interpolate(1, 350);
    setActiveQuality('high');
    a.refreshQuality();
    expect((a as unknown as { skin: { view: { alpha: number } } }).skin.view.alpha).toBe(1);
  });
});

/**
 * `Actor.onAttack` — the shot reaching the view (2026-08-30). One line of wiring, but it is
 * the ONLY thing standing between the engine's `bullet_fired` event and any firing feedback
 * at all, and it has to survive the placeholder skin every actor renders as until its bundle
 * finishes preloading. `render/rigAttackMotion.test.ts` and `render/RigSkin.test.ts` cover what the
 * recoil then does.
 */
describe('Actor.onAttack — the firing recoil reaches the skin', () => {
  afterEach(() => {
    skinRegistryMocks.loaded = undefined;
  });

  it('forwards the shot to the skin', () => {
    skinRegistryMocks.loaded = loadedOrbCoreRig();
    const a = new Actor('player', 20, undefined, false, 'char_vanguard');
    const fire = vi.spyOn((a as unknown as { skin: { attack: () => void } }).skin, 'attack');
    a.onAttack('ranged');
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it('forwards the KIND and the WEAPON through, not just the fact', () => {
    // One line of wiring, but it is the line the whole unified rule funnels through: the two
    // envelopes are opposite motions (`render/rigAttackMotion.ts`), so a dropped `kind` would
    // make every sword swing shove the character backwards — and since 2026-09-02 a dropped
    // `swing` would silently fall the blade back to the starter saber's sector on every weapon
    // in the game, which is exactly the bug that pass fixed.
    skinRegistryMocks.loaded = loadedOrbCoreRig();
    const a = new Actor('player', 20, undefined, false, 'char_vanguard');
    const attack = vi.spyOn((a as unknown as { skin: { attack: () => void } }).skin, 'attack');
    a.onAttack('melee');
    expect(attack).toHaveBeenCalledWith('melee', undefined);
    const shape = { arcDeg: 220, windowMs: 200, recoveryMs: 667, knockback: 12 }; // the hammer, the roster's heaviest
    a.onAttack('melee', shape);
    expect(attack).toHaveBeenLastCalledWith('melee', shape);
  });

  it('forwards the GUN through as well, not just the blade', () => {
    // The ranged half of the case above, and it needs saying separately because the two travel
    // through the SAME parameter and only one of them was covered: since 2026-09-02 a shot's
    // envelope is sized by the firing weapon too, so a dropped argument here silently gives every
    // gun in the game the starter blaster's kick — which is exactly the state that pass removed,
    // and which looks entirely fine on screen.
    skinRegistryMocks.loaded = loadedOrbCoreRig();
    const a = new Actor('player', 20, undefined, false, 'char_vanguard');
    const attack = vi.spyOn((a as unknown as { skin: { attack: () => void } }).skin, 'attack');
    a.onAttack('ranged');
    expect(attack).toHaveBeenCalledWith('ranged', undefined);
    const shot = { intervalMs: 600, punch: 3 }; // the cannon: slow and hard-hitting
    a.onAttack('ranged', shot);
    expect(attack).toHaveBeenLastCalledWith('ranged', shot);
  });

  it('is safe on a placeholder skin — the first frames of every run render as one', () => {
    const a = new Actor('enemy', 12);
    expect(() => a.onAttack('ranged')).not.toThrow();
    expect(() => a.interpolate(1, 16)).not.toThrow();
  });

  it('settles on its own from the render clock, with no second call from the caller', () => {
    skinRegistryMocks.loaded = loadedOrbCoreRig();
    const a = new Actor('player', 20, undefined, false, 'char_vanguard');
    a.place(0, 0, 0);
    a.onAttack('ranged');
    // 200ms of frames — past RECOIL_MS (150), so the envelope must be fully spent purely
    // because `interpolate` kept handing the skin its frame dt.
    for (let i = 0; i < 12; i++) a.interpolate(1, 17);
    const rig = (a as unknown as { skin: { rig?: { advanceClips(ms: number): void } } }).skin.rig!;
    expect(rig).toBeDefined();
    expect((rig as unknown as { motion: { amount: number } }).motion.amount).toBe(0);
  });
});

/**
 * `Actor.onSpawn` / `onHurt` / `onDeath` — the remaining three engine signals reaching the view
 * (2026-09-02), completing the set `onAttack` opened. Thin wiring again, and again it is the only
 * thing standing between the engine and any feedback at all, so each line is pinned.
 *
 * The interesting content here is not "does it forward" but the two ORDERING facts, both of which
 * are silent when wrong:
 *
 *   - the constructor must finish measuring before a spawn can start (the spawn pose is 20% scale
 *     and alpha 0, and `filterArea`/`bodySilhouette` are measured once, at construction);
 *   - `onDeath` must reach BOTH the clip and the dissolve, because the dissolve owns the clock
 *     that destroys the view and the clip owns what the body does on the way out.
 */
describe('Actor.onSpawn / onHurt / onDeath — the lifecycle signals reach the skin', () => {
  afterEach(() => {
    skinRegistryMocks.loaded = undefined;
  });

  const rigged = (): Actor => {
    skinRegistryMocks.loaded = loadedOrbCoreRig();
    return new Actor('player', 20, undefined, false, 'char_vanguard');
  };
  const skinOf = (a: Actor): { hurt(): void; spawn(): void; die(): void } =>
    (a as unknown as { skin: { hurt(): void; spawn(): void; die(): void } }).skin;

  it('forwards a spawn to the skin', () => {
    const a = rigged();
    const spy = vi.spyOn(skinOf(a), 'spawn');
    a.onSpawn();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('does NOT spawn itself at construction — the rest pose has to be measurable first', () => {
    // The filter area is measured ONCE, in the constructor, off a rest-posed rig: its centre is
    // the assembled silhouette's own centre (`getLocalBounds`), because a rig's decorative bones
    // hang off the body bone's TIP and the whole thing is top-heavy relative to (0,0). Starting
    // the spawn clip before that measurement would centre the shield shell, the hit outline, the
    // dissolve and the health bar on a body at 20% scale — for the whole run, not just for the
    // 350 ms of the clip. `Scene.spawn` is the caller precisely so construction stays a
    // measurement.
    //
    // The bundle needs a REAL spawn clip, and the number read has to be one the clip can move.
    // A first version compared `bodySilhouette` on `loadedOrbCoreRig`, whose fake bundle has no
    // clips at all — so it was vacuous twice over, and a battery mutant that moved
    // `this.skin.spawn()` above the measurement survived it.
    const withSpawn = (): Actor => {
      const loaded = loadedOrbCoreRig();
      loaded.bundle.clips.set('spawn', {
        duration: 0.35,
        loop: false,
        keyframes: [
          { time: 0, bones: new Map([['shell', { scaleX: 0.2, scaleY: 0.2 }]]) },
          { time: 0.35, bones: new Map([['shell', { scaleX: 1, scaleY: 1 }]]) },
        ],
      });
      skinRegistryMocks.loaded = loaded;
      return new Actor('player', 20, undefined, false, 'char_vanguard');
    };
    const areaOf = (a: Actor): { y: number; height: number } => {
      const r = (a as unknown as { skin: { view: { filterArea: { y: number; height: number } } } })
        .skin.view.filterArea;
      return { y: r.y, height: r.height };
    };
    const a = withSpawn();
    const b = withSpawn();
    b.onSpawn();
    b.interpolate(1, 16);
    expect(areaOf(a).height).toBeGreaterThan(0);
    expect(areaOf(b)).toEqual(areaOf(a));
    // ...and the clip really does move what the constructor measured, so the equality above is
    // evidence: mid-spawn the drawn silhouette is a fraction of its rest height.
    const midSpawn = (b as unknown as { skin: { view: { getLocalBounds(): { height: number } } } })
      .skin.view.getLocalBounds().height;
    const atRest = (a as unknown as { skin: { view: { getLocalBounds(): { height: number } } } })
      .skin.view.getLocalBounds().height;
    expect(midSpawn).toBeLessThan(atRest);
  });

  it('a hit drives BOTH halves of one reaction — the shader flash and the rig flinch', () => {
    // Two independent mechanisms behind one signal, which is why `EventReactor` calls one method:
    // splitting them into two host calls would let a future reaction reach only half the target.
    const a = rigged();
    const flinch = vi.spyOn(skinOf(a), 'hurt');
    a.onHurt(3, -4);
    expect(flinch).toHaveBeenCalledTimes(1);
    expect(outlineFilterOf(a)!.alpha).toBe(1); // the shader half, same as the block above
  });

  it('death drives BOTH the collapse clip and the dissolve that ends the view', () => {
    const a = rigged();
    const collapse = vi.spyOn(skinOf(a), 'die');
    a.onDeath();
    expect(collapse).toHaveBeenCalledTimes(1);
    expect(dissolveFilterOf(a)!.progress).toBe(0);
    // ...and the dissolve, not the clip, is still what decides when the view is gone.
    expect(a.isDissolved).toBe(false);
    for (let i = 0; i < 50; i++) a.interpolate(1, 17); // 850 ms — past DISSOLVE_MS (700)
    expect(a.isDissolved).toBe(true);
  });

  it('all three are safe on a placeholder skin, which every actor starts as', () => {
    const a = new Actor('enemy', 12);
    expect(() => { a.onSpawn(); a.onHurt(1, 2); a.onDeath(); }).not.toThrow();
    expect(() => a.interpolate(1, 16)).not.toThrow();
  });

  it('the collapse still plays on the LOW quality tier, where there is no dissolve shader', () => {
    // The tier gate is where a wired feature goes quietly untested (it has happened here before).
    // `activeQuality().actorShaders` is false on low, so `ActorFilters` builds no `DissolveFilter`
    // and fades the body with a plain alpha ramp instead — but the `death` CLIP is not a shader,
    // and a cheap tier is supposed to lose the erosion and keep the animation. Nothing else in
    // this file crosses the two, and the failure would be invisible: on low the body would still
    // fade out on schedule, just without ever collapsing.
    setActiveQuality('low');
    const loaded = loadedOrbCoreRig();
    loaded.bundle.clips.set('death', {
      duration: 0.9,
      loop: false,
      keyframes: [
        { time: 0, bones: new Map([['shell', { translateY: 0, alpha: 1 }]]) },
        { time: 0.9, bones: new Map([['shell', { translateY: 30, alpha: 0 }]]) },
      ],
    });
    skinRegistryMocks.loaded = loaded;
    const a = new Actor('enemy', 20, undefined, false, 'char_vanguard');
    a.place(0, 0, 0);
    a.interpolate(1, 16);
    const shellY = (): number =>
      (a as unknown as { skin: { rig: { sprites: Map<string, { y: number }> } } }).skin.rig.sprites.get('shell')!.y;
    const rest = shellY();

    a.onDeath();
    for (let i = 0; i < 12; i++) a.interpolate(1, 17); // ~200 ms into the collapse

    expect(skinFiltersOf(a), 'the low tier draws no per-actor shader at all').toBeNull();
    expect(shellY(), 'the body sank, i.e. the clip ran without the shader').toBeGreaterThan(rest);
    // ...and the low tier's own stand-in for the shader is still doing its half.
    expect((a as unknown as { skin: { view: { alpha: number } } }).skin.view.alpha).toBeLessThan(1);
  });

  it('the clips advance off the render clock alone, with no second call from the caller', () => {
    // Same property `onAttack` has: `interpolate` hands the skin its frame dt, so a spawn plays
    // out and releases with nothing else driving it. Needs a bundle that actually SHIPS a spawn
    // clip — `loadedOrbCoreRig`'s fake one carries none, which is itself the "silent no-op"
    // case the test above covers.
    const loaded = loadedOrbCoreRig();
    loaded.bundle.clips.set('spawn', {
      duration: 0.35,
      loop: false,
      keyframes: [
        { time: 0, bones: new Map([['shell', { alpha: 0 }]]) },
        { time: 0.35, bones: new Map([['shell', { alpha: 1 }]]) },
      ],
    });
    skinRegistryMocks.loaded = loaded;
    const a = new Actor('player', 20, undefined, false, 'char_vanguard');
    a.place(0, 0, 0);
    a.onSpawn();
    const layers = (a as unknown as { skin: { rig: { layers: { spawning: boolean } } } }).skin.rig.layers;
    expect(layers.spawning).toBe(true);
    for (let i = 0; i < 25; i++) a.interpolate(1, 17); // 425 ms, past the 350 ms clip
    expect(layers.spawning).toBe(false);
  });
});
