/**
 * `muzzleDistance` (ENGINE_VERSION 79) — where a bullet is born along its aim ray. Each rule
 * is pinned on the side that must NOT pull the muzzle back as well as the side that must: an
 * over-eager rule would move the golden hash of every run with a mob near a player, which is
 * the only reason this change could stay out of the PvE scenarios.
 */
import { describe, expect, it } from 'vitest';
import { FP_SCALE, type Fp } from '@dd/engine/math/fixed';
import { cosFp, sinFp } from '@dd/engine/math/trig';
import { createGameEngine } from '@dd/engine/GameEngine';
import { createGameState, type GameState } from '@dd/engine/state/GameState';
import type { RangedSimSpec } from '@dd/engine/state/entities';
import { BLASTER_SIM, GYRE_SIM, LASERCUTTER_SIM } from '@dd/engine/content/weapons';
import { makeCommand } from '@dd/engine/state/input';
import { Button } from '@dd/engine/state/commands';
import { muzzleDistance } from './muzzle';

const G = FP_SCALE;
const CFG = { seed: 5, worldW: 1600, worldH: 1200, waves: [] as const };
const RIGHT = { cos: cosFp(0 as never), sin: sinFp(0 as never) };

/** A shooter on team 0 and one other body `dx`,`dy` grid away, on `team`. */
function pair(dx: number, dy = 0, team = 1): GameState {
  const s = createGameState({ ...CFG, players: [{ teamId: 0 }, { teamId: team }] });
  const [a, b] = s.players;
  b!.gx = (a!.gx + dx * G) as Fp;
  b!.gy = (a!.gy + dy * G) as Fp;
  return s;
}

const at = (s: GameState, spec: RangedSimSpec) => muzzleDistance(s, s.players[0]!, spec, RIGHT.cos, RIGHT.sin);

describe('muzzleDistance', () => {
  it('is the authored muzzle when nothing stands inside it', () => {
    expect(at(pair(6), BLASTER_SIM as RangedSimSpec)).toBe(BLASTER_SIM.muzzleOffset);
  });

  it('pulls back so the first step lands on a body closer than the muzzle', () => {
    const spec = BLASTER_SIM as RangedSimSpec;
    const s = pair(0.44);
    expect(at(s, spec)).toBe(Math.max(0, 440 - spec.bulletSpeed));
  });

  it('also covers a body just past the muzzle that the step would carry the bullet beyond', () => {
    const spec = BLASTER_SIM as RangedSimSpec;
    const along = spec.muzzleOffset + spec.bulletSpeed - 10;
    expect(at(pair(along / G), spec)).toBe(along - spec.bulletSpeed);
    // One the step reaches anyway is met in flight, as before.
    expect(at(pair((spec.muzzleOffset + spec.bulletSpeed + 10) / G), spec)).toBe(spec.muzzleOffset);
  });

  it('never goes behind the shooter, and ignores a body behind it', () => {
    const spec = BLASTER_SIM as RangedSimSpec;
    expect(at(pair(0.1), spec)).toBe(0);
    expect(at(pair(-0.44), spec)).toBe(spec.muzzleOffset);
  });

  it('ignores a teammate and a body the ray passes by', () => {
    const spec = BLASTER_SIM as RangedSimSpec;
    expect(at(pair(0.44, 0, 0), spec)).toBe(spec.muzzleOffset);
    const s = pair(0.44, 0);
    const reach = s.players[1]!.radius + spec.bulletRadius;
    expect(at(pair(0.44, (reach + 1) / G), spec)).toBe(spec.muzzleOffset);
    expect(at(pair(0.44, (reach - 1) / G), spec)).toBeLessThan(spec.muzzleOffset);
  });

  it('takes the nearest of two bodies on the ray', () => {
    const spec = BLASTER_SIM as RangedSimSpec;
    const s = createGameState({ ...CFG, players: [{ teamId: 0 }, { teamId: 1 }, { teamId: 2 }] });
    const [a, b, c] = s.players;
    b!.gx = (a!.gx + 700) as Fp;
    c!.gx = (a!.gx + 400) as Fp;
    b!.gy = c!.gy = a!.gy;
    expect(muzzleDistance(s, a!, spec, RIGHT.cos, RIGHT.sin)).toBe(Math.max(0, 400 - spec.bulletSpeed));
  });

  it('starts a beam AT the body (a beam never moves) and leaves an orbit alone', () => {
    const beam = LASERCUTTER_SIM as RangedSimSpec;
    expect(beam.ballistic).toBe('beam');
    expect(at(pair(0.44), beam)).toBe(440);
    const orbit = GYRE_SIM as RangedSimSpec;
    expect(orbit.ballistic).toBe('orbit');
    expect(at(pair(0.44), orbit)).toBe(orbit.muzzleOffset);
  });
});

describe('point-blank, end to end', () => {
  it('two hostile seats standing on each other take damage from their guns', () => {
    const engine = createGameEngine({ ...CFG, players: [{ teamId: 0, start: [400, 400] }, { teamId: 1, start: [414, 400] }] });
    const s = engine.state;
    const hp0 = s.players.map((p) => p.hp + p.shield);
    let hits = 0;
    for (let t = 1; t <= 30; t++) {
      engine.step([0, 1].map((owner) => makeCommand({ owner, tick: t, moveBrad: 0 as never, moveMag: 0, buttons: Button.FIRE })));
      hits += s.events.filter((e) => e.type === 'hit').length;
    }
    expect(Math.abs(s.players[1]!.gx - s.players[0]!.gx)).toBeLessThan(BLASTER_SIM.muzzleOffset);
    expect(hits).toBeGreaterThan(0);
    s.players.forEach((p, i) => expect(p.hp + p.shield, `seat ${i}`).toBeLessThan(hp0[i]!));
  });
});
