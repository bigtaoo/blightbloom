/**
 * design/21's analytics on a host that cannot reach our server: each event of a batch is
 * handed to Bridge's `analytics.send` instead of `POST /client/events`.
 *
 * Playgama's sandbox frame admits only Playgama's own origins (Holy Kicker measured it: every
 * request to its backend was refused by the frame's CSP), and the platform's own requirements
 * forbid third-party analytics anyway. The game's own events, names and props are the same as
 * on every other host, so a Playgama row reads like a web one in the console's telemetry
 * export (`get_game_telemetry_event_analytics`).
 *
 * ## What is NOT forwarded (2026-11-08, narrowed 2026-11-14)
 *
 * Bridge records session start and end, and playtime, itself ("Some events reach analytics
 * without extra code ... session start and end", wiki `api/analytics`), and Playgama's
 * telemetry guide asks a game not to duplicate those signals and not to transmit a session id
 * of its own. So:
 *  - `session_end` is dropped. Ours rides `pagehide`, which a portal frame torn down by its
 *    parent page mostly never sees, so it reached the console for a small fraction of the
 *    visits `session_start` did — a churn number that was wrong rather than merely missing.
 *  - `session_start` is kept, because it carries what Bridge cannot know (`boot_ms`, the
 *    storage tier, the device split) — it is the boot report here, not the session counter;
 *  - the envelope's `install` and `session` ids are not attached: Bridge establishes both the
 *    session and the user, and an unbounded id of ours as a custom dimension is exactly the
 *    cardinality the guide asks a game to keep out.
 *
 * ## Why `active_time` came back (2026-11-14)
 *
 * It was dropped alongside `session_end` on the reasoning above, and that was the one mistake
 * in it. `active_time` does not ride `pagehide` and is not a duplicate of Bridge's session
 * length: it is sent about once a minute WHILE the visit grows, carries only the VISIBLE part
 * of it, and is cumulative, so the server takes a visit's maximum and a lost batch costs a
 * minute. It is the one ruler that survives the exact failure the paragraph above describes.
 *
 * What dropping it cost is on the record. Across 673 sessions of the 2026-11 sandbox test the
 * game's own `session_end` arrived ONCE, so every duration in that archive is the platform's —
 * and the platform's read `p50 0` on four of nine days and produced the false 11-12 headline
 * (mean up 22%, total seconds up 1.2%, denominator down from 104 to 86). A game that cannot
 * measure its own playtime cannot check the number a portal grades it on, and "how long did
 * people play" is the one question a portal asks (`data/playgama-sandbox-2026-11/`).
 */
import type { AnalyticsBatch } from '../../net/analyticsEvents';
import type { PlaygamaBridge } from './bridge';
import type { Attention } from '../keyFocus';

/** Events Bridge already records on its own, which this host therefore never forwards. See the
 *  header: `active_time` was on this list until 2026-11-14 and should never have been. */
export const PLATFORM_OWNED_EVENTS: ReadonlySet<string> = new Set(['session_end']);

/**
 * `attention` (2026-11-10) adds `focus` and `input` to every event (`platform/keyFocus.ts`): has
 * the game ever had the keys, and has the player pressed inside it. Two booleans, so no
 * cardinality to speak of, and they split a run that went unplayed into "the keys never got
 * here" and "the player never tried".
 */
export function bridgeSender(
  bridge: Pick<PlaygamaBridge, 'track'>,
  attention: () => Attention | null = () => null,
): (batch: AnalyticsBatch) => void {
  return (batch) => {
    for (const e of batch.events) {
      if (PLATFORM_OWNED_EVENTS.has(e.name)) continue;
      bridge.track(e.name, { ...e.props, ...attention(), build: batch.build, locale: batch.locale });
    }
  };
}
