/**
 * TutorialHintController (design/10 screen-flow gap — the teaching beats; design/20's
 * onboarding pass, which made them run for a player's first REAL run too). Driven with a
 * fake HudView-shaped host (only `.toast` is called) and a real `GameState` fixture (same
 * `createGameState` convention as RunOutcome.test.ts), so this stays a pure state+events
 * reaction test with no Pixi/engine dependency beyond the state shape itself.
 *
 * The `applies` cases below matter more than they look. While this only ever ran over
 * `tutorialConfig.ts`'s hand-picked repeater+hammer, "the player can swap" and "the player
 * can deflect" were true by construction; over a real loadout they are not, and the step
 * machine's old behaviour for a loadout that cannot do them was to sit on the lesson
 * forever, silently.
 */
import { describe, it, expect, vi } from 'vitest';
import { createGameState } from '@dd/engine/state/GameState';
import type { GameState } from '@dd/engine/state/GameState';
import type { GameEvent } from '@dd/engine/state/events';
import { TutorialHintController } from './TutorialHintController';

function fakeHud() {
  return { toast: vi.fn() };
}

function baseState(): GameState {
  return createGameState({ seed: 1, worldW: 900, worldH: 900, waves: [] });
}

const NO_EVENTS: readonly GameEvent[] = [];

/** The default fixture's loadout is what makes the swap/deflect lessons reachable at all —
 *  stated as an assertion rather than assumed, because every case below it depends on it
 *  and a content change that dropped the melee weapon would otherwise turn those cases
 *  green-by-skipping instead of red. */
it('the fixture player carries two weapons, one of them melee', () => {
  const p = baseState().players[0]!;
  expect(p.weapons.length).toBeGreaterThan(1);
  expect(p.weapons.some((w) => w.spec.kind === 'melee')).toBe(true);
});

describe('TutorialHintController — move step', () => {
  it('shows the move hint once on the first tick', () => {
    const hud = fakeHud();
    const c = new TutorialHintController(hud as never, { localOwner: 0 });
    const s = baseState();
    c.consume(s, NO_EVENTS);
    expect(hud.toast).toHaveBeenCalledTimes(1);
    expect(hud.toast).toHaveBeenCalledWith(
      'Move with WASD. Hold the left mouse button to attack — aiming is automatic.',
      expect.anything(),
    );
  });

  it('does not re-show the same hint every tick', () => {
    const hud = fakeHud();
    const c = new TutorialHintController(hud as never, { localOwner: 0 });
    const s = baseState();
    for (let i = 0; i < 10; i++) {
      c.consume(s, NO_EVENTS);
      s.tick++;
    }
    expect(hud.toast).toHaveBeenCalledTimes(1);
  });
});

describe('TutorialHintController — swap step', () => {
  it('advances to the swap hint once the move window elapses', () => {
    const hud = fakeHud();
    const c = new TutorialHintController(hud as never, { localOwner: 0 });
    const s = baseState();
    for (let i = 0; i < 91; i++) {
      c.consume(s, NO_EVENTS);
      s.tick++;
    }
    expect(hud.toast).toHaveBeenLastCalledWith('Press 1 or 2 to switch weapon.', expect.anything());
  });

  it('advances to the deflect hint once activeSlot changes from its swap-step baseline', () => {
    const hud = fakeHud();
    const c = new TutorialHintController(hud as never, { localOwner: 0 });
    const s = baseState();
    for (let i = 0; i < 91; i++) {
      c.consume(s, NO_EVENTS);
      s.tick++;
    }
    s.players[0]!.activeSlot = 1; // the player swapped weapons
    c.consume(s, NO_EVENTS);
    expect(hud.toast).toHaveBeenLastCalledWith(
      'Swing your melee weapon into incoming bullets to deflect them.',
      expect.anything(),
    );
  });

  it('takes its baseline when the LESSON starts, not at construction', () => {
    // A player who swapped during the move hint must still be able to complete the swap
    // lesson: the comparison is against the slot they were on when the lesson began.
    const hud = fakeHud();
    const c = new TutorialHintController(hud as never, { localOwner: 0 });
    const s = baseState();
    s.players[0]!.activeSlot = 1; // swapped early, before the move window elapsed
    for (let i = 0; i < 91; i++) {
      c.consume(s, NO_EVENTS);
      s.tick++;
    }
    expect(hud.toast).toHaveBeenLastCalledWith('Press 1 or 2 to switch weapon.', expect.anything());
    s.players[0]!.activeSlot = 0;
    c.consume(s, NO_EVENTS);
    expect(hud.toast).toHaveBeenLastCalledWith(expect.stringContaining('deflect'), expect.anything());
  });
});

