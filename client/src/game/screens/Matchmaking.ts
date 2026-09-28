import { Container, Graphics, Text } from 'pixi.js';
import { Button } from '../ui/widgets';
import { MenuShell } from '../ui/MenuShell';
import type { LobbyBackdrop } from '../ui/LobbyBackdrop';
import { SHEET_PAD, SHEET_TITLE_H } from '../ui/MenuSheet';
import { MENU_BUTTONS, MENU_COLORS, menuText } from '../ui/menuTheme';
import { t } from '../../i18n';
import type { CoopSession } from '../../net/CoopSession';
import { MatchRequestError, type QueueProgress } from '../../net/matchmaking';

/** Cooperative cancel token — the same shape `findMatch`'s `signal` option already
 * accepts (`net/matchmaking.ts`), just owned by this screen instead of a caller. */
export type MatchmakingSignal = { cancelled: boolean };
/** `onQueued` (2026-09-26) is how the queue's backfill countdown reaches this screen — the
 *  connect closure forwards it to `findMatch`. Optional so a connect that cannot report one
 *  (a test double, an older path) still works; the screen then shows no countdown. */
export type MatchmakingConnect = (
  signal: MatchmakingSignal,
  onQueued?: (progress: QueueProgress) => void,
) => Promise<CoopSession>;

/**
 * Which of the four messages this screen shows.
 *
 * The 429 is checked FIRST and on the STATUS, never on prose (2026-09-22, when `POST /find`
 * gained a per-IP budget). Every other arm here reads a message, which is tolerable only
 * because those strings are the CLIENT's own — `connectOnlineSession` writes "timed out" and
 * the cancel path writes "cancelled". A server's prose is a different thing to match on: it
 * is reworded without a client release, which is why `net/matchmaking.ts` carries the status.
 *
 * And a throttled player must not be told what the generic arm tells them. This screen's
 * error state ends in a RETRY button; "could not connect — try again" points straight at it,
 * and a retry is the one action that spends more of a budget they have already run out of.
 */
function classifyError(e: unknown): string {
  if (e instanceof MatchRequestError && e.status === 429) return t('matchmaking.errorThrottled');
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes('cancelled')) return t('matchmaking.errorCancelled');
  if (msg.includes('timed out') || msg.includes('expired')) return t('matchmaking.errorTimeout');
  return t('matchmaking.errorGeneric');
}

/** The sheet's width and content width; the fixed rows' heights, top to bottom. Every row keeps
 *  its room in both states, so RETRY lands exactly where CANCEL was. */
const SHEET_W = 420;
const CONTENT_W = SHEET_W - SHEET_PAD * 2;
const MARK_H = 72;
/** The text block: three status lines (the longest error message, translated, wrapped), or
 *  one status line (the elapsed clock) over two caption lines (the backfill countdown). The
 *  hint only ever shows beside a one-line status, so it starts one line down. */
const TEXT_H = 64;
const HINT_Y = 30;
const BUTTON_W = 220;
const BUTTON_H = 44;
const CONTENT_H = MARK_H + 12 + TEXT_H + 14 + BUTTON_H;
/** The crystals circling while the queue works, and how fast they go round. */
const SPINNER_GEMS = 8;
const SPINNER_R = 26;
const SPINNER_RAD_PER_MS = (Math.PI * 2) / 1600;

/**
 * The matchmaking wait/error screen (design/10 screen-flow gap). Previously
 * `connectOnlineSession` ran with NO visible feedback at all — the game sat in a blank
 * `playing` phase while matchmaking/ticket/socket setup happened invisibly, and a
 * post-ticket failure hung forever with no error shown. This screen owns exactly one
 * in-flight connect attempt at a time, driven by a caller-supplied `connect` function
 * (Game.ts closes over whichever mode — solo co-op/PvP queue, or a pre-formed squad —
 * so this screen stays mode-agnostic) and a cooperative cancel signal already supported
 * by `findMatch`/`connectOnlineSession`, just not wired to any UI before now.
 *
 * While connecting, a second line counts down to the queue's BACKFILL point (2026-09-26):
 * "AI players fill empty seats in 4s", then "Filling empty seats with AI players…". The
 * number is the control plane's own (`botFillInMs` on every queued answer), re-synced on
 * each poll and ticked down locally between them, so an operator who changes the backfill
 * flag moves the countdown too. Nobody queueing for a co-op room waits long in silence —
 * the line says what is about to happen rather than leaving an empty queue to look stuck.
 *
 * Two internal states (same "internal state, not a separate phase" convention
 * LoginScreen uses for logged-in/out): 'connecting' (elapsed-time text + Cancel) and
 * 'error' (message + Retry + Back). No network call is made directly here — `connect`
 * is injected, same DI convention as PartyScreen's `PartyApi`.
 *
 * Since the menu shell (design/10 "One shell for every menu", 2026-09-27) it is one framed
 * sheet: a ring of crystals turning while the queue works (a cracked red one on failure), the
 * status and countdown lines, and one button — CANCEL, or RETRY in its place. BACK is the
 * shell's corner chip in both states, and means what CANCEL means: give up on this search.
 */
