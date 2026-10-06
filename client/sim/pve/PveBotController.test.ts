/**
 * PveBotController — the level simulator's driver. Tested against hand-built states
 * rather than live runs so each decision branch (fire/kite/heal-seek/rest/travel/
 * confirm-portal) is exercised in isolation; `levelSim.test.ts` covers it end-to-end
 * through the real engine.
 *
 * The `as unknown as GameState` fixture cast follows `pveNav.test.ts`'s: the bot reads
 * a documented handful of fields, and a literal makes the geometry under test obvious
 * where a real generated floor would hide it.
 */
import { describe, expect, it } from 'vitest';
import { Button, FP_SCALE, WEAPON_SPECS, SIM, weaponProfile, type GameState } from '@dd/engine';
import { BOT_PROFILES, PveBotController } from './PveBotController';

const g = (grid: number): number => grid * FP_SCALE;

interface FixtureOpts {
  playerAt: [number, number];
  hp?: number;
  shield?: number;
  /** [gx, gy, roomId, alive?] per enemy, in grid units. */
  enemies?: [number, number, string, boolean?][];
  heals?: [number, number][];
  /** Room id → whether its runtime says it still holds a live enemy. */
  rooms?: { id: string; x: number; y: number; w: number; h: number; activated?: boolean; hasLiveEnemy?: boolean }[];
  doors?: [string, string, { x: number; y: number; w: number; h: number }][];
  floorIndex?: number;
  floorCount?: number;
  /** [gx, gy, weaponId] per weapon lying on the floor, in grid units (2026-09-26). */
  floorWeapons?: [number, number, string][];
  /** Weapon ids in the seat's slots; the first is the one in hand. Default: none. */
  held?: string[];
  /** The seat's energy pool (2026-09-29, `meleeWhenDry`). Default: full at 100. */
  energy?: number;
  maxEnergy?: number;
  chests?: { roomId: string; kind: 'small' | 'big'; at: [number, number]; opened?: boolean; plates?: [number, number, boolean][] }[];
}

/** Two 10x10 rooms side by side joined by a doorway at their shared edge — the
 *  smallest floor that can exercise travel, and the default for tests that only care
 *  about combat (everything happens inside `a`).
 *
 *  `b` is deliberately UNACTIVATED: it is the last placed room, i.e. the capstone, so
 *  an activated-and-quiet `b` would make `checkpointReached` true and put the bot in
 *  portal mode for every test in the file. */
const TWO_ROOMS: NonNullable<FixtureOpts['rooms']> = [
  { id: 'a', x: 0, y: 0, w: g(10), h: g(10) },
  { id: 'b', x: g(10), y: 0, w: g(10), h: g(10), activated: false },
];
const DOOR_AB: NonNullable<FixtureOpts['doors']> = [['a', 'b', { x: g(9.5), y: g(4), w: g(1), h: g(2) }]];

/** The catalogued spec where there is one, so a fixture gun carries its real `energyCost`. */
const specOf = (id: string) => ({ ...(WEAPON_SPECS[id] ?? { kind: 'ranged' }), name: id });

function fixture(o: FixtureOpts): GameState {
  const rooms = o.rooms ?? TWO_ROOMS;
  return {
    tick: 500,
    floorIndex: o.floorIndex ?? 0,
    dungeonEnabled: true,
    dungeonConfig: { floorCount: o.floorCount ?? 5 },
    players: [
      {
        id: 1,
        alive: true,
        downed: false,
        gx: g(o.playerAt[0]),
        gy: g(o.playerAt[1]),
        hp: o.hp ?? 6,
        maxHp: 6,
        shield: o.shield ?? 3.2,
        maxShield: 3.2,
        energy: o.energy ?? o.maxEnergy ?? 100,
        maxEnergy: o.maxEnergy ?? 100,
        weapons: (o.held ?? []).map((id) => ({ spec: specOf(id) })),
        weapon: o.held?.[0] ? { spec: specOf(o.held[0]) } : undefined,
      },
    ],
    chests: (o.chests ?? []).map((c, i) => ({
      id: 80 + i,
      roomId: c.roomId,
      kind: c.kind,
      gx: g(c.at[0]),
      gy: g(c.at[1]),
      opened: c.opened ?? false,
      mechanisms: (c.plates ?? []).map(([x, y, occupied]) => ({ gx: g(x), gy: g(y), occupied })),
    })),
    enemies: (o.enemies ?? []).map(([gx, gy, roomId, alive], i) => ({
      id: 10 + i,
      alive: alive ?? true,
      gx: g(gx),
      gy: g(gy),
      roomId,
    })),
    pickups: [
      ...(o.heals ?? []).map(([gx, gy], i) => ({ id: 50 + i, alive: true, kind: 'heal', gx: g(gx), gy: g(gy) })),
      ...(o.floorWeapons ?? []).map(([gx, gy, weaponId], i) => ({ id: 60 + i, alive: true, kind: 'weapon', weaponId, gx: g(gx), gy: g(gy) })),
    ],
    dungeonRooms: rooms.map((r) => ({ id: r.id })),
    dungeonRoomRects: rooms.map((r) => ({ id: r.id, rect: { x: r.x, y: r.y, w: r.w, h: r.h } })),
    dungeonRoomRuntime: rooms.map((r) => ({
      activated: r.activated ?? true,
      roomTick: 100,
      schedule: [],
      cursor: 0,
      hasLiveEnemy: r.hasLiveEnemy ?? false,
    })),
    dungeonRoomIndexById: new Map(rooms.map((r, i) => [r.id, i] as const)),
    dungeonDoors: (o.doors ?? DOOR_AB).map(([a, b, rect]) => ({
      door: { roomA: a, roomB: b, passageGrid: { x: 0, y: 0, w: 0, h: 0 } },
      passageAabb: rect,
      locked: false,
    })),
    wavesExhausted: false,
  } as unknown as GameState;
}

