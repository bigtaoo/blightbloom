import { Container, Sprite, Text } from 'pixi.js';
import { Panel, Button } from '../ui/widgets';
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
// leave this screen (mirroring `menuBtn`'s secondary exit) — deliberate, not
// incidental.
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

export class Screens {
  readonly view = new Container();
  private panel = new Panel({ alpha: 0.72, background: 'hub' });
  private title: Text;
  private sub: Text;
  private confirmBtn: Button;
  private menuBtn: Button;
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
  /** Win/loss badge above the title (`RunOutcome.ts`'s titles: EXTRACTED/VICTORY
   * ROYALE = win, DEFEAT/ELIMINATED = loss). Hidden until its art is generated
   * (uiSkins.ts's non-blocking preload) — a missing texture just means no badge. */
  private resultIcon = new Sprite();

  // Called when the player taps `confirmBtn` (start/restart — re-enters the loadout
  // screen to gear up for the next run).
  onConfirm: (() => void) | null = null;
  // Secondary exit — a smaller button, not the primary confirm action (design/10
  // decided result-screen content: confirm still re-enters the loadout screen; this
  // is for a player who wants to fully back out to the main menu instead).
  onMenu: (() => void) | null = null;

  constructor() {
    // `padding` guards against a real observed font-metrics clipping bug (widgets.ts's
    // Button has the full explanation) — these aren't Buttons, so it's set directly.
    this.title = new Text({
      text: '',
      style: { fill: 0xf7fafc, fontSize: 46, fontWeight: 'bold', fontFamily: 'sans-serif', padding: 16 },
    });
    // Multi-line stat rows (design/10 result-screen content) — `align:'center'` keeps
    // each row centered under the anchor, not just the block as a whole.
    this.sub = new Text({
      text: '',
      style: { fill: 0xcbd5e0, fontSize: 19, fontFamily: 'monospace', align: 'center', lineHeight: 26, padding: 26 },
    });
    this.title.anchor.set(0.5);
    this.sub.anchor.set(0.5);

    // Primary action — same green "go" styling as MainMenu's PLAY / ModeSelect's
    // SOLO / PartyScreen's START MATCHING (widgets.ts's established convention for
    // "the button this screen wants you to press").
    this.confirmBtn = new Button(t('results.confirmButton'), { w: 220, h: 44, fontSize: 17, color: 0x2f855a, borderColor: 0x68d391 });
    this.confirmBtn.onTap = () => this.onConfirm?.();
    this.menuBtn = new Button(t('results.mainMenuButton'), { w: 150, h: 32, fontSize: 13, sound: 'ui.back' });
    this.menuBtn.onTap = () => this.onMenu?.();
    // Amber, not the confirm green: this is an OPTIONAL extra, and a second green button
    // beside CONFIRM would read as the primary action on a screen whose primary action is
    // to move on (widgets.ts's "the button this screen wants you to press" convention).
    this.offerBtn = new Button('', { w: 240, h: 40, fontSize: 14, color: 0x975a16, borderColor: 0xf6ad55, autoWidth: true });
    this.offerBtn.onTap = () => void this.claim();
    this.offerBtn.view.visible = false;

    this.resultIcon.anchor.set(0.5);
    this.resultIcon.visible = false;

    this.view.addChild(this.panel.view, this.resultIcon, this.title, this.sub, this.offerBtn.view, this.confirmBtn.view, this.menuBtn.view);
    this.view.visible = false;
  }

  private layout(w: number, h: number) {
    // Remembered so `finishOffer` can re-run this without the viewport being handed back
    // to it: the offer settles from an ad callback, not from a frame, so there is no
    // caller there to ask (`resize` has one, which is why it takes them).
    this.lastW = w;
    this.lastH = h;
    this.panel.layout(w, h);
    const cx = w / 2;
    const cy = h / 2;
    this.resultIcon.position.set(cx, cy - 168);
    this.title.position.set(cx, cy - 120);
    this.sub.position.set(cx, cy);
    // The offer takes a row of its own between the stats and CONFIRM, pushing the two
    // exits down rather than squeezing in beside them: it is the one row a player has to
    // read before pressing the button they always press. With no offer every position
    // below is byte-identical to what this screen has always laid out — the whole shift
    // is `offset`, which is 0 then.
    const offset = this.offerBtn.view.visible ? 56 : 0;
    this.offerBtn.view.position.set(cx - this.offerBtn.width / 2, cy + 78);
    this.confirmBtn.view.position.set(cx - 110, cy + 92 + offset);
    this.menuBtn.view.position.set(cx - 75, cy + 152 + offset);
  }

  show(w: number, h: number, won: boolean, title: string, lines: readonly string[], offer: ResultOffer | null = null) {
    // Retext on show (design/17-i18n.md) so a language change takes effect next time
    // this screen opens, same convention as MainMenu.ts's `retext()`.
    this.confirmBtn.setText(t('results.confirmButton'));
    this.menuBtn.setText(t('results.mainMenuButton'));
    // The offer's label is already translated by whoever built it (it names the reward,
    // which is not this screen's knowledge) — so it is set, not re-derived, here.
    this.offer = offer;
    this.claiming = false;
    this.offerBtn.view.visible = offer !== null;
    if (offer) this.offerBtn.setText(offer.label);
    this.title.text = title;
    this.sub.text = lines.join('\n');
    const tex = getUiTexture(won ? 'icon_result_extract' : 'icon_result_wiped');
    if (tex) {
      this.resultIcon.texture = tex;
      const size = 64;
      this.resultIcon.scale.set(Math.min(size / tex.width, size / tex.height));
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

  hide() {
    this.view.visible = false;
  }

  /** Re-run the pure layout math against a new viewport size — call whenever the
   * caller's own screenSize() changes while this screen is up (window resize). */
  resize(w: number, h: number) {
    if (this.view.visible) this.layout(w, h);
  }
}
