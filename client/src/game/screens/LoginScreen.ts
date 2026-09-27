import { Container, Graphics, Sprite, Text } from 'pixi.js';
import { Button } from '../ui/widgets';
import { TextInputOverlay } from '../ui/TextInputOverlay';
import { MenuShell } from '../ui/MenuShell';
import type { LobbyBackdrop } from '../ui/LobbyBackdrop';
import { FormField } from '../ui/FormField';
import { MENU_BUTTONS, MENU_COLORS, menuText } from '../ui/menuTheme';
import { SHEET_W, CONTENT_W, ID_TEXT_X, TAB_H, BUTTON_H, LOGOUT_H, layoutLoginSheet, drawLoginAvatar, type LoginSheetParts } from './loginSheet';
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

/** The server's own limits (`server/src/AuthService.ts`). */
const USERNAME_MAX = 20;
const PASSWORD_MAX = 64;

type GuestTab = 'login' | 'register';

/**
 * Account login/register (design/16-accounts.md), on the menu shell (design/10 "One shell for
 * every menu", 2026-09-27).
 *
 * ## The layout
 *
 * One framed sheet: who the player is (an avatar and a line saying where their progress
 * lives), then — for a guest — LOG IN / REGISTER as two tabs over ONE form of two fields and
 * one primary button, then the data notice and the policy link inside the card. Signed in, the
 * form is CHANGE PASSWORD's instead, folded away until asked for, and LOG OUT sits in the
 * identity row as the destructive thing it is.
 *
 * It replaced two stacked buttons that each opened two centred prompts in a row: nothing on
 * screen said which field was being asked for, and nothing said what an account is FOR.
 *
 * ## The fields
 *
 * Pixi has no text input, so each `FormField` opens `TextInputOverlay` ON itself. Enter moves
 * on to the next field and, on the last one, submits; a tap anywhere else keeps what was typed
 * (`onBlur`), which is what lets a player type a password and then press the button.
 *
 * Logging in is NEVER required to play — a player who taps BACK without an account stays
 * exactly on the pre-existing guest path (`net/identity.ts`'s local random id). This screen
 * only changes what `getPlayerId()` returns once a session exists.
 */
export class LoginScreen {
  readonly view = new Container();
  private readonly shell: MenuShell;
  /** The dimmed lobby painting. Named `panel` for `menuCoversWorld.test.ts`. */
  private readonly panel: LobbyBackdrop;
  private readonly avatar = new Graphics();
  private readonly avatarInitial: Text;
  private readonly avatarGlyph = new Sprite();
  private whoText: Text;
  /** The line under the name: where the player's progress lives, or what registering buys. */
  private standingText: Text;
  private statusText: Text;
  /** The one-line "what registering stores" notice — see its construction below. */
  private privacyText: Text;
  /** The hosted-policy link under the notice. Rendered only where a URL exists
   *  (`policyLinks.ts`) — the notice above stands on its own without it. */
  private privacyLink: Text;
  private readonly rule = new Graphics();
  /** The guest's two tabs. */
  private loginBtn: Button;
  private registerBtn: Button;
  /** The one primary on the screen: LOG IN, CREATE ACCOUNT or SAVE PASSWORD. */
  private submitBtn: Button;
  private logoutBtn: Button;
  private changePasswordBtn: Button;
  private userField: FormField;
  private passField: FormField;
  private oldPassField: FormField;
  private newPassField: FormField;
  private inputOverlay = new TextInputOverlay();

  private readonly matchBaseUrl: string;
  private readonly api: AuthApi;
  private session: Session | null;
  private tab: GuestTab = 'login';
  /** Signed in: whether the change-password form is unfolded. */
  private passwordOpen = false;
  private busy = false;
  private size: { w: number; h: number } | null = null;
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

    this.shell = new MenuShell({ title: t('auth.title'), back: t('auth.back') });
    this.shell.onBack = () => this.onBack?.();
    this.panel = this.shell.backdrop;

