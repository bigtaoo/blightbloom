import { describe, it, expect, vi } from 'vitest';
import { Texture, TextureSource, Graphics, Sprite } from 'pixi.js';
import { WEAPON_SIM_BY_ID } from '@dd/engine';
import { Pickup, type PickupKind } from './Pickup';
import { pipCount } from '../rarityOverlay';
import { elementColor } from '../theme';

// `render/weaponSkins.ts` is mocked here so the "texture exists" branch (the real
// weapon icon) is actually reachable under vitest — without it every Pickup test below
// would only ever exercise the chevron fallback (no art preloaded in a plain-node
// vitest run), same convention as Forge.npc.test.ts's `uiSkins` mock.
// `render/environmentSprites.ts` is mocked for the same reason, and defaults to "nothing
// loaded" so every other test in this file keeps exercising the Graphics fallback.
const mocks = vi.hoisted(() => ({
  blasterTexture: undefined as Texture | undefined,
  dropTextures: {} as Record<string, Texture | undefined>,
  dropKindsAsked: [] as string[],
}));

vi.mock('../../render/weaponSkins', () => ({
  getWeaponTexture: (name: string | undefined) => (name === 'blaster' ? mocks.blasterTexture : undefined),
}));

vi.mock('../../render/environmentSprites', () => ({
  getPickupTexture: (kind: string) => {
    mocks.dropKindsAsked.push(kind);
    return mocks.dropTextures[kind];
  },
}));

// Every kind a Pickup can render (@dd/engine's PickupKind). 'bandage' shares heal's GLOW
// COLOUR on purpose (same "restore" family) but has had its own sprite since 2026-08-20;
// its Graphics fallback is still the crystal shape, which is what these tests exercise
// unless a texture is mocked in.
// The six drawn-only kinds joined 2026-09-26 with the character drop: until then this list held
// the first six and every shape added since (energy onwards) had no render test at all.
const ALL_KINDS: PickupKind[] = [
  'heal', 'material', 'weapon', 'buff', 'crate', 'bandage',
  'energy', 'coin', 'schematic', 'shield', 'emp', 'character',
];

// Children are appended in this fixed order in the constructor — glow first (so the
// crisp shape draws on top of it), then the shape itself. No public API for either
// (same index-by-construction-order convention as TouchControlsView.test.ts).
const enum Child { Glow, Shape }

function glowOf(p: Pickup): Graphics {
  return p.children[Child.Glow] as Graphics;
}
function shapeOf(p: Pickup): Graphics {
  return p.children[Child.Shape] as Graphics;
}

const FRAME_MS = 1000 / 60;

/** The render-only hover height. `Entity.applyTransform` writes `y = groundY - z`, and a
 *  pickup's ground y never moves, so this recovers z without exposing a field for it. */
function zOf(p: Pickup): number {
  return p.curY - p.y;
}

/** Hover heights sampled once per frame over `ms` of wall time, at `dt` per frame. */
function sweep(p: Pickup, ms: number, dt = FRAME_MS): number[] {
  const out: number[] = [];
  for (let t = 0; t < ms; t += dt) {
    p.interpolate(1, dt);
    out.push(zOf(p));
  }
  return out;
}

describe('Pickup — glow ring (design/10 legibility fix, 2026-08-02)', () => {
  it.each(ALL_KINDS)('gives a %s pickup exactly a glow + a crisp shape (2 children)', (kind) => {
    const p = new Pickup(kind);
    expect(p.children.length).toBe(2);
    expect(p.kind).toBe(kind);
  });

  it.each(ALL_KINDS)('blends the %s glow additively, so it never washes out the shape', (kind) => {
    const p = new Pickup(kind);
    expect(glowOf(p).blendMode).toBe('add');
    // The crisp shape must stay a non-additive fill — 'add' on this one would wash it out.
    expect(shapeOf(p).blendMode).not.toBe('add');
  });

  it.each(ALL_KINDS)('draws a %s glow as a ~26px-wide soft circle behind the shape', (kind) => {
    const p = new Pickup(kind);
    const bounds = glowOf(p).getLocalBounds();
    expect(bounds.width).toBeCloseTo(26, 0);
    expect(bounds.height).toBeCloseTo(26, 0);
  });

  it('still gets a soft shadow (Entity.makeShadow), unrelated to the new glow', () => {
    const p = new Pickup('material');
    expect(p.shadow).not.toBeNull();
  });
});

