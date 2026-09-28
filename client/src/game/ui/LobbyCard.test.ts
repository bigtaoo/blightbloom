/**
 * `LobbyCard` — the lobby's art-backed route card (design/10, 2026-09-27). The layout sweeps
 * (`labelFit`, `widgetOverlap`, `viewportFit`) measure it through the lobby; this file pins the
 * card's own contract: the `Button`-shaped child order those sweeps rely on, the label fit, the
 * banner crop, and the glow that marks the one primary.
 */
import { describe, it, expect, vi } from 'vitest';
import { Graphics, Sprite, Text, Texture, TextureSource } from 'pixi.js';
import { installFakeTextCanvas } from '../screens/fakeTextCanvas';

const mocks = vi.hoisted(() => ({ textures: new Map<string, unknown>() }));
vi.mock('../../render/uiSkins', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../render/uiSkins')>()),
  getUiTexture: (key: string) => mocks.textures.get(key),
  // `whenUiTexture` through the same fake: the real one reads the module's own map, which
  // this mock never fills, so constructor-time icons would silently stay off.
  whenUiTexture: ((key, apply) => { const tex = mocks.textures.get(key); if (tex) apply(tex as never); }) as typeof import('../../render/uiSkins').whenUiTexture,
}));
vi.mock('../../audio/uiSound', () => ({ playUiCue: vi.fn() }));

import { LobbyCard, fitFont, ellipsise } from './LobbyCard';
import { ART_FADE_MS } from './artFade';
import { estimateMonoWidth } from './textWidth';

installFakeTextCanvas();

const BANNER = new Texture({ source: new TextureSource({ width: 1536, height: 512 }) });
mocks.textures.set('banner', BANNER);

function internals(c: LobbyCard) {
  return c as unknown as {
    box: Graphics; glow: Graphics; art: Sprite; hover: Graphics;
    label: Text; hint: Text; iconSprite: Sprite | null;
  };
}

describe('fitFont / ellipsise', () => {
  it('keeps the base size when the text fits, and never grows past it', () => {
    expect(fitFont('CO-OP', 19, 500)).toBe(19);
    expect(fitFont('', 19, 10)).toBe(19);
  });

  it('shrinks to the largest size that fits, down to a floor', () => {
    const size = fitFont('KOLEJKA PVP SOLO', 26, 200);
    expect(size).toBeLessThan(26);
    expect(estimateMonoWidth('KOLEJKA PVP SOLO', size)).toBeLessThanOrEqual(200);
    expect(fitFont('X'.repeat(200), 26, 100)).toBe(10);
  });

  it('cuts with an ellipsis only when it has to', () => {
    expect(ellipsise('short', 12, 500)).toBe('short');
    const cut = ellipsise('a rather long description line', 12, 100);
    expect(cut.endsWith('…')).toBe(true);
    expect(estimateMonoWidth(cut, 12)).toBeLessThanOrEqual(100);
  });
});

describe('LobbyCard — the Button-shaped contract the layout sweeps rely on', () => {
  it('puts the press box first, exactly the card size, and the label as the first Text', () => {
    const c = new LobbyCard('SOLO PvE', 272, 96, { fill: 0x2f855a, frame: 0x9ae6b4, fontSize: 26 });
    expect(c.view.children[0]).toBe(internals(c).box);
    const b = internals(c).box.getLocalBounds();
    expect([b.width, b.height]).toEqual([272, 96]);
    expect(c.view.children.find((ch) => ch instanceof Text)).toBe(internals(c).label);
    expect([c.width, c.height]).toEqual([272, 96]);
  });

  it('fires onTap, plays no part in an ancestor pointerdown, and highlights on hover', () => {
    const c = new LobbyCard('X', 100, 40, { fill: 0, frame: 0, fontSize: 12 });
    const onTap = vi.fn();
    c.onTap = onTap;
    c.view.emit('pointertap', {} as never);
    expect(onTap).toHaveBeenCalledTimes(1);
    const stop = vi.fn();
    c.view.emit('pointerdown', { stopPropagation: stop } as never);
    expect(stop).toHaveBeenCalled();
    c.view.emit('pointerover', {} as never);
    expect(internals(c).hover.visible).toBe(true);
    c.view.emit('pointerout', {} as never);
    expect(internals(c).hover.visible).toBe(false);
    // A card with no handler is still safe to tap.
    c.onTap = null;
    expect(() => c.view.emit('pointertap', {} as never)).not.toThrow();
  });
});

describe('LobbyCard — the banner', () => {
  it('crops the art to the card aspect, keeping the RIGHT side where the subject is', () => {
    const c = new LobbyCard('X', 272, 62, { art: 'banner', fill: 0, frame: 0, fontSize: 12 });
    const art = internals(c).art;
    expect(art.visible).toBe(true);
    const f = art.texture.frame;
    expect(f.width / f.height).toBeCloseTo(272 / 62, 3);
    expect(f.x + f.width).toBeCloseTo(1536, 3);
    expect(art.width).toBeCloseTo(272, 5);
    expect(art.height).toBeCloseTo(62, 5);
  });

  it('crops height instead when the card is taller than the banner', () => {
    const c = new LobbyCard('X', 100, 100, { art: 'banner', fill: 0, frame: 0, fontSize: 12 });
    const f = internals(c).art.texture.frame;
    expect(f.height).toBe(512);
    expect(f.width).toBeCloseTo(512, 3);
  });

  it('falls back to the flat fill with no art, and can drop or swap its art later', () => {
    const c = new LobbyCard('X', 200, 50, { fill: 0x123456, frame: 0, fontSize: 12 });
    expect(internals(c).art.visible).toBe(false);
    c.setArt('banner');
    expect(internals(c).art.visible).toBe(true);
    c.setArt('banner'); // same key: nothing to redo
    c.setArt(undefined);
    expect(internals(c).art.visible).toBe(false);
    c.setArt('missing-key');
    expect(internals(c).art.visible).toBe(false);
  });
});

