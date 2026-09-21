import { Container, Text } from 'pixi.js';
import { WEAPON_SIM_BY_ID, RUN_BUFFS, type Shop, type ShopOffer } from '@dd/engine';
import { getWeaponTexture } from '../../render/weaponSkins';
import { rarityColor, THEME } from '../theme';
import { Panel, Button } from './widgets';
import { t, getLocale } from '../../i18n';

const ROW_W = 250;
const ROW_H = 34;
/** Row label font, and the width a label is wrapped to. The lane is what is left of the row
 *  once the icon chip on the left and the price on the right have taken theirs — a buff row
 *  in Polish ("Zwiększona szansa na trafienie krytyczne") measures 312px against a 250px row
 *  and ran straight through the price and out of the panel until 2026-09-21. Exported for
 *  `hudLabelFit.test.ts`'s locale sweep. */
export const ROW_FONT = 13;
export const ROW_TEXT_W = 160;
const ROW_GAP = 6;
const PAD = 10;
const HEADER_H = 30;

/**
 * The shop counter panel (design/05 "Shops", ENGINE_VERSION 64).
 *
 * Deliberately the same object as `WeaponPickupPrompt` next door, down to the non-blocking
 * contract: shown whenever the seat is standing on a counter's mat, one row per line of stock,
 * and **tapping a row IS the purchase** — `onBuy` routes to `CommandBuilder.requestShopBuy`,
 * a one-shot latch that becomes `PlayerCommand.shopBuyId`. `ShopSystem` does the real,
 * authoritative check. That symmetry is the point: the game already taught "a list of things
 * in reach, tap one" for floor weapons, and a shop is that verb with a price on it.
 *
 * No modal, no pause — lockstep cannot stop for one player (design/06), which is also why
 * there is no close button here: unlike the weapon panel there is nothing to dismiss, because
 * walking off the mat closes it and the mat is drawn (`scene/ShopLayer.ts`).
 *
 * ## What a row has to say before it is tapped
 *
 * Three states, and they are three because a refusal a player cannot predict reads as a broken
 * button:
 *
 *   - **affordable** — normal, tappable.
 *   - **too expensive** — dimmed fill and a dimmed price. Still tappable: the sim refuses it
 *     and `Button`'s default `ui.tap` would be a lie, so these rows go `'silent'` and the
 *     caller plays `ui.denied` off the refusal instead. (Making it un-tappable was the
 *     alternative and it is worse — a dead row cannot tell you *why* it is dead.)
 *   - **sold** — struck through in the SOLD colour, label replaced. It stays on the counter
 *     rather than vanishing, which is what tells a player who just watched a teammate buy it
 *     where it went.
 *
 * Prices come off the offer, never off `SHOP_PRICES`: the offer is what the sim will charge,
 * and a panel that re-derived the number would be a second source of truth for it.
 */
export class ShopPrompt {
  readonly view = new Container();
  private readonly panel = new Panel({ radius: 10, color: 0x0b0e14, alpha: 0.9, borderColor: 0x4c566a, borderAlpha: 0.55 });
  private readonly titleText: Text;
  private rows: Button[] = [];
  private priceLabels: Text[] = [];
  // Rebuild only when something a row DRAWS changes — the same redraw-on-key-change convention
  // `WeaponPickupPrompt`/`WeaponCard` follow. The key carries the wallet as well as the stock,
  // because affordability is drawn and a coin picked up off the floor changes it with the
  // counter untouched.
  private lastKey = ' '; // sentinel, guaranteed to differ from the first real key

  onBuy: ((offerId: number) => void) | null = null;
  /** Fired the instant a press LANDS anywhere on this panel. Same contract, same reason, and
   *  the same capture-phase registration as `WeaponPickupPrompt.onPressStart`: WebInput's raw
   *  `mousedown` sets `firing` independent of what a Pixi button consumed, so without this a
   *  tap on a row also fires the active weapon. */
  onPressStart: (() => void) | null = null;

  get isOpen(): boolean {
    return this.view.visible;
  }

  constructor() {
    this.titleText = new Text({
      text: '',
      style: { fill: THEME.colors.pickupCoin, fontSize: 13, fontFamily: 'monospace', fontWeight: 'bold', padding: 6 },
    });
    this.titleText.position.set(PAD, 8);
    this.titleText.eventMode = 'none'; // decoration — the press belongs to the panel

    this.view.addChild(this.panel.view, this.titleText);
    this.view.visible = false;
    // `static` so a press on the chrome BETWEEN rows lands on the panel's own background and
    // is swallowed on the same terms as a press on a row (Pixi only notifies a listener on a
    // container that `isInteractive()`).
    this.view.eventMode = 'static';
    // `on('pointerdowncapture')` rather than the DOM-shaped `addEventListener`: the latter
    // arrives with the events MIXIN, installed only once a browser `Application` has
    // initialised, so a panel constructed in a headless test would throw on it.
    this.view.on('pointerdowncapture', () => this.onPressStart?.());
  }

