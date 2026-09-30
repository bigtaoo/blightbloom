import { Container, Text } from 'pixi.js';
import { REVIVE_CHANNEL_TICKS } from '@dd/engine';
import { Panel, Bar } from './widgets';
import { t } from '../../i18n';

/**
 * The reviver's own channel readout (design/07, ENGINE_VERSION 86): `DownedBanner` is the body
 * on the floor, this is the seat kneeling over it. Before it, a reviver in a PvP squad saw
 * nothing: `AllyRow` only exists in co-op, and there it names one ally, not the one being
 * revived. The bar is the downed body's `reviveProgressTicks`; the hint says what the channel
 * costs, since a reviver cannot attack and loses the channel if it leaves the reach.
 * Lower-centre, clear of `DownedBanner`'s upper-centre slot.
 */
export class ReviveBanner {
  readonly view = new Container();
  private readonly panel = new Panel({ radius: 10, color: 0x0b1a12, alpha: 0.85, borderColor: 0x68d391, borderAlpha: 0.6 });
  private readonly title: Text;
  private readonly hint: Text;
  private readonly progress = new Bar({ w: 240, h: 10, fillColor: 0x68d391, trackColor: 0x16261c });

  private static readonly W = 260;
  private static readonly H = 78;

  constructor() {
    this.title = new Text({
      text: '',
      style: { fill: 0x9ae6b4, fontSize: 17, fontFamily: 'monospace', fontWeight: 'bold', align: 'center', padding: 6 },
    });
    this.title.anchor.set(0.5, 0);
    this.hint = new Text({
      text: '',
      style: { fill: 0xe2e8f0, fontSize: 12, fontFamily: 'monospace', align: 'center', padding: 6 },
    });
    this.hint.anchor.set(0.5, 0);
    this.panel.layout(ReviveBanner.W, ReviveBanner.H);
    this.view.addChild(this.panel.view, this.title, this.hint, this.progress.view);
    this.view.visible = false;
  }

  reposition(screenPx: { w: number; h: number }): void {
    const x = screenPx.w / 2 - ReviveBanner.W / 2;
    const y = screenPx.h * 0.62;
    this.panel.view.position.set(x, y);
    this.title.position.set(screenPx.w / 2, y + 10);
    this.hint.position.set(screenPx.w / 2, y + 34);
    this.progress.view.position.set(screenPx.w / 2 - 120, y + 56);
  }

  /** `progressTicks` is the body being revived's `reviveProgressTicks`, or `null` when the local
   *  seat is not holding a revive (`reviveTarget` found nobody). */
  set(progressTicks: number | null): void {
    this.view.visible = progressTicks !== null;
    if (progressTicks === null) return;
    this.title.text = t('hud.revive.title', { pct: Math.round((progressTicks / REVIVE_CHANNEL_TICKS) * 100) });
    this.hint.text = t('hud.revive.hint');
    this.progress.set(progressTicks, REVIVE_CHANNEL_TICKS);
  }

  /** Advance the progress bar's flash. Call once per render frame (dt in ms). */
  update(dt: number): void {
    if (this.view.visible) this.progress.update(dt);
  }

  /** Test seams — see StatChip's own. */
  get titleText(): string {
    return this.title.text;
  }
  get hintText(): string {
    return this.hint.text;
  }
}
