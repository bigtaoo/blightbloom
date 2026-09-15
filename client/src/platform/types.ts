// Platform isolation layer.
//
// The Game core (src/game) is platform-agnostic. Everything that differs between
// Web and the WeChat mini-game — canvas acquisition, the Pixi Application setup,
// input devices, lifecycle — lives behind these interfaces. See design/04-wechat.md.
import type { Application } from 'pixi.js';

export interface InputState {
  moveX: number; // normalized movement, [-1, 1]
  moveY: number;
  // No aim field (design/10 v33): manual aim is gone. The engine auto-faces the nearest
  // hostile, else the movement direction, else holds last facing (ApplyInputSystem).
  firing: boolean; // fires ranged / swings melee — a melee swing is also the parry (no block key)
  // Held at a dungeon extraction checkpoint (design/05, ROADMAP 1.4): a sustained hold
  // EXTRACTs (bank + leave), a tap DESCENDs (bank + go deeper). Engine reads it as
  // Button.INTERACT via CommandBuilder. Ignored away from a checkpoint.
  interacting: boolean;
}

// Minimal structural view of the canvas the input source attaches to.
// On Web this is an HTMLCanvasElement; on WeChat it is the wx canvas — both expose
// width/height, and only the Web input touches the DOM event APIs (guarded).
export interface InputCanvas {
  width: number;
  height: number;
  addEventListener?: HTMLCanvasElement['addEventListener'];
  getBoundingClientRect?: () => { left: number; top: number };
}

// Render-facing geometry snapshot of the on-screen touch controls (TouchControls.ts) —
// exactly the values a render layer needs to draw sticks/buttons in the same place
// TouchControls hit-tests them, so the visual never drifts from the real hit zones.
// `active` is true once the player has touched the screen at least once this session
// (not just "a stick is currently held") — a render layer gates all drawing on it so a
// desktop/mouse session never shows the overlay.
export interface TouchVisual {
  active: boolean;
  // Shared hit-zone radius (CSS px, from TouchControls.layout()) for both sticks' base circles.
  stickRadius: number;
  // Null when the move stick isn't currently held. ox/oy is the touch-down origin
  // (dynamic, set fresh each press); dx/dy is the current pixel offset from it, already
  // clamped to stickRadius — same units as ox/oy, so a render layer can draw the knob at
  // (ox + dx, oy + dy) with no further math.
  move: { ox: number; oy: number; dx: number; dy: number } | null;
  // The right-side fire zone (design/10 v33: no more aim stick, just hold-to-fire) — a
  // fixed button, same shape as weapon1/weapon2, plus whether it's currently held.
  fire: { cx: number; cy: number; r: number; pressed: boolean };
  weapon1: { cx: number; cy: number; r: number };
  weapon2: { cx: number; cy: number; r: number };
  // INTERACT — a third corner button, held (not tapped) the same way `fire` is: the
  // revive channel (ReviveSystem, ROADMAP 3.2) reads it every tick for as long as it's
  // down, exactly like the keyboard's E/Space hold. Desktop-only until this pass — see
  // TouchControls.ts's own doc comment for why it was missing.
  interact: { cx: number; cy: number; r: number; pressed: boolean };
}

// A swappable input device. Web = keyboard + mouse; WeChat = virtual joystick + touch.
export interface InputSource {
  onSwitchWeapon: ((slot: number) => void) | null;
  attach(canvas: InputCanvas): void;
  read(): InputState;
  // Both Web and WeChat proxy this straight from their shared TouchControls instance
  // (platform/TouchControls.ts) — see TouchVisual's own doc comment.
  getTouchVisual(): TouchVisual;
  // Left-handed control-layout option (design/10, `Settings.ts` — SettingsState.
  // controlLayout), proxied to TouchControls.setMirrored. Optional: only Web/WeChat's
  // touch-backed sources implement it — a test fake with no touch controls at all has
  // nothing to mirror.
  setControlMirror?(mirrored: boolean): void;
}

