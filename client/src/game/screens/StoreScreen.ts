import { Container, Text } from 'pixi.js';
import { BLUEPRINT_CATALOG, SKIN_DEFS, WEAPON_SPECS } from '@dd/engine';
import { Button } from '../ui/widgets';
import { MenuShell } from '../ui/MenuShell';
import type { LobbyBackdrop } from '../ui/LobbyBackdrop';
import { SHEET_PAD, SHEET_TITLE_H } from '../ui/MenuSheet';
import { MENU_BUTTONS, MENU_COLORS, menuText } from '../ui/menuTheme';
import { clampPageStart, pageCount } from '../ui/paging';
import { playUiCue } from '../../audio/uiSound';
import { formatSkuPrice, type SkuGrant, type StoreSku } from '../../net/billing';
import type { StorePurchase, CatalogFailure, PurchaseFailure } from '../controllers/StorePurchase';
import type { MetaState } from '../../meta';
import { t, tName, type TranslationKey } from '../../i18n';

/** Rows per page. The server table is ten SKUs today and will grow; a fixed pool plus the
 * paging helpers the Forge grid already uses beats letting the list run off the panel — the
 * exact bug `Forge`'s own `buyableText` comment records. */
const PAGE_SIZE = 6;
/** The sheet's width and the content inside its padding; a row's height and pitch; the pager. */
const SHEET_W = 560;
const CONTENT_W = SHEET_W - SHEET_PAD * 2;
const ROW_H = 42;
const ROW_PITCH = ROW_H + 8;
const PAGER_H = 30;

/** Every failure code either half of the flow can produce, mapped to the ONE player-facing
 * line for it. Exhaustive `Record`s rather than a `switch` with a default, so a new code in
 * `StorePurchase` is a compile error here instead of a silent fallthrough to generic copy. */
const PURCHASE_MESSAGE: Record<PurchaseFailure, TranslationKey> = {
  busy: 'store.busy',
  'not-logged-in': 'store.loginRequired',
  'no-platform': 'store.unavailableHere',
  'not-configured': 'store.notConfigured',
  'order-failed': 'store.orderFailed',
  'payment-failed': 'store.paymentFailed',
  'timed-out': 'store.pending',
};

const CATALOG_MESSAGE: Record<CatalogFailure, TranslationKey> = {
  busy: 'store.busy',
  'not-logged-in': 'store.loginRequired',
  'no-platform': 'store.unavailableHere',
  'list-failed': 'store.listFailed',
};

/**
 * The store (design/19-server-platform.md §4, design/14's bounded direct purchase) — real
 * money for a named blueprint, replacing the Forge's `demo: free grant` ACQUIRE.
 *
 * Pure presentation over an injected `StorePurchase`, the same split every other screen here
 * uses. Two things it deliberately does NOT do:
 *
 *   - **It never computes a price.** Rows render `amountCents`/`currency` exactly as the
 *     listing returned them. There is no local price table to drift from
 *     `server/src/billsvc/skus.ts`, and nothing here totals or discounts anything.
 *   - **It never decides whether this build may sell.** That is `platform/storePlatform.ts`,
 *     read through `StorePurchase`; this screen only refuses to render an entry it was told
 *     not to. See that file for why an iOS build showing a web checkout is a rule break
 *     rather than a rough edge.
 *
 * Since the menu shell (design/10 "One shell for every menu", 2026-09-27) it is one framed
 * sheet — the status line, then the rows as full-width buttons, then the pager — with BACK as
 * the shell's corner chip. An owned row keeps its place and drops to the field colour, so a
 * page never reflows under the player's finger after a purchase.
 *
 * Every button is `sound: 'silent'`: a store press can end in a purchase, a refusal, or a
 * swallowed double-tap, and only the transaction knows which — so the cue is played from
 * the outcome (design/11, same reasoning as the Forge's craft rows).
 */
export class StoreScreen {
  readonly view = new Container();
  private readonly shell: MenuShell;
  /** The dimmed lobby painting. Named `panel` for `menuCoversWorld.test.ts`. */
  private readonly panel: LobbyBackdrop;
  private statusText: Text;
  private pageLabel: Text;
  private rows: Button[];
  private prevPageBtn: Button;
  private nextPageBtn: Button;

  private skus: StoreSku[] = [];
  private meta: MetaState | null = null;
  /** SKUs bought during THIS visit. `meta` is the snapshot `show()` was handed, so it does
   * not learn about a purchase made since — without this the row a player just paid for
   * would keep offering itself for sale until they left and came back. */
  private boughtHere = new Set<string>();
  private pageStart = 0;
  private lastW = 0;
  private lastH = 0;
  /** Bumped by `hide()`, checked when an async load/buy settles — the same `attemptToken`
   * convention LoginScreen/Matchmaking/PartyScreen use, so a purchase that resolves after
   * the player walked away cannot repaint a screen that is no longer up. */
  private attemptToken = 0;

  onBack: (() => void) | null = null;

