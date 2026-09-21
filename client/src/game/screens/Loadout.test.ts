/**
 * Loadout — the PRE-RUN screen (2026-09-21). Pixi Container/Text/Graphics construct and
 * mutate fine under plain vitest with no renderer attached (the same finding
 * `Forge.test.ts`/`Screens.test.ts` made), so everything below is asserted through
 * `.position`/`.visible`/`.text` rather than pixel output.
 *
 * Three things this file is actually about, and each is a claim the split made:
 *
 *  1. **The weapon row shows what a run would CARRY, not what could be crafted.** The old
 *     forge listed the whole blueprint catalog here, most of it locked or unaffordable. So
 *     the cases below drive `resolveLoadout`'s real answer through the screen — staged
 *     weapons first, the starter kit filling the free slots — and assert the row never
 *     shows a blueprint that is merely available.
 *  2. **An empty loadout is not an empty row.** A fresh save's `loadout` is `[]` and crafted
 *     weapons are spent after one run, so "nothing staged" is the state most runs start in.
 *     Showing nothing there would tell a player they are unarmed right before handing them a
 *     gun and a saber.
 *  3. **CONTINUE RUN reads a provider on every render.** Moved here from `Forge.test.ts`
 *     along with the button: a provider read once and cached would offer a run that has
 *     since been won or abandoned, which is what the three clear-the-slot call sites exist
 *     to prevent.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { Graphics, Sprite, Texture, TextureSource } from 'pixi.js';
import { PLAYER_BASE, SKIN_DEFS, resolveLoadout } from '@dd/engine';
import { Loadout } from './Loadout';
import { installFakeTextCanvas } from './fakeTextCanvas';
import { defaultMetaState } from '../../meta';
import { setLocale, resetLocaleForTests, tName } from '../../i18n';
import type { LoadedRigSkin } from '../../render/skinRegistry';

/**
 * The rig registry, per-character and switchable per test.
 *
 * Mocked rather than preloaded because `getRigSkin` answers `undefined` for everything under
 * plain vitest — there is no asset pipeline here — so WITHOUT this the portrait's texture
 * branch is unreachable and every case below would be measuring the fallback disc. That is
 * the shape `PlayerCard.test.ts` is still in, and it is why this file mocks at the registry
 * (the same `vi.hoisted` convention `scene/Skin.test.ts` uses) rather than reaching into the
 * screen's private sprite.
 *
 * Empty by default, so every OTHER case in this file keeps meeting the no-art state a unit
 * test would normally see.
 */
const rigs = vi.hoisted(() => ({ byAtlasKey: new Map<string, unknown>() }));
vi.mock('../../render/skinRegistry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../render/skinRegistry')>()),
  getRigSkin: (name: string) => rigs.byAtlasKey.get(name),
}));

installFakeTextCanvas();

interface TestButton {
  view: { visible: boolean; position: { x: number; y: number } };
  label: { text: string };
  onTap: (() => void) | null;
}

interface TestCard {
  view: { visible: boolean; position: { x: number; y: number } };
  onTap: (() => void) | null;
  nameLabel: string;
  statusLabel: string;
  keyLabel: string;
  stagedLabel: string;
}

function privateOf(l: Loadout) {
  return l as unknown as {
    title: { text: string };
    hint: { text: string; position: { x: number; y: number } };
    infoText: { text: string };
    savedText: { text: string; visible: boolean };
    charName: { text: string; position: { x: number; y: number } };
    charStats: { text: string; position: { x: number; y: number } };
    charOwned: { text: string; position: { x: number; y: number } };
    portraitFrame: { position: { x: number; y: number } };
    weaponCards: TestCard[];
    forgeCard: TestCard;
    backBtn: TestButton;
    clearBtn: TestButton;
    startBtn: TestButton;
    continueBtn: TestButton;
    prevCharBtn: TestButton;
    nextCharBtn: TestButton;
  };
}

