/**
 * `FormField` — a labelled field drawn on the canvas, edited through `TextInputOverlay`
 * (design/10 "One shell for every menu", 2026-09-27). What is pinned: a password is never drawn
 * in the clear, an empty field shows its placeholder rather than nothing, and `anchorRect` is
 * where the box is on the canvas under every scale above it — the real input lands there.
 */
import { describe, it, expect, vi } from 'vitest';
import { Container, Text } from 'pixi.js';
import { FormField, FIELD_LABEL_H, FIELD_BOX_H, FIELD_H } from './FormField';

function shown(f: FormField): Text {
  return (f as unknown as { shown: Text }).shown;
}

describe('FormField', () => {
  it('shows the placeholder while empty, and the value once it has one', () => {
    const f = new FormField('USERNAME', 300);
    f.setPlaceholder('Tap to type');
    expect(shown(f).text).toBe('Tap to type');
    f.setValue('alice');
    expect(shown(f).text).toBe('alice');
    expect(f.text).toBe('alice');
  });

  it('never draws a password in the clear', () => {
    const f = new FormField('PASSWORD', 300, { password: true });
    f.setValue('hunter22');
    expect(shown(f).text).toBe('••••••••');
    expect(f.text).toBe('hunter22'); // the value itself is kept for the submit
    expect(f.password).toBe(true);
  });

  it('caps the mask, so a long password cannot run out of the box', () => {
    const f = new FormField('PASSWORD', 300, { password: true });
    f.setValue('x'.repeat(64));
    expect(shown(f).text).toHaveLength(24);
  });

  it('relabels', () => {
    const f = new FormField('USERNAME', 300);
    f.setLabel('BENUTZERNAME');
    expect((f as unknown as { caption: Text }).caption.text).toBe('BENUTZERNAME');
  });

  it('takes a tap anywhere on the caption or the box', () => {
    const f = new FormField('USERNAME', 300);
    const onTap = vi.fn();
    f.onTap = onTap;
    f.view.emit('pointertap', {} as never);
    expect(onTap).toHaveBeenCalledOnce();
    const hit = f.view.hitArea as unknown as { width: number; height: number };
    expect([hit.width, hit.height]).toEqual([300, FIELD_H]);
    f.setWidth(200);
    expect((f.view.hitArea as unknown as { width: number }).width).toBe(200);
  });

  it('puts the anchor on the BOX, under the caption, through every scale above it', () => {
    const outer = new Container();
    outer.scale.set(1.5);
    outer.position.set(100, 40);
    const inner = new Container();
    inner.position.set(10, 20);
    const f = new FormField('USERNAME', 300);
    f.view.position.set(0, 50);
    outer.addChild(inner);
    inner.addChild(f.view);
    const r = f.anchorRect();
    expect(r.x).toBeCloseTo(100 + 10 * 1.5, 5);
    expect(r.y).toBeCloseTo(40 + (20 + 50 + FIELD_LABEL_H) * 1.5, 5);
    expect(r.w).toBeCloseTo(300 * 1.5, 5);
    expect(r.h).toBeCloseTo(FIELD_BOX_H * 1.5, 5);
  });

  it('redraws for focus only on a change', () => {
    const f = new FormField('USERNAME', 300);
    const box = (f as unknown as { box: { clear: () => unknown } }).box;
    const spy = vi.spyOn(box, 'clear');
    f.setFocused(true);
    f.setFocused(true);
    f.setFocused(false);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
