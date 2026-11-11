/**
 * CommandBuilder — the render-side input → PlayerCommand producer. Pins the behavior a
 * real player feels: NO aim input at all (design/10 v33) — only movement + buttons.
 * There used to be manual aim (mouse point / stick direction), and before that a briefly-
 * shipped auto-aim-to-nearest override — both are gone now; this suite exists mostly to
 * nail that down so it can't silently regress. Facing is entirely engine-decided
 * (ApplyInputSystem: nearest hostile, else movement direction, else held).
 */
import { describe, it, expect } from 'vitest';
import { Button } from '@dd/engine';
import { CommandBuilder } from './CommandBuilder';
import { bradToRad } from '../coords';
import type { InputSource } from '../../platform/types';
import type { InputState } from '../../platform/types';

const IDLE_STATE: InputState = {
  moveX: 0,
  moveY: 0,
  firing: false,
  interacting: false,
};

function fakeInput(initial: InputState): InputSource & { state: InputState } {
  return {
    state: initial,
    onSwitchWeapon: null,
    attach() {},
    read() {
      return this.state;
    },
    getTouchVisual() {
      return {
        active: false, stickRadius: 0, move: null,
        fire: { cx: 0, cy: 0, r: 0, pressed: false },
        weapon1: { cx: 0, cy: 0, r: 0 }, weapon2: { cx: 0, cy: 0, r: 0 },
        interact: { cx: 0, cy: 0, r: 0, pressed: false },
      };
    },
  };
}

describe('CommandBuilder — no aim input at all', () => {
  it('build() takes no world-position/camera context — there is nothing left to map a screen point through', () => {
    // (tick, owner) only. If this ever grows a 3rd/4th param, aim mapping is creeping back.
    expect(new CommandBuilder(fakeInput(IDLE_STATE)).build.length).toBe(2);
  });

  it('a command never carries an aim field, regardless of movement', () => {
    const input = fakeInput({ ...IDLE_STATE, moveX: 1, moveY: 0 });
    const builder = new CommandBuilder(input);
    const cmd = builder.build(1, 0);
    expect(cmd).not.toHaveProperty('aimBrad');
  });
});