afterEach(() => {
  resetLocaleForTests();
  rigs.byAtlasKey.clear();
});

/** A loaded bundle whose `shell` slot (the portrait slot) is a texture of the given size.
 *  Only the two fields the screen reads are real; `LoadedRigSkin`'s rig/radius half is not
 *  on the path under test. */
function withPortraitArt(skinId: string, w: number, h: number): Texture {
  const texture = new Texture({ source: new TextureSource({ width: w, height: h }) });
  const bundle = { bindings: new Map(), clips: new Map(), textures: new Map([['shell', texture]]) };
  rigs.byAtlasKey.set(SKIN_DEFS[skinId]!.atlasKey, { bundle } as unknown as LoadedRigSkin);
  return texture;
}

/** The portrait `Sprite`, which only exists once real art has been bound. */
function portraitOf(l: Loadout): Sprite | null {
  return (l as unknown as { portrait: Sprite | null }).portrait;
}

/** How wide the fallback disc is currently painted — 0 once it has been cleared. */
function discWidthOf(l: Loadout): number {
  return (l as unknown as { portraitFallback: Graphics }).portraitFallback.getLocalBounds().width;
}

describe('Loadout — the character block', () => {
  it('names the selected character and states its pools beside the portrait', () => {
    const l = new Loadout();
    l.render(defaultMetaState(), 1280, 720);
    const p = privateOf(l);
    // defaultMetaState() selects DEFAULT_SKIN_ID ('vanguard'). The POOLS are read out of
    // `SKIN_DEFS` rather than written here as numbers: they are a balance decision that
    // belongs to `content/skins.ts` and moves there, and a copy of them in this file would
    // turn a tuning pass into a failing screen test that says nothing about the screen.
    const def = SKIN_DEFS[defaultMetaState().selectedSkin]!;
    expect(p.charName.text).toBe('Vanguard');
    expect(p.charStats.text).toBe(`${def.maxHp} HP / ${def.maxShield} SHIELD`);
    expect(p.charOwned.text).toBe('characters owned: 3');
  });

  it('puts the text to the RIGHT of the portrait, which is the whole point of the block', () => {
    // The report this screen came from asked for the picture first and the text beside it.
    // A regression that centres the text over the portrait would still "fit" every sweep in
    // this directory, so it is asserted directly.
    const l = new Loadout();
    l.render(defaultMetaState(), 1280, 720);
    const p = privateOf(l);
    const portraitRight = p.portraitFrame.position.x + 104; // PORTRAIT
    expect(p.charName.position.x).toBeGreaterThanOrEqual(portraitRight);
    expect(p.charStats.position.x).toBe(p.charName.position.x);
    expect(p.charOwned.position.x).toBe(p.charName.position.x);
  });

  it('keeps the three text lines in reading order, top to bottom', () => {
    const l = new Loadout();
    l.render(defaultMetaState(), 1280, 720);
    const p = privateOf(l);
    expect(p.charName.position.y).toBeLessThan(p.charStats.position.y);
    expect(p.charStats.position.y).toBeLessThan(p.charOwned.position.y);
  });

  it('both cycle arrows run the SAME verb — the roster cycle is forward-only today', () => {
    const l = new Loadout();
    let fired = 0;
    l.onCycleCharacter = () => { fired++; };
    l.render(defaultMetaState(), 1280, 720);
    const p = privateOf(l);
    p.prevCharBtn.onTap?.();
    p.nextCharBtn.onTap?.();
    expect(fired).toBe(2);
  });

  it('echoes an unknown skin id back rather than relabelling it', () => {
    // The same rule `PlayerCard` follows: `resolveSkin`'s forward-compat fallback is right
    // for stat resolution and wrong for a label, where it would silently rename the
    // character the player thinks they picked.
    const l = new Loadout();
    l.render({ ...defaultMetaState(), selectedSkin: 'nobody' }, 1280, 720);
    const p = privateOf(l);
    expect(p.charName.text).toBe('nobody');
    expect(p.charStats.text).toBe('');
  });
});

