import { Container, Text } from 'pixi.js';
import type { GameState } from '@dd/engine';
import { FLOOR_CARDS, floorCardDescVars } from '@dd/engine';
import { Panel, Button } from './widgets';
import { getUiTexture } from '../../render/uiSkins';
import { t, tName, getLocale } from '../../i18n';

/**
 * The floor-card offer (design/05/10, ENGINE_VERSION 58) — three upgrade cards shown
 * above the portal popup once a floor is cleared, one of which the squad picks before
 * descending.
 *
 * Non-blocking, like every other in-match overlay here: the sim keeps running behind it
 * (design/06 — lockstep cannot pause for one player), so this is a panel the player
 * chooses from while standing at the portal, never a modal that stops the game. It sits
 * above `PortalPrompt` and shares its lifecycle: `Game` shows both on the same
 * "cleared, and standing at the portal" condition.
 *
 * Pure presentation. Tapping a card calls `onVote(slot)`, which `Game` routes to
 * `CommandBuilder.requestCardVote` — the engine owns what a vote does, this owns what it
 * looks like, same split as `PortalPrompt`/`PauseMenu`.
 *
 * ## The tally is drawn, not just the cards
 *
 * In co-op the winning card is the most-voted one, so a player has to be able to see
 * where the squad's votes currently sit — otherwise "the majority decides" is a rule
 * whose outcome only becomes visible after it has already happened. Each card shows a
 * vote count once anyone has voted, and the local seat's own pick is drawn selected.
 * With one player there is no ambiguity to resolve, so the counts stay hidden.
 */

/** Card box geometry. Exported because the locale sweep in `hudLabelFit.test.ts` measures
 *  against the BOX, not against the wrap width derived from it — a test that read the same
 *  derived number the code wraps with could not tell a wrong derivation from a right one. */
export const CARD_W = 150;
// 108, not the 96 it was before the icons landed (2026-09-21): 8px of padding, a 43px icon
// box (`Button.topIconBox`), 6px of gap and three 15px lines, which is the worst wrapped
// height any of the 56 card strings produces at this width.
export const CARD_H = 108;
/** The card label's font size, and the width its text is wrapped to: the box less 8px of
 *  breathing room either side. */
export const CARD_FONT = 12;
const CARD_TEXT_W = CARD_W - 16;
const GAP = 10;
const PANEL_PAD = 12;
const TITLE_H = 26;
/** The whole panel's fixed size, in its own local space. `reposition` scales this DOWN to
 *  fit a narrow viewport rather than re-flowing it (the same policy `menuLayer` applies to
 *  the full-screen menus — the HUD is outside that layer and has to do its own). */
export const PANEL_W = 3 * CARD_W + 2 * GAP + 2 * PANEL_PAD;
export const PANEL_H = CARD_H + TITLE_H + 2 * PANEL_PAD + 14;

export class FloorCardPrompt {
  readonly view = new Container();
  private readonly panel = new Panel({ radius: 10, color: 0x141024, alpha: 0.92, borderColor: 0xb794f4, borderAlpha: 0.7 });
  private readonly titleText: Text;
  private readonly cards: Button[] = [];
  private readonly tallies: Text[] = [];
  private _isOpen = false;
  private lastKey = '';

  /** Tapped a card: 1-based slot into `state.floorCardOffer`. */
  onVote: ((slot: number) => void) | null = null;
  /** A press landed anywhere on this panel — routed to
   *  `CommandBuilder.suppressFireUntilRelease` so choosing a card never also fires a
   *  shot. See the capture-phase note in the constructor. */
  onPressStart: (() => void) | null = null;

  get isOpen(): boolean {
    return this._isOpen;
  }

  constructor() {
    this.titleText = new Text({
      text: '',
      style: { fill: 0xd6bcfa, fontSize: 14, fontFamily: 'monospace', fontWeight: 'bold', align: 'center', padding: 6 },
    });
    this.titleText.anchor.set(0.5, 0);
    this.titleText.eventMode = 'none'; // decoration; the press belongs to the panel

    for (let i = 0; i < 3; i++) {
      const slot = i + 1;
      // `wrapWidth`: a card is 150px wide in every locale, and 26 of the 56 card strings do
      // not fit on one line at that width (the Spanish potion card measures 238px) — they
      // were drawn running out of the card and across its neighbours until 2026-09-21.
      const btn = new Button('', { w: CARD_W, h: CARD_H, color: 0x2d2a42, borderColor: 0x6b46c1, fontSize: CARD_FONT, wrapWidth: CARD_TEXT_W });
      btn.onTap = () => this.onVote?.(slot);
      this.cards.push(btn);

      const tally = new Text({
        text: '',
        style: { fill: 0xfaf089, fontSize: 12, fontFamily: 'monospace', fontWeight: 'bold', padding: 6 },
      });
      tally.anchor.set(0.5, 0);
      tally.eventMode = 'none';
      this.tallies.push(tally);
    }

    this.view.addChild(this.panel.view, this.titleText, ...this.cards.map((c) => c.view), ...this.tallies);
    this.view.visible = false;
    // `static` so the panel's own background is a real event target: a press on the gap
    // between two cards has to be swallowed on exactly the same terms as a press on a
    // card. Same reasoning, and the same `pointerdowncapture` registration, as
    // `WeaponPickupPrompt` — `WebInput` reads `firing` from a raw `mousedown` that a
    // Pixi button consuming the event knows nothing about, so the suppression has to be
    // driven explicitly from here.
    this.view.eventMode = 'static';
    this.view.on('pointerdowncapture', () => this.onPressStart?.());
  }

