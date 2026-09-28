// The lobby's ROUTES — the action column on the right of `MainMenu.ts` (design/10).
// The shell around this owns the backdrop, the hero, the logo, the corner chrome and the
// maintenance banner; everything that leads OUT of the lobby and into a mode lives here.
//
// ## Why this is its own file
//
// Composition rather than one longer screen, per CLAUDE.md's split order: the cross-boundary
// call list is one direction and short (`layout`, `retext`, `update`, `setContinue`,
// `setRecommendTutorial`, `setSoloPrimary`), which is what that rule means by countable.
//
// ## Three tiers, drawn as three different kinds of object (2026-09-27)
//
// The 2026-09-22 restructure split "start playing" from "prepare" with a 1px divider inside a
// stack of six same-looking rows, and the report that prompted this redesign was that it
// still did not read: the page looked empty and nothing on it was more important than
// anything else. Hierarchy is now carried by SIZE and MATERIAL, not by one fill colour and a
// hairline:
//
//  1. **The primary** — one painted banner card, the biggest thing in the column, with a
//     breathing glow: SOLO by default, CONTINUE RUN when there is a save (see
//     `applyHierarchy`). On a portal `MainMenu`'s own PLAY card takes this slot.
//  2. **The other two ways to play** — CO-OP and PVP SOLO QUEUE, smaller banner cards with
//     their own route colours (teal, coral), full width because `PVP SOLO QUEUE` runs to 187px
//     in Polish (the two-up version of this row was measured and rejected on 2026-09-10).
//  3. **Prepare** — SQUAD, FORGE and TUTORIAL as a dock of small icon-over-label buttons.
//
// When SOLO is not the primary it is still one of the ways to play, so it drops to a slim
// plain bar directly under the primary rather than disappearing — one widget in two sizes,
// so its tap target never changes identity (`LobbyCard.resize`).
//
// ## CONTINUE and SOLO stay two buttons
//
// A save does not re-point SOLO: two rows with two labels, one of which is the primary, is
// a different thing from one row that changes what it does — the latter is how a player loses
// a run they meant to keep (the rule that keeps SAVE & QUIT and QUIT apart in the pause menu).
//
// ## TUTORIAL hides once seen
//
// "Open it, or take it off the screen" (design/10), not dimmed; `screens/Settings.ts` holds a
// second door so the route never becomes unreachable. The dock re-divides its width between
// SQUAD and FORGE when it goes, so no hole is left where it was.
//
// ## FORGE's badge (2026-09-28)
//
// A count of the weapons the forge would craft right now (`meta/forge.ts craftableNow`), on
// the button's top-right corner, and nothing at zero. It replaced the five material counts
// that sat beside SETTINGS: the lobby only needs to say whether a trip to the forge is worth
// it, and a bank total cannot say that (a recipe's `minTier` and the staged kit decide it).
import { Container, Graphics, Text } from 'pixi.js';
import { Button } from './widgets';
import { LobbyCard } from './LobbyCard';
import { whenUiTexture } from '../../render/uiSkins';
import { TICK_RATE } from '@dd/engine';
import type { SavedRunSummary } from '../match/runSave';
import { t } from '../../i18n';

/** The column's width, in the lobby's own (unscaled) units. */
export const LOBBY_ROUTES_W = 272;
/** The primary banner card — also the size of `MainMenu`'s portal PLAY card. */
export const LOBBY_PRIMARY_H = 96;
/** SOLO when it is not the primary: a slim bar, one tier down. */
const SOLO_SLIM_H = 44;
/** CO-OP and PVP SOLO QUEUE. */
const SECONDARY_H = 62;
/** The dock's buttons: an icon over a short label. */
const DOCK_H = 56;
/** The gap between two items of one tier, and the wider gap between two tiers. */
export const LOBBY_GAP = 8;
const TIER_GAP = 14;
const DOCK_GAP = 8;

/** The block's height when SOLO is the primary (no save, not a portal). */
export const LOBBY_ROUTES_H = LOBBY_PRIMARY_H + TIER_GAP + SECONDARY_H + LOBBY_GAP + SECONDARY_H + TIER_GAP + DOCK_H;
/** The block's height when something above SOLO holds the primary — CONTINUE here, or
 *  `MainMenu`'s PLAY — and SOLO is the slim bar. Includes that primary's own slot. */
export const LOBBY_ROUTES_DEMOTED_H = LOBBY_PRIMARY_H + LOBBY_GAP + SOLO_SLIM_H + TIER_GAP + SECONDARY_H + LOBBY_GAP + SECONDARY_H + TIER_GAP + DOCK_H;