/** brad → the unit vector it points along, for asserting a movement DIRECTION without
 *  restating `quantizeMove`'s own rounding. */
function dir(brad: number): { x: number; y: number } {
  const rad = (brad / 65536) * Math.PI * 2;
  return { x: Math.cos(rad), y: Math.sin(rad) };
}

const bot = (profile = BOT_PROFILES.careful) => new PveBotController(profile);

/** Nudge the seat's y in grid units. `gx`/`gy` are branded `Fp` on the real actor, and
 *  the fixture is a structural cast, so a plain number needs the same cast the fixture
 *  itself uses. */
function setSeatY(s: GameState, grid: number): void {
  (s.players[0] as unknown as { gy: number }).gy = g(grid);
}

describe('PveBotController — dead/downed seats', () => {
  it('idles when its seat does not exist', () => {
    const cmd = bot().build(fixture({ playerAt: [5, 5] }), 3, 501);
    expect(cmd.moveMag).toBe(0);
    expect(cmd.buttons).toBe(0);
  });

  it('idles when dead or downed rather than issuing a fire command', () => {
    const s = fixture({ playerAt: [5, 5], enemies: [[6, 5, 'a']] });
    s.players[0]!.alive = false;
    expect(bot().build(s, 0, 501).buttons).toBe(0);
    s.players[0]!.alive = true;
    s.players[0]!.downed = true;
    expect(bot().build(s, 0, 501).buttons).toBe(0);
  });
});

describe('PveBotController — engaging', () => {
  it('fires at an in-range enemy in its own room', () => {
    const cmd = bot().build(fixture({ playerAt: [2, 5], enemies: [[8, 5, 'a']] }), 0, 501);
    expect(cmd.buttons & Button.FIRE).toBe(Button.FIRE);
  });

  it('ignores enemies in a DIFFERENT room — it cannot shoot through a wall', () => {
    // Without this filter the bot settles into a standoff with an unhittable mob and
    // never advances again (observed: 7 of 8 careful sim runs stalled forever).
    const cmd = bot().build(fixture({ playerAt: [8, 5], enemies: [[11, 5, 'b']] }), 0, 501);
    expect(cmd.buttons & Button.FIRE).toBe(0);
  });

  it('holds fire while a target is beyond its own fire range', () => {
    const s = fixture({
      playerAt: [2, 2],
      rooms: [
        { id: 'a', x: 0, y: 0, w: g(40), h: g(40) },
        { id: 'b', x: g(40), y: 0, w: g(10), h: g(10), activated: false },
      ],
      doors: [['a', 'b', { x: g(39.5), y: g(4), w: g(1), h: g(2) }]],
      enemies: [[30, 30, 'a']],
    });
    expect(bot().build(s, 0, 501).buttons & Button.FIRE).toBe(0);
  });

  it('closes distance when outside its standoff band', () => {
    // 11 grid apart — past careful's 7.5 standoff plus its 1-grid hysteresis.
    const s = fixture({
      playerAt: [1, 5],
      rooms: [
        { id: 'a', x: 0, y: 0, w: g(40), h: g(40) },
        { id: 'b', x: g(40), y: 0, w: g(10), h: g(10), activated: false },
      ],
      doors: [['a', 'b', { x: g(39.5), y: g(4), w: g(1), h: g(2) }]],
      enemies: [[12, 5, 'a']],
    });
    const cmd = bot().build(s, 0, 501);
    expect(cmd.moveMag).toBeGreaterThan(0);
    expect(dir(cmd.moveBrad).x).toBeGreaterThan(0.9); // toward the enemy (+x)
  });

  it('backs off when the target is INSIDE its standoff band — the careful profile kites', () => {
    const s = fixture({ playerAt: [5, 5], enemies: [[7, 5, 'a']] }); // 2 grid < careful's 7.5
    const cmd = bot().build(s, 0, 501);
    expect(cmd.moveMag).toBeGreaterThan(0);
    expect(dir(cmd.moveBrad).x).toBeLessThan(-0.9); // away from the enemy (-x)
  });

  it('holds position inside the hysteresis dead zone instead of oscillating', () => {
    const s = fixture({ playerAt: [0, 5], enemies: [[7.5, 5, 'a']] }); // exactly the standoff
    expect(bot().build(s, 0, 501).moveMag).toBe(0);
  });

  it('the aggressive profile closes where the careful one would already be backing off', () => {
    const s = fixture({ playerAt: [1, 5], enemies: [[7, 5, 'a']] }); // 6 grid
    expect(dir(bot(BOT_PROFILES.aggressive).build(s, 0, 501).moveBrad).x).toBeGreaterThan(0.9); // still closing
    expect(dir(bot(BOT_PROFILES.careful).build(s, 0, 501).moveBrad).x).toBeLessThan(-0.9); // already too close
  });

  it('skips dead enemies when choosing a target', () => {
    const s = fixture({ playerAt: [2, 5], enemies: [[3, 5, 'a', false]] });
    // The only enemy is a corpse → nothing to fight, so it should not be firing.
    expect(bot().build(s, 0, 501).buttons & Button.FIRE).toBe(0);
  });
});

