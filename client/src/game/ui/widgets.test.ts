import { describe, it, expect, afterEach, vi } from 'vitest';
import { Container, EventBoundary, FederatedContainer, Graphics, Text, Texture, extensions } from 'pixi.js';
import { Panel, Button, Slider } from './widgets';
import { setUiAudio } from '../../audio/uiSound';
import type { AudioBus } from '../../platform/types';

// Panel's border option (design/10 legibility fix, 2026-08-02): a flat near-black fill
// at low alpha reads as invisible over the app's own black backdrop — borderColor
// gives it a readable edge regardless of what's behind it. Covers the opt-in stroke
// plus the pre-existing same-size skip-redraw guard `layout()` already had.
describe('Panel', () => {
  it('draws its scrim to the requested size', () => {
    const p = new Panel({ radius: 8 });
    p.layout(120, 60);
    const scrim = p.view.children[0] as Graphics;
    const b = scrim.getLocalBounds();
    expect(b.width).toBeCloseTo(120, 0);
    expect(b.height).toBeCloseTo(60, 0);
  });

  it('adds an inset border stroke when borderColor is set, without changing the panel footprint', () => {
    const bordered = new Panel({ radius: 8, borderColor: 0x4c566a });
    bordered.layout(120, 60);
    const scrim = bordered.view.children[0] as Graphics;
    const b = scrim.getLocalBounds();
    expect(b.width).toBeCloseTo(120, 0);
    expect(b.height).toBeCloseTo(60, 0);
  });

  it('draws no border stroke when borderColor is omitted (default, pre-existing look)', () => {
    const p = new Panel({ radius: 8 });
    expect(() => p.layout(120, 60)).not.toThrow();
  });

  it('is a no-op re-layout at the same size (skips redraw)', () => {
    const p = new Panel({ radius: 8, borderColor: 0x4c566a });
    p.layout(120, 60);
    const scrim = p.view.children[0] as Graphics;
    const clearSpy = vi.spyOn(scrim, 'clear');
    p.layout(120, 60);
    expect(clearSpy).not.toHaveBeenCalled();
  });

  it('redraws when the size actually changes', () => {
    const p = new Panel({ radius: 8, borderColor: 0x4c566a });
    p.layout(120, 60);
    const scrim = p.view.children[0] as Graphics;
    const clearSpy = vi.spyOn(scrim, 'clear');
    p.layout(200, 60);
    expect(clearSpy).toHaveBeenCalled();
  });
});

