import { Container, Sprite, Text } from 'pixi.js';
import { Button } from '../ui/widgets';
import { LobbyRoutes, LOBBY_ROUTES_W, LOBBY_PRIMARY_H } from '../ui/LobbyRoutes';
import { LobbyCard } from '../ui/LobbyCard';
import { LobbyBackdrop } from '../ui/LobbyBackdrop';
import { LobbyHero } from '../ui/LobbyHero';
import { LobbyResources, type MaterialCounts } from '../ui/LobbyResources';
import { lobbyScale, sharpenText } from '../ui/lobbyScale';
import type { SavedRunSummary } from '../match/runSave';
import { getSession } from '../../net/session';
import { getUiTexture } from '../../render/uiSkins';
import { t, getLocale } from '../../i18n';
import { openPolicy, policyUrl } from '../../platform/policyLinks';
import { publicFlag } from '../../net/clientFlags';

/**
 * Longest name the account chip will draw, in characters, before it ellipsises — a bound
 * rather than a fit: the chip grows to whatever it is given (`autoWidth`), so this only stops
 * one absurd name from pushing it into the logo.
 */
const NAME_MAX = 12;

function clipName(name: string): string {
  return name.length <= NAME_MAX ? name : `${name.slice(0, NAME_MAX - 1)}…`;
}

/** The corner chrome's inset from the viewport edge, and its row height (unscaled). */
const EDGE = 14;
const CHROME_H = 40;
/**
 * Room kept under the corner row for a maintenance banner. MEASURED on a real page with the
 * real font (2026-09-10): the worst legal banner (140 `M`s, `@dd/net/publicFlags`) wraps to
 * three lines and 55px at a 700px wrap. `fakeTextCanvas` measures 0.6em per character and
 * would call the same string two lines, so this is a floor the unit suite cannot derive.
 */
const BANNER_RESERVE = 72;
/** The logo's width in the lobby's own units, and the tagline's room under it. */
const LOGO_W = 300;
const TAGLINE_H = 24;
/** What the portal's data notice + policy link occupy under the column. */
const NOTICE_BLOCK_H = 12 + 44 + 18;

/**
 * The LOBBY — the boot front door and the branch point (design/10 screen flow). Still called
 * `MainMenu`, and the phase is still `'menu'`: the `Phase` union and every call site in
 * `ScreenNav` speak that word. The docs call it the lobby; this comment is the mapping.
 *
 * ## The layout (design/10 "The lobby, redesigned", 2026-09-27)
 *
 * The report was that the old centred card "looks empty, the hierarchy is unclear, and the
 * whole screen is too dark". The answer is a scene rather than a menu:
 *
 *  - the painted outpost at full value (`LobbyBackdrop` — no scrim), with the player's own
 *    character hovering on its dais (`LobbyHero`) and the logo above it;
 *  - the ways into the game as one column on the right, in three visibly different tiers
 *    (`LobbyRoutes`), with a soft vignette behind it and nothing else darkened;
 *  - account (top-left) and materials + SETTINGS (top-right) pinned to the real viewport
 *    corners, because they are chrome and not doors.
 *
 * Everything in the column, header and corners is multiplied by one lobby scale `k`
 * (`lobbyScale`): the menu layer never scales UP (`menuLayer.ts`), so on a desktop window the
 * old lobby sat at its phone size in a sea of background — the other half of "looks empty".
 *
 * Pure presentation, same shape as every screen here: `gameWiring.ts` owns what each route
 * does. The shell owns two questions about the routes — whether there is a run to continue
 * (`resumableRun`) and whether a portal wants its one-click PLAY (`applyPrimary`) — plus the
 * profile the hero and the material chips draw (`lobbyProfile`).
 */
