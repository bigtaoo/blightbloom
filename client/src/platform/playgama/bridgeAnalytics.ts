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
 * ## What is NOT forwarded (2026-11-08)
 *
 * Bridge records session start and end, and playtime, itself ("Some events reach analytics
 * without extra code ... session start and end", wiki `api/analytics`), and Playgama's
 * telemetry guide asks a game not to duplicate those signals and not to transmit a session id
 * of its own. Forwarding ours did both, and measured badly on top: our `session_end` rides
 * `pagehide`, which a portal frame torn down by its parent page mostly never sees, so it
 * reached the console for a small fraction of the visits that `session_start` did — a churn
 * number that was wrong rather than merely missing. So:
 *  - `session_end` and `active_time` are dropped: Bridge's own session end and playtime are
 *    the numbers to read on this host;
 *  - `session_start` is kept, because it carries what Bridge cannot know (`boot_ms`, the
 *    storage tier, the device split) — it is the boot report here, not the session counter;
 *  - the envelope's `install` and `session` ids are not attached: Bridge establishes both the
 *    session and the user, and an unbounded id of ours as a custom dimension is exactly the
 *    cardinality the guide asks a game to keep out.
 */
import type { AnalyticsBatch } from '../../net/analyticsEvents';
import type { PlaygamaBridge } from './bridge';

/** Events Bridge already records on its own, which this host therefore never forwards. */
export const PLATFORM_OWNED_EVENTS: ReadonlySet<string> = new Set(['session_end', 'active_time']);

export function bridgeSender(bridge: Pick<PlaygamaBridge, 'track'>): (batch: AnalyticsBatch) => void {
  return (batch) => {
    for (const e of batch.events) {
      if (PLATFORM_OWNED_EVENTS.has(e.name)) continue;
      bridge.track(e.name, { ...e.props, build: batch.build, locale: batch.locale });
    }
  };
}
