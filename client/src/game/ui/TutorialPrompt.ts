import { Container, Text } from 'pixi.js';
import { Panel } from './widgets';
import { t } from '../../i18n';

/** Glyph advance of the 22 px monospace body: ~0.6 em for Latin/Cyrillic, a full em for CJK. */
const LATIN_ADVANCE = 13.2;
const WIDE_ADVANCE = 22;

/**
 * How many lines `text` wraps to at `width` px — an ESTIMATE from the monospace advance, not a
 * measurement: measuring a Pixi `Text` needs a canvas, which the widget tests (and the pure
 * layer) do not have, and one line too many only costs the panel a little padding.
 */
export function estimateLines(text: string, width: number): number {
  let lines = 1;
  let x = 0;
  for (const word of text.split(/(?<=\s)/)) {
    let w = 0;
    for (const ch of word) w += ch.codePointAt(0)! >= 0x2e80 ? WIDE_ADVANCE : LATIN_ADVANCE;
    if (x > 0 && x + w > width) {
      lines++;
      x = 0;
    }
    // A word wider than the line (CJK has no spaces) breaks across as many lines as it fills.
    while (w > width) {
      lines++;
      w -= width;
    }
    x += w;
  }
  return lines;
}

/**
 * The first-run lesson panel (design/20 onboarding, 2026-11-06): one large instruction at the
 * top-centre of the screen that STAYS until the player does what it says. It replaces the
 * 15 px toast the lessons used to ride on, which a first-time sandbox player never read: it
 * sat in the toast lane, faded after 1.4 s and moved on to the next lesson on a timer whether
 * or not the first one had been learned.
 *
 * `TutorialHintController` decides what it says and when; this only draws. Upper-centre at
 * 12% of the height, between the player card (top-left) and the minimap (top-right); while it
 * shows, `HudView` pushes the toast lane below its `bottom`. Never interactive: a panel over
 * the play field must not eat the click that is the lesson.
 */
export class TutorialPrompt {
  readonly view = new Container();
  private readonly panel = new Panel({ radius: 12, color: 0x101626, alpha: 0.88, borderColor: 0xf6c344, borderAlpha: 0.8 });
  private readonly counter: Text;
  private readonly body: Text;
  private screen = { w: 1280, h: 720 };
  /** Milliseconds left on a `finish` message, then the panel hides itself. 0 = not finishing. */
  private finishMs = 0;
  private pulseMs = 0;
  private bottomY = 0;

  static readonly FINISH_MS = 2600;
  private static readonly MAX_W = 620;
  private static readonly PAD = 14;
  private static readonly LINE_H = 28;

  constructor() {
    this.counter = new Text({
      text: '',
      style: { fill: 0xf6c344, fontSize: 13, fontFamily: 'monospace', fontWeight: 'bold', align: 'center', padding: 4 },
    });
    this.counter.anchor.set(0.5, 0);
    this.body = new Text({
      text: '',
      style: {
        fill: 0xffffff,
        fontSize: 22,
        fontFamily: 'monospace',
        fontWeight: 'bold',
        align: 'center',
        padding: 6,
        wordWrap: true,
        wordWrapWidth: TutorialPrompt.MAX_W - 2 * TutorialPrompt.PAD,
        lineHeight: TutorialPrompt.LINE_H,
      },
    });
    this.body.anchor.set(0.5, 0);
    this.view.addChild(this.panel.view, this.counter, this.body);
    this.view.eventMode = 'none';
    this.view.visible = false;
  }

  /** Show lesson `step` of `of` (1-based) until the next call. */
  show(text: string, step: number, of: number): void {
    this.finishMs = 0;
    this.counter.text = t('tutorial.step', { n: step, of });
    this.body.text = text;
    this.body.style.fill = 0xffffff;
    this.view.visible = true;
    this.view.alpha = 1;
    this.layout();
  }

  /** The lessons are over: show `text` (the earned congratulation) for `FINISH_MS`, then
   *  hide — or hide at once when there is nothing to say. */
  finish(text: string | null): void {
    if (text === null) {
      this.hide();
      return;
    }
    this.counter.text = '';
    this.body.text = text;
    this.body.style.fill = 0x9ae6b4;
    this.view.visible = true;
    this.view.alpha = 1;
    this.finishMs = TutorialPrompt.FINISH_MS;
    this.layout();
  }

  hide(): void {
    this.finishMs = 0;
    this.view.visible = false;
  }

  reposition(screenPx: { w: number; h: number }): void {
    this.screen = screenPx;
    this.layout();
  }

  /** A slow border pulse while a lesson waits, and the finish message's count-down and fade.
   *  Call once per render frame (dt in ms). */
  update(dt: number): void {
    if (!this.view.visible) return;
    if (this.finishMs > 0) {
      this.finishMs = Math.max(0, this.finishMs - dt);
      // Fade over the last 600 ms.
      this.view.alpha = Math.min(1, this.finishMs / 600);
      if (this.finishMs === 0) this.hide();
      return;
    }
    this.pulseMs = (this.pulseMs + dt) % 1600;
    this.panel.view.alpha = 0.85 + 0.15 * Math.cos((this.pulseMs / 1600) * 2 * Math.PI);
  }

  private layout(): void {
    const { w, h } = this.screen;
    const pad = TutorialPrompt.PAD;
    const panelW = Math.min(TutorialPrompt.MAX_W, w - 32);
    this.body.style.wordWrapWidth = panelW - 2 * pad;
    const counterH = this.counter.text ? 20 : 0;
    const panelH = pad + counterH + estimateLines(this.body.text, panelW - 2 * pad) * TutorialPrompt.LINE_H + pad;
    const x = w / 2 - panelW / 2;
    const y = Math.round(h * 0.12);
    this.bottomY = y + panelH;
    this.panel.layout(panelW, panelH);
    this.panel.view.position.set(x, y);
    this.counter.position.set(w / 2, y + pad - 4);
    this.body.position.set(w / 2, y + pad + counterH);
  }

  /** The panel's lower edge in screen px, for the widgets laid out under it. */
  get bottom(): number {
    return this.bottomY;
  }

  /** Test seams — see StatChip's own. */
  get bodyText(): string {
    return this.body.text;
  }
  get counterText(): string {
    return this.counter.text;
  }
}
