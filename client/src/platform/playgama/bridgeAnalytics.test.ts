/**
 * `bridgeSender` — a batch becomes one Bridge event per game event, carrying the build and
 * locale, minus the events and ids Bridge already establishes itself (see its header).
 */
import { describe, expect, it } from 'vitest';
import { bridgeSender, PLATFORM_OWNED_EVENTS } from './bridgeAnalytics';
import type { AnalyticsBatch } from '../../net/analyticsEvents';

const batch = (events: AnalyticsBatch['events']): AnalyticsBatch => ({
  install: 'i1',
  session: 's1',
  host: 'playgama',
  build: 'unknown',
  locale: 'de',
  sentAt: 10,
  events,
});

describe('bridgeSender', () => {
  it('sends each game event with its props plus build and locale', () => {
    const sent: [string, unknown][] = [];
    const send = bridgeSender({ track: (e, d) => void sent.push([e, d]) });
    send(batch([
      { name: 'session_start', at: 1, props: { boot_ms: 1234 } },
      { name: 'run_end', at: 2, props: { outcome: 'loss', floor: 3 } },
    ]));
    const env = { build: 'unknown', locale: 'de' };
    expect(sent).toEqual([
      ['session_start', { boot_ms: 1234, ...env }],
      ['run_end', { outcome: 'loss', floor: 3, ...env }],
    ]);
  });

  it('never attaches our install or session id — Bridge owns both', () => {
    const sent: Record<string, unknown>[] = [];
    bridgeSender({ track: (_e, d) => void sent.push(d ?? {}) })(batch([{ name: 'run_start', at: 1 }]));
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toHaveProperty('install');
    expect(sent[0]).not.toHaveProperty('session');
  });

  it('drops the one session signal Bridge records itself, and only that one', () => {
    const sent: string[] = [];
    bridgeSender({ track: (e) => void sent.push(e) })(batch([
      { name: 'session_start', at: 1 },
      { name: 'run_start', at: 2 },
      { name: 'session_end', at: 3, props: { duration_s: 90, active_s: 61 } },
    ]));
    expect(sent).toEqual(['session_start', 'run_start']);
    expect([...PLATFORM_OWNED_EVENTS]).toEqual(['session_end']);
  });

  // The regression this file exists for. `active_time` was in PLATFORM_OWNED_EVENTS from
  // 2026-11-08 to 2026-11-14 on the reasoning that Bridge measures playtime itself, and the
  // cost is on the record: across 673 sessions of the 2026-11 sandbox test the game's own
  // `session_end` arrived ONCE, so the archive has no duration the game measured at all
  // (`data/playgama-sandbox-2026-11/`). Unlike `session_end`, `active_time` does not ride
  // `pagehide` — it is cumulative and sent while the visit grows — so it is the only ruler of
  // ours that survives a portal frame being torn down. Dropping it again would be silent: the
  // event would keep being produced and the console would simply never show a column.
  it('forwards active_time — the only duration of ours that survives a torn-down frame', () => {
    const sent: [string, unknown][] = [];
    bridgeSender({ track: (e, d) => void sent.push([e, d]) })(
      batch([{ name: 'active_time', at: 2, props: { active_s: 60 } }]),
    );
    expect(sent).toEqual([['active_time', { active_s: 60, build: 'unknown', locale: 'de' }]]);
    expect(PLATFORM_OWNED_EVENTS.has('active_time')).toBe(false);
  });

  it('sends nothing for an empty batch', () => {
    const sent: unknown[] = [];
    bridgeSender({ track: () => void sent.push(1) })(batch([]));
    expect(sent).toEqual([]);
  });

  it('carries attention on every event when given, and nothing when it is null', () => {
    const sent: Record<string, unknown>[] = [];
    let att: { focus: boolean; input: boolean } | null = null;
    const send = bridgeSender({ track: (_e, d) => void sent.push(d ?? {}) }, () => att);
    send(batch([{ name: 'run_start', at: 1 }]));
    att = { focus: false, input: true };
    send(batch([{ name: 'first_input', at: 2, props: { kind: 'pointer' } }]));
    expect(sent[0]).not.toHaveProperty('focus');
    expect(sent[1]).toEqual({ kind: 'pointer', focus: false, input: true, build: 'unknown', locale: 'de' });
  });
});
