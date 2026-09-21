import { Container, Sprite, Text } from 'pixi.js';
import {
  BLUEPRINT_CATALOG, DAMAGE_TYPES, PLAYER_BASE, WEAPON_SPECS, RARITY_TIERS,
  resolveLoadout, type WeaponBlueprint,
} from '@dd/engine';
import type { MetaState } from '../../meta';
import { bankTotal, canAfford, isUnlocked, kindAlreadyStaged, purchasableBlueprints } from '../../meta';
import { Panel, Button } from '../ui/widgets';
import { BlueprintCard } from '../ui/BlueprintCard';
import { CompareCard, buildCompareRows, equippedSpecOfKind } from '../ui/compareCard';
import { pageCount, pageStartForIndex, clampPageStart, wrapIndex } from '../ui/paging';
import { RARITY_COLORS } from '../theme';
import { getWeaponTexture } from '../../render/weaponSkins';
import { getUiTexture } from '../../render/uiSkins';
import { t, tName } from '../../i18n';
import { ELEMENT_SHORT_KEY, SOURCE_KEY } from '../../i18n/contentKeys';

/** Cards shown at once (`BLUEPRINT_CATALOG` has more entries than fit above the fixed
 * bottom action bar — a real overflow found while wiring up real Buttons, since the old
 * text board just let everything spill past the screen uncorrected). Paged, not
 * scrolled — simpler, and the existing arrow-key browse cursor already gives a
 * keyboard-only way to reach any entry (it flips pages to keep the cursor visible).
 * `GRID_COLS` fills PAGE_SIZE into a 4×2 icon-card grid (below), not a vertical list. */
const PAGE_SIZE = 8;
const GRID_COLS = 4;
const GRID_GAP_X = 14;
const GRID_GAP_Y = 14;
const GRID_ROWS = Math.ceil(PAGE_SIZE / GRID_COLS);
const GRID_W = GRID_COLS * BlueprintCard.W + (GRID_COLS - 1) * GRID_GAP_X;
const GRID_H = GRID_ROWS * BlueprintCard.H + (GRID_ROWS - 1) * GRID_GAP_Y;

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
 * Pure presentation: it reads a MetaState and renders it; all mutation goes through the
 * meta/forge transactions, driven via the `onX` callbacks below (same pattern as
 * PauseMenu.ts/Settings.ts) — the keyboard path (`ForgeInput`) drives the exact same
 * underlying methods as these cards, so both input paths stay in sync by construction
 * rather than by duplicated logic.
 */
export class Forge {
  readonly view = new Container();
  private panel = new Panel({ alpha: 0.82, background: 'hub' });
  private title: Text;
  private infoText: Text;
  private hint: Text;
  private pageLabel: Text;
  private backBtn: Button;
  private storeBtn: Button;
  private prevPageBtn: Button;
  private nextPageBtn: Button;
  /** Fixed pool of PAGE_SIZE icon cards, reused across pages (relabeled + shown/hidden
   * per render) rather than one card per catalog entry — keeps the widget count
   * bounded regardless of how many blueprints exist. Laid out as a `GRID_COLS`-wide
   * grid, not a vertical list (design/14 icon-card pass). */
  private rowCards: BlueprintCard[];
  private compareCard = new CompareCard();
  /** The forger NPC (design/13's "Outpost/hub" NPC gap) — decorative, corner-anchored
   * art, hidden until its texture is generated (uiSkins.ts's non-blocking preload) and
   * hidden again on any viewport too narrow to fit it beside the centered row column
   * without overlapping (mirrors renderCompareCard's own no-room-hide check below). */
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
    // `padding` guards against a real observed font-metrics clipping bug (see
    // widgets.ts's Button doc comment for the full explanation).
    this.title = new Text({ text: t('forge.title'), style: { fill: 0xf7fafc, fontSize: 30, fontWeight: 'bold', fontFamily: 'sans-serif', padding: 16 } });
    this.title.anchor.set(0.5, 0);
    // wordWrap: the buyable-blueprint list appended below (`Store (demo: free): ...`)
    // has no fixed length — without wrapping it was a real bug, running off both
    // edges of the screen as one unbroken line instead of staying inside the panel.
    // breakWords: defense-in-depth for CJK locales (design/17-i18n.md) — Pixi's
    // wordWrap only breaks at whitespace, so a translated line with no natural break
    // point would otherwise overflow instead of wrapping; today's actual copy is
    // already length-capped (see `buyableText` below) so this isn't a live bug, but
    // costs nothing to guard against a future longer translated line doing the same.
    this.infoText = new Text({ text: '', style: { fill: 0xcbd5e0, fontSize: 14, fontFamily: 'monospace', lineHeight: 20, align: 'center', padding: 24, wordWrap: true, wordWrapWidth: 760, breakWords: true } });
    this.infoText.anchor.set(0.5, 0);
    this.hint = new Text({ text: t('forge.hint'), style: { fill: 0x90cdf4, fontSize: 12, fontFamily: 'monospace', padding: 10 } });
    this.hint.anchor.set(0.5, 1);
    this.pageLabel = new Text({ text: '', style: { fill: 0x90cdf4, fontSize: 12, fontFamily: 'monospace', padding: 14 } });
    this.pageLabel.anchor.set(0.5);

