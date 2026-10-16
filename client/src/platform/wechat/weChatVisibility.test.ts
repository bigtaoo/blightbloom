/** The WeChat visibility source and platform split — `weChatVisibility.ts`. */
import { describe, it, expect, vi } from 'vitest';
import { createWeChatVisibility, weChatDevice } from './weChatVisibility';

describe('createWeChatVisibility', () => {
  it('flips `hidden` on onHide / onShow and tells every listener', () => {
    let hide = (): void => undefined;
    let show = (): void => undefined;
    const source = createWeChatVisibility({ onHide: (cb) => void (hide = cb), onShow: (cb) => void (show = cb) });
    expect(source).not.toBeNull();
    const fn = vi.fn(() => source!.hidden);
    source!.addEventListener('visibilitychange', fn);
    expect(source!.hidden).toBe(false);
    hide();
    expect(source!.hidden).toBe(true);
    show();
    expect(fn.mock.results.map((r) => r.value)).toEqual([true, false]);
    source!.removeEventListener('visibilitychange', fn);
    hide();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('is null without both halves', () => {
    expect(createWeChatVisibility({ onHide: () => undefined })).toBeNull();
    expect(createWeChatVisibility({ onShow: () => undefined })).toBeNull();
    expect(createWeChatVisibility({})).toBeNull();
  });
});

describe('weChatDevice', () => {
  it.each([
    ['ios', { os: 'ios', device: 'phone' }],
    ['android', { os: 'android', device: 'phone' }],
    ['windows', { os: 'windows', device: 'desktop' }],
    ['mac', { os: 'macos', device: 'desktop' }],
    ['devtools', { os: 'other', device: 'phone' }],
    [undefined, { os: 'other', device: 'phone' }],
  ] as const)('%s', (platform, want) => {
    expect(weChatDevice(platform)).toEqual(want);
  });
});
