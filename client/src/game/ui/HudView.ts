import { Container, Graphics } from 'pixi.js';
import { THEME } from '../theme';
import type { Layers } from '../scene/layers';
import { Panel, ToastQueue, Button } from './widgets';
import { nearbyWeaponPickups, WEAPON_PROMPT_RADIUS_FP } from './pickupProximity';
import { WeaponPickupPrompt } from './WeaponPickupPrompt';
import { Minimap, type MinimapPlayer } from './Minimap';
import { dungeonRoomStatus, dungeonToArenaMap, roomStatus } from './minimapLayout';
import { PlayerCard, AllyRow } from './PlayerCard';
import { SeatRoster } from './SeatRoster';
import { WeaponCard } from './WeaponCard';
import { WeaponSlotChip } from './WeaponSlotChip';
import { StatChip } from './StatChip';
import { DownedBanner } from './DownedBanner';
import type { HudIconId } from './hudIcons';
import type { GameState, SeatNames } from '@dd/engine';
import { t, type TranslationKey } from '../../i18n';
import { totalFloorCount } from '../match/floorCount';

/** The bits of Game's own state updateHud needs that aren't already on GameState. */
export interface HudContext {
  localOwner: number;
  score: number;
  selectedSkin: string;
  /** Co-op teammate line (ROADMAP 3.1) — shown for a local bot ally or the arenaDemo harness. */
  showAlly: boolean;
  allySkinId: string;
  /** Seat index -> display name, from the server (design/20). Absent offline and for a
   *  room in which nobody was logged in, which is most rooms — `SeatRoster` then draws
   *  nothing and the row is not laid out at all. */
  seatNames?: SeatNames;
  /** Whether a replay of THIS run could actually be saved (`replayBtn`) — false for an
   *  online match, whose record is the server's confirmed stream, not ours. A control
   *  that cannot work should not be on screen. */
  canSaveReplay: boolean;
}

type ChipKey = 'floor' | 'room' | 'enemies' | 'banked' | 'score' | 'buffs' | 'stage' | 'alive';

// Each chip's glyph + tint. Tints are pulled from what the stat refers to ON SCREEN, not
// picked for variety: the foe count takes the enemy faction red, banked materials take
// the material-pickup yellow, buffs take the buff-pickup violet, the PvP zone stage takes
// the same amber the Minimap telegraphs a closing room with. A player who has learned a
// colour in the world reads the chip for free.
const CHIP_DEFS: Record<ChipKey, { icon: HudIconId; color: number; label: TranslationKey }> = {
  floor: { icon: 'floor', color: 0xf6ad55, label: 'hud.chips.floor' },
  room: { icon: 'room', color: 0x90cdf4, label: 'hud.chips.room' },
  enemies: { icon: 'enemies', color: THEME.colors.enemy, label: 'hud.chips.enemies' },
  banked: { icon: 'banked', color: THEME.colors.pickupMaterial, label: 'hud.chips.banked' },
  score: { icon: 'score', color: 0xffd27f, label: 'hud.chips.score' },
  buffs: { icon: 'buffs', color: THEME.colors.pickupBuff, label: 'hud.chips.buffs' },
  stage: { icon: 'stage', color: 0xf6ad55, label: 'hud.chips.stage' },
  alive: { icon: 'alive', color: 0x68d391, label: 'hud.chips.alive' },
};

// Which chips a mode shows, in row order. `buffs` is in both and drops out of the row
// whenever the run has none — an always-zero chip is noise.
const PVE_CHIPS: readonly ChipKey[] = ['floor', 'room', 'enemies', 'banked', 'score', 'buffs'];
const PVP_CHIPS: readonly ChipKey[] = ['stage', 'alive', 'score', 'buffs'];

const PAD = 12; // panel inset, all four sides
const GAP = 8; // vertical gap between HUD sections
const CHIP_GAP = 6;
const WEAPON_SLOT_GAP = 10; // horizontal gap between the active WeaponCard and the idle-slot chip

/**
 * In-match HUD (design/10 widget kit), extracted out of Game.ts 2026-07-28 and rebuilt
 * as real UI 2026-08-02. It previously composed a couple of bars with two monospace
 * strings — a weapon line and one long "Floor 1/3 Room 1/2 Enemies 1 Banked 0 Score 0"
 * run-on — which read as a debug print rather than a HUD (the user's own complaint).
 * Every one of those values is now a widget: a `PlayerCard` (portrait + name + the two
 * defensive pools), a `WeaponCard` (real weapon art + rarity + element + damage +
 * cooldown), and a row of icon-led `StatChip`s, over one backing `Panel` that sizes
 * itself to whichever section is widest.
 *
 * `view` is the visibility root Game's own phase transitions toggle; HudView owns the
 * widgets, not the show/hide root. `settingsBtn` deliberately stays on Game: it's shown
 * in the FORGE phase too, so it isn't really part of "the HUD."
 */
