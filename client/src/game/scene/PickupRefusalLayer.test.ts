import { describe, it, expect, afterEach } from 'vitest';
import { Container, Text } from 'pixi.js';
import { pxToFp } from '@dd/engine/content/convert';
import type { PickupItem } from '@dd/engine/state/entities';
import { HINT_MS, PickupRefusalLayer } from './PickupRefusalLayer';
import { THEME } from '../theme';
import { resetLocaleForTests } from '../../i18n';
import { useLocale } from '../../i18n/loadLocale';
import type { PickupRefusal } from '../ui/pickupRefusal';

afterEach(() => resetLocaleForTests());

function item(xpx: number, ypx: number): PickupItem {
  return { id: 1, kind: 'energy', gx: pxToFp(xpx), gy: pxToFp(ypx), spawnTick: 0, alive: true };
}

function only(parent: Container): Text {
  expect(parent.children.length).toBe(1);
  return parent.children[0] as Text;
}

describe('PickupRefusalLayer', () => {
  it.each<[PickupRefusal, string, number]>([
    ['hpFull', 'HP full', THEME.colors.pickupHeal],
    ['energyFull', 'Energy full', THEME.colors.pickupEnergy],
    ['shieldFull', 'Shield full', THEME.colors.pickupShield],
    ['noTarget', 'No enemies in range', THEME.colors.pickupEmp],
  ])('%s reads "%s" in that pool\'s colour', (reason, text, color) => {
    const parent = new Container();
    new PickupRefusalLayer(parent).show([{ item: item(100, 100), reason }]);
    const t = only(parent);
    expect(t.text).toBe(text);
    expect(t.style.fill).toBe(color);
  });

  it('speaks the active locale', async () => {
    await useLocale('zh');
    const parent = new Container();
    new PickupRefusalLayer(parent).show([{ item: item(100, 100), reason: 'energyFull' }]);
    expect(only(parent).text).toBe('能量已满');
  });

  it('starts above the drop, rises, fades at the end, and is gone after HINT_MS', () => {
    const parent = new Container();
    const layer = new PickupRefusalLayer(parent);
    layer.show([{ item: item(200, 150), reason: 'hpFull' }]);
    const t = only(parent);
    expect(t.x).toBe(200);
    const y0 = t.y;
    expect(y0).toBeLessThan(150);
    expect(t.alpha).toBe(1);
    layer.update(HINT_MS / 2);
    expect(t.y).toBeLessThan(y0);
    expect(t.alpha).toBe(1);
    layer.update(HINT_MS * 0.4);
    expect(t.alpha).toBeGreaterThan(0);
    expect(t.alpha).toBeLessThan(1);
    expect(layer.count).toBe(1);
    layer.update(HINT_MS * 0.1);
    expect(layer.count).toBe(0);
    expect(parent.children.length).toBe(0);
  });

  it('clear() removes every label at once', () => {
    const parent = new Container();
    const layer = new PickupRefusalLayer(parent);
    layer.show([{ item: item(0, 0), reason: 'hpFull' }, { item: item(50, 0), reason: 'shieldFull' }]);
    expect(layer.count).toBe(2);
    layer.clear();
    expect(layer.count).toBe(0);
    expect(parent.children.length).toBe(0);
  });
});
