/**
 * PortalPrompt (design/10 legibility fix, 2026-08-02) — the exit/continue popup that
 * replaces the old "HOLD [E] to EXTRACT / TAP [E] to DESCEND" text banner (formerly
 * HudView's checkpointPanel/checkpointText, see HudView.test.ts history). `show` is
 * computed by the caller (GameLoop.ts: at an eligible checkpoint AND standing near the
 * portal) — this class only renders it and reads `s` for the pending/floor text.
 * `isLastFloor` picks WHICH single button is shown (ENGINE_VERSION 61): Extract on the boss
 * floor, Descend on every other one. It used to only HIDE Descend on the last floor, leaving
 * a two-button choice everywhere else — see the exclusion suite below for what changed and
 * why the interior floor losing Extract had to be paired with `ExtractionSystem` ignoring it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createGameState } from '@dd/engine/state/GameState';
import type { EngineConfig } from '@dd/engine/state/GameState';
import { PortalPrompt } from './PortalPrompt';
import { setLocale, resetLocaleForTests } from '../../i18n';

afterEach(() => resetLocaleForTests());

function privateOf(p: PortalPrompt) {
  return p as unknown as {
    titleText: { text: string; style: { wordWrap: boolean; breakWords: boolean } };
    extractBtn: { onTap: (() => void) | null; view: { visible: boolean }; label: { text: string } };
    descendBtn: { onTap: (() => void) | null; view: { visible: boolean }; label: { text: string } };
  };
}

const PVE_CFG: EngineConfig = { seed: 1, worldW: 800, worldH: 600, waves: [] };

describe('PortalPrompt — visibility follows the caller-computed `show` flag', () => {
  it('is hidden when show is false, regardless of state content', () => {
    const prompt = new PortalPrompt();
    const s = createGameState(PVE_CFG);
    prompt.update(s, false);
    expect(prompt.view.visible).toBe(false);
    expect(prompt.isOpen).toBe(false);
  });

  it('becomes visible with the real pending count and next floor number when show is true', () => {
    const prompt = new PortalPrompt();
    const s = createGameState(PVE_CFG);
    s.floorIndex = 0; // floor 1 of 3
    s.floorMaterials = { mat_fire: 5, mat_ice: 2 }; // pending = 7

    prompt.update(s, true);

    expect(prompt.view.visible).toBe(true);
    expect(prompt.isOpen).toBe(true);
    const p = privateOf(prompt);
    expect(p.titleText.text.length).toBeGreaterThan(0);
  });

  it('hides again the next update() once show flips back to false', () => {
    const prompt = new PortalPrompt();
    const s = createGameState(PVE_CFG);
    prompt.update(s, true);
    expect(prompt.view.visible).toBe(true);
    prompt.update(s, false);
    expect(prompt.view.visible).toBe(false);
  });
});

/**
 * One button, and WHICH one is the whole rule (ENGINE_VERSION 61, design/05 "Only the boss
 * floor ends a run"). Before that this popup showed both on an interior floor and Extract
 * alone on the last (2026-08-12, live bug report follow-up: the last floor used to skip the
 * popup entirely and auto-resolve EXTRACT the instant the boss died, leaving no time to walk
 * over to its death drops). Now the exclusion runs both ways.
 *
 * Both halves are asserted in every case, not just the one each is about: "Descend shows on
 * an interior floor" would also pass with Extract sitting live beside it, which is exactly
 * the state this version removed — and `ExtractionSystem` would ignore that press, so the
 * player would be clicking a dead button.
 */
