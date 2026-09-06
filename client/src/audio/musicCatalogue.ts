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
 * and both shipped loops were MEASURED against it: the `music` gate's `xfade_band_diff`
 * compares the head and tail windows of exactly this width, and it is the reason the files
 * only had to be tonally compatible over 2 s rather than sample-continuous (`menu` measures
 * 1.76 dB, `boss` 1.60 dB, both post the 2026-09-06 tempo stretch — see `MUSIC_CATALOGUE`).
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
   * Explicit, non-optional and machine-readable on purpose. Two of the three launch loops have
   * masters (`art/audio/README.md`'s Music table); `dungeon.ember` does not, and "the runtime
   * should substitute an existing loop rather than fall silent" is design/11's own
   * instruction. A substitution recorded only in a comment is a substitution that ships
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
  // `Crystal Menu.mp3`, 68.0 s from 81.0 s of the STRETCHED master (native master position
  // ~56.7 s). 2026-09-06: tempo x0.7 is baked into this file by `process_music.py`'s
  // `TEMPO_FACTOR` (`pedalboard.time_stretch`, pitch preserved) — the region itself was
  // RE-PICKED that pass, because the 2026-08-31 region (69.0 s from 218.5 s, band-diff
  // 1.15 dB natively) measured 6.6 dB once stretched, far over the gate. This region measures
  // 1.76 dB post-stretch. Energy sits 160 Hz-1.2 kHz, so still no shelf.
  menu: { path: `${MUSIC_DIR}/menu.mp3`, lengthS: 68.0, gain: 1.0, borrowedFrom: null },

  // NO MASTER YET — this entry plays `menu.mp3`.
  //
  // WHY IT BORROWS `menu` AND NOT `boss`, which is the closer match in mood: if the dungeon
  // bed and the boss bed were the same file, walking into the boss room would produce no
  // audible change at all, and "the music never switches" is indistinguishable from "the music
  // feature is broken". A bed that is wrong for the room is a taste complaint; a transition
  // that cannot be heard is a bug report. So the placeholder is chosen to keep the MECHANISM
  // visible, deliberately at the cost of fit.
  //
  // Closing this is one file plus one line: drop the master in, re-cut it with
  // `process_music.py`, and change `path`/`lengthS`/`borrowedFrom` here. Nothing else in the
  // client knows this track is a stand-in.
  'dungeon.ember': {
    path: `${MUSIC_DIR}/menu.mp3`,
    lengthS: 68.0,
    gain: 1.0,
    borrowedFrom: 'menu',
  },

  // `Frozen Resonance.mp3`, 47.5 s from 147.5 s of the STRETCHED master (native master
  // position ~103.2 s), with a 4th-order zero-phase shelf at 80 Hz / -14 dB. Generated against
  // the MENU brief and measured as a sub-bass drone instead (90% of its energy below 109 Hz),
  // which is dread rather than a calm hub — so it became the boss bed. Same 2026-09-06
  // tempo x0.7 pass as `menu`, same reason the region was re-picked (the 2026-08-31 region
  // measured 2.2-2.9 dB once stretched, too close to the gate to keep); this region measures
  // 1.60 dB post-stretch.
  boss: { path: `${MUSIC_DIR}/boss.mp3`, lengthS: 47.5, gain: 1.0, borrowedFrom: null },
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
