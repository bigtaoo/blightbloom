/**
 * TutorialHintController (design/10 screen-flow gap — the teaching beats; design/20's
 * onboarding pass, which made them run for a player's first REAL run too; 2026-11-06, which
 * made every lesson wait for the player). Driven with a fake `TutorialPromptSink` and a real
 * `GameState` fixture (same `createGameState` convention as RunOutcome.test.ts), so this stays
 * a pure state+events reaction test with no Pixi dependency.
 *
 * Every "advances" case below is paired with a "does not advance" case on the same lesson:
 * the change this file pins is that a lesson is NOT left on a timer, and a test that only
 * ever performed the action could not tell a waiting lesson from a timed one. The two lessons
 * a player can leave undone for good (swap, deflect) do give up, after a window far longer
 * than the action takes; their cases pin both sides of that window.
 *
 * Since 2026-11-08 those two also wait for their CUE before their panel goes up — swap for a
 * fight (`fight`), deflect for an enemy shot (`ENEMY_SHOT`) — so every case that reaches them
 * supplies the cue, and the "waits for its moment" block pins the gate itself.
 */
import { describe, it, expect, vi } from 'vitest';
import { createGameState } from '@dd/engine/state/GameState';
import { fp } from '@dd/engine/math/fixed';
import type { GameState } from '@dd/engine/state/GameState';
import type { GameEvent } from '@dd/engine/state/events';
import type { EnemyActor } from '@dd/engine/state/entities';
import { DEFLECT_GIVE_UP_TICKS, SWAP_GIVE_UP_TICKS, TutorialHintController } from './TutorialHintController';

function fakePrompt() {
  return { show: vi.fn(), finish: vi.fn(), hide: vi.fn() };
}

function baseState(): GameState {
  return createGameState({ seed: 1, worldW: 900, worldH: 900, waves: [] });
}

const NO_EVENTS: readonly GameEvent[] = [];
const fired = (s: GameState): GameEvent =>
  ({ type: 'bullet_fired', ownerId: s.players[0]!.id, faction: 'player' } as GameEvent);
const DEFLECT = { type: 'deflect', gx: 0, gy: 0 } as GameEvent;
/** The id of the fixture's one standing shooter, which `setup` places in the player's room. */
const SHOOTER_ID = 999;
/** The deflect lesson's cue: a shot from the enemy side, by an enemy in the player's room. */
const ENEMY_SHOT = { type: 'bullet_fired', ownerId: SHOOTER_ID, faction: 'enemy' } as GameEvent;

/** The swap lesson's cue: a live enemy that has noticed the player, in the player's room. Only
 *  the fields the controller reads are real. */
function fight(s: GameState, enemy: Partial<EnemyActor> = {}): void {
  s.enemies.push({ alive: true, aggroed: true, roomId: s.players[0]!.roomId, ...enemy } as EnemyActor);
}

function setup(touch?: () => boolean) {
  const prompt = fakePrompt();
  const c = new TutorialHintController(prompt, { localOwner: 0 }, touch);
  const s = baseState();
  // `ENEMY_SHOT`'s owner: present, in the same (room-less) room, and not a fight on its own.
  s.enemies.push({ id: SHOOTER_ID, alive: true, aggroed: false } as EnemyActor);
  /** One tick: consume, then advance the clock. */
  const tick = (events: readonly GameEvent[] = NO_EVENTS) => {
    c.consume(s, events);
    s.tick++;
  };
  const lastShown = () => String(prompt.show.mock.lastCall?.[0]);
  return { prompt, c, s, tick, lastShown };
}

/** Walk the seat 2 grid east — past the 1.5-grid move threshold. */
function walk(s: GameState): void {
  s.players[0]!.gx = fp(s.players[0]!.gx + 2000);
}

/** Through move, at the attack lesson. */
function atAttack() {
  const x = setup();
  x.tick();
  walk(x.s);
  x.tick();
  return x;
}