/**
 * The character's picture — the half of the report this screen exists for, and the half a
 * unit test sees the least of: with no asset pipeline `getRigSkin` answers `undefined`, so
 * every case above is drawing the fallback disc. These four drive the REAL branch.
 */
describe('Loadout — the portrait', () => {
  const PORTRAIT = 104; // the screen's own box constant
  const INNER = PORTRAIT - 16;

  it("binds the selected character's body art, CONTAINED rather than stretched", () => {
    // Body art is square-ish but not guaranteed to be, and a portrait that stretches is the
    // kind of defect a screenshot shows and no assertion ever does. 160x80 into an 88px box
    // is 0.55 on BOTH axes — a stretch would be 0.55 and 1.1.
    const m = defaultMetaState();
    const texture = withPortraitArt(m.selectedSkin, 160, 80);
    const l = new Loadout();
    l.render(m, 1280, 720);

    const portrait = portraitOf(l);
    expect(portrait, 'the texture branch never ran — the registry mock did not reach it').not.toBeNull();
    expect(portrait!.texture).toBe(texture);
    expect(portrait!.scale.x).toBeCloseTo(INNER / 160, 6);
    expect(portrait!.scale.y).toBeCloseTo(portrait!.scale.x, 6);
  });

  it('CONTAINS a tall texture too — the other arm of the same Math.min', () => {
    // The gap the PlayerCard pass (volume 81) exposed by contrast: with a WIDE texture
    // `Math.min` picks the width arm anyway, so dropping the height term entirely survives a
    // wide-only test. 80×160 is the case that fails it — the height arm is the smaller one.
    const m = defaultMetaState();
    withPortraitArt(m.selectedSkin, 80, 160);
    const l = new Loadout();
    l.render(m, 1280, 720);

    const portrait = portraitOf(l)!;
    expect(portrait.scale.y).toBeCloseTo(INNER / 160, 6);
    expect(portrait.scale.x).toBeCloseTo(portrait.scale.y, 6);
  });

  it('falls back for a rig that loaded WITHOUT the shell slot', () => {
    // A bundle that resolved but carries no `shell` binding is a different input from no
    // bundle at all, and it reaches the same `!texture` branch. Worth its own case because a
    // lookup that stopped optional-chaining would throw here rather than draw the disc.
    const m = defaultMetaState();
    const bundle = { bindings: new Map(), clips: new Map(), textures: new Map() }; // no 'shell'
    rigs.byAtlasKey.set(SKIN_DEFS[m.selectedSkin]!.atlasKey, { bundle } as unknown as LoadedRigSkin);

    const l = new Loadout();
    expect(() => l.render(m, 1280, 720)).not.toThrow();
    expect(portraitOf(l)).toBeNull();
  });

  it('clears the disc it already drew when the NEXT character DOES have art', () => {
    // The other direction from the fallback case below, and the one that leaves a visible
    // artefact: a placeholder painted for an unarted character and never cleared sits
    // underneath the real portrait. Asserted through a card that has actually drawn a disc —
    // on a freshly constructed one the assertion holds either way, which is the vacuity trap
    // the PlayerCard pass hit and recorded.
    const m = defaultMetaState();
    const [first, second] = m.ownedCharacters;
    withPortraitArt(second!, 64, 64); // only the SECOND has art

    const l = new Loadout();
    l.render({ ...m, selectedSkin: first! }, 1280, 720);
    expect(discWidthOf(l), 'the disc was never drawn — this case would pass vacuously').toBeGreaterThan(0);

    l.render({ ...m, selectedSkin: second! }, 1280, 720);
    expect(portraitOf(l)).not.toBeNull();
    expect(discWidthOf(l)).toBe(0);
  });

  it('centres it in the frame, and moves it when the layout does', () => {
    // The sprite is anchored (0.5, 0.5) and positioned separately from the frame it sits in,
    // so a layout that moves one and not the other leaves the face outside its own box.
    const m = defaultMetaState();
    withPortraitArt(m.selectedSkin, 64, 64);
    const l = new Loadout();
    const p = privateOf(l);

    l.render(m, 1280, 720);
    const wide = { x: p.portraitFrame.position.x, y: p.portraitFrame.position.y };
    expect(portraitOf(l)!.position.x).toBeCloseTo(wide.x + PORTRAIT / 2, 6);
    expect(portraitOf(l)!.position.y).toBeCloseTo(wide.y + PORTRAIT / 2, 6);

    l.render(m, 900, 720); // a narrower viewport re-centres the whole block
    expect(p.portraitFrame.position.x).not.toBeCloseTo(wide.x, 0);
    expect(portraitOf(l)!.position.x).toBeCloseTo(p.portraitFrame.position.x + PORTRAIT / 2, 6);
  });

  it('re-binds when the character changes', () => {
    // `bindPortrait` is called on every render, and the cycle arrows are the whole point of
    // the block: a portrait that stuck on the first character would leave the picture and
    // the name disagreeing about who is being taken into the run.
    const m = defaultMetaState();
    const [first, second] = m.ownedCharacters;
    const a = withPortraitArt(first!, 64, 64);
    const b = withPortraitArt(second!, 64, 64);
    expect(a).not.toBe(b);

    const l = new Loadout();
    l.render({ ...m, selectedSkin: first! }, 1280, 720);
    expect(portraitOf(l)!.texture).toBe(a);

    l.render({ ...m, selectedSkin: second! }, 1280, 720);
    expect(portraitOf(l)!.texture).toBe(b);
  });

  it('falls back to the disc — and drops the sprite — for a character whose art is missing', () => {
    // Art is best-effort everywhere in this codebase (design/02/12 "gameplay is never blocked
    // on art"), and the direction that matters is this one: art→no-art. A screen that kept
    // the previous sprite would show the WRONG character's face rather than no face, which is
    // worse than the empty state the rule is written to allow.
    const m = defaultMetaState();
    const [first, second] = m.ownedCharacters;
    withPortraitArt(first!, 64, 64); // only the first has art

    const l = new Loadout();
    l.render({ ...m, selectedSkin: first! }, 1280, 720);
    expect(portraitOf(l)).not.toBeNull();

    l.render({ ...m, selectedSkin: second! }, 1280, 720);
    expect(portraitOf(l)).toBeNull();
    expect(privateOf(l).charName.text).toBe(tName(SKIN_DEFS[second!]!.nameKey)); // the name still resolves
  });
});