describe('LobbyCard — label, hint and icon', () => {
  it('fits a long label into the card instead of letting it run past', () => {
    const c = new LobbyCard('KOLEJKA PVP SOLO', 200, 60, { fill: 0, frame: 0, fontSize: 26 });
    const label = internals(c).label;
    expect(Number(label.style.fontSize)).toBeLessThan(26);
    expect(label.x + estimateMonoWidth(label.text, Number(label.style.fontSize))).toBeLessThanOrEqual(200);
  });

  it('stacks the hint under the label, and hides it when emptied', () => {
    const c = new LobbyCard('SOLO', 272, 96, { fill: 0, frame: 0, fontSize: 26 });
    const { label, hint } = internals(c);
    expect(hint.visible).toBe(false);
    expect(label.y).toBe(48);
    c.setHint('Descend alone into the depths');
    expect(hint.visible).toBe(true);
    expect(hint.y).toBeGreaterThan(label.y);
    expect(label.y).toBeLessThan(48);
    c.setHint('');
    expect(hint.visible).toBe(false);
    expect(label.y).toBe(48);
  });

  it('ellipsises a hint too long even at the smallest size', () => {
    const c = new LobbyCard('X', 120, 60, { fill: 0, frame: 0, fontSize: 16 });
    c.setHint('this description will never fit in a card this narrow, at any size');
    expect(internals(c).hint.text.endsWith('…')).toBe(true);
  });

  it('moves the label right of an icon, and back when it is cleared', () => {
    const c = new LobbyCard('CO-OP', 272, 62, { fill: 0, frame: 0, fontSize: 19 });
    const before = internals(c).label.x;
    c.setIcon(Texture.WHITE, 0x123456);
    expect(internals(c).iconSprite).not.toBeNull();
    expect(internals(c).label.x).toBeGreaterThan(before);
    c.setIcon(Texture.WHITE); // replacing keeps one sprite
    expect(c.view.children.filter((ch) => ch === internals(c).iconSprite)).toHaveLength(1);
    c.setIcon(undefined);
    expect(internals(c).iconSprite).toBeNull();
    expect(internals(c).label.x).toBe(before);
  });
});

describe('LobbyCard — state changes', () => {
  it('resizes its box, and ignores a resize to the size it already has', () => {
    const c = new LobbyCard('SOLO', 272, 96, { fill: 0, frame: 0, fontSize: 26 });
    c.resize(272, 96);
    c.resize(272, 44);
    expect(internals(c).box.getLocalBounds().height).toBe(44);
    expect(c.height).toBe(44);
  });

  it('re-colours fill and frame, as no-ops when unchanged', () => {
    const c = new LobbyCard('X', 100, 40, { fill: 1, frame: 2, fontSize: 12 });
    const style = (c as unknown as { style: { fill: number; frame: number } }).style;
    c.setFill(1);
    c.setFrame(2);
    c.setFill(3);
    c.setFrame(4);
    expect([style.fill, style.frame]).toEqual([3, 4]);
  });

  it('breathes its glow only while it is the primary', () => {
    const c = new LobbyCard('X', 100, 40, { fill: 0, frame: 0, fontSize: 12, glow: true });
    const glow = internals(c).glow;
    expect(glow.visible).toBe(true);
    c.update(600);
    const a = glow.alpha;
    c.update(600);
    expect(glow.alpha).not.toBe(a);
    c.setGlow(true); // unchanged
    c.setGlow(false);
    expect(glow.visible).toBe(false);
    const frozen = glow.alpha;
    c.update(600);
    expect(glow.alpha).toBe(frozen);
  });
});

describe('LobbyCard — a banner that lands after the lobby is up (2026-09-28)', () => {
  it('draws the fill until then, and fades the banner in when refreshArt finds it', () => {
    const c = new LobbyCard('X', 272, 62, { art: 'late-banner', fill: 0, frame: 0, fontSize: 12 });
    expect(internals(c).art.visible).toBe(false);
    c.refreshArt(); // still not in: nothing to do
    expect(internals(c).art.visible).toBe(false);
    mocks.textures.set('late-banner', BANNER);
    c.refreshArt();
    const art = internals(c).art;
    expect(art.visible).toBe(true);
    expect(art.width).toBeCloseTo(272, 5); // drawn exactly as a warm card is
    expect(art.alpha).toBe(0);
    c.update(ART_FADE_MS / 2); // not the primary: the fade still runs
    expect(art.alpha).toBeCloseTo(0.5);
    c.update(ART_FADE_MS);
    expect(art.alpha).toBe(1);
    mocks.textures.delete('late-banner');
  });

  it('neither redraws nor fades a card whose art was already there', () => {
    const c = new LobbyCard('X', 272, 62, { art: 'banner', fill: 0, frame: 0, fontSize: 12 });
    const before = internals(c).art.texture;
    c.refreshArt();
    expect(internals(c).art.texture).toBe(before); // no redraw: the same cropped texture
    expect(internals(c).art.alpha).toBe(1);
  });
});
