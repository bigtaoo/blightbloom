/**
 * design/21's analytics on a host that cannot reach our server: each event of a batch is
 * handed to Bridge's `analytics.send` instead of `POST /client/events`.
 *
 * Playgama's sandbox frame admits only Playgama's own origins (Holy Kicker measured it: every
 * request to its backend was refused by the frame's CSP), and the platform's own requirements
 * forbid third-party analytics anyway. The events, their names and their props are the same as
 * on every other host — `installAnalytics` still emits `session_start`, `active_time` and
 * `session_end` itself — so a Playgama row reads exactly like a web one in the console's
 * telemetry export (`get_game_telemetry_event_analytics`). The per-visit and per-install ids
 * ride along on every event, because a platform event stream has no batch to carry them.
 */
import type { AnalyticsBatch } from '../../net/analyticsEvents';
import type { PlaygamaBridge } from './bridge';

export function bridgeSender(bridge: Pick<PlaygamaBridge, 'track'>): (batch: AnalyticsBatch) => void {
  return (batch) => {
    for (const e of batch.events) {
      bridge.track(e.name, { ...e.props, install: batch.install, session: batch.session, build: batch.build, locale: batch.locale });
    }
  };
}