    this.backBtn = new Button(t('forge.backButton'), { w: 90, h: 30, fontSize: 12, sound: 'ui.back' });
    this.backBtn.onTap = () => this.onBack?.();

    this.rowCards = Array.from({ length: PAGE_SIZE }, (_, slot) => {
      const c = new BlueprintCard();
      c.onTap = () => {
        const i = this.pageStart + slot;
        if (this.order[i] !== undefined) this.onCraftAt?.(i);
      };
      return c;
    });

    this.prevPageBtn = new Button(t('forge.pagePrevButton'), { w: 80, h: 26, fontSize: 11 });
    this.prevPageBtn.onTap = () => this.turnPage(-1);
    this.nextPageBtn = new Button(t('forge.pageNextButton'), { w: 80, h: 26, fontSize: 11 });
    this.nextPageBtn.onTap = () => this.turnPage(1);

    // Plain `ui.tap`, unlike the craft rows: opening a screen always does something, so
    // there is no outcome for a `silent` widget to wait on. The cues that DEPEND on a
    // transaction now live one screen further in, on the store's own rows.
    this.storeBtn = new Button(t('forge.storeButton'), { w: 160, h: 30, fontSize: 12 });
    this.storeBtn.onTap = () => this.onStore?.();

    this.npcSprite.anchor.set(0.5, 1);
    this.npcSprite.visible = false;

    this.view.addChild(
      this.panel.view, this.npcSprite, this.title, this.backBtn.view,
      this.infoText, this.storeBtn.view,
      ...this.rowCards.map((c) => c.view),
      this.prevPageBtn.view, this.pageLabel, this.nextPageBtn.view,
      this.compareCard.view,
      this.hint,
    );
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
    this.panel.layout(w, h);

    // Re-apply every label that isn't already rebuilt below on each call, so a
    // language change (design/17-i18n.md) takes effect next time the forge re-renders.
    this.title.text = t('forge.title');
    this.hint.text = t('forge.hint');
    this.backBtn.setText(t('forge.backButton'));
    this.prevPageBtn.setText(t('forge.pagePrevButton'));
    this.nextPageBtn.setText(t('forge.pageNextButton'));
    this.storeBtn.setText(t('forge.storeButton'));

    // Material bank — the five elemental kinds (design/14), summed across every rolled tier.
    const bank = DAMAGE_TYPES.map((e) => `${t(ELEMENT_SHORT_KEY[e])} ${bankTotal(m, e)}`).join('   ');

