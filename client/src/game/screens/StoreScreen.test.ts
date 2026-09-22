/**
 * `StoreScreen` — the purchase screen's presentation half (design/19 §4).
 *
 * `StorePurchase.test.ts` owns the flow's branches; what this file pins is the part a
 * player actually reads: that every one of those branches reaches the screen as a specific
 * line rather than as silence, that the price on a row is the SERVER's number, and that a
 * row for something already owned cannot be bought a second time.
 *
 * The screen is driven against a REAL `StorePurchase` with a faked API, not a stub of the
 * controller: the mapping from an outcome code to a line is the thing under test, and a
 * hand-rolled fake of the controller would let the two drift while every case stayed green.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { StoreScreen } from './StoreScreen';
import { installFakeTextCanvas } from './fakeTextCanvas';
import { StorePurchase, type StorePurchaseApi, type StorePurchaseDeps } from '../controllers/StorePurchase';
import { setUiAudio } from '../../audio/uiSound';
import { defaultMetaState, type MetaState } from '../../meta';
import { resetLocaleForTests, t } from '../../i18n';
import type { StoreOrder, StoreSku } from '../../net/billing';
import { useLocale } from '../../i18n/loadLocale';

installFakeTextCanvas();
afterEach(() => { setUiAudio(null); resetLocaleForTests(); });

/** `Button.label` is private on the real class — the same escape hatch every other screen
 *  test in this directory uses to read it anyway. */
interface TestButton {
  view: { visible: boolean; position: { x: number; y: number } };
  label: { text: string };
  onTap: (() => void) | null;
}

function privateOf(screen: StoreScreen) {
  return screen as unknown as {
    title: { text: string };
    statusText: { text: string };
    rows: TestButton[];
    prevPageBtn: TestButton;
    nextPageBtn: TestButton;
    pageLabel: { visible: boolean; text: string };
    backBtn: TestButton;
  };
}

const SESSION = { accountId: 'acct-1', username: 'alice', token: 'tok-1' };

/** `cryobolt`/`cannon` are real `source: 'purchase'` catalogue ids, so the screen's
 *  localised-name lookup has something to find — the point of the label cases below. */
const CRYO: StoreSku = { sku: 'bp.cryobolt', title: 'Blueprint — Cryobolt', amountCents: 1200, currency: 'CNY', grants: [{ kind: 'blueprint', id: 'cryobolt' }] };
const CANNON: StoreSku = { sku: 'bp.cannon', title: 'Blueprint — Cannon', amountCents: 1800, currency: 'CNY', grants: [{ kind: 'blueprint', id: 'cannon' }] };

const order = (state: StoreOrder['state']): StoreOrder =>
  ({ id: 'ord-1', sku: CRYO.sku, platform: 'dev', amountCents: 1200, currency: 'CNY', state });

function cueLog(): string[] {
  const log: string[] = [];
  setUiAudio({
    preload: async () => {}, play: (cue) => { log.push(cue); },
    setSfxVolume: () => {}, setMusicVolume: () => {}, updateMusic: () => {}, invalidateMusic: () => {}, resume: () => {},
  });
  return log;
}

interface Over {
  skus?: StoreSku[];
  api?: Partial<StorePurchaseApi>;
  deps?: Partial<StorePurchaseDeps>;
  poll?: StoreOrder['state'][];
  meta?: MetaState;
}

function make(over: Over = {}) {
  const seen = over.poll ?? ['settled'];
  let tick = 0;
  const api: StorePurchaseApi = {
    listSkus: vi.fn(async () => over.skus ?? [CRYO, CANNON]),
    createOrder: vi.fn(async () => ({ order: order('created'), payment: { configured: true, params: {} } })),
    fetchOrder: vi.fn(async () => order(seen[Math.min(tick++, seen.length - 1)]!)),
    ...over.api,
  };
  const purchase = new StorePurchase({
    baseUrl: () => 'http://mm',
    session: () => SESSION,
    platform: () => 'dev',
    api,
    refreshOwnership: async () => {},
    sleep: async () => {},
    pollIntervalMs: 1,
    pollTimeoutMs: 3, // 3 attempts — an exhausted poll settles fast
    ...over.deps,
  });
  const screen = new StoreScreen(purchase);
  return { screen, api, purchase, ui: privateOf(screen), meta: over.meta ?? defaultMetaState() };
}

