#!/usr/bin/env node
/**
 * Seed deriver for the later PvE chapters (design/gameplay/04-chapters.md) — writes
 * `world/dungeons/<chapter>/` by TRANSFORMING the shipped, hand-tuned chapter-1 JSON under
 * `world/dungeons/ember/`, rather than generating a level from scratch.
 *
 * Why derive instead of re-running `genEmberLevel1.mjs` with new names: that seeder is
 * the level's FIRST pass. Everything chapter 1 learned since — the halved enemy ramp, the
 * three enemy-free side rooms, the branch variants on floor indices 1-3, the ravager ramp,
 * every editor tweak — lives only in the JSON. A transform of the JSON inherits all of it,
 * and the properties chapter 1's tests prove (every door passable, every spawn reachable,
 * the branch skip real) survive it for free, because each transform below preserves
 * distances and adjacency.
 *
 * The transform, per piece and per floor map (`CHAPTERS` holds each chapter's choices):
 *   1. GEOMETRY. Each chapter turns chapter 1 a different way, so no two read alike:
 *      - `transpose` (frost): x <-> y, w <-> h, west <-> north, east <-> south. A floor laid
 *        out left-to-right becomes one laid out top-to-bottom.
 *      - `rotate180` (storm): every piece turned half a circle inside its own box, every
 *        floor turned half a circle inside its bounding box; north <-> south, east <-> west.
 *        A floor that ran left-to-right and downward runs right-to-left and upward.
 *      - `antitranspose` (blight): the mirror across the other diagonal, i.e. a transpose
 *        followed by a half-turn: (x, y) -> (h - y, w - x), w <-> h, west <-> south,
 *        north <-> east. A floor that ran left-to-right and downward runs bottom-to-top and
 *        leftward, the one direction of the four the earlier chapters left unused.
 *   2. ROSTER SWAP (`roster`): chapter 1's fire mobs trade places with the chapter's own
 *      element, so the garrison is led by that element; the boss sentinel becomes the
 *      chapter's own boss instead of a draw from chapter 1's random pool.
 *   3. RENAME: `ember_l1_*` -> `<chapter>_l1_*`, fire-flavoured room names to the chapter's
 *      own (`names`), and the `'ember_l1'` piece tag to `'<chapter>_l1'`.
 *
 * Like `genEmberLevel1.mjs` this is a ONE-SHOT SEEDER, not a build step: once the JSON is
 * committed it is the source of truth and is meant to be tuned in the map editor. Re-running
 * it OVERWRITES those tweaks, so it is deliberately not wired into any npm script.
 * `engine/world/rooms/<chapter>Level1.test.ts` pins that the committed JSON still IS this
 * transform of chapter 1 — delete that block the day the chapter is hand-edited away from it.
 *
 * Usage: node tools/map-editor/scripts/deriveChapter.mjs <frost|storm|blight>
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORLD = join(HERE, '..', '..', '..', 'world', 'dungeons');
const SRC = join(WORLD, 'ember');

/** Each derived chapter's choices. Anything not named in `roster` / `names` passes through. */
export const CHAPTERS = {
  frost: {
    geometry: 'transpose',
    roster: { emberling: 'frostling', frostling: 'emberling', boss_random: 'glacimaw' },
    names: { forge: 'hollow', kiln: 'drift', furnace: 'glacier', crucible: 'cistern', caldera: 'cirque' },
  },
  storm: {
    geometry: 'rotate180',
    roster: { emberling: 'galvanist', galvanist: 'emberling', boss_random: 'voltreaver' },
    names: { forge: 'spire', kiln: 'coil', furnace: 'dynamo', crucible: 'conduit', caldera: 'maelstrom' },
  },
  // Chapter 1 has no poison mob to trade back, so the swap is one-way: every emberling becomes a
  // blightling, and the frostlings and galvanists stay.
  blight: {
    geometry: 'antitranspose',
    roster: { emberling: 'blightling', boss_random: 'rotbloom' },
    names: { forge: 'mire', kiln: 'warren', furnace: 'thicket', crucible: 'sump', caldera: 'canker' },
  },
};

const EDGE = {
  transpose: { west: 'north', north: 'west', east: 'south', south: 'east' },
  rotate180: { west: 'east', east: 'west', north: 'south', south: 'north' },
  antitranspose: { west: 'south', south: 'west', north: 'east', east: 'north' },
};

/**
 * A geometry as point/rect maps over a box of `w` x `h` (a piece's own size, or a floor's
 * bounding box). Points are continuous grid coordinates and rects are cell ranges, so a
 * half-turn maps a point to `w - x` and a rect to `w - x - rw`.
 */
