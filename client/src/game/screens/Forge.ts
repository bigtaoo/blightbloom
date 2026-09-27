import { Container, Graphics, Sprite, Text } from 'pixi.js';
import {
  BLUEPRINT_CATALOG, PLAYER_BASE, WEAPON_SPECS, RARITY_TIERS,
  resolveLoadout, type WeaponBlueprint,
} from '@dd/engine';
import type { MetaState } from '../../meta';
import { canAfford, isUnlocked, schematicCount, kindAlreadyStaged, purchasableBlueprints } from '../../meta';
import { Button } from '../ui/widgets';
import { MenuShell } from '../ui/MenuShell';
import { MaterialBank } from '../ui/MaterialBank';
import type { LobbyBackdrop } from '../ui/LobbyBackdrop';
import { MENU_BUTTONS, MENU_COLORS, menuText } from '../ui/menuTheme';
import { BlueprintCard } from '../ui/BlueprintCard';
import { CompareCard, buildCompareRows, equippedSpecOfKind } from '../ui/compareCard';
import { pageCount, pageStartForIndex, clampPageStart, wrapIndex } from '../ui/paging';
import { RARITY_COLORS } from '../theme';
import { getWeaponTexture } from '../../render/weaponSkins';
import { getUiTexture } from '../../render/uiSkins';
import { t, tName } from '../../i18n';
import { ELEMENT_SHORT_KEY, SOURCE_KEY } from '../../i18n/contentKeys';
import {
  NARROW_SHEET_W, PAGER_H, PAGE_SIZE, SIDE_W, STORE_H, WIDE_SHEET_W,
  compareCardW, forgeIsWide, layoutForgeSheet, type ForgeSheetParts,
} from './forgeSheet';

/** A blueprint's player-facing name: its weapon's, translated (design/09 — the catalogue id
 *  is an asset key, never display text). */
function blueprintName(id: string): string {
  const spec = WEAPON_SPECS[BLUEPRINT_CATALOG[id]?.weaponId ?? id];
  return spec ? tName(spec.nameKey) : id;
}

/**
 * The forge outpost (design/14, ROADMAP 2.2/2.3) — the page where the player spends
 * banked materials to craft weapons for the next run.
 *
 * ## One question per screen (2026-09-21)
 *
 * This used to be the whole between-run hub: the character picker, the materials bank,
 * START RUN and a paged grid of every blueprint in the catalog, all on one screen. It
 * answered two questions at once, and the crafting one took four fifths of the pixels. So
 * the pre-run half moved to `Loadout.ts` — character, the weapons actually being carried,
 * and the button that starts the run — and this screen kept the crafting grid and nothing
 * else. It is now reached from two places: the lobby's own FORGE route, and the FORGE card
 * at the end of the loadout screen's weapon row. BACK returns to whichever one that was
 * (`RunState.forgeReturnPhase`), not to a fixed screen.
 *
 * ## The sheet (design/10 "One shell for every menu", 2026-09-27)
 *
 * BACK is the shell's corner chip and everything else is one framed sheet: the material bank
 * over the paged grid on the left, and a side column with what the run carries, the compare
 * card, the forger and the store entry. Before, the same widgets floated on the backdrop in
 * one centred stack, the compare card hid whenever the viewport was short, and the forger sat
 * in the viewport's corner, shown only on a wide one. `forgeSheet.ts` holds the geometry.
 *
 * Pure presentation: it reads a MetaState and renders it; all mutation goes through the
 * meta/forge transactions, driven via the `onX` callbacks below (same pattern as
 * PauseMenu.ts/Settings.ts) — the keyboard path (`ForgeInput`) drives the exact same
 * underlying methods as these cards, so both input paths stay in sync by construction
 * rather than by duplicated logic.
 */
export class Forge {
  readonly view = new Container();
  private readonly shell: MenuShell;
  /** The dimmed lobby painting. Named `panel` for `menuCoversWorld.test.ts`. */
  private readonly panel: LobbyBackdrop;
  private rules = new Graphics();
  private bank: MaterialBank;
  private blueprintsHeading: Text;
  private carryingHeading: Text;
  /** The weapons the run would carry, by name — what decides whether a craft is a swap. */
  private carryingText: Text;
  private compareHeading: Text;
  private storeCaption: Text;
  private hint: Text;
  private pageLabel: Text;
  private storeBtn: Button;
  private prevPageBtn: Button;
  private nextPageBtn: Button;
  /** Fixed pool of PAGE_SIZE icon cards, reused across pages (relabeled + shown/hidden
   * per render) rather than one card per catalog entry — keeps the widget count
   * bounded regardless of how many blueprints exist. Laid out as a grid (design/14
   * icon-card pass). */
  private rowCards: BlueprintCard[];
  private compareCard = new CompareCard();
  /** The forger NPC (design/13's "Outpost/hub" NPC gap) — decorative art standing in the
   * side column's free space, hidden until its texture is generated (uiSkins.ts's
   * non-blocking preload) and whenever the column has too little room left for it. */
  private npcSprite = new Sprite();