describe('Pickup — ambient hover (strobe fix, 2026-08-15)', () => {
  // The old rate (0.12 rad/ms ≈ 19 Hz) advanced ~2 rad of phase per 60fps frame, right
  // up against the Nyquist limit — it aliased into a refresh-rate-dependent flicker
  // instead of a float. These bounds pin the hover into the same band as the scene's
  // other ambient loops (Portal 0.48 Hz, status aura 1.27 Hz).

  it('advances only a sliver of the arc per 60fps frame (no aliasing)', () => {
    const p = new Pickup('material');
    p.interpolate(1, 0); // settle onto the hover curve first — the very first call also applies the resting height
    const before = zOf(p);
    p.interpolate(1, FRAME_MS);
    // The step is small enough that one frame barely moves the sprite. The previous
    // 2.0 rad/frame swung it across the full amplitude and back every other frame.
    expect(Math.abs(zOf(p) - before)).toBeLessThan(0.5);
  });

  it('completes exactly one hover cycle every 2 seconds', () => {
    const p = new Pickup('material');
    p.interpolate(1, 500); // quarter cycle in → top of the arc (id 0 starts at the midpoint)
    const top = zOf(p);
    p.interpolate(1, 1000); // half a cycle on → bottom of the arc
    expect(top - zOf(p)).toBeGreaterThan(6); // actually travelled, not stalled at rest height
    p.interpolate(1, 1000); // one full period after `top` → same height again
    expect(zOf(p)).toBeCloseTo(top, 5);
  });

  it('gives each drop id a different start phase, so a floor of loot never pulses in unison', () => {
    const a = new Pickup('material', undefined, 1);
    const b = new Pickup('material', undefined, 2);
    a.interpolate(1, FRAME_MS);
    b.interpolate(1, FRAME_MS);
    expect(zOf(a)).not.toBeCloseTo(zOf(b), 1);
  });

  it('is a pure function of the id and the accumulated clock (no Math.random)', () => {
    const a = new Pickup('material', undefined, 7);
    const b = new Pickup('material', undefined, 7);
    a.interpolate(1, 123);
    b.interpolate(1, 60);
    b.interpolate(1, 63); // same total clock, split differently
    expect(zOf(a)).toBeCloseTo(zOf(b), 10);
  });

  it('breathes the glow in phase with the hover, brightest at the top of the arc', () => {
    const p = new Pickup('material');
    p.interpolate(1, 500); // quarter cycle → peak of the sine
    const top = { z: zOf(p), glow: glowOf(p).alpha };
    p.interpolate(1, 1000); // half a cycle later → trough
    expect(top.z).toBeGreaterThan(zOf(p));
    expect(top.glow).toBeGreaterThan(glowOf(p).alpha);
    // Stays a modulation of the existing soft glow, never a hard blink to black.
    expect(glowOf(p).alpha).toBeGreaterThan(0.5);
    // Peaks at exactly 1 — Pixi clamps alpha there, so anything above it would flatten
    // the bright half of the cycle into a plateau instead of a smooth breathe.
    expect(top.glow).toBeCloseTo(1, 5);
  });

  it('never lets the glow clip against Pixi\'s alpha clamp over a full cycle', () => {
    const p = new Pickup('material', undefined, 3);
    let clampedFrames = 0;
    for (let t = 0; t < 2400; t += FRAME_MS) {
      p.interpolate(1, FRAME_MS);
      const a = glowOf(p).alpha;
      expect(a).toBeLessThanOrEqual(1);
      expect(a).toBeGreaterThan(0.5);
      if (a > 0.9999) clampedFrames++;
    }
    // Only the instantaneous peak may touch 1. A whole plateau of clamped frames would
    // mean the breathe is being cut off flat at the top instead of curving through it.
    expect(clampedFrames).toBeLessThan(5);
  });

  it('stays inside a fixed height band and never sinks into the floor', () => {
    const zs = sweep(new Pickup('material', undefined, 5), 4000);
    const lo = Math.min(...zs);
    const hi = Math.max(...zs);
    expect(lo).toBeGreaterThan(0); // still reads as an object hovering above its shadow
    expect(hi - lo).toBeCloseTo(8, 1); // ±4px around rest, the full designed travel
    expect(hi).toBeLessThan(20); // not floating off into the air
  });

  it('leaves the Y-sort key alone, so hovering can never flicker a drop in front of/behind an actor', () => {
    const p = new Pickup('material', undefined, 2);
    p.pushState(100, 250, 0, 0);
    p.snap();
    const seen = new Set<number>();
    for (let t = 0; t < 2400; t += FRAME_MS) {
      p.interpolate(1, FRAME_MS);
      seen.add(p.zIndex);
    }
    // zIndex is the GROUND y (Entity.applyTransform), never the hovering screen y.
    expect([...seen]).toEqual([250]);
  });

  it('runs off wall-clock time, not frame count — 30fps and 144fps agree after the same second', () => {
    const slow = new Pickup('material', undefined, 4);
    const fast = new Pickup('material', undefined, 4);
    sweep(slow, 1000, 1000 / 30);
    sweep(fast, 1000, 1000 / 144);
    expect(zOf(slow)).toBeCloseTo(zOf(fast), 6);
  });

  it('still reads as a smooth arc at 30fps — the worst frame budget is nowhere near aliasing', () => {
    const zs = sweep(new Pickup('material', undefined, 6), 2000, 1000 / 30);
    const biggestStep = zs.slice(1).reduce((m, z, i) => Math.max(m, Math.abs(z - zs[i]!)), 0);
    // A quarter of the 8px travel in one frame would already read as a jump rather than
    // a drift; the old rate moved the full amplitude and back between adjacent frames.
    expect(biggestStep).toBeLessThan(2);
  });

  it.each(ALL_KINDS)('hovers a %s pickup too — no kind is left sitting flat on the floor', (kind) => {
    const zs = sweep(new Pickup(kind, undefined, 1), 2000);
    expect(Math.max(...zs) - Math.min(...zs)).toBeGreaterThan(6);
  });

  it('only bobs the height — the ground position keeps lerping between sim ticks as before', () => {
    const p = new Pickup('material');
    p.pushState(100, 200, 0, 0);
    p.snap();
    p.pushState(300, 400, 0, 0); // one sim tick of travel (a vacuumed drop being pulled in)
    p.interpolate(0.5, FRAME_MS);
    expect(p.x).toBeCloseTo(200, 5); // halfway, untouched by the hover
    expect(p.zIndex).toBeCloseTo(300, 5); // Y-sort follows the interpolated ground y
    const groundY = 300;
    expect(groundY - p.y).toBeGreaterThan(0); // ...while the height does its own thing on top
  });

  it('drifts the shadow with the hover instead of strobing it', () => {
    const p = new Pickup('material');
    p.interpolate(1, 500); // top of the arc
    const top = { scale: p.shadow!.scale.x, alpha: p.shadow!.alpha };
    p.interpolate(1, 1000); // bottom of the arc
    // Higher lift → smaller, fainter shadow (Entity.applyTransform), so the shadow is the
    // second surface the bob shows up on — it strobed right along with the sprite before.
    expect(top.scale).toBeLessThan(p.shadow!.scale.x);
    expect(top.alpha).toBeLessThan(p.shadow!.alpha);
    // ...but gently: a whole half-cycle only moves it by a fraction of its size. Bound
    // widened from 0.1 on 2026-08-18, when SHADOW_LIFT_FALLOFF went 0.012 -> 0.022 so that
    // an ACTOR's 4-7 px hover produces a visible response at all (at 0.012 it was k = 0.95,
    // i.e. nothing). Still a slow breathe, not the ~19 Hz strobe this test was written for.
    expect(Math.abs(top.scale - p.shadow!.scale.x)).toBeLessThan(0.2);
  });
});

