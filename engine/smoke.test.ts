/**
 * Whole-engine smoke: real runs, invariants checked EVERY tick
 * (design/18-test-strategy.md, Layer 3).
 *
 * ## Why this exists alongside 900-odd unit tests
 *
 * A unit test can encode the same wrong assumption as the code it tests and pass anyway. This
 * repo has that written down twice over — `shield.test.ts` read its expectation from the very
 * constant it was guarding, and the 16 px wall runs shipped past a level-1 content suite where
 * every INPUT gate was green, because the defect was born in the transform between them.
 *
 * The defence is to assert on properties of a real run instead of on scenarios. An invariant
 * like "no actor is ever inside a wall" cannot be satisfied by a mistaken assumption; it is
 * either true of every tick of every scenario or it is not. That is a different kind of claim
 * from anything in `systems/*.test.ts`, and it is the kind that catches the bug nobody
 * predicted — which is the whole reason the two reports behind design/18 (a character buried in
 * a wall, a drop that could not be picked up) reached a human before they reached a test.
 *
 * ## Relationship to the golden gate
 *
 * `goldenHash.test.ts` asks "did behaviour CHANGE". This asks "is behaviour CORRECT". They fail
 * for opposite reasons and neither substitutes for the other: a wrong-but-stable engine passes
 * the golden gate forever, and a deliberate retune fails it while every invariant here holds.
 * The scenarios are shared (`fixtures/goldenScenarios.ts`) so the two always describe the same
 * runs.
 *
 * ## Cost
 *
 * The full set is ~4,700 ticks across five scenarios with a per-tick check over every actor,
 * bullet and pickup. It runs in well under a second, so it stays in the default `npm test`
 * rather than joining the opt-in `.sim.ts` tier.
 */
import { describe, expect, it } from 'vitest';
import { createGameEngine } from './GameEngine';
import { GOLDEN_SCENARIOS, type GoldenScenario } from './fixtures/goldenScenarios';
import { serializeState } from './replay';
import { blockingRadius, dropClearance } from './state/actorRadius';
import { PLAYER_BASE } from './content/players';
import { blockingRect } from './systems/solidBounds';
import { circleOverlapsAabb, circlesOverlap } from './systems/geom';
import { makeCommand } from './state/input';
import { Button, type PlayerCommand } from './state/commands';
import { BRAD_FULL, type Brad } from './math/trig';
import type { Fp } from './math/fixed';
import type { GameState } from './state/GameState';
import type { Actor } from './state/entities';

/**
 * How far an actor may be inside a wall before it counts as a breach.
 *
 * One fp unit — a tolerance for the push's own `Math.trunc` residue and nothing more. It was
 * 200 until ENGINE_VERSION 49, as a MEASURED allowance for a real shipping behaviour this file
 * found: `MovementSystem` resolved walls before `resolveActorPairs`, so a pair shove was the
 * last thing in a tick and could push an actor back into stone. The tradition around that
 * ordering said it was "corrected on the following tick", and for a glancing shove it was — but
 * two bodies pinned together against a wall re-applied the shove every tick, so the wall pass
 * never got the last word and the pair reached a stable standoff INSIDE the wall. Measured on
 * `launch-arena-pvp`: one episode of 103 consecutive ticks (~3.4 s at 30 Hz) at up to 189 fp,
 * a full 6 px of body buried in stone — the same order as the v47/v48 reports that produced
 * design/18.
 *
 * `MovementSystem.reseparateFromSolids` (v49) re-runs the solid passes after the pair push, so
 * the allowance is back to being about rounding. The trade is explicit and is the right way
 * round per design/07: two actors may now overlap each other slightly more than the pair push
 * intended, because a solid gets the final say over a body.
 */
const WALL_PENETRATION_ALLOWANCE = 1;

/** One violation, with enough context to act on without re-running anything. */
interface Breach {
  scenario: string;
  tick: number;
  what: string;
}

/**
 * The invariants. Each returns a description when broken and null when fine.
 *
 * Written as "how far past the line did it go", not "is it past the line", wherever a number is
 * available — a failure that says *how badly* is a failure you can triage from the log.
 */
