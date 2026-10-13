import { describe, it, expect } from 'vitest';
import { SIM, pickupWouldApply, type PickupKind } from '@dd/engine';
import { createGameState, type GameState } from '@dd/engine/state/GameState';
import { PickupSystem } from '@dd/engine/systems/PickupSystem';
import { pxToFp } from '@dd/engine/content/convert';
import { freshStatus } from '@dd/engine/content/damage';
import { BASIC_ENEMY } from '@dd/engine/content/enemies';
import { toFp } from '@dd/engine/math/fixed';
import type { Brad } from '@dd/engine/math/trig';
import { ENEMY_TEAM_ID, type PickupItem, type PlayerActor } from '@dd/engine/state/entities';
import { fpToPx } from '../coords';
import {
  REFUSAL_HINT_COOLDOWN_TICKS,
  REFUSAL_HINT_SLACK_PX,
  RefusalHintTracker,
  pickupRefusalReason,
  withinRefusalHintRange,
} from './pickupRefusal';

const CFG = { seed: 1, worldW: 800, worldH: 600, waves: [] as const };

/** Every kind, as a Record so a new `PickupKind` is a compile error here until it is listed —
 *  which is what makes the parity sweep below cover it. */
const ALL_KINDS: Record<PickupKind, true> = {
  heal: true, material: true, coin: true, weapon: true, buff: true, crate: true, bandage: true,
  energy: true, schematic: true, character: true, shield: true, emp: true,
};

function world(): { s: GameState; p: PlayerActor } {
  const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
  return { s, p: s.players[0]! };
}

function drop(s: GameState, kind: PickupKind, xpx: number, ypx: number): PickupItem {
  const it: PickupItem = { id: s.nextId(), kind, gx: pxToFp(xpx), gy: pxToFp(ypx), spawnTick: -1, alive: true };
  s.pickups.push(it);
  return it;
}

function addEnemy(s: GameState, xpx: number, ypx: number): void {
  s.enemies.push({
    id: s.nextId(), faction: 'enemy', teamId: ENEMY_TEAM_ID,
    gx: pxToFp(xpx), gy: pxToFp(ypx), z: toFp(0), vx: toFp(0), vy: toFp(0),
    knockVx: toFp(0), knockVy: toFp(0),
    facing: 0 as Brad, hp: BASIC_ENEMY.maxHp, maxHp: BASIC_ENEMY.maxHp,
    shield: 0, maxShield: 0, ticksSinceHit: 0,
    radius: BASIC_ENEMY.radius, footprintRadius: BASIC_ENEMY.footprintRadius, solidRadius: BASIC_ENEMY.radius,
    alive: true, weapon: null, firing: false, status: freshStatus(), enraged: false, armorBroken: false, aggroed: false, holding: false,
  });
}

/** Every pool full, and the other way round: every pool short of its cap. */
function fill(p: PlayerActor, full: boolean): void {
  p.maxShield = Math.max(p.maxShield, 10);
  p.hp = full ? p.maxHp : p.maxHp - 1;
  p.energy = full ? p.maxEnergy : p.maxEnergy - 1;
  p.shield = full ? p.maxShield : p.maxShield - 1;
}

describe('pickupRefusalReason — agrees with the engine', () => {
  // The contract the whole hint rests on: a reason is given exactly when the engine would leave
  // the drop. Swept over every kind and both pool states, with and without an enemy in EMP range.
  it.each([false, true])('reason !== null ⇔ !pickupWouldApply, every kind (pools full: %s)', (full) => {
    for (const withEnemy of [false, true]) {
      const { s, p } = world();
      fill(p, full);
      if (withEnemy) addEnemy(s, 120, 100);
      for (const kind of Object.keys(ALL_KINDS) as PickupKind[]) {
        const it = drop(s, kind, 100, 100);
        expect(pickupRefusalReason(p, it, s) !== null, `${kind} enemy=${withEnemy}`).toBe(!pickupWouldApply(p, it, s));
      }
    }
  });

  it('names the pool that is full', () => {
    const { s, p } = world();
    fill(p, true);
    expect(pickupRefusalReason(p, drop(s, 'heal', 100, 100), s)).toBe('hpFull');
    expect(pickupRefusalReason(p, drop(s, 'energy', 100, 100), s)).toBe('energyFull');
    expect(pickupRefusalReason(p, drop(s, 'shield', 100, 100), s)).toBe('shieldFull');
    expect(pickupRefusalReason(p, drop(s, 'emp', 100, 100), s)).toBe('noTarget');
  });

  it('gives no reason once the pool has room, or for a kind that is never conditional', () => {
    const { s, p } = world();
    fill(p, false);
    addEnemy(s, 120, 100);
    for (const kind of ['heal', 'energy', 'shield', 'emp', 'weapon', 'material'] as const) {
      expect(pickupRefusalReason(p, drop(s, kind, 100, 100), s), kind).toBeNull();
    }
  });

  it('the screenshot case: the engine really leaves a full player\'s energy cell, and the hint fires for it', () => {
    const { s, p } = world();
    fill(p, true);
    const cell = drop(s, 'energy', 100, 100);
    s.tick = 5;
    new PickupSystem().tick(s);
    expect(cell.alive).toBe(true);
    expect(new RefusalHintTracker().update(s, p)).toEqual([{ item: cell, reason: 'energyFull' }]);
  });
});

