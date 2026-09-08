/**
 * Shared server config (ROADMAP 3.3) — `ticketSecret()`'s real-secret vs. dev-fallback
 * branches, and the one-time `console.warn` guarded by config.ts's module-scope `warned`
 * flag. That flag is module state, so each case that needs a FRESH flag does
 * `vi.resetModules()` + a dynamic re-import (mirrors this repo's other module-scope-state
 * tests) — sharing one imported `ticketSecret` across cases would leak the warned state
 * between them.
 *
 * **Rules 1 and 2 exist because this file went red once, in a full `npm run check`, and
 * never again in ~50 isolated and under-load re-runs (2026-08-25).** The cause was never
 * reproduced, but the test was structurally able to fail for reasons that have nothing to
 * do with `ticketSecret`, and that is fixed rather than left to recur:
 *
 *  1. **The console spy goes on AFTER the dynamic import, never before.** `src/config.ts`
 *     re-exports from `@dd/game/match/pvpConfig`, so `await import('../src/config')`
 *     evaluates a graph of ~104 modules. A spy installed before it is watching all of them,
 *     which turns `expect(warn).not.toHaveBeenCalled()` into "nothing in a 104-module graph
 *     warned" instead of "ticketSecret did not warn". Nothing in that graph warns at module
 *     scope today (checked), but the assertion should not depend on that staying true — or
 *     on vitest/Node never routing anything through `console.warn` during the await.
 *     `warnsLazily` below pins the property this relies on: the warning comes from the first
 *     `ticketSecret()` CALL, not from importing the module.
 *  2. **Assertions are about the ticket warning, not about console traffic in general.**
 *     `ticketWarnings()` filters to calls that actually mention `BB_TICKET_SECRET`, so an
 *     unrelated warning from anywhere can neither fail a "does not warn" case nor pad the
 *     count in a "warns once" case.
 *  3. **The cold import is paid in `beforeAll`, not by whichever `it` runs first** — see the
 *     comment on that hook. That one is a 2026-08-26 addition, and unlike the two above it
 *     WAS reproduced and measured, 3 red runs in 20.
 */
import { describe, it, expect, vi, beforeAll, afterEach, type MockInstance } from 'vitest';

const DEV_SECRET = 'dev-insecure-secret-do-not-use-in-prod';
const ORIGINAL_ENV = process.env.BB_TICKET_SECRET;

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.BB_TICKET_SECRET;
  else process.env.BB_TICKET_SECRET = ORIGINAL_ENV;
  vi.restoreAllMocks();
});

/**
 * Pay the module graph's COLD cost here, once, instead of billing it to whichever `it` runs
 * first. `import('../src/config')` reaches ~104 modules through `@dd/game/match/pvpConfig`,
 * and the first time a worker asks, vite has to transform all of them: measured 0.9s-8.1s on
 * one machine across 10 runs of `vitest run`, purely as a function of what else the run was
 * doing. Against vitest's 5000ms default `testTimeout` that made the FIRST test in this file
 * fail on 3 runs in 20 — always as a timeout, never as a failed assertion, and always the
 * first case, never the second one doing an identical `freshConfig()` right after it. In the
 * batch that measured both, the runs that went red were exactly the runs whose cold import
 * exceeded 5s.
 *
 * After this import, `freshConfig`'s `vi.resetModules()` + re-import costs ~50ms (the reset
 * discards evaluated modules, not vite's transform cache), so every case below finishes far
 * inside the default timeout and needs no timeout of its own. The explicit hook timeout is
 * sized for that one cold transform and nothing else — no test here waits on I/O, a timer,
 * or a network.
 *
 * Warming up is inert: `ticketSecret()` reads `process.env` and warns on CALL, not at module
 * scope (the `warns LAZILY` case at the bottom pins exactly that), so this import cannot
 * move any assertion below, and every case still gets its own fresh module instance.
 */
beforeAll(async () => {
  await import('../src/config');
}, 60_000);

/** Load a FRESH `config` module for the current env, with the console spy installed only
 *  after the import — see rule 1 in this file's header for why the order matters. */
async function freshConfig(): Promise<{
  ticketSecret: () => { secret: string; isDev: boolean };
  warn: MockInstance<typeof console.warn>;
}> {
  vi.resetModules();
  const { ticketSecret } = await import('../src/config');
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  return { ticketSecret, warn };
}

/** Only the warnings this module is responsible for. Anything else on `console.warn` is
 *  somebody else's and must not move these assertions either way. */
function ticketWarnings(warn: MockInstance<typeof console.warn>): string[] {
  return warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('BB_TICKET_SECRET'));
}

