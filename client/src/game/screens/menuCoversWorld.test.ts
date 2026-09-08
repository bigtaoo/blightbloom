/**
 * The premise `game/powerBudget.ts` rests on: **every screen it stops drawing the world behind
 * actually covers the world.**
 *
 * `worldDrawnInPhase` returns false for every phase but `'playing'`, so from the forge to the
 * pause menu to both result screens the `world` layer is not drawn at all. That is only correct
 * while each of those screens paints an opaque full-viewport backdrop. It was verified once, by
 * hand, with a frame probe on a running client (0 of 329,160 pixels changed with `layers.world`
 * switched off, at a phone-landscape viewport, in menu / paused / forge alike) — and a
 * one-off browser measurement is exactly the kind of evidence that silently stops being true.
 * Make one screen's panel translucent, or drop its background, and the frozen room behind it
 * becomes a hole showing `layers.backdrop`, with every test in this repo still green.
 *
 * What is checkable without a GPU is the mechanism rather than the pixels: each screen's
 * backdrop `Panel` mounts a full-bleed `Sprite` at `alpha === 1` spanning the whole viewport
 * from (0,0). Nothing behind an opaque sprite that covers the viewport can contribute to the
 * frame, and `layers.test.ts` already pins the other half — that `ui` paints after `world`.
 *
 * The panels are read directly rather than through `show()`: `Matchmaking.show` opens a
 * connection and `StoreScreen.show` lists SKUs, and the property under test is a property of
 * the backdrop, not of the layout above it. That also keeps this list complete — every screen
 * a menu-shaped phase can put up, including the two `viewportFit.test.ts` cannot build.
 */
import { describe, it, expect, vi } from 'vitest';
import { Sprite, Texture, TextureSource, type Container } from 'pixi.js';
import { installFakeTextCanvas } from './fakeTextCanvas';
import { Panel } from '../ui/widgets';
import { Forge } from './Forge';
import { LoginScreen } from './LoginScreen';
import { MainMenu } from './MainMenu';
import { Matchmaking } from './Matchmaking';
import { ModeSelect } from './ModeSelect';
import { PartyScreen } from './PartyScreen';
import { PauseMenu } from './PauseMenu';
import { PvpPreview } from './PvpPreview';
import { Screens } from './Screens';
import { Settings } from './Settings';
import { StoreScreen } from './StoreScreen';
import { StorePurchase } from '../controllers/StorePurchase';

// `getUiTexture` returns undefined under vitest (nothing preloads the UI pack), which is the
// FALLBACK branch — a panel with no background art is only its scrim, and translucent. Mocking
// the one key every full-screen panel asks for is what makes the shipped branch reachable here;
// everything else (button icons) keeps returning undefined exactly as it does elsewhere.
const mocks = vi.hoisted(() => ({ hub: undefined as Texture | undefined }));
vi.mock('../../render/uiSkins', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../render/uiSkins')>()),
  getUiTexture: (key: string) => (key === 'hub' ? mocks.hub : undefined),
}));

installFakeTextCanvas();

mocks.hub = new Texture({ source: new TextureSource({ width: 1024, height: 640 }) });

const W = 1280;
const H = 720;

/** The screens a phase with `worldDrawnInPhase === false` can have on screen, by the phase that
 *  shows it (`ScreenNav`). Built, not shown — see the header. */
const BACKDROPS: Array<[string, () => Panel]> = [
  ['menu → MainMenu', () => panelOf(new MainMenu())],
  ['modeSelect → ModeSelect', () => panelOf(new ModeSelect())],
  ['forge → Forge', () => panelOf(new Forge())],
  ['pvpPreview → PvpPreview', () => panelOf(new PvpPreview())],
  ['matchmaking → Matchmaking', () => panelOf(new Matchmaking())],
  ['paused → PauseMenu', () => panelOf(new PauseMenu())],
  ['victory/defeat → Screens', () => panelOf(new Screens())],
  ['settings → Settings', () => panelOf(new Settings())],
  ['squad → PartyScreen', () => panelOf(new PartyScreen({ matchBaseUrl: '' }))],
  ['account → LoginScreen', () => panelOf(new LoginScreen({ matchBaseUrl: '' }))],
  ['store → StoreScreen', () => panelOf(new StoreScreen(new StorePurchase({
    baseUrl: () => '', platform: () => null, refreshOwnership: async () => {}, sleep: async () => {},
  })))],
];

/** Each screen's own backdrop panel — a private field on every one of them. */
function panelOf(screen: object): Panel {
  return (screen as unknown as { panel: Panel }).panel;
}

/** The full-bleed opaque sprite in a laid-out panel, or null if it has none. */
function coveringSprite(view: Container, w: number, h: number): Sprite | null {
  for (const child of view.children) {
    if (!(child instanceof Sprite)) continue;
    if (child.alpha !== 1 || !child.visible) continue;
    if (child.x > 0 || child.y > 0) continue;
    if (child.width < w || child.height < h) continue;
    return child;
  }
  return null;
}

describe('every menu-shaped screen covers the world it is drawn instead of', () => {
  it.each(BACKDROPS)('%s', (_name, build) => {
    const panel = build();
    panel.layout(W, H);
    const cover = coveringSprite(panel.view, W, H);
    expect(cover).not.toBeNull();
    // Exactly the viewport, from the origin: a sprite merely BIGGER than the viewport would
    // also hide the world, but this is a stretch-to-fill background and a mismatch means the
    // panel and the screen disagree about what size they were handed.
    expect(cover!.width).toBe(W);
    expect(cover!.height).toBe(H);
    expect([cover!.x, cover!.y]).toEqual([0, 0]);
    // Behind the scrim, i.e. first in paint order — the scrim is translucent by design, so an
    // opaque sprite drawn OVER it would hide the screen's own art instead of the world.
    expect(panel.view.children.indexOf(cover!)).toBe(0);
  });

  it('re-covers a resized viewport, so an orientation change cannot open a hole', () => {
    // `Panel.layout` early-returns when the size is unchanged, which is the shape that would
    // leave a phone-landscape panel sized for the portrait viewport it booted in.
    const panel = panelOf(new PauseMenu());
    panel.layout(W, H);
    panel.layout(844, 390);
    const cover = coveringSprite(panel.view, 844, 390);
    expect(cover).not.toBeNull();
    expect([cover!.width, cover!.height]).toEqual([844, 390]);
  });

  it('fails for a panel with no background — the check can actually go red', () => {
    // The negative control. Without it, `coveringSprite` returning a sprite for every screen
    // proves nothing: a bug that made it match anything would read as a clean pass. This is
    // also the real degraded state — a `Panel` whose texture never loaded is scrim only, so it
    // is genuinely translucent, and that is a known, accepted look (a dark backdrop instead of
    // the frozen room), not a correctness failure.
    const bare = new Panel({ alpha: 0.82 });
    bare.layout(W, H);
    expect(coveringSprite(bare.view, W, H)).toBeNull();
  });

  it('fails for a panel too small for the viewport', () => {
    // The other way the property can break: a background sized to something other than the
    // screen it is covering.
    const panel = panelOf(new Settings());
    panel.layout(400, 300);
    expect(coveringSprite(panel.view, W, H)).toBeNull();
  });
});
