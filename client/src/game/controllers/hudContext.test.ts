/**
 * The HUD context mapping (split out of `GameLoop.updateHud`, 2026-09-15).
 *
 * Every field here is an answer the loop gives on the HUD's behalf, and three of them are
 * CONDITIONAL — `showAlly`, `canSaveReplay` and `touch` — which is the whole reason this is
 * worth its own suite: a conditional whose line runs every frame while only one arm is ever
 * exercised is exactly the branch-coverage shape CLAUDE.md calls the column that bites. Each
 * one is pinned from both sides below.
 */
import { describe, it, expect } from 'vitest';
import type { CoopSession } from '../../net/CoopSession';
import { buildHudContext, type HudContextHost, type HudContextInput } from './hudContext';

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

const input = (active: boolean): HudContextInput => ({ getTouchVisual: () => ({ active }) });

describe('buildHudContext — the straight-through fields', () => {
  it('copies the seat, score and skins as the host reports them', () => {
    const ctx = buildHudContext(
      host({ localOwner: 1, currentScore: () => 42, selectedSkinId: () => 'skirmisher', allySkinId: () => 'vanguard' }),
      input(false),
    );
    expect(ctx.localOwner).toBe(1);
    expect(ctx.score).toBe(42);
    expect(ctx.selectedSkin).toBe('skirmisher');
    expect(ctx.allySkinId).toBe('vanguard');
  });

  it('passes the session seat names through, and undefined with no session', () => {
    const names = { 0: 'ana' } as unknown as CoopSession['seatNames'];
    expect(buildHudContext(host({ getSession: () => ({ seatNames: names }) as CoopSession }), input(false)).seatNames)
      .toBe(names);
    expect(buildHudContext(host(), input(false)).seatNames).toBeUndefined();
  });
});

describe('buildHudContext — showAlly', () => {
  it('is true for co-op and for the arena demo harness, false for a plain solo run', () => {
    expect(buildHudContext(host({ isCoop: () => true }), input(false)).showAlly).toBe(true);
    expect(buildHudContext(host({ isArenaDemo: () => true }), input(false)).showAlly).toBe(true);
    expect(buildHudContext(host(), input(false)).showAlly).toBe(false);
  });
});

describe('buildHudContext — canSaveReplay', () => {
  it('is true only offline and only while not watching a recording', () => {
    // Both refusals matter and they are different: an online match's record is the server's
    // confirmed stream, and a replay-driven session is already replaying somebody else's file.
    expect(buildHudContext(host(), input(false)).canSaveReplay).toBe(true);
    expect(buildHudContext(host({ isOnline: () => true }), input(false)).canSaveReplay).toBe(false);
    expect(buildHudContext(host({ replayStopTick: () => 120 }), input(false)).canSaveReplay).toBe(false);
  });
});

describe('buildHudContext — touch', () => {
  it('mirrors the live touch-control state', () => {
    // The chest caption names a DIFFERENT control off this flag, so a stuck answer here means a
    // phone player being told to press a key it does not have (`ui/ChestPrompt.ts`).
    expect(buildHudContext(host(), input(true)).touch).toBe(true);
    expect(buildHudContext(host(), input(false)).touch).toBe(false);
  });
});
