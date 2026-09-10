/**
 * `trackFor` — the whole music decision — plus the module sink around it.
 *
 * The boss-room half runs against a REAL dungeon `GameState` built by the engine and the REAL
 * `EMBER_ROOMS` library, not a duck-typed literal. That is the part worth insisting on: the
 * decision walks `players[i].roomId` -> `dungeonRoomIndexById` -> `dungeonRooms[i].piece.role`,
 * three fields whose shapes a hand-written fake would be free to get wrong in exactly the way
 * that makes the test pass and the game silent. The placement of the boss room IS synthetic (it
 * is authored on the last floor, and descending four floors to reach it would be testing
 * `ExtractionSystem`), but the piece, the role and the lookup are the shipped ones.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  createGameState,
  EMBER_DUNGEON,
  EMBER_ROOMS,
  type GameState,
  type RoomPiece,
} from '@dd/engine';
import { invalidateMusicTrack, setMusicAudio, trackFor, updateMusicForFrame } from './musicDirector';
import { BIOME_ID_TO_TRACK, DEFAULT_RUN_TRACK } from '../audio/musicCatalogue';
import type { AudioBus, MusicTrack } from '../platform/types';
import type { Phase } from './phase';

const MENU_PHASES: Phase[] = [
  'menu',
  'forge',
  'pvpPreview',
  'matchmaking',
  'squad',
  'account',
  'store',
  'victory',
  'defeat',
];

/** The other side of the same partition — `musicDirector`'s own private `IN_RUN_PHASES`, which
 *  every test in the two blocks below exercises one member of. */
const IN_RUN_PHASES: Phase[] = ['playing', 'paused', 'settings'];

/**
 * Every value `Phase` admits, read out of `phase.ts` ITSELF.
 *
 * Deliberately not a third hand-written list: the point of the exhaustiveness test below is that
 * a list can drift from the type, and a second list drifts the same way. TypeScript cannot hand a
 * union's members to a runtime test and `Phase` has no runtime array anywhere in the client, so
 * the declaration is the only source of truth there is. Parsing it is cheap and the failure mode
 * is loud: a parse that found nothing makes the set equality below fail rather than pass.
 */
function declaredPhases(): string[] {
  const src = readFileSync(new URL('./phase.ts', import.meta.url), 'utf8');
  const start = src.indexOf('export type Phase =');
  const decl = src.slice(start, src.indexOf(';', start));
  return [...decl.matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]!);
}

/** A dungeon state with one placed room, whose piece is taken from the real library by role. */
function dungeonState(role: 'boss' | 'extraction' | 'normal', biomeId?: string): GameState {
  const piece: RoomPiece =
    role === 'normal'
      ? EMBER_ROOMS.find((p) => p.role === undefined)!
      : EMBER_ROOMS.find((p) => p.role === role)!;
  const s = createGameState({
    seed: 1,
    worldW: 800,
    worldH: 800,
    waves: [],
    dungeon: {
      config: biomeId === undefined ? EMBER_DUNGEON : { ...EMBER_DUNGEON, biomeId },
      library: EMBER_ROOMS,
    },
  });
  s.dungeonRooms.push({
    id: 'r1',
    piece,
    offsetXGrid: 0,
    offsetYGrid: 0,
    entranceGrid: { x: 1, y: 1 },
  });
  s.dungeonRoomIndexById.set('r1', 0);
  s.phase = 'playing';
  s.players[0]!.roomId = 'r1';
  return s;
}

describe('trackFor — the menu bed', () => {
  it('plays the menu bed on every screen phase, including both result screens', () => {
    // The result screens are deliberately in this group: a run ending IS a return to the shell,
    // and the change of bed is the audible part of it.
    for (const phase of MENU_PHASES) {
      expect(trackFor({ phase, state: null, localOwner: 0 }), phase).toBe('menu');
    }
  });

  it('accounts for EVERY phase the type admits, between the two lists', () => {
    // An exhaustiveness line, not a live bug: a new `Phase` falls into `trackFor`'s first branch
    // and takes the menu bed, which is the right default. What it is not is a DECISION — nobody
    // asked whether the new screen should be scored, and the answer arrives silently. This is the
    // gate that turns "the list above happens to be complete" into "the list above is checked",
    // and the reason it goes here rather than in `phase.ts`'s own tests is that music is the only
    // consumer that has to partition the whole set.
    const covered = [...MENU_PHASES, ...IN_RUN_PHASES].sort();
    expect(covered).toEqual([...declaredPhases()].sort());
    // ...and nothing above is vacuous: both lists really are exercised by the cases in this file.
    expect(MENU_PHASES.length).toBeGreaterThan(0);
  });

  it('plays the menu bed on a screen phase even while a run state is still around', () => {
    // `Game.activeState()` keeps returning the finished run's state after `gameover`, so
    // "there is a state" cannot be the test for "a run is live".
    const s = dungeonState('boss');
    s.phase = 'gameover';
    expect(trackFor({ phase: 'victory', state: s, localOwner: 0 })).toBe('menu');
    // ...and the same state on an in-run phase, which is what makes the pair meaningful.
    expect(trackFor({ phase: 'playing', state: s, localOwner: 0 })).toBe('menu');
  });

  it('plays the menu bed when a run phase has no state at all', () => {
    // The frame between `phase = "playing"` and the engine existing.
    expect(trackFor({ phase: 'playing', state: null, localOwner: 0 })).toBe('menu');
  });
});