    // Empty board text names the ACTUAL default pair (resolveLoadout's fill-by-kind
    // rule, ENGINE_VERSION 45) instead of the old "(none → auto pistol)" — that string
    // outlived the behaviour it described, and it was the only place the forge told the
    // player what an empty loadout means.
    const loadout = m.loadout.length
      ? m.loadout.join(', ')
      : t('forge.noneStarterPair', { weapons: PLAYER_BASE.startWeapons.map((w) => tName(w.nameKey)).join(' + ') });
    const buyable = purchasableBlueprints(m);
    // Named only when short; past 3 it collapses to a bare count instead of trying to
    // fit a variable-length name list — `buyable` can list every unlocked-but-uncrafted
    // blueprint at once (a real bug: unbounded, it used to run off both edges of the
    // screen as one line). A length cap alone isn't enough of a guarantee here: this
    // codebase has already hit a real Pixi word-wrap measurement quirk in this exact
    // sandboxed environment (see widgets.ts's Button `padding` comment) where Pixi's
    // own width numbers under-report what the glyphs actually render at, so a fixed,
    // content-independent worst-case length is safer than trusting wordWrap to clip a
    // longer line to its declared width.
    const buyableText = buyable.length <= 3 ? buyable.join(', ') : t('forge.moreAvailable', { count: buyable.length });
    this.infoText.text =
      t('forge.materialsLine', { bank }) + '\n' +
      t('forge.loadoutLine', { loadout, count: m.loadout.length, max: PLAYER_BASE.weaponSlots }) +
      (buyable.length ? '\n' + t('forge.storeLine', { items: buyableText }) : '');

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
      const unlocked = isUnlocked(m, id);
      const staged = m.loadout.filter((x) => x === id).length;
      const affordable = canAfford(m, bp);
      // A blueprint whose weapon KIND is already staged cannot be crafted however much
      // material the bank holds (design/03/05's one-gun-and-one-melee invariant, gated in
      // `meta/forge.ts craft`). Say so on the card: without this the press just plays
      // `ui.denied` on an unlocked, affordable weapon, which reads as a lost input rather
      // than as a rule.
      const kindTaken = unlocked && kindAlreadyStaged(m, id);
      const status = !unlocked
        ? (bp.source === 'drop' ? t('forge.lockedFind') : t('forge.lockedSource', { source: t(SOURCE_KEY[bp.source]) }))
        : kindTaken ? t('forge.kindTaken')
        : affordable ? t('forge.craftable') : t('forge.needMaterials');
      const statusColor = !unlocked || kindTaken ? 0x718096 : affordable ? 0x68d391 : 0xf6ad55;
      const key = i < 9 ? `${i + 1}` : '·'; // only the first 9 have a digit-key shortcut
      const spec = WEAPON_SPECS[bp.weaponId];
      const borderColor = spec ? RARITY_COLORS[RARITY_TIERS[spec.rarity].colorKey] : 0x4c566a;
      card.set({
        key, name: spec ? tName(spec.nameKey) : id, cost: this.costText(bp.cost), status, statusColor, borderColor,
        selected: i === this.selectedIndex, staged, locked: !unlocked,
        icon: spec && getWeaponTexture(spec.id, spec.kind),
      });
    });
    this.pageLabel.text = t('forge.pageLabel', { current: Math.floor(this.pageStart / PAGE_SIZE) + 1, total: pageCount(this.order.length, PAGE_SIZE) });

    // Layout: title top, back button top-left corner, info block, paged blueprint rows
    // filling the middle, and a hint line pinned to the bottom. The hint is anchored to
    // `h` rather than flowed down from the grid above it — a flowed bottom row, merely
    // clamped once it overflowed, is what drew START RUN on top of the still-there weapon
    // cards on a landscape phone (the "screen is a mess" report; `viewportFit.test.ts`'s
    // header has the whole account). The compare card hides itself if there is no longer
    // room for it above that line, rather than overlapping it.
    const cx = w / 2;
    const halfGrid = GRID_W / 2;
    let y = Math.max(20, h * 0.05);
    this.title.position.set(cx, y);
    this.backBtn.view.position.set(16, 16);
    y += 44;
    this.infoText.style.wordWrapWidth = Math.min(760, w - 80);
    this.infoText.position.set(cx, y);
    y += this.infoText.height + 14;
    // Store button: shown only where this build may sell AND there is something left to
    // buy. Right-aligned with the grid below it — reserves its own row so it never
    // overlaps the first blueprint card.
    this.storeBtn.view.visible = this.storeEnabled && buyable.length > 0;
    if (this.storeBtn.view.visible) {
      this.storeBtn.view.position.set(cx + halfGrid - 160, y);
      y += 36;
    }
    // Blueprint grid — `GRID_COLS` cards per row, wrapping into `GRID_ROWS` (design/14
    // icon-card pass, replaces the old one-Button-per-row vertical list).
    this.rowCards.forEach((card, slot) => {
      const col = slot % GRID_COLS;
      const row = Math.floor(slot / GRID_COLS);
      card.view.position.set(
        cx - halfGrid + col * (BlueprintCard.W + GRID_GAP_X),
        y + row * (BlueprintCard.H + GRID_GAP_Y),
      );
    });
    y += GRID_H + 8;
    this.prevPageBtn.view.position.set(cx - halfGrid, y);
    this.pageLabel.position.set(cx, y + 13);
    this.nextPageBtn.view.position.set(cx + halfGrid - 80, y);
    y += 40;

    // The bottom of this screen is the hint line and nothing else since the START RUN bar
    // moved to `Loadout.ts` — but the reservation it used to make is still worth keeping,
    // because the compare card below flows down into whatever is left.
    const footerY = h - 34;
    this.hint.position.set(cx, h - 6);

    // Forger NPC — corner decoration, right of the centered blueprint grid. Only
    // shown once its art exists AND the viewport is wide enough to fit it without
    // overlapping the grid (same "hide if no room" shape as the compare card).
    const npcTex = getUiTexture('npc_forger');
    const npcRightMargin = w - (cx + 300);
    if (npcTex && npcRightMargin > 130) {
      this.npcSprite.texture = npcTex;
      const targetH = Math.min(220, h * 0.32);
      this.npcSprite.scale.set(targetH / npcTex.height);
      this.npcSprite.position.set(w - 24 - (npcTex.width * this.npcSprite.scale.x) / 2, footerY - 6);
      this.npcSprite.visible = true;
    } else {
      this.npcSprite.visible = false;
    }

    const cardShown = this.renderCompareCard(m, cx, y);
    // Measured against the hint line, which is the lowest thing this screen draws — a card
    // that no longer fits above it hides rather than overlapping it, the same "give way
    // instead of stacking" rule the action bar used to get.
    if (cardShown && y + this.compareCard.view.height + 16 > footerY) this.compareCard.hide();

    this.view.visible = true;
  }

  /** design/10's loadout-detail decision: the browse cursor's blueprint vs whichever
   * loadout entry shares its weapon kind. The comparator is what the run would ACTUALLY
   * spawn carrying (`resolveLoadout`, ENGINE_VERSION 45) — so a half-crafted loadout
   * still diffs a melee candidate against the starter saber that would fill the free
   * slot, instead of hiding the card as if that slot were empty. Hidden only when there
   * genuinely is no same-kind comparator (a loadout holding two of the OTHER kind) —
   * nothing useful to diff against. */
  private renderCompareCard(m: MetaState, cx: number, y: number): boolean {
    const candidateId = this.order[this.selectedIndex];
    const candidate = candidateId ? WEAPON_SPECS[BLUEPRINT_CATALOG[candidateId]!.weaponId] : undefined;
    const effectiveLoadout = resolveLoadout(m.loadout).map((w) => w.name);
    const equipped = candidate ? equippedSpecOfKind(effectiveLoadout, candidate.kind) : undefined;
    const rows = candidate && equipped ? buildCompareRows(equipped, candidate) : null;

    if (!candidate || !equipped || !rows) {
      this.compareCard.hide();
      return false;
    }
    this.compareCard.set({
      w: Math.min(420, cx * 2 - 48),
      leftName: t('forge.equippedHeader', { id: tName(equipped.nameKey) }),
      leftColor: RARITY_COLORS[RARITY_TIERS[equipped.rarity].colorKey],
      rightName: t('forge.candidateHeader', { id: tName(candidate.nameKey) }),
      rightColor: RARITY_COLORS[RARITY_TIERS[candidate.rarity].colorKey],
      rows,
    });
    this.compareCard.view.position.set(cx - this.compareCard.view.width / 2, y);
    return true;
  }

  hide() {
    this.view.visible = false;
  }
}
