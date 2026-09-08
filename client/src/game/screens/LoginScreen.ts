import { Container, Text } from 'pixi.js';
import { Panel, Button } from '../ui/widgets';
import { TextInputOverlay } from '../ui/TextInputOverlay';
import * as authApi from '../../net/auth';
import { getSession, setSession, type Session } from '../../net/session';
import { getUiTexture } from '../../render/uiSkins';
import { t } from '../../i18n';
import { openPolicy, policyUrl } from '../../platform/policyLinks';

/** The auth network calls this screen needs — injected (default: the real
 * `net/auth.ts` functions), same DI convention as PartyScreen's `PartyApi`. */
export interface AuthApi {
  register: typeof authApi.register;
  login: typeof authApi.login;
  logout: typeof authApi.logout;
  changePassword: typeof authApi.changePassword;
}

/**
 * Account login/register (design/16-accounts.md — this project's first real login
 * system). Pure presentation + its own two-step username→password prompt (Pixi has no
 * native text input; `TextInputOverlay` shows one field at a time, same as
 * PartyScreen's join-code entry — sequential prompts are simplest here, not worth a
 * multi-field form for two fields).
 *
 * Logging in is NEVER required to play — a player who taps BACK without an account
 * stays exactly on the pre-existing guest path (`net/identity.ts`'s local random id).
 * This screen only changes what `getPlayerId()` returns once a session exists.
 */
export class LoginScreen {
  readonly view = new Container();
  private panel = new Panel({ alpha: 0.85, background: 'hub' });
  private title: Text;
  private statusText: Text;
  /** The one-line "what registering stores" notice — see its construction below. */
  private privacyText: Text;
  /** The hosted-policy link under the notice. Rendered only where a URL exists
   *  (`policyLinks.ts`) — the notice above stands on its own without it. */
  private privacyLink: Text;
  private whoText: Text;
  private loginBtn: Button;
  private registerBtn: Button;
  private logoutBtn: Button;
  private changePasswordBtn: Button;
  private backBtn: Button;
  private inputOverlay = new TextInputOverlay();

  private readonly matchBaseUrl: string;
  private readonly api: AuthApi;
  private session: Session | null;
  private busy = false;
  // Guards a stale login/register/change-password continuation from reacting after the
  // player has already backed out (`hide()` bumps this) — same `attemptToken`
  // convention PartyScreen/Matchmaking already use. `setSession()` itself (the actual
  // persisted-session write) still always runs on a genuine success — the credential
  // really was valid — but `onSessionChange` (which Game.ts wires to overwrite the
  // live `meta` mid-run) and this screen's own local state/UI only react while still
  // the current attempt, so a login that resolves after the player left can't yank a
  // guest run's meta out from under it.
  private attemptToken = 0;

  onBack: (() => void) | null = null;
  /** Fired once a login/register succeeds, or once account meta should re-sync after a
   * session change (login, register, or logout) — Game.ts hooks this to swap MetaStore. */
  onSessionChange: (() => void) | null = null;

