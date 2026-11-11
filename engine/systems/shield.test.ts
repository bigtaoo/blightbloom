import { describe, it, expect } from 'vitest';
import { createGameState, type GameState } from '@dd/engine/state/GameState';
import { StatusEffectSystem } from '@dd/engine/systems';
import { SHIELD_REGEN_DELAY, SHIELD_REGEN_INTERVAL } from '@dd/engine/config';
import { BURN_DURATION } from '@dd/engine/content/damage';
import { SKIN_DEFS } from '@dd/engine/content/skins';
import { takeDamage } from './combat';

const CFG = { seed: 3, worldW: 800, worldH: 800, waves: [] as const };

/** Advance StatusEffectSystem `n` times, keeping state.tick moving (DoT cadence). */
function idle(sys: StatusEffectSystem, s: GameState, n: number): void {
  for (let i = 0; i < n; i++) {
    s.tick++;
    sys.tick(s);
  }
}

describe('two-pool health — takeDamage shield-first absorb (design/07)', () => {
  it('soaks damage on the shield before hp, resetting the idle timer', () => {
    const s = createGameState(CFG);
    const p = s.players[0]!;
    p.ticksSinceHit = 50;
    takeDamage(s, p, 2, 'enemy', 'physical');
    expect(p.shield).toBe(p.maxShield - 2);
    expect(p.hp).toBe(p.maxHp); // hp untouched while shield remains
    expect(p.ticksSinceHit).toBe(0);
    const hit = s.events.find((e) => e.type === 'hit');
    expect(hit && 'shieldRemaining' in hit && hit.shieldRemaining).toBe(p.maxShield - 2);
  });

  it('overflows the remainder to hp and emits shield_break exactly on depletion', () => {
    const s = createGameState(CFG);
    const p = s.players[0]!;
    p.shield = 2;
    takeDamage(s, p, 5, 'enemy', 'physical'); // 2 to shield, 3 overflow to hp
    expect(p.shield).toBe(0);
    expect(p.hp).toBe(p.maxHp - 3);
    expect(s.events.filter((e) => e.type === 'shield_break')).toHaveLength(1);
  });

  it('no shield_break when there was no shield to begin with', () => {
    const s = createGameState(CFG);
    const p = s.players[0]!;
    p.shield = 0;
    takeDamage(s, p, 1, 'enemy', 'physical');
    expect(s.events.some((e) => e.type === 'shield_break')).toBe(false);
  });
});

