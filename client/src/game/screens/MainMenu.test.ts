/**
 * MainMenu (design/10 screen flow). Pixi Container/Text/Graphics construct and mutate
 * fine under plain vitest with no renderer attached (same finding PartyScreen.test.ts/
 * Forge.test.ts made) — asserted here via `.visible`/`.text`, not pixel output.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Assets, Graphics, Texture, TextureSource } from 'pixi.js';
import { MainMenu } from './MainMenu';
import { preloadUiTier, resetUiSkinsForTests } from '../../render/uiSkins';
import { getSession, setSession, resetSessionCacheForTests, type Session } from '../../net/session';
import { setLocale, resetLocaleForTests } from '../../i18n';
import { setPublicFlags } from '../../net/clientFlags';
import { BANNER_MAX_LENGTH, PUBLIC_FLAG_DEFAULTS } from '../../net/publicFlags';
import type { SavedRunSummary } from '../match/runSave';
import { useLocale } from '../../i18n/loadLocale';
import { installFakeTextCanvas } from './fakeTextCanvas';

// The notice strip stacks its lines by their MEASURED height, so the text has to be measurable.
installFakeTextCanvas();

const ALICE: Session = { accountId: 'acct-1', username: 'alice', token: 'tok-1' };

/** Every route row on `LobbyRoutes`, reached the same private-cast way as the shell's own
 *  widgets — the merge (2026-09-10) moved these into a composed widget, not out of reach. */
interface Btn {
  label: { text: string };
  onTap: (() => void) | null;
  color: number;
  view: { visible: boolean; position: { x: number; y: number }; children: unknown[] };
}

/** A positioned, scaled container. */
interface Pt { position: { x: number; y: number }; scale: { x: number; y: number } }

function privateOf(m: MainMenu) {
  return m as unknown as {
    title: { text: string };
    subtitle: { text: string };
    playBtn: Btn;
    routes: {
      continueBtn: Btn & { hint: { text: string; visible: boolean } };
      soloBtn: Btn;
      coopBtn: Btn;
      pvpSoloBtn: Btn;
      squadBtn: Btn;
      forgeBtn: Btn;
      forgeBadge: Pt & { visible: boolean };
      forgeBadgeText: { text: string };
      tutorialBtn: Btn;
      height: number;
      recommendedTag: { text: string; visible: boolean; position: { x: number; y: number } };
    };
    accountBtn: Btn & {
      hint: { text: string; visible: boolean };
      initial: { text: string; visible: boolean };
      iconSprite: { visible: boolean };
      disc: Graphics;
    };
    settingsBtn: Btn;
    accountLabel: { text: string; visible: boolean; position: { x: number; y: number } };
    dataNotice: { text: string; visible: boolean; position: { x: number; y: number } };
    banner: { text: string; visible: boolean; anchor: { x: number; y: number }; position: { x: number; y: number }; height: number };
    notices: Pt & { visible: boolean };
    topLeft: Pt;
    topRight: Pt;
    header: Pt;
    column: Pt;
    logo: { visible: boolean };
    hero: { view: { visible: boolean } };
    privacyLink: {
      text: string;
      visible: boolean;
      cursor: string;
      eventMode: string;
      position: { x: number; y: number };
      emit: (event: string) => void;
    };
  };
}

/** A route's FILL: a `Button` keeps it as `color`, a `LobbyCard` in its style. */
function fillOf(btn: unknown): number {
  const b = btn as { color?: number; style?: { fill: number } };
  return b.color ?? b.style!.fill;
}

/** A widget's press box in SCREEN space — child 0's world bounds, so the column's scale and
 *  position are included. */
function screenBox(btn: { view: { children: unknown[] } }) {
  const b = (btn.view.children[0] as Graphics).getBounds();
  return { x: b.minX, y: b.minY, w: b.maxX - b.minX, h: b.maxY - b.minY };
}

/** A button's own box: its `bg` Graphics is always child 0. Measuring the whole `view`
 *  would pull in the label Text, whose bounds need a real canvas this runner has not got. */
function bgOf(btn: { view: { children: unknown[] } }) {
  return (btn.view.children[0] as Graphics).getLocalBounds();
}

beforeEach(() => resetSessionCacheForTests());
afterEach(() => {
  resetLocaleForTests();
  setPublicFlags(null);
});

/** Set just the maintenance banner, leaving the other public flags shipped. */
function withBanner(text: string): void {
  setPublicFlags({ ...PUBLIC_FLAG_DEFAULTS, 'ui.maintenanceBanner': text });
}