describe('TutorialHintController — deflect step', () => {
  function reachDeflectStep(c: TutorialHintController, s: GameState) {
    for (let i = 0; i < 91; i++) {
      c.consume(s, NO_EVENTS);
      s.tick++;
    }
    s.players[0]!.activeSlot = 1;
    c.consume(s, NO_EVENTS);
  }

  it('advances to done once a deflect event fires', () => {
    const hud = fakeHud();
    const c = new TutorialHintController(hud as never, { localOwner: 0 });
    const s = baseState();
    reachDeflectStep(c, s);
    hud.toast.mockClear();
    c.consume(s, [{ type: 'deflect', gx: 0, gy: 0 } as GameEvent]);
    expect(hud.toast).toHaveBeenCalledWith('Nicely done — head to the portal.', expect.anything());
  });

  it('stays done and shows nothing further on later ticks', () => {
    const hud = fakeHud();
    const c = new TutorialHintController(hud as never, { localOwner: 0 });
    const s = baseState();
    reachDeflectStep(c, s);
    c.consume(s, [{ type: 'deflect', gx: 0, gy: 0 } as GameEvent]);
    hud.toast.mockClear();
    s.tick++;
    c.consume(s, NO_EVENTS);
    expect(hud.toast).not.toHaveBeenCalled();
  });
});

describe('TutorialHintController — a lesson this loadout cannot be taught', () => {
  /** Run past the move window, having reduced the fixture's loadout first. */
  function afterMoveWindow(mutate: (s: GameState) => void) {
    const hud = fakeHud();
    const c = new TutorialHintController(hud as never, { localOwner: 0 });
    const s = baseState();
    mutate(s);
    for (let i = 0; i < 91; i++) {
      c.consume(s, NO_EVENTS);
      s.tick++;
    }
    return { hud, c, s };
  }

  it('skips the swap lesson for a single-weapon loadout', () => {
    const { hud } = afterMoveWindow((s) => {
      s.players[0]!.weapons = [s.players[0]!.weapons.find((w) => w.spec.kind === 'melee')!];
    });
    // Straight past swap to deflect — the melee weapon is still there, so that lesson
    // applies and is what gets shown.
    expect(hud.toast).toHaveBeenLastCalledWith(expect.stringContaining('deflect'), expect.anything());
  });

  it('skips the deflect lesson for an all-ranged loadout', () => {
    const { hud, c, s } = afterMoveWindow((s) => {
      const ranged = s.players[0]!.weapons.find((w) => w.spec.kind !== 'melee')!;
      s.players[0]!.weapons = [ranged, ranged];
    });
    expect(hud.toast).toHaveBeenLastCalledWith('Press 1 or 2 to switch weapon.', expect.anything());
    hud.toast.mockClear();
    s.players[0]!.activeSlot = 1;
    c.consume(s, NO_EVENTS);
    // Nothing. Telling a player with no melee weapon to parry with it is worse than
    // silence, and so is congratulating them for a lesson that never ran.
    expect(hud.toast).not.toHaveBeenCalled();
    // ...and it really is DONE, not parked: a deflect event now changes nothing.
    c.consume(s, [{ type: 'deflect', gx: 0, gy: 0 } as GameEvent]);
    expect(hud.toast).not.toHaveBeenCalled();
  });

  it('says nothing at all past the move hint for a single ranged weapon', () => {
    const { hud } = afterMoveWindow((s) => {
      s.players[0]!.weapons = [s.players[0]!.weapons.find((w) => w.spec.kind !== 'melee')!];
    });
    // One toast, ever: the move hint. Both remaining lessons are unteachable, and `done`
    // was reached by skipping rather than by finishing, so it stays quiet.
    expect(hud.toast).toHaveBeenCalledTimes(1);
    expect(hud.toast).toHaveBeenCalledWith(expect.stringContaining('Move with WASD'), expect.anything());
  });
});

describe('TutorialHintController — wording follows the input device', () => {
  it('names touch gestures for a touch session and keys for a mouse session', () => {
    for (const touch of [false, true]) {
      const hud = fakeHud();
      const c = new TutorialHintController(hud as never, { localOwner: 0 }, () => touch);
      const s = baseState();
      for (let i = 0; i < 91; i++) {
        c.consume(s, NO_EVENTS);
        s.tick++;
      }
      const said = hud.toast.mock.calls.map((call) => String(call[0])).join(' | ');
      // The pair is asserted in both directions, so a controller that ignored the flag and
      // always printed one wording could not pass both halves.
      expect(said).toContain(touch ? 'left side of the screen' : 'WASD');
      expect(said).not.toContain(touch ? 'WASD' : 'left side of the screen');
      expect(said).toContain(touch ? 'Tap a weapon button' : 'Press 1 or 2');
    }
  });

  it('defaults to the keyboard wording when no input source was given', () => {
    const hud = fakeHud();
    const c = new TutorialHintController(hud as never, { localOwner: 0 });
    c.consume(baseState(), NO_EVENTS);
    expect(hud.toast).toHaveBeenCalledWith(expect.stringContaining('WASD'), expect.anything());
  });
});

describe('TutorialHintController — reset', () => {
  it('starts the machine over, including the earned-done flag', () => {
    const hud = fakeHud();
    const c = new TutorialHintController(hud as never, { localOwner: 0 });
    const s = baseState();
    for (let i = 0; i < 91; i++) {
      c.consume(s, NO_EVENTS);
      s.tick++;
    }
    s.players[0]!.activeSlot = 1;
    c.consume(s, NO_EVENTS);
    c.consume(s, [{ type: 'deflect', gx: 0, gy: 0 } as GameEvent]);

    c.reset();
    hud.toast.mockClear();
    const fresh = baseState();
    c.consume(fresh, NO_EVENTS);
    expect(hud.toast).toHaveBeenCalledWith(expect.stringContaining('Move with WASD'), expect.anything());
  });
});
