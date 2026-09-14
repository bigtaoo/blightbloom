import { describe, it, expect } from 'vitest';
import { addFp } from '@dd/engine/math/fixed';
import type { Brad } from '@dd/engine/math/trig';
import { pxToFp } from '@dd/engine/content/convert';
import { BLASTER_SIM } from '@dd/engine/content/weapons';
import { createGameEngine } from '@dd/engine/GameEngine';
import type { GameState } from '@dd/engine/state/GameState';
import { Button, type PlayerCommand } from '@dd/engine/state/commands';

// A compact, order-sensitive snapshot of everything the determinism contract
// covers. Two engines on the same seed + command stream must produce byte-equal
// snapshots every tick — the Stage E golden-replay guarantee in miniature.
function snap(s: GameState): string {
  return JSON.stringify({
    tick: s.tick,
    phase: s.phase,
    winner: s.winner,
    players: s.players.map((p) => [p.id, p.gx, p.gy, p.z, p.hp, p.facing, p.alive]),
    enemies: s.enemies.map((e) => [e.id, e.gx, e.gy, e.hp, e.facing, e.alive]),
    projectiles: s.projectiles.map((b) => [b.id, b.gx, b.gy, b.vx, b.vy, b.faction, b.lifeTicks]),
    pickups: s.pickups.map((k) => [k.id, k.kind, k.gx, k.gy, k.spawnTick]),
  });
}

function cmd(tick: number, o: Partial<PlayerCommand> = {}): PlayerCommand {
  return {
    type: 'input',
    owner: 0,
    tick,
    moveBrad: (o.moveBrad ?? 0) as Brad,
    moveMag: o.moveMag ?? 0,
    buttons: o.buttons ?? 0,
    pickupTargetId: o.pickupTargetId ?? 0,
    cardVote: o.cardVote ?? 0,
    shopBuyId: o.shopBuyId ?? 0,
  };
}

const ARENA = {
  seed: 4242,
  worldW: 800,
  worldH: 800,
  playerStart: [400, 400] as const,
  waves: [
    [[500, 400] as const, [300, 400] as const],
    [[400, 300] as const],
  ],
};

describe('GameEngine determinism (design/08 contract)', () => {
  it('same seed + identical command stream → byte-equal state every tick', () => {
    const a = createGameEngine(ARENA);
    const b = createGameEngine(ARENA);
    for (let t = 1; t <= 400; t++) {
      // A deterministic, varied stream: rotating move direction, held fire.
      const c = cmd(t, { moveBrad: ((t * 337) & 0xffff) as Brad, moveMag: (t * 7) % 256, buttons: Button.FIRE });
      a.step([c]);
      b.step([{ ...c }]); // distinct object, same values
      expect(snap(b.state)).toBe(snap(a.state));
    }
  });
});

describe('GameEngine step order', () => {
  it('fire (step 3) reads THIS tick facing: a bullet spawns at the muzzle then moves', () => {
    const e = createGameEngine({ seed: 1, worldW: 800, worldH: 800, playerStart: [400, 400], waves: [] });
    e.step([cmd(1, { buttons: Button.FIRE })]); // no target, idle → default facing +x
    const b = e.state.projectiles[0]!;
    expect(b.faction).toBe('player');
    // spawned at player-centre + muzzleOffset, then advanced one tick by bulletSpeed
    // within the same step (both along +x); all in grid-fp now.
    expect(b.gx).toBe(addFp(addFp(pxToFp(400), BLASTER_SIM.muzzleOffset), BLASTER_SIM.bulletSpeed));
    expect(b.gy).toBe(pxToFp(400));
  });
});

describe('GameEngine end-to-end loop', () => {
  it('player clears the waves → victory', () => {
    const e = createGameEngine({
      seed: 9,
      worldW: 400,
      worldH: 400,
      playerStart: [200, 200],
      waves: [[[280, 200]]], // one enemy straight ahead at facing 0
    });
    let t = 0;
    while (e.state.winner === null && t < 600) {
      t++;
      e.step([cmd(t, { buttons: Button.FIRE })]);
    }
    expect(e.state.winner).toBe(0);
    expect(e.state.phase).toBe('gameover');
  });

  it('player never fights back → enemies win', () => {
    const e = createGameEngine({
      seed: 3,
      worldW: 400,
      worldH: 400,
      playerStart: [200, 200],
      waves: [[[260, 200], [140, 200], [200, 260], [200, 140]]], // surrounded
    });
    let t = 0;
    while (e.state.winner === null && t < 3000) {
      t++;
      e.step([cmd(t, { buttons: 0 })]); // idle: no fire, no move
    }
    expect(e.state.winner).toBe('enemies');
    expect(e.state.phase).toBe('gameover');
  });

  it('after gameover, step is a no-op that preserves events', () => {
    const e = createGameEngine({ seed: 1, worldW: 400, worldH: 400, playerStart: [200, 200], waves: [[[280, 200]]] });
    let t = 0;
    while (e.state.winner === null && t < 600) {
      t++;
      e.step([cmd(t, { buttons: Button.FIRE })]);
    }
    const tickAtWin = e.state.tick;
    const events = e.step([cmd(t + 1, { buttons: Button.FIRE })]);
    expect(e.state.tick).toBe(tickAtWin); // did not advance
    expect(events.some((ev) => ev.type === 'win')).toBe(true); // events preserved, not cleared
  });
});