describe('PveBotController — heal seeking', () => {
  it('walks to a nearby heal when hurt, while still shooting', () => {
    const s = fixture({ playerAt: [5, 5], hp: 2, shield: 0, enemies: [[9, 5, 'a']], heals: [[5, 9]] });
    const cmd = bot().build(s, 0, 501);
    expect(dir(cmd.moveBrad).y).toBeGreaterThan(0.9); // toward the heal (+y), not spacing
    expect(cmd.buttons & Button.FIRE).toBe(Button.FIRE);
  });

  it('ignores heals at full health — it is not a vacuum', () => {
    const s = fixture({ playerAt: [5, 5], enemies: [[7, 5, 'a']], heals: [[5, 9]] });
    expect(dir(bot().build(s, 0, 501).moveBrad).x).toBeLessThan(-0.9); // kiting, not detouring
  });

  it('collects a heal in a quiet room before moving on', () => {
    const s = fixture({ playerAt: [5, 5], hp: 2, shield: 0, heals: [[5, 9]] });
    expect(dir(bot().build(s, 0, 501).moveBrad).y).toBeGreaterThan(0.9);
  });
});

describe('PveBotController — resting between rooms', () => {
  it('stands still in a cleared room while the shield refills (careful)', () => {
    // Room `b` is unexplored, so there IS somewhere to go — the bot should still wait.
    const s = fixture({ playerAt: [5, 5], shield: 0 });
    expect(bot().build(s, 0, 501).moveMag).toBe(0);
  });

  it('does not rest once the shield is full', () => {
    const s = fixture({
      playerAt: [5, 5],
      shield: 3.2,
      rooms: [
        { id: 'a', x: 0, y: 0, w: g(10), h: g(10) },
        { id: 'b', x: g(10), y: 0, w: g(10), h: g(10), activated: false },
      ],
    });
    expect(bot().build(s, 0, 501).moveMag).toBeGreaterThan(0); // heads for the unexplored room
  });

  it('never rests on the aggressive profile — it walks straight into the next room', () => {
    const s = fixture({
      playerAt: [5, 5],
      shield: 0,
      rooms: [
        { id: 'a', x: 0, y: 0, w: g(10), h: g(10) },
        { id: 'b', x: g(10), y: 0, w: g(10), h: g(10), activated: false },
      ],
    });
    expect(bot(BOT_PROFILES.aggressive).build(s, 0, 501).moveMag).toBeGreaterThan(0);
  });

  it('gives up resting after the cap, so a shieldless character can never wedge the run', () => {
    const s = fixture({
      playerAt: [5, 5],
      shield: 0,
      rooms: [
        { id: 'a', x: 0, y: 0, w: g(10), h: g(10) },
        { id: 'b', x: g(10), y: 0, w: g(10), h: g(10), activated: false },
      ],
    });
    const b = bot();
    let moved = false;
    for (let t = 0; t < 700 && !moved; t++) moved = b.build(s, 0, 501 + t).moveMag > 0;
    expect(moved).toBe(true);
  });
});

describe('PveBotController — travelling', () => {
  it('heads for the door passage when the objective is the next room', () => {
    const s = fixture({
      playerAt: [3, 5],
      rooms: [
        { id: 'a', x: 0, y: 0, w: g(10), h: g(10) },
        { id: 'b', x: g(10), y: 0, w: g(10), h: g(10), activated: false },
      ],
    });
    const cmd = bot().build(s, 0, 501);
    expect(dir(cmd.moveBrad).x).toBeGreaterThan(0.7); // eastward, toward the shared wall
  });

  it('prefers the nearest room still holding live enemies over an unexplored far one', () => {
    const s = fixture({
      playerAt: [15, 5], // in room b, which is clear
      rooms: [
        { id: 'a', x: 0, y: 0, w: g(10), h: g(10), hasLiveEnemy: true },
        { id: 'b', x: g(10), y: 0, w: g(10), h: g(10) },
        { id: 'c', x: g(20), y: 0, w: g(10), h: g(10), activated: false },
      ],
      doors: [
        ['a', 'b', { x: g(9.5), y: g(4), w: g(1), h: g(2) }],
        ['b', 'c', { x: g(19.5), y: g(4), w: g(1), h: g(2) }],
      ],
      shield: 3.2,
    });
    // Both qualify as objectives; BFS finds each at one hop, and door order decides —
    // the assertion is only that it commits to ONE of them and moves.
    expect(bot().build(s, 0, 501).moveMag).toBeGreaterThan(0);
  });

  it('idles when it is nowhere inside the floor at all (no room to reason from)', () => {
    const s = fixture({ playerAt: [90, 90] });
    expect(bot().build(s, 0, 501).moveMag).toBe(0);
  });
});

