/**
 * `ai/roam.ts` (2026-10-08): the co-op ally's quiet-room wander. The floor is `dungeonRoute.test`'s
 * L of three rooms, no walls drawn:
 *
 *   A (0..10, 0..10) -door x10..12, y4..6- B (12..22, 0..10)
 *                                          |  door x16..18, y10..12
 *                                          C (12..22, 12..22)
 */
import { describe, it, expect } from 'vitest';
import { createGameState, FP_SCALE, type AABB, type GameState, type RoomRect } from '@dd/engine';
import { createGameEngine } from '@dd/engine/GameEngine';
import { makeCommand } from '@dd/engine/state/input';
import { BRAD_FULL, type Brad } from '@dd/engine/math/trig';
import { LEASH_FP, POST_MAX_FP, POST_MIN_FP, ROAM_PERIOD_TICKS, STROLL_MAG, roamMove, roamPost } from './roam';
import { AllyController } from '../AllyController';

const fp = (grid: number) => grid * FP_SCALE;
const rect = (x: number, y: number, w: number, h: number) => ({ x: fp(x), y: fp(y), w: fp(w), h: fp(h) }) as AABB;

function floor(): GameState {
  const s = createGameState({ seed: 1, worldW: 800, worldH: 800, waves: [] });
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

function heading(m: { moveBrad: number }): { x: number; y: number } {
  const a = (m.moveBrad / BRAD_FULL) * 2 * Math.PI;
  return { x: Math.cos(a), y: Math.sin(a) };
}

const dist = (a: { gx: number; gy: number }, b: { gx: number; gy: number }) => Math.hypot(a.gx - b.gx, a.gy - b.gy);
const PERIODS = 300;
const tickOf = (period: number) => period * ROAM_PERIOD_TICKS + 1;

describe('roamPost — where the ally means to be', () => {
  const leader = { gx: fp(17), gy: fp(5) }; // the middle of B

  it('is always inside the leader’s room, clear of its walls, and within the post ring of the leader', () => {
    const s = floor();
    let picked = 0;
    for (let p = 0; p < PERIODS; p++) {
      const post = roamPost(s, 1, leader, tickOf(p));
      if (!post) continue;
      picked++;
      expect(post.gx, `period ${p}`).toBeGreaterThanOrEqual(fp(14));
      expect(post.gx, `period ${p}`).toBeLessThanOrEqual(fp(20));
      expect(post.gy, `period ${p}`).toBeGreaterThanOrEqual(fp(2));
      expect(post.gy, `period ${p}`).toBeLessThanOrEqual(fp(8));
      expect(dist(post, leader), `period ${p}`).toBeLessThanOrEqual(POST_MAX_FP + 1);
      expect(dist(post, leader), `period ${p}`).toBeGreaterThanOrEqual(POST_MIN_FP - 1);
    }
    expect(picked).toBeGreaterThan(0);
  });

  it('with the leader in a corner, still finds spots — off their feet, inside the walls', () => {
    // Live, 2026-10-08: a leader 3 grid into a 15x15 room's corner. Clamping a ring spot inside
    // the walls landed most of them on the leader, and the ally milled round their feet.
    const s = floor();
    const corner = { gx: fp(13), gy: fp(1) }; // B's north-west corner, inside its 2-grid inset
    let picked = 0;
    for (let p = 0; p < PERIODS; p++) {
      const post = roamPost(s, 1, corner, tickOf(p));
      if (!post) continue;
      picked++;
      expect(dist(post, corner)).toBeGreaterThanOrEqual(POST_MIN_FP - 1);
      expect(post.gx).toBeGreaterThanOrEqual(fp(14));
      expect(post.gy).toBeGreaterThanOrEqual(fp(2));
    }
    expect(picked / PERIODS).toBeGreaterThan(0.5); // it roams there too, not just rests
  });

  it('rests about one period in three, and moves on most of the rest — not one spot forever', () => {
    const s = floor();
    const posts = Array.from({ length: PERIODS }, (_, p) => roamPost(s, 1, leader, tickOf(p)));
    const rests = posts.filter((p) => p === null).length;
    expect(rests / PERIODS).toBeGreaterThan(0.2);
    expect(rests / PERIODS).toBeLessThan(0.45);
    const distinct = new Set(posts.filter((p) => p).map((p) => `${p!.gx},${p!.gy}`));
    expect(distinct.size).toBeGreaterThan(PERIODS / 3);
  });

  it('holds one spot for a whole period, and is a pure function of its inputs', () => {
    const s = floor();
    for (let p = 0; p < 20; p++) {
      const first = roamPost(s, 1, leader, p * ROAM_PERIOD_TICKS);
      expect(roamPost(s, 1, leader, p * ROAM_PERIOD_TICKS + ROAM_PERIOD_TICKS - 1)).toEqual(first);
      expect(roamPost(floor(), 1, leader, p * ROAM_PERIOD_TICKS)).toEqual(first);
    }
  });

  it('two allies in one squad do not pick the same spots', () => {
    const s = floor();
    let same = 0;
    for (let p = 0; p < PERIODS; p++) if (JSON.stringify(roamPost(s, 1, leader, tickOf(p))) === JSON.stringify(roamPost(s, 2, leader, tickOf(p)))) same++;
    expect(same / PERIODS).toBeLessThan(0.2); // both resting is the only way to agree
  });

  it('with no room layout (an arena), a spot on the ring round the leader', () => {
    const s = createGameState({ seed: 1, worldW: 1600, worldH: 1200, waves: [] });
    for (let p = 0; p < PERIODS; p++) {
      const post = roamPost(s, 1, leader, tickOf(p));
      if (!post) continue;
      const d = dist(post, leader);
      expect(d).toBeGreaterThanOrEqual(POST_MIN_FP - 1);
      expect(d).toBeLessThanOrEqual(POST_MAX_FP + 1);
    }
  });
});

describe('roamMove — the quiet-room move', () => {
  const firstPeriod = (s: GameState, leader: { gx: number; gy: number }, wantRest: boolean) => {
    for (let p = 0; p < PERIODS; p++) if ((roamPost(s, 1, leader, tickOf(p)) === null) === wantRest) return tickOf(p);
    throw new Error('no such period');
  };

  it('walks back at full pace, through the door, when the leader is in another room', () => {
    const s = floor();
    const m = roamMove(s, 1, { gx: fp(5), gy: fp(5) }, { gx: fp(14), gy: fp(5) }, firstPeriod(s, { gx: fp(14), gy: fp(5) }, true));
    expect(m.moveMag).toBeGreaterThan(STROLL_MAG);
    expect(heading(m).x).toBeGreaterThan(0.95); // east, to the A–B door — even on a rest period
  });

  it('walks back at full pace past the leash in the leader’s own room', () => {
    const s = createGameState({ seed: 1, worldW: 1600, worldH: 1200, waves: [] });
    const me = { gx: fp(10), gy: fp(10) };
    const leader = { gx: me.gx + LEASH_FP + fp(1), gy: me.gy };
    const m = roamMove(s, 1, me, leader, firstPeriod(s, leader, true));
    expect(m.moveMag).toBeGreaterThan(STROLL_MAG);
    expect(heading(m).x).toBeGreaterThan(0.95);
  });

  it('inside the leash, rests on a rest period — it does not close on the leader', () => {
    const s = floor();
    const leader = { gx: fp(17), gy: fp(5) };
    expect(roamMove(s, 1, { gx: fp(13), gy: fp(8) }, leader, firstPeriod(s, leader, true)).moveMag).toBe(0);
  });

  it('inside the leash, strolls toward its spot on any other period', () => {
    const s = floor();
    const leader = { gx: fp(17), gy: fp(5) };
    let strolled = 0;
    for (let p = 0; p < 40; p++) {
      const tick = tickOf(p);
      const post = roamPost(s, 1, leader, tick);
      const me = { gx: fp(13), gy: fp(8) };
      if (!post || dist(me, post) < fp(2)) continue;
      const m = roamMove(s, 1, me, leader, tick);
      expect(m.moveMag).toBeGreaterThan(0);
      expect(m.moveMag).toBeLessThanOrEqual(STROLL_MAG);
      const h = heading(m);
      const want = { x: (post.gx - me.gx) / dist(me, post), y: (post.gy - me.gy) / dist(me, post) };
      expect(h.x * want.x + h.y * want.y, `period ${p}`).toBeGreaterThan(0.9);
      strolled++;
    }
    expect(strolled).toBeGreaterThan(5);
  });
});

describe('the ally through step(): a companion, not a shadow', () => {
  const idle = (t: number) => makeCommand({ owner: 0, tick: t, moveBrad: 0 as Brad, moveMag: 0, buttons: 0 });

  /** The ally's positions over `ticks` with its leader standing still at grid (12, 12), in one
   *  20x20 room. An arena with no enemy left is won on tick 1, so one is parked, disarmed, OUTSIDE
   *  the room — where it is nobody's fight (`enemiesInReach`) — and pinned there each tick. */
  function run(ally: AllyController, ticks: number) {
    const eng = createGameEngine({ seed: 3, worldW: 1600, worldH: 1200, waves: [[[1500, 1100]]], players: [{ start: [384, 384] }, { start: [404, 384] }] });
    eng.step([idle(1)]);
    eng.state.dungeonRoomRects.push({ id: 'R', rect: rect(2, 2, 20, 20) } as RoomRect);
    const trail: { gx: number; gy: number }[] = [];
    for (let t = 2; t <= ticks; t++) {
      const e = eng.state.enemies[0]!;
      Object.assign(e, { weapon: null, gx: fp(47), gy: fp(34) });
      eng.step([idle(t), ally.build(eng.state, 1, 0, t)]);
      trail.push({ gx: eng.state.players[1]!.gx, gy: eng.state.players[1]!.gy });
    }
    expect(eng.state.phase).toBe('playing');
    return { trail, leader: eng.state.players[0]! };
  }

  it('wanders round a still leader, inside the leash; the follow-only ally just stands by it', () => {
    const ticks = 12 * ROAM_PERIOD_TICKS;
    const roaming = run(new AllyController(), ticks);
    const cells = new Set(roaming.trail.map((p) => `${Math.round(p.gx / fp(2))},${Math.round(p.gy / fp(2))}`));
    expect(cells.size).toBeGreaterThan(5); // it went places
    for (const p of roaming.trail) expect(dist(p, roaming.leader)).toBeLessThanOrEqual(LEASH_FP);

    // Control: the follow-only ally, spawned inside 3 grid of a leader who never moves, never moves.
    const follower = run(new AllyController({ roams: false }), ticks);
    expect(new Set(follower.trail.map((p) => `${p.gx},${p.gy}`)).size).toBe(1);
  });
});