  /**
   * Re-anchor on viewport resize (Game's relayoutViewport, same as HudView).
   *
   * Everything inside is laid out in the panel's OWN space and the container is then
   * placed and scaled as a whole. The scale is what keeps a 494px-wide panel of three
   * cards on a viewport narrower than that: at 480px the old absolute layout put the
   * panel's left edge at x=-7 and its first card half off the screen. Down only
   * (`Math.min(1, …)`), so every viewport at or above the panel's own width is
   * unchanged — the same rule, and the same reason, as `menuFitScale`.
   */
  reposition(screenPx: { w: number; h: number }): void {
    this.panel.layout(PANEL_W, PANEL_H);
    const scale = Math.min(1, (screenPx.w - 16) / PANEL_W);
    this.view.scale.set(scale);
    // Above the portal popup (which sits at 0.6 of the screen height), so the two read
    // as one stack: "here is what you won, here is where you go".
    this.view.position.set(
      screenPx.w / 2 - (PANEL_W * scale) / 2,
      Math.max(8, screenPx.h * 0.6 - PANEL_H * scale - 12),
    );
    this.panel.view.position.set(0, 0);
    this.titleText.position.set(PANEL_W / 2, 8);
    for (let i = 0; i < this.cards.length; i++) {
      const cx = PANEL_PAD + i * (CARD_W + GAP);
      this.cards[i]!.view.position.set(cx, TITLE_H + PANEL_PAD);
      this.tallies[i]!.position.set(cx + CARD_W / 2, TITLE_H + PANEL_PAD + CARD_H + 2);
    }
  }

  /**
   * `show` is the caller's already-computed "at an eligible checkpoint AND standing near
   * the portal" condition — the same one `PortalPrompt` takes, so the two panels can
   * never disagree about whether the floor is finished.
   *
   * An offer of fewer than three (the last floor's empty one) closes the panel outright
   * rather than drawing dead slots: there is no card to pick there at all.
   */
  update(s: GameState, show: boolean, localOwner: number): void {
    const offer = s.floorCardOffer;
    const open = show && offer.length > 0;
    this._isOpen = open;
    this.view.visible = open;
    if (!open) return;

    const votes = s.players.map((p) => p.cardVote);
    const mine = s.players[localOwner]?.cardVote ?? 0;
    // Locale is part of the cache key, same convention as WeaponCard/WeaponPickupPrompt:
    // these strings are translated, so a language change has to rebuild them even when
    // the offer and the votes have not moved.
    const key = `${getLocale()}|${offer.join(',')}|${votes.join(',')}|${s.players.length}`;
    if (key === this.lastKey) return;
    this.lastKey = key;

    this.titleText.text = t('hud.floorCardTitle');
    for (let i = 0; i < this.cards.length; i++) {
      const btn = this.cards[i]!;
      const id = offer[i];
      const visible = id !== undefined;
      btn.view.visible = visible;
      this.tallies[i]!.visible = visible;
      if (id === undefined) continue;

      const def = FLOOR_CARDS[id];
      // An id with no catalogue entry can only mean a client older than the sim that
      // sent it. Showing the raw id beats showing an empty card: the player can still
      // pick it, and the sim — which does know the card — still applies it correctly.
      // `tName`, not `t`: these are content nameKeys off an engine catalogue, so they
      // are open-ended runtime strings rather than the closed `TranslationKey` union —
      // the same seam weapon/skin/material/buff names already go through, with
      // `i18n/contentNames.test.ts` as the parity net. The description numbers come from
      // the catalogue itself (`floorCardDescVars`) so a retuned buff cannot leave eight
      // locale files promising the old figure.
      btn.setText(def ? `${tName(def.nameKey)}\n${tName(def.descKey, floorCardDescVars(id))}` : id);
      // The card's own art, above its text (`uiSkins.ts`'s `icon_card_*`). Keyed off the
      // offer's id rather than a table here, and `undefined` — a card with no art yet, or
      // an id from a newer sim — takes `setIcon`'s clear branch and leaves the card exactly
      // as it read before the icons existed. Art never gates play (design/12), and this is
      // the panel where that matters most: the offer is on a timer the player is standing in.
      btn.setIcon(getUiTexture(`icon_card_${id}`), undefined, 'top');
      // The local seat's own pick is the selected one. Border colour rather than fill,
      // matching the browse-cursor convention `BlueprintCard` already uses.
      btn.setBorder(mine === i + 1 ? 0xfaf089 : 0x6b46c1);

      const n = votes.filter((v) => v === i + 1).length;
      // Solo play has no majority to resolve, so a "1" under the card you just tapped is
      // noise. In co-op it is the whole point of showing the panel at all.
      this.tallies[i]!.text = s.players.length > 1 && n > 0 ? t('hud.floorCardVotes', { n }) : '';
    }
  }
}
