// Render-side input → PlayerCommand. Reads the platform InputSource each sim tick
// and assembles the engine's frozen twin-stick command. The float→brad/mag
// quantization is the engine's input-edge seam (quantizeMove, design/06/08) — this
// file only handles the render-specific bits: latching the discrete weapon-swap /
// portal-choice presses into one-tick button pulses so the engine's rising-edge
// detection sees a clean press.
//
// Because the quantization lives in @dd/engine, the golden-replay tests build
// commands through the exact same grid this producer uses.
import { Button, makeCommand, quantizeMove, type PlayerCommand } from '@dd/engine';
import type { InputSource } from '../../platform/types';
import { bradToRad } from '../coords';

export class CommandBuilder {
  private swapLatch = false;
  private confirmExtractLatch = false;
  private confirmDescendLatch = false;
  private cardVoteLatch = 0;
  // Ground-weapon click target (design/03, ENGINE_VERSION 32) — 0 = no click this
  // tick. Same one-shot-latch shape as the confirm latches above, set from
  // WeaponPickupPrompt's onPick via Game.ts.
  private pickupLatchId = 0;
  // Shop counter tap (design/05 "Shops", 2026-09-14) — 0 = no tap this tick. Its own latch
  // and its own command field rather than sharing `pickupLatchId`: offer ids and pickup ids
  // come from different id spaces, so one channel for both would make a buy also collect.
  private shopLatchId = 0;
  // Set while the portal popup is open (PortalPrompt.isOpen) so a click on one of its
  // buttons doesn't also register as a shot — WebInput's `leftDown` is set from a raw
  // `canvas.addEventListener('mousedown', ...)`, independent of Pixi's own event
  // system, so it fires regardless of what a Pixi button's hit-test consumes.
  private fireSuppressed = false;
  // The same problem for a panel that is NOT modal — one press, not one panel, is what
  // gets swallowed. See suppressFireUntilRelease().
  private pressHoldsFire = false;

  /**
   * The movement half of the command this builder last produced, in radians + the engine's own
   * 0..255 deflection. Kept because a render-only reader needs the input the SIM was given for the
   * tick being drawn, not a fresh `input.read()` — `scene/doorTick.isRefused` asks "is the player
   * pushing into this locked door", and re-reading the device would answer for a different instant
   * and would also poll a gamepad twice a frame. Written on every `build()`, so it is exactly as
   * old as the newest submitted command; `{0, 0}` before the first one.
   */
  readonly lastMove = { rad: 0, mag: 0 };

  constructor(private readonly input: InputSource) {}

  /** Discrete-action latch, set from Game's onSwitchWeapon routing. */
  requestSwap(): void {
    this.swapLatch = true;
  }

  /** One-shot portal-popup choices (design/10, ROADMAP 1.4 follow-up), set from
   * PortalPrompt's onExtract/onDescend callbacks — same one-shot-latch shape as
   * requestSwap(). */
  requestConfirmExtract(): void {
    this.confirmExtractLatch = true;
  }

  requestConfirmDescend(): void {
    this.confirmDescendLatch = true;
  }

  /** One-shot ground-weapon collect, set from WeaponPickupPrompt's onPick (a row
   *  click) — same one-shot-latch shape as requestSwap()/requestConfirmExtract(). */
  requestPickup(itemId: number): void {
    this.pickupLatchId = itemId;
  }

  /** One-shot shop purchase, set from ShopPrompt's onBuy (a row tap) — same one-shot-latch
   *  shape as requestPickup() above, and refused or honoured entirely by `ShopSystem`. The
   *  client deliberately does no affordability check of its own before sending: the sim owns
   *  the wallet, and a client that pre-refused would be a second rule to keep in step. */
  requestShopBuy(offerId: number): void {
    this.shopLatchId = offerId;
  }

  /** Vote for a floor-card slot (1..3), set from FloorCardPrompt's card taps
   *  (design/05, ENGINE_VERSION 58). A one-shot latch like the others, but what it
   *  carries is not: the ENGINE keeps the vote once it has seen it, so a tap only has
   *  to reach the sim once and a player who then does nothing still counts as having
   *  chosen. Re-tapping another card sends a new value and overwrites the old one. */
  requestCardVote(slot: number): void {
    this.cardVoteLatch = slot;
  }

  suppressFire(active: boolean): void {
    this.fireSuppressed = active;
  }

  /**
   * Swallow the press that is landing RIGHT NOW, and only that press — called from a
   * panel's own capture-phase pointerdown (WeaponPickupPrompt.onPressStart) before
   * WebInput's raw `mousedown` listener has even set `firing`, so the click that picks a
   * weapon up never also fires a shot.
   *
   * The difference from `suppressFire(true)` is the whole point of it (live report,
   * *"附近有可以拾取的武器时，不要阻断了玩家攻击"*): the weapon-pickup panel pops open
   * from `SIM.lootRevealRadius` away and stays open for as long as any floor weapon is in
   * range — which, since every kill drops one, is most of a fight. Gating fire on that
   * panel's `isOpen` disarmed the player next to loot. Gating it on the press means the
   * panel costs exactly the clicks that hit it and nothing else. It clears itself the
   * first tick the input reports not-firing (i.e. on release), so there is no matching
   * "off" call to forget and no pointerup listener to keep in sync.
   */
  suppressFireUntilRelease(): void {
    this.pressHoldsFire = true;
  }

  /**
   * Build this tick's command. There is no manual aim input at all (design/10 v33): the
   * engine auto-faces the nearest hostile, else the movement direction, else holds last
   * facing (ApplyInputSystem) — exactly like an enemy's own facing is computed for it
   * (AIDecideSystem, design/07). This builder only ever reports movement + buttons, so
   * (unlike before) it needs no world-position/camera context to map a screen aim point.
   */
  build(tick: number, owner: number): PlayerCommand {
    const inp = this.input.read();

    // Move: raw vector → direction brad + 0..255 magnitude (engine input edge).
    const { moveBrad, moveMag } = quantizeMove(inp.moveX, inp.moveY);

    // A press that started on a UI panel stays swallowed until it is released; releasing
    // is the only thing that clears the latch (suppressFireUntilRelease).
    if (!inp.firing) this.pressHoldsFire = false;

    let buttons = 0;
    if (inp.firing && !this.fireSuppressed && !this.pressHoldsFire) buttons |= Button.FIRE;
    if (inp.interacting) buttons |= Button.INTERACT; // revive channel / weapon-swap-on-pickup
    if (this.swapLatch) {
      buttons |= Button.SWAP_WEAPON;
      this.swapLatch = false;
    }
    if (this.confirmExtractLatch) {
      buttons |= Button.CONFIRM_EXTRACT;
      this.confirmExtractLatch = false;
    }
    if (this.confirmDescendLatch) {
      buttons |= Button.CONFIRM_DESCEND;
      this.confirmDescendLatch = false;
    }
    const pickupTargetId = this.pickupLatchId;
    this.pickupLatchId = 0;
    const cardVote = this.cardVoteLatch;
    this.cardVoteLatch = 0;
    const shopBuyId = this.shopLatchId;
    this.shopLatchId = 0;

    this.lastMove.rad = bradToRad(moveBrad);
    this.lastMove.mag = moveMag;
    return makeCommand({ owner, tick, moveBrad, moveMag, buttons, pickupTargetId, cardVote, shopBuyId });
  }
}
