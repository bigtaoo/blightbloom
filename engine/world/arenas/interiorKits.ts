/**
 * The hand-authored interior kit library for the launch arena — the "furniture" half of
 * `launchArena.ts`, kept separate per CLAUDE.md's 500-line convention (form (1): a table of
 * independent functions with no shared state).
 *
 * Each kit is a hand-designed cover pattern, written as a function of the room's INNER size
 * so one pattern reads correctly in a 9x9 closet and a 22x15 hall. That is deliberate, and
 * it is the difference between this and the map it replaces: the previous arena stamped ONE
 * arrangement into 60 identical rooms, so no room ever asked a different question. Here the
 * author picks a kit per room, and the kits themselves disagree about what a fight in them
 * should look like — a long-sightline colonnade plays nothing like a chevron you cannot
 * shoot across.
 *
 * Every coordinate returned is ROOM-RELATIVE, which is the convention `roomGeometry`,
 * `buildArenaCellTraits`, `SpawnSystem` and `arenaGeometryMetrics` all share (only
 * `ArenaRoom.rectGrid` is absolute). The previous map got this wrong for its pillars and
 * loot markers and put 90 of 120 features off the map; kits taking the room's size rather
 * than its position makes writing an absolute coordinate here structurally awkward.
 */
import type { AabbGrid, PillarGrid } from '../../content/rooms';
import type { CellTrait } from '../../content/arenas';

export interface Interior {
  solids: AabbGrid[];
  pillars: PillarGrid[];
  cellTraits: CellTrait[];
}

/** The room's walkable interior, i.e. inside the 1-cell perimeter ring. */
export interface Inner {
  /** First walkable cell. */
  x0: number;
  y0: number;
  /** Last walkable cell. */
  x1: number;
  y1: number;
  w: number;
  h: number;
}

export function innerOf(size: { w: number; h: number }): Inner {
  return { x0: 1, y0: 1, x1: size.w - 2, y1: size.h - 2, w: size.w - 2, h: size.h - 2 };
}

/** A kit takes the room's inner extent and a stable per-room id (used only to vary which
 *  side an asymmetric pattern faces — never to randomize anything at match time). */
export type Kit = (inner: Inner, variant: number) => Interior;

const empty = (): Interior => ({ solids: [], pillars: [], cellTraits: [] });

/** Fractional position along an axis, snapped to a cell. */
function at(lo: number, len: number, frac: number): number {
  return lo + Math.max(0, Math.min(len - 1, Math.round((len - 1) * frac)));
}

function spike(id: string, x: number, y: number, w = 1, h = 1): CellTrait {
  return { id, rectGrid: { x, y, w, h }, kind: 'spike', timed: false, damage: 2, damageType: 'physical' };
}

/** A phased spike field: safe half the time, so it gates a route without closing it. */
function pulseSpike(id: string, x: number, y: number, w: number, h: number, offset: number): CellTrait {
  return {
    id,
    rectGrid: { x, y, w, h },
    kind: 'spike',
    timed: true,
    phase: { armTicks: 90, activeTicks: 60, offsetTicks: offset },
    damage: 3,
    damageType: 'physical',
  };
}

/** Nothing at all. Reserved for arteries and the halls a fight needs room to breathe in —
 *  used sparingly, because "no cover" is the state the whole previous map was in. */
export const openHall: Kit = () => empty();

/** Four pillars at the quarter points: the generic "there is something to hide behind". */
export const fourPillars: Kit = (inner) => ({
  solids: [],
  pillars: [0.25, 0.75].flatMap((fx) =>
    [0.25, 0.75].map((fy) => ({
      center: { x: at(inner.x0, inner.w, fx), y: at(inner.y0, inner.h, fy) },
      radius: 1,
    })),
  ),
  cellTraits: [],
});

/** A ring of six around an open centre — a room you circle rather than cross. */
export const pillarRing: Kit = (inner) => ({
  solids: [],
  pillars: [
    [0.5, 0.12],
    [0.88, 0.32],
    [0.88, 0.68],
    [0.5, 0.88],
    [0.12, 0.68],
    [0.12, 0.32],
  ].map(([fx, fy]) => ({
    // Kept a body's width off the walls: rounded flush against one, a disc closes the corner
    // behind it (`atrium_r4c3`'s north door opened into a sealed corner until 2026-09-30).
    center: {
      x: Math.max(inner.x0 + 2, Math.min(inner.x1, at(inner.x0, inner.w, fx!))),
      y: Math.max(inner.y0 + 2, Math.min(inner.y1, at(inner.y0, inner.h, fy!))),
    },
    radius: 1,
  })),
  cellTraits: [],
});

