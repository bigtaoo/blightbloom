import { Container, Text } from 'pixi.js';
import { Panel, Button } from '../ui/widgets';
import { getUiTexture } from '../../render/uiSkins';
import { t } from '../../i18n';
import type { CoopSession } from '../../net/CoopSession';

/** Cooperative cancel token — the same shape `findMatch`'s `signal` option already
 * accepts (`net/matchmaking.ts`), just owned by this screen instead of a caller. */
export type MatchmakingSignal = { cancelled: boolean };
export type MatchmakingConnect = (signal: MatchmakingSignal) => Promise<CoopSession>;

function classifyError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes('cancelled')) return t('matchmaking.errorCancelled');
  if (msg.includes('timed out') || msg.includes('expired')) return t('matchmaking.errorTimeout');
  return t('matchmaking.errorGeneric');
}

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
 * Two internal states (same "internal state, not a separate phase" convention
 * LoginScreen uses for logged-in/out): 'connecting' (elapsed-time text + Cancel) and
 * 'error' (message + Retry + Back). No network call is made directly here — `connect`
 * is injected, same DI convention as PartyScreen's `PartyApi`.
 */
export class Matchmaking {
  readonly view = new Container();
  private panel = new Panel({ alpha: 0.85, background: 'hub' });
  private title: Text;
  private statusText: Text;
  private cancelBtn: Button;
  private retryBtn: Button;
  private backBtn: Button;

  private connectFn: MatchmakingConnect | null = null;
  private signal: MatchmakingSignal | null = null;
  private state: 'connecting' | 'error' = 'connecting';
  private errorText = '';
  private elapsedMs = 0;
  // Guards a stale attempt's resolve/reject from landing after cancel/retry/hide —
  // incremented on every state-ending action, checked when the promise settles.
  private attemptToken = 0;

  onConnected: ((session: CoopSession) => void) | null = null;
  /** Fired on Cancel (mid-connect) or Back (from the error state) alike — both mean
   * "give up on matchmaking", Game.ts routes both back to the lobby/Squad. */
  onCancelled: (() => void) | null = null;

  constructor() {
    this.title = new Text({ text: t('matchmaking.searching'), style: { fill: 0xf7fafc, fontSize: 30, fontWeight: 'bold', fontFamily: 'sans-serif', padding: 16 } });
    this.title.anchor.set(0.5, 0);
    this.statusText = new Text({ text: '', style: { fill: 0x90cdf4, fontSize: 16, fontFamily: 'monospace', padding: 16 } });
    this.statusText.anchor.set(0.5, 0);

    this.cancelBtn = new Button(t('matchmaking.cancel'), { w: 160, h: 40, fontSize: 14, color: 0x742a2a, sound: 'ui.back' });
    this.cancelBtn.onTap = () => this.cancel();
    this.retryBtn = new Button(t('matchmaking.retry'), { w: 160, h: 40, fontSize: 14, color: 0x2f855a });
    this.retryBtn.onTap = () => this.retry();
    this.backBtn = new Button(t('matchmaking.back'), { w: 160, h: 40, fontSize: 14, sound: 'ui.back' });
    this.backBtn.onTap = () => this.cancel();
    this.backBtn.setIcon(getUiTexture('icon_back'));

    this.view.addChild(this.panel.view, this.title, this.statusText, this.cancelBtn.view, this.retryBtn.view, this.backBtn.view);
    this.view.eventMode = 'static';
    this.view.visible = false;
  }

  private layout(w: number, h: number): void {
    this.panel.layout(w, h);
    const cx = w / 2;
    const cy = h / 2;
    this.title.position.set(cx, cy - 80);
    this.statusText.position.set(cx, cy - 10);
    this.cancelBtn.view.position.set(cx - 80, cy + 40);
    this.retryBtn.view.position.set(cx - 170, cy + 40);
    this.backBtn.view.position.set(cx + 10, cy + 40);
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
    this.refreshStatusText();
  }

  private beginAttempt(): void {
    this.state = 'connecting';
    this.elapsedMs = 0;
    this.signal = { cancelled: false };
    const token = ++this.attemptToken;
    this.refresh();
    this.connectFn!(this.signal)
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
    this.cancelBtn.setText(t('matchmaking.cancel'));
    this.retryBtn.setText(t('matchmaking.retry'));
    this.backBtn.setText(t('matchmaking.back'));
  }

  private refreshStatusText(): void {
    if (this.state === 'connecting') {
      this.statusText.text = t('matchmaking.elapsed', { seconds: Math.floor(this.elapsedMs / 1000) });
    }
  }

  private refresh(): void {
    const connecting = this.state === 'connecting';
    this.title.text = connecting ? t('matchmaking.searching') : t('matchmaking.errorTitle');
    this.statusText.text = connecting ? t('matchmaking.elapsed', { seconds: 0 }) : this.errorText;
    this.cancelBtn.view.visible = connecting;
    this.retryBtn.view.visible = !connecting;
    this.backBtn.view.visible = !connecting;
  }
}
