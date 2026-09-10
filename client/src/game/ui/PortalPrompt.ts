import { Container, Text } from 'pixi.js';
import type { GameState } from '@dd/engine';
import { Panel, Button } from './widgets';
import { t } from '../../i18n';

/**
 * Everything the EXTRACT press would hand to the account — shown on the popup so "bank &
 * leave" isn't an abstract phrase without a number attached to it.
 *
 * BOTH tiers, since ENGINE_VERSION 61: this floor's un-banked buffer AND the carry-out bag
 * the earlier floors' descends folded into. It used to be the buffer alone, which was the
 * honest number while any floor's checkpoint could extract — the bag was already "banked"
 * relative to that decision. It is the wrong number now: the boss floor is the only exit,
 * so a player standing here is deciding about the WHOLE run's materials, and design/05's
 * locked wipe rule says the bag is at risk right up to this press (`RunOutcome.lose()`
 * never hands it over). Naming the smaller half would understate what the button pays.
 */
function totalCarryOut(s: GameState): number {
  let n = 0;
  for (const v of Object.values(s.floorMaterials)) n += v ?? 0;
  for (const v of Object.values(s.bankedMaterials)) n += v ?? 0;
  return n;
}

/**
 * The portal popup (design/10 legibility fix, 2026-08-02) — replaces the old "HOLD [E] to
 * EXTRACT / TAP [E] to DESCEND" text banner with a real button, shown only once the player
 * has walked up to the portal (Portal.ts, RoomBuilder). Mirrors PauseMenu.ts's shape: pure
 * presentation, Game owns what the button actually does (wires onExtract/onDescend to
 * CommandBuilder's one-shot confirm latches).
 *
 * **One button, not two, since ENGINE_VERSION 61** (design/05 "Only the boss floor ends a
 * run"). It was a two-button choice — Bank & Extract, or Descend — on every floor but the
 * last, which showed Extract alone. Now the pairing is exclusive in BOTH directions: an
 * interior floor offers Descend alone, the boss floor offers Extract alone, and the engine
 * ignores the button the popup is not showing (`ExtractionSystem`), so a stale click can
 * never resolve something the panel never offered.
 *
 * Both buttons are still constructed and still carry a label, even though only one is
 * visible at a time. That is deliberate: `labelFit.test.ts` reflects over the fields to
 * measure every label in all eight locales, and a button whose text is only set when shown
 * would be measured as empty and skipped.
 */
export class PortalPrompt {
  readonly view = new Container();
  private readonly panel = new Panel({ radius: 10, color: 0x0b1a10, alpha: 0.9, borderColor: 0x68d391, borderAlpha: 0.6 });
  private readonly titleText: Text;
  private readonly extractBtn: Button;
  private readonly descendBtn: Button;
  private _isOpen = false;

  onExtract: (() => void) | null = null;
  onDescend: (() => void) | null = null;

  get isOpen(): boolean {
    return this._isOpen;
  }

  constructor() {
    this.titleText = new Text({
      text: '',
      style: { fill: 0x9ae6b4, fontSize: 15, fontFamily: 'monospace', fontWeight: 'bold', align: 'center', padding: 6 },
    });
    this.titleText.anchor.set(0.5, 0);

    this.extractBtn = new Button('', { w: 260, h: 40 });
    this.extractBtn.onTap = () => this.onExtract?.();
    this.descendBtn = new Button('', { w: 260, h: 40 });
    this.descendBtn.onTap = () => this.onDescend?.();

    this.view.addChild(this.panel.view, this.titleText, this.extractBtn.view, this.descendBtn.view);
    this.view.visible = false;
  }

  /** Re-anchor on viewport resize (Game's relayoutViewport, same convention as HudView). */
  reposition(screenPx: { w: number; h: number }): void {
    const w = Math.min(320, screenPx.w - 24);
    // Title + one button. Was 150 for the two-button era; the panel shrank with the
    // choice rather than keeping a dead slot (ENGINE_VERSION 61). `FloorCardPrompt`
    // stacks itself off `screenPx.h * 0.6` — this panel's TOP — not off its height, so
    // this does not move the card panel.
    const h = 112;
    this.panel.layout(w, h);
    const x = screenPx.w / 2 - w / 2;
    const y = screenPx.h * 0.6;
    this.panel.view.position.set(x, y);
    this.titleText.style.wordWrap = true;
    this.titleText.style.wordWrapWidth = w - 24;
    // Pixi's wordWrap only breaks at whitespace by default — CJK text has none, so an
    // unbroken Chinese/Japanese/Korean run longer than wordWrapWidth would otherwise
    // overflow the panel as one line instead of wrapping (confirmed live under the zh
    // locale, design/17-i18n.md's flagged-but-unverified risk). `breakWords` forces a
    // character-level break when a run has no earlier break point, fixing CJK without
    // changing anything about how space-delimited English wraps.
    this.titleText.style.breakWords = true;
    this.titleText.position.set(screenPx.w / 2, y + 12);
    // One slot, and both buttons sit in it — only one is ever visible (see the class
    // header), so they cannot collide and neither needs a layout of its own.
    const btnX = x + w / 2 - 130;
    const btnY = y + 58;
    this.extractBtn.view.position.set(btnX, btnY);
    this.descendBtn.view.position.set(btnX, btnY);
  }

  /** `show` is the caller's already-computed "at an eligible checkpoint AND standing
   *  near the portal" condition — kept out of this class so Game doesn't have to
   *  duplicate it between here and RoomBuilder.setPortalOpen (which needs the same
   *  checkpoint half without the proximity half).
   *
   *  `isLastFloor` picks WHICH single button this is (see the class header): Extract on
   *  the boss floor, Descend on every other. The boss floor showing a button at all is
   *  itself a fix (2026-08-12 live report: it used to skip this popup entirely and
   *  auto-resolve EXTRACT the instant the boss died, leaving no time to walk over to its
   *  death drops). The interior floors LOSING their Extract button is ENGINE_VERSION 61 —
   *  the title still names the extraction that is coming, one floor at a time, and the
   *  run's own exit is now the boss. */
  update(s: GameState, show: boolean, isLastFloor = false): void {
    this._isOpen = show;
    this.view.visible = show;
    if (!show) return;
    const nextFloor = s.floorIndex + 2; // 1-based display, one floor further than current
    this.titleText.text = t(isLastFloor ? 'hud.portalTitleBoss' : 'hud.portalTitle');
    this.extractBtn.setText(t('hud.portalExtract', { pending: totalCarryOut(s) }));
    this.descendBtn.setText(t('hud.portalDescend', { floor: nextFloor }));
    this.extractBtn.view.visible = isLastFloor;
    this.descendBtn.view.visible = !isLastFloor;
  }
}