/** The "go" green every primary action in this project uses, and its brighter border. */
const PRIMARY_FILL = 0x2f855a;
const PRIMARY_FRAME = 0x9ae6b4;
const PLAIN_FILL = 0x2a3140;
const PLAIN_FRAME = 0x718096;
/** CO-OP's and PVP's route colours — the same teal/coral their banners were painted in. */
const COOP_FRAME = 0x4fd1c5;
const PVP_FRAME = 0xfc8181;
/** FORGE's badge: the green the forge itself paints a craftable card's status in. */
const BADGE_FILL = 0x68d391;
const BADGE_H = 20;

export class LobbyRoutes {
  readonly view = new Container();
  /** CONTINUE RUN — drawn only for a save `resumableRun.ts` says this build can rebuild. */
  private continueBtn: LobbyCard;
  private soloBtn: LobbyCard;
  private coopBtn: LobbyCard;
  private pvpSoloBtn: LobbyCard;
  private squadBtn: Button;
  /** The crafting page's lobby door (2026-09-21). */
  private forgeBtn: Button;
  private tutorialBtn: Button;
  private recommendedTag: Text;
  /** FORGE's "N craftable now" badge — see `setForgeReady`. */
  private forgeBadge = new Container();
  private forgeBadgeBg = new Graphics();
  private forgeBadgeText: Text;
  private forgeBadgeW = BADGE_H;
  /** Both "badge TUTORIAL as NEW HERE?" and "draw TUTORIAL at all". Defaults to `true`: the
   *  real caller (`ScreenFlow.showMenu`) always sets it before the first `show()`, and
   *  "always on screen" is the safer fallback for a test that skips it. */
  private recommendTutorial = true;
  /** The resumable save on offer, or null — kept so `retext()` can rebuild its hint. */
  private saved: SavedRunSummary | null = null;
  /** False on a game portal, where `MainMenu`'s own PLAY card holds the primary. */
  private ownsPrimary = true;

  onContinue: (() => void) | null = null;
  onSolo: (() => void) | null = null;
  onCoop: (() => void) | null = null;
  onPvpSolo: (() => void) | null = null;
  onSquad: (() => void) | null = null;
  onForge: (() => void) | null = null;
  onTutorial: (() => void) | null = null;

  constructor() {
    this.continueBtn = new LobbyCard(t('mainMenu.continueRun'), LOBBY_ROUTES_W, LOBBY_PRIMARY_H, { art: 'lobby_card_descend', fill: PRIMARY_FILL, frame: PRIMARY_FRAME, fontSize: 24, glow: true });
    this.continueBtn.onTap = () => this.onContinue?.();
    this.continueBtn.view.visible = false;

    this.soloBtn = new LobbyCard(t('mainMenu.solo'), LOBBY_ROUTES_W, LOBBY_PRIMARY_H, { art: 'lobby_card_descend', fill: PRIMARY_FILL, frame: PRIMARY_FRAME, fontSize: 26, glow: true });
    this.soloBtn.onTap = () => this.onSolo?.();

    this.coopBtn = new LobbyCard(t('mainMenu.coop'), LOBBY_ROUTES_W, SECONDARY_H, { art: 'lobby_card_coop', fill: 0x234e52, frame: COOP_FRAME, fontSize: 19 });
    this.coopBtn.onTap = () => this.onCoop?.();

    this.pvpSoloBtn = new LobbyCard(t('mainMenu.pvpSolo'), LOBBY_ROUTES_W, SECONDARY_H, { art: 'lobby_card_pvp', fill: 0x63171b, frame: PVP_FRAME, fontSize: 19 });
    this.pvpSoloBtn.onTap = () => this.onPvpSolo?.();

    // The dock: icon over label ('top' placement), because three labels up to nine
    // characters long do not fit beside a chip in a third of the column.
    const dockW = this.dockWidth(3);
    this.squadBtn = new Button(t('mainMenu.squad'), { w: dockW, h: DOCK_H, fontSize: 12, borderColor: PLAIN_FRAME });
    this.squadBtn.onTap = () => this.onSquad?.();
    whenUiTexture('icon_party_create', (tex) => this.squadBtn.setIcon(tex, undefined, 'top'));

    // The forger NPC's own art as the icon: it is the character this route leads to.
    this.forgeBtn = new Button(t('mainMenu.forge'), { w: dockW, h: DOCK_H, fontSize: 12, borderColor: PLAIN_FRAME });
    this.forgeBtn.onTap = () => this.onForge?.();
    whenUiTexture('npc_forger', (tex) => this.forgeBtn.setIcon(tex, undefined, 'top'));

    this.tutorialBtn = new Button(t('mainMenu.tutorial'), { w: dockW, h: DOCK_H, fontSize: 12, borderColor: 0xfbd38d });
    this.tutorialBtn.onTap = () => this.onTutorial?.();
    whenUiTexture('icon_account', (tex) => this.tutorialBtn.setIcon(tex, undefined, 'top'));

    // Never forced — the same "never required" convention `LoginScreen` follows. A tag on
    // the dock button's top edge rather than inside it: the button is too small to share.
    this.recommendedTag = new Text({ text: t('mainMenu.recommended'), style: { fill: 0x1a202c, fontSize: 10, fontFamily: 'monospace', fontWeight: 'bold', padding: 8, stroke: { color: 0xfbd38d, width: 5 } } });
    this.recommendedTag.anchor.set(0.5, 0.5);
    this.recommendedTag.visible = false;

    this.forgeBadgeText = new Text({ text: '', style: { fill: 0x1a202c, fontSize: 12, fontFamily: 'monospace', fontWeight: 'bold', padding: 8 } });
    this.forgeBadgeText.anchor.set(0.5, 0.5);
    this.forgeBadge.addChild(this.forgeBadgeBg, this.forgeBadgeText);
    this.forgeBadge.visible = false;

    this.view.addChild(
      this.continueBtn.view, this.soloBtn.view, this.coopBtn.view, this.pvpSoloBtn.view,
      this.squadBtn.view, this.forgeBtn.view, this.tutorialBtn.view, this.recommendedTag,
      this.forgeBadge,
    );
    this.applyHierarchy();
  }