// Button's border option (design/10 legibility fix, 2026-08-02, same as Panel's above) —
// a flat fill alone reads as low-contrast wherever a button sits over a background image
// brighter than the fill itself (MainMenu's hub art). Covers the opt-in stroke, the fill
// staying fully opaque (was 0.9 — another part of the same fix), and the pre-existing
// label/icon behavior this change must not have broken.
describe('Button', () => {
  it('sizes its hit area to the given w/h, with or without a border', () => {
    // Bounds are read off the `bg` Graphics directly (children[0]), not the whole
    // `view` — `view` also holds the label Text, and measuring a Text's bounds needs
    // a real canvas, which this repo's plain-node vitest doesn't have (no jsdom/canvas
    // here, same constraint noted in ui/textWidth.ts).
    const plain = new Button('X', { w: 100, h: 40 });
    const plainBounds = (plain.view.children[0] as Graphics).getLocalBounds();
    expect(plainBounds.width).toBeCloseTo(100, 0);
    expect(plainBounds.height).toBeCloseTo(40, 0);

    // The border stroke's line width pushes bounds out by half its width — loosen the
    // tolerance a bit rather than pin an exact pixel, which isn't the invariant this
    // test cares about.
    const bordered = new Button('X', { w: 100, h: 40, borderColor: 0x718096 });
    const borderedBounds = (bordered.view.children[0] as Graphics).getLocalBounds();
    expect(borderedBounds.width).toBeCloseTo(100, -1);
    expect(borderedBounds.height).toBeCloseTo(40, -1);
  });

  it('draws no border stroke when borderColor is omitted (default, pre-existing look)', () => {
    expect(() => new Button('X', { w: 100, h: 40 })).not.toThrow();
  });

  it('sets the label text at construction and via setText', () => {
    const b = new Button('HELLO', { w: 100, h: 40 });
    const label = b.view.children[1] as Text;
    expect(label.text).toBe('HELLO');
    b.setText('BYE');
    expect(label.text).toBe('BYE');
  });

  it('fires onTap exactly once per pointertap, and only when it is set', () => {
    // `emit` is typed to require a real FederatedPointerEvent payload; the handler
    // itself ignores it, so a plain cast is fine here rather than constructing one.
    const emitTap = (view: { emit: (event: string) => void }) => view.emit('pointertap');
    const b = new Button('X', { w: 100, h: 40 });
    expect(() => emitTap(b.view)).not.toThrow();
    let calls = 0;
    b.onTap = () => { calls += 1; };
    emitTap(b.view);
    emitTap(b.view);
    expect(calls).toBe(2);
  });

  // "Press" is not "activate". A Button must only commit on the full down-then-up
  // gesture, because the frames between the two belong to whatever screen the press
  // started on — anything that acts on `pointerdown` alone can navigate that screen away
  // and swallow the tap that was actually intended (a real historical bug: a raw
  // mouse-down poll once did exactly that to every menu button, before design/10 gave
  // every screen real Buttons — see ENGINE_VERSION_HISTORY-style precedent in
  // `Screens.ts`'s own doc comment for the same class of bug on the result screen,
  // fixed 2026-08-17). The `pointerdown` listener here exists only to stop propagation.
  it('does not fire onTap on pointerdown alone — only the completed tap commits', () => {
    // Unlike the pointertap handler above, the pointerdown one DOES read its payload
    // (it calls stopPropagation), so this emit needs a stub rather than a bare cast.
    let stopped = 0;
    const ev = { stopPropagation: () => { stopped += 1; } };
    const emit = (view: { emit: (event: string, ev?: unknown) => void }, name: string) => view.emit(name, ev);
    const b = new Button('X', { w: 100, h: 40 });
    let calls = 0;
    b.onTap = () => { calls += 1; };

    emit(b.view, 'pointerdown');
    expect(calls).toBe(0);
    expect(stopped).toBe(1); // it consumed the press, but did not commit the action
    emit(b.view, 'pointerup');
    expect(calls).toBe(0); // Pixi synthesizes pointertap itself; up alone is not it

    emit(b.view, 'pointertap');
    expect(calls).toBe(1);
  });

  it('setIcon adds a chip + sprite and re-anchors the label to sit left-of-center', () => {
    const b = new Button('X', { w: 100, h: 40 });
    const label = b.view.children[1] as Text;
    expect(b.view.children.length).toBe(2);
    expect(label.anchor.x).toBe(0.5); // centered, no icon

    b.setIcon(Texture.WHITE);
    expect(b.view.children.length).toBe(4);
    expect(label.anchor.x).toBe(0); // left-anchored to sit right of the icon now

    b.setIcon(undefined);
    expect(b.view.children.length).toBe(2);
    expect(label.anchor.x).toBe(0.5); // back to centered once the icon is cleared
  });

  it('setIcon accepts an optional chip color without throwing', () => {
    const b = new Button('X', { w: 100, h: 40 });
    expect(() => b.setIcon(Texture.WHITE, 0x6b46c1)).not.toThrow();
    expect(b.view.children.length).toBe(4);
  });

  // Which CHILD takes the press (2026-09-02). The box does; the label is `eventMode:
  // 'none'` and is not a hit target at all. Two things ride on that, and neither is
  // visible from the emit-based cases above, which bypass hit-testing entirely:
  //   - a press must still land on the button when the pointer is over its LABEL — i.e.
  //     marking the text 'none' must not have punched a hole in the middle of the box;
  //   - `Text.containsPoint` measures its glyphs, and measuring needs a real canvas, so
  //     an interactive label makes any hit test over this button THROW in a headless
  //     suite (and costs a text measurement per press in the app).
  // Hit-testing needs the events mixin a browser `Application.init()` would have
  // installed, and works only in untransformed space (nothing headless updates a world
  // transform) — so the button stays at the origin here.
  it('takes a press on its box, never on its label', () => {
    extensions.mixin(Container, FederatedContainer);
    const b = new Button('HELLO', { w: 100, h: 40 });
    const root = new Container();
    root.addChild(b.view);
    const boundary = new EventBoundary(root);

    const label = b.view.children[1] as Text;
    expect(label.eventMode).toBe('none');
    // Dead centre — over the label's own glyphs, which is where a real player clicks.
    expect(boundary.hitTest(50, 20)).toBe(b.view);
    expect(boundary.hitTest(300, 300)).not.toBe(b.view); // and nowhere near it
  });
});