export class HudView {
  readonly view = new Container();
  // Sub-widgets are public so tests (and any future caller) can assert against a named
  // widget rather than indexing into `view.children` by position, which is what the
  // previous version of this file forced on HudView.test.ts.
  readonly playerCard = new PlayerCard();
  readonly weaponCard = new WeaponCard();
  // The OTHER carried weapon (design/10 HUD follow-up, 2026-08-12) — a small tappable
  // icon beside the active WeaponCard; tapping it swaps the active slot. Hidden
  // whenever the loadout has fewer than two weapons (update()).
  readonly weaponSlotChip = new WeaponSlotChip();
  readonly allyRow = new AllyRow();
  readonly seatRoster = new SeatRoster();
  readonly downedBanner = new DownedBanner();
  readonly chips = new Map<ChipKey, StatChip>();
  // Ground weapon-pickup panel (design/03, ENGINE_VERSION 32) — lists every nearby
  // floor weapon (icon + name); tapping one is the collect action itself. Replaces the
  // old single-nearest "ground compare card" + tap-INTERACT gesture.
  readonly weaponPickupPrompt = new WeaponPickupPrompt();
  // Shared PvP/PvE room-graph minimap (design/10, PvE wiring 2026-08-05) — its own
  // visibility is driven independently of the rest of the HUD (zoneEnabled/
  // dungeonRooms, not phase), so it's mounted as a SIBLING of `view` inside
  // `layers.hudOverlay`, not as a child of `view` (see build()). Box size is fixed, so
  // it can construct as a plain field.
  readonly minimap = new Minimap({ w: 140, h: 140 });
  // In-run pause entry point (design/10, "now resolved" — a real gap this pass closed:
  // `Game.pause()` had exactly one way in, a keyboard Escape/P listener, so touch/WeChat
  // players — who have no keyboard at all — could never pause mid-run. Top-right corner,
  // above the minimap; '‖' reads as a universal pause glyph with no translation needed
  // (same single-glyph-label convention Forge's ‹/› cycle buttons already use).
  readonly pauseBtn = new Button('‖', { w: 36, h: 36, fontSize: 16 });
  // Save a marked replay of the run so far (design/08 "Getting a replay OUT of a live
  // session"). Exactly the same defect the pause button above exists for, one layer over:
  // the save verb shipped as an F9 hotkey, and a touch/WeChat player has no keyboard at
  // all — which is the platform a bug report is most likely to come FROM. '●' is the
  // transport-control record glyph, needs no translation, and sits directly under '‖'
  // so the two read as one control column. Hidden unless the run is recordable (update()).
  readonly replayBtn = new Button('●', { w: 36, h: 36, fontSize: 14, sound: 'ui.tap' });
  /** Wired by Game to the same `pause()` its Escape/P keyboard handler already calls —
   *  one source of truth for both input paths, matching Forge's onX callback shape. */
  onPause: (() => void) | null = null;
  /** Wired by Game to the same swap action the keyboard (1/2) and touch corner buttons
   *  already trigger — see WeaponSlotChip's own doc comment for why "tap the idle
   *  slot" and "cycle the active slot" are the same action with a two-weapon loadout. */
  onSwapWeapon: (() => void) | null = null;
  /** Wired by Game to the same `saveReplay()` its F9 keyboard handler already calls —
   *  one verb, two entry points, matching `onPause`'s shape exactly. */
  onSaveReplay: (() => void) | null = null;

  private statsPanel!: Panel;
  private readonly dividers = new Graphics();
  private toasts!: ToastQueue;
  private panelW = 0;
  private panelH = 0;