describe('CommandBuilder — move/buttons', () => {
  it('quantizes the move vector', () => {
    const input = fakeInput({ ...IDLE_STATE, moveX: 1, moveY: 0 });
    const builder = new CommandBuilder(input);
    const cmd = builder.build(1, 0);
    expect(bradToRad(cmd.moveBrad)).toBeCloseTo(0, 3); // east
    expect(cmd.moveMag).toBeGreaterThan(0);
  });

  it('maps firing/interacting to the FIRE/INTERACT bits', () => {
    const input = fakeInput({ ...IDLE_STATE, firing: true, interacting: true });
    const builder = new CommandBuilder(input);
    const cmd = builder.build(1, 0);
    expect(cmd.buttons & Button.FIRE).toBeTruthy();
    expect(cmd.buttons & Button.INTERACT).toBeTruthy();
    expect(cmd.buttons & Button.SWAP_WEAPON).toBeFalsy();
  });

  it('requestSwap() latches SWAP_WEAPON for exactly one build() call', () => {
    const input = fakeInput(IDLE_STATE);
    const builder = new CommandBuilder(input);
    builder.requestSwap();
    const first = builder.build(1, 0);
    const second = builder.build(2, 0);
    expect(first.buttons & Button.SWAP_WEAPON).toBeTruthy();
    expect(second.buttons & Button.SWAP_WEAPON).toBeFalsy();
  });

  it('requestConfirmExtract()/requestConfirmDescend() each latch for exactly one build() call', () => {
    const input = fakeInput(IDLE_STATE);
    const builder = new CommandBuilder(input);
    builder.requestConfirmExtract();
    const extractCmd = builder.build(1, 0);
    const afterExtract = builder.build(2, 0);
    expect(extractCmd.buttons & Button.CONFIRM_EXTRACT).toBeTruthy();
    expect(afterExtract.buttons & Button.CONFIRM_EXTRACT).toBeFalsy();

    builder.requestConfirmDescend();
    const descendCmd = builder.build(3, 0);
    const afterDescend = builder.build(4, 0);
    expect(descendCmd.buttons & Button.CONFIRM_DESCEND).toBeTruthy();
    expect(afterDescend.buttons & Button.CONFIRM_DESCEND).toBeFalsy();
  });

  it('requestCardVote(slot) latches cardVote for exactly one build() call', () => {
    // A one-shot latch on the CLIENT even though the vote is persistent state in the
    // SIM: the engine keeps the slot once it has seen it (ApplyInputSystem), so
    // re-sending it every frame would be pure wire traffic. Zero means "not changing
    // my vote", never "withdraw it".
    const builder = new CommandBuilder(fakeInput(IDLE_STATE));
    expect(builder.build(1, 0).cardVote).toBe(0); // default: not voting
    builder.requestCardVote(2);
    const first = builder.build(1, 1);
    const second = builder.build(1, 2);
    expect(first.cardVote).toBe(2);
    expect(second.cardVote).toBe(0);
  });

  it('a second requestCardVote before the next build wins — a changed mind is not queued', () => {
    const builder = new CommandBuilder(fakeInput(IDLE_STATE));
    builder.requestCardVote(1);
    builder.requestCardVote(3);
    expect(builder.build(1, 1).cardVote).toBe(3);
  });

  it('requestPickup(id) latches pickupTargetId for exactly one build() call', () => {
    const input = fakeInput(IDLE_STATE);
    const builder = new CommandBuilder(input);
    expect(builder.build(1, 0).pickupTargetId).toBe(0); // default: no click
    builder.requestPickup(42);
    const first = builder.build(2, 0);
    const second = builder.build(3, 0);
    expect(first.pickupTargetId).toBe(42);
    expect(second.pickupTargetId).toBe(0);
  });

  it('suppressFire(true) zeroes the FIRE bit even while the input source reports firing', () => {
    const input = fakeInput({ ...IDLE_STATE, firing: true });
    const builder = new CommandBuilder(input);
    builder.suppressFire(true);
    const suppressed = builder.build(1, 0);
    expect(suppressed.buttons & Button.FIRE).toBeFalsy();

    builder.suppressFire(false);
    const restored = builder.build(2, 0);
    expect(restored.buttons & Button.FIRE).toBeTruthy();
  });

  // The weapon-pickup panel's own suppression (2026-09-02, *"附近有可以拾取的武器时，不要
  // 阻断了玩家攻击"*). Unlike suppressFire(true) above, nobody ever turns this one OFF —
  // releasing the button is what clears it, which is the property these three cases pin.
  it('suppressFireUntilRelease() swallows the press it lands in, all the way to release', () => {
    const input = fakeInput({ ...IDLE_STATE, firing: true });
    const builder = new CommandBuilder(input);
    builder.suppressFireUntilRelease(); // pointerdown on the panel, before the button is even read
    expect(builder.build(1, 0).buttons & Button.FIRE).toBeFalsy();
    // Still held (a slow click, or several sim ticks inside one press) — still swallowed.
    expect(builder.build(2, 0).buttons & Button.FIRE).toBeFalsy();
  });

  it('the NEXT press after that one fires normally — nothing has to turn it back off', () => {
    const input = fakeInput({ ...IDLE_STATE, firing: true });
    const builder = new CommandBuilder(input);
    builder.suppressFireUntilRelease();
    builder.build(1, 0);
    input.state = { ...input.state, firing: false }; // release
    builder.build(2, 0);
    input.state = { ...input.state, firing: true }; // a fresh press, in open ground
    expect(builder.build(3, 0).buttons & Button.FIRE).toBeTruthy();
  });

  it('swallows FIRE only — INTERACT and the one-shot latches ride the same press through', () => {
    // The latch is set from a pointerdown on a panel that is deliberately NOT modal, so
    // it must not become a general input block: a revive channel held through the click
    // keeps channelling, and the click's own pickup still reaches the sim on that tick.
    const input = fakeInput({ ...IDLE_STATE, firing: true, interacting: true });
    const builder = new CommandBuilder(input);
    builder.suppressFireUntilRelease();
    builder.requestPickup(42);
    builder.requestSwap();

    const cmd = builder.build(1, 0);

    expect(cmd.buttons & Button.FIRE).toBeFalsy();
    expect(cmd.buttons & Button.INTERACT).toBeTruthy();
    expect(cmd.buttons & Button.SWAP_WEAPON).toBeTruthy();
    expect(cmd.pickupTargetId).toBe(42);
  });

  it('a press that never touched the panel still fires while the panel is on screen', () => {
    // The regression itself: the panel being open is not, on its own, a reason to drop
    // FIRE — only a press that landed ON it is (GameLoop no longer OR's isOpen into
    // suppressFire, and this builder has no idea the panel exists).
    const input = fakeInput({ ...IDLE_STATE, firing: true });
    const builder = new CommandBuilder(input);
    expect(builder.build(1, 0).buttons & Button.FIRE).toBeTruthy();
  });
});