const INVARIANTS: readonly { name: string; check(s: GameState): string | null }[] = [
  {
    name: 'no actor is inside a solid',
    check: (s) => {
      for (const a of [...s.players, ...s.enemies] as Actor[]) {
        if (!a.alive) continue;
        const r = blockingRadius(a);
        for (const w of s.walls) {
          const b = blockingRect(w);
          const rect = { x: b.left, y: b.top, w: (b.right - b.left) as Fp, h: (b.bottom - b.top) as Fp };
          if (!circleOverlapsAabb(a.gx, a.gy, r, rect)) continue;
          // Tangency is legal and common (see boundaryParity.test.ts) — `circleOverlapsAabb` is
          // closed while the push is open, so only a REAL penetration counts here. One fp unit
          // of slack absorbs the push's own `Math.trunc` residue.
          const cx = Math.max(b.left, Math.min(a.gx, b.right));
          const cy = Math.max(b.top, Math.min(a.gy, b.bottom));
          const dx = (a.gx as number) - cx;
          const dy = (a.gy as number) - cy;
          const depth = (r as number) - Math.sqrt(dx * dx + dy * dy);
          if (depth > WALL_PENETRATION_ALLOWANCE) {
            return `actor ${a.id} is ${Math.round(depth)} fp inside a wall at (${a.gx}, ${a.gy})`;
          }
        }
        for (const o of s.obstacles) {
          if (!circlesOverlap(a.gx, a.gy, r, o.gx, o.gy, o.radius)) continue;
          const dx = (a.gx as number) - (o.gx as number);
          const dy = (a.gy as number) - (o.gy as number);
          const depth = (r as number) + (o.radius as number) - Math.sqrt(dx * dx + dy * dy);
          if (depth > 1) return `actor ${a.id} is ${Math.round(depth)} fp inside a pillar`;
        }
      }
      return null;
    },
  },
  {
    name: 'no enemy stands where a player could not follow',
    check: (s) => {
      // The user's own words, third round of the unpickable-loot report (2026-08-31):
      // *"怪物不能跑进阻挡区域"*. The rule above ("no actor is inside a solid") judges each
      // actor by ITS OWN clearance, so it stays green for a 13 px critter tucked into a band
      // the 16 px player can never enter — which is how a mob comes to die, and drop, somewhere
      // the player cannot walk. This one judges every enemy by the PLAYER'S circle instead.
      //
      // v50 makes it true by construction (`buildEnemyActor` floors `solidRadius` at
      // `PLAYER_BASE.solidRadius`), which is exactly why it is worth asserting: the floor is one
      // `Math.max` in a content file, and this is the thing that notices if a future blueprint,
      // spawn site or resolver routes around it.
      for (const e of s.enemies) {
        if (!e.alive) continue;
        const depth = deepestSolidPenetration(s, e.gx, e.gy, PLAYER_BASE.solidRadius);
        if (depth > WALL_PENETRATION_ALLOWANCE) {
          return `enemy ${e.id} at (${e.gx}, ${e.gy}) stands ${Math.round(depth)} fp inside a solid measured by the PLAYER's clearance`;
        }
      }
      return null;
    },
  },
  {
    name: 'every alive pickup sits where a player body could stand',
    check: (s) => {
      // The other half of the same report: *"掉落物品也不能掉在阻挡区域"*. Stated as a property
      // of the pickup's RESTING PLACE rather than as "is it reachable", deliberately — a
      // reachability check needs a flood fill, a collect radius and a notion of which region
      // the player is in, and every one of those is a place for the test to encode the same
      // assumption as the code. "A player's own collision circle fits here, unmoved" needs none
      // of them, and it implies reachability for free: the player can stand ON the drop.
      //
      // Honest status, because it matters for what this rule is FOR: reverting v50's
      // `dropClearance()` back to `SIM.pickupRadius` does NOT turn this red, and that is not a
      // gap in the test — it is the measurement. 903 real drops across 16 bot-driven runs of
      // the five shipped floors already satisfied it at the old radius, because every shipped
      // room is authored on a 1000 fp lattice and 1000 fp is exactly two player radii, so no
      // pocket exists that a 469 fp circle fits and a 500 fp one does not.
      //
      // So this is a CONTENT gate, not a proof about the code. `clearanceParity.test.ts` owns
      // the code half — including the case, on geometry built for it, where the two radii do
      // come apart, and the limit that no clamp radius can escape a pocket narrower than a
      // body. What this one adds is that a new room piece with a tighter pocket, or a wider
      // body radius, fails here, per tick, on every shipped scenario — which is the thing
      // nobody would think to go and check.
      for (const item of s.pickups) {
        if (!item.alive) continue;
        const depth = deepestSolidPenetration(s, item.gx, item.gy, dropClearance());
        if (depth > WALL_PENETRATION_ALLOWANCE) {
          return `${item.kind} pickup ${item.id} rests ${Math.round(depth)} fp inside a solid at (${item.gx}, ${item.gy}) — no player body can occupy that spot`;
        }
      }
      return null;
    },
  },
  {
    name: 'every fp coordinate is a finite integer',
    check: (s) => {
      // Guards the whole design/06 fixed-point discipline at once. A float leaking into a
      // stored position desyncs on the first client whose rounding differs, and it can arrive
      // from any arithmetic site in the engine — no single unit test covers "all of them".
      const bad = (n: number, what: string): string | null =>
        Number.isFinite(n) && Number.isInteger(n) ? null : `${what} is ${n}`;
      for (const a of [...s.players, ...s.enemies] as Actor[]) {
        for (const [k, v] of [
          ['gx', a.gx],
          ['gy', a.gy],
          ['vx', a.vx],
          ['vy', a.vy],
          ['knockVx', a.knockVx],
          ['knockVy', a.knockVy],
        ] as const) {
          const err = bad(v as number, `actor ${a.id}.${k}`);
          if (err) return err;
        }
      }
      for (const b of s.projectiles) {
        for (const [k, v] of [
          ['gx', b.gx],
          ['gy', b.gy],
          ['vx', b.vx],
          ['vy', b.vy],
        ] as const) {
          const err = bad(v as number, `bullet ${b.id}.${k}`);
          if (err) return err;
        }
      }
      return null;
    },
  },
  {
    name: 'no alive enemy carries an undefined roomId in dungeon mode',
    check: (s) => {
      // A named, twice-recurring omission in this repo rather than a hypothetical:
      // `DoorSystem`'s `hasLiveEnemy` scan skips any enemy with `roomId === undefined`, so a
      // spawn site that forgets to set it leaves a room's door open for a tick — or, in the
      // `DeathDropsSystem` boss-adds case found in live play, unlocks then re-locks and force-
      // regroups the player. Every `state.enemies.push(...)` site has to set it; this notices
      // when a new one does not.
      if (s.dungeonRooms.length === 0) return null; // not a dungeon run
      for (const e of s.enemies) {
        if (e.alive && e.roomId === undefined) return `enemy ${e.id} alive with no roomId at (${e.gx}, ${e.gy})`;
      }
      return null;
    },
  },
  {
    name: 'every alive entity is inside the world',
    check: (s) => {
      // Deliberately generous — this is looking for an entity that has escaped entirely, not
      // for a margin violation. `MovementSystem.clampToWorld` only ever runs on PLAYERS, so an
      // enemy legitimately sits outside the player margin; a whole world's width outside is a
      // different thing.
      const slack = 4000;
      for (const a of [...s.players, ...s.enemies] as Actor[]) {
        if (!a.alive) continue;
        if (
          (a.gx as number) < -slack ||
          (a.gy as number) < -slack ||
          (a.gx as number) > (s.worldW as number) + slack ||
          (a.gy as number) > (s.worldH as number) + slack
        ) {
          return `actor ${a.id} escaped the world at (${a.gx}, ${a.gy}) of ${s.worldW}x${s.worldH}`;
        }
      }
      return null;
    },
  },
  {
    name: 'hp never exceeds maxHp',
    check: (s) => {
      // Cheap, and it covers a bug class this repo has a name for: introducing a fractional
      // value into a previously-integer domain exposes a latent unclamped `+1` that integer
      // snapping used to mask. Shield regen and heal pickups are both such increments.
      for (const a of [...s.players, ...s.enemies] as Actor[]) {
        if (a.hp > a.maxHp) return `actor ${a.id} has hp ${a.hp} > maxHp ${a.maxHp}`;
        if (a.shield > a.maxShield) return `actor ${a.id} has shield ${a.shield} > maxShield ${a.maxShield}`;
      }
      return null;
    },
  },
];

