/**
 * MainMenu (design/10 screen flow). Pixi Container/Text/Graphics construct and mutate
 * fine under plain vitest with no renderer attached (same finding PartyScreen.test.ts/
 * Forge.test.ts made) — asserted here via `.visible`/`.text`, not pixel output.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Graphics } from 'pixi.js';
import { MainMenu } from './MainMenu';
import { getSession, setSession, resetSessionCacheForTests, type Session } from '../../net/session';
import { setLocale, resetLocaleForTests } from '../../i18n';
import { setPublicFlags } from '../../net/clientFlags';
import { BANNER_MAX_LENGTH, PUBLIC_FLAG_DEFAULTS } from '../../net/publicFlags';

const ALICE: Session = { accountId: 'acct-1', username: 'alice', token: 'tok-1' };

/** Every route row on `LobbyRoutes`, reached the same private-cast way as the shell's own
 *  widgets — the merge (2026-09-10) moved these into a composed widget, not out of reach. */
interface Btn {
  label: { text: string };
  onTap: (() => void) | null;
  color: number;
  view: { visible: boolean; position: { x: number; y: number }; children: unknown[] };
}

function privateOf(m: MainMenu) {
  return m as unknown as {
    title: { text: string };
    subtitle: { text: string };
    playBtn: Btn;
    routes: {
      soloBtn: Btn;
      coopBtn: Btn;
      pvpSoloBtn: Btn;
      squadBtn: Btn;
      tutorialBtn: Btn;
      recommendedTag: { text: string; visible: boolean; position: { x: number; y: number } };
    };
    accountBtn: Btn;
    settingsBtn: Btn;
    accountLabel: { text: string; visible: boolean; position: { x: number; y: number } };
    dataNotice: { text: string; visible: boolean; position: { x: number; y: number } };
    banner: { text: string; visible: boolean; anchor: { x: number; y: number }; position: { x: number; y: number } };
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

  it('sits ABOVE the title and never moves the menu block', () => {
    // The layout property the field's own comment claims, asserted rather than described.
    // A banner that added a row would change the geometry `viewportFit.test.ts` measures
    // every other screen against — depending on whether an operator had typed something.
    const plain = new MainMenu();
    plain.show(800, 600);
    // x/y only: a Pixi `ObservablePoint` carries an internal uid, so comparing the objects
    // would fail on two identical layouts.
    const pos = (m: MainMenu): [number, number] => [privateOf(m).routes.soloBtn.view.position.x, privateOf(m).routes.soloBtn.view.position.y];
    const before = pos(plain);

    withBanner('x'.repeat(BANNER_MAX_LENGTH));
    const withIt = new MainMenu();
    withIt.show(800, 600);
    expect(pos(withIt)).toEqual(before);
    // Anchored at its BOTTOM edge, so wrapping grows it upward and its last line stays a
    // fixed distance above the title instead of pushing into it.
    expect(privateOf(withIt).banner.anchor.y).toBe(1);
    expect(privateOf(withIt).banner.position.y).toBeLessThan(
      (privateOf(withIt).title as unknown as { position: { y: number } }).position.y,
    );
    expect(privateOf(withIt).banner.position.y).toBeGreaterThan(0);
  });

  it('is positioned even while hidden, so a later refresh needs no re-layout', () => {
    // Why `show()` positions it unconditionally: `refreshBanner` changes only the text and
    // the visibility, so a banner arriving mid-screen has to already be somewhere sensible.
    // Without this the first live banner would draw at (0, 0).
    const m = new MainMenu();
    m.show(800, 600);
    expect(privateOf(m).banner.visible).toBe(false);
    expect(privateOf(m).banner.position.x).toBe(400);
    expect(privateOf(m).banner.position.y).toBeGreaterThan(0);
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
    expect(privateOf(m).accountBtn.label.text).toBe('Hi, alice');
  });

  it('show() re-reads the session, so a login after construction still surfaces', () => {
    const m = new MainMenu();
    expect(privateOf(m).accountBtn.label.text).toBe('LOGIN');
    setSession(ALICE);
    m.show(800, 600);
    expect(privateOf(m).accountBtn.label.text).toBe('Hi, alice');
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
  it('centers the title on the given viewport and becomes visible', () => {
    const m = new MainMenu();
    m.show(800, 600);
    expect(m.view.visible).toBe(true);
  });
});

// Button hierarchy + backing card (design/10 legibility fix, 2026-08-02): there is exactly
// ONE primary action and it must read as visibly bigger than everything else — SOLO since
// the 2026-09-10 merge, or the quick-play PLAY above it on a portal. ACCOUNT and SETTINGS
// sit side by side rather than stacked so their near-identical icons at small scale stop
// inviting a misclick between two stacked targets.
describe('MainMenu — button hierarchy and layout', () => {
  // Bounds come off each button's `bg` Graphics (view.children[0]), not the whole
  // `view` — `view` also holds the label Text, and measuring a Text's bounds needs a
  // real canvas, which this repo's plain-node vitest doesn't have.
  function bgBounds(btn: { view: { children: unknown[] } }) {
    return (btn.view.children[0] as Graphics).getLocalBounds();
  }

  it('sizes SOLO as the biggest route, the rest below it, ACCOUNT/SETTINGS smallest', () => {
    const m = new MainMenu();
    const p = privateOf(m);
    const soloB = bgBounds(p.routes.soloBtn);
    const squadB = bgBounds(p.routes.squadBtn);
    const coopB = bgBounds(p.routes.coopBtn);
    const accountB = bgBounds(p.accountBtn);
    const settingsB = bgBounds(p.settingsBtn);

    expect(soloB.height).toBeGreaterThan(coopB.height);
    expect(coopB.height).toBeGreaterThan(squadB.height);
    expect(squadB.height).toBeGreaterThanOrEqual(accountB.height);
    expect(accountB.height).toBe(settingsB.height);
    // Every route is full width — see LobbyRoutes' header for the half-width pair that was
    // tried first and what measuring it in eight locales said about it.
    expect(soloB.width).toBe(coopB.width);
    expect(soloB.width).toBeGreaterThan(accountB.width);
  });

  it('gives the card exactly one green primary, and hands it over under quick play', () => {
    // The failure this exists for is the one design/10 recorded on 2026-08-02: two controls
    // of equal weight on one card, reported as clicks landing on the wrong page when the
    // routing was correct all along. The fill is the ranking, so the fill is the assertion.
    const plain = new MainMenu();
    const quick = new MainMenu();
    quick.setQuickPlay(true);
    const GREEN = 0x2f855a;
    expect(privateOf(plain).routes.soloBtn.color).toBe(GREEN);
    expect(privateOf(quick).routes.soloBtn.color).not.toBe(GREEN);
    expect(privateOf(quick).playBtn.color).toBe(GREEN);
    // ...and back, because the switch is a setter and not a one-way door: a screen that
    // could only ever LOSE its primary would be a latent bug in whichever host wires it
    // twice, and it is one line of implementation either way.
    quick.setQuickPlay(false);
    expect(privateOf(quick).routes.soloBtn.color).toBe(GREEN);
  });

  it('stacks the five routes in order, then the utility row', () => {
    const m = new MainMenu();
    m.show(800, 600);
    const p = privateOf(m);
    expect(p.routes.soloBtn.view.position.y).toBeLessThan(p.routes.coopBtn.view.position.y);
    // One column: every route starts at the same x, and no two share a y.
    expect(p.routes.coopBtn.view.position.x).toBe(p.routes.soloBtn.view.position.x);
    expect(p.routes.pvpSoloBtn.view.position.x).toBe(p.routes.soloBtn.view.position.x);
    expect(p.routes.coopBtn.view.position.y).toBeLessThan(p.routes.pvpSoloBtn.view.position.y);
    expect(p.routes.pvpSoloBtn.view.position.y).toBeLessThan(p.routes.squadBtn.view.position.y);
    expect(p.routes.squadBtn.view.position.y).toBeLessThan(p.routes.tutorialBtn.view.position.y);
    expect(p.routes.tutorialBtn.view.position.y).toBeLessThan(p.accountBtn.view.position.y);
    // Side by side, not stacked: same row (y), different column (x).
    expect(p.accountBtn.view.position.y).toBe(p.settingsBtn.view.position.y);
    expect(p.accountBtn.view.position.x).toBeLessThan(p.settingsBtn.view.position.x);
  });

  it('keeps every route inside the card behind it', () => {
    const m = new MainMenu();
    m.show(800, 600);
    const p = privateOf(m) as unknown as {
      menuCard: { view: { position: { x: number }; children: unknown[] } };
      routes: Record<string, { view: { position: { x: number }; children: unknown[] } }>;
    };
    const cardLeft = p.menuCard.view.position.x;
    const cardRight = cardLeft + (p.menuCard.view.children[0] as Graphics).getLocalBounds().width;
    for (const name of ['soloBtn', 'coopBtn', 'pvpSoloBtn', 'squadBtn', 'tutorialBtn']) {
      const btn = p.routes[name]!;
      const left = btn.view.position.x;
      expect(left, name).toBeGreaterThan(cardLeft);
      expect(left + bgBounds(btn).width, name).toBeLessThan(cardRight);
    }
  });

  it('backs the button cluster with a card sized to fully contain it', () => {
    const m = new MainMenu();
    m.show(800, 600);
    const p = privateOf(m) as unknown as {
      menuCard: { view: { position: { x: number; y: number }; children: unknown[] } };
      routes: { soloBtn: { view: { position: { x: number; y: number }; children: unknown[] } } };
      settingsBtn: { view: { position: { x: number; y: number }; children: unknown[] } };
    };
    const card = p.menuCard.view;
    // Panel's own scrim Graphics is children[0] too (see ui/widgets.test.ts's Panel
    // suite for the same convention).
    const cardBounds = (card.children[0] as Graphics).getLocalBounds();
    const playTop = p.routes.soloBtn.view.position.y;
    const settingsBottom = p.settingsBtn.view.position.y + bgBounds(p.settingsBtn).height;

    expect(card.position.y).toBeLessThanOrEqual(playTop);
    expect(card.position.y + cardBounds.height).toBeGreaterThanOrEqual(settingsBottom);
  });
});

describe('MainMenu — i18n (design/17-i18n.md)', () => {
  it('defaults to English', () => {
    const m = new MainMenu();
    const p = privateOf(m);
    expect(p.subtitle.text).toBe('descend, extract, survive');
    expect(p.playBtn.label.text).toBe('PLAY');
  });

  it('retexts its static labels from the active locale on show()', () => {
    const m = new MainMenu();
    setLocale('zh');
    m.show(800, 600);
    const p = privateOf(m);
    expect(p.subtitle.text).toBe('深入·撤离·生存');
    expect(p.playBtn.label.text).toBe('开始');
    expect(p.routes.squadBtn.label.text).toBe('组队');
    expect(p.settingsBtn.label.text).toBe('设置');
  });

  it('the account label also retexts, guest and logged-in alike', () => {
    const m = new MainMenu();
    setLocale('zh');
    m.show(800, 600);
    expect(privateOf(m).accountBtn.label.text).toBe('登录');

    setSession(ALICE);
    m.show(800, 600);
    expect(privateOf(m).accountBtn.label.text).toBe('你好，alice');
  });

  it('switching back to English on a later show() fully reverts', () => {
    const m = new MainMenu();
    setLocale('zh');
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

  it('makes room for the extra row instead of overlapping the ones below it', () => {
    // The layout is hand-computed from a card top plus fixed row heights, so an added row
    // is exactly the kind of change that silently lands a button on top of another. Asserted
    // as "every row is below the previous one by at least its own height".
    const m = new MainMenu();
    m.setQuickPlay(true);
    m.show(800, 600);
    const p = privateOf(m);
    const play = p.playBtn.view.position.y;
    const solo = p.routes.soloBtn.view.position.y;
    const coop = p.routes.coopBtn.view.position.y;
    const squad = p.routes.squadBtn.view.position.y;
    const account = p.accountBtn.view.position.y;
    const pvp = p.routes.pvpSoloBtn.view.position.y;
    expect(solo - play).toBeGreaterThanOrEqual(60);
    expect(coop - solo).toBeGreaterThanOrEqual(48);
    expect(pvp - coop).toBeGreaterThanOrEqual(44);
    expect(squad - pvp).toBeGreaterThanOrEqual(44);
    expect(account - squad).toBeGreaterThanOrEqual(42);
  });

  it('keeps the block centred rather than pushing it off the bottom', () => {
    // `menuLayer.ts`'s fit-scale handles a block that is too tall for the viewport, but only
    // if it is still centred — a block that grows downward only would sit low on a landscape
    // phone even after scaling.
    // 800 tall, not 600: below ~640 the banner reserve (see MainMenu's own constant) puts a
    // floor under the block and the growth stops being symmetric. That floor is deliberate
    // and is asserted on its own below; this test is about the centring above it.
    const plain = new MainMenu();
    plain.show(800, 800);
    const quick = new MainMenu();
    quick.setQuickPlay(true);
    quick.show(800, 800);
    // The FIRST row of each layout — which is SOLO by default and PLAY once quick play adds
    // one above it. Comparing SOLO to SOLO would measure the wrong thing: it is pushed DOWN
    // by the new row even while the block as a whole grows upward.
    const firstRow = (m: MainMenu, quickPlay: boolean) =>
      (quickPlay ? privateOf(m).playBtn : privateOf(m).routes.soloBtn).view.position.y;
    const mid = (m: MainMenu, quickPlay: boolean) =>
      (firstRow(m, quickPlay) + privateOf(m).accountBtn.view.position.y) / 2;
    const plainTop = firstRow(plain, false);
    const quickTop = firstRow(quick, true);
    // Grew in BOTH directions by half the added row, which is what "still centred" means
    // here: the first route moved UP and the utility row moved DOWN.
    expect(quickTop).toBeLessThan(plainTop);
    expect(privateOf(quick).accountBtn.view.position.y)
      .toBeGreaterThan(privateOf(plain).accountBtn.view.position.y);
    expect(mid(quick, true)).toBeCloseTo(mid(plain, false), 5);
  });

  it('never centres the block so high that a full-length banner would be off screen', () => {
    // The tallest configuration there is — a portal build, so quick play AND the data notice
    // under the card — on the shortest design height `menuLayer.fit` ever hands back. The
    // banner is not part of the centred block (it must not move the layout), so the layout
    // owes it room instead, and this is that floor.
    const m = new MainMenu();
    m.setQuickPlay(true);
    m.setAccountEntry(false);
    withBanner('M'.repeat(BANNER_MAX_LENGTH));
    m.show(1386, 640); // 844x390, the mini-game phone, through the fit-scale
    const p = privateOf(m);
    expect(p.banner.visible).toBe(true);
    // The worst legal banner measures 55px tall against the real font at this wrap width
    // (see BANNER_RESERVE, which was measured rather than guessed), and it hangs upward
    // from here.
    expect(p.banner.position.y).toBeGreaterThanOrEqual(55);
    // ...and the other end still fits: the policy link is the lowest thing on the screen.
    expect(p.privacyLink.position.y).toBeLessThan(640);
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

  it('centres SETTINGS across the row its pair used to share', () => {
    const paired = new MainMenu();
    paired.show(800, 600);
    const alone = new MainMenu();
    alone.setAccountEntry(false);
    alone.show(800, 600);
    // 800/2 - 67 = 333: the row's centre, rather than the right-hand half it sat in.
    expect(privateOf(alone).settingsBtn.view.position.x).toBe(333);
    expect(privateOf(paired).settingsBtn.view.position.x).toBe(405);
  });

  it('shows the data notice, below the card and not over the banner', () => {
    // The point of collection moved: nobody types anything on a portal, so the one screen
    // they do see has to say what is stored. `BannerHost` owns the bottom of the viewport,
    // so this sits under the menu card instead.
    const m = new MainMenu();
    m.setAccountEntry(false);
    m.show(800, 600);
    const notice = privateOf(m).dataNotice;
    expect(notice.visible).toBe(true);
    expect(notice.text).toContain('CrazyGames');
    expect(notice.position.y).toBeGreaterThan(privateOf(m).settingsBtn.view.position.y);
    expect(notice.position.y).toBeLessThan(600);
  });

  it('translates the notice with the rest of the screen', () => {
    const m = new MainMenu();
    m.setAccountEntry(false);
    m.show(800, 600);
    const english = privateOf(m).dataNotice.text;
    setLocale('zh');
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

  it('translates the link with the rest of the screen', () => {
    const m = new MainMenu();
    m.setAccountEntry(false);
    m.show(800, 600);
    const english = privateOf(m).privacyLink.text;
    setLocale('zh');
    m.show(800, 600);
    expect(privateOf(m).privacyLink.text).not.toBe(english);
    expect(privateOf(m).privacyLink.text.length).toBeGreaterThan(0);
  });
});
