/**
 * `config.ts`'s internal-key half (design/19 §3, ROADMAP 8.1) — kept out of `config.test.ts`
 * because the two share module state that must NOT be shared between them: `ticketSecret`'s
 * `warned` flag and `internalKeys`' `internalWarned` flag both live at module scope in the
 * same file, so a case that resets one resets the other, and interleaving the two suites
 * would make each one's "warns exactly once" assertion depend on the order of the other's.
 *
 * The same three structural rules `config.test.ts`'s header states apply verbatim here, and
 * for the same measured reason: the console spy goes on AFTER the dynamic import (that
 * import evaluates ~104 modules through `@dd/game/match/pvpConfig`), assertions filter to
 * this module's OWN warning text, and the cold transform is paid in `beforeAll`.
 *
 * The one case here that is about security rather than plumbing is the production branch. A
 * process deployed with `NODE_ENV=production` and no `BB_INTERNAL_KEY` must get an EMPTY
 * registry, not the dev key: the dev key is published in `config.ts`, so falling back to it
 * in production is identical to having no authentication while looking configured. That is
 * design/19 §5's "fail closed in production" applied to the seam ROADMAP 8.1 builds.
 */
import { describe, it, expect, vi, beforeAll, afterEach, type MockInstance } from 'vitest';
import type { InternalCaller } from '../src/internalAuth';

const DEV_INTERNAL_KEY = 'dev-insecure-internal-key-do-not-use-in-prod';
const ORIGINAL_KEY = process.env.BB_INTERNAL_KEY;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.BB_INTERNAL_KEY;
  else process.env.BB_INTERNAL_KEY = ORIGINAL_KEY;
  if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  vi.restoreAllMocks();
});

/** See `config.test.ts`'s hook of the same shape — this pays the cold module graph once. */
beforeAll(async () => {
  await import('../src/config');
}, 60_000);

async function freshConfig(): Promise<{
  internalKeys: () => { registry: InternalCaller[]; isDev: boolean };
  internalKeyFor: (caller: string) => string | undefined;
  sharedInternalKey: () => string | undefined;
  controlPlaneUrl: () => string;
  gameserver: string;
  billsvc: string;
  warn: MockInstance<typeof console.warn>;
}> {
  vi.resetModules();
  const mod = await import('../src/config');
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  return {
    internalKeys: mod.internalKeys,
    internalKeyFor: mod.internalKeyFor,
    sharedInternalKey: mod.sharedInternalKey,
    controlPlaneUrl: mod.controlPlaneUrl,
    gameserver: mod.INTERNAL_CALLER_GAMESERVER,
    billsvc: mod.INTERNAL_CALLER_BILLSVC,
    warn,
  };
}

/** Only the warnings this module owns — anything else on the console is somebody else's. */
function keyWarnings(warn: MockInstance<typeof console.warn>): string[] {
  return warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('BB_INTERNAL_KEY'));
}

describe('internalKeys — a real key configured', () => {
  it('returns a one-entry registry naming the gameserver, isDev:false, no warning', async () => {
    process.env.BB_INTERNAL_KEY = 'a-real-internal-key';
    const { internalKeys, gameserver, warn } = await freshConfig();
    expect(internalKeys()).toEqual({
      registry: [{ caller: gameserver, key: 'a-real-internal-key' }],
      isDev: false,
    });
    expect(keyWarnings(warn)).toEqual([]);
  });

  it('a real key wins even under NODE_ENV=production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.BB_INTERNAL_KEY = 'a-real-production-key';
    const { internalKeys, warn } = await freshConfig();
    expect(internalKeys().registry).toHaveLength(1);
    expect(internalKeys().isDev).toBe(false);
    expect(keyWarnings(warn)).toEqual([]);
  });

  it('reads the env per CALL, not at import — a key set after the import is honoured', async () => {
    delete process.env.BB_INTERNAL_KEY;
    const { internalKeys } = await freshConfig();
    process.env.BB_INTERNAL_KEY = 'set-after-the-import';
    expect(internalKeys().registry[0]!.key).toBe('set-after-the-import');
  });
});

describe('internalKeys — unset outside production (dev fallback)', () => {
  it('falls back to the published dev key with isDev:true, and warns once', async () => {
    delete process.env.BB_INTERNAL_KEY;
    process.env.NODE_ENV = 'test';
    const { internalKeys, gameserver, warn } = await freshConfig();
    expect(internalKeys()).toEqual({
      registry: [{ caller: gameserver, key: DEV_INTERNAL_KEY }],
      isDev: true,
    });
    const warnings = keyWarnings(warn);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('insecure');
  });

  it('treats an empty-string env var the same as unset', async () => {
    process.env.BB_INTERNAL_KEY = '';
    const { internalKeys } = await freshConfig();
    expect(internalKeys()).toMatchObject({ isDev: true });
  });

  it('warns only ONCE across repeated calls (module-scope guard)', async () => {
    delete process.env.BB_INTERNAL_KEY;
    const { internalKeys, warn } = await freshConfig();
    for (let i = 0; i < 5; i++) internalKeys();
    expect(keyWarnings(warn)).toHaveLength(1);
  });

  it('warns LAZILY — importing config is silent, the first call is what warns', async () => {
    delete process.env.BB_INTERNAL_KEY;
    vi.resetModules();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { internalKeys } = await import('../src/config');
    expect(keyWarnings(warn), 'importing config must not warn on its own').toEqual([]);
    internalKeys();
    expect(keyWarnings(warn)).toHaveLength(1);
  });
});