  // Cached from the last render() call so the page-nav buttons (pure browse, no meta
  // mutation) can re-render themselves without needing a Game-level round-trip.
  private lastMeta: MetaState | null = null;
  private lastW = 0;
  private lastH = 0;

  /** Stable blueprint order = display order = the number key that crafts each of the
   * first PAGE_SIZE entries (design/10 loadout-detail decision). */
  readonly order: string[] = Object.keys(BLUEPRINT_CATALOG);

  /** Cursor over `order` (design/10's open "how much detail to show" question — an
   * arrow-key browse cursor OR a row tap moves it, so a player can preview a
   * blueprint's stats via the compare card without necessarily committing materials). */
  selectedIndex = 0;
  private pageStart = 0;

  onBack: (() => void) | null = null;
  /** Tapping a row both previews (moves `selectedIndex`) AND crafts it — one tap, no
   * separate select-then-confirm step (design/10's "favor fewer, clearer actions"
   * clutter decision). */
  onCraftAt: ((i: number) => void) | null = null;
  /** Opens the STORE (design/19 §4). This button used to hand the player the first
   * purchasable blueprint for FREE (`demo: free grant`, ROADMAP 2.4) — a grant the client
   * made to itself, which stopped surviving the next login the moment the server began
   * answering `/account/meta` from its own entitlements table. It now opens a real
   * purchase screen instead; `KeyB` runs the same verb. */
  onStore: (() => void) | null = null;

  /** Whether this build may show a store entry at all (`platform/storePlatform.ts` — a
   * web checkout inside an iOS store build is an App Store rule break, not a rough edge).
   * Set by the assembly; presentation never decides it. Default `false` so a caller that
   * forgets to set it shows NO store, which is the fail-closed direction. */
  storeEnabled = false;

  constructor() {
    this.shell = new MenuShell({ title: t('forge.title'), back: t('forge.backButton') });
    this.shell.onBack = () => this.onBack?.();
    this.panel = this.shell.backdrop;

    this.bank = new MaterialBank(t('forge.sectionMaterials'));
    this.blueprintsHeading = new Text({ text: t('forge.sectionBlueprints'), style: menuText('heading') });
    this.carryingHeading = new Text({ text: '', style: menuText('heading') });
    this.carryingText = new Text({ text: '', style: menuText('body', { fill: MENU_COLORS.text }) });
    this.compareHeading = new Text({ text: t('forge.sectionCompare'), style: menuText('heading') });
    // The shelf line has no fixed length (it names up to three blueprints), so it wraps —
    // and force-breaks, since a CJK translation has no spaces for Pixi's wrap to break at.
    this.storeCaption = new Text({ text: '', style: menuText('caption') });
    this.hint = new Text({ text: t('forge.hint'), style: menuText('caption', { wordWrap: false, align: 'center' }) });
    this.hint.anchor.set(0.5, 0);
    this.pageLabel = new Text({ text: '', style: menuText('label', { fill: MENU_COLORS.accent, fontSize: 12 }) });
    this.pageLabel.anchor.set(0.5);

    this.rowCards = Array.from({ length: PAGE_SIZE }, (_, slot) => {
      const c = new BlueprintCard();
      c.onTap = () => {
        const i = this.pageStart + slot;
        if (this.order[i] !== undefined) this.onCraftAt?.(i);
      };
      return c;
    });

    this.prevPageBtn = new Button(t('forge.pagePrevButton'), { w: 96, h: PAGER_H, fontSize: 12, autoWidth: true, ...MENU_BUTTONS.secondary });
    this.prevPageBtn.onTap = () => this.turnPage(-1);
    this.nextPageBtn = new Button(t('forge.pageNextButton'), { w: 96, h: PAGER_H, fontSize: 12, autoWidth: true, ...MENU_BUTTONS.secondary });
    this.nextPageBtn.onTap = () => this.turnPage(1);

    // Plain `ui.tap`, unlike the craft rows: opening a screen always does something, so
    // there is no outcome for a `silent` widget to wait on. The cues that DEPEND on a
    // transaction now live one screen further in, on the store's own rows.
    this.storeBtn = new Button(t('forge.storeButton'), { w: SIDE_W, h: STORE_H, fontSize: 14, ...MENU_BUTTONS.secondary });
    this.storeBtn.onTap = () => this.onStore?.();

    this.npcSprite.anchor.set(0.5, 1);
    this.npcSprite.visible = false;

    this.shell.content.addChild(
      this.rules, this.bank.view, this.blueprintsHeading,
      ...this.rowCards.map((c) => c.view),
      this.prevPageBtn.view, this.pageLabel, this.nextPageBtn.view,
      this.carryingHeading, this.carryingText, this.compareHeading, this.compareCard.view,
      this.npcSprite, this.storeCaption, this.storeBtn.view,
      this.hint,
    );
    this.shell.mount(this.view);
    this.view.eventMode = 'static';
    this.view.visible = false;
  }