describe('MainMenu — the maintenance banner (design/21 §9)', () => {
  it('draws nothing at all with no banner set, which is the shipped default', () => {
    // The state every player is in almost always. It is asserted first because it is the
    // one that must not regress: an empty flag has to leave this screen exactly as it was.
    const m = new MainMenu();
    m.show(800, 600);
    expect(privateOf(m).banner.visible).toBe(false);
    expect(privateOf(m).banner.text).toBe('');
  });

  it('shows the operator’s text VERBATIM, unlocalised', () => {
    // Verbatim is the contract: there is no key to look up, because the value is one line
    // somebody typed into the console. Asserting the exact string is what pins that this
    // screen does not decorate, prefix or translate it — any of which would make the 140
    // character cap mean something different at the two ends.
    withBanner('Back at 14:00 UTC — server move');
    const m = new MainMenu();
    m.show(800, 600);
    expect(privateOf(m).banner.visible).toBe(true);
    expect(privateOf(m).banner.text).toBe('Back at 14:00 UTC — server move');
  });

  it('picks the banner up on show(), so re-entering the menu is enough', () => {
    const m = new MainMenu();
    m.show(800, 600);
    expect(privateOf(m).banner.visible).toBe(false);
    withBanner('scheduled restart 03:00 UTC');
    m.show(800, 600);
    expect(privateOf(m).banner.text).toBe('scheduled restart 03:00 UTC');
  });

  it('refreshBanner() works while the menu is ALREADY on screen', () => {
    // The case the flag exists for: a player sitting in the menu when an operator puts a
    // notice up. `gameWiring.ts` subscribes this to the flag store so it happens without
    // them navigating away and back.
    const m = new MainMenu();
    m.show(800, 600);
    withBanner('going down in 20 minutes');
    m.refreshBanner();
    expect(privateOf(m).banner.visible).toBe(true);
    expect(privateOf(m).banner.text).toBe('going down in 20 minutes');
  });

  it('goes away again when the operator clears it', () => {
    // The reverse transition, which a show-only test would never reach. A banner that could
    // be raised and not lowered is a banner nobody dares use.
    withBanner('down for maintenance');
    const m = new MainMenu();
    m.show(800, 600);
    expect(privateOf(m).banner.visible).toBe(true);
    setPublicFlags(null);
    m.refreshBanner();
    expect(privateOf(m).banner.visible).toBe(false);
    expect(privateOf(m).banner.text).toBe('');
  });

  it('sits in a strip centred on the top third of the screen, moving nothing else', () => {
    // 2026-09-27: it used to hang under the corner row and push the header down. Now it sits
    // on one band across the scene at a third of the height; the header, the column and the
    // corners stay exactly where they are without it.
    const plain = new MainMenu();
    plain.show(1280, 720);
    withBanner('x'.repeat(BANNER_MAX_LENGTH));
    const withIt = new MainMenu();
    withIt.show(1280, 720);
    const a = privateOf(plain);
    const b = privateOf(withIt);
    expect(a.notices.visible).toBe(false);
    expect(b.notices.visible).toBe(true);
    const k = b.notices.scale.y;
    const top = b.notices.position.y;
    const bottom = top + (b.banner.position.y + b.banner.height + 8) * k;
    expect((top + bottom) / 2).toBeCloseTo(720 / 3, 0);
    for (const key of ['header', 'column', 'topLeft', 'topRight'] as const) {
      expect([b[key].position.x, b[key].position.y], key).toEqual([a[key].position.x, a[key].position.y]);
    }
  });

  it('stays across the scene, left of the column, and never above the corner row', () => {
    withBanner('M'.repeat(BANNER_MAX_LENGTH));
    const m = new MainMenu();
    m.show(1386, 640);
    const p = privateOf(m);
    const k = p.notices.scale.x;
    // The banner is centred on the strip, and the strip ends where the column's room does.
    expect(p.notices.position.x + p.banner.position.x * k * 2).toBeLessThan(p.column.position.x);
    expect(p.notices.position.y).toBeGreaterThanOrEqual(p.topLeft.position.y + 40 * p.topLeft.scale.y);
  });

  it('re-lays the screen out when a banner arrives while the lobby is up, and hides the strip when it goes', () => {
    const m = new MainMenu();
    m.show(800, 600);
    expect(privateOf(m).notices.visible).toBe(false);
    withBanner('going down in 20 minutes');
    m.refreshBanner();
    expect(privateOf(m).notices.visible).toBe(true);
    expect(privateOf(m).notices.position.y).toBeGreaterThan(0);
    setPublicFlags(null);
    m.refreshBanner();
    expect(privateOf(m).notices.visible).toBe(false);
  });
});

