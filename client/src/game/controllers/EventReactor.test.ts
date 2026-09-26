/**
 * EventReactor (design/08 "events are the only engine→render channel"). Only the
 * toast-text side is asserted here (design/17-i18n.md migrated it to `t()`) — fx/audio
 * are exercised incidentally via real `FxController`/fake `AudioBus` so `consume()`
 * doesn't throw, same "construct real Pixi widgets under plain vitest" convention as
 * HudView.test.ts.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  pxToFp, WEAPON_SIM_BY_ID,
  type GameEvent, type GameState, type MeleeSimSpec, type RangedSimSpec,
} from '@dd/engine';
import { createGameState } from '@dd/engine/state/GameState';
import { buildEnemyActor } from '@dd/engine/content/enemies';
import { DeathDropsSystem } from '@dd/engine/systems';
// Every enemy in the game fires this one, and `weapons.ts` keeps it out of
// `WEAPON_SIM_BY_ID` (not player-facing) — so the enemy-shooter case imports it directly.
import { ENEMY_GUN_SIM } from '@dd/engine/content/weapons';
import type { ArenaMap } from '@dd/engine/content/arenas';
import { EventReactor, type EventReactorHost } from './EventReactor';
import { fpToPx } from '../coords';
import { swingShapeOf } from './attackShapes';
import type { FxController } from '../fx/FxController';
import { HudView } from '../ui/HudView';
import { Layers } from '../scene/layers';
import type { AudioBus } from '../../platform/types';
import { resetLocaleForTests } from '../../i18n';
import { THEME } from '../theme';
import type { SlashArcPose } from '../fx/slashArc';
import {
  swingSchedule, recoilSchedule, RECOIL_MS, type ShotShape, type SwingShape,
} from '../../render/rigAttackMotion';
import { useLocale } from '../../i18n/loadLocale';

// `FxController`'s real constructor builds WebGL filters (VignetteFilter/
// ChromaticAberrationFilter), which need an actual `document`/GL context this repo's
// plain-node vitest doesn't have (see FxController.ts) — a minimal fake covering only
// the methods EventReactor.consume() actually calls is the same "avoid a real renderer"
// convention every other screen test here already uses for Pixi Text/Container.
function fakeFx(): FxController {
  return {
    flash: vi.fn(),
    muzzleFlare: vi.fn(),
    slashArc: vi.fn(),
    addShake: vi.fn(),
    addHitStop: vi.fn(),
    pulseChromatic: vi.fn(),
    numbers: { spawn: vi.fn() },
    particles: {
      muzzleFlame: vi.fn(), shellCasing: vi.fn(), explosionDebris: vi.fn(), shieldShards: vi.fn(),
    },
  } as unknown as FxController;
}

function fakeAudio(): AudioBus {
  return {
    play: vi.fn(),
    preload: vi.fn(async () => {}),
    setSfxVolume: vi.fn(),
    setMusicVolume: vi.fn(),
    updateMusic: vi.fn(),
    invalidateMusic: vi.fn(),
    resume: vi.fn(),
  };
}

function fakeHost(): EventReactorHost {
  return {
    localOwner: 0,
    activeState: () => null,
    addScore: vi.fn(),
    onRoomEnter: vi.fn(),
    onDoorStateChange: vi.fn(),
    onForceRegroup: vi.fn(),
    onWeaponPickup: vi.fn(),
    actorAt: vi.fn(() => undefined),
  };
}

function newReactor() {
  const hud = new HudView();
  hud.build(new Layers(), { w: 1280, h: 720 });
  const reactor = new EventReactor(fakeFx(), hud, fakeAudio(), fakeHost());
  const toast = vi.spyOn(hud, 'toast');
  return { reactor, toast };
}

const PICKUP_BASE = { type: 'pickup' as const, by: 1, gx: 0, gy: 0 };

/** The smallest map that makes `createGameState` build an ARENA state (`zoneEnabled`, seats
 *  with `teamId`s) — the `win` cue's whole question is which win model applies, and only a
 *  real state answers that. Same one-room fixture `RunOutcome.test.ts` uses for the screen
 *  side of the same decision. */
const MINI_ARENA: ArenaMap = {
  id: 'mini',
  sizeGrid: { w: 10, h: 10 },
  rooms: [{ id: 'A', rectGrid: { x: 0, y: 0, w: 10, h: 10 }, solids: [] }],
  doors: [],
  spawns: [{ x: 5, y: 5 }],
  eyeCandidates: [{ roomId: 'A' }],
};

afterEach(() => resetLocaleForTests());

describe('EventReactor — pickup toasts', () => {
  it('a heal pickup toasts "+1 HP"', () => {
    const { reactor, toast } = newReactor();
    reactor.consume([{ ...PICKUP_BASE, kind: 'heal' }] as GameEvent[]);
    expect(toast).toHaveBeenCalledWith('+1 HP', expect.anything());
  });

  it('a recognized weapon pickup toasts its translated display name', () => {
    const { reactor, toast } = newReactor();
    reactor.consume([{ ...PICKUP_BASE, kind: 'weapon', weaponId: 'repeater' }] as GameEvent[]);
    expect(toast).toHaveBeenCalledWith('Repeater', expect.anything());
  });

  it('an unrecognized weapon id falls back to "New weapon"', () => {
    const { reactor, toast } = newReactor();
    reactor.consume([{ ...PICKUP_BASE, kind: 'weapon', weaponId: 'no-such-weapon' }] as GameEvent[]);
    expect(toast).toHaveBeenCalledWith('New weapon', expect.anything());
  });

  it('a weapon pickup with no weaponId at all also falls back to "New weapon"', () => {
    // Same defensive shape as the buff/material toasts below — `weaponId` is absent rather
    // than merely uncatalogued, which the "unrecognized id" case above does not exercise.
    const { reactor, toast } = newReactor();
    reactor.consume([{ ...PICKUP_BASE, kind: 'weapon' }] as GameEvent[]);
    expect(toast).toHaveBeenCalledWith('New weapon', expect.anything());
  });

  it('a schematic pickup toasts the translated weapon name (ENGINE_VERSION 68)', () => {
    const { reactor, toast } = newReactor();
    reactor.consume([{ ...PICKUP_BASE, kind: 'schematic', weaponId: 'flamer' }] as GameEvent[]);
    expect(toast).toHaveBeenCalledWith('Schematic: Flamethrower', expect.anything());
  });

  it('an unrecognized schematic weapon id falls back to the raw id', () => {
    const { reactor, toast } = newReactor();
    reactor.consume([{ ...PICKUP_BASE, kind: 'schematic', weaponId: 'no-such-weapon' }] as GameEvent[]);
    expect(toast).toHaveBeenCalledWith('Schematic: no-such-weapon', expect.anything());
  });

  it('a schematic pickup with no weaponId at all falls back to an empty name', () => {
    const { reactor, toast } = newReactor();
    reactor.consume([{ ...PICKUP_BASE, kind: 'schematic' }] as GameEvent[]);
    expect(toast).toHaveBeenCalledWith('Schematic: ', expect.anything());
  });

  it('a character pickup toasts the translated character name, falling back to the raw id or nothing (2026-09-26)', () => {
    const { reactor, toast } = newReactor();
    reactor.consume([{ ...PICKUP_BASE, kind: 'character', skinId: 'juggernaut' }] as GameEvent[]);
    expect(toast).toHaveBeenLastCalledWith('New character: Juggernaut', expect.anything());
    reactor.consume([{ ...PICKUP_BASE, kind: 'character', skinId: 'no-such-skin' }] as GameEvent[]);
    expect(toast).toHaveBeenLastCalledWith('New character: no-such-skin', expect.anything());
    reactor.consume([{ ...PICKUP_BASE, kind: 'character' }] as GameEvent[]);
    expect(toast).toHaveBeenLastCalledWith('New character: ', expect.anything());
  });

  it('a shield-battery pickup toasts "Shield recharged" (Task 4 instant item)', () => {
    const { reactor, toast } = newReactor();
    reactor.consume([{ ...PICKUP_BASE, kind: 'shield' }] as GameEvent[]);
    expect(toast).toHaveBeenCalledWith('Shield recharged', expect.anything());
  });

  it('an EMP-grenade pickup toasts "EMP burst" (Task 4 instant item)', () => {
    const { reactor, toast } = newReactor();
    reactor.consume([{ ...PICKUP_BASE, kind: 'emp' }] as GameEvent[]);
    expect(toast).toHaveBeenCalledWith('EMP burst', expect.anything());
  });

  it('a recognized buff toasts "Buff: {translated name}"', () => {
    const { reactor, toast } = newReactor();
    reactor.consume([{ ...PICKUP_BASE, kind: 'buff', buffId: 'dmg_up' }] as GameEvent[]);
    expect(toast).toHaveBeenCalledWith('Buff: Damage Up', expect.anything());
  });

  it('an uncatalogued buff id falls back to echoing the raw id; an absent one toasts the generic label', () => {
    const { reactor, toast } = newReactor();
    reactor.consume([{ ...PICKUP_BASE, kind: 'buff', buffId: 'crit_surge' }] as GameEvent[]);
    expect(toast).toHaveBeenCalledWith('Buff: crit_surge', expect.anything());
    toast.mockClear();
    reactor.consume([{ ...PICKUP_BASE, kind: 'buff' }] as GameEvent[]);
    expect(toast).toHaveBeenCalledWith('Buff', expect.anything());
  });

  it('a recognized material pickup toasts "+{qty} {translated material name}"', () => {
    const { reactor, toast } = newReactor();
    reactor.consume([{ ...PICKUP_BASE, kind: 'material', materialId: 'mat_fire', qty: 3 }] as GameEvent[]);
    expect(toast).toHaveBeenCalledWith('+3 Fire', expect.anything());
  });

  it('an uncatalogued material id falls back to echoing the raw id; an absent one toasts the generic label', () => {
    const { reactor, toast } = newReactor();
    reactor.consume([{ ...PICKUP_BASE, kind: 'material', materialId: 'fire', qty: 3 }] as GameEvent[]);
    expect(toast).toHaveBeenCalledWith('+3 fire', expect.anything());
    toast.mockClear();
    reactor.consume([{ ...PICKUP_BASE, kind: 'material' }] as GameEvent[]);
    expect(toast).toHaveBeenCalledWith('+1 material', expect.anything());
  });
});

