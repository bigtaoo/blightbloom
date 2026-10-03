import { Container, Text } from 'pixi.js';
import { TICK_RATE, type GameState } from '@dd/engine';
import { Panel, Button } from './widgets';
import { t } from '../../i18n';

/** The button box, and the width its label is wrapped to (the box less 10px either side).
 *  Exported for `hudLabelFit.test.ts`'s locale sweep, which measures against the BOX. */
export const BTN_W = 260;
export const BTN_FONT = 15;
const BTN_TEXT_W = BTN_W - 20;

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
 *
 * Per-seat since ENGINE_VERSION 68 (design/14) — this shows THIS local seat's own bags,
 * which now genuinely differ from a teammate's.
 */
function totalCarryOut(s: GameState, localOwner: number): number {
  let n = 0;
  const p = s.players[localOwner];
  if (!p) return 0;
  for (const v of Object.values(p.floorMaterials)) n += v ?? 0;
  for (const v of Object.values(p.bankedMaterials)) n += v ?? 0;
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
 *
 * **The co-op countdown (ENGINE_VERSION 87).** Once any seat opens the portal, the engine
 * runs `portalCountdownTicks` and every seat sees this panel wherever it stands (the caller
 * drops the proximity half of `show`). The title becomes the countdown and how many living
 * seats have confirmed; the button is the same one, now a confirm, and it is hidden once
 * this seat has pressed it, or while it cannot (downed or dead).
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
  /** A press landed anywhere on this panel — routed to `CommandBuilder.suppressFireUntilRelease`.
   *  Fire is only gated on the panel near the portal (`checkpointOverlays`); during a countdown it
   *  also shows mid-fight, where gating it would disarm the seat for up to 30 s. */
  onPressStart: (() => void) | null = null;

  get isOpen(): boolean {
    return this._isOpen;
  }

  constructor() {
    this.titleText = new Text({
      text: '',
      style: { fill: 0x9ae6b4, fontSize: 15, fontFamily: 'monospace', fontWeight: 'bold', align: 'center', padding: 6 },
    });
    this.titleText.anchor.set(0.5, 0);

    // `wrapWidth`: "Bank & Extract (12 materials)" is 261px at this font — it did not fit
    // its own 260px box in ENGLISH, let alone in Russian at 378px, and ran out of the
    // button and past the panel's edge in seven of the eight locales (2026-09-21). The box
    // cannot grow (the panel is capped at 320px on a phone), so the label folds instead.
    this.extractBtn = new Button('', { w: BTN_W, h: 40, wrapWidth: BTN_TEXT_W });
    this.extractBtn.onTap = () => this.onExtract?.();
    this.descendBtn = new Button('', { w: BTN_W, h: 40, wrapWidth: BTN_TEXT_W });
    this.descendBtn.onTap = () => this.onDescend?.();

    this.view.addChild(this.panel.view, this.titleText, this.extractBtn.view, this.descendBtn.view);
    this.view.visible = false;
    // Same capture-phase swallow as `FloorCardPrompt`: `WebInput` reads `firing` from a raw
    // `mousedown` that a Pixi button consuming the event knows nothing about.
    this.view.eventMode = 'static';
    this.view.on('pointerdowncapture', () => this.onPressStart?.());
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
    const btnX = x + w / 2 - BTN_W / 2;
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
  update(s: GameState, show: boolean, localOwner: number, isLastFloor = false): void {
    this._isOpen = show;
    this.view.visible = show;
    if (!show) return;
    const nextFloor = s.floorIndex + 2; // 1-based display, one floor further than current
    this.titleText.text = s.portalCountdownTicks > 0 ? countdownTitle(s) : t(isLastFloor ? 'hud.portalTitleBoss' : 'hud.portalTitle');
    this.extractBtn.setText(t('hud.portalExtract', { pending: totalCarryOut(s, localOwner) }));
    this.descendBtn.setText(t('hud.portalDescend', { floor: nextFloor }));
    const me = s.players[localOwner];
    const canPress = !!me && me.alive && !me.downed && !me.portalReady;
    this.extractBtn.view.visible = isLastFloor && canPress;
    this.descendBtn.view.visible = !isLastFloor && canPress;
  }
}

/** "Squad leaves in 23s — 1/2 ready": whole seconds rounded up, so it never reads 0 while
 *  the portal is still waiting. Counts living seats only, the ones the engine waits for. */
function countdownTitle(s: GameState): string {
  const living = s.players.filter((p) => p.alive);
  return t('hud.portalCountdown', {
    seconds: Math.ceil(s.portalCountdownTicks / TICK_RATE),
    ready: living.filter((p) => p.portalReady).length,
    total: living.length,
  });
}
