import { Container, Text } from 'pixi.js';
import { Panel, Button } from '../ui/widgets';
import { getSession } from '../../net/session';
import { getUiTexture } from '../../render/uiSkins';
import { t } from '../../i18n';
import { openPolicy, policyUrl } from '../../platform/policyLinks';

/**
 * The boot/main-menu screen (design/10 screen flow — the front door that never got
 * built). Pure presentation, same shape as PauseMenu.ts/Settings.ts: Game owns what
 * each button actually does. Deliberately minimal (design/10's "clutter" decision) —
 * PvP arena entry is still a URL-flag boot-time choice (see Game.ts's `online`/`pvp`/
 * `arenaDemo` fields); SQUAD is the one runtime entry point added so far (design/05/15's
 * PvP squad follow-up) — a pre-formed party still needs somewhere to be created/joined
 * before a run starts, which a boot-time flag alone can't offer. ACCOUNT (design/16
 * -accounts.md) opens login/register; its label reflects the current session so a
 * logged-in player sees who they are without opening the screen.
 */
export class MainMenu {
  readonly view = new Container();
  private panel = new Panel({ alpha: 0.82, background: 'hub' });
  // A dedicated card behind the nav buttons (design/10 legibility fix, 2026-08-02):
  // the hub art's brightness varies a lot behind where the buttons sit, so relying on
  // the button fill alone for contrast made them nearly disappear over the lighter
  // stonework. A flat, consistently-dark backing card guarantees contrast regardless
  // of what's in the art underneath.
  private menuCard = new Panel({ radius: 18, color: 0x05070c, alpha: 0.62, borderColor: 0x3a4a5c, borderAlpha: 0.5 });
  private title: Text;
  private subtitle: Text;
  private playBtn: Button;
  private modesBtn: Button;
  private squadBtn: Button;
  private accountBtn: Button;
  private settingsBtn: Button;
  /** Shown INSTEAD of the ACCOUNT button where a host forbids a login entry point — see
   *  `setAccountEntry`. Never interactive: it states who the player is, it does not offer
   *  to change it. */
  private accountLabel: Text;
  /** The data notice a host may require at the point of collection — see `setAccountEntry`.
   *  One line, under the menu card, never over gameplay: the platform's own wording for
   *  what it wants is "unobtrusive rather than blocking". */
  private dataNotice: Text;
  /** The hosted-policy link that goes WITH the notice above. Rendered only where a URL
   *  actually exists (`policyLinks.ts`), because a link to nowhere is worse than none. */
  private privacyLink: Text;
  private quickPlay = false;
  private accountEntry = true;

  onPlay: (() => void) | null = null;
  /** Only wired in quick-play mode — see `setQuickPlay`. */
  onModes: (() => void) | null = null;
  onSquad: (() => void) | null = null;
  onAccount: (() => void) | null = null;
  onSettings: (() => void) | null = null;

