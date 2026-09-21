import { describe, it, expect, afterEach } from 'vitest';
import { Container, EventBoundary, FederatedContainer, FederatedPointerEvent, extensions } from 'pixi.js';
import type { PickupItem, Fp } from '@dd/engine';
import { WeaponPickupPrompt } from './WeaponPickupPrompt';
import { setLocale, resetLocaleForTests } from '../../i18n';
import { useLocale } from '../../i18n/loadLocale';

afterEach(() => resetLocaleForTests());

const fp = (n: number) => n as Fp;

function pickup(id: number, weaponId: string): PickupItem {
  return { id, kind: 'weapon', gx: fp(0), gy: fp(0), spawnTick: 0, alive: true, weaponId };
}

function privateOf(p: WeaponPickupPrompt) {
  return p as unknown as { titleText: { text: string }; rows: Array<{ onTap: (() => void) | null }> };
}

describe('WeaponPickupPrompt — visibility follows the nearby list', () => {
  it('is hidden with no nearby weapons', () => {
    const prompt = new WeaponPickupPrompt();
    prompt.update([]);
    expect(prompt.view.visible).toBe(false);
    expect(prompt.isOpen).toBe(false);
  });

  it('becomes visible with one row per nearby weapon', () => {
    const prompt = new WeaponPickupPrompt();
    prompt.update([pickup(1, 'blaster'), pickup(2, 'saber')]);
    expect(prompt.isOpen).toBe(true);
    expect(privateOf(prompt).rows.length).toBe(2);
  });

  it('hides again once the list goes empty', () => {
    const prompt = new WeaponPickupPrompt();
    prompt.update([pickup(1, 'blaster')]);
    expect(prompt.isOpen).toBe(true);
    prompt.update([]);
    expect(prompt.isOpen).toBe(false);
  });
});

describe('WeaponPickupPrompt — click-to-collect', () => {
  it('tapping a row reports that item\'s id, not another one\'s', () => {
    const prompt = new WeaponPickupPrompt();
    prompt.update([pickup(11, 'blaster'), pickup(22, 'saber')]);
    const picked: number[] = [];
    prompt.onPick = (id) => picked.push(id);

    const rows = privateOf(prompt).rows;
    rows[1]!.onTap?.();
    rows[0]!.onTap?.();

    expect(picked).toEqual([22, 11]);
  });
});

describe('WeaponPickupPrompt — close behavior (stays hidden until the set changes)', () => {
  it('close() hides the panel even though the same weapons are still nearby', () => {
    const prompt = new WeaponPickupPrompt();
    const list = [pickup(1, 'blaster')];
    prompt.update(list);
    expect(prompt.isOpen).toBe(true);

    (prompt as unknown as { closeBtn: { onTap: () => void } }).closeBtn.onTap();
    expect(prompt.isOpen).toBe(false);

    prompt.update(list); // identical set — stays closed
    expect(prompt.isOpen).toBe(false);
  });

  it('reopens once the nearby set actually changes', () => {
    const prompt = new WeaponPickupPrompt();
    prompt.update([pickup(1, 'blaster')]);
    (prompt as unknown as { closeBtn: { onTap: () => void } }).closeBtn.onTap();
    expect(prompt.isOpen).toBe(false);

    prompt.update([pickup(1, 'blaster'), pickup(2, 'saber')]); // a second weapon entered range
    expect(prompt.isOpen).toBe(true);
  });

  it('reopens after leaving the area and coming back to the same set', () => {
    const prompt = new WeaponPickupPrompt();
    const list = [pickup(1, 'blaster')];
    prompt.update(list);
    (prompt as unknown as { closeBtn: { onTap: () => void } }).closeBtn.onTap();

    prompt.update([]); // walked away
    prompt.update(list); // walked back to the same weapon
    expect(prompt.isOpen).toBe(true);
  });
});

describe('WeaponPickupPrompt — i18n (design/17-i18n.md)', () => {
  it('translates the title under zh and reverts under en', async () => {
    const prompt = new WeaponPickupPrompt();
    await useLocale('zh');
    prompt.update([pickup(1, 'blaster')]);
    const zhTitle = privateOf(prompt).titleText.text;
    setLocale('en');
    prompt.update([pickup(2, 'saber')]); // different id set so rebuild actually re-runs
    const enTitle = privateOf(prompt).titleText.text;
    expect(zhTitle).not.toBe(enTitle);
  });
});


