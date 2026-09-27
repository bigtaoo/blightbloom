/**
 * `LobbyHero` — the selected character on the lobby dais (design/10, 2026-09-27), and the
 * `LobbyResources` material chips beside SETTINGS.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Sprite, Text, Texture, TextureSource } from 'pixi.js';
import { SKIN_DEFS } from '@dd/engine';
import { installFakeTextCanvas } from '../screens/fakeTextCanvas';

const mocks = vi.hoisted(() => ({ textures: new Map<string, unknown>() }));
vi.mock('../../render/uiSkins', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../render/uiSkins')>()),
  getUiTexture: (key: string) => mocks.textures.get(key),
}));

import { LobbyHero, HERO_PORTRAITS } from './LobbyHero';
import { LobbyResources, compactCount } from './LobbyResources';
import { UI_ASSET_KEYS } from '../../render/uiSkins';

installFakeTextCanvas();

const PORTRAIT = new Texture({ source: new TextureSource({ width: 342, height: 384 }) });

function internals(h: LobbyHero) {
  return h as unknown as { sprite: Sprite; nameText: Text; statsText: Text };
}

beforeEach(() => mocks.textures.clear());

describe('LobbyHero', () => {
  it('has a registered portrait for every playable character', () => {
    // A character added to the roster without one would silently leave the dais empty.
    const atlasKeys = Object.values(SKIN_DEFS).map((d) => d.atlasKey).filter((k) => k.startsWith('char_'));
    expect(atlasKeys.length).toBeGreaterThan(0);
    for (const key of atlasKeys) {
      expect(HERO_PORTRAITS[key], key).toBeDefined();
      expect(UI_ASSET_KEYS, key).toContain(HERO_PORTRAITS[key]);
    }
  });

  it('draws nothing for no skin, an unknown skin, or a portrait that has not loaded', () => {
    const h = new LobbyHero();
    h.setCharacter(null);
    expect(h.view.visible).toBe(false);
    h.setCharacter('no-such-skin');
    expect(h.view.visible).toBe(false);
    expect(internals(h).nameText.text).toBe('');
    h.setCharacter('vanguard'); // registered, but no texture in this test
    expect(h.view.visible).toBe(false);
  });

  it('shows the portrait, name and stats of the selected character', () => {
    mocks.textures.set('lobby_hero_orb', PORTRAIT);
    const h = new LobbyHero();
    h.setCharacter('vanguard');
    expect(h.view.visible).toBe(true);
    expect(internals(h).sprite.texture).toBe(PORTRAIT);
    expect(internals(h).nameText.text.length).toBeGreaterThan(0);
    expect(internals(h).statsText.text).toContain(String(SKIN_DEFS.vanguard!.maxHp));
  });

  it('stands on the dais at the height asked for, hovering and bobbing above it', () => {
    mocks.textures.set('lobby_hero_orb', PORTRAIT);
    const h = new LobbyHero();
    h.setCharacter('vanguard');
    h.layout(300, 400, 192, 440, 1);
    const sprite = internals(h).sprite;
    expect(sprite.height).toBeCloseTo(192, 5);
    expect(sprite.x).toBe(300);
    expect(sprite.y).toBeLessThan(400); // hovering, never standing IN the stone
    const y0 = sprite.y;
    h.update(700);
    expect(sprite.y).not.toBe(y0);
    expect(internals(h).nameText.y).toBe(440);
    expect(internals(h).statsText.y).toBeGreaterThan(440);
  });

  it('does not animate while hidden', () => {
    const h = new LobbyHero();
    h.layout(300, 400, 192, 440, 1);
    const y0 = internals(h).sprite.y;
    h.update(700);
    expect(internals(h).sprite.y).toBe(y0);
  });
});

describe('LobbyResources', () => {
  it('compacts a count to fit a four-digit chip', () => {
    expect(compactCount(0)).toBe('0');
    expect(compactCount(9999)).toBe('9999');
    expect(compactCount(12345)).toBe('12k');
    expect(compactCount(2_500_000)).toBe('2m');
  });

  it('draws one chip per element, zero for a missing or bad count', () => {
    const r = new LobbyResources();
    r.set({ fire: 7, ice: -3, lightning: Number.NaN });
    const labels = (r as unknown as { labels: Text[] }).labels.map((l) => l.text);
    expect(labels).toHaveLength(5);
    expect(labels).toContain('7');
    expect(labels.filter((t) => t === '0').length).toBe(4);
    expect(r.width).toBeGreaterThan(0);
    expect(r.height).toBeGreaterThan(0);
  });

  it('widens as a count grows', () => {
    const r = new LobbyResources();
    r.set({});
    const narrow = r.width;
    r.set({ fire: 9999 });
    expect(r.width).toBeGreaterThan(narrow);
  });
});
