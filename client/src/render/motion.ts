/**
 * "Reduce motion" — the accessibility lever this client did not have (2026-09-22).
 *
 * Added with the frame-pacing work and from the same report ("dizziness after about twenty
 * minutes"), because the two are separate causes of the same symptom and fixing only the one
 * that happened to be a bug would have been answering the diagnosis rather than the player.
 * What it turns off is the whole-screen motion that is decoration rather than information:
 *
 * - **camera shake** (`fx/FxController.ts`). ±14 px of white noise applied to the entire world
 *   layer, re-rolled every render frame. Nothing about the game state is readable from it —
 *   the hit it accompanies is already shown by the flash, the knockback and the damage number
 *   — and an uncorrelated per-frame translation of everything on screen is the single most
 *   reliable way to make a player motion-sick.
 * - **the chromatic-aberration pulse** (`fx/filters/screenFx.ts`), for the same reason one
 *   step weaker: it is a full-frame distortion on a hit, and it is the other thing on screen
 *   that moves without being an object.
 *
 * What it deliberately does NOT turn off: the vignette (static, no motion), hit-stop (a
 * pause is the opposite of motion), particles, and every animation attached to an object the
 * player is tracking. Those carry information or stay put; switching them off would be a
 * different setting, and one nobody asked for.
 *
 * A module mirror, same shape and same reason as `quality.ts`'s `activeQuality()` and i18n's
 * `t()` (design/17): the persisted copy lives in `SettingsState`, `SettingsBinding` pushes
 * every change here, and the reader is on a path that runs every frame. Threading a settings
 * parameter through `GameLoop.updateCamera` into `FxController` for a process-wide boolean is
 * the alternative, and it is worse.
 */

let reduced = false;

/** The player changed the setting (`SettingsBinding`, at boot and on every change). */
export function setReduceMotion(on: boolean): void {
  reduced = on;
}

/** Is whole-screen decorative motion suppressed? Read per frame; keep it cheap. */
export function motionReduced(): boolean {
  return reduced;
}

/** Test helper — one case's pick must not leak into the next, and both values are legal, so
 *  the leak would be invisible rather than loud. */
export function resetReduceMotion(): void {
  reduced = false;
}
