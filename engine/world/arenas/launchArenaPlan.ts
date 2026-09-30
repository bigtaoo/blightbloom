/**
 * THE HAND-AUTHORED PLAN for the launch arena (design/15's "one ~60-room hand-authored map
 * at launch, produced by a dedicated map editor — not a procedural layout").
 *
 * Everything in this file is a decision, written the way it would be drawn on graph paper.
 * `launchArena.ts` assembles it into an `ArenaMap`; `slotGrid.ts` does the arithmetic. The
 * split is deliberate: this file should be readable and arguable by someone who does not
 * care how a wall run is computed, and it should diff line-by-line when the map changes.
 *
 * ## The shape: districts joined by a few arteries
 *
 * Seven districts of 6–14 rooms, laid on one hand-drawn 9x8 slot grid with 12 slots left
 * EMPTY so the map is not a lattice. Column widths and row heights vary, so room footprints
 * range from 9x9 closets to 20x14 halls — a slot's size is a design choice, not a constant.
 *
 * Districts connect only through a short list of ARTERIES (below). That is where the map's
 * decisions live: inside a district you have options, but leaving one is a commitment
 * through a place someone can be waiting. A battle royale needs that — the zone tells you
 * WHERE to go, and the layout is what makes the trip cost something.
 *
 *   terraces   NW   open, long sightlines, thin cover — the exposed district
 *   kilns      N    hazard-heavy, phased spike fields
 *   cisterns   W    colonnades and rings; sightlines broken across, open along
 *   atrium     mid  the hub: biggest halls, richest loot, the usual eye of the zone
 *   barracks   NE/E tight rooms, stubs and chevrons — close quarters
 *   catacombs  S/SE the maze: most rooms, most dead ends, lowest visibility
 *   foundry    SW   dense industrial cover, rubble and stubs
 *
 * ## What the previous map got wrong, and what this plan does about it
 *
 * `arena_prototype_60` was 60 identical 10x10 rooms with `solids: []` everywhere, so it had
 * no walls at all: its rooms and all 71 of its doors were logical-only and an actor walked
 * straight across the map. Here every room's perimeter is real stone and a door is the only
 * hole in it, so the door graph the zone's BFS reasons over is the graph a player actually
 * moves on. Its pillars and loot markers were also authored as ABSOLUTE coordinates where
 * the engine expects room-relative, putting 90 of 120 features off the map; nothing in this
 * plan names an absolute coordinate at all — slots and kits are positioned by the grid.
 */

/** Rows of the slot grid, top to bottom. One character per column:
 *  `T`erraces `K`ilns `C`isterns `A`trium `B`arracks `X` catacombs `F`oundry, `.` empty. */
export const DISTRICT_MAP = [
  'TTT.KKKK.',
  'TTCCK.KBB',
  'TCCAAAKBB',
  '.CCAAABBB',
  'FCCAA.XB.',
  'FFF.XXXXB',
  'FF.XX.XXX',
  '.FFX.XXX.',
] as const;

/** Which interior kit furnishes each slot — same grid, same order as `DISTRICT_MAP`.
 *  `o`pen `4` four pillars `r`ing `c`olonnade `s`tubs `h` chevron `v`ault pen `u` rubble
 *  `S` spike field `l` spike line, `.` empty slot. */
export const KIT_MAP = [
  'co4.SluS.',
  'cur4l.usu',
  '4crovrShs',
  '.4cvovsvh',
  'urcro.hs.',
  'suc.vhusv',
  'us.4l.vs4',
  '.cus.hSv.',
] as const;

/** Column widths, west to east. Deliberately uneven: a district's character comes as much
 *  from its room proportions as from its furniture. */
export const COL_WIDTHS = [14, 10, 16, 9, 20, 9, 16, 10, 13] as const;

/** Row heights, north to south. */
export const ROW_HEIGHTS = [12, 9, 14, 10, 12, 14, 9, 11] as const;

/** Where the grid starts, leaving a margin of stone around the whole map. */
export const GRID_ORIGIN = { x: 2, y: 2 } as const;
export const GRID_MARGIN = 2;

/** A slot reference as written in the door table: row then column. */
export type SlotRef = `r${number}c${number}`;

/**
 * Every door, authored by hand. Intra-district first, then the arteries — the split is
 * meaningful: the arteries are the whole reason the districts are districts, and they are
 * the doors to widen or close when the map plays badly.
 *
 * Doors are the ONLY way between two rooms (design/15: adjacency is never inferred from rect
 * proximity), and here that is physically true as well as logically — two adjacent rooms
 * without a door in this list have two cells of stone between them.
 */
