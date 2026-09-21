// The lobby's ROUTES — one of the two halves of `MainMenu.ts` (design/10, 2026-09-10).
// The shell around this owns the title, the maintenance banner, the account chip and
// SETTINGS; everything that leads OUT of the lobby and into a mode lives here.
//
// ## Why this is its own file
//
// The 2026-09-10 merge folded `ModeSelect.ts`'s four routes into the menu, and the menu was
// already 303 lines. Composition rather than one longer screen, per CLAUDE.md's split order:
// the cross-boundary call list is exactly one direction and four calls (`layout`, `retext`,
// `setRecommendTutorial`, `setSoloPrimary`), which is what that rule means by countable.
//
// ## Five rows — six with a saved run (2026-09-17)
//
// CONTINUE RUN joined the top of the stack when the lobby was audited as a front door
// (design/10): the row is drawn only for a save `match/resumableRun.ts` says this build can
// actually rebuild, so the front door either says nothing about a saved run or offers one
// that works. It takes the green from SOLO when it is there — see `applyHierarchy` for the
// ladder and for the portal case, where it takes nothing.
//
// ## Four full-width rows, one two-up row, and the two-up row that was measured and rejected
//
// The first version put CO-OP and PVP QUEUE side by side at half width, to buy back the
// vertical space five stacked rows cost against the portal layout's budget (`MainMenu.show`).
// It looked right in English at a glance and it was wrong: measured live, `PVP SOLO QUEUE`
// draws 115 px of label starting 54 px in — past the right edge of a 135 px button — and the
// same holds in **seven of the eight locales** (Polish `KOLEJKA PVP SOLO` runs to 187 px,
// Russian to 186; only Chinese fits). CO-OP overflowed too, in Spanish and Polish.
//
// Worth recording HOW that got past the tests, because the same hole is still open for the
// next screen: `viewportFit.test.ts` sweeps all eight locales, and it passed. It asserts that
// nothing lands outside the design space — a label spilling out of its own button into the
// gap beside it is still comfortably inside the screen. Its own header says to read it as
// "nothing is off screen", never as "nothing collides", and this is that sentence collecting.
// What found it was reading the label widths off a running page. `screens/labelFit.test.ts`
// exists because of it, and it is what makes the two-up row below checkable rather than a
// second guess.
//
// So CO-OP and PVP QUEUE are full width, and the height came out of the header instead
// (`HEADER_H`) and out of a banner that now wraps wider before it wraps taller.
//
// ## Why SQUAD and FORGE share a row (2026-09-21)
//
// FORGE is a sixth route: the crafting page has its own screen now (`screens/Forge.ts`) and
// the lobby is its front door, beside the loadout screen that SOLO opens. A sixth FULL-WIDTH
// row would not have fitted — the tallest legal lobby (a portal build's quick-play row and
// data notice, the longest maintenance banner, and a resumable save) already measures 630 of
// a 640-px design height in all eight locales, so there was 10 px to spend and a row costs
// 47. What makes the pair safe where CO-OP/PVP QUEUE was not is the labels: the longest of
// the eight is 8 characters (`SCHMIEDE`, `ESCOUADE`) against a budget of ~87 px, where
// `PVP SOLO QUEUE` needed 169. `labelFit.test.ts` checks that claim in every locale rather
// than leaving it as arithmetic in a comment.
import { Container, Text } from 'pixi.js';
import { Button } from './widgets';
import { getUiTexture } from '../../render/uiSkins';
import { TICK_RATE } from '@dd/engine';
import type { SavedRunSummary } from '../match/runSave';
import { t } from '../../i18n';

/** The block's width — the same 280 every other stacked control in the menu uses. */
export const LOBBY_ROUTES_W = 280;
const GAP = 5;
/** The gap between the two halves of the SQUAD/FORGE row, and each half's width. */
const PAIR_GAP = 6;
const PAIR_W = (LOBBY_ROUTES_W - PAIR_GAP) / 2;
const SOLO_H = 48;
/** CONTINUE RUN, when there is one: SOLO's own height, because it is the same tier of
 *  action — "start playing" — and the one the returning player came for. */
const CONTINUE_H = 48;
/** The caption under CONTINUE (floor + elapsed) plus the gap above it. A `Text`, not a
 *  button, so it is not a second tap target competing with the row it describes. */
