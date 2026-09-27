import { Container, Graphics, Text } from 'pixi.js';
import { buildArenaSpecs, PVP_SCALE_FACTOR, type SkinId } from '@dd/engine';
import { Button } from '../ui/widgets';
import { MenuShell } from '../ui/MenuShell';
import type { LobbyBackdrop } from '../ui/LobbyBackdrop';
import { SHEET_PAD, SHEET_TITLE_H, placeHeading } from '../ui/MenuSheet';
import { MENU_BUTTONS, MENU_COLORS, menuText } from '../ui/menuTheme';
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

/** The sheet's width and content width; the build box's inset, and the QUEUE button. */
const SHEET_W = 440;
const CONTENT_W = SHEET_W - SHEET_PAD * 2;
const BOX_PAD = 14;
const BUILD_BOX_H = BOX_PAD + PlayerCard.HEIGHT + 12 + WeaponCard.HEIGHT + BOX_PAD;
const QUEUE_H = 50;

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
 *
 * Since the menu shell (design/10 "One shell for every menu", 2026-09-27) it is one framed
 * sheet: ARENA (the map and its size), YOUR BUILD (the character and the whole kit, in a box of
 * their own), the fairness note, then QUEUE across the sheet in the lobby's PvP red. BACK is the
 * shell's corner chip.
 */
export class PvpPreview {
  readonly view = new Container();
  private readonly shell: MenuShell;
  /** The dimmed lobby painting. Named `panel` for `menuCoversWorld.test.ts`. */
  private readonly panel: LobbyBackdrop;
  private readonly rules = new Graphics();
  /** The box the build sits in — drawn, not pressed. */
  private readonly buildBox = new Graphics();
  private readonly arenaHeading: Text;
  private readonly buildHeading: Text;
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

  onQueue: (() => void) | null = null;
  onBack: (() => void) | null = null;

  constructor() {
    this.shell = new MenuShell({ title: t('pvpPreview.title'), back: t('pvpPreview.back') });
    this.shell.onBack = () => this.onBack?.();
    this.panel = this.shell.backdrop;
    this.arenaHeading = new Text({ text: '', style: menuText('heading') });
    this.buildHeading = new Text({ text: '', style: menuText('heading') });
    this.mapLine = new Text({ text: '', style: menuText('value') });
    this.fairnessNote = new Text({ text: '', style: menuText('caption', { fontSize: 12, lineHeight: 16, align: 'center', wordWrapWidth: CONTENT_W }) });
    this.fairnessNote.anchor.set(0.5, 0);

    this.queueBtn = new Button('', { w: CONTENT_W, h: QUEUE_H, fontSize: 18, ...MENU_BUTTONS.pvp });
    this.queueBtn.onTap = () => this.onQueue?.();

    this.shell.content.addChild(
      this.rules, this.buildBox, this.arenaHeading, this.mapLine, this.buildHeading,
      this.playerCard.view, this.weaponCard.view, this.weaponSlotChip.view, this.fairnessNote, this.queueBtn.view,
    );
    this.shell.mount(this.view);
    this.view.eventMode = 'static';
    this.view.visible = false;
  }

  /** `skinId` is the player's already-chosen character (MetaState.selectedSkin) — PvP
   *  carries character choice same as PvE (the fairness wall's one named exception,
   *  design/14/15), so the preview shows the SAME scaled build a real match would seat
   *  them with (`buildArenaSpecs`, the exact function GameState.buildSeat calls). */
  show(w: number, h: number, skinId: string): void {
    this.retext(skinId);
    this.shell.layout(w, h, SHEET_W, this.layout());
    this.view.visible = true;
  }

  /** Flow the sheet top to bottom and return its height (title plate and padding included). */
  private layout(): number {
    this.rules.clear();
    let y = placeHeading(this.arenaHeading, this.rules, 0, 0, CONTENT_W);
    this.mapLine.position.set(0, y);
    y += 26 + 12;

    y = placeHeading(this.buildHeading, this.rules, 0, y, CONTENT_W);
    const c = MENU_COLORS;
    this.buildBox.clear()
      .roundRect(0, y, CONTENT_W, BUILD_BOX_H, 10).fill({ color: c.field, alpha: 0.9 })
      .roundRect(0, y, CONTENT_W, BUILD_BOX_H, 10).stroke({ color: c.fieldBorder, width: 1 });
    this.playerCard.view.position.set(BOX_PAD, y + BOX_PAD);
    const weaponRowY = y + BOX_PAD + PlayerCard.HEIGHT + 12;
    this.weaponCard.view.position.set(BOX_PAD, weaponRowY);
    // Right of the active card, same row and same gap as HudView's own idle-slot chip
    // (+2 to line up with the WeaponCard's icon chip, which starts at local y=2).
    this.weaponSlotChip.view.position.set(BOX_PAD + this.weaponCard.estimatedWidth() + 10, weaponRowY + 2);
    y += BUILD_BOX_H + 12;

    this.fairnessNote.position.set(CONTENT_W / 2, y);
    y += Math.max(32, this.fairnessNote.height) + 12;
    this.queueBtn.view.position.set(0, y);
    y += QUEUE_H;
    return SHEET_TITLE_H + 18 + y + SHEET_PAD;
  }

  /** Per-frame: the backdrop's rocks, glow and motes. Driven from the main loop's
   *  `menuScreens`, and a no-op while this screen is hidden. */
  animate(dtMs: number): void {
    if (this.view.visible) this.panel.update(dtMs);
  }

  hide(): void {
    this.view.visible = false;
  }

  private retext(skinId: string): void {
    const built = buildArenaSpecs('landing_basic', skinId as SkinId);
    const rooms = ARENA_CATALOG[REAL_ARENA_ID].rooms.length;

    this.shell.setTitle(t('pvpPreview.title'));
    this.shell.setBack(t('pvpPreview.back'));
    this.arenaHeading.text = t('pvpPreview.sectionArena');
    this.buildHeading.text = t('pvpPreview.sectionBuild');
    this.mapLine.text = t('pvpPreview.map', { name: ARENA_DISPLAY_NAME[REAL_ARENA_ID], rooms });
    this.fairnessNote.text = t('pvpPreview.fairnessNote', { factor: PVP_SCALE_FACTOR });
    this.queueBtn.setText(t('pvpPreview.queue'));

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
