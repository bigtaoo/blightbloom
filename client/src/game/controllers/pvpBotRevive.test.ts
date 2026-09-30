/**
 * PvpBotController's revive rule (volume 118) and `ai/revive.ts` behind it: the shipped bot
 * walks to a downed squadmate, holds the revive from well inside the reach, and fetches a floor
 * bandage first when an arena revive would find it without one. Each side is pinned: it acts when
 * it should, and holds off when it should not, since a rule that silently never fires reads in
 * the sims as "revives do nothing".
 */
import { describe, expect, it } from 'vitest';
import { Button, FP_SCALE, REVIVE_CHANNEL_TICKS, REVIVE_RANGE_GRID, createGameEngine, type GameState, type PlayerActor } from '@dd/engine';
import { toFpGrid } from '@dd/engine/content/convert';
import { buildPvpEngineConfig } from '../match/pvpConfig';
import { PvpBotController } from './PvpBotController';
import { BANDAGE_DETOUR_FP, REVIVE_DETOUR_FP, REVIVE_SNUG_FP, reviveGoal } from './ai/revive';

const G = FP_SCALE;
const REVIVE_RANGE_FP = toFpGrid(REVIVE_RANGE_GRID);

/** An eight-seat arena at the drop: seat 0 and a squadmate `gap` grid east of it, downed. */
function squad(gap: number, bandages = 1): { s: GameState; me: PlayerActor; mate: PlayerActor } {
  const s = createGameEngine(buildPvpEngineConfig(5, 8)).state;
  const me = s.players[0]!;
  const mate = s.players.find((p) => p !== me && p.teamId === me.teamId)!;
  Object.assign(mate, { gx: me.gx + gap * G, gy: me.gy, downed: true, hp: 0, bleedoutTicks: 900 });
  me.bandages = bandages;
  return { s, me, mate };
}
const interacts = (buttons: number) => (buttons & Button.INTERACT) !== 0;
/** A gap, in grid, inside the reach but short of snug. */
const edgeGap = () => (REVIVE_SNUG_FP + REVIVE_RANGE_FP) / 2 / G + (2 * squad(1).me.radius) / G;

describe('reviveGoal', () => {
  it('names the mate, in reach or not, and snug only well inside the reach', () => {
    const far = squad(6);
    expect(reviveGoal(far.s, far.me)).toMatchObject({ kind: 'mate', inReach: false, snug: false });
    const edge = squad(edgeGap());
    expect(reviveGoal(edge.s, edge.me)).toMatchObject({ inReach: true, snug: false });
    const near = squad(1);
    expect(reviveGoal(near.s, near.me)).toMatchObject({ inReach: true, snug: true });
  });

  it('passes over a rival, a mate beyond the detour, and every mate while it has no bandage', () => {
    const rival = squad(1);
    rival.mate.teamId = rival.me.teamId + 1;
    expect(reviveGoal(rival.s, rival.me)).toBeUndefined();
    const beyond = squad(REVIVE_DETOUR_FP / G + 1);
    expect(reviveGoal(beyond.s, beyond.me)).toBeUndefined();
    const broke = squad(1, 0);
    expect(reviveGoal(broke.s, broke.me)).toBeUndefined();
  });

  it('with no bandage, names a floor one within the detour', () => {
    const { s, me } = squad(1, 0);
    s.pickups.push({ id: 77, kind: 'bandage', gx: me.gx, gy: me.gy + 3 * G, spawnTick: 0, alive: true } as never);
    expect(reviveGoal(s, me)).toMatchObject({ kind: 'bandage', inReach: false, snug: false });
    s.pickups[s.pickups.length - 1]!.gy = (me.gy + BANDAGE_DETOUR_FP + G) as never;
    expect(reviveGoal(s, me)).toBeUndefined();
  });

  it('asks for no bandage outside the arena', () => {
    const { s, me } = squad(1, 0);
    (s as { zoneEnabled: boolean }).zoneEnabled = false;
    expect(reviveGoal(s, me)).toMatchObject({ kind: 'mate' });
  });
});