type Fixture = ReturnType<typeof make>;

/** `show()` kicks an async listing; this is the settle point every case needs. */
async function shown(over: Over = {}): Promise<Fixture> {
  const f = make(over);
  f.screen.show(760, 640, f.meta);
  await vi.waitFor(() => expect(f.ui.statusText.text).not.toBe(t('store.loading')));
  return f;
}

/** The item name the screen put on row `slot`, recovered from the row label so the
 *  expectations below do not re-derive it (a naming change then fails one case, not ten). */
function rowItem(f: Fixture, slot: number): string {
  return f.ui.rows[slot]!.label.text.split('   ')[0]!;
}

/** Press a row and let the whole purchase settle. */
async function tapRow(f: Fixture, slot: number): Promise<void> {
  const buying = t('store.purchasing', { item: rowItem(f, slot) });
  f.ui.rows[slot]!.onTap?.();
  await vi.waitFor(() => expect(f.ui.statusText.text).not.toBe(buying));
}

describe('the listing', () => {
  it("renders one row per SKU, at the SERVER's price", async () => {
    // The rule `net/billing.ts` exists to keep: the number on the row is the one that came
    // off the wire. Nothing here derives, totals or discounts it.
    const f = await shown();
    expect(f.ui.rows[0]!.view.visible).toBe(true);
    expect(f.ui.rows[1]!.view.visible).toBe(true);
    expect(f.ui.rows[2]!.view.visible).toBe(false); // only two SKUs were listed
    expect(f.ui.rows[0]!.label.text).toMatch(/12/); // 1200 minor units
    expect(f.ui.rows[1]!.label.text).toMatch(/18/); // 1800
  });

  it("names the weapon in the player's language, not the server's operator title", async () => {
    // design/09: engine data carries keys, never display text. The server's `title` is an
    // operator label; a row has to read like the rest of the game.
    await useLocale('zh');
    const f = await shown({ skus: [CRYO] });
    expect(f.ui.rows[0]!.label.text).not.toContain('Blueprint');
    expect(f.ui.rows[0]!.label.text).toMatch(/12/); // ...and the price is still on it
  });

  it('falls back to the server title for a SKU this build knows nothing about', async () => {
    // A SKU billsvc starts selling before the client ships content for it. An operator
    // label beats a blank row.
    const f = await shown({ skus: [{ sku: 'bp.future', title: 'Blueprint — Future', amountCents: 999, currency: 'CNY', grants: [{ kind: 'blueprint', id: 'not-a-real-blueprint' }] }] });
    expect(f.ui.rows[0]!.label.text).toContain('Blueprint — Future');
  });

  it('names a CHARACTER grant too, and refuses one the account already has', async () => {
    // `server/src/billsvc/skus.ts` sells no characters yet — picking which of the three
    // launch characters is paid is an undecided product call, and the `'character'` kind
    // exists so adding one is a single row. This is the client side of that row being
    // ready: the name resolves through `SKIN_DEFS` rather than falling back to the
    // operator title, and the owned check reads `ownedCharacters`, not blueprints.
    const skin: StoreSku = { sku: 'char.juggernaut', title: 'Character — Juggernaut', amountCents: 3000, currency: 'CNY', grants: [{ kind: 'character', id: 'juggernaut' }] };
    const unowned = await shown({ skus: [skin], meta: { ...defaultMetaState(), ownedCharacters: ['vanguard'] } });
    expect(unowned.ui.rows[0]!.label.text).not.toContain('Character —');
    expect(unowned.ui.rows[0]!.label.text).not.toBe(t('store.rowOwned', { item: rowItem(unowned, 0) }));

    const owned = await shown({ skus: [skin], meta: { ...defaultMetaState(), ownedCharacters: ['juggernaut'] } });
    expect(owned.ui.rows[0]!.label.text).toBe(t('store.rowOwned', { item: rowItem(owned, 0) }));
  });

  it('falls back to the server title for a CHARACTER this build does not have either', async () => {
    // The other half of the fallback: a paid character shipped server-side before the skin
    // exists in this build. Same answer as the unknown blueprint — an operator label, not
    // a blank row.
    const f = await shown({ skus: [{ sku: 'char.future', title: 'Character — Future', amountCents: 3000, currency: 'CNY', grants: [{ kind: 'character', id: 'not-a-real-skin' }] }] });
    expect(f.ui.rows[0]!.label.text).toContain('Character — Future');
  });

  it('says the store is EMPTY rather than leaving a blank panel', async () => {
    const f = await shown({ skus: [] });
    expect(f.ui.statusText.text).toBe(t('store.empty'));
  });

  it('pages once there are more SKUs than fit, and hides the nav when there are not', async () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ ...CRYO, sku: `bp.${i}` }));
    const paged = await shown({ skus: many });
    expect(paged.ui.nextPageBtn.view.visible).toBe(true);
    expect(paged.ui.pageLabel.visible).toBe(true);
    expect(paged.ui.rows.filter((r) => r.view.visible)).toHaveLength(6);

    paged.ui.nextPageBtn.onTap?.();
    expect(paged.ui.rows.filter((r) => r.view.visible)).toHaveLength(3); // the 9 - 6 remainder
    paged.ui.prevPageBtn.onTap?.();
    expect(paged.ui.rows.filter((r) => r.view.visible)).toHaveLength(6);

    const small = await shown();
    expect(small.ui.nextPageBtn.view.visible).toBe(false);
    expect(small.ui.pageLabel.visible).toBe(false);
  });

  it('buys the SKU under the row that was pressed, not the first one', async () => {
    // Off by one on a paged list charges for the wrong weapon and looks perfectly normal.
    const f = await shown();
    await tapRow(f, 1);
    expect(f.api.createOrder).toHaveBeenCalledWith('http://mm', 'tok-1', CANNON.sku, 'dev');
  });
});

