/**
 * `PlayerCard`/`AllyRow` are the two widgets that answer "who is on this team and how
 * are they doing". Both cache on identity (skin id) while updating on value every
 * frame, so the things worth pinning are: the shield bar's presence tracks the
 * character's actual pool rather than being drawn always-empty, the portrait binding
 * survives a skin with no loaded art (art is best-effort everywhere in this codebase),
 * and the ally row's downed branch actually swaps.
 *
 * `skinRegistry.getRigSkin` is mocked (the `vi.hoisted` convention `scene/Skin.test.ts`
 * established, in the `importOriginal` form `screens/Loadout.test.ts` uses so the
 * module's other exports survive) because under plain vitest there is no asset pipeline,
 * so the real one answers `undefined` for every key — which left the whole bound-texture
 * half of `bindPortrait` unreachable, and therefore unrun: the contain fit, the child
 * index, and the re-bind on a character change. `AllyRow` has no portrait, so all of
 * that is scoped to `PlayerCard`. `Loadout.test.ts` makes the same claims about the
 * loadout screen's own 104px portrait; this file is the 44px HUD card.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { Graphics, Sprite, Text, Texture, TextureSource, type Container } from 'pixi.js';
import { PlayerCard, AllyRow } from './PlayerCard';
import { resetLocaleForTests } from '../../i18n';
import { useLocale } from '../../i18n/loadLocale';

/** Only the one path `bindPortrait` walks — `getRigSkin(atlasKey)?.bundle.textures` —
 *  is faked; a whole `LoadedRigSkin` (rig, referenceRadius, bodyFill) would be four
 *  fields of ceremony the card never reads. */
const mocks = vi.hoisted(() => ({
  rigs: new Map<string, { bundle: { textures: Map<string, unknown> } }>(),
  lookups: [] as string[],
}));
vi.mock('../../render/skinRegistry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../render/skinRegistry')>()),
  getRigSkin: (name: string) => {
    mocks.lookups.push(name);
    return mocks.rigs.get(name);
  },
}));

beforeEach(() => {
  mocks.rigs.clear();
  mocks.lookups.length = 0;
});
afterEach(() => resetLocaleForTests());

// Constructor child order: frame, fallback, name, hpBar.view, shieldBar.view.
const SHIELD_BAR = 4;

function shieldBarOf(card: PlayerCard): Container {
  return card.view.children[SHIELD_BAR] as Container;
}

// `portrait`/`fallback` are private with no accessor — reached by cast, the way
// Actor.test.ts's `skinOf` and Skin.test.ts's `internals` reach theirs.
function internals(card: PlayerCard): { portrait: Sprite | null; fallback: Graphics } {
  return card as unknown as { portrait: Sprite | null; fallback: Graphics };
}

function tex(width: number, height: number): Texture {
  return new Texture({ source: new TextureSource({ width, height }) });
}

/** `atlasKey` is `SKIN_DEFS[skinId].atlasKey` (`char_vanguard`), deliberately NOT the
 *  skin id. Pass no texture for a rig that loaded without the `shell` slot. */
function registerArt(atlasKey: string, texture?: Texture): void {
  const textures = new Map<string, unknown>();
  if (texture) textures.set('shell', texture);
  mocks.rigs.set(atlasKey, { bundle: { textures } });
}

/** The fallback disc is drawn into `fallback` and `clear()`ed on the bound-texture
 *  side, so its instruction count is what says which of the two ran last. */
function discDrawn(card: PlayerCard): boolean {
  return internals(card).fallback.context.instructions.length > 0;
}

