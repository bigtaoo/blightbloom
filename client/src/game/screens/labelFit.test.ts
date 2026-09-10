/**
 * Does every button's LABEL fit inside that button — in all eight locales, with the icon it
 * actually ships with?
 *
 * ## The hole this fills, and why the sweep next door could not
 *
 * `viewportFit.test.ts` asks whether anything lands outside the design space. That is a
 * different question, and on 2026-09-10 the difference cost a shipped defect: the lobby's
 * first layout put CO-OP and PVP QUEUE side by side at 135px, `PVP SOLO QUEUE` needed 169,
 * and the label ran out of its button and across the gap into its neighbour — in seven of
 * the eight locales. Every one of that file's 239 cases stayed green, correctly, because a
 * label spilling into the gap beside it is still comfortably on screen. Its own header
 * already says to read it as "nothing is off screen", never as "nothing collides".
 *
 * ## Two reasons a unit test measures a layout no player sees, both handled here
 *
 *  1. **No art.** `getUiTexture` answers `undefined` with nothing loaded, so `Button.setIcon`
 *     takes its clear branch and the label CENTRES. Shipped, the icon is there and the label
 *     is left-anchored past the chip — a strictly tighter layout, and a different failure.
 *     So this file mocks the texture registry rather than the buttons: every screen then gets
 *     an icon exactly where it already asked for one, and nowhere else.
 *  2. **Approximate glyphs.** `fakeTextCanvas` charges 0.6em per character. Measured against
 *     the real font, Latin at these sizes came out at ~0.55em, so the estimate errs the safe
 *     way there; CJK is about a full em, so it UNDER-measures Chinese. Read a passing `zh`
 *     row as "not evidence", and a passing Latin row as evidence.
 *
 * ## Why its own file, and its own (simpler) builder list
 *
 * Mocking the texture registry changes what `viewportFit`'s sweep measures, and that file's
 * cases are tuned to specific tallest-variant states; this one needs no such states, because
 * a label is the same length whichever page of the store is showing. The two lists overlap
 * in the screens they name and in nothing else.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { Graphics, Text, Texture } from 'pixi.js';
import { installFakeTextCanvas } from './fakeTextCanvas';
import { MENU_DESIGN_W, MENU_DESIGN_H } from '../ui/menuLayer';
import { Forge } from './Forge';
import { MainMenu } from './MainMenu';
import { PvpPreview } from './PvpPreview';
import { Screens } from './Screens';
import { Settings } from './Settings';
import { PauseMenu } from './PauseMenu';
import { PartyScreen } from './PartyScreen';
import { LoginScreen } from './LoginScreen';
import { Matchmaking } from './Matchmaking';
import { StoreScreen } from './StoreScreen';
import { StorePurchase } from '../controllers/StorePurchase';
import type { StoreSku } from '../../net/billing';
import { defaultMetaState } from '../../meta';
import { defaultSettingsState } from '../../settings';
import { LOCALES, setLocale, resetLocaleForTests } from '../../i18n';
import { setSession, resetSessionCacheForTests } from '../../net/session';

// Every UI icon resolves, so each screen is built with the chips it ships with. Mocked at the
// registry rather than per button: a test that hands icons to buttons the design never gave
// one to would be measuring a layout that is stricter than the product, and would eventually
// be "fixed" by loosening the assertion.
vi.mock('../../render/uiSkins', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../render/uiSkins')>()),
  getUiTexture: () => Texture.WHITE,
}));

installFakeTextCanvas();

afterEach(() => {
  resetLocaleForTests();
  resetSessionCacheForTests();
});

/** A widget that is a `Button` for our purposes: it has a box and a label. */
interface ButtonLike {
  view: { children: unknown[] };
}

function isButtonLike(v: unknown): v is ButtonLike {
  const o = v as { setText?: unknown; setIcon?: unknown; view?: { children?: unknown } };
  return !!o && typeof o === 'object'
    && typeof o.setText === 'function' && typeof o.setIcon === 'function'
    && Array.isArray(o.view?.children);
}

/**
 * Every Button a screen owns, including the ones it owns through a composed widget
 * (`MainMenu` → `LobbyRoutes`) or an array (`Forge`'s blueprint cards, the store's rows).
 *
 * Reflection over the instance's own fields rather than a walk of the display tree, and the
 * difference matters: a display-tree walk has to GUESS what a button looks like (a Graphics
 * plus a Text), which also describes a stat chip, a card and a prompt — widgets that are
 * allowed to have text wider than the shape behind them.
 */