describe('MainMenu — account label', () => {
  it('reads LOGIN as a guest (no session)', () => {
    const m = new MainMenu();
    m.refreshAccountLabel();
    expect(privateOf(m).accountBtn.label.text).toBe('LOGIN');
  });

  it('reads "Hi, {username}" once logged in', () => {
    setSession(ALICE);
    const m = new MainMenu();
    m.refreshAccountLabel();
    // The BARE NAME on the chip, not the greeting sentence — 2026-09-10, after
    // `labelFit.test.ts` measured "Cześć, alice" and five other locales' greetings running
    // out of a 135px button with a five-letter name in them. The greeting still exists and
    // still says hello; it just says it on the portal's LABEL, which has a whole row.
    expect(privateOf(m).accountBtn.label.text).toBe('alice');
  });

  it('ellipsises a name too long to be a chip label', () => {
    // A bound, not a fit: the chip is `autoWidth` so it grows to whatever it is handed, and
    // this only stops one absurd name from pushing the pair wider than the card behind it.
    setSession({ ...ALICE, username: 'a-very-long-display-name' });
    const m = new MainMenu();
    m.refreshAccountLabel();
    const text = privateOf(m).accountBtn.label.text;
    expect(text).toHaveLength(12);
    expect(text.endsWith('…')).toBe(true);
    expect(text.startsWith('a-very-long')).toBe(true);
  });

  it('grows the chip for the name without moving it off its corner', () => {
    // What `autoWidth` buys: the chip widens for the name, and since it is pinned top-left
    // it grows AWAY from the edge rather than off it.
    const short = new MainMenu();
    setSession({ ...ALICE, username: 'al' });
    short.show(800, 600);
    const wide = new MainMenu();
    // A CJK name, because `estimateMonoWidth` counts one of those as a full em where a
    // Latin character is 0.6 — the case that actually outgrows the chip within the clip.
    setSession({ ...ALICE, username: '一二三四五六七八九十' });
    wide.show(800, 600);
    expect(bgOf(privateOf(wide).accountBtn).width).toBeGreaterThan(bgOf(privateOf(short).accountBtn).width);
    expect(screenBox(privateOf(wide).accountBtn).x).toBe(screenBox(privateOf(short).accountBtn).x);
    // ...and it stays clear of the top-right chrome.
    expect(screenBox(privateOf(wide).accountBtn).x + screenBox(privateOf(wide).accountBtn).w)
      .toBeLessThan(screenBox(privateOf(wide).settingsBtn).x);
  });

  it('tells a guest why logging in is worth a tap, and a player that their progress syncs', () => {
    // The line lives INSIDE the card now (2026-09-27): it used to hang loose under the chip,
    // where it pushed the header down and read as a second, unrelated caption.
    const m = new MainMenu();
    m.show(800, 600);
    const card = privateOf(m).accountBtn;
    expect(card.hint.visible).toBe(true);
    expect(card.hint.text).toBe('Log in to save progress');
    setSession(ALICE);
    m.show(800, 600);
    expect(card.hint.text).toBe('Progress synced');
  });

  it('draws the guest glyph as a guest and the name’s initial once signed in', () => {
    const m = new MainMenu();
    m.show(800, 600);
    const card = privateOf(m).accountBtn;
    expect(card.initial.visible).toBe(false);
    setSession(ALICE);
    m.show(800, 600);
    expect(card.initial.visible).toBe(true);
    expect(card.initial.text).toBe('A');
    expect(card.iconSprite.visible).toBe(false);
    // ...and back to the glyph on logout, not a stale initial.
    resetSessionCacheForTests();
    m.refreshAccountLabel();
    expect(card.initial.visible).toBe(false);
  });

  it('keeps the header in the same place for a guest and a signed-in player', () => {
    // The loose guest line used to push the header down 16px for a guest only; the card
    // holds both lines in one row, so the scene no longer shifts on login.
    const guest = new MainMenu();
    guest.show(800, 600);
    setSession(ALICE);
    const alice = new MainMenu();
    alice.show(800, 600);
    expect(privateOf(alice).header.position.y).toBe(privateOf(guest).header.position.y);
  });

  it('show() re-reads the session, so a login after construction still surfaces', () => {
    const m = new MainMenu();
    expect(privateOf(m).accountBtn.label.text).toBe('LOGIN');
    setSession(ALICE);
    m.show(800, 600);
    expect(privateOf(m).accountBtn.label.text).toBe('alice');
    expect(getSession()).toEqual(ALICE); // sanity: this test's own session write took
  });
});

describe('MainMenu — callbacks', () => {
  it('tapping each button fires its own callback, not another one', () => {
    // Seven since the 2026-09-10 merge, and the four in the middle arrive through
    // `LobbyRoutes` rather than being this screen's own buttons — which is exactly why they
    // are worth asserting one by one: a delegation typo wires two rows to one handler and
    // nothing else in the suite would notice.
    const m = new MainMenu();
    const p = privateOf(m);
    const calls: string[] = [];
    m.onPlay = () => calls.push('play');
    m.onSolo = () => calls.push('solo');
    m.onCoop = () => calls.push('coop');
    m.onPvpSolo = () => calls.push('pvpSolo');
    m.onSquad = () => calls.push('squad');
    m.onTutorial = () => calls.push('tutorial');
    m.onAccount = () => calls.push('account');
    m.onSettings = () => calls.push('settings');

    p.playBtn.onTap?.();
    p.routes.soloBtn.onTap?.();
    p.routes.coopBtn.onTap?.();
    p.routes.pvpSoloBtn.onTap?.();
    p.routes.squadBtn.onTap?.();
    p.routes.tutorialBtn.onTap?.();
    p.accountBtn.onTap?.();
    p.settingsBtn.onTap?.();

    expect(calls).toEqual(['play', 'solo', 'coop', 'pvpSolo', 'squad', 'tutorial', 'account', 'settings']);
  });

  it('badges TUTORIAL only for a player who has not seen it', () => {
    // The badge `ModeSelect` carried before the merge, on the row it followed here.
    const m = new MainMenu();
    m.setRecommendTutorial(true);
    m.show(800, 600);
    expect(privateOf(m).routes.recommendedTag.visible).toBe(true);
    m.setRecommendTutorial(false);
    m.show(800, 600);
    expect(privateOf(m).routes.recommendedTag.visible).toBe(false);
  });
});

describe('MainMenu — show()', () => {
  it('becomes visible', () => {
    const m = new MainMenu();
    m.show(800, 600);
    expect(m.view.visible).toBe(true);
  });
});

