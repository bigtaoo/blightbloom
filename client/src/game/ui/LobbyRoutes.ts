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
// ## Five full-width rows, and the two-up row that was measured and rejected
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
// What found it was reading the label widths off a running page.
//
// So every route is full width, and the height came out of the header instead (`HEADER_H`)
// and out of a banner that now wraps wider before it wraps taller.
import { Container, Text } from 'pixi.js';
import { Button } from './widgets';
import { getUiTexture } from '../../render/uiSkins';
import { t } from '../../i18n';

/** The block's width — the same 280 every other stacked control in the menu uses. */
export const LOBBY_ROUTES_W = 280;
const GAP = 5;
const SOLO_H = 48;
/** CO-OP and PVP QUEUE: still a tier of their own, one step down from SOLO. */
const QUEUE_H = 44;
const ROW_H = 42;
/** What `MainMenu.show` reserves for this block. A constant rather than a measurement: every
 *  position in these screens is arithmetic on constants precisely so that laying one out
 *  needs no canvas and no `Text.height` (see `screens/fakeTextCanvas.ts`). */
export const LOBBY_ROUTES_H = SOLO_H + GAP + QUEUE_H + GAP + QUEUE_H + GAP + ROW_H + GAP + ROW_H;

/** The "go" green every primary action in this project uses, and its brighter border. */
const PRIMARY_FILL = 0x2f855a;
const PRIMARY_BORDER = 0x68d391;
const PLAIN_FILL = 0x2a3140;
const PLAIN_BORDER = 0x718096;

export class LobbyRoutes {
  readonly view = new Container();
  private soloBtn: Button;
  private coopBtn: Button;
  private pvpSoloBtn: Button;
  private squadBtn: Button;
  private tutorialBtn: Button;
  private recommendedTag: Text;
  private recommendTutorial = false;

  onSolo: (() => void) | null = null;
  onCoop: (() => void) | null = null;
  onPvpSolo: (() => void) | null = null;
  onSquad: (() => void) | null = null;
  onTutorial: (() => void) | null = null;

  constructor() {
    this.soloBtn = new Button(t('mainMenu.solo'), { w: LOBBY_ROUTES_W, h: SOLO_H, fontSize: 22, color: PRIMARY_FILL, borderColor: PRIMARY_BORDER });
    this.soloBtn.onTap = () => this.onSolo?.();
    this.soloBtn.setIcon(getUiTexture('icon_play'));

    this.coopBtn = new Button(t('mainMenu.coop'), { w: LOBBY_ROUTES_W, h: QUEUE_H, fontSize: 16, borderColor: PLAIN_BORDER });
    this.coopBtn.onTap = () => this.onCoop?.();
    this.coopBtn.setIcon(getUiTexture('icon_party_join'), 0x2c5282);

    this.pvpSoloBtn = new Button(t('mainMenu.pvpSolo'), { w: LOBBY_ROUTES_W, h: QUEUE_H, fontSize: 16, borderColor: PLAIN_BORDER });
    this.pvpSoloBtn.onTap = () => this.onPvpSolo?.();
    this.pvpSoloBtn.setIcon(getUiTexture('icon_squad'), 0x742a2a);

    this.squadBtn = new Button(t('mainMenu.squad'), { w: LOBBY_ROUTES_W, h: ROW_H, fontSize: 16, borderColor: PLAIN_BORDER });
    this.squadBtn.onTap = () => this.onSquad?.();
    this.squadBtn.setIcon(getUiTexture('icon_party_create'), 0x2c5282);

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
      this.soloBtn.view, this.coopBtn.view, this.pvpSoloBtn.view,
      this.squadBtn.view, this.tutorialBtn.view, this.recommendedTag,
    );
  }

  /** Call before `layout()` so the TUTORIAL badge reflects `!MetaState.hasSeenTutorial`. */
  setRecommendTutorial(recommend: boolean): void {
    this.recommendTutorial = recommend;
    this.recommendedTag.visible = recommend;
  }

  /**
   * Whether SOLO is the lobby's primary action.
   *
   * It is, everywhere except a game portal: there `MainMenu`'s own PLAY button sits above
   * this block and starts a run in one click (design/20), so SOLO — which goes to the forge
   * first — demotes to an ordinary route. Two green buttons on one card is the hierarchy
   * failure design/10 recorded on 2026-08-02, from a report that said clicks were landing on
   * the wrong page when in fact the routing was correct and the ranking was not.
   */
  setSoloPrimary(primary: boolean): void {
    this.soloBtn.setFill(primary ? PRIMARY_FILL : PLAIN_FILL);
    this.soloBtn.setBorder(primary ? PRIMARY_BORDER : PLAIN_BORDER);
  }

  /** Lay the block out with its top-left at (`cx` - half the width, `top`). */
  layout(cx: number, top: number): void {
    const left = cx - LOBBY_ROUTES_W / 2;
    this.soloBtn.view.position.set(left, top);
    const coopY = top + SOLO_H + GAP;
    this.coopBtn.view.position.set(left, coopY);
    const pvpY = coopY + QUEUE_H + GAP;
    this.pvpSoloBtn.view.position.set(left, pvpY);
    const squadY = pvpY + QUEUE_H + GAP;
    this.squadBtn.view.position.set(left, squadY);
    const tutorialY = squadY + ROW_H + GAP;
    this.tutorialBtn.view.position.set(left, tutorialY);
    // Inside the button's own right edge, not out past it: the badge sat to the RIGHT of the
    // row on `ModeSelect`, where the block was the widest thing on the screen. Here the card
    // is only 40px wider than the row, so an outside badge would have crossed its border.
    this.recommendedTag.position.set(left + LOBBY_ROUTES_W - 10, tutorialY + ROW_H / 2);
    this.recommendedTag.visible = this.recommendTutorial;
  }

  /** Re-apply every label from the active locale — `MainMenu.retext` calls this. */
  retext(): void {
    this.soloBtn.setText(t('mainMenu.solo'));
    this.coopBtn.setText(t('mainMenu.coop'));
    this.pvpSoloBtn.setText(t('mainMenu.pvpSolo'));
    this.squadBtn.setText(t('mainMenu.squad'));
    this.tutorialBtn.setText(t('mainMenu.tutorial'));
    this.recommendedTag.text = t('mainMenu.recommended');
  }
}
