/**
 * LoginScreen (design/16-accounts.md). Driven with a fake `AuthApi` (no network) —
 * mirrors PartyScreen.test.ts's style, reaching private do-action state via the same
 * escape hatch. Session state is global (net/session.ts), so each test resets it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LoginScreen, type AuthApi } from './LoginScreen';
import { resetSessionCacheForTests, getSession } from '../../net/session';
import { AuthRequestError, type AuthResult } from '../../net/auth';
import { setLocale, resetLocaleForTests, t } from '../../i18n';
import { useLocale } from '../../i18n/loadLocale';
import { installFakeTextCanvas } from './fakeTextCanvas';

// The sheet measures its wrapped lines (the standing line, the status, the notice).
installFakeTextCanvas();

function fakeApi(overrides: Partial<AuthApi> = {}): AuthApi {
  return {
    register: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
    changePassword: vi.fn(),
    ...overrides,
  };
}

const SESSION: AuthResult = { accountId: 'acct-1', username: 'alice', token: 'tok-1' };

function makeScreen(api: AuthApi) {
  const screen = new LoginScreen({ matchBaseUrl: 'http://mm', api });
  screen.show(800, 600);
  return screen;
}

/** A controllable pending promise, for pinning "still in flight" re-entrancy behavior. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function privateOf(s: LoginScreen) {
  const shell = (s as unknown as { shell: { sheet: { title: { text: string } } } }).shell;
  return Object.assign(s as unknown as {
    loginBtn: { view: { visible: boolean }; label: { text: string } };
    registerBtn: { view: { visible: boolean }; label: { text: string } };
    logoutBtn: { view: { visible: boolean }; label: { text: string } };
    changePasswordBtn: { view: { visible: boolean }; label: { text: string } };
    whoText: { text: string };
    statusText: { text: string };
    doLogin(username: string, password: string): Promise<void>;
    doRegister(username: string, password: string): Promise<void>;
    doChangePassword(oldPassword: string, newPassword: string): Promise<void>;
    doLogout(): Promise<void>;
    privacyText: { text: string; position: { x: number; y: number } };
    privacyLink: {
      text: string;
      visible: boolean;
      cursor: string;
      eventMode: string;
      position: { x: number; y: number };
      emit: (event: string) => void;
    };
  }, { title: shell.sheet.title });
}

beforeEach(() => resetSessionCacheForTests());
afterEach(() => resetLocaleForTests());

describe('LoginScreen — guest (no session)', () => {
  it('shows login/register, hides logout/change-password', () => {
    const s = makeScreen(fakeApi());
    const p = privateOf(s);
    expect(p.loginBtn.view.visible).toBe(true);
    expect(p.registerBtn.view.visible).toBe(true);
    expect(p.logoutBtn.view.visible).toBe(false);
    expect(p.changePasswordBtn.view.visible).toBe(false);
    expect(p.whoText.text).toMatch(/guest/i);
  });
});

describe('LoginScreen — login', () => {
  it('a successful login stores the session and flips to the logged-in state', async () => {
    const api = fakeApi({ login: vi.fn().mockResolvedValue(SESSION) });
    const s = makeScreen(api);
    const p = privateOf(s);
    await p.doLogin('alice', 'hunter22');
    expect(api.login).toHaveBeenCalledWith('http://mm', 'alice', 'hunter22');
    expect(getSession()).toEqual(SESSION);
    expect(p.whoText.text).toContain('alice');
    expect(p.logoutBtn.view.visible).toBe(true);
    expect(p.loginBtn.view.visible).toBe(false);
  });

  it('a failed login surfaces the server error and stays logged out', async () => {
    const api = fakeApi({ login: vi.fn().mockRejectedValue(new Error('invalid username or password')) });
    const s = makeScreen(api);
    const p = privateOf(s);
    await p.doLogin('alice', 'wrong');
    expect(p.statusText.text).toMatch(/invalid/i);
    expect(getSession()).toBeNull();
    expect(p.loginBtn.view.visible).toBe(true);
  });

  it('fires onSessionChange after a successful login', async () => {
    const api = fakeApi({ login: vi.fn().mockResolvedValue(SESSION) });
    const s = makeScreen(api);
    const onChange = vi.fn();
    s.onSessionChange = onChange;
    await privateOf(s).doLogin('alice', 'hunter22');
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

describe('LoginScreen — register', () => {
  it('a successful register stores the session and flips to the logged-in state', async () => {
    const api = fakeApi({ register: vi.fn().mockResolvedValue(SESSION) });
    const s = makeScreen(api);
    const p = privateOf(s);
    await p.doRegister('alice', 'hunter22');
    expect(api.register).toHaveBeenCalledWith('http://mm', 'alice', 'hunter22');
    expect(getSession()).toEqual(SESSION);
    expect(p.logoutBtn.view.visible).toBe(true);
  });

  it('a failed register (duplicate username) surfaces the server error', async () => {
    const api = fakeApi({ register: vi.fn().mockRejectedValue(new Error('username already taken')) });
    const s = makeScreen(api);
    const p = privateOf(s);
    await p.doRegister('alice', 'hunter22');
    expect(p.statusText.text).toMatch(/already taken/i);
    expect(getSession()).toBeNull();
  });
});

describe('LoginScreen — a throttled call is the one refusal the server does not get to word', () => {
  // Four of this screen's routes spend a per-IP budget since 2026-09-22 (`LOGIN_RATE_LIMIT`,
  // `REGISTER_RATE_LIMIT`, `CHANGE_PASSWORD_RATE_LIMIT`, and `/auth/portal` from elsewhere).
  // Everything else this screen shows is the server's own prose, deliberately — only the
  // server knows whether the username was taken or the password too short. A 429 is the
  // exception in both directions: its prose says nothing the player can act on, and it
  // arrives in English on a screen the player has in one of eight languages.

  it('a throttled login shows the localised throttle, not the server text', async () => {
    const api = fakeApi({
      login: vi.fn().mockRejectedValue(new AuthRequestError('too many login attempts from this address', 429)),
    });
    const p = privateOf(makeScreen(api));
    await p.doLogin('alice', 'hunter22');
    expect(p.statusText.text).toBe(t('auth.throttled'));
    expect(p.statusText.text).not.toMatch(/from this address/);
    expect(getSession()).toBeNull();
  });

  it('a throttled register and a throttled password change say the same thing', async () => {
    const api = fakeApi({
      register: vi.fn().mockRejectedValue(new AuthRequestError('too many accounts created', 429)),
      changePassword: vi.fn().mockRejectedValue(new AuthRequestError('too many password changes', 429)),
    });
    const p = privateOf(makeScreen(api));
    await p.doRegister('alice', 'hunter22');
    expect(p.statusText.text).toBe(t('auth.throttled'));

    // `doChangePassword` returns early without a session, so this one logs in first.
    const q = privateOf(
      makeScreen(
        fakeApi({
          login: vi.fn().mockResolvedValue(SESSION),
          changePassword: vi.fn().mockRejectedValue(new AuthRequestError('too many password changes', 429)),
        }),
      ),
    );
    await q.doLogin('alice', 'hunter22');
    await q.doChangePassword('hunter22', 'hunter333');
    expect(q.statusText.text).toBe(t('auth.throttled'));
  });

  it('every other status keeps the server prose — the control', async () => {
    // Without this, a `failureText` that returned the throttle string for every
    // `AuthRequestError` would pass the two cases above while hiding "username already taken"
    // behind "try again in a few minutes", which is advice for a wait that will not help.
    for (const status of [400, 401, 503]) {
      const api = fakeApi({ login: vi.fn().mockRejectedValue(new AuthRequestError('invalid username or password', status)) });
      const p = privateOf(makeScreen(api));
      await p.doLogin('alice', 'wrong');
      expect(p.statusText.text).toMatch(/invalid username or password/i);
    }
  });

  it('a thrown plain Error still shows its own message', async () => {
    // An injected double and an offline `fetch` both produce one, so the branch is
    // `instanceof` rather than a cast — and a status-less failure must not become a throttle.
    const api = fakeApi({ login: vi.fn().mockRejectedValue(new Error('network down')) });
    const p = privateOf(makeScreen(api));
    await p.doLogin('alice', 'hunter22');
    expect(p.statusText.text).toBe('network down');
  });
});

describe('LoginScreen — logout', () => {
  it('logging out clears the session and reverts to guest state', async () => {
    const api = fakeApi({ login: vi.fn().mockResolvedValue(SESSION), logout: vi.fn().mockResolvedValue(undefined) });
    const s = makeScreen(api);
    const p = privateOf(s);
    await p.doLogin('alice', 'hunter22');
    await p.doLogout();
    expect(api.logout).toHaveBeenCalledWith('http://mm', 'tok-1');
    expect(getSession()).toBeNull();
    expect(p.loginBtn.view.visible).toBe(true);
  });
});

describe('LoginScreen — change password', () => {
  it('changing the password while logged in reports success', async () => {
    const api = fakeApi({
      login: vi.fn().mockResolvedValue(SESSION),
      changePassword: vi.fn().mockResolvedValue(undefined),
    });
    const s = makeScreen(api);
    const p = privateOf(s);
    await p.doLogin('alice', 'hunter22');
    await p.doChangePassword('hunter22', 'newpassword1');
    expect(api.changePassword).toHaveBeenCalledWith('http://mm', 'tok-1', 'hunter22', 'newpassword1');
    expect(p.statusText.text).toMatch(/changed/i);
  });
});

describe('LoginScreen — re-entrant guard (edge case: a double-fire while a call is in flight)', () => {
  it('a second doLogin call while the first is still pending does not re-invoke the API', async () => {
    const d = deferred<AuthResult>();
    const login = vi.fn().mockReturnValue(d.promise);
    const s = makeScreen(fakeApi({ login }));
    const p = privateOf(s);

    const first = p.doLogin('alice', 'hunter22');
    const second = p.doLogin('alice', 'hunter22'); // fired before `first` resolves
    d.resolve(SESSION);
    await Promise.all([first, second]);

    expect(login).toHaveBeenCalledTimes(1);
  });

  it('a second doRegister call while the first is still pending does not re-invoke the API', async () => {
    const d = deferred<AuthResult>();
    const register = vi.fn().mockReturnValue(d.promise);
    const s = makeScreen(fakeApi({ register }));
    const p = privateOf(s);

    const first = p.doRegister('alice', 'hunter22');
    const second = p.doRegister('alice', 'hunter22');
    d.resolve(SESSION);
    await Promise.all([first, second]);

    expect(register).toHaveBeenCalledTimes(1);
  });

  it('a second doChangePassword call while the first is still pending does not re-invoke the API', async () => {
    const d = deferred<void>();
    const changePassword = vi.fn().mockReturnValue(d.promise);
    const s = makeScreen(fakeApi({ login: vi.fn().mockResolvedValue(SESSION), changePassword }));
    const p = privateOf(s);
    await p.doLogin('alice', 'hunter22');

    const first = p.doChangePassword('hunter22', 'newpassword1');
    const second = p.doChangePassword('hunter22', 'newpassword1');
    d.resolve();
    await Promise.all([first, second]);

    expect(changePassword).toHaveBeenCalledTimes(1);
  });

  it('once the in-flight call settles, a fresh doLogin call is allowed through again', async () => {
    const login = vi.fn().mockResolvedValue(SESSION);
    const s = makeScreen(fakeApi({ login }));
    const p = privateOf(s);
    await p.doLogin('alice', 'hunter22');
    await p.doLogin('alice', 'hunter22');
    expect(login).toHaveBeenCalledTimes(2); // NOT re-entrant — two genuinely sequential calls
  });
});

describe('LoginScreen — staleness guard (backing out mid-request never lands a late onSessionChange)', () => {
  it('doLogin: hiding the screen before login resolves still persists the session, but never fires onSessionChange or mutates local state', async () => {
    const d = deferred<AuthResult>();
    const api = fakeApi({ login: vi.fn().mockReturnValue(d.promise) });
    const s = makeScreen(api);
    const p = privateOf(s);
    const onChange = vi.fn();
    s.onSessionChange = onChange;

    const loginPromise = p.doLogin('alice', 'hunter22'); // player starts logging in...
    s.hide(); // ...then immediately backs out
    d.resolve(SESSION); // the server call finally lands
    await loginPromise;

    expect(getSession()).toEqual(SESSION); // the login really did succeed — persisted regardless
    expect(onChange).not.toHaveBeenCalled(); // but nothing reacts to it anymore
    expect(p.whoText.text).toMatch(/guest/i); // this screen's own local state never mutated
  });

  it('doRegister: hiding the screen before register resolves never fires onSessionChange', async () => {
    const d = deferred<AuthResult>();
    const api = fakeApi({ register: vi.fn().mockReturnValue(d.promise) });
    const s = makeScreen(api);
    const p = privateOf(s);
    const onChange = vi.fn();
    s.onSessionChange = onChange;

    const registerPromise = p.doRegister('alice', 'hunter22');
    s.hide();
    d.resolve(SESSION);
    await registerPromise;

    expect(onChange).not.toHaveBeenCalled();
  });

  it('doChangePassword: hiding the screen before it resolves never touches statusText', async () => {
    const d = deferred<void>();
    const api = fakeApi({ login: vi.fn().mockResolvedValue(SESSION), changePassword: vi.fn().mockReturnValue(d.promise) });
    const s = makeScreen(api);
    const p = privateOf(s);
    await p.doLogin('alice', 'hunter22');

    const changePromise = p.doChangePassword('hunter22', 'newpassword1');
    s.hide();
    d.resolve();
    await changePromise;

    expect(p.statusText.text).toBe(''); // never overwritten with the stale "changed" message
  });

  it('`busy` always clears after a stale (post-hide) resolve, so re-showing the screen can log in again', async () => {
    const d = deferred<AuthResult>();
    const login = vi.fn().mockReturnValue(d.promise);
    const s = makeScreen(fakeApi({ login }));
    const p = privateOf(s);

    const first = p.doLogin('alice', 'hunter22');
    s.hide();
    d.resolve(SESSION);
    await first;

    s.show(800, 600);
    login.mockResolvedValue({ ...SESSION, username: 'bob' });
    await p.doLogin('bob', 'hunter22'); // must not be swallowed by a `busy` flag stuck true
    expect(p.whoText.text).toContain('bob');
  });
});

describe('LoginScreen — hide()', () => {
  it('hides the view without throwing even with no open input overlay', () => {
    const s = makeScreen(fakeApi());
    expect(() => s.hide()).not.toThrow();
  });
});

describe('LoginScreen — i18n (design/17-i18n.md)', () => {
  it('retexts on show() under zh, guest and logged-in copy alike', async () => {
    const s = makeScreen(fakeApi());
    await useLocale('zh');
    s.show(800, 600);
    const p = privateOf(s);
    expect(p.title.text).toBe('账户');
    expect(p.loginBtn.label.text).toBe('登录');
    expect(p.registerBtn.label.text).toBe('注册');
    expect(p.whoText.text).toBe('以访客身份游玩');
  });

  it('a failed login under zh falls back to the translated error when the server sends none', async () => {
    const api = fakeApi({ login: vi.fn().mockRejectedValue(new Error()) });
    await useLocale('zh');
    const s = makeScreen(api);
    await privateOf(s).doLogin('alice', 'wrong');
    expect(privateOf(s).statusText.text).toBe('登录失败，请重试。');
  });

  it('switching back to English on a later show() fully reverts', async () => {
    const s = makeScreen(fakeApi());
    await useLocale('zh');
    s.show(800, 600);
    setLocale('en');
    s.show(800, 600);
    expect(privateOf(s).title.text).toBe('ACCOUNT');
  });
});

describe('LoginScreen — the hosted policy link (design/20)', () => {
  // This screen is the point of collection on every target that keeps its own login, and it
  // already carried the factual data notice. The link is the hosted document that notice
  // summarises; design/20's rule was that nothing renders one until a URL exists.

  it('renders under the notice and is tappable', () => {
    const s = makeScreen(fakeApi());
    const p = privateOf(s);
    expect(p.privacyLink.visible).toBe(true);
    expect(p.privacyLink.text.length).toBeGreaterThan(0);
    expect(p.privacyLink.position.y).toBeGreaterThan(p.privacyText.position.y);
    expect(p.privacyLink.eventMode).toBe('static');
    expect(p.privacyLink.cursor).toBe('pointer');
  });

  it('opens an absolute URL in a new tab when tapped', () => {
    const s = makeScreen(fakeApi());
    const open = vi.fn();
    const original = globalThis.open;
    (globalThis as { open?: unknown }).open = open;
    try {
      privateOf(s).privacyLink.emit('pointertap');
    } finally {
      (globalThis as { open?: unknown }).open = original;
    }
    expect(open).toHaveBeenCalledTimes(1);
    expect(String(open.mock.calls[0]![0])).toMatch(/^https:\/\//);
    expect(open.mock.calls[0]![1]).toBe('_blank');
  });

  it('translates with the rest of the screen', async () => {
    const s = makeScreen(fakeApi());
    const english = privateOf(s).privacyLink.text;
    await useLocale('zh');
    s.show(800, 600);
    expect(privateOf(s).privacyLink.text).not.toBe(english);
    expect(privateOf(s).privacyLink.text.length).toBeGreaterThan(0);
  });
});

/**
 * The INPUT path — field tap to API call, through the real `TextInputOverlay`.
 *
 * Every case above this point calls `doLogin`/`doRegister`/`doChangePassword` directly, so
 * none of them proves a player can reach those methods at all. The real overlay is used rather
 * than a fake one for the reason this block was first written (2026-09-17): `password: true`
 * is passed from here and nowhere else, and deleting it keeps every other test green while
 * the player's password shows in plain text as they type it.
 *
 * Since the sheet redesign (design/10, 2026-09-27) the form is two `FormField`s over ONE
 * primary button, with LOG IN / REGISTER as tabs: Enter walks from the first field to the
 * second and submits from the second; a tap elsewhere (blur) keeps what was typed.
 */