describe('Loadout — the weapon row shows what the run CARRIES', () => {
  it('fills an empty loadout with the starter kit rather than drawing nothing', () => {
    const l = new Loadout();
    const m = defaultMetaState();
    expect(m.loadout).toEqual([]); // the state most runs actually start in
    l.render(m, 1280, 720);
    const p = privateOf(l);
    const shown = p.weaponCards.filter((c) => c.view.visible);
    expect(shown).toHaveLength(PLAYER_BASE.weaponSlots);
    expect(shown.map((c) => c.nameLabel)).toEqual(['Blaster', 'Saber']);
    for (const c of shown) expect(c.statusLabel).toBe('default kit');
  });

  it('marks a forged weapon as forged, and the starter beside it as the default', () => {
    const l = new Loadout();
    l.render({ ...defaultMetaState(), loadout: ['repeater'] }, 1280, 720);
    const p = privateOf(l);
    expect(p.weaponCards[0]!.nameLabel).toBe('Repeater');
    expect(p.weaponCards[0]!.statusLabel).toBe('forged');
    expect(p.weaponCards[0]!.stagedLabel).toBe('▸×1'); // the badge a crafted slot carries
    // `resolveLoadout` fills the free slot with the starter of the OTHER kind.
    expect(p.weaponCards[1]!.nameLabel).toBe('Saber');
    expect(p.weaponCards[1]!.statusLabel).toBe('default kit');
    expect(p.weaponCards[1]!.stagedLabel).toBe('');
  });

  it('draws exactly what resolveLoadout resolves — never a blueprint that is merely craftable', () => {
    // The claim the whole split rests on. `defaultMetaState` starts with five unlocked
    // blueprints and materials can buy more; none of them belongs on this screen until it
    // has been forged into the loadout.
    const l = new Loadout();
    const m = { ...defaultMetaState(), loadout: ['repeater'], materialBank: { mat_physical: 99 } };
    l.render(m, 1280, 720);
    const p = privateOf(l);
    const shown = p.weaponCards.filter((c) => c.view.visible).map((c) => c.nameLabel);
    expect(shown).toHaveLength(resolveLoadout(m.loadout).length);
    expect(shown).not.toContain('Scattergun'); // unlocked, affordable, and not being carried
  });

  it('counts only the forged slots in the header line, not the starters filling in', () => {
    const l = new Loadout();
    l.render(defaultMetaState(), 1280, 720);
    expect(privateOf(l).infoText.text).toContain(`0/${PLAYER_BASE.weaponSlots}`);

    l.render({ ...defaultMetaState(), loadout: ['repeater'] }, 1280, 720);
    expect(privateOf(l).infoText.text).toContain(`1/${PLAYER_BASE.weaponSlots}`);
  });

  it('ignores an id no weapon catalog knows, exactly as the engine does', () => {
    // `resolveLoadout` drops unknown ids (design/09 forward-compat) and fills the slot with
    // a starter. A count taken off the raw array would say "1/2 forged" over two starter
    // cards, which is a screen disagreeing with itself.
    const l = new Loadout();
    l.render({ ...defaultMetaState(), loadout: ['no_such_weapon'] }, 1280, 720);
    const p = privateOf(l);
    expect(p.infoText.text).toContain(`0/${PLAYER_BASE.weaponSlots}`);
    expect(p.weaponCards.filter((c) => c.view.visible).map((c) => c.nameLabel)).toEqual(['Blaster', 'Saber']);
  });

  it('states the material bank, which is what decides whether a forge trip is worth it', () => {
    const l = new Loadout();
    l.render(defaultMetaState(), 1280, 720);
    expect(privateOf(l).infoText.text).toMatch(/PHY \d+.*FIR \d+.*ICE \d+.*LIG \d+.*POI \d+/s);
  });
});

