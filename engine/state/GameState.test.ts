import { describe, it, expect } from 'vitest';
import { createGameState } from '@dd/engine/state/GameState';
import { pxToFp } from '@dd/engine/content/convert';
import { PVP_SCALE_FACTOR } from '@dd/engine/balance/build';
import { BLASTER_SIM, SABER_SIM } from '@dd/engine/content/weapons';
import { SKIN_DEFS, DEFAULT_SKIN_ID } from '@dd/engine/content/skins';
import { PLAYER_BASE } from '@dd/engine/content/players';
import type { ArenaMap } from '@dd/engine/content/arenas';

const CONFIG = {
  seed: 12345,
  worldW: 1600,
  worldH: 1200,
  waves: [[[300, 300] as const, [1300, 300] as const]],
};

describe('GameState (plain data, design/08 schema)', () => {
  it('constructs idle at tick 0 with a single player at the world centre', () => {
    const s = createGameState(CONFIG);
    expect(s.phase).toBe('idle');
    expect(s.tick).toBe(0);
    expect(s.players).toHaveLength(1);
    expect(s.players[0]!.gx).toBe(pxToFp(800)); // world centre, px → grid-fp
    expect(s.players[0]!.gy).toBe(pxToFp(600));
    expect(s.players[0]!.weapon?.spec.kind).toBe('ranged');
    expect(s.enemies).toHaveLength(0);
  });

  it('the spawned player carries all three PLAYER_BASE radii (ENGINE_VERSION 43)', () => {
    const p = createGameState(CONFIG).players[0]!;
    expect(p.radius).toBe(PLAYER_BASE.radius);
    expect(p.footprintRadius).toBe(PLAYER_BASE.footprintRadius);
    expect(p.solidRadius).toBe(PLAYER_BASE.solidRadius); // the wall clearance, not the feet circle
  });

  it('nextId() is state-local and monotonic (no module global)', () => {
    const a = createGameState(CONFIG);
    const b = createGameState(CONFIG);
    // player took id 1 in each; both counters are independent and reproducible.
    expect(a.nextId()).toBe(2);
    expect(a.nextId()).toBe(3);
    expect(b.nextId()).toBe(2); // b's counter is not perturbed by a
  });

  it('injects distinct-seed PRNGs so streams do not alias', () => {
    const s = createGameState(CONFIG);
    const ai = s.aiPrng.nextInt(1_000_000);
    const combat = s.combatPrng.nextInt(1_000_000);
    const drop = s.dropPrng.nextInt(1_000_000);
    expect(new Set([ai, combat, drop]).size).toBe(3);
  });

  it('same seed → identical PRNG draws (replay foundation)', () => {
    const a = createGameState(CONFIG);
    const b = createGameState(CONFIG);
    expect(a.dropPrng.nextInt(1000)).toBe(b.dropPrng.nextInt(1000));
  });
});

