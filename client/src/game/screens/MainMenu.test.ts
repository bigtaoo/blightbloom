/**
 * MainMenu (design/10 screen flow). Pixi Container/Text/Graphics construct and mutate
 * fine under plain vitest with no renderer attached (same finding PartyScreen.test.ts/
 * Forge.test.ts made) — asserted here via `.visible`/`.text`, not pixel output.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Graphics } from 'pixi.js';
import { MainMenu } from './MainMenu';
import { getSession, setSession, resetSessionCacheForTests, type Session } from '../../net/session';
import { setLocale, resetLocaleForTests } from '../../i18n';

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
      view: { position: { x: number; y: number } };
    };
    settingsBtn: { label: { text: string }; onTap: (() => void) | null };
  };
}

beforeEach(() => resetSessionCacheForTests());
afterEach(() => resetLocaleForTests());

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