describe('trackFor — the run bed', () => {
  it('plays the biome bed for a live run in an ordinary room', () => {
    expect(trackFor({ phase: 'playing', state: dungeonState('normal'), localOwner: 0 })).toBe(
      'dungeon.ember',
    );
  });

  it('keeps the run bed while paused', () => {
    // Switching to the menu bed on pause and back on resume is two crossfades for a moment the
    // player did not change rooms.
    expect(trackFor({ phase: 'paused', state: dungeonState('normal'), localOwner: 0 })).toBe(
      'dungeon.ember',
    );
  });

  it('routes every biome in the table to the track the table names', () => {
    // Table-driven rather than hard-coded, and worth being explicit about what it does and does
    // not currently prove. A mutation battery (2026-08-31) deleted the table lookup entirely and
    // NOTHING failed — because the one biome that exists, `ember`, maps to `dungeon.ember`, which
    // IS `DEFAULT_RUN_TRACK`. That mutant is genuinely equivalent today, not an untested gap: no
    // reachable run can tell the two code paths apart. It stops being equivalent the instant a
    // second biome loop ships, and the loop below is what will catch it then, so it is written
    // now rather than remembered later.
    for (const [biomeId, track] of Object.entries(BIOME_ID_TO_TRACK)) {
      expect(
        trackFor({ phase: 'playing', state: dungeonState('normal', biomeId), localOwner: 0 }),
        biomeId,
      ).toBe(track);
    }
    // The vacuity, stated as an assertion so it is visible in a diff when it ends.
    expect(
      Object.values(BIOME_ID_TO_TRACK).every((t) => t === DEFAULT_RUN_TRACK),
      'a biome now maps somewhere other than the fallback: the loop above is a real gate, ' +
        'and this line should be deleted',
    ).toBe(true);
  });

  it('falls back to the ember bed for a run whose biome names no track', () => {
    // An arena/PvP match, the tutorial, a flat `waves` config, or a biome authored before its
    // loop exists. design/11 asks the runtime to substitute rather than fall silent: a match with
    // no music reads as broken audio, where a bed that does not match the room reads as a bed
    // that does not match the room.
    expect(trackFor({ phase: 'playing', state: dungeonState('normal', 'glacier'), localOwner: 0 }))
      .toBe('dungeon.ember');
    const flat = createGameState({ seed: 1, worldW: 800, worldH: 800, waves: [] });
    flat.phase = 'playing';
    expect(trackFor({ phase: 'playing', state: flat, localOwner: 0 })).toBe('dungeon.ember');
  });
});

describe('trackFor — the boss room', () => {
  it('swaps to the boss bed when OUR seat stands in a boss-role room', () => {
    expect(trackFor({ phase: 'playing', state: dungeonState('boss'), localOwner: 0 })).toBe('boss');
  });

  it('does not swap for the extraction room, which is the other capstone role', () => {
    // The two are easy to conflate: design/05 says the deepest floor's extraction room IS its
    // boss room, so a role test that accepted either would fire on every floor's capstone.
    expect(trackFor({ phase: 'playing', state: dungeonState('extraction'), localOwner: 0 })).toBe(
      'dungeon.ember',
    );
  });

  it('reads OUR seat, not a teammate standing in the boss room', () => {
    const s = dungeonState('boss');
    s.players.push({ ...s.players[0]!, roomId: undefined });
    expect(trackFor({ phase: 'playing', state: s, localOwner: 1 })).toBe('dungeon.ember');
    expect(trackFor({ phase: 'playing', state: s, localOwner: 0 })).toBe('boss');
  });

  it('treats a player in a door passage as not in the boss room', () => {
    // `EnvironmentSystem` clears `roomId` while a player straddles a passage. Reading that as
    // "not the boss room" keeps the bed on the doorway frame; remembering the last known room
    // would hold boss music through the door OUT of it.
    const s = dungeonState('boss');
    s.players[0]!.roomId = undefined;
    expect(trackFor({ phase: 'playing', state: s, localOwner: 0 })).toBe('dungeon.ember');
  });

  it('survives a roomId the placed-room table does not know', () => {
    const s = dungeonState('boss');
    s.players[0]!.roomId = 'r_nonexistent';
    expect(() => trackFor({ phase: 'playing', state: s, localOwner: 0 })).not.toThrow();
    expect(trackFor({ phase: 'playing', state: s, localOwner: 0 })).toBe('dungeon.ember');
  });

  it('survives a localOwner with no seat', () => {
    const s = dungeonState('boss');
    expect(trackFor({ phase: 'playing', state: s, localOwner: 7 })).toBe('dungeon.ember');
  });
});