// Audio cue vocabulary — a small closed set of ids, shared with fx/animation
// (design/11, design/12). The render layer maps engine events (design/08) to a cue;
// the platform's AudioBus decides how to make the sound. Audio is pure presentation:
// it reads events and plays, and NEVER feeds the sim (design/06/11).
export type AudioCue =
  | 'muzzle'
  // The melee counterpart of `muzzle`, off the `melee_swing` event (ENGINE_VERSION 52) —
  // announced whether or not the swing connects, so a stroke through empty air is audible.
  // A connection is `impact`'s job and a parry is `deflect`'s; this is the stroke itself.
  | 'swing'
  | 'impact'
  | 'deflect'
  | 'clash'
  | 'shield.break'
  | 'status.burn'
  | 'status.chill'
  | 'status.shock'
  | 'status.poison'
  // The four cues a CHARACTER makes about itself, and the audio half of the rig's own
  // authored clips (design/12): `attack` is `swing` above, and these three are `hurt`,
  // `death` and `spawn`. All four clips have animated a body since 2026-09-02 and none of
  // them made a sound; `idle`/`move` are the two that never should.
  //
  // `hurt` fires ONLY for the local seat, unlike `impact`, which fires for every hit anywhere.
  // That is the whole point of it: `impact` says a hit landed, `hurt` says it landed on YOU —
  // the "player damage" at the top of design/11's priority ladder. Firing it for every actor
  // would just double `impact` on every frame of a fight.
  | 'hurt'
  // `death` split in two (2026-09-02). The bare `death` cue only ever fired for an enemy —
  // `EventReactor` tested `faction === 'enemy'` before playing it — so a player death, the
  // moment a run ends, was the one lifecycle event in the game with no sound at all. Two
  // named cues instead of one silent branch, which is also design/11's own written
  // vocabulary (`death.<enemy/player>`).
  | 'death.enemy'
  | 'death.player'
  // An actor VIEW being built. Alone among the engine-driven cues this one has no engine
  // event behind it: an id appearing in `GameState` is a diff `Scene` computes, not something
  // the sim announces (same reason `Actor.onSpawn` is driven from there rather than from
  // `EventReactor`). It arrives as a per-frame COUNT instead — a room's wave can materialise
  // nine actors on one frame, which the mixer coalesces into one voice at higher gain.
  | 'spawn'
  | 'pickup.heal'
  | 'pickup.weapon'
  | 'pickup.material'
  | 'pickup.buff'
  // A chest paying out (design/05 "Chest rooms", 2026-09-15). The cue is the LID, not the
  // reward: the payout gets its own `pickup.weapon` a tick later when somebody collects it,
  // so a second reward sting here would only double that. Fires for both kinds — a small
  // chest opening on approach and a big one opening on its plates are the same event to a
  // listener, and the difference between them is a thing you SEE.
  | 'chest.open'
  | 'wave-clear'
  | 'win'
  // UI cues. Unlike everything above, these are NOT driven by engine events — they come
  // from the screen layer's own wall-clock interactions (design/11's "UI-side cues (button
  // tap, screen transition, extract/descend commit, result screen) come from 10's
  // ScreenManager, not the engine"). They share this union, the catalogue, the voice cap
  // and both backends, because the only thing that differs is who fires them: a UI cue is a
  // response to the player's finger rather than to a simulated event. They reach the bus
  // through `audio/uiSound.ts`, never through EventReactor.
  //
  // Four, not one, because they answer four different questions the player is asking:
  // `tap` = heard you, `back` = you are leaving this screen, `toggle` = the setting under
  // your finger changed, `denied` = that press did nothing (an unaffordable craft), which
  // was previously indistinguishable from a dropped input.
  | 'ui.tap'
  | 'ui.back'
  | 'ui.toggle'
  | 'ui.denied';

// Music vocabulary (design/11 "Music & ambience") — the three launch loops, and a closed
// union for the same reason `AudioCue` is one: `audio/musicCatalogue.ts` holds an exhaustive
// `Record<MusicTrack, TrackDef>`, so adding a track here is a COMPILE error until it has a
// music decision (which file, how long that file is, and whether the file is really its own).
//
// Three, not eight. design/11's original plan is one loop per elemental biome, but
// `game/theme.ts`'s `BIOME_ID_TO_ELEMENT` maps the only authored dungeon to `fire`, and
// ice/lightning/poison have art with no dungeon pointing at them — the same standard
// `assetPacks.json` already applies to art: do not pay bytes for content a run cannot reach.
//
// Unlike a cue, a track is never triggered by an engine event. `game/musicDirector.ts`
// DERIVES which one should be playing from the situation every render frame, so there is no
// trigger to miss, nothing to de-duplicate against prediction rollback (design/06), and no
// gap while the autoplay gate is still closed.
export type MusicTrack =
  | 'menu' // menus, the forge outpost, and every result screen
  | 'dungeon.ember' // the fire biome's run bed — NO MASTER YET, see musicCatalogue.ts
  | 'boss';

