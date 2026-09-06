import { describe, it, expect } from 'vitest';
import { packReplayFile, type ReplayFile } from '@dd/engine';
import { loadReplayFile, replayStopTick } from './replayPlayback';

const file = (marks: { tick: number; note: string }[], ticks = 500): ReplayFile =>
  packReplayFile({
    config: { seed: 1, worldW: 800, worldH: 800, waves: [] },
    commands: [],
    ticks,
    label: 'dungeon',
    marks,
    recordedAtMs: 0,
  });

const fakeFetch = (body: string, ok = true, status = 200): typeof fetch =>
  (async () => ({ ok, status, text: async () => body })) as unknown as typeof fetch;

describe('replayStopTick (where playback holds)', () => {
  it('holds at the end of an unmarked recording', () => {
    expect(replayStopTick(file([]))).toBe(500);
  });

  it('holds at the mark — the moment the player said mattered', () => {
    expect(replayStopTick(file([{ tick: 321, note: 'hotkey' }]))).toBe(321);
  });

  it('holds at the LAST mark when there are several', () => {
    expect(replayStopTick(file([{ tick: 100, note: 'a' }, { tick: 400, note: 'b' }]))).toBe(400);
  });

  it('never holds past the recording, so a bad mark cannot idle the run forward', () => {
    expect(replayStopTick(file([{ tick: 9999, note: 'a' }]))).toBe(500);
  });

  it('ignores a zero/negative mark rather than freezing before tick 1', () => {
    expect(replayStopTick(file([{ tick: 0, note: 'a' }]))).toBe(500);
  });
});

describe('loadReplayFile', () => {
  it('fetches and parses a real file', async () => {
    const text = JSON.stringify(file([{ tick: 7, note: 'x' }]));
    const loaded = await loadReplayFile('/r.json', fakeFetch(text));
    expect(loaded.label).toBe('dungeon');
    expect(loaded.marks).toEqual([{ tick: 7, note: 'x' }]);
  });

  it('names the URL and the reason when the fetch fails', async () => {
    await expect(loadReplayFile('/nope.json', fakeFetch('', false, 404))).rejects.toThrow(
      /Could not load replay \/nope\.json: HTTP 404/,
    );
  });

  it('propagates the parser\'s own complaint about a foreign file', async () => {
    await expect(loadReplayFile('/x.json', fakeFetch('{"kind":"something else"}'))).rejects.toThrow(
      /Not a Blightbloom replay/,
    );
  });
});