const CONTINUE_CAPTION_H = 18;
/** CO-OP and PVP QUEUE: still a tier of their own, one step down from SOLO. */
const QUEUE_H = 44;
const ROW_H = 42;
/** What `MainMenu.show` reserves for this block WITHOUT a resumable run. A constant rather
 *  than a measurement: every position in these screens is arithmetic on constants precisely
 *  so that laying one out needs no canvas and no `Text.height` (see
 *  `screens/fakeTextCanvas.ts`). The saved-run row adds to it — see `height`. */
export const LOBBY_ROUTES_H = SOLO_H + GAP + QUEUE_H + GAP + QUEUE_H + GAP + ROW_H + GAP + ROW_H;
/** What the CONTINUE row and its caption add when one is offered. */
export const LOBBY_CONTINUE_H = CONTINUE_H + CONTINUE_CAPTION_H + GAP;

/** The "go" green every primary action in this project uses, and its brighter border. */
const PRIMARY_FILL = 0x2f855a;
const PRIMARY_BORDER = 0x68d391;
const PLAIN_FILL = 0x2a3140;
const PLAIN_BORDER = 0x718096;

export class LobbyRoutes {
  readonly view = new Container();
  /** CONTINUE RUN — drawn only for a save `resumableRun.ts` says this build can rebuild. */
  private continueBtn: Button;
  private continueCaption: Text;
  private soloBtn: Button;
  private coopBtn: Button;
  private pvpSoloBtn: Button;
  private squadBtn: Button;
  /** The crafting page's lobby door (2026-09-21) — half a row, beside SQUAD. */
  private forgeBtn: Button;
  private tutorialBtn: Button;
  private recommendedTag: Text;
  private recommendTutorial = false;
  /** The resumable save this block is currently offering, or null. Kept so `retext()` can
   *  rebuild the caption in the new locale without the caller re-supplying it. */
  private saved: SavedRunSummary | null = null;
  /** False on a game portal, where `MainMenu`'s own PLAY button holds the green — see
   *  `setSoloPrimary` and `applyHierarchy`. */
  private ownsPrimary = true;

  onContinue: (() => void) | null = null;
  onSolo: (() => void) | null = null;
  onCoop: (() => void) | null = null;
  onPvpSolo: (() => void) | null = null;
  onSquad: (() => void) | null = null;
  onForge: (() => void) | null = null;
  onTutorial: (() => void) | null = null;

