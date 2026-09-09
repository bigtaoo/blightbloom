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

function privateOf(m: MainMenu) {
  return m as unknown as {
    title: { text: string };
    subtitle: { text: string };
    playBtn: { label: { text: string }; onTap: (() => void) | null; view: { position: { x: number; y: number } } };
    modesBtn: {
      label: { text: string };
      onTap: (() => void) | null;
      view: { visible: boolean; position: { x: number; y: number } };
    };
    squadBtn: {
      label: { text: string };
      onTap: (() => void) | null;
      view: { position: { x: number; y: number } };
    };
    accountBtn: {
      label: { text: string };
      onTap: (() => void) | null;
      view: { visible: boolean; position: { x: number; y: number } };
    };
    settingsBtn: {
      label: { text: string };
      onTap: (() => void) | null;
      view: { visible: boolean; position: { x: number; y: number } };
    };
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
    const pos = (m: MainMenu): [number, number] => [privateOf(m).playBtn.view.position.x, privateOf(m).playBtn.view.position.y];
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
    const m = new MainMenu();
    const p = privateOf(m);
    const calls: string[] = [];
    m.onPlay = () => calls.push('play');
    m.onSquad = () => calls.push('squad');
    m.onAccount = () => calls.push('account');
    m.onSettings = () => calls.push('settings');

    p.playBtn.onTap?.();
    p.squadBtn.onTap?.();
    p.accountBtn.onTap?.();
    p.settingsBtn.onTap?.();

    expect(calls).toEqual(['play', 'squad', 'account', 'settings']);
  });
});

describe('MainMenu — show()', () => {
  it('centers the title on the given viewport and becomes visible', () => {
    const m = new MainMenu();
    m.show(800, 600);
    expect(m.view.visible).toBe(true);
  });
});