describe('PveBotController — the portal', () => {
  /** Capstone (last room) activated and clear → `checkpointReached` is true. */
  const atCheckpoint = (playerAt: [number, number], floorIndex = 0) =>
    fixture({
      playerAt,
      floorIndex,
      shield: 3.2,
      rooms: [
        { id: 'a', x: 0, y: 0, w: g(10), h: g(10) },
        { id: 'cap', x: g(10), y: 0, w: g(10), h: g(10), activated: true, hasLiveEnemy: false },
      ],
      doors: [['a', 'cap', { x: g(9.5), y: g(4), w: g(1), h: g(2) }]],
    });

  it('walks to the capstone room first — it does not confirm from across the floor', () => {
    const cmd = bot().build(atCheckpoint([3, 5]), 0, 501);
    expect(cmd.buttons).toBe(0);
    expect(cmd.moveMag).toBeGreaterThan(0);
  });

  it('presses DESCEND once inside the capstone, while floors remain', () => {
    const cmd = bot().build(atCheckpoint([15, 5], 0), 0, 501);
    expect(cmd.buttons & Button.CONFIRM_DESCEND).toBe(Button.CONFIRM_DESCEND);
    expect(cmd.buttons & Button.CONFIRM_EXTRACT).toBe(0);
  });

  it('presses EXTRACT instead on the last floor, where there is nothing to descend to', () => {
    const cmd = bot().build(atCheckpoint([15, 5], 4), 0, 501); // floorCount 5 → index 4 is last
    expect(cmd.buttons & Button.CONFIRM_EXTRACT).toBe(Button.CONFIRM_EXTRACT);
    expect(cmd.buttons & Button.CONFIRM_DESCEND).toBe(0);
  });

  it('presses DESCEND on an endless boss floor, which offers both — the sweep measures depth', () => {
    const s = atCheckpoint([15, 5], 4);
    (s as { dungeonConfig: unknown }).dungeonConfig = { floorCount: 5, endless: { segments: [{ floorCount: 5 }] } };
    const cmd = bot().build(s, 0, 501);
    expect(cmd.buttons & Button.CONFIRM_DESCEND).toBe(Button.CONFIRM_DESCEND);
    expect(cmd.buttons & Button.CONFIRM_EXTRACT).toBe(0);
  });
});

describe('PveBotController — circling a target nothing is killing', () => {
  it('switches from spacing to a perpendicular strafe once no kill has landed for a while', () => {
    // The stall this models: a mob behind a pillar soaks every bullet in the wall, so a
    // purely radial mover shoots that wall until the run times out (2-3 of 8 sim runs
    // per profile before this existed). Enemy due EAST and inside the standoff band, so
    // spacing would move due WEST — a perpendicular move is unambiguously distinguishable.
    const s = fixture({ playerAt: [5, 5], enemies: [[7, 5, 'a']] });
    const b = bot();
    expect(dir(b.build(s, 0, 501).moveBrad).x).toBeLessThan(-0.9); // kiting, as usual

    // Jitter the seat a hair per tick: a bot that never MOVES also trips the separate
    // stuck-unstick rotation, which would rotate the orbit heading on top of itself and
    // muddy what is being asserted. A real kiting bot is always drifting.
    let cmd = b.build(s, 0, 502);
    for (let t = 2; t <= 200; t++) {
      setSeatY(s, 5 + (t % 2 === 0 ? 0.05 : -0.05));
      cmd = b.build(s, 0, 501 + t); // nothing ever dies
    }
    // Perpendicular to the target direction: mostly vertical, not the radial ±x.
    expect(Math.abs(dir(cmd.moveBrad).y)).toBeGreaterThan(0.7);
    expect(cmd.buttons & Button.FIRE).toBe(Button.FIRE); // still shooting while it circles
  });

  it('goes back to holding spacing as soon as something dies', () => {
    const s = fixture({ playerAt: [5, 5], enemies: [[7, 5, 'a'], [8, 5, 'a']] });
    const b = bot();
    for (let t = 0; t <= 200; t++) {
      setSeatY(s, 5 + (t % 2 === 0 ? 0.05 : -0.05));
      b.build(s, 0, 501 + t); // long enough to start circling
    }
    setSeatY(s, 5);
    s.enemies[1]!.alive = false; // a kill lands → the stall is over
    const cmd = b.build(s, 0, 800);
    expect(dir(cmd.moveBrad).x).toBeLessThan(-0.9); // radial kiting again
  });
});

describe('PveBotController — stuck handling', () => {
  it('turns a quarter circle after being pinned for a while, instead of pushing into the wall forever', () => {
    const s = fixture({
      playerAt: [3, 5],
      rooms: [
        { id: 'a', x: 0, y: 0, w: g(10), h: g(10) },
        { id: 'b', x: g(10), y: 0, w: g(10), h: g(10), activated: false },
      ],
    });
    const b = bot();
    const first = b.build(s, 0, 501); // wants to move east; position never changes below
    let turned = first.moveBrad;
    for (let t = 1; t < 40; t++) turned = b.build(s, 0, 501 + t).moveBrad;
    const delta = Math.abs(((turned - first.moveBrad + 98304) % 65536) - 32768);
    expect(delta).toBeGreaterThan(8192); // meaningfully off the original heading
  });
});

/**
 * Room-scoped target and heal search (2026-08-17). Both scans used to be bounded by a
 * scan RADIUS as well as by the bot's room. That was fine while every woken mob walked
 * over on its own; once `ENGINE_VERSION` 42 gave enemies a perception radius, a mob on
 * the far side of a big room just stood there, the bot found no target inside its scan
 * radius, fell through to `travel`, and bounced off the room's combat-locked door until
 * the run timed out. The heal scan had the same shape for a different reason: a heal in
 * the room next door is behind that same locked door, and heal-seeking outranks every
 * other move in `fight`.
 *
 * The rule both now follow: while unambiguously inside a room, that ROOM is the bound —
 * its walls already are one, and its doors are locked anyway. Standing in a passage
 * (`roomIdAt` → undefined, both rooms open to the bot) keeps the plain radius scan.
 */