/** Drive one scenario, checking every invariant every tick. Stops at the first breach per rule. */
function run(sc: GoldenScenario): {
  breaches: Breach[];
  ticks: number;
  state: GameState;
  worstPenetration: number;
  pickupsSeen: number;
} {
  const engine = createGameEngine(sc.config);
  const breaches: Breach[] = [];
  const silenced = new Set<string>();
  let worstPenetration = 0;
  // Distinct pickup ids seen alive at any point, not `state.pickups.length` at the end — a
  // collected drop is compacted out, so the final array says nothing about how many the run
  // actually placed and checked.
  const pickupsSeen = new Set<number>();
  let t = 1;
  for (; t <= sc.ticks; t++) {
    const cmds: PlayerCommand[] = [];
    for (let owner = 0; owner < sc.seats; owner++) {
      // A simple always-moving, always-firing stream. This file does not need the golden
      // scenarios' exact input (it is not comparing hashes), only their CONFIGS — so the
      // stream stays trivial and readable rather than importing the scripted one.
      cmds.push(
        makeCommand({
          owner,
          tick: t,
          moveBrad: ((((t * 137 + owner * 971) % BRAD_FULL) | 0) as number) as Brad,
          moveMag: 255,
          buttons: Button.FIRE,
        }),
      );
    }
    const before = engine.state.tick;
    engine.step(cmds);
    if (engine.state.tick === before) break; // gameover
    worstPenetration = Math.max(worstPenetration, deepestWallPenetration(engine.state));
    for (const item of engine.state.pickups) if (item.alive) pickupsSeen.add(item.id);
    for (const inv of INVARIANTS) {
      if (silenced.has(inv.name)) continue;
      const err = inv.check(engine.state);
      if (err) {
        breaches.push({ scenario: sc.name, tick: engine.state.tick, what: `${inv.name}: ${err}` });
        silenced.add(inv.name); // one report per rule per scenario, not one per tick
      }
    }
  }
  return { breaches, ticks: t - 1, state: engine.state, worstPenetration, pickupsSeen: pickupsSeen.size };
}

