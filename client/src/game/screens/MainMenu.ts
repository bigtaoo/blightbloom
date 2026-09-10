import { Container, Text } from 'pixi.js';
import { Panel, Button } from '../ui/widgets';
import { LobbyRoutes, LOBBY_ROUTES_W, LOBBY_ROUTES_H } from '../ui/LobbyRoutes';
import { getSession } from '../../net/session';
import { getUiTexture } from '../../render/uiSkins';
import { t } from '../../i18n';
import { openPolicy, policyUrl } from '../../platform/policyLinks';
import { publicFlag } from '../../net/clientFlags';

/** The quick-play button's height — a row this screen only has on a portal. */
const PLAY_H = 60;
/** Title top → card top: the title, the subtitle under it, and the gap. */
const HEADER_H = 88;
/** What the portal's data notice + policy link occupy under the card. */
const NOTICE_BLOCK_H = 14 + 44 + 18;
/**
 * Room kept above the title for a maintenance banner that is not part of the centred block.
 *
 * MEASURED rather than derived, on a real page with the real font (2026-09-10): the tallest
 * legal banner is 140 characters (`@dd/net/publicFlags`), and the worst of those is 140 `M`s,
 * which wraps to three lines and 55px at the 700px width below. A realistic sentence is 38px.
 * It hangs upward from 16px above the title, so 16 + 55 is the floor. Note what the unit
 * suite cannot tell you here — `fakeTextCanvas` measures 0.6em per character, so the same
 * string is two lines and fits under any floor at all. Without this the tallest
 * CONFIGURATION — a portal build, so quick-play plus the data notice — centres high enough
 * that those three lines start above y=0, which is off screen at every viewport
 * `viewportFit.test.ts` sweeps.
 */
const BANNER_RESERVE = 72;

