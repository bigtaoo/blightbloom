// Which track should be playing, decided fresh every render frame (design/11 "Music &
// ambience", built 2026-08-31).
//
// WHY A PER-FRAME DERIVATION AND NOT AN EVENT SINK. Every other sound in the game is a
// RESPONSE — an engine event (`controllers/EventReactor.ts`) or a button press
// (`audio/uiSound.ts`). Music is not: it is a function of the SITUATION, and the situation is
// already fully described by state the render layer reads every frame anyway. Deriving it has
// three properties an event-driven version would each have to earn separately:
//
//   - **Nothing to hook, so no moment can be missed.** A new screen, a new run entry point, a
//     new way to reach the boss room: all of them change the situation, and the situation is
//     what is read. An event-driven director would need a call at each of those sites, which is
//     exactly the shape of the bug where a setting applies on change but not at boot
//     (`settingsBinding.ts`'s own header records that one).
//   - **Nothing fires twice.** Setting the track that is already playing is a no-op inside
//     `MusicPlayer`, so re-entering a room, a rollback-replayed tick (design/06) or a double
//     transition cannot restart a bed. There is no de-duplication to get wrong because there is
//     no trigger.
//   - **The autoplay gate crosses itself.** While the audio context is suspended the backend's
//     `updateMusic` has nothing it can do; the frame after the first gesture resumes it, the
//     same call starts the bed. No queue, no retry, no "did we already try".
//
// WHY A MODULE SINK rather than a constructor dependency: identical reasoning to
// `audio/uiSound.ts`, and one hard constraint. The per-frame caller is `GameLoop`, which would
// have to receive the bus from `Game.ts` — and `Game.ts` is this repo's one tracked 500-line
// offender, whose baseline the length gate pins at its current size, so a new dep in its
// `GameLoopDeps` literal fails `npm run check`. The placement is also better on its own terms:
// boot is where the audio device is created, so boot is where it is attached, next to
// `setUiAudio`. UNSET IS THE SAFE STATE — with no sink attached this is a no-op, which is what
// every existing `GameLoop` test runs against.
//
// DETERMINISM (design/06/11): reads `GameState` and `Phase`, writes neither. Music is
// explicitly not determinism-relevant, so it may read anything the render layer can see.
import type { GameState } from '@dd/engine';
import type { AudioBus, MusicTrack } from '../platform/types';
import { BIOME_ID_TO_TRACK, DEFAULT_RUN_TRACK } from '../audio/musicCatalogue';
import type { Phase } from './phase';

/** Everything the decision needs, and nothing else — narrow so a test can state a situation in
 *  one object literal instead of standing up a `Game`. */
export interface MusicSituation {
  /** The render-side screen phase (`phase.ts`). */
  phase: Phase;
  /** The live run's state, or null outside a run. */
  state: GameState | null;
  /** Which seat is ours — a co-op teammate standing in the boss room is not our situation. */
  localOwner: number;
}

/**
 * Render phases during which the RUN's bed plays rather than the menu bed.
 *
 * `settings` is in here, which looks wrong until you see the pair it forms with the
 * `state.phase` test below. The settings screen is reachable from the menu AND from the pause
 * menu mid-run (`Game.settingsReturnPhase`), and the phase value is the same either way. Left
 * out of this set, opening settings to nudge the music slider would crossfade to the menu bed
 * and back — two transitions, the second of which is triggered by closing a screen. Left in
 * unconditionally, settings from the main menu would play the dungeon bed. Gating on whether a
 * run is actually live separates the two with no extra plumbing, and `state.phase` is the
 * engine's own answer to "is a run live".
 */
const IN_RUN_PHASES: ReadonlySet<Phase> = new Set<Phase>(['playing', 'paused', 'settings']);

/**
 * The whole decision, as a pure function.
 *
 * Menu-side phases — `menu`, `forge`, `pvpPreview`, `matchmaking`, `squad`,
 * `account`, and both result screens — take the `menu` bed. The result screens are deliberately
 * in that group: a run ending IS a return to the shell, and the change of bed is the audible
 * part of it.
 */
export function trackFor(sit: MusicSituation): MusicTrack | null {
  if (!IN_RUN_PHASES.has(sit.phase)) return 'menu';
  const s = sit.state;
  // `activeState()` keeps returning the finished run's state after `gameover`, so the engine's
  // own phase is what says whether a run is live — not the presence of a state.
  if (!s || s.phase !== 'playing') return 'menu';
  if (inBossRoom(s, sit.localOwner)) return 'boss';
  return BIOME_ID_TO_TRACK[s.dungeonConfig?.biomeId ?? ''] ?? DEFAULT_RUN_TRACK;
}

/**
 * Is our seat standing in a room whose piece is authored as the boss room?
 *
 * design/11 asks for the swap on "entering the boss room", and this is that literally: the
 * ROOM, from `RoomPiece.role` (`engine/content/rooms.ts`), not "a live boss exists". The
 * difference is audible at both ends of the fight — the bed changes as the threshold is crossed
 * rather than when the first spawn lands, and it stays changed while the player picks up the
 * boss's death drops instead of snapping back to the dungeon bed over the corpse.
 *
 * `roomId` is `EnvironmentSystem`'s per-tick cache, and it is UNDEFINED while a player stands in
 * a door passage. That reads here as "not the boss room", which keeps the bed on the doorway
 * frame it takes to cross; the alternative (remembering the last known room) would hold boss
 * music through the door out of it.
 */
function inBossRoom(s: GameState, localOwner: number): boolean {
  const roomId = s.players[localOwner]?.roomId;
  if (roomId === undefined) return false;
  const idx = s.dungeonRoomIndexById.get(roomId);
  if (idx === undefined) return false;
  return s.dungeonRooms[idx]?.piece.role === 'boss';
}

let bus: AudioBus | null = null;
/** One warning per attached bus, not one per frame — a broken deck is broken 60 times a
 *  second, and a log line per frame would bury whatever else the console was saying. */
let warned = false;

/**
 * Point music at an audio device (both entries, at boot, beside `setUiAudio`). `null` detaches,
 * which is what a test does when it is done — module state outlives a single test in a file.
 */
export function setMusicAudio(next: AudioBus | null): void {
  bus = next;
  warned = false;
}

/**
 * Tell the attached bus its current answer was wrong (`AudioBus.invalidateMusic`).
 *
 * Called once per session, by `render/preloadArt.ts`, when the background `music` subpackage
 * lands — see design/12's "Music is loaded but never awaited" for why a per-frame derivation
 * still needs this one push. It decides nothing: the next frame re-derives the same track it
 * already wanted, and this time the file is there. Detached bus: a no-op, like every other
 * function in this module.
 */
export function invalidateMusicTrack(): void {
  try {
    bus?.invalidateMusic();
  } catch (err) {
    console.warn('[audio] music invalidate failed; the menu bed may stay silent:', err);
  }
}

/**
 * One render frame of music. Called unconditionally from `GameLoop.update`, in every phase.
 *
 * Failures are contained rather than allowed out: this runs inside the main loop, ahead of the
 * sim step, so a throw from a media element or an `InnerAudioContext` would cost the FRAME in
 * exchange for a sound. The realistic sources are all on design/11's unverified-on-device list.
 */
export function updateMusicForFrame(sit: MusicSituation, dtMs: number): void {
  if (!bus) return;
  try {
    bus.updateMusic(trackFor(sit), dtMs);
  } catch (err) {
    if (!warned) {
      warned = true;
      console.warn('[audio] music update failed; the game runs without a bed this session:', err);
    }
  }
}