  constructor(opts: { matchBaseUrl: string; api?: AuthApi }) {
    this.matchBaseUrl = opts.matchBaseUrl;
    this.api = opts.api ?? authApi;
    this.session = getSession();

    this.title = new Text({ text: t('auth.title'), style: { fill: 0xf7fafc, fontSize: 32, fontWeight: 'bold', fontFamily: 'sans-serif', padding: 16 } });
    this.title.anchor.set(0.5, 0);
    this.whoText = new Text({ text: '', style: { fill: 0x90cdf4, fontSize: 18, fontFamily: 'monospace', padding: 16 } });
    this.whoText.anchor.set(0.5, 0);
    this.statusText = new Text({ text: '', style: { fill: 0xf56565, fontSize: 13, fontFamily: 'monospace', padding: 12 } });
    this.statusText.anchor.set(0.5, 0);
    // The data notice, at the point of collection.
    //
    // This screen is the ONLY place this game sends anything about a player anywhere: an
    // account is never required to play (design/16's own rule), so a player who never opens
    // it has had nothing about them leave the device. Which makes this the honest place to
    // say what registering does, rather than a policy page nobody opens — and it is what a
    // host that asks for consent before data collection beyond its own SDK events is asking
    // for (`docs.crazygames.com/requirements/technical`).
    //
    // Deliberately factual and derived from the code rather than legal boilerplate: what is
    // stored is a username, a password hash and the account's progress
    // (`server/src/AuthService.ts`, `EntitlementService.ts`), and the alternative is to
    // simply not do this.
    this.privacyText = new Text({
      text: '',
      style: { fill: 0x8fa2b8, fontSize: 12, fontFamily: 'monospace', align: 'center', lineHeight: 17, padding: 12, wordWrap: true, wordWrapWidth: 420 },
    });
    this.privacyText.anchor.set(0.5, 0);
    // The notice says what registering does; this points at the full document for the
    // player who wants it. Visible only if a URL exists, and it is the only tappable thing
    // in this corner of the screen.
    this.privacyLink = new Text({ text: '', style: { fill: 0x63b3ed, fontSize: 12, fontFamily: 'monospace', padding: 12, align: 'center' } });
    this.privacyLink.anchor.set(0.5, 0);
    this.privacyLink.visible = policyUrl('privacy') !== null;
    this.privacyLink.eventMode = 'static';
    this.privacyLink.cursor = 'pointer';
    this.privacyLink.on('pointertap', () => openPolicy('privacy'));

    this.loginBtn = new Button(t('auth.login'), { w: 200, h: 44, fontSize: 15 });
    this.loginBtn.onTap = () => this.beginLogin();
    this.loginBtn.setIcon(getUiTexture('icon_account'));
    this.registerBtn = new Button(t('auth.register'), { w: 200, h: 44, fontSize: 15, color: 0x2f855a });
    this.registerBtn.onTap = () => this.beginRegister();
    this.registerBtn.setIcon(getUiTexture('icon_register'));
    this.changePasswordBtn = new Button(t('auth.changePassword'), { w: 200, h: 40, fontSize: 13 });
    this.changePasswordBtn.onTap = () => this.beginChangePassword();
    this.changePasswordBtn.setIcon(getUiTexture('icon_password'));
    this.logoutBtn = new Button(t('auth.logout'), { w: 160, h: 36, fontSize: 13, color: 0x742a2a });
    this.logoutBtn.onTap = () => void this.doLogout();
    this.logoutBtn.setIcon(getUiTexture('icon_logout'));
    this.backBtn = new Button(t('auth.back'), { w: 120, h: 32, fontSize: 13, sound: 'ui.back' });
    this.backBtn.onTap = () => this.onBack?.();
    this.backBtn.setIcon(getUiTexture('icon_back'));

    this.view.addChild(
      this.panel.view, this.title, this.whoText, this.statusText, this.privacyText, this.privacyLink,
      this.loginBtn.view, this.registerBtn.view, this.changePasswordBtn.view, this.logoutBtn.view, this.backBtn.view,
    );
    this.view.eventMode = 'static';
    this.view.visible = false;
    this.refresh();
  }

  show(w: number, h: number): void {
    this.retext();
    this.layout(w, h);
    this.session = getSession();
    this.view.visible = true;
    this.refresh();
  }

  /** Re-apply every static label from the active locale — same convention as
   * MainMenu.ts's `retext()` (design/17-i18n.md). */
  private retext(): void {
    this.title.text = t('auth.title');
    this.loginBtn.setText(t('auth.login'));
    this.registerBtn.setText(t('auth.register'));
    this.changePasswordBtn.setText(t('auth.changePassword'));
    this.logoutBtn.setText(t('auth.logout'));
    this.backBtn.setText(t('auth.back'));
    this.privacyText.text = t('auth.dataNotice');
    this.privacyLink.text = t('auth.privacyLink');
  }

  hide(): void {
    this.view.visible = false;
    this.inputOverlay.close(); // never leave a DOM input dangling once navigated away
    this.attemptToken++; // any login/register/change-password still in flight becomes stale
  }

  private layout(w: number, h: number): void {
    this.panel.layout(w, h);
    const cx = w / 2;
    const cy = h / 2;
    this.title.position.set(cx, cy - 160);
    this.whoText.position.set(cx, cy - 100);
    this.statusText.position.set(cx, cy + 110);
    this.loginBtn.view.position.set(cx - 100, cy - 40);
    this.registerBtn.view.position.set(cx - 100, cy + 14);
    this.changePasswordBtn.view.position.set(cx - 100, cy - 40);
    this.logoutBtn.view.position.set(cx - 80, cy + 14);
    this.backBtn.view.position.set(cx - 60, cy + 170);
    this.privacyText.position.set(cx, cy + 216);
    // Below the notice. A FIXED offset, not `privacyText.height`: reading `.height` on a
    // Pixi `Text` forces a canvas text measurement, and this screen is unit-tested with no
    // `document`. 54px clears three lines at this font's 17px line height.
    this.privacyLink.position.set(cx, cy + 216 + 54);
  }