  private turnPage(delta: number) {
    this.pageStart = clampPageStart(this.pageStart, delta, this.order.length, PAGE_SIZE);
    if (this.lastMeta) this.render(this.lastMeta, this.lastW, this.lastH);
  }

  /** Move the browse cursor, wrapping at both ends, and flip pages to keep it visible. */
  moveSelection(delta: number) {
    this.selectedIndex = wrapIndex(this.selectedIndex, delta, this.order.length);
    this.pageStart = pageStartForIndex(this.selectedIndex, PAGE_SIZE);
  }

  private costText(cost: readonly WeaponBlueprint['cost'][number][]): string {
    // Show the tier gate when a cost demands it (design/14): FIR×2≥t2 = two fire mats of
    // tier ≥ 2. Un-gated costs (minTier 0/absent) read as before.
    return cost.map((c) => `${t(ELEMENT_SHORT_KEY[c.element])}×${c.qty}${c.minTier ? `≥t${c.minTier}` : ''}`).join(' ');
  }

  render(m: MetaState, w: number, h: number) {
    this.lastMeta = m;
    this.lastW = w;
    this.lastH = h;

    // Re-apply every label that isn't already rebuilt below on each call, so a
    // language change (design/17-i18n.md) takes effect next time the forge re-renders.
    this.shell.setTitle(t('forge.title'));
    this.shell.setBack(t('forge.backButton'));
    this.bank.setTitle(t('forge.sectionMaterials'));
    this.blueprintsHeading.text = t('forge.sectionBlueprints');
    this.compareHeading.text = t('forge.sectionCompare');
    this.hint.text = t('forge.hint');
    this.prevPageBtn.setText(t('forge.pagePrevButton'));
    this.nextPageBtn.setText(t('forge.pageNextButton'));
    this.storeBtn.setText(t('forge.storeButton'));

    // Material bank — the five elemental kinds (design/14), summed across every rolled tier.
    this.bank.render(m);

    // An empty loadout names the ACTUAL default pair (resolveLoadout's fill-by-kind rule,
    // ENGINE_VERSION 45) rather than reading as "nothing" — the one place the forge tells
    // the player what an empty loadout means.
    this.carryingHeading.text = t('forge.sectionCarrying', { count: m.loadout.length, max: PLAYER_BASE.weaponSlots });
    this.carryingText.text = m.loadout.length
      ? m.loadout.map(blueprintName).join(' + ')
      : t('forge.noneStarterPair', { weapons: PLAYER_BASE.startWeapons.map((w) => tName(w.nameKey)).join(' + ') });

    // Named only when short; past 3 it collapses to a bare count — `buyable` can list every
    // unlocked-but-uncrafted blueprint at once (a real bug: unbounded, it used to run off
    // both edges of the screen as one line). A content-independent worst-case length is
    // safer than trusting wordWrap alone, given the Pixi measurement quirk widgets.ts's
    // Button `padding` comment records.
    const buyable = purchasableBlueprints(m);
    const buyableText = buyable.length <= 3 ? buyable.map(blueprintName).join(', ') : t('forge.moreAvailable', { count: buyable.length });
    this.storeCaption.text = t('forge.storeCaption', { items: buyableText });

    // Blueprint cards — icon, name, cost, status. The browse cursor (moveSelection /
    // a card tap) is a bright border instead of the old leading '»' glyph (design/14
    // icon-card pass — a grid has no "line start" for an inline glyph to sit at);
    // '▸staged' is a separate corner badge marking a crafted slot. Only the current
    // page's slice is shown; unused trailing slots on a partial last page are hidden.
    this.rowCards.forEach((card, slot) => {
      const i = this.pageStart + slot;
      const id = this.order[i];
      if (id === undefined) {
        card.view.visible = false;
        return;
      }
      card.view.visible = true;
      const bp = BLUEPRINT_CATALOG[id]!;
      // Two independent ways to be craftable now (design/14, ENGINE_VERSION 68): a
      // permanent recipe, or a banked one-time schematic — `permanent` is which one this
      // card has, `craftable` is whether it has either. A card with ONLY schematic stock
      // says so on the status line (`craftableSchematic`) rather than reading as
      // permanently `craftable`, because crafting it spends the last thing making it true.
      const permanent = isUnlocked(m, id);
      const stock = schematicCount(m, id);
      const craftable = permanent || stock > 0;
      const staged = m.loadout.filter((x) => x === id).length;
      const affordable = canAfford(m, bp);
      // A blueprint whose weapon KIND is already staged cannot be crafted however much
      // material the bank holds (design/03/05's one-gun-and-one-melee invariant, gated in
      // `meta/forge.ts craft`). Say so on the card: without this the press just plays
      // `ui.denied` on an unlocked, affordable weapon, which reads as a lost input rather
      // than as a rule.
      const kindTaken = craftable && kindAlreadyStaged(m, id);
      const status = !craftable
        ? (bp.source === 'drop' ? t('forge.lockedFind') : t('forge.lockedSource', { source: t(SOURCE_KEY[bp.source]) }))
        : kindTaken ? t('forge.kindTaken')
        : !affordable ? t('forge.needMaterials')
        : permanent ? t('forge.craftable') : t('forge.craftableSchematic', { count: stock });
      const statusColor = !craftable || kindTaken ? 0x718096 : affordable ? 0x68d391 : 0xf6ad55;
      const key = i < 9 ? `${i + 1}` : '·'; // only the first 9 have a digit-key shortcut
      const spec = WEAPON_SPECS[bp.weaponId];
      const borderColor = spec ? RARITY_COLORS[RARITY_TIERS[spec.rarity].colorKey] : 0x4c566a;
      card.set({
        key, name: spec ? tName(spec.nameKey) : id, cost: this.costText(bp.cost), status, statusColor, borderColor,
        selected: i === this.selectedIndex, staged, locked: !craftable,
        icon: spec && getWeaponTexture(spec.id, spec.kind),
      });
    });
    this.pageLabel.text = t('forge.pageLabel', { current: Math.floor(this.pageStart / PAGE_SIZE) + 1, total: pageCount(this.order.length, PAGE_SIZE) });

    // Store button: shown only where this build may sell AND there is something left to
    // buy (its caption goes with it).
    this.storeBtn.view.visible = this.storeEnabled && buyable.length > 0;
    const wide = forgeIsWide(w);
    this.renderCompareCard(m, compareCardW(wide));

    this.shell.layout(w, h, wide ? WIDE_SHEET_W : NARROW_SHEET_W, layoutForgeSheet(this.parts(), wide));
    this.view.visible = true;
  }