/**
 * How far the worst-off actor is inside a wall right now, in fp. Shares its geometry with the
 * `no actor is inside a solid` invariant deliberately — one definition, so the bound asserted
 * later cannot drift away from the rule that produced it.
 */
function deepestWallPenetration(s: GameState): number {
  let worst = 0;
  for (const a of [...s.players, ...s.enemies] as Actor[]) {
    if (!a.alive) continue;
    const r = blockingRadius(a) as number;
    for (const w of s.walls) {
      const b = blockingRect(w);
      const cx = Math.max(b.left as number, Math.min(a.gx as number, b.right as number));
      const cy = Math.max(b.top as number, Math.min(a.gy as number, b.bottom as number));
      const dx = (a.gx as number) - cx;
      const dy = (a.gy as number) - cy;
      worst = Math.max(worst, r - Math.sqrt(dx * dx + dy * dy));
    }
  }
  return worst;
}

/**
 * How far a circle of radius `r` centred on (gx, gy) reaches into the nearest solid — walls
 * (brimmed rect, `blockingRect`) and pillars alike. Positive means overlap; 0 or less means
 * clear, tangency included.
 *
 * Split out so the two v50 invariants above can ask the SAME geometric question about a
 * different circle than the actor's own: a mob measured by the player's clearance, and a
 * pickup measured by `dropClearance()`. Sharing the shape is the point — an invariant that
 * re-derived "inside a solid" for itself could disagree with the rule it is guarding, which is
 * this suite's whole reason for existing.
 */
function deepestSolidPenetration(s: GameState, gx: Fp, gy: Fp, r: Fp): number {
  let worst = 0;
  for (const w of s.walls) {
    const b = blockingRect(w);
    const cx = Math.max(b.left as number, Math.min(gx as number, b.right as number));
    const cy = Math.max(b.top as number, Math.min(gy as number, b.bottom as number));
    const dx = (gx as number) - cx;
    const dy = (gy as number) - cy;
    worst = Math.max(worst, (r as number) - Math.sqrt(dx * dx + dy * dy));
  }
  for (const o of s.obstacles) {
    const dx = (gx as number) - (o.gx as number);
    const dy = (gy as number) - (o.gy as number);
    worst = Math.max(worst, (r as number) + (o.radius as number) - Math.sqrt(dx * dx + dy * dy));
  }
  return worst;
}

const RUNS = GOLDEN_SCENARIOS.map((sc) => ({ sc, ...run(sc) }));

describe.each(RUNS.map((r) => [r.sc.name, r] as const))('%s', (_name, r) => {
  it('holds every invariant on every tick', () => {
    expect(r.breaches.map((b) => `t${b.tick} ${b.what}`)).toEqual([]);
  });

  it('actually ran', () => {
    // The anti-vacuity guard, per scenario. Every assertion above is `toEqual([])`, which a
    // zero-tick run satisfies perfectly.
    expect(r.ticks, `${r.sc.name} produced no ticks`).toBeGreaterThan(50);
  });
});