  private beginLogin(): void {
    if (this.busy) return;
    this.promptCredentials((username, password) => void this.doLogin(username, password));
  }

  private beginRegister(): void {
    if (this.busy) return;
    this.promptCredentials((username, password) => void this.doRegister(username, password));
  }

  private promptCredentials(onDone: (username: string, password: string) => void): void {
    this.statusText.text = '';
    this.inputOverlay.open({
      placeholder: t('auth.usernamePlaceholder'),
      maxLength: 20,
      onSubmit: (username) => {
        const name = username.trim();
        if (!name) {
          this.statusText.text = t('auth.usernameRequired');
          return;
        }
        this.inputOverlay.open({
          placeholder: t('auth.passwordPlaceholder'),
          maxLength: 64,
          password: true,
          onSubmit: (password) => onDone(name, password),
        });
      },
    });
  }

  private beginChangePassword(): void {
    if (this.busy || !this.session) return;
    this.statusText.text = '';
    this.inputOverlay.open({
      placeholder: t('auth.currentPasswordPlaceholder'),
      maxLength: 64,
      password: true,
      onSubmit: (oldPassword) => {
        this.inputOverlay.open({
          placeholder: t('auth.newPasswordPlaceholder'),
          maxLength: 64,
          password: true,
          onSubmit: (newPassword) => void this.doChangePassword(oldPassword, newPassword),
        });
      },
    });
  }

  private async doLogin(username: string, password: string): Promise<void> {
    if (this.busy) return; // re-entrant guard — mirrors PartyScreen's doCreate/doJoin
    this.busy = true;
    const token = this.attemptToken;
    try {
      const result = await this.api.login(this.matchBaseUrl, username, password);
      setSession(result); // the login really did succeed — persist it regardless of staleness
      if (token === this.attemptToken) {
        this.session = result;
        this.onSessionChange?.();
      }
    } catch (e) {
      if (token === this.attemptToken) this.statusText.text = (e as Error).message || t('auth.loginFailed');
    } finally {
      this.busy = false; // always clears — this screen's own guard, not tied to staleness
      if (token === this.attemptToken) this.refresh();
    }
  }

  private async doRegister(username: string, password: string): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    const token = this.attemptToken;
    try {
      const result = await this.api.register(this.matchBaseUrl, username, password);
      setSession(result);
      if (token === this.attemptToken) {
        this.session = result;
        this.onSessionChange?.();
      }
    } catch (e) {
      if (token === this.attemptToken) this.statusText.text = (e as Error).message || t('auth.registerFailed');
    } finally {
      this.busy = false;
      if (token === this.attemptToken) this.refresh();
    }
  }

  private async doChangePassword(oldPassword: string, newPassword: string): Promise<void> {
    if (!this.session || this.busy) return;
    this.busy = true;
    const token = this.attemptToken;
    try {
      await this.api.changePassword(this.matchBaseUrl, this.session.token, oldPassword, newPassword);
      if (token === this.attemptToken) this.statusText.text = t('auth.passwordChanged');
    } catch (e) {
      if (token === this.attemptToken) this.statusText.text = (e as Error).message || t('auth.passwordChangeFailed');
    } finally {
      this.busy = false;
      if (token === this.attemptToken) this.refresh();
    }
  }

  private async doLogout(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    const session = this.session;
    setSession(null);
    this.session = null;
    this.onSessionChange?.();
    this.refresh();
    if (session) {
      try {
        await this.api.logout(this.matchBaseUrl, session.token);
      } catch {
        /* best-effort — the session TTLs out server-side even if this call is lost */
      } finally {
        this.busy = false;
      }
    } else {
      this.busy = false;
    }
  }

  private refresh(): void {
    const loggedIn = this.session !== null;
    this.whoText.text = loggedIn ? t('auth.loggedInAs', { username: this.session!.username }) : t('auth.playingAsGuest');
    this.loginBtn.view.visible = !loggedIn;
    this.registerBtn.view.visible = !loggedIn;
    this.changePasswordBtn.view.visible = loggedIn;
    this.logoutBtn.view.visible = loggedIn;
  }
}
