/**
 * The WeChat shell's stand-in for `document.visibilitychange` (design/21 §2.9): a
 * {@link VisibilitySource} driven by `wx.onHide` / `wx.onShow`, so the playtime clock stops
 * while the player is in a chat rather than counting it as play. The shell has no way to
 * unregister either callback, so "removing" a listener only stops it being called.
 */
import type { VisibilitySource } from '../../net/analyticsInstall';
import type { OsFamily, DeviceClass } from '../../net/analyticsEvents';

export function createWeChatVisibility(api: { onHide?: (cb: () => void) => void; onShow?: (cb: () => void) => void }): VisibilitySource | null {
  // Without both halves there is no honest answer: a hide with no show would freeze the
  // clock for the rest of the visit. `null` makes the install count the visit as visible.
  if (typeof api.onHide !== 'function' || typeof api.onShow !== 'function') return null;
  const listeners = new Set<() => void>();
  const source: VisibilitySource = {
    hidden: false,
    addEventListener: (_type, fn) => void listeners.add(fn),
    removeEventListener: (_type, fn) => void listeners.delete(fn),
  };
  const set = (hidden: boolean): void => {
    source.hidden = hidden;
    for (const fn of listeners) fn();
  };
  api.onHide(() => set(true));
  api.onShow(() => set(false));
  return source;
}

/** `wx.getDeviceInfo().platform` mapped onto the analytics OS family, and the device class
 *  it implies: the desktop WeChat clients run mini-games too, and are not phones. */
export function weChatDevice(platform: string | undefined): { os: OsFamily; device: DeviceClass } {
  switch (platform) {
    case 'ios':
      return { os: 'ios', device: 'phone' };
    case 'android':
      return { os: 'android', device: 'phone' };
    case 'windows':
      return { os: 'windows', device: 'desktop' };
    case 'mac':
      return { os: 'macos', device: 'desktop' };
    default:
      return { os: 'other', device: 'phone' };
  }
}