export class MainMenu {
  readonly view = new Container();
  /** Named `panel` like every other screen's backdrop, so `menuCoversWorld.test.ts` finds it. */
  private panel = new LobbyBackdrop();
  private hero = new LobbyHero();
  private header = new Container();
  private logo = new Sprite();
  /** The text title, drawn only when the logo art is missing. */
  private title: Text;
  private subtitle: Text;
  private column = new Container();
  /** One-click play, and ONLY on a host that requires it — see `setQuickPlay`. */
  private playBtn: LobbyCard;
  private routes = new LobbyRoutes();
  private topLeft = new Container();
  private topRight = new Container();
  private accountBtn: Button;
  /** Under the account chip for a guest: why logging in is worth a tap. */
  private guestHint: Text;
  private settingsBtn: Button;
  private resources = new LobbyResources();
  /** Shown INSTEAD of the ACCOUNT button where a host forbids a login entry point — see
   *  `setAccountEntry`. It states who the player is; it does not offer to change it. */
  private accountLabel: Text;
  /** The data notice a host may require at the point of collection — see `setAccountEntry`. */
  private dataNotice: Text;
  /** The hosted-policy link that goes WITH the notice — only where a URL actually exists. */
  private privacyLink: Text;
  /**
   * The operator's maintenance notice (design/21 §4's `ui.maintenanceBanner`). Empty means no
   * banner, the shipped default. Not localised and cannot be (it is one line an operator
   * typed), hence the 140-character cap in `@dd/net/publicFlags`. It hangs under the corner
   * row and pushes the header down by `BANNER_RESERVE` when shown, so `refreshBanner` re-lays
   * the screen out when it appears or goes while the lobby is up.
   */
  private banner: Text;
  private quickPlay = false;
  private accountEntry = true;
  /** The resumable run `show()` last read — `applyPrimary` is also reachable from
   *  `setQuickPlay`, which the assembly calls before the first show. */
  private saved: SavedRunSummary | null = null;
  private size: { w: number; h: number } | null = null;

  /**
   * Whether this lobby has an unfinished run to offer (design/10, 2026-09-17). A provider,
   * asked on every `show()`, and defaulted to "nothing" — the fail-closed direction. Must be
   * wired to `match/resumableRun.ts`: the row is an offer, and one this build cannot honour
   * has no business on the front door.
   */
  resumableRun: () => SavedRunSummary | null = () => null;

  /** The selected character and the banked materials — a provider for the same reason as
   *  `resumableRun`. `null` (the default) draws an empty dais and no material chips. */
  lobbyProfile: () => { skinId: string; materials: MaterialCounts } | null = () => null;

  /** Quick-play only — see `setQuickPlay`. Every other route is on `routes`. */
  onPlay: (() => void) | null = null;
  /** CONTINUE RUN — only ever called while `resumableRun()` answers non-null. */
  onContinue: (() => void) | null = null;
  onSolo: (() => void) | null = null;
  onCoop: (() => void) | null = null;
  onPvpSolo: (() => void) | null = null;
  onSquad: (() => void) | null = null;
  onForge: (() => void) | null = null;
  onTutorial: (() => void) | null = null;
  onAccount: (() => void) | null = null;
  onSettings: (() => void) | null = null;

