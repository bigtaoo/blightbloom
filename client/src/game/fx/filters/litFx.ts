// Split out of fx/filters.ts (2026-08-18, 500-line convention): the directional-lighting
// filter (design/01 fidelity-roadmap milestone 2).
//
// 2026-08-24: rewritten from a PER-ACTOR filter (`NormalLitFilter`, one instance attached
// to every actor's skin, always on) into ONE screen-space pass over the whole scene layer
// (`SceneLightFilter` on `Layers.lit` = ground + shadow + entities). The per-actor form was
// measured — by the perf system ported the same day, see `src/perf/README.md` — to be the
// dominant cost of the frame: a filtered container is its own render-target pass in Pixi
// (bind target, draw, bind back, re-draw through the filter's program), so 9 on-screen
// actors meant 9 extra passes AND cut the sprite batcher into 9 pieces. 175 draw calls and
// 105 program switches for a scene of 892 nodes, render p50 10.4ms against update 0.6ms.
//
// Three things change with the move, beyond the cost:
//   * Point lights become PER-PIXEL. The old filter got one direction+intensity per actor
//     (`LightRegistry.strongestAt` at the actor's centre); this one gets every light's world
//     position and computes direction and falloff at each texel, so a light actually falls
//     off across a body instead of shading it uniformly, and several lights add up.
//   * The ENVIRONMENT is lit too — floor, walls, doors, props, portals, pickups. That is the
//     point of doing it in one pass: a muzzle flash now lights the room it goes off in, not
//     just the actors standing in it.
//   * Shading now runs AFTER each actor's own overlays (shield glow, hit flash, dissolve),
//     since it sees them already composited, where before it ran first and they layered on
//     top. Kept deliberately: the alternative is going back to per-actor passes.
import { Filter, GlProgram, UniformGroup, defaultFilterVert, type FilterAntialias } from 'pixi.js';
import { FRAME_UV, hexToRgb } from './shaderPrelude';

/** Point lights the one pass can carry. A frame with more (a big fight throws a transient
 *  per impact, each ~170ms long) keeps the STRONGEST this many — `LightRegistry.snapshot`
 *  does the picking and is where that truncation is documented. Sized for one persistent
 *  player glow, up to `torches.MAX_LIT_TORCHES` wall torches (2026-10-10: 8 -> 12 for them, so
 *  a torch-lit room still leaves five slots to a burst of impacts); every slot costs a
 *  per-texel iteration over the whole screen, so this is the knob that decides the pass's fill
 *  cost — and the loop breaks at `uLightCount`, so an unused slot costs nothing. */
export const MAX_SCENE_LIGHTS = 12;

/** Ambient floor + fake-normal gain, unchanged from the per-actor filter this replaces:
 *  ambient 0.55 with key 0.55 means a surface facing fully away from the key light drops to
 *  70% of the brightness of a flat one, and one facing into it rises to 140% (see
 *  `flatReference` — the shading is normalized so FLAT comes out at exactly 1.0, which is
 *  what lets the same numbers now apply to pre-shaded environment art without darkening it). */
const AMBIENT = 0.55;
const KEY_INTENSITY = 0.55;
/** Gain on the luminance gradient that stands in for a normal map. 7.0 is the value the
 *  per-actor filter used, kept because it is what makes a small busy character sprite read
 *  as relief; it now also applies to floor/wall art, which is the one look change of this
 *  move that had to be judged from a real frame rather than reasoned about. */
const GRADIENT = 7.0;

/** `dot(flatNormal, KEY_DIR)` — the key term for an unsloped texel, i.e. KEY_DIR.z. Kept in
 *  sync with the shader constant below by `litFx.test.ts`. */
const FLAT_KEY_TERM = 0.4285;

