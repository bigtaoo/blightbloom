/**
 * TutorialHintController (design/10 screen-flow gap — the teaching beats; design/20's
 * onboarding pass, which made them run for a player's first REAL run too; 2026-11-06, which
 * made every lesson wait for the player). Driven with a fake `TutorialPromptSink` and a real
 * `GameState` fixture (same `createGameState` convention as RunOutcome.test.ts), so this stays
 * a pure state+events reaction test with no Pixi dependency.
 *
 * Every "advances" case below is paired with a "does not advance" case on the same lesson:
 * the change this file pins is that a lesson is NOT left on a timer, and a test that only
 * ever performed the action could not tell a waiting lesson from a timed one.
 */
import { describe, it, expect, vi } from 'vitest';
import { createGameState } from '@dd/engine/state/GameState';
import { fp } from '@dd/engine/math/fixed';
import type { GameState } from '@dd/engine/state/GameState';
import type { GameEvent } from '@dd/engine/state/events';
import { DEFLECT_GIVE_UP_TICKS, TutorialHintController } from './TutorialHintController';

function fakePrompt() {
  return { show: vi.fn(), finish: vi.fn(), hide: vi.fn() };
}

function baseState(): GameState {
  return createGameState({ seed: 1, worldW: 900, worldH: 900, waves: [] });
}

const NO_EVENTS: readonly GameEvent[] = [];
const fired = (s: GameState): GameEvent => ({ type: 'bullet_fired', ownerId: s.players[0]!.id } as GameEvent);
const DEFLECT = { type: 'deflect', gx: 0, gy: 0 } as GameEvent;

function setup(touch?: () => boolean) {
  const prompt = fakePrompt();
  const c = new TutorialHintController(prompt, { localOwner: 0 }, touch);
  const s = baseState();
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
  function atAttack() {
    const x = setup();
    x.tick();
    walk(x.s);
    x.tick();
    return x;
  }

  it('advances on the seat’s own shot or swing, and on nothing else', () => {
    const { prompt, s, tick, lastShown } = atAttack();
    tick([{ type: 'bullet_fired', ownerId: s.players[0]!.id + 99 } as GameEvent]); // someone else's
    tick([DEFLECT]);
    expect(lastShown()).toMatch(/attack/);
    tick([{ type: 'melee_swing', ownerId: s.players[0]!.id } as GameEvent]);
    expect(lastShown()).toBe('Press 1 or 2 to switch weapon.');
    expect(prompt.show).toHaveBeenLastCalledWith(expect.any(String), 3, 4);
  });

  it('a ranged shot counts too', () => {
    const { s, tick, lastShown } = atAttack();
    tick([fired(s)]);
    expect(lastShown()).toMatch(/switch weapon/);
  });
});

describe('TutorialHintController — swap and deflect', () => {
  function atSwap() {
    const x = setup();
    x.tick();
    walk(x.s);
    x.tick();
    x.tick([fired(x.s)]);
    return x;
  }

  it('swap measures from the slot the lesson started on, not from construction', () => {
    const x = setup();
    x.s.players[0]!.activeSlot = 1; // swapped early, during the move lesson
    x.tick();
    walk(x.s);
    x.tick();
    x.tick([fired(x.s)]);
    expect(x.lastShown()).toMatch(/switch weapon/);
    x.s.players[0]!.activeSlot = 0;
    x.tick();
    expect(x.lastShown()).toMatch(/deflect/);
    expect(x.prompt.show).toHaveBeenLastCalledWith(expect.any(String), 4, 4);
  });

  it('a deflect finishes the lessons with the earned congratulation, once', () => {
    const { prompt, s, tick } = atSwap();
    s.players[0]!.activeSlot = 1;
    tick();
    tick([DEFLECT]);
    expect(prompt.finish).toHaveBeenCalledWith('Nicely done — you know the basics.');
    for (let i = 0; i < 10; i++) tick([DEFLECT]);
    expect(prompt.finish).toHaveBeenCalledTimes(1);
  });

  it('a deflect lesson nobody completes is dropped quietly after the give-up window', () => {
    const { prompt, s, tick } = atSwap();
    s.players[0]!.activeSlot = 1;
    tick();
    for (let i = 0; i < DEFLECT_GIVE_UP_TICKS - 1; i++) tick();
    expect(prompt.finish).not.toHaveBeenCalled();
    tick();
    expect(prompt.finish).toHaveBeenCalledWith(null);
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
    const { prompt, c, s, tick } = setup();
    tick();
    walk(s);
    tick();
    tick([fired(s)]);
    s.players[0]!.activeSlot = 1;
    tick();
    tick([DEFLECT]);

    c.reset();
    expect(prompt.hide).toHaveBeenCalledTimes(1);
    prompt.show.mockClear();
    c.consume(baseState(), NO_EVENTS);
    expect(prompt.show).toHaveBeenCalledWith('Move with WASD.', 1, 4);
  });
});
