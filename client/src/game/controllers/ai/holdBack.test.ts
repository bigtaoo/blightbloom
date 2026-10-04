/**
 * `holdBack.ts` (2026-10-04): the co-op ally fights only in its own room or its leader's, from
 * 7.5 grid off. The floor is `dungeonRoute.test.ts`'s L of three rooms, no walls drawn:
 *
 *   A (0..10, 0..10) -door x10..12, y4..6- B (12..22, 0..10)
 *                                          |  door x16..18, y10..12
 *                                          C (12..22, 12..22)
 */
import { describe, it, expect } from 'vitest';
import { Button, createGameState, FP_SCALE, type AABB, type GameState, type RoomRect } from '@dd/engine';
import { BRAD_FULL } from '@dd/engine/math/trig';
import { WEAPON_SIM_BY_ID } from '@dd/engine/content/weapons';
import { enemiesInReach, holdBackFight, HOLD_BACK_FP } from './holdBack';
import { engageNearest, FIRE_RANGE_FP } from './engage';

const fp = (grid: number) => grid * FP_SCALE;
const px = (grid: number) => grid * 32;
const rect = (x: number, y: number, w: number, h: number) => ({ x: fp(x), y: fp(y), w: fp(w), h: fp(h) }) as AABB;
const at = (gx: number, gy: number) => ({ gx: fp(gx), gy: fp(gy) });

/** The ally (seat 1) at `me`, its leader (seat 0) at `leader`, on the three-room floor. */
function floor(me: [number, number], leader: [number, number]): GameState {
  const s = createGameState({ seed: 1, worldW: 800, worldH: 800, waves: [], players: [{ start: [px(leader[0]), px(leader[1])] }, { start: [px(me[0]), px(me[1])] }] });
  s.dungeonRoomRects.push(...([
    { id: 'A', rect: rect(0, 0, 10, 10) },
    { id: 'B', rect: rect(12, 0, 10, 10) },
    { id: 'C', rect: rect(12, 12, 10, 10) },
  ] as RoomRect[]));
  const door = (roomA: string, roomB: string, x: number, y: number, w: number, h: number) =>
    ({ door: { roomA, roomB, passageGrid: { x, y, w, h } }, passageAabb: rect(x, y, w, h), locked: false }) as never;
  s.dungeonDoors.push(door('A', 'B', 10, 4, 2, 2), door('B', 'C', 16, 10, 2, 2));
  return s;
}

/** The move's heading as a unit vector (+y is south). */
const heading = (brad: number) => ({ x: Math.cos((brad / BRAD_FULL) * 2 * Math.PI), y: Math.sin((brad / BRAD_FULL) * 2 * Math.PI) });

describe('enemiesInReach — the ally’s room and its leader’s, nothing further', () => {
  it('keeps an enemy in either seat’s room and drops one in a third room', () => {
    const s = floor([2, 5], [14, 5]); // ally in A, leader in B
    const inA = at(8, 5), inB = at(20, 5), inC = at(17, 17);
    expect(enemiesInReach(s, s.players[1]!, s.players[0]!, [inA, inB, inC])).toEqual([inA, inB]);
  });

  it('with no leader, only the ally’s own room', () => {
    const s = floor([2, 5], [14, 5]);
    expect(enemiesInReach(s, s.players[1]!, undefined, [at(8, 5), at(20, 5)])).toEqual([at(8, 5)]);
  });

  it('in a doorway, only an enemy already in fire range', () => {
    const s = floor([11, 5], [2, 5]); // ally in the A–B door, in no room's rect
    const near = at(20, 5); // 9 grid off, in B
    const far = at(17, 21); // in C, past fire range
    expect(Math.hypot(far.gx - fp(11), far.gy - fp(5))).toBeGreaterThan(FIRE_RANGE_FP);
    expect(enemiesInReach(s, s.players[1]!, s.players[0]!, [near, far])).toEqual([near]);
  });

  it('with no room layout (an arena) every enemy counts, as before', () => {
    const s = createGameState({ seed: 1, worldW: 800, worldH: 800, waves: [], players: [{ start: [0, 0] }, { start: [32, 0] }] });
    const all = [at(2, 2), at(20, 20)];
    expect(enemiesInReach(s, s.players[1]!, s.players[0]!, all)).toEqual(all);
  });
});

describe('holdBackFight — the standoff band', () => {
  it('nothing in reach is null, so the caller regroups', () => {
    const s = floor([2, 5], [4, 5]); // both in A
    expect(holdBackFight(s, 1, 5, s.players[1]!, s.players[0]!, [at(17, 17)])).toBeNull();
    // Control: the old fight chases the same enemy two rooms on.
    expect(engageNearest(1, 5, s.players[1]!, [at(17, 17)])).not.toBeNull();
  });

  it('stands still and fires inside the band', () => {
    const s = floor([1, 5], [1, 2]);
    const cmd = holdBackFight(s, 1, 5, s.players[1]!, s.players[0]!, [{ gx: fp(1) + HOLD_BACK_FP, gy: fp(5) }])!;
    expect(cmd.moveMag).toBe(0);
    expect(cmd.buttons & Button.FIRE).toBeTruthy();
  });

  it('backs away from an enemy inside the band, still firing', () => {
    const s = floor([4, 5], [1, 2]);
    const cmd = holdBackFight(s, 1, 5, s.players[1]!, s.players[0]!, [at(7, 5)])!;
    expect(cmd.moveMag).toBeGreaterThan(0);
    expect(heading(cmd.moveBrad).x).toBeLessThan(-0.9); // west, away from it
    expect(cmd.buttons & Button.FIRE).toBeTruthy();
  });

  it('closes on an enemy past fire range without firing', () => {
    const s = floor([13, 1], [13, 2]); // both in B, the enemy in its far corner
    s.dungeonRoomRects[1] = { id: 'B', rect: rect(12, 0, 20, 20) } as RoomRect; // a big room
    const cmd = holdBackFight(s, 1, 5, s.players[1]!, s.players[0]!, [at(30, 18)])!;
    expect(cmd.moveMag).toBeGreaterThan(0);
    expect(cmd.buttons & Button.FIRE).toBe(0);
  });

  it('walks to a target in the leader’s room through the door, not through the wall', () => {
    const s = floor([16, 5], [17, 16]); // ally in B, leader in C, enemy in C's far corner
    const cmd = holdBackFight(s, 1, 5, s.players[1]!, s.players[0]!, [at(21, 21)])!;
    expect(cmd.moveMag).toBeGreaterThan(0);
    // The B–C door is at x16..18 on y10..12: due south of the ally, not the target's south-east.
    expect(heading(cmd.moveBrad).y).toBeGreaterThan(0.9);
  });

  it('a blade in hand keeps the old close-in shape: it holds inside 4 grid', () => {
    const s = floor([4, 5], [1, 2]);
    const me = s.players[1]!;
    me.weapon = { ...me.weapon!, spec: WEAPON_SIM_BY_ID.saber! } as never;
    const cmd = holdBackFight(s, 1, 5, me, s.players[0]!, [at(7, 5)])!;
    expect(cmd.moveMag).toBe(0);
    // Control: the same spot with the gun backs off.
    const gun = floor([4, 5], [1, 2]);
    expect(holdBackFight(gun, 1, 5, gun.players[1]!, gun.players[0]!, [at(7, 5)])!.moveMag).toBeGreaterThan(0);
  });
});
