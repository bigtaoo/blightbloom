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

export interface PlaygamaGameView {
  getPhase(): Phase;
}

type SessionBridge = Pick<
  PlaygamaBridge,
  'send' | 'onPause' | 'onMute' | 'interstitial' | 'rewarded' | 'rewardedSupported' | 'adInFlight'
>;

/** Why the game is stopped or silent right now; it runs again only when this is empty. */
type Hold = 'ad' | 'pause';

export class PlaygamaSession {
  private readonly bracket: GameplayBracket;
  private readonly holds = new Set<Hold>();
  private platformMuted = false;
  private previous: Phase | null = null;
  private lastSubstantive: Phase | null = null;
  private interstitials = 0;

  constructor(
    private readonly game: PlaygamaGameView,
    private readonly bridge: SessionBridge,
    private readonly clock: SuspendableClock,
    private readonly mute: (muted: boolean) => void = setExternalMute,
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

  update(): void {
    const phase = this.game.getPhase();
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