// Button hierarchy + backing card (design/10 legibility fix, 2026-08-02): PLAY is the
// one primary action and must read as visibly bigger than everything else; ACCOUNT and
// SETTINGS moved from a vertical stack to a side-by-side row so their near-identical
// icons at small scale stop inviting a misclick between two stacked targets.
describe('MainMenu — button hierarchy and layout', () => {
  // Bounds come off each button's `bg` Graphics (view.children[0]), not the whole
  // `view` — `view` also holds the label Text, and measuring a Text's bounds needs a
  // real canvas, which this repo's plain-node vitest doesn't have.
  function bgBounds(btn: { view: { children: unknown[] } }) {
    return (btn.view.children[0] as Graphics).getLocalBounds();
  }

  it('sizes PLAY as the biggest button, SQUAD next, ACCOUNT/SETTINGS smallest', () => {
    const m = new MainMenu();
    const p = privateOf(m) as unknown as {
      playBtn: { view: { children: unknown[] } };
      squadBtn: { view: { children: unknown[] } };
      accountBtn: { view: { children: unknown[] } };
      settingsBtn: { view: { children: unknown[] } };
    };
    const playB = bgBounds(p.playBtn);
    const squadB = bgBounds(p.squadBtn);
    const accountB = bgBounds(p.accountBtn);
    const settingsB = bgBounds(p.settingsBtn);

    expect(playB.height).toBeGreaterThan(squadB.height);
    expect(squadB.height).toBeGreaterThan(accountB.height);
    expect(accountB.height).toBe(settingsB.height);
    expect(playB.width).toBeGreaterThanOrEqual(squadB.width);
    expect(squadB.width).toBeGreaterThan(accountB.width);
  });

  it('stacks PLAY above SQUAD above a side-by-side ACCOUNT/SETTINGS row', () => {
    const m = new MainMenu();
    m.show(800, 600);
    const p = privateOf(m) as unknown as {
      playBtn: { view: { position: { x: number; y: number } } };
      squadBtn: { view: { position: { x: number; y: number } } };
      accountBtn: { view: { position: { x: number; y: number } } };
      settingsBtn: { view: { position: { x: number; y: number } } };
    };
    expect(p.playBtn.view.position.y).toBeLessThan(p.squadBtn.view.position.y);
    expect(p.squadBtn.view.position.y).toBeLessThan(p.accountBtn.view.position.y);
    // Side by side, not stacked: same row (y), different column (x).
    expect(p.accountBtn.view.position.y).toBe(p.settingsBtn.view.position.y);
    expect(p.accountBtn.view.position.x).toBeLessThan(p.settingsBtn.view.position.x);
  });

  it('backs the button cluster with a card sized to fully contain it', () => {
    const m = new MainMenu();
    m.show(800, 600);
    const p = privateOf(m) as unknown as {
      menuCard: { view: { position: { x: number; y: number }; children: unknown[] } };
      playBtn: { view: { position: { x: number; y: number }; children: unknown[] } };
      settingsBtn: { view: { position: { x: number; y: number }; children: unknown[] } };
    };
    const card = p.menuCard.view;
    // Panel's own scrim Graphics is children[0] too (see ui/widgets.test.ts's Panel
    // suite for the same convention).
    const cardBounds = (card.children[0] as Graphics).getLocalBounds();
    const playTop = p.playBtn.view.position.y;
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
    expect(p.squadBtn.label.text).toBe('组队');
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
  // (`docs.crazygames.com/requirements/gameplay`), and this menu's default route is four:
  // PLAY -> SELECT MODE -> SOLO PvE -> START RUN. Quick play makes PLAY direct and keeps the
  // old route on a second button, so nothing becomes unreachable.

  it('hides SELECT MODE in the default layout', () => {
    const m = new MainMenu();
    m.show(800, 600);
    expect(privateOf(m).modesBtn.view.visible).toBe(false);
  });

  it('reveals SELECT MODE once quick play is on', () => {
    const m = new MainMenu();
    m.setQuickPlay(true);
    m.show(800, 600);
    expect(privateOf(m).modesBtn.view.visible).toBe(true);
    expect(privateOf(m).modesBtn.label.text).toBe('SELECT MODE');
  });

  it('routes the two buttons to two different callbacks', () => {
    // The whole point: PLAY stops being the way to the mode list, so both have to be wired
    // and they must not be the same handler.
    const m = new MainMenu();
    m.setQuickPlay(true);
    const fired: string[] = [];
    m.onPlay = () => fired.push('play');
    m.onModes = () => fired.push('modes');
    privateOf(m).playBtn.onTap?.();
    privateOf(m).modesBtn.onTap?.();
    expect(fired).toEqual(['play', 'modes']);
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
    const modes = p.modesBtn.view.position.y;
    const squad = p.squadBtn.view.position.y;
    const account = p.accountBtn.view.position.y;
    expect(modes - play).toBeGreaterThanOrEqual(68);
    expect(squad - modes).toBeGreaterThanOrEqual(50);
    expect(account - squad).toBeGreaterThanOrEqual(50);
  });

  it('keeps the block centred rather than pushing it off the bottom', () => {
    // `menuLayer.ts`'s fit-scale handles a block that is too tall for the viewport, but only
    // if it is still centred — a block that grows downward only would sit low on a landscape
    // phone even after scaling.
    const plain = new MainMenu();
    plain.show(800, 600);
    const quick = new MainMenu();
    quick.setQuickPlay(true);
    quick.show(800, 600);
    const mid = (m: MainMenu) =>
      (privateOf(m).playBtn.view.position.y + privateOf(m).accountBtn.view.position.y) / 2;
    const plainTop = privateOf(plain).playBtn.view.position.y;
    const quickTop = privateOf(quick).playBtn.view.position.y;
    // Grew in BOTH directions by half the added row, which is what "still centred" means
    // here — the midpoint between the first and last row is unchanged.
    expect(quickTop).toBeLessThan(plainTop);
    expect(privateOf(quick).accountBtn.view.position.y)
      .toBeGreaterThan(privateOf(plain).accountBtn.view.position.y);
    expect(mid(quick)).toBeCloseTo(mid(plain), 5);
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
