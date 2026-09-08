import { describe, it, expect, afterEach } from 'vitest';
import type { Container } from 'pixi.js';
import { createGameState } from '@dd/engine/state/GameState';
import type { GameState, EngineConfig } from '@dd/engine/state/GameState';
import type { PlacedRoom } from '@dd/engine/world/dungeon';
import type { Fp } from '@dd/engine/math/fixed';
import { WEAPON_PROMPT_RADIUS_FP } from './pickupProximity';
import { Layers } from '../scene/layers';
import { HudView, type HudContext } from './HudView';
import { StatChip } from './StatChip';
import { WeaponCard } from './WeaponCard';
import { setLocale, resetLocaleForTests, tName } from '../../i18n';

afterEach(() => resetLocaleForTests());

function newHud(): HudView {
  const hud = new HudView();
  hud.build(new Layers(), { w: 1280, h: 720 });
  return hud;
}

const CTX: HudContext = {
  localOwner: 0,
  score: 0,
  selectedSkin: 'skirmisher',
  showAlly: false,
  allySkinId: '',
  canSaveReplay: true,
};

const PVE_CFG: EngineConfig = { seed: 1, worldW: 800, worldH: 600, waves: [] };

function pveState(): GameState {
  return createGameState(PVE_CFG);
}

/** `createGameState` only sets `zoneEnabled` when `EngineConfig.arena` is provided
 *  (same minimal-arena helper shape engine/systems/revive.test.ts uses). */
function pvpState(): GameState {
  return createGameState({
    ...PVE_CFG,
    players: [{}, {}],
    arena: {
      id: 'mini',
      sizeGrid: { w: 10, h: 10 },
      rooms: [{ id: 'A', rectGrid: { x: 0, y: 0, w: 10, h: 10 }, solids: [] }],
      doors: [],
      spawns: [{ x: 5, y: 5 }],
      eyeCandidates: [{ roomId: 'A' }],
    },
  });
}

/** statsPanel is the first child added in build() — the only widget with no public
 *  handle, since nothing but this test ever needs to look at it. */
function statsPanelOf(hud: HudView): Container {
  return hud.view.children[0] as Container;
}

/** Minimal, well-typed `PlacedRoom` stand-in — these tests poke rooms directly into
 *  `dungeonRooms` to exercise the floor/room chips and the minimap without a real
 *  floor-generation pipeline (same shortcut this file always used); a bare `{}` no
 *  longer suffices now that the minimap adapter (`dungeonToArenaMap`) reads real
 *  room geometry off every entry. */
function fakeRoom(id: string, offsetXGrid = 0): PlacedRoom {
  return {
    id,
    piece: { id, sizeGrid: { w: 20, h: 16 }, solids: [], spawns: { player: [], enemy: [] }, exits: [] },
    offsetXGrid,
    offsetYGrid: 0,
    entranceGrid: { x: 0, y: 0 },
  };
}

describe('HudView — stat cluster backing panel', () => {
  it('widens to fit a long character name instead of clipping or leaving it unbacked', () => {
    const hud = newHud();
    const s = pveState();

    hud.update(s, 16, CTX);
    const narrowWidth = statsPanelOf(hud).width;

    hud.update(s, 16, { ...CTX, selectedSkin: 'a-very-long-character-skin-name-indeed' });

    expect(statsPanelOf(hud).width).toBeGreaterThan(narrowWidth);
  });

  it('grows taller when the co-op ally row is shown', () => {
    const hud = newHud();
    const s = createGameState({ ...PVE_CFG, players: [{}, {}] }); // a 2nd seat, ROADMAP 3.1

    hud.update(s, 16, CTX);
    const soloHeight = statsPanelOf(hud).height;

    hud.update(s, 16, { ...CTX, showAlly: true, allySkinId: 'juggernaut' });

    expect(statsPanelOf(hud).height).toBeGreaterThan(soloHeight);
  });
});

