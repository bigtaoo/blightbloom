/**
 * The HUD context mapping (split out of `GameLoop.updateHud`, 2026-09-15).
 *
 * Every field here is an answer the loop gives on the HUD's behalf, and two of them are
 * CONDITIONAL — `showAlly` and `canSaveReplay` — which is the whole reason this is worth its
 * own suite: a conditional whose line runs every frame while only one arm is ever exercised is
 * exactly the branch-coverage shape CLAUDE.md calls the column that bites. Each is pinned from
 * both sides below. (A third, `touch`, lived here for one afternoon: the small chest's caption
 * named a control, and then the small chest stopped having one — `ui/ChestPrompt.ts`.)
 */
import { describe, it, expect } from 'vitest';
import type { CoopSession } from '../../net/CoopSession';
import { buildHudContext, type HudContextHost } from './hudContext';

const host = (over: Partial<HudContextHost> = {}): HudContextHost => ({
  localOwner: 0,
  isCoop: () => false,
  isArenaDemo: () => false,
  isOnline: () => false,
  currentScore: () => 0,
  selectedSkinId: () => 'vanguard',
  allySkinId: () => 'skirmisher',
  getSession: () => null,
  replayStopTick: () => null,
  ...over,
});

describe('buildHudContext — the straight-through fields', () => {
  it('copies the seat, score and skins as the host reports them', () => {
    const ctx = buildHudContext(
      host({ localOwner: 1, currentScore: () => 42, selectedSkinId: () => 'skirmisher', allySkinId: () => 'vanguard' }),
    );
    expect(ctx.localOwner).toBe(1);
    expect(ctx.score).toBe(42);
    expect(ctx.selectedSkin).toBe('skirmisher');
    expect(ctx.allySkinId).toBe('vanguard');
  });

  it('passes the session seat names through, and undefined with no session', () => {
    const names = { 0: 'ana' } as unknown as CoopSession['seatNames'];
    expect(buildHudContext(host({ getSession: () => ({ seatNames: names }) as CoopSession })).seatNames).toBe(names);
    expect(buildHudContext(host()).seatNames).toBeUndefined();
  });
});

describe('buildHudContext — showAlly', () => {
  it('is true for co-op and for the arena demo harness, false for a plain solo run', () => {
    expect(buildHudContext(host({ isCoop: () => true })).showAlly).toBe(true);
    expect(buildHudContext(host({ isArenaDemo: () => true })).showAlly).toBe(true);
    expect(buildHudContext(host()).showAlly).toBe(false);
  });
});

describe('buildHudContext — canSaveReplay', () => {
  it('is true only offline and only while not watching a recording', () => {
    // Both refusals matter and they are different: an online match's record is the server's
    // confirmed stream, and a replay-driven session is already replaying somebody else's file.
    expect(buildHudContext(host()).canSaveReplay).toBe(true);
    expect(buildHudContext(host({ isOnline: () => true })).canSaveReplay).toBe(false);
    expect(buildHudContext(host({ replayStopTick: () => 120 })).canSaveReplay).toBe(false);
  });
});
