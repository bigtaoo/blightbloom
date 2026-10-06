// The music catalogue (design/11 "Music & ambience") — the data half of "what does a track
// sound like, and where does its file live". Same shape and same reasoning as
// `cueCatalogue.ts`: the union lives in `platform/types.ts`, the exhaustive `Record` lives
// here, so a track cannot reach the player without a music decision existing for it.
//
// WHAT IS DIFFERENT FROM A CUE, and it is most of the file:
//
//  - **A track is STREAMED, never decoded into a `SampleBank`.** A 69 s stereo loop decodes
//    to ~26 MB of `AudioBuffer` at 48 kHz. That single figure is why music runs on two
//    long-lived decks (an `Audio` element on web, an `InnerAudioContext` on WeChat) instead of
//    going through the path every cue shares.
//  - **Length is part of the decision, not a curiosity.** The loop is closed by the PLAYER,
//    not by the file: `el.loop = true` is unusable because MP3 frame padding denies
//    sample-exact wrapping, so `MusicPlayer` starts a second deck at `length - XFADE_S` and
//    equal-power crossfades into it. It therefore has to KNOW the length, and the number here
//    is checked against the shipped file's real audible duration by `musicAssets.test.ts` — a
//    length that drifts from the file would put the wrap in the wrong place, which is audible
//    as a stumble rather than as an error.
//  - **A track may be a PLACEHOLDER**, and that is a field rather than a comment. See
//    `borrowedFrom`.
//
// Every loop is openly licensed music (CC0/CC-BY) since 2026-10-06; who wrote each one, and
// the credit line the game shows, is `musicCredits.ts`.
//
// The level decision is NOT here. It lives in the asset: every shipped loop is normalised so
// its 250-2000 Hz RMS lands at -30 dBFS (`tools/audio-pipeline/process_music.py`'s
// `MID_TARGET_DBFS`, gated by `audit.py --class music`), which leaves every cue's peak 9-16 dB
// above the bed in the band they share. `gain` below is a mix knob on top of that and every
// shipped value is 1.0 — the same discipline `CueDef.gain` records, for the same reason: two
// places to set a level is one place too many for anyone to find the level later.
import type { MusicTrack } from '../platform/types';

/** Where the shipped loops live, public-relative. On WeChat this prefix is what routes them
 *  into the `music` subpackage (`render/assetPacks.json`) — a prefix rule, no loader change,
 *  exactly as design/11 predicted when `AssetHost.readBinary` was added. */
export const MUSIC_DIR = '/audio/music';

/**
 * Crossfade length, seconds. **This number is shared with the asset pipeline and must not be
 * changed on one side alone.** `tools/audio-pipeline/audit.py`'s `XFADE_S` is the same 2.0,
 * and every shipped loop was MEASURED against it: the `music` gate's `xfade_band_diff`
 * compares the head and tail windows of exactly this width, and it is the reason the files
 * only had to be tonally compatible over 2 s rather than sample-continuous (0.83-1.54 dB
 * across the five — see `MUSIC_CATALOGUE`).
 * Widening it here would judge the loops on a window nobody measured; narrowing it would leave
 * measured seam quality on the table.
 */
export const XFADE_S = 2.0;

export interface TrackDef {
  /** Public-relative path of the file that actually plays for this track. */
  path: string;
  /**
   * Audible length of that file, seconds. Where `MusicPlayer` starts the next deck
   * (`length - XFADE_S`), so it is load-bearing rather than descriptive.
   */
  lengthS: number;
  /**
   * Linear gain for this track, under the music bus volume (design/10 settings) and on top of
   * the level the asset already carries. 1.0 = "as mastered, at the -30 dBFS band target".
   * Every shipped value is 1.0; see this file's header for why a second level knob is
   * deliberately left unused rather than removed (a placeholder standing in for a missing
   * master is the one case where trimming a track without re-cutting it is legitimate).
   */
  gain: number;
  /**
   * `null` when this track has its own master. Otherwise the track whose FILE it is borrowing,
   * because its own does not exist yet.
   *
   * Explicit, non-optional and machine-readable on purpose. No shipped track borrows today
   * (`dungeon.ember` did until 2026-10-06, playing `menu.mp3`); the field stays because the
   * next track added before its file exists needs it, and "the runtime should substitute an
   * existing loop rather than fall silent" is design/11's own instruction. A substitution recorded only in a comment is a substitution that ships
   * forever: `musicAssets.test.ts` asserts exactly which tracks are standing in, so
   * replacing this entry with a real master is a visible, one-line change rather than an
   * archaeology exercise.
   */
  borrowedFrom: MusicTrack | null;
}

/**
 * Every track the game can ask for, with its music decision.
 *
 * Exhaustive `Record` on purpose — adding a member to `MusicTrack` is a compile error until it
 * has an entry here, which is the guarantee `cueCatalogue.ts` already provides for cues.
 */
