import { Container, Graphics, Sprite, Text } from 'pixi.js';
import { Button } from '../ui/widgets';
import { MenuShell } from '../ui/MenuShell';
import type { LobbyBackdrop } from '../ui/LobbyBackdrop';
import { SHEET_PAD, SHEET_TITLE_H } from '../ui/MenuSheet';
import { MENU_BUTTONS, MENU_COLORS, menuText } from '../ui/menuTheme';
import { getUiTexture } from '../../render/uiSkins';
import { t } from '../../i18n';

// Render-side screen overlay: the menu / victory / defeat panels that wrap a run
// (design/10 screen flow). It is pure presentation — it reads nothing from the
// engine and only calls back `onConfirm` (start/restart) / `onMenu` (exit to the main
// menu). Lives in the fixed `ui` layer, on top of the HUD.
//
// Confirm is a single explicit button, not tap-anywhere-on-the-panel (changed
// ENGINE_VERSION-independent, render-only, 2026-08-17): a player report — "swarmed
// and killed almost instantly, then the screen just seemed to vanish" — traced to
// this screen accepting a pointerdown ANYWHERE on the panel, plus a raw fire-button
// rising edge (`confirmEdge.ts`, now deleted), as "confirm". A player who just died
// mid-fight is often still moving the mouse or holding fire from the fight itself,
// so the very first stray click/press after the swarm kill could dismiss this
// screen before it was even read — reading as "the level just exited on its own"
// even though a real confirm technically fired. `confirmBtn` is now the ONE way to
// leave this screen forward (MAIN MENU, the shell's corner chip, is the other exit) —
// deliberate, not incidental.
//
// Since the menu shell (design/10 "One shell for every menu", 2026-09-27) it is one framed
// sheet: the outcome as the sheet's title, tinted for a win or a loss; the badge; the stat
// lines in a field box; the optional offer; and CONFIRM across the sheet. MAIN MENU moved from
// a small button under CONFIRM to the shell's top-left chip — the corner every other screen
// leaves for the lobby from — which also takes it out from under the thumb that presses
// CONFIRM.
/**
 * An optional extra action on the results screen: today the rewarded-ad materials bonus
 * (`RunOutcome.ts`), which is why the reward itself is not modelled here. This screen knows
 * only that there is one button with a label, that pressing it runs something asynchronous,
 * and that what comes back are the stat lines to show afterwards.
 *
 * `claim` resolves with lines in BOTH outcomes — the reward's own lines when it landed, the
 * unchanged ones plus a note when it did not. A caller cannot signal "nothing happened" by
 * resolving nothing, on purpose: a player who pressed a button and watched nothing change
 * has no way to tell the offer from a broken button.
 */
export interface ResultOffer {
  label: string;
  claim: () => Promise<readonly string[]>;
}

/** The sheet's width and content width; the rows' heights and the gap between them. */
const SHEET_W = 440;
const CONTENT_W = SHEET_W - SHEET_PAD * 2;
const BADGE = 64;
const BOX_PAD = 14;
const OFFER_H = 40;
const CONFIRM_H = 48;
const GAP = 14;

export class Screens {
  readonly view = new Container();
  private readonly shell: MenuShell;
  /** The dimmed lobby painting. Named `panel` for `menuCoversWorld.test.ts`. */
  private readonly panel: LobbyBackdrop;
  /** The stat lines' field box. */
  private readonly box = new Graphics();
  private sub: Text;
  private confirmBtn: Button;
  /** The optional offer button (see `ResultOffer`). Hidden unless `show` is handed one,
   *  which is every build without a rewarded ad installed and every result that has
   *  nothing to offer. `autoWidth` because its label is translated and the longest
   *  locale's string decides the box. */
  private offerBtn: Button;
  /** The offer currently on screen, or `null`. Held so the tap handler wired once at
   *  construction reaches whatever the latest `show` was handed. */
  private offer: ResultOffer | null = null;
  /** True from the tap until `claim` settles. The button is one-shot — an offer can be
   *  taken once — so this guards the window in between, where the button is still on
   *  screen and a second tap would run the whole claim again. */
  private claiming = false;
  /** The viewport the last `layout` ran against — see its own note. */
  private lastW = 0;
  private lastH = 0;
  /** Win/loss badge at the top of the sheet (`RunOutcome.ts`'s titles: EXTRACTED/VICTORY
   * ROYALE = win, DEFEAT/ELIMINATED = loss). Hidden until its art is generated
   * (uiSkins.ts's non-blocking preload) — a missing texture just means no badge, and the
   * rows close up over the room it would have taken. */
  private resultIcon = new Sprite();

