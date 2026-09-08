/**
 * `platform/onlineEntry.ts` — the two multiplayer doors a host can push the game through.
 * A registry, so what there is to test is that it is INERT until installed: every target
 * but the portal installs the implementation and nothing ever calls it, and a portal calls
 * it before the game may exist.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { onlineEntry, setOnlineEntry } from './onlineEntry';

afterEach(() => setOnlineEntry(null));

describe('onlineEntry', () => {
  it('is null before anything installs one', () => {
    expect(onlineEntry()).toBeNull();
  });

  it('hands back the installed implementation', () => {
    const entry = { queueCoop: vi.fn(), joinPartyByCode: vi.fn() };
    setOnlineEntry(entry);
    expect(onlineEntry()).toBe(entry);
    onlineEntry()?.queueCoop();
    onlineEntry()?.joinPartyByCode('ABCD');
    expect(entry.queueCoop).toHaveBeenCalledTimes(1);
    expect(entry.joinPartyByCode).toHaveBeenCalledWith('ABCD');
  });

  it('can be uninstalled', () => {
    setOnlineEntry({ queueCoop: vi.fn(), joinPartyByCode: vi.fn() });
    setOnlineEntry(null);
    expect(onlineEntry()).toBeNull();
  });

  it('replaces rather than accumulates', () => {
    const first = { queueCoop: vi.fn(), joinPartyByCode: vi.fn() };
    const second = { queueCoop: vi.fn(), joinPartyByCode: vi.fn() };
    setOnlineEntry(first);
    setOnlineEntry(second);
    onlineEntry()?.queueCoop();
    expect(first.queueCoop).not.toHaveBeenCalled();
    expect(second.queueCoop).toHaveBeenCalledTimes(1);
  });
});
