// The defeat screen's one diagnostic line: what to do differently, read off the death-cause
// numbers `deathCause.ts` already measures (split out as its own module so the rule is a
// table a test can walk, not four branches buried in `RunOutcome.lose`).
//
// ## Why
//
// The Playgama sandbox's first 30 sessions end on the defeat screen 47% of the time, and
// that screen was four lines of ledger — floor fallen on, materials lost, time, score. All
// four state the loss; none names a cause, and none names a fix. Meanwhile `run_death` has
// carried `killer`, `room`, `hits` and `burst_pct` since 2026-11-09: the game already knew
// why the player died and told only us. A player who closes the tab after a death closes it
// not knowing what to change, which is the version of the loss that ends the session —
// restart friction is not the problem (the loss → next `run_start` gap has a p50 of 0.0 s
// since TRY AGAIN landed on 2026-11-09; 57% of losses are already restarted).
//
// ## Why these three, and why no enemy name
//
// Each line has to name a DIFFERENT action, or it is decoration. The three the measured
// numbers can separate honestly:
//
// - `burst`: a spike. `burst_pct` is the damage of the last five seconds as a share of the
//   whole HP + shield pool, so a high one means the fight was lost before the player could
//   react to it. The action is positional — move, break line of sight — not "heal more".
// - `attrition`: the median death (13 hits at 50% burst). Nothing spiked; the player stood
//   in fire and never let the shield come back. The action is the shield-regen delay
//   chapter 1 sets at 45 ticks (1.5 s, ENGINE_VERSION 93) — which exists precisely for this
//   death and which nothing on screen mentions.
// - `fragile`: a run ended by a handful of hits is not a skill problem; it is an unbuilt
//   character walking downstairs. The action is the loadout, before the next descent.
//
// Deliberately NOT said: the killer's name. `killer` is a blueprint id (`basic`, `turret`,
// `fire_status`), not a display name, and naming it would buy a display string per enemy in
// every locale to tell the player something the fight already showed them. The one thing
// they could not see is WHICH of the three mistakes above they made.
import type { DeathProps } from './deathCause';

/** Which of the three readings the numbers support. The id doubles as the i18n suffix. */
export type DeathAdviceId = 'burst' | 'attrition' | 'fragile';

export interface DeathAdvice {
  id: DeathAdviceId;
  /** A literal key, so the i18n parity test (`i18n.test.ts`) sees every one of them. */
  key: 'results.adviceBurst' | 'results.adviceAttrition' | 'results.adviceFragile';
  params: { hits: number };
}

/** Damage in the last five seconds, as a percent of the full pool, at or above which the
 *  death reads as a spike rather than a bleed. The sandbox median is 50, so this sits above
 *  the ordinary death on purpose: the positional advice is wrong for a slow loss. */
export const BURST_ADVICE_PCT = 70;

/** At or below this many hits over a WHOLE run, the body was the problem, not the play. */
export const FRAGILE_ADVICE_HITS = 3;

/**
 * The line for a death, or `null` when there is nothing honest to say — a run with no
 * recorded hit at all (a disconnect, a resumed run killed on its first frame) gets the
 * four ledger lines and no advice rather than a guess.
 */
export function deathAdvice(props: DeathProps): DeathAdvice | null {
  const hits = props.hits ?? 0;
  if (hits <= 0) return null;
  // Burst first: three hits that took 90% of the pool is a spike, not a fragile body, and
  // "go craft something" would be the wrong thing to tell that player.
  if ((props.burst_pct ?? 0) >= BURST_ADVICE_PCT) return { id: 'burst', key: 'results.adviceBurst', params: { hits } };
  if (hits <= FRAGILE_ADVICE_HITS) return { id: 'fragile', key: 'results.adviceFragile', params: { hits } };
  return { id: 'attrition', key: 'results.adviceAttrition', params: { hits } };
}