  constructor() {
    // Hidden until `setContinue` is handed a save, and hidden again the moment it is handed
    // null: the whole point of routing this through `checkResumable` is that a row which is
    // on screen can always be walked through.
    this.continueBtn = new Button(t('mainMenu.continueRun'), { w: LOBBY_ROUTES_W, h: CONTINUE_H, fontSize: 22, color: PRIMARY_FILL, borderColor: PRIMARY_BORDER });
    this.continueBtn.onTap = () => this.onContinue?.();
    this.continueBtn.setIcon(getUiTexture('icon_play'));
    this.continueBtn.view.visible = false;
    // Which run, in one line. A bare CONTINUE tells a player who has been away a week that
    // SOMETHING is saved, which is the half of the report this row exists for; the floor and
    // the elapsed time are the other half. Deliberately NOT in the button's own label: the
    // one measured version of that ran 316px of Russian into a 280px button (design/10,
    // 2026-09-17), and this caption is mostly digits in every locale.
    this.continueCaption = new Text({ text: '', style: { fill: 0x9ae6b4, fontSize: 11, fontFamily: 'monospace', padding: 10 } });
    this.continueCaption.anchor.set(0.5, 0);
    this.continueCaption.visible = false;

    this.soloBtn = new Button(t('mainMenu.solo'), { w: LOBBY_ROUTES_W, h: SOLO_H, fontSize: 22, color: PRIMARY_FILL, borderColor: PRIMARY_BORDER });
    this.soloBtn.onTap = () => this.onSolo?.();
    this.soloBtn.setIcon(getUiTexture('icon_play'));

    this.coopBtn = new Button(t('mainMenu.coop'), { w: LOBBY_ROUTES_W, h: QUEUE_H, fontSize: 16, borderColor: PLAIN_BORDER });
    this.coopBtn.onTap = () => this.onCoop?.();
    this.coopBtn.setIcon(getUiTexture('icon_party_join'), 0x2c5282);

    this.pvpSoloBtn = new Button(t('mainMenu.pvpSolo'), { w: LOBBY_ROUTES_W, h: QUEUE_H, fontSize: 16, borderColor: PLAIN_BORDER });
    this.pvpSoloBtn.onTap = () => this.onPvpSolo?.();
    this.pvpSoloBtn.setIcon(getUiTexture('icon_squad'), 0x742a2a);

    this.squadBtn = new Button(t('mainMenu.squad'), { w: PAIR_W, h: ROW_H, fontSize: 16, borderColor: PLAIN_BORDER });
    this.squadBtn.onTap = () => this.onSquad?.();
    this.squadBtn.setIcon(getUiTexture('icon_party_create'), 0x2c5282);

    // The forger NPC's own art as the chip, rather than a new icon nobody has drawn yet:
    // it is the character this route leads to, and the forge screen already shows him.
    this.forgeBtn = new Button(t('mainMenu.forge'), { w: PAIR_W, h: ROW_H, fontSize: 16, borderColor: PLAIN_BORDER });
    this.forgeBtn.onTap = () => this.onForge?.();
    this.forgeBtn.setIcon(getUiTexture('npc_forger'), 0x744210);

    this.tutorialBtn = new Button(t('mainMenu.tutorial'), { w: LOBBY_ROUTES_W, h: ROW_H, fontSize: 16, borderColor: PLAIN_BORDER });
    this.tutorialBtn.onTap = () => this.onTutorial?.();
    this.tutorialBtn.setIcon(getUiTexture('icon_account'), 0x6b46c1);

    // Never forced — the same "never required" convention `LoginScreen` follows, and the
    // badge `ModeSelect` carried before the merge. Hidden the moment the player has completed
    // OR skipped the tutorial once (`MetaState.hasSeenTutorial`).
    this.recommendedTag = new Text({ text: t('mainMenu.recommended'), style: { fill: 0xfbd38d, fontSize: 11, fontFamily: 'monospace', fontWeight: 'bold', padding: 10 } });
    this.recommendedTag.anchor.set(1, 0.5);
    this.recommendedTag.visible = false;

    this.view.addChild(
      this.continueBtn.view, this.continueCaption,
      this.soloBtn.view, this.coopBtn.view, this.pvpSoloBtn.view,
      this.squadBtn.view, this.forgeBtn.view, this.tutorialBtn.view, this.recommendedTag,
    );
  }

  /**
   * Offer CONTINUE RUN for this save, or withdraw the offer with null.
   *
   * The caller passes `resumableRun.ts`'s answer, never `savedRunSummary()`'s: "a save
   * exists" and "a save this build can rebuild" are different questions, and only the second
   * one may draw a button (that module's header has what the first one shipped).
   */
  setContinue(saved: SavedRunSummary | null): void {
    this.saved = saved;
    this.continueBtn.view.visible = saved !== null;
    this.continueCaption.visible = saved !== null;
    this.retextContinue();
    this.applyHierarchy();
  }

  /** What this block occupies vertically, which is state-dependent since 2026-09-17 —
   *  `MainMenu.show` sizes the card off this rather than off `LOBBY_ROUTES_H` alone. */
  get height(): number {
    return LOBBY_ROUTES_H + (this.saved ? LOBBY_CONTINUE_H : 0);
  }

  /** Call before `layout()` so the TUTORIAL badge reflects `!MetaState.hasSeenTutorial`. */
  setRecommendTutorial(recommend: boolean): void {
    this.recommendTutorial = recommend;
    this.recommendedTag.visible = recommend;
  }

  /**
   * Whether this block owns the lobby's primary action at all.
   *
   * It does, everywhere except a game portal: there `MainMenu`'s own PLAY button sits above
   * this block and starts a run in one click (design/20), so every row here — including
   * CONTINUE — demotes to an ordinary route. Two green buttons on one card is the hierarchy
   * failure design/10 recorded on 2026-08-02, from a report that said clicks were landing on
   * the wrong page when in fact the routing was correct and the ranking was not.
   *
   * Still named for SOLO because that is what `MainMenu.setQuickPlay` is deciding and what
   * every existing caller passes; WHICH of this block's rows takes the green when it does own
   * one is `applyHierarchy`'s business, not the caller's.
   */
  setSoloPrimary(primary: boolean): void {
    this.ownsPrimary = primary;
    this.applyHierarchy();
  }

