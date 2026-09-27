// The lobby's hero showcase (design/10 "The lobby, redesigned", 2026-09-27): the player's
// selected character, hovering on the dais at the centre of the painting, with its name and
// stats beneath it.
//
// ## Its own art, not the rig
//
// The in-run rig is built for a 16-40 px body and its parts are separate bones; at showcase
// size it would need the whole Actor stack (rig, sphere shade, mounted weapon) to look like
// itself. Each character instead has one painted full-body portrait (`lobby_hero_*`),
// generated against the rig's own art as the reference. A character with no portrait yet
// draws nothing here rather than a wrong one — the dais simply stays empty.
import { Container, Graphics, Sprite, Text } from 'pixi.js';
import { SKIN_DEFS } from '@dd/engine';
import { getUiTexture } from '../../render/uiSkins';
import { t, tName } from '../../i18n';

/** Portrait art per render key (`SkinDef.atlasKey`). Keyed by the render key rather than the
 *  skin id so a second skin sharing a body would share its portrait too. */
export const HERO_PORTRAITS: Readonly<Record<string, string>> = {
  char_vanguard: 'lobby_hero_orb',
  char_skirmisher: 'lobby_hero_skirmisher',
  char_juggernaut: 'lobby_hero_juggernaut',
};

/** The hover: how far above the dais the body floats, and how far it bobs, as fractions of
 *  its own height. Slower than the in-run idle — this is a portrait, not a combatant. */
const HOVER = 0.1;
const BOB = 0.035;
const BOB_PERIOD_MS = 2800;

export class LobbyHero {
  readonly view = new Container();
  private shadow = new Graphics();
  private sprite = new Sprite();
  private nameText: Text;
  private statsText: Text;
  private skinId: string | null = null;
  private footX = 0;
  private footY = 0;
  private bodyH = 0;
  private clockMs = 0;

  constructor() {
    this.sprite.anchor.set(0.5, 1);
    this.nameText = new Text({ text: '', style: { fill: 0xffffff, fontSize: 20, fontFamily: 'monospace', fontWeight: 'bold', padding: 12, stroke: { color: 0x0b0e14, width: 5 } } });
    this.nameText.anchor.set(0.5, 0);
    this.statsText = new Text({ text: '', style: { fill: 0xbee3f8, fontSize: 12, fontFamily: 'monospace', padding: 10, stroke: { color: 0x0b0e14, width: 4 } } });
    this.statsText.anchor.set(0.5, 0);
    this.view.addChild(this.shadow, this.sprite, this.nameText, this.statsText);
    this.view.eventMode = 'none';
    this.view.visible = false;
  }

  /** Show this skin, or nothing for `null` or a skin with no portrait. */
  setCharacter(skinId: string | null): void {
    this.skinId = skinId;
    this.retext();
    const def = skinId ? SKIN_DEFS[skinId] : undefined;
    const key = def ? HERO_PORTRAITS[def.atlasKey] : undefined;
    const texture = key ? getUiTexture(key) : undefined;
    this.view.visible = !!texture;
    if (texture) this.sprite.texture = texture;
  }

  /** The name and stats in the active locale — `MainMenu.retext` calls this. */
  retext(): void {
    const def = this.skinId ? SKIN_DEFS[this.skinId] : undefined;
    this.nameText.text = def ? tName(def.nameKey) : '';
    this.statsText.text = def ? t('loadout.charStats', { hp: def.maxHp, sh: def.maxShield }) : '';
  }

  /**
   * Stand the hero on (`footX`, `footY`) — the dais centre — at `height` px tall, with the
   * caption starting at `captionY`. Font sizes scale with the lobby's own scale `k`.
   */
  layout(footX: number, footY: number, height: number, captionY: number, k: number): void {
    this.footX = footX;
    this.footY = footY;
    this.bodyH = height;
    const tex = this.sprite.texture;
    const s = tex.height > 0 ? height / tex.height : 1;
    this.sprite.scale.set(s);
    const bodyW = tex.width * s;
    this.shadow.clear().ellipse(footX, footY, bodyW * 0.32, bodyW * 0.07).fill({ color: 0x0b0e14, alpha: 0.3 });
    this.nameText.style.fontSize = Math.round(20 * k);
    this.statsText.style.fontSize = Math.round(12 * k);
    this.nameText.position.set(footX, captionY);
    this.statsText.position.set(footX, captionY + 26 * k);
    this.place();
  }

  update(dtMs: number): void {
    if (!this.view.visible) return;
    this.clockMs = (this.clockMs + dtMs) % BOB_PERIOD_MS;
    this.place();
  }

  private place(): void {
    const phase = Math.sin((this.clockMs / BOB_PERIOD_MS) * Math.PI * 2);
    this.sprite.position.set(this.footX, this.footY - this.bodyH * (HOVER + BOB * (phase + 1) / 2));
    // The shadow tightens as the body rises, which is what sells the hover.
    this.shadow.alpha = 0.85 - 0.25 * (phase + 1) / 2;
  }
}