describe('Pickup — the breathing glow is the halo, not the item art', () => {
  it('modulates only the additive glow, leaving the weapon icon at full opacity', () => {
    mocks.blasterTexture = new Texture({ source: new TextureSource({ width: 8, height: 8 }) });
    try {
      const p = new Pickup('weapon', 'blaster', 1);
      const icon = p.children[1] as Sprite;
      p.interpolate(1, 1500); // trough of the breathe — the glow is at its dimmest here
      expect(glowOf(p).alpha).toBeLessThan(1);
      // A dimming pass that caught the icon (or the crisp shape) would read as the whole
      // item fading in and out, which is the flicker this change set out to remove.
      expect(icon.alpha).toBe(1);
      expect((p.children[2] as Graphics).alpha).toBe(1);
    } finally {
      mocks.blasterTexture = undefined;
    }
  });

  it.each(ALL_KINDS)('leaves a %s pickup\'s crisp shape at full opacity while the glow breathes', (kind) => {
    const p = new Pickup(kind, undefined, 2);
    p.interpolate(1, 1500);
    expect(shapeOf(p).alpha).toBe(1);
    expect(glowOf(p).alpha).toBeLessThan(1);
  });
});

describe('Pickup — real weapon icon on the ground (design/03)', () => {
  it('falls back to the double-chevron shape when no texture is resolvable (unknown/unset weaponId)', () => {
    const p = new Pickup('weapon', 'not_a_real_weapon');
    expect(p.children.length).toBe(2); // glow + chevron, no sprite
    expect(shapeOf(p).getLocalBounds().width).toBeGreaterThan(0); // chevron actually drew something
  });

  it('draws the real weapon sprite in place of the chevron once a texture resolves', () => {
    mocks.blasterTexture = new Texture({ source: new TextureSource({ width: 8, height: 8 }) });
    try {
      const p = new Pickup('weapon', 'blaster');
      // Identified by TYPE, not by child index/count: a weapon drop also carries the
      // rarity/element overlays (2026-08-25), and a raw count assertion here would have to be
      // renumbered every time the drop gains a layer — which is how an assertion quietly stops
      // covering the claim it was written for.
      const icon = p.children.find((c): c is Sprite => c instanceof Sprite);
      expect(icon).toBeDefined();
      expect(icon!.texture).toBe(mocks.blasterTexture);
      // The displaced chevron. `shapeOf` can't be used here — it indexes child 1, which in the
      // with-texture case is the Sprite. Construction order for a weapon drop WITH art is
      // glow, icon, chevron, then the rarity/element overlays (both of which draw something
      // for a non-common weapon, so "the empty Graphics" isn't a unique handle either —
      // `blaster` is common, so its rarity marks are legitimately empty too).
      const chevron = p.children[2] as Graphics;
      expect(chevron.getLocalBounds().width).toBe(0); // chevron never drew — icon took its place
    } finally {
      mocks.blasterTexture = undefined; // don't leak into later tests
    }
  });
});

