/**
 * WebInput — the desktop keyboard+mouse InputSource, also hosting the shared
 * TouchControls for mobile/Capacitor browsers (design/04). No real DOM here (plain-node
 * vitest, no jsdom, per daydayup-testing-conventions memory) — `window`/the canvas are
 * hand-rolled fakes that capture registered listeners so a test can fire them directly,
 * the same `vi.stubGlobal('window', {...})` pattern already used for other browser-only
 * files in this repo.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WebInput, prefersTouchControls } from './WebInput';
import type { InputCanvas } from '../types';

type Handler = (e: unknown) => void;

function fakeEventTarget() {
  const listeners: Record<string, Handler[]> = {};
  return {
    addEventListener(type: string, fn: Handler) {
      (listeners[type] ??= []).push(fn);
    },
    removeEventListener() {},
    /** Fire a listener. A real `KeyboardEvent` always carries `preventDefault`, and
     *  `WebInput` now calls it for the page-scroll keys — so the fake carries one too,
     *  auto-spied unless the test supplies its own. A fake event without it would make the
     *  production code look like it needed an optional call. */
    fire(type: string, e: Record<string, unknown> = {}) {
      const event = 'preventDefault' in e ? e : { ...e, preventDefault: vi.fn() };
      for (const fn of listeners[type] ?? []) fn(event);
      return event as { preventDefault: ReturnType<typeof vi.fn> };
    },
  };
}

function fakeCanvas(width = 800, height = 600) {
  return {
    ...fakeEventTarget(),
    width,
    height,
    getBoundingClientRect() {
      return { left: 0, top: 0, width: this.width, height: this.height };
    },
  };
}

let win: ReturnType<typeof fakeEventTarget>;
let canvas: ReturnType<typeof fakeCanvas>;
let input: WebInput;

beforeEach(() => {
  win = fakeEventTarget();
  vi.stubGlobal('window', win);
  canvas = fakeCanvas();
  input = new WebInput();
  input.attach(canvas as unknown as InputCanvas);
});

describe('WebInput — keyboard movement', () => {
  it('is idle with no keys held', () => {
    const inp = input.read();
    expect(inp.moveX).toBe(0);
    expect(inp.moveY).toBe(0);
    expect(inp.firing).toBe(false);
  });

  it('WASD/arrow keys drive a normalized move vector', () => {
    win.fire('keydown', { code: 'KeyW' });
    expect(input.read().moveY).toBeCloseTo(-1);
    win.fire('keyup', { code: 'KeyW' });

    win.fire('keydown', { code: 'ArrowDown' });
    expect(input.read().moveY).toBeCloseTo(1);
  });

  it('diagonal movement is normalized (not faster than a cardinal direction)', () => {
    win.fire('keydown', { code: 'KeyW' });
    win.fire('keydown', { code: 'KeyD' });
    const inp = input.read();
    expect(Math.hypot(inp.moveX, inp.moveY)).toBeCloseTo(1);
    expect(inp.moveX).toBeGreaterThan(0);
    expect(inp.moveY).toBeLessThan(0);
  });

  it('releasing a key stops driving that axis', () => {
    win.fire('keydown', { code: 'KeyA' });
    expect(input.read().moveX).toBeCloseTo(-1);
    win.fire('keyup', { code: 'KeyA' });
    expect(input.read().moveX).toBe(0);
  });

  it('E or Space held maps to interacting', () => {
    expect(input.read().interacting).toBe(false);
    win.fire('keydown', { code: 'KeyE' });
    expect(input.read().interacting).toBe(true);
    win.fire('keyup', { code: 'KeyE' });
    win.fire('keydown', { code: 'Space' });
    expect(input.read().interacting).toBe(true);
  });
});

