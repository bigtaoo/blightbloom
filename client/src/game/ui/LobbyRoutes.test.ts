/**
 * The lobby's route column (design/10): the CONTINUE card added 2026-09-17, and the three-tier
 * layout of the 2026-09-27 redesign.
 *
 * Three paths the CONTINUE acceptance named are all here: the card APPEARS for a resumable
 * save, it is GONE when there is none, and the hierarchy it changes resolves to exactly one
 * green primary in each of the four states (save × portal). `MainMenu.test.ts` covers the
 * shell's half — the provider, the column's placement, and which top card a portal draws.
 *
 * `installFakeTextCanvas` for the same reason every screen test here uses it: Pixi's `Text`
 * wants a canvas to measure glyphs and there is none. Read a passing `zh` width as "not
 * evidence" — the fake charges 0.6em per character and CJK is nearer a full em.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { Graphics } from 'pixi.js';
import { installFakeTextCanvas } from '../screens/fakeTextCanvas';
import { LobbyRoutes, LOBBY_ROUTES_W, LOBBY_ROUTES_H, LOBBY_ROUTES_DEMOTED_H, LOBBY_PRIMARY_H, LOBBY_GAP } from './LobbyRoutes';
import { MainMenu } from '../screens/MainMenu';
import { LOCALES, setLocale, resetLocaleForTests, t } from '../../i18n';
import type { SavedRunSummary } from '../match/runSave';
import { useLocale } from '../../i18n/loadLocale';

installFakeTextCanvas();

afterEach(() => resetLocaleForTests());

const SAVED: SavedRunSummary = { floorIndex: 2, ticks: 9000, savedAtMs: 0 };

interface Btn {
  label: { text: string };
  onTap: (() => void) | null;
  view: { visible: boolean; position: { x: number; y: number }; children: unknown[] };
}

interface Card extends Btn {
  hint: { text: string; visible: boolean; width: number; x: number };
  style: { fill: number; frame: number; art?: string; glow?: boolean };
}

function privateOf(r: LobbyRoutes) {
  return r as unknown as {
    continueBtn: Card;
    soloBtn: Card;
    coopBtn: Card;
    pvpSoloBtn: Card;
    squadBtn: Btn & { borderColor: number };
    forgeBtn: Btn;
    tutorialBtn: Btn;
    recommendedTag: { visible: boolean; position: { x: number; y: number } };
    chapters: { view: { position: { x: number; y: number } }; height: number; cycle: (step: 1 | -1) => void; chapter: string };
  };
}

function boxOf(b: Btn) {
  return (b.view.children[0] as Graphics).getLocalBounds();
}

const GREEN = 0x2f855a;
/** A box's local bounds include half its border stroke; sub-pixel noise, not layout. */
const SLACK = 1;