/**
 * Presses go through Pixi's own dispatcher (`EventBoundary`) rather than by poking a
 * widget's callback: the phase this panel listens in IS the behavior under test — its
 * listener is capture-phase precisely because `Button` stops `pointerdown` from bubbling
 * (widgets.ts), so a fake that called the handler directly would pass whichever phase the
 * real code had registered in.
 *
 * Two entry points, because the two cases genuinely differ. `pressOn` dispatches at a
 * known target and exercises PROPAGATION only; `pressAt` runs the real hit test — but only
 * in the panel's own untransformed space, since nothing headless updates a world transform.
 * A child's `position` is therefore invisible to `pressAt`, which is exactly the trap that
 * made an earlier version of the row case silently resolve to the panel background and pass
 * either way; that is why the row case dispatches at the row instead of aiming at it.
 */
function boundaryFor(prompt: WeaponPickupPrompt): { boundary: EventBoundary; root: Container } {
  // What a real `Application.init()` does on the way up (environment-browser/browserAll):
  // hit-testing and dispatch both read `isInteractive()`/`eventMode` off this mixin, and
  // nothing in a headless suite installs it.
  extensions.mixin(Container, FederatedContainer);
  const root = new Container();
  root.addChild(prompt.view);
  return { boundary: new EventBoundary(root), root };
}

function pointerDown(boundary: EventBoundary): FederatedPointerEvent {
  const e = new FederatedPointerEvent(boundary);
  e.type = 'pointerdown';
  e.button = 0;
  e.buttons = 1;
  e.pointerId = 1;
  e.pointerType = 'mouse';
  e.isPrimary = true;
  e.nativeEvent = {} as PointerEvent;
  return e;
}

/** Press whose hit test already resolved to `target` — the row button the player clicked. */
function pressOn(prompt: WeaponPickupPrompt, target: Container): void {
  const { boundary } = boundaryFor(prompt);
  const e = pointerDown(boundary);
  e.target = target;
  boundary.dispatchEvent(e, 'pointerdown');
}

/** Press at a screen point, hit-tested for real against the panel's own `hitArea`. */
function pressAt(prompt: WeaponPickupPrompt, x: number, y: number): void {
  const { boundary } = boundaryFor(prompt);
  const e = pointerDown(boundary);
  e.global.set(x, y);
  boundary.mapEvent(e);
}

function rowViewOf(prompt: WeaponPickupPrompt, i: number): Container {
  return (prompt as unknown as { rows: Array<{ view: Container }> }).rows[i]!.view;
}

describe('WeaponPickupPrompt — a press on the panel is UI, a press anywhere else is an attack', () => {
  // 2026-09-02 live report: *"附近有可以拾取的武器时，不要阻断了玩家攻击"*. Fire used to be
  // gated on this panel's `isOpen` (GameLoop), which disarmed the player for as long as any
  // floor weapon was in range — most of a fight. Now the panel swallows only presses that
  // hit it, so these three cases are the whole of what the pickup panel costs the player.
  it('reports a press that lands on a row, which Button stops from bubbling', () => {
    const prompt = new WeaponPickupPrompt();
    prompt.update([pickup(1, 'blaster')]);
    let presses = 0;
    prompt.onPressStart = () => presses++;

    pressOn(prompt, rowViewOf(prompt, 0));
    expect(presses).toBe(1);
  });

  it('reports a press on the chrome between rows, not just one on a button', () => {
    const prompt = new WeaponPickupPrompt();
    prompt.update([pickup(1, 'blaster'), pickup(2, 'saber')]);
    let presses = 0;
    prompt.onPressStart = () => presses++;

    pressAt(prompt, 4, 4); // top-left corner: panel padding, no widget under it
    expect(presses).toBe(1);
  });

  it('swallows nothing once it is closed — a dismissed panel is not a dead zone', () => {
    // `×` hides the panel but leaves it parented at the same place. If a hidden panel
    // still took presses, closing it would trade a disarmed player for an invisible
    // rectangle that eats attacks — the same bug wearing a different hat.
    const prompt = new WeaponPickupPrompt();
    const list = [pickup(1, 'blaster')];
    prompt.update(list);
    let presses = 0;
    prompt.onPressStart = () => presses++;

    (prompt as unknown as { closeBtn: { onTap: () => void } }).closeBtn.onTap();
    prompt.update(list); // same set — stays closed
    pressAt(prompt, 4, 4); // exactly where a press DID register while it was open

    expect(prompt.isOpen).toBe(false);
    expect(presses).toBe(0);
  });

  it('stays silent for a press outside the panel — that click is a shot', () => {
    const prompt = new WeaponPickupPrompt();
    prompt.update([pickup(1, 'blaster')]);
    let presses = 0;
    prompt.onPressStart = () => presses++;

    pressAt(prompt, 900, 500); // out in the world
    expect(presses).toBe(0);
  });
});
