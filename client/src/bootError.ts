/**
 * Boot-failure reporting for main.ts (web) / main.wechat.ts — split into its own module
 * with no import-time side effects (unlike main.ts, which kicks off the real `boot()`
 * sequence — real Platform/Pixi/Game construction — the instant it's imported) so this
 * logic is unit-testable without triggering that.
 *
 * Before this existed, an uncaught throw anywhere in `boot()` (platform/app init, Game
 * construction, `start()`) was just an unhandled promise rejection: the browser's
 * default handler logged it, but the code path that removes `#boot-loading` never ran,
 * so the player was left staring at an infinite loading spinner with no indication
 * anything had gone wrong.
 */

/** Web entry's boot() failure handler — clears the boot splash and shows a real
 *  failure state instead of leaving `#boot-loading`'s spinner up forever. */
export function reportWebBootFailure(err: unknown): void {
  console.error('blightbloom: boot failed', err);
  const el = document.getElementById('boot-loading');
  if (el) el.innerHTML = '<div>Failed to load — please refresh the page.</div>';
}

/** WeChat entry's boot() failure handler — no DOM/loading-splash exists in the
 *  mini-game shell to update, but the error must still surface clearly rather than
 *  vanish as a bare unhandled rejection. */
export function reportWeChatBootFailure(err: unknown): void {
  console.error('blightbloom (wechat): boot failed', err);
}