describe('Loadout — the FORGE card at the end of the row', () => {
  it('sits after the last weapon slot, on the same row', () => {
    const l = new Loadout();
    l.render(defaultMetaState(), 1280, 720);
    const p = privateOf(l);
    const last = p.weaponCards[PLAYER_BASE.weaponSlots - 1]!;
    expect(p.forgeCard.view.position.x).toBeGreaterThan(last.view.position.x);
    expect(p.forgeCard.view.position.y).toBe(last.view.position.y);
  });

  it('is always there, even with a full loadout — it is the way to change one', () => {
    const l = new Loadout();
    l.render({ ...defaultMetaState(), loadout: ['repeater', 'emberblade'] }, 1280, 720);
    expect(privateOf(l).forgeCard.view.visible).toBe(true);
  });

  it('tapping it fires onForge and nothing else', () => {
    const l = new Loadout();
    const calls: string[] = [];
    l.onForge = () => calls.push('forge');
    l.onStart = () => calls.push('start');
    l.render(defaultMetaState(), 1280, 720);
    privateOf(l).forgeCard.onTap?.();
    expect(calls).toEqual(['forge']);
  });

  it('carries the [F] key tag, which is the shortcut that opens the same page', () => {
    const l = new Loadout();
    l.render(defaultMetaState(), 1280, 720);
    expect(privateOf(l).forgeCard.keyLabel).toBe('[F]');
  });
});

