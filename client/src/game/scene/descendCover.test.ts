/** `DescendCover` — the black a descend's staged build happens behind. */
import { describe, it, expect } from 'vitest';
import { Container, Graphics } from 'pixi.js';
import { COVER_FADE_MS, DescendCover } from './descendCover';

function setup(): { parent: Container; cover: DescendCover; view: Graphics } {
  const parent = new Container();
  parent.addChild(new Container()); // something already in the UI layer, e.g. the HUD
  const cover = new DescendCover(parent);
  return { parent, cover, view: parent.children[0] as Graphics };
}

describe('DescendCover', () => {
  it('goes UNDER whatever the layer already holds, hidden, and never takes input', () => {
    const { parent, view } = setup();
    expect(parent.children).toHaveLength(2);
    expect(view).toBeInstanceOf(Graphics);
    expect(view.visible).toBe(false);
    expect(view.eventMode).toBe('none');
  });

  it('covers far past any screen, in every direction', () => {
    const b = setup().view.getLocalBounds();
    expect(b.minX).toBeLessThan(-8000);
    expect(b.minY).toBeLessThan(-8000);
    expect(b.maxX).toBeGreaterThan(8000);
    expect(b.maxY).toBeGreaterThan(8000);
  });

  it('shows at full opacity at once, and holds for as long as it is told to', () => {
    const { cover, view } = setup();
    cover.show();
    expect(view.visible).toBe(true);
    expect(view.alpha).toBe(1);
    for (let i = 0; i < 50; i++) cover.update(16, true);
    expect(cover.opacity).toBe(1);
  });

  it('fades out over COVER_FADE_MS once released, and is then hidden', () => {
    const { cover, view } = setup();
    cover.show();
    cover.update(COVER_FADE_MS / 2, false);
    expect(cover.opacity).toBeCloseTo(0.5, 6);
    expect(view.alpha).toBeCloseTo(0.5, 6);
    cover.update(COVER_FADE_MS / 2, false);
    expect(cover.opacity).toBe(0);
    expect(view.visible).toBe(false);
    cover.update(16, false); // and stays down, not negative
    expect(cover.opacity).toBe(0);
  });

  it('hide() removes it at once, mid-fade or mid-hold', () => {
    const { cover, view } = setup();
    cover.show();
    cover.update(40, false);
    cover.hide();
    expect(view.visible).toBe(false);
    expect(cover.opacity).toBe(0);
  });

  it('an update while it is down is a no-op — the idle cost is one comparison', () => {
    const { cover, view } = setup();
    view.alpha = 0.3; // a marker: an update that ran would overwrite it
    cover.update(16, true);
    expect(view.alpha).toBe(0.3);
  });
});