// Hierarchy (design/10, 2026-08-02, and the 2026-09-27 redesign): exactly ONE primary
// action, visibly the biggest thing in the column, then the other two ways to play, then the
// "prepare" dock — and the corner chrome smaller than any of them.
describe('MainMenu — hierarchy and layout', () => {
  it('draws three tiers of decreasing size, and the corner chrome smallest', () => {
    const m = new MainMenu();
    m.show(800, 600);
    const p = privateOf(m);
    const solo = bgOf(p.routes.soloBtn);
    const coop = bgOf(p.routes.coopBtn);
    const squad = bgOf(p.routes.squadBtn);
    expect(solo.height).toBeGreaterThan(coop.height);
    expect(coop.height).toBeGreaterThan(squad.height);
    expect(squad.height).toBeGreaterThan(bgOf(p.accountBtn).height);
    expect(bgOf(p.accountBtn).height).toBe(bgOf(p.settingsBtn).height);
    // CO-OP and PVP full width — see LobbyRoutes' header for the half-width pair that was
    // tried first and what measuring it in eight locales said about it.
    expect(coop.width).toBe(solo.width);
    expect(bgOf(p.routes.pvpSoloBtn).width).toBe(solo.width);
    expect(squad.width).toBeLessThan(solo.width / 2);
  });

  it('gives the screen exactly one green primary, and hands it over under quick play', () => {
    // The failure this exists for is the one design/10 recorded on 2026-08-02: two controls
    // of equal weight, reported as clicks landing on the wrong page when the routing was
    // correct all along. The fill is the ranking, so the fill is the assertion.
    const plain = new MainMenu();
    const quick = new MainMenu();
    quick.setQuickPlay(true);
    const GREEN = 0x2f855a;
    expect(fillOf(privateOf(plain).routes.soloBtn)).toBe(GREEN);
    expect(fillOf(privateOf(quick).routes.soloBtn)).not.toBe(GREEN);
    expect(fillOf(privateOf(quick).playBtn)).toBe(GREEN);
    // SOLO demoted is the slim bar, not a second banner.
    expect(bgOf(privateOf(quick).routes.soloBtn).height).toBeLessThan(bgOf(privateOf(quick).playBtn).height);
    // ...and back: the switch is a setter, not a one-way door.
    quick.setQuickPlay(false);
    expect(fillOf(privateOf(quick).routes.soloBtn)).toBe(GREEN);
  });

  it('stacks the routes in one column, in order, with the dock last', () => {
    const m = new MainMenu();
    m.show(800, 600);
    const r = privateOf(m).routes;
    const box = (b: Btn) => screenBox(b);
    expect(box(r.coopBtn).x).toBe(box(r.soloBtn).x);
    expect(box(r.pvpSoloBtn).x).toBe(box(r.soloBtn).x);
    expect(box(r.soloBtn).y + box(r.soloBtn).h).toBeLessThanOrEqual(box(r.coopBtn).y);
    expect(box(r.coopBtn).y + box(r.coopBtn).h).toBeLessThanOrEqual(box(r.pvpSoloBtn).y);
    expect(box(r.pvpSoloBtn).y + box(r.pvpSoloBtn).h).toBeLessThanOrEqual(box(r.squadBtn).y);
    // The dock is one row: SQUAD, FORGE, TUTORIAL left to right.
    expect(box(r.forgeBtn).y).toBe(box(r.squadBtn).y);
    expect(box(r.tutorialBtn).y).toBe(box(r.squadBtn).y);
    expect(box(r.squadBtn).x).toBeLessThan(box(r.forgeBtn).x);
    expect(box(r.forgeBtn).x).toBeLessThan(box(r.tutorialBtn).x);
  });

  it('pins ACCOUNT top-left and SETTINGS top-right, on one row above the column', () => {
    const CASES: Array<[string, number, number, (m: MainMenu) => void]> = [
      ['plain', 800, 600, () => {}],
      ['portal', 800, 600, (m) => m.setQuickPlay(true)],
      ['saved run', 800, 600, (m) => { m.resumableRun = () => ({ floorIndex: 2, ticks: 9000, savedAtMs: 0 }); }],
      ['wide desktop', 1920, 1080, () => {}],
    ];
    for (const [name, w, h, setup] of CASES) {
      const m = new MainMenu();
      setup(m);
      m.show(w, h);
      const p = privateOf(m);
      const account = screenBox(p.accountBtn);
      const settings = screenBox(p.settingsBtn);
      expect(account.y, name).toBe(settings.y);
      expect(account.x, name).toBeLessThan(40);
      expect(settings.x + settings.w, name).toBeGreaterThan(w - 40);
      expect(settings.x + settings.w, name).toBeLessThanOrEqual(w);
      const first = p.playBtn.view.visible ? p.playBtn
        : p.routes.continueBtn.view.visible ? p.routes.continueBtn : p.routes.soloBtn;
      expect(screenBox(first).y, name).toBeGreaterThan(settings.y + settings.h);
    }
  });

  it('keeps the column on screen and right of the dais', () => {
    for (const [w, h] of [[800, 600], [1386, 640], [1920, 1080], [760, 1646]] as const) {
      const m = new MainMenu();
      m.show(w, h);
      const r = privateOf(m).routes;
      const top = screenBox(r.soloBtn);
      const dock = screenBox(r.squadBtn);
      expect(top.x + top.w, `${w}x${h}`).toBeLessThanOrEqual(w);
      expect(dock.y + dock.h, `${w}x${h}`).toBeLessThanOrEqual(h);
      const dais = (m as unknown as { panel: { dais: { x: number } } }).panel.dais;
      expect(dais.x, `${w}x${h}`).toBeLessThan(top.x);
      expect(dais.x, `${w}x${h}`).toBeGreaterThan(0);
    }
  });

  it('scales the lobby up on a big viewport rather than leaving it at its phone size', () => {
    const small = new MainMenu();
    small.show(760, 640);
    const big = new MainMenu();
    big.show(1920, 1080);
    expect(privateOf(small).column.scale.x).toBe(1);
    expect(privateOf(big).topLeft.scale.x).toBe(1.5);
    expect(privateOf(big).header.scale.x).toBe(1.5);
    // The column goes past `k` — the boost, where the viewport has room for it.
    expect(privateOf(big).column.scale.x).toBeCloseTo(1.5 * 1.35, 6);
  });

  it('draws the column bigger than the rest of the lobby, but never past its share of the width', () => {
    for (const [w, h] of [[1386, 640], [1888, 901], [1920, 1080], [2560, 1440], [3440, 1440]] as const) {
      const m = new MainMenu();
      m.show(w, h);
      const p = privateOf(m);
      const k = p.header.scale.x;
      expect(p.column.scale.x, `${w}x${h}`).toBeGreaterThanOrEqual(k);
      expect(screenBox(p.routes.soloBtn).w, `${w}x${h}`).toBeLessThanOrEqual(w * 0.3 + 1);
    }
    // 1888x901 — the window the request was made at: the column is visibly bigger than `k`.
    const m = new MainMenu();
    m.show(1888, 901);
    expect(privateOf(m).column.scale.x).toBeGreaterThan(privateOf(m).header.scale.x * 1.3);
  });

  it('re-divides the dock between SQUAD and FORGE when TUTORIAL hides', () => {
    // "Open it, or take it off the screen" (design/10) — and leave no hole where it was.
    const shown = new MainMenu();
    shown.setRecommendTutorial(true);
    shown.show(800, 600);
    const hidden = new MainMenu();
    hidden.setRecommendTutorial(false);
    hidden.show(800, 600);
    const a = privateOf(shown).routes;
    const b = privateOf(hidden).routes;
    expect(b.tutorialBtn.view.visible).toBe(false);
    expect(bgOf(b.squadBtn).width).toBeGreaterThan(bgOf(a.squadBtn).width);
    // FORGE's right edge lands where TUTORIAL's did: the row is still full width.
    expect(screenBox(b.forgeBtn).x + screenBox(b.forgeBtn).w)
      .toBeCloseTo(screenBox(a.tutorialBtn).x + screenBox(a.tutorialBtn).w, 5);
  });
});