// `autoWidth` (design/17-i18n.md follow-up, 2026-08-14): a translated label can run
// longer than the pixel width picked for its English source string (Settings.ts's
// "LANGUAGE: {name}"/"CONTROLS: {mode}" buttons, e.g. Russian "ВКЛЮЧИТЬ ЗВУК"), and the
// old fixed-width box let it overflow instead of resizing. Off by default so every
// other call site (50+ across the app) keeps its exact pre-existing fixed-width look.
// Widths are read off `bg`'s Graphics bounds, same convention as the "sizes its hit
// area" test above — no real canvas needed.
describe('Button — autoWidth', () => {
  function bgWidth(b: Button): number {
    return (b.view.children[0] as Graphics).getLocalBounds().width;
  }

  it('keeps the fixed width when autoWidth is not set, even for text that would overflow it', () => {
    const b = new Button('A MUCH LONGER LABEL THAN THE BOX', { w: 100, h: 40 });
    expect(bgWidth(b)).toBeCloseTo(100, 0);
  });

  it('grows the box to fit longer text once autoWidth is set', () => {
    const short = new Button('X', { w: 100, h: 40, autoWidth: true });
    const long = new Button('A MUCH LONGER LABEL THAN THE BOX', { w: 100, h: 40, autoWidth: true });
    expect(bgWidth(long)).toBeGreaterThan(bgWidth(short));
    expect(bgWidth(long)).toBeGreaterThan(100);
  });

  it('never shrinks below the given w — it is a minimum, not a target, for short text', () => {
    const b = new Button('X', { w: 200, h: 40, autoWidth: true });
    expect(bgWidth(b)).toBeCloseTo(200, 0);
  });

  it('re-measures and grows on setText, not just at construction', () => {
    const b = new Button('X', { w: 100, h: 40, autoWidth: true });
    const before = bgWidth(b);
    b.setText('A MUCH LONGER LABEL THAN THE BOX');
    expect(bgWidth(b)).toBeGreaterThan(before);
  });

  it('re-centers the label on the new width after a resizing setText', () => {
    const b = new Button('X', { w: 100, h: 40, autoWidth: true });
    b.setText('A MUCH LONGER LABEL THAN THE BOX');
    const label = b.view.children[1] as Text;
    expect(label.position.x).toBeCloseTo(bgWidth(b) / 2, 0);
  });

  it('exposes the current width via the `width` getter, matching the drawn box', () => {
    const b = new Button('A MUCH LONGER LABEL THAN THE BOX', { w: 100, h: 40, autoWidth: true });
    expect(b.width).toBeCloseTo(bgWidth(b), 0);
  });

  it('setText on a non-autoWidth button does not resize the box', () => {
    const b = new Button('X', { w: 100, h: 40 });
    const before = bgWidth(b);
    b.setText('A MUCH LONGER LABEL THAN THE BOX');
    expect(bgWidth(b)).toBeCloseTo(before, 0);
  });
});

describe('Button — the icon offset, and what used to undo it', () => {
  const labelOf = (b: Button) => b.view.children.find((c) => c instanceof Text) as Text;
  /** Where `setIcon` puts the label: hard against the right of the chip, left-anchored. */
  const offsetFor = (h: number) => 8 + (h - 8) + 8;

  it('moves the label right of the chip and anchors it there', () => {
    const b = new Button('X', { w: 200, h: 40 });
    b.setIcon(Texture.WHITE);
    expect(labelOf(b).anchor.x).toBe(0);
    expect(labelOf(b).position.x).toBe(offsetFor(40));
  });

  it('KEEPS that offset across a redraw — setFill, setBorder, and an autoWidth setText', () => {
    // The regression this exists for (2026-09-10). `redraw()` re-centred the label
    // unconditionally and `setIcon` was the only thing that ever applied the offset, so any
    // later redraw dropped a left-anchored label at the middle of the box — running off the
    // right edge by however far the offset had been. `LobbyRoutes.setSoloPrimary` calls
    // `setFill`, on the portal build only, so this would have shipped there and nowhere else.
    for (const [name, mutate] of [
      ['setFill', (b: Button) => b.setFill(0x2f855a)],
      ['setBorder', (b: Button) => b.setBorder(0x68d391)],
      ['autoWidth setText', (b: Button) => b.setText('A MUCH LONGER LABEL THAN THE BOX')],
    ] as Array<[string, (b: Button) => void]>) {
      const b = new Button('X', { w: 200, h: 40, borderColor: 0x718096, autoWidth: name === 'autoWidth setText' });
      b.setIcon(Texture.WHITE);
      mutate(b);
      expect(labelOf(b).anchor.x, name).toBe(0);
      expect(labelOf(b).position.x, name).toBe(offsetFor(40));
    }
  });

  it('re-centres the label when the icon is cleared', () => {
    // The other direction, so the restore is not just "always offset".
    const b = new Button('X', { w: 200, h: 40 });
    b.setIcon(Texture.WHITE);
    b.setIcon(undefined);
    expect(labelOf(b).anchor.x).toBe(0.5);
    expect(labelOf(b).position.x).toBe(100);
  });
});