export const INTRA_DISTRICT_DOORS: [SlotRef, SlotRef][] = [
  // terraces — a hook of three along the north edge dropping south; r0c2 is a dead end.
  ['r0c0', 'r0c1'], ['r0c1', 'r0c2'], ['r0c0', 'r1c0'], ['r1c0', 'r1c1'],
  ['r0c1', 'r1c1'], ['r1c0', 'r2c0'],

  // kilns — a north corridor with two southward pockets; r0c7 and r1c4 are dead ends.
  ['r0c4', 'r0c5'], ['r0c5', 'r0c6'], ['r0c6', 'r0c7'], ['r0c4', 'r1c4'],
  ['r0c6', 'r1c6'], ['r1c6', 'r2c6'],

  // cisterns — a 2-wide column, fully connected: the district you can always route through.
  ['r1c2', 'r1c3'], ['r1c2', 'r2c2'], ['r2c1', 'r2c2'], ['r2c1', 'r3c1'],
  ['r2c2', 'r3c2'], ['r3c1', 'r3c2'], ['r3c1', 'r4c1'], ['r3c2', 'r4c2'],
  ['r4c1', 'r4c2'],

  // atrium — deliberately the best-connected district. Whoever holds it can move; the cost
  // is that it is also the easiest place to be found, and the zone usually ends here.
  ['r2c3', 'r2c4'], ['r2c4', 'r2c5'], ['r2c3', 'r3c3'], ['r2c4', 'r3c4'],
  ['r2c5', 'r3c5'], ['r3c3', 'r3c4'], ['r3c4', 'r3c5'], ['r3c3', 'r4c3'],
  ['r3c4', 'r4c4'], ['r4c3', 'r4c4'],

  // barracks — a dense block of small rooms. r5c8 is NOT connected to it: see the arteries.
  ['r1c7', 'r1c8'], ['r1c7', 'r2c7'], ['r1c8', 'r2c8'], ['r2c7', 'r2c8'],
  ['r2c7', 'r3c7'], ['r2c8', 'r3c8'], ['r3c6', 'r3c7'], ['r3c7', 'r3c8'],
  ['r3c7', 'r4c7'],

  // catacombs — the maze. Sparse on purpose: four dead ends, no room with more than three
  // doors, and the only way across it is through r5c6 or r6c6.
  ['r4c6', 'r5c6'], ['r5c4', 'r5c5'], ['r5c5', 'r5c6'], ['r5c6', 'r5c7'],
  ['r5c4', 'r6c4'], ['r6c3', 'r6c4'], ['r6c3', 'r7c3'], ['r5c6', 'r6c6'],
  ['r6c6', 'r6c7'], ['r6c7', 'r6c8'], ['r6c6', 'r7c6'], ['r7c5', 'r7c6'],
  ['r7c6', 'r7c7'], ['r6c7', 'r7c7'],

  // foundry — a compact ring with a tail; the safest district to hold, and a corner.
  ['r4c0', 'r5c0'], ['r5c0', 'r5c1'], ['r5c1', 'r5c2'], ['r5c0', 'r6c0'],
  ['r5c1', 'r6c1'], ['r6c0', 'r6c1'], ['r6c1', 'r7c1'], ['r7c1', 'r7c2'],
];

/**
 * The arteries. Wider passages (see `ARTERY_DOOR_SPAN`) and few enough to name: this list
 * IS the map's strategic shape, and `npm run audit:arena`'s chokepoint list should mostly be
 * the rooms on either end of it.
 */
export const ARTERY_DOORS: [SlotRef, SlotRef][] = [
  ['r2c0', 'r2c1'], // terraces  -> cisterns (south link)
  ['r1c1', 'r1c2'], // terraces  -> cisterns (north link)
  ['r2c6', 'r2c5'], // kilns     -> atrium
  ['r1c6', 'r1c7'], // kilns     -> barracks
  ['r2c2', 'r2c3'], // cisterns  -> atrium
  ['r4c1', 'r5c1'], // cisterns  -> foundry
  ['r4c4', 'r5c4'], // atrium    -> catacombs
  ['r3c5', 'r3c6'], // atrium    -> barracks
  ['r7c2', 'r7c3'], // foundry   -> catacombs
  ['r4c7', 'r5c7'], // barracks  -> catacombs
  ['r5c7', 'r5c8'], // catacombs -> the barracks outpost, which the barracks cannot reach
  ['r6c8', 'r5c8'], // catacombs -> the outpost's second way in
];

