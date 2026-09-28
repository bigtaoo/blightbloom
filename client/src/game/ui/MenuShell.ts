// The shell a menu screen composes (design/10 "One shell for every menu", 2026-09-27): the
// dimmed lobby painting, a BACK chip pinned top-left, and a framed `MenuSheet` centred in the
// room left, scaled up with the viewport the way the lobby is.
//
// ## What it fixes, per the audit of every screen outside the lobby
//
//  - The backdrop was the old 384x288 hub art under a dark scrim — a different, murkier place
//    than the lobby every one of these screens is a door out of. It is the lobby painting now.
//  - The menu layer only ever scales DOWN (`menuLayer.ts`), so on a desktop window a screen
//    sat at its phone size in a sea of background. The shell scales its sheet and chrome up
//    by `lobbyScale`, capped by what fits.
//  - BACK was top-left on two screens, bottom-centre on three and bottom-right on one. It is
//    top-left, at the same inset and height as the lobby's corner chips, everywhere.
//
// ## How a screen uses it
//
// `mount(view)` into the screen's own view, build widgets into `content` in the sheet's own
// units (the origin is the content area's top-left, `SHEET_PAD` inside the frame, under the
// title), then call `layout(w, h, sheetW, sheetH)` from the screen's own layout. Keep the
// backdrop in the screen's `panel` field: `menuCoversWorld.test.ts` reads every screen's
// backdrop by that name, and `viewportFit.test.ts` skips the screen view's child 0 as the
// backdrop, which is why `mount` puts it there rather than inside the shell's own view.
import { Container } from 'pixi.js';
import { Button } from './widgets';
import { LobbyBackdrop } from './LobbyBackdrop';
import { MenuSheet } from './MenuSheet';
import { lobbyScale, sharpenText } from './lobbyScale';
import { MENU_BACKDROP_DIM, MENU_BUTTONS } from './menuTheme';
import { whenUiTexture } from '../../render/uiSkins';

/** The corner chrome's inset and height — the lobby's (`MainMenu`'s `EDGE`/`CHROME_H`). */
export const SHELL_EDGE = 14;
export const SHELL_CHROME_H = 40;
/** The least room kept between the sheet and the viewport's edges, in design px. */
const MARGIN = 16;

export class MenuShell {
  /** The sheet and the chrome — everything but the backdrop, which `mount` puts under it. */
  readonly view = new Container();
  readonly backdrop = new LobbyBackdrop({ dim: MENU_BACKDROP_DIM, daisU: 0.5 });
  readonly sheet: MenuSheet;
  /** Where a screen builds its content, in the sheet's units, from the content area's corner. */
  readonly content = new Container();
  readonly backBtn: Button;
  private readonly root = new Container();
  private readonly chrome = new Container();
  /** An optional chip pinned top-RIGHT, mirroring BACK (`setCorner`). */
  private corner: Button | null = null;
  private k = 1;
  onBack: (() => void) | null = null;

  constructor(opts: { title: string; back: string }) {
    this.sheet = new MenuSheet(opts.title);
    this.backBtn = new Button(opts.back, { w: 96, h: SHELL_CHROME_H, fontSize: 13, autoWidth: true, sound: 'ui.back', ...MENU_BUTTONS.chrome });
    whenUiTexture('icon_back', (tex) => this.backBtn.setIcon(tex, 0x4a5568));
    this.backBtn.onTap = () => this.onBack?.();
    this.chrome.addChild(this.backBtn.view);
    this.root.addChild(this.sheet.view, this.content);
    this.view.addChild(this.root, this.chrome);
  }

  /**
   * Pin a chip top-right, at BACK's inset and scale — the loadout's SETTINGS chip, which is a
   * shared button the assembly floats over the screens rather than one this screen owns. The
   * shell only places it: it stays in its own parent, which lays out in the same menu design
   * space the screen's view does.
   */
  setCorner(btn: Button | null): void {
    this.corner = btn;
  }

  /** Put the backdrop and then the shell into a screen's view, as its first two children. */
  mount(screen: Container): void {
    screen.addChildAt(this.view, 0);
    screen.addChildAt(this.backdrop.view, 0);
  }

  /** The scale the last `layout` settled on — for a screen that positions something of its
   *  own (a DOM input) against the sheet. */
  get scale(): number {
    return this.k;
  }

  setTitle(text: string): void {
    this.sheet.setTitle(text);
  }

  setBack(text: string): void {
    this.backBtn.setText(text);
  }

  /**
   * Lay the shell out in a `w x h` design space around a `sheetW x sheetH` sheet (unscaled),
   * and return the content area's size in the sheet's own units.
   *
   * The scale is the lobby's (`lobbyScale`), then capped so the sheet fits under the chrome
   * row; the sheet is centred in the viewport, and pushed down only as far as it takes to clear
   * the BACK chip when the two would overlap.
   */
  layout(w: number, h: number, sheetW: number, sheetH: number): { w: number; h: number } {
    this.backdrop.layout(w, h);
    const want = lobbyScale(w, h);
    const chromeBottomAt = (k: number) => SHELL_EDGE * k + SHELL_CHROME_H * k;
    const fitW = (w - MARGIN * 2) / sheetW;
    const fitH = (h - chromeBottomAt(want) - MARGIN * 2) / sheetH;
    const k = Math.max(0.1, Math.min(want, fitW, fitH));
    this.k = k;

    this.chrome.scale.set(k);
    this.chrome.position.set(SHELL_EDGE * k, SHELL_EDGE * k);

    const area = this.sheet.layout(sheetW, sheetH);
    const drawnW = sheetW * k;
    const drawnH = sheetH * k;
    const x = (w - drawnW) / 2;
    // Centred, so the gap on the right is the gap on the left: the wider corner chip decides.
    const chipRight = (SHELL_EDGE + Math.max(this.backBtn.width, this.corner?.width ?? 0)) * k;
    const minTop = x < chipRight + MARGIN ? chromeBottomAt(k) + MARGIN : MARGIN;
    const y = Math.max(minTop, (h - drawnH) / 2);
    this.root.scale.set(k);
    this.root.position.set(x, y);
    this.content.position.set(area.x, area.y);

    if (this.corner) {
      this.corner.view.scale.set(k);
      this.corner.view.position.set(w - (SHELL_EDGE + this.corner.width) * k, SHELL_EDGE * k);
      sharpenText(this.corner.view, k);
    }
    sharpenText(this.view, k);
    return { w: area.w, h: area.h };
  }

  /** Re-rasterise text that changed after `layout` (a status line, a retext). */
  sharpen(): void {
    sharpenText(this.view, this.k);
  }

  /** Per-frame: the painting's rocks, glow and motes. The owning screen gates it on its own
   *  visibility. */
  update(dtMs: number): void {
    this.backdrop.update(dtMs);
  }
}