describe('HudView — stat chips (design/10, replaced the monospace info line)', () => {
  it('shows the dungeon chips and hides the PvP-only ones', () => {
    const hud = newHud();
    hud.update(pveState(), 16, CTX);

    expect(hud.chips.get('floor')!.view.visible).toBe(true);
    expect(hud.chips.get('room')!.view.visible).toBe(true);
    expect(hud.chips.get('enemies')!.view.visible).toBe(true);
    expect(hud.chips.get('banked')!.view.visible).toBe(true);
    expect(hud.chips.get('score')!.view.visible).toBe(true);
    expect(hud.chips.get('stage')!.view.visible).toBe(false);
    expect(hud.chips.get('alive')!.view.visible).toBe(false);
  });

  it('swaps to the PvP chip set once the arena zone is enabled', () => {
    const hud = newHud();
    const s = pvpState();
    expect(s.zoneEnabled).toBe(true);

    hud.update(s, 16, CTX);

    expect(hud.chips.get('stage')!.view.visible).toBe(true);
    expect(hud.chips.get('alive')!.valueText).toBe('2/2');
    expect(hud.chips.get('floor')!.view.visible).toBe(false);
    expect(hud.chips.get('enemies')!.view.visible).toBe(false);
  });

  it('drops the buffs chip out of the row while the run has none', () => {
    const hud = newHud();
    const s = pveState();

    hud.update(s, 16, CTX);
    expect(hud.chips.get('buffs')!.view.visible).toBe(false);

    s.players[0]!.buffs.push({ kind: 'damage', magnitude: 1, ticksLeft: 100 } as never);
    hud.update(s, 16, CTX);
    expect(hud.chips.get('buffs')!.view.visible).toBe(true);
    expect(hud.chips.get('buffs')!.valueText).toBe('1');
  });

  it('lays the visible chips out left to right without overlapping', () => {
    const hud = newHud();
    hud.update(pveState(), 16, CTX);

    const row = [...hud.chips.values()].filter((c) => c.view.visible).sort((a, b) => a.view.x - b.view.x);
    expect(row.length).toBeGreaterThan(1);
    for (let i = 1; i < row.length; i++) {
      expect(row[i]!.view.x).toBeGreaterThanOrEqual(row[i - 1]!.view.x + row[i - 1]!.width);
    }
    // All on one row.
    expect(new Set(row.map((c) => c.view.y)).size).toBe(1);
  });

  it('reports the floor and room the state is actually on', () => {
    // Co-resident room/door model (design/05, 2026-08-04): the floor's room COUNT is
    // `dungeonRooms.length` (every room placed at once); WHICH room is per-player
    // (`roomId`, looked up via `dungeonRoomIndexById`) rather than a single global
    // cursor — a real `PlacedRoom` shape isn't needed since HudView only reads length.
    const hud = newHud();
    const s = pveState();
    s.floorIndex = 1;
    s.dungeonRooms.push(fakeRoom('r0', 0), fakeRoom('r1', 20), fakeRoom('r2', 40), fakeRoom('r3', 60)); // 4 rooms this floor
    s.dungeonRoomIndexById.set('r2', 2);
    s.players[0]!.roomId = 'r2';

    hud.update(s, 16, CTX);

    // "/5" is level 1's floor count (EMBER_DUNGEON, world/rooms/ember.ts) — the chip
    // reads the live config via `totalFloorCount`, so this tracks the shipped level.
    expect(hud.chips.get('floor')!.valueText).toBe('2/5');
    expect(hud.chips.get('room')!.valueText).toBe('3/4');
  });

  it('falls back to room 1 before the local player\'s roomId resolves to any placed room', () => {
    // The one-tick activation lag right after a fresh floor places (design/05,
    // 2026-08-04): dungeonRooms is already populated, but EnvironmentSystem hasn't
    // confirmed the player's roomId against it yet — `dungeonRoomIndexById.get`
    // returns undefined, which must read as "room 1", not crash or show "0/3".
    const hud = newHud();
    const s = pveState();
    s.dungeonRooms.push(fakeRoom('r0', 0), fakeRoom('r1', 20), fakeRoom('r2', 40));
    expect(s.players[0]!.roomId).toBeUndefined();

    hud.update(s, 16, CTX);

    expect(hud.chips.get('room')!.valueText).toBe('1/3');
  });

  // design/10 screen-flow gap: the floor chip used to hardcode EMBER_DUNGEON.floorCount
  // regardless of the run's actual config — harmless while the ember dungeon was the
  // only floored content, wrong for a flat (non-dungeon) floors config like the
  // tutorial level (ROADMAP totalFloorCount fix, floorCount.ts).
  it('reports a flat (non-dungeon) floors config\'s own floor count, not the ember-dungeon default', () => {
    const hud = newHud();
    const s = createGameState({ ...PVE_CFG, floors: [[[[100, 100]]]] }); // 1 extra floor → 2 total
    expect(s.dungeonEnabled).toBe(false);

    hud.update(s, 16, CTX);

    expect(hud.chips.get('floor')!.valueText).toBe('1/2');
  });
});

