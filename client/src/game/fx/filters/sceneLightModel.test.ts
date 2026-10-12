/**
 * A numeric model of `SceneLightFilter`'s shading equation.
 *
 * Nothing in this repo can run a real GL context under vitest, and `filters.test.ts`'s
 * source-contract tests only assert that the GLSL *says* the right things. This file closes
 * the other half: it reimplements the equation in TS and asserts the PROPERTIES the design
 * depends on — a flat texel comes out at exactly 1.0, a slope reads as relief, lights add
 * up, and a light stops contributing exactly at its radius.
 *
 * It is deliberately not a copy-with-the-same-numbers: every constant the model uses is
 * PARSED OUT OF THE SHIPPED SHADER SOURCE (and the uniforms off the built filter), so a
 * change to the shader that this file does not follow makes the tests fail rather than pass
 * against a stale duplicate. Same reasoning as the pow2 model in `filters.test.ts`.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';

// GlProgram.from() probes `document.createElement('canvas').getContext()` for the max
// fragment precision and falls back to mediump when it gets null — same stub, same reason,
// as filters.test.ts. This repo's plain-node vitest has no `document` at all.
beforeAll(() => {
  vi.stubGlobal('document', {
    createElement: () => ({ width: 0, height: 0, getContext: () => null }),
  });
});

// eslint-disable-next-line import/first
import { SceneLightFilter, MAX_SCENE_LIGHTS, flatReference, FLAT_KEY } from './litFx';

type Vec3 = [number, number, number];

/** Strip comments so a number quoted in prose cannot satisfy a regex meant for real code. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');

/** KEY_DIR, read off the shipped GLSL rather than duplicated here. */
function keyDirOf(src: string): Vec3 {
  const m = /const vec3 KEY_DIR = vec3\(([-0-9.]+), ([-0-9.]+), ([-0-9.]+)\)/.exec(code(src));
  if (!m) throw new Error('scene-light shader no longer declares KEY_DIR');
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** POINT_HEIGHT, likewise. */
function pointHeightOf(src: string): number {
  const m = /const float POINT_HEIGHT = ([0-9.]+)/.exec(code(src));
  if (!m) throw new Error('scene-light shader no longer declares POINT_HEIGHT');
  return Number(m[1]);
}

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

interface Light {
  x: number;
  y: number;
  radius: number;
  intensity: number;
  color?: Vec3;
}

/** The shader's `main`, in TS. Returns the per-channel multiplier applied to `color.rgb`. */
function shade(
  f: SceneLightFilter,
  opts: { normal?: Vec3; world?: [number, number]; lights?: Light[] } = {},
): Vec3 {
  const src = f.glProgram.fragment!;
  const KEY_DIR = keyDirOf(src);
  const POINT_HEIGHT = pointHeightOf(src);
  const keyColor = (f.resources.sceneLightUniforms as { uniforms: Record<string, unknown> })
    .uniforms.uKeyColor as Vec3;

  // `opts.normal` is the shader's UNnormalised (-dx, -dy, 1): the point lights see the same slope
  // scaled by `uPointRelief`, exactly as the GLSL builds `pointNormal`.
  const raw = opts.normal ?? [0, 0, 1];
  const normal = norm(raw);
  const pr = f.pointRelief;
  const pointNormal = norm([(raw[0] / raw[2]) * pr, (raw[1] / raw[2]) * pr, 1]);
  const [wx, wy] = opts.world ?? [0, 0];

  const keyTerm = Math.max(0, dot(normal, KEY_DIR));
  const lit: Vec3 = [
    f.ambient + keyTerm * 0.55 * keyColor[0],
    f.ambient + keyTerm * 0.55 * keyColor[1],
    f.ambient + keyTerm * 0.55 * keyColor[2],
  ];

  for (const l of (opts.lights ?? []).slice(0, MAX_SCENE_LIGHTS)) {
    const dx = l.x - wx;
    const dy = l.y - wy;
    const dist = Math.hypot(dx, dy);
    const falloff = Math.max(0, 1 - dist / Math.max(1, l.radius));
    if (falloff <= 0) continue;
    const dir = norm([dx / Math.max(dist, 0.0001), dy / Math.max(dist, 0.0001), POINT_HEIGHT]);
    const term = Math.max(0, dot(pointNormal, dir)) * l.intensity * falloff;
    const c = l.color ?? [1, 1, 1];
    lit[0] += term * c[0];
    lit[1] += term * c[1];
    lit[2] += term * c[2];
  }

  return [lit[0] / f.flatReference, lit[1] / f.flatReference, lit[2] / f.flatReference];
}

/** Green channel — the dominant term in the luma the eye reads. */
const g = (v: Vec3): number => v[1];

describe('SceneLightFilter shading model — the key light', () => {
  it('leaves a FLAT, unlit surface at exactly its painted colour', () => {
    // This is the property that lets the same ambient/key numbers the per-actor filter used
    // apply to pre-shaded floor and wall art. Off by a few percent and the whole scene tints.
    const f = new SceneLightFilter();
    const m = shade(f);
    expect(m[0]).toBeCloseTo(1, 6);
    // The key light is warm (0xfff2e0), so a flat texel's green/blue sit a hair under 1 —
    // that is the light's colour, not a brightness error, and it is what makes the neutral
    // point a WHITE-BALANCE choice rather than an arbitrary constant.
    expect(g(m)).toBeGreaterThan(0.97);
    expect(g(m)).toBeLessThanOrEqual(1);
  });

  it('darkens a surface sloping away from the key light, to the documented floor', () => {
    // A normal pointing hard away from KEY_DIR clamps keyTerm to 0, leaving ambient alone.
    const f = new SceneLightFilter();
    const away = shade(f, { normal: [0.6469, 0.6469, -0.4285] });
    expect(g(away)).toBeCloseTo(f.ambient / f.flatReference, 6);
    expect(g(away)).toBeCloseTo(0.7, 2); // ~70% of a flat texel
  });

  it('brightens a surface facing into the key light, to the documented ceiling', () => {
    const f = new SceneLightFilter();
    const into = shade(f, { normal: [-0.6469, -0.6469, 0.4285] });
    expect(g(into)).toBeGreaterThan(1.3);
    expect(g(into)).toBeLessThan(1.45); // ~140% of a flat texel
  });

  it('is monotonic between those two — no banding step in the middle', () => {
    const f = new SceneLightFilter();
    const samples = [-1, -0.5, 0, 0.5, 1].map((t) => g(shade(f, { normal: [-t, -t, 1] })));
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]!).toBeGreaterThanOrEqual(samples[i - 1]!);
    }
  });

  it('keeps the neutral point tied to KEY_DIR.z, not to a second hardcoded number', () => {
    // If KEY_DIR is retuned and FLAT_KEY is not, a flat texel stops landing on 1.0 and the
    // entire scene shifts brightness — the failure mode this whole normalization exists to
    // avoid. Reading the shader's own vector is what ties them together.
    const f = new SceneLightFilter();
    expect(keyDirOf(f.glProgram.fragment!)[2]).toBeCloseTo(FLAT_KEY, 4);
    expect(f.flatReference).toBeCloseTo(flatReference(f.ambient, 0.55), 9);
  });
});