describe('internalKeys — unset IN production (fail closed)', () => {
  it('returns an EMPTY registry, never the published dev key', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.BB_INTERNAL_KEY;
    const { internalKeys } = await freshConfig();
    const { registry, isDev } = internalKeys();
    expect(registry).toEqual([]);
    // Not dev either: this is a misconfigured production process, and calling it "dev" is
    // what would tempt some later caller into a "well, in dev we allow it" branch.
    expect(isDev).toBe(false);
    expect(JSON.stringify(registry)).not.toContain(DEV_INTERNAL_KEY);
  });

  it('warns that every internal route is now rejecting, once', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.BB_INTERNAL_KEY;
    const { internalKeys, warn } = await freshConfig();
    internalKeys();
    internalKeys();
    const warnings = keyWarnings(warn);
    expect(warnings).toHaveLength(1);
    // The operator's only signal that settlement reports are being refused, so it has to
    // say what is happening, not just that a variable is missing.
    expect(warnings[0]).toContain('REJECTS');
  });
});

describe('internalKeyFor — the key this process presents outbound', () => {
  it('returns the gameserver key when one is configured', async () => {
    process.env.BB_INTERNAL_KEY = 'a-real-internal-key';
    const { internalKeyFor, gameserver } = await freshConfig();
    expect(internalKeyFor(gameserver)).toBe('a-real-internal-key');
  });

  it('returns undefined for a caller that is not in the registry', async () => {
    // The registry has exactly one entry today; `billsvc` (design/19 §4) is the next one,
    // and until it is added this must be `undefined` rather than the gameserver's key.
    process.env.BB_INTERNAL_KEY = 'a-real-internal-key';
    const { internalKeyFor } = await freshConfig();
    expect(internalKeyFor('billsvc')).toBeUndefined();
  });

  it('returns undefined in the production fail-closed state, for every caller', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.BB_INTERNAL_KEY;
    const { internalKeyFor, gameserver } = await freshConfig();
    expect(internalKeyFor(gameserver)).toBeUndefined();
  });
});

describe('sharedInternalKey — what billsvc presents outbound (design/19 §4)', () => {
  it('is the one configured key, whatever caller the registry entry is labelled', async () => {
    // The registry today holds ONE key that all three processes share, filed under the
    // caller that needed it first. billsvc asking for it by that label would put a false
    // name in the one place an audit line reads one, so it asks for the shared key instead —
    // and `internalKeyFor('billsvc')` correctly still answers undefined (the case above),
    // which is what makes this function necessary rather than redundant.
    process.env.BB_INTERNAL_KEY = 'a-real-internal-key';
    const { sharedInternalKey, internalKeyFor, billsvc } = await freshConfig();
    expect(sharedInternalKey()).toBe('a-real-internal-key');
    expect(internalKeyFor(billsvc)).toBeUndefined();
  });

  it('is the published dev key outside production, so the local three-process setup works', async () => {
    delete process.env.BB_INTERNAL_KEY;
    delete process.env.NODE_ENV;
    const { sharedInternalKey } = await freshConfig();
    expect(sharedInternalKey()).toBe(DEV_INTERNAL_KEY);
  });

  it('is undefined in the production fail-closed state', async () => {
    // The billing plane then sends no `x-internal-key` at all and every delivery is rejected
    // with a logged reason — visibly broken, rather than looking configured while presenting
    // a secret that is published in `config.ts`.
    process.env.NODE_ENV = 'production';
    delete process.env.BB_INTERNAL_KEY;
    const { sharedInternalKey } = await freshConfig();
    expect(sharedInternalKey()).toBeUndefined();
  });

  it('names billsvc distinctly from the gameserver', async () => {
    const { billsvc, gameserver } = await freshConfig();
    expect(billsvc).toBe('billsvc');
    expect(billsvc).not.toBe(gameserver);
  });
});

describe('controlPlaneUrl — where billsvc delivers to', () => {
  const ORIGINAL_URL = process.env.BB_MATCHSVC_URL;
  afterEach(() => {
    if (ORIGINAL_URL === undefined) delete process.env.BB_MATCHSVC_URL;
    else process.env.BB_MATCHSVC_URL = ORIGINAL_URL;
  });

  it('reads BB_MATCHSVC_URL when it is set', async () => {
    process.env.BB_MATCHSVC_URL = 'https://control.example';
    const { controlPlaneUrl } = await freshConfig();
    expect(controlPlaneUrl()).toBe('https://control.example');
  });

  it('defaults to localhost on the control plane own port, matching matchsvc posture', async () => {
    delete process.env.BB_MATCHSVC_URL;
    const { controlPlaneUrl } = await freshConfig();
    expect(controlPlaneUrl()).toBe('http://localhost:8788');
  });

  it('treats an empty-string env var as unset', async () => {
    process.env.BB_MATCHSVC_URL = '';
    const { controlPlaneUrl } = await freshConfig();
    expect(controlPlaneUrl()).toBe('http://localhost:8788');
  });

  it('reads the env per CALL, not at import', async () => {
    delete process.env.BB_MATCHSVC_URL;
    const { controlPlaneUrl } = await freshConfig();
    expect(controlPlaneUrl()).toBe('http://localhost:8788');
    process.env.BB_MATCHSVC_URL = 'https://later.example';
    expect(controlPlaneUrl()).toBe('https://later.example');
  });
});