describe('MainMenu — the scene (hero, logo, FORGE badge)', () => {
  it('draws an empty dais and no FORGE badge with no profile, which is the default', () => {
    const m = new MainMenu();
    m.show(800, 600);
    expect(privateOf(m).hero.view.visible).toBe(false);
    expect(privateOf(m).routes.forgeBadge.visible).toBe(false);
  });

  it('keeps the top-right corner to SETTINGS alone — the material counts left the lobby', () => {
    const m = new MainMenu();
    m.lobbyProfile = () => ({ skinId: 'vanguard', forgeReady: 3, bestFloor: 0 });
    m.show(800, 600);
    expect((privateOf(m).topRight as unknown as { children: unknown[] }).children).toEqual([privateOf(m).settingsBtn.view]);
  });

  it("badges FORGE with the profile's craftable count, on the button's top-right corner", () => {
    const m = new MainMenu();
    m.lobbyProfile = () => ({ skinId: 'vanguard', forgeReady: 3, bestFloor: 0 });
    m.show(800, 600);
    const r = privateOf(m).routes;
    expect(r.forgeBadge.visible).toBe(true);
    expect(r.forgeBadgeText.text).toBe('3');
    const forge = r.forgeBtn.view as unknown as Pt;
    const box = bgOf(r.forgeBtn);
    expect(r.forgeBadge.position.y).toBeCloseTo(forge.position.y, 5);
    expect(r.forgeBadge.position.x).toBeGreaterThan(forge.position.x + box.width / 2);
    expect(r.forgeBadge.position.x).toBeLessThan(forge.position.x + box.width);
  });

  it('hides the badge at zero, and for a count that is not a positive number', () => {
    for (const forgeReady of [0, -2, Number.NaN]) {
      const m = new MainMenu();
      m.lobbyProfile = () => ({ skinId: 'vanguard', forgeReady, bestFloor: 0 });
      m.show(800, 600);
      expect(privateOf(m).routes.forgeBadge.visible).toBe(false);
    }
  });

  it('caps the badge at 99+ and clears it when the count drops back to zero', () => {
    const m = new MainMenu();
    let forgeReady = 250;
    m.lobbyProfile = () => ({ skinId: 'vanguard', forgeReady, bestFloor: 0 });
    m.show(800, 600);
    expect(privateOf(m).routes.forgeBadgeText.text).toBe('99+');
    forgeReady = 0;
    m.show(800, 600);
    expect(privateOf(m).routes.forgeBadge.visible).toBe(false);
  });

  it('draws the text title where the logo art is missing', () => {
    const m = new MainMenu();
    m.show(800, 600);
    expect(privateOf(m).logo.visible).toBe(false);
    expect((privateOf(m).title as unknown as { visible: boolean }).visible).toBe(true);
  });

  it('animates only while it is on screen', () => {
    const m = new MainMenu();
    m.update(16); // hidden: a no-op, and must not throw on a screen never laid out
    m.show(800, 600);
    const glow = (privateOf(m).routes.soloBtn as unknown as { glow: { alpha: number } }).glow;
    m.update(600);
    const a = glow.alpha;
    m.update(600);
    expect(glow.alpha).not.toBe(a);
    m.hide();
    const frozen = glow.alpha;
    m.update(600);
    expect(glow.alpha).toBe(frozen);
  });
});

describe('MainMenu — i18n (design/17-i18n.md)', () => {
  it('defaults to English', () => {
    const m = new MainMenu();
    const p = privateOf(m);
    expect(p.subtitle.text).toBe('descend, extract, survive');
    expect(p.playBtn.label.text).toBe('PLAY');
  });

  it('retexts its static labels from the active locale on show()', async () => {
    const m = new MainMenu();
    await useLocale('zh');
    m.show(800, 600);
    const p = privateOf(m);
    expect(p.subtitle.text).toBe('深入·撤离·生存');
    expect(p.playBtn.label.text).toBe('开始');
    expect(p.routes.squadBtn.label.text).toBe('组队');
    expect(p.settingsBtn.label.text).toBe('设置');
  });

  it('the account chip retexts as a guest, and stops being localisable once signed in', async () => {
    const m = new MainMenu();
    await useLocale('zh');
    m.show(800, 600);
    expect(privateOf(m).accountBtn.label.text).toBe('登录');

    // A NAME has no translation, which is the point: since 2026-09-10 the chip carries the
    // player's, and the localised greeting moved to the portal label below (asserted in the
    // host-forbids-a-login suite, where that label is the thing on screen).
    setSession(ALICE);
    m.show(800, 600);
    expect(privateOf(m).accountBtn.label.text).toBe('alice');
    m.setAccountEntry(false);
    m.show(800, 600);
    expect(privateOf(m).accountLabel.text).toBe('你好，alice');
  });

  it('switching back to English on a later show() fully reverts', async () => {
    const m = new MainMenu();
    await useLocale('zh');
    m.show(800, 600);
    setLocale('en');
    m.show(800, 600);
    expect(privateOf(m).subtitle.text).toBe('descend, extract, survive');
  });
});