describe('SceneLightFilter shading model — point lights', () => {
  const near: Light = { x: 0, y: 0, radius: 100, intensity: 1 };

  it('brightens a flat surface standing right under a light', () => {
    const f = new SceneLightFilter();
    expect(g(shade(f, { lights: [near], world: [0, 0] }))).toBeGreaterThan(g(shade(f)));
  });

  it('falls off with distance and reaches exactly zero contribution at the radius', () => {
    // A hard cutoff AT the radius is what makes `LightRegistry` able to keep far lights in
    // the set without them tinting the whole screen — the shader, not the registry, decides
    // what a light touches now.
    const f = new SceneLightFilter();
    const flat = g(shade(f));
    const half = g(shade(f, { lights: [near], world: [50, 0] }));
    const edge = g(shade(f, { lights: [near], world: [100, 0] }));
    const past = g(shade(f, { lights: [near], world: [140, 0] }));
    expect(half).toBeGreaterThan(flat);
    expect(half).toBeLessThan(g(shade(f, { lights: [near], world: [10, 0] })));
    expect(edge).toBeCloseTo(flat, 6);
    expect(past).toBeCloseTo(flat, 6);
  });

  it('ADDS several lights instead of picking a winner', () => {
    // The capability the per-actor filter could not have: it had room for one direction, so
    // a second light was simply discarded (`LightRegistry.strongestAt`).
    const f = new SceneLightFilter();
    const one = g(shade(f, { lights: [near], world: [0, 0] }));
    const two = g(shade(f, {
      lights: [near, { x: 20, y: 0, radius: 100, intensity: 1 }],
      world: [0, 0],
    }));
    expect(two).toBeGreaterThan(one);
  });

  it('lights the same surface differently at different points — falloff is per-texel', () => {
    // The other half of that capability: one light used to shade a whole body uniformly,
    // sampled at its centre. Two texels of the SAME flat surface must now differ.
    const f = new SceneLightFilter();
    const atLight = g(shade(f, { lights: [near], world: [0, 0] }));
    const acrossTheBody = g(shade(f, { lights: [near], world: [60, 0] }));
    expect(atLight).toBeGreaterThan(acrossTheBody);
  });

  it('carries the light colour, not just its brightness', () => {
    const f = new SceneLightFilter();
    const red = shade(f, { lights: [{ ...near, color: [1, 0, 0] }], world: [0, 0] });
    expect(red[0]).toBeGreaterThan(red[1]);
    expect(red[1]).toBeCloseTo(g(shade(f)), 6); // green untouched by a pure-red light
  });

  it('never darkens a surface below its unlit key-light value', () => {
    // Every point term is clamped at 0, so a light BEHIND a surface adds nothing rather than
    // subtracting — a lighting pass over authored art must not be able to punch holes in it.
    const f = new SceneLightFilter();
    const behind = g(shade(f, {
      normal: [0, 0, 1],
      lights: [{ x: 0, y: 0, radius: 100, intensity: 5 }],
      world: [0, 0],
    }));
    expect(behind).toBeGreaterThanOrEqual(g(shade(f)));
  });

  it('ignores anything past the shader slot count, matching the uniform array size', () => {
    // The model truncates the same way the shader loop does; if these disagreed, a frame
    // over the cap would light differently on screen than any test here predicts.
    const f = new SceneLightFilter();
    const many = Array.from({ length: MAX_SCENE_LIGHTS + 4 }, () => ({ ...near }));
    const capped = Array.from({ length: MAX_SCENE_LIGHTS }, () => ({ ...near }));
    expect(g(shade(f, { lights: many, world: [0, 0] })))
      .toBeCloseTo(g(shade(f, { lights: capped, world: [0, 0] })), 9);
  });
});