class FakeInput {
  type = '';
  placeholder = '';
  maxLength = 0;
  autocapitalize = '';
  autocomplete = '';
  spellcheck = false;
  style: Record<string, string> = {};
  value = '';
  removed = false;
  private readonly listeners: Record<string, ((e: unknown) => void)[]> = {};
  addEventListener(type: string, fn: (e: unknown) => void): void {
    (this.listeners[type] ??= []).push(fn);
  }
  focus(): void {}
  remove(): void {
    this.removed = true;
  }
  private key(key: string): void {
    for (const fn of [...(this.listeners.keydown ?? [])]) fn({ key, stopPropagation: () => {} });
  }
  /** Type a value and press Enter. */
  submit(value: string): void {
    this.value = value;
    this.key('Enter');
  }
  /** Type a value and tap somewhere else. */
  blur(value: string): void {
    this.value = value;
    for (const fn of [...(this.listeners.blur ?? [])]) fn({});
  }
  /** Type a value and press Escape. */
  escape(value: string): void {
    this.value = value;
    this.key('Escape');
  }
}

function stubDom(): FakeInput[] {
  const appended: FakeInput[] = [];
  vi.stubGlobal('document', {
    createElement: () => new FakeInput(),
    querySelector: () => null,
    body: { appendChild: (el: FakeInput) => appended.push(el) },
  });
  return appended;
}