  build(layers: Layers, screenPx: { w: number; h: number }): void {
    this.statsPanel = new Panel({ radius: 10, color: 0x0b0e14, alpha: 0.66, borderColor: 0x4c566a, borderAlpha: 0.55 });
    this.toasts = new ToastQueue({ w: 220 });
    this.pauseBtn.onTap = () => this.onPause?.();
    this.replayBtn.onTap = () => this.onSaveReplay?.();
    this.weaponSlotChip.onTap = () => this.onSwapWeapon?.();

    this.statsPanel.view.position.set(4, 4);
    this.playerCard.view.position.set(PAD, 10);
    this.weaponCard.view.position.set(PAD, 10 + PlayerCard.HEIGHT + GAP);
    // x is re-set every layout() once weaponCard's real width is known; y is fixed here
    // (+2 to match the WeaponCard's own icon chip, which starts at local y=2, not 0).
    this.weaponSlotChip.view.position.set(PAD, 10 + PlayerCard.HEIGHT + GAP + 2);

    for (const [key, def] of Object.entries(CHIP_DEFS) as Array<[ChipKey, (typeof CHIP_DEFS)[ChipKey]]>) {
      this.chips.set(key, new StatChip(def.icon, def.color));
    }

    this.view.addChild(
      this.statsPanel.view,
      this.dividers,
      this.playerCard.view,
      this.weaponCard.view,
      this.weaponSlotChip.view,
      ...[...this.chips.values()].map((c) => c.view),
      this.allyRow.view,
      this.seatRoster.view,
      this.toasts.view,
      this.weaponPickupPrompt.view,
      this.downedBanner.view,
      this.pauseBtn.view,
      this.replayBtn.view,
    );
    // NOTE: `view` itself is NOT added to `layers.ui` here — the caller (Game) mounts
    // it inside its own visibility-toggled `hudView` container.

    // Minimap (design/10 "room progress") — hidden unless zoneEnabled/PvE has rooms
    // placed (update()). Top-right, inset enough to keep the WeChat capsule corner
    // clear (design/10 layout note). A sibling of `view`, not a child — see the field
    // doc comment above. `hudOverlay`, NOT `layers.ui` directly: `ui` is exactly two
    // sub-layers now (layers.ts) and the menus are the upper one, so a third child
    // mounted straight into `ui` would paint the minimap OVER the pause menu.
    layers.hudOverlay.addChild(this.minimap.view);

    this.reposition(screenPx);
  }

  /** Re-anchor the elements whose position depends on viewport size — call on build()
   *  and whenever the caller's own screenSize() changes. */
  reposition(screenPx: { w: number; h: number }): void {
    this.toasts.view.position.set(screenPx.w / 2 - 110, screenPx.h * 0.22);
    this.minimap.view.position.set(screenPx.w - 140 - 20, 60);
    this.pauseBtn.view.position.set(screenPx.w - 20 - 36, 12); // top-right corner, above the minimap
    // Beside the pause button, not under it: the minimap starts at y=60 on the same
    // right edge, so a second row would land on top of it.
    this.replayBtn.view.position.set(screenPx.w - 20 - 36 - 42, 12);
    this.downedBanner.reposition(screenPx);
  }

