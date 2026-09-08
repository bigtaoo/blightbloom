import { describe, it, expect, vi, afterEach } from 'vitest';
import { FxController, type CameraTarget } from './FxController';
import { Layers } from '../scene/layers';
import { Terrain } from '../scene/Terrain';
import { makeLightBuffer } from './lighting';
import { resetActiveQuality, setActiveQuality } from '../../render/quality';
import { Container, type Sprite } from 'pixi.js';
import { tagGroundPiece } from '../scene/groundCulling';
import { resetSlashArcPool, slashArcPoolSize, type SlashArcPose } from './slashArc';

// FxController's filters (fx/filters.ts) build a real WebGL GlProgram at construction
// time — unavailable under plain vitest (no `document`/canvas), and irrelevant to the
// camera-zoom math this file tests. Stubbed the same way RoomBuilder.test.ts stubs
// render/biomeTiles.ts: a controllable, network/GPU-independent replacement.
// `SceneLightFilter`'s stub RECORDS what it is handed, so the tests below can assert the
// region and light set the camera pass uploads without a GPU.
// `attach()` also builds Pixi's own BlurFilter for the fx layer, which compiles a real GL
// program at construction and therefore needs a canvas. Partial-mocked (everything else in
// pixi.js stays real — `Layers` needs the actual Container) so the attach path is testable.
vi.mock('pixi.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('pixi.js')>()),
  BlurFilter: class { strength = 0; quality = 0; },
}));

vi.mock('./filters', () => ({
  VignetteFilter: class { intensity = 0; radius = 0; },
  ChromaticAberrationFilter: class { amount: number; constructor(amount = 0) { this.amount = amount; } },
  MAX_SCENE_LIGHTS: 8,
  SceneLightFilter: class {
    region: number[] = [0, 0, 1, 1];
    lights: { x: number; y: number; radius: number; intensity: number; color: number }[] = [];
    setRegion(x: number, y: number, w: number, h: number) { this.region = [x, y, w, h]; }
    setLights(lights: { x: number; y: number; radius: number; intensity: number; color: number }[], count: number) {
      this.lights = lights.slice(0, count).map((l) => ({ ...l }));
    }
  },
}));

const MAX_SCENE_LIGHTS = 8;

/** The stub filter's recorded state, typed for the assertions below. */
function recorded(fx: FxController) {
  return fx.sceneLight as unknown as {
    region: number[];
    lights: { x: number; y: number; radius: number; intensity: number; color: number }[];
  };
}

// updateCamera's zoom-to-fill (design/10 legibility fix, 2026-08-02; cover-fit follow-up
// 2026-08-12): a room smaller than the viewport is zoomed up so BOTH axes cover it
// (cover-fit — zoom by whichever axis needs the most zoom), capped so a tiny/degenerate
// room doesn't blow sprites up into blocks, and leaves an already-big room (arenas, big
// dungeon rooms) untouched at 1x. No letterbox void on either axis; the axis that didn't
// need the zoom instead overflows the viewport and pans with the player (the existing
// clamp-to-room-bounds branch).
function fakePlayer(x: number, y: number): CameraTarget {
  return { interpGroundX: () => x, interpGroundY: () => y };
}

/** The registry's live set, as `SceneLightFilter` would receive it. */
function activeLights(fx: FxController) {
  const buf = makeLightBuffer(MAX_SCENE_LIGHTS);
  return buf.slice(0, fx.lights.snapshot(buf));
}

describe('FxController.lights (design/01 fidelity roadmap milestone 2)', () => {
  it('registers a transient light from flash(), matching the burst position/colour', () => {
    const layers = new Layers();
    const fx = new FxController(layers);
    fx.flash(100, 200, 0x66e0ff, 20);
    const lit = activeLights(fx);
    expect(lit).toHaveLength(1);
    expect(lit[0]!.color).toBe(0x66e0ff);
    expect([lit[0]!.x, lit[0]!.y]).toEqual([100, 200]);
  });

  it('decays flash()-registered lights via updateFx, same lifetime as the visual burst', () => {
    const layers = new Layers();
    const fx = new FxController(layers);
    fx.flash(0, 0, 0xffffff, 20);
    const full = activeLights(fx)[0]!.intensity;
    fx.updateFx(85, 0, undefined); // half of FX_LIFE_MS (170ms)
    const half = activeLights(fx)[0]!.intensity;
    expect(half).toBeLessThan(full);
    fx.updateFx(86, 0, undefined); // past its lifetime
    expect(activeLights(fx)).toEqual([]);
  });

  it('resetForNewRun clears every light — a fresh run inherits none of the last one\'s glow', () => {
    const layers = new Layers();
    const fx = new FxController(layers);
    fx.lights.addPersistent('local', { x: 0, y: 0, color: 0xffffff, radius: 100, intensity: 1 });
    fx.resetForNewRun();
    expect(activeLights(fx)).toEqual([]);
  });
});