  // Called when the player taps `confirmBtn` (start/restart — re-enters the loadout
  // screen to gear up for the next run).
  onConfirm: (() => void) | null = null;
  // Secondary exit — the shell's corner chip, not the primary confirm action (design/10
  // decided result-screen content: confirm still re-enters the loadout screen; this
  // is for a player who wants to fully back out to the main menu instead).
  onMenu: (() => void) | null = null;

  constructor() {
    this.shell = new MenuShell({ title: '', back: t('results.mainMenuButton') });
    this.shell.onBack = () => this.onMenu?.();
    this.panel = this.shell.backdrop;
    // Multi-line stat rows (design/10 result-screen content) — `align:'center'` keeps
    // each row centered under the anchor, not just the block as a whole.
    this.sub = new Text({
      text: '',
      style: menuText('value', { fill: MENU_COLORS.textSoft, align: 'center', lineHeight: 26, wordWrap: true, breakWords: true, wordWrapWidth: CONTENT_W - BOX_PAD * 2 }),
    });
    this.sub.anchor.set(0.5, 0);

    // Primary action — the shell's go-green (`MENU_BUTTONS.primary`), "the button this
    // screen wants you to press".
    this.confirmBtn = new Button(t('results.confirmButton'), { w: CONTENT_W, h: CONFIRM_H, fontSize: 17, ...MENU_BUTTONS.primary });
    this.confirmBtn.onTap = () => this.onConfirm?.();
    // Amber, not the confirm green: this is an OPTIONAL extra, and a second green button
    // beside CONFIRM would read as the primary action on a screen whose primary action is
    // to move on.
    this.offerBtn = new Button('', { w: CONTENT_W, h: OFFER_H, fontSize: 14, color: 0x975a16, borderColor: 0xf6ad55, autoWidth: true });
    this.offerBtn.onTap = () => void this.claim();
    this.offerBtn.view.visible = false;

    this.resultIcon.anchor.set(0.5, 0);
    this.resultIcon.visible = false;

    this.shell.content.addChild(this.box, this.resultIcon, this.sub, this.offerBtn.view, this.confirmBtn.view);
    this.shell.mount(this.view);
    this.view.visible = false;
  }

  /** Flow the sheet top to bottom and return the content's height. Every row but CONFIRM
   *  can be absent — the badge before its art loads, the offer on most results — and the
   *  rows close up rather than leave a hole. */
  private flow(): number {
    const cx = CONTENT_W / 2;
    let y = 0;
    this.resultIcon.position.set(cx, y);
    if (this.resultIcon.visible) y += BADGE + GAP;
    const boxH = this.sub.height + BOX_PAD * 2;
    this.box.clear()
      .roundRect(0, y, CONTENT_W, boxH, 10).fill({ color: MENU_COLORS.field, alpha: 0.9 })
      .roundRect(0.5, y + 0.5, CONTENT_W - 1, boxH - 1, 10).stroke({ color: MENU_COLORS.fieldBorder, width: 1 });
    this.sub.position.set(cx, y + BOX_PAD);
    y += boxH + GAP + 4;
    // The offer takes a row of its own between the stats and CONFIRM, pushing CONFIRM down
    // rather than squeezing in beside it: it is the one row a player has to read before
    // pressing the button they always press.
    this.offerBtn.view.position.set(cx - this.offerBtn.width / 2, y);
    if (this.offerBtn.view.visible) y += OFFER_H + GAP;
    this.confirmBtn.view.position.set(0, y);
    return y + CONFIRM_H;
  }