describe('Loadout — the fixed bottom action bar', () => {
  it('anchors clear/start/hint to the viewport height, not to the content flow above them', () => {
    const l = new Loadout();
    l.render(defaultMetaState(), 1280, 720);
    const p = privateOf(l);
    expect(p.startBtn.view.position.y).toBe(720 - 60);
    expect(p.clearBtn.view.position.y).toBe(720 - 60 + 7);
    expect(p.hint.position.y).toBe(720 - 6);
  });

  it('stays at the same height-relative offset on a short viewport', () => {
    // The bug the forge was reported for, inherited along with the bar: a button whose y came
    // from `Math.min(flowedY, h - 70)` landed wherever the flow happened to overflow to.
    const l = new Loadout();
    l.render(defaultMetaState(), 1280, 480);
    const p = privateOf(l);
    expect(p.startBtn.view.position.y).toBe(480 - 60);
    expect(p.hint.position.y).toBe(480 - 6);
  });

  it('CLEAR and START run different verbs', () => {
    const l = new Loadout();
    const calls: string[] = [];
    l.onClear = () => calls.push('clear');
    l.onStart = () => calls.push('start');
    l.onBack = () => calls.push('back');
    l.render(defaultMetaState(), 1280, 720);
    const p = privateOf(l);
    p.clearBtn.onTap?.();
    p.startBtn.onTap?.();
    p.backBtn.onTap?.();
    expect(calls).toEqual(['clear', 'start', 'back']);
  });
});

/**
 * CONTINUE RUN (design/05 "Only the boss floor ends a run", ENGINE_VERSION 61) — this
 * screen's second primary button, and the two-row action bar it produces. Moved here from
 * `Forge.test.ts` with the button itself.
 */
describe('Loadout — CONTINUE RUN', () => {
  const SAVED = { floorIndex: 2, ticks: 5400, savedAtMs: 0 }; // floor 3, 3:00 played

  function withSave(saved: typeof SAVED | null = SAVED): Loadout {
    const l = new Loadout();
    l.savedRun = () => saved;
    return l;
  }

  it('is hidden with no saved run — the default provider answers null', () => {
    const l = new Loadout();
    l.render(defaultMetaState(), 1280, 720);
    expect(privateOf(l).continueBtn.view.visible).toBe(false);
  });

  it('appears when there is one', () => {
    const l = withSave();
    l.render(defaultMetaState(), 1280, 720);
    expect(privateOf(l).continueBtn.view.visible).toBe(true);
  });

  it('re-reads the provider on every render, so a cleared save stops being offered', () => {
    // The live case: the run is resumed (or won, or abandoned), the slot is cleared, and this
    // screen is re-rendered by the very navigation that got us back here.
    let saved: typeof SAVED | null = SAVED;
    const l = new Loadout();
    l.savedRun = () => saved;
    l.render(defaultMetaState(), 1280, 720);
    expect(privateOf(l).continueBtn.view.visible).toBe(true);

    saved = null;
    l.render(defaultMetaState(), 1280, 720);
    expect(privateOf(l).continueBtn.view.visible).toBe(false);
  });

  it('takes the footer slot, and pushes START RUN to the row above', () => {
    // Continuing is what a returning player came for, so it gets the primary position; and
    // the two must not overlap, because the other one discards the save.
    const l = withSave();
    l.render(defaultMetaState(), 1280, 720);
    const p = privateOf(l);
    expect(p.continueBtn.view.position.y).toBe(720 - 60);
    expect(p.startBtn.view.position.y).toBe(720 - 60 - 52);
  });

  it('leaves START RUN exactly where it was when there is no save', () => {
    const l = withSave(null);
    l.render(defaultMetaState(), 1280, 720);
    expect(privateOf(l).startBtn.view.position.y).toBe(720 - 60);
  });

  it('fires onContinue, never onStart', () => {
    const l = withSave();
    const calls: string[] = [];
    l.onStart = () => calls.push('start');
    l.onContinue = () => calls.push('continue');
    l.render(defaultMetaState(), 1280, 720);
    privateOf(l).continueBtn.onTap?.();
    expect(calls).toEqual(['continue']);
  });

  it('names the saved run — floor and time played', () => {
    // Two buttons that differ only by label are not enough to decide between "resume" and
    // "throw it away" on. 5400 ticks at 30 Hz is 3:00.
    const l = withSave();
    l.render(defaultMetaState(), 1280, 720);
    const p = privateOf(l);
    expect(p.savedText.visible).toBe(true);
    expect(p.savedText.text).toContain('floor 3'); // 0-based 2, displayed 1-based
    expect(p.savedText.text).toContain('3:00');
  });

  it('pads the seconds, so 65 ticks reads 0:02 and not 0:2', () => {
    const l = withSave({ floorIndex: 0, ticks: 65, savedAtMs: 0 });
    l.render(defaultMetaState(), 1280, 720);
    expect(privateOf(l).savedText.text).toContain('0:02');
  });

  it('says nothing about a saved run when there is none', () => {
    const l = new Loadout();
    l.render(defaultMetaState(), 1280, 720);
    const p = privateOf(l);
    expect(p.savedText.text).toBe('');
    expect(p.savedText.visible).toBe(false);
  });
});