describe('EventReactor — pickup toasts, i18n (design/17-i18n.md)', () => {
  it('translate every toast template under zh', async () => {
    await useLocale('zh');
    const { reactor, toast } = newReactor();
    reactor.consume([{ ...PICKUP_BASE, kind: 'heal' }] as GameEvent[]);
    expect(toast).toHaveBeenCalledWith('+1 生命', expect.anything());
    toast.mockClear();
    reactor.consume([{ ...PICKUP_BASE, kind: 'buff' }] as GameEvent[]);
    expect(toast).toHaveBeenCalledWith('增益', expect.anything());
    toast.mockClear();
    reactor.consume([{ ...PICKUP_BASE, kind: 'material' }] as GameEvent[]);
    expect(toast).toHaveBeenCalledWith('+1 材料', expect.anything());
  });

  it('translates a recognized weapon/buff/material name, not just the generic templates', async () => {
    await useLocale('zh');
    const { reactor, toast } = newReactor();
    reactor.consume([{ ...PICKUP_BASE, kind: 'weapon', weaponId: 'repeater' }] as GameEvent[]);
    expect(toast).toHaveBeenCalledWith('连发枪', expect.anything());
    toast.mockClear();
    reactor.consume([{ ...PICKUP_BASE, kind: 'buff', buffId: 'dmg_up' }] as GameEvent[]);
    expect(toast).toHaveBeenCalledWith('增益：伤害提升', expect.anything());
    toast.mockClear();
    reactor.consume([{ ...PICKUP_BASE, kind: 'material', materialId: 'mat_fire', qty: 3 }] as GameEvent[]);
    expect(toast).toHaveBeenCalledWith('+3 火', expect.anything());
  });
});

describe('EventReactor — score reactions unaffected by the toast migration', () => {
  it('an enemy death still scores a kill', () => {
    const hud = new HudView();
    hud.build(new Layers(), { w: 1280, h: 720 });
    const host = fakeHost();
    const reactor = new EventReactor(fakeFx(), hud, fakeAudio(), host);
    reactor.consume([{ type: 'death', faction: 'enemy', gx: 0, gy: 0, r: pxToFp(15) } as GameEvent]);
    expect(host.addScore).toHaveBeenCalled();
  });
});

// 2026-09-03. The death burst is sized off the corpse (`GameEvent`'s `death.r`, the dying
// actor's drawn body radius) instead of off one authored constant, and centred on that body
// rather than on its ground anchor. Both are invisible in a screenshot of one mob dying —
// which is how the old flat spray survived: it was eyeballed on a 15 px body and stayed the
// same size on a 30 px boss — so they are measured here against TWO body sizes.
describe('EventReactor — the death burst is sized and centred off the dying body', () => {
  const dieAt = (gx: number, gy: number, bodyPx: number) => {
    const hud = new HudView();
    hud.build(new Layers(), { w: 1280, h: 720 });
    const fx = fakeFx();
    new EventReactor(fx, hud, fakeAudio(), fakeHost()).consume([
      { type: 'death', id: 3, faction: 'enemy', gx, gy, r: pxToFp(bodyPx) } as GameEvent,
    ]);
    const debris = fx.particles.explosionDebris as unknown as ReturnType<typeof vi.fn>;
    expect(debris).toHaveBeenCalledTimes(1);
    return debris.mock.calls[0] as [number, number, number, number];
  };

  it('hands the particle system the body radius in screen px', () => {
    // Through the fp round trip, which is lossy (`pxToFp(15)` comes back as 14.992), so every
    // expectation below is stated as the round-tripped value rather than as the authored px.
    expect(dieAt(0, 0, 15)[3]).toBeCloseTo(fpToPx(pxToFp(15)), 6);
    expect(dieAt(0, 0, 30)[3]).toBeCloseTo(fpToPx(pxToFp(30)), 6);
  });

  it('lifts the centre by a fraction of that body, not by a flat 12 px', () => {
    // The bug the fraction replaced: a lift that is 0.8 body radii on the mob it was chosen
    // against and 0.4 on a boss, i.e. a boss ring hanging around its feet.
    const [x, mobY] = dieAt(pxToFp(300), pxToFp(200), 15);
    expect(x).toBeCloseTo(300, 6);
    expect(mobY).toBeCloseTo(200 - fpToPx(pxToFp(15)) * 0.8, 6);
    const [, bossY] = dieAt(pxToFp(300), pxToFp(200), 30);
    expect(bossY).toBeCloseTo(200 - fpToPx(pxToFp(30)) * 0.8, 6);
    // ...and the lift is a real fraction of the body, not two constants that happen to differ.
    expect(200 - bossY).toBeCloseTo((200 - mobY) * 2, 3);
  });

  it('follows the corpse rather than sitting at the origin', () => {
    const [x, y] = dieAt(pxToFp(-140), pxToFp(96), 15);
    expect(x).toBeCloseTo(-140, 6);
    expect(y).toBeCloseTo(96 - fpToPx(pxToFp(15)) * 0.8, 6);
  });

  it('is sized off the same radius the BODY is drawn at, through the real engine', () => {
    // The end-to-end version of the two cases above, and the one that can catch what they
    // cannot: they hand this reactor an event built by hand, so they pin the reactor's own
    // arithmetic while taking the event's contents on trust. Here the event comes out of the
    // real `DeathDropsSystem`, off a real `buildEnemyActor`, so the whole chain is measured —
    // which radius the engine puts on the wire, which field the reactor reads, and the fp→px
    // conversion between them (handing `e.r` straight through would be a burst ~32x too big,
    // and it is the single easiest mistake to make in this file: `gx`/`gy` right beside it
    // need the same call).
    //
    // The expectation is `fpToPx(e.radius)` because that is LITERALLY what the body is drawn
    // at — `Scene.reconcile` builds the view as `new Enemy(fpToPx(e.radius), ...)`. So a ring
    // of 1.6 is 1.6 of the silhouette on screen, which is the whole claim of the rewrite.
    const s = createGameState({ seed: 3, worldW: 1600, worldH: 1200, waves: [] });
    const boss = buildEnemyActor(s, pxToFp(400), pxToFp(300), 'boss');
    s.enemies.push(boss);
    const drawnR = fpToPx(boss.radius);
    const feetR = fpToPx(boss.footprintRadius);
    boss.hp = 0;
    new DeathDropsSystem().tick(s);
    expect(s.enemies).toHaveLength(0); // ...and the corpse is gone, which is why `r` is carried

    const hud = new HudView();
    hud.build(new Layers(), { w: 1280, h: 720 });
    const fx = fakeFx();
    new EventReactor(fx, hud, fakeAudio(), fakeHost()).consume(s.events);
    const debris = fx.particles.explosionDebris as unknown as ReturnType<typeof vi.fn>;
    expect(debris).toHaveBeenCalledTimes(1);
    const [, , , bodyPx] = debris.mock.calls[0] as [number, number, number, number];
    expect(bodyPx).toBeCloseTo(drawnR, 6);
    // Not the feet circle — the substitution that has already gone wrong twice on the engine
    // side of this same value (`DoorSystem`, the minion clamp; both fixed in v49).
    expect(bodyPx).not.toBeCloseTo(feetR, 1);
    // ...and in px, not fp. Stated as a bound rather than as "=== drawnR" a second time, so
    // this line fails for the one reason it is here for.
    expect(bodyPx).toBeLessThan(boss.radius as unknown as number);
  });

  it('does not burst for a player death — that branch is cue-only', () => {
    const hud = new HudView();
    hud.build(new Layers(), { w: 1280, h: 720 });
    const fx = fakeFx();
    new EventReactor(fx, hud, fakeAudio(), fakeHost()).consume([
      { type: 'death', id: 1, faction: 'player', gx: 0, gy: 0, r: pxToFp(15) } as GameEvent,
    ]);
    expect(fx.particles.explosionDebris).not.toHaveBeenCalled();
  });
});