describe('PvpBotController — reviving a squadmate', () => {
  const bot = () => new PvpBotController();

  it('walks to the body, holds INTERACT once in reach, and stops once snug', () => {
    const walk = bot().build(squad(6).s, 0, 5);
    expect(walk.moveMag).toBeGreaterThan(0);
    expect(interacts(walk.buttons)).toBe(false);
    const closing = bot().build(squad(edgeGap()).s, 0, 5);
    expect(interacts(closing.buttons) && closing.moveMag > 0).toBe(true);
    const hold = bot().build(squad(1).s, 0, 5);
    expect(interacts(hold.buttons)).toBe(true);
    expect(hold.buttons & Button.FIRE).toBe(0); // the engine would hold it anyway
    expect(hold.moveMag).toBe(0);
  });

  it("does not start a channel under an opponent's clear shot, but holds one already running", () => {
    const { s, me, mate } = squad(1);
    const rival = s.players.find((p) => p.teamId !== me.teamId)!;
    Object.assign(rival, { gx: me.gx - 2 * G, gy: me.gy });
    const open = bot().build(s, 0, 5);
    expect(interacts(open.buttons)).toBe(false); // fights instead
    mate.reviveProgressTicks = 50;
    expect(interacts(bot().build(s, 0, 5).buttons)).toBe(true);
    // A body being revived by someone else, with this seat out of reach, is no reason to walk in.
    const far = squad(6);
    far.mate.reviveProgressTicks = 50;
    Object.assign(far.s.players.find((p) => p.teamId !== far.me.teamId)!, { gx: far.me.gx - 2 * G, gy: far.me.gy });
    expect(interacts(bot().build(far.s, 0, 5).buttons)).toBe(false);
    expect(bot().build(far.s, 0, 5)).toEqual(new PvpBotController({ revives: false }).build(far.s, 0, 5));
  });

  it('never revives with the rule off, or with no bandage in the arena', () => {
    expect(interacts(new PvpBotController({ revives: false }).build(squad(1).s, 0, 5).buttons)).toBe(false);
    expect(interacts(bot().build(squad(1, 0).s, 0, 5).buttons)).toBe(false);
  });

  it('walks to a floor bandage while nothing it aims at is in range', () => {
    const { s, me } = squad(1, 0);
    s.pickups.push({ id: 77, kind: 'bandage', gx: me.gx, gy: me.gy + 3 * G, spawnTick: 0, alive: true } as never);
    const cmd = bot().build(s, 0, 5);
    expect(cmd.moveMag).toBeGreaterThan(0);
    expect(cmd).not.toEqual(new PvpBotController({ revives: false }).build(s, 0, 5));
  });

  it('brings the mate back up in the engine, spending the bandage', () => {
    const engine = createGameEngine(buildPvpEngineConfig(5, 8));
    const s = engine.state as GameState;
    const me = s.players[0]!;
    const mate = s.players.find((p) => p !== me && p.teamId === me.teamId)!;
    Object.assign(mate, { gx: me.gx + 2 * G, gy: me.gy, downed: true, hp: 0, bleedoutTicks: 900 });
    me.bandages = 1;
    const reviver = bot();
    let revivedAt = -1;
    for (let t = 0; t < REVIVE_CHANNEL_TICKS + 60 && revivedAt < 0; t++) {
      // Every other seat stands idle: the channel measured alone.
      engine.step([reviver.build(s, 0, s.tick + 1)]);
      if (s.events.some((e) => e.type === 'revived' && e.id === mate.id)) revivedAt = t;
    }
    expect(revivedAt).toBeGreaterThanOrEqual(REVIVE_CHANNEL_TICKS - 1);
    expect(mate.downed).toBe(false);
    expect(me.bandages).toBe(0);
  });
});
