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

  it('drops the session signals Bridge records itself, and only those', () => {
    const sent: string[] = [];
    bridgeSender({ track: (e) => void sent.push(e) })(batch([
      { name: 'session_start', at: 1 },
      { name: 'active_time', at: 2, props: { active_s: 60 } },
      { name: 'run_start', at: 3 },
      { name: 'session_end', at: 4, props: { duration_s: 90, active_s: 61 } },
    ]));
    expect(sent).toEqual(['session_start', 'run_start']);
    expect([...PLATFORM_OWNED_EVENTS].sort()).toEqual(['active_time', 'session_end']);
  });

  it('sends nothing for an empty batch', () => {
    const sent: unknown[] = [];
    bridgeSender({ track: () => void sent.push(1) })(batch([]));
    expect(sent).toEqual([]);
  });
});