describe('EventReactor — hit-flash outline (design/01 fidelity roadmap milestone 5)', () => {
  it('flashes the specific actor named by a hit event\'s `target` id', () => {
    const hud = new HudView();
    hud.build(new Layers(), { w: 1280, h: 720 });
    const onHurt = vi.fn();
    const host = fakeHost();
    (host.actorAt as ReturnType<typeof vi.fn>).mockReturnValue({ onHurt });
    const reactor = new EventReactor(fakeFx(), hud, fakeAudio(), host);
    reactor.consume([{ type: 'hit', target: 7, faction: 'player', gx: 0, gy: 0, damage: 1, damageType: 'physical' } as GameEvent]);
    expect(host.actorAt).toHaveBeenCalledWith(7);
    expect(onHurt).toHaveBeenCalled();
  });

  // 2026-08-26. `shield_break` grew a second fx call: the shell's own fragments
  // (`ParticleSystem.shieldShards`). Worth a test of its own because the POSITION is the part
  // that can be wrong invisibly — `shield_break` carries the target actor's centre (`combat.ts`
  // pushes `target.gx/gy`) while the neighbouring `hit` case carries the impact point, and a
  // ring of shards thrown from the wrong one of those still reads as "the shield broke".
  describe('shield_break spawns the shell fragments', () => {
    const breakAt = (gx: number, gy: number) => {
      const hud = new HudView();
      hud.build(new Layers(), { w: 1280, h: 720 });
      const fx = fakeFx();
      new EventReactor(fx, hud, fakeAudio(), fakeHost()).consume([
        { type: 'shield_break', id: 7, gx, gy } as GameEvent,
      ]);
      return fx.particles.shieldShards as unknown as ReturnType<typeof vi.fn>;
    };

    it('throws the ring from the event position, in screen px', () => {
      const shards = breakAt(pxToFp(300), pxToFp(200));
      expect(shards).toHaveBeenCalledTimes(1);
      const [x, y] = shards.mock.calls[0] as [number, number, number];
      expect(x).toBeCloseTo(300, 6);
      expect(y).toBeCloseTo(200, 6);
    });

    it('follows the actor rather than sitting at the origin', () => {
      // The failure this catches: a burst hard-coded to (0,0), or to the camera centre, which
      // looks plausible in any single screenshot of a fight near the middle of the room.
      const [x, y] = breakAt(pxToFp(-140), pxToFp(96)).mock.calls[0] as [number, number, number];
      expect(x).toBeCloseTo(-140, 6);
      expect(y).toBeCloseTo(96, 6);
    });

    it('does not fire on any other event that reaches the same switch', () => {
      const hud = new HudView();
      hud.build(new Layers(), { w: 1280, h: 720 });
      const fx = fakeFx();
      new EventReactor(fx, hud, fakeAudio(), fakeHost()).consume([
        { type: 'hit', target: 7, faction: 'player', gx: 0, gy: 0, damage: 1, damageType: 'physical' },
        { type: 'deflect', gx: 0, gy: 0 },
        { type: 'clash', gx: 0, gy: 0 },
      ] as GameEvent[]);
      expect(fx.particles.shieldShards).not.toHaveBeenCalled();
    });
  });

  // 2026-08-26. The shield shell dents where the hit LANDED (`EnergyShieldFilter.hit`), which
  // makes the delta this passes a load-bearing value rather than a decoration. It is also
  // completely invisible when wrong: a sign flip dents the far side, and "the shield deformed"
  // still reads as correct on screen. Nothing else in the suite covers this — the mutation
  // battery for the rewrite only mutates the shader and the tile, never this file.
  describe('hands the shell the direction the hit came from', () => {
    const fire = (target: { onHurt: ReturnType<typeof vi.fn>; x: number; y: number }, gx: number, gy: number) => {
      const hud = new HudView();
      hud.build(new Layers(), { w: 1280, h: 720 });
      const host = fakeHost();
      (host.actorAt as ReturnType<typeof vi.fn>).mockReturnValue(target);
      new EventReactor(fakeFx(), hud, fakeAudio(), host).consume([
        { type: 'hit', target: 7, faction: 'player', gx, gy, damage: 1, damageType: 'physical' } as GameEvent,
      ]);
      return target.onHurt.mock.calls[0] as [number, number];
    };
    // The actor is deliberately NOT at the origin: with it at (0,0) an implementation that
    // forwarded the impact's absolute position instead of the delta would produce the same
    // vector, and this whole describe would pass against it.
    const AT = { x: 300, y: 200 };

    it('points from the actor toward the impact, not the other way', () => {
      const t = { onHurt: vi.fn(), ...AT };
      // Impact one grid to the RIGHT of the actor: 300px is 9.375 grid, +1 grid = 332px.
      const [dx, dy] = fire(t, pxToFp(332), pxToFp(200));
      expect(dx).toBeGreaterThan(0);
      expect(Math.abs(dy)).toBeLessThan(1e-6);
    });

    it('flips with the impact side', () => {
      const right = fire({ onHurt: vi.fn(), ...AT }, pxToFp(332), pxToFp(200));
      const left = fire({ onHurt: vi.fn(), ...AT }, pxToFp(268), pxToFp(200));
      expect(Math.sign(right[0])).toBe(1);
      expect(Math.sign(left[0])).toBe(-1);
      expect(right[0]).toBeCloseTo(-left[0], 6); // symmetric about the actor
    });

    it('is a DELTA from the actor, not the impact position', () => {
      const t = { onHurt: vi.fn(), ...AT };
      const [dx, dy] = fire(t, pxToFp(332), pxToFp(232));
      expect(dx).toBeCloseTo(32, 6);
      expect(dy).toBeCloseTo(32, 6);
    });

    it('uses screen-down y, so a hit from below dents the bottom of the shell', () => {
      const t = { onHurt: vi.fn(), ...AT };
      const [, dy] = fire(t, pxToFp(300), pxToFp(264));
      expect(dy).toBeGreaterThan(0); // +y is DOWN on screen; the shader's dent axis assumes it
    });
  });

  it('is a no-op when the target id has no live view (already gone)', () => {
    const hud = new HudView();
    hud.build(new Layers(), { w: 1280, h: 720 });
    const reactor = new EventReactor(fakeFx(), hud, fakeAudio(), fakeHost());
    expect(() =>
      reactor.consume([{ type: 'hit', target: 99, faction: 'enemy', gx: 0, gy: 0, damage: 1, damageType: 'physical' } as GameEvent]),
    ).not.toThrow();
  });
});

describe('EventReactor — door lock/unlock (design/05 "Room & door model" DoorSystem)', () => {
  it('door_locked restyles the door fixture(s) via onDoorStateChange, given the active state', () => {
    const hud = new HudView();
    hud.build(new Layers(), { w: 1280, h: 720 });
    const host = fakeHost();
    // `players: []` rather than `{}`: `activeState()` is typed `GameState | null`, so a state
    // with no seat array is a shape the game never produces and the cast was hiding that.
    const state = { players: [] } as unknown as GameState;
    host.activeState = () => state;
    const reactor = new EventReactor(fakeFx(), hud, fakeAudio(), host);
    reactor.consume([{ type: 'door_locked', roomId: 'r1' } as GameEvent]);
    expect(host.onDoorStateChange).toHaveBeenCalledWith(state);
  });

  it('door_unlocked does the same', () => {
    const hud = new HudView();
    hud.build(new Layers(), { w: 1280, h: 720 });
    const host = fakeHost();
    const state = { players: [] } as unknown as GameState;
    host.activeState = () => state;
    const reactor = new EventReactor(fakeFx(), hud, fakeAudio(), host);
    reactor.consume([{ type: 'door_unlocked', roomId: 'r1' } as GameEvent]);
    expect(host.onDoorStateChange).toHaveBeenCalledWith(state);
  });

  it('is a no-op when there is no active state', () => {
    const hud = new HudView();
    hud.build(new Layers(), { w: 1280, h: 720 });
    const host = fakeHost(); // activeState() => null by default
    const reactor = new EventReactor(fakeFx(), hud, fakeAudio(), host);
    reactor.consume([{ type: 'door_locked', roomId: 'r1' } as GameEvent]);
    expect(host.onDoorStateChange).not.toHaveBeenCalled();
  });
});

describe('EventReactor — force_regroup (design/05 DoorSystem)', () => {
  function stateWithLocalPlayer(id: number): GameState {
    return { players: [{ id, gx: 0, gy: 0 }] } as unknown as GameState;
  }

  it('snaps the camera when the local player is among the regrouped ids', () => {
    const hud = new HudView();
    hud.build(new Layers(), { w: 1280, h: 720 });
    const host = fakeHost();
    host.activeState = () => stateWithLocalPlayer(7);
    const reactor = new EventReactor(fakeFx(), hud, fakeAudio(), host);
    reactor.consume([{ type: 'force_regroup', roomId: 'r1', playerIds: [7] } as GameEvent]);
    expect(host.onForceRegroup).toHaveBeenCalled();
  });

  it('is a no-op when the local player is not among the regrouped ids', () => {
    const hud = new HudView();
    hud.build(new Layers(), { w: 1280, h: 720 });
    const host = fakeHost();
    host.activeState = () => stateWithLocalPlayer(7);
    const reactor = new EventReactor(fakeFx(), hud, fakeAudio(), host);
    reactor.consume([{ type: 'force_regroup', roomId: 'r1', playerIds: [3, 9] } as GameEvent]);
    expect(host.onForceRegroup).not.toHaveBeenCalled();
  });

  it('is a no-op when there is no active state', () => {
    const hud = new HudView();
    hud.build(new Layers(), { w: 1280, h: 720 });
    const host = fakeHost(); // activeState() => null by default
    const reactor = new EventReactor(fakeFx(), hud, fakeAudio(), host);
    expect(() =>
      reactor.consume([{ type: 'force_regroup', roomId: 'r1', playerIds: [7] } as GameEvent]),
    ).not.toThrow();
    expect(host.onForceRegroup).not.toHaveBeenCalled();
  });
});

/**
 * The character-reaction cues (design/11, 2026-09-02). Three of the four are gated on the
 * LOCAL seat, and that gate is the whole design: `impact` already reports that a hit landed
 * somewhere, `death.enemy` that something died. What had no sound at all was the answer to
 * "was that me" — so a `hurt` or a `death.player` that fired for every actor would not be a
 * louder version of this feature, it would be the absence of it.
 */