  constructor() {
    // `padding` guards against a real observed font-metrics clipping bug (see
    // widgets.ts's Button — same mitigation, needed here too since these aren't Buttons).
    this.title = new Text({ text: t('mainMenu.title'), style: { fill: 0xf7fafc, fontSize: 46, fontWeight: 'bold', fontFamily: 'sans-serif', padding: 16 } });
    this.title.anchor.set(0.5, 0);
    this.subtitle = new Text({ text: t('mainMenu.subtitle'), style: { fill: 0x90cdf4, fontSize: 16, fontFamily: 'monospace', padding: 26 } });
    this.subtitle.anchor.set(0.5, 0);

    // Hierarchy (design/10 legibility fix, 2026-08-02): PLAY is the one primary
    // action — biggest, filled with the same "go" green every other screen in this
    // project uses for its primary action (PartyScreen's START MATCHING, LoginScreen's
    // REGISTER), with a matching bright border so it reads as the obvious next step.
    // SQUAD is the one secondary action a run needs before it starts. ACCOUNT/SETTINGS
    // are tertiary utility — sized down and placed side by side (not stacked) so their
    // near-identical badge-style icons at small scale don't invite a misclick between
    // two vertically-adjacent targets; distinct chip colors give each a second cue.
    this.playBtn = new Button(t('mainMenu.play'), { w: 280, h: 68, fontSize: 26, color: 0x2f855a, borderColor: 0x68d391 });
    this.playBtn.onTap = () => this.onPlay?.();
    this.playBtn.setIcon(getUiTexture('icon_play'));
    // Quick-play's companion (see `setQuickPlay`): with PLAY taken over by "start a run
    // now", this is where SELECT MODE — and with it co-op, PvP and the tutorial — stays
    // reachable. Hidden entirely in the default layout, where PLAY already opens it.
    this.modesBtn = new Button(t('mainMenu.modes'), { w: 280, h: 50, fontSize: 18, borderColor: 0x718096 });
    this.modesBtn.onTap = () => this.onModes?.();
    this.modesBtn.setIcon(getUiTexture('icon_play'), 0x2c5282);
    this.modesBtn.view.visible = false;
    this.squadBtn = new Button(t('mainMenu.squad'), { w: 280, h: 50, fontSize: 18, borderColor: 0x718096 });
    this.squadBtn.onTap = () => this.onSquad?.();
    this.squadBtn.setIcon(getUiTexture('icon_squad'), 0x2c5282);
    this.accountBtn = new Button(t('mainMenu.account'), { w: 135, h: 42, fontSize: 14, borderColor: 0x718096 });
    this.accountBtn.onTap = () => this.onAccount?.();
    this.accountBtn.setIcon(getUiTexture('icon_account'), 0x6b46c1);
    this.settingsBtn = new Button(t('mainMenu.settings'), { w: 135, h: 42, fontSize: 14, borderColor: 0x718096 });
    this.settingsBtn.onTap = () => this.onSettings?.();
    this.settingsBtn.setIcon(getUiTexture('icon_settings'), 0x4a5568);
    this.accountLabel = new Text({ text: '', style: { fill: 0x90cdf4, fontSize: 14, fontFamily: 'monospace', padding: 16 } });
    this.accountLabel.anchor.set(0.5, 0.5);
    this.accountLabel.visible = false;
    this.dataNotice = new Text({ text: '', style: { fill: 0x718096, fontSize: 11, fontFamily: 'sans-serif', padding: 12, align: 'center', wordWrap: true, wordWrapWidth: 420 } });
    this.dataNotice.anchor.set(0.5, 0);
    this.dataNotice.visible = false;
    // Underlined and link-coloured because it is the one thing under the card that is
    // tappable, and nothing else on this row is.
    this.privacyLink = new Text({ text: '', style: { fill: 0x63b3ed, fontSize: 11, fontFamily: 'sans-serif', padding: 12, align: 'center' } });
    this.privacyLink.anchor.set(0.5, 0);
    this.privacyLink.visible = false;
    this.privacyLink.eventMode = 'static';
    this.privacyLink.cursor = 'pointer';
    this.privacyLink.on('pointertap', () => openPolicy('privacy'));

    this.view.addChild(
      this.panel.view, this.menuCard.view, this.title, this.subtitle,
      this.playBtn.view, this.modesBtn.view, this.squadBtn.view, this.accountBtn.view, this.settingsBtn.view,
      this.accountLabel, this.dataNotice, this.privacyLink,
    );
    this.view.eventMode = 'static';
    this.view.visible = false;
  }

  /**
   * Turn PLAY into "start a run right now" and reveal SELECT MODE beside it.
   *
   * A game portal requires that a first-time visitor reach gameplay in at most one click
   * (`docs.crazygames.com/requirements/gameplay`), and the default route through this menu
   * is four. Rather than delete the route — the forge is the between-run decision this game
   * is built around, and the portal's rule is about the FIRST click, not about the loop —
   * this makes the front door direct and keeps the old door next to it. `Game` still owns
   * what each button does; this only decides which two are on screen.
   *
   * Called once during assembly, from the host branch in `gameWiring.ts`. Not a constructor
   * argument because `Screens`/`ModeSelect`/every other screen here takes none, and one
   * screen with a different construction signature is how that convention starts to rot.
   */
  setQuickPlay(enabled: boolean): void {
    this.quickPlay = enabled;
    this.modesBtn.view.visible = enabled;
  }

  /**
   * Whether this menu offers a way INTO the account screen.
   *
   * `false` on a game portal, and the reason is policy rather than taste: that platform
   * forbids a game's own credential login outright (its account rules name email login,
   * a logout that leads back to one, and a login button as a primary call to action —
   * `docs.crazygames.com/requirements/account-integration`), and a portal player is signed
   * in silently instead (`platform/crazygames/portalAuth.ts`). So there is nothing for this
   * button to open and nothing for the player to do.
   *
   * What replaces it is a plain LABEL, not a disabled button: the platform also requires
   * that the CrazyGames username be shown, and `storePlatform.ts`'s own precedent here is
   * "a build that may not sell renders no entry at all" rather than one that is drawn and
   * refuses. Same shape as `setQuickPlay`, called from the same host branch in
   * `gameWiring.ts`.
   */
  setAccountEntry(enabled: boolean): void {
    this.accountEntry = enabled;
    this.accountBtn.view.visible = enabled;
    // The notice comes WITH the silent login rather than as a second switch, because it is
    // the same fact from the player's side: nobody typed anything, so nobody was shown what
    // it stores, so the one screen they do see has to say it. `LoginScreen` carries the
    // equivalent line on every other target, at its own point of collection.
    this.dataNotice.visible = !enabled;
    // Same gate as the notice, AND a URL has to exist — design/20's rule that nothing
    // renders a link until one does.
    this.privacyLink.visible = !enabled && policyUrl('privacy') !== null;
  }

