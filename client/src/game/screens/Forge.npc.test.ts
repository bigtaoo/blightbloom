/**
 * Forge's Forger-NPC sprite (design/13's "Outpost/hub" NPC gap). Decorative art standing in
 * the wide sheet's side column (`forgeSheet.ts`), which must stay hidden until BOTH its
 * texture exists (uiSkins.ts's non-blocking preload — nothing generated yet just means
 * `getUiTexture` returns undefined) AND the column has room left for it — never drawn over
 * the compare card above it or the store entry below.
 * `render/uiSkins.ts` is mocked here so the "texture exists" branch is actually
 * reachable under vitest — Forge.test.ts's own suite never registers one, so it only
 * ever exercises the "no texture" fallback.
 */
import { describe, it, expect, vi } from 'vitest';
import { DOMAdapter, Texture, TextureSource, type Sprite } from 'pixi.js';
import { Forge } from './Forge';
import { NPC_MIN_H, SIDE_W, SIDE_X, layoutForgeSheet, type ForgeSheetParts } from './forgeSheet';
import { defaultMetaState } from '../../meta';

const mocks = vi.hoisted(() => ({ npcTexture: undefined as Texture | undefined }));

vi.mock('../../render/uiSkins', () => ({
  getUiTexture: (key: string) => (key === 'npc_forger' ? mocks.npcTexture : undefined),
}));

// Same fake-canvas seam Forge.test.ts installs — render() reads Text.height to flow
// its layout, which needs a real 2D context this repo's plain-node vitest lacks.
DOMAdapter.set({
  ...DOMAdapter.get(),
  createCanvas: (width?: number, height?: number) => {
    const ctx = {
      font: '',
      measureText(text: string) {
        const m = /(\d+(?:\.\d+)?)px/.exec(this.font as string);
        const fontSize = m ? parseFloat(m[1]!) : 10;
        const w = text.length * fontSize * 0.6;
        return { width: w, actualBoundingBoxAscent: fontSize * 0.8, actualBoundingBoxDescent: fontSize * 0.2 };
      },
    };
    return { width: width ?? 0, height: height ?? 0, getContext: () => ctx } as unknown as HTMLCanvasElement;
  },
  getCanvasRenderingContext2D: () => class {} as unknown as typeof CanvasRenderingContext2D,
});

function npcSpriteOf(f: Forge): Sprite {
  return (f as unknown as { npcSprite: Sprite }).npcSprite;
}

describe('Forge — Forger NPC visibility', () => {
  it('stays hidden when no texture has been generated yet, even on a wide viewport', () => {
    mocks.npcTexture = undefined;
    const f = new Forge();
    f.render(defaultMetaState(), 1280, 720);
    expect(npcSpriteOf(f).visible).toBe(false);
  });

  it('shows once a texture exists and the viewport is wide enough beside the row column', () => {
    mocks.npcTexture = new Texture({ source: new TextureSource({ width: 100, height: 140 }) });
    const f = new Forge();
    f.render(defaultMetaState(), 1280, 720);
    const sprite = npcSpriteOf(f);
    expect(sprite.visible).toBe(true);
    expect(sprite.texture).toBe(mocks.npcTexture);
  });

  it('hides again in the narrow layout even though the texture exists — no column to stand in', () => {
    mocks.npcTexture = new Texture({ source: new TextureSource({ width: 100, height: 140 }) });
    const f = new Forge();
    f.render(defaultMetaState(), 700, 1600); // too narrow for the wide sheet
    expect(npcSpriteOf(f).visible).toBe(false);
  });

  it('stands in the side column, between the compare card and the store entry', () => {
    mocks.npcTexture = new Texture({ source: new TextureSource({ width: 100, height: 140 }) });
    const f = new Forge();
    f.storeEnabled = true;
    f.render(defaultMetaState(), 1280, 720);
    const sprite = npcSpriteOf(f);
    expect(sprite.visible).toBe(true);
    expect(sprite.x).toBe(SIDE_X + SIDE_W / 2);
    const p = f as unknown as { storeCaption: { y: number }; compareCard: { view: { y: number; height: number } } };
    // Anchored at its feet, so `y` is the bottom edge and `y - drawn height` the top.
    expect(sprite.y).toBeLessThan(p.storeCaption.y);
    expect(sprite.y - 140 * sprite.scale.y).toBeGreaterThanOrEqual(p.compareCard.view.y + p.compareCard.view.height);
    expect(sprite.scale.x).toBe(sprite.scale.y); // uniform, not stretched
  });

  it('never grows past its height cap, however much room the column has', () => {
    mocks.npcTexture = new Texture({ source: new TextureSource({ width: 100, height: 140 }) });
    const f = new Forge(); // no store entry: the most room the column ever has
    f.render(defaultMetaState(), 1280, 720);
    expect(npcSpriteOf(f).scale.y).toBeCloseTo(150 / 140, 5);
  });

  it('gives way when the column above it has grown too tall to leave it room', () => {
    mocks.npcTexture = new Texture({ source: new TextureSource({ width: 100, height: 140 }) });
    const f = new Forge();
    f.render(defaultMetaState(), 1280, 720);
    const parts = (f as unknown as { parts(): ForgeSheetParts }).parts();
    // A carrying list long enough to eat the column: whatever room is left is under the floor.
    parts.carryingText.text = Array.from({ length: 12 }, () => 'Repeater').join('\n');
    layoutForgeSheet(parts, true);
    expect(npcSpriteOf(f).visible).toBe(false);
    expect(NPC_MIN_H).toBeGreaterThan(0);
  });
});
