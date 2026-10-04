/**
 * `webStorage` — the guarded `localStorage` accessor. The case it exists for is a getter that
 * THROWS (storage denied to an embedded or sandboxed frame), which `typeof` does not catch.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { webStorage } from './webStorage';
import { createWebIdentityStore } from '../net/identity';
import { createWebSessionStore } from '../net/session';
import { createWebMetaStore } from '../meta/store';
import { createWebSettingsStore } from '../settings/store';
import { createWebRunSaveStore } from '../game/match/runSaveStore';

const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

afterEach(() => {
  if (original) Object.defineProperty(globalThis, 'localStorage', original);
  else delete (globalThis as { localStorage?: unknown }).localStorage;
});

function defineStorage(get: () => unknown): void {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get });
}

describe('webStorage', () => {
  it('is null, not a throw, when reading the global throws SecurityError', () => {
    defineStorage(() => {
      throw new DOMException("Failed to read the 'localStorage' property from 'Window'", 'SecurityError');
    });
    expect(() => webStorage()).not.toThrow();
    expect(webStorage()).toBeNull();
  });

  it('is null when there is no localStorage at all', () => {
    defineStorage(() => undefined);
    expect(webStorage()).toBeNull();
  });

  it('is the storage object when one is there', () => {
    const fake = { getItem: () => null } as unknown as Storage;
    defineStorage(() => fake);
    expect(webStorage()).toBe(fake);
  });
});

describe('the web stores, with storage denied', () => {
  it('construct, load and save without throwing — the boot path they sit on', () => {
    // Each of these opened with an unguarded `typeof localStorage` until 2026-10-04, and
    // constructing one in a storage-denied frame threw before the game drew anything.
    defineStorage(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(() => {
      const identity = createWebIdentityStore();
      identity.save('x');
      expect(identity.load()).toBeNull();
      const session = createWebSessionStore();
      session.save(null);
      expect(session.load()).toBeNull();
      const meta = createWebMetaStore();
      meta.save(meta.load());
      const settings = createWebSettingsStore();
      settings.save(settings.load());
      const runs = createWebRunSaveStore();
      expect(runs.load()).toBeNull();
      runs.clear();
    }).not.toThrow();
  });
});
