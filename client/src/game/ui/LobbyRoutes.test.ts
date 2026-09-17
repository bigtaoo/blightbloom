/**
 * The lobby's route rows, and in particular the CONTINUE row added 2026-09-17 (design/10).
 *
 * Three paths the acceptance for that row named, all here: the row APPEARS for a resumable
 * save, it is GONE when there is none, and the hierarchy it changes resolves to exactly one
 * green button in each of the four states (save × portal). `MainMenu.test.ts` covers the
 * shell's half — the provider, the card growing, and which top row a portal draws.
 *
 * `installFakeTextCanvas` for the same reason every screen test here uses it: Pixi's `Text`
 * wants a canvas to measure glyphs and there is none, and the caption assertion below is a
 * width measurement. Read a passing `zh` width as "not evidence" — the fake charges 0.6em
 * per character and CJK is nearer a full em (`screens/labelFit.test.ts` has the table).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { Text } from 'pixi.js';
import { installFakeTextCanvas } from '../screens/fakeTextCanvas';
import { LobbyRoutes, LOBBY_ROUTES_W, LOBBY_ROUTES_H, LOBBY_CONTINUE_H } from './LobbyRoutes';
import { LOCALES, setLocale, resetLocaleForTests, t } from '../../i18n';
import type { SavedRunSummary } from '../match/runSave';

installFakeTextCanvas();

afterEach(() => resetLocaleForTests());

const SAVED: SavedRunSummary = { floorIndex: 2, ticks: 9000, savedAtMs: 0 };

interface Btn {
  label: { text: string };
  onTap: (() => void) | null;
  color: number;
  view: { visible: boolean; position: { x: number; y: number } };
}

function privateOf(r: LobbyRoutes) {
  return r as unknown as {
    continueBtn: Btn;
    continueCaption: { text: string; visible: boolean; position: { x: number; y: number } } & Text;
    soloBtn: Btn;
    coopBtn: Btn;
    tutorialBtn: Btn;
  };
}

const GREEN = 0x2f855a;

describe('the CONTINUE row appears only for a run this build can resume', () => {
  it('is hidden with no save — which is the default, so a caller that never sets it is safe', () => {
    const r = new LobbyRoutes();
    r.layout(400, 100);
    const p = privateOf(r);
    expect(p.continueBtn.view.visible).toBe(false);
    expect(p.continueCaption.visible).toBe(false);
    expect(r.height).toBe(LOBBY_ROUTES_H);
  });

  it('appears, with a caption naming the floor and the time played', () => {
    const r = new LobbyRoutes();
    r.setContinue(SAVED);
    r.layout(400, 100);
    const p = privateOf(r);
    expect(p.continueBtn.view.visible).toBe(true);
    expect(p.continueCaption.visible).toBe(true);
    // 1-based floor and mm:ss off 9000 ticks at 30 Hz — the same arithmetic the Forge's own
    // saved-run line does, asserted on the OUTPUT so the two cannot drift apart silently.
    expect(p.continueCaption.text).toBe(t('mainMenu.continueRunAt', { floor: 3, m: 5, ss: '00' }));
    expect(p.continueCaption.text).toContain('3');
    expect(p.continueCaption.text).toContain('5:00');
  });

  it('goes away again when the offer is withdrawn', () => {
    const r = new LobbyRoutes();
    r.setContinue(SAVED);
    r.setContinue(null);
    r.layout(400, 100);
    const p = privateOf(r);
    expect(p.continueBtn.view.visible).toBe(false);
    expect(p.continueCaption.visible).toBe(false);
    expect(p.continueCaption.text).toBe(''); // not a stale line under a hidden button
    expect(r.height).toBe(LOBBY_ROUTES_H);
  });

  it('routes a tap to onContinue, and nowhere near SOLO', () => {
    const r = new LobbyRoutes();
    const hits: string[] = [];
    r.onContinue = () => hits.push('continue');
    r.onSolo = () => hits.push('solo');
    r.setContinue(SAVED);
    privateOf(r).continueBtn.onTap?.();
    expect(hits).toEqual(['continue']);
  });
});

describe('exactly one primary, and it is the topmost row that starts a run', () => {
  /** [has a save, this block owns the primary] → which row is green. */
  const CASES: Array<[string, SavedRunSummary | null, boolean, 'continue' | 'solo' | 'neither']> = [
    ['no save, ordinary build', null, true, 'solo'],
    ['saved run, ordinary build', SAVED, true, 'continue'],
    // On a portal the shell's own PLAY holds the green when there is nothing to continue;
    // when there IS, the shell hides PLAY and hands this block the primary back, which is
    // why there is no fourth row here where both are plain.
    ['no save, portal', null, false, 'neither'],
    ['saved run, portal-with-PLAY-still-up', SAVED, false, 'neither'],
  ];

  it.each(CASES)('%s', (_name, saved, ownsPrimary, expected) => {
    const r = new LobbyRoutes();
    r.setSoloPrimary(ownsPrimary);
    r.setContinue(saved);
    const p = privateOf(r);
    expect(p.continueBtn.color === GREEN).toBe(expected === 'continue');
    expect(p.soloBtn.color === GREEN).toBe(expected === 'solo');
    // Never two. The 2026-08-02 report this rule comes from read as "the click went to the
    // wrong page" when the routing had been correct all along.
    expect([p.continueBtn.color, p.soloBtn.color].filter((c) => c === GREEN).length)
      .toBeLessThanOrEqual(1);
  });

  it('re-resolves when the offer arrives AFTER the host has been decided', () => {
    // The real call order: the assembly calls `setSoloPrimary` once at boot, and `show()`
    // pushes a save in on every entry to the lobby. A hierarchy computed only in the first
    // of those would leave SOLO green under a CONTINUE row.
    const r = new LobbyRoutes();
    r.setSoloPrimary(true);
    expect(privateOf(r).soloBtn.color).toBe(GREEN);
    r.setContinue(SAVED);
    expect(privateOf(r).soloBtn.color).not.toBe(GREEN);
    expect(privateOf(r).continueBtn.color).toBe(GREEN);
  });
});