describe('the smoke suite as a whole exercised the engine', () => {
  it('no actor ends any tick meaningfully inside a wall', () => {
    // The deepest penetration across every scenario, asserted directly rather than only through
    // the per-tick invariant, so a regression that reintroduces the v48 pair-shove standoff
    // fails here with an actual number instead of a boolean. This was `toBeGreaterThan(1)` on
    // the other side too, while the standoff was still shipping; v49 removed the reason.
    let worst = 0;
    for (const r of RUNS) worst = Math.max(worst, r.worstPenetration);
    expect(worst, 'an actor is inside a wall by more than the rounding residue of the push').toBeLessThanOrEqual(
      WALL_PENETRATION_ALLOWANCE,
    );
  });

  it('covers combat, geometry, the dungeon and the arena between them', () => {
    // Guards against the set silently shrinking to whatever still passes.
    const names = RUNS.map((r) => r.sc.name);
    expect(names).toContain('walls-and-pillars');
    expect(names).toContain('ember-dungeon-floor1');
    expect(names).toContain('brim-grinder');
    expect(names).toContain('launch-arena-pvp');
    expect(RUNS.reduce((n, r) => n + r.ticks, 0)).toBeGreaterThan(3000);
  });

  it('every invariant was genuinely evaluated, not skipped', () => {
    // The subtlest way this file could die: an invariant whose `check` returns null because it
    // bailed early (the dungeon `roomId` rule returns null for non-dungeon runs, by design)
    // would be silently inert if NO scenario ever reached its precondition. Assert that at
    // least one run satisfies each rule's precondition.
    const dungeonRuns = RUNS.filter((r) => r.state.dungeonRooms.length > 0);
    expect(dungeonRuns.length, 'no scenario is a dungeon run — the roomId invariant is inert').toBeGreaterThan(0);
    const withEnemies = RUNS.filter((r) => r.state.enemies.length > 0);
    expect(withEnemies.length, 'no scenario ever spawned an enemy').toBeGreaterThan(0);
    // The v50 pickup rule is the one most at risk of going inert: a run where nothing ever
    // dies produces no drops, and "no pickup is inside a solid" is then perfectly true of the
    // empty set. Counted over the whole run rather than at the final state, since a collected
    // pickup leaves `state.pickups` — asserting on the end state would have measured only
    // whatever happened to be lying on the floor when the budget ran out.
    const totalDrops = RUNS.reduce((n, r) => n + r.pickupsSeen, 0);
    expect(totalDrops, 'no scenario ever produced a pickup — the drop-placement invariant is inert').toBeGreaterThan(
      0,
    );
    const withWalls = RUNS.filter((r) => r.state.walls.length > 0);
    expect(withWalls.length, 'no scenario has any wall geometry — the containment rule is inert').toBeGreaterThan(1);
  });

  it('the serialized state carries no float at all', () => {
    // `serializeState` is what the replay hash and the anti-cheat checkpoint are computed over
    // (design/06/15), so this walks the whole serialized shape rather than the handful of
    // fields the per-tick invariant covers.
    //
    // Until 2026-09-21 this test recorded a FINDING instead of enforcing the rule: `hp` and
    // `shield` came out fractional (3.2, 4.2 in four of the five scenarios) and the exemption
    // was argued to be safe — correctly, as far as it went (IEEE 754 specifies `+ - * /` to be
    // correctly rounded, so the same ops in the same order are bit-identical on every platform;
    // what design/06 really bans is transcendentals and platform-dependent math). But "safe"
    // was never the whole question. The single source of every one of those fractions was
    // `vanguard.maxShield: 3.2`, a design number the forge printed at the player, and its own
    // note warned that the first `*` or `/` on the pool would turn the exemption into a real
    // desync. The pool is an integer now (`content/skins.ts`), so the rule holds with no
    // exemption and this asserts it rather than describing it.
    const floats: string[] = [];
    let numbersSeen = 0;
    const walk = (v: unknown, path: string): void => {
      if (typeof v === 'number') {
        numbersSeen++;
        if (!Number.isInteger(v)) floats.push(`${path} = ${v}`);
        return;
      }
      if (Array.isArray(v)) {
        v.forEach((item, i) => walk(item, `${path}[${i}]`));
        return;
      }
      if (v && typeof v === 'object') {
        for (const [k, item] of Object.entries(v)) walk(item, `${path}.${k}`);
      }
    };
    for (const r of RUNS) walk(serializeState(r.state), r.sc.name);
    expect(floats.slice(0, 8)).toEqual([]);
    // The anti-vacuity half: a walk that visited nothing would also report no floats.
    expect(numbersSeen, 'the walk visited no numbers — the no-float rule is inert').toBeGreaterThan(500);
  });
});
