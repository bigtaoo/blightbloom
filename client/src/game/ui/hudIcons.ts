import type { Graphics } from 'pixi.js';

/**
 * Vector glyphs for the in-run HUD (design/10 widget kit). The HUD used to spell its
 * state out as one monospace run-on line ("Floor 1/3   Room 1/2   Enemies 1 …"), which
 * read as debug output rather than UI; every stat is now an icon-led chip and these are
 * the icons. Drawn with `Graphics` rather than shipped as art so a chip can be tinted
 * per stat and stays crisp at any DPR — the same reason `Pickup`/`Minimap` draw
 * their own silhouettes.
 *
 * Each glyph is drawn inside the box (cx±r, cy±r) and MUST stay inside it — `StatChip`
 * lays out around that box without measuring. Silhouettes deliberately echo the things
 * they stand for elsewhere on screen (the crystal matches a material pickup, the buff
 * chevron-in-a-diamond matches `Pickup`'s buff shape), so the chip and the world object
 * read as the same thing.
 */
export type HudIconId =
  | 'floor'
  | 'room'
  | 'enemies'
  | 'banked'
  | 'coins'
  | 'score'
  | 'buffs'
  | 'alive'
  | 'stage'
  | 'ally';

/** Punched-out detail (skull eye sockets) — matches the HUD panel's own fill so the
 *  hole reads as a hole over whatever the world happens to be behind the panel. */
const HOLE = 0x0b0e14;

function starPoints(cx: number, cy: number, outer: number, inner: number): number[] {
  const pts: number[] = [];
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 === 0 ? outer : inner;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    pts.push(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad);
  }
  return pts;
}

export function drawHudIcon(g: Graphics, icon: HudIconId, cx: number, cy: number, r: number, color: number): void {
  switch (icon) {
    case 'floor': {
      // Three stacked slabs, widening downward — "how deep you are".
      for (let i = 0; i < 3; i++) {
        const w = r * (0.55 + i * 0.22);
        const y = cy - r * 0.9 + i * r * 0.7;
        g.roundRect(cx - w, y, w * 2, r * 0.42, 1).fill({ color, alpha: 0.55 + i * 0.22 });
      }
      break;
    }
    case 'room': {
      // A room outline with a "you are here" dot — the room within the floor.
      g.roundRect(cx - r, cy - r, r * 2, r * 2, 2).stroke({ color, width: 1.5, alpha: 0.9 });
      g.circle(cx, cy, r * 0.3).fill({ color });
      break;
    }
    case 'enemies': {
      // A single-eyed crystal critter head — the same red as the enemy faction tint
      // (THEME.colors.enemy), and the same silhouette the world actually spawns.
      //
      // This was a SKULL until 2026-08-25, when `game/elementIcons.ts` landed the icon
      // half of design/13's locked dual-channel element law — and that law names the
      // skull as POISON's glyph. Two different meanings for one silhouette on one screen
      // is exactly the class of collision this project has been bitten by before (the
      // pale-disc-with-a-dark-centre that read as an eye), so the skull went to the
      // locked rule and this chip took the shape it should arguably always have had:
      // design/13 describes enemies as "living crystal, single glowing eye", and nothing
      // in this world has a skull — which is why a skull reads as "toxic" and not as
      // "a mob" here in the first place.
      g.poly([
        cx, cy - r,
        cx + r * 0.86, cy - r * 0.30,
        cx + r * 0.62, cy + r * 0.78,
        cx - r * 0.62, cy + r * 0.78,
        cx - r * 0.86, cy - r * 0.30,
      ]).fill({ color });
      // The eye: a punched socket with a bright pupil, so the "one eye" read survives
      // even where the body silhouette is small enough to be a blob.
      g.circle(cx, cy - r * 0.06, r * 0.38).fill({ color: HOLE });
      g.circle(cx, cy - r * 0.06, r * 0.20).fill({ color });
      break;
    }
    case 'banked': {
      // Crystal — the same silhouette `Pickup` draws for a material drop.
      g.poly([cx, cy - r, cx + r * 0.72, cy, cx, cy + r, cx - r * 0.72, cy]).fill({ color });
      g.poly([cx, cy - r, cx + r * 0.72, cy, cx, cy]).fill({ color: 0xfffbe6, alpha: 0.45 });
      break;
    }
    case 'coins': {
      // A struck disc with a rim — the same silhouette `Pickup` draws for a coin, which is
      // the whole point of this file: a player who learned the shape on the floor reads the
      // chip for free. Separated from `banked`'s crystal by FORM, since both are warm.
      g.circle(cx, cy, r * 0.92).fill({ color });
      g.circle(cx, cy, r * 0.92).stroke({ color: 0xfff6d5, width: 1, alpha: 0.8 });
      g.circle(cx - r * 0.28, cy - r * 0.28, r * 0.24).fill({ color: 0xfffbe6, alpha: 0.7 });
      break;
    }
    case 'score': {
      g.poly(starPoints(cx, cy, r, r * 0.45)).fill({ color });
      break;
    }
    case 'buffs': {
      // Chevron-in-a-diamond — the same silhouette `Pickup` draws for a run buff.
      g.poly([cx, cy - r, cx + r, cy, cx, cy + r, cx - r, cy]).fill({ color, alpha: 0.35 });
      g.poly([cx - r * 0.6, cy + r * 0.32, cx, cy - r * 0.6, cx + r * 0.6, cy + r * 0.32, cx, cy]).fill({ color });
      break;
    }
    case 'alive': {
      // One standing figure — survivors left in a PvP arena.
      g.circle(cx, cy - r * 0.42, r * 0.38).fill({ color });
      g.roundRect(cx - r * 0.6, cy + r * 0.06, r * 1.2, r * 0.86, r * 0.4).fill({ color });
      break;
    }
    case 'stage': {
      // Closing rings — matches the PvP zone telegraph the Minimap already draws.
      g.circle(cx, cy, r).stroke({ color, width: 1.3, alpha: 0.5 });
      g.circle(cx, cy, r * 0.58).stroke({ color, width: 1.5 });
      g.circle(cx, cy, r * 0.18).fill({ color });
      break;
    }
    case 'ally': {
      // Two figures — the co-op teammate row.
      g.circle(cx - r * 0.38, cy - r * 0.34, r * 0.32).fill({ color });
      g.circle(cx + r * 0.42, cy - r * 0.18, r * 0.26).fill({ color, alpha: 0.7 });
      g.roundRect(cx - r, cy + r * 0.16, r * 2, r * 0.7, r * 0.35).fill({ color, alpha: 0.85 });
      break;
    }
  }
}