export class Matchmaking {
  readonly view = new Container();
  private readonly shell: MenuShell;
  /** The dimmed lobby painting. Named `panel` for `menuCoversWorld.test.ts`. */
  private readonly panel: LobbyBackdrop;
  /** The ring of crystals while searching; the failure mark in its place. */
  private readonly spinner = new Graphics();
  private readonly failMark = new Graphics();
  private statusText: Text;
  private hintText: Text;
  private cancelBtn: Button;
  private retryBtn: Button;
  /** Whether `layout` has run — text changed before it has nothing to re-rasterise against. */
  private laidOut = false;

  private connectFn: MatchmakingConnect | null = null;
  private signal: MatchmakingSignal | null = null;
  private state: 'connecting' | 'error' = 'connecting';
  private errorText = '';
  private elapsedMs = 0;
  /** Time left to the backfill point, or `null` before the queue has said (or never will). */
  private botFillLeftMs: number | null = null;
  // Guards a stale attempt's resolve/reject from landing after cancel/retry/hide —
  // incremented on every state-ending action, checked when the promise settles.
  private attemptToken = 0;

  onConnected: ((session: CoopSession) => void) | null = null;
  /** Fired on Cancel (mid-connect) or Back (from the error state) alike — both mean
   * "give up on matchmaking", Game.ts routes both back to the lobby/Squad. */
  onCancelled: (() => void) | null = null;

  constructor() {
    this.shell = new MenuShell({ title: t('matchmaking.searching'), back: t('matchmaking.back') });
    this.shell.onBack = () => this.cancel();
    this.panel = this.shell.backdrop;
    this.statusText = new Text({ text: '', style: menuText('value', { fill: MENU_COLORS.accent, align: 'center', wordWrap: true, breakWords: true, wordWrapWidth: CONTENT_W, lineHeight: 21 }) });
    this.statusText.anchor.set(0.5, 0);
    this.hintText = new Text({ text: '', style: menuText('caption', { fontSize: 12, lineHeight: 16, align: 'center', wordWrapWidth: CONTENT_W }) });
    this.hintText.anchor.set(0.5, 0);
    drawSpinner(this.spinner);
    drawFailMark(this.failMark);

    this.cancelBtn = new Button(t('matchmaking.cancel'), { w: BUTTON_W, h: BUTTON_H, fontSize: 15, sound: 'ui.back', ...MENU_BUTTONS.danger });
    this.cancelBtn.onTap = () => this.cancel();
    this.retryBtn = new Button(t('matchmaking.retry'), { w: BUTTON_W, h: BUTTON_H, fontSize: 15, ...MENU_BUTTONS.primary });
    this.retryBtn.onTap = () => this.retry();

    this.shell.content.addChild(this.spinner, this.failMark, this.statusText, this.hintText, this.cancelBtn.view, this.retryBtn.view);
    this.shell.mount(this.view);
    this.view.eventMode = 'static';
    this.view.visible = false;
  }

  private layout(w: number, h: number): void {
    this.laidOut = true;
    const cx = CONTENT_W / 2;
    this.spinner.position.set(cx, MARK_H / 2);
    this.failMark.position.set(cx, MARK_H / 2);
    let y = MARK_H + 12;
    this.statusText.position.set(cx, y);
    this.hintText.position.set(cx, y + HINT_Y);
    y += TEXT_H + 14;
    this.cancelBtn.view.position.set(cx - BUTTON_W / 2, y);
    this.retryBtn.view.position.set(cx - BUTTON_W / 2, y);
    this.shell.layout(w, h, SHEET_W, SHEET_TITLE_H + 18 + CONTENT_H + SHEET_PAD);
  }

  /** Begin (or resume showing) a matchmaking attempt. `connect` is called immediately —
   * Game.ts is expected to pass a fresh closure each time it opens this screen. */
  show(w: number, h: number, connect: MatchmakingConnect): void {
    this.retext();
    this.layout(w, h);
    this.connectFn = connect;
    this.beginAttempt();
    this.view.visible = true;
  }

  /** Per-frame: the backdrop's rocks, glow and motes. Driven from the main loop's
   *  `menuScreens`, and a no-op while this screen is hidden. */
  animate(dtMs: number): void {
    if (!this.view.visible) return;
    this.panel.update(dtMs);
    if (this.spinner.visible) this.spinner.rotation = (this.spinner.rotation + dtMs * SPINNER_RAD_PER_MS) % (Math.PI * 2);
  }

  hide(): void {
    this.view.visible = false;
    this.attemptToken++; // any attempt still in flight becomes stale
  }