/**
 * The LOBBY — the boot front door and the branch point, one screen (design/10 screen flow).
 *
 * Still called `MainMenu`, and the phase is still `'menu'`: the 2026-09-10 merge changed what
 * this screen CONTAINS, not what it is called, because the `Phase` union and every call site
 * in `ScreenNav` already speak that word. The docs call it the lobby, the code calls it the
 * menu, and this comment is the mapping.
 *
 * What merged, and why. Until 2026-09-10 this screen was PLAY · SQUAD · LOGIN · SETTINGS and
 * PLAY opened a second screen (`ModeSelect.ts`, now deleted) holding SOLO · CO-OP · PVP SOLO
 * QUEUE · TUTORIAL. That split put the two doors into multiplayer on two different screens —
 * SQUAD here, CO-OP and PVP one level deeper — which is the incoherence the report that
 * prompted the merge circled. Folding them together removes a layer rather than adding one:
 * four screens to a run became three.
 *
 * Pure presentation, same shape as PauseMenu.ts/Settings.ts: `gameWiring.ts` owns what each
 * route actually does. `ui/LobbyRoutes.ts` owns the five routes and their layout; everything
 * here is the shell — title, maintenance banner, the account chip, SETTINGS, and (on a game
 * portal only) the one-click PLAY button above the routes and the data notice below them.
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
  /** One-click play, and ONLY on a host that requires it — see `setQuickPlay`. */
  private playBtn: Button;
  private routes = new LobbyRoutes();
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
  /**
   * The operator's maintenance notice (design/21 §4's `ui.maintenanceBanner`, delivered by
   * `GET /client/flags`). Empty means no banner, and empty is the shipped default, so the
   * ordinary lobby is exactly what it was.
   *
   * Read from the flag store rather than passed in, the way `refreshAccountLabel` already
   * reads `getSession()` — the value changes at runtime and no constructor argument can
   * carry that. Three properties worth stating because each one is a decision:
   *
   *  - **It does not affect the layout.** It hangs at a fixed offset ABOVE the title rather
   *    than adding a row the way quick-play's PLAY button does, so a banner arriving while
   *    the lobby is already on screen needs no re-layout. What the layout does owe it is
   *    ROOM: `show()` never places the title higher than `BANNER_RESERVE`, so the tallest
   *    legal banner still lands on screen (see that constant).
   *  - **It is not localised, and cannot be.** The value is one line an operator typed;
   *    there is no key to look up. That is the honest cost of a switch that must work
   *    without a deploy, and it is why the flag is capped at 140 characters and refuses
   *    markup and control characters (`@dd/net/publicFlags`) rather than being a rich
   *    message with a schema.
   *  - **It is stroked, not carded.** A backing `Panel` would have to be sized from
   *    `Text.height`, and reading that forces a canvas text measurement — the thing every
   *    position in this file already avoids, and the reason these screens are unit-testable
   *    with no `document`. A dark stroke buys the same contrast over the hub art for free.
   */
  private banner: Text;
  private quickPlay = false;
  private accountEntry = true;

  /** Quick-play only — see `setQuickPlay`. Every other route is on `routes`. */
  onPlay: (() => void) | null = null;
  onSolo: (() => void) | null = null;
  onCoop: (() => void) | null = null;
  onPvpSolo: (() => void) | null = null;
  onSquad: (() => void) | null = null;
  onTutorial: (() => void) | null = null;
  onAccount: (() => void) | null = null;
  onSettings: (() => void) | null = null;

  constructor() {
    // `padding` guards against a real observed font-metrics clipping bug (see
    // widgets.ts's Button — same mitigation, needed here too since these aren't Buttons).
    this.title = new Text({ text: t('mainMenu.title'), style: { fill: 0xf7fafc, fontSize: 46, fontWeight: 'bold', fontFamily: 'sans-serif', padding: 16 } });
    this.title.anchor.set(0.5, 0);
    this.subtitle = new Text({ text: t('mainMenu.subtitle'), style: { fill: 0x90cdf4, fontSize: 16, fontFamily: 'monospace', padding: 26 } });
    this.subtitle.anchor.set(0.5, 0);

    // Hierarchy (design/10 legibility fix, 2026-08-02, and it survived the merge intact):
    // exactly ONE primary action, filled with the "go" green every other screen in this
    // project uses for its primary — which is SOLO on `routes` by default, and this button
    // instead on a portal. ACCOUNT/SETTINGS are tertiary utility, sized down and placed side
    // by side (not stacked) so their near-identical badge-style icons at small scale don't
    // invite a misclick between two vertically-adjacent targets; distinct chip colors give
    // each a second cue.
    this.playBtn = new Button(t('mainMenu.play'), { w: LOBBY_ROUTES_W, h: PLAY_H, fontSize: 24, color: 0x2f855a, borderColor: 0x68d391 });
    this.playBtn.onTap = () => this.onPlay?.();
    this.playBtn.setIcon(getUiTexture('icon_play'));
    this.playBtn.view.visible = false;

    this.routes.onSolo = () => this.onSolo?.();
    this.routes.onCoop = () => this.onCoop?.();
    this.routes.onPvpSolo = () => this.onPvpSolo?.();
    this.routes.onSquad = () => this.onSquad?.();
    this.routes.onTutorial = () => this.onTutorial?.();

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

    // `breakWords` alongside `wordWrap`, and it is not belt-and-braces: `wordWrap` alone
    // breaks at spaces, so a 140-character banner with none — a URL, a long compound word,
    // or `MMMM…` — cannot wrap at all and runs off both edges of the screen. That is a legal
    // value (`@dd/net/publicFlags` refuses markup and control characters, not long words),
    // and `viewportFit.test.ts`'s banner entry is what caught it: the sweep failed at five
    // of seven viewports the moment the case was actually put in front of it. The 700 is
    // 2026-09-10: at 480 the longest legal banner needed three lines, and the room for the
    // third had to come out of the lobby's own rows (`BANNER_RESERVE`). It stays well inside
    // the 760 design width, which is the narrowest this layer ever hands a screen.
    this.banner = new Text({ text: '', style: { fill: 0xfbd38d, fontSize: 15, fontFamily: 'sans-serif', fontWeight: 'bold', padding: 16, align: 'center', wordWrap: true, wordWrapWidth: 700, breakWords: true, stroke: { color: 0x1a202c, width: 4 } } });
    this.banner.anchor.set(0.5, 1);
    this.banner.visible = false;

    this.view.addChild(
      this.panel.view, this.menuCard.view, this.banner, this.title, this.subtitle,
      this.playBtn.view, this.routes.view, this.accountBtn.view, this.settingsBtn.view,
      this.accountLabel, this.dataNotice, this.privacyLink,
    );
    this.view.eventMode = 'static';
    this.view.visible = false;
  }

  /**
   * Turn on the one-click PLAY button above the routes, and demote SOLO to an ordinary one.
   *
   * A game portal requires that a first-time visitor reach gameplay in at most one click
   * (`docs.crazygames.com/requirements/gameplay`), and SOLO — the default primary — goes to
   * the forge first. Rather than delete the forge route, which is the between-run decision
   * this game is built around, this adds a direct one above it and hands the green to the new
   * button (`LobbyRoutes.setSoloPrimary`), so the card still has exactly one primary action.
   *
   * Called once during assembly, from the host branch in `gameWiring.ts`. Not a constructor
   * argument because `Screens`/`PauseMenu`/every other screen here takes none, and one screen
   * with a different construction signature is how that convention starts to rot.
   */
  setQuickPlay(enabled: boolean): void {
    this.quickPlay = enabled;
    this.playBtn.view.visible = enabled;
    this.routes.setSoloPrimary(!enabled);
  }

  /** Call before `show()` so the TUTORIAL badge reflects `!MetaState.hasSeenTutorial` — the
   *  flag `ScreenFlow.showMenu` now carries in, as it already did for `ModeSelect`. */
  setRecommendTutorial(recommend: boolean): void {
    this.routes.setRecommendTutorial(recommend);
  }

  /**
   * Whether this lobby offers a way INTO the account screen.
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

    // The whole block is CENTRED as one unit, so a host that adds a row (quick-play) or a
    // paragraph (the portal's data notice) stays centred instead of drifting down — and
    // `menuLayer.ts`'s fit-scale then keeps it inside a landscape phone's viewport.
    const extra = this.quickPlay ? PLAY_H + 12 : 0;
    const cardH = 12 + extra + LOBBY_ROUTES_H + 12 + 42 + 24;
    const below = this.accountEntry ? 0 : NOTICE_BLOCK_H;
    // ...but never so high that a maintenance banner would be drawn off the top. The banner
    // is deliberately not part of the block (see its own comment), so the block owes it room
    // rather than a row.
    const top = Math.max(BANNER_RESERVE, cy - (HEADER_H + cardH + below) / 2);

    this.title.position.set(cx, top);
    this.subtitle.position.set(cx, top + 50);
    // Anchored (0.5, 1) — BOTTOM-centre — so it grows UPWARD as it wraps and its last line
    // always sits the same 16px above the title, instead of a two-line notice pushing into
    // it. Positioned unconditionally, hidden or not, which is what lets `refreshBanner`
    // change only the text and the visibility while the lobby is already on screen.
    this.banner.position.set(cx, top - 16);
    this.refreshBanner();

    const cardW = LOBBY_ROUTES_W + 40;
    const cardTop = top + HEADER_H;
    this.menuCard.layout(cardW, cardH);
    this.menuCard.view.position.set(cx - cardW / 2, cardTop);

    if (this.quickPlay) this.playBtn.view.position.set(cx - LOBBY_ROUTES_W / 2, cardTop + 12);
    this.routes.layout(cx, cardTop + 12 + extra);

    const tertiaryY = cardTop + 12 + extra + LOBBY_ROUTES_H + 12;
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

  /**
   * Re-read the maintenance flag and show or hide the notice. Called by `show()`, and
   * subscribed to the flag store by `gameWiring.ts` so a banner an operator sets while a
   * player is sitting in this lobby appears without them having to navigate away and back —
   * which is exactly the player the banner exists for.
   *
   * Nothing here re-lays anything out; see the field's own comment on why it cannot need to.
   */
  refreshBanner() {
    const text = publicFlag('ui.maintenanceBanner');
    this.banner.text = text;
    // An empty banner is hidden rather than drawn as an empty `Text`: a zero-height node in
    // the middle of the lobby is invisible either way, but a hidden one cannot be measured,
    // hit-tested or picked up by a future layout that reads children.
    this.banner.visible = text.length > 0;
  }

  /** Call after a login/register/logout so the chip reflects the current session
   * without needing to re-`show()` the whole lobby. */
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
    this.routes.retext();
    this.settingsBtn.setText(t('mainMenu.settings'));
    this.dataNotice.text = t('auth.portalDataNotice');
    this.privacyLink.text = t('auth.privacyLink');
    this.refreshAccountLabel();
  }
}