describe('two-pool health — idle shield regen (design/07)', () => {
  const sys = new StatusEffectSystem();

  /** The smallest dungeon that carries a config — only `shieldRegenDelay` is read here. */
  const dungeon = (shieldRegenDelay?: number): GameState =>
    createGameState({
      ...CFG,
      dungeon: {
        config: {
          biomeId: 't',
          nameKey: 't',
          floorCount: 1,
          roomsPerFloor: { min: 1, max: 1 },
          pieceTags: ['t'],
          layout: 'linear',
          extractionPieceId: 't_extract',
          bossPieceId: 't_boss',
          difficultyCurve: { base: 1, perFloor: 1 },
          ...(shieldRegenDelay === undefined ? {} : { shieldRegenDelay }),
        },
        library: [],
      },
    });

  it('does not regen before the delay, then refills +1 at the delay boundary', () => {
    const s = createGameState(CFG);
    const p = s.players[0]!;
    p.shield = 1; // room to regen
    idle(sys, s, SHIELD_REGEN_DELAY - 1);
    expect(p.shield).toBe(1); // still within the delay window
    idle(sys, s, 1); // crosses the delay boundary
    expect(p.shield).toBe(2);
  });

  it('refills once per interval and never exceeds maxShield', () => {
    const s = createGameState(CFG);
    const p = s.players[0]!;
    p.shield = 0;
    idle(sys, s, SHIELD_REGEN_DELAY); // +1 at the delay
    expect(p.shield).toBe(1);
    idle(sys, s, SHIELD_REGEN_INTERVAL); // +1 one interval later
    expect(p.shield).toBe(2);
    // Run long past full — it caps at maxShield.
    idle(sys, s, SHIELD_REGEN_INTERVAL * (p.maxShield + 2));
    expect(p.shield).toBe(p.maxShield);
  });

  it("a dungeon's own shieldRegenDelay replaces the global one (chapter 1, 2026-11-11)", () => {
    // Chapter 1 halves the gate to 45 ticks because its killers are chip damage: a player
    // who stays in the room never waits out 90 unhit ticks and collects nothing back.
    const short = 45;
    const s = dungeon(short);
    const p = s.players[0]!;
    p.shield = 0;
    idle(sys, s, short - 1);
    expect(p.shield, 'regen must not start one tick early').toBe(0);
    idle(sys, s, 1);
    expect(p.shield).toBe(1);
    // The INTERVAL is untouched by the override — only the gate in front of it moved.
    idle(sys, s, SHIELD_REGEN_INTERVAL);
    expect(p.shield).toBe(2);
    // The control: the same state WITHOUT the field is still waiting at that tick.
    const plain = dungeon();
    const q = plain.players[0]!;
    q.shield = 0;
    expect(short).toBeLessThan(SHIELD_REGEN_DELAY); // the control's control
    idle(sys, plain, short);
    expect(q.shield, 'a config without the field must still be waiting on the global delay').toBe(0);
    idle(sys, plain, SHIELD_REGEN_DELAY - short);
    expect(q.shield).toBe(1);
  });

  it('a lingering DoT resets the timer, suppressing regen while the status persists', () => {
    const s = createGameState(CFG);
    const p = s.players[0]!;
    p.shield = 0;
    // A burn kept alive longer than the regen delay (naturally BURN_DURATION < DELAY,
    // so hold it artificially to prove the SUPPRESSION, not just the short duration).
    p.status.burnTicks = SHIELD_REGEN_DELAY * 3;
    p.status.burnDmg = 1;
    // Idle well past the delay: a DoT lands every DOT_INTERVAL and zeroes ticksSinceHit,
    // so it never reaches the delay boundary — without that reset it would regen at DELAY.
    idle(sys, s, SHIELD_REGEN_DELAY * 2);
    expect(p.shield).toBe(0); // never regenerated while burning
    expect(p.ticksSinceHit).toBeLessThan(SHIELD_REGEN_DELAY); // kept below the threshold
  });

  it('INVARIANT: a full shield pool refills inside a plausible between-rooms pause (ENGINE_VERSION 41)', () => {
    // Everything above tests the regen MECHANISM against whatever the constants happen
    // to be, so it passes at any interval — including the ~10s one that made the shield
    // effectively single-use across a PvE run (design/05 "Room encounter budget": a
    // character refilled 3.2 shield in ~32s while a room takes ~8s to clear and the next
    // is seconds away, so a 37-enemy floor was fought on one 9.2-point pool). This pins
    // the DESIGN INTENT instead — shield is the renewable half of the two-pool split
    // (design/07) — and it is derived from content, so a character gaining a bigger
    // shield pool re-checks the claim rather than silently invalidating it.
    const BETWEEN_ROOMS_TICKS = 30 * 15; // 15s: clear a room, walk to the next door
    const biggestPool = Math.max(...Object.values(SKIN_DEFS).map((d) => d.maxShield));
    const ticksToFull = SHIELD_REGEN_DELAY + SHIELD_REGEN_INTERVAL * Math.ceil(biggestPool - 1);
    expect(ticksToFull, `${ticksToFull} ticks to refill ${biggestPool} shield`).toBeLessThanOrEqual(BETWEEN_ROOMS_TICKS);

    // And prove it end-to-end for the real starter character, not just arithmetically.
    const s = createGameState(CFG);
    const p = s.players[0]!;
    p.shield = 0;
    idle(sys, s, BETWEEN_ROOMS_TICKS);
    expect(p.shield).toBe(p.maxShield);
  });

  it('a DoT tick is absorbed shield-first (a shield soaks a burn)', () => {
    const s = createGameState(CFG);
    const p = s.players[0]!;
    p.shield = p.maxShield;
    p.status.burnTicks = BURN_DURATION;
    p.status.burnDmg = 1;
    const s0 = p.shield;
    // Step to the next DoT-cadence tick so the burn lands.
    idle(sys, s, 60);
    expect(p.shield).toBeLessThan(s0); // shield took the burn
    expect(p.hp).toBe(p.maxHp); // hp still full
  });
});
