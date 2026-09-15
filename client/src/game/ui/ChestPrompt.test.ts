/**
 * The big chest's caption (design/05 "Chest rooms", 2026-09-15, `ENGINE_VERSION` 66).
 *
 * The engine suite proves a big chest opens only while every plate is occupied. What no engine
 * test can see is whether the player was ever told that rule existed — and nothing in the world
 * says it: the plates are drawn, but a ring of discs in an empty room does not read as a gate.
 * So every assertion here is about what the caption SAYS while the player is working it out.
 *
 * The suite that was here the same morning tested a SMALL chest's *"Press E to open"*. That
 * mechanic is gone (a small chest opens on approach), and with it the three strings and both
 * control-scheme cases — kept in mind here only because the one thing this widget must never do
 * again is name a button, and a big chest has none either.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { Chest, Fp } from '@dd/engine';
import { ChestPrompt } from './ChestPrompt';
import { setLocale, resetLocaleForTests, t } from '../../i18n';

afterEach(() => resetLocaleForTests());

const fp = (n: number) => n as Fp;

const big = (occupied: boolean[], id = 2): Chest => ({
  id,
  roomId: 'r1',
  kind: 'big',
  gx: fp(0),
  gy: fp(0),
  mechanisms: occupied.map((o) => ({ gx: fp(0), gy: fp(0), occupied: o })),
  opened: false,
});

function privateOf(p: ChestPrompt) {
  return p as unknown as { titleText: { text: string }; detailText: { text: string } };
}

describe('ChestPrompt — visibility follows the chest in reach', () => {
  it('is hidden with no chest in reach', () => {
    const prompt = new ChestPrompt();
    prompt.update(undefined);
    expect(prompt.isOpen).toBe(false);
  });

  it('opens for a chest in reach and closes again when it goes away', () => {
    const prompt = new ChestPrompt();
    prompt.update(big([false, false]));
    expect(prompt.isOpen).toBe(true);
    prompt.update(undefined);
    expect(prompt.isOpen).toBe(false);
  });
});

describe('ChestPrompt — it counts plates instead of naming a button', () => {
  it('shows the live occupied/total count', () => {
    const prompt = new ChestPrompt();
    prompt.update(big([true, false, false]));
    const v = privateOf(prompt);
    expect(v.titleText.text).toBe(t('hud.chest.bigTitle'));
    expect(v.detailText.text).toBe(t('hud.chest.plates', { on: 1, total: 3 }));
  });

  it('follows a plate being stepped on without the chest moving', () => {
    // The one number here that changes while nothing else does — and the reason the redraw key
    // carries it. A cached caption would freeze at whatever the count was on the frame the
    // player walked into range, which is the worst possible moment for it to stop updating.
    const prompt = new ChestPrompt();
    prompt.update(big([false, false]));
    expect(privateOf(prompt).detailText.text).toBe(t('hud.chest.plates', { on: 0, total: 2 }));
    prompt.update(big([true, false]));
    expect(privateOf(prompt).detailText.text).toBe(t('hud.chest.plates', { on: 1, total: 2 }));
  });

  it('redraws when a DIFFERENT chest comes into range at the same count', () => {
    // Two big chests in one room is authorable, and the key carries the id so the second one
    // is not shown the first one's cached line.
    const prompt = new ChestPrompt();
    prompt.update(big([true, false], 2));
    prompt.update(big([true, false], 3));
    expect(privateOf(prompt).detailText.text).toBe(t('hud.chest.plates', { on: 1, total: 2 }));
  });
});

describe('ChestPrompt — the two things it must not do', () => {
  it('redraws on a locale change with the chest untouched', () => {
    const prompt = new ChestPrompt();
    prompt.update(big([false]));
    const english = privateOf(prompt).detailText.text;
    setLocale('zh');
    prompt.update(big([false]));
    expect(privateOf(prompt).detailText.text).not.toBe(english);
    expect(privateOf(prompt).detailText.text).toBe(t('hud.chest.plates', { on: 0, total: 1 }));
  });

  it('takes no pointer events, so standing at a chest never eats a shot', () => {
    // `WeaponPickupPrompt`/`ShopPrompt` are interactive because the tap IS the action there. No
    // chest reads any input at all now, so anything this panel swallowed would be a shot the
    // player meant to fire at whatever is in the room.
    expect(new ChestPrompt().view.eventMode).toBe('none');
  });
});
