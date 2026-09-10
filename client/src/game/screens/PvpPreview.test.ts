/**
 * PvpPreview (design/10 open question "PvP preset-pick has no UI yet", 15) — the
 * confirm/preview step the lobby's PVP SOLO QUEUE now opens before Matchmaking. Same
 * plain-vitest, no-renderer convention as MainMenu.test.ts/Settings.test.ts.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { buildArenaSpecs, PVP_SCALE_FACTOR, DEFAULT_SKIN_ID, SKIN_DEFS } from '@dd/engine';
import { PvpPreview } from './PvpPreview';
import { setLocale, resetLocaleForTests, tName } from '../../i18n';

function privateOf(p: PvpPreview) {
  return p as unknown as {
    title: { text: string };
    mapLine: { text: string };
    fairnessNote: { text: string };
    queueBtn: { label: { text: string }; onTap: (() => void) | null };
    backBtn: { label: { text: string }; onTap: (() => void) | null };
    playerCard: { displayName: string };
    weaponCard: { nameText: string; damageText: string; estimatedWidth(): number; view: { position: { x: number; y: number } } };
    weaponSlotChip: { view: { visible: boolean; position: { x: number; y: number } }; set(spec: unknown): void };
  };
}

afterEach(() => resetLocaleForTests());

describe('PvpPreview — callbacks', () => {
  it('tapping QUEUE/BACK fires its own callback, not the other one', () => {
    const p = new PvpPreview();
    p.show(800, 600, DEFAULT_SKIN_ID);
    const calls: string[] = [];
    p.onQueue = () => calls.push('queue');
    p.onBack = () => calls.push('back');

    privateOf(p).queueBtn.onTap?.();
    privateOf(p).backBtn.onTap?.();

    expect(calls).toEqual(['queue', 'back']);
  });
});

describe('PvpPreview — show()/hide()', () => {
  it('starts hidden', () => {
    const p = new PvpPreview();
    expect(p.view.visible).toBe(false);
  });

  it('becomes visible on show()', () => {
    const p = new PvpPreview();
    p.show(800, 600, DEFAULT_SKIN_ID);
    expect(p.view.visible).toBe(true);
  });

  it('hide() hides it again', () => {
    const p = new PvpPreview();
    p.show(800, 600, DEFAULT_SKIN_ID);
    p.hide();
    expect(p.view.visible).toBe(false);
  });
});

describe('PvpPreview — PvP-scaled build preview', () => {
  it('shows the same scaled character + weapon a real arena seat would get (buildArenaSpecs)', () => {
    const p = new PvpPreview();
    p.show(800, 600, DEFAULT_SKIN_ID);
    const built = buildArenaSpecs('landing_basic', DEFAULT_SKIN_ID);

    expect(privateOf(p).playerCard.displayName).toBe(tName(SKIN_DEFS[DEFAULT_SKIN_ID]!.nameKey));
    expect(privateOf(p).weaponCard.nameText).toBe(tName(built.weapons[0]!.spec.nameKey));
    expect(privateOf(p).weaponCard.damageText).toContain(String(built.weapons[0]!.spec.damage));
  });

  it('shows the WHOLE kit — the melee slot beside the active gun, not half of it', () => {
    // The kit is a gun + a melee weapon (ENGINE_VERSION 45). This screen's entire job is
    // "see what you are about to enter with", so rendering only `weapons[0]` would be a
    // silent halving — and the kind of thing that rots the day a preset changes, since
    // nothing about a one-card layout looks wrong on its own.
    const p = new PvpPreview();
    p.show(800, 600, DEFAULT_SKIN_ID);
    const built = buildArenaSpecs('landing_basic', DEFAULT_SKIN_ID);
    expect(built.weapons.length).toBeGreaterThan(1); // premise: a pair is what we are previewing

    const inner = privateOf(p);
    expect(inner.weaponSlotChip.view.visible).toBe(true);
    // Same reading as the in-match HUD: idle slot immediately right of the active card's
    // RIGHT EDGE (comparing against the width alone would pass even unpositioned, since
    // the card itself is already inset past that many pixels), on the same row.
    expect(inner.weaponSlotChip.view.position.x)
      .toBeGreaterThan(inner.weaponCard.view.position.x + inner.weaponCard.estimatedWidth());
    expect(inner.weaponSlotChip.view.position.y).toBe(inner.weaponCard.view.position.y + 2);
    expect(inner.weaponSlotChip.set).toBeDefined();
  });

  it('names the scale factor actually in effect', () => {
    const p = new PvpPreview();
    p.show(800, 600, DEFAULT_SKIN_ID);
    expect(privateOf(p).fairnessNote.text).toContain(String(PVP_SCALE_FACTOR));
  });

  it('re-shows cleanly for a different character', () => {
    const p = new PvpPreview();
    p.show(800, 600, 'skirmisher');
    expect(privateOf(p).playerCard.displayName).toBe('Skirmisher');
    p.show(800, 600, 'juggernaut');
    expect(privateOf(p).playerCard.displayName).toBe('Juggernaut');
  });

  // buildArenaSpecs/resolveSkin fall back to the default character for an unknown id
  // (forward-compat, same convention every other skinId reader in this repo follows) —
  // this should never crash the preview even if MetaState ever carries a stale id.
  it('does not throw for an unknown skinId, and falls back to a real character', () => {
    const p = new PvpPreview();
    expect(() => p.show(800, 600, 'not-a-real-skin')).not.toThrow();
    expect(privateOf(p).playerCard.displayName).toBe('NOT-A-REAL-SKIN');
    expect(privateOf(p).weaponCard.nameText).not.toBe('');
  });
});

describe('PvpPreview — i18n (design/17-i18n.md)', () => {
  it('defaults to English', () => {
    const p = new PvpPreview();
    p.show(800, 600, DEFAULT_SKIN_ID);
    expect(privateOf(p).title.text).toBe('PVP MATCH');
    expect(privateOf(p).queueBtn.label.text).toBe('QUEUE');
  });

  it('retexts its static labels from the active locale on show()', () => {
    setLocale('zh');
    const p = new PvpPreview();
    p.show(800, 600, DEFAULT_SKIN_ID);
    expect(privateOf(p).title.text).toBe('PVP 对战');
    expect(privateOf(p).queueBtn.label.text).toBe('开始匹配');
    expect(privateOf(p).backBtn.label.text).toBe('返回');
  });

  it('switching back to English on a later show() fully reverts', () => {
    const p = new PvpPreview();
    setLocale('zh');
    p.show(800, 600, DEFAULT_SKIN_ID);
    setLocale('en');
    p.show(800, 600, DEFAULT_SKIN_ID);
    expect(privateOf(p).title.text).toBe('PVP MATCH');
  });
});
