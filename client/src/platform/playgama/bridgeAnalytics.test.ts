/**
 * `bridgeSender` — a batch becomes one Bridge event per analytics event, each carrying the
 * visit's ids, because a platform event stream has no envelope to hold them.
 */
import { describe, expect, it } from 'vitest';
import { bridgeSender } from './bridgeAnalytics';
import type { AnalyticsBatch } from '../../net/analyticsEvents';

describe('bridgeSender', () => {
  it('sends each event with its props and the envelope fields', () => {
    const sent: [string, unknown][] = [];
    const send = bridgeSender({ track: (e, d) => void sent.push([e, d]) });
    const batch: AnalyticsBatch = {
      install: 'i1',
      session: 's1',
      host: 'playgama',
      build: 'unknown',
      locale: 'de',
      sentAt: 10,
      events: [
        { name: 'session_start', at: 1 },
        { name: 'run_end', at: 2, props: { outcome: 'loss', floor: 3 } },
      ],
    };
    send(batch);
    const env = { install: 'i1', session: 's1', build: 'unknown', locale: 'de' };
    expect(sent).toEqual([
      ['session_start', env],
      ['run_end', { outcome: 'loss', floor: 3, ...env }],
    ]);
  });

  it('sends nothing for an empty batch', () => {
    const sent: unknown[] = [];
    bridgeSender({ track: () => void sent.push(1) })({
      install: 'i', session: 's', host: 'playgama', build: 'b', locale: 'en', sentAt: 0, events: [],
    });
    expect(sent).toEqual([]);
  });
});