  /** @param shop the counter in reach, or undefined when the seat is not standing at one.
   *  @param coins the LOCAL seat's wallet — affordability is per-seat (`PlayerActor.coins`). */
  update(shop: Shop | undefined, coins: number): void {
    // Locale is part of the key for the same reason it is in `WeaponPickupPrompt`'s: these
    // strings are translated, so a language change must invalidate the cache even when
    // nothing about the shop moved.
    const stockKey = shop ? shop.stock.map((o) => `${o.id}:${o.sold ? 1 : 0}`).join(',') : '';
    const key = `${getLocale()}|${shop?.id ?? 0}|${stockKey}|${coins}`;
    if (key !== this.lastKey) {
      this.lastKey = key;
      this.rebuild(shop, coins);
    }
    this.view.visible = shop !== undefined;
  }

  private rebuild(shop: Shop | undefined, coins: number): void {
    for (const row of this.rows) row.view.destroy({ children: true });
    for (const label of this.priceLabels) label.destroy();
    this.rows = [];
    this.priceLabels = [];
    if (!shop) return;

    this.titleText.text = t('hud.shop.title', { coins });

    const n = shop.stock.length;
    const h = HEADER_H + (n ? n * (ROW_H + ROW_GAP) - ROW_GAP + PAD : 0) + PAD;
    this.panel.layout(ROW_W + PAD * 2, h);

    shop.stock.forEach((offer, i) => {
      const affordable = coins >= offer.price;
      // A sold row is not a button that happens to be disabled — it is a different label in a
      // different colour, so `sold` is checked first and everything below reads as "the row
      // you could still buy".
      const row = new Button(this.rowLabel(offer), {
        w: ROW_W,
        h: ROW_H,
        fontSize: ROW_FONT,
        wrapWidth: ROW_TEXT_W,
        color: offer.sold ? 0x1a1f28 : affordable ? 0x2a3140 : 0x20242e,
        textColor: offer.sold ? 0x4a5568 : affordable ? 0xe2e8f0 : 0x8a93a3,
        // Silent unless it will actually do something — the forge's craft rows already
        // established this: only the transaction knows whether a press did anything, so the
        // caller plays `ui.tap` or `ui.denied` off the outcome rather than the widget
        // promising a success it cannot see.
        sound: 'silent',
      });
      if (offer.kind === 'weapon' && offer.weaponId) {
        const spec = WEAPON_SIM_BY_ID[offer.weaponId];
        if (spec) row.setIcon(getWeaponTexture(offer.weaponId, spec.kind), rarityColor(spec));
      }
      row.view.position.set(PAD, HEADER_H + i * (ROW_H + ROW_GAP));
      const id = offer.id;
      row.onTap = () => this.onBuy?.(id);
      this.rows.push(row);
      this.view.addChild(row.view);

      if (!offer.sold) {
        const price = new Text({
          text: t('hud.shop.price', { price: offer.price }),
          style: {
            fill: affordable ? THEME.colors.pickupCoin : 0x6b7280,
            fontSize: 12,
            fontFamily: 'monospace',
            fontWeight: 'bold',
            padding: 6,
          },
        });
        price.eventMode = 'none'; // decoration — the press belongs to the row underneath it
        price.anchor.set(1, 0.5);
        price.position.set(PAD + ROW_W - 8, HEADER_H + i * (ROW_H + ROW_GAP) + ROW_H / 2);
        this.priceLabels.push(price);
        this.view.addChild(price);
      }
    });
  }

  /** What one row says. Data-driven values (a weapon's name, a buff's family) come from the
   *  catalogues and are deliberately NOT translated — the same rule design/17 applies to every
   *  other enum-shaped value in the HUD. */
  private rowLabel(offer: ShopOffer): string {
    if (offer.sold) return t('hud.shop.sold');
    switch (offer.kind) {
      case 'weapon':
        return (offer.weaponId ? WEAPON_SIM_BY_ID[offer.weaponId]?.name : undefined) ?? offer.weaponId ?? '?';
      case 'buff':
        return offer.buffId ? t(RUN_BUFFS[offer.buffId]?.nameKey as never) : '?';
      case 'heal':
        return t('hud.shop.heal');
      default:
        return t('hud.shop.energy');
    }
  }
}
