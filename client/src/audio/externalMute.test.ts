/**
 * `externalMute` — the one-boolean sink between an ad and the audio bus.
 *
 * Small enough that the only things worth pinning are the two that a caller relies on: the
 * listener fires on a real change and not on a repeat, and the flag is a FACTOR rather than
 * a second copy of the player's own mute setting (that half is asserted in
 * `game/settingsBinding.test.ts`, where the two meet).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isExternallyMuted,
  onExternalMuteChange,
  resetExternalMute,
  setExternalMute,
} from './externalMute';

afterEach(() => resetExternalMute());

describe('externalMute', () => {
  it('starts released', () => {
    expect(isExternallyMuted()).toBe(false);
  });

  it('notifies the authority on a real change', () => {
    const cb = vi.fn();
    onExternalMuteChange(cb);
    setExternalMute(true);
    expect(isExternallyMuted()).toBe(true);
    expect(cb).toHaveBeenCalledOnce();
    setExternalMute(false);
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('does not notify on a repeat', () => {
    // `AdController` releases from a `finally` that can run after an already-released
    // path, and `SettingsBinding.applyAll` pushes into the audio bus on every notification.
    // A repeat would be a redundant bus write per ad, not a wrong one — cheap to avoid.
    const cb = vi.fn();
    onExternalMuteChange(cb);
    setExternalMute(true);
    setExternalMute(true);
    expect(cb).toHaveBeenCalledOnce();
  });

  it('works with no listener registered', () => {
    // Every entry point except the portal one leaves this module unused; a mute set before
    // `SettingsBinding` exists must not throw.
    expect(() => setExternalMute(true)).not.toThrow();
    expect(isExternallyMuted()).toBe(true);
  });

  it('keeps one authority, not a growing list', () => {
    // Two objects pushing different numbers into the same audio bus is the failure this
    // shape rules out — the second registration replaces the first rather than joining it.
    const first = vi.fn();
    const second = vi.fn();
    onExternalMuteChange(first);
    onExternalMuteChange(second);
    setExternalMute(true);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });

  it('reset clears both the flag and the listener', () => {
    const cb = vi.fn();
    onExternalMuteChange(cb);
    setExternalMute(true);
    resetExternalMute();
    expect(isExternallyMuted()).toBe(false);
    setExternalMute(true);
    expect(cb).toHaveBeenCalledOnce(); // only the pre-reset call
  });
});