describe('Pickup — real drop art (2026-08-20)', () => {
  /** A texture with a deliberately non-square, non-18 source, so a scale assertion cannot
   *  pass by accident: every shipped drop file has its own aspect (the crystal is 116x192,
   *  the bandage 192x100) and `Pickup` is supposed to honour it. */
  function tex(width: number, height: number): Texture {
    return new Texture({ source: new TextureSource({ width, height }) });
  }

  function withArt<T>(entries: Record<string, Texture>, run: () => T): T {
    mocks.dropTextures = entries;
    mocks.dropKindsAsked = [];
    try {
      return run();
    } finally {
      mocks.dropTextures = {};
    }
  }

  it.each(['heal', 'material', 'buff', 'crate', 'bandage'] as const)(
    'mounts the %s sprite in place of its Graphics silhouette',
    (kind) => {
      withArt({ [kind]: tex(116, 192) }, () => {
        const p = new Pickup(kind, undefined, 3);
        expect(p.children.length).toBe(3); // glow + sprite + the (now-empty) fallback Graphics
        const sprite = p.children[1] as Sprite;
        expect(sprite.texture).toBe(mocks.dropTextures[kind]);
        // The fallback must not ALSO draw: two silhouettes stacked is the bug this shape of
        // if/else exists to prevent (see the weapon branch's own version of this check).
        expect((p.children[2] as Graphics).getLocalBounds().width).toBe(0);
      });
    },
  );

  it('scales a drop by its LONG axis and keeps the art aspect', () => {
    withArt({ material: tex(116, 192) }, () => {
      const sprite = new Pickup('material', undefined, 0).children[1] as Sprite;
      // 18 px on the long axis (ART_LONG_AXIS), and the short one follows from the art.
      expect(Math.max(sprite.width, sprite.height)).toBeCloseTo(18, 4);
      expect(sprite.width / sprite.height).toBeCloseTo(116 / 192, 4);
    });
  });

  it('scales a WIDE drop by its width, not by a fixed box', () => {
    // Fitting both axes into a square box (what the weapon icon does, because a weapon has
    // to fit a HUD chip too) would shrink the bandage's 192x100 to 18x9.4 either way — but
    // a `Math.min` over both axes would give a 9.4-tall crystal as well. Pinning the wide
    // case separately is what tells the two rules apart.
    withArt({ bandage: tex(192, 100) }, () => {
      const sprite = new Pickup('bandage', undefined, 0).children[1] as Sprite;
      expect(sprite.width).toBeCloseTo(18, 4);
      expect(sprite.height).toBeCloseTo(18 * (100 / 192), 4);
    });
  });

  it('centres a drop on its hover point', () => {
    // A drop bobs on `z` around a fixed ground point; a top-left or bottom anchor would make
    // the whole object swing instead of hovering in place.
    withArt({ heal: tex(136, 192) }, () => {
      const sprite = new Pickup('heal', undefined, 0).children[1] as Sprite;
      expect(sprite.anchor.x).toBe(0.5);
      expect(sprite.anchor.y).toBe(0.5);
    });
  });

  it('never asks for drop art for a WEAPON drop', () => {
    // A weapon drop draws that weapon's own business-end art, so a `pickup_weapon.png` must
    // never become the thing that shadows it — not even if someone adds the file later.
    withArt({}, () => {
      new Pickup('weapon', 'blaster');
      expect(mocks.dropKindsAsked).not.toContain('weapon');
    });
  });

  it('still draws the fallback silhouette when the art has not loaded', () => {
    // The standing rule: art never blocks gameplay (design/02/12). Every OTHER test in this
    // file runs in exactly this state, which is why the two paths are asserted separately.
    withArt({}, () => {
      const p = new Pickup('material', undefined, 0);
      expect(p.children.length).toBe(2); // glow + the Graphics silhouette, no sprite
      expect((p.children[1] as Graphics).getLocalBounds().width).toBeGreaterThan(0);
    });
  });

  it('keeps every drop inside the glow that gives it its pop', () => {
    // ART_LONG_AXIS is chosen against GLOW_RADIUS: art wider than the additive glow behind it
    // reads as an object with a smudge on it rather than as a glowing object.
    withArt({ buff: tex(192, 192) }, () => {
      const p = new Pickup('buff', undefined, 0);
      const sprite = p.children[1] as Sprite;
      expect(Math.max(sprite.width, sprite.height)).toBeLessThanOrEqual(glowOf(p).getLocalBounds().width);
    });
  });
});

