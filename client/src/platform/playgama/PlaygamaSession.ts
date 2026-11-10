/**
 * The Playgama counterpart of `platform/crazygames/PortalSession.ts`: tells Bridge what the
 * game is doing, places the interstitial, and obeys the platform's pause and sound switches.
 *
 * Same shape and same reason as that file — a derivation from the phase stream on its own
 * ticker callback, so `src/game/` does not know a portal exists. What Playgama's requirements
 * add (the Bridge docs' "required steps"):
 *  - `gameplay_started` / `gameplay_stopped` around real play, from the same
 *    `GameplayBracket` the CrazyGames build uses.
 *  - An interstitial only at a natural pause — the end of a run — and never on a timer of our
 *    own; Bridge's `minimumDelayBetweenInterstitial` (`playgama-bridge-config.json`) owns the
 *    cooldown, and a call inside it fails at once without showing anything.
 *  - `pause_state_changed` stops the game's clock and its sound; `audio_state_changed` and
 *    `isAudioEnabled` mute it. Both are folded with the ad's own hold into one mute and one
 *    clock, because two owners of `setExternalMute` would unmute each other.
 */
import type { Phase } from '../../game/phase';
import { setExternalMute } from '../../audio/externalMute';
import type { RewardedAd } from '../rewardedAd';
import { GameplayBracket, isGameplayPhase } from '../crazygames/GameplayBracket';
import type { SuspendableClock } from '../crazygames/suspension';
import type { PlaygamaBridge } from './bridge';
import { heldForKeys, onKeyFocus } from '../keyFocus';

export interface PlaygamaGameView {
  getPhase(): Phase;
}

type SessionBridge = Pick<
  PlaygamaBridge,
  'send' | 'onPause' | 'onMute' | 'interstitial' | 'rewarded' | 'rewardedSupported' | 'adInFlight'
>;

/** Why the game is stopped or silent right now; it runs again only when this is empty. */
type Hold = 'ad' | 'pause' | 'unsized' | 'keys';

/**
 * The keys' side of `platform/keyFocus.ts`: whether the move lesson is waiting on keys that go
 * to the portal's page, and a way to hear the moment they arrive. Injected for the tests.
 */
export interface SessionKeys {
  held(): boolean;
  onFocus(fn: () => void): void;
}

const sinkKeys: SessionKeys = { held: heldForKeys, onFocus: onKeyFocus };

/**
 * The frame the game is drawn into. Playgama's sandbox mounts the game in an iframe that starts
 * at 0x0 and is sized later; a run that ticks in that window is played by nobody — the first-run
 * autostart puts a new player straight into combat, so the frames they miss are the ones that
 * teach. Injected so the rule is testable without a window.
 */
export interface SessionViewport {
  size(): { w: number; h: number };
  onResize(fn: () => void): void;
}

const windowViewport: SessionViewport = {
  size: () => ({ w: globalThis.innerWidth ?? 1, h: globalThis.innerHeight ?? 1 }),
  onResize: (fn) => globalThis.addEventListener?.('resize', fn),
};

export class PlaygamaSession {
  private readonly bracket: GameplayBracket;
  private readonly holds = new Set<Hold>();
  private platformMuted = false;
  private previous: Phase | null = null;
  private lastSubstantive: Phase | null = null;
  private interstitials = 0;
  private keys: SessionKeys | null = null;

  constructor(
    private readonly game: PlaygamaGameView,
    private readonly bridge: SessionBridge,
    private readonly clock: SuspendableClock,
    private readonly mute: (muted: boolean) => void = setExternalMute,
    private readonly viewport: SessionViewport = windowViewport,
  ) {
    this.bracket = new GameplayBracket({
      gameplayStart: () => bridge.send('gameplay_started'),
      gameplayStop: () => bridge.send('gameplay_stopped'),
    });
  }

