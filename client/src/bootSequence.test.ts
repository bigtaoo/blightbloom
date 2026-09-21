/**
 * The boot ORDER each entry point runs, for the steps this repository has no other way to see.
 *
 * An entry module runs `boot()` the moment it is imported — real Platform, real Pixi, real
 * `Game` — so there is no seam to observe any of this from inside, and every ordering below is
 * load-bearing, silent when wrong, and would survive a full green suite. Same technique and
 * same reason as `render/wechatPhasedBoot.test.ts` (the art phases), `i18n/loadLocale.test.ts`
 * (the active locale) and `platform/crazygames/portalBuild.test.ts` (the portal's own chain);
 * what lives here is the splash and the first-screen critical path, which span all three
 * entries and belong to none of those files.
 *
 * THE FAILURE MODE OF A TEST LIKE THIS IS MATCHING NOTHING. A needle that no longer appears
 * makes `indexOf` return −1, and −1 is less than everything, so a renamed call would turn every
 * assertion below into a tautology. `at()` fails on the miss, by name, before any comparison
 * happens.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const DOM_ENTRIES = ['main.ts', 'main.crazygames.ts'] as const;
const ALL_ENTRIES = ['main.ts', 'main.crazygames.ts', 'main.wechat.ts'] as const;

function source(entry: string): string {
  return readFileSync(new URL(`./${entry}`, import.meta.url), 'utf8');
}

/** Where a needle is, failing loudly if it is nowhere. */
function locator(entry: string): (needle: string) => number {
  const src = source(entry);
  return (needle) => {
    const i = src.indexOf(needle);
    expect(i, `${entry}: no \`${needle}\``).toBeGreaterThan(-1);
    return i;
  };
}

/**
 * Where a STATEMENT is, rather than where the string first appears anywhere.
 *
 * Borrowed verbatim from `portalBuild.test.ts`, which grew it after an ordering assertion
 * silently anchored on a call named in a COMMENT above the code and passed while the code was
 * in the opposite order. Every file here is more comment than code, so this is not a
 * hypothetical hazard in this directory.
 */
function statementLocator(entry: string): (line: string) => number {
  const at = locator(entry);
  return (line) => at(`\n  ${line}`);
}

describe('the splash comes down last, and only after a frame exists', () => {
  it.each(DOM_ENTRIES)('%s: waits for a rendered frame before hiding', (entry) => {
    // The bug this whole pass started from: `remove()` sat one statement after `game.start()`,
    // which populates the stage without drawing it, so the splash was pulled off a canvas the
    // menu had never been rendered onto. Reversing these two lines puts that blank frame back
    // and nothing else in the suite would notice — `hideBootSplash` is perfectly happy to run
    // first.
    const stmt = statementLocator(entry);
    expect(stmt('await afterFirstRenderedFrame(app.ticker);')).toBeLessThan(stmt('await hideBootSplash();'));
  });

  it.each(DOM_ENTRIES)('%s: hides the splash after everything else boot() installs', (entry) => {
    // `hideBootSplash` is a WAIT — up to the full `bootHold.ts` floor — so anything queued
    // behind it is delayed by that much. On web that is the deploy auto-reload; on both it is
    // the debugging handle. Neither is visible on screen, which is exactly why nothing would
    // report it.
    const src = source(entry);
    const stmt = statementLocator(entry);
    const hide = stmt('await hideBootSplash();');
    const tail = entry === 'main.ts' ? stmt('installAutoReload(') : stmt('app.ticker.add(() => portal.update());');
    expect(tail).toBeLessThan(hide);
    // ...and nothing at all comes after it: the last statement of `boot()` is the one that is
    // allowed to wait. (`hide` is the index of the statement's leading newline + indent, which
    // is what `stmt` anchors on, so the call's own length is measured from the raw source.)
    const call = 'await hideBootSplash();';
    expect(src.slice(src.indexOf(call, hide) + call.length).trim()).toMatch(/^\}/);
  });

  it.each(DOM_ENTRIES)('%s: feeds the lobby load into the bar rather than leaving it parked', (entry) => {
    // `preloadLobbyArt()` with no argument is the pre-2026-09-21 call and is still perfectly
    // valid — the parameter is optional. So dropping the callback leaves a bar that sits at 20%
    // for the whole download it exists to describe, with every test in `bootSplash.test.ts`
    // still green because they all drive `setBootProgress` directly.
    const at = locator(entry);
    expect(at('await preloadLobbyArt((done, total) => setBootProgress(')).toBeGreaterThan(-1);
  });
});

describe('nothing optional shares the pipe with the one download the player waits on', () => {
  it.each(ALL_ENTRIES)('%s: kicks the SFX set after the lobby pack, not beside the audio device', (entry) => {
    // Measured on the live deploy: 70 sample requests went out while the `lobby` pack was
    // still in flight. Moving `void audio.preload()` back up beside `createAudio()` is a
    // one-line edit, reads as perfectly natural, costs the player a slower first screen, and
    // has no observable consequence anywhere in this suite.
    const at = locator(entry);
    expect(at('await preloadLobbyArt(')).toBeLessThan(at('void audio.preload();'));
  });

  it.each(ALL_ENTRIES)('%s: kicks the run art and the spare locales only once the lobby is up', (entry) => {
    // Both are background work with no one waiting on them, and both are large. The art half
    // is also pinned by `wechatPhasedBoot.test.ts` for a different reason (arming the gate
    // before `new Game`), so this is the bandwidth half of the same line.
    const at = locator(entry);
    const lobby = at('await preloadLobbyArt(');
    expect(lobby).toBeLessThan(at('beginDeferredArt();'));
    expect(lobby).toBeLessThan(at('prefetchLocales();'));
  });
});

describe('the WeChat entry, which has no DOM to put a splash in', () => {
  it('awaits its Pixi progress screen down rather than dropping the promise', () => {
    // `showBootLoading(...).done()` returns a promise now, because it owes the player
    // `bootHold.ts`'s floor before it destroys the screen. A bare `loading.done();` still
    // compiles, still type-checks (the return is ignorable), and takes the screen down
    // immediately on exactly the fast boots the floor exists for.
    const at = locator('main.wechat.ts');
    expect(at('await loading.done();')).toBeGreaterThan(-1);
  });
});