  /** Re-run the pure layout math against a new viewport size, WITHOUT touching the
   * current attempt — unlike show(), a resize must never restart connect() (Screens.ts's
   * own show()/resize() split is the existing precedent for this distinction). */
  resize(w: number, h: number): void {
    if (this.view.visible) this.layout(w, h);
  }

  /** Call once per render frame while visible — only drives the elapsed-time text. */
  update(dt: number): void {
    if (!this.view.visible || this.state !== 'connecting') return;
    this.elapsedMs += dt;
    if (this.botFillLeftMs !== null) this.botFillLeftMs = Math.max(0, this.botFillLeftMs - dt);
    this.refreshStatusText();
  }

  private beginAttempt(): void {
    this.state = 'connecting';
    this.elapsedMs = 0;
    this.botFillLeftMs = null;
    this.signal = { cancelled: false };
    const token = ++this.attemptToken;
    this.refresh();
    const onQueued = (progress: QueueProgress): void => {
      if (token !== this.attemptToken || this.state !== 'connecting') return; // a stale attempt's poll
      this.botFillLeftMs = progress.botFillInMs ?? null;
      this.refreshStatusText();
    };
    this.connectFn!(this.signal, onQueued)
      .then((session) => {
        if (token !== this.attemptToken) return; // cancelled/retried/hidden since
        this.onConnected?.(session);
      })
      .catch((e: unknown) => {
        if (token !== this.attemptToken) return;
        this.state = 'error';
        this.errorText = classifyError(e);
        this.refresh();
      });
  }

  private cancel(): void {
    if (this.signal) this.signal.cancelled = true;
    this.attemptToken++;
    this.onCancelled?.();
  }

  private retry(): void {
    this.beginAttempt();
  }

  private retext(): void {
    this.shell.setBack(t('matchmaking.back'));
    this.cancelBtn.setText(t('matchmaking.cancel'));
    this.retryBtn.setText(t('matchmaking.retry'));
  }

  private refreshStatusText(): void {
    if (this.state === 'connecting') {
      this.statusText.text = t('matchmaking.elapsed', { seconds: Math.floor(this.elapsedMs / 1000) });
      this.hintText.text = this.hintLine();
    }
  }

  /** The backfill line: a countdown in whole seconds (rounded UP, so it never reads 0 while
   *  a second is still left), then "filling now" once it has run out, and nothing at all
   *  until the queue has reported. */
  private hintLine(): string {
    if (this.botFillLeftMs === null) return '';
    if (this.botFillLeftMs <= 0) return t('matchmaking.botNow');
    return t('matchmaking.botSoon', { seconds: Math.ceil(this.botFillLeftMs / 1000) });
  }

  private refresh(): void {
    const connecting = this.state === 'connecting';
    this.shell.setTitle(connecting ? t('matchmaking.searching') : t('matchmaking.errorTitle'));
    this.statusText.text = connecting ? t('matchmaking.elapsed', { seconds: 0 }) : this.errorText;
    this.statusText.style.fill = connecting ? MENU_COLORS.accent : MENU_COLORS.error;
    this.hintText.text = connecting ? this.hintLine() : '';
    this.spinner.visible = connecting;
    this.failMark.visible = !connecting;
    this.cancelBtn.view.visible = connecting;
    this.retryBtn.view.visible = !connecting;
    if (this.laidOut) this.shell.sharpen();
  }
}

/** A ring of crystals, brightest at the head, so turning it reads as motion: the sheet's own
 *  corner gem, repeated round a circle. */
function drawSpinner(g: Graphics): void {
  for (let i = 0; i < SPINNER_GEMS; i++) {
    const a = (i / SPINNER_GEMS) * Math.PI * 2;
    const x = Math.cos(a) * SPINNER_R;
    const y = Math.sin(a) * SPINNER_R;
    const s = 3 + (i / SPINNER_GEMS) * 3;
    g.poly([x, y - s * 1.5, x + s, y, x, y + s * 1.5, x - s, y])
      .fill({ color: MENU_COLORS.frame, alpha: 0.2 + 0.8 * (i / (SPINNER_GEMS - 1)) });
  }
}

/** The failure mark: one large crystal in the error red, split down the middle. */
function drawFailMark(g: Graphics): void {
  const s = 18;
  g.poly([0, -s * 1.5, s, 0, 0, s * 1.5, -s, 0]).fill({ color: MENU_COLORS.danger, alpha: 0.9 })
    .poly([0, -s * 1.5, s, 0, 0, s * 1.5, -s, 0]).stroke({ color: MENU_COLORS.error, width: 2 })
    .moveTo(-3, -s * 1.1).lineTo(3, -4).lineTo(-3, 4).lineTo(2, s * 1.1)
    .stroke({ color: MENU_COLORS.outline, width: 3 });
}