describe('Slider — drag lifecycle', () => {
  function draggingOf(s: Slider): boolean {
    return (s as unknown as { dragging: boolean }).dragging;
  }
  const down = (view: { emit: (e: string, ev?: unknown) => void }, x: number) =>
    view.emit('pointerdown', { global: { x, y: 0 } });
  const move = (target: { emit: (e: string, ev?: unknown) => void }, x: number) =>
    target.emit('globalpointermove', { global: { x, y: 0 } });
  // No payload for these — same bare-cast convention Button's own `emitTap` test uses.
  const fire = (target: { emit: (e: string) => void }, name: string) => target.emit(name);

  it('starts dragging on pointerdown and updates value on globalpointermove', () => {
    const s = new Slider({ w: 200 });
    down(s.view, 100);
    expect(draggingOf(s)).toBe(true);
    expect(s.get()).toBeCloseTo(0.5, 5);
  });

  it('stops dragging on pointerup', () => {
    const s = new Slider({ w: 200 });
    down(s.view, 100);
    fire(s.view, 'pointerup');
    expect(draggingOf(s)).toBe(false);
  });

  it('stops dragging on pointerupoutside', () => {
    const s = new Slider({ w: 200 });
    down(s.view, 100);
    fire(s.view, 'pointerupoutside');
    expect(draggingOf(s)).toBe(false);
  });

  it('stops dragging on pointercancel (an OS-level interruption mid-drag, e.g. an incoming call) — previously stuck true forever', () => {
    const s = new Slider({ w: 200 });
    down(s.view, 100);
    expect(draggingOf(s)).toBe(true);
    fire(s.view, 'pointercancel');
    expect(draggingOf(s)).toBe(false);
  });

  it('after a pointercancel, a later globalpointermove no longer drags this slider', () => {
    const s = new Slider({ w: 200 });
    down(s.view, 0);
    fire(s.view, 'pointercancel');
    move(s.view, 200); // an unrelated later move over the same surface
    expect(s.get()).toBe(0); // never dragged by it — cancel already cleared `dragging`
  });

  it('a pointercancel on a SHARED dragSurface (Settings.ts\'s three sliders) protects THIS slider from a later unrelated move on that surface', () => {
    const surface = new Container();
    const s = new Slider({ w: 200, dragSurface: surface });
    down(s.view, 0); // pointerdown is always on the slider's own view, cancel/move on the shared surface
    fire(surface, 'pointercancel');
    move(surface, 200);
    expect(s.get()).toBe(0);
  });
});

/**
 * UI sound (design/11's screen-layer cues, added 2026-08-30). These widgets are where ~40
 * buttons across ~14 screens get their click, so what is pinned here is the DEFAULT (audible
 * without opting in) and the two opt-outs that carry meaning, plus the call ORDER, which is
 * not cosmetic: the settings mute button is one of these, and its handler is what applies the
 * new volume.
 */