function geometry(kind, w, h) {
  if (kind === 'transpose') {
    return {
      size: { w: h, h: w },
      rect: (r) => ({ ...r, x: r.y, y: r.x, w: r.h, h: r.w }),
      point: (p) => ({ ...p, x: p.y, y: p.x }),
    };
  }
  if (kind === 'rotate180') {
    return {
      size: { w, h },
      rect: (r) => ({ ...r, x: w - r.x - r.w, y: h - r.y - r.h }),
      point: (p) => ({ ...p, x: w - p.x, y: h - p.y }),
    };
  }
  if (kind === 'antitranspose') {
    return {
      size: { w: h, h: w },
      rect: (r) => ({ ...r, x: h - r.y - r.h, y: w - r.x - r.w, w: r.h, h: r.w }),
      point: (p) => ({ ...p, x: h - p.y, y: w - p.x }),
    };
  }
  throw new Error(`deriveChapter: unknown geometry ${kind}`);
}

/** The id and room-name renames for one chapter. */
export function renamer(chapter) {
  const { names } = CHAPTERS[chapter];
  const suffix = (s) => names[s] ?? s;
  return {
    /** `ember_l1_kiln` -> `<chapter>_l1_<name>`; `ember_l1_floor_2` -> `<chapter>_l1_floor_2`. */
    id: (id) => {
      const m = /^ember_l1_(.+)$/.exec(id);
      if (!m) throw new Error(`deriveChapter: unexpected id ${id}`);
      return `${chapter}_l1_${suffix(m[1])}`;
    },
    /** Floor room ids: `r2_kiln` -> `r2_<name>`. */
    room: (id) => id.replace(/^([a-z]\d+_)(.+)$/, (_, p, s) => p + suffix(s)),
  };
}

export function derivePiece(chapter, p) {
  const { geometry: kind, roster } = CHAPTERS[chapter];
  const g = geometry(kind, p.sizeGrid.w, p.sizeGrid.h);
  const out = { ...p, id: renamer(chapter).id(p.id) };
  if (p.tags) out.tags = p.tags.map((t) => (t === 'ember_l1' ? `${chapter}_l1` : t));
  out.sizeGrid = g.size;
  out.solids = p.solids.map(g.rect);
  if (p.pillars) out.pillars = p.pillars.map((c) => ({ ...c, center: g.point(c.center) }));
  out.spawns = {
    player: p.spawns.player.map(g.point),
    enemy: p.spawns.enemy.map((e) => {
      const t = g.point(e);
      if (e.type !== undefined) t.type = roster[e.type] ?? e.type;
      return t;
    }),
  };
  out.exits = p.exits.map((x) => ({ ...x, edge: EDGE[kind][x.edge] }));
  if (p.props) out.props = p.props.map(g.point);
  if (p.chests) out.chests = p.chests.map(g.point);
  if (p.shops) out.shops = p.shops.map(g.point);
  return out;
}

/** `sizeOf(pieceId)` is the SOURCE piece's size: a floor turns inside its bounding box, which
 *  only the pieces it places can tell. */
export function deriveFloor(chapter, f, sizeOf) {
  const { geometry: kind } = CHAPTERS[chapter];
  const rename = renamer(chapter);
  const w = Math.max(...f.rooms.map((r) => r.offsetXGrid + sizeOf(r.pieceId).w));
  const h = Math.max(...f.rooms.map((r) => r.offsetYGrid + sizeOf(r.pieceId).h));
  const g = geometry(kind, w, h);
  return {
    ...f,
    id: rename.id(f.id),
    rooms: f.rooms.map((r) => {
      const size = sizeOf(r.pieceId);
      const box = g.rect({ x: r.offsetXGrid, y: r.offsetYGrid, w: size.w, h: size.h });
      return { ...r, id: rename.room(r.id), pieceId: rename.id(r.pieceId), offsetXGrid: box.x, offsetYGrid: box.y };
    }),
    doors: f.doors.map((d) => ({
      ...d,
      roomA: rename.room(d.roomA),
      roomB: rename.room(d.roomB),
      passageGrid: g.rect(d.passageGrid),
    })),
  };
}

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const writeJson = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2) + '\n');

function main(chapter) {
  if (!CHAPTERS[chapter]) throw new Error(`usage: deriveChapter.mjs <${Object.keys(CHAPTERS).join('|')}>`);
  const out = join(WORLD, chapter);
  mkdirSync(join(out, 'pieces'), { recursive: true });
  const sizes = new Map();
  for (const f of readdirSync(join(SRC, 'pieces'))) {
    const src = readJson(join(SRC, 'pieces', f));
    sizes.set(src.id, src.sizeGrid);
    const piece = derivePiece(chapter, src);
    writeJson(join(out, 'pieces', `${piece.id}.json`), piece);
  }
  for (const f of readdirSync(SRC)) {
    if (!f.endsWith('.json')) continue;
    const floor = deriveFloor(chapter, readJson(join(SRC, f)), (id) => sizes.get(id));
    writeJson(join(out, `${floor.id}.json`), floor);
  }
  console.log(`wrote ${out}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv[2]);