/** At the swap lesson, mid-fight, so its panel is up. */
function atSwap() {
  const x = atAttack();
  fight(x.s);
  x.tick([fired(x.s)]);
  return x;
}

/** The default fixture's loadout is what makes the swap/deflect lessons reachable at all —
 *  stated as an assertion rather than assumed, because every case below it depends on it
 *  and a content change that dropped the melee weapon would otherwise turn those cases
 *  green-by-skipping instead of red. */
it('the fixture player carries two weapons, one of them melee', () => {
  const p = baseState().players[0]!;
  expect(p.weapons.length).toBeGreaterThan(1);
  expect(p.weapons.some((w) => w.spec.kind === 'melee')).toBe(true);
});

describe('TutorialHintController — move', () => {
  it('shows the move lesson as step 1 of 4 on the first tick, once', () => {
    const { prompt, tick } = setup();
    for (let i = 0; i < 10; i++) tick();
    expect(prompt.show).toHaveBeenCalledTimes(1);
    expect(prompt.show).toHaveBeenCalledWith('Move with WASD.', 1, 4);
  });

  it('waits for the player: a minute standing still is still the move lesson', () => {
    const { prompt, tick } = setup();
    for (let i = 0; i < 1800; i++) tick();
    expect(prompt.show).toHaveBeenCalledTimes(1);
  });

  it('a nudge under 1.5 grid does not count; a real step does', () => {
    const { prompt, s, tick, lastShown } = setup();
    tick();
    s.players[0]!.gx = fp(s.players[0]!.gx + 1400);
    tick();
    expect(prompt.show).toHaveBeenCalledTimes(1);
    s.players[0]!.gx = fp(s.players[0]!.gx + 200);
    tick();
    expect(lastShown()).toBe('Hold the left mouse button to attack — aiming is automatic.');
    expect(prompt.show).toHaveBeenLastCalledWith(expect.any(String), 2, 4);
  });
});

describe('TutorialHintController — attack', () => {
  it('advances on the seat’s own shot or swing, and on nothing else', () => {
    const { prompt, s, tick, lastShown } = atAttack();
    fight(s);
    tick([{ type: 'bullet_fired', ownerId: s.players[0]!.id + 99, faction: 'player' } as GameEvent]); // someone else's
    tick([DEFLECT]);
    expect(lastShown()).toMatch(/attack/);
    tick([{ type: 'melee_swing', ownerId: s.players[0]!.id } as GameEvent]);
    expect(lastShown()).toBe('Press 1 or 2 to switch weapon.');
    expect(prompt.show).toHaveBeenLastCalledWith(expect.any(String), 3, 4);
  });

  it('a ranged shot counts too', () => {
    const { s, tick, lastShown } = atAttack();
    fight(s);
    tick([fired(s)]);
    expect(lastShown()).toMatch(/switch weapon/);
  });
});

describe('TutorialHintController — swap and deflect', () => {
  it('swap measures from the slot the lesson started on, not from construction', () => {
    const x = setup();
    x.s.players[0]!.activeSlot = 1; // swapped early, during the move lesson
    x.tick();
    walk(x.s);
    x.tick();
    fight(x.s);
    x.tick([fired(x.s)]);
    expect(x.lastShown()).toMatch(/switch weapon/);
    x.s.players[0]!.activeSlot = 0;
    x.tick();
    x.tick([ENEMY_SHOT]);
    expect(x.lastShown()).toMatch(/deflect/);
    expect(x.prompt.show).toHaveBeenLastCalledWith(expect.any(String), 4, 4);
  });

  it('a deflect finishes the lessons with the earned congratulation, once', () => {
    const { prompt, s, tick } = atSwap();
    s.players[0]!.activeSlot = 1;
    tick();
    tick([ENEMY_SHOT]);
    tick([DEFLECT]);
    expect(prompt.finish).toHaveBeenCalledWith('Nicely done — you know the basics.');
    for (let i = 0; i < 10; i++) tick([DEFLECT]);
    expect(prompt.finish).toHaveBeenCalledTimes(1);
  });

  it('a deflect lesson nobody completes is dropped quietly after the give-up window', () => {
    const { prompt, s, tick } = atSwap();
    s.players[0]!.activeSlot = 1;
    tick();
    tick([ENEMY_SHOT]);
    for (let i = 0; i < DEFLECT_GIVE_UP_TICKS - 1; i++) tick();
    expect(prompt.finish).not.toHaveBeenCalled();
    tick();
    expect(prompt.finish).toHaveBeenCalledWith(null);
  });
});