  update(s: GameState, dt: number, ctx: HudContext): void {
    const p = s.players[ctx.localOwner];
    this.replayBtn.view.visible = ctx.canSaveReplay;

    this.playerCard.set(
      ctx.selectedSkin, p?.hp ?? 0, p?.maxHp ?? 0, p?.shield ?? 0, p?.maxShield ?? 0,
      // Weapon energy (design/03/05, ENGINE_VERSION 59) — `?? 0` hides the bar for a
      // state with no pool at all, the same way a 0 shield pool hides its own.
      p?.energy ?? 0, p?.maxEnergy ?? 0,
    );
    this.playerCard.update(dt);

    // Cooldown sweep (design/10): weapon.cooldownTicks counts DOWN from the spec's fixed
    // cooldown (already whole ticks, sim-facing) to 0=ready — the bar fills as it recovers.
    const weapon = p?.weapon;
    const maxCdTicks = weapon
      ? Math.max(1, weapon.spec.kind === 'ranged' ? weapon.spec.fireRateTicks : weapon.spec.swingCooldownTicks)
      : 1;
    this.weaponCard.set(weapon?.spec ?? null, weapon ? maxCdTicks - weapon.cooldownTicks : maxCdTicks, maxCdTicks);
    this.weaponCard.update(dt);

    // The OTHER loadout slot (design/10 HUD follow-up) — only meaningful with a real
    // two-weapon loadout; a solo-weapon spawn (or no player yet) hides the chip rather
    // than drawing an empty "nothing to swap to" tile.
    const otherWeapon = p && p.weapons.length > 1 ? p.weapons[(p.activeSlot + 1) % p.weapons.length] : undefined;
    this.weaponSlotChip.view.visible = otherWeapon !== undefined;
    if (otherWeapon) this.weaponSlotChip.set(otherWeapon.spec);

    const buffCount = p?.buffs.length ?? 0;
    if (s.zoneEnabled) {
      // PvP arena (design/15) — zone stage / survivors / score, instead of the dungeon
      // floor-and-room chips, which have no meaning here.
      const zone = s.zone;
      const stage = zone?.stage ?? 0;
      this.chips.get('stage')!.set(t('hud.chips.stage'), zone?.escalation ? `${stage}+${zone.escalation}` : `${stage}`);
      this.chips.get('alive')!.set(t('hud.chips.alive'), `${s.players.filter((pl) => pl.alive).length}/${s.players.length}`);
    } else {
      // Dungeon progress (ROADMAP 1.3; co-resident room/door model, design/05
      // 2026-08-04): floor / room within floor, plus the banked bag. `s.dungeonRooms`
      // is the WHOLE floor (every room placed at once, ROADMAP 1.3/design/05) — "which
      // room" is now per-player (`roomId`), not a single global cursor, so it's looked
      // up via `dungeonRoomIndexById`. `-1` (roomId not yet resolved to any placed
      // room — before the floor places, or the one-tick activation lag right after)
      // is clamped to "room 1" for the chip text below.
      const rooms = s.dungeonRooms.length;
      const roomIndex = p?.roomId !== undefined ? s.dungeonRoomIndexById.get(p.roomId) ?? -1 : -1;
      this.chips.get('floor')!.set(t('hud.chips.floor'), `${s.floorIndex + 1}/${totalFloorCount(s)}`);
      this.chips.get('room')!.set(t('hud.chips.room'), `${Math.max(1, roomIndex + 1)}/${rooms}`);
      this.chips.get('enemies')!.set(t('hud.chips.enemies'), `${s.enemies.length}`);
      this.chips.get('banked')!.set(t('hud.chips.banked'), `${totalBanked(s)}`);
    }
    this.chips.get('score')!.set(t('hud.chips.score'), `${ctx.score}`);
    this.chips.get('buffs')!.set(t('hud.chips.buffs'), `${buffCount}`);

    // Co-op teammate (ROADMAP 3.1): the ally seat's health + downed/bleedout state, so
    // the second player is legible. Single-player omits the row entirely.
    const ally = ctx.showAlly ? s.players.find((_, i) => i !== ctx.localOwner) : undefined;
    this.allyRow.view.visible = ally !== undefined;
    if (ally) {
      this.allyRow.set(ctx.allySkinId, ally.hp, ally.maxHp, ally.downed, Math.ceil(ally.bleedoutTicks / 30), ally.reviveProgressTicks);
      this.allyRow.update(dt);
    }

    // Local seat's own downed/revive state (design/10 open question, ROADMAP 3.2) —
    // previously invisible: a downed player saw only a frozen world, nothing explaining
    // why or how long until either a revive completes or bleedout ends the run.
    this.downedBanner.set(p?.downed ?? false, p?.bleedoutTicks ?? 0, p?.reviveProgressTicks ?? 0);
    this.downedBanner.update(dt);

    // Who else is here, by name (design/20). Set BEFORE `layout`, which reserves the row
    // only when there is something in it — and `set` returning that answer is why the two
    // cannot disagree.
    const showRoster = this.seatRoster.set(ctx.seatNames, ctx.localOwner);
    this.layout(s.zoneEnabled ? PVP_CHIPS : PVE_CHIPS, buffCount > 0, ally !== undefined, showRoster);
    this.updateWeaponPickupPrompt(s, p);
    this.toasts.update(dt);

    // Shared room-graph minimap (design/10 "room progress"; PvE wiring 2026-08-05,
    // retiring the old FloorProgress track — a linear index couldn't represent a
    // fork's untaken sibling, the spatial map can). PvP reads state.arenaMap/zone
    // directly; PvE converts its placed-room/door data via dungeonToArenaMap/
    // dungeonRoomStatus (minimapLayout.ts) into the same ArenaMap shape.
    const players: MinimapPlayer[] = s.players.map((pl, i) => ({
      roomId: pl.roomId,
      alive: pl.alive,
      isLocal: i === ctx.localOwner,
    }));
    if (s.zoneEnabled && s.arenaMap) {
      this.minimap.view.visible = true;
      this.minimap.update(s.arenaMap, (id) => roomStatus(s.zone, id), players);
    } else if (s.dungeonRooms.length > 0) {
      this.minimap.view.visible = true;
      this.minimap.update(
        dungeonToArenaMap(s.dungeonRooms, s.dungeonDoors),
        (id) => dungeonRoomStatus(s.dungeonRoomRuntime, s.dungeonRoomIndexById, id),
        players,
      );
    } else {
      this.minimap.view.visible = false;
    }
  }

