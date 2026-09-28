/**
 * `LobbyHero` — the selected character on the lobby dais (design/10, 2026-09-27).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Sprite, Text, Texture, TextureSource } from 'pixi.js';
import { SKIN_DEFS } from '@dd/engine';
import { installFakeTextCanvas } from '../screens/fakeTextCanvas';

const mocks = vi.hoisted(() => ({ textures: new Map<string, unknown>() }));
vi.mock('../../render/uiSkins', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../render/uiSkins')>()),
  getUiTexture: (key: string) => mocks.textures.get(key),
  // `whenUiTexture` through the same fake: the real one reads the module's own map, which
  // this mock never fills, so constructor-time icons would silently stay off.
  whenUiTexture: ((key, apply) => { const tex = mocks.textures.get(key); if (tex) apply(tex as never); }) as typeof import('../../render/uiSkins').whenUiTexture,
}));

import { LobbyHero, HERO_PORTRAITS } from './LobbyHero';
import { ART_FADE_MS } from './artFade';
import { UI_ASSET_KEYS } from '../../render/uiSkins';

installFakeTextCanvas();

const PORTRAIT = new Texture({ source: new TextureSource({ width: 342, height: 384 }) });
const WEAPON = new Texture({ source: new TextureSource({ width: 160, height: 148 }) });

function internals(h: LobbyHero) {
  return h as unknown as { sprite: Sprite; nameText: Text; statsText: Text; bestText: Text; weapon: Sprite };
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

describe('LobbyHero — the orbiting weapon', () => {
  function orbiting() {
    mocks.textures.set('lobby_hero_orb', PORTRAIT);
    mocks.textures.set('lobby_weapon', WEAPON);
    const h = new LobbyHero();
    h.setCharacter('vanguard');
    h.layout(300, 400, 200, 440, 1);
    return h;
  }

  it('is registered with the lobby pack, not borrowed from the forge pack', () => {
    expect(UI_ASSET_KEYS).toContain('lobby_weapon');
  });

  it('draws no weapon when its texture has not loaded, and the hero still stands', () => {
    mocks.textures.set('lobby_hero_orb', PORTRAIT);
    const h = new LobbyHero();
    h.setCharacter('vanguard');
    expect(h.view.visible).toBe(true);
    expect(internals(h).weapon.visible).toBe(false);
  });

  it('is sized against the body, and laps it — in front on the near half, behind on the far', () => {
    const h = orbiting();
    const { weapon, sprite } = internals(h);
    expect(weapon.visible).toBe(true);
    expect(Math.max(weapon.width, weapon.height)).toBeGreaterThan(200 * 0.25);
    expect(Math.max(weapon.width, weapon.height)).toBeLessThan(200 * 0.45);
    const seen = { front: 0, back: 0 };
    const xs: number[] = [];
    for (let i = 0; i < 14; i++) {
      h.update(500);
      xs.push(weapon.x);
      if (weapon.zIndex > sprite.zIndex) seen.front++;
      else seen.back++;
      // Nearer is bigger and more opaque; farther, the reverse.
      if (weapon.zIndex > sprite.zIndex) expect(weapon.alpha).toBeGreaterThanOrEqual(0.8);
      else expect(weapon.alpha).toBeLessThanOrEqual(0.8);
    }
    expect(seen.front).toBeGreaterThan(3);
    expect(seen.back).toBeGreaterThan(3);
    // Both sides of the body, wider than the body is.
    expect(Math.min(...xs)).toBeLessThan(300 - 60);
    expect(Math.max(...xs)).toBeGreaterThan(300 + 60);
  });

  it('rides with the body as it bobs, rather than circling a fixed point', () => {
    const h = orbiting();
    const { weapon, sprite } = internals(h);
    // After a whole lap the orbit is back where it began; only the bob has moved.
    const w0 = weapon.y - sprite.y;
    h.update(7000);
    expect(weapon.y - sprite.y).toBeCloseTo(w0, 5);
  });
});

describe('LobbyHero — the best floor', () => {
  it('shows no line before any run has ended, and the deepest floor after', () => {
    mocks.textures.set('lobby_hero_orb', PORTRAIT);
    const h = new LobbyHero();
    h.setCharacter('vanguard');
    h.layout(300, 400, 192, 440, 1);
    expect(internals(h).bestText.visible).toBe(false);
    h.setBestFloor(4);
    expect(internals(h).bestText.visible).toBe(true);
    expect(internals(h).bestText.text).toContain('4');
    expect(internals(h).bestText.y).toBeGreaterThan(internals(h).statsText.y);
    h.setBestFloor(0);
    expect(internals(h).bestText.visible).toBe(false);
  });
});

describe('LobbyHero — art that lands after the lobby is up (2026-09-28)', () => {
  it('shows a portrait that arrives later, fading it in rather than popping it', () => {
    const h = new LobbyHero();
    h.setCharacter('vanguard'); // cold boot: the `lobby` tier is still downloading
    expect(h.view.visible).toBe(false);
    mocks.textures.set('lobby_hero_orb', PORTRAIT);
    mocks.textures.set('lobby_weapon', WEAPON);
    h.refreshArt();
    expect(h.view.visible).toBe(true);
    expect(internals(h).sprite.texture).toBe(PORTRAIT);
    expect(h.view.alpha).toBe(0);
    h.update(ART_FADE_MS / 2);
    expect(h.view.alpha).toBeCloseTo(0.5);
    h.update(ART_FADE_MS);
    expect(h.view.alpha).toBe(1);
    // The weapon came in with the body, inside the body's fade — not held at 0 by its own.
    expect(internals(h).weapon.alpha).toBeGreaterThan(0.5);
  });

  it('does not fade art that is already there on the first draw — the warm boot', () => {
    mocks.textures.set('lobby_hero_orb', PORTRAIT);
    mocks.textures.set('lobby_weapon', WEAPON);
    const h = new LobbyHero();
    h.setCharacter('vanguard');
    expect(h.view.alpha).toBe(1);
    h.update(16);
    expect(internals(h).weapon.alpha).toBeGreaterThan(0.5);
  });

  it('fades a weapon that lands after the body on its own', () => {
    mocks.textures.set('lobby_hero_orb', PORTRAIT);
    const h = new LobbyHero();
    h.setCharacter('vanguard');
    h.layout(400, 500, 300, 520, 1);
    expect(internals(h).weapon.visible).toBe(false);
    mocks.textures.set('lobby_weapon', WEAPON);
    h.refreshArt();
    expect(internals(h).weapon.visible).toBe(true);
    h.update(0);
    expect(internals(h).weapon.alpha).toBe(0);
    h.update(ART_FADE_MS);
    expect(internals(h).weapon.alpha).toBeGreaterThan(0.5);
    expect(h.view.alpha).toBe(1); // the body did not replay its fade
  });

  it('does not fade on a character change once the art is in', () => {
    mocks.textures.set('lobby_hero_orb', PORTRAIT);
    mocks.textures.set('lobby_hero_skirmisher', PORTRAIT);
    mocks.textures.set('lobby_weapon', WEAPON);
    const h = new LobbyHero();
    h.setCharacter('vanguard');
    h.setCharacter('skirmisher');
    expect(h.view.alpha).toBe(1);
  });
});
