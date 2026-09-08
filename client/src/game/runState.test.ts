/**
 * `RunState` — the rules that used to need a WebGL renderer to reach.
 *
 * Every case here was previously only exercisable by constructing `Game`, which needs a real
 * `Application`. That is the whole point of the 2026-09-03 split: these are decisions about a
 * run, not about drawing one, and each of them fails SILENTLY when it breaks — a stale
 * `online` flag renders the next offline run off a closed session, a `meta` write that skips
 * the store loses a banked material on reload, a query-param `null` that overwrites a default
 * sends every request to the literal string "null".
 */
import { describe, expect, it, vi } from 'vitest';
import { defaultMetaState, type MetaState, type MetaStore } from '../meta';
import type { GameQueryParams } from './match/gameQueryParams';
import { DEFAULT_MATCH_BASE_URL, RunState, SEED_BASE, resolveMatchBaseUrl } from './runState';

/** An in-memory MetaStore that records every save. */
function fakeStore(initial: MetaState = defaultMetaState()) {
  const saves: MetaState[] = [];
  let held = initial;
  const store: MetaStore = {
    load: () => held,
    save: (m) => {
      held = m;
      saves.push(m);
    },
  };
  return { store, saves, held: () => held };
}

const noParams = (over: Partial<GameQueryParams> = {}): GameQueryParams => ({
  skinOverride: null,
  coop: false,
  online: false,
  arenaDemo: null,
  pvp: false,
  pvpSeats: null,
  matchBaseUrl: null,
  lagMs: null,
  loadoutOverride: null,
  perf: false,
  pickupDebug: false,
  replayUrl: null,
  ...over,
});

describe('defaults', () => {
  it('starts on the menu, offline, with no run in hand', () => {
    const s = new RunState(fakeStore().store);
    expect(s.phase).toBe('menu');
    expect(s.online).toBe(false);
    expect(s.engine).toBeNull();
    expect(s.session).toBeNull();
    expect(s.activeState()).toBeNull();
    expect(s.matchBaseUrl).toBe(DEFAULT_MATCH_BASE_URL);
  });

  it('derives a run seed from the run index, with no clock read', () => {
    // Determinism: the same run index must produce the same seed on every machine and every
    // launch, which is what makes a recorded replay reproducible at all.
    const s = new RunState(fakeStore().store);
    expect(s.nextRunSeed()).toBe(SEED_BASE);
    s.runCount = 3;
    expect(s.nextRunSeed()).toBe(SEED_BASE + 3);
  });
});

describe('meta', () => {
  it('loads from the store', () => {
    const held = { ...defaultMetaState(), selectedSkin: 'someone-else' };
    const s = new RunState(fakeStore(held).store);
    s.loadMeta();
    expect(s.meta.selectedSkin).toBe('someone-else');
  });

  it('SAVES on every write — the reason setMeta exists rather than a bare assignment', () => {
    // The failure this closes is invisible in-session: an in-memory-only update looks
    // completely correct until the page reloads and the change is gone.
    const f = fakeStore();
    const s = new RunState(f.store);
    s.setMeta({ ...s.meta, hasSeenTutorial: true });
    expect(f.saves).toHaveLength(1);
    expect(f.held().hasSeenTutorial).toBe(true);
    expect(s.meta.hasSeenTutorial).toBe(true);
  });
});

describe('markTutorialSeen', () => {
  it('sets the flag and persists it', () => {
    const f = fakeStore();
    const s = new RunState(f.store);
    s.markTutorialSeen();
    expect(s.meta.hasSeenTutorial).toBe(true);
    expect(f.saves).toHaveLength(1);
  });

  it('is IDEMPOTENT — a second call writes nothing', () => {
    // Called from two places (tutorial completion in the loop, and Skip in quitRun), so a
    // non-idempotent version would write on every gameover tick of a tutorial run.
    const f = fakeStore();
    const s = new RunState(f.store);
    s.markTutorialSeen();
    s.markTutorialSeen();
    s.markTutorialSeen();
    expect(f.saves).toHaveLength(1);
  });
});

describe('activeState', () => {
  it('reads the SESSION online and the ENGINE offline', () => {
    // Everything render-side goes through this one accessor so both paths behave
    // identically; reading the wrong one draws a frame from a run that is not being played.
    const s = new RunState(fakeStore().store);
    const engineState = { tick: 1 } as never;
    const sessionState = { tick: 2 } as never;
    s.engine = { state: engineState } as never;
    s.session = { state: sessionState } as never;

    expect(s.activeState()).toBe(engineState);
    s.online = true;
    expect(s.activeState()).toBe(sessionState);
  });

  it('is null online while still connecting, rather than falling back to the engine', () => {
    // The window between "queued" and match_start. Falling back to a stale offline engine
    // here would render the PREVIOUS run under a "Finding a match…" screen.
    const s = new RunState(fakeStore().store);
    s.engine = { state: { tick: 9 } } as never;
    s.online = true;
    s.session = null;
    expect(s.activeState()).toBeNull();
  });
});