  /** The widgets `layoutForgeSheet` places. */
  private parts(): ForgeSheetParts {
    return {
      bank: this.bank, blueprintsHeading: this.blueprintsHeading, cards: this.rowCards,
      prevPageBtn: this.prevPageBtn, nextPageBtn: this.nextPageBtn, pageLabel: this.pageLabel,
      carryingHeading: this.carryingHeading, carryingText: this.carryingText,
      compareHeading: this.compareHeading, compareCard: this.compareCard,
      npc: this.npcSprite, npcTexture: getUiTexture('npc_forger'),
      storeCaption: this.storeCaption, storeBtn: this.storeBtn,
      hint: this.hint, rules: this.rules,
    };
  }

  /** design/10's loadout-detail decision: the browse cursor's blueprint vs whichever
   * loadout entry shares its weapon kind. The comparator is what the run would ACTUALLY
   * spawn carrying (`resolveLoadout`, ENGINE_VERSION 45) — so a half-crafted loadout
   * still diffs a melee candidate against the starter saber that would fill the free
   * slot, instead of hiding the card as if that slot were empty. Hidden only when there
   * genuinely is no same-kind comparator (a loadout holding two of the OTHER kind) —
   * nothing useful to diff against. */
  private renderCompareCard(m: MetaState, cardW: number): void {
    const candidateId = this.order[this.selectedIndex];
    const candidate = candidateId ? WEAPON_SPECS[BLUEPRINT_CATALOG[candidateId]!.weaponId] : undefined;
    const effectiveLoadout = resolveLoadout(m.loadout).map((w) => w.name);
    const equipped = candidate ? equippedSpecOfKind(effectiveLoadout, candidate.kind) : undefined;
    const rows = candidate && equipped ? buildCompareRows(equipped, candidate) : null;

    if (!candidate || !equipped || !rows) {
      this.compareCard.hide();
      return;
    }
    this.compareCard.set({
      w: cardW,
      leftName: t('forge.equippedHeader', { id: tName(equipped.nameKey) }),
      leftColor: RARITY_COLORS[RARITY_TIERS[equipped.rarity].colorKey],
      rightName: t('forge.candidateHeader', { id: tName(candidate.nameKey) }),
      rightColor: RARITY_COLORS[RARITY_TIERS[candidate.rarity].colorKey],
      rows,
    });
  }

  /** Per-frame: the backdrop's rocks, glow and motes. Driven from the main loop's
   *  `menuScreens`, and a no-op while this screen is hidden. */
  animate(dtMs: number): void {
    if (this.view.visible) this.panel.update(dtMs);
  }

  hide() {
    this.view.visible = false;
  }
}