function buttonsOf(screen: object, depth = 2, path = ''): Array<[string, ButtonLike]> {
  const found: Array<[string, ButtonLike]> = [];
  for (const [key, value] of Object.entries(screen)) {
    const name = path ? `${path}.${key}` : key;
    if (isButtonLike(value)) {
      found.push([name, value]);
      continue;
    }
    if (Array.isArray(value)) {
      value.forEach((v, i) => {
        if (isButtonLike(v)) found.push([`${name}[${i}]`, v]);
        else if (depth > 0 && v && typeof v === 'object') found.push(...buttonsOf(v, depth - 1, `${name}[${i}]`));
      });
      continue;
    }
    // A composed widget (it has its own `view`) — but not a Pixi node, whose `children` walk
    // would take us into the display tree this function deliberately does not use.
    if (depth > 0 && value && typeof value === 'object' && 'view' in value && !('parent' in value)) {
      found.push(...buttonsOf(value, depth - 1, name));
    }
  }
  return found;
}

const STORE_SKUS: StoreSku[] = [
  { sku: 'bp.cryobolt', title: 'Blueprint — Cryobolt', amountCents: 1200, currency: 'CNY', grants: [{ kind: 'blueprint', id: 'cryobolt' }] },
  { sku: 'bp.cannon', title: 'Blueprint — Cannon', amountCents: 1800, currency: 'CNY', grants: [{ kind: 'blueprint', id: 'cannon' }] },
];

function storeScreen(): StoreScreen {
  return new StoreScreen(new StorePurchase({
    baseUrl: () => 'http://mm',
    session: () => ({ accountId: 'a', username: 'alice', token: 'tok' }),
    platform: () => 'dev',
    api: {
      listSkus: async () => STORE_SKUS,
      createOrder: async () => { throw new Error('not used'); },
      fetchOrder: async () => { throw new Error('not used'); },
    },
    refreshOwnership: async () => {},
    sleep: async () => {},
  }));
}

/** Build a screen and lay it out at the design size. Returns the INSTANCE, not its view. */
type Build = (w: number, h: number) => object | Promise<object>;

const SCREENS: Array<[string, Build]> = [
  ['MainMenu', (w, h) => { const s = new MainMenu(); s.show(w, h); return s; }],
  // The portal shape: one more button (quick-play PLAY) and one fewer (no ACCOUNT).
  ['MainMenu (portal)', (w, h) => {
    const s = new MainMenu();
    s.setQuickPlay(true);
    s.setAccountEntry(false);
    s.show(w, h);
    return s;
  }],
  // Logged in, because the ACCOUNT button's label is then a GREETING containing a name —
  // the one label on any of these screens whose length is not ours to choose.
  ['MainMenu (signed in)', (w, h) => {
    setSession({ accountId: 'a', username: 'alice', token: 'tok' });
    const s = new MainMenu();
    s.show(w, h);
    return s;
  }],
  ['Forge', (w, h) => { const s = new Forge(); s.storeEnabled = true; s.render(defaultMetaState(), w, h); return s; }],
  // With a saved run in the slot (ENGINE_VERSION 61) — the state that draws CONTINUE RUN and
  // moves START RUN up a row. Its own case because a `savedRun` provider is the only way to
  // reach that layout, and the default is "no save": without this the CONTINUE label would be
  // constructed, measured once at its constructor default, and never re-measured under a
  // locale, which is exactly the "counted but not covered" shape the count guard below is for.
  ['Forge (saved run)', (w, h) => {
    const s = new Forge();
    s.storeEnabled = true;
    s.savedRun = () => ({ floorIndex: 2, ticks: 9000, savedAtMs: 0 });
    s.render(defaultMetaState(), w, h);
    return s;
  }],
  ['PvpPreview', (w, h) => { const s = new PvpPreview(); s.show(w, h, defaultMetaState().selectedSkin); return s; }],
  ['Screens', (w, h) => { const s = new Screens(); s.show(w, h, true, 'VICTORY', ['line one']); return s; }],
  ['Screens + ad offer', (w, h) => {
    const s = new Screens();
    s.show(w, h, true, 'EXTRACTED', ['line one'], { label: 'СМОТРЕТЬ РЕКЛАМУ: МАТЕРИАЛЫ x2', claim: async () => [] });
    return s;
  }],
  ['Settings', (w, h) => { const s = new Settings(); s.show(w, h, defaultSettingsState()); return s; }],
  ['PauseMenu', (w, h) => { const s = new PauseMenu(); s.show(w, h); return s; }],
  ['PartyScreen', (w, h) => { const s = new PartyScreen({ matchBaseUrl: '' }); s.show(w, h); return s; }],
  ['LoginScreen', (w, h) => { const s = new LoginScreen({ matchBaseUrl: '' }); s.show(w, h); return s; }],
  ['Matchmaking (connecting)', (w, h) => {
    const s = new Matchmaking();
    s.show(w, h, () => new Promise<never>(() => {}));
    return s;
  }],
  ['Matchmaking (error)', async (w, h) => {
    const s = new Matchmaking();
    s.show(w, h, () => Promise.reject(new Error('matchmaking failed')));
    await new Promise((r) => setTimeout(r, 0));
    s.resize(w, h);
    return s;
  }],
  ['StoreScreen', async (w, h) => {
    const s = storeScreen();
    s.show(w, h, defaultMetaState());
    await new Promise((r) => setTimeout(r, 0));
    return s;
  }],
];

