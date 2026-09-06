/**
 * bootError.ts — main.ts/main.wechat.ts's boot() error boundary (ROADMAP: previously a
 * throw anywhere in boot() was just an unhandled promise rejection, leaving the player
 * on an infinite loading spinner with no indication anything failed). Deliberately its
 * own module with no import-time side effects, unlike main.ts itself (importing that
 * would kick off the real boot() sequence — real Platform/Pixi/Game construction).
 *
 * `document` isn't a global in this project's plain-node vitest environment (no jsdom —
 * see game/ui/TextInputOverlay.test.ts's own note), so it's stubbed here with just the
 * `getElementById` surface `reportWebBootFailure` actually touches.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { reportWebBootFailure, reportWeChatBootFailure } from './bootError';

afterEach(() => vi.unstubAllGlobals());

describe('reportWebBootFailure', () => {
  it('logs the error and replaces #boot-loading\'s content with a refresh message', () => {
    const el = { innerHTML: '' };
    vi.stubGlobal('document', { getElementById: (id: string) => (id === 'boot-loading' ? el : null) });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const err = new Error('platform init failed');
    reportWebBootFailure(err);

    expect(errorSpy).toHaveBeenCalledWith('blightbloom: boot failed', err);
    expect(el.innerHTML).toContain('refresh');
    errorSpy.mockRestore();
  });

  it('does not throw if #boot-loading is already gone from the DOM', () => {
    vi.stubGlobal('document', { getElementById: () => null });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => reportWebBootFailure(new Error('boom'))).not.toThrow();
    errorSpy.mockRestore();
  });
});

describe('reportWeChatBootFailure', () => {
  it('logs the error — no DOM to update in the mini-game shell, but it must not vanish silently', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = new Error('wx platform init failed');
    reportWeChatBootFailure(err);
    expect(errorSpy).toHaveBeenCalledWith('blightbloom (wechat): boot failed', err);
    errorSpy.mockRestore();
  });

  it('never touches `document` at all (would throw a ReferenceError in the mini-game shell if it did)', () => {
    // No `document` stub here at all — if reportWeChatBootFailure referenced it, this
    // would throw "document is not defined" exactly as it would in a real mini-game.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => reportWeChatBootFailure(new Error('boom'))).not.toThrow();
    errorSpy.mockRestore();
  });
});
