/**
 * WebPlatform — the Web `Platform` implementation (design/04). `createApp()` is NOT
 * covered here: it constructs a real Pixi `Application` and calls a real `app.init()`
 * against a real WebGL context, the same class of gap `Game.ts`/`ArenaCanvas.mount()`
 * are documented (daydayup-testing-conventions memory) as needing a live browser, not
 * worth stubbing. `createInput`/`createAudio` are plain factories with no such
 * dependency — fully covered here.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { Application } from 'pixi.js';
import { WebPlatform } from './WebPlatform';
import { WebInput } from './WebInput';
import { WebAudio } from './WebAudio';
import { attention, resetKeyFocus } from '../keyFocus';

describe('WebPlatform', () => {
  it('createInput returns a fresh WebInput, ignoring the app argument (Web input never needs it)', () => {
    const platform = new WebPlatform();
    const input = platform.createInput({} as Application);
    expect(input).toBeInstanceOf(WebInput);
  });

  it('createAudio returns a fresh WebAudio', () => {
    const platform = new WebPlatform();
    expect(platform.createAudio()).toBeInstanceOf(WebAudio);
  });

  it('createInput/createAudio return a NEW instance each call, not a shared singleton', () => {
    const platform = new WebPlatform();
    expect(platform.createInput({} as Application)).not.toBe(platform.createInput({} as Application));
    expect(platform.createAudio()).not.toBe(platform.createAudio());
  });

  describe('the constructor asks for the keys (platform/keyFocus.ts)', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      resetKeyFocus();
    });

    it('installs key focus on the real window when there is one', () => {
      const focus = vi.fn();
      vi.stubGlobal('window', { focus, addEventListener: vi.fn() });
      vi.stubGlobal('document', { hasFocus: () => false });
      new WebPlatform();
      expect(focus).toHaveBeenCalledTimes(1);
      expect(attention()).toEqual({ focus: false, input: false });
    });

    it('does nothing without a window (a test, a host with no DOM)', () => {
      vi.stubGlobal('window', undefined);
      new WebPlatform();
      expect(attention()).toBeNull();
    });
  });
});
