/**
 * Unit tests for `server/src/routes/*` — the route groups `matchsvc.ts` was split into on
 * 2026-09-04 (P0, prep for ROADMAP Phase 8).
 *
 * The two HTTP files (`matchsvc.http.test.ts`, `matchsvc.queue.http.test.ts`) drive these
 * same handlers through a real `node:http` server and are the reason the split could be
 * verified as behaviour-preserving at all — they are not repeated here. What this file adds
 * is the set of paths a real request cannot easily produce, and which were uncovered
 * BEFORE the split too:
 *
 *  - `readJson`'s three non-happy exits: a body that overflows the 4 KB cap (the tail is
 *    dropped, not the request rejected), malformed JSON, and a stream `error` event.
 *  - `requireAuth`'s two refusal shapes (absent header, non-Bearer scheme) and the fact
 *    that it hands the service the token ONLY, not the whole header value.
 *  - `POST /auth/logout` with a non-string token — the fallback arm of the one `if` in
 *    that handler, which a client sending a real token never takes.
 *  - The three `/:param` extractors. This is the one thing the split genuinely moved: the
 *    shell used to capture the path parameter and the handler received it; now each handler
 *    re-matches its own exported pattern. A handler reading the wrong capture group, or
 *    forgetting `decodeURIComponent`, would still answer 200 with plausible-looking JSON.
 *  - `send`'s `access-control-allow-headers`, asserted at the unit layer as well as through
 *    a real browser-shaped preflight, because design/16-accounts.md records dropping
 *    `authorization` from it as a bug only a real preflight can surface.
 */
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AuthService } from '../src/AuthService';
import type { Matchmaker, MatchTicket } from '../src/Matchmaker';
import type { PartyService } from '../src/PartyService';
import type { RatingStore } from '../src/rating';
import { CORS, readJson, send } from '../src/routes/http';
import { getMe, postLogout, requireAuth } from '../src/routes/auth';
import { FIND_POLL_PATH, getFindPoll } from '../src/routes/match';
import { PARTY_LOOKUP_PATH, getParty, randomCode } from '../src/routes/party';
import { RATING_LOOKUP_PATH, getRating } from '../src/routes/rating';

// --- fakes -----------------------------------------------------------------------------
// Deliberately hand-written rather than mocked: a route handler's whole job is to move
// values between the HTTP objects and one service call, so the assertion worth making is
// "which value reached which side", and a recording double states that directly.