describe('HudView — weapon card', () => {
  it('names the equipped weapon and its damage badge', () => {
    const hud = newHud();
    const s = pveState();
    const spec = s.players[0]!.weapon!.spec;

    hud.update(s, 16, CTX);

    // Translated display name (tName(spec.nameKey)), not the raw catalog id (spec.name,
    // which is now the render/texture-lookup key only) — the fix this test now guards.
    expect(hud.weaponCard.nameText).toBe(tName(spec.nameKey));
    expect(hud.weaponCard.nameText).not.toBe(spec.name);
    expect(hud.weaponCard.damageText).toContain(String(spec.damage));
    expect(hud.weaponCard.subText).toContain(spec.damageType);
  });

  it('falls back to an unarmed card with no damage badge', () => {
    const hud = newHud();
    const s = pveState();
    s.players[0]!.weapon = null;

    hud.update(s, 16, CTX);

    expect(hud.weaponCard.nameText).toBe('NO WEAPON');
    expect(hud.weaponCard.damageText).toBe('');
  });
});

describe('HudView — idle weapon slot chip (design/10 HUD follow-up, 2026-08-12)', () => {
  it('shows the other carried weapon for the default two-weapon loadout', () => {
    const hud = newHud();
    const s = pveState();
    const p = s.players[0]!;
    expect(p.weapons.length).toBe(2);
    const otherSpec = p.weapons[(p.activeSlot + 1) % p.weapons.length]!.spec;

    hud.update(s, 16, CTX);

    expect(hud.weaponSlotChip.view.visible).toBe(true);
    expect(hud.view.children).toContain(hud.weaponSlotChip.view);
    expect(hud.weaponSlotChip.view.position.x).toBeGreaterThan(hud.weaponCard.view.position.x + hud.weaponCard.estimatedWidth());
    void otherSpec; // exercised via bindIcon/redraw internally — no public getter to assert the spec name against
  });

  /**
   * The regression the live report was: *"角色可以同时持有一把近战武器和一把枪，并且在ui上
   * 我标注的位置可以进行切换。我记得之前实现过一次"* — screenshot showed one weapon and an
   * empty tile where this chip belongs (ENGINE_VERSION 45).
   *
   * `pveState()` above builds its config with NO `loadout` field, which was always the
   * two-weapon path — so this suite passed all the way through the bug. What a real run
   * actually passes is `loadout: <the staged meta array>`, and `[]` (a fresh save, or any
   * run after the previous one consumed its crafted weapons) used to resolve to a lone
   * pistol, at which point the chip hid ITSELF by design and the swap verb vanished with
   * nothing red anywhere. So these cases source their state from the real producer with
   * the configs `Game.beginRun` really builds, not from a hand-written weapons array.
   */
  it.each([
    ['an empty staged loadout (fresh save, or a run after the last one consumed its crafts)', [] as string[]],
    ['a half-crafted loadout — one gun, melee slot filled by the starter saber', ['repeater']],
    ['a half-crafted loadout — one blade, gun slot filled by the starter blaster', ['emberblade']],
    ['an all-unknown loadout (a save written by a newer build)', ['ghost']],
  ])('shows the chip for %s', (_label, loadout) => {
    const hud = newHud();
    const s = createGameState({ ...PVE_CFG, loadout });
    const p = s.players[0]!;

    hud.update(s, 16, CTX);

    expect(p.weapons).toHaveLength(2);
    expect(new Set(p.weapons.map((w) => w.spec.kind))).toEqual(new Set(['ranged', 'melee']));
    expect(hud.weaponSlotChip.view.visible).toBe(true);
    // ...and it lands where the report circled it: right of the weapon card, same row.
    expect(hud.weaponSlotChip.view.position.x).toBeGreaterThan(hud.weaponCard.view.position.x + hud.weaponCard.estimatedWidth());
    expect(hud.weaponSlotChip.view.position.y).toBeLessThan(hud.weaponCard.view.position.y + WeaponCard.HEIGHT);
  });

  it('shows in a PvP arena too — the landing kit is a pair, so the swap verb exists there', () => {
    // PvP does not go through `resolveLoadout` at all (the fairness wall: `buildArenaSpecs`
    // reads an arena-scoped preset and never the PvE meta), so the invariant has to be
    // observed separately on this side. A one-weapon kit hid this chip in every arena match.
    const hud = newHud();
    const s = pvpState();
    const p = s.players[0]!;

    hud.update(s, 16, CTX);

    expect(p.weapons.length).toBeGreaterThan(1);
    expect(new Set(p.weapons.map((w) => w.spec.kind))).toEqual(new Set(['ranged', 'melee']));
    expect(hud.weaponSlotChip.view.visible).toBe(true);
  });

  it('hides when the loadout has only one weapon', () => {
    const hud = newHud();
    const s = pveState();
    s.players[0]!.weapons.length = 1;

    hud.update(s, 16, CTX);

    expect(hud.weaponSlotChip.view.visible).toBe(false);
  });

  it('tapping it fires onSwapWeapon — Game wires this to the same builder.requestSwap() the keyboard/touch swap uses', () => {
    const hud = newHud();
    hud.update(pveState(), 16, CTX);
    let fired = 0;
    hud.onSwapWeapon = () => { fired++; };

    hud.weaponSlotChip.onTap?.();

    expect(fired).toBe(1);
  });
});