/** Sub-pixel text-metric noise, not a layout budget — the same slack `viewportFit` allows. */
const SLACK = 1;

/** What the reflection found, per screen, recorded on the English pass and asserted at the
 *  end — see the last test for why a count is not enough on its own. */
const seen = new Map<string, string[]>();

describe('every button label fits inside its own button', () => {
  for (const locale of LOCALES) {
    it.each(SCREENS)(`${locale} — %s`, async (name, build) => {
      setLocale(locale);
      const screen = await build(MENU_DESIGN_W, MENU_DESIGN_H);
      const buttons = buttonsOf(screen);
      // A screen whose buttons could not be found would pass this test perfectly.
      expect(buttons.length, `${name}: no buttons found — the reflection missed them`).toBeGreaterThan(0);
      if (locale === 'en') seen.set(name, buttons.map(([f]) => f));

      // Collected, not asserted one at a time: `expect` throws on the first failure, so a
      // per-button assertion reports ONE overflow per screen per locale and hides the rest
      // behind it. That is not hypothetical — it is how this sweep's own first run
      // under-reported itself, twice, and each fix uncovered the next label.
      const spills: string[] = [];
      for (const [field, btn] of buttons) {
        const kids = btn.view.children;
        const box = (kids[0] as Graphics).getLocalBounds().width;
        const label = kids.find((c) => c instanceof Text) as Text | undefined;
        if (!label || label.text === '') continue; // a button with no text cannot overflow
        const left = label.x - label.width * label.anchor.x;
        const where = `${name}.${field} "${label.text}"`;
        if (left < -SLACK) spills.push(`${where} starts ${(-left).toFixed(0)}px left of its box`);
        if (left + label.width > box + SLACK) {
          spills.push(`${where} runs ${(left + label.width - box).toFixed(0)}px past its ${box.toFixed(0)}px box`);
        }
      }
      expect(spills, `${locale}: labels outside their buttons`).toEqual([]);
    });
  }
});

describe('the sweep measured what it claims to', () => {
  it('found every button on every screen, not just the easy ones', async () => {
    // The failure this exists for is the one a green sweep cannot distinguish from success:
    // `buttonsOf` reflects over instance fields, so a screen that keeps its buttons somewhere
    // the walk does not reach (three levels deep, or in a Map) contributes ZERO assertions
    // and passes. The per-case `length > 0` above only catches a screen with none at all.
    //
    // Recorded from the run above rather than re-derived, and pinned as a count per screen:
    // a button that disappears from the walk shows up here as a smaller number.
    //
    // Every number below was cross-checked against `grep -c 'new Button(' <screen>.ts` when
    // it was written, which is what makes it a measurement rather than a snapshot of
    // whatever the walk happened to do. Two of them only agree because the walk reaches
    // further than a screen's own fields: MainMenu is 3 of its own plus LobbyRoutes' 5
    // (a composed widget), and StoreScreen is 4 plus its five row buttons (an array).
    expect([...seen].map(([name, fields]) => `${name}: ${fields.length}`).sort()).toEqual([
      'Forge (saved run): 9',
      'Forge: 9',
      'LoginScreen: 5',
      'MainMenu (portal): 8',
      'MainMenu (signed in): 8',
      'MainMenu: 8',
      'Matchmaking (connecting): 3',
      'Matchmaking (error): 3',
      'PartyScreen: 5',
      'PauseMenu: 4',
      'PvpPreview: 2',
      'Screens + ad offer: 3',
      'Screens: 3',
      'Settings: 6',
      'StoreScreen: 9',
    ]);
  });
});