describe('Pickup — the glow is a ramp, not a plate (2026-08-20)', () => {
  interface Instr {
    action: string;
    data: {
      style?: { alpha: number; width: number; color: number };
      path?: { instructions: Array<{ action: string; data: unknown[] }> };
    };
  }

  /** The glow's stroked annuli, as `{ alpha, width, radius }` in draw order — read off Pixi's
   *  retained instruction list, which is the only place the ramp actually exists (bounds and
   *  the container's own alpha are identical for a flat disc and for a falloff). */
  function bands(p: Pickup): Array<{ alpha: number; width: number; radius: number }> {
    const out: Array<{ alpha: number; width: number; radius: number }> = [];
    for (const i of (glowOf(p).context.instructions as unknown as Instr[])) {
      if (i.action !== 'stroke') continue;
      for (const pi of i.data.path?.instructions ?? []) {
        if (pi.action !== 'circle') continue;
        const d = pi.data as number[];
        out.push({ alpha: i.data.style!.alpha, width: i.data.style!.width, radius: d[2]! });
      }
    }
    return out;
  }

  it.each(ALL_KINDS)("fades a %s drop's glow outward instead of filling a disc", (kind) => {
    // The live defect this replaced: one flat additive circle at a single alpha reads as a
    // coloured token plate the art is standing on. A test on bounds or on the container's
    // alpha cannot tell the two apart, which is why this reads the ramp itself.
    const b = bands(new Pickup(kind, undefined, 0));
    expect(b.length).toBeGreaterThan(4);
    for (let i = 1; i < b.length; i++) expect(b[i]!.alpha).toBeLessThan(b[i - 1]!.alpha);
    expect(b[0]!.alpha).toBeLessThanOrEqual(0.34); // never brighter than the old peak
    expect(b[b.length - 1]!.alpha).toBeLessThan(0.02); // reaches nothing at the rim
  });

  it('steps by less than the eye can see, and covers the disc with no gaps or overlap', () => {
    // Each band's alpha is exactly its ramp value ONLY while the bands do not overlap —
    // stacked translucent shapes compound, which is what showed as five hard stripes across
    // the wall coping in the 2026-08-19 pass. Adjacent radii must therefore differ by exactly
    // one stroke width, and the innermost stroke must reach the centre.
    const b = bands(new Pickup('material', undefined, 0));
    for (let i = 1; i < b.length; i++) {
      expect(b[i]!.radius - b[i - 1]!.radius).toBeCloseTo(b[i]!.width, 6);
      expect(b[i - 1]!.alpha - b[i]!.alpha).toBeLessThan(0.06);
    }
    expect(b[0]!.radius - b[0]!.width / 2).toBeCloseTo(0, 6);
    // Convex, not a linear cone: the glow has to keep its brightness in the CORE, or it
    // reads as a wide flat wash again — half the peak still sitting at half the radius is
    // most of the plate back. A linear ramp satisfies every other assertion here.
    // Measured: the squared ramp puts 0.22 of the peak at half the radius, a linear one 0.48.
    // A 0.5 threshold let the linear version through by 0.007 — the battery caught that too.
    const mid = b[Math.floor(b.length / 2)]!;
    expect(mid.alpha).toBeLessThan(b[0]!.alpha * 0.35);
    const outer = b[b.length - 1]!;
    expect(outer.radius + outer.width / 2).toBeCloseTo(13, 6); // still a 26px-wide glow
  });

  it("tints every band with that kind's own colour", () => {
    // One mismatched band would read as a coloured fringe, and the ramp makes it easy to
    // introduce: the loop has to carry the colour through every iteration.
    for (const kind of ALL_KINDS) {
      const colours = new Set(
        (glowOf(new Pickup(kind, undefined, 0)).context.instructions as unknown as Instr[])
          .filter((i) => i.action === 'stroke')
          .map((i) => i.data.style!.color),
      );
      expect(colours.size).toBe(1);
    }
  });
});