  /**
   * Offer CONTINUE RUN for this save, or withdraw the offer with null.
   *
   * The caller passes `resumableRun.ts`'s answer, never `savedRunSummary()`'s: "a save
   * exists" and "a save this build can rebuild" are different questions, and only the second
   * one may draw a button.
   */
  setContinue(saved: SavedRunSummary | null): void {
    this.saved = saved;
    this.continueBtn.view.visible = saved !== null;
    this.retextContinue();
    this.applyHierarchy();
  }

  /** What this block occupies vertically — the primary's slot included when SOLO is demoted
   *  by something `MainMenu` draws above it (portal PLAY), so the shell can size the column
   *  the same way in every state. */
  get height(): number {
    return this.soloIsPrimary() ? LOBBY_ROUTES_H : LOBBY_ROUTES_DEMOTED_H;
  }

  /** Whether the TOP slot of this block is empty and owed to `MainMenu`'s PLAY card. */
  get reservesPrimarySlot(): boolean {
    return !this.soloIsPrimary() && this.saved === null;
  }

  /** Badge FORGE with how many weapons it can craft right now; none at zero (or at a count
   *  that is not a positive number — a badge reading `NaN` is worse than no badge). */
  setForgeReady(count: number): void {
    const n = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
    this.forgeBadge.visible = n > 0;
    if (n === 0) return;
    this.forgeBadgeText.text = n > 99 ? '99+' : String(n);
    const w = Math.max(BADGE_H, this.forgeBadgeText.width + 10);
    this.forgeBadgeW = w;
    this.forgeBadgeBg.clear()
      .roundRect(-w / 2, -BADGE_H / 2, w, BADGE_H, BADGE_H / 2).fill(BADGE_FILL)
      .stroke({ color: 0x1a202c, width: 2 });
  }

  setRecommendTutorial(recommend: boolean): void {
    this.recommendTutorial = recommend;
    this.recommendedTag.visible = recommend;
    this.tutorialBtn.view.visible = recommend;
  }

  /**
   * Whether this block owns the lobby's primary action at all — it does everywhere except a
   * game portal without a save, where `MainMenu`'s PLAY sits in the top slot and starts a run
   * in one click (design/20). Still named for SOLO because that is what every caller passes.
   */
  setSoloPrimary(primary: boolean): void {
    this.ownsPrimary = primary;
    this.applyHierarchy();
  }

  private soloIsPrimary(): boolean {
    return this.ownsPrimary && this.saved === null;
  }

  /**
   * Exactly one primary on the screen, and it is the topmost card that starts play: CONTINUE
   * with a save, SOLO without one, and neither on a portal (`MainMenu`'s PLAY). SOLO demoted
   * becomes the slim plain bar; CONTINUE never drops below the primary size, because the only
   * state that would demote it — a portal with a save — draws it as the primary instead.
   */
  private applyHierarchy(): void {
    const soloPrimary = this.soloIsPrimary();
    this.soloBtn.resize(LOBBY_ROUTES_W, soloPrimary ? LOBBY_PRIMARY_H : SOLO_SLIM_H);
    this.soloBtn.setArt(soloPrimary ? 'lobby_card_descend' : undefined);
    this.soloBtn.setFill(soloPrimary ? PRIMARY_FILL : PLAIN_FILL);
    this.soloBtn.setFrame(soloPrimary ? PRIMARY_FRAME : PLAIN_FRAME);
    this.soloBtn.setGlow(soloPrimary);
    this.retextSolo();
    const continuePrimary = this.ownsPrimary && this.saved !== null;
    this.continueBtn.setFill(continuePrimary ? PRIMARY_FILL : PLAIN_FILL);
    this.continueBtn.setFrame(continuePrimary ? PRIMARY_FRAME : PLAIN_FRAME);
    this.continueBtn.setGlow(continuePrimary);
  }

