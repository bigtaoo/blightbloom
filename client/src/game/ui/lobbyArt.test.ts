/**
 * The lobby redesign's SHIPPED art (design/10, 2026-09-27), decoded from `client/public/ui/`
 * rather than trusted — the art pipeline's standing rule, because nothing else records
 * whether an import step was actually run on the file that ships.
 *
 *  - the portraits and logos went through `alphaClamp` (generator output has a 250-254 body
 *    plateau and a 1-10 veil) BEFORE `compress` trimmed them, so the trim is tight;
 *  - they ship at the resolution the lobby draws them at, not the generator's 1254-2688 px;
 *  - the painting and the banners are JPEG (opaque — see `uiSkins.ts`), at the aspect the
 *    code assumes: `LobbyBackdrop`'s measured dais position is a fraction of a 16:9 image.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { decodePNG } from '../../../../tools/png-pipeline/pngCodec.mjs';
import { SKY_ROCKS } from './LobbyBackdrop';

interface Img { width: number; height: number; data: Uint8Array }

const UI = new URL('../../../public/ui/', import.meta.url);
const png = (name: string) => decodePNG(readFileSync(new URL(name, UI))) as Img;

/** Width and height off a baseline/progressive JPEG's SOF marker. */
function jpegSize(name: string): { width: number; height: number } {
  const b = readFileSync(new URL(name, UI));
  expect(b[0] === 0xff && b[1] === 0xd8, `${name} is not a JPEG`).toBe(true);
  let i = 2;
  while (i < b.length) {
    const marker = b[i + 1]!;
    const len = b.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc2) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  throw new Error(`${name}: no SOF marker`);
}

const SPRITES: Array<[string, number]> = [
  ['lobby_hero_orb.png', 384],
  ['lobby_hero_skirmisher.png', 384],
  ['lobby_hero_juggernaut.png', 384],
  ['lobby_logo_en.png', 768],
  ['lobby_logo_zh.png', 768],
  // The sky rocks lifted out of the painting, at the painting's own 0.75 (2560 -> 1920).
  ['lobby_rock_a.png', 52],
  ['lobby_rock_b.png', 45],
  ['lobby_rock_c.png', 88],
  // A byte-for-byte copy of weapons/gun_cryobolt.png (LobbyHero's orbiting weapon).
  ['lobby_weapon.png', 160],
];

describe('the lobby portraits and logos', () => {
  it.each(SPRITES)('%s ships clamped, trimmed, and at its drawn resolution', (name, longAxis) => {
    const img = png(name);
    expect(Math.max(img.width, img.height)).toBe(longAxis);
    let veil = 0;
    let opaque = 0;
    let minX = img.width, minY = img.height, maxX = -1, maxY = -1;
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const a = img.data[(y * img.width + x) * 4 + 3]!;
        if (a > 0 && a <= 2) veil++;
        if (a === 255) opaque++;
        if (a > 0) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
      }
    }
    // No sub-perceptual veil survived the clamp (a box downsample can still leave a faint
    // antialiased edge, so this counts only the near-invisible end), and the body is truly
    // opaque rather than the generator's 253 plateau.
    expect(veil / (img.width * img.height)).toBeLessThan(0.002);
    expect(opaque / (img.width * img.height)).toBeGreaterThan(0.3);
    // Trimmed: the art touches all four edges of its canvas (within a texel of downsampling).
    expect(minX).toBeLessThanOrEqual(1);
    expect(minY).toBeLessThanOrEqual(1);
    expect(maxX).toBeGreaterThanOrEqual(img.width - 2);
    expect(maxY).toBeGreaterThanOrEqual(img.height - 2);
  });
});

describe('the sky rocks', () => {
  it.each(SKY_ROCKS.filter((r) => r.lifted).map((r) => [r.key, r.hFrac] as const))(
    '%s ships at the height LobbyBackdrop draws it at, so it is never magnified', (key, hFrac) => {
      // `hFrac` is the rock's height in the painting; the file must be that height at the
      // shipped painting's 1080 rows (within a texel of the resample), or the backdrop would
      // be scaling it up or down against the sky it was cut from.
      expect(Math.abs(png(`${key}.png`).height - hFrac * 1080)).toBeLessThanOrEqual(1);
    },
  );
});

describe('the sky rocks, reused', () => {
  it('draws every open-sky copy no larger than the rock it was cut from', () => {
    // A copy is the same sprite placed again; drawn bigger than its source, it would be the
    // one magnified thing in a painting that is otherwise at its own resolution.
    const lifted = new Map(SKY_ROCKS.filter((r) => r.lifted).map((r) => [r.key, r.hFrac]));
    const copies = SKY_ROCKS.filter((r) => !r.lifted);
    expect(copies.length).toBeGreaterThan(0);
    for (const r of copies) expect(r.hFrac, r.key).toBeLessThanOrEqual(lifted.get(r.key)!);
  });
});

describe('the painting and the route banners', () => {
  it('ships the painting as a 16:9 JPEG, the aspect the dais measurement is a fraction of', () => {
    const { width, height } = jpegSize('lobby_bg.jpg');
    expect([width, height]).toEqual([1920, 1080]);
  });

  it.each(['lobby_card_descend.jpg', 'lobby_card_coop.jpg', 'lobby_card_pvp.jpg'])(
    '%s is a 3:1 banner', (name) => {
      const { width, height } = jpegSize(name);
      expect(width / height).toBeCloseTo(3, 5);
      expect(width).toBe(768);
    },
  );

  it('keeps the whole lobby set inside a fraction of the boot pack', () => {
    // The `lobby` pack is what the player waits for at boot (assetPacks.json); the redesign's
    // art is budgeted at about 1 MB of its 2 MB limit, and this keeps a re-export from quietly
    // shipping the generator's multi-megabyte originals instead.
    const names = [...SPRITES.map(([n]) => n), 'lobby_bg.jpg', 'lobby_card_descend.jpg', 'lobby_card_coop.jpg', 'lobby_card_pvp.jpg'];
    const bytes = names.reduce((n, name) => n + statSync(new URL(name, UI)).size, 0);
    expect(bytes).toBeLessThan(1.1 * 1024 * 1024);
  });
});
