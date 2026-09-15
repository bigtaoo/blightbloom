import { Container, Text } from 'pixi.js';
import type { Chest } from '@dd/engine';
import { THEME } from '../theme';
import { Panel } from './widgets';
import { t, getLocale } from '../../i18n';

const W = 280;
const H = 58;

/**
 * The big chest's caption (design/05 "Chest rooms", 2026-09-15; narrowed to the big chest the
 * same day, `ENGINE_VERSION` 66).
 *
 * A big chest opens only while **every** mechanism plate is occupied at once. Nothing in the
 * world says that: the plates are drawn (`scene/ChestLayer`) but a player standing on one in an
 * empty room has no way to learn that the ring is a gate, let alone how much of it is covered.
 * So this shows a live `{on}/{total}` read straight off `Chest.mechanisms`, which
 * `ChestSystem.markMechanisms` refreshes every tick for exactly this kind of consumer.
 *
 * **It was originally written for the SMALL chest** — *"Press E to open"*, against a report that
 * a chest could not be opened at all. That mechanic is gone: a small chest opens on approach,
 * so its caption could only flash for the single frame before it opened. What is left is the
 * kind with something to say.
 *
 * Deliberately NOT built like `ShopPrompt`/`WeaponPickupPrompt`, the other two in-reach panels:
 * those exist because the action IS the tap (`shopBuyId` / `pickupTargetId` are real command
 * fields). A chest has no command of its own at all — no chest kind reads a button now — so a
 * tappable row here would promise something the sim never receives. `eventMode = 'none'` makes
 * that literal: every press falls through to the weapon underneath, so standing at a chest
 * never eats a shot. It sits bottom-centre rather than in the HUD's right-hand prompt column
 * for the same reason: the column is for panels you reach for, this is a caption about the
 * thing under your feet — and it keeps clear of the weapon panel, which opens on the same spot
 * the instant the chest pays out.
 */
export class ChestPrompt {
  readonly view = new Container();
  private readonly panel = new Panel({ radius: 10, color: 0x0b0e14, alpha: 0.9, borderColor: 0x4c566a, borderAlpha: 0.55 });
  private readonly titleText: Text;
  private readonly detailText: Text;
  // Same redraw-on-key-change convention as every other prompt in this folder. The key carries
  // the locale (these strings are translated, so a language switch has to invalidate a cache
  // nothing else moved) and the plate count, which is the one number here that is live.
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

  /** @param chest the big chest in reach of its plates, or undefined when there is none. */
  update(chest: Chest | undefined): void {
    const on = chest ? chest.mechanisms.filter((m) => m.occupied).length : 0;
    const key = `${getLocale()}|${chest?.id ?? 0}|${on}/${chest?.mechanisms.length ?? 0}`;
    if (key !== this.lastKey) {
      this.lastKey = key;
      if (chest) {
        this.titleText.text = t('hud.chest.bigTitle');
        this.detailText.text = t('hud.chest.plates', { on, total: chest.mechanisms.length });
      }
    }
    this.view.visible = chest !== undefined;
  }
}