  constructor() {
    // `padding` guards against a real observed font-metrics clipping bug (see Button).
    this.title = new Text({ text: t('mainMenu.title'), style: { fill: 0xf7fafc, fontSize: 46, fontWeight: 'bold', fontFamily: 'sans-serif', padding: 16, stroke: { color: 0x1a202c, width: 6 } } });
    this.title.anchor.set(0.5, 0);
    this.subtitle = new Text({ text: t('mainMenu.subtitle'), style: { fill: 0xffffff, fontSize: 14, fontFamily: 'monospace', fontWeight: 'bold', padding: 20, stroke: { color: 0x1a202c, width: 4 } } });
    this.subtitle.anchor.set(0.5, 0);
    this.logo.anchor.set(0.5, 0);
    this.header.addChild(this.logo, this.title, this.subtitle);

    // The portal's PLAY takes the primary slot at the top of the column, drawn exactly like
    // the SOLO banner it demotes — see `setQuickPlay`.
    this.playBtn = new LobbyCard(t('mainMenu.play'), LOBBY_ROUTES_W, LOBBY_PRIMARY_H, { art: 'lobby_card_descend', fill: 0x2f855a, frame: 0x9ae6b4, fontSize: 30, glow: true });
    this.playBtn.onTap = () => this.onPlay?.();
    this.playBtn.view.visible = false;

    this.routes.onContinue = () => this.onContinue?.();
    this.routes.onSolo = () => this.onSolo?.();
    this.routes.onCoop = () => this.onCoop?.();
    this.routes.onPvpSolo = () => this.onPvpSolo?.();
    this.routes.onSquad = () => this.onSquad?.();
    this.routes.onForge = () => this.onForge?.();
    this.routes.onTutorial = () => this.onTutorial?.();

    // `autoWidth` because signed in it carries a PLAYER'S NAME, and every fixed width fails
    // some name in some script.
    this.accountBtn = new Button(t('mainMenu.account'), { w: 110, h: CHROME_H, fontSize: 14, color: 0x1f2532, borderColor: 0xb794f4, autoWidth: true });
    this.accountBtn.onTap = () => this.onAccount?.();
    this.accountBtn.setIcon(getUiTexture('icon_account'), 0x6b46c1);
    this.guestHint = new Text({ text: '', style: { fill: 0xfbd38d, fontSize: 11, fontFamily: 'monospace', fontWeight: 'bold', padding: 10, stroke: { color: 0x1a202c, width: 3 } } });
    this.guestHint.position.set(2, CHROME_H + 5);
    this.accountLabel = new Text({ text: '', style: { fill: 0xffffff, fontSize: 14, fontFamily: 'monospace', fontWeight: 'bold', padding: 16, stroke: { color: 0x1a202c, width: 4 } } });
    this.accountLabel.anchor.set(0, 0.5);
    this.accountLabel.position.set(0, CHROME_H / 2);
    this.accountLabel.visible = false;
    this.topLeft.addChild(this.accountBtn.view, this.guestHint, this.accountLabel);

    this.settingsBtn = new Button(t('mainMenu.settings'), { w: 120, h: CHROME_H, fontSize: 13, color: 0x1f2532, borderColor: 0x718096, autoWidth: true });
    this.settingsBtn.onTap = () => this.onSettings?.();
    this.settingsBtn.setIcon(getUiTexture('icon_settings'), 0x4a5568);
    this.topRight.addChild(this.resources.view, this.settingsBtn.view);

    this.dataNotice = new Text({ text: '', style: { fill: 0xe2e8f0, fontSize: 11, fontFamily: 'sans-serif', padding: 12, align: 'center', wordWrap: true, wordWrapWidth: LOBBY_ROUTES_W, stroke: { color: 0x1a202c, width: 3 } } });
    this.dataNotice.anchor.set(0.5, 0);
    this.dataNotice.visible = false;
    this.privacyLink = new Text({ text: '', style: { fill: 0x90cdf4, fontSize: 11, fontFamily: 'sans-serif', padding: 12, align: 'center', stroke: { color: 0x1a202c, width: 3 } } });
    this.privacyLink.anchor.set(0.5, 0);
    this.privacyLink.visible = false;
    this.privacyLink.eventMode = 'static';
    this.privacyLink.cursor = 'pointer';
    this.privacyLink.on('pointertap', () => openPolicy('privacy'));
    this.column.addChild(this.playBtn.view, this.routes.view, this.dataNotice, this.privacyLink);

    // `breakWords` alongside `wordWrap`: a 140-character banner with no spaces (a URL, `MMMM…`)
    // is a legal value and cannot wrap at spaces at all (`viewportFit.test.ts` caught it).
    this.banner = new Text({ text: '', style: { fill: 0xfbd38d, fontSize: 15, fontFamily: 'sans-serif', fontWeight: 'bold', padding: 16, align: 'center', wordWrap: true, wordWrapWidth: 700, breakWords: true, stroke: { color: 0x1a202c, width: 4 } } });
    this.banner.anchor.set(0.5, 0);
    this.banner.visible = false;

    this.view.addChild(
      this.panel.view, this.hero.view, this.header, this.column,
      this.topLeft, this.topRight, this.banner,
    );
    this.view.eventMode = 'static';
    this.view.visible = false;
  }

  /**
   * Turn on the one-click PLAY card at the top of the column, and demote SOLO to the slim bar.
   *
   * A game portal requires that a first-time visitor reach gameplay in at most one click
   * (`docs.crazygames.com/requirements/gameplay`), and SOLO goes to the loadout first. Called
   * once during assembly, from the host branch in `gameWiring.ts`. A REQUEST, not the final
   * answer — `applyPrimary` reconciles it with a resumable run.
   */
  setQuickPlay(enabled: boolean): void {
    this.quickPlay = enabled;
    this.applyPrimary();
  }

  /**
   * Exactly one primary on the screen: with a resumable save it is always CONTINUE, including
   * on a portal, where it takes PLAY's slot rather than sitting under it — the platform rule
   * behind PLAY is about a FIRST-time visitor, which a player with a save is not. PLAY is
   * never re-pointed at the resume: two buttons with two labels, one drawn at a time, is how a
   * player keeps a run they meant to keep (design/10).
   */
  private applyPrimary(): void {
    const showPlay = this.quickPlay && this.saved === null;
    this.playBtn.view.visible = showPlay;
    this.routes.setSoloPrimary(!showPlay);
  }