export const MUSIC_CATALOGUE: Record<MusicTrack, TrackDef> = {
  // "Aurora" (Scott Buckley, CC-BY 4.0): 85.0 s from 86.0 s of the 8:19 track, the slow build
  // well before its climax. The bed a player hears longest (menus, the Forge, result screens),
  // so it is the longest loop the gate's 90 s ceiling allows; seam 0.83 dB. No shelf.
  menu: { path: `${MUSIC_DIR}/menu.mp3`, lengthS: 85.0, gain: 1.0, borrowedFrom: null },

  // "Lava Area Theme" (Wolfgang_, CC-BY 4.0): 60.0 s from 12.5 s, with a 4th-order zero-phase
  // shelf at 80 Hz / -10 dB; seam 1.54 dB. Chapter 1's own bed since 2026-10-06 — before that
  // this entry borrowed `menu.mp3` (and deliberately not `boss.mp3`, so the boss-room switch
  // stayed audible).
  'dungeon.ember': {
    path: `${MUSIC_DIR}/dungeon-ember.mp3`,
    lengthS: 60.0,
    gain: 1.0,
    borrowedFrom: null,
  },

  // "Beyond the Frozen Veil" (Synth-thetic, CC0): 71.5 s from 34.5 s of the composer's loop
  // version; seam 1.40 dB. No shelf. Chapter 2 shared chapter 1's bed until 2026-10-06.
  'dungeon.frost': {
    path: `${MUSIC_DIR}/dungeon-frost.mp3`,
    lengthS: 71.5,
    gain: 1.0,
    borrowedFrom: null,
  },

  // "Endless Cyber Runner" (Eric Matyas, CC-BY 4.0): 50.0 s from 27.5 s of the composer's
  // looping version, with the 80 Hz / -10 dB shelf; seam 1.20 dB. Chapter 3's bed (the storm
  // biome). 120 bpm, so the 50.0 s length keeps both decks' beats aligned through the fade.
  'dungeon.storm': {
    path: `${MUSIC_DIR}/dungeon-storm.mp3`,
    lengthS: 50.0,
    gain: 1.0,
    borrowedFrom: null,
  },

  // "Colossal Boss Battle Theme" (Matthew Pablo, CC-BY 3.0), the no-vocals loop: 58.5 s from
  // 49.5 s, with the same 80 Hz / -10 dB shelf; seam 1.31 dB. Both chapters' boss rooms.
  boss: { path: `${MUSIC_DIR}/boss.mp3`, lengthS: 58.5, gain: 1.0, borrowedFrom: null },
};

/** Every track, at runtime. Derived from the catalogue, so it cannot drift from the union the
 *  way a hand-written list can (the `Record` is what the compiler holds exhaustive). */
export const ALL_TRACKS: readonly MusicTrack[] = Object.keys(MUSIC_CATALOGUE) as MusicTrack[];

/** The tracks currently playing somebody else's file — i.e. what still needs authoring.
 *  Derived, so it cannot disagree with the catalogue. */
export const PLACEHOLDER_TRACKS: readonly MusicTrack[] = ALL_TRACKS.filter(
  (t) => MUSIC_CATALOGUE[t].borrowedFrom !== null,
);

/** The distinct files the catalogue actually names, in track order. Shorter than `ALL_TRACKS`
 *  while any track is borrowing — which is precisely the set that has to exist on disk. */
export function musicPaths(): readonly string[] {
  return [...new Set(ALL_TRACKS.map((t) => MUSIC_CATALOGUE[t].path))];
}

/**
 * Which track a dungeon's `biomeId` asks for (`GameState.dungeonConfig?.biomeId`).
 *
 * Parallel to `game/theme.ts`'s `BIOME_ID_TO_ELEMENT` and kept separate from it on purpose:
 * that table maps a biome to a COLOUR vocabulary shared by four elements, while a track is one
 * authored file per biome. A new biome needs a new entry in both, and until it has one here it
 * falls to `DEFAULT_RUN_TRACK` rather than going silent.
 */
export const BIOME_ID_TO_TRACK: Record<string, MusicTrack> = {
  ember: 'dungeon.ember',
  frost: 'dungeon.frost',
  storm: 'dungeon.storm',
};

/**
 * The bed for a run whose biome names no track — an arena/PvP match, the tutorial, a flat
 * `waves` config, or a biome authored before its loop exists.
 *
 * Playing the ember bed there is knowingly wrong and knowingly better than silence: design/11
 * asks the runtime to "substitute an existing loop rather than fall silent", and a PvP match
 * with no music at all reads as broken audio, where a bed that does not match the room reads
 * as a bed that does not match the room.
 */
export const DEFAULT_RUN_TRACK: MusicTrack = 'dungeon.ember';
