/**
 * `tName()`'s parity net (i18n/index.ts's doc comment) — the test-time replacement for
 * the compile-time exhaustiveness `t()`/`TranslationKey` gets for free from
 * `Translations<typeof en>`. Since content nameKeys are plain runtime strings, nothing
 * stops a locale file from missing one; this walks the REAL catalogs (not a hand-
 * maintained mirror of their ids) and asserts every nameKey they carry actually
 * resolves in every declared locale. Mirrors `i18n.test.ts`'s own "locale parity" test
 * shape (`lookup()`'s documented miss behavior is to return the key itself unchanged,
 * so "resolved" means "not equal to the raw key").
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { tName, resetLocaleForTests, LOCALES } from './index';
import { WEAPON_SPECS, SKIN_DEFS, MATERIAL_DEFS, RUN_BUFFS, FLOOR_CARDS } from '@dd/engine';
import { useLocale } from '../i18n/loadLocale';

beforeEach(() => resetLocaleForTests());

function allContentNameKeys(): string[] {
  return [
    ...Object.values(WEAPON_SPECS).map((s) => s.nameKey),
    ...Object.values(SKIN_DEFS).map((s) => s.nameKey),
    ...Object.values(MATERIAL_DEFS).map((m) => m.nameKey),
    ...Object.values(RUN_BUFFS).map((b) => b.nameKey),
    // Floor cards carry TWO keys each (design/05, ENGINE_VERSION 58) — the description
    // is as player-facing as the name, and is the half that actually says what the card
    // does, so a locale missing it leaves a card that cannot be evaluated.
    ...Object.values(FLOOR_CARDS).flatMap((c) => [c.nameKey, c.descKey]),
  ];
}

describe('tName() content-catalog parity', () => {
  it('every weapon/skin/material/buff/card nameKey resolves in every declared locale', async () => {
    const keys = allContentNameKeys();
    // Guards against a future catalog refactor silently emptying the list out from
    // under this test (an empty `keys` array would make every locale's loop a no-op
    // pass, hiding a real regression rather than catching one).
    expect(keys.length).toBeGreaterThan(0);
    for (const locale of LOCALES) {
      await useLocale(locale);
      for (const key of keys) {
        expect(tName(key)).not.toBe(key);
      }
    }
  });

  it('falls back to the raw key for an uncatalogued id (never throws, never blank)', () => {
    expect(tName('weapon.not-a-real-weapon.name')).toBe('weapon.not-a-real-weapon.name');
  });
});