describe('PveBotController — the room, not a scan radius, is what bounds the search', () => {
  // One room far wider than ENGAGE_SCAN_FP (14 grid) / HEAL_SCAN_FP (12 grid), so
  // "inside my room" and "inside my scan radius" are genuinely different sets. Room `b`
  // stays the unactivated capstone, as in TWO_ROOMS.
  const BIG_ROOM: NonNullable<FixtureOpts['rooms']> = [
    { id: 'a', x: 0, y: 0, w: g(40), h: g(10), hasLiveEnemy: true },
    { id: 'b', x: g(40), y: 0, w: g(10), h: g(10), activated: false },
  ];
  const BIG_DOOR: NonNullable<FixtureOpts['doors']> = [['a', 'b', { x: g(39.5), y: g(4), w: g(1), h: g(2) }]];

  it('walks toward the last mob in its own room even when it is far past the scan radius', () => {
    // 33 grid away — more than twice ENGAGE_SCAN_FP. Nothing else will close this gap:
    // the mob has not noticed the player and will not move (v42).
    const s = fixture({ playerAt: [2, 5], rooms: BIG_ROOM, doors: BIG_DOOR, enemies: [[35, 5, 'a']] });
    const cmd = bot().build(s, 0, 501);
    expect(dir(cmd.moveBrad).x).toBeGreaterThan(0.9); // heading east, at the mob
    expect(cmd.buttons & Button.FIRE).toBe(0); // still far outside fire range
  });

  it('does not mistake that for a reason to walk at the door instead', () => {
    // The failure mode this replaced: no target found → travel(nextObjectiveRoom) →
    // the door at x 39.5, y 5. Both head east, so distinguish them on the y axis by
    // putting the mob well off the door's line.
    const s = fixture({ playerAt: [2, 5], rooms: BIG_ROOM, doors: BIG_DOOR, enemies: [[35, 9, 'a']] });
    expect(dir(bot().build(s, 0, 501).moveBrad).y).toBeGreaterThan(0.1); // toward the mob (+y)
  });

  it('still ignores a far mob in ANOTHER room — the room bound is a bound, not a removal', () => {
    const s = fixture({
      playerAt: [2, 5],
      rooms: [
        { id: 'a', x: 0, y: 0, w: g(40), h: g(10) },
        { id: 'b', x: g(40), y: 0, w: g(10), h: g(10), activated: false },
      ],
      doors: BIG_DOOR,
      enemies: [[45, 5, 'b']],
    });
    expect(bot().build(s, 0, 501).buttons & Button.FIRE).toBe(0);
  });

  it('keeps the radius bound while standing in a passage, where no room owns the bot', () => {
    // A real gap between the two rooms, so the seat can be inside neither. Both rooms
    // are open to it there, and a plain radius scan is the correct behaviour.
    const gapped: NonNullable<FixtureOpts['rooms']> = [
      { id: 'a', x: 0, y: 0, w: g(10), h: g(10), hasLiveEnemy: true },
      { id: 'b', x: g(12), y: 0, w: g(40), h: g(10), activated: false },
    ];
    const doors: NonNullable<FixtureOpts['doors']> = [['a', 'b', { x: g(10), y: g(4), w: g(2), h: g(2) }]];

    // The far mob sits OFF the travel line (y 9 vs the door/room-centre line at y 5), so
    // "ignored it and travelled" and "targeted it" are distinguishable on the y axis —
    // both head east otherwise, and both hold fire at 34 grid, so neither the x
    // component nor the trigger can tell them apart.
    const far = fixture({ playerAt: [11, 5], rooms: gapped, doors, enemies: [[45, 9, 'b']] });
    const cmd = bot().build(far, 0, 501);
    expect(Math.abs(dir(cmd.moveBrad).y)).toBeLessThan(0.1); // travelling, not chasing
    expect(cmd.buttons & Button.FIRE).toBe(0);

    const near = fixture({ playerAt: [11, 5], rooms: gapped, doors, enemies: [[18, 5, 'b']] });
    expect(bot().build(near, 0, 501).buttons & Button.FIRE).toBe(Button.FIRE); // 7 grid: engaged
  });

  it('ignores a heal in the next room while its own still holds a live enemy — that door is locked', () => {
    // Hurt enough to want the heal, and it is well inside HEAL_SCAN_FP (4 grid away).
    // Unbounded, `fight` would walk WEST at it, into the locked door, forever.
    const s = fixture({
      playerAt: [12, 5],
      hp: 2,
      shield: 0,
      rooms: [
        { id: 'a', x: g(10), y: 0, w: g(20), h: g(10), hasLiveEnemy: true },
        { id: 'b', x: 0, y: 0, w: g(10), h: g(10), activated: false },
      ],
      doors: [['a', 'b', { x: g(9.5), y: g(4), w: g(1), h: g(2) }]],
      enemies: [[20, 5, 'a']],
      heals: [[8, 5]], // in room `b`, behind the door
    });
    expect(dir(bot().build(s, 0, 501).moveBrad).x).toBeGreaterThan(0); // east, at the mob
  });

  it('still takes a heal that IS in its own room — the filter must not block the normal case', () => {
    const s = fixture({
      playerAt: [12, 5],
      hp: 2,
      shield: 0,
      rooms: [
        { id: 'a', x: g(10), y: 0, w: g(20), h: g(10), hasLiveEnemy: true },
        { id: 'b', x: 0, y: 0, w: g(10), h: g(10), activated: false },
      ],
      doors: [['a', 'b', { x: g(9.5), y: g(4), w: g(1), h: g(2) }]],
      enemies: [[20, 5, 'a']],
      heals: [[12, 9]], // same room, due south
    });
    expect(dir(bot().build(s, 0, 501).moveBrad).y).toBeGreaterThan(0.9);
  });
});