  private dockWidth(n: number): number {
    return (LOBBY_ROUTES_W - DOCK_GAP * (n - 1)) / n;
  }

  /** Lay the block out from its own top-left at (0, 0) — `MainMenu` positions and scales
   *  the column it sits in. */
  layout(): void {
    let y = 0;
    if (this.saved) {
      this.continueBtn.view.position.set(0, y);
      y += LOBBY_PRIMARY_H + LOBBY_GAP;
    } else if (!this.soloIsPrimary()) {
      // The portal's PLAY card is drawn here by the shell.
      y += LOBBY_PRIMARY_H + LOBBY_GAP;
    }
    this.soloBtn.view.position.set(0, y);
    y += this.soloBtn.height + TIER_GAP;
    this.coopBtn.view.position.set(0, y);
    y += SECONDARY_H + LOBBY_GAP;
    this.pvpSoloBtn.view.position.set(0, y);
    y += SECONDARY_H + TIER_GAP;

    // The dock: three across, or two across once TUTORIAL has been seen.
    const n = this.recommendTutorial ? 3 : 2;
    const dockW = this.dockWidth(n);
    const dock = [this.squadBtn, this.forgeBtn, this.tutorialBtn].slice(0, n);
    dock.forEach((b, i) => {
      b.setWidth(dockW);
      b.view.position.set(i * (dockW + DOCK_GAP), y);
    });
    // Positioned even when hidden, same as every invisible node in these screens. The badge
    // straddles FORGE's top-right corner, inset so it never pokes past the column's edge.
    this.forgeBadge.position.set(dockW + DOCK_GAP + dockW - this.forgeBadgeW / 2 - 2, y);
    this.tutorialBtn.view.visible = this.recommendTutorial;
    this.recommendedTag.position.set(2 * (dockW + DOCK_GAP) + dockW / 2, y);
    this.recommendedTag.visible = this.recommendTutorial;
  }

  /** Advance the primary card's glow, and any banner's fade-in. */
  update(dtMs: number): void {
    for (const card of this.cards()) card.update(dtMs);
  }

  /** Redraw any banner whose art has landed since it was drawn (`MainMenu`, as lobby art
   *  arrives). */
  refreshArt(): void {
    for (const card of this.cards()) card.refreshArt();
  }

  private cards(): LobbyCard[] {
    return [this.continueBtn, this.soloBtn, this.coopBtn, this.pvpSoloBtn];
  }

  /** CONTINUE's label and its floor/time hint, in the active locale. */
  private retextContinue(): void {
    this.continueBtn.setText(t('mainMenu.continueRun'));
    const saved = this.saved;
    // Same arithmetic and the same 1-based floor the Loadout screen's saved-run line uses, so
    // the two readouts of one save cannot disagree about which floor it is on.
    this.continueBtn.setHint(saved ? t('mainMenu.continueRunAt', {
      floor: saved.floorIndex + 1,
      m: Math.floor(saved.ticks / TICK_RATE / 60),
      ss: String(Math.floor(saved.ticks / TICK_RATE) % 60).padStart(2, '0'),
    }) : '');
  }

  /** SOLO's description only while it is the banner — the slim bar has no room for one. */
  private retextSolo(): void {
    this.soloBtn.setText(t('mainMenu.solo'));
    this.soloBtn.setHint(this.soloIsPrimary() ? t('mainMenu.soloHint') : '');
  }

  /** Re-apply every label from the active locale — `MainMenu.retext` calls this. */
  retext(): void {
    this.retextContinue();
    this.retextSolo();
    this.coopBtn.setText(t('mainMenu.coop'));
    this.coopBtn.setHint(t('mainMenu.coopHint'));
    this.pvpSoloBtn.setText(t('mainMenu.pvpSolo'));
    this.pvpSoloBtn.setHint(t('mainMenu.pvpHint'));
    this.squadBtn.setText(t('mainMenu.squad'));
    this.forgeBtn.setText(t('mainMenu.forge'));
    this.tutorialBtn.setText(t('mainMenu.tutorial'));
    this.recommendedTag.text = t('mainMenu.recommended');
  }
}
