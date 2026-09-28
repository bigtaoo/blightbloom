/**
 * The menu shell (design/10 "One shell for every menu", 2026-09-27): `MenuShell`, the framed
 * `MenuSheet` it centres, and the theme tokens both draw with.
 *
 * What is pinned is what the audit behind it complained about, one property each: the sheet
 * scales UP with the viewport the way the lobby does (and never past what fits), BACK is in
 * the same corner on every screen, the backdrop is the screen view's child 0 (what
 * `viewportFit` and `menuCoversWorld` both rely on), and the content origin is where a screen
 * builds from.
 */
import { describe, it, expect, vi } from 'vitest';
import { Container } from 'pixi.js';
import { MenuShell, SHELL_EDGE, SHELL_CHROME_H } from './MenuShell';
import { MenuSheet, SHEET_PAD, SHEET_TITLE_H } from './MenuSheet';
import { menuText, MENU_BUTTONS, MENU_COLORS } from './menuTheme';
import { LOBBY_MAX_SCALE } from './lobbyScale';
import { Button } from './widgets';

function internals(s: MenuShell) {
  return s as unknown as { root: Container; chrome: Container };
}

describe('MenuShell — mounting', () => {
  it('puts the backdrop first and the shell second, ahead of anything the screen already had', () => {
    const shell = new MenuShell({ title: 'ACCOUNT', back: 'BACK' });
    const screen = new Container();
    const own = new Container();
    screen.addChild(own);
    shell.mount(screen);
    expect(screen.children[0]).toBe(shell.backdrop.view);
    expect(screen.children[1]).toBe(shell.view);
    expect(screen.children[2]).toBe(own);
  });

  it('wires BACK to onBack, set after construction', () => {
    const shell = new MenuShell({ title: 'T', back: 'BACK' });
    const onBack = vi.fn();
    shell.onBack = onBack;
    (shell.backBtn as unknown as { onTap: () => void }).onTap();
    expect(onBack).toHaveBeenCalledOnce();
  });
});

describe('MenuShell — layout', () => {
  it('scales the sheet up on a desktop window, the way the lobby does, and centres it', () => {
    const shell = new MenuShell({ title: 'T', back: 'BACK' });
    shell.layout(1280, 720, 460, 300);
    const k = 720 / 640; // lobbyScale's height-bound answer here, and the sheet fits under it
    expect(shell.scale).toBeCloseTo(k, 6);
    const { root } = internals(shell);
    expect(root.scale.x).toBeCloseTo(k, 6);
    expect(root.x).toBeCloseTo((1280 - 460 * k) / 2, 6);
    expect(root.y).toBeCloseTo((720 - 300 * k) / 2, 6);
  });

  it('never scales past the lobby cap, however big the window', () => {
    const shell = new MenuShell({ title: 'T', back: 'BACK' });
    shell.layout(4000, 3000, 460, 300);
    expect(shell.scale).toBe(LOBBY_MAX_SCALE);
  });

  it('shrinks a sheet too tall for the room under the chrome row, and keeps it on screen', () => {
    const shell = new MenuShell({ title: 'T', back: 'BACK' });
    shell.layout(1385, 640, 460, 700);
    expect(shell.scale).toBeLessThan(1);
    const { root } = internals(shell);
    expect(root.y).toBeGreaterThanOrEqual(0);
    expect(root.y + 700 * shell.scale).toBeLessThanOrEqual(640);
  });

  it('shrinks a sheet too wide for the window', () => {
    const shell = new MenuShell({ title: 'T', back: 'BACK' });
    shell.layout(390, 844, 460, 300);
    const { root } = internals(shell);
    expect(root.x).toBeGreaterThanOrEqual(0);
    expect(root.x + 460 * shell.scale).toBeLessThanOrEqual(390);
  });

  it('pins BACK to the top-left corner at the lobby chips\' inset, scaled with the sheet', () => {
    const shell = new MenuShell({ title: 'T', back: 'BACK' });
    shell.layout(1280, 720, 460, 300);
    const { chrome } = internals(shell);
    expect([chrome.x, chrome.y]).toEqual([SHELL_EDGE * shell.scale, SHELL_EDGE * shell.scale]);
    expect(chrome.scale.x).toBe(shell.scale);
  });

  it('pushes a sheet wide enough to reach the BACK chip down below it — and only then', () => {
    const wide = new MenuShell({ title: 'T', back: 'BACK' });
    wide.layout(800, 700, 760, 100);
    const chromeBottom = (SHELL_EDGE + SHELL_CHROME_H) * wide.scale;
    expect(internals(wide).root.y).toBeGreaterThan(chromeBottom);

    // A narrow sheet on a short window may rise above the chip's bottom edge: it cannot hit it.
    const narrow = new MenuShell({ title: 'T', back: 'BACK' });
    narrow.layout(1280, 720, 300, 600);
    expect(internals(narrow).root.y).toBeLessThan((SHELL_EDGE + SHELL_CHROME_H) * narrow.scale);
  });

  it('pins a corner chip top-RIGHT, at the same inset and scale as BACK', () => {
    const shell = new MenuShell({ title: 'T', back: 'BACK' });
    const chip = new Button('SETTINGS', { w: 120, h: SHELL_CHROME_H, fontSize: 13 });
    shell.setCorner(chip);
    shell.layout(1280, 720, 460, 300);
    const k = shell.scale;
    expect(chip.view.scale.x).toBe(k);
    expect(chip.view.x).toBeCloseTo(1280 - (SHELL_EDGE + 120) * k);
    expect(chip.view.y).toBeCloseTo(SHELL_EDGE * k);
    // Not reparented: the chip stays wherever its owner put it.
    expect(chip.view.parent).toBeNull();
  });

  it('clears a corner chip WIDER than BACK too, since the sheet is centred', () => {
    // A tall 520-wide sheet in 800: centred, it rises above the chips' bottom edge, which is
    // fine beside a narrow BACK chip and not beside a 200px corner chip.
    const without = new MenuShell({ title: 'T', back: 'B' });
    without.layout(800, 700, 520, 600);
    expect(internals(without).root.y).toBeLessThan((SHELL_EDGE + SHELL_CHROME_H) * without.scale);

    const withWide = new MenuShell({ title: 'T', back: 'B' });
    withWide.setCorner(new Button('X', { w: 200, h: SHELL_CHROME_H, fontSize: 13 }));
    withWide.layout(800, 700, 520, 600);
    expect(internals(withWide).root.y).toBeGreaterThan((SHELL_EDGE + SHELL_CHROME_H) * withWide.scale);
  });

  it('hands back the content area in the sheet\'s own units, and puts `content` at its corner', () => {
    const shell = new MenuShell({ title: 'T', back: 'BACK' });
    const area = shell.layout(1280, 720, 460, 400);
    expect(area.w).toBe(460 - SHEET_PAD * 2);
    expect([shell.content.x, shell.content.y]).toEqual([SHEET_PAD, SHEET_TITLE_H + 18]);
    expect(area.h).toBe(400 - SHEET_TITLE_H - 18 - SHEET_PAD);
  });

  it('passes the frame clock to the backdrop', () => {
    const shell = new MenuShell({ title: 'T', back: 'BACK' });
    const spy = vi.spyOn(shell.backdrop, 'update');
    shell.update(16);
    expect(spy).toHaveBeenCalledWith(16);
  });

  it('retitles and relabels', () => {
    const shell = new MenuShell({ title: 'A', back: 'B' });
    shell.setTitle('KONTO');
    shell.setBack('ZURÜCK');
    expect(shell.sheet.title.text).toBe('KONTO');
    expect((shell.backBtn as unknown as { label: { text: string } }).label.text).toBe('ZURÜCK');
    shell.layout(1280, 720, 460, 300);
    expect(() => shell.sharpen()).not.toThrow();
  });
});