describe('HudView — player card', () => {
  it('titles the card with the selected character\'s translated name', () => {
    const hud = newHud();
    hud.update(pveState(), 16, CTX);
    expect(hud.playerCard.displayName).toBe('Skirmisher');
  });
});

describe('HudView — weapon-pickup panel placement (design/03)', () => {
  // Regression (pre-dates the click-to-collect panel, back when this was the ground
  // compare card): the card used to sit at a hardcoded x=220, chosen when the HUD panel
  // was a fixed 220 wide. The rebuilt panel is wider (and varies with the locale and
  // the character name), so a fixed offset put the card straight on top of it.
  it('sits clear of the backing panel, not on top of it', () => {
    const hud = newHud();
    hud.update(pveState(), 16, CTX);
    expect(hud.weaponPickupPrompt.view.x).toBeGreaterThan(statsPanelOf(hud).width);
  });

  it('slides right when the panel grows', () => {
    const hud = newHud();
    const s = pveState();

    hud.update(s, 16, CTX);
    const near = hud.weaponPickupPrompt.view.x;

    hud.update(s, 16, { ...CTX, selectedSkin: 'a-very-long-character-skin-name-indeed' });

    expect(hud.weaponPickupPrompt.view.x).toBeGreaterThan(near);
    expect(hud.weaponPickupPrompt.view.x).toBeGreaterThan(statsPanelOf(hud).width);
  });

  it('stays hidden while no floor weapon is in reach', () => {
    const hud = newHud();
    hud.update(pveState(), 16, CTX);
    expect(hud.weaponPickupPrompt.view.visible).toBe(false);
  });

  it('opens and lists a weapon pickup dropped at the player position', () => {
    const hud = newHud();
    const s = pveState();
    const p = s.players[0]!;
    s.pickups.push({
      id: s.nextId(), kind: 'weapon', weaponId: 'blaster',
      gx: p.gx, gy: p.gy, spawnTick: -1, alive: true,
    });

    hud.update(s, 16, CTX);

    expect(hud.weaponPickupPrompt.isOpen).toBe(true);
  });

  /**
   * What the panel is FED, not where it is put — `HudView.updateWeaponPickupPrompt` is the
   * one and only production call site of `nearbyWeaponPickups`, and until these two cases
   * nothing anywhere asserted the arguments it passes.
   *
   * That gap is not academic, it is exactly the *"无法拾取"* shape: the panel decides whether
   * a weapon gets a clickable row and `PickupSystem` independently decides whether to honour
   * the click, so the two can disagree with both packages green. `pickupProximity.test.ts`
   * proves the panel ring agrees with the sim's gate, but it calls
   * `nearbyWeaponPickups(..., WEAPON_PROMPT_RADIUS_FP)` itself — so what it pins is a
   * property of the CONSTANT. Moving the constant out of `HudView` (2026-08-31) removed the
   * duplicate definition and left the USE unpinned; all three of these survived:
   *
   *   - radius → `SIM.pickupRadius` (469 fp): the panel goes silent at the very distances the
   *     report was filed at, 469..2500 fp, and there is no other way to collect a floor weapon;
   *   - radius → `SIM.lootRevealRadius * 3`: the panel offers rows `PickupSystem` refuses,
   *     which is the same bug read from the other side — a row that does nothing when tapped;
   *   - `p.gx, p.gy` → `p.gy, p.gx`: proximity measured from a mirrored point. Invisible on
   *     any fixture where the player sits on the diagonal, which is why the default spawn
   *     (12500, 9375) is used as-is rather than moved somewhere tidy.
   */
  const nearFar = (s: GameState) => {
    const p = s.players[0]!;
    // Straddling the ring by 50 fp either side: close enough that only the radius ARGUMENT
    // separates them, far enough that fp rounding cannot.
    const near = { id: s.nextId(), kind: 'weapon' as const, weaponId: 'blaster', gx: (p.gx + (WEAPON_PROMPT_RADIUS_FP as number) - 50) as Fp, gy: p.gy, spawnTick: -1, alive: true };
    const far = { id: s.nextId(), kind: 'weapon' as const, weaponId: 'saber', gx: (p.gx + (WEAPON_PROMPT_RADIUS_FP as number) + 50) as Fp, gy: p.gy, spawnTick: -1, alive: true };
    s.pickups.push(near, far);
    return { near, far };
  };

  /** Which items the panel actually offers, in row order — read by firing each row's own
   *  tap handler, i.e. through the same `onPick` path `Game` wires to `requestPickup`. A
   *  row that reports no id is not a row a player can collect with. */
  const offeredIds = (hud: HudView): number[] => {
    const ids: number[] = [];
    hud.weaponPickupPrompt.onPick = (id) => ids.push(id);
    for (const row of (hud.weaponPickupPrompt as unknown as { rows: Array<{ onTap: (() => void) | null }> }).rows) {
      row.onTap?.();
    }
    return ids;
  };

  it('offers the weapon inside the panel ring and not the one outside it', () => {
    const hud = newHud();
    const s = pveState();
    const { near } = nearFar(s);

    hud.update(s, 16, CTX);

    expect(hud.weaponPickupPrompt.isOpen).toBe(true);
    expect(offeredIds(hud)).toEqual([near.id]);
  });

  it('offers BOTH once the far one is inside too — the single row above is a decision, not a cap', () => {
    // Anti-vacuity control for the case above: if the panel could only ever show one row (or
    // if `nearFar`'s far item were malformed and silently skipped), `[near.id]` would pass for
    // free and the "radius is too wide" mutation would survive on a technicality.
    const hud = newHud();
    const s = pveState();
    const { near, far } = nearFar(s);
    far.gx = (near.gx - 100) as Fp; // now nearer than `near`, so row ORDER is observable too

    hud.update(s, 16, CTX);

    expect(offeredIds(hud)).toEqual([far.id, near.id]); // nearest first
  });
});