  show(w: number, h: number) {
    this.retext();
    this.panel.layout(w, h);
    const cx = w / 2;
    const cy = h / 2;

    // One extra row in quick-play mode. The card grows and the whole block shifts up by
    // half the growth so it stays centred — `menuLayer.ts`'s fit-scale then keeps it inside
    // a landscape phone's viewport exactly as it does the shorter version.
    const extra = this.quickPlay ? 50 + 12 : 0;
    this.title.position.set(cx, cy - 150 - extra / 2);
    this.subtitle.position.set(cx, cy - 96 - extra / 2);

    const cardW = 280 + 40;
    const cardTop = cy - 44 - extra / 2;
    const cardH = 68 + 12 + 50 + 12 + 42 + 24 + extra;
    this.menuCard.layout(cardW, cardH);
    this.menuCard.view.position.set(cx - cardW / 2, cardTop);

    this.playBtn.view.position.set(cx - 140, cardTop + 12);
    let y = cardTop + 12 + 68 + 12;
    if (this.quickPlay) {
      this.modesBtn.view.position.set(cx - 140, y);
      y += 50 + 12;
    }
    this.squadBtn.view.position.set(cx - 140, y);
    const tertiaryY = y + 50 + 12;
    if (this.accountEntry) {
      this.accountBtn.view.position.set(cx - 140, tertiaryY);
      this.settingsBtn.view.position.set(cx + 5, tertiaryY);
    } else {
      // SETTINGS takes the whole tertiary row rather than staying in its half, so the row
      // does not read as one button that lost its pair.
      this.settingsBtn.view.position.set(cx - 67, tertiaryY);
      this.accountLabel.position.set(cx, cardTop - 24);
      // Below the card, not at the screen bottom: `BannerHost` owns the bottom centre of a
      // portal page, and a notice underneath an ad is a notice nobody reads.
      this.dataNotice.position.set(cx, cardTop + cardH + 14);
      // Under the notice it belongs to, not beside it: the notice wraps to two lines on a
      // narrow portal frame and a link on the same row would collide with the second.
      //
      // A FIXED offset rather than `dataNotice.height`, which every other position in this
      // file also avoids: reading `.height` on a Pixi `Text` forces a canvas text
      // measurement, and these screens are unit-tested with no `document` at all. 44px
      // clears three wrapped lines at this font size, one more than the longest locale needs.
      this.privacyLink.position.set(cx, cardTop + cardH + 14 + 44);
    }
    this.refreshAccountLabel();
    this.view.visible = true;
  }

  hide() {
    this.view.visible = false;
  }

  /** Call after a login/register/logout so the button reflects the current session
   * without needing to re-`show()` the whole menu. */
  refreshAccountLabel() {
    const session = getSession();
    const greeting = session ? t('mainMenu.greeting', { username: session.username }) : t('mainMenu.account');
    this.accountBtn.setText(greeting);
    // Without an account entry there is no "log in" state to advertise, so a guest gets no
    // label at all — an empty row rather than a prompt the player cannot act on.
    this.accountLabel.text = session ? greeting : '';
    this.accountLabel.visible = !this.accountEntry && session !== null;
  }

  /** Re-apply every static label from the active locale — called on `show()` so a
   * language change made in Settings (design/17-i18n.md) takes effect the next time
   * this screen is opened, without needing a global re-render hook. */
  private retext() {
    this.title.text = t('mainMenu.title');
    this.subtitle.text = t('mainMenu.subtitle');
    this.playBtn.setText(t('mainMenu.play'));
    this.modesBtn.setText(t('mainMenu.modes'));
    this.squadBtn.setText(t('mainMenu.squad'));
    this.settingsBtn.setText(t('mainMenu.settings'));
    this.dataNotice.text = t('auth.portalDataNotice');
    this.privacyLink.text = t('auth.privacyLink');
    this.refreshAccountLabel();
  }
}