interface Recorded {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function fakeRes(): { res: ServerResponse; sent: Recorded } {
  const sent: Recorded = { status: 0, headers: {}, body: '' };
  const res = {
    writeHead(status: number, headers: Record<string, string>) {
      sent.status = status;
      sent.headers = headers;
      return res;
    },
    end(body?: string) {
      sent.body = body ?? '';
    },
  };
  return { res: res as unknown as ServerResponse, sent };
}

/** An `IncomingMessage` that is only an event emitter plus headers — all `readJson` uses. */
function fakeReq(headers: Record<string, string> = {}): IncomingMessage & EventEmitter {
  const req = new EventEmitter() as EventEmitter & { headers: Record<string, string> };
  req.headers = headers;
  return req as unknown as IncomingMessage & EventEmitter;
}

const url = (pathname: string) => new URL(`http://match.test${pathname}`);

const parsed = (sent: Recorded) => JSON.parse(sent.body) as Record<string, unknown>;

// --- routes/http.ts --------------------------------------------------------------------

describe('routes/http send', () => {
  it('writes JSON with the CORS block and a content type', async () => {
    const { res, sent } = fakeRes();
    send(res, 200, { ok: true });
    expect(sent.status).toBe(200);
    expect(sent.body).toBe('{"ok":true}');
    expect(sent.headers['content-type']).toBe('application/json');
    expect(sent.headers['access-control-allow-origin']).toBe('*');
  });

  it('keeps `authorization` in access-control-allow-headers (design/16 regression guard)', async () => {
    // Not a style preference: without it a browser preflight rejects every /auth/me and
    // /account/* call before it is sent, and the failure surfaces client-side as a bare
    // "Failed to fetch" with no server log at all. Asserted on the constant AND on a
    // response, so neither editing the constant nor bypassing it can pass unnoticed.
    const { res, sent } = fakeRes();
    send(res, 200, {});
    for (const headers of [CORS, sent.headers]) {
      const allowed = headers['access-control-allow-headers']!.split(',').map((s) => s.trim());
      expect(allowed).toContain('authorization');
      expect(allowed).toContain('content-type');
    }
  });

  it('sends 204 with a genuinely empty body, not the string "{}"', async () => {
    const { res, sent } = fakeRes();
    send(res, 204, { ignored: true });
    expect(sent.status).toBe(204);
    expect(sent.body).toBe('');
  });
});

describe('routes/http readJson', () => {
  /** Drive one request body through `readJson` and resolve with what the callback saw. */
  function drive(emit: (req: EventEmitter) => void): Promise<unknown> {
    const req = fakeReq();
    return new Promise<unknown>((resolve) => {
      readJson(req, resolve);
      emit(req);
    });
  }

  it('parses a JSON body', async () => {
    expect(await drive((r) => {
      r.emit('data', Buffer.from('{"playerCount":4}'));
      r.emit('end');
    })).toEqual({ playerCount: 4 });
  });

  it('reassembles a body split across chunks', async () => {
    expect(await drive((r) => {
      r.emit('data', Buffer.from('{"a":'));
      r.emit('data', Buffer.from('1}'));
      r.emit('end');
    })).toEqual({ a: 1 });
  });

  it('treats an absent body as {}', async () => {
    expect(await drive((r) => r.emit('end'))).toEqual({});
  });

  it('treats malformed JSON as {} rather than throwing out of the request handler', async () => {
    expect(await drive((r) => {
      r.emit('data', Buffer.from('not json'));
      r.emit('end');
    })).toEqual({});
  });

  it('DROPS the tail past the 4 KB cap instead of rejecting the request', async () => {
    // The distinguishing case: the first chunk is already a complete, valid body, so if the
    // cap dropped the overflow tail (as intended) this still parses. A cap implemented as
    // "abort the whole read" would answer {} here and look identical to every other
    // oversized-body test.
    expect(await drive((r) => {
      r.emit('data', Buffer.from('{"a":1}'));
      r.emit('data', Buffer.from('x'.repeat(5000)));
      r.emit('end');
    })).toEqual({ a: 1 });
  });

  it('yields {} when the very first chunk overflows the cap', async () => {
    const huge = `{"data":"${'x'.repeat(5000)}"}`;
    expect(await drive((r) => {
      r.emit('data', Buffer.from(huge));
      r.emit('end');
    })).toEqual({});
  });

  it('yields {} on a stream error, and never invokes the callback twice', async () => {
    const req = fakeReq();
    const seen: unknown[] = [];
    readJson(req, (body) => seen.push(body));
    req.emit('error', new Error('socket reset'));
    // `readJson` resolves through a promise now, so its callback lands on a microtask
    // rather than inside `emit`. Nothing in production notices; a test that reads on the
    // next line does. The "never twice" half of this case is the one that matters and is
    // unchanged — `seen` must hold exactly one entry.
    await Promise.resolve();
    expect(seen).toEqual([{}]);
  });
});

// --- routes/auth.ts --------------------------------------------------------------------

function fakeAuth(overrides: Partial<AuthService> = {}): AuthService {
  return {
    verifySession: () => null,
    logout: () => {},
    ...overrides,
  } as unknown as AuthService;
}

describe('routes/auth requireAuth', () => {
  it('refuses a request with no Authorization header', async () => {
    const verifySession = vi.fn();
    expect(await requireAuth(fakeReq(), fakeAuth({ verifySession }))).toBeNull();
    // Not merely "returns null": an absent header must not reach the session store at all.
    expect(verifySession).not.toHaveBeenCalled();
  });

  it('refuses a non-Bearer scheme without consulting the session store', async () => {
    const verifySession = vi.fn();
    const req = fakeReq({ authorization: 'Basic dXNlcjpwYXNz' });
    expect(await requireAuth(req, fakeAuth({ verifySession }))).toBeNull();
    expect(verifySession).not.toHaveBeenCalled();
  });

  it('hands the store the token only, not the whole header value', async () => {
    const session = { accountId: 'a1', username: 'ada' };
    const verifySession = vi.fn(() => Promise.resolve(session));
    const req = fakeReq({ authorization: 'Bearer tok-123' });
    expect(await requireAuth(req, fakeAuth({ verifySession }))).toBe(session);
    expect(verifySession).toHaveBeenCalledWith('tok-123');
  });
});

describe('routes/auth handlers', () => {
  it('GET /auth/me answers 401 for an unauthenticated request', async () => {
    const { res, sent } = fakeRes();
    await getMe(fakeReq(), res, url('/auth/me'), { auth: fakeAuth() });
    expect(sent.status).toBe(401);
    expect(parsed(sent)).toEqual({ error: 'invalid or expired session' });
  });

  it('POST /auth/logout ignores a non-string token but still answers ok', async () => {
    // The fallback arm of this handler's only `if`. A logout is deliberately not an
    // authenticated route and must never 4xx — a client whose token is already gone (or
    // garbage) is exactly the client trying hardest to log out.
    const logout = vi.fn();
    const req = fakeReq();
    const { res, sent } = fakeRes();
    const done = postLogout(req, res, url('/auth/logout'), { auth: fakeAuth({ logout }) });
    await Promise.resolve();
    req.emit('data', Buffer.from('{"token":12345}'));
    req.emit('end');
    await done;
    expect(sent.status).toBe(200);
    expect(parsed(sent)).toEqual({ ok: true });
    expect(logout).not.toHaveBeenCalled();
  });

  it('POST /auth/logout forwards a string token to the session store', async () => {
    const logout = vi.fn();
    const req = fakeReq();
    const { res, sent } = fakeRes();
    const done = postLogout(req, res, url('/auth/logout'), { auth: fakeAuth({ logout }) });
    await Promise.resolve();
    req.emit('data', Buffer.from('{"token":"tok-9"}'));
    req.emit('end');
    await done;
    expect(sent.status).toBe(200);
    expect(logout).toHaveBeenCalledWith('tok-9');
  });
});

// --- the /:param extractors ------------------------------------------------------------
// Each of these three handlers re-matches its own exported pattern out of the URL, which
// is the one mechanic the split actually changed (the shell used to do the capturing).

describe('routes/match getFindPoll', () => {
  const deps = (poll: Matchmaker['poll']) => ({
    matchmaker: { poll } as unknown as Matchmaker,
    // ROADMAP 8.6: the URL is no longer a constant the shell closes over but a
    // `GameRegistry` lookup this group makes per request — see `matchsvc.registry.test.ts`
    // for the empty answer, which this happy-path fake never produces.
    pickGameserver: () => ({ wsUrl: 'ws://gs.test/ws' }),
    secret: 'unused-here',
  });

  it('percent-decodes the queue id before polling', async () => {
    const poll = vi.fn(() => ({ status: 'queued' as const }));
    const { res, sent } = fakeRes();
    getFindPoll(fakeReq(), res, url('/find/q%20one'), deps(poll as unknown as Matchmaker['poll']));
    expect(poll).toHaveBeenCalledWith('q one');
    expect(sent.status).toBe(200);
    expect(parsed(sent)).toEqual({ status: 'queued' });
  });

  it('stamps the gameserver URL onto a matched ticket, and only onto that shape', async () => {
    const ticket: MatchTicket = {
      roomId: 'r1',
      owner: 0,
      seed: 7,
      playerCount: 2,
      teamId: 0,
      mode: 'coop',
      token: 'signed',
    };
    const { res, sent } = fakeRes();
    getFindPoll(
      fakeReq(),
      res,
      url('/find/q1'),
      deps((() => ({ status: 'matched', ticket })) as unknown as Matchmaker['poll']),
    );
    expect(parsed(sent)).toEqual({ status: 'matched', match: { ...ticket, wsUrl: 'ws://gs.test/ws' } });
  });

  it('passes a non-matched poll result through verbatim', async () => {
    const { res, sent } = fakeRes();
    getFindPoll(
      fakeReq(),
      res,
      url('/find/gone'),
      deps((() => ({ status: 'expired' })) as unknown as Matchmaker['poll']),
    );
    expect(parsed(sent)).toEqual({ status: 'expired' });
  });

  it('matches a one-segment id and nothing deeper', async () => {
    expect(FIND_POLL_PATH.test('/find/q1')).toBe(true);
    expect(FIND_POLL_PATH.test('/find')).toBe(false);
    expect(FIND_POLL_PATH.test('/find/q1/extra')).toBe(false);
  });
});

describe('routes/party getParty', () => {
  it('percent-decodes the party id before the lookup', async () => {
    const get = vi.fn(() => undefined);
    const { res, sent } = fakeRes();
    getParty(fakeReq(), res, url('/party/p%2F1'), { parties: { get } as unknown as PartyService });
    expect(get).toHaveBeenCalledWith('p/1');
    expect(sent.status).toBe(404);
    expect(parsed(sent)).toEqual({ error: 'party not found' });
  });

  it('answers 200 with the party when one exists', async () => {
    const info = { partyId: 'p1', leaderId: 'ada', members: ['ada'], code: 'ABCDE', state: 'idle' };
    const { res, sent } = fakeRes();
    getParty(fakeReq(), res, url('/party/p1'), {
      parties: { get: () => info } as unknown as PartyService,
    });
    expect(sent.status).toBe(200);
    expect(parsed(sent)).toEqual(info);
  });

  it('would also match the POST party paths, which is why the shell checks those first', async () => {
    expect(PARTY_LOOKUP_PATH.test('/party/p1')).toBe(true);
    expect(PARTY_LOOKUP_PATH.test('/party/create')).toBe(true);
    expect(PARTY_LOOKUP_PATH.test('/party')).toBe(false);
  });
});

describe('routes/rating getRating', () => {
  it('percent-decodes the account id, including a guest seat scaffold', async () => {
    // `seat:{roomId}:{seatIdx}` (ladderReport.ts) is a real rating key for a guest/bot, and
    // its colons arrive percent-encoded from any conforming client.
    const get = vi.fn(() => Promise.resolve(1234));
    const { res, sent } = fakeRes();
    await getRating(fakeReq(), res, url('/rating/seat%3Ar1%3A0'), {
      ratings: { get } as unknown as RatingStore,
    });
    expect(get).toHaveBeenCalledWith('seat:r1:0');
    expect(parsed(sent)).toEqual({ accountId: 'seat:r1:0', rating: 1234 });
  });

  it('would also match /rating/report, which is why the shell checks that POST first', async () => {
    expect(RATING_LOOKUP_PATH.test('/rating/a1')).toBe(true);
    expect(RATING_LOOKUP_PATH.test('/rating/report')).toBe(true);
    expect(RATING_LOOKUP_PATH.test('/rating')).toBe(false);
  });
});

// --- routes/party.ts randomCode --------------------------------------------------------

describe('routes/party randomCode', () => {
  it('emits 5 characters from an alphabet with no 0/O/1/I, over many draws', async () => {
    // The alphabet's whole point is that a player reads this code out to a friend, so the
    // visually ambiguous glyphs are excluded. Nothing pinned that before.
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const code = randomCode();
      expect(code).toMatch(/^[A-Z2-9]{5}$/);
      for (const ch of code) seen.add(ch);
    }
    for (const banned of ['0', 'O', '1', 'I']) expect(seen.has(banned)).toBe(false);
    // 500 draws x 5 chars over a 32-glyph alphabet: a generator stuck on a subset (a
    // truncated alphabet, a mis-scaled index) shows up as a shortfall here.
    expect(seen.size).toBe(32);
  });
});
