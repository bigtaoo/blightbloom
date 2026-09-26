import { describe, it, expect, afterEach } from 'vitest';
import { Container, Sprite, Texture, TextureSource } from 'pixi.js';
import { DamageNumbers, DAMAGE_DIGITS_KEY } from './DamageNumbers';
import { DAMAGE_DIGIT_ATLAS as ATLAS, DAMAGE_DIGITS_PATH } from '../../render/damageDigitAtlas';
import { UI_ASSETS } from '../../render/uiSkins';
import { qualityProfile, resetActiveQuality, setActiveQuality } from '../../render/quality';
import { BANG_GLYPH, CRIT_SCALE, LIFE_MS, magnitudeScale, NUMBER_PX, PLUS_GLYPH, POP_MS, POP_SCALE, DRIFT_PX } from './damageNumberModel';

// Sprites and containers only, like `Particles.test.ts` — no renderer is needed to build or
// place them. The sheet is a blank source the size the glyph table describes, so every frame
// the view cuts out of it is in bounds.
function sheet(): Texture {
  const w = ATLAS.frameX.at(-1)! + ATLAS.cellW + ATLAS.frameY;
  return new Texture({ source: new TextureSource({ width: w, height: ATLAS.cellH + 2 * ATLAS.frameY }) });
}

function numbers(): { dn: DamageNumbers; views: () => Container<Sprite>[] } {
  const src = sheet();
  const dn = new DamageNumbers(() => src);
  return { dn, views: () => dn.view.children as Container<Sprite>[] };
}

/** The glyphs a view currently shows, read back off the sprite frames. */
function shown(v: Container<Sprite>): string {
  const marks: Record<number, string> = { [ATLAS.plus]: '+', [ATLAS.bang]: '!' };
  return v.children
    .filter((s) => s.visible)
    .map((s) => {
      const i = ATLAS.frameX.indexOf(s.texture.frame.x);
      return marks[i] ?? String(i);
    })
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

  it('the pure model names the same "+" and "!" frames the generated atlas does', () => {
    expect(PLUS_GLYPH).toBe(ATLAS.plus);
    expect(BANG_GLYPH).toBe(ATLAS.bang);
    expect(ATLAS.frameX).toHaveLength(12); // ten digits and both marks are really on the sheet
    expect(ATLAS.bangAdvance).toBeLessThan(ATLAS.advance);
  });

  it('prints a crit as "N!", the "!" packed against the digits, and bigger', () => {
    const { dn, views } = numbers();
    dn.spawn(7, 48, 0xffb020, 0, 0, 'crit');
    dn.spawn(8, 48, 0xffb020, 0, 0);
    dn.update(POP_MS, 1);
    const [crit, plain] = views();
    expect(shown(crit!)).toBe('48!');
    const half = (2 * ATLAS.advance + ATLAS.bangAdvance) / 2;
    expect(crit!.children.map((s) => s.x)).toEqual([
      -half + ATLAS.advance / 2, -half + ATLAS.advance * 1.5, half - ATLAS.bangAdvance / 2,
    ]);
    expect(crit!.scale.x).toBeCloseTo(plain!.scale.x * CRIT_SCALE);
  });

  it('prints a heal as "+N" at the plain size', () => {
    const { dn, views } = numbers();
    dn.spawn(7, 12, 0x68d391, 0, 0, 'heal');
    dn.update(POP_MS, 1);
    const [v] = views();
    expect(shown(v!)).toBe('+12');
    expect(v!.children.map((s) => s.x)).toEqual([-ATLAS.advance, 0, ATLAS.advance]);
    expect(v!.scale.x).toBeCloseTo((NUMBER_PX / ATLAS.cellH) * magnitudeScale(12));
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