  private layout(w: number, h: number) {
    // Remembered so `finishOffer` can re-run this without the viewport being handed back
    // to it: the offer settles from an ad callback, not from a frame, so there is no
    // caller there to ask (`resize` has one, which is why it takes them).
    this.lastW = w;
    this.lastH = h;
    this.shell.layout(w, h, SHEET_W, SHEET_TITLE_H + 18 + this.flow() + SHEET_PAD);
  }

  show(w: number, h: number, won: boolean, title: string, lines: readonly string[], offer: ResultOffer | null = null) {
    // Retext on show (design/17-i18n.md) so a language change takes effect next time
    // this screen opens, same convention as MainMenu.ts's `retext()`.
    this.confirmBtn.setText(t('results.confirmButton'));
    this.shell.setBack(t('results.mainMenuButton'));
    // The offer's label is already translated by whoever built it (it names the reward,
    // which is not this screen's knowledge) — so it is set, not re-derived, here.
    this.offer = offer;
    this.claiming = false;
    this.offerBtn.view.visible = offer !== null;
    if (offer) this.offerBtn.setText(offer.label);
    // The copy is the caller's; the tint is the one thing `won` decides here.
    this.shell.sheet.title.style.fill = won ? MENU_COLORS.success : MENU_COLORS.error;
    this.shell.setTitle(title);
    this.sub.text = lines.join('\n');
    const tex = getUiTexture(won ? 'icon_result_extract' : 'icon_result_wiped');
    if (tex) {
      this.resultIcon.texture = tex;
      this.resultIcon.scale.set(Math.min(BADGE / tex.width, BADGE / tex.height));
      this.resultIcon.visible = true;
    } else {
      this.resultIcon.visible = false;
    }
    this.layout(w, h);
    this.view.visible = true;
  }

  /**
   * Run the offer. Public for the same reason `Button.onTap` handlers usually are not:
   * this is the one path a test can drive without a real pointer event, and the sequence
   * it guarantees is worth pinning — the button leaves the screen BEFORE the lines change,
   * and it leaves it whatever `claim` resolves with.
   *
   * A rejection is caught and treated as "nothing changed". `RewardedAd.show` is
   * documented never to throw and `AdController` honours that in a `finally`, so this is
   * the belt to that braces: the failure it guards is not a missing ad, it is a results
   * screen stuck behind a dead button with the player's own numbers still on it.
   */
  async claim(): Promise<void> {
    const offer = this.offer;
    if (offer === null || this.claiming) return;
    this.claiming = true;
    try {
      const lines = await offer.claim();
      this.finishOffer(lines);
    } catch {
      this.finishOffer(null);
    }
  }

  /** One-shot teardown of the offer row: the button goes, the layout closes the gap it
   *  left, and the stats are replaced if the claim produced new ones. */
  private finishOffer(lines: readonly string[] | null) {
    this.offer = null;
    this.claiming = false;
    this.offerBtn.view.visible = false;
    if (lines) this.sub.text = lines.join('\n');
    if (this.view.visible) this.layout(this.lastW, this.lastH);
  }

  /** Per-frame: the backdrop's rocks, glow and motes. Driven from the main loop's
   *  `menuScreens`, and a no-op while this screen is hidden. */
  animate(dtMs: number): void {
    if (this.view.visible) this.panel.update(dtMs);
  }

  hide() {
    this.view.visible = false;
  }

  /** Re-run the pure layout math against a new viewport size — call whenever the
   * caller's own screenSize() changes while this screen is up (window resize). */
  resize(w: number, h: number) {
    if (this.view.visible) this.layout(w, h);
  }
}
