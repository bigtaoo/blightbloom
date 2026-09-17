import { Container, Rectangle, Text } from 'pixi.js';
import { Panel, Button } from './widgets';
import { t } from '../../i18n';
import type { GuestMergeOffer } from '../../meta/guestMerge';

/**
 * The account layer's two modal answers (design/16-accounts.md holes 1 and 2, 2026-09-17):
 * the one-time guest-merge confirmation, and the "your session expired" notice.
 *
 * ## Why a floating overlay and not a screen
 *
 * Both of these arrive during `OnlineMatch.syncMetaWithSession`, which only ever runs in a
 * hub phase — the lobby or the Forge. A full screen would have to be threaded through
 * `phase`, `ScreenFlow`'s ten hide-everything-else methods and `ScreenNav`, and would then
 * REPLACE the screen the player was already on in order to ask a question about it. This is
 * mounted in `MenuLayer.mount`'s floating slot instead, above every screen, exactly where the
 * Forge's SETTINGS button already lives.
 *
 * ## Why the session notice is not a toast
 *
 * `HudView`'s toast queue is the obvious home for a one-line "you were signed out", and it is
 * the wrong one: the queue lives inside `hudView`, which every hub screen sets
 * `visible = false` (`ScreenFlow.showMenu`). A 401 fires at the lobby by definition — it is
 * the answer to the meta pull a login or a boot just made — so a toast would be pushed into a
 * hidden container and the player would be silently demoted to a guest, which is the failure
 * hole 2 is about, moved down one layer.
 *
 * ## Modality
 *
 * The root container takes a full-viewport `hitArea` while it is open, so a tap meant for the
 * lobby button underneath is swallowed rather than acted on. Pixi hit-tests children before a
 * container's own `hitArea`, so this prompt's own buttons still win.
 */
export type GuestMergeChoice = 'account' | 'merge';

export interface AccountPromptDeps {
  /** Menu DESIGN space for the current viewport (`ui/menuLayer.ts`) — the same thing
   *  `ScreenNav.fit()` wraps. A thunk, not a value, because the viewport moves. */
  size: () => { w: number; h: number };
}

export class AccountPrompt {
  readonly view = new Container();
  private readonly scrim = new Panel({ alpha: 0.55 });
  private readonly panel = new Panel({ radius: 12, color: 0x121722, alpha: 0.96, borderColor: 0x63b3ed, borderAlpha: 0.7 });
  private readonly titleText: Text;
  private readonly bodyText: Text;
  /** The guest-merge pair. Both are constructed and both always carry a label, even in
   *  notice mode — `labelFit.test.ts` reflects over these fields to measure every label in
   *  all eight locales, and a button whose text is only set when it is shown measures as
   *  empty and is skipped (the same reason `PortalPrompt` keeps both of its). */
  private readonly accountBtn: Button;
  private readonly mergeBtn: Button;
  private readonly closeBtn: Button;
  private mode: 'none' | 'merge' | 'notice' = 'none';
  /** Resolves the promise `askGuestMerge` handed out. Held on the instance rather than
   *  closed over, because the tap handlers are wired once, at construction. */
  private resolveChoice: ((choice: GuestMergeChoice) => void) | null = null;

  constructor(private readonly deps: AccountPromptDeps) {
    this.titleText = new Text({
      text: '',
      style: { fill: 0x90cdf4, fontSize: 20, fontFamily: 'sans-serif', fontWeight: 'bold', align: 'center', padding: 8 },
    });
    this.titleText.anchor.set(0.5, 0);
    // `breakWords` alongside `wordWrap` for design/17-i18n.md's CJK rule — PortalPrompt's own
    // comment has the live report behind it: Chinese has no spaces to wrap at, so a plain
    // wordWrap leaves an unbroken run overflowing the panel as one line.
    this.bodyText = new Text({
      text: '',
      style: { fill: 0xcbd5e0, fontSize: 15, fontFamily: 'sans-serif', align: 'center', padding: 8, wordWrap: true, wordWrapWidth: 440, breakWords: true },
    });
    this.bodyText.anchor.set(0.5, 0);

    // The account is the PRIMARY action (the brighter fill, the upper slot), and that is the
    // decision rather than the styling: on a shared computer the guest progress on this
    // browser belongs to whoever used it last, so "use the account's" has to be what a player
    // gets by pressing the obvious button.
    this.accountBtn = new Button('', { w: 300, h: 42, color: 0x2b6cb0, borderColor: 0x90cdf4 });
    this.accountBtn.onTap = () => this.choose('account');
    this.mergeBtn = new Button('', { w: 300, h: 42 });
    this.mergeBtn.onTap = () => this.choose('merge');
    // `closeBtn`, not `dismissBtn`: `buttonCueConventions.test.ts` reads the FIELD NAME to
    // decide which buttons may carry `ui.back`, and its list of leaving-verbs is the
    // convention rather than a regex that happens to match.
    this.closeBtn = new Button('', { w: 200, h: 42, color: 0x2b6cb0, borderColor: 0x90cdf4, sound: 'ui.back' });
    this.closeBtn.onTap = () => this.hide();

    this.view.addChild(
      this.scrim.view, this.panel.view, this.titleText, this.bodyText,
      this.accountBtn.view, this.mergeBtn.view, this.closeBtn.view,
    );
    this.view.visible = false;
    this.retext();
  }

