/**
 * `SettingsBinding` (2026-08-25) — the persisted settings and the five places a change to them
 * has to land.
 *
 * The bug shape this exists to prevent, and the reason it is a class rather than five private
 * methods on `Game`: a setting that applies on CHANGE but not at BOOT. That is a two-call-site
 * invariant, and it has to be kept by hand every time a new setting is added — quality was the
 * fifth, the in-run frame cap the sixth. So every case below checks both paths, not one.
 */
import { afterEach, describe, it, expect } from 'vitest';
import { SettingsBinding, type SettingsBindingDeps } from './settingsBinding';
import { MemorySettingsStore, defaultSettingsState, type SettingsState } from '../settings';
import { getLocale, resetLocaleForTests } from '../i18n';
import { resetExternalMute, setExternalMute } from '../audio/externalMute';
import { activePlayFrameCap, resetPlayFrameCap } from './powerBudget';

afterEach(() => resetPlayFrameCap());

function harness(initial: Partial<SettingsState> = {}) {
  const audio = { sfx: -1, music: -1 };
  const input = { mirrored: null as boolean | null };
  const quality = { applied: [] as string[], pinned: [] as string[] };
  const deps: SettingsBindingDeps = {
    audio: {
      setSfxVolume: (v) => { audio.sfx = v; },
      setMusicVolume: (v) => { audio.music = v; },
    },
    input: { setControlMirror: (m) => { input.mirrored = m; } },
    quality: {
      apply: (s) => quality.applied.push(s),
      pin: (s) => quality.pinned.push(s),
    },
  };
  const store = new MemorySettingsStore({ ...defaultSettingsState(), ...initial });
  return { binding: new SettingsBinding(deps, store), audio, input, quality, store };
}

describe('SettingsBinding.load — everything takes effect at boot', () => {
  it('applies volume, control layout and quality from the persisted state', () => {
    const h = harness({ master: 1, sfx: 0.25, music: 0.75, controlLayout: 'mirrored', quality: 'low' });
    h.binding.load();
    expect(h.audio.sfx).toBe(0.25);
    expect(h.audio.music).toBe(0.75);
    expect(h.input.mirrored).toBe(true);
    expect(h.quality.applied).toEqual(['low']);
  });

  it('sets the live locale mirror, not just the stored copy', () => {
    resetLocaleForTests();
    const h = harness({ locale: 'ru' });
    h.binding.load();
    expect(getLocale()).toBe('ru');
    resetLocaleForTests();
  });

  it('honours mute at boot rather than only after the first mute tap', () => {
    const h = harness({ muted: true, sfx: 0.9, music: 0.9 });
    h.binding.load();
    expect(h.audio.sfx).toBe(0);
    expect(h.audio.music).toBe(0);
  });

  it('tolerates a host with no control mirror at all', () => {
    // A test fake, or any InputSource with no touch controls. Not an error — there is simply
    // nothing to mirror.
    const store = new MemorySettingsStore({ ...defaultSettingsState(), controlLayout: 'mirrored' });
    const binding = new SettingsBinding(
      { audio: { setSfxVolume: () => {}, setMusicVolume: () => {} }, input: {}, quality: { apply: () => {}, pin: () => {} } },
      store,
    );
    expect(() => binding.load()).not.toThrow();
  });
});

describe('SettingsBinding — the in-run frame cap', () => {
  it('applies the persisted rate at BOOT, not only after the first tap', () => {
    // The cap is a module mirror (`powerBudget.ts`), so "applied" means the mirror moved. A
    // player who picked 30 last session must not spend their first run back at 60.
    expect(activePlayFrameCap()).toBe(60);
    harness({ frameRate: 30 }).binding.load();
    expect(activePlayFrameCap()).toBe(30);
  });

  it('applies a change reported by the settings screen', () => {
    const h = harness({ frameRate: 60 });
    h.binding.load();
    expect(activePlayFrameCap()).toBe(60);
    h.binding.update({ ...h.binding.state, frameRate: 30 });
    expect(activePlayFrameCap()).toBe(30);
    // ...and back, in the same session.
    h.binding.update({ ...h.binding.state, frameRate: 60 });
    expect(activePlayFrameCap()).toBe(60);
  });

  it('survives an unrelated edit — a volume drag must not reset the cap', () => {
    const h = harness({ frameRate: 30 });
    h.binding.load();
    h.binding.update({ ...h.binding.state, master: 0.4 });
    expect(activePlayFrameCap()).toBe(30);
  });

  it('is restored by the ad-mute re-apply path, which recomputes from the settings', () => {
    // `applyAll` runs on the external-mute callback too, so the cap has to be idempotent
    // there rather than reset to the default by a path that only meant to touch the audio.
    const h = harness({ frameRate: 30 });
    h.binding.load();
    setExternalMute(true);
    expect(activePlayFrameCap()).toBe(30);
    setExternalMute(false);
    expect(activePlayFrameCap()).toBe(30);
  });
});

