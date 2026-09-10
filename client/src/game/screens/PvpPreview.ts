import { Container, Text } from 'pixi.js';
import { buildArenaSpecs, PVP_SCALE_FACTOR, type SkinId } from '@dd/engine';
import { Panel, Button } from '../ui/widgets';
import { PlayerCard } from '../ui/PlayerCard';
import { WeaponCard } from '../ui/WeaponCard';
import { WeaponSlotChip } from '../ui/WeaponSlotChip';
import { ARENA_CATALOG, type ArenaId } from '../match/arenaCatalog';
import { t } from '../../i18n';

// Display names for the client-side arena catalog — a proper-noun map name, same
// "left untranslated" convention design/17-i18n.md already applies to weapon/character
// names (data-driven content, not UI chrome). `landing_basic` never appears in a real
// match (it's the `?arenaDemo=1` dev fixture — arenaCatalog.ts) but is named here too
// so this map stays total over `ArenaId` rather than needing a fallback string.
const ARENA_DISPLAY_NAME: Record<ArenaId, string> = {
  landing_basic: 'Landing Basic',
  arena_launch: 'The Seven Districts',
};

// A real PvP solo-queue match always resolves to this map (Game.buildOnlineConfig /
// match/pvpConfig.ts) — known upfront, before matchmaking even starts, so a preview can
// show it honestly rather than guessing.
const REAL_ARENA_ID: ArenaId = 'arena_launch';

/**
 * PvP match preview (design/10 open question "PvP preset-pick has no UI yet", 15) —
 * shown between the lobby's PVP SOLO QUEUE row and the Matchmaking screen, so a
 * player sees what they're about to enter instead of jumping straight into "Finding a
 * match…" blind. `design/15`'s `ARENA_PRESETS` schema was built to support multiple
 * presets, but only one (`landing_basic`, the loadout preset id — distinct from the
 * client's own `ArenaId` map catalog) exists today, so this is a confirm/preview step
 * rather than an actual picker; the map/weapon cards it reuses are exactly the widgets
 * a real picker would need, so adding a second preset later is additive here, not a
 * rewrite. Pure presentation: Game owns what QUEUE/BACK actually do.
 */
export class PvpPreview {
  readonly view = new Container();
  private readonly panel = new Panel({ alpha: 0.82, background: 'hub' });
  private readonly card = new Panel({ radius: 18, color: 0x05070c, alpha: 0.62, borderColor: 0x3a4a5c, borderAlpha: 0.5 });
  private readonly title: Text;
  private readonly mapLine: Text;
  private readonly fairnessNote: Text;
  private readonly playerCard = new PlayerCard();
  private readonly weaponCard = new WeaponCard();
  // The kit's OTHER slot, drawn with the same widget (and so the same reading) the
  // in-match HUD uses for it. A landing kit is a gun + a melee weapon (ENGINE_VERSION
  // 45), and this screen exists to show what a player is about to enter with — showing
  // only `weapons[0]` would now under-report the kit by half.
  private readonly weaponSlotChip = new WeaponSlotChip();
  private readonly queueBtn: Button;
  private readonly backBtn: Button;

  onQueue: (() => void) | null = null;
  onBack: (() => void) | null = null;

  constructor() {
    this.title = new Text({ text: '', style: { fill: 0xf7fafc, fontSize: 30, fontWeight: 'bold', fontFamily: 'sans-serif', padding: 12 } });
    this.title.anchor.set(0.5, 0);
    this.mapLine = new Text({ text: '', style: { fill: 0xcbd5e0, fontSize: 15, fontFamily: 'monospace', padding: 6 } });
    this.mapLine.anchor.set(0.5, 0);
    this.fairnessNote = new Text({
      text: '',
      style: { fill: 0x94a3b8, fontSize: 12, fontFamily: 'monospace', align: 'center', wordWrap: true, wordWrapWidth: 340, breakWords: true, padding: 6 },
    });
    this.fairnessNote.anchor.set(0.5, 0);

    this.queueBtn = new Button('', { w: 220, h: 48, fontSize: 18, color: 0x9b2c2c, borderColor: 0xfc8181 });
    this.queueBtn.onTap = () => this.onQueue?.();
    this.backBtn = new Button('', { w: 140, h: 34, fontSize: 13, sound: 'ui.back' });
    this.backBtn.onTap = () => this.onBack?.();

    this.view.addChild(
      this.panel.view, this.card.view, this.title, this.mapLine, this.fairnessNote,
      this.playerCard.view, this.weaponCard.view, this.weaponSlotChip.view, this.queueBtn.view, this.backBtn.view,
    );
    this.view.eventMode = 'static';
    this.view.visible = false;
  }

