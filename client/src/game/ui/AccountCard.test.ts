/**
 * `AccountCard` — the lobby's account card (design/10, 2026-09-27). What is pinned: it keeps
 * `Button`'s shape (the three reflection harnesses depend on it), it grows for its longest line
 * without ever shrinking below its floor, and the avatar is the player's own and stable.
 */
import { describe, it, expect } from 'vitest';
import { Graphics, Text, Texture, TextureSource } from 'pixi.js';
import { AccountCard, avatarColor, initialOf } from './AccountCard';

function internals(c: AccountCard) {
  return c as unknown as {
    box: Graphics; hover: Graphics; label: Text; hint: Text; initial: Text;
    iconSprite: { visible: boolean; texture: Texture; scale: { x: number } };
  };
}

describe('AccountCard — Button’s shape', () => {
  it('has the press box at child 0 and the NAME as its first Text', () => {
    const c = new AccountCard('LOGIN', 40);
    expect(c.view.children[0]).toBe(internals(c).box);
    // The initial is a Text too; the harnesses take the FIRST one as the label.
    expect(c.view.children.find((k) => k instanceof Text)).toBe(internals(c).label);
    expect(typeof c.setText).toBe('function');
    expect(typeof c.setIcon).toBe('function');
    expect('onTap' in c).toBe(true);
  });

  it('fires onTap on a tap, and swallows pointerdown so a screen handler does not double-fire', () => {
    const c = new AccountCard('LOGIN', 40);
    let taps = 0;
    c.onTap = () => taps++;
    c.view.emit('pointertap', {} as never);
    expect(taps).toBe(1);
    let stopped = false;
    c.view.emit('pointerdown', { stopPropagation: () => { stopped = true; } } as never);
    expect(stopped).toBe(true);
  });

  it('shows the hover wash only while hovered', () => {
    const c = new AccountCard('LOGIN', 40);
    expect(internals(c).hover.visible).toBe(false);
    c.view.emit('pointerover', {} as never);
    expect(internals(c).hover.visible).toBe(true);
    c.view.emit('pointerout', {} as never);
    expect(internals(c).hover.visible).toBe(false);
  });
});

describe('AccountCard — sizing', () => {
  it('never drops below its floor for a short name', () => {
    const c = new AccountCard('al', 40);
    expect(c.width).toBe(120);
    expect(c.height).toBe(40);
  });

  it('grows for whichever line is longer, and back', () => {
    const c = new AccountCard('al', 40);
    c.setHint('Accedi per salvare i progressi');
    const forHint = c.width;
    expect(forHint).toBeGreaterThan(120);
    c.setText('一二三四五六七八九十一二三四五六');
    expect(c.width).toBeGreaterThan(forHint);
    c.setText('al');
    c.setHint('');
    expect(c.width).toBe(120);
  });

  it('keeps both lines inside the box, left of its right edge', () => {
    const c = new AccountCard('Zaloguj', 40);
    c.setHint('Zaloguj się, by zapisać postęp');
    const { label, hint } = internals(c);
    expect(hint.visible).toBe(true);
    expect(label.y).toBeLessThan(hint.y);
    expect(label.y - 7).toBeGreaterThanOrEqual(0);
    expect(hint.y + 5).toBeLessThanOrEqual(40);
  });

  it('centres the name when there is no hint', () => {
    const c = new AccountCard('alice', 40);
    expect(internals(c).hint.visible).toBe(false);
    expect(internals(c).label.y).toBe(20);
  });
});

describe('AccountCard — the avatar', () => {
  const GLYPH = new Texture({ source: new TextureSource({ width: 64, height: 64 }) });

  it('draws the guest glyph with no signed-in name, and the initial with one', () => {
    const c = new AccountCard('LOGIN', 40);
    c.setIcon(GLYPH, 0x123456);
    expect(internals(c).iconSprite.visible).toBe(true);
    expect(internals(c).initial.visible).toBe(false);
    c.setAvatar('alice');
    expect(internals(c).iconSprite.visible).toBe(false);
    expect(internals(c).initial.visible).toBe(true);
    expect(internals(c).initial.text).toBe('A');
    c.setAvatar(null);
    expect(internals(c).initial.visible).toBe(false);
    expect(internals(c).iconSprite.visible).toBe(true);
  });

  it('draws the guest disc for a name with no drawable initial', () => {
    const c = new AccountCard('LOGIN', 40);
    c.setAvatar('   ');
    expect(internals(c).initial.visible).toBe(false);
  });

  it('draws no glyph when none was given', () => {
    const c = new AccountCard('LOGIN', 40);
    expect(internals(c).iconSprite.visible).toBe(false);
  });

  it('gives a name the same colour every time, and spreads different names across the palette', () => {
    expect(avatarColor('alice')).toBe(avatarColor('alice'));
    const names = ['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'grace', 'heidi', 'ivan', 'judy', 'mallory', 'oscar'];
    expect(new Set(names.map(avatarColor)).size).toBeGreaterThanOrEqual(5);
  });

  it('takes a whole code point as the initial, upper-cased', () => {
    expect(initialOf('alice')).toBe('A');
    expect(initialOf('  émile')).toBe('É');
    expect(initialOf('绽晶')).toBe('绽');
    expect(initialOf('𝒳yz')).toBe('𝒳');
    expect(initialOf('')).toBe('');
  });
});
