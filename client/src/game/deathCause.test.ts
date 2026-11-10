import { afterEach, describe, expect, it } from 'vitest';
import { ENEMY_BLUEPRINTS, buildEnemyActor, createGameEngine, createGameState, type GameEvent, type PlayerCommand } from '@dd/engine';
import { BURST_WINDOW_TICKS, deathReportProps, enemyTypeOf, noteDeathCauseEvents, resetDeathCause, type DeathCauseState } from './deathCause';

afterEach(() => resetDeathCause());

describe('enemyTypeOf — reading a blueprint type back off a live actor', () => {
  it('no two blueprints share the (tint, bodyRig, boss) signature the reverse lookup keys on', () => {
    const seen = new Map<string, string>();
    for (const [type, bp] of Object.entries(ENEMY_BLUEPRINTS)) {
      const sig = `${bp.tint}|${bp.bodyRig}|${bp.boss === true}`;
      expect(seen.get(sig), `${type} collides with ${seen.get(sig)}`).toBeUndefined();
      seen.set(sig, type);
    }
  });

  it('every blueprint, built by the engine factory, classifies back to its own type', () => {
    const s = createGameState({ seed: 1, worldW: 800, worldH: 800, playerStart: [400, 400], waves: [] });
    for (const type of Object.keys(ENEMY_BLUEPRINTS)) {
      expect(enemyTypeOf(buildEnemyActor(s, 0 as never, 0 as never, type)), type).toBe(type);
    }
  });

  it('a shape no blueprint has is "unknown", not the nearest guess', () => {
    expect(enemyTypeOf({ id: 1, tint: 0x123456 })).toBe('unknown');
  });
});

/** A hand-built state: one player of 10 HP + 6 shield, one room, two enemies. */
function fixture(): Required<DeathCauseState> {
  return {
    tick: 100,
    players: [{ id: 1, gx: 50, gy: 50, maxHp: 10, maxShield: 6 }],
    enemies: [
      { id: 7, tint: ENEMY_BLUEPRINTS.emberling!.tint },
      { id: 8, tint: ENEMY_BLUEPRINTS.brute!.tint, bodyRig: ENEMY_BLUEPRINTS.brute!.bodyRig },
    ],
    dungeonRoomRects: [{ id: 'r2_alcove', rect: { x: 0, y: 0, w: 100, h: 100 } }],
  };
}

const hit = (over: Partial<Extract<GameEvent, { type: 'hit' }>>): GameEvent =>
  ({ type: 'hit', target: 1, faction: 'enemy', gx: 0, gy: 0, damage: 2, damageType: 'physical', ...over }) as GameEvent;

describe('deathReportProps', () => {
  it('names the type of whoever landed the LAST hit, the room, and the hit count', () => {
    const s = fixture();
    noteDeathCauseEvents(s, 0, [hit({ by: 7 }), hit({ by: 8 })]);
    expect(deathReportProps(s, 0)).toMatchObject({ killer: 'brute', room: 'r2_alcove', hits: 2 });
  });

  it('remembers a shooter seen firing, so a bullet that lands after its shooter died still names it', () => {
    const s = fixture();
    noteDeathCauseEvents(s, 0, [{ type: 'bullet_fired', ownerId: 7, faction: 'enemy', gx: 0, gy: 0, facing: 0 } as GameEvent]);
    s.enemies = []; // compacted out by DeathDropsSystem
    noteDeathCauseEvents(s, 0, [hit({ by: 7 })]);
    expect(deathReportProps(s, 0).killer).toBe('emberling');
  });

  it('a shooter never seen alive is "unknown"', () => {
    const s = fixture();
    noteDeathCauseEvents(s, 0, [hit({ by: 99 })]);
    expect(deathReportProps(s, 0).killer).toBe('unknown');
  });

  it('names attacker-less hits by their source: hazard, rival player, or the element of a DoT', () => {
    const s = fixture();
    noteDeathCauseEvents(s, 0, [hit({ faction: 'environment' })]);
    expect(deathReportProps(s, 0).killer).toBe('environment');
    noteDeathCauseEvents(s, 0, [hit({ faction: 'player', by: 2 })]);
    expect(deathReportProps(s, 0).killer).toBe('player');
    noteDeathCauseEvents(s, 0, [hit({ damageType: 'fire' })]);
    expect(deathReportProps(s, 0).killer).toBe('fire_status');
  });

  it('ignores hits on anyone else, zero-damage hits, and friendly fire on enemies', () => {
    const s = fixture();
    noteDeathCauseEvents(s, 0, [hit({ target: 7, by: 1, faction: 'player' }), hit({ damage: 0, by: 8 })]);
    expect(deathReportProps(s, 0)).toEqual({});
  });

  it('burst_pct sums only the last five seconds, over the full HP + shield pool', () => {
    const s = fixture();
    noteDeathCauseEvents(s, 0, [hit({ damage: 8, by: 7 })]); // tick 100: outside the window below
    s.tick = 100 + BURST_WINDOW_TICKS;
    noteDeathCauseEvents(s, 0, [hit({ damage: 4, by: 7 })]);
    s.tick += 10;
    noteDeathCauseEvents(s, 0, [hit({ damage: 4, by: 8 })]);
    // 8 / 16 = 50% — the first 8 aged out exactly at the window edge.
    expect(deathReportProps(s, 0)).toMatchObject({ hits: 3, burst_pct: 50 });
  });

  it('keeps the last room seen when the player dies in a doorway gap no rect covers', () => {
    const s = fixture();
    noteDeathCauseEvents(s, 0, [hit({ by: 7 })]);
    s.players = [{ ...s.players[0]!, gx: 500 }];
    noteDeathCauseEvents(s, 0, [hit({ by: 7 })]);
    expect(deathReportProps(s, 0).room).toBe('r2_alcove');
  });

  it('sends nothing it does not have: no state, no seat, or a reset run', () => {
    noteDeathCauseEvents(null, 0, [hit({ by: 7 })]);
    noteDeathCauseEvents(fixture(), 3, [hit({ by: 7 })]);
    expect(deathReportProps(null, 0)).toEqual({});
    const s = fixture();
    noteDeathCauseEvents(s, 0, [hit({ by: 7 })]);
    resetDeathCause();
    expect(deathReportProps(s, 0)).toEqual({});
  });
});

describe('cause of death from a real engine run', () => {
  it('a player who never fights back is killed by a named blueprint, with the hits counted', () => {
    const eng = createGameEngine({
      seed: 3,
      worldW: 400,
      worldH: 400,
      playerStart: [200, 200],
      waves: [[[260, 200, 'emberling'], [140, 200, 'brute'], [200, 260, 'stalker']]],
    });
    let hitsOnPlayer = 0;
    for (let t = 1; eng.state.winner === null && t < 3000; t++) {
      const cmd = { type: 'input', owner: 0, tick: t, moveBrad: 0, moveMag: 0, buttons: 0, pickupTargetId: 0, cardVote: 0, shopBuyId: 0 };
      const events = eng.step([cmd as unknown as PlayerCommand]);
      const me = eng.state.players[0]!.id;
      hitsOnPlayer += events.filter((e) => e.type === 'hit' && e.target === me && e.damage > 0).length;
      noteDeathCauseEvents(eng.state, 0, events);
    }
    expect(eng.state.winner).toBe('enemies');
    const props = deathReportProps(eng.state, 0);
    expect(['emberling', 'brute', 'stalker', 'fire_status']).toContain(props.killer);
    expect(props.hits).toBe(hitsOnPlayer);
    expect(props.burst_pct).toBeGreaterThan(0);
  });
});