describe('FxController.updateCamera', () => {
  it('is a no-op (leaves layers.world untouched) with no player', () => {
    const layers = new Layers();
    const fx = new FxController(layers);
    fx.updateCamera(1, { vw: 800, vh: 600 }, { w: 400, h: 400 }, null);
    expect(layers.world.scale.x).toBe(1);
    expect(layers.world.x).toBe(0);
    expect(layers.world.y).toBe(0);
  });

  it('zooms a small room up to cover both axes, capped at MAX_ZOOM', () => {
    const layers = new Layers();
    const fx = new FxController(layers);
    // zoomX = 800/100 = 8, zoomY = 600/100 = 6 — cover-fit picks the max (8), past the cap (4.5).
    fx.updateCamera(1, { vw: 800, vh: 600 }, { w: 100, h: 100 }, fakePlayer(50, 50));
    expect(layers.world.scale.x).toBeCloseTo(4.5);
    expect(layers.world.scale.y).toBeCloseTo(4.5);
    expect(fx.zoom).toBeCloseTo(4.5);
  });

  it('zooms by the uncapped cover-fit ratio when under MAX_ZOOM', () => {
    const layers = new Layers();
    const fx = new FxController(layers);
    // zoomX = 800/500 = 1.6, zoomY = 600/500 = 1.2 — cover-fit picks the max (1.6), under the cap.
    fx.updateCamera(1, { vw: 800, vh: 600 }, { w: 500, h: 500 }, fakePlayer(250, 250));
    expect(layers.world.scale.x).toBeCloseTo(1.6);
    expect(fx.zoom).toBeCloseTo(1.6);
  });

  it('never shrinks a room that already covers the viewport (zoom floors at 1)', () => {
    const layers = new Layers();
    const fx = new FxController(layers);
    // zoomX = 800/2000 = 0.4, zoomY = 600/2000 = 0.3 — both under 1, floored to 1.
    fx.updateCamera(1, { vw: 800, vh: 600 }, { w: 2000, h: 2000 }, fakePlayer(1000, 1000));
    expect(layers.world.scale.x).toBe(1);
    expect(fx.zoom).toBe(1);
  });

  it('exposes the same zoom on `fx.zoom` that it applies to layers.world.scale', () => {
    const layers = new Layers();
    const fx = new FxController(layers);
    fx.updateCamera(1, { vw: 800, vh: 600 }, { w: 500, h: 500 }, fakePlayer(250, 250));
    expect(fx.zoom).toBe(layers.world.scale.x);
  });

  it('fills the axis that needs more zoom exactly, panning the other axis with the player (cover-fit, no void)', () => {
    const layers = new Layers();
    const fx = new FxController(layers);
    // A square room in a wider-than-tall viewport: cover-fit picks the axis that needs
    // MORE zoom (horizontal, 800/400=2 vs vertical 400/400=1), so the effective width
    // exactly fills vw (no horizontal void) while the effective height now overflows
    // vh and the clamp-to-room-bounds branch pans it toward the player instead.
    fx.updateCamera(1, { vw: 800, vh: 400 }, { w: 400, h: 400 }, fakePlayer(200, 200));
    expect(layers.world.scale.x).toBeCloseTo(2);
    expect(layers.world.x).toBeCloseTo(0); // effW === vw exactly at this zoom — no horizontal void
    // effH (800) > vh (400) — panned toward the player, clamped to [-400, 0]. The look-at
    // point is CAMERA_BODY_BIAS_R (8% of vh = 32 screen px, 16 world px at this zoom)
    // above the player's ground point, so the world sits 32px lower than a feet-centred
    // camera's -200 would put it.
    expect(layers.world.y).toBeCloseTo(-168);
  });

  it('centres the character rather than its feet — the look-at point is biased above the ground position', () => {
    const layers = new Layers();
    const fx = new FxController(layers);
    // Same setup on both axes so the vertical bias is the ONLY asymmetry: a world twice
    // the viewport on each axis, player dead centre, so neither clamp bound is hit.
    fx.updateCamera(1, { vw: 800, vh: 600 }, { w: 1600, h: 1200 }, fakePlayer(800, 600));
    expect(fx.zoom).toBe(1);
    expect(layers.world.x).toBeCloseTo(-400); // 800/2 - 800 — exactly centred horizontally
    // 600/2 - (600 - 600*0.08) = 300 - 552. The +48 vs a feet-centred -300 is the bias:
    // the rendered world moves DOWN the screen, which lifts the character off the
    // bottom-heavy framing a feet-centred camera gives it.
    expect(layers.world.y).toBeCloseTo(-252);
  });

  it('fits the FRAME rect (the current room) when given one, not the whole floor', () => {
    const layers = new Layers();
    const fx = new FxController(layers);
    // The floor is 4000x3000 — far bigger than the viewport, so fitting IT floors the
    // zoom at 1 and the player sees several rooms at once. The room they're standing in
    // is 400x400: cover-fit on that picks 800/400 = 2.
    const world = { w: 4000, h: 3000 };
    const player = fakePlayer(2000, 1500);
    fx.updateCamera(1, { vw: 800, vh: 600 }, world, player);
    expect(fx.zoom).toBe(1); // no frame: the old whole-floor behaviour, unchanged

    fx.updateCamera(1, { vw: 800, vh: 600 }, world, player, { x: 1800, y: 1300, w: 400, h: 400 });
    expect(fx.zoom).toBeCloseTo(2);
  });

  it("lets the frame pull the camera ABOVE world y=0, so a north wall's top stays on screen", () => {
    // 2026-08-19. `GameLoop.cameraFrame` extends its rect upward by MAX_WALL_HEIGHT because a
    // standing wall draws its cap and the top of its face at NEGATIVE world y — but `cy`'s upper
    // clamp bound was a flat 0, the world's own top edge, which pinned exactly that band off the
    // top of the screen and silently cancelled the whole extension. Confirmed live before the
    // fix: `layers.world.y === 0` with the room's north wall showing face only, no cap.
    const layers = new Layers();
    const fx = new FxController(layers);
    // A player standing at the north edge of a north-boundary room: without the overscan the
    // clamp pins y at 0.
    fx.updateCamera(
      1,
      { vw: 800, vh: 600 },
      { w: 2000, h: 2000 },
      fakePlayer(1000, 20),
      { x: 800, y: -104, w: 400, h: 504 },
    );
    expect(layers.world.y).toBeGreaterThan(0);
    expect(layers.world.y).toBeCloseTo(104 * fx.zoom); // exactly the overscan the frame asked for
  });

  it('grants no overscan at all when the frame asks for none, or when there is no frame', () => {
    // The floor's own interior rooms have frame.y >= 0, and a mode with no room model passes
    // null — neither may start revealing the void above the world.
    const layers = new Layers();
    const fx = new FxController(layers);
    fx.updateCamera(1, { vw: 800, vh: 600 }, { w: 2000, h: 2000 }, fakePlayer(1000, 20), { x: 800, y: 400, w: 400, h: 400 });
    expect(layers.world.y).toBe(0);
    fx.updateCamera(1, { vw: 800, vh: 600 }, { w: 2000, h: 2000 }, fakePlayer(1000, 20));
    expect(layers.world.y).toBe(0);
  });

  it('still clamps panning to the WORLD, not to the frame — a doorway must not hard-stop the camera', () => {
    const layers = new Layers();
    const fx = new FxController(layers);
    // Player at the far-east edge of a small room at the far-east edge of the floor. The
    // clamp bound has to come from the floor's own width (2000*2 = 4000 effective, so
    // x floors at 800-4000 = -3200), not from the room's.
    fx.updateCamera(
      1,
      { vw: 800, vh: 600 },
      { w: 2000, h: 2000 },
      fakePlayer(1990, 1000),
      { x: 1600, y: 800, w: 400, h: 400 },
    );
    expect(fx.zoom).toBeCloseTo(2);
    expect(layers.world.x).toBeCloseTo(-3200); // hit the WORLD's east bound, not the room's
  });
});