describe('the CONTINUE card appears only for a run this build can resume', () => {
  it('is hidden with no save — which is the default, so a caller that never sets it is safe', () => {
    const r = new LobbyRoutes();
    r.layout();
    expect(privateOf(r).continueBtn.view.visible).toBe(false);
    expect(r.height).toBe(LOBBY_ROUTES_H);
  });

  it('appears, with a hint naming the floor and the time played', () => {
    const r = new LobbyRoutes();
    r.setContinue(SAVED);
    r.layout();
    const p = privateOf(r);
    expect(p.continueBtn.view.visible).toBe(true);
    expect(p.continueBtn.hint.visible).toBe(true);
    // 1-based floor and mm:ss off 9000 ticks at 30 Hz — the same arithmetic the Loadout
    // screen's saved-run line does, asserted on the OUTPUT so the two cannot drift apart.
    expect(p.continueBtn.hint.text).toBe(t('mainMenu.continueRunAt', { floor: 3, m: 5, ss: '00' }));
  });

  it('goes away again when the offer is withdrawn', () => {
    const r = new LobbyRoutes();
    r.setContinue(SAVED);
    r.setContinue(null);
    r.layout();
    const p = privateOf(r);
    expect(p.continueBtn.view.visible).toBe(false);
    expect(p.continueBtn.hint.visible).toBe(false); // not a stale line on a hidden card
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

describe('exactly one primary, and it is the topmost card that starts a run', () => {
  /** [has a save, this block owns the primary] → which card is green. */
  const CASES: Array<[string, SavedRunSummary | null, boolean, 'continue' | 'solo' | 'neither']> = [
    ['no save, ordinary build', null, true, 'solo'],
    ['saved run, ordinary build', SAVED, true, 'continue'],
    // On a portal the shell's own PLAY holds the green when there is nothing to continue;
    // when there IS, the shell hides PLAY and hands this block the primary back.
    ['no save, portal', null, false, 'neither'],
    ['saved run, portal-with-PLAY-still-up', SAVED, false, 'neither'],
  ];

  it.each(CASES)('%s', (_name, saved, ownsPrimary, expected) => {
    const r = new LobbyRoutes();
    r.setSoloPrimary(ownsPrimary);
    r.setContinue(saved);
    const p = privateOf(r);
    expect(p.continueBtn.style.fill === GREEN).toBe(expected === 'continue');
    expect(p.soloBtn.style.fill === GREEN).toBe(expected === 'solo');
    // The glow goes with the green — one breathing card on the screen, never two.
    expect(!!p.continueBtn.style.glow).toBe(expected === 'continue');
    expect(!!p.soloBtn.style.glow).toBe(expected === 'solo');
  });

  it('re-resolves when the offer arrives AFTER the host has been decided', () => {
    // The real call order: `setSoloPrimary` once at boot, a save pushed in on every show.
    const r = new LobbyRoutes();
    r.setSoloPrimary(true);
    expect(privateOf(r).soloBtn.style.fill).toBe(GREEN);
    r.setContinue(SAVED);
    expect(privateOf(r).soloBtn.style.fill).not.toBe(GREEN);
    expect(privateOf(r).continueBtn.style.fill).toBe(GREEN);
  });

  it('draws SOLO as the banner when it is the primary, and as the slim plain bar when not', () => {
    const r = new LobbyRoutes();
    expect(boxOf(privateOf(r).soloBtn).height).toBe(LOBBY_PRIMARY_H);
    expect(privateOf(r).soloBtn.style.art).toBe('lobby_card_descend');
    expect(privateOf(r).soloBtn.hint.visible).toBe(true);
    r.setContinue(SAVED);
    expect(boxOf(privateOf(r).soloBtn).height).toBeLessThan(LOBBY_PRIMARY_H);
    expect(privateOf(r).soloBtn.style.art).toBeUndefined();
    expect(privateOf(r).soloBtn.hint.visible).toBe(false);
  });
});

describe('no card shares another card\'s slot', () => {
  it('stacks CONTINUE above a slim SOLO and moves the rest down by the difference', () => {
    const plain = new LobbyRoutes();
    plain.layout();
    const saved = new LobbyRoutes();
    saved.setContinue(SAVED);
    saved.layout();
    const a = privateOf(plain);
    const b = privateOf(saved);
    expect(saved.height).toBe(LOBBY_ROUTES_DEMOTED_H);
    // CONTINUE takes the top slot; SOLO sits under it — never in the slot SOLO had, which is
    // the mis-tap the pause menu's SAVE & QUIT row is laid out to avoid.
    expect(b.continueBtn.view.position.y).toBe(a.soloBtn.view.position.y);
    expect(b.soloBtn.view.position.y).toBeGreaterThanOrEqual(LOBBY_PRIMARY_H);
    const shift = LOBBY_ROUTES_DEMOTED_H - LOBBY_ROUTES_H;
    expect(b.coopBtn.view.position.y).toBe(a.coopBtn.view.position.y + shift);
    expect(b.squadBtn.view.position.y).toBe(a.squadBtn.view.position.y + shift);
  });

  it('leaves the top slot empty for the portal PLAY card, and says so', () => {
    const r = new LobbyRoutes();
    r.setSoloPrimary(false);
    r.layout();
    expect(r.reservesPrimarySlot).toBe(true);
    expect(privateOf(r).soloBtn.view.position.y).toBeGreaterThanOrEqual(LOBBY_PRIMARY_H);
    r.setContinue(SAVED);
    expect(r.reservesPrimarySlot).toBe(false); // CONTINUE fills it
  });

  it('keeps every card inside the column width', () => {
    const r = new LobbyRoutes();
    r.layout();
    const p = privateOf(r);
    for (const b of [p.soloBtn, p.coopBtn, p.pvpSoloBtn, p.squadBtn, p.forgeBtn, p.tutorialBtn]) {
      expect(b.view.position.x).toBeGreaterThanOrEqual(0);
      expect(b.view.position.x + boxOf(b).width).toBeLessThanOrEqual(LOBBY_ROUTES_W + SLACK);
    }
  });
});

describe('the hint fits its card in every locale', () => {
  // `labelFit.test.ts` sweeps the LABEL of every press target; the hint is a second `Text` and
  // invisible to it. It is fitted (and at worst ellipsised) to the room its card has.
  it.each(LOCALES)('%s', async (locale) => {
    await useLocale(locale);
    const m = new MainMenu();
    // The widest plausible CONTINUE readout: a two-digit floor and an hour-long run.
    m.resumableRun = () => ({ floorIndex: 11, ticks: 30 * 60 * 99 + 30 * 59, savedAtMs: 0 });
    m.show(760, 640);
    const r = privateOf((m as unknown as { routes: LobbyRoutes }).routes);
    for (const card of [r.continueBtn, r.coopBtn, r.pvpSoloBtn]) {
      expect(card.hint.text).not.toBe('');
      expect(card.hint.x + card.hint.width, `${locale}: "${card.hint.text}" runs past its card`)
        .toBeLessThanOrEqual(boxOf(card).width);
    }
  });
});

describe('a locale change reaches the column', () => {
  it('retexts the card AND its hint, without being handed the save again', async () => {
    const r = new LobbyRoutes();
    setLocale('en');
    r.setContinue(SAVED);
    const p = privateOf(r);
    expect(p.continueBtn.label.text).toBe(t('mainMenu.continueRun'));
    const english = p.continueBtn.hint.text;

    await useLocale('ru');
    r.retext();
    expect(p.continueBtn.label.text).toBe(t('mainMenu.continueRun'));
    expect(p.continueBtn.hint.text).not.toBe(english);
    expect(p.continueBtn.hint.text).toContain('3'); // still the same run
  });
});

describe('TUTORIAL hides once the player has seen it (2026-09-22)', () => {
  it('is drawn, badged, for a caller that never says otherwise — a new player', () => {
    const r = new LobbyRoutes();
    r.layout();
    expect(privateOf(r).tutorialBtn.view.visible).toBe(true);
    expect(privateOf(r).recommendedTag.visible).toBe(true);
  });

  it('disappears, and the dock closes the gap, once told the player has seen it', () => {
    const r = new LobbyRoutes();
    r.setRecommendTutorial(false);
    r.layout();
    const p = privateOf(r);
    expect(p.tutorialBtn.view.visible).toBe(false);
    expect(p.recommendedTag.visible).toBe(false);
    // Two across now: FORGE ends at the column's right edge.
    expect(Math.abs(p.forgeBtn.view.position.x + boxOf(p.forgeBtn).width - LOBBY_ROUTES_W)).toBeLessThanOrEqual(SLACK);
    // The dock is still one row, so the column's height does not change.
    expect(r.height).toBe(LOBBY_ROUTES_H);
  });

  it('comes back if a later call says the player has NOT seen it after all', () => {
    const r = new LobbyRoutes();
    r.setRecommendTutorial(false);
    r.layout();
    r.setRecommendTutorial(true);
    r.layout();
    const p = privateOf(r);
    expect(p.tutorialBtn.view.visible).toBe(true);
    expect(Math.abs(p.tutorialBtn.view.position.x + boxOf(p.tutorialBtn).width - LOBBY_ROUTES_W)).toBeLessThanOrEqual(SLACK);
  });
});

describe("TUTORIAL does not borrow ACCOUNT's colour (2026-09-22)", () => {
  // design/10:75's "two adjacent buttons must differ by more than their label". The glyph is
  // still borrowed (no dedicated icon yet); in the dock it has no chip, so the border colour
  // is the cue doing the work, and it must not be ACCOUNT's purple.
  it('draws a different border than MainMenu’s ACCOUNT button', () => {
    const m = new MainMenu();
    const tutorial = (m as unknown as { routes: { tutorialBtn: { borderColor: number } } }).routes.tutorialBtn;
    const account = (m as unknown as { accountBtn: { borderColor: number } }).accountBtn;
    expect(tutorial.borderColor).toBeDefined();
    expect(tutorial.borderColor).not.toBe(account.borderColor);
  });
});

describe('the chapter picker sits under SOLO, and a locked chapter takes SOLO out of play (2026-10-06)', () => {
  /** [state name, has a save, owns the primary] — every arrangement SOLO can be drawn in. */
  const STATES: Array<[string, SavedRunSummary | null, boolean]> = [
    ['SOLO primary', null, true],
    ['CONTINUE primary', SAVED, true],
    ['portal PLAY primary', null, false],
  ];

  it.each(STATES)('%s: directly under SOLO and above CO-OP, never sharing a slot', (_name, saved, owns) => {
    const r = new LobbyRoutes();
    r.setSoloPrimary(owns);
    r.setContinue(saved);
    r.layout();
    const p = privateOf(r);
    const soloBottom = p.soloBtn.view.position.y + boxOf(p.soloBtn).height;
    const pickerY = p.chapters.view.position.y;
    expect(pickerY).toBeGreaterThanOrEqual(soloBottom - SLACK);
    expect(pickerY - soloBottom).toBeLessThanOrEqual(LOBBY_GAP + SLACK); // tied to SOLO, not floating
    expect(pickerY + p.chapters.height).toBeLessThanOrEqual(p.coopBtn.view.position.y);
    // ...and the declared height still accounts for every card, picker included.
    expect(p.squadBtn.view.position.y + boxOf(p.squadBtn).height).toBeLessThanOrEqual(r.height + SLACK);
  });

  it('dims SOLO and stops it taking taps while a locked chapter is shown, and reports it', () => {
    const r = new LobbyRoutes();
    const reports: boolean[] = [];
    r.onStartBlockedChange = (b) => reports.push(b);
    r.setChapterProgress({ selectedChapter: 'ember', clearedChapters: [] });
    const solo = privateOf(r).soloBtn.view as unknown as { alpha: number; eventMode: string };
    expect(r.startBlocked).toBe(false);
    expect(solo.eventMode).toBe('static');
    privateOf(r).chapters.cycle(1); // onto frost, still locked
    expect(r.startBlocked).toBe(true);
    expect(solo.alpha).toBeLessThan(1);
    expect(solo.eventMode).toBe('none');
    privateOf(r).chapters.cycle(1); // and back to ember
    expect(solo.alpha).toBe(1);
    expect(solo.eventMode).toBe('static');
    expect(reports).toEqual([true, false]);
  });

  it('routes an unlocked pick out through onSelectChapter', () => {
    const r = new LobbyRoutes();
    const picks: string[] = [];
    r.onSelectChapter = (id) => picks.push(id);
    r.setChapterProgress({ selectedChapter: 'ember', clearedChapters: ['ember'] });
    privateOf(r).chapters.cycle(1);
    expect(picks).toEqual(['frost']);
  });

  it('is safe with neither callback installed', () => {
    const r = new LobbyRoutes();
    r.setChapterProgress({ selectedChapter: 'ember', clearedChapters: ['ember'] });
    expect(() => privateOf(r).chapters.cycle(1)).not.toThrow();
    r.setChapterProgress({ selectedChapter: 'ember', clearedChapters: [] });
    expect(() => privateOf(r).chapters.cycle(1)).not.toThrow();
    expect(r.startBlocked).toBe(true);
  });
});