describe('EventReactor — the cues that are about YOU (design/11)', () => {
  const LOCAL = 11;
  const OTHER = 12;

  function reactorFor(seatId: number | null) {
    const hud = new HudView();
    hud.build(new Layers(), { w: 1280, h: 720 });
    const audio = fakeAudio();
    const fx = fakeFx();
    const host = fakeHost();
    if (seatId !== null) {
      host.activeState = () =>
        ({ players: [{ id: seatId, gx: 0, gy: 0 }] }) as unknown as GameState;
    }
    return { reactor: new EventReactor(fx, hud, audio, host), audio, fx, host };
  }

  const hitOn = (target: number) => ({
    type: 'hit', target, faction: 'enemy', gx: 0, gy: 0, damage: 1, damageType: 'physical',
  }) as GameEvent;

  it('a hit on the local seat plays hurt AND impact — the pair IS the signal', () => {
    // Not either/or: `impact` places the hit in the world and `hurt` says whose body it was.
    // A version that replaced one with the other would lose half of what the frame knows.
    const { reactor, audio } = reactorFor(LOCAL);
    reactor.consume([hitOn(LOCAL)]);
    expect(cuesOf(audio).sort()).toEqual(['hurt', 'impact']);
  });

  it('a hit on anybody else plays impact alone', () => {
    const { reactor, audio } = reactorFor(LOCAL);
    reactor.consume([hitOn(OTHER)]);
    expect(cuesOf(audio)).toEqual(['impact']);
  });

  it('coalesces a burst of hits on the local seat into one hurt carrying the count', () => {
    const { reactor, audio } = reactorFor(LOCAL);
    reactor.consume([hitOn(LOCAL), hitOn(LOCAL), hitOn(OTHER)]);
    expect(audio.play).toHaveBeenCalledWith('hurt', 2);
    expect(audio.play).toHaveBeenCalledWith('impact', 3);
  });

  it('plays nothing seat-specific when there is no seat yet', () => {
    // A menu frame draining a stale queue: `activeState()` is null, so there is no local id.
    // The failure this pins is treating "no local actor" as actor 0, which would hand the
    // hurt cue to whichever entity happened to be first.
    const { reactor, audio } = reactorFor(null);
    reactor.consume([
      hitOn(0),
      { type: 'death', id: 0, faction: 'player', gx: 0, gy: 0, r: pxToFp(15) } as GameEvent,
    ]);
    expect(cuesOf(audio)).toEqual(['impact']);
  });

  it("the local seat's death plays death.player; another player's plays nothing", () => {
    const a = reactorFor(LOCAL);
    a.reactor.consume([{ type: 'death', id: LOCAL, faction: 'player', gx: 0, gy: 0, r: pxToFp(15) } as GameEvent]);
    expect(cuesOf(a.audio)).toEqual(['death.player']);

    const b = reactorFor(LOCAL);
    b.reactor.consume([{ type: 'death', id: OTHER, faction: 'player', gx: 0, gy: 0, r: pxToFp(15) } as GameEvent]);
    expect(b.audio.play).not.toHaveBeenCalled();
  });

  it('an enemy death still plays death.enemy, and never the run-ending fall', () => {
    const { reactor, audio, host } = reactorFor(LOCAL);
    reactor.consume([{ type: 'death', id: 99, faction: 'enemy', gx: 0, gy: 0, r: pxToFp(15) } as GameEvent]);
    expect(cuesOf(audio)).toEqual(['death.enemy']);
    expect(host.addScore).toHaveBeenCalled(); // the kill-score branch is untouched
  });

  it('being downed plays hurt, and coalesces with the hit that caused it', () => {
    // Going down is damage, so it takes the damage cue rather than a lifecycle one — a downed
    // player in co-op can be revived, and the run-ending fall would be a lie. In the frame
    // where both land, that is ONE louder hurt, which is what the moment should be.
    const { reactor, audio } = reactorFor(LOCAL);
    reactor.consume([
      hitOn(LOCAL),
      { type: 'downed', id: LOCAL, gx: 0, gy: 0 } as GameEvent,
    ]);
    expect(audio.play).toHaveBeenCalledWith('hurt', 2);
  });

  it('a teammate going down is SEEN but not heard', () => {
    // The split is deliberate: the fx stays ungated because a teammate collapsing is worth
    // looking at, while the cue is the local seat's own damage channel.
    const { reactor, audio, fx } = reactorFor(LOCAL);
    reactor.consume([{ type: 'downed', id: OTHER, gx: 0, gy: 0 } as GameEvent]);
    expect(audio.play).not.toHaveBeenCalled();
    expect(fx.addShake).toHaveBeenCalled();
    expect(fx.addHitStop).toHaveBeenCalled();
  });

  // ---- `win` is about whose run ended well (2026-09-02) ------------------------------
  //
  // The bug these pin was live and reproduced, not theoretical: `case 'win'` played the
  // jingle for ANY `win` event, and the event fires when anyone wins. With `?arenaDemo=1`,
  // downing the local seat and letting it bleed out produced `death.player:1` then `win:1`
  // in one frame with `phase === 'defeat'` — the victory sting over a defeat screen.
  //
  // Fixtures use the engine's REAL `createGameState` rather than the cast object literal the
  // cases above share, because the whole question turns on two fields those literals do not
  // have: `zoneEnabled` (which win model applies) and per-seat `teamId` (which squad won).
  // A cast fixture would pass while spelling either of them wrong.

  /** A finished arena match. `teams[i]` is seat i's squad; the local seat is seat 0
   *  (`fakeHost().localOwner`), and seat i's entity id is i + 1 (`GameState.nextId`). */
  function arenaReactor(teams: readonly number[]) {
    const hud = new HudView();
    hud.build(new Layers(), { w: 1280, h: 720 });
    const audio = fakeAudio();
    const host = fakeHost();
    const s = createGameState({
      seed: 1, worldW: 0, worldH: 0, waves: [], arena: MINI_ARENA,
      players: teams.map((teamId) => ({ teamId })),
    });
    host.activeState = () => s;
    return { reactor: new EventReactor(fakeFx(), hud, audio, host), audio, state: s };
  }

  const winBy = (winner: number | 'enemies' | null) => ({ type: 'win', winner }) as GameEvent;

  it('plays the jingle when the local seat itself is the named winner', () => {
    const { reactor, audio } = arenaReactor([0, 1]);
    reactor.consume([winBy(0)]);
    expect(cuesOf(audio)).toEqual(['win']);
  });

  it('a RIVAL winning plays the run-ending fall, never the jingle', () => {
    // The reported bug, at its smallest: someone won, and it was not us.
    const { reactor, audio } = arenaReactor([0, 1]);
    reactor.consume([winBy(1)]);
    expect(cuesOf(audio)).toEqual(['death.player']);
  });

  it("a squad-mate named as winner is still YOUR win — team membership, not seat identity", () => {
    // `WinConditionSystem.tickPlacement` names the winning squad's LOWEST seat, so a seat-
    // equality check hands most of a winning squad the defeat sound. That exact mistake was a
    // real bug on the screen side (fixed 2026-08-04); sharing `localSeatWon` is what stops the
    // audio side from having to make it again independently.
    const { reactor, audio } = arenaReactor([0, 1, 1, 0]);
    reactor.consume([winBy(3)]); // seat 3 shares the local seat's squad (team 0)
    expect(cuesOf(audio)).toEqual(['win']);
  });

  it('a rival SQUAD winning plays the fall even though a seat of ours outlived a seat of theirs', () => {
    const { reactor, audio } = arenaReactor([0, 1, 1, 0]);
    reactor.consume([winBy(1)]);
    expect(cuesOf(audio)).toEqual(['death.player']);
  });

  it('the local seat dying and the match ending in the same frame is ONE louder fall, not two sounds', () => {
    // The literal reproduced frame: `death.player` from the bleedout plus a rival's `win`.
    // Coalescing is what makes that one voice at higher gain — the same call design/11 makes
    // for `downed` plus the `hit` that caused it. Two separate cues here would be the bug's
    // twin: a second sound narrating the moment the first one already announced.
    const { reactor, audio, state } = arenaReactor([0, 1]);
    reactor.consume([
      { type: 'death', id: state.players[0]!.id, faction: 'player', gx: 0, gy: 0, r: pxToFp(15) } as GameEvent,
      winBy(1),
    ]);
    expect(audio.play).toHaveBeenCalledTimes(1);
    expect(audio.play).toHaveBeenCalledWith('death.player', 2);
  });

  it('a PvE run ends well for the whole party, not just for the seat the sim names', () => {
    // `WinConditionSystem`/`ExtractionSystem` both hardcode `winner: 0` (*"single-player:
    // player id 0"*), so in co-op the arena rule — is that seat mine? — would silence the
    // jingle for every seat but the first. PvE has no per-seat answer at all.
    const { reactor, audio } = reactorFor(LOCAL); // no `zoneEnabled` → the PvE model
    reactor.consume([winBy(0)]);
    expect(cuesOf(audio)).toEqual(['win']);
  });

  it("a PvE wipe ('enemies' won) plays the fall", () => {
    // The single-player defeat, and the one case where this cue says something no other cue
    // in the frame does: the seat is `downed`, not dead, so `hurt` is all that fired and
    // nothing yet said the fall was final.
    const { reactor, audio } = reactorFor(LOCAL);
    reactor.consume([
      { type: 'downed', id: LOCAL, gx: 0, gy: 0 } as GameEvent,
      winBy('enemies'),
    ]);
    expect(cuesOf(audio).sort()).toEqual(['death.player', 'hurt']);
  });

  it('reads the winner the EVENT announced, not the one the state happens to hold', () => {
    // The state is only consulted for the seats' teams; WHO won comes off the event. The two
    // agree in the real game (every producer sets `state.winner` and pushes the event in one
    // tick), which is exactly why the difference is invisible unless a test forces it apart —
    // so here the state carries the OPPOSITE winner from the event, and the event has to win.
    // Reading `s.winner` instead compiles, and with the two never disagreeing anywhere else in
    // this file it would stay green.
    const a = arenaReactor([0, 1]);
    a.state.winner = 1;            // the state says a rival took it
    a.reactor.consume([winBy(0)]);  // the event says we did
    expect(cuesOf(a.audio)).toEqual(['win']);

    const b = arenaReactor([0, 1]);
    b.state.winner = 0;            // ...and the mirror image
    b.reactor.consume([winBy(1)]);
    expect(cuesOf(b.audio)).toEqual(['death.player']);
  });

  it('plays NEITHER cue when there is no state to ask', () => {
    // A menu frame draining a stale queue. Guessing either way is worse than silence: the
    // jingle would be the original bug, and the fall would invent a defeat.
    const { reactor, audio } = reactorFor(null);
    reactor.consume([winBy(0), winBy('enemies')]);
    expect(audio.play).not.toHaveBeenCalled();
  });
});