// 2026-08-24: lighting moved off the individual actors onto one screen-space pass over
// `Layers.lit`. The pass shades by WORLD position, so the camera rect it is handed has to be
// the inverse of the camera transform that same frame — get this wrong and every light sits
// somewhere other than where its source is, in a way no unit test of the shader could catch.
describe('FxController scene-light sync', () => {
  it('mounts the one lighting pass on the lit layer, with a filterArea (never bare bounds)', () => {
    // The filter opts out of Pixi's viewport clip, so with no filterArea its region would be
    // the whole dungeon floor's bounds — a texture allocation the size of the level.
    const layers = new Layers();
    const fx = new FxController(layers);
    fx.attach();
    expect(layers.lit.filters).toEqual([fx.sceneLight]);
    expect(layers.lit.filterArea).not.toBeNull();
  });

  it('leaves terrain, fx and hud out of the pass — three different reasons, one exclusion', () => {
    // `fx` — a muzzle flash IS light, shading it would dim the thing casting the light.
    // `hud` — a floating health bar is a readout riding in world space, not a surface.
    // `terrain` (2026-08-28) — the void's far side. It is excluded because the light pass is
    //   precisely what was darkening everything beyond the player's room to near-black, which is
    //   the reading the far side exists to fix; shade it and the feature undoes itself.
    // Terrain paints FIRST among world's children, so floor and stone cover it and what shows
    // through is exactly the void.
    const layers = new Layers();
    new FxController(layers).attach();
    expect(layers.lit.children).toEqual([layers.ground, layers.shadow, layers.entities]);
    expect(layers.world.children).toEqual([layers.terrain, layers.lit, layers.fx, layers.hud]);
  });

  it('hands the pass the world rect the camera is actually showing', () => {
    const layers = new Layers();
    const fx = new FxController(layers);
    fx.attach();
    // World twice the viewport on each axis, player dead centre: zoom 1, world at (-400,-300)
    // with the 8%-of-vh body bias, so the visible world rect starts at (400, 348).
    fx.updateCamera(1, { vw: 800, vh: 600 }, { w: 1600, h: 1200 }, fakePlayer(800, 600));
    const [x, y, w, h] = recorded(fx).region;
    expect(w).toBeCloseTo(800);
    expect(h).toBeCloseTo(600);
    expect(x).toBeCloseTo(-layers.world.x / layers.world.scale.x);
    expect(y).toBeCloseTo(-layers.world.y / layers.world.scale.x);
  });

  it('divides the viewport by the zoom — a zoomed-in camera shows LESS world, not more', () => {
    // The region is in world px, so it must shrink as the camera zooms in. Multiplying
    // instead of dividing would look identical at zoom 1 and be wrong at every other zoom,
    // which is exactly the class of bug the shipped camera (zoom 4 in a real room) hits.
    const layers = new Layers();
    const fx = new FxController(layers);
    fx.attach();
    fx.updateCamera(1, { vw: 800, vh: 600 }, { w: 2000, h: 2000 }, fakePlayer(1000, 1000), { x: 800, y: 800, w: 400, h: 400 });
    expect(fx.zoom).toBeCloseTo(2);
    const [, , w, h] = recorded(fx).region;
    expect(w).toBeCloseTo(400);
    expect(h).toBeCloseTo(300);
  });

  it('keeps the filterArea and the shader region describing the same rectangle', () => {
    // These two are set from one computation on purpose: Pixi sizes the render target from
    // `filterArea` while the shader maps texels through `uRegion`. Any drift between them
    // slides the whole lighting relative to the scene.
    const layers = new Layers();
    const fx = new FxController(layers);
    fx.attach();
    fx.updateCamera(1, { vw: 800, vh: 600 }, { w: 2000, h: 2000 }, fakePlayer(1000, 1000), { x: 800, y: 800, w: 400, h: 400 });
    const area = layers.lit.filterArea!;
    expect(recorded(fx).region).toEqual([area.x, area.y, area.width, area.height]);
  });

  it('re-syncs even with no player, so an expiring light still leaves the pass', () => {
    const layers = new Layers();
    const fx = new FxController(layers);
    fx.attach();
    fx.flash(10, 20, 0xff0000, 5);
    fx.updateCamera(1, { vw: 800, vh: 600 }, { w: 400, h: 400 }, null);
    expect(recorded(fx).lights).toHaveLength(1);
    fx.updateFx(1000, 0, undefined); // well past FX_LIFE_MS
    fx.updateCamera(1, { vw: 800, vh: 600 }, { w: 400, h: 400 }, null);
    expect(recorded(fx).lights).toEqual([]);
  });

  it('uploads lights in world coordinates, untouched by the camera', () => {
    // The shader converts texel -> world, not light -> screen. A light pre-multiplied by the
    // camera here would be double-transformed.
    const layers = new Layers();
    const fx = new FxController(layers);
    fx.attach();
    fx.lights.addPersistent('local', { x: 1234, y: 567, color: 0xfff4d6, radius: 140, intensity: 0.35 });
    fx.updateCamera(1, { vw: 800, vh: 600 }, { w: 2000, h: 2000 }, fakePlayer(1000, 1000), { x: 800, y: 800, w: 400, h: 400 });
    expect(recorded(fx).lights[0]).toMatchObject({ x: 1234, y: 567, radius: 140, intensity: 0.35 });
  });
});