describe('every refusal reaches the player as a line', () => {
  it('a GUEST is told to log in, and is shown no rows at all', async () => {
    // The listing itself needs the account's token, so a guest never gets a catalogue —
    // and a store that renders an empty panel with no explanation reads as broken.
    const f = await shown({ deps: { session: () => null } });
    expect(f.ui.statusText.text).toBe(t('store.loginRequired'));
    expect(f.ui.rows.every((r) => !r.view.visible)).toBe(true);
    expect(f.api.listSkus).not.toHaveBeenCalled();
  });

  it('a build that may not sell says so', async () => {
    const f = await shown({ deps: { platform: () => null } });
    expect(f.ui.statusText.text).toBe(t('store.unavailableHere'));
    expect(f.api.listSkus).not.toHaveBeenCalled();
  });

  it('a failed listing is NOT reported as an empty store', async () => {
    // "Nothing is for sale" and "we could not ask" are different sentences, and only one of
    // them tells the player to try again.
    const f = await shown({ api: { listSkus: vi.fn(async () => { throw new Error('502'); }) } });
    expect(f.ui.statusText.text).toBe(t('store.listFailed'));
    expect(f.ui.statusText.text).not.toBe(t('store.empty'));
  });

  it.each([
    ['payment.configured === false', { api: { createOrder: vi.fn(async () => ({ order: order('created'), payment: { configured: false, params: {} } })) } } as Over, 'store.notConfigured'],
    ['a rejected order', { api: { createOrder: vi.fn(async () => { throw new Error('unknown sku'); }) } } as Over, 'store.orderFailed'],
    ['a payment that failed', { poll: ['failed'] } as Over, 'store.paymentFailed'],
    ['a poll that timed out', { poll: ['created'] } as Over, 'store.pending'],
  ] as const)('%s shows its own line and plays ui.denied', async (_why, over, key) => {
    const log = cueLog();
    const f = await shown(over);
    await tapRow(f, 0);
    expect(f.ui.statusText.text).toBe(t(key));
    expect(log).toEqual(['ui.denied']);
  });

  it('no two of those lines are the same sentence', async () => {
    // `StoreScreen`'s message `Record`s are exhaustive, so a new outcome code cannot fall
    // through to generic copy. This is the other half: that the codes they map do not all
    // land on the same string, which would make the exhaustiveness worth nothing.
    const lines = ([
      'store.notConfigured', 'store.orderFailed', 'store.paymentFailed', 'store.pending',
      'store.loginRequired', 'store.unavailableHere', 'store.listFailed', 'store.busy',
    ] as const).map((k) => t(k));
    expect(new Set(lines).size).toBe(lines.length);
  });
});

