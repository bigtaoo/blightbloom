// `gameplayStart` / `gameplayStop`, derived from the phase every frame.
//
// The portal needs to know when the player is actually PLAYING: it is the boundary its ad
// rules are written against ("advertisements should not be shown while a user is playing"),
// the point its initial-download measurement stops at, and the window in which it hands
// keyboard focus to the frame.
//
// ## Why this is a per-frame derivation and not a set of event hooks
//
// The obvious implementation is a call at each transition — one in `RunLifecycle.beginRun`,
// one in `quitRun`, one in the pause path, one in each gameover arm, one either side of an
// ad. That is five hooks whose correctness is "nobody forgot one", and this codebase has
// already paid for that shape once: `game/musicDirector.ts` is a per-frame derivation for
// exactly this reason, and its doc comment names the two failure modes an event-driven
// version has — "a moment nobody remembered to hook, and a moment that fires twice".
//
// So this takes the same form. `update()` is called every frame in every phase, it computes
// whether gameplay is live from the phase it is handed, and it emits only on a change. A new
// phase, a new pause path or a new ad placement cannot get this wrong, because none of them
// has to know it exists.
//
// The one thing it does NOT derive is the ad: an ad is not a phase (it happens over the top
// of a menu), so `adActive` is passed in alongside. It suppresses gameplay unconditionally,
// which is the platform's "a user cannot progress the game while an ad is showing" rule
// stated where it cannot be missed.
import type { Phase } from '../../game/phase';

/** The phases that count as gameplay. `paused` deliberately does not: the docs list a pause
 *  as a break, and it is also the phase an ad may legally be requested from. `matchmaking`
 *  does not either — nothing is being played while a socket is being found. */
const GAMEPLAY_PHASES: ReadonlySet<Phase> = new Set<Phase>(['playing']);

export function isGameplayPhase(phase: Phase): boolean {
  return GAMEPLAY_PHASES.has(phase);
}

/** The two calls this bracket makes. Narrowed to a two-method interface rather than taking
 *  the whole `CrazyGamesSdk`, so a test asserts on a two-line fake (CLAUDE.md form ②). */
export interface GameplaySignal {
  gameplayStart(): void;
  gameplayStop(): void;
}

export class GameplayBracket {
  /** `null` = nothing has been reported yet, which is distinct from `false`: the FIRST
   *  frame of a menu must still emit a `gameplayStop`, because the portal treats the span
   *  before the first bracket call as "still loading". */
  private live: boolean | null = null;

  constructor(private readonly signal: GameplaySignal) {}

  /** Call once per frame, in every phase. Emits only on a change. */
  update(phase: Phase, adActive = false): void {
    const next = !adActive && isGameplayPhase(phase);
    if (next === this.live) return;
    this.live = next;
    if (next) this.signal.gameplayStart();
    else this.signal.gameplayStop();
  }

  /** What was last reported, for tests and for the diagnostics row. */
  isLive(): boolean {
    return this.live === true;
  }
}