/**
 * The quality lever (`render/quality.ts`, 2026-08-25) — does turning it actually unmount the
 * full-viewport passes?
 *
 * These assert the OUTPUT: what is on `layers.*.filters` after `applyQuality()`, which is the
 * only thing the renderer reads. A test that spied on `applyQuality` being CALLED would pass
 * with every filter still mounted, and that is precisely the bug this lever exists to prevent
 * — a knob wired to nothing looks identical to a knob wired to everything until a device
 * measures it.
 */
describe('FxController quality tiers', () => {
  afterEach(() => resetActiveQuality());

  /** Filters actually mounted on each of the three filtered layers. */
  function mounted(layers: Layers) {
    return {
      world: (layers.world.filters ?? []) as unknown[],
      fx: (layers.fx.filters ?? []) as unknown[],
      lit: (layers.lit.filters ?? []) as unknown[],
    };
  }

  it('mounts all three full-viewport passes on the high tier', () => {
    setActiveQuality('high');
    const layers = new Layers();
    const fx = new FxController(layers);
    fx.attach();
    const m = mounted(layers);
    expect(m.world).toEqual([fx.vignette, fx.chromatic]);
    expect(m.fx).toHaveLength(1); // the bloom blur
    expect(m.lit).toEqual([fx.sceneLight]);
  });

  it('mounts ONLY the lighting pass on the medium tier — the rung is the pass count', () => {
    // The whole value of the middle rung (2026-09-08, the phone/iPad battery pass): a frame goes
    // from four render-target passes to one, measured live as 11 framebuffer binds -> 3, while
    // keeping the pass that carries the game's look. Asserted here as the mounted filters
    // because that IS the pass count — each of these is one full-viewport target switch.
    setActiveQuality('medium');
    const layers = new Layers();
    const fx = new FxController(layers);
    fx.attach();
    const m = mounted(layers);
    expect(m.lit).toEqual([fx.sceneLight]);
    expect(m.world).toEqual([]);
    expect(m.fx).toEqual([]);
  });

  it('mounts none of them on the low tier', () => {
    setActiveQuality('low');
    const layers = new Layers();
    const fx = new FxController(layers);
    fx.attach();
    const m = mounted(layers);
    expect(m.world).toEqual([]);
    expect(m.fx).toEqual([]);
    expect(m.lit).toEqual([]);
  });

  it('keeps `lit`\'s filterArea across a tier change, so re-mounting needs no second call', () => {
    setActiveQuality('low');
    const layers = new Layers();
    const fx = new FxController(layers);
    fx.attach();
    // The area is a property of the LAYER, not of the pass: without it the region would be the
    // whole dungeon floor's bounds the instant the filter came back.
    expect(layers.lit.filterArea).not.toBeNull();
    const area = layers.lit.filterArea;
    setActiveQuality('high');
    fx.applyQuality();
    expect(layers.lit.filterArea).toBe(area);
    expect(layers.lit.filters).toEqual([fx.sceneLight]);
  });

  it('flips back and forth without rebuilding the filters', () => {
    setActiveQuality('high');
    const layers = new Layers();
    const fx = new FxController(layers);
    fx.attach();
    const firstBloom = (layers.fx.filters as unknown[])[0];
    setActiveQuality('low');
    fx.applyQuality();
    setActiveQuality('high');
    fx.applyQuality();
    // Same instance, not a fresh one — a rebuilt filter is a fresh GL program upload, and on the
    // device this is aimed at, a settings tap must not cost that.
    expect((layers.fx.filters as unknown[])[0]).toBe(firstBloom);
  });

  it('stops feeding the lighting pass its per-frame region while it is unmounted', () => {
    setActiveQuality('low');
    const layers = new Layers();
    const fx = new FxController(layers);
    fx.attach();
    fx.updateCamera(1, { vw: 800, vh: 600 }, { w: 800, h: 600 }, fakePlayer(400, 300));
    // The stub records what it was handed; the placeholder region it was constructed with is
    // what should still be there. (Asserting the CAMERA still works is the control: the pass
    // being off must not stop the world transform from being computed.)
    expect(recorded(fx).region).toEqual([0, 0, 1, 1]);
    expect(layers.world.scale.x).toBeGreaterThan(0);
  });

  it('still culls the ground on the low tier — the pass is off, the floor still has to be', () => {
    // The defect this exists for: `syncCamera` computing the camera rect, then returning early on
    // the low tier BEFORE running the cull. That is what this method used to do, back when the rect
    // existed only to feed the light shader, and a 2026-08-27 battery found that moving the cull
    // back below that guard survives all 3,309 client tests — the code comment records the fix and
    // nothing read it.
    //
    // It fails exactly where it hurts most. The low tier is the DEVICE tier: a phone that drops to
    // it would keep every one of `arena_launch`'s 374 floor pieces resident, so the machine that
    // most needs the cull is the only one that would not get it.
    setActiveQuality('low');
    const layers = new Layers();
    const fx = new FxController(layers);
    fx.attach();
    // Deliberately not near-miss geometry — `updateCamera`'s zoom is not what is under test here.
    // One piece that overlaps any camera near the origin, one that no camera on this map reaches.
    const near = new Container();
    const far = new Container();
    tagGroundPiece(near, { x: -10_000, y: -10_000, w: 20_000, h: 20_000 });
    tagGroundPiece(far, { x: 1_000_000, y: 1_000_000, w: 40, h: 40 });
    layers.ground.addChild(near, far);

    fx.updateCamera(1, { vw: 800, vh: 600 }, { w: 800, h: 600 }, fakePlayer(400, 300));

    expect(far.culled).toBe(true);
    expect(near.culled).toBe(false);
    expect(fx.visibleGroundPieces).toBe(1);
    // Control: this really is the tier whose early return the test is about. If the pass were
    // mounted, the assertions above would hold on the path that was never in doubt.
    expect(recorded(fx).region).toEqual([0, 0, 1, 1]);
  });

  it('fits the terrain to the CAMERA WORLD RECT, not to the viewport', () => {
    // The low-tier test below proves `fitTerrain` RAN; it cannot tell which rectangle it was
    // handed, because any non-degenerate one leaves the plane wider than 1px. Handing it the raw
    // viewport instead of the inverse-camera rect is the plausible mistake — identical at zoom 1
    // and wrong at every other zoom, which is the same shape as the bug the scene-light region
    // already has a test for. At zoom != 1 the two answers differ by the zoom factor.
    const layers = new Layers();
    const fx = new FxController(layers);
    fx.attach();
    new Terrain(layers);

    // A framed room half the viewport's size, so cover-fit zooms to 2. Without the frame the
    // zoom lands on exactly 1, the viewport and the world rect coincide, and the test proves
    // nothing — which is what the control at the bottom caught on the first run.
    fx.updateCamera(1, { vw: 800, vh: 600 }, { w: 1600, h: 1200 }, fakePlayer(800, 600), {
      x: 600,
      y: 450,
      w: 400,
      h: 300,
    });

    const zoom = layers.world.scale.x;
    const plane = layers.terrain.children[0] as Sprite;
    expect(plane.x).toBeCloseTo(-layers.world.x / zoom, 6);
    expect(plane.y).toBeCloseTo(-layers.world.y / zoom, 6);
    expect(plane.width).toBeCloseTo(800 / zoom, 6);
    expect(plane.height).toBeCloseTo(600 / zoom, 6);
    // Control: a zoom of exactly 1 would make the viewport and the world rect the same size and
    // this test vacuous. Assert the case is real.
    expect(zoom).not.toBeCloseTo(1, 6);
  });

  it('still fits the TERRAIN on the low tier — the void must have a far side there too', () => {
    // Same guard, same reason, different casualty. `fitTerrain` sits above the
    // `activeQuality().sceneLight` early return in `syncCamera`; move it below and the terrain
    // plane keeps the 1x1 size it was constructed at, so the void's far side is a single pixel in
    // the corner and everything else is backdrop again — on the LOW tier, which is the device
    // tier, i.e. the one machine class where the black-hole reading was reported in the first
    // place. Nothing else in the render path reads the plane's size, so no other assertion in the
    // suite would notice.
    setActiveQuality('low');
    const layers = new Layers();
    const fx = new FxController(layers);
    fx.attach();
    new Terrain(layers);

    fx.updateCamera(1, { vw: 800, vh: 600 }, { w: 4000, h: 4000 }, fakePlayer(400, 300));

    for (const child of layers.terrain.children) {
      expect((child as Sprite).width).toBeGreaterThan(1);
      expect((child as Sprite).height).toBeGreaterThan(1);
    }
    // Control: this is the tier whose early return the test is about — if the pass were mounted,
    // the assertions above would be running on the path that was never in doubt.
    expect(recorded(fx).region).toEqual([0, 0, 1, 1]);
  });

  it('resumes feeding it the moment the tier comes back', () => {
    setActiveQuality('low');
    const layers = new Layers();
    const fx = new FxController(layers);
    fx.attach();
    fx.updateCamera(1, { vw: 800, vh: 600 }, { w: 800, h: 600 }, fakePlayer(400, 300));
    setActiveQuality('high');
    fx.applyQuality();
    fx.updateCamera(1, { vw: 800, vh: 600 }, { w: 800, h: 600 }, fakePlayer(400, 300));
    expect(recorded(fx).region).not.toEqual([0, 0, 1, 1]);
  });

  it('thins particles rather than silencing them', () => {
    setActiveQuality('low');
    const layers = new Layers();
    const fx = new FxController(layers);
    fx.attach();
    fx.particles.muzzleFlame(0, 0, 0, 0xffffff);
    // Fewer than the authored three, but never zero — a muzzle flash carries the information
    // that someone fired.
    const count = fx.particles.view.children.length;
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(3);
  });
});