  constructor(private readonly purchase: StorePurchase) {
    this.shell = new MenuShell({ title: t('store.title'), back: t('store.back') });
    this.shell.onBack = () => this.onBack?.();
    this.panel = this.shell.backdrop;
    // wordWrap for the same reason the Forge's store caption has it: these lines are
    // translated and one of them carries a server-supplied failure message of no fixed length.
    this.statusText = new Text({ text: '', style: menuText('body', { fill: MENU_COLORS.accent, align: 'center', wordWrapWidth: CONTENT_W }) });
    this.statusText.anchor.set(0.5, 0);
    this.pageLabel = new Text({ text: '', style: menuText('label', { fill: MENU_COLORS.accent, fontSize: 12 }) });
    this.pageLabel.anchor.set(0.5);

    this.rows = Array.from({ length: PAGE_SIZE }, (_, slot) => {
      const skuRowBtn = new Button('', { w: CONTENT_W, h: ROW_H, fontSize: 14, sound: 'silent', ...MENU_BUTTONS.secondary });
      skuRowBtn.onTap = () => {
        const sku = this.skus[this.pageStart + slot];
        if (sku) void this.buy(sku);
      };
      return skuRowBtn;
    });

    this.prevPageBtn = new Button(t('store.pagePrev'), { w: 96, h: PAGER_H, fontSize: 12, autoWidth: true, ...MENU_BUTTONS.secondary });
    this.prevPageBtn.onTap = () => this.turnPage(-1);
    this.nextPageBtn = new Button(t('store.pageNext'), { w: 96, h: PAGER_H, fontSize: 12, autoWidth: true, ...MENU_BUTTONS.secondary });
    this.nextPageBtn.onTap = () => this.turnPage(1);

    // BACK is the shell's chip. Its label carries NO arrow glyph: the chip draws one, and
    // `store.back` used to carry a `←` as well, which rendered as "← ← FORGE".
    this.shell.content.addChild(
      this.statusText, ...this.rows.map((r) => r.view),
      this.prevPageBtn.view, this.pageLabel, this.nextPageBtn.view,
    );
    this.shell.mount(this.view);
    this.view.eventMode = 'static';
    this.view.visible = false;
  }

  /** Open the store and kick a listing. `meta` is what the player already owns — an owned
   * SKU is shown as owned and cannot be bought a second time, which is the one mistake here
   * that costs real money. */
  show(w: number, h: number, meta: MetaState): void {
    this.meta = meta;
    this.boughtHere.clear();
    this.skus = [];
    this.pageStart = 0;
    this.statusText.text = t('store.loading');
    this.retext();
    this.render(w, h);
    this.view.visible = true;
    void this.load();
  }

  /** Per-frame: the backdrop's rocks, glow and motes. Driven from the main loop's
   *  `menuScreens`, and a no-op while this screen is hidden. */
  animate(dtMs: number): void {
    if (this.view.visible) this.panel.update(dtMs);
  }

  hide(): void {
    this.view.visible = false;
    this.attemptToken++;
  }

  /** Re-render against a fresh viewport (ScreenNav.relayout) without re-listing. */
  resize(w: number, h: number): void {
    this.render(w, h);
  }

  /** Re-apply every static label from the active locale — MainMenu's `retext()` convention
   * (design/17-i18n.md). */
  private retext(): void {
    this.shell.setTitle(t('store.title'));
    this.shell.setBack(t('store.back'));
    this.prevPageBtn.setText(t('store.pagePrev'));
    this.nextPageBtn.setText(t('store.pageNext'));
  }

  private async load(): Promise<void> {
    const token = this.attemptToken;
    const result = await this.purchase.loadCatalog();
    if (token !== this.attemptToken) return;
    if (!result.ok) {
      this.skus = [];
      this.statusText.text = t(CATALOG_MESSAGE[result.code]);
      this.render(this.lastW, this.lastH);
      return;
    }
    this.skus = result.skus;
    this.pageStart = 0;
    this.statusText.text = result.skus.length ? t('store.pickOne') : t('store.empty');
    this.render(this.lastW, this.lastH);
  }

  private async buy(sku: StoreSku): Promise<void> {
    // Owned already — refused HERE rather than at the server, because the server would
    // happily take the money for a second copy of a thing that grants nothing new.
    if (this.owns(sku)) {
      playUiCue('ui.denied');
      this.statusText.text = t('store.alreadyOwned', { item: this.skuLabel(sku) });
      this.render(this.lastW, this.lastH);
      return;
    }
    const token = this.attemptToken;
    this.statusText.text = t('store.purchasing', { item: this.skuLabel(sku) });
    this.render(this.lastW, this.lastH);

    // `buy` plays the cue (it is the half that knows the outcome) and carries its own
    // re-entrancy guard, so a double tap lands on `busy` rather than booking two orders.
    const result = await this.purchase.buy(sku.sku);
    if (token !== this.attemptToken) return;
    if (result.ok) this.boughtHere.add(sku.sku);

    if (!result.ok) {
      this.statusText.text = t(PURCHASE_MESSAGE[result.code]);
      this.render(this.lastW, this.lastH);
      return;
    }
    // Delivered. `refreshed: false` means this client could not re-read the entitlement —
    // the purchase stands, so the line says where it will show up rather than sounding like
    // a failure (`StorePurchase`'s own note on that arm).
    this.statusText.text = result.refreshed
      ? t('store.purchased', { item: this.skuLabel(sku) })
      : t('store.purchasedNoRefresh', { item: this.skuLabel(sku) });
    // Nothing to notify: `StorePurchase.refreshOwnership` has already written the server's
    // answer into the live meta, and BACK re-renders the forge from it. The store is a full
    // phase, so the forge is not on screen to refresh while this is up.
    this.render(this.lastW, this.lastH);
  }