  /** Subscribe to the platform's switches. Once, after `bridge.init()`. */
  start(): void {
    this.bridge.onPause((paused) => this.setHold('pause', paused));
    this.bridge.onMute((muted) => {
      this.platformMuted = muted;
      this.applyMute();
    });
  }

  /** The first playable frame is on screen: the loading screen may come down. */
  ready(): void {
    this.bridge.send('game_ready');
  }

  /**
   * Hold the game while its frame has no area (`SessionViewport`'s doc). Armed only after
   * `ready()`: the boot waits for one rendered frame before it may send `game_ready`, and a
   * stopped ticker would never render it — the same order D:/jump's boot keeps.
   */
  watchViewport(): void {
    const check = (): void => {
      const { w, h } = this.viewport.size();
      this.setHold('unsized', !(w > 0 && h > 0));
    };
    check();
    this.viewport.onResize(check);
  }

  /**
   * Hold a run whose move lesson is asking for a click (`keyFocus.ts`): the sandbox's first runs
   * played on unseen, the keys going to the portal's page and the consent popup over the frame,
   * until the player had lost the fight they never steered (Holy Kicker measured ~38 such runs,
   * D:/standing `ui/runWatch.ts`). Held, the frame stays on the panel that says what to do, no
   * `gameplay_started` goes out, and the first focus — a click anywhere in the frame — lets it go.
   * Released from the focus event, because a stopped clock runs no `update()` to notice it.
   */
  watchKeys(keys: SessionKeys = sinkKeys): void {
    this.keys = keys;
    keys.onFocus(() => this.setHold('keys', false));
  }

  update(): void {
    const phase = this.game.getPhase();
    const keys = this.keys !== null && phase === 'playing' && this.keys.held();
    if (keys !== this.holds.has('keys')) this.setHold('keys', keys);
    this.bracket.update(phase, this.holds.size > 0);
    if (phase !== this.previous) this.onPhaseChange(phase);
    this.previous = phase;
  }

  /** The rewarded-ad capability (`platform/rewardedAd.ts`), backed by Bridge. */
  rewardedAd(): RewardedAd {
    return {
      available: () => this.bridge.rewardedSupported() && !this.bridge.adInFlight(),
      show: () => this.whileAd((opened) => this.bridge.rewarded(opened)),
    };
  }

  diagnostics(): string {
    return `holds ${[...this.holds].join('+') || 'none'} · muted ${this.platformMuted} · interstitials ${this.interstitials}` +
      `${this.bracket.isLive() ? ' · gameplay' : ''}`;
  }

  private onPhaseChange(to: Phase): void {
    // Settings is an overlay a run can be paused into, not the run ending.
    if (to === 'settings') return;
    const from = this.lastSubstantive;
    this.lastSubstantive = to;
    if (from !== null && inRun(from) && !inRun(to)) {
      this.interstitials += 1;
      // Nobody awaits an interstitial, so a rejection would surface as an unhandled one.
      this.whileAd((opened) => this.bridge.interstitial(opened)).catch(() => undefined);
    }
  }

  /** Runs one ad with the game held from the moment it opens until it is over. */
  private async whileAd<T>(show: (opened: () => void) => Promise<T>): Promise<T> {
    try {
      return await show(() => this.setHold('ad', true));
    } finally {
      this.setHold('ad', false);
    }
  }

  private setHold(hold: Hold, on: boolean): void {
    const was = this.holds.size > 0;
    if (on) this.holds.add(hold);
    else this.holds.delete(hold);
    const now = this.holds.size > 0;
    if (was !== now) {
      if (now) this.clock.stop();
      else this.clock.start();
      // `update()` rides the clock just stopped, so the bracket is told here or not at all.
      this.bracket.update(this.game.getPhase(), now);
    }
    this.applyMute();
  }

  private applyMute(): void {
    this.mute(this.platformMuted || this.holds.size > 0);
  }
}

function inRun(p: Phase): boolean {
  return isGameplayPhase(p) || p === 'paused' || p === 'victory' || p === 'defeat';
}