describe('the rows below it move down rather than sharing its slot', () => {
  it('pushes every other route down by exactly the block it adds', () => {
    const plain = new LobbyRoutes();
    plain.layout(400, 100);
    const saved = new LobbyRoutes();
    saved.setContinue(SAVED);
    saved.layout(400, 100);

    const a = privateOf(plain);
    const b = privateOf(saved);
    expect(saved.height).toBe(LOBBY_ROUTES_H + LOBBY_CONTINUE_H);
    // CONTINUE takes the slot SOLO used to sit in, and SOLO — with everything under it —
    // moves down a whole block. Nothing lands where a different row was, which is the
    // mis-tap the pause menu's SAVE & QUIT row is laid out to avoid.
    expect(b.continueBtn.view.position.y).toBe(a.soloBtn.view.position.y);
    expect(b.soloBtn.view.position.y).toBe(a.soloBtn.view.position.y + LOBBY_CONTINUE_H);
    expect(b.coopBtn.view.position.y).toBe(a.coopBtn.view.position.y + LOBBY_CONTINUE_H);
    expect(b.tutorialBtn.view.position.y).toBe(a.tutorialBtn.view.position.y + LOBBY_CONTINUE_H);
  });

  it('draws the caption inside the block it reserved, not over the row below', () => {
    const r = new LobbyRoutes();
    r.setContinue(SAVED);
    r.layout(400, 100);
    const p = privateOf(r);
    const capTop = p.continueCaption.position.y;
    expect(capTop).toBeGreaterThan(p.continueBtn.view.position.y);
    expect(capTop + p.continueCaption.height).toBeLessThanOrEqual(p.soloBtn.view.position.y);
  });
});

describe('the caption fits the card in every locale', () => {
  // `labelFit.test.ts` sweeps BUTTONS; this is a `Text` and would be invisible to it. It is
  // one unwrapped line by design (wrapping would make the block's height a measurement, which
  // these screens cannot afford — see `LOBBY_ROUTES_H`), so it has to fit on its own.
  it.each(LOCALES)('%s', (locale) => {
    setLocale(locale);
    const r = new LobbyRoutes();
    // The widest plausible readout: a two-digit floor and an hour-long run.
    r.setContinue({ floorIndex: 11, ticks: 30 * 60 * 99 + 30 * 59, savedAtMs: 0 });
    r.layout(400, 100);
    const cap = privateOf(r).continueCaption;
    expect(cap.text).not.toBe('');
    expect(cap.width, `${locale}: "${cap.text}" is wider than the row it sits under`)
      .toBeLessThanOrEqual(LOBBY_ROUTES_W);
  });
});

describe('a locale change reaches the row', () => {
  it('retexts the button AND the caption, without being handed the save again', () => {
    const r = new LobbyRoutes();
    setLocale('en');
    r.setContinue(SAVED);
    const p = privateOf(r);
    expect(p.continueBtn.label.text).toBe(t('mainMenu.continueRun'));
    const english = p.continueCaption.text;

    setLocale('ru');
    r.retext();
    expect(p.continueBtn.label.text).toBe(t('mainMenu.continueRun'));
    expect(p.continueCaption.text).not.toBe(english);
    expect(p.continueCaption.text).toContain('3'); // still the same run
  });
});