  private turnPage(delta: number): void {
    this.pageStart = clampPageStart(this.pageStart, delta, this.skus.length, PAGE_SIZE);
    this.render(this.lastW, this.lastH);
  }

  /** Does the local meta already carry everything this SKU grants? A SKU granting nothing
   * this client understands (a kind billsvc adds later) is never "owned" — same
   * skip-the-unknown posture `entitlementOwnership` takes. */
  private owns(sku: StoreSku): boolean {
    if (this.boughtHere.has(sku.sku)) return true;
    const m = this.meta;
    if (!m || sku.grants.length === 0) return false;
    return sku.grants.every((g) =>
      g.kind === 'blueprint' ? m.unlockedBlueprints.includes(g.id)
      : g.kind === 'character' ? m.ownedCharacters.includes(g.id)
      : false);
  }

  /** The player-facing name: the localised CONTENT name where the grant names something
   * this build knows (design/09 — engine data carries keys, never display text), else the
   * server's own operator-facing title. */
  private skuLabel(sku: StoreSku): string {
    const named = sku.grants.map((g) => grantName(g)).filter((n): n is string => n !== null);
    return named.length ? named.join(' + ') : sku.title;
  }

  private render(w: number, h: number): void {
    this.lastW = w;
    this.lastH = h;

    // Clamp after a listing shrank the page count out from under a page we were on.
    const pages = pageCount(this.skus.length, PAGE_SIZE);
    if (this.pageStart >= this.skus.length) this.pageStart = Math.max(0, (pages - 1) * PAGE_SIZE);

    this.statusText.position.set(CONTENT_W / 2, 0);
    let y = Math.max(20, this.statusText.height) + 16;

    this.rows.forEach((row, slot) => {
      const sku = this.skus[this.pageStart + slot];
      if (!sku) {
        row.view.visible = false;
        return;
      }
      row.view.visible = true;
      const owned = this.owns(sku);
      row.setText(
        owned
          ? t('store.rowOwned', { item: this.skuLabel(sku) })
          : t('store.row', { item: this.skuLabel(sku), price: formatSkuPrice(sku.amountCents, sku.currency) }),
      );
      row.setFill(owned ? MENU_COLORS.field : MENU_BUTTONS.secondary.color);
      row.setBorder(owned ? MENU_COLORS.fieldBorder : MENU_BUTTONS.secondary.borderColor);
      row.view.position.set(0, y + slot * ROW_PITCH);
    });
    // A paged list reserves a full page, so flipping to a short last page does not shrink
    // the sheet (and rescale everything) under the pager the player just pressed.
    const paged = this.skus.length > PAGE_SIZE;
    const shownRows = paged ? PAGE_SIZE : this.skus.length;
    y += shownRows * ROW_PITCH;

    this.prevPageBtn.view.visible = paged;
    this.nextPageBtn.view.visible = paged;
    this.pageLabel.visible = paged;
    if (paged) {
      y += 4;
      this.prevPageBtn.view.position.set(0, y);
      this.pageLabel.text = t('store.pageLabel', { current: Math.floor(this.pageStart / PAGE_SIZE) + 1, total: pages });
      this.pageLabel.position.set(CONTENT_W / 2, y + PAGER_H / 2);
      this.nextPageBtn.view.position.set(CONTENT_W - this.nextPageBtn.width, y);
      y += PAGER_H;
    } else if (shownRows > 0) {
      y -= ROW_PITCH - ROW_H;
    }

    // `MenuSheet.layout`'s own sums: the title plate, the gap under it, and the bottom padding.
    this.shell.layout(w, h, SHEET_W, SHEET_TITLE_H + 18 + y + SHEET_PAD);
  }
}

/** Free function rather than a method: it reads only the engine catalogues, so it needs no
 * screen state and is the piece a test can exercise on its own. */
function grantName(g: SkuGrant): string | null {
  if (g.kind === 'blueprint') {
    const bp = BLUEPRINT_CATALOG[g.id];
    const spec = bp && WEAPON_SPECS[bp.weaponId];
    return spec ? tName(spec.nameKey) : null;
  }
  const skin = SKIN_DEFS[g.id];
  return skin ? tName(skin.nameKey) : null;
}