describe('TutorialHintController — the swap lesson gives up (2026-11-07)', () => {
  it('moves on to deflect, unearned, after the give-up window and not a tick before', () => {
    const { prompt, tick, lastShown } = atSwap();
    expect(lastShown()).toMatch(/switch weapon/);
    for (let i = 0; i < SWAP_GIVE_UP_TICKS - 1; i++) tick();
    expect(lastShown()).toMatch(/switch weapon/);
    expect(prompt.hide).not.toHaveBeenCalled();
    tick();
    // Deflect is next, and waits hidden for an enemy shot.
    expect(prompt.hide).toHaveBeenCalledTimes(1);
    tick([ENEMY_SHOT]);
    expect(lastShown()).toMatch(/deflect/);
    expect(prompt.show).toHaveBeenLastCalledWith(expect.any(String), 4, 4);
  });

  it('an all-ranged loadout that never swaps ends quietly, with no congratulation', () => {
    const { prompt, s, tick } = setup();
    const ranged = s.players[0]!.weapons.find((w) => w.spec.kind !== 'melee')!;
    s.players[0]!.weapons = [ranged, ranged];
    tick();
    walk(s);
    tick();
    fight(s);
    tick([fired(s)]);
    for (let i = 0; i < SWAP_GIVE_UP_TICKS; i++) tick();
    expect(prompt.finish).toHaveBeenCalledWith(null);
  });
});