describe('MainMenu — quick play', () => {
  // A game portal allows a first-time visitor at most one click to reach gameplay
  // (`docs.crazygames.com/requirements/gameplay`), and SOLO — this lobby's default primary —
  // goes to the forge first. Quick play adds a PLAY button above the routes that starts a
  // run directly, and hands it the green (see the hierarchy suite above).

  it('hides PLAY in the default layout', () => {
    const m = new MainMenu();
    m.show(800, 600);
    expect(privateOf(m).playBtn.view.visible).toBe(false);
  });

  it('reveals PLAY once quick play is on', () => {
    const m = new MainMenu();
    m.setQuickPlay(true);
    m.show(800, 600);
    expect(privateOf(m).playBtn.view.visible).toBe(true);
    expect(privateOf(m).playBtn.label.text).toBe('PLAY');
  });

  it('routes PLAY and SOLO to two different callbacks', () => {
    // The whole point: one starts a run, the other opens the forge. Wiring both to the same
    // handler would satisfy the portal's one-click rule and lose the forge.
    const m = new MainMenu();
    m.setQuickPlay(true);
    const fired: string[] = [];
    m.onPlay = () => fired.push('play');
    m.onSolo = () => fired.push('solo');
    privateOf(m).playBtn.onTap?.();
    privateOf(m).routes.soloBtn.onTap?.();
    expect(fired).toEqual(['play', 'solo']);
  });

  it('makes room for the extra card instead of overlapping the ones below it', () => {
    // The layout is arithmetic on fixed heights, so an added card is exactly the kind of
    // change that silently lands one button on another.
    const m = new MainMenu();
    m.setQuickPlay(true);
    m.show(800, 600);
    const p = privateOf(m);
    const play = screenBox(p.playBtn);
    const solo = screenBox(p.routes.soloBtn);
    const coop = screenBox(p.routes.coopBtn);
    expect(play.y + play.h).toBeLessThanOrEqual(solo.y);
    expect(solo.y + solo.h).toBeLessThanOrEqual(coop.y);
  });

  it('keeps the column centred rather than pushing it off the bottom', () => {
    // The column is centred in the room under the corner row, so a taller one (PLAY above a
    // slim SOLO) grows in both directions around the same middle.
    const mid = (m: MainMenu) => {
      const p = privateOf(m);
      return p.column.position.y + (p.routes.height * p.column.scale.y) / 2;
    };
    const plain = new MainMenu();
    plain.show(800, 800);
    const quick = new MainMenu();
    quick.setQuickPlay(true);
    quick.show(800, 800);
    expect(privateOf(quick).routes.height).toBeGreaterThan(privateOf(plain).routes.height);
    expect(mid(quick)).toBeCloseTo(mid(plain), 5);
  });

  it('fits the tallest lobby there is — portal, notice, full banner — on the shortest design height', () => {
    // A portal build (quick play AND the data notice under the column) with the longest
    // legal banner, on the height `menuLayer.fit` hands back for the 844x390 mini-game phone.
    const m = new MainMenu();
    m.setQuickPlay(true);
    m.setAccountEntry(false);
    withBanner('M'.repeat(BANNER_MAX_LENGTH));
    m.show(1386, 640);
    const p = privateOf(m);
    expect(p.banner.visible).toBe(true);
    // Banner, notice and link all in the strip, and the strip on the screen.
    const k = p.notices.scale.y;
    expect(p.privacyLink.position.y).toBeGreaterThan(p.banner.position.y);
    expect(p.notices.position.y + (p.privacyLink.position.y + 18) * k).toBeLessThan(640);
    // ...and the column, which no longer makes room for either, still fits too.
    expect(p.column.position.y + p.column.scale.y * 10).toBeLessThan(640);
  });
});

