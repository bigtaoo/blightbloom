import { Container, Graphics } from 'pixi.js';
import { Button } from '../ui/widgets';
import { MenuShell } from '../ui/MenuShell';
import type { LobbyBackdrop } from '../ui/LobbyBackdrop';
import { SHEET_PAD, SHEET_TITLE_H } from '../ui/MenuSheet';
import { MENU_BUTTONS, MENU_COLORS } from '../ui/menuTheme';
import { getUiTexture } from '../../render/uiSkins';
import { t } from '../../i18n';

/** The sheet's width and content width; the rows' heights and the gaps between them. */
const SHEET_W = 360;
const CONTENT_W = SHEET_W - SHEET_PAD * 2;
const RESUME_H = 48;
const ROW_H = 44;
const GAP = 10;
/** The room the hairline between "stay in the run" and "leave it" takes. */
const DIVIDER_H = 22;

/**
 * The in-run pause menu (design/10 open question, now resolved) — resume / open
 * settings / save & quit / quit to the forge, reachable mid-run instead of only between
 * runs. Pure presentation, same shape as Screens.ts/Settings.ts: it reads nothing from the
 * engine, Game owns what each button actually does.
 *
 * SAVE & QUIT arrived with ENGINE_VERSION 61 (design/05 "Only the boss floor ends a run").
 * It is shown CONDITIONALLY — only for a run that can actually be saved, which is
 * single-player offline dungeon runs (`match/runSave.ts savableRun`) — and the plain QUIT
 * button stays put beside it rather than being replaced, because the two are different
 * decisions: one keeps the run, the other throws it away. Collapsing them into one button
 * whose meaning depends on the mode is how a player loses a run they meant to keep.
 *
 * Since the menu shell (design/10 "One shell for every menu", 2026-09-27) it is one framed
 * sheet in two groups under a hairline: RESUME (the primary, green) and SETTINGS stay in the
 * run; SAVE & QUIT and QUIT (red, the one that throws the run away) leave it. The shell's
 * corner chip is a second RESUME, in the corner every other screen's way back sits.
 */
export class PauseMenu {
  readonly view = new Container();
  private readonly shell: MenuShell;
  /** The dimmed lobby painting (`MenuShell`'s header has why). Named `panel` for
   *  `menuCoversWorld.test.ts`. */
  private readonly panel: LobbyBackdrop;
  private readonly rules = new Graphics();
  private resumeBtn: Button;
  private settingsBtn: Button;
  private saveQuitBtn: Button;
  private quitBtn: Button;

  onResume: (() => void) | null = null;
  onSettings: (() => void) | null = null;
  onSaveQuit: (() => void) | null = null;
  onQuit: (() => void) | null = null;

  constructor() {
    this.shell = new MenuShell({ title: t('pauseMenu.title'), back: t('pauseMenu.resume') });
    this.shell.onBack = () => this.onResume?.();
    this.panel = this.shell.backdrop;

    this.resumeBtn = new Button(t('pauseMenu.resume'), { w: CONTENT_W, h: RESUME_H, fontSize: 16, sound: 'ui.back', ...MENU_BUTTONS.primary });
    this.resumeBtn.onTap = () => this.onResume?.();
    this.resumeBtn.setIcon(getUiTexture('icon_play'));
    this.settingsBtn = new Button(t('pauseMenu.settings'), { w: CONTENT_W, h: ROW_H, ...MENU_BUTTONS.secondary });
    this.settingsBtn.onTap = () => this.onSettings?.();
    this.settingsBtn.setIcon(getUiTexture('icon_settings'));
    this.saveQuitBtn = new Button(t('pauseMenu.saveQuit'), { w: CONTENT_W, h: ROW_H, sound: 'ui.back', ...MENU_BUTTONS.secondary });
    this.saveQuitBtn.onTap = () => this.onSaveQuit?.();
    this.saveQuitBtn.setIcon(getUiTexture('icon_play'));
    this.quitBtn = new Button(t('pauseMenu.quit'), { w: CONTENT_W, h: ROW_H, sound: 'ui.back', ...MENU_BUTTONS.danger });
    this.quitBtn.onTap = () => this.onQuit?.();
    this.quitBtn.setIcon(getUiTexture('icon_quit'));

    this.shell.content.addChild(this.rules, this.resumeBtn.view, this.settingsBtn.view,
      this.saveQuitBtn.view, this.quitBtn.view);
    this.shell.mount(this.view);
    this.view.eventMode = 'static';
    this.view.visible = false;
  }

  /** `quitLabelText`, if given, overrides the quit button's label (e.g. "SKIP TUTORIAL"
   * during the tutorial level, design/10 screen-flow gap) — the button still calls the
   * same `onQuit`, only the wording changes since it no longer always returns to Forge.
   *
   * `savable` shows the SAVE & QUIT row (see the class header). The caller computes it from
   * `savableRun()` rather than this screen deciding, for the same reason the quit label is
   * passed in: presentation does not get to know what kind of run is in flight. */
  show(w: number, h: number, quitLabelText?: string, savable = false) {
    // Re-apply static labels so a language change (design/17-i18n.md) takes effect the
    // next time this screen opens, same convention as MainMenu.ts's `retext()`.
    this.shell.setTitle(t('pauseMenu.title'));
    this.shell.setBack(t('pauseMenu.resume'));
    this.resumeBtn.setText(t('pauseMenu.resume'));
    this.settingsBtn.setText(t('pauseMenu.settings'));
    this.saveQuitBtn.setText(t('pauseMenu.saveQuit'));
    this.quitBtn.setText(quitLabelText ?? t('pauseMenu.quit'));
    this.saveQuitBtn.view.visible = savable;
    this.shell.layout(w, h, SHEET_W, SHEET_TITLE_H + 18 + this.flow(savable) + SHEET_PAD);
    this.view.visible = true;
  }

  /** Stack the two groups and return the content's height. The rows grow downward from a
   *  fixed top, so RESUME and SETTINGS sit at the same place in the sheet whether it is
   *  three rows or four, and QUIT takes the row under SAVE & QUIT rather than its slot. */
  private flow(savable: boolean): number {
    let y = 0;
    this.resumeBtn.view.position.set(0, y);
    y += RESUME_H + GAP;
    this.settingsBtn.view.position.set(0, y);
    y += ROW_H;
    this.rules.clear().rect(0, y + DIVIDER_H / 2, CONTENT_W, 1).fill({ color: MENU_COLORS.frame, alpha: 0.35 });
    y += DIVIDER_H;
    this.saveQuitBtn.view.position.set(0, y);
    if (savable) y += ROW_H + GAP;
    this.quitBtn.view.position.set(0, y);
    return y + ROW_H;
  }

  /** Per-frame: the backdrop's rocks, glow and motes. Driven from the main loop's
   *  `menuScreens`, and a no-op while this screen is hidden. */
  animate(dtMs: number): void {
    if (this.view.visible) this.panel.update(dtMs);
  }

  hide() {
    this.view.visible = false;
  }
}
