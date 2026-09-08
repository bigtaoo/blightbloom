/**
 * LoginScreen (design/16-accounts.md). Driven with a fake `AuthApi` (no network) —
 * mirrors PartyScreen.test.ts's style, reaching private do-action state via the same
 * escape hatch. Session state is global (net/session.ts), so each test resets it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LoginScreen, type AuthApi } from './LoginScreen';
import { resetSessionCacheForTests, getSession } from '../../net/session';
import type { AuthResult } from '../../net/auth';
import { setLocale, resetLocaleForTests } from '../../i18n';

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
  return s as unknown as {
    title: { text: string };
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
  };
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
  it('retexts on show() under zh, guest and logged-in copy alike', () => {
    const s = makeScreen(fakeApi());
    setLocale('zh');
    s.show(800, 600);
    const p = privateOf(s);
    expect(p.title.text).toBe('账户');
    expect(p.loginBtn.label.text).toBe('登录');
    expect(p.registerBtn.label.text).toBe('注册');
    expect(p.whoText.text).toBe('以访客身份游玩');
  });

  it('a failed login under zh falls back to the translated error when the server sends none', async () => {
    const api = fakeApi({ login: vi.fn().mockRejectedValue(new Error()) });
    setLocale('zh');
    const s = makeScreen(api);
    await privateOf(s).doLogin('alice', 'wrong');
    expect(privateOf(s).statusText.text).toBe('登录失败，请重试。');
  });

  it('switching back to English on a later show() fully reverts', () => {
    const s = makeScreen(fakeApi());
    setLocale('zh');
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

  it('translates with the rest of the screen', () => {
    const s = makeScreen(fakeApi());
    const english = privateOf(s).privacyLink.text;
    setLocale('zh');
    s.show(800, 600);
    expect(privateOf(s).privacyLink.text).not.toBe(english);
    expect(privateOf(s).privacyLink.text.length).toBeGreaterThan(0);
  });
});
