// "Something outside the game is making noise, so be silent" — one boolean, one sink.
//
// The case that needs it is a portal video ad. Those have their own audio, and the platform's
// requirement is unambiguous: "mute your audio whenever an advertisement starts playing, and
// unmute it when the ad has finished" (`docs.crazygames.com/requirements/ads`).
//
// ## Why this is a module sink and not a parameter
//
// The two ends are as far apart as two things in this client can be. The muter is
// `platform/crazygames/AdController`, installed from an entry point and unknown to the game;
// the muted is the audio bus, whose volume has exactly one authority — `game/settingsBinding.ts`,
// which owns the settings state and pushes `effectiveVolume` into the bus. Threading a
// parameter between them means a handle on the settings binding reaching the entry point,
// which means an accessor on `Game` — a file sitting at exactly its 500-line limit — for a
// boolean.
//
// `audio/uiSound.ts` and `game/musicDirector.ts` both took the module-sink shape for the same
// reason and say so in their own headers: a caller that cannot be handed a dependency reaches
// the one authority through a module instead. This is the third instance of that pattern, not
// a new one.
//
// ## Why it is a FACTOR and not a second `muted` flag
//
// Because it must not be confusable with the player's own mute. `SettingsState.muted` is a
// setting: it persists, the settings screen renders it, and the player owns it. This does
// none of those things — it is a transient override that must leave the setting exactly as
// it found it, so that an ad ending restores a player who had music at 25% to 25% and not to
// some default. Keeping them separate is what makes that automatic rather than careful.

let muted = false;
let listener: (() => void) | null = null;

/**
 * Mute or unmute everything for a reason outside the game.
 *
 * Notifies the audio authority so the change lands immediately rather than on the next
 * settings edit. Idempotent: an ad's `adError` arm and its `finally` can both release it.
 */
export function setExternalMute(next: boolean): void {
  if (muted === next) return;
  muted = next;
  listener?.();
}

export function isExternallyMuted(): boolean {
  return muted;
}

/** Registered once by `SettingsBinding`, which is the single authority on bus volume. A
 *  second registration replaces the first — there is only ever one such authority, and two
 *  would mean two objects pushing different numbers into the same bus. */
export function onExternalMuteChange(cb: (() => void) | null): void {
  listener = cb;
}

/** Reset both the flag and the listener. For tests — module state outlives a test file, and
 *  a leaked listener would fire into a torn-down binding. */
export function resetExternalMute(): void {
  muted = false;
  listener = null;
}
