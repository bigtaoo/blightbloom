/**
 * `playerAvatar.ts` — the portal picture's seam. What has to hold: only an https URL gets
 * through (it is fetched cross-origin from a remote object's field), listeners fire on a
 * CHANGE and not on a repeat, and one failing listener cannot stop the next.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { onPlayerAvatarChanged, playerAvatar, setPlayerAvatar } from './playerAvatar';

afterEach(() => setPlayerAvatar(null));

describe('playerAvatar', () => {
  it('is null until set, and holds an https URL', () => {
    expect(playerAvatar()).toBeNull();
    setPlayerAvatar('https://images.example/a.png');
    expect(playerAvatar()).toBe('https://images.example/a.png');
  });

  it('refuses what is not an absolute https URL', () => {
    for (const bad of ['http://images.example/a.png', 'javascript:alert(1)', '/a.png', 'https://a b', '', undefined, null]) {
      setPlayerAvatar('https://ok.example/x.png');
      setPlayerAvatar(bad);
      expect(playerAvatar()).toBeNull();
    }
  });

  it('notifies on a change only, and stops after unsubscribe', () => {
    const seen = vi.fn();
    const stop = onPlayerAvatarChanged(seen);
    setPlayerAvatar('https://images.example/a.png');
    setPlayerAvatar('https://images.example/a.png');
    expect(seen).toHaveBeenCalledTimes(1);
    setPlayerAvatar(null);
    expect(seen).toHaveBeenCalledTimes(2);
    stop();
    setPlayerAvatar('https://images.example/b.png');
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it('one listener throwing does not stop the next', () => {
    const second = vi.fn();
    const stopA = onPlayerAvatarChanged(() => {
      throw new Error('redraw failed');
    });
    const stopB = onPlayerAvatarChanged(second);
    expect(() => setPlayerAvatar('https://images.example/a.png')).not.toThrow();
    expect(second).toHaveBeenCalledTimes(1);
    stopA();
    stopB();
  });
});