describe('MenuSheet', () => {
  it('starts the content under the title plate when there is a title', () => {
    const sheet = new MenuSheet('SETTINGS');
    expect(sheet.layout(400, 300)).toEqual({ x: SHEET_PAD, y: SHEET_TITLE_H + 18, w: 400 - SHEET_PAD * 2, h: 300 - SHEET_TITLE_H - 18 - SHEET_PAD });
    expect([sheet.width, sheet.height]).toEqual([400, 300]);
  });

  it('starts it at the padding when the title is empty, and hides the title', () => {
    const sheet = new MenuSheet('SETTINGS');
    sheet.layout(400, 300);
    sheet.setTitle('');
    expect(sheet.title.visible).toBe(false);
    expect(sheet.layout(400, 300)).toEqual({ x: SHEET_PAD, y: SHEET_PAD, w: 400 - SHEET_PAD * 2, h: 300 - SHEET_PAD * 2 });
  });

  it('centres the title on the plate', () => {
    const sheet = new MenuSheet('X');
    sheet.layout(400, 300);
    expect(sheet.title.x).toBe(200);
  });

  it('holds no press target — the reflection harnesses must never find a button in it', () => {
    const sheet = new MenuSheet('X');
    for (const child of sheet.view.children) expect(child.eventMode).toBe('none');
  });
});

describe('menuTheme', () => {
  it('hands out a fresh style per call, so one text retuning its wrap does not retune them all', () => {
    const a = menuText('body');
    const b = menuText('body', { wordWrapWidth: 99 });
    a.wordWrapWidth = 10;
    expect(menuText('body').wordWrapWidth).toBeUndefined();
    expect(b.wordWrapWidth).toBe(99);
  });

  it('keeps labels monospace — the width estimates the layouts use only hold for it', () => {
    for (const role of ['title', 'heading', 'label', 'value'] as const) expect(menuText(role).fontFamily).toBe('monospace');
  });

  it('gives the one primary the go-green every screen has used since 2026-08-02', () => {
    expect(MENU_BUTTONS.primary.color).toBe(MENU_COLORS.go);
    expect(MENU_BUTTONS.danger.color).not.toBe(MENU_BUTTONS.primary.color);
  });
});