describe('PlayerCard — identity', () => {
  it('titles the card with the character\'s translated display name', () => {
    const card = new PlayerCard();
    card.set('juggernaut', 11, 11, 0, 0);
    expect(card.displayName).toBe('Juggernaut');
  });

  it('re-titles when the character changes between runs', () => {
    const card = new PlayerCard();
    card.set('juggernaut', 11, 11, 0, 0);
    card.set('skirmisher', 6, 6, 5, 5);
    expect(card.displayName).toBe('Skirmisher');
  });

  it('survives a skin id with no registered art (portrait is best-effort)', () => {
    const card = new PlayerCard();
    expect(() => card.set('a-skin-that-does-not-exist', 10, 10, 0, 0)).not.toThrow();
    expect(card.displayName).toBe('A-SKIN-THAT-DOES-NOT-EXIST');
  });
});

describe('PlayerCard — the portrait (the bound-texture branch)', () => {
  // PORTRAIT is 44 and the art is contained into a 4px-inset box, so every fit below
  // is against an inner of 36. Restated rather than imported because both constants
  // are private: if one moves, these numbers are supposed to go red.
  const BOX = 44;
  const INNER = 36;

  it("binds the character's own shell art above the frame and below the text", () => {
    registerArt('char_vanguard', tex(64, 64));
    const card = new PlayerCard();
    card.set('vanguard', 10, 10, 0, 0);

    const sprite = internals(card).portrait;
    expect(sprite).toBeInstanceOf(Sprite);
    const kids = card.view.children;
    // Index 1 is the whole point: at 0 the frame would paint over the face, and at the
    // end it would paint over the name and both bars.
    expect(kids.indexOf(sprite as Sprite)).toBe(1);
    expect(kids[0]).toBeInstanceOf(Graphics); // the frame it sits above
    expect(kids.findIndex((c) => c instanceof Text)).toBeGreaterThan(1); // the name it sits below
  });

  it('looks the art up by atlasKey, not by the skin id', () => {
    registerArt('vanguard', tex(64, 64)); // right texture, wrong key
    const card = new PlayerCard();
    card.set('vanguard', 10, 10, 0, 0);

    expect(mocks.lookups).toEqual(['char_vanguard']);
    expect(internals(card).portrait).toBeNull();
  });

  it('CONTAINS a wide texture rather than stretching it to the box', () => {
    registerArt('char_vanguard', tex(80, 40));
    const card = new PlayerCard();
    card.set('vanguard', 10, 10, 0, 0);

    const { scale } = internals(card).portrait!;
    // Uniform is the claim: a stretch fit (inner/w, inner/h) would read 0.45 by 0.9 and
    // squash the character 2:1. Both the ratio and the magnitude are pinned, so neither
    // a per-axis fit nor a Math.max survives.
    expect(scale.x).toBe(scale.y);
    expect(scale.x).toBeCloseTo(INNER / 80, 10);
    expect(80 * scale.x).toBeCloseTo(INNER, 10); // the long side touches the box
    expect(40 * scale.y).toBeLessThan(INNER); //   the short one stays inside it
  });

  it('CONTAINS a tall texture too — the other arm of the same Math.min', () => {
    registerArt('char_vanguard', tex(40, 80));
    const card = new PlayerCard();
    card.set('vanguard', 10, 10, 0, 0);

    const { scale } = internals(card).portrait!;
    expect(scale.x).toBe(scale.y);
    expect(scale.y).toBeCloseTo(INNER / 80, 10);
    expect(80 * scale.y).toBeCloseTo(INNER, 10);
    expect(40 * scale.x).toBeLessThan(INNER);
  });

  it('centres the portrait in the box', () => {
    registerArt('char_vanguard', tex(64, 64));
    const card = new PlayerCard();
    card.set('vanguard', 10, 10, 0, 0);

    const sprite = internals(card).portrait!;
    expect(sprite.anchor.x).toBe(0.5);
    expect(sprite.anchor.y).toBe(0.5);
    // Centre-anchored at the box's centre. Left at the default (0, 0) the face would
    // hang off the card's top-left corner by half its own size.
    expect(sprite.position.x).toBe(BOX / 2);
    expect(sprite.position.y).toBe(BOX / 2);
  });

  it('clears a disc that was already drawn when the NEXT character does have art', () => {
    registerArt('char_vanguard', tex(64, 64));
    const card = new PlayerCard();
    card.set('juggernaut', 11, 11, 0, 0); // char_juggernaut unregistered → placeholder disc
    expect(discDrawn(card)).toBe(true);

    card.set('vanguard', 10, 10, 0, 0);
    expect(internals(card).portrait).not.toBeNull();
    // The other direction of the swap above. Without the clear on the bound side the
    // teal placeholder stays painted under the face it was standing in for — and since
    // the disc is inset well within the portrait, it shows around nothing and reads as
    // a tint on the art. Asserting this on a FRESH card proves nothing: the constructor
    // draws no disc, so there the clear is a no-op.
    expect(discDrawn(card)).toBe(false);
  });

  it('re-binds texture AND fit when the character changes', () => {
    const vanguard = tex(80, 40);
    const skirmisher = tex(24, 24);
    registerArt('char_vanguard', vanguard);
    registerArt('char_skirmisher', skirmisher);
    const card = new PlayerCard();

    card.set('vanguard', 10, 10, 0, 0);
    const first = internals(card).portrait!;
    expect(first.texture).toBe(vanguard);
    expect(first.scale.x).toBeCloseTo(INNER / 80, 10);

    card.set('skirmisher', 6, 6, 5, 5);
    const second = internals(card).portrait!;
    expect(second.texture).toBe(skirmisher);
    // The refit is a separate claim from the rebind: a bindPortrait that only swapped
    // the texture on an existing sprite would keep 0.45 and draw the new art at 11px.
    expect(second.scale.x).toBeCloseTo(INNER / 24, 10);
    expect(card.view.children.filter((c) => c instanceof Sprite)).toHaveLength(1);
  });

  it('drops back to the disc when the NEXT character has no art, keeping no stale face', () => {
    registerArt('char_vanguard', tex(64, 64));
    const card = new PlayerCard();
    card.set('vanguard', 10, 10, 0, 0);
    expect(internals(card).portrait).not.toBeNull();

    card.set('juggernaut', 11, 11, 0, 0); // char_juggernaut never registered
    expect(internals(card).portrait).toBeNull();
    expect(card.view.children.filter((c) => c instanceof Sprite)).toHaveLength(0);
    expect(discDrawn(card)).toBe(true);
    expect(card.displayName).toBe('Juggernaut'); // the name moved on; the face must too
  });

  it('falls back for a rig that loaded without the shell slot', () => {
    registerArt('char_vanguard'); // resolves, but its bundle has no PORTRAIT_SLOT
    const card = new PlayerCard();
    card.set('vanguard', 10, 10, 0, 0);

    expect(internals(card).portrait).toBeNull();
    expect(discDrawn(card)).toBe(true);
  });

  it('binds once per identity — a same-character update does not re-look-up the art', () => {
    registerArt('char_vanguard', tex(64, 64));
    const card = new PlayerCard();
    card.set('vanguard', 10, 10, 0, 0);
    card.set('vanguard', 4, 10, 0, 0); // damage, same character
    expect(mocks.lookups).toEqual(['char_vanguard']);

    card.set('skirmisher', 6, 6, 5, 5);
    expect(mocks.lookups).toEqual(['char_vanguard', 'char_skirmisher']);
  });
});