describe('SceneLightFilter shading model — a retuned look', () => {
  it('re-centres the neutral point when ambient and key change together', () => {
    // The reference is a FUNCTION of both. A call site that raised ambient alone would push
    // every flat texel above 1.0 and wash the scene out.
    const f = new SceneLightFilter({ ambient: 0.8, keyIntensity: 0.2 });
    expect(f.flatReference).toBeCloseTo(flatReference(0.8, 0.2), 9);
    const m = shade(f);
    // The model hardcodes 0.55 for the key term, so it only mirrors the default look — what
    // matters here is that the FILTER's own reference tracks its own uniforms.
    expect(m[0]).toBeGreaterThan(0);
    expect(f.ambient / f.flatReference).toBeGreaterThan(0.7); // less contrast, as configured
  });

  it('a lower gradient means less relief for the same geometry', () => {
    // `uGradient` scales the luminance derivative BEFORE the normal is built, so it is the
    // one knob that decides how strongly the environment's art edges emboss.
    const soft = new SceneLightFilter({ gradient: 1 });
    const hard = new SceneLightFilter({ gradient: 7 });
    const slopeFor = (gain: number): Vec3 => [-0.05 * gain, -0.05 * gain, 1];
    expect(g(shade(hard, { normal: slopeFor(hard.gradient) })))
      .toBeGreaterThan(g(shade(soft, { normal: slopeFor(soft.gradient) })));
  });
});