/** Two colonnades running along the long axis: sightlines stay long ALONG the room and are
 *  broken across it. The kit that makes a room's orientation matter. */
export const colonnade: Kit = (inner) => {
  const alongX = inner.w >= inner.h;
  const pillars: PillarGrid[] = [];
  const count = Math.max(3, Math.floor((alongX ? inner.w : inner.h) / 4));
  for (let i = 0; i < count; i++) {
    const frac = (i + 0.5) / count;
    for (const cross of [0.28, 0.72]) {
      pillars.push({
        center: alongX
          ? { x: at(inner.x0, inner.w, frac), y: at(inner.y0, inner.h, cross) }
          : { x: at(inner.x0, inner.w, cross), y: at(inner.y0, inner.h, frac) },
        radius: 1,
      });
    }
  }
  return { solids: [], pillars, cellTraits: [] };
};

/** Stubs reaching in from the middle of each wall — every entrance is a corner you have to
 *  clear, and the room's centre stays open for the fight. */
export const crossStubs: Kit = (inner) => {
  const depthX = Math.max(2, Math.floor(inner.w / 4));
  const depthY = Math.max(2, Math.floor(inner.h / 4));
  const midX = at(inner.x0, inner.w, 0.5);
  const midY = at(inner.y0, inner.h, 0.5);
  return {
    solids: [
      { x: midX, y: inner.y0, w: 1, h: depthY },
      { x: midX, y: inner.y1 - depthY + 1, w: 1, h: depthY },
      { x: inner.x0, y: midY, w: depthX, h: 1 },
      { x: inner.x1 - depthX + 1, y: midY, w: depthX, h: 1 },
    ],
    pillars: [],
    cellTraits: [],
  };
};

/** Two offset wall runs forcing an S-shaped path: nothing can be shot straight through, and
 *  a defender always has one side they cannot see. `variant` mirrors it. */
export const chevron: Kit = (inner, variant) => {
  const flip = variant % 2 === 1;
  const len = Math.max(3, Math.floor(inner.w * 0.6));
  // The lane between the runs is three rows where the room has them. One row, less the lower
  // run's north brim, is narrower than a body, and every short room built with this kit came
  // out sealed in two. Two rows are walkable but not visible: the lower run's 70 px face is
  // drawn over the 64 px lane, so the lane reads as one wall. Three rows leave 26 px of floor
  // in view. A 9-row room has no third row to give, so none is furnished with this kit.
  // No pillar either: it stood in that lane in every room it was used in (until 2026-09-30).
  const top = at(inner.y0, inner.h, 0.32);
  const bottom = Math.min(inner.y1 - 1, Math.max(at(inner.y0, inner.h, 0.68), top + 4));
  const leftX = inner.x0;
  const rightX = inner.x1 - len + 1;
  return {
    solids: [
      { x: flip ? rightX : leftX, y: top, w: len, h: 1 },
      { x: flip ? leftX : rightX, y: bottom, w: len, h: 1 },
    ],
    pillars: [],
    cellTraits: [],
  };
};

/** A three-walled inner pen: whatever is inside it is worth taking, and taking it means
 *  committing to one entrance with your back to a wall. */
export const vaultPen: Kit = (inner, variant) => {
  const w = Math.max(3, Math.floor(inner.w * 0.4));
  const h = Math.max(3, Math.floor(inner.h * 0.4));
  const x = at(inner.x0, inner.w, 0.5) - Math.floor(w / 2);
  const y = at(inner.y0, inner.h, 0.5) - Math.floor(h / 2);
  const openSouth = variant % 2 === 0;
  return {
    solids: [
      { x, y, w, h: 1 },
      { x, y: y + 1, w: 1, h: h - 2 },
      { x: x + w - 1, y: y + 1, w: 1, h: h - 2 },
      // The fourth side is the way in; the opposite wall closes when `variant` flips, so
      // two pens in the same district are not entered from the same direction.
      ...(openSouth ? [] : [{ x, y: y + h - 1, w, h: 1 }]),
    ],
    pillars: [],
    cellTraits: [],
  };
};