describe('FxController.updateFx — the particle system is actually advanced', () => {
  // Nothing in this file asserted that `updateFx` steps `this.particles` at all, and a 2026-08-26
  // battery confirmed the gap: `this.particles.update(0 * dt, …)` survived the whole suite. Every
  // burst this controller owns would spawn and then hang in mid-air forever — the muzzle flames,
  // the casings, the death debris, and the shield shards `shield_break` throws.
  it('moves live particles and retires them on schedule', () => {
    const fx = new FxController(new Layers());
    fx.particles.shieldShards(0, 0, 0x66e0ff);
    const spawned = fx.particles.view.children.length;
    expect(spawned).toBeGreaterThan(0);
    const first = fx.particles.view.children[0]!;
    const at = { x: first.x, y: first.y };

    fx.updateFx(16, 0, undefined);
    expect(Math.hypot(first.x - at.x, first.y - at.y)).toBeGreaterThan(0); // it moved

    // ...and the same clock retires them, so a burst is a burst and not a permanent decal.
    fx.updateFx(400, 0, undefined);
    expect(fx.particles.view.children.length).toBe(0);
  });
});

/**
 * `muzzleFlare` (2026-08-30, user report *"枪口也没有射击特效"*) — the directional flash that
 * replaced a radial `flash()` at this event. The three properties that made the old one read
 * as absent are the three asserted here: it must land exactly where it is told (no hidden 12 px
 * lift, since `EventReactor` now hands it the drawn barrel tip), it must POINT, and it must be
 * gone before the next shot of a fast weapon — the starter blaster fires every 200 ms.
 */