describe('HudView — mode-dependent widgets', () => {
  // The minimap is the one HUD element mounted OUTSIDE `view` (its visibility is driven by
  // zoneEnabled/dungeonRooms, not by phase), which makes where it lands easy to get wrong.
  // It must be a sibling of `view` inside `hudOverlay` — real screen space, under the menus.
  // Mounted straight into `layers.ui` (as it was until 2026-08-25) it outranks `layers.menu`
  // and paints over the pause menu; mounted inside `layers.menu` it would inherit the menus'
  // fit-scale and shrink on a phone.
  it('mounts the minimap into hudOverlay — beside the HUD, not inside it and not in the menu layer', () => {
    const layers = new Layers();
    const hud = new HudView();
    hud.build(layers, { w: 1280, h: 720 });
    expect(hud.minimap.view.parent).toBe(layers.hudOverlay);
    expect(hud.view.children).not.toContain(hud.minimap.view);
    expect(layers.ui.children).not.toContain(hud.minimap.view);
    expect(layers.menu.children).not.toContain(hud.minimap.view);
  });

  it('shows the minimap for a PvP arena, reading state.arenaMap/zone', () => {
    const hud = newHud();
    hud.update(pvpState(), 16, CTX);
    expect(hud.minimap.view.visible).toBe(true);
  });

  it('shows the minimap for a PvE floor (design/05 "fully-realized branching" follow-up, 2026-08-05 — replaces the old FloorProgress track)', () => {
    const hud = newHud();
    const s = pveState();
    s.dungeonRooms.push(fakeRoom('r0', 0), fakeRoom('r1', 20), fakeRoom('r2', 40));

    hud.update(s, 16, CTX);

    expect(hud.minimap.view.visible).toBe(true);
  });

  it('hides the minimap for a flat (non-dungeon) config with no rooms placed and no arena', () => {
    const hud = newHud();
    const s = pveState(); // dungeonRooms is empty by default for a non-dungeon config

    hud.update(s, 16, CTX);

    expect(hud.minimap.view.visible).toBe(false);
  });

  it('survives a viewport resize (reposition is called on every relayout)', () => {
    const hud = newHud();
    hud.update(pveState(), 16, CTX);
    expect(() => hud.reposition({ w: 480, h: 900 })).not.toThrow();
    expect(() => hud.update(pveState(), 16, CTX)).not.toThrow();
  });

  it('accepts a toast without a live run behind it', () => {
    const hud = newHud();
    expect(() => hud.toast('+1 ember', 0xffffff)).not.toThrow();
    hud.update(pveState(), 16, CTX);
  });
});

