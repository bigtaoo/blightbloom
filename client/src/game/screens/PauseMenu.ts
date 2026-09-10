import { Container, Text } from 'pixi.js';
import { Panel, Button } from '../ui/widgets';
import { getUiTexture } from '../../render/uiSkins';
import { t } from '../../i18n';

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
 */
export class PauseMenu {
  readonly view = new Container();
  private panel = new Panel({ alpha: 0.82, background: 'hub' });
  private title: Text;
  private resumeBtn: Button;
  private settingsBtn: Button;
  private saveQuitBtn: Button;
  private quitBtn: Button;

  onResume: (() => void) | null = null;
  onSettings: (() => void) | null = null;
  onSaveQuit: (() => void) | null = null;
  onQuit: (() => void) | null = null;

  constructor() {
    this.title = new Text({ text: t('pauseMenu.title'), style: { fill: 0xf7fafc, fontSize: 34, fontWeight: 'bold', fontFamily: 'sans-serif' } });
    this.title.anchor.set(0.5, 0);

    this.resumeBtn = new Button(t('pauseMenu.resume'), { w: 200, h: 40, sound: 'ui.back' });
    this.resumeBtn.onTap = () => this.onResume?.();
    this.resumeBtn.setIcon(getUiTexture('icon_play'));
    this.settingsBtn = new Button(t('pauseMenu.settings'), { w: 200, h: 40 });
    this.settingsBtn.onTap = () => this.onSettings?.();
    this.settingsBtn.setIcon(getUiTexture('icon_settings'));
    this.saveQuitBtn = new Button(t('pauseMenu.saveQuit'), { w: 200, h: 40, sound: 'ui.back' });
    this.saveQuitBtn.onTap = () => this.onSaveQuit?.();
    this.saveQuitBtn.setIcon(getUiTexture('icon_play'));
    this.quitBtn = new Button(t('pauseMenu.quit'), { w: 200, h: 40, sound: 'ui.back' });
    this.quitBtn.onTap = () => this.onQuit?.();
    this.quitBtn.setIcon(getUiTexture('icon_quit'));

    this.view.addChild(this.panel.view, this.title, this.resumeBtn.view, this.settingsBtn.view,
      this.saveQuitBtn.view, this.quitBtn.view);
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
    this.title.text = t('pauseMenu.title');
    this.resumeBtn.setText(t('pauseMenu.resume'));
    this.settingsBtn.setText(t('pauseMenu.settings'));
    this.saveQuitBtn.setText(t('pauseMenu.saveQuit'));
    this.quitBtn.setText(quitLabelText ?? t('pauseMenu.quit'));
    this.panel.layout(w, h);
    const cx = w / 2;
    const cy = h / 2;
    // The stack keeps its centre whether it is three rows or four, so RESUME does not jump
    // between a savable and a non-savable run — the rows grow downward from a fixed top.
    this.title.position.set(cx, cy - 130);
    this.resumeBtn.view.position.set(cx - 100, cy - 60);
    this.settingsBtn.view.position.set(cx - 100, cy - 5);
    this.saveQuitBtn.view.visible = savable;
    this.saveQuitBtn.view.position.set(cx - 100, cy + 50);
    this.quitBtn.view.position.set(cx - 100, savable ? cy + 105 : cy + 50);
    this.view.visible = true;
  }

  hide() {
    this.view.visible = false;
  }
}