describe('endRun', () => {
  it('closes the SESSION and clears it when the run was online', () => {
    const s = new RunState(fakeStore().store);
    const close = vi.fn();
    s.online = true;
    s.session = { close } as never;
    s.engine = { state: {} } as never;

    s.endRun();
    expect(close).toHaveBeenCalledTimes(1);
    expect(s.session).toBeNull();
  });

  it('drops the ENGINE when the run was offline, and never touches a session', () => {
    const s = new RunState(fakeStore().store);
    const close = vi.fn();
    s.session = { close } as never;
    s.engine = { state: {} } as never;

    s.endRun();
    expect(s.engine).toBeNull();
    expect(close).not.toHaveBeenCalled();
  });

  it('CLEARS the online flag — the bug the old quitRun had', () => {
    // Recorded in `endRun`'s own doc comment: quitRun never reset this, so a later offline
    // run inherited it. `activeState()` and the sim step both key off `online`, so the next
    // run rendered from a session that had already been closed — with nothing logged.
    const s = new RunState(fakeStore().store);
    s.online = true;
    s.session = { close: () => {} } as never;
    s.endRun();
    expect(s.online).toBe(false);
  });

  it('reports whether the abandoned run was the tutorial, and clears the flag', () => {
    // The caller routes somewhere different for each (ModeSelect vs. Forge), so the answer
    // has to survive the clear — hence a return value rather than a second read.
    const s = new RunState(fakeStore().store);
    s.tutorialActive = true;
    expect(s.endRun()).toEqual({ wasTutorial: true });
    expect(s.tutorialActive).toBe(false);
    expect(s.endRun()).toEqual({ wasTutorial: false });
  });
});

describe('applyQueryParams', () => {
  it('applies the boolean flags straight through', () => {
    const s = new RunState(fakeStore().store);
    s.applyQueryParams(noParams({ coop: true, online: true, pvp: true, arenaDemo: 'landing_basic' }));
    expect(s.coop).toBe(true);
    expect(s.online).toBe(true);
    expect(s.pvp).toBe(true);
    expect(s.arenaDemo).toBe('landing_basic');
  });

  it('leaves the DEFAULTS standing for the three params that mean "absent" with null', () => {
    // The failure mode this pins: assigning `null` to matchBaseUrl sends every request to
    // the string "null/find", which fails as a network error with no clue why. Same shape
    // for pvpSeats (a room of `null` seats) and lagMs.
    const s = new RunState(fakeStore().store);
    s.applyQueryParams(noParams());
    expect(s.matchBaseUrl).toBe(DEFAULT_MATCH_BASE_URL);
    expect(s.pvpSeats).toBe(2);
    expect(s.lagMs).toBe(0);
  });

  it('applies those three when they ARE present, including a zero', () => {
    // The control for the case above, and the reason the guard is `!== null` rather than a
    // truthiness check: `?lag=0` is a real, meaningful override.
    const s = new RunState(fakeStore().store);
    s.applyQueryParams(noParams({ matchBaseUrl: 'http://elsewhere:9', pvpSeats: 8, lagMs: 0 }));
    expect(s.matchBaseUrl).toBe('http://elsewhere:9');
    expect(s.pvpSeats).toBe(8);
    expect(s.lagMs).toBe(0);
  });

  it('takes a loadout override, and ignores an absent one', () => {
    const s = new RunState(fakeStore().store);
    const before = s.meta.loadout;
    s.applyQueryParams(noParams());
    expect(s.meta.loadout).toBe(before);
    s.applyQueryParams(noParams({ loadoutOverride: ['a', 'b'] }));
    expect(s.meta.loadout).toEqual(['a', 'b']);
  });

  it('routes a skin override through selectCharacter rather than assigning it', () => {
    // `selectCharacter` is what enforces "only a character the account owns"; assigning
    // `meta.selectedSkin` directly would let `?skin=` hand a player anything.
    const s = new RunState(fakeStore().store);
    const before = s.meta.selectedSkin;
    s.applyQueryParams(noParams({ skinOverride: 'definitely-not-owned' }));
    expect(s.meta.selectedSkin).toBe(before);
  });

  it('does NOT persist anything it applies — a dev flag must not rewrite saved state', () => {
    // `applyQueryParams` assigns `meta` directly rather than going through `setMeta`, and
    // that asymmetry is deliberate: booting once with `?skin=` or `?wpn=` must not leave the
    // player's real saved loadout replaced.
    const f = fakeStore();
    const s = new RunState(f.store);
    s.applyQueryParams(noParams({ loadoutOverride: ['x'], skinOverride: 'whatever' }));
    expect(f.saves).toEqual([]);
  });
});

describe('resolveMatchBaseUrl', () => {
  // An ENTRY POINT needs the backend origin before a `RunState` exists: a portal build logs
  // the player in before the first screen is drawn (design/20). Exported so that answer is
  // computed by the same precedence `applyQueryParams` applies, rather than by a second copy
  // of the rule in `main.crazygames.ts`.

  it('prefers ?mm= when it is present', () => {
    expect(resolveMatchBaseUrl({ matchBaseUrl: 'https://staging.example' })).toBe('https://staging.example');
  });

  it('falls back to the build-time default when it is absent', () => {
    // Under vitest `VITE_MATCHSVC_URL` is unset, so this is `DEFAULT_MATCH_BASE_URL` — the
    // same value a fresh `RunState` starts with, which is the property worth pinning.
    expect(resolveMatchBaseUrl({ matchBaseUrl: null })).toBe(DEFAULT_MATCH_BASE_URL);
    expect(resolveMatchBaseUrl({ matchBaseUrl: null })).toBe(new RunState(fakeStore().store).matchBaseUrl);
  });

  it('agrees with what applyQueryParams would have produced', () => {
    // The two paths must not drift: the entry point's answer and the run state's answer are
    // the same origin, or a portal player logs in against one backend and plays on another.
    for (const matchBaseUrl of [null, 'https://a.example', 'http://localhost:9999']) {
      const s = new RunState(fakeStore().store);
      s.applyQueryParams(noParams({ matchBaseUrl }));
      expect(resolveMatchBaseUrl({ matchBaseUrl })).toBe(s.matchBaseUrl);
    }
  });
});
