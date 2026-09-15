import { Container, Text } from 'pixi.js';
import type { Chest } from '@dd/engine';
import { THEME } from '../theme';
import { Panel } from './widgets';
import { t, getLocale } from '../../i18n';

const W = 280;
const H = 58;

/**
 * The chest prompt (design/05 "Chest rooms", 2026-09-15) — the one thing a chest was missing.
 *
 * A chest has shipped since ENGINE_VERSION 63 with no art, no sound, and no cue of any kind,
 * and INTERACT is taught nowhere: the tutorial's hints cover move, attack, swap and deflect
 * and stop there. The result was a chest that reads as broken rather than as locked — the
 * report this was written for was *"宝箱无法打开"* about a chest that, verified in the running
 * client the same day, opens on the first frame a `KeyE` arrives.
 *
 * Deliberately NOT built like `ShopPrompt`/`WeaponPickupPrompt`, the other two in-reach
 * panels, and the difference is the whole design:
 *
 *   - **It is not a list and it is not tappable.** Those two panels exist because the action
 *     IS the tap (`shopBuyId` / `pickupTargetId` are real command fields). A chest has no
 *     command of its own — `ChestSystem` reads the INTERACT hold, the same button a revive
 *     uses — so a tappable row here would be a button promising something the sim never
 *     receives. `eventMode = 'none'` on the root makes that literal: every press falls
 *     through to the weapon underneath, so standing at a chest never eats a shot.
 *   - **It sits bottom-centre**, not in the HUD's right-hand prompt column. The column is for
 *     panels you reach for; this is a caption about the thing under your feet, and the bottom
 *     centre is where the eye already is in a twin-stick game. It also keeps it clear of the
 *     weapon panel, which opens on the same spot the instant the chest pays out.
 *
 * ## What each kind has to say
 *
 * A SMALL chest is a button prompt, and which button depends on what the player is holding:
 * `E` on a keyboard, the touch INTERACT pad on a phone (`TouchControlsView`'s green `+`).
 *
 * A BIG chest has no button at all — it opens when every mechanism plate is occupied at once —
 * so the useful sentence is a live count, not a control. `{on}/{total}` reads straight off
 * `Chest.mechanisms`, which `ChestSystem.markMechanisms` refreshes every tick for exactly this
 * kind of consumer, and it answers the question a ring of plates raises without teaching
 * anybody a button that does nothing here.
 */
export class ChestPrompt {
  readonly view = new Container();
  private readonly panel = new Panel({ radius: 10, color: 0x0b0e14, alpha: 0.9, borderColor: 0x4c566a, borderAlpha: 0.55 });
  private readonly titleText: Text;
  private readonly detailText: Text;
  // Same redraw-on-key-change convention as every other prompt in this folder: the key
  // carries the locale (these strings are translated, so a language switch has to invalidate
  // a cache nothing else moved) and the plate count (which changes with the chest standing
  // still, and is the one number here that is live).
  private lastKey = ' '; // sentinel, guaranteed to differ from the first real key

  get isOpen(): boolean {
    return this.view.visible;
  }

  constructor() {
    this.titleText = new Text({
      text: '',
      style: { fill: THEME.colors.pickupWeapon, fontSize: 14, fontFamily: 'monospace', fontWeight: 'bold', align: 'center', padding: 6 },
    });
    this.titleText.anchor.set(0.5, 0);
    this.detailText = new Text({
      text: '',
      style: { fill: 0xe2e8f0, fontSize: 13, fontFamily: 'monospace', align: 'center', padding: 6 },
    });
    this.detailText.anchor.set(0.5, 0);
    this.panel.layout(W, H);
    this.view.addChild(this.panel.view, this.titleText, this.detailText);
    this.view.visible = false;
    // Informational, never a target — see the class note. A press here belongs to the weapon.
    this.view.eventMode = 'none';
  }

  /** Re-anchor on viewport resize (same convention as `DownedBanner`/`PortalPrompt`). Above
   *  the touch controls' own thumb zone, which is why it is not flush to the bottom edge. */
  reposition(screenPx: { w: number; h: number }): void {
    const x = screenPx.w / 2 - W / 2;
    const y = screenPx.h - H - 96;
    this.panel.view.position.set(x, y);
    this.titleText.position.set(screenPx.w / 2, y + 9);
    this.detailText.position.set(screenPx.w / 2, y + 31);
  }

  /**
   * @param chest the chest in reach, or undefined when the seat is not near an unopened one.
   * @param touch whether this session is being played with touch controls — picks which
   *        control the small-chest line names. Same source and same reason as
   *        `TutorialHintController`'s own `touch` flag: printing both sentences would make
   *        every player read one that is false for them.
   */
  update(chest: Chest | undefined, touch: boolean): void {
    const on = chest ? chest.mechanisms.filter((m) => m.occupied).length : 0;
    const key = `${getLocale()}|${chest?.kind ?? ''}|${on}/${chest?.mechanisms.length ?? 0}|${touch ? 1 : 0}`;
    if (key !== this.lastKey) {
      this.lastKey = key;
      this.redraw(chest, touch, on);
    }
    this.view.visible = chest !== undefined;
  }

  private redraw(chest: Chest | undefined, touch: boolean, on: number): void {
    if (!chest) return;
    if (chest.kind === 'big') {
      this.titleText.text = t('hud.chest.bigTitle');
      this.detailText.text = t('hud.chest.plates', { on, total: chest.mechanisms.length });
      return;
    }
    this.titleText.text = t('hud.chest.title');
    this.detailText.text = t(touch ? 'hud.chest.openTouch' : 'hud.chest.openKeys');
  }
}