const sceneLightFrag = FRAME_UV + /* glsl */ `
in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
// NOTE: \`uInputSize\` is NOT declared here — FRAME_UV above already declares it (as highp,
// which is also the precision the vertex stage uses, so the link succeeds). Declaring it a
// second time is a hard compile error, 'uInputSize : redefinition', and a filter whose
// program fails to compile renders its whole layer BLACK rather than failing loudly.
uniform vec3 uKeyColor;
uniform float uKeyIntensity;
uniform float uAmbient;
uniform float uGradient;
uniform float uFlatReference;
// World-space rect this filtered region covers: xy = origin, zw = size. Supplied by
// \`FxController.syncSceneLight\` together with a \`filterArea\` pinned to exactly that rect,
// which is what makes this mapping exact rather than a guess about Pixi's own bounds
// (\`uOutputFrame.xy\` cannot be used: FilterSystem zeroes it whenever the filter's output is
// not the final render target, and this one always renders into \`world\`'s post-fx input).
uniform vec4 uRegion;
uniform int uLightCount;
uniform vec4 uLights[${MAX_SCENE_LIGHTS}];      // xy = world position, z = radius (world px), w = intensity
uniform vec3 uLightColors[${MAX_SCENE_LIGHTS}];

// Fixed "lit from upper-left" direction (screen space) — the one directional-lighting
// convention this project already has (RoomBuilder.ts's pillar highlight/shadow bands).
// z=0.5 keeps the key light from ever fully grazing a flat-on sprite.
const vec3 KEY_DIR = vec3(-0.6469, -0.6469, 0.4285); // normalize(vec3(-0.6, -0.6, 0.4))
// How far "toward the viewer" a point light sits. Non-zero for the same reason KEY_DIR.z is:
// a light exactly in the ground plane would contribute nothing to a flat-facing texel.
const float POINT_HEIGHT = 0.4;

float luminance(vec4 c)
{
    // Premultiplied by alpha: fully transparent neighbours contribute zero "height", so a
    // silhouette's own edge reads as a slope (a rim highlight) exactly like a real normal
    // map would, on top of whatever internal shading the flat-cel art already carries.
    return dot(c.rgb, vec3(0.299, 0.587, 0.114)) * c.a;
}

void main(void)
{
    vec4 color = texture(uTexture, vTextureCoord);
    vec2 px = uInputSize.zw;
    float hR = luminance(texture(uTexture, vTextureCoord + vec2(px.x, 0.0)));
    float hL = luminance(texture(uTexture, vTextureCoord - vec2(px.x, 0.0)));
    float hD = luminance(texture(uTexture, vTextureCoord + vec2(0.0, px.y)));
    float hU = luminance(texture(uTexture, vTextureCoord - vec2(0.0, px.y)));
    float dx = (hR - hL) * uGradient;
    float dy = (hD - hU) * uGradient;
    vec3 normal = normalize(vec3(-dx, -dy, 1.0));

    float keyTerm = max(0.0, dot(normal, KEY_DIR));
    vec3 lit = vec3(uAmbient) + keyTerm * uKeyIntensity * uKeyColor;

    // This texel's own world position — the whole reason the pass can do positional lights
    // at all. \`frameUv\` (not raw vTextureCoord) because the filter's input comes from a
    // power-of-two pool texture, so the raw coord does not span 0..1 across the region; see
    // shaderPrelude.ts for the bug that taught us this.
    vec2 world = uRegion.xy + frameUv(vTextureCoord) * uRegion.zw;
    for (int i = 0; i < ${MAX_SCENE_LIGHTS}; i++) {
        if (i >= uLightCount) break;
        vec4 light = uLights[i];
        vec2 delta = light.xy - world;
        float dist = length(delta);
        float falloff = max(0.0, 1.0 - dist / max(1.0, light.z));
        if (falloff <= 0.0) continue;
        vec3 dir = normalize(vec3(delta / max(dist, 0.0001), POINT_HEIGHT));
        lit += max(0.0, dot(normal, dir)) * light.w * falloff * uLightColors[i];
    }

    // Normalized so a FLAT, unlit-by-points texel comes out at exactly 1.0. Without this the
    // whole scene would darken by the same ~21% the per-actor version applied to actors —
    // acceptable when only characters were shaded, not when the pre-shaded floor and wall art
    // is in the pass too. Slopes and lights then read as relative brightening/darkening of
    // the art's own painted value, which is what a lighting pass over authored art should do.
    color.rgb *= lit / uFlatReference;
    // Premultiplied, so a colour channel may never exceed alpha. A no-op over an opaque texel
    // (the 8-bit target clamps at 1 anyway), and the whole point over a translucent one: the
    // split pass (\`Layers.litStand\`) lights actors and walls over a TRANSPARENT background,
    // where a brightened antialiased edge texel would otherwise composite as a glow.
    color.rgb = min(color.rgb, vec3(color.a));
    finalColor = color;
}
`;

export interface SceneLightOptions {
  /** Shading floor: what an entirely unlit texel is multiplied by, before normalization. */
  ambient?: number;
  /** Gain on the luminance gradient that stands in for a normal map. */
  gradient?: number;
  keyColor?: number;
  keyIntensity?: number;
  /** Multisampling of the pass's own render target. Pixi's filter default is `'off'`, which
   *  is right for a pass over soft content and wrong for one over hard moving edges — see
   *  `Layers.litStand`. */
  antialias?: FilterAntialias;
}

/** One light as the shader wants it: world position, world-px radius, already-faded
 *  intensity, colour. `LightRegistry.snapshot` produces these. */
export interface SceneLight {
  x: number;
  y: number;
  radius: number;
  intensity: number;
  color: number;
}

/**
 * Dynamic lighting (design/01 fidelity roadmap milestone 2) as ONE screen-space pass over
 * the scene layer — see this file's header for what it replaced and why.
 *
 * Rather than the design doc's literal "separate lightmap layer, multiply-composited", the
 * per-pixel normal is still derived from the layer's OWN rendered luminance/alpha at shader
 * time (the neighbour-texel trick `OutlineFilter` uses for alpha edges, reading brightness
 * instead) — no normal-map asset exists or is needed. What the move to one pass bought is
 * the other half of the doc's intent: the lights are now positional across the whole scene
 * instead of one averaged direction per character.
 */
export class SceneLightFilter extends Filter {
  private readonly lightData = new Float32Array(MAX_SCENE_LIGHTS * 4);
  private readonly lightColors = new Float32Array(MAX_SCENE_LIGHTS * 3);

