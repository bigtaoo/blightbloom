/**
 * PartyScreen (design/05/15 PvP squad follow-up). Driven with a fake `PartyApi` (no
 * network) — mirrors this project's standing DI convention (Matchmaker/PartyService/
 * findMatch). Pixi Container/Text/Graphics construct and mutate fine under plain
 * vitest with no renderer attached (same finding TouchControlsView.test.ts made) —
 * asserted here via `.visible`/`.text`, not pixel output.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { PartyScreen, type PartyApi } from './PartyScreen';
import type { PartyInfo } from '../../net/party';
import { setLocale, resetLocaleForTests } from '../../i18n';
import { getPartyPresence, resetPartyPresence } from '../../platform/partyPresence';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeApi(overrides: Partial<PartyApi> = {}): PartyApi {
  return {
    createParty: vi.fn(),
    joinParty: vi.fn(),
    leaveParty: vi.fn(),
    startPartyMatching: vi.fn(),
    getParty: vi.fn(),
    ...overrides,
  };
}

const PARTY: PartyInfo = { partyId: 'p1', code: 'ABCDE', leaderId: 'me', members: ['me'], matching: false };

function makeScreen(api: PartyApi, playerId = 'me') {
  const screen = new PartyScreen({ matchBaseUrl: 'http://mm', playerId, api });
  screen.show(800, 600);
  return screen;
}

// Reach private state via the same escape hatch tests elsewhere in this repo use for
// Pixi widgets with no public getters — `as any` on a private-only surface, never on
// engine/sim state.
function privateOf(s: PartyScreen) {
  return s as unknown as {
    title: { text: string };
    createBtn: { view: { visible: boolean }; label: { text: string } };
    joinBtn: { view: { visible: boolean }; label: { text: string } };
    startBtn: { view: { visible: boolean }; label: { text: string } };
    leaveBtn: { view: { visible: boolean }; label: { text: string } };
    codeText: { text: string };
    membersText: { text: string };
    statusText: { text: string };
    doCreate(): Promise<void>;
    doJoin(code: string): Promise<void>;
    doStart(): Promise<void>;
    doLeave(): Promise<void>;
    pollOnce(): Promise<void>;
  };
}

afterEach(() => resetLocaleForTests());

describe('PartyScreen — no party yet', () => {
  it('shows create/join, hides start/leave, before any party exists', () => {
    const s = makeScreen(fakeApi());
    const p = privateOf(s);
    expect(p.createBtn.view.visible).toBe(true);
    expect(p.joinBtn.view.visible).toBe(true);
    expect(p.startBtn.view.visible).toBe(false);
    expect(p.leaveBtn.view.visible).toBe(false);
  });
});

describe('PartyScreen — create', () => {
  it('creating a party shows the code and switches to leave/start (as leader)', async () => {
    const api = fakeApi({ createParty: vi.fn().mockResolvedValue(PARTY) });
    const s = makeScreen(api);
    const p = privateOf(s);
    await p.doCreate();
    expect(api.createParty).toHaveBeenCalledWith('http://mm', 'me');
    expect(p.codeText.text).toContain('ABCDE');
    expect(p.startBtn.view.visible).toBe(true); // leader
    expect(p.leaveBtn.view.visible).toBe(true);
    expect(p.createBtn.view.visible).toBe(false);
  });

  it('a failed create shows a status message and leaves the screen in the pre-party state', async () => {
    const api = fakeApi({ createParty: vi.fn().mockRejectedValue(new Error('boom')) });
    const s = makeScreen(api);
    const p = privateOf(s);
    await p.doCreate();
    expect(p.statusText.text).toMatch(/could not create/i);
    expect(p.createBtn.view.visible).toBe(true); // still in the pre-party state
  });
});

describe('PartyScreen — join', () => {
  it('joining shows the roster and hides start (not leader)', async () => {
    const joined: PartyInfo = { partyId: 'p1', code: 'ABCDE', leaderId: 'alice', members: ['alice', 'me'] , matching: false };
    const api = fakeApi({ joinParty: vi.fn().mockResolvedValue(joined) });
    const s = makeScreen(api, 'me');
    const p = privateOf(s);
    await p.doJoin('ABCDE');
    expect(api.joinParty).toHaveBeenCalledWith('http://mm', 'me', 'ABCDE');
    expect(p.membersText.text).toContain('alice');
    expect(p.membersText.text).toContain('you'); // self labeled "you", not its raw id
    expect(p.startBtn.view.visible).toBe(false); // alice is leader, not me
    expect(p.leaveBtn.view.visible).toBe(true);
  });

  it('an invalid code surfaces a status message without joining', async () => {
    const api = fakeApi({ joinParty: vi.fn().mockRejectedValue(new Error('not found')) });
    const s = makeScreen(api);
    const p = privateOf(s);
    await p.doJoin('NOPE1');
    expect(p.statusText.text).toMatch(/invalid or full/i);
    expect(p.leaveBtn.view.visible).toBe(false);
  });
});

describe('PartyScreen — start matching', () => {
  it('the leader starting matching fires onStartMatch with the partyId', async () => {
    const api = fakeApi({
      createParty: vi.fn().mockResolvedValue(PARTY),
      startPartyMatching: vi.fn().mockResolvedValue({ ...PARTY, matching: true }),
    });
    const s = makeScreen(api);
    const p = privateOf(s);
    const onStart = vi.fn();
    s.onStartMatch = onStart;
    await p.doCreate();
    await p.doStart();
    expect(api.startPartyMatching).toHaveBeenCalledWith('http://mm', 'p1', 'me');
    expect(onStart).toHaveBeenCalledWith('p1');
  });

  it('a non-leader polling and seeing matching flip to true also fires onStartMatch, without tapping anything', async () => {
    const joined: PartyInfo = { partyId: 'p1', code: 'ABCDE', leaderId: 'alice', members: ['alice', 'me'], matching: false };
    const nowMatching: PartyInfo = { ...joined, matching: true };
    const api = fakeApi({
      joinParty: vi.fn().mockResolvedValue(joined),
      getParty: vi.fn().mockResolvedValue(nowMatching),
    });
    const s = makeScreen(api, 'me');
    const p = privateOf(s);
    const onStart = vi.fn();
    s.onStartMatch = onStart;
    await p.doJoin('ABCDE');
    await p.pollOnce(); // simulates the periodic poll observing the leader's flip
    expect(onStart).toHaveBeenCalledWith('p1');
  });

  it('polling again after already-matching does not re-fire onStartMatch', async () => {
    const already: PartyInfo = { ...PARTY, matching: true };
    const api = fakeApi({
      createParty: vi.fn().mockResolvedValue(already),
      getParty: vi.fn().mockResolvedValue(already),
    });
    const s = makeScreen(api);
    const p = privateOf(s);
    const onStart = vi.fn();
    await p.doCreate();
    s.onStartMatch = onStart; // wired AFTER create, so create's own fire (if any) isn't counted
    await p.pollOnce();
    await p.pollOnce();
    expect(onStart).toHaveBeenCalledTimes(0); // wasMatching was already true both times
  });
});

describe('PartyScreen — leave', () => {
  it('leaving clears the party and reverts to create/join', async () => {
    const api = fakeApi({
      createParty: vi.fn().mockResolvedValue(PARTY),
      leaveParty: vi.fn().mockResolvedValue(null),
    });
    const s = makeScreen(api);
    const p = privateOf(s);
    await p.doCreate();
    await p.doLeave();
    expect(api.leaveParty).toHaveBeenCalledWith('http://mm', 'p1', 'me');
    expect(p.createBtn.view.visible).toBe(true);
    expect(p.leaveBtn.view.visible).toBe(false);
    expect(p.codeText.text).toBe('');
  });
});

describe('PartyScreen — poll observing the party dissolve', () => {
  it('a null poll result (party closed) reverts to the pre-party state with a status message', async () => {
    const api = fakeApi({
      createParty: vi.fn().mockResolvedValue(PARTY),
      getParty: vi.fn().mockResolvedValue(null),
    });
    const s = makeScreen(api);
    const p = privateOf(s);
    await p.doCreate();
    await p.pollOnce();
    expect(p.statusText.text).toMatch(/closed/i);
    expect(p.createBtn.view.visible).toBe(true);
  });
});

describe('PartyScreen — hide()', () => {
  it('hides the view without throwing even with no open input overlay', () => {
    const s = makeScreen(fakeApi());
    expect(() => s.hide()).not.toThrow();
  });
});

describe('PartyScreen — staleness guard (backing out mid-request never lands a late onStartMatch)', () => {
  it('doStart: hiding the screen before startPartyMatching resolves discards the result and never fires onStartMatch', async () => {
    const d = deferred<PartyInfo>();
    const api = fakeApi({
      createParty: vi.fn().mockResolvedValue(PARTY),
      startPartyMatching: vi.fn().mockReturnValue(d.promise),
    });
    const s = makeScreen(api);
    const p = privateOf(s);
    const onStart = vi.fn();
    s.onStartMatch = onStart;
    await p.doCreate();

    const startPromise = p.doStart(); // leader taps START MATCHING...
    s.hide(); // ...then immediately backs out (Game.ts's showMenu() → partyScreen.hide())
    d.resolve({ ...PARTY, matching: true }); // the server call finally lands
    await startPromise;

    expect(onStart).not.toHaveBeenCalled();
  });

  it('pollOnce: hiding the screen mid-poll discards the result and never fires onStartMatch', async () => {
    const joined: PartyInfo = { partyId: 'p1', code: 'ABCDE', leaderId: 'alice', members: ['alice', 'me'], matching: false };
    const d = deferred<PartyInfo>();
    const api = fakeApi({
      joinParty: vi.fn().mockResolvedValue(joined),
      getParty: vi.fn().mockReturnValue(d.promise),
    });
    const s = makeScreen(api, 'me');
    const p = privateOf(s);
    const onStart = vi.fn();
    s.onStartMatch = onStart;
    await p.doJoin('ABCDE');

    const pollPromise = p.pollOnce(); // a routine 1s poll goes out...
    s.hide(); // ...player backs out before it lands
    d.resolve({ ...joined, matching: true });
    await pollPromise;

    expect(onStart).not.toHaveBeenCalled();
  });

  it('doCreate: a stale resolve after hide() never overwrites `party` (no stale state on the NEXT show())', async () => {
    const d = deferred<PartyInfo>();
    const api = fakeApi({ createParty: vi.fn().mockReturnValue(d.promise) });
    const s = makeScreen(api);
    const p = privateOf(s);

    const createPromise = p.doCreate();
    s.hide();
    d.resolve(PARTY);
    await createPromise;

    s.show(800, 600); // re-enter the screen later
    expect(p.createBtn.view.visible).toBe(true); // still pre-party — the stale create never landed
    expect(p.codeText.text).toBe('');
  });

  it('`busy` always clears after a stale (post-hide) resolve, so re-showing the screen can create/join/start again', async () => {
    const d = deferred<PartyInfo>();
    const api = fakeApi({ createParty: vi.fn().mockReturnValue(d.promise) });
    const s = makeScreen(api);
    const p = privateOf(s);

    const first = p.doCreate();
    s.hide();
    d.resolve(PARTY);
    await first;

    s.show(800, 600);
    const api2 = api.createParty as ReturnType<typeof vi.fn>;
    api2.mockResolvedValue({ ...PARTY, code: 'ZZZZZ' });
    await p.doCreate(); // must not be swallowed by a `busy` flag stuck true from the stale attempt
    expect(p.codeText.text).toContain('ZZZZZ');
  });
});

describe('PartyScreen — i18n (design/17-i18n.md)', () => {
  it('retexts on show() under zh', () => {
    const s = makeScreen(fakeApi());
    setLocale('zh');
    s.show(800, 600);
    const p = privateOf(s);
    expect(p.title.text).toBe('组队');
    expect(p.createBtn.label.text).toBe('创建队伍');
    expect(p.joinBtn.label.text).toBe('输入邀请码加入');
  });

  it('translates the code line, member "you" label, and status messages under zh', async () => {
    const api = fakeApi({ createParty: vi.fn().mockResolvedValue(PARTY) });
    setLocale('zh');
    const s = makeScreen(api);
    await privateOf(s).doCreate();
    const p = privateOf(s);
    expect(p.codeText.text).toBe('邀请码：ABCDE');
    expect(p.membersText.text).toContain('你');
  });

  it('a failed create under zh surfaces the translated error', async () => {
    const api = fakeApi({ createParty: vi.fn().mockRejectedValue(new Error('boom')) });
    setLocale('zh');
    const s = makeScreen(api);
    await privateOf(s).doCreate();
    expect(privateOf(s).statusText.text).toBe('创建队伍失败，请重试。');
  });

  it('switching back to English on a later show() fully reverts', () => {
    const s = makeScreen(fakeApi());
    setLocale('zh');
    s.show(800, 600);
    setLocale('en');
    s.show(800, 600);
    expect(privateOf(s).title.text).toBe('SQUAD');
  });
});

describe('PartyScreen — declaring the squad to the host (design/20)', () => {
  // A game portal requires room information be passed through its SDK so a friend can join
  // (`platform/partyPresence.ts` is the seam, `crazygames/PortalRooms.ts` the reader). What
  // is pinned here is the SOURCE of that declaration: this screen, from the one place all of
  // create/join/start/leave and the poll converge.
  beforeEach(() => resetPartyPresence());
  afterEach(() => resetPartyPresence());

  it('declares nothing before there is a party', () => {
    makeScreen(fakeApi());
    expect(getPartyPresence()).toBeNull();
  });

  it('declares a joinable squad once one is created', async () => {
    const api = fakeApi({ createParty: vi.fn().mockResolvedValue(PARTY) });
    const s = makeScreen(api);
    await privateOf(s).doCreate();
    expect(getPartyPresence()).toEqual({ partyId: 'p1', code: 'ABCDE', joinable: true });
  });

  it('declares it CLOSED once the party is matching', async () => {
    // The seats are being allocated; a joiner would be refused, so the platform must not
    // be told the room is open.
    const matching: PartyInfo = { ...PARTY, matching: true };
    const api = fakeApi({ createParty: vi.fn().mockResolvedValue(matching) });
    const s = makeScreen(api);
    await privateOf(s).doCreate();
    expect(getPartyPresence()?.joinable).toBe(false);
  });

  it('declares it CLOSED once the party is full', async () => {
    // `SQUAD_SIZE` is 4 and the server's own `MAX_PARTY_SIZE` is an alias of it, so this is
    // the same cap a fifth player's join would be refused by.
    const full: PartyInfo = { ...PARTY, members: ['me', 'b', 'c', 'd'] };
    const api = fakeApi({ createParty: vi.fn().mockResolvedValue(full) });
    const s = makeScreen(api);
    await privateOf(s).doCreate();
    expect(getPartyPresence()?.joinable).toBe(false);
  });

  it('withdraws the declaration on leave', async () => {
    const api = fakeApi({
      createParty: vi.fn().mockResolvedValue(PARTY),
      leaveParty: vi.fn().mockResolvedValue(null),
    });
    const s = makeScreen(api);
    await privateOf(s).doCreate();
    expect(getPartyPresence()).not.toBeNull();
    await privateOf(s).doLeave();
    expect(getPartyPresence()).toBeNull();
  });
});

describe('PartyScreen.joinWithCode — an accepted portal invite', () => {
  beforeEach(() => resetPartyPresence());
  afterEach(() => resetPartyPresence());

  it('joins the code as if it had been typed', async () => {
    const joined: PartyInfo = { ...PARTY, leaderId: 'them', members: ['them', 'me'] };
    const api = fakeApi({ joinParty: vi.fn().mockResolvedValue(joined) });
    const s = makeScreen(api);
    s.joinWithCode('ABCDE');
    await Promise.resolve();
    await Promise.resolve();
    expect(api.joinParty).toHaveBeenCalledWith('http://mm', 'me', 'ABCDE');
    expect(getPartyPresence()).toEqual({ partyId: 'p1', code: 'ABCDE', joinable: true });
  });

  it('trims the code, since it arrived from a URL', async () => {
    const api = fakeApi({ joinParty: vi.fn().mockResolvedValue(PARTY) });
    makeScreen(api).joinWithCode('  ABCDE  ');
    await Promise.resolve();
    expect(api.joinParty).toHaveBeenCalledWith('http://mm', 'me', 'ABCDE');
  });

  it('shares the busy guard with a typed join rather than racing it', async () => {
    const gate = deferred<PartyInfo>();
    const api = fakeApi({ joinParty: vi.fn().mockReturnValue(gate.promise) });
    const s = makeScreen(api);
    s.joinWithCode('ABCDE');
    s.joinWithCode('WXYZ');
    gate.resolve(PARTY);
    await Promise.resolve();
    expect(api.joinParty).toHaveBeenCalledTimes(1);
  });

  it('reports a bad code the same way a typed one does, and declares no party', async () => {
    const api = fakeApi({ joinParty: vi.fn().mockRejectedValue(new Error('not found')) });
    const s = makeScreen(api);
    s.joinWithCode('NOPE');
    await Promise.resolve();
    await Promise.resolve();
    expect(privateOf(s).statusText.text).toBe('Invalid or full code.');
    expect(getPartyPresence()).toBeNull();
  });

  it('ignores an empty code', async () => {
    const api = fakeApi({ joinParty: vi.fn() });
    makeScreen(api).joinWithCode('   ');
    await Promise.resolve();
    expect(api.joinParty).not.toHaveBeenCalled();
  });
});