  get isOpen(): boolean {
    return this.mode !== 'none';
  }

  /**
   * Ask the one-time device-merge question. Resolves with the player's answer, and there is
   * no third outcome on purpose: this prompt has no dismiss in merge mode, because "closed
   * the panel" would have to mean one of the two answers anyway, and the server-side claim
   * that makes the question one-time has already been spent by the time the caller gets here.
   */
  askGuestMerge(counts: GuestMergeOffer, username: string): Promise<GuestMergeChoice> {
    this.mode = 'merge';
    this.titleText.text = t('auth.mergeTitle');
    this.bodyText.text = t('auth.mergeBody', {
      username,
      materials: counts.materials,
      blueprints: counts.blueprints,
      characters: counts.characters,
    });
    this.open();
    return new Promise((resolve) => {
      this.resolveChoice = resolve;
    });
  }

  /** The one-button notice — today the expired/revoked session (hole 2). */
  showNotice(title: string, body: string): void {
    this.mode = 'notice';
    this.titleText.text = title;
    this.bodyText.text = body;
    this.open();
  }

  /** Re-run the layout against a fresh viewport, if anything is on screen. Called by
   *  `ScreenNav.relayout`, the same hook every screen's own resize goes through. */
  relayout(): void {
    if (this.mode === 'none') return;
    const { w, h } = this.deps.size();
    this.layout(w, h);
  }

  private open(): void {
    this.retext();
    const { w, h } = this.deps.size();
    this.layout(w, h);
    this.view.visible = true;
  }

  private choose(choice: GuestMergeChoice): void {
    const resolve = this.resolveChoice;
    this.hide();
    // Resolved AFTER `hide()` has cleared the slot: a resolver that ran first would re-enter
    // this class through its caller's continuation while `mode` still said the panel was up.
    resolve?.(choice);
  }

  private hide(): void {
    this.mode = 'none';
    this.resolveChoice = null;
    this.view.visible = false;
  }

  /** Re-apply every static label from the active locale — the same convention as `MainMenu`'s
   *  own `retext`, so a language change made in Settings lands the next time this opens. */
  private retext(): void {
    this.accountBtn.setText(t('auth.mergeUseAccount'));
    this.mergeBtn.setText(t('auth.mergeCombine'));
    this.closeBtn.setText(t('auth.noticeDismiss'));
  }

  /** Public so the two layout sweeps (`viewportFit`/`labelFit`) can place it at the design
   *  size with no viewport; production reaches it through `open`/`relayout`. */
  layout(w: number, h: number): void {
    this.scrim.layout(w, h);
    // Re-set every layout because the viewport it has to cover changes. See the class header
    // on why a container hitArea does not steal its own buttons' taps.
    this.view.hitArea = new Rectangle(0, 0, w, h);
    this.view.eventMode = 'static';

    const panelW = Math.min(520, w - 48);
    const panelH = 268;
    const x = w / 2 - panelW / 2;
    const y = h / 2 - panelH / 2;
    this.panel.layout(panelW, panelH);
    this.panel.view.position.set(x, y);

    const cx = w / 2;
    this.titleText.position.set(cx, y + 24);
    // Wrapped against the panel it sits in rather than against a constant: `panelW` shrinks
    // on a narrow viewport, and text laid out for the wide case runs off both sides of it.
    this.bodyText.style.wordWrapWidth = panelW - 48;
    this.bodyText.position.set(cx, y + 62);

    const merge = this.mode === 'merge';
    this.accountBtn.view.visible = merge;
    this.mergeBtn.view.visible = merge;
    this.closeBtn.view.visible = this.mode === 'notice';
    // Stacked, never side by side: eight locales' worth of labels next to each other is the
    // collision `labelFit.test.ts` exists for, and a modal has the vertical room.
    this.accountBtn.view.position.set(cx - 150, y + panelH - 106);
    this.mergeBtn.view.position.set(cx - 150, y + panelH - 56);
    this.closeBtn.view.position.set(cx - 100, y + panelH - 56);
  }
}