interface FieldLike {
  onTap: () => void;
  text: string;
  view: { visible: boolean };
}

function form(s: LoginScreen) {
  return s as unknown as {
    loginBtn: { onTap: () => void };
    registerBtn: { onTap: () => void };
    submitBtn: { onTap: () => void; view: { visible: boolean }; label: { text: string } };
    changePasswordBtn: { onTap: () => void };
    userField: FieldLike;
    passField: FieldLike;
    oldPassField: FieldLike;
    newPassField: FieldLike;
  };
}

describe('LoginScreen — from the field to the API', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('LOG IN: the username field, then a MASKED password field, then the API with both', async () => {
    const inputs = stubDom();
    const login = vi.fn().mockResolvedValue(SESSION);
    const s = makeScreen(fakeApi({ login }));

    form(s).userField.onTap();
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.maxLength).toBe(20); // the server's MAX_USERNAME
    expect(inputs[0]!.type).toBe('text');

    inputs[0]!.submit('alice');
    expect(inputs).toHaveLength(2);
    expect(inputs[1]!.maxLength).toBe(64);
    // The one assertion this whole block exists for.
    expect(inputs[1]!.type).toBe('password');

    inputs[1]!.submit('hunter22');
    await vi.waitFor(() => expect(login).toHaveBeenCalledWith('http://mm', 'alice', 'hunter22'));
  });

  it('trims the username, so a stray space cannot make a second account', () => {
    const inputs = stubDom();
    const login = vi.fn().mockResolvedValue(SESSION);
    const s = makeScreen(fakeApi({ login }));
    form(s).userField.onTap();
    inputs[0]!.submit('  alice  ');
    inputs[1]!.submit('hunter22');
    expect(login).toHaveBeenCalledWith('http://mm', 'alice', 'hunter22');
  });

  it('refuses an empty username without ever opening the password field', () => {
    // A blank Enter must not walk on to the password and then post `''` as a username — the
    // server would refuse it, but only after the player typed their password into a field
    // opened for an account that cannot exist.
    const inputs = stubDom();
    const login = vi.fn();
    const s = makeScreen(fakeApi({ login }));
    form(s).userField.onTap();
    inputs[0]!.submit('   ');
    expect(inputs).toHaveLength(1);
    expect(privateOf(s).statusText.text).toBe(t('auth.usernameRequired'));
    expect(login).not.toHaveBeenCalled();
  });

  it('REGISTER is a tab over the same form, and lands on register, not login', () => {
    const inputs = stubDom();
    const register = vi.fn().mockResolvedValue(SESSION);
    const login = vi.fn();
    const s = makeScreen(fakeApi({ register, login }));
    form(s).registerBtn.onTap();
    expect(form(s).submitBtn.label.text).toBe(t('auth.submitRegister'));
    form(s).userField.onTap();
    inputs[0]!.submit('newbie');
    expect(inputs[1]!.type).toBe('password');
    inputs[1]!.submit('hunter22');
    expect(register).toHaveBeenCalledWith('http://mm', 'newbie', 'hunter22');
    expect(login).not.toHaveBeenCalled();
  });

  it('the LOG IN tab puts the primary back to logging in', () => {
    const s = makeScreen(fakeApi());
    form(s).registerBtn.onTap();
    form(s).loginBtn.onTap();
    expect(form(s).submitBtn.label.text).toBe(t('auth.submitLogin'));
  });

  it('a tap elsewhere KEEPS what was typed, so the primary button can send it', async () => {
    // The blur path is how a player types a password and then presses the button, rather than
    // Enter — a prompt that dropped the value on blur would send an empty password.
    const inputs = stubDom();
    const login = vi.fn().mockResolvedValue(SESSION);
    const s = makeScreen(fakeApi({ login }));
    form(s).userField.onTap();
    inputs[0]!.blur('alice');
    form(s).passField.onTap();
    inputs[1]!.blur('hunter22');
    expect(form(s).userField.text).toBe('alice');
    form(s).submitBtn.onTap();
    await vi.waitFor(() => expect(login).toHaveBeenCalledWith('http://mm', 'alice', 'hunter22'));
  });

  it('Escape drops the edit and leaves the field as it was', () => {
    const inputs = stubDom();
    const s = makeScreen(fakeApi());
    form(s).userField.onTap();
    inputs[0]!.blur('alice');
    form(s).userField.onTap();
    const again = inputs[inputs.length - 1]!;
    expect(again.value).toBe('alice'); // it opens on the value it has
    again.escape('mallory');
    expect(form(s).userField.text).toBe('alice');
  });

  it('the primary button names what is missing instead of calling the API', () => {
    const inputs = stubDom();
    const login = vi.fn();
    const s = makeScreen(fakeApi({ login }));
    form(s).submitBtn.onTap();
    expect(privateOf(s).statusText.text).toBe(t('auth.usernameRequired'));
    form(s).userField.onTap();
    inputs[0]!.blur('alice');
    form(s).submitBtn.onTap();
    expect(privateOf(s).statusText.text).toBe(t('auth.passwordRequired'));
    expect(login).not.toHaveBeenCalled();
  });

  it('a password never outlives the attempt, or the screen; the username does', async () => {
    const inputs = stubDom();
    const s = makeScreen(fakeApi({ login: vi.fn().mockRejectedValue(new Error('invalid username or password')) }));
    form(s).userField.onTap();
    inputs[0]!.submit('alice');
    inputs[1]!.submit('wrong');
    await vi.waitFor(() => expect(privateOf(s).statusText.text).toBe('invalid username or password'));
    expect(form(s).passField.text).toBe('');
    expect(form(s).userField.text).toBe('alice');
    form(s).passField.onTap();
    inputs[inputs.length - 1]!.blur('typed-then-left');
    expect(form(s).passField.text).toBe('typed-then-left');
    s.hide();
    expect(form(s).passField.text).toBe('');
  });

  it('CHANGE PASSWORD unfolds a form of two MASKED fields, and SAVE sends both', async () => {
    const inputs = stubDom();
    const changePassword = vi.fn().mockResolvedValue(undefined);
    const s = makeScreen(fakeApi({ login: vi.fn().mockResolvedValue(SESSION), changePassword }));
    await privateOf(s).doLogin('alice', 'hunter22'); // the button only exists once logged in
    expect(form(s).oldPassField.view.visible).toBe(false);
    expect(form(s).submitBtn.view.visible).toBe(false);

    form(s).changePasswordBtn.onTap();
    expect(form(s).oldPassField.view.visible).toBe(true);
    expect(form(s).submitBtn.label.text).toBe(t('auth.savePassword'));
    form(s).oldPassField.onTap();
    expect(inputs[0]!.type).toBe('password');
    inputs[0]!.submit('hunter22');
    expect(inputs[1]!.type).toBe('password');
    inputs[1]!.submit('newpassword1');
    await vi.waitFor(() => expect(changePassword).toHaveBeenCalledWith('http://mm', 'tok-1', 'hunter22', 'newpassword1'));
    // A change that landed folds the form away and says so.
    await vi.waitFor(() => expect(form(s).oldPassField.view.visible).toBe(false));
    expect(privateOf(s).statusText.text).toBe(t('auth.passwordChanged'));
  });

  it('SAVE with a field left empty names it instead of calling the API', async () => {
    const changePassword = vi.fn();
    const s = makeScreen(fakeApi({ login: vi.fn().mockResolvedValue(SESSION), changePassword }));
    await privateOf(s).doLogin('alice', 'hunter22');
    form(s).changePasswordBtn.onTap();
    form(s).submitBtn.onTap();
    expect(privateOf(s).statusText.text).toBe(t('auth.passwordRequired'));
    expect(changePassword).not.toHaveBeenCalled();
    // Folding the form away again clears it.
    form(s).changePasswordBtn.onTap();
    expect(form(s).oldPassField.view.visible).toBe(false);
    expect(privateOf(s).statusText.text).toBe('');
  });

  it('opens nothing at all while a call is still in flight', async () => {
    // `edit`'s own busy guard, which is a different line from the one in `do*` that the
    // re-entrancy block above pins: without it a second tap opens a second input over the
    // first, and the player types their password into a field whose submit is discarded.
    const inputs = stubDom();
    const d = deferred<AuthResult>();
    const s = makeScreen(fakeApi({ login: vi.fn().mockReturnValue(d.promise) }));
    form(s).userField.onTap();
    inputs[0]!.submit('alice');
    inputs[1]!.submit('hunter22');
    const during = inputs.length;
    form(s).userField.onTap();
    form(s).passField.onTap();
    form(s).registerBtn.onTap();
    form(s).submitBtn.onTap();
    expect(inputs).toHaveLength(during);
    expect(form(s).submitBtn.label.text).toBe(t('auth.submitLogin')); // the tab did not switch
    d.resolve(SESSION);
    await Promise.resolve();
  });

  it('CHANGE PASSWORD does nothing at all for a guest', () => {
    // The button is hidden rather than disabled, but `togglePasswordForm` guards on the
    // session too — a tap arriving from a stale hit area must not unfold a form whose SAVE
    // would read `this.session` as null.
    const inputs = stubDom();
    const s = makeScreen(fakeApi());
    form(s).changePasswordBtn.onTap();
    expect(form(s).oldPassField.view.visible).toBe(false);
    expect(inputs).toHaveLength(0);
  });
});

