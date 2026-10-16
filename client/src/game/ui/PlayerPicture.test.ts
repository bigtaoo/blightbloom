/**
 * `PlayerPicture` — the portal avatar disc. Everything about a remote picture may fail, and
 * the property that matters is that every failure ends with the disc HIDDEN (the label then
 * sits where it always did), including the one that is invisible in a manual check: a load
 * that lands after the player switched accounts must not paint the previous player's face.
 */
import { describe, expect, it, vi } from 'vitest';
import { Texture } from 'pixi.js';
import { PlayerPicture, loadRemotePicture } from './PlayerPicture';

function tex(w: number, h: number): Texture {
  return { width: w, height: h } as unknown as Texture;
}

/** A loader whose answers the test releases by hand, so ordering is the test's to choose. */
function manualLoader() {
  const pending = new Map<string, (t: Texture | null) => void>();
  const load = (url: string) => new Promise<Texture | null>((r) => pending.set(url, r));
  return { load, release: (url: string, t: Texture | null) => pending.get(url)!(t) };
}

describe('PlayerPicture', () => {
  it('is hidden until a picture has loaded, then covers the disc', async () => {
    const pic = new PlayerPicture(40, async () => tex(80, 160));
    expect(pic.shown).toBe(false);
    const settled = vi.fn();
    await pic.setUrl('https://images.example/a.png', settled);
    expect(pic.shown).toBe(true);
    expect(settled).toHaveBeenCalledTimes(1);
    // Cover: the SHORT side fits the disc (80 → 40, scale 0.5), the long one overflows,
    // centred — its overflow is what the circular mask trims.
    const sprite = pic.view.children[0];
    expect(sprite.scale.x).toBe(0.5);
    expect(sprite.position.x).toBe(0);
    expect(sprite.position.y).toBe((40 - 160 * 0.5) / 2);
  });

  it('stays hidden when the load fails or yields an empty texture', async () => {
    for (const answer of [null, tex(0, 0)]) {
      const pic = new PlayerPicture(40, async () => answer);
      const settled = vi.fn();
      await pic.setUrl('https://images.example/a.png', settled);
      expect(pic.shown).toBe(false);
      expect(settled).toHaveBeenCalledTimes(1);
    }
  });

  it('hides on null, and a repeat of the same URL does not reload', async () => {
    const load = vi.fn(async () => tex(10, 10));
    const pic = new PlayerPicture(40, load);
    await pic.setUrl('https://images.example/a.png');
    await pic.setUrl('https://images.example/a.png');
    expect(load).toHaveBeenCalledTimes(1);
    const settled = vi.fn();
    await pic.setUrl(null, settled);
    expect(pic.shown).toBe(false);
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it('a load that lands after the player changed is discarded', async () => {
    const m = manualLoader();
    const pic = new PlayerPicture(40, m.load);
    const first = pic.setUrl('https://images.example/a.png');
    const second = pic.setUrl('https://images.example/b.png');
    m.release('https://images.example/b.png', tex(10, 10));
    await second;
    m.release('https://images.example/a.png', tex(99, 99));
    await first;
    expect(pic.shown).toBe(true);
    expect(pic.view.children[0].scale.x).toBe(4); // b's 10px, not a's 99px
  });

  it('a load that lands after sign-out leaves the disc hidden', async () => {
    const m = manualLoader();
    const pic = new PlayerPicture(40, m.load);
    const first = pic.setUrl('https://images.example/a.png');
    await pic.setUrl(null);
    m.release('https://images.example/a.png', tex(10, 10));
    await first;
    expect(pic.shown).toBe(false);
  });

  it('the default loader answers null rather than rejecting when the fetch fails', async () => {
    // No network in the test environment: the load fails, and that is the case under test.
    await expect(loadRemotePicture('https://invalid.example/none.png')).resolves.toBeNull();
  });
});
