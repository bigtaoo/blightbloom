/**
 * Four measurements Task 0 (2026-09-23) added ahead of any balance change to the level
 * content itself (difficulty curve retune, new bosses, shop reweight, room randomization,
 * rarity-by-depth): per-floor survivability, weapon rarity distribution, shop purchasing
 * power, and room-skip rate. Split out of `report.ts` from the start (CLAUDE.md form ①,
 * same reason `reportFire.ts` was split off it) rather than grown into it, since these four
 * are one dated pass and the existing tables are not.
 *
 * `report.ts` re-exports everything here, so `from './report'` stays the one import site.
 */
import type { RarityTier, ShopOffer } from '@dd/engine';
import type { RunMetrics } from './levelSim';
import { round1, round2 } from './reportRound';

/**
 * Per-floor survivability at the CHECKPOINT (design/05 "Room encounter budget"), the
 * companion `peakBurstDamage` was missing: that number asks "could one window have
 * killed you", this asks "what did you actually walk out of the floor with". Read
 * together they separate a floor that is scary-but-safe (low vitals, no near-miss burst)
 * from one that is a coin flip (both low).
 *
 * `complete` is the same honest denominator every other per-floor table uses — a run
 * that died mid-floor never reached a checkpoint to report vitals for at all.
 */
export interface FloorVitalsStats {
  floorIndex: number;
  /** Checkpoint visits sampled — always `<= FloorDropStats.complete` for the same floor,
   *  and equal to it unless a profile split changes which runs are being read. */
  complete: number;
  avgHpFrac: number;
  minHpFrac: number;
  avgShieldFrac: number;
}

export function floorVitalsStats(runs: readonly RunMetrics[]): FloorVitalsStats[] {
  const byFloor = new Map<number, { hpFrac: number; shieldFrac: number }[]>();
  for (const r of runs) {
    for (const v of r.vitalsAtCheckpoint) {
      const hpFrac = v.maxHp > 0 ? v.hp / v.maxHp : 0;
      const shieldFrac = v.maxShield > 0 ? v.shield / v.maxShield : 0;
      const list = byFloor.get(v.floorIndex);
      if (list) list.push({ hpFrac, shieldFrac });
      else byFloor.set(v.floorIndex, [{ hpFrac, shieldFrac }]);
    }
  }
  const out: FloorVitalsStats[] = [];
  for (const [floorIndex, rows] of byFloor) {
    out.push({
      floorIndex,
      complete: rows.length,
      avgHpFrac: round2(rows.reduce((a, v) => a + v.hpFrac, 0) / rows.length),
      minHpFrac: round2(Math.min(...rows.map((v) => v.hpFrac))),
      avgShieldFrac: round2(rows.reduce((a, v) => a + v.shieldFrac, 0) / rows.length),
    });
  }
  return out.sort((a, b) => a.floorIndex - b.floorIndex);
}

export function formatVitalsTable(rows: readonly FloorVitalsStats[]): string {
  const head = 'floor  checkpoints  hp%(avg/min)  shield%(avg)';
  const body = rows.map(
    (r) =>
      `${String(r.floorIndex).padEnd(7)}${String(r.complete).padEnd(13)}` +
      `${`${Math.round(r.avgHpFrac * 100)}/${Math.round(r.minHpFrac * 100)}`.padEnd(14)}${Math.round(r.avgShieldFrac * 100)}`,
  );
  return [head, ...body].join('\n');
}

/**
 * Weapon rarity distribution by floor (design/09 "deeper floors roll better materials" —
 * the weapon-find counterpart Task 7 is going to retune). One row per (floor, rarity)
 * pair that was actually seen, so a rarity a floor never handed out is absent rather
 * than a padded zero.
 */
export interface WeaponRarityStats {
  floorIndex: number;
  rarity: RarityTier;
  count: number;
  /** Share of this floor's weapon drops that were this rarity — the number a "shift
   *  toward higher tiers with depth" change is judged against. */
  share: number;
}

export function weaponRarityStats(runs: readonly RunMetrics[]): WeaponRarityStats[] {
  const byFloor = new Map<number, Map<RarityTier, number>>();
  for (const r of runs) {
    for (const d of r.drops) {
      if (d.kind !== 'weapon' || !d.rarity) continue;
      let byRarity = byFloor.get(d.floorIndex);
      if (!byRarity) {
        byRarity = new Map();
        byFloor.set(d.floorIndex, byRarity);
      }
      byRarity.set(d.rarity, (byRarity.get(d.rarity) ?? 0) + 1);
    }
  }
  const out: WeaponRarityStats[] = [];
  for (const [floorIndex, byRarity] of byFloor) {
    const total = [...byRarity.values()].reduce((a, n) => a + n, 0);
    for (const [rarity, count] of byRarity) {
      out.push({ floorIndex, rarity, count, share: round2(count / total) });
    }
  }
  return out.sort((a, b) => a.floorIndex - b.floorIndex || b.count - a.count);
}

export function formatRarityTable(rows: readonly WeaponRarityStats[]): string {
  const head = 'floor  rarity      count  share';
  const body = rows.map(
    (r) => `${String(r.floorIndex).padEnd(7)}${r.rarity.padEnd(12)}${String(r.count).padEnd(7)}${Math.round(r.share * 100)}%`,
  );
  return [head, ...body].join('\n');
}

/**
 * Shop purchasing power (design/05 "Shops" — "at the first-pass prices a measured
 * floor's income buys roughly one line and a bit", stated in prose with no measurement
 * behind it until now). Read off `ShopSnapshot`s taken the tick a shop's room first
 * activates, independent of whether the bot buys anything — the bot never shops, so
 * this is a coins-vs-price measurement, not a conversion-rate one.
 */