describe('ticketSecret — real secret configured', () => {
  it('returns the env secret with isDev:false, and never warns', async () => {
    process.env.BB_TICKET_SECRET = 'a-real-production-secret';
    const { ticketSecret, warn } = await freshConfig();
    expect(ticketSecret()).toEqual({ secret: 'a-real-production-secret', isDev: false });
    expect(ticketWarnings(warn)).toEqual([]);
  });

  it('repeated calls keep returning the same real secret, still without warning', async () => {
    process.env.BB_TICKET_SECRET = 'a-real-production-secret';
    const { ticketSecret, warn } = await freshConfig();
    ticketSecret();
    ticketSecret();
    expect(ticketSecret()).toEqual({ secret: 'a-real-production-secret', isDev: false });
    expect(ticketWarnings(warn)).toEqual([]);
  });
});

/**
 * `ticketSecret()` reads `process.env` on every CALL — it does not capture it at module
 * scope. Two reasons that is worth its own cases rather than being left implied by the
 * cases above, all of which set the env var BEFORE importing and so pass either way:
 *
 *  1. It is what the server actually depends on. `matchsvc.ts` and `index.ts` both import
 *     this module at boot, and a module-scope capture would make the secret depend on
 *     whether whatever loads the environment ran before that import — the failure being a
 *     process that signs real tickets with the DEV secret while looking correctly
 *     configured, which is the exact posture this file exists to defend.
 *  2. It is the property that makes the `beforeAll` warm-up above sound. That import runs
 *     under the ambient environment, before any case has set anything, so if the env were
 *     read at import time the warm-up would be a behaviour change and not just a cost.
 *     Pinned here rather than trusted, the same way `warns LAZILY` pins the sibling
 *     property for the console warning.
 */
describe('ticketSecret — env is read per call, not captured at import', () => {
  it('honours a secret set AFTER the module was imported', async () => {
    delete process.env.BB_TICKET_SECRET;
    const { ticketSecret, warn } = await freshConfig();
    process.env.BB_TICKET_SECRET = 'set-after-the-import';
    expect(ticketSecret()).toEqual({ secret: 'set-after-the-import', isDev: false });
    expect(ticketWarnings(warn)).toEqual([]);
  });

  it('falls back and warns when the secret is removed AFTER the import', async () => {
    process.env.BB_TICKET_SECRET = 'set-before-the-import';
    const { ticketSecret, warn } = await freshConfig();
    delete process.env.BB_TICKET_SECRET;
    expect(ticketSecret()).toEqual({ secret: DEV_SECRET, isDev: true });
    expect(ticketWarnings(warn)).toHaveLength(1);
  });
});

describe('ticketSecret — unset (dev fallback)', () => {
  it('falls back to the hard-coded dev secret with isDev:true, and warns once', async () => {
    delete process.env.BB_TICKET_SECRET;
    const { ticketSecret, warn } = await freshConfig();
    expect(ticketSecret()).toEqual({ secret: DEV_SECRET, isDev: true });
    const warnings = ticketWarnings(warn);
    expect(warnings).toHaveLength(1);
    // The message has to name the variable AND say what to do about it — this is the only
    // signal an operator gets that they are signing tickets with a public secret.
    expect(warnings[0]).toContain('BB_TICKET_SECRET');
    expect(warnings[0]).toContain('insecure');
  });

  it('treats an empty-string env var the same as unset', async () => {
    process.env.BB_TICKET_SECRET = '';
    const { ticketSecret, warn } = await freshConfig();
    expect(ticketSecret()).toEqual({ secret: DEV_SECRET, isDev: true });
    expect(ticketWarnings(warn)).toHaveLength(1);
  });

  it('warns only ONCE across many repeated calls (module-scope `warned` guard)', async () => {
    delete process.env.BB_TICKET_SECRET;
    const { ticketSecret, warn } = await freshConfig();
    for (let i = 0; i < 5; i++) {
      expect(ticketSecret()).toEqual({ secret: DEV_SECRET, isDev: true });
    }
    expect(ticketWarnings(warn)).toHaveLength(1);
  });

  it('a fresh module instance (vi.resetModules) gets its own independent warned flag', async () => {
    delete process.env.BB_TICKET_SECRET;

    const first = await freshConfig();
    first.ticketSecret();
    first.ticketSecret();
    expect(ticketWarnings(first.warn)).toHaveLength(1);
    first.warn.mockRestore();

    const second = await freshConfig();
    second.ticketSecret();
    // The second module's OWN first call, not a leftover count from the first instance.
    expect(ticketWarnings(second.warn)).toHaveLength(1);
  });

  it('warns LAZILY — importing the module is silent, the first call is what warns', async () => {
    // The property rule 1 in this file's header depends on. If the warning ever moves to
    // module scope, every spy-after-import assertion above would silently stop observing it,
    // so pin it explicitly rather than letting those cases quietly go vacuous.
    delete process.env.BB_TICKET_SECRET;
    vi.resetModules();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { ticketSecret } = await import('../src/config');
    expect(ticketWarnings(warn), 'importing config must not warn on its own').toEqual([]);
    ticketSecret();
    expect(ticketWarnings(warn)).toHaveLength(1);
  });
});