describe('withinRefusalHintRange', () => {
  it('reaches the sim gate plus the slack, and no further', () => {
    const { s, p } = world();
    const reach = fpToPx((SIM.pickupRadius + p.radius) as typeof p.radius) + REFUSAL_HINT_SLACK_PX;
    expect(withinRefusalHintRange(p, drop(s, 'heal', 100 + reach - 0.5, 100))).toBe(true);
    expect(withinRefusalHintRange(p, drop(s, 'heal', 100, 100 + reach + 0.5))).toBe(false);
  });

  it('is wider than the sim gate itself — the drawn body floats above its ground point', () => {
    const { s, p } = world();
    const gate = fpToPx((SIM.pickupRadius + p.radius) as typeof p.radius);
    expect(withinRefusalHintRange(p, drop(s, 'heal', 100 + gate + 5, 100))).toBe(true);
  });
});

describe('RefusalHintTracker', () => {
  function setup() {
    const { s, p } = world();
    fill(p, true);
    const heal = drop(s, 'heal', 100, 100);
    return { s, p, heal, tr: new RefusalHintTracker() };
  }

  it('announces once on arrival, not on every tick spent standing there', () => {
    const { s, p, heal, tr } = setup();
    expect(tr.update(s, p)).toEqual([{ item: heal, reason: 'hpFull' }]);
    s.tick++;
    expect(tr.update(s, p)).toEqual([]);
  });

  it('standing on it longer than the cooldown still does not repeat it', () => {
    const { s, p, tr } = setup();
    tr.update(s, p);
    for (let i = 0; i < REFUSAL_HINT_COOLDOWN_TICKS * 2; i++) {
      s.tick++;
      expect(tr.update(s, p)).toEqual([]);
    }
  });

  it('leaving and coming back inside the cooldown stays quiet; after it, announces again', () => {
    const { s, p, heal, tr } = setup();
    tr.update(s, p);
    p.gx = pxToFp(400);
    s.tick++;
    expect(tr.update(s, p)).toEqual([]);
    p.gx = pxToFp(100);
    s.tick++;
    expect(tr.update(s, p)).toEqual([]);
    p.gx = pxToFp(400);
    s.tick = REFUSAL_HINT_COOLDOWN_TICKS;
    tr.update(s, p);
    p.gx = pxToFp(100);
    s.tick++;
    expect(tr.update(s, p)).toEqual([{ item: heal, reason: 'hpFull' }]);
  });

  it('a drop that turns refused while the player is already on it is announced then', () => {
    const { s, p, heal, tr } = setup();
    p.hp = p.maxHp - 1;
    expect(tr.update(s, p)).toEqual([]);
    p.hp = p.maxHp;
    s.tick++;
    expect(tr.update(s, p)).toEqual([{ item: heal, reason: 'hpFull' }]);
  });

  it('says nothing for no local player, a dead one, or a dead drop', () => {
    const { s, p, heal, tr } = setup();
    expect(tr.update(s, undefined)).toEqual([]);
    p.alive = false;
    expect(tr.update(s, p)).toEqual([]);
    p.alive = true;
    heal.alive = false;
    expect(tr.update(s, p)).toEqual([]);
  });

  it('forgets a drop that left the state, so its cooldown does not outlive it', () => {
    const { s, p, heal, tr } = setup();
    tr.update(s, p);
    s.pickups.length = 0;
    s.tick++;
    tr.update(s, p);
    // Same id back inside the cooldown: only a pruned entry lets it announce.
    s.pickups.push(heal);
    s.tick++;
    expect(tr.update(s, p)).toEqual([{ item: heal, reason: 'hpFull' }]);
  });

  it('clear() forgets everything', () => {
    const { s, p, heal, tr } = setup();
    tr.update(s, p);
    tr.clear();
    expect(tr.update(s, p)).toEqual([{ item: heal, reason: 'hpFull' }]);
  });
});