/**
 * Chests and better guns (2026-09-26). Until then the bot fought every floor with the starter
 * blaster: the capstone was usually nearer than the dead-end chest room, it never walked up to
 * a chest, and it had no notion of a better gun — so `weaponFireStats` read `blaster 100%` on
 * every sweep and nothing measured a looted frame running its pool dry.
 */
describe('PveBotController — chests and better guns', () => {
  const dps = (id: string) => weaponProfile(id, WEAPON_SPECS[id]!).axes.dps!;
  const rank = (id: string) => ['common', 'fine', 'epic', 'legend', 'legendary'].indexOf(WEAPON_SPECS[id]!.rarity);
  const ranged = Object.keys(WEAPON_SPECS).filter((id) => WEAPON_SPECS[id]!.kind === 'ranged');
  const better = ranged.find((id) => dps(id) > dps('blaster'))!;
  const same = ranged.find((id) => id !== 'blaster' && dps(id) === dps('blaster'));
  /** Rarer than the blaster and slower than it — what the rarity ordering used to walk to. */
  const rarerButSlower = ranged.find((id) => rank(id) > rank('blaster') && dps(id) < dps('blaster'));

  it('walks to an unopened small chest in its quiet room', () => {
    const s = fixture({ playerAt: [2, 2], held: ['blaster'], chests: [{ roomId: 'a', kind: 'small', at: [8, 8] }] });
    const d = dir(bot().build(s, 0, 501).moveBrad);
    expect(d.x).toBeGreaterThan(0.5);
    expect(d.y).toBeGreaterThan(0.5);
  });

  it("stands on a big chest's free plate, not on the chest", () => {
    const s = fixture({
      playerAt: [5, 5],
      held: ['blaster'],
      chests: [{ roomId: 'a', kind: 'big', at: [8, 5], plates: [[5, 1, false]] }],
    });
    expect(dir(bot().build(s, 0, 501).moveBrad).y).toBeLessThan(-0.9); // straight up to the plate
  });

  /** A second seat standing well away from the chest: a co-op squadmate. */
  const withMate = (s: GameState) => {
    (s.players as unknown as object[]).push({ id: 2, alive: true, downed: false, gx: g(1), gy: g(9) });
    return s;
  };

  it('keeps the plate it stands on rather than walking to the free one (co-op, 2026-10-03)', () => {
    // Its own plate reads occupied, by itself: "the first free plate" walked it off to the other.
    const s = withMate(fixture({
      playerAt: [5, 1],
      held: ['blaster'],
      chests: [{ roomId: 'a', kind: 'big', at: [5, 5], plates: [[5, 1, true], [5, 9, false]] }],
    }));
    const cmd = bot().build(s, 0, 501);
    expect(cmd.moveMag > 0 && dir(cmd.moveBrad).y > 0.5).toBe(false);
    // Control: a step off its plate, it heads back to that one, not south to the free one.
    const off = withMate(fixture({
      playerAt: [3, 1],
      held: ['blaster'],
      chests: [{ roomId: 'a', kind: 'big', at: [5, 5], plates: [[5, 1, false], [5, 9, false]] }],
    }));
    expect(dir(bot().build(off, 0, 501).moveBrad).x).toBeGreaterThan(0.9);
  });

  it('passes over a big chest with more plates than there are standing seats', () => {
    // Two plates and one seat (the fixture is solo): with its co-op ally dead, the bot stood on
    // its plate for the rest of the run. Control: with a squadmate standing, it goes up to one.
    const chest = () => fixture({
      playerAt: [5, 5],
      held: ['blaster'],
      chests: [{ roomId: 'a', kind: 'big', at: [8, 5], plates: [[5, 1, false], [5, 9, false]] }],
    });
    expect(dir(bot().build(chest(), 0, 501).moveBrad).x).toBeGreaterThan(0.5);
    expect(dir(bot().build(withMate(chest()), 0, 501).moveBrad).y).toBeLessThan(-0.9);
  });

  it('ignores an opened chest and one in another room', () => {
    const s = fixture({
      playerAt: [5, 5],
      held: ['blaster'],
      chests: [
        { roomId: 'a', kind: 'small', at: [1, 1], opened: true },
        { roomId: 'b', kind: 'small', at: [15, 5] },
      ],
    });
    const cmd = bot().build(s, 0, 501);
    expect(cmd.pickupTargetId).toBe(0);
    // With nothing left here it travels (the only door is east), never toward the opened chest.
    expect(dir(cmd.moveBrad).x).toBeGreaterThan(0.5);
  });

  it("walks to a better gun and clicks it once inside the pickup panel's reach", () => {
    const far = bot().build(fixture({ playerAt: [1, 5], held: ['blaster'], floorWeapons: [[8, 5, better]] }), 0, 501);
    expect(dir(far.moveBrad).x).toBeGreaterThan(0.9);
    expect(far.pickupTargetId).toBe(0); // out of reach: walk, do not click yet
    const reach = (SIM.lootRevealRadius as number) / FP_SCALE;
    const near = bot().build(fixture({ playerAt: [8 - reach / 2, 5], held: ['blaster'], floorWeapons: [[8, 5, better]] }), 0, 501);
    expect(near.pickupTargetId).toBe(60);
  });

  it('never takes a gun that is not strictly better, so the one a swap drops cannot lure it back', () => {
    expect(same).toBeDefined();
    const s = fixture({ playerAt: [8, 5], held: ['blaster'], floorWeapons: [[8.5, 5, same!]] });
    expect(bot().build(s, 0, 501).pickupTargetId).toBe(0);
  });

  it('orders guns by dps, not rarity: a rarer, slower gun is not an upgrade', () => {
    // The 2026-09-29 finding: over 400 paired seeds a rarity-ordered swap made the run worse on
    // 46 of 67 seeds, because rarity buys a mechanic and this bot can only use pace (design/03).
    expect(rarerButSlower).toBeDefined();
    const s = fixture({ playerAt: [8, 5], held: ['blaster'], floorWeapons: [[8.5, 5, rarerButSlower!]] });
    expect(bot().build(s, 0, 501).pickupTargetId).toBe(0);
    // Control: the same spot, a faster gun — so the refusal above is the ordering, not the reach.
    const ok = fixture({ playerAt: [8, 5], held: ['blaster'], floorWeapons: [[8.5, 5, better]] });
    expect(bot().build(ok, 0, 501).pickupTargetId).toBe(60);
  });

  it("never takes a melee weapon from the floor — the blade slot is meleeWhenDry's", () => {
    const blade = Object.keys(WEAPON_SPECS).find((id) => WEAPON_SPECS[id]!.kind === 'melee' && rank(id) > 0)!;
    const s = fixture({ playerAt: [8, 5], held: ['blaster'], floorWeapons: [[8.5, 5, blade]] });
    expect(bot().build(s, 0, 501).pickupTargetId).toBe(0);
  });

  it('fights first: a gun on the floor waits until the room is quiet', () => {
    const s = fixture({ playerAt: [5, 5], held: ['blaster'], enemies: [[5, 8, 'a']], floorWeapons: [[5.5, 5, better]] });
    const cmd = bot().build(s, 0, 501);
    expect(cmd.pickupTargetId).toBe(0);
    expect(cmd.buttons & Button.FIRE).toBe(Button.FIRE);
  });

  it('with swapsWeapons off, ignores both chests and guns: the pre-2026-09-26 bot exactly', () => {
    const off = { ...BOT_PROFILES.careful, swapsWeapons: false };
    const s = fixture({
      playerAt: [8, 5],
      held: ['blaster'],
      floorWeapons: [[8.5, 5, better]],
      chests: [{ roomId: 'a', kind: 'small', at: [1, 1] }],
    });
    const cmd = bot(off).build(s, 0, 501);
    expect(cmd.pickupTargetId).toBe(0);
    expect(dir(cmd.moveBrad).x).toBeGreaterThan(0.5); // straight on toward the door, as before
  });

  it('keeps the base spacing for the gun it started with, and re-spaces only after a swap', () => {
    // The shortest-reach ranged gun: re-spacing pulls its fire range in, which the trigger shows.
    const reachOf = (id: string) => {
      const sp = WEAPON_SPECS[id]!;
      return sp.kind === 'ranged' ? sp.bulletSpeed * sp.lifespanSec : 99;
    };
    const shortGun = ranged.filter((id) => id !== 'blaster').sort((x, y) => reachOf(x) - reachOf(y))[0]!;
    const b = bot();
    // First fight: blaster in hand, so it becomes the starting gun and fires at the base 11 grid.
    const blaster = fixture({ playerAt: [5, 0.5], held: ['blaster'], enemies: [[5, 9.5, 'a']] });
    expect(b.build(blaster, 0, 501).buttons & Button.FIRE).toBe(Button.FIRE);
    // Same bot, now holding the swapped-in short gun at the same 9-grid distance: its re-spaced
    // fire range is the gun's own short reach, so it closes instead of firing.
    const swapped = fixture({ playerAt: [5, 0.5], held: [shortGun], enemies: [[5, 9.5, 'a']] });
    const cmd = b.build(swapped, 0, 502);
    expect(cmd.buttons & Button.FIRE).toBe(0);
    expect(dir(cmd.moveBrad).y).toBeGreaterThan(0.9);
  });
});