describe('a purchase that lands', () => {
  it('reports it, plays ui.tap, and stops offering the row', async () => {
    const log = cueLog();
    const f = await shown();
    const item = rowItem(f, 0);
    await tapRow(f, 0);
    expect(f.ui.statusText.text).toBe(t('store.purchased', { item }));
    expect(log).toEqual(['ui.tap']);
    // The row just paid for must stop looking buyable. `show()`'s meta snapshot cannot
    // learn about a purchase made since, so the screen tracks this visit's own buys.
    expect(f.ui.rows[0]!.label.text).toBe(t('store.rowOwned', { item }));
    f.ui.rows[0]!.onTap?.();
    await Promise.resolve();
    expect(f.api.createOrder).toHaveBeenCalledTimes(1); // a second press books nothing
  });

  it('a DELIVERED purchase whose ownership re-read failed still reads as bought', async () => {
    // The arm easiest to get wrong: the money moved and the entitlement exists, so anything
    // that reads as a failure here is a lie. The line says where the weapon will show up.
    const log = cueLog();
    const f = await shown({ deps: { refreshOwnership: async () => { throw new Error('offline'); } } });
    const item = rowItem(f, 0);
    await tapRow(f, 0);
    expect(f.ui.statusText.text).toBe(t('store.purchasedNoRefresh', { item }));
    expect(f.ui.statusText.text).not.toBe(t('store.purchased', { item }));
    expect(log).toEqual(['ui.tap']); // ...and it SOUNDS like the success it is
  });
});

describe('buying something twice', () => {
  it('a SKU the account already owns is refused before any order is booked', async () => {
    // The one mistake on this screen that costs real money: the server would happily take
    // it for a second copy of something that grants nothing new.
    const log = cueLog();
    const owned = defaultMetaState();
    const meta = { ...owned, unlockedBlueprints: [...owned.unlockedBlueprints, 'cryobolt'] };
    const f = await shown({ skus: [CRYO], meta });
    const item = rowItem(f, 0);
    expect(f.ui.rows[0]!.label.text).toBe(t('store.rowOwned', { item }));

    f.ui.rows[0]!.onTap?.();
    await Promise.resolve();
    expect(f.api.createOrder).not.toHaveBeenCalled();
    expect(log).toEqual(['ui.denied']);
    expect(f.ui.statusText.text).toBe(t('store.alreadyOwned', { item }));
  });

  it('a SKU granting something this build cannot name is never "owned"', async () => {
    // Same skip-the-unknown posture `entitlementOwnership` takes: a grant kind the client
    // does not understand must not silently read as already-bought and block a real sale.
    const f = await shown({ skus: [{ ...CRYO, grants: [] }] });
    expect(f.ui.rows[0]!.label.text).not.toBe(t('store.rowOwned', { item: rowItem(f, 0) }));
    await tapRow(f, 0);
    expect(f.api.createOrder).toHaveBeenCalledTimes(1);
  });

  it('DOUBLE-TAPPING the buy row books exactly one order', async () => {
    // A payment button being pressed twice is not hypothetical. The guard lives in
    // `StorePurchase`; this is the screen actually going through it.
    const log = cueLog();
    const f = await shown({ poll: ['created', 'settled'] });
    const buying = t('store.purchasing', { item: rowItem(f, 0) });
    f.ui.rows[0]!.onTap?.();
    f.ui.rows[0]!.onTap?.();
    await vi.waitFor(() => expect(f.ui.statusText.text).not.toBe(buying));
    expect(f.api.createOrder).toHaveBeenCalledTimes(1);
    expect(log).toEqual(['ui.denied', 'ui.tap']); // the swallowed tap, then the real one
  });
});