/** Scattered small blocks — the messiest kit, and the one that reads as a real place rather
 *  than a diagram. Placement is a fixed hand-written pattern, cycled by `variant`. */
export const rubble: Kit = (inner, variant) => {
  const pattern: [number, number, number, number][][] = [
    [
      [0.2, 0.25, 2, 1],
      [0.62, 0.2, 1, 2],
      [0.35, 0.62, 3, 1],
      [0.78, 0.7, 1, 2],
    ],
    [
      [0.15, 0.6, 1, 3],
      [0.45, 0.22, 2, 1],
      [0.7, 0.45, 2, 2],
      [0.3, 0.8, 1, 1],
    ],
    [
      [0.3, 0.3, 1, 2],
      [0.55, 0.55, 2, 1],
      [0.8, 0.25, 1, 1],
      [0.2, 0.75, 2, 2],
    ],
  ];
  const chosen = pattern[variant % pattern.length]!;
  const solids = chosen.map(([fx, fy, w, h]) => ({
    x: Math.min(at(inner.x0, inner.w, fx), inner.x1 - w + 1),
    y: Math.min(at(inner.y0, inner.h, fy), inner.y1 - h + 1),
    w,
    h,
  }));
  // No pillar touching two chunks at once: bridging them, the disc makes one long wall, and in
  // `terraces_r1c1` that wall cut the room in half (until 2026-09-30). Against one chunk it is
  // only a bigger chunk.
  const pillar = { center: { x: at(inner.x0, inner.w, 0.5), y: at(inner.y0, inner.h, 0.42) }, radius: 1 };
  const pressed = solids.filter(
    (s) =>
      s.x <= pillar.center.x + 1 && s.x + s.w >= pillar.center.x - 1 &&
      s.y <= pillar.center.y + 1 && s.y + s.h >= pillar.center.y - 1,
  );
  return { solids, pillars: pressed.length < 2 ? [pillar] : [], cellTraits: [] };
};

/** A hazard floor with cover only at the edges: crossing costs health, going around costs
 *  time, and the zone decides which you can afford. */
export const spikeField: Kit = (inner, variant) => {
  const w = Math.max(2, Math.floor(inner.w * 0.45));
  const h = Math.max(2, Math.floor(inner.h * 0.35));
  const x = at(inner.x0, inner.w, 0.5) - Math.floor(w / 2);
  const y = at(inner.y0, inner.h, 0.5) - Math.floor(h / 2);
  return {
    solids: [],
    pillars: [0.12, 0.88].flatMap((fx) =>
      [0.2, 0.8].map((fy) => ({
        center: { x: at(inner.x0, inner.w, fx), y: at(inner.y0, inner.h, fy) },
        radius: 1,
      })),
    ),
    cellTraits: [pulseSpike(`field_${variant}`, x, y, w, h, (variant % 3) * 50)],
  };
};

/** A narrow always-on hazard across one axis, with a walkable shoulder — the cheapest way to
 *  make a wide artery cost something to run down. */
export const spikeLine: Kit = (inner, variant) => {
  const alongX = inner.w >= inner.h;
  const cut = Math.floor((alongX ? inner.h : inner.w) * 0.55);
  const from = alongX ? inner.y0 : inner.x0;
  return {
    solids: [],
    pillars: [],
    cellTraits: [
      alongX
        ? spike(`line_${variant}`, at(inner.x0, inner.w, 0.5), from, 1, cut)
        : spike(`line_${variant}`, from, at(inner.y0, inner.h, 0.5), cut, 1),
    ],
  };
};

/** Every kit, by the id the authoring table names. */
export const INTERIOR_KITS = {
  open: openHall,
  pillars4: fourPillars,
  ring: pillarRing,
  colonnade,
  stubs: crossStubs,
  chevron,
  vault: vaultPen,
  rubble,
  spikeField,
  spikeLine,
} as const;

export type KitId = keyof typeof INTERIOR_KITS;