describe('TutorialHintController — swap and deflect wait for their moment (2026-11-08)', () => {
  it('swap waits hidden, with no clock running, until a fight starts', () => {
    const { prompt, s, tick, lastShown } = atAttack();
    tick([fired(s)]); // attack learned, nothing hostile awake
    expect(prompt.hide).toHaveBeenCalledTimes(1);
    expect(lastShown()).toMatch(/attack/);
    // Far past the give-up window: a lesson that was never shown is never given up on.
    for (let i = 0; i < SWAP_GIVE_UP_TICKS * 2; i++) tick();
    expect(prompt.show).toHaveBeenCalledTimes(2);
    expect(prompt.hide).toHaveBeenCalledTimes(1);
    fight(s);
    tick();
    expect(lastShown()).toBe('Press 1 or 2 to switch weapon.');
    expect(prompt.show).toHaveBeenLastCalledWith(expect.any(String), 3, 4);
    // ...and its give-up counts from here.
    for (let i = 0; i < SWAP_GIVE_UP_TICKS - 1; i++) tick();
    expect(prompt.hide).toHaveBeenCalledTimes(1);
    tick();
    expect(prompt.hide).toHaveBeenCalledTimes(2); // on to deflect, hidden until a shot
  });

  it('an enemy that has not noticed the player, or a dead one, is not a fight', () => {
    const { prompt, s, tick } = atAttack();
    fight(s, { aggroed: false });
    fight(s, { alive: false });
    tick([fired(s)]);
    for (let i = 0; i < 30; i++) tick();
    expect(prompt.show).toHaveBeenCalledTimes(2);
    fight(s); // the control: one awake, live enemy is
    tick();
    expect(prompt.show).toHaveBeenCalledTimes(3);
  });

  it('a slot swapped while the swap lesson was hidden is not the lesson', () => {
    const { prompt, s, tick, lastShown } = atAttack();
    tick([fired(s)]);
    s.players[0]!.activeSlot = 1; // swapped in a cleared room, before the fight
    tick();
    fight(s);
    tick();
    tick();
    expect(lastShown()).toMatch(/switch weapon/);
    // Still the swap lesson: had the stale swap counted, deflect's wait would have hidden it.
    expect(prompt.hide).toHaveBeenCalledTimes(1);
    s.players[0]!.activeSlot = 0;
    tick();
    expect(prompt.hide).toHaveBeenCalledTimes(2); // learned; deflect waits hidden
    tick([ENEMY_SHOT]);
    expect(lastShown()).toMatch(/deflect/);
  });

  it('deflect waits for an ENEMY shot: the player’s own does not cue it', () => {
    const { prompt, s, tick, lastShown } = atSwap();
    s.players[0]!.activeSlot = 1;
    tick();
    for (let i = 0; i < DEFLECT_GIVE_UP_TICKS * 2; i++) tick([fired(s)]);
    expect(lastShown()).toMatch(/switch weapon/);
    expect(prompt.finish).not.toHaveBeenCalled();
    tick([ENEMY_SHOT]);
    expect(lastShown()).toMatch(/deflect/);
  });

  it('a deflect before the lesson is up is not the lesson', () => {
    const { prompt, s, tick } = atSwap();
    s.players[0]!.activeSlot = 1;
    tick();
    tick([DEFLECT]);
    expect(prompt.finish).not.toHaveBeenCalled();
    tick([ENEMY_SHOT, DEFLECT]); // the cue tick arms; it does not also score
    expect(prompt.finish).not.toHaveBeenCalled();
    tick([DEFLECT]);
    expect(prompt.finish).toHaveBeenCalledWith('Nicely done — you know the basics.');
  });

  it('a fight or a shot in ANOTHER room is not a cue (a co-op ally’s, or a mob woken through a door)', () => {
    const { prompt, s, tick, lastShown } = atAttack();
    s.players[0]!.roomId = 'r1_entrance';
    fight(s, { roomId: 'r2_side' });
    tick([fired(s)]);
    for (let i = 0; i < 30; i++) tick();
    expect(prompt.show).toHaveBeenCalledTimes(2); // still waiting: swap never went up
    fight(s); // the control: the same fight in the player's room
    tick();
    expect(lastShown()).toMatch(/switch weapon/);
    s.players[0]!.activeSlot = 1;
    tick();
    s.enemies.push({ id: 1234, alive: true, aggroed: true, roomId: 'r2_side' } as EnemyActor);
    const farShot = { type: 'bullet_fired', ownerId: 1234, faction: 'enemy' } as GameEvent;
    for (let i = 0; i < 30; i++) tick([farShot]);
    expect(lastShown()).toMatch(/switch weapon/); // deflect still hidden
    tick([ENEMY_SHOT]); // the fixture's shooter is still room-less, so not in r1_entrance either
    expect(lastShown()).toMatch(/switch weapon/);
    s.enemies.find((e) => e.id === SHOOTER_ID)!.roomId = 'r1_entrance';
    tick([ENEMY_SHOT]); // the control: the same shot from the player's room
    expect(lastShown()).toMatch(/deflect/);
  });

  it('a cue already present when the lesson starts shows it on the same tick, never hiding', () => {
    const { prompt } = atSwap();
    expect(prompt.show).toHaveBeenLastCalledWith('Press 1 or 2 to switch weapon.', 3, 4);
    expect(prompt.hide).not.toHaveBeenCalled();
  });
});

describe('TutorialHintController — teachingMove', () => {
  it('is true only while the move lesson is up', () => {
    const { c, s, tick } = setup();
    expect(c.teachingMove).toBe(false); // nothing taught yet (and never, on a run that does not teach)
    tick();
    expect(c.teachingMove).toBe(true);
    walk(s);
    tick();
    expect(c.teachingMove).toBe(false);
    c.reset();
    expect(c.teachingMove).toBe(false);
  });
});

