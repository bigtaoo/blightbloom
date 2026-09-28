# Work log — 2026-09-28

Volume 106. See [`design/ROADMAP.md`](../ROADMAP.md) for the index and the phase spine.

## Walls and actors are antialiased, so they stop juddering in motion (2026-09-28, client + render + test, no engine change)

The owner's report came after the camera comfort pass ([volume 104](104-2026-09-28-camera-comfort.md)):
play still felt a little dizzying. Walls and objects on the ground juddered while the character
moved, and even at rest the picture looked less smooth than the lobby.

**Camera timing was ruled out first.** On a live run the per-frame pan deltas were smooth (about
11 px a frame walking, with a clean ease-out). Every node updated every frame, and the camera came
fully to rest.

**The cause was antialiasing, or rather its absence.** The scene-lighting pass renders the whole
world into a filter pool texture, and a Pixi filter's default is `antialias: 'off'`. Every wall edge,
rig outline and shading band was therefore rasterised with no AA at all. The lobby, drawn straight
into the canvas, got the canvas's own MSAA. To measure it, the camera was shifted in 1/8 px steps on
a live run: 36.5% of the moving edge pixels jumped in one step instead of gliding. A player reads
that as the walls juddering while walking, and as the idle hover bob stepping.

**What shipped.**

- MSAA over the whole pass fixed the stepping, but cost +4.4 ms of GPU on a 1080p desktop (3.2 to
  7.6 ms). Nearly all of that is the floor's overdraw times four samples, and the floor contributes
  almost none of the stepping. So on the high tier the pass is split over `lit`'s two halves
  (`scene/layers.ts`):
  - `litFloor` holds the ground and the shadows. It keeps the existing pass, with no MSAA.
  - `litStand` holds the Y-sorted entities. It gets a second instance with MSAA.
- Result: stepping 36.5% to 9.7%, for +0.8 ms (3.2 to 4.0 ms). At rest 1.3% of pixels change, all
  at edges.
- The medium tier keeps the single pass on `lit`, since its whole point is the pass count. The low
  tier is unchanged.
- The shader now clamps rgb to alpha, which a premultiplied pass over a transparent background
  needs.

**The follow-up the live frame demanded.** The first version asked for `antialias: 'inherit'`, and a
live frame then measured the stepping unchanged (36.8% to 36.5%). Pixi resolves `'inherit'` against
the CURRENT render target. On the high tier the lit pass sits inside `world`'s vignette pass, whose
pool texture has no MSAA, so `'inherit'` meant off. The stand pass now asks for `'on'`. A WebGL1 host
still gets none, because Pixi only multisamples where `supports.msaa` is true.

**Tests.** `FxController.test.ts` pins the tier split, the shared filter area, and the stand pass's
`'on'` beside the floor pass's `'off'`. The shader's rgb-to-alpha clamp (`litFx.ts`) has no test:
it is GLSL, and `sceneLightModel.test.ts` models the lighting terms, not the final premultiply.