describe('WebInput — page-scroll keys are cancelled', () => {
  // Why this exists: the game is embedded in somebody else's scrollable page on a portal,
  // and the CrazyGames SDK docs and requirements both ask for arrow/space defaults to be
  // cancelled by name. Space is the worse of the two — it is a game key here (the revive
  // channel), so without this a held revive scrolls the host page under the player.

  it('cancels the default for the arrows and Space', () => {
    for (const code of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']) {
      const e = win.fire('keydown', { code });
      expect(e.preventDefault, code).toHaveBeenCalledOnce();
      win.fire('keyup', { code });
    }
  });

  it('leaves every other key alone', () => {
    // Not a blanket preventDefault: cancelling everything breaks browser shortcuts and, for
    // Tab specifically, keyboard navigation out of the frame.
    for (const code of ['KeyW', 'KeyE', 'Digit1', 'Tab', 'Escape', 'F9']) {
      const e = win.fire('keydown', { code });
      expect(e.preventDefault, code).not.toHaveBeenCalled();
      win.fire('keyup', { code });
    }
  });

  it('cancels on every repeat of a HELD key, not just the first', () => {
    // A held arrow fires `keydown` continuously. The cancellation therefore has to happen
    // BEFORE the already-held early return, or the page scrolls from the second event on —
    // which is the shape this test pins and the reason for the ordering in the handler.
    const first = win.fire('keydown', { code: 'ArrowUp' });
    const repeat = win.fire('keydown', { code: 'ArrowUp' });
    expect(first.preventDefault).toHaveBeenCalledOnce();
    expect(repeat.preventDefault).toHaveBeenCalledOnce();
  });

  it('yields to a focused text field', () => {
    // `game/ui/TextInputOverlay.ts` puts a real `<input>` over the canvas for the login and
    // party-code screens. Space and the arrows are editing keys in there: cancelling them
    // would stop the player typing a space in a username and freeze the caret.
    vi.stubGlobal('document', { activeElement: { tagName: 'INPUT' } });
    const e = win.fire('keydown', { code: 'Space' });
    expect(e.preventDefault).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe('prefersTouchControls', () => {
  it('is true for a coarse primary pointer — a phone or tablet', () => {
    expect(prefersTouchControls((q) => ({ matches: q === '(pointer: coarse)' }))).toBe(true);
  });

  it('is false for a fine primary pointer, even on a touchscreen laptop', () => {
    // The reason the query is `pointer` and not `any-pointer`: a touchscreen laptop has a
    // coarse pointer AVAILABLE but a mouse as its primary, and drawing a twin-stick overlay
    // over a mouse session would be a regression on desktop.
    expect(prefersTouchControls(() => ({ matches: false }))).toBe(false);
  });

  it('is false when there is nothing to ask', () => {
    expect(prefersTouchControls(undefined)).toBe(false);
    expect(
      prefersTouchControls(() => {
        throw new Error('no matchMedia');
      }),
    ).toBe(false);
  });
});

describe('WebInput — touch controls are visible before the first touch', () => {
  it('declares a touch session to TouchControls on a coarse-pointer device', () => {
    // The bug: `TouchVisual.active` used to be set only by the first `pointerDown`, so a
    // phone player opened the game and saw no joystick, no fire button and no weapon
    // buttons until they had already guessed where to press.
    win = fakeEventTarget();
    vi.stubGlobal('window', { ...win, matchMedia: () => ({ matches: true }) });
    const touchInput = new WebInput();
    touchInput.attach(fakeCanvas() as unknown as InputCanvas);
    expect(touchInput.getTouchVisual().active).toBe(true);
  });

  it('leaves them hidden on a mouse session until something is touched', () => {
    // `input` comes from `beforeEach`, whose fake `window` has no `matchMedia` at all.
    expect(input.getTouchVisual().active).toBe(false);
  });
});

describe('WebInput — weapon-swap keys (edge-detected)', () => {
  it('Digit1/Digit2 fire onSwitchWeapon once per fresh press, not while held', () => {
    const switched: number[] = [];
    input.onSwitchWeapon = (slot) => switched.push(slot);

    win.fire('keydown', { code: 'Digit1' });
    win.fire('keydown', { code: 'Digit1' }); // held/repeat — must not re-fire
    expect(switched).toEqual([1]);

    win.fire('keyup', { code: 'Digit1' });
    win.fire('keydown', { code: 'Digit1' }); // fresh press again
    expect(switched).toEqual([1, 1]);

    win.fire('keydown', { code: 'Digit2' });
    expect(switched).toEqual([1, 1, 2]);
  });
});

describe('WebInput — mouse fire', () => {
  it('left mousedown on the canvas fires; mouseup on the window releases it', () => {
    expect(input.read().firing).toBe(false);
    canvas.fire('mousedown', { button: 0 });
    expect(input.read().firing).toBe(true);
    win.fire('mouseup', { button: 0 });
    expect(input.read().firing).toBe(false);
  });

  it('ignores non-left mouse buttons', () => {
    canvas.fire('mousedown', { button: 2 }); // right-click
    expect(input.read().firing).toBe(false);
  });
});

describe('WebInput — touch overrides keyboard/mouse while active', () => {
  it('a touch on the canvas takes over read(), even with keys/mouse also active', () => {
    win.fire('keydown', { code: 'KeyD' });
    canvas.fire('mousedown', { button: 0 });
    expect(input.read().moveX).toBeGreaterThan(0); // keyboard driving, pre-touch

    canvas.fire('touchstart', {
      preventDefault() {},
      changedTouches: [{ identifier: 1, clientX: 100, clientY: 100 }],
    });
    const inp = input.read();
    // Touch state now wins — a move stick opened at (100,100) reports zero deflection
    // until dragged, not the keyboard's moveX.
    expect(inp.moveX).toBe(0);
    expect(inp.moveY).toBe(0);
  });

  it('a touch on the on-screen INTERACT button sets interacting=true with no keyboard involved — the real gap this pass closed', () => {
    // Interact button center for an 800x600 canvas, standard (non-mirrored) layout:
    // unit=600, r=48, m=72, gap=115.2 → weapon1 cx=728, weapon2 cx=612.8,
    // interact cx=497.6, cy=72 (same corner-cluster math WebInput — layout's own test
    // above already pins down for weapon1).
    expect(input.read().interacting).toBe(false); // KeyE not held, no prior touch
    canvas.fire('touchstart', {
      preventDefault() {},
      changedTouches: [{ identifier: 5, clientX: 497.6, clientY: 72 }],
    });
    expect(input.read().interacting).toBe(true);
    expect(input.getTouchVisual().interact.pressed).toBe(true);

    canvas.fire('touchend', {
      preventDefault() {},
      changedTouches: [{ identifier: 5, clientX: 497.6, clientY: 72 }],
    });
    expect(input.read().interacting).toBe(false);
    expect(input.getTouchVisual().interact.pressed).toBe(false);
  });

  it('touchmove/touchend drive the underlying TouchControls, reflected in getTouchVisual()', () => {
    canvas.fire('touchstart', {
      preventDefault() {},
      changedTouches: [{ identifier: 1, clientX: 100, clientY: 100 }],
    });
    canvas.fire('touchmove', {
      preventDefault() {},
      changedTouches: [{ identifier: 1, clientX: 150, clientY: 100 }],
    });
    expect(input.getTouchVisual().move).toEqual({ ox: 100, oy: 100, dx: 50, dy: 0 });

    canvas.fire('touchend', {
      preventDefault() {},
      changedTouches: [{ identifier: 1, clientX: 150, clientY: 100 }],
    });
    expect(input.getTouchVisual().move).toBeNull();
  });
});

describe('WebInput — layout', () => {
  it('lays out TouchControls against the canvas size immediately on attach', () => {
    // weapon1 sits near the top-right corner for an 800x600 canvas (standard layout) —
    // if layout() were never called at attach time this would still be {cx:0,cy:0,r:0}.
    const v = input.getTouchVisual();
    expect(v.weapon1.cx).toBeGreaterThan(400);
    expect(v.weapon1.r).toBeGreaterThan(0);
  });

  it('re-lays out on window resize using the canvas size at that moment', () => {
    const before = input.getTouchVisual().weapon1.cx;
    canvas.width = 400;
    canvas.height = 300;
    win.fire('resize');
    expect(input.getTouchVisual().weapon1.cx).not.toBe(before);
  });
});

describe('WebInput — setControlMirror', () => {
  it('delegates to the underlying TouchControls, swapping the weapon-button corner', () => {
    const before = input.getTouchVisual().weapon1.cx;
    input.setControlMirror(true);
    expect(input.getTouchVisual().weapon1.cx).toBeLessThan(before);
  });
});