describe('HudView — ally row revive progress (design/10 open question, ROADMAP 3.2)', () => {
  it('passes the ally\'s reviveProgressTicks through to a REVIVING readout', () => {
    const hud = newHud();
    const s = createGameState({ ...PVE_CFG, players: [{}, {}] });
    const ally = s.players[1]!;
    ally.downed = true;
    ally.bleedoutTicks = 60;
    ally.reviveProgressTicks = 225; // REVIVE_CHANNEL_TICKS is 450 → 50%

    hud.update(s, 16, { ...CTX, showAlly: true, allySkinId: 'juggernaut' });

    expect(hud.allyRow.statusText).toBe('REVIVING 50%');
  });

  it('falls back to the bleedout countdown when the ally has no revive in progress', () => {
    const hud = newHud();
    const s = createGameState({ ...PVE_CFG, players: [{}, {}] });
    const ally = s.players[1]!;
    ally.downed = true;
    ally.bleedoutTicks = 60;

    hud.update(s, 16, { ...CTX, showAlly: true, allySkinId: 'juggernaut' });

    expect(hud.allyRow.statusText).toBe('DOWNED 2s');
  });
});

describe('HudView — local downed banner (design/10 open question, ROADMAP 3.2)', () => {
  it('stays hidden while the local player is up', () => {
    const hud = newHud();
    hud.update(pveState(), 16, CTX);
    expect(hud.downedBanner.view.visible).toBe(false);
  });

  it('shows once the local player goes down', () => {
    const hud = newHud();
    const s = pveState();
    s.players[0]!.downed = true;
    s.players[0]!.bleedoutTicks = 60;

    hud.update(s, 16, CTX);

    expect(hud.downedBanner.view.visible).toBe(true);
    expect(hud.downedBanner.detailText).toContain('2'); // 60 ticks / 30 tick-rate
  });

  it('switches to a revive-progress readout once a teammate\'s channel starts', () => {
    const hud = newHud();
    const s = pveState();
    s.players[0]!.downed = true;
    s.players[0]!.bleedoutTicks = 60;
    s.players[0]!.reviveProgressTicks = 90;

    hud.update(s, 16, CTX);

    expect(hud.downedBanner.progressVisible).toBe(true);
  });

  it('hides again once revived', () => {
    const hud = newHud();
    const s = pveState();
    s.players[0]!.downed = true;
    hud.update(s, 16, CTX);
    expect(hud.downedBanner.view.visible).toBe(true);

    s.players[0]!.downed = false;
    hud.update(s, 16, CTX);
    expect(hud.downedBanner.view.visible).toBe(false);
  });
});

describe('HudView — pause button (a real touch/WeChat gap this pass closed)', () => {
  // Before this pass, Game.pause() had exactly one entry point — a keyboard Escape/P
  // listener — so a touch/WeChat player (no keyboard at all) could never pause mid-run.
  it('exists, is part of the HUD (toggled by the same view Game shows/hides per phase)', () => {
    const hud = newHud();
    expect(hud.view.children).toContain(hud.pauseBtn.view);
  });

  it('is positioned in the top-right corner, above the minimap', () => {
    const hud = newHud();
    expect(hud.pauseBtn.view.position.x).toBeGreaterThan(1280 - 140 - 20); // right of the minimap's own left edge
    expect(hud.pauseBtn.view.position.y).toBeLessThan(hud.minimap.view.position.y);
  });

  it('renders the universal pause glyph, needing no translation', () => {
    const hud = newHud();
    // Same private-`label`-field cast PauseMenu.test.ts/Forge.test.ts already use.
    expect((hud.pauseBtn as unknown as { label: { text: string } }).label.text).toBe('‖');
  });

  it('re-anchors on reposition (viewport resize), same as the rest of the HUD', () => {
    const hud = newHud();
    hud.reposition({ w: 640, h: 480 });
    expect(hud.pauseBtn.view.position.x).toBeCloseTo(640 - 20 - 36);
  });

  it('tapping it fires onPause — Game wires this to the exact same pause() the keyboard calls', () => {
    const hud = newHud();
    let fired = 0;
    hud.onPause = () => { fired++; };
    hud.pauseBtn.onTap?.();
    expect(fired).toBe(1);
  });

  it('does nothing (no throw) when onPause is never wired', () => {
    const hud = newHud();
    expect(() => hud.pauseBtn.onTap?.()).not.toThrow();
  });
});