/**
 * `spawn` — the one cue with no engine event behind it. `Scene` counts the actor views it
 * built this frame and `GameLoop` hands that count here, so these cases are about the
 * arithmetic at this end; `Scene.test.ts` owns whether the count itself is right.
 */
describe('EventReactor — the spawn count (design/11)', () => {
  function reactorWithAudio() {
    const hud = new HudView();
    hud.build(new Layers(), { w: 1280, h: 720 });
    const audio = fakeAudio();
    return { reactor: new EventReactor(fakeFx(), hud, audio, fakeHost()), audio };
  }

  it('plays one spawn cue carrying how many actors materialised', () => {
    // A room's wave arrives all at once: nine bodies must be one voice at higher gain, the
    // same rule design/11 states for ten hits in a frame.
    const { reactor, audio } = reactorWithAudio();
    reactor.consume([], 9);
    expect(audio.play).toHaveBeenCalledTimes(1);
    expect(audio.play).toHaveBeenCalledWith('spawn', 9);
  });

  it('plays nothing on a frame that built no views', () => {
    // The common case by far — every frame between waves. A cue at count 0 would be a voice
    // per frame, which is the mistake a truthy check would not catch.
    const { reactor, audio } = reactorWithAudio();
    reactor.consume([{ type: 'clash', gx: 0, gy: 0 } as GameEvent], 0);
    expect(cuesOf(audio)).toEqual(['clash']);
  });

  it('defaults to no spawns when the caller passes nothing', () => {
    // Every other case in this file calls `consume(events)` with one argument; the default is
    // what keeps that honest rather than silently meaning "one spawn".
    const { reactor, audio } = reactorWithAudio();
    reactor.consume([{ type: 'clash', gx: 0, gy: 0 } as GameEvent]);
    expect(cuesOf(audio)).toEqual(['clash']);
  });

  it('rides in the same coalescing map as the events, not around it', () => {
    const { reactor, audio } = reactorWithAudio();
    reactor.consume([{ type: 'bullet_fired', gx: 0, gy: 0, facing: 0 } as GameEvent], 2);
    expect(audio.play).toHaveBeenCalledTimes(2);
    expect(audio.play).toHaveBeenCalledWith('spawn', 2);
    expect(audio.play).toHaveBeenCalledWith('muzzle', 1);
  });
});

/** Which cues a fake bus was asked for, in call order. */
const cuesOf = (audio: ReturnType<typeof fakeAudio>): string[] =>
  (audio.play as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string);

describe('EventReactor — audio cue coalescing (design/11)', () => {
  function reactorWithAudio() {
    const hud = new HudView();
    hud.build(new Layers(), { w: 1280, h: 720 });
    const audio = fakeAudio();
    return { reactor: new EventReactor(fakeFx(), hud, audio, fakeHost()), audio };
  }

  const hit = (gx = 0) => ({
    type: 'hit', target: 7, faction: 'player', gx, gy: 0, damage: 1, damageType: 'physical',
  }) as GameEvent;

  it('plays a repeated cue ONCE, carrying how many events collapsed into it', () => {
    // design/11: ten hits in a frame are one impact at higher gain, not ten impacts. The
    // COUNT is what lets the mixer do the gain half — dropping it (a plain Set) is the
    // version this test exists to catch.
    const { reactor, audio } = reactorWithAudio();
    reactor.consume([hit(0), hit(1), hit(2)]);
    expect(audio.play).toHaveBeenCalledTimes(1);
    expect(audio.play).toHaveBeenCalledWith('impact', 3);
  });

  it('counts each cue separately, and plays each one once', () => {
    const { reactor, audio } = reactorWithAudio();
    reactor.consume([
      hit(0),
      hit(1),
      { type: 'bullet_fired', gx: 0, gy: 0, facing: 0 } as GameEvent,
      { type: 'clash', gx: 0, gy: 0 } as GameEvent,
    ]);
    expect(audio.play).toHaveBeenCalledWith('impact', 2);
    expect(audio.play).toHaveBeenCalledWith('muzzle', 1);
    expect(audio.play).toHaveBeenCalledWith('clash', 1);
    expect(audio.play).toHaveBeenCalledTimes(3);
  });

  it('starts a fresh count each frame', () => {
    const { reactor, audio } = reactorWithAudio();
    reactor.consume([hit(0), hit(1)]);
    reactor.consume([hit(0)]);
    expect(audio.play).toHaveBeenNthCalledWith(1, 'impact', 2);
    expect(audio.play).toHaveBeenNthCalledWith(2, 'impact', 1);
  });
});

/**
 * `bullet_fired` (2026-08-30, user report *"角色射击时，没有射击动画，枪口也没有射击特效"*).
 *
 * The old handler burst at the event's OWN position — the sim's muzzle, a flat `muzzleOffset`
 * along the aim ray on the GROUND plane — lifted by a hardcoded 12 px. That lands near the
 * character's middle, not at the gun the rig draws, which is why a muzzle effect that had
 * existed since 2026-07-26 read as absent. These pin the two things that changed: the fx are
 * anchored on the SHOOTER's drawn barrel tip, and the shot is reported back to that actor so
 * it can recoil.
 */