describe('leaving the screen', () => {
  it('a purchase that resolves after BACK does not repaint a screen that is gone', async () => {
    // Same `attemptToken` staleness convention LoginScreen/Matchmaking use. Without it a
    // slow settle writes "purchased" onto a store the player has left, and the NEXT visit
    // opens on a line about a purchase made in the last one.
    const f = await shown({ poll: ['created', 'settled'] });
    const buying = t('store.purchasing', { item: rowItem(f, 0) });
    f.ui.rows[0]!.onTap?.();
    f.screen.hide();
    await new Promise((r) => setTimeout(r, 5));
    expect(f.ui.statusText.text).toBe(buying); // never advanced to `purchased`
  });

  it('a listing that resolves after BACK is dropped too', async () => {
    // Asserting on the STATUS LINE, not on the rows: `show()` empties the row pool anyway,
    // so "no rows" would pass with the staleness check deleted. Only the line separates
    // "the load was dropped" from "the load landed on a screen nobody is looking at".
    const f = make();
    f.screen.show(760, 640, f.meta);
    f.screen.hide();
    await new Promise((r) => setTimeout(r, 5));
    expect(f.ui.statusText.text).toBe(t('store.loading'));
    expect(f.ui.statusText.text).not.toBe(t('store.pickOne'));
    expect(f.ui.rows.every((r) => !r.view.visible)).toBe(true);
  });

  it('BACK fires onBack, and re-opening starts from a clean slate', async () => {
    const f = await shown();
    let backs = 0;
    f.screen.onBack = () => { backs++; };
    f.ui.backBtn.onTap?.();
    expect(backs).toBe(1);

    f.screen.show(760, 640, f.meta);
    expect(f.ui.statusText.text).toBe(t('store.loading'));
    expect(f.ui.rows.every((r) => !r.view.visible)).toBe(true);
  });

  it('resize() re-lays out WITHOUT re-listing — a rotation mid-purchase must not restart it', async () => {
    // Same reason `ScreenNav.relayout` resizes matchmaking instead of showing it: `show()`
    // clears the status line and starts a second listing under an order already booked.
    const f = await shown();
    f.screen.resize(1280, 720);
    expect(f.api.listSkus).toHaveBeenCalledTimes(1);
    expect(f.ui.rows[0]!.view.visible).toBe(true);
    expect(f.ui.statusText.text).toBe(t('store.pickOne'));
  });
});

describe('i18n (design/17-i18n.md)', () => {
  it('retexts every static label on show()', async () => {
    await useLocale('zh');
    const f = await shown();
    expect(f.ui.title.text).toBe('商店');
    // No arrow glyph in the label — `icon_back` draws one, and carrying both rendered as
    // "← ← FORGE" on a build with the UI art loaded.
    expect(f.ui.backBtn.label.text).toBe('锻造场');
    expect(f.ui.backBtn.label.text).not.toContain('←');
    expect(f.ui.prevPageBtn.label.text).toBe('‹ 上一页');
  });
});