describe('HudView — record button (the same touch/WeChat gap, one layer over)', () => {
  // The save-a-replay verb shipped as an F9 hotkey, which is unusable on exactly the
  // platform a bug report is most likely to come FROM. Same shape as the pause button
  // above, and the same reason.
  it('exists and is part of the HUD', () => {
    const hud = newHud();
    expect(hud.view.children).toContain(hud.replayBtn.view);
  });

  it('sits beside the pause button, not under it — the minimap owns that space', () => {
    const hud = newHud();
    expect(hud.replayBtn.view.position.y).toBe(hud.pauseBtn.view.position.y);
    expect(hud.replayBtn.view.position.x).toBeLessThan(hud.pauseBtn.view.position.x);
    // and clear of it: 36 wide, so the gap must exceed the button's own width
    expect(hud.pauseBtn.view.position.x - hud.replayBtn.view.position.x).toBeGreaterThanOrEqual(36);
    // and above the minimap, like its neighbour
    expect(hud.replayBtn.view.position.y).toBeLessThan(hud.minimap.view.position.y);
  });

  it('renders the record glyph, needing no translation', () => {
    const hud = newHud();
    expect((hud.replayBtn as unknown as { label: { text: string } }).label.text).toBe('●');
  });

  it('re-anchors on reposition, same as the rest of the HUD', () => {
    const hud = newHud();
    hud.reposition({ w: 640, h: 480 });
    expect(hud.replayBtn.view.position.x).toBeCloseTo(640 - 20 - 36 - 42);
  });

  it('tapping it fires onSaveReplay — Game wires this to the same saveReplay() F9 calls', () => {
    const hud = newHud();
    let fired = 0;
    hud.onSaveReplay = () => { fired++; };
    hud.replayBtn.onTap?.();
    expect(fired).toBe(1);
  });

  it('does nothing (no throw) when onSaveReplay is never wired', () => {
    const hud = newHud();
    expect(() => hud.replayBtn.onTap?.()).not.toThrow();
  });

  it('hides itself when the run cannot be saved, rather than offering a dead control', () => {
    const hud = newHud();
    const s = pveState();
    hud.update(s, 16, { ...CTX, canSaveReplay: false });
    expect(hud.replayBtn.view.visible).toBe(false);
    hud.update(s, 16, { ...CTX, canSaveReplay: true });
    expect(hud.replayBtn.view.visible).toBe(true);
  });
});

describe('HudView — degenerate states', () => {
  it('does not throw when the local seat index has no player (post-death frame)', () => {
    const hud = newHud();
    const s = pveState();
    expect(() => hud.update(s, 16, { ...CTX, localOwner: 99 })).not.toThrow();
  });

  it('hides the ally row when showAlly is set but there is no second seat', () => {
    const hud = newHud();
    hud.update(pveState(), 16, { ...CTX, showAlly: true, allySkinId: 'juggernaut' });
    expect(hud.allyRow.view.visible).toBe(false);
  });

  it('re-runs cleanly for many frames (the per-frame path is cached, not rebuilt)', () => {
    const hud = newHud();
    const s = pveState();
    for (let i = 0; i < 200; i++) hud.update(s, 16, { ...CTX, score: 0 });
    expect(hud.chips.get('score')!.valueText).toBe('0');
    expect(hud.playerCard.displayName).toBe('Skirmisher');
  });
});

