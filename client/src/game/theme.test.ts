/**
 * theme.ts is pure colour-derivation math. `mixHex` became an export on 2026-08-18 (the
 * standing-wall pass needed it to derive stone tones outside this file), so it is now tested
 * directly as well as through `biomePalette`'s derived fields — the exact hex values below are
 * computed with the SAME lerp-per-channel-then-round formula the source uses (base +
 * (tint-base)*amount, rounded, one channel at a time), so a regression in that math (wrong
 * channel order, wrong rounding, wrong amount) changes these constants.
 */
import { describe, it, expect } from 'vitest';
import { CHAPTERS, CHAPTER_ORDER, ENDLESS_DUNGEON, WEAPON_SIM_BY_ID, type GameState, type WeaponSimSpec } from '@dd/engine';
import { THEME, ELEMENT_COLORS, elementColor, biomePalette, biomeElementOf, floorBiomeId, rarityColor, mixHex } from './theme';

describe('elementColor', () => {
  it('maps each elemental damage type to its status-fx hue', () => {
    expect(elementColor('fire')).toBe(THEME.colors.statusBurn);
    expect(elementColor('ice')).toBe(THEME.colors.statusChill);
    expect(elementColor('lightning')).toBe(THEME.colors.statusShock);
    expect(elementColor('poison')).toBe(THEME.colors.statusPoison);
  });

  it('falls back to the locked neutral hex for physical (deliberately absent from ELEMENT_COLORS)', () => {
    expect(ELEMENT_COLORS.physical).toBeUndefined();
    expect(elementColor('physical')).toBe(0xe2e8f0);
  });
});

describe('biomeElementOf', () => {
  it('maps each chapter biome id to its element', () => {
    expect(biomeElementOf('ember')).toBe('fire');
    expect(biomeElementOf('frost')).toBe('ice');
  });

  it('gives every chapter in the engine catalog a real element, never the neutral fallback', () => {
    // The compile-time `satisfies` guards the table's keys; this guards what a run DRAWS — a
    // chapter landing on 'neutral' would ship as the flat grey palette with no swatches.
    for (const id of CHAPTER_ORDER) {
      if (id === 'endless') continue; // no biome of its own: see the next test
      expect(biomeElementOf(CHAPTERS[id].config.biomeId), id).not.toBe('neutral');
    }
  });

  it('draws each endless floor in the element of the chapter it borrows the floor from', () => {
    const at = (floorIndex: number) =>
      biomeElementOf(floorBiomeId({ dungeonConfig: ENDLESS_DUNGEON, floorIndex } as Pick<GameState, 'dungeonConfig' | 'floorIndex'>));
    expect([0, 4, 5, 10, 15, 19, 20].map(at)).toEqual(['fire', 'fire', 'ice', 'lightning', 'poison', 'poison', 'fire']);
    expect(floorBiomeId({ dungeonConfig: undefined, floorIndex: 3 })).toBeUndefined();
    expect(floorBiomeId({ dungeonConfig: CHAPTERS.frost.config, floorIndex: 3 })).toBe('frost');
  });

  it('falls back to neutral for undefined (outside dungeon mode) and any unknown id', () => {
    expect(biomeElementOf(undefined)).toBe('neutral');
    expect(biomeElementOf('not-a-real-biome')).toBe('neutral');
  });
});

describe('biomePalette — neutral (unchanged existing palette)', () => {
  it('undefined and any unknown biomeId both resolve to the exact THEME.colors palette', () => {
    const undef = biomePalette(undefined);
    const unknown = biomePalette('not-a-real-biome');
    expect(undef).toEqual(unknown);
    expect(undef.ground).toBe(THEME.colors.ground);
    expect(undef.gridLine).toBe(THEME.colors.gridLine);
    expect(undef.pillar).toBe(THEME.colors.pillar);
    expect(undef.pillarTop).toBe(THEME.colors.pillarTop);
    expect(undef.wall).toBe(THEME.colors.wall);
    expect(undef.wallEdge).toBe(THEME.colors.wallEdge);
  });

  it('void is ground mixed 45% toward black (never toward the bright FX neutral)', () => {
    // mixHex(ground, 0x000000, 0.45), computed channel-by-channel: ground=0x161a24
    // (22,26,36) -> round(22*0.55)=12=0x0c, round(26*0.55)=14=0x0e, round(36*0.55)=20=0x14
    expect(biomePalette(undefined).void).toBe(0x0c0e14);
  });
});