describe('SceneLightFilter shading model — point-light relief (2026-10-12)', () => {
  const light: Light = { x: 30, y: 0, radius: 100, intensity: 1 };
  const slope: Vec3 = [-0.4, 0, 1];

  it('defaults to the full relief, the look every pass had before', () => {
    expect(new SceneLightFilter().pointRelief).toBe(1);
  });

  it('at 0, a point light shades a slope exactly as it shades a flat texel', () => {
    // The point light's own contribution, with the (static) key term subtracted out: that is the
    // part that moves when the player's glow does, and at 0 relief it no longer depends on the art.
    const f = new SceneLightFilter({ pointRelief: 0 });
    const pointPart = (n: Vec3) => g(shade(f, { normal: n, lights: [light] })) - g(shade(f, { normal: n }));
    expect(pointPart(slope)).toBeCloseTo(pointPart([0, 0, 1]), 9);
  });

  it('at 0, the KEY light still shows the relief — it never moves, so it cannot crawl', () => {
    const f = new SceneLightFilter({ pointRelief: 0 });
    expect(g(shade(f, { normal: slope }))).not.toBeCloseTo(g(shade(f)), 3);
  });

  it('at 1, a slope facing a point light catches more of it than a flat texel', () => {
    const f = new SceneLightFilter({ pointRelief: 1 });
    const pointPart = (n: Vec3) => g(shade(f, { normal: n, lights: [light] })) - g(shade(f, { normal: n }));
    expect(pointPart([0.4, 0, 1])).toBeGreaterThan(pointPart([0, 0, 1]));
  });
});

// The model above is a PARALLEL implementation, so a shader edit it does not follow would
// otherwise leave every test above passing against a stale mirror. These pin the
// correspondence line by line: if the GLSL stops saying this, the mirror is stale and this
// file has to be revisited rather than silently trusted.
describe('the model mirrors the shipped shader', () => {
  const src = () => code(new SceneLightFilter().glProgram.fragment!);

  it('builds the normal from a gradient-scaled luminance derivative', () => {
    expect(src()).toContain('float dx = (hR - hL) * uGradient;');
    expect(src()).toContain('vec3 normal = normalize(vec3(-dx, -dy, 1.0));');
  });

  it('clamps the key term at zero and tints it by the key colour', () => {
    expect(src()).toContain('float keyTerm = max(0.0, dot(normal, KEY_DIR));');
    expect(src()).toContain('vec3 lit = vec3(uAmbient) + keyTerm * uKeyIntensity * uKeyColor;');
  });

  it('uses a linear 1 - dist/radius falloff, floored at zero', () => {
    expect(src()).toContain('float falloff = max(0.0, 1.0 - dist / max(1.0, light.z));');
  });

  it('ADDS each light rather than keeping a maximum', () => {
    // `lit +=`, not `lit = max(lit, ...)`. This one character is the whole difference from
    // the per-actor filter's one-winning-light model.
    expect(src()).toContain('lit += max(0.0, dot(pointNormal, dir)) * light.w * falloff * uLightColors[i];');
  });

  it('gives the point lights the same slope, scaled by uPointRelief', () => {
    expect(src()).toContain('vec3 pointNormal = normalize(vec3(-dx * uPointRelief, -dy * uPointRelief, 1.0));');
  });

  it('divides by the flat reference at the very end, after every light has been added', () => {
    const s = src();
    expect(s).toContain('color.rgb *= lit / uFlatReference;');
    expect(s.indexOf('lit +=')).toBeLessThan(s.indexOf('color.rgb *= lit / uFlatReference;'));
  });
});
