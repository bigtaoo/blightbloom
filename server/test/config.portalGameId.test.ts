/**
 * `config.portalGameId()` (design/20 "account integration") — the CrazyGames game id
 * `/auth/portal` checks a user token's `gameId` claim against.
 *
 * Its own file, and with the same three rules `config.test.ts`'s header establishes for
 * `ticketSecret`: the warn flag is module state so each case that needs a fresh one does
 * `vi.resetModules()` + a dynamic re-import; the console spy goes on AFTER that import
 * (which evaluates a ~104-module graph through `@dd/game/match/pvpConfig`); and assertions
 * filter to warnings that actually mention this variable, so unrelated console traffic can
 * neither fail a "does not warn" case nor pad a count.
 */
import { describe, it, expect, vi, beforeAll, afterEach, type MockInstance } from 'vitest';

const ORIGINAL_ENV = process.env.BB_CG_GAME_ID;

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.BB_CG_GAME_ID;
  else process.env.BB_CG_GAME_ID = ORIGINAL_ENV;
  vi.restoreAllMocks();
});

beforeAll(async () => {
  // Pay the cold module-graph transform once, here, rather than billing it to whichever
  // `it` runs first — config.test.ts's own measured reason.
  await import('../src/config');
});

async function freshConfig(): Promise<{
  portalGameId: () => string | undefined;
  warnings: () => string[];
  spy: MockInstance;
}> {
  vi.resetModules();
  const mod = await import('../src/config');
  const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  return {
    portalGameId: mod.portalGameId,
    warnings: () => spy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('BB_CG_GAME_ID')),
    spy,
  };
}

describe('portalGameId', () => {
  it('returns the configured id and warns about nothing', async () => {
    process.env.BB_CG_GAME_ID = 'blightbloom-123';
    const { portalGameId, warnings } = await freshConfig();
    expect(portalGameId()).toBe('blightbloom-123');
    expect(warnings()).toEqual([]);
  });

  it('returns undefined and warns ONCE when unset', async () => {
    delete process.env.BB_CG_GAME_ID;
    const { portalGameId, warnings } = await freshConfig();
    expect(portalGameId()).toBeUndefined();
    expect(portalGameId()).toBeUndefined();
    expect(portalGameId()).toBeUndefined();
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain('ANY game');
  });

  it('treats an EMPTY value as unset rather than as a game id', async () => {
    // An id of `''` would match no token's claim, so every login would 401 — which looks
    // like a broken integration rather than a missing variable. Falling back to "unchecked
    // and warned" is the honest reading of an empty string.
    process.env.BB_CG_GAME_ID = '';
    const { portalGameId, warnings } = await freshConfig();
    expect(portalGameId()).toBeUndefined();
    expect(warnings()).toHaveLength(1);
  });

  it('reads the env per CALL, not once at module scope', async () => {
    // config.ts's own stated rule for every getter in it: a module-scope capture makes the
    // answer depend on whether the environment was loaded before the first import.
    delete process.env.BB_CG_GAME_ID;
    const { portalGameId } = await freshConfig();
    expect(portalGameId()).toBeUndefined();
    process.env.BB_CG_GAME_ID = 'set-later';
    expect(portalGameId()).toBe('set-later');
  });

  it('warns lazily — importing the module warns nothing', async () => {
    delete process.env.BB_CG_GAME_ID;
    vi.resetModules();
    const mod = await import('../src/config');
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(spy).not.toHaveBeenCalled();
    mod.portalGameId();
    expect(spy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('BB_CG_GAME_ID'))).toHaveLength(1);
  });
});
