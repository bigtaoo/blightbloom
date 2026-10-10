/**
 * Building a room on a WeChat-SHAPED runtime — the regression net for the 2026-08-25 crash
 * where entering any map threw out of `RoomBuilder.build`:
 *
 *     Error: Could not find a source type for resource: [object HTMLCanvasElement]
 *         at ... a3.build ... v3.onRoomEnter
 *
 * The cause was `capLight.bakeLitCap` reaching for browser DOM directly: `document.createElement`
 * for the bake canvas and `Texture.from(canvas)` for the result. `Texture.from` identifies a canvas
 * by `resource instanceof HTMLCanvasElement || resource instanceof OffscreenCanvas`, and the
 * mini-game runtime defines NEITHER global — so the canvas matched no source class and Pixi threw,
 * taking the whole room build with it. Every other room test in this directory runs in an
 * environment that has no canvas at all, which takes `bakeLitCap`'s early-out and therefore could
 * not see this: the bug needed a runtime where a canvas EXISTS but is not a DOM one.
 *
 * So this file models exactly that, in the same spirit as `render/wechatAssetLoad.test.ts`: strip
 * the browser globals a mini-game does not have, install a WeChat-shaped `DOMAdapter` whose
 * `createCanvas` hands back a wx-style canvas object, and run the REAL `RoomBuilder.build()`.
 * Nothing about the room is faked beyond the swatch textures the biome loaders would return.
 *
 * Both host shapes are run, because they fail DIFFERENTLY and only one of them crashes:
 *   - the DevTools simulator leaves a `document` reachable, so the old code got a canvas out of it
 *     and then threw at `Texture.from` — the reported crash;
 *   - a real device has no `document`, so the old code took the "no canvas" early-out instead: no
 *     crash, and silently no bake — the wall cap paid two draws forever on the one target the bake
 *     was written for. A fix that only stopped the throw would leave that half standing.
 *
 * It cannot pin what a real base library does with the resulting texture on upload (design/04's
 * checklist still owns that); it pins that the room BUILDS, and that the baked cap really is the
 * adapter's canvas rather than a browser one.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { DOMAdapter, TilingSprite, Texture, TextureSource } from 'pixi.js';
import type { Adapter } from 'pixi.js';
import { createGameState } from '@dd/engine/state/GameState';
import type { GameState } from '@dd/engine/state/GameState';
import { Layers } from './layers';
import { Backdrop } from './Backdrop';
import { RoomBuilder } from './RoomBuilder';
import type { Entity } from './Entity';
import { resetLitCapCache } from './capLight';

const mocks = vi.hoisted(() => ({
  tex: undefined as unknown,
}));

vi.mock('../../render/biomeTiles', () => ({
  getFloorTexture: () => mocks.tex,
  getWallTexture: () => mocks.tex,
  getWallFaceTexture: () => mocks.tex,
  getPillarTexture: () => mocks.tex,
  // Every swatch here is first-generation (no warm-stone metadata) unless a test says otherwise.
  swatchMeta: () => undefined,
}));

vi.mock('../../render/environmentSprites', () => ({
  getDoorTexture: () => undefined,
  getDoorCurtainTexture: () => undefined,
  getPortalArchTexture: () => undefined,
  // No torch art: a torch-lit chapter still hangs its lights, just no sconce sprite.
  getTorchTexture: () => undefined,
  getPickupTexture: () => undefined,
  getPropTexture: () => undefined,
}));

// Same bare-class stub the other room tests use: `NormalLitFilter` compiles a real GlProgram at
// construction, which needs a GL context neither this environment nor the point of this file has.
vi.mock('../fx/filters', async () => ({
  ...(await vi.importActual<typeof import('../fx/filters')>('../fx/filters')),
  NormalLitFilter: class {
    constructor(
      public keyColor?: number,
      public keyIntensity?: number,
      public opts?: { ambient?: number; gradient?: number },
    ) {}
  },
}));

/** A wx-style 2D canvas: the shape `wx.createCanvas()` returns — width/height/getContext and
 *  nothing else. Deliberately NOT an HTMLCanvasElement, because that is the whole point. */
function wxStyleCanvas(): { width: number; height: number; getContext: () => unknown } {
  return {
    width: 0,
    height: 0,
    getContext: () => ({
      drawImage: () => undefined,
      getImageData: (_x: number, _y: number, w: number, h: number) => ({
        data: new Uint8ClampedArray(w * h * 4).fill(46),
      }),
      putImageData: () => undefined,
    }),
  };
}