describe('EventReactor — a shot leaves the shooter, not the event position', () => {
  const SHOT = { type: 'bullet_fired', ownerId: 7, gx: pxToFp(100), gy: pxToFp(200), facing: 0 } as GameEvent;

  function shooter(muzzle: { x: number; y: number } | null) {
    return {
      onHurt: vi.fn(), onAttack: vi.fn(), muzzlePos: vi.fn(() => muzzle), x: 100, y: 200,
    };
  }

  function reactorWith(actor: ReturnType<typeof shooter> | undefined) {
    const fx = fakeFx();
    const host = { ...fakeHost(), actorAt: vi.fn(() => actor) };
    const hud = new HudView();
    hud.build(new Layers(), { w: 1280, h: 720 });
    return { fx, host, actor, reactor: new EventReactor(fx, hud, fakeAudio(), host) };
  }

  it('tells the shooter it fired, so the rig can recoil', () => {
    const actor = shooter({ x: 140, y: 150 });
    const { reactor, host } = reactorWith(actor);
    reactor.consume([SHOT]);
    expect(host.actorAt).toHaveBeenCalledWith(7);
    // Two arguments now: the shooter's own gun sizes and paces the kick. `undefined` here is
    // the honest answer for this fixture — `fakeHost().activeState()` is null (a menu frame
    // draining a stale queue), and the rig falls back to the starter blaster.
    expect(actor.onAttack).toHaveBeenCalledWith('ranged', undefined);
    expect(actor.onAttack).toHaveBeenCalledTimes(1);
  });

  /**
   * The melee half (ENGINE_VERSION 52). Before `melee_swing` existed the render layer was never
   * told a swing happened at all: `deflect` fires only when a swing catches a bullet and `hit`
   * only when it connects, so swinging at empty air reached the view as nothing.
   */
  it('tells the swinger it swung, off the melee event, with the melee kind', () => {
    const SWING = { type: 'melee_swing', ownerId: 7, gx: pxToFp(100), gy: pxToFp(200), facing: 0 } as GameEvent;
    const actor = shooter(null);
    const { reactor, host } = reactorWith(actor);
    reactor.consume([SWING]);
    expect(host.actorAt).toHaveBeenCalledWith(7);
    expect(actor.onAttack).toHaveBeenCalledWith('melee', undefined);
  });

  it('a swing draws no muzzle fx and costs no cue — a blade has no muzzle', () => {
    // The reason this is its own case and not folded into the one above: the two events carry
    // IDENTICAL fields, so the easy mistake is to route the swing through the ranged branch and
    // get a muzzle flare, flame, shell casing and a gunshot cue out of a sword.
    const SWING = { type: 'melee_swing', ownerId: 7, gx: pxToFp(100), gy: pxToFp(200), facing: 0 } as GameEvent;
    const { reactor, fx } = reactorWith(shooter({ x: 140, y: 150 }));
    reactor.consume([SWING]);
    expect(fx.muzzleFlare).not.toHaveBeenCalled();
    expect(fx.particles.muzzleFlame).not.toHaveBeenCalled();
    expect(fx.particles.shellCasing).not.toHaveBeenCalled();
  });

  it('survives a swinger whose view is already gone', () => {
    const SWING = { type: 'melee_swing', ownerId: 7, gx: pxToFp(0), gy: pxToFp(0), facing: 0 } as GameEvent;
    const { reactor } = reactorWith(undefined);
    expect(() => reactor.consume([SWING])).not.toThrow();
  });

  it('a swing plays its OWN cue, never the gunshot', () => {
    // This case used to assert the opposite — that a swing made no sound at all — and said in
    // its own comment that authoring a swing cue is what would change it. That happened
    // 2026-09-02. What it is pinning is unchanged and is the part that matters: `melee_swing`
    // and `bullet_fired` carry identical fields, so routing a swing through the ranged branch
    // would hand a sword the `muzzle` cue and nothing would look wrong.
    const SWING = { type: 'melee_swing', ownerId: 7, gx: pxToFp(0), gy: pxToFp(0), facing: 0 } as GameEvent;
    const audio = fakeAudio();
    const hud = new HudView();
    hud.build(new Layers(), { w: 1280, h: 720 });
    const host = { ...fakeHost(), actorAt: vi.fn(() => shooter({ x: 1, y: 2 })) };
    new EventReactor(fakeFx(), hud, audio, host).consume([SWING]);
    expect(audio.play).toHaveBeenCalledWith('swing', 1);
    expect(audio.play).toHaveBeenCalledTimes(1);
  });

  it('lands on the swinger the event names, not on whoever swung last', () => {
    // `actorAt(e.ownerId)` — the same resolution the ranged branch does. In a PvP arena eight
    // players can swing on one tick, and a dropped `ownerId` would animate one of them eight times.
    const a = shooter(null), b = shooter(null);
    const byId = new Map([[7, a], [9, b]]);
    const host = { ...fakeHost(), actorAt: vi.fn((id: number) => byId.get(id)) };
    const hud = new HudView();
    hud.build(new Layers(), { w: 1280, h: 720 });
    new EventReactor(fakeFx(), hud, fakeAudio(), host).consume([
      { type: 'melee_swing', ownerId: 9, gx: pxToFp(0), gy: pxToFp(0), facing: 0 } as GameEvent,
    ]);
    // `undefined` is the second argument: `fakeHost().activeState()` is null, so no weapon can
    // be resolved and the rig falls back to `DEFAULT_SWING`. The weapon-carrying path has its
    // own block at the bottom of this file.
    expect(b.onAttack).toHaveBeenCalledWith('melee', undefined);
    expect(a.onAttack).not.toHaveBeenCalled();
  });

  it('anchors flare, sparks and casing on the DRAWN barrel tip — all three at the same point', () => {
    const actor = shooter({ x: 140, y: 150 });
    const { reactor, fx } = reactorWith(actor);
    reactor.consume([SHOT]);
    expect(fx.muzzleFlare).toHaveBeenCalledWith(140, 150, 0, expect.any(Number));
    expect(fx.particles.muzzleFlame).toHaveBeenCalledWith(140, 150, 0, expect.any(Number));
    expect(fx.particles.shellCasing).toHaveBeenCalledWith(140, 150, 0);
  });

  it('points the flare along the shot, not along a fixed direction', () => {
    const actor = shooter({ x: 0, y: 0 });
    const { reactor, fx } = reactorWith(actor);
    reactor.consume([{ ...SHOT, facing: 16384 } as GameEvent]); // a quarter turn in brad
    const angle = (fx.muzzleFlare as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![2];
    expect(angle).toBeCloseTo(Math.PI / 2, 6);
  });

  // A skin that mounts no module at all (design/13's boss), one still on the Graphics
  // placeholder, and the frames before a weapon texture finishes preloading all report null.
  // Those must keep the pre-2026-08-30 behaviour rather than bursting at the origin.
  it('falls back to the sim position (lifted 12 px) when the skin mounts no weapon', () => {
    const { reactor, fx } = reactorWith(shooter(null));
    reactor.consume([SHOT]);
    expect(fx.muzzleFlare).toHaveBeenCalledWith(100, 200 - 12, 0, expect.any(Number));
    expect(fx.particles.shellCasing).toHaveBeenCalledWith(100, 200 - 12, 0);
  });

  it('still fires the fx when the shooter’s view is already gone', () => {
    const { reactor, fx } = reactorWith(undefined);
    expect(() => reactor.consume([SHOT])).not.toThrow();
    expect(fx.muzzleFlare).toHaveBeenCalledWith(100, 200 - 12, 0, expect.any(Number));
  });
});

/**
 * A shotgun volley — `SCATTERGUN_SIM` emits one `bullet_fired` PER PELLET in a single frame,
 * all from one actor (`engine/systems/ballistics.test.ts` pins that end). Worth its own test
 * because it is the only shape where the three reactions this handler runs disagree about
 * counting: the recoil must fire per pellet (each one restarts the same envelope, which is what
 * a fast weapon should look like), the fx must be per pellet, and the AUDIO must coalesce to
 * one cue carrying the count — design/11's "ten hits in one frame are one impact at higher
 * gain, not ten impacts".
 */
describe('EventReactor — a multi-pellet volley in one frame', () => {
  it('recoils and flares per pellet, but plays exactly one muzzle cue carrying the count', () => {
    const actor = { onHurt: vi.fn(), onAttack: vi.fn(), muzzlePos: vi.fn(() => ({ x: 12, y: 34 })), x: 0, y: 0 };
    const fx = fakeFx();
    const audio = fakeAudio();
    const hud = new HudView();
    hud.build(new Layers(), { w: 1280, h: 720 });
    const reactor = new EventReactor(fx, hud, audio, { ...fakeHost(), actorAt: vi.fn(() => actor) });

    const volley = [0, 1, 2, 3, 4].map((i) => ({
      type: 'bullet_fired', ownerId: 3, gx: pxToFp(0), gy: pxToFp(0), facing: 1000 * i,
    }) as GameEvent);
    reactor.consume(volley);

    expect(actor.onAttack).toHaveBeenCalledTimes(5);
    expect(fx.muzzleFlare).toHaveBeenCalledTimes(5);
    expect(audio.play).toHaveBeenCalledTimes(1);
    expect(audio.play).toHaveBeenCalledWith('muzzle', 5);
  });
});

/**
 * The melee sector arc's WIRING (2026-09-02). `fx/slashArc.test.ts` owns the geometry; what is
 * asserted here is the translation, which is the half that can silently be wrong: the event
 * carries no weapon, so this reactor resolves the swinger's spec out of `GameState` and converts
 * brad→rad, fp→px and ticks→ms on the way to the fx. Every one of those conversions is a place a
 * plausible-looking arc can end up at the wrong size.
 */
/**
 * The RANGED half of "the weapon that attacked drives the motion" (2026-09-02, asked directly
 * alongside the melee pass: *"the firing motion could use some optimisation too"*). Same shape as
 * the melee describe below and the same failure mode: the event carries no weapon, so this
 * reactor resolves the shooter's spec out of `GameState`, and a conversion that silently
 * returned nothing would leave every gun in the game kicking like the starter blaster — which is
 * exactly the state this replaced, and which looks perfectly fine on screen.
 */
describe('EventReactor — a shot carries the gun that fired it', () => {
  const BLASTER = WEAPON_SIM_BY_ID.blaster as RangedSimSpec;
  const SCATTERGUN = WEAPON_SIM_BY_ID.scattergun as RangedSimSpec;

  /** A state with one player and one enemy, either of which may hold `spec`. Both lists are
   *  present because `attacker` walks both — which is the point of the enemy case below. */
  function stateWith(
    who: 'player' | 'enemy' | 'none',
    spec: RangedSimSpec,
  ): GameState {
    const armed = { id: 7, radius: pxToFp(16), weapon: { spec } };
    const bare = { id: 7, radius: pxToFp(16), weapon: null };
    return {
      players: who === 'player' ? [armed] : [],
      enemies: who === 'enemy' ? [armed] : who === 'none' ? [bare] : [],
    } as unknown as GameState;
  }

  function fireWith(who: 'player' | 'enemy' | 'none', spec: RangedSimSpec) {
    const actor = {
      onHurt: vi.fn(), onAttack: vi.fn(), muzzlePos: vi.fn(() => null), x: 0, y: 0,
    };
    const host = {
      ...fakeHost(),
      activeState: () => stateWith(who, spec),
      actorAt: vi.fn(() => actor),
    };
    const hud = new HudView();
    hud.build(new Layers(), { w: 1280, h: 720 });
    new EventReactor(fakeFx(), hud, fakeAudio(), host).consume([
      { type: 'bullet_fired', ownerId: 7, gx: pxToFp(80), gy: pxToFp(120), facing: 0 } as GameEvent,
    ]);
    const calls = (actor.onAttack as unknown as { mock: { calls: [string, ShotShape?][] } })
      .mock.calls;
    return calls[0]?.[1];
  }

  it('hands the rig the shooter own cadence and per-pull damage', () => {
    const shape = fireWith('player', BLASTER)!;
    expect(shape.intervalMs).toBeCloseTo((6 * 1000) / 30, 6); // 6 ticks, the starter blaster
    expect(shape.punch).toBe(1); // 1 damage x 1 bullet
  });

  it('counts a pellet spread as ONE trigger pull, not five shots', () => {
    // The scattergun emits five `bullet_fired` events in one frame (see the volley describe
    // above), so the easy mistake is a per-BULLET punch — which would give each of the five
    // pellets the blaster's kick and make a shotgun the softest weapon in the game.
    const shape = fireWith('player', SCATTERGUN)!;
    expect(shape.punch).toBe(5); // 1 damage x 5 pellets
    expect(recoilSchedule(shape).modulePx).toBeGreaterThan(recoilSchedule(fireWith('player', BLASTER)!).modulePx);
  });

  it('resolves an ENEMY shooter, which is most of what fires in a run', () => {
    // The lookup this replaced only walked `state.players`, because it was written for the melee
    // branch where that is sufficient (no enemy in the roster carries a blade). Every mob in the
    // game shoots, so a players-only lookup would have handed the entire enemy roster the
    // fallback blaster kick and nothing would have looked broken.
    const shape = fireWith('enemy', ENEMY_GUN_SIM)!;
    expect(shape.intervalMs).toBeCloseTo((45 * 1000) / 30, 6); // 1.5 s — the roster's slowest
  });

  it('degrades rather than throwing on a state that carries only one of the two lists', () => {
    // Not hypothetical: the reactor is handed partial states by menu frames, stale queues and
    // most of the faked hosts in this repo's suites (`audio/audioPipeline.test.ts`'s is exactly
    // `{ players: [...] }`). Widening the lookup to a SECOND list is what made this reachable —
    // the previous players-only version could not touch a field that was not there — so it is
    // pinned here rather than left to whichever unrelated suite happens to notice.
    const bare = (state: unknown) => {
      const actor = {
        onHurt: vi.fn(), onAttack: vi.fn(), muzzlePos: vi.fn(() => null), x: 0, y: 0,
      };
      const host = {
        ...fakeHost(),
        activeState: () => state as GameState,
        actorAt: vi.fn(() => actor),
      };
      const hud = new HudView();
      hud.build(new Layers(), { w: 1280, h: 720 });
      const reactor = new EventReactor(fakeFx(), hud, fakeAudio(), host);
      return () => reactor.consume([
        { type: 'bullet_fired', ownerId: 9, gx: 0, gy: 0, facing: 0 } as GameEvent,
        { type: 'melee_swing', ownerId: 9, gx: 0, gy: 0, facing: 0 } as GameEvent,
      ]);
    };
    expect(bare({ players: [{ id: 1, radius: pxToFp(16), weapon: null }] })).not.toThrow();
    expect(bare({ enemies: [{ id: 1, radius: pxToFp(16), weapon: null }] })).not.toThrow();
    expect(bare({})).not.toThrow();
  });

  it('falls back to the starter blaster for a shooter with no weapon on the state', () => {
    // An actor already gone, or a frame where the shot outlives its owner. `undefined` reaches
    // `AttackMotion.kick`, which derives `DEFAULT_SHOT` — the blaster's own tuned envelope.
    expect(fireWith('none', BLASTER)).toBeUndefined();
    expect(recoilSchedule(undefined).totalMs).toBeCloseTo(RECOIL_MS, 6);
  });
});

describe('EventReactor — the melee swing carries the weapon that swung', () => {
  const SABER = WEAPON_SIM_BY_ID.saber as MeleeSimSpec;
  const HAMMER = WEAPON_SIM_BY_ID.hammer as MeleeSimSpec;
  const SPEAR = WEAPON_SIM_BY_ID.spear as MeleeSimSpec;

  /** A state holding one player at `id` with `spec` equipped — the narrow slice `attacker`
   *  reads (`players[]`/`enemies[]`, each entry's `id`/`radius`/`weapon.spec`), faked rather
   *  than driven through a real engine because what is under test is the translation, not the
   *  sim. `enemies` is present and empty rather than absent: the lookup walks BOTH lists since
   *  the ranged branch started using it, and a fake that omits one would throw on a miss. */
  function stateWith(id: number, spec: MeleeSimSpec | undefined): GameState {
    return {
      players: [{ id, radius: pxToFp(16), weapon: spec ? { spec } : null }],
      enemies: [],
    } as unknown as GameState;
  }

  function swingWith(spec: MeleeSimSpec | undefined, facing = 0) {
    const fx = fakeFx();
    const actor = { onHurt: vi.fn(), onAttack: vi.fn(), muzzlePos: vi.fn(() => null), x: 100, y: 200 };
    const host = {
      ...fakeHost(),
      activeState: () => stateWith(7, spec),
      actorAt: vi.fn(() => actor),
    };
    const hud = new HudView();
    hud.build(new Layers(), { w: 1280, h: 720 });
    new EventReactor(fx, hud, fakeAudio(), host).consume([
      { type: 'melee_swing', ownerId: 7, gx: pxToFp(80), gy: pxToFp(120), facing } as GameEvent,
    ]);
    const pose = (fx.slashArc as unknown as { mock: { calls: [SlashArcPose][] } }).mock.calls[0]?.[0];
    return { fx, actor, pose };
  }

  it('draws the arc at the weapon own sector and reach, not at a constant', () => {
    const { pose } = swingWith(SABER);
    // 162° authored → 81° each side, and 1.44 grid → 46 px. Both restated from
    // `weaponSpecs/starter.ts` rather than recomputed from the spec, so a spec change has to be
    // acknowledged here instead of the assertion following it silently.
    expect(pose!.arcHalfRad).toBeCloseTo((81 * Math.PI) / 180, 3);
    expect(pose!.outerPx).toBeCloseTo(46, 0);
    expect(pose!.innerPx).toBeCloseTo(16, 6); // the actor's own radius — the arc's inner edge
  });

  it('gives the hammer a wider arc and the spear a longer reach — the specs, not the animation', () => {
    // The two extremes of the roster, and the concrete statement of what this pass fixed: they
    // used to be drawn identically.
    const hammer = swingWith(HAMMER).pose!;
    const spear = swingWith(SPEAR).pose!;
    expect(hammer.arcHalfRad).toBeGreaterThan(spear.arcHalfRad * 3);
    expect(spear.outerPx).toBeGreaterThan(hammer.outerPx);
  });

  it('anchors the arc on the SIM swing origin, lifted to blade height', () => {
    // Not on the drawn body (which `muzzleFlare` uses): `meleeArc` measures `range` from the
    // actor's own gx/gy, and this fx exists to agree with the hit test.
    const { pose } = swingWith(SABER);
    expect(pose!.x).toBeCloseTo(80, 6);
    expect(pose!.y).toBeCloseTo(120 - 12, 6);
  });

  it('sweeps with the mirrored body when the swing points left', () => {
    expect(swingWith(SABER, 0).pose!.flipX).toBe(1);
    // Half a turn in brad — `facingFromAngle` reads the cosine's sign, so this is the mirror case.
    expect(swingWith(SABER, 32768).pose!.flipX).toBe(-1);
  });

  it('tints the arc by element, and falls back to the blade glow for physical', () => {
    expect(swingWith(SABER).pose!.color).toBe(THEME.colors.swordGlow); // the saber is physical
    expect(swingWith(WEAPON_SIM_BY_ID.emberblade as MeleeSimSpec).pose!.color)
      .toBe(THEME.colors.statusBurn);
  });

  it('schedules the arc inside the strike window of that weapon own envelope', () => {
    const { pose } = swingWith(SABER);
    // The saber's ACTIVE hit window (4 ticks), not its 11-tick recovery — ENGINE_VERSION 53.
    const schedule = swingSchedule(swingShapeOf(SABER));
    expect(pose!.delayMs).toBeCloseTo(schedule.strikeStartMs, 6);
    expect(pose!.sweepMs).toBeCloseTo(schedule.strikeEndMs - schedule.strikeStartMs, 6);
    // The whole fx has to be gone before the next swing of a held trigger starts one.
    expect(pose!.delayMs + pose!.sweepMs + pose!.fadeMs).toBeLessThan((11 * 1000) / 30);
  });

  it('hands the rig the same weapon shape it hands the arc', () => {
    // One spec, two consumers. If these ever disagreed the blade and the light on the ground
    // would sweep different arcs at different speeds, and each on its own would look fine.
    const { actor } = swingWith(HAMMER);
    const shape = (actor.onAttack as unknown as { mock: { calls: [string, SwingShape][] } })
      .mock.calls[0]![1]!;
    expect(shape.arcDeg).toBeCloseTo(220, 0);
    // The hammer's 6-tick window (ENGINE_VERSION 53's anchor for the STRIKE) AND its 20-tick
    // recovery (which sizes the follow-through, 2026-09-02) — both are read, and they are not
    // interchangeable. Both consumers read them off the same spec, which keeps them in step.
    expect(shape.windowMs).toBeCloseTo((6 * 1000) / 30, 0);
    expect(shape.recoveryMs).toBeCloseTo((20 * 1000) / 30, 0);
    // And the heft the body commits with: 12 grid/s as authored, converted out of the fp/tick
    // the sim holds it in — to within the sim's own truncation, which loses ~1% on the way in
    // (`toFpPerTick(12)` is 396, which reads back as 11.88; see `SwingShape.knockback`). The
    // roster's hardest shove, twice the saber's, which is the part the lunge reads.
    expect(shape.knockback).toBeCloseTo(12, 0.5);
    expect(shape.knockback / swingShapeOf(SABER).knockback).toBeCloseTo(2, 6);
  });

  it('finishes the whole sector fx inside every weapon own recovery, not just the saber', () => {
    // The arc outlives its own sweep by design (`delayMs + sweepMs + fadeMs`), so "it is gone
    // before the next swing" is a claim about a SUM, and it was pinned for the starter saber
    // only. The follow-through now derives from the recovery (2026-09-02), which moves the
    // envelope this fx schedules against for every weapon EXCEPT the saber — so the one weapon
    // that was covered is precisely the one that could not have caught a regression.
    //
    // A held trigger that restarts the arc while the last one is still fading stacks two sectors
    // at different angles, which reads as the blade hitting in a direction it is not pointing.
    for (const [id, spec] of Object.entries(WEAPON_SIM_BY_ID)) {
      if (spec.kind !== 'melee') continue;
      const { pose } = swingWith(spec);
      const recoveryMs = (spec.swingCooldownTicks * 1000) / 30;
      expect(pose!.delayMs + pose!.sweepMs + pose!.fadeMs, id).toBeLessThan(recoveryMs);
      // ...and the sweep is the strike itself, so the light is on the ground while the blade is.
      const schedule = swingSchedule(swingShapeOf(spec));
      expect(pose!.delayMs, id).toBeCloseTo(schedule.strikeStartMs, 6);
      expect(pose!.sweepMs, id).toBeCloseTo(schedule.strikeEndMs - schedule.strikeStartMs, 6);
    }
  });

  it('animates but draws no sector for a swinger whose weapon cannot be resolved', () => {
    // The normal case for an enemy: `meleeArc` only runs over `state.players`, and no enemy in
    // the roster carries a melee weapon. The clip and the cue must still fire — a swing that
    // animates nothing is worse than one drawn at a default size.
    const { fx, actor } = swingWith(undefined);
    expect(actor.onAttack).toHaveBeenCalledWith('melee', undefined);
    expect(fx.slashArc).not.toHaveBeenCalled();
  });

  it('falls back rather than mis-deriving when the event and the held weapon disagree', () => {
    // SWAP is one input away and the queue is drained a frame after the tick that filled it, so a
    // player can be holding the other kind by the time their own `melee_swing` is read. Deriving
    // a swing from a GUN's numbers is worse than falling back — `arcHalf`/`swingTicks` simply do
    // not exist on a `RangedSimSpec`, so every field would come out `NaN` and the blade would
    // freeze mid-air. `specOf` narrows on `kind` for exactly this, and nothing else covered it.
    const actor = { onHurt: vi.fn(), onAttack: vi.fn(), muzzlePos: vi.fn(() => null), x: 0, y: 0 };
    const host = {
      ...fakeHost(),
      activeState: () => ({
        players: [{ id: 7, radius: pxToFp(16), weapon: { spec: WEAPON_SIM_BY_ID.blaster } }],
        enemies: [],
      } as unknown as GameState),
      actorAt: vi.fn(() => actor),
    };
    const fx = fakeFx();
    const hud = new HudView();
    hud.build(new Layers(), { w: 1280, h: 720 });
    new EventReactor(fx, hud, fakeAudio(), host).consume([
      { type: 'melee_swing', ownerId: 7, gx: 0, gy: 0, facing: 0 } as GameEvent,
    ]);
    // The swing still animates — a stroke through empty air is a real action the player took —
    // but on the starter saber's shape rather than on a gun reinterpreted as a blade.
    expect(actor.onAttack).toHaveBeenCalledWith('melee', undefined);
    expect(fx.slashArc).not.toHaveBeenCalled(); // and no sector is drawn at a made-up size
  });

  it('draws no sector on a menu frame draining a stale swing', () => {
    // `activeState()` is null between runs, and the same queue is drained there.
    const fx = fakeFx();
    const hud = new HudView();
    hud.build(new Layers(), { w: 1280, h: 720 });
    new EventReactor(fx, hud, fakeAudio(), fakeHost()).consume([
      { type: 'melee_swing', ownerId: 7, gx: pxToFp(0), gy: pxToFp(0), facing: 0 } as GameEvent,
    ]);
    expect(fx.slashArc).not.toHaveBeenCalled();
  });
});

/**
 * The chest cue (design/05 "Chest rooms", 2026-09-15).
 *
 * A chest had no sound at all for its first day, and the silence was reported from real play as
 * the mechanic being broken — twice, by two different routes. So what these cases hold is the
 * two decisions that silence cost: that a chest makes ONE noise, and that BOTH kinds make it.
 */
describe('a chest opening', () => {
  const chestEvent = (kind: 'small' | 'big', id: number): GameEvent =>
    ({ type: 'chest_open', id, kind, gx: pxToFp(100), gy: pxToFp(100), weapons: 1 }) as GameEvent;

  function reactorWithAudio() {
    const audio = fakeAudio();
    const hud = new HudView();
    hud.build(new Layers(), { w: 1280, h: 720 });
    return { audio, hud, reactor: new EventReactor(fakeFx(), hud, audio, fakeHost()) };
  }

  it('plays the lid cue for a SMALL chest', () => {
    const { audio, reactor } = reactorWithAudio();
    reactor.consume([chestEvent('small', 1)]);
    expect(audio.play).toHaveBeenCalledWith('chest.open', 1);
  });

  it('plays the SAME cue for a big one — the difference between them is a thing you see', () => {
    // A big chest's ceremony is its ring of plates and the caption counting them
    // (`ui/ChestPrompt.ts`); giving it a second sound would be a vocabulary nobody asked for.
    const { audio, reactor } = reactorWithAudio();
    reactor.consume([chestEvent('big', 2)]);
    expect(audio.play).toHaveBeenCalledWith('chest.open', 1);
  });

  it('coalesces two chests opening in one frame into ONE cue at count 2', () => {
    // design/11's rule, and the reason `consume` keeps a COUNT rather than a set: ten hits in a
    // frame become one `impact` at higher gain, not ten voices. Two chests on one frame is
    // rare but reachable — a big chest's last plate can be stepped on at the moment a teammate
    // walks into a small one.
    const { audio, reactor } = reactorWithAudio();
    reactor.consume([chestEvent('small', 1), chestEvent('big', 2)]);
    expect(audio.play).toHaveBeenCalledTimes(1);
    expect(audio.play).toHaveBeenCalledWith('chest.open', 2);
  });

  it('says nothing else: no toast, no flash', () => {
    // The payout announces itself when it is COLLECTED (`pickup.weapon`, a tick later — pinned
    // in `engine/systems/chests.test.ts`), and the weapon panel that opens over the pile says
    // what came out. A toast here would be a third statement of one event.
    const fx = fakeFx();
    const audio = fakeAudio();
    const hud = new HudView();
    hud.build(new Layers(), { w: 1280, h: 720 });
    const toast = vi.spyOn(hud, 'toast');
    new EventReactor(fx, hud, audio, fakeHost()).consume([chestEvent('small', 1)]);
    expect(toast).not.toHaveBeenCalled();
    expect(fx.flash).not.toHaveBeenCalled();
    expect(audio.play).toHaveBeenCalledTimes(1); // the sound, and only the sound
  });
});

/**
 * The events nothing on the client reacts to yet.
 *
 * `blueprint_drop` was on this list (ENGINE_VERSION 63) until it was DELETED, not wired up
 * (ENGINE_VERSION 68): the boss schematic is now a real ground pickup, so its cue is an
 * ordinary `pickup`/`'schematic'` case like every other kind, not a second event type.
 * `chest_open` was on this list until 2026-09-15 and is the example of the list working: it
 * sat here for a day as "a chest pays out in silence", the silence was then reported from
 * real play as the mechanic being broken, and it is now wired to `chest.open`.
 * The shrinking zone's three events have been in the same position for longer, and
 * `EventReactor.ts`'s own comment on `zone_damage` says so ("this reactor has never handled
 * [it], and wiring that up is its own decision").
 *
 * Those comments are the problem this block replaces: a per-event note, written where the
 * decision was taken, that nobody reads when adding the NEXT event. The list below is one
 * place, and it is derived from the union rather than restated, so a new engine event lands
 * here as a red test with two honest ways out — wire it up, or add it and say why.
 */
describe('engine events the client deliberately does not react to', () => {
  const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
  const declared = [...read('../../../../engine/state/events.ts').matchAll(/\{ type: '([a-z_]+)'/g)].map((m) => m[1]!);
  const reacted = new Set([...read('./EventReactor.ts').matchAll(/case '([a-z_]+)':/g)].map((m) => m[1]!));

  /** Every engine event with no `case` in the reactor, and the reason each one is here. */
  const UNWIRED: Record<string, string> = {
    zone_warn: 'PvP zone UI is unbuilt (ROADMAP 4.2d)',
    zone_close: 'PvP zone UI is unbuilt (ROADMAP 4.2d)',
    zone_damage: 'the hurt cue fires on `hit`; zone ticks arrive here instead and are their own decision',
  };

  it('has an up-to-date list of them — a new engine event has to be classified', () => {
    expect(declared.length).toBeGreaterThan(15); // anti-vacuity: the regex really found the union
    expect(declared.filter((t) => !reacted.has(t)).sort()).toEqual(Object.keys(UNWIRED).sort());
  });

  it('every `case` in the reactor is a real engine event or a real pickup kind', () => {
    // The other direction: a `case` for an event the engine stopped emitting is dead code the
    // list above would never notice. `consume` also switches on a `pickup`'s own `kind` in the
    // same file, so those labels are legitimate — resolved against the engine's `PickupKind`
    // union rather than excused by name, or this test would wave through a typo'd event too.
    const kinds = /export type PickupKind =([^;]+);/.exec(read('../../../../engine/state/entities/world.ts'))![1]!;
    const pickupKinds = [...kinds.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
    expect(pickupKinds).toContain('weapon'); // anti-vacuity: the union really was found
    expect([...reacted].filter((t) => !declared.includes(t) && !pickupKinds.includes(t))).toEqual([]);
  });

});

describe('EventReactor — damage numbers (design/10)', () => {
  function reactorWithFx() {
    const hud = new HudView();
    hud.build(new Layers(), { w: 1280, h: 720 });
    const fx = fakeFx();
    return { fx, reactor: new EventReactor(fx, hud, fakeAudio(), fakeHost()) };
  }

  it('a hit spawns its number', () => {
    const { fx, reactor } = reactorWithFx();
    reactor.consume([{ type: 'hit', target: 9, faction: 'player', gx: pxToFp(0), gy: pxToFp(0), damage: 21, damageType: 'physical' }]);
    expect(fx.numbers.spawn).toHaveBeenCalledWith(9, 21, expect.any(Number), expect.any(Number), expect.any(Number), 'hit');
  });

  it('a crit hit spawns a crit number', () => {
    const { fx, reactor } = reactorWithFx();
    reactor.consume([{ type: 'hit', target: 9, faction: 'player', gx: pxToFp(0), gy: pxToFp(0), damage: 42, damageType: 'physical', crit: true }]);
    expect(fx.numbers.spawn).toHaveBeenCalledWith(9, 42, expect.any(Number), expect.any(Number), expect.any(Number), 'crit');
  });

  it("a heal on the local seat spawns a heal number; another seat's does not", () => {
    const hud = new HudView();
    hud.build(new Layers(), { w: 1280, h: 720 });
    const fx = fakeFx();
    const seats = { players: [{ id: 5, radius: pxToFp(16) }, { id: 6, radius: pxToFp(16) }], enemies: [] } as unknown as GameState;
    const reactor = new EventReactor(fx, hud, fakeAudio(), { ...fakeHost(), activeState: () => seats });
    reactor.consume([
      { type: 'heal', target: 5, gx: pxToFp(0), gy: pxToFp(0), amount: 1, pool: 'hp' },
      { type: 'heal', target: 6, gx: pxToFp(0), gy: pxToFp(0), amount: 1, pool: 'hp' },
    ]);
    expect(fx.numbers.spawn).toHaveBeenCalledTimes(1);
    expect(fx.numbers.spawn).toHaveBeenCalledWith(5, 1, expect.any(Number), expect.any(Number), expect.any(Number), 'heal');
  });

  it('a zone tick is numbered once, through its hit, and never again through zone_damage', () => {
    // EnvironmentSystem pushes both for one tick: the `hit` from takeDamage, then `zone_damage`.
    const { fx, reactor } = reactorWithFx();
    reactor.consume([
      { type: 'hit', target: 9, faction: 'environment', gx: pxToFp(0), gy: pxToFp(0), damage: 3, damageType: 'physical' },
      { type: 'zone_damage', target: 9, dmg: 3 },
    ]);
    expect(fx.numbers.spawn).toHaveBeenCalledTimes(1);
  });
});