describe('GameState.buildSeat — buildArenaSpecs wiring (design/15, ROADMAP 4.2c)', () => {
  const MINI_MAP: ArenaMap = {
    id: 'mini',
    sizeGrid: { w: 10, h: 10 },
    rooms: [{ id: 'A', rectGrid: { x: 0, y: 0, w: 10, h: 10 }, solids: [] }],
    doors: [],
    spawns: [{ x: 5, y: 5 }],
    eyeCandidates: [{ roomId: 'A' }],
  };

  it('an arena seat gets buildArenaSpecs\' arena HP/shield and landing-kit weapon, ignoring loadout', () => {
    const s = createGameState({
      seed: 1, worldW: 0, worldH: 0, waves: [], arena: MINI_MAP,
      players: [{ teamId: 0, loadout: ['saber'] }], // a PvE weapon id — must be ignored in arena mode
    });
    const p = s.players[0]!;
    const defaultSkin = SKIN_DEFS[DEFAULT_SKIN_ID]!;
    expect(p.maxHp).toBe(defaultSkin.pvp.maxHp);
    expect(p.maxShield).toBe(defaultSkin.pvp.maxShield);
    expect(p.hp).toBe(p.maxHp); // spawns full
    expect(p.shield).toBe(p.maxShield);
    expect(p.weapon?.spec.damage).toBe(Math.round(BLASTER_SIM.damage * PVP_SCALE_FACTOR)); // landing kit, not the PvE loadout
    // The kit is a gun + a melee weapon (ENGINE_VERSION 45), so the seat DOES spawn with
    // a saber — which makes the fairness assertion sharper, not weaker: the saber it holds
    // is the ARENA's scaled copy, not the PvE 'saber' the config asked for. A leaked PvE
    // spec would show up here as raw damage 2 against a 30 HP pool.
    expect(p.weapons).toHaveLength(PLAYER_BASE.weaponSlots);
    const melee = p.weapons.find((w) => w.spec.kind === 'melee');
    expect(melee).toBeDefined();
    expect(melee!.spec.damage).toBe(Math.round(SABER_SIM.damage * PVP_SCALE_FACTOR));
    expect(melee!.spec.damage).not.toBe(SABER_SIM.damage);
  });

  // The one place the character-capacity axis (ENGINE_VERSION 60) meets the PvP scale.
  // (maxHp, maxShield) get their own arena-scale numbers because weapon DAMAGE is scaled
  // alongside them, which is what preserves relative TTK. `energyCost` is NOT scaled — so
  // giving the pool an arena number too would not preserve a ratio, it would hand every
  // arena seat five times as many shots at the same price and remove the ammo economy
  // from PvP entirely. Asserted against the raw SkinDef number (not "!== the arena one")
  // so it still means something if either scale is ever retuned.
  it('an arena seat carries the character energy pool through UNSCALED, unlike hp/shield', () => {
    const s = createGameState({
      seed: 1, worldW: 0, worldH: 0, waves: [], arena: MINI_MAP,
      players: [{ teamId: 0, skinId: 'juggernaut' }],
    });
    const p = s.players[0]!;
    const skin = SKIN_DEFS.juggernaut!;
    expect(p.maxEnergy).toBe(skin.maxEnergy);
    expect(p.energy).toBe(skin.maxEnergy); // spawns full, like hp/shield
    expect(p.maxHp).toBe(skin.pvp.maxHp); // the arena pair, for contrast
    expect(p.maxHp).not.toBe(skin.maxHp);
  });

  it('an arena seat takes the RIGHT character\'s stats by skinId', () => {
    const s = createGameState({
      seed: 1, worldW: 0, worldH: 0, waves: [], arena: MINI_MAP,
      players: [{ teamId: 0, skinId: 'juggernaut' }],
    });
    const juggernaut = SKIN_DEFS['juggernaut']!;
    expect(s.players[0]!.maxHp).toBe(juggernaut.pvp.maxHp);
  });

  it('an arena seat carries PLAYER_BASE.solidRadius too — PvP walls are hugged like PvE ones', () => {
    // buildSeat is the ONLY place a PlayerActor is constructed, for both modes, but an
    // arena seat re-derives most of its stats through buildArenaSpecs — this pins that the
    // v43 clearance rides the shared path rather than the PvE-only branch.
    const s = createGameState({
      seed: 1, worldW: 0, worldH: 0, waves: [], arena: MINI_MAP,
      players: [{ teamId: 0 }, { teamId: 1 }],
    });
    for (const p of s.players) {
      expect(p.solidRadius).toBe(PLAYER_BASE.solidRadius);
      expect(p.footprintRadius).toBe(PLAYER_BASE.footprintRadius); // and the feet circle is untouched
    }
  });

  /**
   * Per-SEAT loadout resolution (ENGINE_VERSION 45). `buildSeat` runs once per seat, so
   * the "always a gun AND a melee weapon" invariant has to hold for a co-op ally too —
   * and an ally seat is the one shape that carries no `loadout` key at all, while the
   * local seat carries whatever the meta staged (`[]` on a fresh save). Both paths run
   * through the same construction, but nothing asserted that they BOTH end up armed for
   * the swap control until now.
   */
  it('every co-op seat spawns with both weapon kinds, whatever its own loadout key looks like', () => {
    const s = createGameState({
      seed: 1, worldW: 800, worldH: 600, waves: [],
      players: [{ loadout: [] }, {}, { loadout: ['repeater'] }, { loadout: ['ghost'] }],
    });
    expect(s.players).toHaveLength(4);
    for (const p of s.players) {
      expect(p.weapons).toHaveLength(PLAYER_BASE.weaponSlots);
      expect(new Set(p.weapons.map((w) => w.spec.kind))).toEqual(new Set(['ranged', 'melee']));
      // The active pointer and the slot cursor agree — what ApplyInputSystem.swap toggles.
      expect(p.weapon).toBe(p.weapons[p.activeSlot]);
    }
    // The one seat that staged a real weapon spawns holding it, not a default.
    expect(s.players[2]!.weapon?.spec.name).toBe('repeater');
  });

  it('a non-arena config is completely unaffected — plain unscaled SkinDef stats + real loadout', () => {
    const s = createGameState({
      seed: 1, worldW: 800, worldH: 600, waves: [],
      players: [{ teamId: 0 }],
    });
    const defaultSkin = SKIN_DEFS[DEFAULT_SKIN_ID]!;
    expect(s.players[0]!.maxHp).toBe(defaultSkin.maxHp); // unscaled
    expect(s.players[0]!.weapon?.spec.damage).toBe(BLASTER_SIM.damage); // unscaled default weapon
  });
});