    this.avatarInitial = new Text({ text: '', style: { fill: 0xffffff, fontSize: 24, fontFamily: 'sans-serif', fontWeight: 'bold', padding: 8 } });
    this.avatarInitial.anchor.set(0.5);
    this.avatarGlyph.anchor.set(0.5);
    this.whoText = new Text({ text: '', style: menuText('value', { fontSize: 17, wordWrap: true, breakWords: true, wordWrapWidth: CONTENT_W - ID_TEXT_X }) });
    this.whoText.anchor.set(0, 0);
    this.standingText = new Text({ text: '', style: menuText('body', { fontSize: 13, lineHeight: 17, fill: MENU_COLORS.warn, wordWrapWidth: CONTENT_W - ID_TEXT_X }) });
    this.standingText.anchor.set(0, 0);
    this.statusText = new Text({ text: '', style: menuText('body', { fontSize: 13, align: 'center', fill: MENU_COLORS.error, wordWrapWidth: CONTENT_W }) });
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
    this.privacyText = new Text({ text: '', style: menuText('caption', { align: 'center', wordWrapWidth: CONTENT_W }) });
    this.privacyText.anchor.set(0.5, 0);
    // The notice says what registering does; this points at the full document for the
    // player who wants it. Visible only if a URL exists, and it is the only tappable thing
    // in this corner of the screen.
    this.privacyLink = new Text({ text: '', style: menuText('caption', { fill: MENU_COLORS.link, align: 'center', wordWrap: false }) });
    this.privacyLink.anchor.set(0.5, 0);
    this.privacyLink.visible = policyUrl('privacy') !== null;
    this.privacyLink.eventMode = 'static';
    this.privacyLink.cursor = 'pointer';
    this.privacyLink.on('pointertap', () => openPolicy('privacy'));

    const tabW = (CONTENT_W - 8) / 2;
    this.loginBtn = new Button(t('auth.login'), { w: tabW, h: TAB_H, fontSize: 14, ...MENU_BUTTONS.secondary, sound: 'ui.toggle' });
    this.loginBtn.onTap = () => this.selectTab('login');
    this.loginBtn.setIcon(getUiTexture('icon_account'));
    this.registerBtn = new Button(t('auth.register'), { w: tabW, h: TAB_H, fontSize: 14, ...MENU_BUTTONS.secondary, sound: 'ui.toggle' });
    this.registerBtn.onTap = () => this.selectTab('register');
    this.registerBtn.setIcon(getUiTexture('icon_register'));
    this.submitBtn = new Button(t('auth.submitLogin'), { w: CONTENT_W, h: BUTTON_H, fontSize: 17, ...MENU_BUTTONS.primary });
    this.submitBtn.onTap = () => this.submit();
    this.changePasswordBtn = new Button(t('auth.changePassword'), { w: CONTENT_W, h: TAB_H, fontSize: 14, ...MENU_BUTTONS.secondary });
    this.changePasswordBtn.onTap = () => this.togglePasswordForm();
    this.changePasswordBtn.setIcon(getUiTexture('icon_password'));
    this.logoutBtn = new Button(t('auth.logout'), { w: 112, h: LOGOUT_H, fontSize: 12, autoWidth: true, ...MENU_BUTTONS.danger });
    this.logoutBtn.onTap = () => void this.doLogout();
    this.logoutBtn.setIcon(getUiTexture('icon_logout'));

    this.userField = new FormField(t('auth.usernamePlaceholder'), CONTENT_W);
    this.passField = new FormField(t('auth.passwordPlaceholder'), CONTENT_W, { password: true });
    this.oldPassField = new FormField(t('auth.currentPasswordPlaceholder'), CONTENT_W, { password: true });
    this.newPassField = new FormField(t('auth.newPasswordPlaceholder'), CONTENT_W, { password: true });
    for (const field of this.fields()) field.onTap = () => this.edit(field);