describe('FxController.muzzleFlare', () => {
  const flares = (fx: FxController) => (fx as unknown as {
    layers: { fx: { children: { x: number; y: number; rotation: number; alpha: number; scale: { x: number } }[] } };
  }).layers.fx.children.filter((c) => '_life' in c);

  it('draws at exactly the point it is given — no hidden lift', () => {
    const fx = new FxController(new Layers());
    fx.muzzleFlare(140, 150, 0, 0xffe08a);
    const g = flares(fx)[0]!;
    expect([g.x, g.y]).toEqual([140, 150]);
  });

  it('points along the shot', () => {
    const fx = new FxController(new Layers());
    fx.muzzleFlare(0, 0, Math.PI / 2, 0xffe08a);
    expect(flares(fx)[0]!.rotation).toBeCloseTo(Math.PI / 2, 10);
  });

  it('lights the room for as long as it is on screen, then stops', () => {
    const fx = new FxController(new Layers());
    fx.muzzleFlare(140, 150, 0, 0xffe08a);
    const lit = activeLights(fx);
    expect(lit).toHaveLength(1);
    expect([lit[0]!.x, lit[0]!.y]).toEqual([140, 150]);
    expect(lit[0]!.color).toBe(0xffe08a);
    fx.updateFx(86, 0, undefined); // past MUZZLE_FLARE_MS (85)
    expect(activeLights(fx)).toEqual([]);
  });

  it('is gone well before a 200ms-cooldown weapon fires again', () => {
    const fx = new FxController(new Layers());
    fx.muzzleFlare(0, 0, 0, 0xffe08a);
    fx.updateFx(100, 0, undefined);
    expect(flares(fx)).toHaveLength(0);
  });

  it('COLLAPSES as it fades, where a flash expands', () => {
    // The whole difference between "a gun fired" and "something is glowing near the body".
    // `_grow` is negative here and positive for `flash()`, and this is what pins that apart.
    const fx = new FxController(new Layers());
    fx.muzzleFlare(0, 0, 0, 0xffe08a);
    fx.updateFx(42, 0, undefined); // ~half its life
    const flare = flares(fx)[0]!;
    expect(flare.scale.x).toBeLessThan(1);
    expect(flare.alpha).toBeLessThan(1);

    const other = new FxController(new Layers());
    other.flash(0, 0, 0xffe08a, 12);
    other.updateFx(42, 0, undefined);
    expect(flares(other)[0]!.scale.x).toBeGreaterThan(1);
  });

  // `flash()` and `trailDot()` predate the per-child lifetime and must keep FX_LIFE_MS. Both
  // are checked, not just the one this event used to call: `_lifeMax`/`_grow` are read off EVERY
  // child in `updateFx`, so a wrong default silently retimes the bullet trails too.
  it.each([
    ['flash', (fx: FxController) => fx.flash(0, 0, 0xffe08a, 12)],
    ['trailDot', (fx: FxController) => fx.trailDot(0, 0, 0xffe08a, 3)],
  ])('does not change how a %s fades — 170ms, still expanding', (_label, spawn) => {
    const fx = new FxController(new Layers());
    spawn(fx);
    fx.updateFx(100, 0, undefined); // past a flare's 85ms, well inside the old 170ms
    expect(flares(fx)).toHaveLength(1);
    expect(flares(fx)[0]!.scale.x).toBeGreaterThan(1); // grows, the opposite of the flare
    fx.updateFx(80, 0, undefined);
    expect(flares(fx)).toHaveLength(0);
  });
});

