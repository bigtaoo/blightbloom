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
}));

import { LobbyBackdrop, DAIS_U, DAIS_V } from './LobbyBackdrop';

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