describe('Loadout — i18n (design/17-i18n.md)', () => {
  it('render() retexts every static label from the active locale', () => {
    const l = new Loadout();
    l.savedRun = () => ({ floorIndex: 1, ticks: 1800, savedAtMs: 0 });
    setLocale('zh');
    l.render(defaultMetaState(), 1280, 720);
    const p = privateOf(l);
    expect(p.title.text).toBe('出击准备');
    expect(p.startBtn.label.text).toBe('开始行动 ▸');
    expect(p.continueBtn.label.text).toBe('继续行动 ▸');
    expect(p.clearBtn.label.text).toBe('清空装备');
    expect(p.backBtn.label.text).toBe('← 菜单');
    expect(p.hint.text).toBe('[C] 切换角色 · [X] 清空装备 · [F] 锻造场 · [Enter] 出发');
  });

  it('translates the character, the weapon cards and the forge card too', () => {
    const l = new Loadout();
    setLocale('zh');
    l.render({ ...defaultMetaState(), loadout: ['repeater'] }, 1280, 720);
    const p = privateOf(l);
    const def = SKIN_DEFS[defaultMetaState().selectedSkin]!;
    expect(p.charName.text).toBe('先锋');
    expect(p.charStats.text).toBe(`${def.maxHp} 生命 / ${def.maxShield} 护盾`);
    expect(p.weaponCards[0]!.nameLabel).toBe('连发枪');
    expect(p.weaponCards[0]!.statusLabel).toBe('已锻造');
    expect(p.weaponCards[1]!.statusLabel).toBe('默认武器');
    expect(p.forgeCard.nameLabel).toBe('锻造场');
    expect(p.infoText.text).toMatch(/物 \d+/);
  });

  it('switching back to English on a later render() fully reverts', () => {
    const l = new Loadout();
    setLocale('zh');
    l.render(defaultMetaState(), 1280, 720);
    setLocale('en');
    l.render(defaultMetaState(), 1280, 720);
    expect(privateOf(l).title.text).toBe('LOADOUT');
  });
});

describe('Loadout — visibility', () => {
  it('render() shows the screen and hide() takes it away', () => {
    const l = new Loadout();
    expect(l.view.visible).toBe(false); // screens start hidden
    l.render(defaultMetaState(), 1280, 720);
    expect(l.view.visible).toBe(true);
    l.hide();
    expect(l.view.visible).toBe(false);
  });
});
