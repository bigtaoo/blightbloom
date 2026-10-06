#!/usr/bin/env node
/**
 * Seed deriver for chapter 2 ("the Frost descent", design/gameplay/04-chapters.md) —
 * writes `world/dungeons/frost/` by TRANSFORMING the shipped, hand-tuned chapter-1 JSON
 * under `world/dungeons/ember/`, rather than generating a level from scratch.
 *
 * Why derive instead of re-running `genEmberLevel1.mjs` with new names: that seeder is
 * the level's FIRST pass. Everything chapter 1 learned since — the halved enemy ramp, the
 * three enemy-free side rooms, the branch variants on floor indices 1-3, the ravager ramp,
 * every editor tweak — lives only in the JSON. A transform of the JSON inherits all of it,
 * and the properties chapter 1's tests prove (every door passable, every spawn reachable,
 * the branch skip real) survive it for free, because each transform below preserves
 * distances and adjacency.
 *
 * The transform, per piece and per floor map:
 *   1. TRANSPOSE (x <-> y, w <-> h, west <-> north, east <-> south). A floor laid out
 *      left-to-right becomes one laid out top-to-bottom, and every room's interior turns
 *      with it, so the chapter does not read as chapter 1 with a new floor colour.
 *   2. ROSTER SWAP (`ROSTER`): chapter 1's fire mobs become ice mobs and vice versa, so
 *      the chapter's garrison is frost-led; the boss sentinel becomes the chapter's own
 *      boss (`glacimaw`) instead of a draw from chapter 1's random pool.
 *   3. RENAME: `ember_l1_*` -> `frost_l1_*`, fire-flavoured room names to frost ones
 *      (`NAMES`), and the `'ember_l1'` piece tag to `'frost_l1'`.
 *
 * Like `genEmberLevel1.mjs` this is a ONE-SHOT SEEDER, not a build step: once the JSON is
 * committed it is the source of truth and is meant to be tuned in the map editor. Re-running
 * it OVERWRITES those tweaks, so it is deliberately not wired into any npm script.
 * `engine/world/rooms/frostLevel1.test.ts` pins that the committed JSON still IS this
 * transform of chapter 1 — delete that block the day frost is hand-edited away from it.
 *
 * Usage: node tools/map-editor/scripts/deriveChapter.mjs
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORLD = join(HERE, '..', '..', '..', 'world', 'dungeons');
const SRC = join(WORLD, 'ember');
const OUT = join(WORLD, 'frost');

/** Enemy type substitution. Anything not named passes through unchanged. */
export const ROSTER = {
  emberling: 'frostling',
  frostling: 'emberling',
  boss_random: 'glacimaw',
};

/** Room-name substitution, applied to the suffix of every piece id and floor room id. */
export const NAMES = {
  forge: 'hollow',
  kiln: 'drift',
  furnace: 'glacier',
  crucible: 'cistern',
  caldera: 'cirque',
};

const EDGE = { west: 'north', north: 'west', east: 'south', south: 'east' };

const renameSuffix = (s) => NAMES[s] ?? s;
/** `ember_l1_kiln` -> `frost_l1_drift`; `ember_l1_floor_2` -> `frost_l1_floor_2`. */
export const renameId = (id) => {
  const m = /^ember_l1_(.+)$/.exec(id);
  if (!m) throw new Error(`deriveChapter: unexpected id ${id}`);
  return `frost_l1_${renameSuffix(m[1])}`;
};
/** Floor room ids: `r2_kiln` -> `r2_drift`. */
const renameRoom = (id) => id.replace(/^([a-z]\d+_)(.+)$/, (_, p, s) => p + renameSuffix(s));

const tRect = (r) => ({ ...r, x: r.y, y: r.x, w: r.h, h: r.w });
const tPoint = (p) => ({ ...p, x: p.y, y: p.x });

export function derivePiece(p) {
  const out = { ...p, id: renameId(p.id) };
  if (p.tags) out.tags = p.tags.map((t) => (t === 'ember_l1' ? 'frost_l1' : t));
  out.sizeGrid = { w: p.sizeGrid.h, h: p.sizeGrid.w };
  out.solids = p.solids.map(tRect);
  if (p.pillars) out.pillars = p.pillars.map((c) => ({ ...c, center: tPoint(c.center) }));
  out.spawns = {
    player: p.spawns.player.map(tPoint),
    enemy: p.spawns.enemy.map((e) => {
      const t = tPoint(e);
      if (e.type !== undefined) t.type = ROSTER[e.type] ?? e.type;
      return t;
    }),
  };
  out.exits = p.exits.map((x) => ({ ...x, edge: EDGE[x.edge] }));
  if (p.props) out.props = p.props.map(tPoint);
  if (p.chests) out.chests = p.chests.map(tPoint);
  if (p.shops) out.shops = p.shops.map(tPoint);
  return out;
}

export function deriveFloor(f) {
  return {
    ...f,
    id: renameId(f.id),
    rooms: f.rooms.map((r) => ({
      ...r,
      id: renameRoom(r.id),
      pieceId: renameId(r.pieceId),
      offsetXGrid: r.offsetYGrid,
      offsetYGrid: r.offsetXGrid,
    })),
    doors: f.doors.map((d) => ({
      ...d,
      roomA: renameRoom(d.roomA),
      roomB: renameRoom(d.roomB),
      passageGrid: tRect(d.passageGrid),
    })),
  };
}

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const writeJson = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2) + '\n');

function main() {
  mkdirSync(join(OUT, 'pieces'), { recursive: true });
  for (const f of readdirSync(join(SRC, 'pieces'))) {
    const piece = derivePiece(readJson(join(SRC, 'pieces', f)));
    writeJson(join(OUT, 'pieces', `${piece.id}.json`), piece);
  }
  for (const f of readdirSync(SRC)) {
    if (!f.endsWith('.json')) continue;
    const floor = deriveFloor(readJson(join(SRC, f)));
    writeJson(join(OUT, `${floor.id}.json`), floor);
  }
  console.log(`wrote ${OUT}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