describe('trackFor — the settings screen, which is reachable from both sides', () => {
  it('plays the run bed for settings opened from the pause menu', () => {
    // Left out of the in-run set, nudging the music slider mid-run would crossfade to the menu
    // bed and back — two transitions, the second triggered by closing a screen.
    expect(trackFor({ phase: 'settings', state: dungeonState('normal'), localOwner: 0 })).toBe(
      'dungeon.ember',
    );
  });

  it('plays the boss bed for settings opened from a pause inside the boss room', () => {
    expect(trackFor({ phase: 'settings', state: dungeonState('boss'), localOwner: 0 })).toBe('boss');
  });

  it('plays the menu bed for settings opened from the main menu or the forge', () => {
    // The same phase value, and the pair is why the decision gates on `state.phase` rather than
    // on the render phase alone.
    expect(trackFor({ phase: 'settings', state: null, localOwner: 0 })).toBe('menu');
    const idle = dungeonState('normal');
    idle.phase = 'idle';
    expect(trackFor({ phase: 'settings', state: idle, localOwner: 0 })).toBe('menu');
  });
});

describe('the module sink', () => {
  const calls: { track: MusicTrack | null; dtMs: number }[] = [];
  let invalidations = 0;
  const bus = {
    preload: async () => {},
    play: () => {},
    setSfxVolume: () => {},
    setMusicVolume: () => {},
    updateMusic: (track: MusicTrack | null, dtMs: number) => {
      calls.push({ track, dtMs });
    },
    invalidateMusic: () => {
      invalidations++;
    },
    resume: () => {},
  } satisfies AudioBus;

  beforeEach(() => {
    calls.length = 0;
    invalidations = 0;
  });
  afterEach(() => {
    setMusicAudio(null);
  });

  it('is a silent no-op with nothing attached — the state every existing test runs in', () => {
    setMusicAudio(null);
    expect(() =>
      updateMusicForFrame({ phase: 'menu', state: null, localOwner: 0 }, 16),
    ).not.toThrow();
    expect(calls).toEqual([]);
  });

  it('passes the derived track and the frame time through to the bus', () => {
    setMusicAudio(bus);
    updateMusicForFrame({ phase: 'menu', state: null, localOwner: 0 }, 16);
    updateMusicForFrame({ phase: 'playing', state: dungeonState('boss'), localOwner: 0 }, 17);
    expect(calls).toEqual([
      { track: 'menu', dtMs: 16 },
      { track: 'boss', dtMs: 17 },
    ]);
  });

  it('contains a throwing bus and warns exactly once', () => {
    // This runs inside `GameLoop.update`, ahead of the sim step: a throw would cost the FRAME in
    // exchange for a sound. Once, not per frame, because a broken deck is broken 60 times a
    // second and a log line each time would bury whatever else the console was saying.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setMusicAudio({
      ...bus,
      updateMusic: () => {
        throw new Error('the media element is gone');
      },
    });
    for (let i = 0; i < 120; i++) {
      expect(() =>
        updateMusicForFrame({ phase: 'menu', state: null, localOwner: 0 }, 16),
      ).not.toThrow();
    }
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('forwards an invalidate to the bus, and does nothing without one', () => {
    // The one push a per-frame derivation still needs (design/12): the `music` subpackage lands
    // in the background, and until then the deck was handed a path that named no file.
    setMusicAudio(bus);
    invalidateMusicTrack();
    expect(invalidations).toBe(1);
    setMusicAudio(null);
    expect(() => invalidateMusicTrack()).not.toThrow();
    expect(invalidations).toBe(1);
  });

  it('contains a throwing invalidate rather than taking the caller down', () => {
    // The caller is a `.then()` on a subpackage download, so an escaping throw would become an
    // unhandled rejection during boot — on the platform with no reload button.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setMusicAudio({
      ...bus,
      invalidateMusic: () => {
        throw new Error('the deck is gone');
      },
    });
    expect(() => invalidateMusicTrack()).not.toThrow();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('re-arms the warning when a different bus is attached', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const broken = {
      ...bus,
      updateMusic: () => {
        throw new Error('broken');
      },
    };
    setMusicAudio(broken);
    updateMusicForFrame({ phase: 'menu', state: null, localOwner: 0 }, 16);
    setMusicAudio(broken);
    updateMusicForFrame({ phase: 'menu', state: null, localOwner: 0 }, 16);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
