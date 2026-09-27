// The lobby's own scale (design/10 "The lobby, redesigned", 2026-09-27) — and the one thing a
// scaled-up container needs so its text does not go soft.
//
// `menuLayer.ts` fits every menu screen DOWN to small viewports and never scales one up, so on
// a desktop window the lobby's controls were drawn at their phone size with the rest of the
// window left to background. The lobby alone now scales its column, header and corner chrome
// up to `LOBBY_MAX_SCALE`, from the same 760x640 design size the layer fits against. Only the
// lobby: the other screens are dense with text and read fine at 1:1.
import { Container, Text } from 'pixi.js';
import { MENU_DESIGN_W, MENU_DESIGN_H } from './menuLayer';

export const LOBBY_MAX_SCALE = 1.5;

/** 1 at (or under) the design size, growing with the viewport up to `LOBBY_MAX_SCALE`. */
export function lobbyScale(w: number, h: number): number {
  if (!(w > 0) || !(h > 0)) return 1;
  return Math.min(LOBBY_MAX_SCALE, Math.max(1, Math.min(w / MENU_DESIGN_W, h / MENU_DESIGN_H)));
}

/**
 * Render every `Text` under `root` at `k` times the device resolution, so a label inside a
 * container scaled by `k` is rasterised at the size it is drawn rather than magnified from a
 * smaller bitmap. `k = 1` hands the texts back to Pixi's automatic resolution.
 */
export function sharpenText(root: Container, k: number): void {
  const dpr = typeof globalThis.devicePixelRatio === 'number' ? Math.min(2, globalThis.devicePixelRatio) : 1;
  const resolution = k > 1 ? dpr * k : null;
  const walk = (c: Container) => {
    if (c instanceof Text) {
      // Assigned only on a change: every assignment re-rasterises the text.
      if (resolution === null) {
        if (!isAuto(c)) c.resolution = null as unknown as number; // Pixi: null = automatic
      } else if (isAuto(c) || c.resolution !== resolution) {
        c.resolution = resolution;
      }
      return;
    }
    for (const child of c.children) walk(child as Container);
  };
  walk(root);
}

function isAuto(t: Text): boolean {
  return (t as unknown as { _autoResolution?: boolean })._autoResolution !== false;
}