describe('Button — the UI cue', () => {
  const emitTap = (view: { emit: (event: string) => void }) => view.emit('pointertap');

  /** Records cues in the order they reach the bus, interleaved with anything the test pushes
   *  itself — the sequence is the assertion in the ordering case below. */
  function recorder() {
    const log: string[] = [];
    const bus: AudioBus = {
      preload: async () => {},
      play: (cue) => { log.push(cue); },
      setSfxVolume: () => {},
      setMusicVolume: () => {},
      updateMusic: () => {},
      invalidateMusic: () => {},
      resume: () => {},
    };
    setUiAudio(bus);
    return log;
  }

  afterEach(() => setUiAudio(null));

  it('plays ui.tap by default, once per press', () => {
    const log = recorder();
    const b = new Button('PLAY', { w: 100, h: 40 });
    emitTap(b.view);
    emitTap(b.view);
    expect(log).toEqual(['ui.tap', 'ui.tap']);
  });

  it('plays a button’s own cue when it means something else', () => {
    const log = recorder();
    emitTap(new Button('BACK', { w: 100, h: 40, sound: 'ui.back' }).view);
    emitTap(new Button('MUTE', { w: 100, h: 40, sound: 'ui.toggle' }).view);
    expect(log).toEqual(['ui.back', 'ui.toggle']);
  });

  it('stays silent when the OUTCOME decides the sound (forge craft rows, ACQUIRE)', () => {
    // Not "this button has no sound" — `ForgeActions` plays ui.tap or ui.denied depending on
    // whether the transaction did anything, which the widget cannot know.
    const log = recorder();
    const b = new Button('CRAFT', { w: 100, h: 40, sound: 'silent' });
    b.onTap = () => {};
    emitTap(b.view);
    expect(log).toEqual([]);
  });

  it('runs onTap BEFORE the cue, so muting ends in silence instead of a beep', () => {
    // The settings mute button applies the new volume in `onTap`. Reversed, the click would be
    // played at the OLD volume: audible when you mute, silent when you unmute — backwards.
    const log = recorder();
    const b = new Button('MUTE', { w: 100, h: 40, sound: 'ui.toggle' });
    b.onTap = () => log.push('handler');
    emitTap(b.view);
    expect(log).toEqual(['handler', 'ui.toggle']);
  });

  it('still clicks with no handler attached', () => {
    // A button wired to nothing is a UI bug, but it should not also be a silent one — the
    // press is still feedback that the hit area was found.
    const log = recorder();
    emitTap(new Button('X', { w: 40, h: 40 }).view);
    expect(log).toEqual(['ui.tap']);
  });

  it('makes no sound at all with no bus attached (every widget test, and a headless boot)', () => {
    setUiAudio(null);
    const b = new Button('X', { w: 40, h: 40 });
    expect(() => emitTap(b.view)).not.toThrow();
  });
});

describe('Slider — the commit cue', () => {
  const down = (view: { emit: (e: string, ev?: unknown) => void }, x: number) =>
    view.emit('pointerdown', { global: { x, y: 0 } });
  const move = (target: { emit: (e: string, ev?: unknown) => void }, x: number) =>
    target.emit('globalpointermove', { global: { x, y: 0 } });
  const fire = (target: { emit: (e: string) => void }, name: string) => target.emit(name);

  function recorder() {
    const log: string[] = [];
    setUiAudio({
      preload: async () => {}, play: (cue) => { log.push(cue); },
      setSfxVolume: () => {}, setMusicVolume: () => {}, updateMusic: () => {}, invalidateMusic: () => {}, resume: () => {},
    });
    return log;
  }

  afterEach(() => setUiAudio(null));

  it('ticks once on release, not once per pixel of travel', () => {
    // The tick is also the level preview: it plays through the bus the slider just changed,
    // so releasing the SFX slider is how you hear what you set it to.
    const log = recorder();
    const s = new Slider({ w: 200 });
    down(s.view, 40);
    move(s.view, 80);
    move(s.view, 120);
    expect(log).toEqual([]); // nothing during the drag
    fire(s.view, 'pointerup');
    expect(log).toEqual(['ui.toggle']);
  });

  it('ticks on a release that lands outside the track', () => {
    const log = recorder();
    const s = new Slider({ w: 200 });
    down(s.view, 40);
    fire(s.view, 'pointerupoutside');
    expect(log).toEqual(['ui.toggle']);
  });

  it('says nothing when an OS interruption cancels the drag', () => {
    // An incoming call is not the player committing a value.
    const log = recorder();
    const s = new Slider({ w: 200 });
    down(s.view, 40);
    fire(s.view, 'pointercancel');
    expect(log).toEqual([]);
  });

  it('only the slider being dragged ticks, though all three share a drag surface', () => {
    // Settings.ts gives its three sliders one `dragSurface`, so EVERY pointerup on that screen
    // reaches all three. Without the `dragging` guard, one release would tick three times.
    const log = recorder();
    const surface = new Container();
    const master = new Slider({ w: 200, dragSurface: surface });
    const sfx = new Slider({ w: 200, dragSurface: surface });
    const music = new Slider({ w: 200, dragSurface: surface });
    expect([master, sfx, music]).toHaveLength(3);
    down(sfx.view, 100);
    fire(surface, 'pointerup');
    expect(log).toEqual(['ui.toggle']);
  });

  it('a release with no drag in progress is silent', () => {
    const log = recorder();
    const s = new Slider({ w: 200 });
    fire(s.view, 'pointerup');
    expect(log).toEqual([]);
  });
});