  /** Call before `show()` so TUTORIAL reflects `!MetaState.hasSeenTutorial`. */
  setRecommendTutorial(recommend: boolean): void {
    this.routes.setRecommendTutorial(recommend);
  }

  /**
   * Whether this lobby offers a way INTO the account screen. `false` on a game portal: that
   * platform forbids a game's own credential login (`docs.crazygames.com/requirements/
   * account-integration`) and signs the player in silently instead. What replaces the button
   * is a plain LABEL naming the player (the platform requires the username be shown), plus the
   * data notice — nobody typed anything, so the one screen they do see has to say what is
   * stored.
   */
  setAccountEntry(enabled: boolean): void {
    this.accountEntry = enabled;
    this.accountBtn.view.visible = enabled;
    this.dataNotice.visible = !enabled;
    // Same gate as the notice, AND a URL has to exist — design/20's rule that nothing renders
    // a link until one does.
    this.privacyLink.visible = !enabled && policyUrl('privacy') !== null;
    this.refreshAccountLabel();
  }

  show(w: number, h: number) {
    this.size = { w, h };
    this.retext();
    // Asked on every show rather than cached, so a run saved from the pause menu is on the
    // front door the moment the player lands back on it — and before the layout, because the
    // CONTINUE card changes the column's height.
    this.saved = this.resumableRun();
    this.routes.setContinue(this.saved);
    this.applyPrimary();
    const profile = this.lobbyProfile();
    this.hero.setCharacter(profile?.skinId ?? null);
    this.resources.set(profile?.materials ?? {});
    this.resources.view.visible = profile !== null;
    this.refreshBanner(false);
    this.layout(w, h);
    this.view.visible = true;
  }

  hide() {
    this.view.visible = false;
  }

  /** Per-frame: the crystal, the hero's hover, the primary card's glow. Driven from the main
   *  loop's `lobbyScreens` list, and a no-op while the lobby is hidden. */
  update(dtMs: number): void {
    if (!this.view.visible) return;
    this.panel.update(dtMs);
    this.hero.update(dtMs);
    this.playBtn.update(dtMs);
    this.routes.update(dtMs);
  }

  private layout(w: number, h: number): void {
    const k = lobbyScale(w, h);
    const edge = EDGE * k;

    // Corners — pinned to the real viewport edges (the design space IS the viewport here,
    // divided by the layer's fit scale).
    this.topLeft.scale.set(k);
    this.topLeft.position.set(edge, edge);
    this.topRight.scale.set(k);
    const settingsW = this.settingsBtn.width;
    this.settingsBtn.view.position.set(-settingsW, 0);
    this.resources.view.position.set(-settingsW - 10 - this.resources.width, (CHROME_H - this.resources.height) / 2);
    this.topRight.position.set(w - edge, edge);

    // The banner hangs under the corner row, full width, and owes the header its room.
    const chromeBottom = edge + CHROME_H * k;
    this.banner.style.wordWrapWidth = Math.min(700, w - 32);
    this.banner.position.set(w / 2, chromeBottom + 8);
    const reserve = this.banner.visible ? BANNER_RESERVE : 0;

    // The column: right-aligned, below the corner row (and the banner), centred in what is
    // left. Its height includes the portal's notice block when that is shown.
    const colW = LOBBY_ROUTES_W * k;
    const noticeH = this.accountEntry ? 0 : NOTICE_BLOCK_H;
    const colH = this.routes.height + noticeH;
    const colX = w - Math.max(20, w * 0.035) - colW;
    const colTopMin = chromeBottom + 14 + reserve;
    const colTop = colTopMin + Math.max(0, (h - 16 - colTopMin - colH * k) / 2);
    this.column.scale.set(k);
    this.column.position.set(colX, colTop);
    this.playBtn.view.position.set(0, 0);
    this.routes.layout();
    this.routes.view.position.set(0, 0);
    this.dataNotice.position.set(LOBBY_ROUTES_W / 2, this.routes.height + 12);
    this.privacyLink.position.set(LOBBY_ROUTES_W / 2, this.routes.height + 12 + 44);
    this.panel.setFocus({ x: colX, y: colTop, w: colW, h: colH * k });

    // The painting, cropped so the dais sits in the middle of the room left of the column.
    const leftRoom = colX - 16;
    this.panel.setDaisTarget(Math.min(0.42, (leftRoom / 2) / w));
    this.panel.layout(w, h);
    const dais = this.panel.dais;

    // The header — logo (or the text title) and the tagline — centred over the dais, kept
    // clear of both screen edges and of the column.
    const logoTex = getUiTexture(getLocale() === 'zh' ? 'lobby_logo_zh' : 'lobby_logo_en');
    this.logo.visible = !!logoTex;
    this.title.visible = !logoTex;
    let headerH: number;
    if (logoTex) {
      this.logo.texture = logoTex;
      this.logo.scale.set(LOGO_W / logoTex.width);
      headerH = logoTex.height * (LOGO_W / logoTex.width);
    } else {
      headerH = 56;
    }
    this.subtitle.position.set(0, headerH + 2);
    headerH += TAGLINE_H;
    this.header.scale.set(k);
    const half = (LOGO_W * k) / 2;
    const headerX = Math.min(Math.max(dais.x, half + 16), Math.max(half + 16, leftRoom - half));
    // Under the guest hint too when it is drawn: it hangs below the account chip, and the
    // header is centred over the dais, which on a narrow screen puts it over that corner.
    const hintH = this.guestHint.visible ? 16 * k : 0;
    const headerTop = chromeBottom + 10 + hintH + reserve;
    this.header.position.set(headerX, headerTop);
    const headerBottom = headerTop + headerH * k;

    // The hero, standing on the dais: sized against the painting so it stays in proportion
    // to the stone, and never taller than the room between the header and the dais.
    const room = (dais.y - headerBottom - 6) / (1 + 0.14);
    const heroH = Math.max(0, Math.min(dais.paintingH * 0.3, w * 0.36, room));
    const captionY = Math.min(dais.y + dais.paintingH * 0.075, h - 48 * k);
    this.hero.layout(dais.x, dais.y, heroH, captionY, k);

    sharpenText(this.view, k);
  }

