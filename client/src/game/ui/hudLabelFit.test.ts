/**
 * Does every in-run HUD label fit the box it is drawn in — in all eight locales?
 *
 * ## Why the menus' sweep could not answer this
 *
 * `screens/labelFit.test.ts` asks exactly this question for the menu screens, and this file
 * is deliberately its twin rather than an extension of it: the two measure different
 * geometry. A menu screen lives in `MenuLayer`'s design space, which scales the WHOLE layer
 * down to fit a phone, so "fits" there is a statement about a fixed 760x640 canvas. The HUD
 * is outside that layer (see `menuLayer.ts`'s closing note) and is laid out against real
 * screen pixels, so its boxes are whatever `reposition` says and nothing rescales a label
 * that outgrows one.
 *
 * ## The bug it exists for (2026-09-21)
 *
 * Reported off a screenshot of the floor-card offer: the card text ran out of its card and
 * across the two beside it. Measured, it was not one string but twenty-six — `client`'s
 * eight locales carry 56 floor-card strings and 26 of them are wider than the 150px card,
 * the worst (Spanish "Las pociones caen 2x más a menudo") at 238px. The same pass found two
 * more of the same shape: `PortalPrompt`'s Bank & Extract label overflows its 260px button
 * in SEVEN locales — including English, at 261px — and a `ShopPrompt` buff row in Polish
 * measures 312px against a 250px row, drawing straight through the price beside it.
 *
 * None of it was visible to the suite, because the three panels' own test files assert what
 * a label SAYS and nothing about how wide it is, and because Pixi's `style.wordWrap` (which
 * the menus lean on) wraps inside the canvas text measurer — a thing this Node-only
 * environment does not have. That is why the fix wraps through `wrapMono` instead: the
 * wrapped lines are a plain string, so this file can measure them.
 *
 * ## How to read a row
 *
 * `estimateMonoWidth` charges 0.6em per Latin character and a full em per CJK one. Measured
 * against the real font the Latin estimate is slightly generous, so a passing Latin row is
 * evidence; CJK is about right but never under-charged, so read `zh` as weaker evidence —
 * the same caveat `labelFit.test.ts` states, for the same estimator.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { Texture } from 'pixi.js';
import type { GameState, Shop, ShopOffer, Fp } from '@dd/engine';
import { FLOOR_CARD_IDS, RUN_BUFFS } from '@dd/engine';
import { FloorCardPrompt, CARD_W, CARD_H, CARD_FONT } from './FloorCardPrompt';
import { PortalPrompt, BTN_W, BTN_FONT } from './PortalPrompt';
import { ShopPrompt, ROW_FONT, ROW_TEXT_W } from './ShopPrompt';
import { estimateMonoWidth } from './textWidth';
import { LOCALES, resetLocaleForTests } from '../../i18n';
import { useLocale } from '../../i18n/loadLocale';

// Every UI icon resolves, so each panel is measured with the art it actually ships with —
// the same mock, for the same reason, as `screens/labelFit.test.ts`: `getUiTexture` answers
// `undefined` with nothing loaded, and a floor card without its icon centres its label
// instead of sitting it under one, which is a strictly roomier layout than the product's.
vi.mock('../../render/uiSkins', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../render/uiSkins')>()),
  getUiTexture: () => Texture.WHITE,
}));

afterEach(() => resetLocaleForTests());

/** Every line of a label, as drawn. A widget that wraps hands back one string with `\n`s in
 *  it — splitting is how a fixed box is measured against what actually lands in it. */
function lines(text: string): string[] {
  return text.split('\n');
}

/** The single failing line, named, so a red run says WHICH locale and WHICH string — a bare
 *  "expected 238 to be at most 142" is a measurement without a defect attached. */
function widest(text: string, fontSize: number): { line: string; px: number } {
  let worst = { line: '', px: 0 };
  for (const line of lines(text)) {
    const px = estimateMonoWidth(line, fontSize);
    if (px > worst.px) worst = { line, px };
  }
  return worst;
}

// ---------------------------------------------------------------- floor cards

/** The slice of GameState `FloorCardPrompt` reads (same shape as its own test's). */
function cardState(offer: string[]): GameState {
  return { floorCardOffer: offer, players: [{ cardVote: 0 }] } as unknown as GameState;
}

/** The catalogue in offers of three, so the sweep covers every card rather than whichever
 *  three a seed happens to draw. */
function offers(): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < FLOOR_CARD_IDS.length; i += 3) out.push([...FLOOR_CARD_IDS.slice(i, i + 3)]);
  return out;
}

interface CardLike {
  view: { visible: boolean };
  /** `y` is where the label's top sits once an icon has pushed it down — see the vertical
   *  assertion in the sweep below. */
  label: { text: string; y: number };
}

function cardsOf(p: FloorCardPrompt): CardLike[] {
  return (p as unknown as { cards: CardLike[] }).cards.filter((c) => c.view.visible);
}

function cardLabels(p: FloorCardPrompt): string[] {
  return cardsOf(p).map((c) => c.label.text);
}