/**
 * A weapon lying on the floor is the one object in the game that carried NEITHER of the two
 * channels design/13 requires of a weapon: its rarity was invisible (every drop wore the same
 * amber kind-glow) and its element was invisible too (the icon was drawn untinted, so a fire
 * rifle and a poison one were the same picture). Both landed 2026-08-25 — rarity as a COUNT of
 * additive marks (`game/rarityOverlay.ts`), element as the locked icon badge.
 *
 * Subjects come from the authored content, so the sweep covers whatever tiers/elements actually
 * ship rather than a hand-picked pair that could drift out of the registry.
 */
describe('Pickup — a weapon drop carries its rarity and its element (design/13/14, 2026-08-25)', () => {
  type Instr = {
    action: string;
    data: { style?: { color?: number; alpha?: number }; path?: { instructions: Array<{ action: string; data: unknown[] }> } };
  };

  /** Additive Graphics children — the rarity marks live on one, per the "emissive" clause. */
  function additiveGraphics(p: Pickup): Graphics[] {
    return p.children.filter((c): c is Graphics => c instanceof Graphics && c.blendMode === 'add');
  }

  /** Circles drawn across every Graphics child of `p`, tagged with the blend mode they were
   *  drawn on — enough to separate the additive rarity marks from the opaque element badge. */
  function circlesOf(p: Pickup): Array<{ r: number; color: number; additive: boolean }> {
    const out: Array<{ r: number; color: number; additive: boolean }> = [];
    for (const c of p.children) {
      if (!(c instanceof Graphics)) continue;
      const additive = c.blendMode === 'add';
      for (const ins of c.context.instructions as unknown as Instr[]) {
        for (const pi of ins.data.path?.instructions ?? []) {
          if (pi.action !== 'circle') continue;
          const [, , r] = pi.data as number[];
          out.push({ r: r!, color: ins.data.style?.color ?? 0, additive });
        }
      }
    }
    return out;
  }

  /** The rarity marks only: the additive Graphics that is NOT the glow. The glow is 12
   *  concentric STROKED circles; the marks are fills, so filter on the instruction action. */
  function markCount(p: Pickup): number {
    let n = 0;
    for (const g of additiveGraphics(p)) {
      for (const ins of g.context.instructions as unknown as Instr[]) {
        if (ins.action !== 'fill') continue;
        n += (ins.data.path?.instructions ?? []).filter((pi) => pi.action === 'circle').length;
      }
    }
    return n;
  }

  // Enumerated from `WEAPON_SIM_BY_ID`, which is the registry `Pickup` itself looks up — NOT
  // from `WEAPON_SPECS`. The two differ by exactly one entry (`enemygun`, the mob loadout that
  // is deliberately not player-facing and therefore never drops), and sweeping the wrong one
  // asserts a badge on a weapon that can never appear on a floor.
  const WEAPON_IDS = Object.keys(WEAPON_SIM_BY_ID);

  it('the content spans more than one rarity tier (else the sweep below proves nothing)', () => {
    expect(new Set(WEAPON_IDS.map((id) => WEAPON_SIM_BY_ID[id]!.rarity)).size).toBeGreaterThan(2);
  });

  it('the sweep covers every droppable weapon, and only those', () => {
    expect(WEAPON_IDS.length).toBeGreaterThan(10);
    expect(WEAPON_IDS).not.toContain('enemygun');
  });

  it.each(WEAPON_IDS)('%s draws exactly its tier\'s mark count', (id) => {
    const spec = WEAPON_SIM_BY_ID[id]!;
    expect(markCount(new Pickup('weapon', id))).toBe(pipCount(spec.rarity));
  });

  it('a baseline-tier drop adds no marks at all, so a common drop stays undecorated', () => {
    const common = WEAPON_IDS.find((id) => WEAPON_SIM_BY_ID[id]!.rarity === 'common')!;
    expect(markCount(new Pickup('weapon', common))).toBe(0);
  });

  it('a top-tier drop is louder than a low-tier one (the emissive half of the spec)', () => {
    const alphaOf = (id: string): number => {
      for (const g of additiveGraphics(new Pickup('weapon', id))) {
        for (const ins of g.context.instructions as unknown as Instr[]) {
          if (ins.action !== 'fill') continue;
          if ((ins.data.path?.instructions ?? []).some((pi) => pi.action === 'circle')) {
            return ins.data.style?.alpha ?? 0;
          }
        }
      }
      return 0;
    };
    const low = WEAPON_IDS.find((id) => WEAPON_SIM_BY_ID[id]!.rarity === 'fine');
    const top = WEAPON_IDS.find((id) => WEAPON_SIM_BY_ID[id]!.rarity === 'legendary');
    expect(low, 'content has no fine-tier weapon').toBeDefined();
    expect(top, 'content has no legendary weapon').toBeDefined();
    expect(alphaOf(top!)).toBeGreaterThan(alphaOf(low!));
  });

  it.each(WEAPON_IDS)('%s draws an element badge in its own element hue', (id) => {
    const want = elementColor(WEAPON_SIM_BY_ID[id]!.damageType);
    // The badge's ring is drawn in the element hue on a NON-additive Graphics (its chip is a
    // dark plate, which additive blending would erase).
    const opaque = circlesOf(new Pickup('weapon', id)).filter((c) => !c.additive);
    expect(opaque.map((c) => c.color)).toContain(want);
  });

  it('the badge sits inside the glow, so the drop still reads as one object', () => {
    const p = new Pickup('weapon', 'blaster');
    const badge = p.children[p.children.length - 1] as Graphics; // badge is appended last
    const b = badge.getLocalBounds();
    const GLOW_RADIUS = 13;
    expect(Math.hypot(b.x + b.width / 2, b.y + b.height / 2)).toBeLessThan(GLOW_RADIUS);
  });

  it('a non-weapon drop gets neither channel — they describe a WEAPON, not a pickup', () => {
    for (const kind of ['heal', 'material', 'buff', 'crate', 'bandage'] as PickupKind[]) {
      const p = new Pickup(kind);
      expect(markCount(p), kind).toBe(0);
    }
  });

  it('an unresolvable weapon id claims nothing rather than guessing a tier', () => {
    const p = new Pickup('weapon', 'not_a_real_weapon');
    expect(markCount(p)).toBe(0);
    expect(circlesOf(p).filter((c) => !c.additive)).toHaveLength(0);
  });

  it('the real icon is tinted to its element, matching the MOUNTED copy of the same texture', () => {
    mocks.blasterTexture = new Texture({ source: new TextureSource({ width: 8, height: 8 }) });
    try {
      const p = new Pickup('weapon', 'blaster');
      const icon = p.children.find((c): c is Sprite => c instanceof Sprite)!;
      expect(icon.tint).toBe(elementColor(WEAPON_SIM_BY_ID['blaster']!.damageType));
    } finally {
      mocks.blasterTexture = undefined;
    }
  });
});

describe('Pickup.bodySilhouette — what the occlusion x-ray measures a wall against (live report "被墙挡住的物品，只有角色走到墙下的时候才显示")', () => {
  it('is measured off the drawn art, never zero — an empty silhouette would never trigger the x-ray', () => {
    for (const kind of ALL_KINDS) {
      const { halfW, bodyH } = new Pickup(kind).bodySilhouette;
      expect(halfW, kind).toBeGreaterThan(0);
      expect(bodyH, kind).toBeGreaterThan(0);
    }
  });

  it('is at least as wide as the glow ring every kind carries (design/10)', () => {
    const GLOW_RADIUS = 13;
    for (const kind of ALL_KINDS) {
      expect(new Pickup(kind).bodySilhouette.halfW, kind).toBeGreaterThanOrEqual(GLOW_RADIUS - 1e-9);
    }
  });
});