describe('biomePalette — ember (fire-tinted derivation, design/13)', () => {
  const p = biomePalette('ember');

  it('mixes each neutral field toward statusBurn by its documented amount, exactly', () => {
    // Values computed with the source's own mix(b,t)=round(b+(t-b)*amount) formula,
    // per channel, against THEME.colors.statusBurn (0xff7043) — see file header.
    expect(p.ground).toBe(0x2d2327); // mixHex(ground, statusBurn, 0.10)
    expect(p.gridLine).toBe(0x3e3034); // mixHex(gridLine, statusBurn, 0.14)
    expect(p.pillar).toBe(0x564850); // mixHex(pillar, statusBurn, 0.14)
    expect(p.pillarTop).toBe(0x6c5b63); // mixHex(pillarTop, statusBurn, 0.18)
    expect(p.wall).toBe(0x483a40); // mixHex(wall, statusBurn, 0.14)
    expect(p.wallEdge).toBe(0x735c61); // mixHex(wallEdge, statusBurn, 0.22)
    expect(p.void).toBe(0x241819); // mixHex(neutral.void, statusBurn, 0.10)
  });

  it('never mutates or aliases the neutral palette object', () => {
    const neutral = biomePalette(undefined);
    expect(p).not.toBe(neutral);
    expect(p.ground).not.toBe(neutral.ground);
  });
});

describe('rarityColor', () => {
  const BASE = WEAPON_SIM_BY_ID.blaster!;
  function withRarity(rarity: WeaponSimSpec['rarity']): WeaponSimSpec {
    return { ...BASE, rarity };
  }

  it('maps every tier to its design/14 white/blue/purple/orange/gold hex', () => {
    expect(rarityColor(withRarity('common'))).toBe(0xe2e8f0);
    expect(rarityColor(withRarity('fine'))).toBe(0x63b3ed);
    expect(rarityColor(withRarity('epic'))).toBe(0xb794f4);
    expect(rarityColor(withRarity('legend'))).toBe(0xf6ad55);
    expect(rarityColor(withRarity('legendary'))).toBe(0xf6e05e);
  });
});

describe('mixHex', () => {
  it('returns the base at amount 0 and the tint at amount 1', () => {
    expect(mixHex(0x102030, 0xffffff, 0)).toBe(0x102030);
    expect(mixHex(0x102030, 0xffffff, 1)).toBe(0xffffff);
  });

  it('lerps each channel independently, rounding per channel', () => {
    // 0x10 -> 0x20 is 16 -> 32; halfway is 24 = 0x18. Doing this on the packed integer instead
    // of per channel would bleed one channel into the next.
    expect(mixHex(0x101010, 0x202020, 0.5)).toBe(0x181818);
    expect(mixHex(0xff0000, 0x0000ff, 0.5)).toBe(0x800080);
  });

  it('rounds rather than truncating', () => {
    // 0 -> 1 at 0.5 rounds to 1; truncation would give 0 and quietly darken every derived tone.
    expect(mixHex(0x000000, 0x010101, 0.5)).toBe(0x010101);
  });

  it('is the same function the standing-wall stone tones are derived with', () => {
    // `wallRender.buildPillarBody` folds a minority share of the biome's wall colour into its
    // own charcoal-navy base. That only stays a MINORITY share if the amount is applied to the
    // tint and not to the base — a swapped argument order would make pillars take the palette's
    // hue almost entirely, which is the exact bug the pillar rewrite existed to remove.
    const base = 0x424954;
    const biome = 0x483a40;
    const mixed = mixHex(base, biome, 0.16);
    const dist = (a: number, b: number) => Math.abs(((a >> 16) & 0xff) - ((b >> 16) & 0xff));
    expect(dist(mixed, base)).toBeLessThan(dist(mixed, biome));
  });
});