    this.shell.content.addChild(
      this.avatar, this.avatarInitial, this.avatarGlyph, this.whoText, this.standingText,
      this.loginBtn.view, this.registerBtn.view, this.changePasswordBtn.view, this.logoutBtn.view,
      this.userField.view, this.passField.view, this.oldPassField.view, this.newPassField.view,
      this.statusText, this.submitBtn.view, this.rule, this.privacyText, this.privacyLink,
    );
    this.shell.mount(this.view);
    this.view.eventMode = 'static';
    this.view.visible = false;
    this.refresh();
  }

  show(w: number, h: number): void {
    this.size = { w, h };
    this.session = getSession();
    // A fresh visit starts clean: the last visit's error is not news any more.
    this.statusText.text = '';
    this.retext();
    this.view.visible = true;
    this.refresh();
  }

  /** Re-apply every static label from the active locale — same convention as
   * MainMenu.ts's `retext()` (design/17-i18n.md). */
  private retext(): void {
    this.shell.setTitle(t('auth.title'));
    this.shell.setBack(t('auth.back'));
    this.loginBtn.setText(t('auth.login'));
    this.registerBtn.setText(t('auth.register'));
    this.changePasswordBtn.setText(t('auth.changePassword'));
    this.logoutBtn.setText(t('auth.logout'));
    this.userField.setLabel(t('auth.usernamePlaceholder'));
    this.passField.setLabel(t('auth.passwordPlaceholder'));
    this.oldPassField.setLabel(t('auth.currentPasswordPlaceholder'));
    this.newPassField.setLabel(t('auth.newPasswordPlaceholder'));
    for (const f of this.fields()) f.setPlaceholder(t('auth.tapToType'));
    this.privacyText.text = t('auth.dataNotice');
    this.privacyLink.text = t('auth.privacyLink');
  }

  hide(): void {
    this.view.visible = false;
    this.inputOverlay.close(); // never leave a DOM input dangling once navigated away
    this.attemptToken++; // any login/register/change-password still in flight becomes stale
    this.clearSecrets();
  }

  /** Per-frame: the backdrop's motion. A no-op while hidden. */
  animate(dtMs: number): void {
    if (this.view.visible) this.panel.update(dtMs);
  }

  private fields(): FormField[] {
    return [this.userField, this.passField, this.oldPassField, this.newPassField];
  }

  /** Passwords never outlive the screen, or a failed attempt: a player who comes back finds
   *  the username they typed and an empty password. */
  private clearSecrets(): void {
    this.passField.setValue('');
    this.oldPassField.setValue('');
    this.newPassField.setValue('');
  }

  private selectTab(tab: GuestTab): void {
    if (this.busy) return;
    this.tab = tab;
    this.statusText.text = '';
    this.refresh();
  }

  private togglePasswordForm(): void {
    if (this.busy || !this.session) return;
    this.passwordOpen = !this.passwordOpen;
    this.statusText.text = '';
    if (!this.passwordOpen) this.clearSecrets();
    this.refresh();
  }

  /**
   * Open the real input on `field`. Enter keeps the value and moves to the form's next field
   * (or submits, from the last one); a tap elsewhere keeps the value and stops; Escape drops
   * the edit.
   */
  private edit(field: FormField): void {
    if (this.busy) return;
    const isUser = field === this.userField;
    for (const f of this.fields()) f.setFocused(f === field);
    const done = (value: string) => {
      field.setFocused(false);
      field.setValue(isUser ? value.trim() : value);
    };
    this.inputOverlay.open({
      placeholder: t('auth.tapToType'),
      maxLength: isUser ? USERNAME_MAX : PASSWORD_MAX,
      password: field.password,
      value: field.text,
      anchor: this.anchorOf(field),
      onSubmit: (value) => {
        done(value);
        // A blank username stops here rather than walking on to the password: the player
        // would otherwise type a password for an account that cannot exist.
        if (isUser && !value.trim()) {
          this.statusText.text = t('auth.usernameRequired');
          this.relayout();
          return;
        }
        const next = this.after(field);
        if (next) this.edit(next);
        else this.submit();
      },
      onBlur: done,
      onCancel: () => field.setFocused(false),
    });
  }

  /** The field Enter moves to after `field` — the second field of a form ends it. */
  private after(field: FormField): FormField | null {
    return field === this.userField ? this.passField : field === this.oldPassField ? this.newPassField : null;
  }

  /** Where the real input goes: over the field, when the screen has been laid out on a real
   *  canvas; `undefined` (the centred prompt) otherwise. */
  private anchorOf(field: FormField): { x: number; y: number; w: number; h: number } | undefined {
    const rect = field.anchorRect();
    return rect.w > 0 && rect.h > 0 ? rect : undefined;
  }

  /** The primary button — and Enter on the last field. */
  private submit(): void {
    if (this.busy) return;
    if (this.session) {
      if (!this.passwordOpen) return;
      const oldPassword = this.oldPassField.text;
      const newPassword = this.newPassField.text;
      if (!oldPassword || !newPassword) {
        this.statusText.text = t('auth.passwordRequired');
        this.relayout();
        return;
      }
      void this.doChangePassword(oldPassword, newPassword);
      return;
    }
    const username = this.userField.text.trim();
    const password = this.passField.text;
    if (!username) {
      this.statusText.text = t('auth.usernameRequired');
      this.relayout();
      return;
    }
    if (!password) {
      this.statusText.text = t('auth.passwordRequired');
      this.relayout();
      return;
    }
    if (this.tab === 'login') void this.doLogin(username, password);
    else void this.doRegister(username, password);
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
      if (token === this.attemptToken) this.statusText.text = this.failureText(e, t('auth.loginFailed'));
    } finally {
      this.busy = false; // always clears — this screen's own guard, not tied to staleness
      if (token === this.attemptToken) {
        this.clearSecrets();
        this.refresh();
      }
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
      if (token === this.attemptToken) this.statusText.text = this.failureText(e, t('auth.registerFailed'));
    } finally {
      this.busy = false;
      if (token === this.attemptToken) {
        this.clearSecrets();
        this.refresh();
      }
    }
  }

  /**
   * What the status line says when an auth call is refused.
   *
   * Every failure but one keeps the behaviour this screen has always had: the SERVER's own
   * prose. That is deliberate and it is not laziness — "username is taken", "password must
   * be at least 8 characters" and "invalid username or password" are answers only the server
   * can give, and a client that localised them would have to know which of them it was
   * looking at, which is exactly the prose-matching this codebase refuses to do.
   *
   * A 429 is the exception, and for the same reason `PartyScreen.doJoin` carved one out on
   * the same day: a throttle's prose tells the player nothing they can act on, and the only
   * action it suggests — try again — is the one that spends more of a budget they have
   * already run out of. Four routes this screen calls can answer 429 now (`register`,
   * `login`, `change-password`, and `portal` from elsewhere), so the branch is on the STATUS
   * and one localised string covers all of them.
   *
   * A thrown plain `Error` — an injected test double, an offline `fetch` — has no status
   * and keeps the old answer, which is why the check is `instanceof` rather than a cast.
   */
  private failureText(e: unknown, fallback: string): string {
    if (e instanceof authApi.AuthRequestError && e.status === 429) return t('auth.throttled');
    return (e as Error).message || fallback;
  }

  private async doChangePassword(oldPassword: string, newPassword: string): Promise<void> {
    if (!this.session || this.busy) return;
    this.busy = true;
    const token = this.attemptToken;
    let changed = false;
    try {
      await this.api.changePassword(this.matchBaseUrl, this.session.token, oldPassword, newPassword);
      changed = true;
      if (token === this.attemptToken) this.statusText.text = t('auth.passwordChanged');
    } catch (e) {
      if (token === this.attemptToken) this.statusText.text = this.failureText(e, t('auth.passwordChangeFailed'));
    } finally {
      this.busy = false;
      if (token === this.attemptToken) {
        this.clearSecrets();
        // A change that landed folds the form away; the success line stays to say so.
        if (changed) this.passwordOpen = false;
        this.refresh();
      }
    }
  }

  private async doLogout(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    const session = this.session;
    setSession(null);
    this.session = null;
    this.passwordOpen = false;
    this.tab = 'login';
    this.statusText.text = '';
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

  /** Re-derive every state-dependent label and visibility, then re-lay the sheet out. */
  private refresh(): void {
    const loggedIn = this.session !== null;
    const guest = !loggedIn;
    this.whoText.text = loggedIn ? t('auth.loggedInAs', { username: this.session!.username }) : t('auth.playingAsGuest');
    this.standingText.text = loggedIn ? t('auth.syncedStatus') : this.tab === 'register' ? t('auth.registerPitch') : t('auth.guestStatus');
    this.standingText.style.fill = loggedIn ? MENU_COLORS.success : MENU_COLORS.warn;
    this.loginBtn.view.visible = guest;
    this.registerBtn.view.visible = guest;
    this.userField.view.visible = guest;
    this.passField.view.visible = guest;
    this.changePasswordBtn.view.visible = loggedIn;
    this.logoutBtn.view.visible = loggedIn;
    this.oldPassField.view.visible = loggedIn && this.passwordOpen;
    this.newPassField.view.visible = loggedIn && this.passwordOpen;
    this.submitBtn.view.visible = guest || this.passwordOpen;
    this.submitBtn.setText(loggedIn ? t('auth.savePassword') : this.tab === 'login' ? t('auth.submitLogin') : t('auth.submitRegister'));
    // The selected tab carries the crystal frame; the other is a plain secondary.
    const on = (b: Button, active: boolean) => {
      b.setFill(active ? 0x1d3350 : MENU_COLORS.field);
      b.setBorder(active ? MENU_COLORS.frame : MENU_COLORS.fieldBorder);
    };
    on(this.loginBtn, this.tab === 'login');
    on(this.registerBtn, this.tab === 'register');
    on(this.changePasswordBtn, this.passwordOpen);
    // The notice is about what REGISTERING stores, so it goes with the guest's form.
    this.privacyText.visible = guest;
    this.privacyLink.visible = guest && policyUrl('privacy') !== null;
    drawLoginAvatar({ avatar: this.avatar, avatarInitial: this.avatarInitial, avatarGlyph: this.avatarGlyph }, this.session?.username ?? null);
    this.relayout();
  }

  private relayout(): void {
    if (this.size) this.layout(this.size.w, this.size.h);
  }

  private layout(w: number, h: number): void {
    this.statusText.style.fill = this.statusText.text === t('auth.passwordChanged') ? MENU_COLORS.success : MENU_COLORS.error;
    this.shell.layout(w, h, SHEET_W, layoutLoginSheet(this.parts(), this.session !== null, this.passwordOpen));
  }

  /** The widgets `loginSheet.ts` places — kept as fields here, where the harnesses read them. */
  private parts(): LoginSheetParts {
    const { whoText, standingText, statusText, privacyText, privacyLink, rule, loginBtn, registerBtn } = this;
    const { changePasswordBtn, logoutBtn, submitBtn, userField, passField, oldPassField, newPassField } = this;
    return { whoText, standingText, statusText, privacyText, privacyLink, rule, loginBtn, registerBtn, changePasswordBtn, logoutBtn, submitBtn, userField, passField, oldPassField, newPassField };
  }
}