/**
 * The melee sector arc's LIFECYCLE (2026-09-02). The arc's own geometry is pinned in
 * `slashArc.test.ts`; what this block owns is the part that lives on `FxController` — an fx that
 * deliberately opts out of the `_life` machinery every other fx here rides on, and therefore has
 * to be stepped, removed and pooled by hand.
 */
describe('FxController.slashArc', () => {
  const POSE: SlashArcPose = {
    x: 40, y: 60, facingRad: 0, arcHalfRad: 1, innerPx: 16, outerPx: 46,
    color: 0x90cdf4, flipX: 1, delayMs: 78, sweepMs: 65, fadeMs: 130,
  };

  it('mounts the arc on the additive fx layer and lights the room for its whole length', () => {
    const layers = new Layers();
    const fx = new FxController(layers);
    fx.slashArc(POSE);
    expect(layers.fx.children).toHaveLength(1);
    const lit = activeLights(fx);
    expect(lit).toHaveLength(1);
    expect([lit[0]!.x, lit[0]!.y]).toEqual([POSE.x, POSE.y]);
    expect(lit[0]!.color).toBe(POSE.color);
  });

  it('steps the sweep from updateFx, then removes the arc once it has faded', () => {
    // The failure this catches is a leak, and a silent one: an arc that is never stepped stays
    // parented forever at full alpha — a permanent glowing wedge stuck to the floor.
    const layers = new Layers();
    const fx = new FxController(layers);
    fx.slashArc(POSE);
    const arc = layers.fx.children[0]!;
    fx.updateFx(POSE.delayMs + POSE.sweepMs, 0, undefined);
    expect(arc.parent).toBe(layers.fx);
    expect(arc.visible).toBe(true);
    fx.updateFx(POSE.fadeMs, 0, undefined);
    expect(layers.fx.children).toHaveLength(0);
  });

  it('does not touch the arc alpha or scale the way the `_life` loop would', () => {
    // `_life`-tagged children get `alpha = life/max` and `scale = 1 + (1-alpha) * _grow` each
    // frame. Applied to a sector that would GROW the arc past the reach it exists to state, so
    // the arc must not be tagged — asserted through the visible consequence rather than by
    // reaching for the private tag.
    const layers = new Layers();
    const fx = new FxController(layers);
    fx.slashArc(POSE);
    const arc = layers.fx.children[0]!;
    fx.updateFx(POSE.delayMs + POSE.sweepMs * 0.5, 0, undefined);
    expect(arc.scale.x).toBe(1);
    expect(arc.alpha).toBe(1);
  });

  it('recycles a finished arc rather than allocating a fresh set of buffers per swing', () => {
    const layers = new Layers();
    const fx = new FxController(layers);
    resetSlashArcPool();
    fx.slashArc(POSE);
    fx.updateFx(POSE.delayMs + POSE.sweepMs + POSE.fadeMs, 0, undefined);
    expect(slashArcPoolSize()).toBe(1);
    fx.slashArc(POSE);
    expect(slashArcPoolSize()).toBe(0);
    expect(layers.fx.children).toHaveLength(1);
  });

  it('drops an in-flight arc on a run boundary', () => {
    // A `_life` glow is small and gone in 170 ms so those are left to expire; an arc is the size
    // of a weapon's whole reach, and one hanging over the first frames of the next run reads as
    // that run's own swing.
    const layers = new Layers();
    const fx = new FxController(layers);
    fx.slashArc(POSE);
    fx.updateFx(POSE.delayMs + 10, 0, undefined);
    fx.resetForNewRun();
    expect(layers.fx.children).toHaveLength(0);
    // ...and the next run's own arcs still work, i.e. the list was cleared, not corrupted.
    fx.slashArc(POSE);
    fx.updateFx(POSE.delayMs + POSE.sweepMs, 0, undefined);
    expect(layers.fx.children).toHaveLength(1);
  });

  it('steps several concurrent arcs independently — two players can swing on one tick', () => {
    const layers = new Layers();
    const fx = new FxController(layers);
    fx.slashArc(POSE);
    fx.slashArc({ ...POSE, delayMs: POSE.delayMs * 3 }); // a slower weapon, still winding up
    fx.updateFx(POSE.delayMs + POSE.sweepMs + POSE.fadeMs, 0, undefined);
    // The first is spent and gone; the second is only now mid-sweep. Reaping backwards is what
    // makes this work — a forward splice would skip the element after each removal.
    expect(layers.fx.children).toHaveLength(1);
    expect(layers.fx.children[0]!.visible).toBe(true);
  });
});