describe('floor cards fit their card', () => {
  // 8px of breathing room either side of the text, which is what the card is wrapped to.
  const MAX_W = CARD_W - 16;
  // Pixi's default line advance is ~1.2em, so 15px at this font size.
  const LINE_H = CARD_FONT * 1.25;

  for (const locale of LOCALES) {
    it(`${locale}: no card's text leaves its box, under the icon it ships with`, async () => {
      await useLocale(locale);
      const p = new FloorCardPrompt();
      for (const offer of offers()) {
        p.update(cardState(offer), true, 0);
        for (const card of cardsOf(p)) {
          const worst = widest(card.label.text, CARD_FONT);
          expect(worst.px, `[${locale}] "${worst.line}"`).toBeLessThanOrEqual(MAX_W);
          // The VERTICAL half, and the reason the texture registry is mocked at the top of
          // this file: shipped, every card carries an icon, the label starts below it
          // rather than centred, and the room left under it is what a third wrapped line
          // has to fit in. With no art loaded the label would centre and this would pass
          // while measuring a layout no player sees.
          const bottom = card.label.y + lines(card.label.text).length * LINE_H;
          expect(bottom, `[${locale}] "${card.label.text}"`).toBeLessThanOrEqual(CARD_H - 4);
        }
      }
    });
  }

  it('really is wrapping — the longest card string is drawn as more than one line', async () => {
    // The control on the sweep above: a panel that silently CLIPPED its labels (or a
    // catalogue that lost its long strings) would pass every width assertion while the
    // player read half a sentence. Spanish is where the catalogue is widest.
    await useLocale('es');
    const p = new FloorCardPrompt();
    p.update(cardState(['potion_flow', 'edge', 'bulwark']), true, 0);
    const [potion] = cardLabels(p);
    expect(lines(potion!).length).toBeGreaterThan(2); // name + at least two wrapped desc lines
    expect(potion!.replace(/\n/g, ' ')).toContain('pociones');
  });
});

// --------------------------------------------------------------- portal popup

function portalState(): GameState {
  // Per-seat since ENGINE_VERSION 68 (design/14) — the carry-out bags live on `players[0]`,
  // not at the top level.
  return { floorIndex: 0, players: [{ floorMaterials: { alloy: 12 }, bankedMaterials: {} }] } as unknown as GameState;
}

function portalLabels(p: PortalPrompt): string[] {
  const inner = p as unknown as { extractBtn: { label: { text: string } }; descendBtn: { label: { text: string } } };
  return [inner.extractBtn.label.text, inner.descendBtn.label.text];
}

describe('the portal popup’s buttons fit their box', () => {
  const MAX_W = BTN_W - 20;
  // A 40px-tall button holds two lines at 15px (~36px) and no more.
  const MAX_LINES = 2;

  for (const locale of LOCALES) {
    it(`${locale}: neither Extract nor Descend runs out of its button`, async () => {
      await useLocale(locale);
      const p = new PortalPrompt();
      for (const isLastFloor of [true, false]) {
        p.update(portalState(), true, 0, isLastFloor);
        for (const label of portalLabels(p)) {
          const worst = widest(label, BTN_FONT);
          expect(worst.px, `[${locale}] "${worst.line}"`).toBeLessThanOrEqual(MAX_W);
          expect(lines(label).length, `[${locale}] "${label}"`).toBeLessThanOrEqual(MAX_LINES);
        }
      }
    });
  }
});

// ------------------------------------------------------------------ shop rows

const fp = (n: number) => n as Fp;

/** One row per buff family plus the two consumables — the whole set of translated labels a
 *  counter can show. Weapon rows are left out on purpose: a weapon's name comes off the
 *  engine's spec and is the same string in every locale. */
function shopStock(): ShopOffer[] {
  const buffs: ShopOffer[] = Object.keys(RUN_BUFFS).map((buffId, i) => ({
    id: i + 1,
    kind: 'buff',
    buffId,
    price: 40,
    sold: false,
  }));
  return [
    ...buffs,
    // A pick-one-of-three buff line (ROADMAP B2): its header is a string of its own.
    { id: 80, kind: 'buff', price: 40, sold: false, choices: [{ id: 81, buffId: 'dmg_up' }, { id: 82, buffId: 'cell_up' }, { id: 83, buffId: 'crit_up' }] },
    { id: 90, kind: 'heal', price: 12, sold: false },
    { id: 91, kind: 'energy', price: 12, sold: false },
  ];
}

const shop = (stock: ShopOffer[]): Shop => ({ id: 1, roomId: 'r1', gx: fp(0), gy: fp(0), stock });

function shopLabels(p: ShopPrompt): string[] {
  return (p as unknown as { rows: Array<{ label: { text: string } }> }).rows.map((r) => r.label.text);
}

describe('shop rows fit the lane between the icon and the price', () => {
  // Two lines at 13px (~31px) inside a 34px row.
  const MAX_LINES = 2;

  for (const locale of LOCALES) {
    it(`${locale}: no row label reaches the price beside it`, async () => {
      await useLocale(locale);
      const p = new ShopPrompt();
      // Both wallets: an unaffordable row is a different colour, not a different string, but
      // rebuilding under both is what proves the wrap is not a property of one branch.
      for (const coins of [0, 999]) {
        p.update(shop(shopStock()), coins);
        for (const label of shopLabels(p)) {
          const worst = widest(label, ROW_FONT);
          expect(worst.px, `[${locale}] "${worst.line}"`).toBeLessThanOrEqual(ROW_TEXT_W);
          expect(lines(label).length, `[${locale}] "${label}"`).toBeLessThanOrEqual(MAX_LINES);
        }
      }
    });
  }
});
