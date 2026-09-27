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
//
// ## The orbiting weapon
//
// One weapon circles the body on a flattened ellipse, passing in front of it on the near half
// and behind it on the far half, a little smaller and dimmer there. It is always the same one
// (`lobby_weapon`, the cryobolt, whose cyan matches the dais crystal) rather than the player's
// loadout: the weapon art lives in the `forge` pack, which loads at the run phase, so the lobby
// ships its own copy of exactly one — and the loadout is empty on the lobby anyway, consumed by
// the run it was staged for.
//
// ## The caption
//
// Name, stats, and — once any dungeon run has ended — the deepest floor reached
// (`MetaState.bestFloor`).
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
/** The weapon's orbit: the ellipse's half-axes and its centre above the feet, as fractions of
 *  the body's height; the weapon's own long axis likewise; one lap in `ORBIT_PERIOD_MS`. */
const ORBIT_RX = 0.66;
const ORBIT_RY = 0.2;
const ORBIT_CY = 0.45;
const WEAPON_SIZE = 0.4;
const ORBIT_PERIOD_MS = 7000;
/** The caption's line offsets under `captionY`, in the lobby's own units. */
const STATS_DY = 26;
const BEST_DY = 44;

export class LobbyHero {
  readonly view = new Container();
  private shadow = new Graphics();
  private sprite = new Sprite();
  private nameText: Text;
  private statsText: Text;
  private bestText: Text;
  private weapon = new Sprite();
  private skinId: string | null = null;
  private bestFloor = 0;
  private footX = 0;
  private footY = 0;
  private bodyH = 0;
  private clockMs = 0;
  private orbitMs = 0;
  private weaponScale = 1;

  constructor() {
    this.sprite.anchor.set(0.5, 1);
    this.nameText = new Text({ text: '', style: { fill: 0xffffff, fontSize: 20, fontFamily: 'monospace', fontWeight: 'bold', padding: 12, stroke: { color: 0x0b0e14, width: 5 } } });
    this.nameText.anchor.set(0.5, 0);
    this.statsText = new Text({ text: '', style: { fill: 0xbee3f8, fontSize: 12, fontFamily: 'monospace', padding: 10, stroke: { color: 0x0b0e14, width: 4 } } });
    this.statsText.anchor.set(0.5, 0);
    this.bestText = new Text({ text: '', style: { fill: 0xfbd38d, fontSize: 12, fontFamily: 'monospace', fontWeight: 'bold', padding: 10, stroke: { color: 0x0b0e14, width: 4 } } });
    this.bestText.anchor.set(0.5, 0);
    this.bestText.visible = false;
    this.weapon.anchor.set(0.5);
    this.weapon.visible = false;
    // `zIndex` rather than two parents: `place()` moves the weapon in front of the body (2) or
    // behind it (0) as it laps.
    this.view.sortableChildren = true;
    this.sprite.zIndex = 1;
    this.nameText.zIndex = this.statsText.zIndex = this.bestText.zIndex = 3;
    this.view.addChild(this.shadow, this.weapon, this.sprite, this.nameText, this.statsText, this.bestText);
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
    const weaponTex = getUiTexture('lobby_weapon');
    this.weapon.visible = !!weaponTex;
    if (weaponTex) this.weapon.texture = weaponTex;
  }

  /** The deepest floor reached; 0 hides the line. */
  setBestFloor(floor: number): void {
    this.bestFloor = floor;
    this.retext();
  }

  /** The name and stats in the active locale — `MainMenu.retext` calls this. */
  retext(): void {
    const def = this.skinId ? SKIN_DEFS[this.skinId] : undefined;
    this.nameText.text = def ? tName(def.nameKey) : '';
    this.statsText.text = def ? t('loadout.charStats', { hp: def.maxHp, sh: def.maxShield }) : '';
    this.bestText.visible = this.bestFloor > 0;
    this.bestText.text = this.bestFloor > 0 ? t('mainMenu.bestFloor', { floor: this.bestFloor }) : '';
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
    this.bestText.style.fontSize = Math.round(12 * k);
    this.nameText.position.set(footX, captionY);
    this.statsText.position.set(footX, captionY + STATS_DY * k);
    this.bestText.position.set(footX, captionY + BEST_DY * k);
    const wt = this.weapon.texture;
    this.weaponScale = (height * WEAPON_SIZE) / Math.max(wt.width, wt.height, 1);
    this.place();
  }

  update(dtMs: number): void {
    if (!this.view.visible) return;
    this.clockMs = (this.clockMs + dtMs) % BOB_PERIOD_MS;
    this.orbitMs = (this.orbitMs + dtMs) % ORBIT_PERIOD_MS;
    this.place();
  }

  private place(): void {
    const phase = Math.sin((this.clockMs / BOB_PERIOD_MS) * Math.PI * 2);
    const lift = this.bodyH * (HOVER + BOB * (phase + 1) / 2);
    this.sprite.position.set(this.footX, this.footY - lift);
    // The shadow tightens as the body rises, which is what sells the hover.
    this.shadow.alpha = 0.85 - 0.25 * (phase + 1) / 2;

    // The orbit rides with the body. `near` is +1 at the front of the lap (lowest on screen,
    // nearest the viewer) and -1 at the back.
    const angle = (this.orbitMs / ORBIT_PERIOD_MS) * Math.PI * 2;
    const near = Math.sin(angle);
    this.weapon.position.set(
      this.footX + Math.cos(angle) * this.bodyH * ORBIT_RX,
      this.footY - lift - this.bodyH * ORBIT_CY + near * this.bodyH * ORBIT_RY,
    );
    this.weapon.scale.set(this.weaponScale * (0.86 + 0.14 * near));
    this.weapon.alpha = 0.8 + 0.2 * near;
    this.weapon.rotation = -0.2 * Math.cos(angle);
    this.weapon.zIndex = near >= 0 ? 2 : 0;
  }
}