  constructor(opts: SceneLightOptions = {}) {
    const glProgram = GlProgram.from({ vertex: defaultFilterVert, fragment: sceneLightFrag, name: 'scene-light-filter' });
    const ambient = opts.ambient ?? AMBIENT;
    const keyIntensity = opts.keyIntensity ?? KEY_INTENSITY;
    super({
      glProgram,
      // No padding: the region is pinned to exactly the visible world rect (`setRegion`), and
      // growing it would put `uRegion` and the real region out of step — the shader's whole
      // world-space mapping depends on those two agreeing. The cost is that the one-texel
      // neighbour reads clamp at the screen edge instead of sampling just off it.
      padding: 0,
      // Same reason: the region must be `filterArea` and nothing else. Pixi otherwise
      // intersects it with the viewport, which is a no-op while `filterArea` IS the viewport
      // but would silently shift the mapping the first time it is not.
      clipToViewport: false,
      antialias: opts.antialias ?? 'off',
      resources: {
        sceneLightUniforms: new UniformGroup({
          uKeyColor: { value: hexToRgb(opts.keyColor ?? 0xfff2e0), type: 'vec3<f32>' },
          uKeyIntensity: { value: keyIntensity, type: 'f32' },
          uAmbient: { value: ambient, type: 'f32' },
          uGradient: { value: opts.gradient ?? GRADIENT, type: 'f32' },
          uFlatReference: { value: flatReference(ambient, keyIntensity), type: 'f32' },
          // Harmless default: with uLightCount 0 the region is never read, so a filter that
          // has not been synced yet simply applies the key light alone.
          uRegion: { value: [0, 0, 1, 1], type: 'vec4<f32>' },
          uLightCount: { value: 0, type: 'i32' },
          uLights: { value: new Float32Array(MAX_SCENE_LIGHTS * 4), type: 'vec4<f32>', size: MAX_SCENE_LIGHTS },
          uLightColors: { value: new Float32Array(MAX_SCENE_LIGHTS * 3), type: 'vec3<f32>', size: MAX_SCENE_LIGHTS },
        }),
      },
    });
    // Hand the class's own buffers to the uniform group, so `setLights` can write into them
    // in place with no per-frame allocation. Safe to do only here, after `super`: field
    // initializers run between the super call and this line. Pixi's generated GL sync for an
    // ARRAY uniform is an unconditional `gl.uniform4fv` (no identity/value compare, unlike
    // the scalar path), so mutating the same buffer still uploads.
    this.uniforms.uLights = this.lightData;
    this.uniforms.uLightColors = this.lightColors;
  }

  private get uniforms(): Record<string, unknown> {
    return this.resources.sceneLightUniforms.uniforms as Record<string, unknown>;
  }

  get ambient(): number { return this.uniforms.uAmbient as number; }
  get gradient(): number { return this.uniforms.uGradient as number; }
  get flatReference(): number { return this.uniforms.uFlatReference as number; }
  get lightCount(): number { return this.uniforms.uLightCount as number; }
  /** The world rect currently mapped onto the filtered region — `[x, y, w, h]`. */
  get region(): readonly number[] { return this.uniforms.uRegion as number[]; }

  /**
   * The world-space rect the filtered region covers. MUST match the `filterArea` set on the
   * filtered container, or every light lands in the wrong place — `FxController` sets both
   * from one computation for exactly that reason.
   */
  setRegion(x: number, y: number, w: number, h: number): void {
    // Written in place: this runs every frame, and a fresh array per frame is the kind of
    // churn the thing this filter replaced was measured for.
    const region = this.uniforms.uRegion as number[];
    region[0] = x;
    region[1] = y;
    region[2] = Math.max(1, w);
    region[3] = Math.max(1, h);
  }

  /** This frame's lights, in world space. Anything past `MAX_SCENE_LIGHTS` is ignored here —
   *  the caller is responsible for having already picked the strongest ones. */
  setLights(lights: readonly SceneLight[], count = lights.length): void {
    const n = Math.min(count, MAX_SCENE_LIGHTS);
    for (let i = 0; i < n; i++) {
      const l = lights[i]!;
      this.lightData[i * 4] = l.x;
      this.lightData[i * 4 + 1] = l.y;
      this.lightData[i * 4 + 2] = l.radius;
      this.lightData[i * 4 + 3] = l.intensity;
      const [r, g, b] = hexToRgb(l.color);
      this.lightColors[i * 3] = r;
      this.lightColors[i * 3 + 1] = g;
      this.lightColors[i * 3 + 2] = b;
    }
    this.uniforms.uLightCount = n;
  }
}

/** The shading value a flat, point-light-free texel gets before normalization — the divisor
 *  that makes such a texel come out at exactly its painted colour. */
export function flatReference(ambient: number, keyIntensity: number): number {
  return ambient + FLAT_KEY_TERM * keyIntensity;
}

/** `dot(flatNormal, KEY_DIR)`, exported so a test can hold it against the shader's own
 *  KEY_DIR rather than trusting two copies of the same number. */
export const FLAT_KEY = FLAT_KEY_TERM;
