# Work log — 2026-09-28

Volume 104. See [`design/ROADMAP.md`](../ROADMAP.md) for the index and the phase spine.

## The camera stops causing motion sickness (2026-09-28, client + test + docs, no engine change)

The owner: playing still makes them dizzy, like 3D motion sickness — what exactly is wrong? A read
of `FxController.updateCamera` found three causes, and they agreed the second and third were the
likely main ones. All four proposed changes were made. The design record is in
[rendering/01-foundations](../rendering/01-foundations.md#view) ("Motion comfort"); this entry is
the work.

**The three causes.**

1. **Zoom snapped at every door.** The zoom was recomputed from scratch each frame by cover-fitting
   the player's current room. A door passage belongs to no room, so `EnvironmentSystem` clears the
   player's `roomId` there, `GameLoop.cameraFrame` returns null, and the camera fell back to
   fitting the whole FLOOR: ~4x → ~1x → ~4x in a single frame each way through every door. Rooms
   of different sizes also cut between zooms.
2. **The camera was welded to the player.** The world offset was the player's position times the
   zoom, every frame, with no easing and no dead zone. Every strafe, wall bump and knockback moved
   the whole screen 1:1, magnified by a zoom of up to 4.5.
3. **The shake was a buzz.** ±14 px of white noise re-rolled every render frame, topped up by
   every kill (+0.15 trauma each), so a busy room kept the whole screen moving.

**The changes.** The math moved into a new pure module, `client/src/game/fx/cameraRig.ts`
(`CameraRig`, `fitZoom`, `shakeOffset`), which also keeps `FxController` under the 500-line rule
(485 → 417 lines). `CameraTarget`/`CameraFrame` moved with it and are re-exported from
`FxController`.

- **Zoom:** held through a passage (the rig keeps the last room it fitted and re-fits it against
  the current viewport), and eased toward a new room's fit in log space, `ZOOM_TAU_MS` 320.
  The whole-world fit remains only for a mode that never had a room.
- **Pan:** a dead-zone anchor (`DEADZONE_R`, 5% of the viewport's shorter side) that the look-at
  point eases toward (`FOLLOW_TAU_MS` 140). Both eases are `1 - exp(-dt/tau)`, so frame rate does
  not change them. The world-edge clamp is applied to the anchor and again to the eased point,
  so an easing zoom never reveals past the world. A jump past half the viewport's longer side
  (`SNAP_DISTANCE_R`) is a cut, not a pan, and so is the first frame and the first frame of a new
  run (`FxController.resetForNewRun` → `CameraRig.reset`). `updateCamera` gained a trailing `dtMs`,
  passed from both `GameLoop` render paths; omitted, the camera cuts, which is what every existing
  single-call test relied on.
- **Shake:** `shakeOffset` — two incommensurate sines per axis (~7-12 Hz) on a clock advanced by
  `updateFx`, bounded by the magnitude — replaces the per-frame `Math.random()`. `MAX_SHAKE_PX`
  14 → 7. The enemy-death shake is gone. Reduce-motion still zeroes it at the output.
- **`MAX_ZOOM` 4.5 → 3.5**, so the same step slides less screen. A room that no longer quite
  covers a desktop viewport shows a sliver of its neighbours at the edges.

**Verification.** 16 new tests in `cameraRig.test.ts`: the cuts (first step, no dt, teleport,
reset), the dead zone holding still, the ease being partial and settling at the dead-zone edge,
frame-rate independence mid-ease, zoom easing and being held with no frame, the clamp during a
zoom ease, a centred axis, and the shake's bound and smoothness. The two reduce-motion shake tests
now advance the shake clock between frames. `groundGeometryBudget`'s worst-camera pin moved
26,150 → 26,226, because the lower cap shows a little more floor. The two art-resolution tests keep
their 4.5x bar on purpose, and their comments now say why. Client 7,830 tests green; client,
engine and server typecheck clean.

Driven live in the dev server on `arena_launch`: a 6 px nudge left the world layer exactly where it
was; an 80 px move eased in over about half a second (−8, −73, −123, … −228 screen px, every third
frame); walking the 640 px corridor between rooms A and B, which is in no room, held the zoom at
3.2 with zero per-frame change. The old camera would have fit the whole floor there.

**Open.** The tuning is a first guess. The owner is play-testing it, and the constants at the top of
`cameraRig.ts` are the knobs.
