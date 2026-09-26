/**
 * The shop counter panel (design/05 "Shops", ENGINE_VERSION 64).
 *
 * The engine suite proves `ShopSystem` refuses what it should. What it cannot see is whether a
 * player was ever told — and a refusal nobody can predict reads as a broken button, which is
 * the single most likely way this feature fails in front of someone. So the assertions here are
 * about what a row SAYS before it is tapped: the price comes off the offer the sim will charge,
 * an unaffordable row looks unaffordable, and a sold row stays on the counter saying so instead
 * of quietly vanishing.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { Shop, ShopOffer } from '@dd/engine';
import type { Fp } from '@dd/engine';
import { ShopPrompt } from './ShopPrompt';
import { resetLocaleForTests, t } from '../../i18n';
import { useLocale } from '../../i18n/loadLocale';

afterEach(() => resetLocaleForTests());

const fp = (n: number) => n as Fp;

const offer = (over: Partial<ShopOffer> = {}): ShopOffer => ({
  id: 1,
  kind: 'heal',
  price: 12,
  sold: false,
  ...over,
});

const shop = (stock: ShopOffer[]): Shop => ({ id: 1, roomId: 'r1', gx: fp(0), gy: fp(0), stock });

function privateOf(p: ShopPrompt) {
  return p as unknown as {
    titleText: { text: string };
    rows: Array<{ onTap: (() => void) | null; label: { text: string } }>;
    priceLabels: Array<{ text: string }>;
  };
}

describe('ShopPrompt — visibility follows the counter in reach', () => {
  it('is hidden with no shop in reach', () => {
    const p = new ShopPrompt();
    p.update(undefined, 100);
    expect(p.view.visible).toBe(false);
    expect(p.isOpen).toBe(false);
  });

  it('opens with one row per line of stock', () => {
    const p = new ShopPrompt();
    p.update(shop([offer({ id: 1 }), offer({ id: 2 }), offer({ id: 3 })]), 100);
    expect(p.isOpen).toBe(true);
    expect(privateOf(p).rows).toHaveLength(3);
  });

  it('closes again when the player walks off the mat', () => {
    // There is no close button, deliberately — walking off IS the dismissal, and the mat is
    // drawn (`scene/ShopLayer.ts`). If this stopped working there would be no way to close it.
    const p = new ShopPrompt();
    p.update(shop([offer()]), 100);
    p.update(undefined, 100);
    expect(p.isOpen).toBe(false);
  });
});

describe('ShopPrompt — what a row says before it is tapped', () => {
  it('shows the price the SIM will charge, off the offer itself', () => {
    // Never re-derived from `SHOP_PRICES`: the offer is what `ShopSystem` reads, so a panel
    // computing its own number would be a second source of truth for a value the player is
    // about to spend.
    const p = new ShopPrompt();
    p.update(shop([offer({ price: 45 })]), 100);
    expect(privateOf(p).priceLabels[0]!.text).toContain('45');
  });

  it('draws an unaffordable row differently from one you can pay for', () => {
    const p = new ShopPrompt();
    p.update(shop([offer({ price: 45 })]), 100);
    const rich = privateOf(p).priceLabels[0]!;
    const richStyle = (rich as unknown as { style: { fill: number } }).style.fill;

    p.update(shop([offer({ price: 45 })]), 10);
    const poorStyle = (privateOf(p).priceLabels[0]! as unknown as { style: { fill: number } }).style.fill;
    expect(poorStyle).not.toBe(richStyle);
  });

  it('rebuilds when the WALLET changes even though the counter did not', () => {
    // The subtle half of the cache key. A coin picked up off the floor changes affordability
    // with the shop's own state untouched, so a key built from the stock alone would leave
    // every row drawn as unaffordable until the player walked away and came back.
    const p = new ShopPrompt();
    const s = shop([offer({ price: 45 })]);
    p.update(s, 10);
    const poor = privateOf(p).priceLabels[0]!;
    p.update(s, 100);
    expect(privateOf(p).priceLabels[0]).not.toBe(poor);
  });

  it('keeps a SOLD line on the counter, saying so', () => {
    // It stays rather than vanishing because that is what tells a player who just watched a
    // teammate buy it where it went. A row that disappeared would read as a bug.
    const p = new ShopPrompt();
    p.update(shop([offer({ sold: true })]), 100);
    expect(privateOf(p).rows).toHaveLength(1);
    expect(privateOf(p).rows[0]!.label.text).toBe(t('hud.shop.sold'));
    expect(privateOf(p).priceLabels).toHaveLength(0); // a sold line has no price to pay
  });

  it('names a weapon by its catalogue name and a buff by its translated one', () => {
    // design/17's rule, applied per kind: a weapon id is data and stays untranslated; a buff's
    // name is a `nameKey` because it is prose.
    const p = new ShopPrompt();
    p.update(shop([offer({ id: 1, kind: 'weapon', weaponId: 'repeater' }), offer({ id: 2, kind: 'buff', buffId: 'dmg_up' })]), 500);
    expect(privateOf(p).rows[0]!.label.text.toLowerCase()).toContain('repeat');
    expect(privateOf(p).rows[1]!.label.text).toBe(t('buff.dmg_up.name' as never));
  });

  it('puts the wallet in the title, so the number you spend and the number you have are together', () => {
    const p = new ShopPrompt();
    p.update(shop([offer()]), 137);
    expect(privateOf(p).titleText.text).toContain('137');
  });
});

describe('ShopPrompt — a tap is the purchase', () => {
  it('routes a row tap to onBuy with THAT row’s offer id', () => {
    const p = new ShopPrompt();
    const bought: number[] = [];
    p.onBuy = (id) => bought.push(id);
    p.update(shop([offer({ id: 11 }), offer({ id: 22 })]), 100);
    privateOf(p).rows[1]!.onTap?.();
    expect(bought).toEqual([22]);
  });

  it('still routes a tap on a row the player cannot afford', () => {
    // Deliberate: the sim refuses it and the caller plays `ui.denied` off the refusal. A row
    // made un-tappable could not tell you WHY it was dead, which is the whole job of drawing
    // three states instead of two.
    const p = new ShopPrompt();
    const bought: number[] = [];
    p.onBuy = (id) => bought.push(id);
    p.update(shop([offer({ id: 7, price: 45 })]), 1);
    privateOf(p).rows[0]!.onTap?.();
    expect(bought).toEqual([7]);
  });
});

describe('ShopPrompt — locale', () => {
  it('rebuilds on a language change even though the shop did not move', async () => {
    const p = new ShopPrompt();
    const s = shop([offer()]);
    p.update(s, 100);
    const before = privateOf(p).rows[0]!.label.text;
    await useLocale('zh');
    p.update(s, 100);
    expect(privateOf(p).rows[0]!.label.text).not.toBe(before);
  });
});

describe('ShopPrompt — a buff line is a pick-one-of-three (ROADMAP B2, 2026-09-26)', () => {
  const buffLine = (over: Partial<ShopOffer> = {}): ShopOffer =>
    offer({
      id: 10,
      kind: 'buff',
      price: 40,
      choices: [
        { id: 11, buffId: 'dmg_up' },
        { id: 12, buffId: 'rof_up' },
        { id: 13, buffId: 'cell_up' },
      ],
      ...over,
    });

  it('draws a header carrying the one price, then one row per choice', () => {
    const p = new ShopPrompt();
    p.update(shop([buffLine()]), 100);
    const { rows, priceLabels } = privateOf(p);
    expect(rows).toHaveLength(4);
    expect(rows[0]!.label.text).toBe(t('hud.shop.buffPick'));
    expect(priceLabels.map((l) => l.text)).toEqual([t('hud.shop.price', { price: 40 })]); // once, not per choice
  });

  it('a tap on a choice buys THAT choice — the header buys nothing', () => {
    const p = new ShopPrompt();
    const bought: number[] = [];
    p.onBuy = (id) => bought.push(id);
    p.update(shop([buffLine()]), 100);
    const { rows } = privateOf(p);
    expect(rows[0]!.onTap).toBeNull();
    rows[3]!.onTap!();
    rows[1]!.onTap!();
    expect(bought).toEqual([13, 11]);
  });

  it('names each choice by its buff', () => {
    const p = new ShopPrompt();
    p.update(shop([buffLine()]), 100);
    const labels = privateOf(p).rows.slice(1).map((r) => r.label.text);
    expect(new Set(labels).size).toBe(3);
    for (const l of labels) expect(l).not.toMatch(/^(dmg_up|rof_up|cell_up)$/); // translated, not the raw id
  });

  it('collapses to one SOLD row once the line is bought', () => {
    const p = new ShopPrompt();
    p.update(shop([buffLine({ sold: true, buffId: 'rof_up' })]), 100);
    const { rows, priceLabels } = privateOf(p);
    expect(rows.map((r) => r.label.text)).toEqual([t('hud.shop.sold')]);
    expect(priceLabels).toEqual([]);
  });

  it('sits beside ordinary lines without shifting their taps', () => {
    const p = new ShopPrompt();
    const bought: number[] = [];
    p.onBuy = (id) => bought.push(id);
    p.update(shop([offer({ id: 1 }), buffLine(), offer({ id: 2 })]), 100);
    const { rows } = privateOf(p);
    expect(rows).toHaveLength(6);
    rows[0]!.onTap!();
    rows[5]!.onTap!();
    expect(bought).toEqual([1, 2]);
  });
});