describe('PlayerCard — the two defensive pools (design/07)', () => {
  it('hides the shield bar for a zero-shield body instead of drawing an empty track', () => {
    const card = new PlayerCard();
    card.set('juggernaut', 11, 11, 0, 0); // juggernaut: flat HP, no shield
    expect(shieldBarOf(card).visible).toBe(false);
  });

  it('shows the shield bar for a character that has a pool', () => {
    const card = new PlayerCard();
    card.set('skirmisher', 6, 6, 5, 5);
    expect(shieldBarOf(card).visible).toBe(true);
  });

  it('follows a character swap in both directions', () => {
    const card = new PlayerCard();
    card.set('skirmisher', 6, 6, 5, 5);
    expect(shieldBarOf(card).visible).toBe(true);
    card.set('juggernaut', 11, 11, 0, 0);
    expect(shieldBarOf(card).visible).toBe(false);
  });

  it('clamps a negative hp (over-kill damage) without throwing', () => {
    const card = new PlayerCard();
    expect(() => card.set('juggernaut', -5, 11, 0, 0)).not.toThrow();
  });

  it('update() advances both bars without throwing, shield present or not', () => {
    const card = new PlayerCard();
    card.set('juggernaut', 11, 11, 0, 0);
    expect(() => card.update(16)).not.toThrow();
    card.set('skirmisher', 6, 6, 5, 5);
    expect(() => card.update(16)).not.toThrow();
  });
});

