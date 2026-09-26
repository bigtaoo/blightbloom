/**
 * The gameserver's integrity-report call site (`reportIntegrity`, `onMatchSettled` in
 * `src/index.ts`; design/15, "PvP integrity", decided 2026-09-26). What the body contains is
 * pinned in `integrityReport.test.ts`; this pins WHEN the call is made, where it goes, what it
 * carries on the wire, and that it runs beside the ladder report rather than instead of it.
 *
 * `BB_MATCHSVC_URL` is read at module scope, so every case re-imports the module under a
 * stubbed env — the same shape `index.lifecycle.test.ts` uses for `reportSettledMatch`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SettledMatch } from '../src/MatchRoom';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.restoreAllMocks();
});

const noSleep = () => Promise.resolve();

const settled = (over: Partial<SettledMatch> = {}): SettledMatch => ({
  roomId: 'room-9',
  mode: 'pvp',
  winner: 0,
  placements: [3, 2, 1],
  playerCount: 4,
  hashOk: true,
  integrity: { verdict: 'dissent', dissenters: [2], kicked: [], absent: [], settleFrame: 900, seed: 7, log: [] },
  seatAccounts: { 2: 'acct-two' },
  ...over,
});

async function withMatchsvc(url: string | undefined, status = 200) {
  vi.stubEnv('BB_MATCHSVC_URL', url ?? '');
  const calls: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
  const fetchMock = vi.fn((u: string, init: { body: string; headers: Record<string, string> }) => {
    calls.push({ url: u, body: JSON.parse(init.body) as Record<string, unknown>, headers: init.headers });
    return Promise.resolve(new Response('{"recorded":true}', { status }));
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.resetModules();
  const mod = await import('../src/index');
  return { mod, calls, fetchMock };
}

describe('reportIntegrity', () => {
  it('POSTs a dissenting PvP match to matchsvc, with the internal key', async () => {
    const { mod, calls } = await withMatchsvc('http://matchsvc.test');
    mod.reportIntegrity(settled(), { sleep: noSleep });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://matchsvc.test/integrity/report');
    expect(calls[0]!.headers['x-internal-caller']).toBe('gameserver');
    expect(calls[0]!.headers['x-internal-key']).toBeTruthy();
    expect(calls[0]!.body).toMatchObject({
      roomId: 'room-9',
      verdict: 'dissent',
      suspects: [{ seat: 2, accountId: 'acct-two', dissented: true, kicked: false }],
    });
  });

  it.each([
    ['no matchsvc configured', undefined, settled()],
    ['a clean match', 'http://matchsvc.test', settled({ integrity: { verdict: 'clean', dissenters: [], kicked: [], absent: [], settleFrame: 900, seed: 7 } })],
    ['a co-op room', 'http://matchsvc.test', settled({ mode: 'coop' })],
  ])('skips: %s', async (_label, url, match) => {
    const { mod, fetchMock } = await withMatchsvc(url);
    mod.reportIntegrity(match, { sleep: noSleep });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('warns, naming the room and the verdict, when every attempt fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { mod } = await withMatchsvc('http://matchsvc.test', 503);
    mod.reportIntegrity(settled({ integrity: { verdict: 'bounds', bounds: 'too_short', dissenters: [], kicked: [], absent: [], settleFrame: 3, seed: 7, log: [] } }), { sleep: noSleep });
    await vi.waitFor(() => {
      const lines = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('integrity report'));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('room-9');
      expect(lines[0]).toContain('(bounds)');
      expect(lines[0]).toContain('503');
    });
  });

  it('warns with the transport error when the request itself rejects', async () => {
    vi.stubEnv('BB_MATCHSVC_URL', 'http://matchsvc.test');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('matchsvc is down'))));
    vi.resetModules();
    const mod = await import('../src/index');
    mod.reportIntegrity(settled(), { sleep: noSleep });
    await vi.waitFor(() => {
      const lines = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('integrity report'));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('matchsvc is down');
    });
  });
});

describe('onMatchSettled — both reports, independently', () => {
  it('a dissenting match that still settled is rated AND recorded', async () => {
    const { mod, calls } = await withMatchsvc('http://matchsvc.test');
    mod.onMatchSettled(settled(), { sleep: noSleep });
    expect(calls.map((c) => c.url).sort()).toEqual([
      'http://matchsvc.test/integrity/report',
      'http://matchsvc.test/rating/report',
    ]);
  });

  it('a match with no consensus is recorded and NOT rated', async () => {
    const { mod, calls } = await withMatchsvc('http://matchsvc.test');
    mod.onMatchSettled(
      settled({ hashOk: false, integrity: { verdict: 'no_consensus', dissenters: [], kicked: [], absent: [], settleFrame: 900, seed: 7, log: [] } }),
      { sleep: noSleep },
    );
    expect(calls.map((c) => c.url)).toEqual(['http://matchsvc.test/integrity/report']);
  });

  it('a clean match is rated and NOT recorded', async () => {
    const { mod, calls } = await withMatchsvc('http://matchsvc.test');
    mod.onMatchSettled(settled({ integrity: { verdict: 'clean', dissenters: [], kicked: [], absent: [], settleFrame: 900, seed: 7 } }), { sleep: noSleep });
    expect(calls.map((c) => c.url)).toEqual(['http://matchsvc.test/rating/report']);
  });
});