  /**
   * Re-read the maintenance flag and show or hide the notice. Called by `show()`, and
   * subscribed to the flag store by `gameWiring.ts` so a banner an operator sets while a
   * player is sitting in this lobby appears without them navigating away — which is exactly
   * the player it exists for. Re-lays the screen out when the banner comes or goes.
   */
  refreshBanner(relayout = true) {
    const text = publicFlag('ui.maintenanceBanner');
    const wasVisible = this.banner.visible;
    this.banner.text = text;
    // Hidden rather than an empty `Text`: a hidden node cannot be measured, hit-tested or
    // picked up by a layout that reads children.
    this.banner.visible = text.length > 0;
    if (relayout && this.size && this.banner.visible !== wasVisible) this.layout(this.size.w, this.size.h);
  }

  /** Call after a login/register/logout so the chip reflects the current session without
   *  re-`show()`ing the whole lobby. */
  refreshAccountLabel() {
    const session = getSession();
    // The BUTTON gets the bare name, the label gets the greeting: a chip cannot hold
    // "Cześć, {username}" — measured, six of eight locales overflowed with a five-letter name.
    this.accountBtn.setText(session ? clipName(session.username) : t('mainMenu.account'));
    this.guestHint.text = t('mainMenu.guestHint');
    this.guestHint.visible = this.accountEntry && session === null;
    // Without an account entry there is no "log in" state to advertise, so a guest gets no
    // label at all rather than a prompt the player cannot act on.
    this.accountLabel.text = session ? t('mainMenu.greeting', { username: session.username }) : '';
    this.accountLabel.visible = !this.accountEntry && session !== null;
    if (this.size) {
      const k = lobbyScale(this.size.w, this.size.h);
      sharpenText(this.topLeft, k);
    }
  }

  /** Re-apply every static label from the active locale — called on `show()` so a language
   *  change made in Settings (design/17) takes effect the next time the lobby opens. */
  private retext() {
    this.title.text = t('mainMenu.title');
    this.subtitle.text = t('mainMenu.subtitle');
    this.playBtn.setText(t('mainMenu.play'));
    this.playBtn.setHint(t('mainMenu.playHint'));
    this.routes.retext();
    this.hero.retext();
    this.settingsBtn.setText(t('mainMenu.settings'));
    this.dataNotice.text = t('auth.portalDataNotice');
    this.privacyLink.text = t('auth.privacyLink');
    this.refreshAccountLabel();
  }
}