  /**
   * Exactly one green button on the card, and it is the topmost row that starts play.
   *
   * With a resumable save that is CONTINUE, and SOLO — which goes to the forge first — steps
   * down beside CO-OP. On a portal it is neither: `MainMenu`'s PLAY holds the green, because
   * the platform's one-click-to-gameplay requirement is about the button a first-time visitor
   * lands on and a saved run is by definition not a first visit.
   *
   * What this deliberately does NOT do is re-point PLAY at the resume when a save exists.
   * One button whose meaning depends on the state is how a player loses a run they meant to
   * keep — the same rule that keeps SAVE & QUIT and QUIT as two rows in the pause menu
   * (design/10's HUD table) rather than one that changes its mind.
   */
  private applyHierarchy(): void {
    const continuePrimary = this.ownsPrimary && this.saved !== null;
    const soloPrimary = this.ownsPrimary && this.saved === null;
    this.continueBtn.setFill(continuePrimary ? PRIMARY_FILL : PLAIN_FILL);
    this.continueBtn.setBorder(continuePrimary ? PRIMARY_BORDER : PLAIN_BORDER);
    this.soloBtn.setFill(soloPrimary ? PRIMARY_FILL : PLAIN_FILL);
    this.soloBtn.setBorder(soloPrimary ? PRIMARY_BORDER : PLAIN_BORDER);
  }

  /** Lay the block out with its top-left at (`cx` - half the width, `top`). */
  layout(cx: number, top: number): void {
    const left = cx - LOBBY_ROUTES_W / 2;
    // CONTINUE sits ABOVE SOLO, and the rows below simply start lower when it is there —
    // no row shares a slot with another, so a tap aimed at SOLO on a save-less lobby can
    // never land on CONTINUE on a saved one (the `PauseMenu`'s SAVE & QUIT rule, one screen
    // out). The caption hangs in the gap the row's own block reserves for it.
    let y = top;
    if (this.saved) {
      this.continueBtn.view.position.set(left, y);
      this.continueCaption.position.set(cx, y + CONTINUE_H + 2);
      y += LOBBY_CONTINUE_H;
    }
    const soloY = y;
    this.soloBtn.view.position.set(left, soloY);
    const coopY = soloY + SOLO_H + GAP;
    this.coopBtn.view.position.set(left, coopY);
    const pvpY = coopY + QUEUE_H + GAP;
    this.pvpSoloBtn.view.position.set(left, pvpY);
    const squadY = pvpY + QUEUE_H + GAP;
    this.squadBtn.view.position.set(left, squadY);
    this.forgeBtn.view.position.set(left + PAIR_W + PAIR_GAP, squadY);
    const tutorialY = squadY + ROW_H + GAP;
    this.tutorialBtn.view.position.set(left, tutorialY);
    // Inside the button's own right edge, not out past it: the badge sat to the RIGHT of the
    // row on `ModeSelect`, where the block was the widest thing on the screen. Here the card
    // is only 40px wider than the row, so an outside badge would have crossed its border.
    this.recommendedTag.position.set(left + LOBBY_ROUTES_W - 10, tutorialY + ROW_H / 2);
    this.recommendedTag.visible = this.recommendTutorial;
  }

  /** The CONTINUE row's label and caption, in the active locale. Split out of `retext` so
   *  `setContinue` can refresh the caption without re-applying five other labels. */
  private retextContinue(): void {
    this.continueBtn.setText(t('mainMenu.continueRun'));
    const saved = this.saved;
    if (!saved) {
      this.continueCaption.text = '';
      return;
    }
    // Same arithmetic and the same 1-based floor the Forge's own saved-run line uses
    // (`Forge.render`), so the two readouts of one save cannot disagree about which floor it
    // is on.
    this.continueCaption.text = t('mainMenu.continueRunAt', {
      floor: saved.floorIndex + 1,
      m: Math.floor(saved.ticks / TICK_RATE / 60),
      ss: String(Math.floor(saved.ticks / TICK_RATE) % 60).padStart(2, '0'),
    });
  }

  /** Re-apply every label from the active locale — `MainMenu.retext` calls this. */
  retext(): void {
    this.retextContinue();
    this.soloBtn.setText(t('mainMenu.solo'));
    this.coopBtn.setText(t('mainMenu.coop'));
    this.pvpSoloBtn.setText(t('mainMenu.pvpSolo'));
    this.squadBtn.setText(t('mainMenu.squad'));
    this.forgeBtn.setText(t('mainMenu.forge'));
    this.tutorialBtn.setText(t('mainMenu.tutorial'));
    this.recommendedTag.text = t('mainMenu.recommended');
  }
}