/**
 * `worldView` (2026-09-03b) — this frame's visible world rect, exposed so the scene layer can cull
 * against what is actually on screen (`RoomBuilder.tickFixtures`, whose doors each cost a per-frame
 * redraw). It is the same rect the lighting pass is handed, and it has to stay that way: they
 * describe one thing, and a second derivation of it is a second thing to get wrong.
 */
describe('FxController.worldView', () => {
  it('is the rect the camera is actually showing, and the SAME one the light pass is given', () => {
    const layers = new Layers();
    const fx = new FxController(layers);
    fx.attach();
    fx.updateCamera(1, { vw: 800, vh: 600 }, { w: 1600, h: 1200 }, fakePlayer(800, 600));

    const [x, y, w, h] = recorded(fx).region;
    expect([fx.worldView.x, fx.worldView.y, fx.worldView.width, fx.worldView.height]).toEqual([x, y, w, h]);
  });

  it('tracks the camera rather than reporting one frame forever', () => {
    // The failure this catches is total and silent: a `worldView` frozen at its placeholder culls
    // every door in the level out of its own animation the moment the camera leaves the origin.
    const layers = new Layers();
    const fx = new FxController(layers);
    fx.attach();
    fx.updateCamera(1, { vw: 800, vh: 600 }, { w: 4000, h: 4000 }, fakePlayer(400, 400));
    const first = { x: fx.worldView.x, y: fx.worldView.y };
    fx.updateCamera(1, { vw: 800, vh: 600 }, { w: 4000, h: 4000 }, fakePlayer(3000, 3000));

    expect(fx.worldView.x).not.toBe(first.x);
    expect(fx.worldView.y).not.toBe(first.y);
  });

  it('is live on the LOW tier too, where the light pass that also reads it is unmounted', () => {
    // Same shape as the 2026-08-27 battery survivor this file already guards for the ground cull:
    // the low tier is the DEVICE tier, so a `worldView` that only updated while the lighting pass
    // was mounted would leave the cheapest machines animating every door in the floor.
    const layers = new Layers();
    const fx = new FxController(layers);
    setActiveQuality('low');
    try {
      fx.attach();
      fx.updateCamera(1, { vw: 800, vh: 600 }, { w: 4000, h: 4000 }, fakePlayer(3000, 3000));
      expect(fx.worldView.width).toBe(800);
      expect(fx.worldView.x).toBeGreaterThan(0);
    } finally {
      resetActiveQuality();
    }
  });
});