describe('MainMenu — a host that forbids a login entry (design/20 account integration)', () => {
  // A game portal disallows a game's own credential login outright: its account rules name
  // email login, a logout that leads back to one, and a login button as a primary call to
  // action. So the button is not drawn at all — `storePlatform.ts`'s precedent, "a build
  // that may not sell renders no entry", rather than a button that is drawn and refuses.

  it('hides the ACCOUNT button', () => {
    const m = new MainMenu();
    m.setAccountEntry(false);
    m.show(800, 600);
    expect(privateOf(m).accountBtn.view.visible).toBe(false);
  });

  it('keeps it by default, so every other target is unchanged', () => {
    const m = new MainMenu();
    m.show(800, 600);
    expect(privateOf(m).accountBtn.view.visible).toBe(true);
    expect(privateOf(m).accountLabel.visible).toBe(false);
    expect(privateOf(m).dataNotice.visible).toBe(false);
  });

  it('shows the signed-in name as a LABEL instead — the platform requires it be displayed', () => {
    setSession(ALICE);
    const m = new MainMenu();
    m.setAccountEntry(false);
    m.show(800, 600);
    expect(privateOf(m).accountLabel.visible).toBe(true);
    expect(privateOf(m).accountLabel.text).toBe('Hi, alice');
    setSession(null);
  });

  it('shows NO label for a guest — there is nothing they could act on', () => {
    const m = new MainMenu();
    m.setAccountEntry(false);
    m.show(800, 600);
    expect(privateOf(m).accountLabel.visible).toBe(false);
    expect(privateOf(m).accountLabel.text).toBe('');
  });

  it('follows a login that lands after the menu was drawn', () => {
    // The portal signs the player in asynchronously, from the entry point, so the label has
    // to be reachable without re-showing the screen (`refreshAccountLabel`, which
    // `gameWiring.ts` drives off `sessionEvents.ts`).
    const m = new MainMenu();
    m.setAccountEntry(false);
    m.show(800, 600);
    expect(privateOf(m).accountLabel.visible).toBe(false);
    setSession(ALICE);
    m.refreshAccountLabel();
    expect(privateOf(m).accountLabel.visible).toBe(true);
    expect(privateOf(m).accountLabel.text).toBe('Hi, alice');
    setSession(null);
    m.refreshAccountLabel();
    expect(privateOf(m).accountLabel.visible).toBe(false);
  });

  it('keeps SETTINGS pinned top-right whether or not ACCOUNT is drawn', () => {
    const paired = new MainMenu();
    paired.show(800, 600);
    const alone = new MainMenu();
    alone.setAccountEntry(false);
    alone.show(800, 600);
    expect(screenBox(privateOf(alone).settingsBtn)).toEqual(screenBox(privateOf(paired).settingsBtn));
  });

  it('shows the data notice in the top-third strip, not at the bottom edge the banner ad owns', () => {
    // Nobody types anything on a portal, so the one screen they do see has to say what is
    // stored. `BannerHost` owns the bottom of the viewport, so this sits in the notice strip.
    const m = new MainMenu();
    m.setAccountEntry(false);
    m.show(800, 600);
    const p = privateOf(m);
    const notice = p.dataNotice;
    expect(notice.visible).toBe(true);
    expect(notice.text).toContain('CrazyGames');
    expect(p.notices.visible).toBe(true);
    const y = p.notices.position.y + notice.position.y * p.notices.scale.y;
    expect(y).toBeGreaterThan(0);
    expect(y).toBeLessThan(600 / 2);
  });

  it('translates the notice with the rest of the screen', async () => {
    const m = new MainMenu();
    m.setAccountEntry(false);
    m.show(800, 600);
    const english = privateOf(m).dataNotice.text;
    await useLocale('zh');
    m.show(800, 600);
    expect(privateOf(m).dataNotice.text).not.toBe(english);
    expect(privateOf(m).dataNotice.text.length).toBeGreaterThan(0);
  });

  it('links to the hosted policy, below the notice it belongs to', () => {
    // design/20 required a hosted document as well as the in-game notice; this is the link
    // to it. Below the notice rather than beside it, because the notice wraps to two lines
    // in most locales and a link on the same row would collide with the second.
    const m = new MainMenu();
    m.setAccountEntry(false);
    m.show(800, 600);
    const link = privateOf(m).privacyLink;
    expect(link.visible).toBe(true);
    expect(link.text.length).toBeGreaterThan(0);
    expect(link.position.y).toBeGreaterThan(privateOf(m).dataNotice.position.y);
    // Tappable, unlike every other thing under the card.
    expect(link.eventMode).toBe('static');
    expect(link.cursor).toBe('pointer');
  });

  it('opens the policy when tapped', () => {
    const m = new MainMenu();
    m.setAccountEntry(false);
    m.show(800, 600);
    const open = vi.fn();
    const original = globalThis.open;
    (globalThis as { open?: unknown }).open = open;
    try {
      privateOf(m).privacyLink.emit('pointertap');
    } finally {
      (globalThis as { open?: unknown }).open = original;
    }
    // The absolute URL matters more than the exact host: a relative one would resolve
    // against the PORTAL's origin inside its frame (`platform/policyLinks.ts`).
    expect(open).toHaveBeenCalledTimes(1);
    expect(String(open.mock.calls[0]![0])).toMatch(/^https:\/\//);
    expect(open.mock.calls[0]![1]).toBe('_blank');
  });

  it('renders NO link on a target that keeps its own login', () => {
    // The notice and the link are both the portal's requirement; on our own domain the
    // equivalent pair lives on `LoginScreen`, at its own point of collection.
    const m = new MainMenu();
    m.show(800, 600);
    expect(privateOf(m).privacyLink.visible).toBe(false);
  });

  it('translates the link with the rest of the screen', async () => {
    const m = new MainMenu();
    m.setAccountEntry(false);
    m.show(800, 600);
    const english = privateOf(m).privacyLink.text;
    await useLocale('zh');
    m.show(800, 600);
    expect(privateOf(m).privacyLink.text).not.toBe(english);
    expect(privateOf(m).privacyLink.text.length).toBeGreaterThan(0);
  });

  // ── CONTINUE RUN on the front door (design/10, 2026-09-17) ──────────────────────────
  //
  // The report: a player who saved on floor 3 last night opens the game and the lobby says
  // nothing about it — CONTINUE RUN lived in the Forge, one click behind SOLO PvE. The row
  // below is the fix, and what these cases pin is the three paths its acceptance named.

  it('draws no CONTINUE row when the provider says there is nothing to continue', () => {
    // Also the DEFAULT provider, which is what an assembly that forgets to wire one gets:
    // no row, rather than a row that leads nowhere.
    const m = new MainMenu();
    m.show(800, 600);
    expect(privateOf(m).routes.continueBtn.view.visible).toBe(false);
  });

  it('draws the row, and asks the provider again on every show', () => {
    // A save is written from the pause menu mid-session, so a value read once at boot would
    // leave the lobby denying a run the player saved four minutes ago. The provider shape is
    // `Forge.savedRun`'s, for exactly this reason.
    let saved: SavedRunSummary | null = null;
    const m = new MainMenu();
    m.resumableRun = () => saved;
    m.show(800, 600);
    expect(privateOf(m).routes.continueBtn.view.visible).toBe(false);

    saved = { floorIndex: 2, ticks: 9000, savedAtMs: 0 };
    m.show(800, 600);
    expect(privateOf(m).routes.continueBtn.view.visible).toBe(true);
    expect(privateOf(m).routes.continueBtn.hint.text).toContain('3'); // floor, 1-based

    saved = null;
    m.show(800, 600);
    expect(privateOf(m).routes.continueBtn.view.visible).toBe(false);
  });

  it('forwards the CONTINUE row tap to onContinue', () => {
    const m = new MainMenu();
    const hits: string[] = [];
    m.onContinue = () => hits.push('continue');
    m.onSolo = () => hits.push('solo');
    m.onPlay = () => hits.push('play');
    m.resumableRun = () => ({ floorIndex: 0, ticks: 30, savedAtMs: 0 });
    m.show(800, 600);
    privateOf(m).routes.continueBtn.onTap?.();
    expect(hits).toEqual(['continue']);
  });

  it('grows the column by the card it added, keeping it on screen', () => {
    const plain = new MainMenu();
    plain.show(800, 600);
    const saved = new MainMenu();
    saved.resumableRun = () => ({ floorIndex: 2, ticks: 9000, savedAtMs: 0 });
    saved.show(800, 600);
    const a = privateOf(plain);
    const b = privateOf(saved);
    expect(b.routes.height).toBeGreaterThan(a.routes.height);
    const cont = screenBox(b.routes.continueBtn);
    const solo = screenBox(b.routes.soloBtn);
    expect(cont.y + cont.h).toBeLessThanOrEqual(solo.y);
    const dock = screenBox(b.routes.squadBtn);
    expect(dock.y + dock.h).toBeLessThanOrEqual(600);
  });

  it('gives the portal CONTINUE instead of PLAY, never both', () => {
    // Both answer "start playing now", and the platform requirement behind PLAY is about a
    // FIRST-time visitor reaching gameplay in one click — which a player with an unfinished
    // run is not. Stacking them also does not fit: the tallest legal lobby measured 702px
    // against a 640px design height (see `applyPrimary`).
    const GREEN = 0x2f855a;
    const m = new MainMenu();
    m.setQuickPlay(true);
    m.show(800, 600);
    expect(m['playBtn'].view.visible).toBe(true);
    expect(privateOf(m).routes.continueBtn.view.visible).toBe(false);

    m.resumableRun = () => ({ floorIndex: 2, ticks: 9000, savedAtMs: 0 });
    m.show(800, 600);
    expect(m['playBtn'].view.visible).toBe(false);
    expect(privateOf(m).routes.continueBtn.view.visible).toBe(true);
    // ...and the green goes with the slot, so the card still has exactly one primary.
    expect(fillOf(privateOf(m).routes.continueBtn)).toBe(GREEN);
    expect(fillOf(privateOf(m).routes.soloBtn)).not.toBe(GREEN);
  });
});
describe('MainMenu — lobby art that lands after the first frame (2026-09-28)', () => {
  // Through the REAL uiSkins module and its real `lobby`-tier load, with only Pixi's loader
  // stubbed: the property is that a lobby shown before its decoration arrived ends up dressed,
  // and a stub of `onUiTexture` could not tell a wired-up menu from one that never listens.
  afterEach(() => resetUiSkinsForTests());

  it('re-lays itself out on the next frame, and shows the hero and banners', async () => {
    resetUiSkinsForTests();
    const m = new MainMenu();
    m.lobbyProfile = () => ({ skinId: 'vanguard', forgeReady: 0, bestFloor: 0 });
    m.show(1280, 720);
    const hero = (m as unknown as { hero: { view: { visible: boolean; alpha: number } } }).hero;
    const solo = (m as unknown as { routes: { soloBtn: { art: { visible: boolean } } } }).routes.soloBtn;
    expect(hero.view.visible).toBe(false);
    expect(solo.art.visible).toBe(false);

    const tex = new Texture({ source: new TextureSource({ width: 300, height: 360 }) });
    const spy = vi.spyOn(Assets, 'load').mockResolvedValue(tex as never);
    try {
      await preloadUiTier('lobby');
    } finally {
      spy.mockRestore();
    }
    // Nothing changes until a frame runs: ten files land one by one, and each would otherwise
    // cost a full layout of its own.
    expect(hero.view.visible).toBe(false);
    m.update(16);
    expect(hero.view.visible).toBe(true);
    expect(solo.art.visible).toBe(true);
    expect(hero.view.alpha).toBeLessThan(1); // arriving art fades in
  });

  it('ignores a `late` file, and does nothing while hidden', async () => {
    resetUiSkinsForTests();
    const m = new MainMenu();
    m.show(1280, 720);
    const layout = vi.spyOn(m as unknown as { layout(w: number, h: number): void }, 'layout');
    const spy = vi.spyOn(Assets, 'load').mockResolvedValue(Texture.WHITE as never);
    try {
      await preloadUiTier('late');
      m.update(16);
      expect(layout).not.toHaveBeenCalled();
      m.hide();
      await preloadUiTier('lobby');
      m.update(16);
      expect(layout).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