/**
 * `lastMove` (2026-09-03b) — the movement half of the command this builder last PRODUCED.
 *
 * It exists because a render-only reader (`scene/doorTick.isRefused`, "is the player pushing into
 * this locked door") needs the input the SIM was given for the tick being drawn. Re-reading the
 * device would answer for a different instant and would poll a gamepad twice a frame.
 */
describe('CommandBuilder.lastMove', () => {
  it('starts at rest, so nothing reads a push out of a builder that has never built', () => {
    const b = new CommandBuilder(fakeInput({ ...IDLE_STATE }));
    expect(b.lastMove).toEqual({ rad: 0, mag: 0 });
  });

  it('records the direction and deflection of the command it just returned', () => {
    const input = fakeInput({ ...IDLE_STATE, moveX: 0, moveY: -1 });
    const b = new CommandBuilder(input);
    const cmd = b.build(1, 0);

    expect(b.lastMove.mag).toBe(cmd.moveMag);
    expect(b.lastMove.rad).toBeCloseTo(bradToRad(cmd.moveBrad), 6);
    expect(b.lastMove.mag).toBeGreaterThan(0);
  });

  it('only moves when a command is BUILT, not when the device changes', () => {
    // The property `doorTick` depends on: a paused frame submits no command, so a finger left on
    // the stick must not keep refusing doors. Mutating the input alone must change nothing.
    const input = fakeInput({ ...IDLE_STATE, moveX: 1, moveY: 0 });
    const b = new CommandBuilder(input);
    b.build(1, 0);
    const after = { ...b.lastMove };

    input.state.moveX = 0;
    input.state.moveY = -1;
    expect(b.lastMove).toEqual(after);

    b.build(2, 0);
    expect(b.lastMove).not.toEqual(after);
  });

  it('goes back to rest when the stick does', () => {
    const input = fakeInput({ ...IDLE_STATE, moveX: 1, moveY: 0 });
    const b = new CommandBuilder(input);
    b.build(1, 0);
    input.state.moveX = 0;
    b.build(2, 0);
    expect(b.lastMove.mag).toBe(0);
  });

  it('is one object, mutated in place — a caller may hold the reference across frames', () => {
    const input = fakeInput({ ...IDLE_STATE, moveX: 1, moveY: 0 });
    const b = new CommandBuilder(input);
    const held = b.lastMove;
    b.build(1, 0);
    expect(b.lastMove).toBe(held);
    expect(held.mag).toBeGreaterThan(0);
  });
});

describe('CommandBuilder.hasLatchedAction — what the opening hold reads', () => {
  // The freeze in `openingHold.ts` holds the world still until the player shows up, and a
  // frozen sim never calls build(). So every one-shot latch has to be VISIBLE before it is
  // consumed, or a run whose first action is a HUD tap stays frozen until the 20 s fuse.
  // One case per latch, because a getter that forgot one would still pass a single-case test.
  const latch: ReadonlyArray<readonly [string, (b: CommandBuilder) => void]> = [
    ['swap', (b) => b.requestSwap()],
    ['confirm extract', (b) => b.requestConfirmExtract()],
    ['confirm descend', (b) => b.requestConfirmDescend()],
    ['ground pickup', (b) => b.requestPickup(7)],
    ['shop buy', (b) => b.requestShopBuy(3)],
    ['floor-card vote', (b) => b.requestCardVote(2)],
  ];

  it('is false for a builder nobody has touched', () => {
    expect(new CommandBuilder(fakeInput(IDLE_STATE)).hasLatchedAction).toBe(false);
  });

  it.each(latch)('reports a pending %s, and stops once build() has carried it', (_, set) => {
    const b = new CommandBuilder(fakeInput(IDLE_STATE));
    set(b);
    expect(b.hasLatchedAction).toBe(true);
    b.build(1, 0);
    expect(b.hasLatchedAction).toBe(false);
  });

  it('is not set by firing or interacting — those are read from the device, not latched', () => {
    // The control: without it, a getter that simply returned `true` would pass every case
    // above. These two reach the command through `InputState`, which the hold reads itself.
    const b = new CommandBuilder(fakeInput({ ...IDLE_STATE, firing: true, interacting: true }));
    expect(b.hasLatchedAction).toBe(false);
  });
});