/** Ordinary doors are this many cells wide; arteries are wider, so a fight in one is a real
 *  fight rather than a queue. */
export const DOOR_SPAN = 3;
export const ARTERY_DOOR_SPAN = 5;

/**
 * The eight drop points, one per outer-district corner of the map, chosen so no two start
 * within a short walk of each other and none starts in the atrium (design/15: spawns are
 * system-assigned with no player choice, so an unfair one cannot be opted out of).
 */
export const SPAWN_SLOTS: SlotRef[] = [
  'r0c0', // terraces, NW
  'r0c5', // kilns, N
  'r1c8', // barracks, NE
  'r4c7', // barracks, E
  'r7c7', // catacombs, SE — deep in the maze, not on the outpost's doorstep
  'r5c4', // catacombs, S — its west end, not the maze's dead ends
  'r7c1', // foundry, SW
  'r3c1', // cisterns, W
];

/*
 * Why not the obvious eight corners: the first draft dropped two seats in the foundry and two
 * in the south catacombs, and `npm run audit:arena` reported a minimum pairwise separation of
 * TWO door hops — the foundry->catacombs artery (`r7c2-r7c3`) puts those two "far apart"
 * corners back to back. A drop that can be contested before the zone has moved once is a
 * coin-flip the player never agreed to (design/15: spawns are system-assigned, no opt-out),
 * so the two southern seats moved off the artery and one moved to the cisterns. Nothing about
 * that is visible on the map drawing; it only shows up in hops.
 */

/**
 * Candidate final rooms for the zone. The atrium carries most of the weight — a match that
 * usually ends in the biggest, richest, most-connected district is the readable default —
 * but every outer district holds one low-weight candidate so the shrink is not a solved
 * problem on match one.
 */
export const EYE_SLOTS: { slot: SlotRef; weight: number }[] = [
  { slot: 'r2c4', weight: 4 },
  { slot: 'r3c4', weight: 4 },
  { slot: 'r3c3', weight: 3 },
  { slot: 'r3c5', weight: 3 },
  { slot: 'r2c3', weight: 2 },
  { slot: 'r2c5', weight: 2 },
  { slot: 'r4c3', weight: 2 },
  { slot: 'r4c4', weight: 2 },
  { slot: 'r1c0', weight: 1 }, // terraces
  { slot: 'r0c5', weight: 1 }, // kilns
  { slot: 'r3c1', weight: 1 }, // cisterns
  { slot: 'r2c7', weight: 1 }, // barracks
  { slot: 'r6c6', weight: 1 }, // catacombs
  { slot: 'r5c1', weight: 1 }, // foundry
];

export interface DistrictProfile {
  name: string;
  /** Which arena drop table this district's markers name. `LootMarker.tableId` is carried
   *  but not yet differentiated (content/arenas.ts) — authoring it truthfully now means the
   *  real per-table catalog, when it lands, does not need a second pass over the map. */
  loot: string;
  /** A vault-kit room in this district gets this table instead, and a second marker. */
  vaultLoot: string;
  /** The district's AI flavour, drawn from PvE's ENEMY_BLUEPRINTS verbatim (design/15). */
  enemies: string[];
  /** Roughly what share of the district's rooms carry an encounter, 0..1. Applied to the
   *  district's rooms in authored order — no PRNG anywhere in this map. */
  encounterShare: number;
}

export const DISTRICTS: Record<string, DistrictProfile> = {
  T: { name: 'terraces', loot: 'arena_common', vaultLoot: 'arena_rich', enemies: ['basic', 'floater'], encounterShare: 0.5 },
  K: { name: 'kilns', loot: 'arena_common', vaultLoot: 'arena_rich', enemies: ['emberling'], encounterShare: 0.6 },
  C: { name: 'cisterns', loot: 'arena_common', vaultLoot: 'arena_rich', enemies: ['frostling', 'basic'], encounterShare: 0.5 },
  A: { name: 'atrium', loot: 'arena_rich', vaultLoot: 'arena_vault', enemies: ['ironclad', 'brute'], encounterShare: 0.75 },
  B: { name: 'barracks', loot: 'arena_common', vaultLoot: 'arena_rich', enemies: ['basic', 'ironclad'], encounterShare: 0.55 },
  X: { name: 'catacombs', loot: 'arena_common', vaultLoot: 'arena_vault', enemies: ['galvanist', 'floater'], encounterShare: 0.4 },
  F: { name: 'foundry', loot: 'arena_common', vaultLoot: 'arena_rich', enemies: ['ironclad', 'brute'], encounterShare: 0.5 },
};