describe('PveBotController — the capstone is the last objective', () => {
  it('sweeps a nearer unvisited side room before walking into the capstone', () => {
    // a to b (the capstone, placed last) and a to c (a side room): both adjacent, c unvisited.
    const s = fixture({
      playerAt: [5, 5],
      rooms: [
        { id: 'a', x: 0, y: 0, w: g(10), h: g(10) },
        { id: 'c', x: 0, y: g(10), w: g(10), h: g(10), activated: false },
        { id: 'b', x: g(10), y: 0, w: g(10), h: g(10), activated: false },
      ],
      doors: [
        ['a', 'b', { x: g(9.5), y: g(4), w: g(1), h: g(2) }],
        ['a', 'c', { x: g(4), y: g(9.5), w: g(2), h: g(1) }],
      ],
    });
    expect(dir(bot().build(s, 0, 501).moveBrad).y).toBeGreaterThan(0.9); // south to c, not east to b
  });
});

/**
 * The blade when the gun is dry (2026-09-29). Until then a pool that could not pay for a pull
 * left the bot holding FIRE on a refused trigger, disarmed, with a blade in the other slot.
 */
describe('PveBotController — melee when the gun is dry', () => {
  const blade = Object.keys(WEAPON_SPECS).find((id) => WEAPON_SPECS[id]!.kind === 'melee')!;
  const cost = (WEAPON_SPECS.blaster as { energyCost: number }).energyCost;
  const fight = (o: Partial<FixtureOpts>) =>
    fixture({ playerAt: [5, 2], held: ['blaster', blade], enemies: [[5, 8, 'a']], ...o });
  /** A bot that has already fought once in room `a`, so it knows which room it is in. */
  const primed = (profile = BOT_PROFILES.careful) => {
    const b = bot(profile);
    b.build(fight({}), 0, 400);
    return b;
  };

  it('pulses SWAP_WEAPON, and not FIRE, when the gun cannot pay for a pull', () => {
    const cmd = primed().build(fight({ energy: cost - 1 }), 0, 501);
    expect(cmd.buttons & Button.SWAP_WEAPON).toBe(Button.SWAP_WEAPON);
    expect(cmd.buttons & Button.FIRE).toBe(0);
  });

  it('keeps the gun while one pull is still affordable — the boundary', () => {
    const cmd = primed().build(fight({ energy: cost }), 0, 501);
    expect(cmd.buttons & Button.SWAP_WEAPON).toBe(0);
    expect(cmd.buttons & Button.FIRE).toBe(Button.FIRE);
  });

  it('does not holster in a quiet room — there is nothing to swing at', () => {
    const cmd = primed().build(fight({ energy: 0, enemies: [] }), 0, 501);
    expect(cmd.buttons & Button.SWAP_WEAPON).toBe(0);
  });

  it('never pulses on two consecutive ticks, which the engine would read as one held press', () => {
    const b = primed();
    expect(b.build(fight({ energy: 0 }), 0, 501).buttons & Button.SWAP_WEAPON).toBe(Button.SWAP_WEAPON);
    expect(b.build(fight({ energy: 0 }), 0, 502).buttons & Button.SWAP_WEAPON).toBe(0);
    expect(b.build(fight({ energy: 0 }), 0, 503).buttons & Button.SWAP_WEAPON).toBe(Button.SWAP_WEAPON);
  });

  it("swings the blade from the blade's own reach, not from the gun's standoff", () => {
    // Blade in hand, 6 grid from the mob: far outside any blade's arc, so it closes and holds fire.
    const cmd = primed().build(fight({ held: [blade, 'blaster'], energy: 0 }), 0, 501);
    expect(cmd.buttons & Button.FIRE).toBe(0);
    expect(dir(cmd.moveBrad).y).toBeGreaterThan(0.9);
    // Adjacent: it swings.
    const close = primed().build(fight({ held: [blade, 'blaster'], energy: 0, playerAt: [5, 7.5] }), 0, 501);
    expect(close.buttons & Button.FIRE).toBe(Button.FIRE);
  });

  it('re-spaces for the blade even with swapsWeapons off — the two flags are independent', () => {
    const bladeOnly = { ...BOT_PROFILES.careful, swapsWeapons: false };
    const cmd = primed(bladeOnly).build(fight({ held: [blade, 'blaster'], energy: 0 }), 0, 501);
    expect(cmd.buttons & Button.FIRE).toBe(0);
    expect(dir(cmd.moveBrad).y).toBeGreaterThan(0.9);
  });

  it('re-draws the gun at half a bar, and not a tick before', () => {
    const below = primed().build(fight({ held: [blade, 'blaster'], energy: 49 }), 0, 501);
    expect(below.buttons & Button.SWAP_WEAPON).toBe(0);
    const at = primed().build(fight({ held: [blade, 'blaster'], energy: 50 }), 0, 501);
    expect(at.buttons & Button.SWAP_WEAPON).toBe(Button.SWAP_WEAPON);
  });

  it('re-draws in a quiet room too, so the next room opens with the gun', () => {
    const cmd = primed().build(fight({ held: [blade, 'blaster'], energy: 100, enemies: [] }), 0, 501);
    expect(cmd.buttons & Button.SWAP_WEAPON).toBe(Button.SWAP_WEAPON);
  });

  it('with meleeWhenDry off, stays disarmed on the gun: the pre-2026-09-29 bot exactly', () => {
    const off = { ...BOT_PROFILES.careful, meleeWhenDry: false };
    const cmd = primed(off).build(fight({ energy: 0 }), 0, 501);
    expect(cmd.buttons & Button.SWAP_WEAPON).toBe(0);
    expect(cmd.buttons & Button.FIRE).toBe(Button.FIRE);
  });

  it('does nothing without a blade to swap to', () => {
    const cmd = primed().build(fight({ held: ['blaster'], energy: 0 }), 0, 501);
    expect(cmd.buttons & Button.SWAP_WEAPON).toBe(0);
  });
});
