/**
 * The chest caption (design/05 "Chest rooms", 2026-09-15).
 *
 * The engine suite proves `ChestSystem` opens a chest for a player holding INTERACT in reach.
 * What no engine test can see is whether the player was ever told INTERACT exists — and it did
 * not: a chest has no art, no sound, and no tutorial hint names the button. The report this
 * widget answers was a chest the player was standing on, reported as unopenable, that opens on
 * the first frame a key arrives. So every assertion here is about what the caption SAYS, per
 * kind and per control scheme, because a sentence naming a button this device does not have is
 * the same failure one layer along.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { Chest, Fp } from '@dd/engine';
import { ChestPrompt } from './ChestPrompt';
import { setLocale, resetLocaleForTests, t } from '../../i18n';

afterEach(() => resetLocaleForTests());

const fp = (n: number) => n as Fp;

const small = (): Chest => ({ id: 1, roomId: 'r1', kind: 'small', gx: fp(0), gy: fp(0), mechanisms: [], opened: false });

const big = (occupied: boolean[]): Chest => ({
  id: 2,
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
    prompt.update(undefined, false);
    expect(prompt.isOpen).toBe(false);
  });

  it('opens for a chest in reach and closes again when it goes away', () => {
    const prompt = new ChestPrompt();
    prompt.update(small(), false);
    expect(prompt.isOpen).toBe(true);
    prompt.update(undefined, false);
    expect(prompt.isOpen).toBe(false);
  });
});

describe('ChestPrompt — a small chest names the control this player actually has', () => {
  it('says the E key on a keyboard', () => {
    const prompt = new ChestPrompt();
    prompt.update(small(), false);
    const v = privateOf(prompt);
    expect(v.titleText.text).toBe(t('hud.chest.title'));
    expect(v.detailText.text).toBe(t('hud.chest.openKeys'));
  });

  it('says the touch button on a touch session', () => {
    // Not a cosmetic swap: a phone has no E key at all, so the keyboard sentence there is a
    // dead end of exactly the kind this widget exists to remove.
    const prompt = new ChestPrompt();
    prompt.update(small(), true);
    expect(privateOf(prompt).detailText.text).toBe(t('hud.chest.openTouch'));
    expect(t('hud.chest.openTouch')).not.toBe(t('hud.chest.openKeys'));
  });

  it('redraws when the control scheme changes under it', () => {
    // The redraw key carries `touch` for this: a player who picks up a controller-free tablet
    // mid-run gets the other sentence, rather than the cached one from the first frame.
    const prompt = new ChestPrompt();
    prompt.update(small(), false);
    prompt.update(small(), true);
    expect(privateOf(prompt).detailText.text).toBe(t('hud.chest.openTouch'));
  });
});

describe('ChestPrompt — a big chest counts plates instead of naming a button', () => {
  it('shows the live occupied/total count', () => {
    const prompt = new ChestPrompt();
    prompt.update(big([true, false, false]), false);
    const v = privateOf(prompt);
    expect(v.titleText.text).toBe(t('hud.chest.bigTitle'));
    expect(v.detailText.text).toBe(t('hud.chest.plates', { on: 1, total: 3 }));
  });

  it('follows a plate being stepped on without the chest moving', () => {
    // The one number here that changes while nothing else does — and the reason the redraw key
    // carries it. A cached caption would freeze at whatever the count was on the frame the
    // player walked into range, which is the worst possible moment for it to stop updating.
    const prompt = new ChestPrompt();
    prompt.update(big([false, false]), false);
    expect(privateOf(prompt).detailText.text).toBe(t('hud.chest.plates', { on: 0, total: 2 }));
    prompt.update(big([true, false]), false);
    expect(privateOf(prompt).detailText.text).toBe(t('hud.chest.plates', { on: 1, total: 2 }));
  });

  it('never names a button, in any locale', () => {
    // A big chest has no button: it opens when every plate is occupied. Telling a player to
    // press something would be teaching a control that does nothing to this chest.
    const prompt = new ChestPrompt();
    for (const loc of ['en', 'zh'] as const) {
      setLocale(loc);
      prompt.update(big([false]), false);
      expect(privateOf(prompt).detailText.text).not.toBe(t('hud.chest.openKeys'));
      expect(privateOf(prompt).detailText.text).not.toBe(t('hud.chest.openTouch'));
    }
  });
});

describe('ChestPrompt — the two things it must not do', () => {
  it('redraws on a locale change with the chest untouched', () => {
    const prompt = new ChestPrompt();
    prompt.update(small(), false);
    const english = privateOf(prompt).detailText.text;
    setLocale('zh');
    prompt.update(small(), false);
    expect(privateOf(prompt).detailText.text).not.toBe(english);
    expect(privateOf(prompt).detailText.text).toBe(t('hud.chest.openKeys'));
  });

  it('takes no pointer events, so standing at a chest never eats a shot', () => {
    // `WeaponPickupPrompt`/`ShopPrompt` are interactive because the tap IS the action there. A
    // chest has no command of its own — only the INTERACT hold — so anything this panel
    // swallowed would be a shot the player meant to fire at whatever is in the room.
    expect(new ChestPrompt().view.eventMode).toBe('none');
  });
});