describe('LoginScreen — where the real input opens', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('opens the input ON the field it edits, not as a prompt in the middle of the screen', () => {
    // The point of the form (FormField's header): a player types into the box they tapped.
    // With no canvas in the stub the page offset is zero, so the style is the field's rect.
    const inputs = stubDom();
    const s = makeScreen(fakeApi());
    const field = (s as unknown as { passField: FieldLike & { anchorRect(): { x: number; y: number; w: number; h: number } } }).passField;
    field.onTap();
    const rect = field.anchorRect();
    expect(rect.w).toBeGreaterThan(0);
    expect(inputs[0]!.style.left).toBe(`${rect.x}px`);
    expect(inputs[0]!.style.top).toBe(`${rect.y}px`);
    expect(inputs[0]!.style.width).toBe(`${rect.w}px`);
    // Control: the username field opens somewhere else — the style follows the field.
    form(s).userField.onTap();
    expect(inputs[1]!.style.top).not.toBe(inputs[0]!.style.top);
  });

  it('the folded password form cannot be submitted while signed in', async () => {
    const changePassword = vi.fn();
    const s = makeScreen(fakeApi({ login: vi.fn().mockResolvedValue(SESSION), changePassword }));
    await privateOf(s).doLogin('alice', 'hunter22');
    expect(form(s).submitBtn.view.visible).toBe(false);
    form(s).submitBtn.onTap();
    expect(changePassword).not.toHaveBeenCalled();
    expect(privateOf(s).statusText.text).not.toBe(t('auth.passwordRequired'));
  });
});