  /** `skinId` is the player's already-chosen character (MetaState.selectedSkin) — PvP
   *  carries character choice same as PvE (the fairness wall's one named exception,
   *  design/14/15), so the preview shows the SAME scaled build a real match would seat
   *  them with (`buildArenaSpecs`, the exact function GameState.buildSeat calls). */
  show(w: number, h: number, skinId: string): void {
    this.retext(skinId);
    this.panel.layout(w, h);

    const cx = w / 2;
    let y = Math.max(30, h * 0.08);
    this.title.position.set(cx, y);
    y += 46;
    this.mapLine.position.set(cx, y);
    y += 28;

    const cardW = Math.min(360, w - 40);
    const cardTop = y;
    const cardH = 16 + PlayerCard.HEIGHT + 12 + WeaponCard.HEIGHT + 16;
    this.card.layout(cardW, cardH);
    this.card.view.position.set(cx - cardW / 2, cardTop);
    this.playerCard.view.position.set(cx - cardW / 2 + 16, cardTop + 16);
    const weaponRowY = cardTop + 16 + PlayerCard.HEIGHT + 12;
    this.weaponCard.view.position.set(cx - cardW / 2 + 16, weaponRowY);
    // Right of the active card, same row and same gap as HudView's own idle-slot chip
    // (+2 to line up with the WeaponCard's icon chip, which starts at local y=2).
    this.weaponSlotChip.view.position.set(cx - cardW / 2 + 16 + this.weaponCard.estimatedWidth() + 10, weaponRowY + 2);
    y = cardTop + cardH + 16;

    this.fairnessNote.position.set(cx, y);
    y += 50;
    this.queueBtn.view.position.set(cx - 110, y);
    y += 64;
    this.backBtn.view.position.set(cx - 70, y);

    this.view.visible = true;
  }

  hide(): void {
    this.view.visible = false;
  }

  private retext(skinId: string): void {
    const built = buildArenaSpecs('landing_basic', skinId as SkinId);
    const rooms = ARENA_CATALOG[REAL_ARENA_ID].rooms.length;

    this.title.text = t('pvpPreview.title');
    this.mapLine.text = t('pvpPreview.map', { name: ARENA_DISPLAY_NAME[REAL_ARENA_ID], rooms });
    this.fairnessNote.text = t('pvpPreview.fairnessNote', { factor: PVP_SCALE_FACTOR });
    this.queueBtn.setText(t('pvpPreview.queue'));
    this.backBtn.setText(t('pvpPreview.back'));

    // Full pools (this IS the character's PvP-scaled max, not a live run) — the same
    // scaled build GameState.buildSeat gives a real arena seat.
    this.playerCard.set(skinId, built.maxHp, built.maxHp, built.maxShield, built.maxShield);
    const weapon = built.weapons[0] ?? null;
    this.weaponCard.set(weapon?.spec ?? null, 1, 1); // ready (full bar), no live cooldown to show
    // Slot 2 — hidden rather than drawn empty if a preset ever carries one weapon, the
    // same convention HudView applies to this widget.
    const other = built.weapons[1] ?? null;
    this.weaponSlotChip.view.visible = other !== null;
    this.weaponSlotChip.set(other?.spec ?? null);
  }
}