describe('HudView — i18n (design/17-i18n.md)', () => {
  it('translates the chip labels and the weapon subtitle under zh', () => {
    setLocale('zh');
    const hud = newHud();

    hud.update(pveState(), 16, CTX);

    expect(hud.chips.get('floor')!.labelText).toBe('楼层');
    expect(hud.chips.get('enemies')!.labelText).toBe('敌人');
    expect(hud.weaponCard.subText).toContain('普通'); // the starter weapon's rarity
    expect(hud.weaponCard.subText).toContain('远程');
    expect(hud.weaponCard.damageText).toContain('伤害');
  });

  it('translates the no-weapon fallback under zh', () => {
    setLocale('zh');
    const hud = newHud();
    const s = pveState();
    s.players[0]!.weapon = null;

    hud.update(s, 16, CTX);

    expect(hud.weaponCard.nameText).toBe('无武器');
  });

  it('translates the ally row, including the downed branch', () => {
    setLocale('zh');
    const hud = newHud();
    const s = createGameState({ ...PVE_CFG, players: [{}, {}] });
    const ally = s.players[1]!;

    hud.update(s, 16, { ...CTX, showAlly: true, allySkinId: 'juggernaut' });
    // Translated character name (skin.juggernaut.name), not the raw skin id.
    expect(hud.allyRow.nameText).toBe('队友·重装兵');
    expect(hud.allyRow.statusText).toBe('');

    ally.downed = true;
    ally.bleedoutTicks = 60;
    hud.update(s, 16, { ...CTX, showAlly: true, allySkinId: 'juggernaut' });
    expect(hud.allyRow.statusText).toBe('倒地 2秒');
  });

  it('switching back to English on a later update() fully reverts', () => {
    const hud = newHud();
    const s = pveState();
    s.players[0]!.weapon = null;

    setLocale('zh');
    hud.update(s, 16, CTX);
    expect(hud.weaponCard.nameText).toBe('无武器');

    setLocale('en');
    hud.update(s, 16, CTX);
    expect(hud.weaponCard.nameText).toBe('NO WEAPON');
    expect(hud.chips.get('floor')!.labelText).toBe('FLOOR');
  });

  it('sizes a chip wider for a double-width CJK label than for its Latin one', () => {
    const latin = new StatChip('score', 0xffffff);
    latin.set('SCORE', '0');
    const cjk = new StatChip('score', 0xffffff);
    cjk.set('分数分数分数', '0');

    expect(cjk.width).toBeGreaterThan(latin.width);
  });
});

describe('HudView — the seat roster (design/20)', () => {
  it('is not drawn at all with no names, which is every offline run', () => {
    const hud = newHud();
    hud.update(pveState(), 16, CTX);
    expect(hud.seatRoster.view.visible).toBe(false);
    expect(hud.seatRoster.text).toBe('');
  });

  it('draws the named seats and marks the local one', () => {
    const hud = newHud();
    hud.update(pveState(), 16, { ...CTX, seatNames: ['Ada', 'Grace'] });
    expect(hud.seatRoster.view.visible).toBe(true);
    expect(hud.seatRoster.text).toBe('YOU Ada  ·  Grace');
  });

  it('marks the local seat by the localOwner in context, not by position', () => {
    const hud = newHud();
    hud.update(pveState(), 16, { ...CTX, localOwner: 1, seatNames: ['Ada', 'Grace'] });
    expect(hud.seatRoster.text).toBe('Ada  ·  YOU Grace');
  });

  it('reserves a row for it, below everything else in the column', () => {
    // The layout is hand-computed from a cursor, so an added row is exactly the kind of
    // change that silently lands one element on top of another.
    const hud = newHud();
    hud.update(pveState(), 16, { ...CTX, showAlly: true, allySkinId: 'juggernaut', seatNames: ['Ada'] });
    expect(hud.seatRoster.view.position.y).toBeGreaterThan(hud.allyRow.view.position.y);
  });

  it('reserves NO row when there is nothing in it', () => {
    // The property that makes the row free for every existing run: a panel that grew to
    // hold an invisible line would change every single-player HUD.
    const withNames = newHud();
    withNames.update(pveState(), 16, { ...CTX, seatNames: ['Ada'] });
    const without = newHud();
    without.update(pveState(), 16, CTX);
    const height = (h: HudView) => (h as unknown as { panelH: number }).panelH;
    expect(height(withNames)).toBeGreaterThan(height(without));
  });

  it('widens the panel for a long roster', () => {
    const hud = newHud();
    hud.update(pveState(), 16, CTX);
    const narrow = (hud as unknown as { panelW: number }).panelW;
    hud.update(pveState(), 16, { ...CTX, seatNames: ['a-rather-long-portal-username', 'another-long-one'] });
    expect((hud as unknown as { panelW: number }).panelW).toBeGreaterThan(narrow);
  });

  it('works in PvP as well as co-op — the roster is not a co-op row', () => {
    const hud = newHud();
    hud.update(pvpState(), 16, { ...CTX, seatNames: ['Ada', 'Grace'] });
    expect(hud.seatRoster.view.visible).toBe(true);
  });
});
