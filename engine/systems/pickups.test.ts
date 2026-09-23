import { describe, it, expect } from 'vitest';
import { createGameState } from '@dd/engine/state/GameState';
import type { GameState } from '@dd/engine/state/GameState';
import type { PickupItem, RangedSimSpec } from '@dd/engine/state/entities';
import type { Fp } from '@dd/engine/math/fixed';
import { PickupSystem } from '@dd/engine/systems';
import { toFpGrid } from '@dd/engine/content/convert';
import { createGameEngine } from '@dd/engine/GameEngine';
import { makeCommand } from '@dd/engine/state/input';
import { RUN_BUFFS, BUFF_CAPS } from '@dd/engine/balance/runbuffs';
import type { Brad } from '@dd/engine/math/trig';

const CFG = { seed: 7, worldW: 1600, worldH: 1200, waves: [] as const };

/** A pickup sitting on top of the player, collectable this tick (spawnTick in the past). */
function dropOnPlayer(s: GameState, item: Omit<PickupItem, 'id' | 'gx' | 'gy' | 'spawnTick' | 'alive'>): void {
  const p = s.players[0]!;
  s.pickups.push({ id: s.nextId(), gx: p.gx, gy: p.gy, spawnTick: -1, alive: true, ...item });
}

describe('PickupSystem — the in-run power ramp (design/05)', () => {
  const sys = new PickupSystem();

  it('heal restores up to maxHp, never over', () => {
    const s = createGameState(CFG);
    const p = s.players[0]!;
    p.hp = 2;
    dropOnPlayer(s, { kind: 'heal' });
    sys.tick(s);
    expect(p.hp).toBe(3);
    expect(s.pickups).toHaveLength(0); // consumed

    // One point short of full still collects — the boundary on the useful side.
    p.hp = p.maxHp - 1;
    dropOnPlayer(s, { kind: 'heal' });
    sys.tick(s);
    expect(p.hp).toBe(p.maxHp);
    expect(s.pickups).toHaveLength(0);
  });

  // design/05's locked "consumables auto-apply, but only when useful" rule. There is no
  // item bag, so a heal collected at full HP is destroyed for nothing — and HP is the one
  // pool nothing else in the game restores. Shipped ENGINE_VERSION 54; before it,
  // `apply` clamped with Math.min and the item was consumed regardless, which LOOKED
  // correct from the hp assertion alone (that is why the test above grew a pickups-length
  // assertion too: "hp unchanged" was already true of the bug).
  it('a full-HP player leaves a heal on the floor instead of binning it', () => {
    const s = createGameState(CFG);
    const p = s.players[0]!;
    p.hp = p.maxHp;
    dropOnPlayer(s, { kind: 'heal' });

    sys.tick(s);

    expect(p.hp).toBe(p.maxHp);
    expect(s.pickups).toHaveLength(1);
    expect(s.pickups[0]!.alive).toBe(true);
    expect(s.events.filter((e) => e.type === 'pickup')).toHaveLength(0); // no toast either
  });

  it('the same heal is collected on a later tick, once the player has taken damage', () => {
    const s = createGameState(CFG);
    const p = s.players[0]!;
    p.hp = p.maxHp;
    dropOnPlayer(s, { kind: 'heal' });
    const id = s.pickups[0]!.id;

    sys.tick(s);
    expect(s.pickups[0]!.id).toBe(id); // same item, still there

    p.hp -= 1;
    sys.tick(s);

    expect(p.hp).toBe(p.maxHp);
    expect(s.pickups).toHaveLength(0);
  });

  // The gate is per-PLAYER, inside the player loop — a `continue`, not a `break`. Were it
  // per-item, the full teammate standing on it would deny it to the hurt one.
  it('a full-HP player standing on a heal does not block a hurt co-op teammate from taking it', () => {
    const s = createGameState({ ...CFG, players: [{ teamId: 0 }, { teamId: 0 }] });
    const full = s.players[0]!;
    const hurt = s.players[1]!;
    full.hp = full.maxHp;
    hurt.hp = 1;
    hurt.gx = full.gx;
    hurt.gy = full.gy; // both overlapping the same drop
    dropOnPlayer(s, { kind: 'heal' });

    sys.tick(s);

    expect(full.hp).toBe(full.maxHp);
    expect(hurt.hp).toBe(2);
    expect(s.pickups).toHaveLength(0);
  });

  // Only `heal` is gated (see `wouldApply`'s own doc): the other auto kinds accumulate
  // with no local cap, so "would it do something" is always yes for them.
  it('a material is still collected at any state — the rule is heal-specific', () => {
    const s = createGameState(CFG);
    const p = s.players[0]!;
    p.hp = p.maxHp;
    dropOnPlayer(s, { kind: 'material', materialId: 'mat_fire', qty: 1, tier: 0 });

    sys.tick(s);

    expect(s.pickups).toHaveLength(0);
    expect(p.floorMaterials.mat_fire).toBe(1);
  });

  it('a material goes into the COLLECTOR\u2019s own floor buffer, not a shared one (ENGINE_VERSION 68)', () => {
    // Per-seat since ENGINE_VERSION 68, exactly like `coin` already was \u2014 asserted against
    // a teammate standing on the same tile, because "went to the right bag" and "went to A
    // bag" are different claims.
    const s = createGameState({ ...CFG, players: [{}, {}] });
    const [a, b] = [s.players[0]!, s.players[1]!];
    b.gx = a.gx;
    b.gy = a.gy;
    dropOnPlayer(s, { kind: 'material', materialId: 'mat_fire', qty: 5, tier: 0 });

    sys.tick(s);

    expect(s.pickups).toHaveLength(0);
    expect(a.floorMaterials.mat_fire).toBe(5);
    expect(b.floorMaterials.mat_fire).toBeUndefined();
  });

  it('a coin goes into the COLLECTOR\u2019s wallet, not a shared floor buffer', () => {
    // The whole per-seat-purse decision, now shared by `material` too (the test above) \u2014 a
    // coin is never banked/carried out at all, unlike material, which is the rest of the
    // difference between the two. Asserted against a teammate standing on the same tile,
    // because "went to the right wallet" and "went to A wallet" are different claims.
    const s = createGameState({ ...CFG, players: [{}, {}] });
    const [a, b] = [s.players[0]!, s.players[1]!];
    b.gx = a.gx;
    b.gy = a.gy;
    dropOnPlayer(s, { kind: 'coin', qty: 5 });

    sys.tick(s);

    expect(s.pickups).toHaveLength(0);
    expect(a.coins).toBe(5);
    expect(b.coins).toBe(0);
    expect(a.floorMaterials).toEqual({});
    expect(a.bankedMaterials).toEqual({});
  });

  it('a schematic goes to the COLLECTOR’s own blueprintPickup, not every seat (ENGINE_VERSION 68)', () => {
    // Replaces the old squad-wide `state.runBlueprint` flag — whichever seat's actor is
    // standing on it is the one who carries it out, exactly like `material` above.
    const s = createGameState({ ...CFG, players: [{}, {}] });
    const [a, b] = [s.players[0]!, s.players[1]!];
    b.gx = a.gx;
    b.gy = a.gy;
    dropOnPlayer(s, { kind: 'schematic', weaponId: 'flamer' });

    sys.tick(s);

    expect(s.pickups).toHaveLength(0);
    expect(a.blueprintPickup).toBe('flamer');
    expect(b.blueprintPickup).toBeNull();
  });

  it('a second schematic pickup this tick does not overwrite an already-carried one', () => {
    // Defensive: only one schematic ever exists in a run today (one boss, one roll), so
    // this guards a future where that stops being true rather than a reachable case now.
    const s = createGameState(CFG);
    const p = s.players[0]!;
    p.blueprintPickup = 'spear';
    dropOnPlayer(s, { kind: 'schematic', weaponId: 'flamer' });

    sys.tick(s);

    expect(p.blueprintPickup).toBe('spear');
  });

  it('the event names the COLLECTOR, not the item and not the first seat (render reads `by`)', () => {
    // `by` exists so the render layer can fly the drop to the body that took it
    // (`client/src/game/scene/pickupFlight.ts`). Two failures it has to tell apart, and neither
    // is visible from a one-player state: handing back the ITEM's id (ids come from one
    // `nextId()` space, so both are small integers and both "work"), and handing back
    // `players[0]` (right in single-player, wrong for every teammate in co-op/PvP). The SECOND
    // seat collects here, and the item id is asserted against as well, so both failures survive
    // only by being right.
    const s = createGameState({ ...CFG, players: [{}, {}] });
    const [a, b] = [s.players[0]!, s.players[1]!];
    // Well out of a's reach, so the player loop cannot pick a by standing in the same place.
    b.gx = (a.gx + toFpGrid(12)) as Fp;
    b.gy = a.gy;
    const item: PickupItem = {
      id: s.nextId(), kind: 'material', materialId: 'mat_fire', qty: 1,
      gx: b.gx, gy: b.gy, spawnTick: -1, alive: true,
    };
    s.pickups.push(item);

    sys.tick(s);

    const ev = s.events.find((e) => e.type === 'pickup');
    expect(ev).toBeDefined();
    expect(ev && 'by' in ev && ev.by).toBe(b.id);
    expect(ev && 'by' in ev && ev.by).not.toBe(a.id);
    expect(ev && 'by' in ev && ev.by).not.toBe(item.id);
    // The premise the three assertions above rest on: these really are three different numbers,
    // so none of them can pass by collision.
    expect(new Set([a.id, b.id, item.id]).size).toBe(3);
  });

  it('a coin is collected at full HP and full energy \u2014 it is not an instant item', () => {
    // The `pickupWouldApply` gate is for things with a ceiling. A wallet has none, so a coin
    // must never be left on the floor; a stray clause adding it to that gate would strand
    // currency next to a healthy player.
    const s = createGameState(CFG);
    const p = s.players[0]!;
    p.hp = p.maxHp;
    p.energy = p.maxEnergy;
    dropOnPlayer(s, { kind: 'coin', qty: 5 });

    sys.tick(s);

    expect(s.pickups).toHaveLength(0);
    expect(p.coins).toBe(5);
  });

  it('a weapon drop is NOT collected on overlap alone (design/03: click-driven, not auto)', () => {
    const s = createGameState(CFG);
    const p = s.players[0]!;
    const before = p.weapon!.spec.name;
    dropOnPlayer(s, { kind: 'weapon', weaponId: 'cannon' });
    sys.tick(s); // no pickupTargetId set
    expect(p.weapon!.spec.name).toBe(before); // untouched
    expect(s.pickups).toHaveLength(1); // still sitting on the floor
    expect(s.pickups[0]!.alive).toBe(true);
  });

  it('clicking the wrong/stale item id does nothing, even while overlapping a real one', () => {
    const s = createGameState(CFG);
    const p = s.players[0]!;
    const before = p.weapon!.spec.name;
    dropOnPlayer(s, { kind: 'weapon', weaponId: 'cannon' });
    p.pickupTargetId = s.pickups[0]!.id + 999; // some other/stale id
    sys.tick(s);
    expect(p.weapon!.spec.name).toBe(before);
    expect(s.pickups[0]!.alive).toBe(true);
  });

  it('clicking (pickupTargetId matching the item) swaps the active slot and drops the outgoing weapon', () => {
    const s = createGameState(CFG);
    const p = s.players[0]!;
    const outgoingId = p.weapon!.spec.name;
    dropOnPlayer(s, { kind: 'weapon', weaponId: 'cannon' });
    p.pickupTargetId = s.pickups[0]!.id;
    sys.tick(s);

    const active = p.weapon!;
    expect(active.spec.name).toBe('cannon');
    expect(p.weapons[p.activeSlot]).toBe(active); // slot pointer updated
    expect((active.spec as RangedSimSpec).damage).toBe(3); // cannon's authored damage

    // The outgoing weapon lands back on the floor as a fresh pickup at the player.
    const dropped = s.pickups.find((x) => x.weaponId === outgoingId);
    expect(dropped).toBeDefined();
    expect(dropped!.alive).toBe(true);
    expect(dropped!.spawnTick).toBe(s.tick);
  });

  it('a click is a one-tick pulse — not re-applied on a later tick without a fresh click', () => {
    const s = createGameState(CFG);
    const p = s.players[0]!;
    dropOnPlayer(s, { kind: 'weapon', weaponId: 'cannon' });
    p.pickupTargetId = s.pickups[0]!.id;
    sys.tick(s); // swaps in cannon, drops the starter weapon at the same spot
    expect(p.weapon!.spec.name).toBe('cannon');
    p.pickupTargetId = 0; // ApplyInputSystem would reset this every tick without a fresh click

    // Advance past the dropped item's spawnTick guard so this actually exercises
    // whether the stale click re-fires, not just the "same-tick drop" guard.
    s.tick += 1;
    sys.tick(s);
    expect(p.weapon!.spec.name).toBe('cannon'); // unchanged, did not swap back
  });

  // ── ENGINE_VERSION 46: a pickup replaces the slot holding the SAME KIND ─────────
  //
  // Live report: *"拾起武器时，只替换角色身上对应的武器。不能拾取一把刀，却把枪换掉了，导致
  // 玩家拿着两把刀"*. Until v46 `applyWeapon` overwrote `p.activeSlot` unconditionally, which
  // is not a preference but a broken invariant: `resolveLoadout` (content/players.ts) and
  // `buildArenaSpecs` (balance/build.ts) both guarantee one gun and one melee weapon at
  // spawn — design/03's ranged-vs-melee trade-off is built on it — and the first floor
  // pickup of the non-active kind destroyed it permanently. The starter pair is
  // [BLASTER_SIM (ranged), SABER_SIM (melee)] with slot 0 active, so "pick up a melee
  // weapon" was exactly the reported case.

  it('puts a MELEE pickup in the melee slot, leaving the gun alone', () => {
    const s = createGameState(CFG);
    const p = s.players[0]!;
    expect(p.activeSlot).toBe(0);
    expect(p.weapons[0]!.spec.kind).toBe('ranged'); // premise: the reported starting state
    expect(p.weapons[1]!.spec.kind).toBe('melee');
    const gun = p.weapons[0]!.spec.name;

    dropOnPlayer(s, { kind: 'weapon', weaponId: 'hammer' }); // melee
    p.pickupTargetId = s.pickups[0]!.id;
    sys.tick(s);

    expect(p.weapons[1]!.spec.name).toBe('hammer'); // the MELEE slot took it...
    expect(p.weapons[0]!.spec.name).toBe(gun); // ...and the gun is untouched
    expect(p.weapon!.spec.name).toBe('hammer'); // the clicked weapon is in hand
    expect(p.activeSlot).toBe(1);
    // The displaced weapon is the outgoing MELEE one, not the active gun.
    expect(s.pickups.map((x) => x.weaponId)).toEqual(['saber']);
  });

  it('puts a RANGED pickup in the gun slot even while the melee slot is active', () => {
    const s = createGameState(CFG);
    const p = s.players[0]!;
    p.activeSlot = 1; // holding the saber
    p.weapon = p.weapons[1]!;
    const melee = p.weapons[1]!.spec.name;

    dropOnPlayer(s, { kind: 'weapon', weaponId: 'cannon' }); // ranged
    p.pickupTargetId = s.pickups[0]!.id;
    sys.tick(s);

    expect(p.weapons[0]!.spec.name).toBe('cannon');
    expect(p.weapons[1]!.spec.name).toBe(melee);
    expect(p.activeSlot).toBe(0);
    expect(s.pickups.map((x) => x.weaponId)).toEqual(['blaster']);
  });

  it('keeps one of EACH kind however many weapons pass through the loadout', () => {
    // The invariant itself, not one instance of it: the property design/03 rests on and the
    // one the v45 loadout builder goes out of its way to establish at spawn. A run that
    // loots a mixed pile must still own both halves at the end of it.
    const s = createGameState(CFG);
    const p = s.players[0]!;
    for (const id of ['hammer', 'spear', 'cannon', 'saber', 'hammer', 'repeater']) {
      const item: PickupItem = {
        id: s.nextId(), kind: 'weapon', weaponId: id,
        gx: p.gx, gy: p.gy, spawnTick: -1, alive: true,
      };
      s.pickups.push(item);
      p.pickupTargetId = item.id;
      sys.tick(s);
      const kinds = p.weapons.map((w) => w.spec.kind).sort();
      expect(kinds).toEqual(['melee', 'ranged']);
      expect(p.weapon!.spec.name).toBe(id); // and the clicked weapon is always in hand
      s.pickups.length = 0; // clear the outgoing drops so the next click is unambiguous
    }
  });

  it('fills a FREE slot rather than overwriting the only weapon a seat carries', () => {
    // Not reachable through `resolveLoadout`, which always fills both slots — but a seat
    // built from a config that skipped it holds one weapon, and overwriting that weapon
    // with the other kind would leave the player with one again, just a different one.
    const s = createGameState(CFG);
    const p = s.players[0]!;
    p.weapons.length = 1; // gun only
    p.activeSlot = 0;
    p.weapon = p.weapons[0]!;

    dropOnPlayer(s, { kind: 'weapon', weaponId: 'hammer' });
    p.pickupTargetId = s.pickups[0]!.id;
    sys.tick(s);

    expect(p.weapons.map((w) => w.spec.kind)).toEqual(['ranged', 'melee']);
    expect(p.activeSlot).toBe(1);
    expect(s.pickups).toHaveLength(0); // nothing displaced, so nothing dropped
  });

  it('collects a weapon click from beyond pickupRadius but within the wider lootRevealRadius', () => {
    const s = createGameState(CFG);
    const p = s.players[0]!;
    // pickupRadius is ~0.47 grid; lootRevealRadius is 2.5 grid — 1 grid away is out of
    // the tight ring every other kind uses but well inside the panel's own ring.
    const id = s.nextId();
    s.pickups.push({ id, kind: 'weapon', weaponId: 'cannon', gx: (p.gx + toFpGrid(1)) as Fp, gy: p.gy, spawnTick: -1, alive: true });
    p.pickupTargetId = id;
    sys.tick(s);
    expect(p.weapon!.spec.name).toBe('cannon');
  });

  it('materials have no in-sim effect yet (a distinct, not-yet-banked currency)', () => {
    const s = createGameState(CFG);
    const p = s.players[0]!;
    const snapshot = JSON.stringify([p.hp, p.maxHp, p.weapons.map((w) => w.spec.damage)]);
    dropOnPlayer(s, { kind: 'material', materialId: 'mat_fire', qty: 1 });
    sys.tick(s);
    expect(JSON.stringify([p.hp, p.maxHp, p.weapons.map((w) => w.spec.damage)])).toBe(snapshot);
  });

  it('a buff pickup is added to the player stack; unknown ids are ignored', () => {
    const s = createGameState(CFG);
    const p = s.players[0]!;
    dropOnPlayer(s, { kind: 'buff', buffId: 'dmg_up' });
    sys.tick(s);
    expect(p.buffs).toEqual(['dmg_up']);

    dropOnPlayer(s, { kind: 'buff', buffId: 'not_a_real_buff' });
    sys.tick(s);
    expect(p.buffs).toEqual(['dmg_up']); // forward-compat: unknown id → no-op
  });

  it('a flat_hp buff raises maxHp and heals by the same amount, clamped by the cap', () => {
    const s = createGameState(CFG);
    const p = s.players[0]!;
    const baseMax = p.maxHp;
    p.hp = 1;
    dropOnPlayer(s, { kind: 'buff', buffId: 'vit_up' }); // +2 maxHp
    sys.tick(s);
    expect(p.maxHp).toBe(baseMax + 2);
    expect(p.hp).toBe(3); // gaining max HP also healed +2

    // Past the +10 cap, extra vit_up buffs add nothing (Σ-then-clamp delta = 0).
    for (let i = 0; i < 10; i++) {
      dropOnPlayer(s, { kind: 'buff', buffId: 'vit_up' });
      sys.tick(s);
    }
    expect(p.maxHp).toBe(baseMax + 10);
  });

  it('a flat_energy buff raises maxEnergy AND refills by the same amount, clamped by the cap', () => {
    // The `flat_hp` case above, for the second absolute family (ENGINE_VERSION 60). The
    // refill half is the load-bearing one: a card that raised the ceiling and left the bar
    // where it was would hand a player who took it while empty nothing at all until regen
    // caught up — which is the exact moment they would have picked it.
    const s = createGameState(CFG);
    const p = s.players[0]!;
    const baseMax = p.maxEnergy;
    const step = RUN_BUFFS.cell_up!.value;
    p.energy = 5;
    dropOnPlayer(s, { kind: 'buff', buffId: 'cell_up' });
    sys.tick(s);
    expect(p.maxEnergy).toBe(baseMax + step);
    expect(p.energy).toBe(5 + step); // the ceiling moved and so did the bar

    // Past the cap, extra picks add nothing (Σ-then-clamp delta = 0) — and crucially do
    // not keep refilling either, which a "always +step to current" shortcut would.
    for (let i = 0; i < 20; i++) {
      dropOnPlayer(s, { kind: 'buff', buffId: 'cell_up' });
      sys.tick(s);
    }
    expect(p.maxEnergy).toBe(baseMax + BUFF_CAPS.flat_energy);
    expect(p.energy).toBe(5 + BUFF_CAPS.flat_energy);
  });

  it('an HP buff moves only the HP pair, and an energy buff only the energy pair', () => {
    // The two `flat_*` families now run through one `applyBuff` reading one `sumBuffs`
    // pair. A crossed delta there — energy's growth applied to maxHp, say — would still
    // pass every single-family test above, because each one only looks at its own stat.
    const s = createGameState(CFG);
    const p = s.players[0]!;
    const before = { maxHp: p.maxHp, hp: p.hp, maxEnergy: p.maxEnergy, energy: p.energy };
    dropOnPlayer(s, { kind: 'buff', buffId: 'cell_up' });
    sys.tick(s);
    expect(p.maxHp).toBe(before.maxHp);
    expect(p.hp).toBe(before.hp);
    expect(p.maxEnergy).toBeGreaterThan(before.maxEnergy);

    const mid = { maxEnergy: p.maxEnergy, energy: p.energy };
    dropOnPlayer(s, { kind: 'buff', buffId: 'vit_up' });
    sys.tick(s);
    expect(p.maxEnergy).toBe(mid.maxEnergy);
    expect(p.energy).toBe(mid.energy);
    expect(p.maxHp).toBeGreaterThan(before.maxHp);
  });

  it('a bandage pickup adds to the squad-revive currency, uncapped (design/05/15)', () => {
    const s = createGameState(CFG);
    const p = s.players[0]!;
    expect(p.bandages).toBe(0);
    dropOnPlayer(s, { kind: 'bandage' });
    sys.tick(s);
    expect(p.bandages).toBe(1);
    dropOnPlayer(s, { kind: 'bandage' });
    sys.tick(s);
    expect(p.bandages).toBe(2); // no cap
  });

  it('a real PlayerCommand.pickupTargetId (via ApplyInputSystem, engine.step) actually collects — not just a directly-set actor field', () => {
    // Regression coverage for the real wiring, not PickupSystem in isolation: every
    // other case above sets PlayerActor.pickupTargetId directly, which would keep
    // passing unchanged even if the command→actor wiring were completely absent (as
    // it briefly was) — this is the ONLY place in the suite that drives a click
    // through the full path (CommandBuilder's would-be output → ApplyInputSystem →
    // PickupSystem).
    const e = createGameEngine(CFG);
    const p = e.state.players[0]!;
    const before = p.weapon!.spec.name;
    const id = e.state.nextId();
    e.state.pickups.push({ id, kind: 'weapon', weaponId: 'cannon', gx: p.gx, gy: p.gy, spawnTick: -1, alive: true });

    e.step([makeCommand({
      owner: 0, tick: e.state.tick + 1, moveBrad: 0 as Brad, moveMag: 0, buttons: 0,
      pickupTargetId: id,
    })]);

    expect(p.weapon!.spec.name).toBe('cannon');
    expect(p.weapon!.spec.name).not.toBe(before);
  });

  it('does not vacuum a pickup dropped this very tick (spawnTick guard)', () => {
    const s = createGameState(CFG);
    const p = s.players[0]!;
    s.tick = 5;
    s.pickups.push({ id: s.nextId(), kind: 'material', gx: p.gx, gy: p.gy, spawnTick: 5, alive: true });
    sys.tick(s);
    expect(s.pickups).toHaveLength(1); // still there next tick
    expect(s.pickups[0]!.alive).toBe(true);
  });
});