describe('PlayerCard — layout width', () => {
  it('never reports narrower than the health bar it draws', () => {
    const card = new PlayerCard();
    card.set('x', 10, 10, 0, 0);
    expect(card.estimatedWidth()).toBeGreaterThanOrEqual(150);
  });

  it('grows for a name long enough to overrun the bar', () => {
    const card = new PlayerCard();
    card.set('x', 10, 10, 0, 0);
    const narrow = card.estimatedWidth();
    card.set('a-very-long-character-skin-name-indeed', 10, 10, 0, 0);
    expect(card.estimatedWidth()).toBeGreaterThan(narrow);
  });
});

describe('AllyRow', () => {
  it('names the teammate with their translated character name', () => {
    const row = new AllyRow();
    row.set('vanguard', 8, 10, false, 0);
    expect(row.nameText).toBe('ALLY · Vanguard');
    expect(row.statusText).toBe('');
  });

  it('echoes back an unrecognized skin id raw, rather than falling back to a default character', () => {
    const row = new AllyRow();
    row.set('not-a-real-skin', 8, 10, false, 0);
    expect(row.nameText).toBe('ALLY · not-a-real-skin');
  });

  it('shows the bleedout countdown while downed', () => {
    const row = new AllyRow();
    row.set('vanguard', 0, 10, true, 4);
    expect(row.statusText).toBe('DOWNED 4s');
  });

  it('clears the downed status once revived', () => {
    const row = new AllyRow();
    row.set('vanguard', 0, 10, true, 4);
    row.set('vanguard', 3, 10, false, 0);
    expect(row.statusText).toBe('');
  });

  it('translates both branches under zh', async () => {
    await useLocale('zh');
    const row = new AllyRow();
    row.set('vanguard', 8, 10, false, 0);
    expect(row.nameText).toBe('队友·先锋');
    row.set('vanguard', 0, 10, true, 2);
    expect(row.statusText).toBe('倒地 2秒');
  });

  it('widens to fit the downed status, which sits right of the bar', () => {
    const row = new AllyRow();
    row.set('vanguard', 8, 10, false, 0);
    const healthy = row.estimatedWidth();
    row.set('vanguard', 0, 10, true, 12);
    expect(row.estimatedWidth()).toBeGreaterThan(healthy);
  });

  it('update() advances the bar without throwing', () => {
    const row = new AllyRow();
    row.set('vanguard', 8, 10, false, 0);
    expect(() => row.update(16)).not.toThrow();
  });

  it('shows revive progress instead of the frozen bleedout countdown once a channel is active', () => {
    const row = new AllyRow();
    row.set('vanguard', 0, 10, true, 4, 225); // REVIVE_CHANNEL_TICKS is 450 → 50%
    expect(row.statusText).toBe('REVIVING 50%');
  });

  it('falls back to the bleedout countdown when no revive is in progress (default param)', () => {
    const row = new AllyRow();
    row.set('vanguard', 0, 10, true, 4);
    expect(row.statusText).toBe('DOWNED 4s');
  });
});
