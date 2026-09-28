/**
 * `LobbyBackdrop` — the lobby's painting (design/10, 2026-09-27). What is pinned: the cover is
 * one opaque sprite exactly the viewport (the property `menuCoversWorld.test.ts` relies on for
 * every screen), the crop keeps the dais on screen where a centred crop would lose it, and the
 * art falls back instead of blocking the lobby.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Graphics, Sprite, Texture, TextureSource } from 'pixi.js';

const mocks = vi.hoisted(() => ({ textures: new Map<string, unknown>() }));
vi.mock('../../render/uiSkins', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../render/uiSkins')>()),
  getUiTexture: (key: string) => mocks.textures.get(key),
  // `whenUiTexture` through the same fake: the real one reads the module's own map, which
  // this mock never fills, so constructor-time icons would silently stay off.
  whenUiTexture: ((key, apply) => { const tex = mocks.textures.get(key); if (tex) apply(tex as never); }) as typeof import('../../render/uiSkins').whenUiTexture,
}));

import { LobbyBackdrop, DAIS_U, DAIS_V, SKY_ROCKS } from './LobbyBackdrop';
import { ART_FADE_MS } from './artFade';

const PAINTING = new Texture({ source: new TextureSource({ width: 1920, height: 1080 }) });
const HUB = new Texture({ source: new TextureSource({ width: 384, height: 288 }) });

function internals(b: LobbyBackdrop) {
  return b as unknown as { cover: Sprite; glow: Graphics; motes: Graphics; vignette: Graphics };
}

beforeEach(() => mocks.textures.clear());

describe('LobbyBackdrop — the cover', () => {
  it('is child 0, opaque, and exactly the viewport, from the origin', () => {
    mocks.textures.set('lobby_bg', PAINTING);
    const b = new LobbyBackdrop();
    b.layout(1280, 720);
    const cover = internals(b).cover;
    expect(b.view.children[0]).toBe(cover);
    expect([cover.x, cover.y, cover.width, cover.height, cover.alpha]).toEqual([0, 0, 1280, 720, 1]);
  });

  it('crops through the texture frame, never stretching the painting', () => {
    mocks.textures.set('lobby_bg', PAINTING);
    const b = new LobbyBackdrop();
    b.layout(844, 390);
    const f = internals(b).cover.texture.frame;
    expect(f.width / f.height).toBeCloseTo(844 / 390, 5);
    expect(f.x).toBeGreaterThanOrEqual(0);
    expect(f.x + f.width).toBeLessThanOrEqual(1920 + 1e-6);
    expect(f.y + f.height).toBeLessThanOrEqual(1080 + 1e-6);
  });

  it('keeps the dais on screen on a portrait window, where a centred crop loses it', () => {
    mocks.textures.set('lobby_bg', PAINTING);
    const b = new LobbyBackdrop();
    b.setDaisTarget(0.3);
    b.layout(760, 1646);
    // A centred crop would put it at DAIS_U * drawnW - (drawnW - w) / 2 — off the left edge.
    const drawnW = 1920 * (1646 / 1080);
    expect(DAIS_U * drawnW - (drawnW - 760) / 2).toBeLessThan(0);
    expect(b.dais.x).toBeCloseTo(760 * 0.3, 5);
    expect(b.dais.paintingH).toBeCloseTo(1646, 5);
  });

  it('clamps the crop to the painting when the target cannot be reached', () => {
    mocks.textures.set('lobby_bg', PAINTING);
    const b = new LobbyBackdrop();
    b.setDaisTarget(0.9);
    b.layout(1920, 1080); // no slack to crop at all
    expect(b.dais.x).toBeCloseTo(DAIS_U * 1920, 5);
    expect(b.dais.y).toBeCloseTo(DAIS_V * 1080, 5);
    expect(internals(b).cover.texture.frame.x).toBe(0);
  });

  it('falls back to the hub art, then to a flat fill — art never blocks the lobby', () => {
    mocks.textures.set('hub', HUB);
    const hub = new LobbyBackdrop();
    hub.layout(800, 600);
    expect(internals(hub).cover.texture.source).toBe(HUB.source);
    expect(internals(hub).cover.width).toBe(800);

    mocks.textures.clear();
    const flat = new LobbyBackdrop();
    flat.layout(800, 600);
    const cover = internals(flat).cover;
    expect(cover.texture).toBe(Texture.WHITE);
    expect([cover.width, cover.height]).toEqual([800, 600]);
    expect(cover.tint).not.toBe(0xffffff);
    expect(flat.dais.y).toBeCloseTo(600 * 0.72, 5);
  });
});

describe('LobbyBackdrop — the crystal and the vignette', () => {
  it('lights the painting\'s own dais, and animates it', () => {
    mocks.textures.set('lobby_bg', PAINTING);
    const b = new LobbyBackdrop();
    b.layout(1280, 720);
    const { glow, motes } = internals(b);
    expect(glow.getLocalBounds().width).toBeGreaterThan(0);
    b.update(800);
    const a = glow.alpha;
    b.update(800);
    expect(glow.alpha).not.toBe(a);
    expect(motes.getLocalBounds().width).toBeGreaterThan(0);
  });

  it('draws no glow over the fallback art, whose dais is somewhere else', () => {
    mocks.textures.set('hub', HUB);
    const b = new LobbyBackdrop();
    b.layout(800, 600);
    const { glow } = internals(b);
    expect(glow.getLocalBounds().width).toBe(0);
    const before = glow.alpha;
    b.update(800);
    expect(glow.alpha).toBe(before);
  });

  it('darkens only around the rect it is given, and clears', () => {
    const b = new LobbyBackdrop();
    b.layout(800, 600);
    b.setFocus({ x: 500, y: 100, w: 272, h: 300 });
    const v = internals(b).vignette.getLocalBounds();
    expect(v.minX).toBeLessThan(500);
    expect(v.maxX).toBeGreaterThan(772);
    expect(v.minX).toBeGreaterThan(0);
    b.setFocus(null);
    expect(internals(b).vignette.getLocalBounds().width).toBe(0);
  });
});

describe('LobbyBackdrop — the drifting sky rocks', () => {
  const ROCK = new Texture({ source: new TextureSource({ width: 48, height: 52 }) });
  const rocksOf = (b: LobbyBackdrop) => (b as unknown as { rocks: { visible: boolean; children: Sprite[] } }).rocks;
  const withRocks = () => {
    mocks.textures.set('lobby_bg', PAINTING);
    for (const r of SKY_ROCKS) mocks.textures.set(r.key, ROCK);
  };

  it('puts each rock at its measured home in the cropped painting, at the painting\'s scale', () => {
    withRocks();
    const b = new LobbyBackdrop();
    b.layout(1920, 1080); // the painting 1:1, no crop — home is exactly u*W, v*H
    const rocks = rocksOf(b);
    expect(rocks.visible).toBe(true);
    SKY_ROCKS.forEach((r, i) => {
      const s = rocks.children[i]!;
      expect(s.visible).toBe(true);
      expect(s.height).toBeCloseTo(r.hFrac * 1080, 5);
      // Within its drift of home (the clock is at 0, so the offset is the phase's own).
      expect(Math.abs(s.x - r.u * 1920)).toBeLessThanOrEqual(r.drift * 1080 * 0.35 + 1e-6);
      expect(Math.abs(s.y - r.v * 1080)).toBeLessThanOrEqual(r.drift * 1080 + 1e-6);
    });
  });

  it('follows the crop: a rock stays on the same stone of sky when the dais target moves', () => {
    withRocks();
    const a = new LobbyBackdrop();
    // 800x600 draws the painting 1067 wide, so the crop has 267px to move in.
    a.setDaisTarget(0.2);
    a.layout(800, 600);
    const b = new LobbyBackdrop();
    b.setDaisTarget(0.4);
    b.layout(800, 600);
    // Same painting scale, different crop: every rock moved by exactly the dais's shift.
    const shift = b.dais.x - a.dais.x;
    expect(shift).not.toBe(0);
    rocksOf(a).children.forEach((s, i) => expect(rocksOf(b).children[i]!.x - s.x).toBeCloseTo(shift, 5));
  });

  it('drifts over time, each rock on its own period, and stays within its amplitude', () => {
    withRocks();
    const b = new LobbyBackdrop();
    b.layout(1920, 1080);
    const at = () => rocksOf(b).children.map((s) => s.y);
    const start = at();
    const seen = SKY_ROCKS.map(() => ({ min: Infinity, max: -Infinity }));
    for (let t = 0; t < 9000; t += 50) {
      b.update(50);
      at().forEach((y, i) => { seen[i]!.min = Math.min(seen[i]!.min, y); seen[i]!.max = Math.max(seen[i]!.max, y); });
    }
    SKY_ROCKS.forEach((r, i) => {
      const amp = r.drift * 1080;
      // It really moves (most of its range over a full period) and never past its amplitude.
      expect(seen[i]!.max - seen[i]!.min).toBeGreaterThan(amp * 1.8);
      expect(seen[i]!.max).toBeLessThanOrEqual(r.v * 1080 + amp + 1e-6);
      expect(seen[i]!.min).toBeGreaterThanOrEqual(r.v * 1080 - amp - 1e-6);
    });
    // Not in step: after the same elapsed time the rocks are at different points of their bob.
    const offsets = at().map((y, i) => (y - SKY_ROCKS[i]!.v * 1080) / (SKY_ROCKS[i]!.drift * 1080));
    expect(new Set(offsets.map((o) => o.toFixed(2))).size).toBe(SKY_ROCKS.length);
    expect(start).not.toEqual(at());
  });

  it('mirrors a reused sprite where asked, at the same size', () => {
    withRocks();
    const b = new LobbyBackdrop();
    b.layout(1920, 1080);
    SKY_ROCKS.forEach((r, i) => {
      const s = rocksOf(b).children[i]!;
      expect(Math.sign(s.scale.x), r.key).toBe(r.flip ? -1 : 1);
      expect(Math.abs(s.scale.x)).toBeCloseTo(s.scale.y, 9);
    });
    expect(SKY_ROCKS.some((r) => r.flip)).toBe(true);
  });

  it('places the open-sky copies clear of the lifted homes, which the UI covers at 16:9', () => {
    // Each copy at least a rock's height away from every home, so none reads as a double.
    const homes = SKY_ROCKS.filter((r) => r.lifted);
    for (const r of SKY_ROCKS.filter((x) => !x.lifted)) {
      for (const h of homes) expect(Math.hypot((r.u - h.u) * 16 / 9, r.v - h.v)).toBeGreaterThan(h.hFrac * 2);
    }
  });

  it('the far rock drifts least', () => {
    const far = SKY_ROCKS.find((r) => r.key === 'lobby_rock_c')!;
    for (const r of SKY_ROCKS) if (r !== far) expect(far.drift).toBeLessThan(r.drift);
  });

  it('leaves a rock out when its texture is missing, and all of them over the fallback art', () => {
    mocks.textures.set('lobby_bg', PAINTING);
    mocks.textures.set('lobby_rock_a', ROCK);
    const b = new LobbyBackdrop();
    b.layout(1280, 720);
    expect(rocksOf(b).children.map((s) => s.visible)).toEqual(SKY_ROCKS.map((r) => r.key === 'lobby_rock_a'));

    mocks.textures.clear();
    mocks.textures.set('hub', HUB);
    for (const r of SKY_ROCKS) mocks.textures.set(r.key, ROCK);
    b.layout(1280, 720);
    // The hub art has its own rocks painted in; drawing the lobby's over it would double them.
    expect(rocksOf(b).visible).toBe(false);
  });

  it('sits under the vignette, so a rock behind the column darkens with its sky', () => {
    withRocks();
    const b = new LobbyBackdrop();
    const view = b.view;
    expect(view.getChildIndex(rocksOf(b) as never)).toBeLessThan(view.getChildIndex(internals(b).vignette));
    expect(view.getChildIndex(rocksOf(b) as never)).toBeGreaterThan(0);
  });
});

describe('LobbyBackdrop — the dimmed mode every other menu draws (2026-09-27)', () => {
  function wash(b: LobbyBackdrop): Graphics {
    return (b as unknown as { wash: Graphics }).wash;
  }

  it('the lobby itself draws no wash', () => {
    mocks.textures.set('lobby_bg', PAINTING);
    const b = new LobbyBackdrop();
    b.layout(1280, 720);
    expect(wash(b).visible).toBe(false);
  });

  it('washes the painting and its rocks, under the crystal glow — the place stays lit', () => {
    mocks.textures.set('lobby_bg', PAINTING);
    const b = new LobbyBackdrop({ dim: 0.5 });
    b.layout(1280, 720);
    const w = wash(b);
    expect(w.visible).toBe(true);
    const kids = b.view.children;
    const i = kids.indexOf(w);
    expect(i).toBeGreaterThan(kids.indexOf(internals(b).cover));
    expect(i).toBeGreaterThan(kids.indexOf((b as unknown as { rocks: Graphics }).rocks));
    expect(i).toBeLessThan(kids.indexOf(internals(b).glow));
    // It spans exactly the viewport it was laid out for.
    const bounds = w.getLocalBounds();
    expect([bounds.x, bounds.y, bounds.width, bounds.height]).toEqual([0, 0, 1280, 720]);
    b.layout(844, 390);
    const again = w.getLocalBounds();
    expect([again.width, again.height]).toEqual([844, 390]);
  });

  it('keeps the cover opaque and the viewport\'s size, so the world stays covered', () => {
    mocks.textures.set('hub', HUB);
    const b = new LobbyBackdrop({ dim: 0.5 });
    b.layout(1280, 720);
    const cover = internals(b).cover;
    expect([cover.x, cover.y, cover.width, cover.height, cover.alpha]).toEqual([0, 0, 1280, 720, 1]);
  });

  it('centres the dais when asked to, until `setDaisTarget` says otherwise', () => {
    mocks.textures.set('lobby_bg', PAINTING);
    const b = new LobbyBackdrop({ dim: 0.5, daisU: 0.5 });
    b.layout(760, 1646);
    expect(b.dais.x).toBeCloseTo(760 * 0.5, 5);
  });
});

describe('LobbyBackdrop — rocks that land after the painting (2026-09-28)', () => {
  const ROCK = new Texture({ source: new TextureSource({ width: 48, height: 52 }) });
  const rockSprites = (b: LobbyBackdrop) => (b as unknown as { rocks: { children: Sprite[] } }).rocks.children;

  it('fades each rock in as a re-layout finds it, and not before', () => {
    mocks.textures.set('lobby_bg', PAINTING);
    const b = new LobbyBackdrop();
    b.layout(1280, 720);
    for (const s of rockSprites(b)) expect(s.visible).toBe(false);
    for (const r of SKY_ROCKS) mocks.textures.set(r.key, ROCK);
    b.layout(1280, 720); // `MainMenu` re-lays the lobby as art lands
    for (const s of rockSprites(b)) {
      expect(s.visible).toBe(true);
      expect(s.alpha).toBe(0);
    }
    b.update(ART_FADE_MS);
    for (const s of rockSprites(b)) expect(s.alpha).toBe(1);
    b.layout(1280, 720); // a later re-layout (a resize) does not replay it
    for (const s of rockSprites(b)) expect(s.alpha).toBe(1);
  });

  it('does not fade rocks already in on the first layout, nor count the hub fallback as waiting', () => {
    mocks.textures.set('lobby_bg', PAINTING);
    for (const r of SKY_ROCKS) mocks.textures.set(r.key, ROCK);
    const warm = new LobbyBackdrop();
    warm.layout(1280, 720);
    for (const s of rockSprites(warm)) expect(s.alpha).toBe(1);

    // Over the hub fallback there are no rocks to wait for: when the painting then arrives
    // with its rocks already in, they simply appear with it.
    mocks.textures.delete('lobby_bg');
    mocks.textures.set('hub', HUB);
    const fallback = new LobbyBackdrop();
    fallback.layout(1280, 720);
    mocks.textures.set('lobby_bg', PAINTING);
    fallback.layout(1280, 720);
    for (const s of rockSprites(fallback)) expect(s.alpha).toBe(1);
  });
});
