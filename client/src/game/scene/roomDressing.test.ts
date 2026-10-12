/**
 * `roomDressing.buildPillarEntities` — which body a pillar gets (2026-10-12).
 *
 * A warm-stone chapter paints its pillars from its own wall art (`pillarBake.ts`); everything else
 * keeps the pillar sprite, and with no sprite the hand-toned cylinder. The bake itself is mocked:
 * `pillarBake.test.ts` owns its pixels, and this repo's vitest has no canvas to paint on.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Graphics, Sprite, Texture, TextureSource } from 'pixi.js';
import { createGameState } from '@dd/engine/state/GameState';
import { Layers } from './layers';
import { buildPillarEntities } from './roomDressing';
import { biomePalette } from '../theme';
import { PILLAR_BASE_PX, pillarArtExtent, pillarCapRadii } from './pillarRender';
import { WALL_HEIGHT } from './wallGeometry';

const mocks = vi.hoisted(() => ({
  face: undefined as unknown,
  cap: undefined as unknown,
  sprite: undefined as unknown,
  meta: new Map<unknown, { density: number; seamless: boolean; authoredTone: boolean }>(),
  baked: undefined as unknown,
  bakeCalls: [] as unknown[][],
}));

vi.mock('../../render/biomeTiles', () => ({
  getWallFaceTexture: () => mocks.face,
  getWallTexture: () => mocks.cap,
  getPillarTexture: () => mocks.sprite,
  swatchMeta: (t: unknown) => (t ? mocks.meta.get(t) : undefined),
}));

vi.mock('./pillarBake', () => ({
  bakeStonePillar: (...a: unknown[]) => {
    mocks.bakeCalls.push(a);
    return mocks.baked;
  },
}));

const tex = (w = 16, h = 16) => new Texture({ source: new TextureSource({ width: w, height: h }) });
const WARM = { density: 4, seamless: true, authoredTone: true };

function build() {
  const layers = new Layers();
  const s = createGameState({ seed: 1, worldW: 800, worldH: 600, waves: [], walls: [], obstacles: [[150, 120, 20]] });
  return { layers, ...buildPillarEntities(layers, s, biomePalette('ember'), 'fire') };
}

beforeEach(() => {
  mocks.face = tex(512, 256);
  mocks.cap = tex(512, 512);
  mocks.sprite = tex(326, 384);
  mocks.meta = new Map([[mocks.face, { ...WARM, density: 1 }], [mocks.cap, WARM]]);
  mocks.baked = tex(336, 390);
  mocks.bakeCalls = [];
});

describe('buildPillarEntities — which pillar a room gets', () => {
  it('paints a warm-stone chapter\'s pillar from its own face and cap, at the cap\'s density', () => {
    const { pillars } = build();
    expect(mocks.bakeCalls.length).toBe(1);
    const [face, cap, density, shape] = mocks.bakeCalls[0]!;
    expect(face).toBe(mocks.face);
    expect(cap).toBe(mocks.cap);
    expect(density).toBe(4);
    const bodyW = (shape as { bodyW: number }).bodyW;
    expect(shape).toEqual({ bodyW, height: WALL_HEIGHT, ...pillarCapRadii(bodyW), basePx: PILLAR_BASE_PX });
    // The painted art as it is: no chapter tint over it, and no flat crease rect under it.
    const body = pillars[0]!.children[0]!;
    expect(body.children.length).toBe(1);
    const sprite = body.children[0] as Sprite;
    expect(sprite).toBeInstanceOf(Sprite);
    expect(sprite.texture).toBe(mocks.baked);
    expect(sprite.tint).toBe(0xffffff);
  });

  it('measures the x-ray occluder off the painted texture, not the sprite it replaced', () => {
    const { occluders, pillars } = build();
    const bodyW = (mocks.bakeCalls[0]![3] as { bodyW: number }).bodyW;
    const want = pillarArtExtent(bodyW, WALL_HEIGHT, mocks.baked as Texture);
    expect(occluders[0]!.box.top).toBeCloseTo(pillars[0]!.y + want.top, 6);
    expect(occluders[0]!.box.right - occluders[0]!.box.left).toBeCloseTo(want.halfW * 2, 6);
  });

  it('keeps the pillar sprite, tinted, where the bake cannot run', () => {
    mocks.baked = undefined;
    const { pillars } = build();
    const body = pillars[0]!.children[0]!;
    const sprite = body.children[0] as Sprite;
    expect(sprite.texture).toBe(mocks.sprite);
    expect(sprite.tint).not.toBe(0xffffff);
    // ...with its crease.
    expect(body.children[1]).toBeInstanceOf(Graphics);
  });

  it.each([
    ['a first-generation face', () => mocks.meta.delete(mocks.face)],
    ['a face whose tone is not authored', () => mocks.meta.set(mocks.face, { ...WARM, authoredTone: false })],
    ['a cap with no metadata', () => mocks.meta.delete(mocks.cap)],
    ['no face', () => { mocks.face = undefined; }],
    ['no cap', () => { mocks.cap = undefined; }],
  ])('does not paint for %s', (_name, arrange) => {
    arrange();
    const { pillars } = build();
    expect(mocks.bakeCalls.length).toBe(0);
    expect((pillars[0]!.children[0]!.children[0] as Sprite).texture).toBe(mocks.sprite);
  });

  it('falls back to the hand-toned cylinder with neither a bake nor a sprite', () => {
    mocks.baked = undefined;
    mocks.sprite = undefined;
    const { pillars } = build();
    expect(pillars[0]!.children[0]).toBeInstanceOf(Graphics);
  });
});