const made: ReturnType<typeof wxStyleCanvas>[] = [];
let browserAdapter: Adapter;

/** Install a WeChat-shaped host. `doc` is what `globalThis.document` should be: the simulator's
 *  canvas-producing stub, or `undefined` for a device, which has no such global at all. */
function installHost(doc: unknown): void {
  browserAdapter = DOMAdapter.get();
  // The globals a mini-game does not have. Stubbing them away rather than leaving them unused is
  // what makes a stray `instanceof HTMLCanvasElement` fail here the way it fails on the runtime.
  vi.stubGlobal('document', doc);
  vi.stubGlobal('HTMLCanvasElement', undefined);
  vi.stubGlobal('OffscreenCanvas', undefined);
  vi.stubGlobal('Image', undefined);
  DOMAdapter.set({
    ...browserAdapter,
    createCanvas: (w = 0, h = 0) => {
      const c = wxStyleCanvas();
      c.width = w;
      c.height = h;
      made.push(c);
      return c as unknown as HTMLCanvasElement;
    },
  });
}

/** The DevTools simulator's shape: `document.createElement('canvas')` answers with a canvas that
 *  is still not an `HTMLCanvasElement` as far as the game's own scope can tell. */
const simulatorDocument = { createElement: () => wxStyleCanvas() };

afterAll(() => {
  DOMAdapter.set(browserAdapter);
  vi.unstubAllGlobals();
});

afterEach(() => {
  resetLitCapCache();
  made.length = 0;
});

/** A swatch as the biome loaders hand one over: a real Texture whose source carries a resource,
 *  which is what `bakeLitCap` needs to have something to draw. */
function swatch(): Texture {
  const t = new Texture({ source: new TextureSource({ width: 64, height: 64 }) });
  (t.source as unknown as { resource: unknown }).resource = { width: 64, height: 64 };
  return t;
}

function stateWithOneWall(): GameState {
  const s = createGameState({
    seed: 1, worldW: 800, worldH: 600, waves: [],
    walls: [[100, 100, 64, 64]],
    obstacles: [],
  });
  (s as unknown as { dungeonConfig?: { biomeId: string } }).dungeonConfig = { biomeId: 'ember' };
  return s;
}

describe.each([
  ['DevTools simulator — a document exists, but no HTMLCanvasElement', simulatorDocument as unknown],
  ['device — no document at all', undefined as unknown],
])('RoomBuilder.build on a WeChat-shaped runtime (%s)', (_label, doc) => {
  beforeAll(() => installHost(doc));

  it('builds a room with real swatches instead of throwing "Could not find a source type"', () => {
    mocks.tex = swatch();
    const layers = new Layers();
    const rb = new RoomBuilder(layers, new Backdrop(layers));

    expect(() => rb.build(stateWithOneWall())).not.toThrow();

    expect((rb as unknown as { wallEntities: Entity[] }).wallEntities).toHaveLength(1);
  });

  it('bakes the cap key light onto the ADAPTER’s canvas — the one thing a browser-only path lost', () => {
    // Not just "it didn't throw": on the broken code the whole bake was unreachable here, so a fix
    // that merely swallowed the error would leave the cap drawn as two additive sprites forever —
    // silently giving the target this optimisation exists for the draw-call cost it was meant to
    // remove. So assert the baked texture reached the scene, and that its resource is the wx canvas.
    mocks.tex = swatch();
    const layers = new Layers();
    const rb = new RoomBuilder(layers, new Backdrop(layers));

    rb.build(stateWithOneWall());

    const wall = (rb as unknown as { wallEntities: Entity[] }).wallEntities[0]!;
    const tiles = wall.children.filter((c): c is TilingSprite => c instanceof TilingSprite);
    const lit = tiles.filter((t) => t.texture.label?.startsWith('lit-cap:'));
    expect(lit).toHaveLength(1);
    expect(made).toHaveLength(1);
    expect(lit[0]!.texture.source.resource).toBe(made[0]);
    // ...and one cap sprite, not the additive pair the fallback path draws.
    expect(tiles.filter((t) => t.blendMode === 'add')).toHaveLength(0);
  });
});
