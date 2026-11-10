/**
 * `keyFocus` — the sink between the portal iframe's focus and the two readers that act on it
 * (the move lesson and the Playgama session's hold). Driven with a fake window and document,
 * so every branch runs without a browser.
 *
 * What would fail silently: a boot that never asks for focus, a press inside the frame that
 * does not ask again, a hold that a focus event cannot release, and `attention()` reporting the
 * keys as never having arrived after they did.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  attention, heldForKeys, installKeyFocus, keysReach, onKeyFocus, resetKeyFocus, setAwaitingKeys,
} from './keyFocus';

function fakeWindow(opts: { throwOnFocus?: boolean } = {}) {
  const listeners = new Map<string, () => void>();
  const w = {
    focusCalls: 0,
    focus() {
      w.focusCalls++;
      if (opts.throwOnFocus) throw new Error('refused');
    },
    addEventListener: (type: string, fn: () => void) => void listeners.set(type, fn),
    fire: (type: string) => listeners.get(type)!(),
  };
  return w;
}

afterEach(resetKeyFocus);

describe('keyFocus — with no window installed', () => {
  it('reads as a host with no iframe: the keys reach, nothing is held, no attention fields', () => {
    expect(keysReach()).toBe(true);
    setAwaitingKeys(true);
    expect(heldForKeys()).toBe(false);
    expect(attention()).toBeNull();
  });
});

describe('keyFocus — installed', () => {
  it('asks for focus at boot and again on every press inside the frame', () => {
    const w = fakeWindow();
    installKeyFocus(w, { hasFocus: () => false });
    expect(w.focusCalls).toBe(1);
    w.fire('pointerdown');
    w.fire('pointerdown');
    expect(w.focusCalls).toBe(3);
  });

  it('keysReach follows the document, live', () => {
    let has = false;
    installKeyFocus(fakeWindow(), { hasFocus: () => has });
    expect(keysReach()).toBe(false);
    has = true;
    expect(keysReach()).toBe(true);
  });

  it('holds only while a lesson awaits the keys AND they are elsewhere', () => {
    let has = false;
    installKeyFocus(fakeWindow(), { hasFocus: () => has });
    expect(heldForKeys()).toBe(false);
    setAwaitingKeys(true);
    expect(heldForKeys()).toBe(true);
    has = true;
    expect(heldForKeys()).toBe(false);
    has = false;
    setAwaitingKeys(false);
    expect(heldForKeys()).toBe(false);
  });

  it('attention starts at what the boot found and only ever goes up', () => {
    let has = false;
    const w = fakeWindow();
    installKeyFocus(w, { hasFocus: () => has });
    expect(attention()).toEqual({ focus: false, input: false });
    w.fire('pointerdown');
    expect(attention()).toEqual({ focus: false, input: true });
    has = true; // focus arrived without a `focus` event reaching us first
    expect(attention()).toEqual({ focus: true, input: true });
    has = false;
    expect(attention()).toEqual({ focus: true, input: true });
  });

  it('a boot that already has the keys says so', () => {
    installKeyFocus(fakeWindow(), { hasFocus: () => true });
    expect(attention()).toEqual({ focus: true, input: false });
  });

  it('a focus event marks focus and tells every listener', () => {
    const w = fakeWindow();
    installKeyFocus(w, { hasFocus: () => false });
    const heard: string[] = [];
    onKeyFocus(() => heard.push('a'));
    onKeyFocus(() => heard.push('b'));
    w.fire('focus');
    expect(heard).toEqual(['a', 'b']);
    expect(attention()?.focus).toBe(true);
  });

  it('a host that refuses window.focus() still installs, and a press still counts', () => {
    const w = fakeWindow({ throwOnFocus: true });
    expect(() => installKeyFocus(w, { hasFocus: () => false })).not.toThrow();
    expect(() => w.fire('pointerdown')).not.toThrow();
    expect(attention()).toEqual({ focus: false, input: true });
  });

  it('resetKeyFocus drops the listeners and the window', () => {
    const w = fakeWindow();
    installKeyFocus(w, { hasFocus: () => false });
    const heard: number[] = [];
    onKeyFocus(() => heard.push(1));
    resetKeyFocus();
    expect(keysReach()).toBe(true);
    expect(attention()).toBeNull();
    w.fire('focus'); // the old window's listener is still attached, but nobody is subscribed
    expect(heard).toEqual([]);
  });
});