describe('PortalPrompt — exactly one choice, and the floor picks it', () => {
  it('an interior floor offers Descend and no Extract', () => {
    const prompt = new PortalPrompt();
    const s = createGameState(PVE_CFG);
    prompt.update(s, true);
    const p = privateOf(prompt);
    expect(p.descendBtn.view.visible).toBe(true);
    expect(p.extractBtn.view.visible).toBe(false);
  });

  it('the last floor offers Extract and no Descend', () => {
    const prompt = new PortalPrompt();
    const s = createGameState(PVE_CFG);
    prompt.update(s, true, true);
    const p = privateOf(prompt);
    expect(p.descendBtn.view.visible).toBe(false);
    expect(p.extractBtn.view.visible).toBe(true);
  });

  it('swaps back and forth across updates rather than latching', () => {
    const prompt = new PortalPrompt();
    const s = createGameState(PVE_CFG);
    prompt.update(s, true, true);
    prompt.update(s, true, false);
    expect(privateOf(prompt).descendBtn.view.visible).toBe(true);
    expect(privateOf(prompt).extractBtn.view.visible).toBe(false);
    prompt.update(s, true, true);
    expect(privateOf(prompt).extractBtn.view.visible).toBe(true);
  });

  it('counts an absent quantity as zero rather than as NaN', () => {
    // `floorMaterials`/`bankedMaterials` are `Partial<Record<string, number>>`, so a key
    // present with no value is representable — and one `undefined` in the sum turns the
    // whole button label into "NaN materials". The line runs either way; only this asserts
    // the fallback arm (CLAUDE.md's note on branch coverage being the column that bites).
    const prompt = new PortalPrompt();
    const s = createGameState(PVE_CFG);
    s.floorMaterials = { mat_fire: 3, mat_ice: undefined };
    s.bankedMaterials = { mat_poison: undefined };
    prompt.update(s, true, true);
    expect(privateOf(prompt).extractBtn.label.text).toContain('3');
    expect(privateOf(prompt).extractBtn.label.text).not.toContain('NaN');
  });

  it('titles the two cases differently — the boss floor is where the run ends', () => {
    const prompt = new PortalPrompt();
    const s = createGameState(PVE_CFG);
    prompt.update(s, true, false);
    const interior = privateOf(prompt).titleText.text;
    prompt.update(s, true, true);
    expect(privateOf(prompt).titleText.text).not.toBe(interior);
  });

  it('the Extract label counts the WHOLE carry-out, not just this floor\'s buffer', () => {
    // Since v61 this press is the run's only exit, so the number beside it is what the
    // player walks away with — both tiers. Naming the floor buffer alone (which is what it
    // used to name, correctly, while any floor could extract) would understate it by
    // everything the earlier floors' descends had folded in.
    const prompt = new PortalPrompt();
    const s = createGameState(PVE_CFG);
    s.floorMaterials = { mat_fire: 5 };
    s.bankedMaterials = { mat_ice: 12 };
    prompt.update(s, true, true);
    const label = privateOf(prompt).extractBtn.label.text;
    expect(label).toContain('17');
    expect(label).not.toContain('5 materials');
  });
});

describe('PortalPrompt — text wrapping (design/17-i18n.md)', () => {
  it('reposition() sets wordWrap AND breakWords — CJK text has no spaces to wrap at, so a plain wordWrap alone would overflow the panel instead of wrapping (confirmed live, 2026-08-03)', () => {
    const prompt = new PortalPrompt();
    prompt.reposition({ w: 320, h: 800 });
    const style = privateOf(prompt).titleText.style;
    expect(style.wordWrap).toBe(true);
    expect(style.breakWords).toBe(true);
  });
});

describe('PortalPrompt — callbacks', () => {
  it('tapping each button fires its own callback, not the other one', () => {
    const prompt = new PortalPrompt();
    const s = createGameState(PVE_CFG);
    prompt.update(s, true);
    const calls: string[] = [];
    prompt.onExtract = () => calls.push('extract');
    prompt.onDescend = () => calls.push('descend');

    const p = privateOf(prompt);
    p.extractBtn.onTap?.();
    p.descendBtn.onTap?.();

    expect(calls).toEqual(['extract', 'descend']);
  });
});

describe('PortalPrompt — i18n (design/17-i18n.md)', () => {
  it('defaults to English copy', () => {
    const prompt = new PortalPrompt();
    const s = createGameState(PVE_CFG);
    prompt.update(s, true);
    expect(privateOf(prompt).titleText.text).not.toBe('');
  });

  it('translates under zh and reverts under en on a later update()', () => {
    const prompt = new PortalPrompt();
    const s = createGameState(PVE_CFG);
    setLocale('zh');
    prompt.update(s, true);
    const zhTitle = privateOf(prompt).titleText.text;
    setLocale('en');
    prompt.update(s, true);
    const enTitle = privateOf(prompt).titleText.text;
    expect(zhTitle).not.toBe(enTitle);
  });
});