  /** Push a toast — the only HUD widget consumeEvents reaches into directly (pickup fx). */
  toast(text: string, color: number): void {
    this.toasts.push(text, color);
  }

  /** Pack the chip row, stack whatever sections are live, and size the backing panel to
   *  the widest of them. Sizing is `estimateMonoWidth`-derived throughout (never
   *  `Text.width`/`getBounds()`, both canvas-measurement calls) — see textWidth.ts for
   *  why: cheaper every frame, and testable without a live canvas. */
  private layout(order: readonly ChipKey[], showBuffs: boolean, showAlly: boolean, showRoster = false): void {
    let chipX = PAD;
    for (const [key, chip] of this.chips) {
      const active = order.includes(key) && (key !== 'buffs' || showBuffs);
      chip.view.visible = active;
      if (!active) continue;
      chip.view.position.set(chipX, 0); // y set below, once the row's own y is known
      chipX += chip.width + CHIP_GAP;
    }
    const chipsW = chipX - PAD - CHIP_GAP;

    // The idle-slot chip's x tracks the active WeaponCard's real (name-length-dependent)
    // width — a static offset would either overlap a long weapon name or leave a gap
    // after a short one.
    const weaponRowW = this.weaponCard.estimatedWidth() + (this.weaponSlotChip.view.visible ? WEAPON_SLOT_GAP + WeaponSlotChip.SIZE : 0);
    this.weaponSlotChip.view.position.x = PAD + this.weaponCard.estimatedWidth() + WEAPON_SLOT_GAP;

    let y = 10 + PlayerCard.HEIGHT + GAP + WeaponCard.HEIGHT + GAP;
    const chipRowY = y;
    for (const chip of this.chips.values()) if (chip.view.visible) chip.view.position.y = chipRowY;
    y += StatChip.HEIGHT;

    if (showAlly) {
      this.allyRow.view.position.set(PAD, y + 8);
      y += 8 + AllyRow.HEIGHT;
    }

    if (showRoster) {
      this.seatRoster.view.position.set(PAD, y + 6);
      y += 6 + SeatRoster.HEIGHT;
    }

    const w =
      Math.ceil(
        Math.max(
          this.playerCard.estimatedWidth(),
          weaponRowW,
          chipsW,
          showAlly ? this.allyRow.estimatedWidth() : 0,
          showRoster ? this.seatRoster.estimatedWidth() : 0,
        ),
      ) + PAD;
    const h = y + 10;
    if (w !== this.panelW || h !== this.panelH) {
      this.panelW = w;
      this.panelH = h;
      this.statsPanel.layout(w, h);
      this.redrawDividers(w);
      // The weapon-pickup panel floats immediately right of the HUD (design/03) — it
      // has to track the panel's live width, or a long localized weapon name slides
      // the panel out from under it.
      this.weaponPickupPrompt.view.position.set(w + 12, 40);
    }
  }

  private redrawDividers(w: number): void {
    // Hairlines between the three fixed sections (who you are / what you hold / how the
    // run is going). Cheap grouping cue — without them the card reads as one dense block.
    const line = (y: number) => {
      this.dividers.moveTo(PAD, y).lineTo(w - PAD + 4, y);
    };
    this.dividers.clear();
    line(10 + PlayerCard.HEIGHT + GAP / 2);
    line(10 + PlayerCard.HEIGHT + GAP + WeaponCard.HEIGHT + GAP / 2);
    this.dividers.stroke({ color: 0x4c566a, alpha: 0.35, width: 1 });
  }

  // Weapon-pickup panel (design/03) — lists every nearby floor weapon while standing
  // near one or more; the click itself is the collect action (WeaponPickupPrompt.onPick,
  // wired to CommandBuilder.requestPickup by Game.ts).
  private updateWeaponPickupPrompt(s: GameState, p: GameState['players'][number] | undefined): void {
    const nearby = p ? nearbyWeaponPickups(s.pickups, p.gx, p.gy, WEAPON_PROMPT_RADIUS_FP) : [];
    this.weaponPickupPrompt.update(nearby);
  }
}

function totalBanked(s: GameState): number {
  let n = 0;
  for (const v of Object.values(s.bankedMaterials)) n += v ?? 0;
  return n;
}
