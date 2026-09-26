import { describe, it, expect, afterEach } from 'vitest';
import { Container, Sprite, Texture, TextureSource } from 'pixi.js';
import { DamageNumbers, DAMAGE_DIGITS_KEY } from './DamageNumbers';
import { DAMAGE_DIGIT_ATLAS as ATLAS, DAMAGE_DIGITS_PATH } from '../../render/damageDigitAtlas';
import { UI_ASSETS } from '../../render/uiSkins';
import { qualityProfile, resetActiveQuality, setActiveQuality } from '../../render/quality';
import { LIFE_MS, NUMBER_PX, POP_MS, POP_SCALE, DRIFT_PX } from './damageNumberModel';

// Sprites and containers only, like `Particles.test.ts` — no renderer is needed to build or
// place them. The sheet is a blank source the size the glyph table describes, so every frame
// the view cuts out of it is in bounds.
function sheet(): Texture {
  const w = ATLAS.frameX[9]! + ATLAS.cellW + ATLAS.frameY;
  return new Texture({ source: new TextureSource({ width: w, height: ATLAS.cellH + 2 * ATLAS.frameY }) });
}

function numbers(): { dn: DamageNumbers; views: () => Container<Sprite>[] } {
  const src = sheet();
  const dn = new DamageNumbers(() => src);
  return { dn, views: () => dn.view.children as Container<Sprite>[] };
}

/** The digits a view currently shows, read back off the sprite frames. */
function shown(v: Container<Sprite>): string {
  return v.children
    .filter((s) => s.visible)
    .map((s) => ATLAS.frameX.indexOf(s.texture.frame.x))
    .join('');
}

afterEach(() => resetActiveQuality());

describe('DamageNumbers', () => {
  it('loads its sheet from the UI art table, under the key and path the generator writes', () => {
    expect(UI_ASSETS[DAMAGE_DIGITS_KEY]).toBe(DAMAGE_DIGITS_PATH);
  });

  it('reads the real UI art cache by default — empty under vitest, so nothing is drawn', () => {
    const dn = new DamageNumbers();
    dn.spawn(1, 12, 0xffffff, 0, 0);
    expect(dn.count).toBe(0);
  });

  it('draws nothing while the atlas has not loaded, then works once it has', () => {
    let tex: Texture | undefined;
    const dn = new DamageNumbers(() => tex);
    dn.spawn(1, 12, 0xffffff, 0, 0);
    expect(dn.count).toBe(0);
    tex = sheet();
    dn.spawn(1, 12, 0xffffff, 0, 0);
    expect(dn.count).toBe(1);
  });

  it('lays a number out as one tinted sprite per digit, centred on the anchor', () => {
    const { dn, views } = numbers();
    dn.spawn(7, 305, 0xff8800, 40, 60);
    dn.update(0, 1);
    const [v] = views();
    expect(shown(v!)).toBe('305');
    expect(v!.children.map((s) => s.tint)).toEqual([0xff8800, 0xff8800, 0xff8800]);
    expect(v!.children.map((s) => s.x)).toEqual([-ATLAS.advance, 0, ATLAS.advance]);
  });

  it('re-lays the digits in place when a hit merges into it', () => {
    const { dn, views } = numbers();
    dn.spawn(7, 38, 0xffffff, 0, 0);
    dn.update(16, 1);
    dn.spawn(7, 3, 0xffffff, 0, 0);
    dn.update(16, 1);
    expect(views()).toHaveLength(1);
    expect(shown(views()[0]!)).toBe('41');
  });

  it('places a number in SCREEN px: scale and drift divide by the zoom', () => {
    const { dn, views } = numbers();
    dn.spawn(1, 5, 0xffffff, 100, 200);
    dn.update(POP_MS, 1);
    const flat = views()[0]!;
    const atOne = { x: flat.x, s: flat.scale.x };
    dn.clear();
    dn.spawn(2, 5, 0xffffff, 100, 200);
    dn.update(POP_MS, 4);
    const zoomed = views()[0]!;
    expect(atOne.s).toBeCloseTo(NUMBER_PX / ATLAS.cellH);
    expect(zoomed.scale.x).toBeCloseTo(atOne.s / 4);
    expect(zoomed.x - 100).toBeCloseTo((DRIFT_PX[1]!) / 4);
    expect(zoomed.y).toBeLessThan(200);
  });

  it('pops on spawn and treats a zoom of 0 as 1 rather than dividing by it', () => {
    const { dn, views } = numbers();
    dn.spawn(1, 5, 0xffffff, 0, 0);
    dn.update(0, 0);
    expect(views()[0]!.scale.x).toBeCloseTo((NUMBER_PX / ATLAS.cellH) * (1 + POP_SCALE));
  });

  it('removes a number at the end of its life and reuses its view, sprites and all', () => {
    const { dn, views } = numbers();
    dn.spawn(1, 1234, 0xffffff, 0, 0);
    dn.update(0, 1);
    const v = views()[0]!;
    dn.update(LIFE_MS, 1);
    expect(dn.count).toBe(0);
    expect(views()).toHaveLength(0);
    dn.spawn(2, 7, 0xffffff, 0, 0);
    dn.update(0, 1);
    expect(views()[0]).toBe(v);
    expect(v.children).toHaveLength(4);
    expect(shown(v)).toBe('7');
  });

  it('caps the live count at the active quality tier', () => {
    setActiveQuality('low');
    const cap = qualityProfile('low').damageNumbers;
    const { dn, views } = numbers();
    for (let t = 0; t < cap + 5; t++) dn.spawn(t, 9, 0xffffff, 0, 0);
    expect(dn.count).toBe(cap);
    expect(views()).toHaveLength(cap);
  });

  it('trims down at once when the tier drops mid-fight', () => {
    setActiveQuality('high');
    const { dn, views } = numbers();
    for (let t = 0; t < qualityProfile('high').damageNumbers; t++) dn.spawn(t, 9, 0xffffff, 0, 0);
    setActiveQuality('low');
    dn.update(1, 1);
    expect(dn.count).toBe(qualityProfile('low').damageNumbers);
    expect(views()).toHaveLength(qualityProfile('low').damageNumbers);
  });

  it('draws nothing for a hit that rounds to 0', () => {
    const { dn, views } = numbers();
    dn.spawn(1, 0.3, 0xffffff, 0, 0);
    expect(dn.count).toBe(0);
    expect(views()).toHaveLength(0);
  });

  it("keeps a settled number's sprites between frames — only a changed value re-lays them", () => {
    const { dn, views } = numbers();
    dn.spawn(1, 42, 0xffffff, 0, 0);
    dn.update(16, 1);
    const sprites = [...views()[0]!.children];
    sprites[0]!.tint = 0x123456; // a re-layout would repaint this
    dn.update(16, 1);
    expect(views()[0]!.children).toEqual(sprites);
    expect(sprites[0]!.tint).toBe(0x123456);
  });

  it('clear empties the screen for a new run', () => {
    const { dn, views } = numbers();
    dn.spawn(1, 5, 0xffffff, 0, 0);
    dn.spawn(2, 5, 0xffffff, 0, 0);
    dn.clear();
    expect(dn.count).toBe(0);
    expect(views()).toHaveLength(0);
  });
});