export interface ShopPowerStats {
  floorIndex: number;
  samples: number;
  avgCoins: number;
  /** Average total price of the shop's own stock (all offers, not just afforded ones). */
  avgStockPrice: number;
  /** Average count of the shop's offers the sampled coin balance could afford
   *  individually — NOT whether all three together fit the budget. */
  avgLinesAffordable: number;
  /** `avgCoins / avgStockPrice` — the single number "does a floor's income cover the
   *  counter" reads off. 1.0 means the average visit could clear the whole shop. */
  purchasingPowerRatio: number;
}

export function shopPowerStats(runs: readonly RunMetrics[]): ShopPowerStats[] {
  const byFloor = new Map<number, { coins: number; offers: { kind: ShopOffer['kind']; price: number }[] }[]>();
  for (const r of runs) {
    for (const snap of r.shopSnapshots) {
      const list = byFloor.get(snap.floorIndex);
      if (list) list.push(snap);
      else byFloor.set(snap.floorIndex, [snap]);
    }
  }
  const out: ShopPowerStats[] = [];
  for (const [floorIndex, snaps] of byFloor) {
    const n = snaps.length;
    const avgCoins = snaps.reduce((a, s) => a + s.coins, 0) / n;
    const avgStockPrice = snaps.reduce((a, s) => a + s.offers.reduce((b, o) => b + o.price, 0), 0) / n;
    const avgLinesAffordable = snaps.reduce((a, s) => a + s.offers.filter((o) => o.price <= s.coins).length, 0) / n;
    out.push({
      floorIndex,
      samples: n,
      avgCoins: round1(avgCoins),
      avgStockPrice: round1(avgStockPrice),
      avgLinesAffordable: round1(avgLinesAffordable),
      purchasingPowerRatio: avgStockPrice === 0 ? 0 : round2(avgCoins / avgStockPrice),
    });
  }
  return out.sort((a, b) => a.floorIndex - b.floorIndex);
}

export function formatShopPowerTable(rows: readonly ShopPowerStats[]): string {
  const head = 'floor  shops  avgCoins  stockPrice  linesAffordable  ratio';
  const body = rows.map(
    (r) =>
      `${String(r.floorIndex).padEnd(7)}${String(r.samples).padEnd(7)}${String(r.avgCoins).padEnd(10)}` +
      `${String(r.avgStockPrice).padEnd(12)}${String(r.avgLinesAffordable).padEnd(17)}${r.purchasingPowerRatio}`,
  );
  return [head, ...body].join('\n');
}

/**
 * Room-skip rate — "rooms actually activated / rooms the floor placed", read per floor
 * over COMPLETE visits only (an incomplete one under-activates because the run died,
 * not because anything was skippable). A procedurally-generated floor
 * (`world/dungeon/generateFloor.ts`) is a strict linear chain (one STAGE per room, a
 * single capstone, nothing forks) and reads 0% by construction; a hand-authored floor
 * (`placeAuthoredFloor.ts`) already CAN branch — floor 0's `b1_cache` chest room is a
 * real side branch off the critical path today, which is why this reads nonzero before
 * Task 6 ships anything. It is wired up ahead of the room-randomization pass rather than
 * after it, so that change has a baseline to move the number away from, instead of a
 * first reading taken on the same run that introduced what it measures.
 */
export interface RoomSkipStats {
  floorIndex: number;
  /** Complete visits (reached this floor's checkpoint) sampled. */
  complete: number;
  avgRoomsTotal: number;
  avgRoomsActivated: number;
  /** `1 - avgRoomsActivated / avgRoomsTotal`, over complete visits only. */
  skipRate: number;
}

export function roomSkipStats(runs: readonly RunMetrics[]): RoomSkipStats[] {
  const byFloor = new Map<number, { total: number; activated: number }[]>();
  for (const r of runs) {
    const activatedByFloor = new Map<number, Set<string>>();
    for (const e of r.encounters) {
      let set = activatedByFloor.get(e.floorIndex);
      if (!set) {
        set = new Set();
        activatedByFloor.set(e.floorIndex, set);
      }
      set.add(e.roomId);
    }
    for (const floorIndex of r.checkpointFloors) {
      const total = r.roomsTotalByFloor[floorIndex];
      if (total === undefined) continue;
      const activated = activatedByFloor.get(floorIndex)?.size ?? 0;
      const list = byFloor.get(floorIndex);
      const row = { total, activated };
      if (list) list.push(row);
      else byFloor.set(floorIndex, [row]);
    }
  }
  const out: RoomSkipStats[] = [];
  for (const [floorIndex, rows] of byFloor) {
    const avgRoomsTotal = rows.reduce((a, r) => a + r.total, 0) / rows.length;
    const avgRoomsActivated = rows.reduce((a, r) => a + r.activated, 0) / rows.length;
    out.push({
      floorIndex,
      complete: rows.length,
      avgRoomsTotal: round1(avgRoomsTotal),
      avgRoomsActivated: round1(avgRoomsActivated),
      skipRate: avgRoomsTotal === 0 ? 0 : round2(1 - avgRoomsActivated / avgRoomsTotal),
    });
  }
  return out.sort((a, b) => a.floorIndex - b.floorIndex);
}

export function formatSkipTable(rows: readonly RoomSkipStats[]): string {
  const head = 'floor  checkpoints  roomsTotal  roomsActivated  skipRate';
  const body = rows.map(
    (r) =>
      `${String(r.floorIndex).padEnd(7)}${String(r.complete).padEnd(13)}${String(r.avgRoomsTotal).padEnd(12)}` +
      `${String(r.avgRoomsActivated).padEnd(16)}${Math.round(r.skipRate * 100)}%`,
  );
  return [head, ...body].join('\n');
}
