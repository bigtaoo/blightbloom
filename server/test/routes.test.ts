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
import type { Logger } from '../src/log';
import { CORS, readJson, send } from '../src/routes/http';
import { getMe, postLogout, requireAuth } from '../src/routes/auth';
import { FIND_POLL_PATH, getFindPoll } from '../src/routes/match';
import { PARTY_LOOKUP_PATH, getParty, postCreate, randomCode } from '../src/routes/party';
import { ROOM_CODE_PATTERN } from '../src/config';
import { CodeSpaceExhausted } from '../src/PartyService';
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

/** The party group's `log`, which only `/party/create`'s unexpected-failure arm ever calls
 *  — so a `getParty` test supplies one that does nothing rather than a recorder. */
function silentLog(): Logger {
  const noop = () => {};
  return { error: noop, warn: noop, info: noop, debug: noop } as unknown as Logger;
}

describe('routes/party getParty', () => {
  it('percent-decodes the party id before the lookup', async () => {
    const get = vi.fn(() => undefined);
    const { res, sent } = fakeRes();
    getParty(fakeReq(), res, url('/party/p%2F1'), { parties: { get } as unknown as PartyService, log: silentLog() });
    expect(get).toHaveBeenCalledWith('p/1');
    expect(sent.status).toBe(404);
    expect(parsed(sent)).toEqual({ error: 'party not found' });
  });

  it('answers 200 with the party when one exists', async () => {
    const info = { partyId: 'p1', leaderId: 'ada', members: ['ada'], code: 'ABCDE', state: 'idle' };
    const { res, sent } = fakeRes();
    getParty(fakeReq(), res, url('/party/p1'), {
      parties: { get: () => info } as unknown as PartyService,
      log: silentLog(),
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

describe('routes/party postCreate', () => {
  /** POST an already-JSON body through a handler that reads it with `readJson`. */
  function drive(handler: () => void, req: EventEmitter, body: unknown): Promise<void> {
    handler();
    req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
    // `readJson` resolves through a promise, so the response lands a microtask later.
    return Promise.resolve().then(() => {});
  }

  it('answers 503, not a hang, when the code space is exhausted', async () => {
    // The failure this pins is the one the bound exists for, and it is silent: `readJson`
    // invokes its callback from inside a `.then()`, so a throw escaping the handler becomes
    // an unhandled rejection and the request is answered with NOTHING — a client left
    // waiting on its own timeout, with `matchsvc.ts`'s error boundary never seeing it
    // (`routes/http.ts` says so in its own header). 503 rather than 400 or 500 because the
    // caller sent nothing wrong and a retry very likely succeeds.
    const req = fakeReq();
    const { res, sent } = fakeRes();
    const parties = {
      create: () => {
        throw new CodeSpaceExhausted(100);
      },
    } as unknown as PartyService;
    await drive(() => postCreate(req, res, url('/party/create'), { parties, log: silentLog() }), req, { playerId: 'p1' });
    expect(sent.status).toBe(503);
    expect(parsed(sent)).toEqual({ error: 'no room code available' });
  });

  it('answers 500 and logs it for any OTHER failure, rather than answering nothing', async () => {
    // Same escape hatch, different verdict: an unexpected throw is a bug, not a condition,
    // so it gets a 500 and a line in the log store instead of vanishing into an unhandled
    // rejection. Asserted on the log too — a 500 nobody can find the cause of is barely
    // better than the hang.
    const lines: { msg: string; fields?: Record<string, unknown> }[] = [];
    const log = {
      error: (msg: string, fields?: Record<string, unknown>) => lines.push({ msg, fields }),
      warn: () => {},
      info: () => {},
      debug: () => {},
    } as unknown as Logger;
    const req = fakeReq();
    const { res, sent } = fakeRes();
    const parties = {
      create: () => {
        throw new Error('mongo went away');
      },
    } as unknown as PartyService;
    await drive(() => postCreate(req, res, url('/party/create'), { parties, log }), req, { playerId: 'p1' });
    expect(sent.status).toBe(500);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.fields).toEqual({ error: 'mongo went away' });
  });

  it('400s a missing playerId before it ever reaches the service', async () => {
    const create = vi.fn();
    const req = fakeReq();
    const { res, sent } = fakeRes();
    await drive(
      () => postCreate(req, res, url('/party/create'), { parties: { create } as unknown as PartyService, log: silentLog() }),
      req,
      {},
    );
    expect(sent.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('routes/party randomCode', () => {
  it('emits exactly 6 decimal digits, over many draws', () => {
    // Six digits since 2026-09-21 (it was 5 characters of a no-0/O/1/I alphabet). Asserted
    // over many draws rather than one because the ways this breaks are statistical: a
    // generator that occasionally emits five characters, or that can produce a non-digit,
    // is invisible in a single sample.
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const code = randomCode();
      expect(code).toMatch(/^[0-9]{6}$/);
      expect(code).toHaveLength(6);
      for (const ch of code) seen.add(ch);
    }
    // All ten digits, 0 included: a 1-based or leading-zero-shy generator (a `% 9`, a
    // `randomInt(1, 10)`) shows up here as a shortfall, and `004271` is a code this service
    // has to be able to mint.
    expect([...seen].sort().join('')).toBe('0123456789');
  });

  it('draws digits near-uniformly, not the biased shape a scaled Math.random gives', () => {
    // `Math.floor(Math.random() * n)` was uniform for the old 32-glyph alphabet only because
    // 32 is a power of two; it is not for 10, and the `%` spelling of the same idea is
    // measurably biased — which is why the generator uses `crypto.randomInt`. A chi-square
    // would be the rigorous test; this generous band is enough to catch the real failures (a
    // digit that never appears, or one appearing half again as often as the rest).
    const counts = new Map<string, number>();
    const draws = 5000; // x6 digits = 30000 samples, ~3000 expected per digit
    for (let i = 0; i < draws; i++) for (const ch of randomCode()) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    const expected = (draws * 6) / 10;
    for (let d = 0; d <= 9; d++) {
      const n = counts.get(String(d)) ?? 0;
      expect(n).toBeGreaterThan(expected * 0.85);
      expect(n).toBeLessThan(expected * 1.15);
    }
  });

  it('randomCode mints codes the SHARED pattern accepts, plus the near-misses a stale client sends', () => {
    // Two claims, and only the first belongs to this file now that the shape moved to
    // `@dd/game/match/roomCode`: that the server's own GENERATOR satisfies the shared
    // pattern. `client/src/game/match/roomCode.test.ts` is the shape's authority and owns
    // the exhaustive near-miss list, including the Unicode-digit scripts that a `[\p{Nd}]`
    // pattern would wrongly accept.
    //
    // What is kept here is the server-side concern: what a STALE CLIENT sends — five
    // characters of the old no-0/O/1/I alphabet, a truncated or padded code. Anchoring is
    // still worth restating, since an unanchored `[0-9]{6}` matches `abc123456xyz` and would
    // hand an arbitrary string to the lookup map.
    for (let i = 0; i < 200; i++) expect(ROOM_CODE_PATTERN.test(randomCode())).toBe(true);
    expect(ROOM_CODE_PATTERN.test('004271')).toBe(true);
    const nearMisses = ['', '12345', '1234567', 'ABCDE', 'A12345', '12345A', ' 123456', '123456 ', '12 456', 'x123456y', '1e5000', '12.456'];
    for (const bad of nearMisses) expect(ROOM_CODE_PATTERN.test(bad)).toBe(false);
  });
});