describe('SettingsBinding.update — a change persists and applies', () => {
  it('writes to the store and re-applies the audio buses', () => {
    const h = harness();
    h.binding.load();
    h.binding.update({ ...h.binding.state, sfx: 0.1, music: 0.2 });
    expect(h.audio.sfx).toBeCloseTo(0.1);
    expect(h.audio.music).toBeCloseTo(0.2);
    expect(h.store.load().sfx).toBeCloseTo(0.1);
  });

  it('pins the quality tier only when the quality actually changed', () => {
    const h = harness({ quality: 'auto' });
    h.binding.load();
    h.binding.update({ ...h.binding.state, muted: true });
    // `pin` can reallocate the renderer's backing buffer — a volume drag must not pay for one
    // on every frame of the drag.
    expect(h.quality.pinned).toEqual([]);
    h.binding.update({ ...h.binding.state, quality: 'low' });
    expect(h.quality.pinned).toEqual(['low']);
  });

  it('exposes the new state immediately, so the screen re-renders what it just reported', () => {
    const h = harness();
    h.binding.load();
    h.binding.update({ ...h.binding.state, quality: 'high', controlLayout: 'mirrored' });
    expect(h.binding.state.quality).toBe('high');
    expect(h.binding.state.controlLayout).toBe('mirrored');
    expect(h.input.mirrored).toBe(true);
  });
});

describe('SettingsBinding — the external (ad) mute', () => {
  // `audio/externalMute.ts` is the sink a portal video ad reaches the audio bus through; this
  // class is the bus's only authority, so this is where the two meet. The property that
  // matters is that it is a FACTOR and not a write: an ad must leave the player's own volumes
  // exactly as it found them.

  afterEach(() => resetExternalMute());

  it('silences both buses while set, and restores the player’s own levels after', () => {
    const h = harness({ master: 1, sfx: 0.5, music: 0.25 });
    h.binding.load();
    expect(h.audio.sfx).toBeCloseTo(0.5);
    expect(h.audio.music).toBeCloseTo(0.25);

    setExternalMute(true);
    expect(h.audio.sfx).toBe(0);
    expect(h.audio.music).toBe(0);

    setExternalMute(false);
    // Back to 0.25, not to a default — the whole reason this is not a second `muted` flag.
    expect(h.audio.sfx).toBeCloseTo(0.5);
    expect(h.audio.music).toBeCloseTo(0.25);
  });

  it('never touches the persisted state the settings screen renders', () => {
    const h = harness({ master: 1, sfx: 0.5, music: 0.25, muted: false });
    h.binding.load();
    setExternalMute(true);
    expect(h.binding.state.muted).toBe(false);
    expect(h.binding.state.sfx).toBeCloseTo(0.5);
    // ...and it is not written through to the store either, so it cannot outlive the ad.
    expect(h.store.load().muted).toBe(false);
  });

  it('keeps a player who muted themselves muted after the ad', () => {
    // The interaction that would be easy to get backwards: releasing the ad's mute must not
    // un-mute a player who had turned the sound off.
    const h = harness({ master: 1, sfx: 0.5, music: 0.25, muted: true });
    h.binding.load();
    expect(h.audio.sfx).toBe(0);
    setExternalMute(true);
    setExternalMute(false);
    expect(h.audio.sfx).toBe(0);
  });

  it('applies at BOOT as well as on change', () => {
    // This file's founding bug shape — a setting that applies on change but not at load.
    // An ad in flight while the settings are (re)loaded has to stay silent.
    setExternalMute(true);
    const h = harness({ master: 1, sfx: 0.5, music: 0.25 });
    h.binding.load();
    expect(h.audio.sfx).toBe(0);
    expect(h.audio.music).toBe(0);
  });

  it('keeps applying the factor across an ordinary settings edit', () => {
    // A volume drag while an ad is playing must not push audio back into the bus.
    const h = harness({ master: 1, sfx: 0.5, music: 0.25 });
    h.binding.load();
    setExternalMute(true);
    h.binding.update({ ...h.binding.state, sfx: 1 });
    expect(h.audio.sfx).toBe(0);
    setExternalMute(false);
    expect(h.audio.sfx).toBeCloseTo(1);
  });
});