// A swappable audio device, symmetric to InputSource. Both backends now run the SAME cue
// pipeline (audio/CueMixer.ts — the shipped sample if one is loaded, the procedural voice if
// not); they differ only in how the AudioContext is obtained and how asset bytes are read.
// All calls are render-clock, fire-and-forget.
export interface AudioBus {
  /**
   * Fetch + decode the shipped SFX set (design/11 "preload the core SFX set at boot").
   * Best-effort, and boot never awaits it: until it resolves — or if it fails outright —
   * cues fall back to the procedural voices, which is audible rather than silent. Safe to
   * call more than once; a second call retries only what has nothing loaded.
   */
  preload(): Promise<void>;
  // Play a one-shot SFX cue. Cheap and idempotent-per-frame — the caller coalesces duplicate
  // cues within a frame (design/11 "coalesce identical cues in the same frame") and passes
  // how many events collapsed into this one as `count`, which raises the gain rather than
  // playing the cue twice.
  play(cue: AudioCue, count?: number): void;
  // 0..1 gain on the SFX / music buses (design/10 settings). Both are real now: `game/
  // settingsBinding.ts` has always computed and pushed the music value, and until 2026-08-31
  // both backends threw it away in a `(_v) => {}`, so the settings screen's music slider moved
  // a number that reached nothing.
  //
  // The two implementations are necessarily different, and not as an accident of style: web
  // puts a `GainNode` between the music decks and the destination, while WeChat's decks are
  // `InnerAudioContext`s with no audio graph at all, so there the bus value has to be
  // MULTIPLIED into each deck's own `.volume` alongside that deck's crossfade level.
  setSfxVolume(v: number): void;
  setMusicVolume(v: number): void;
  /**
   * Render-clock music tick (design/11 "Music & ambience"): which track SHOULD be sounding
   * this frame, and how much wall-clock time the last frame took.
   *
   * Called EVERY frame, in every phase, by `game/musicDirector.ts` — passing the track that is
   * already playing is a no-op, so no caller ever has to detect a transition. That shape is
   * immune to the two failure modes an event-driven music trigger has: a moment nobody
   * remembered to hook, and a moment that fires twice. It also crosses the autoplay gate for
   * free — while the gate is closed this call has nothing it can do, and the frame after the
   * context reaches `running` it simply starts.
   *
   * `dtMs` drives the crossfade envelope only. WHERE the loop wrap happens is read back from
   * the deck's own reported position, never accumulated here, so a stalled frame, a
   * backgrounded tab or an audio interruption cannot drift it.
   *
   * `null` means "nothing should be playing", and fades out over the same window.
   */
  updateMusic(track: MusicTrack | null, dtMs: number): void;
  /**
   * Forget which track is playing, so the next `updateMusic` starts it again from scratch
   * (design/12, "Music is loaded but never awaited").
   *
   * The one caller is `render/preloadArt.ts`, when the `music` subpackage finishes its
   * background download. Until it lands, a path inside that pack names no file on WeChat: the
   * deck reports an error, plays nothing, and `updateMusic` has already recorded the track as
   * the current one — so the per-frame derivation that normally needs no retry logic has
   * nothing left to notice. This is the one thing that has to be told, and all it is told is
   * "your answer was wrong, ask again".
   */
  invalidateMusic(): void;
  // Resume after the browser/WeChat autoplay gate; call on a user gesture (design/11).
  resume(): void;
}

// A platform provides the Pixi Application (bound to its canvas), the input device,
// and the audio device.
export interface Platform {
  createApp(): Promise<Application>;
  createInput(app: Application): InputSource;
  createAudio(): AudioBus;
}