describe('TutorialHintController — a lesson this loadout cannot be taught', () => {
  it('skips swap for a single-weapon loadout, and counts 3 steps', () => {
    const { prompt, s, tick, lastShown } = setup();
    s.players[0]!.weapons = [s.players[0]!.weapons.find((w) => w.spec.kind === 'melee')!];
    tick();
    expect(prompt.show).toHaveBeenLastCalledWith(expect.any(String), 1, 3);
    walk(s);
    tick();
    tick([fired(s)]);
    tick([ENEMY_SHOT]);
    expect(lastShown()).toMatch(/deflect/);
    expect(prompt.show).toHaveBeenLastCalledWith(expect.any(String), 3, 3);
  });

  it('an all-ranged loadout ends on swap, and that ending is earned', () => {
    const { prompt, s, tick } = setup();
    const ranged = s.players[0]!.weapons.find((w) => w.spec.kind !== 'melee')!;
    s.players[0]!.weapons = [ranged, ranged];
    tick();
    walk(s);
    tick();
    fight(s);
    tick([fired(s)]);
    s.players[0]!.activeSlot = 1;
    tick();
    expect(prompt.finish).toHaveBeenCalledWith('Nicely done — you know the basics.');
    // ...and it really is done, not parked: a deflect now changes nothing.
    tick([DEFLECT]);
    expect(prompt.finish).toHaveBeenCalledTimes(1);
    expect(prompt.show).toHaveBeenCalledTimes(3);
  });

  it('a single ranged weapon is taught move and attack only', () => {
    const { prompt, s, tick } = setup();
    s.players[0]!.weapons = [s.players[0]!.weapons.find((w) => w.spec.kind !== 'melee')!];
    tick();
    expect(prompt.show).toHaveBeenLastCalledWith(expect.any(String), 1, 2);
    walk(s);
    tick();
    tick([fired(s)]);
    expect(prompt.finish).toHaveBeenCalledWith('Nicely done — you know the basics.');
  });

  it('does nothing while the local seat is missing', () => {
    const prompt = fakePrompt();
    const c = new TutorialHintController(prompt, { localOwner: 3 });
    c.consume(baseState(), NO_EVENTS);
    expect(prompt.show).not.toHaveBeenCalled();
  });
});

describe('TutorialHintController — wording follows the input device', () => {
  it('names touch gestures for a touch session and keys for a mouse session', () => {
    for (const touch of [false, true]) {
      const { prompt, s, tick } = setup(() => touch);
      tick();
      walk(s);
      tick();
      fight(s);
      tick([fired(s)]);
      const said = prompt.show.mock.calls.map((call) => String(call[0])).join(' | ');
      // Asserted in both directions, so a controller that ignored the flag and always
      // printed one wording could not pass both halves.
      expect(said).toContain(touch ? 'left side of the screen' : 'WASD');
      expect(said).not.toContain(touch ? 'WASD' : 'left side of the screen');
      expect(said).toContain(touch ? 'right side of the screen' : 'left mouse button');
      expect(said).toContain(touch ? 'Tap a weapon button' : 'Press 1 or 2');
    }
  });
});

describe('TutorialHintController — reset', () => {
  it('hides the panel and starts the machine over, including the earned-done flag', () => {
    const { prompt, c, s, tick } = atSwap();
    s.players[0]!.activeSlot = 1;
    tick();
    tick([ENEMY_SHOT]);
    tick([DEFLECT]);
    expect(prompt.finish).toHaveBeenCalledTimes(1);

    prompt.hide.mockClear(); // the deflect lesson's wait hid it once already
    c.reset();
    expect(prompt.hide).toHaveBeenCalledTimes(1);
    prompt.show.mockClear();
    c.consume(baseState(), NO_EVENTS);
    expect(prompt.show).toHaveBeenCalledWith('Move with WASD.', 1, 4);
  });
});
