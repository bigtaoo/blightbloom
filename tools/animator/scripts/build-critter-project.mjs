// One-off build script: constructs critter-core.editortao — the minimal one-bone
// enemy rig (tools/animator/src/skeleton/rigs/critterCore.ts) bound to the existing
// neutral art/units/enemy_critter.png, with a gentle idle bob so it's actually
// previewable/animated instead of a static image. Mirrors the Node+jszip approach
// used for orb-core.editortao / boss-core.editortao / the two character projects
// (design/12, 2026-07-27).
//
// CAUTION this script had DRIFTED from the bundle it writes, in two ways at once, and both are
// now guarded rather than merely documented (found 2026-09-02 by re-running it to check the clip
// table below still reproduced the shipped bundle -- the clips matched exactly, nothing else did):
//
//   1. body.png. This script copies art/units/enemy_critter.png in RAW (1254 px, ~1 MB). The
//      SHIPPED body.png is a 256 px downsample of it (~52 KB) produced by something that is not
//      in this repo, so a re-run replaced a run-pack asset with one 20x its size.
//   2. bindings. `BODY_SCALE` below is computed against that raw 1254 px, giving 0.0797; the
//      shipped bundle carries 0.3906 (= 100/256), the correct scale for the downsampled art. A
//      re-run therefore ALSO shrank the critter to a fifth of its size on screen, which
//      `rigComposition.test.ts`'s footprint and BODY_FILL cases catch immediately.
//
// So the shipped bundle is the ground truth for BOTH -- exactly the same conclusion
// build-character-projects.mjs reached about its own `orbWorldWidth`. Both are now preserved
// when a bundle already exists on disk, and the raw values below are the bootstrap path only.
//
// NOTE brute-core and floater-core share this one RIG (client/src/render/skinRegistry.ts's
// RIG_DEFS) but as of 2026-11-15 they no longer share its MOTION: each of the three bundles
// now carries a deliberately different gait (critter scurries, brute lumbers, floater drifts
// -- design/12). They have no build script of their own, and their clips must NOT be copied
// from the table below any more; `rigComposition.test.ts` pins each one's distinguishing
// property so a copy-paste that flattens the three back into one fails the suite.
//
// The same "shipped bundle is ground truth" rule the CAUTION above states for bindings and
// body.png therefore now covers `animations` as well: a re-run keeps whatever critter-core
// ships and never touches the other two bundles. The table below is the bootstrap path only
// -- it is also what goes into the .editortao, so it is kept in sync with critter's bundle
// by hand.
//
// Run from tools/animator: node scripts/build-critter-project.mjs
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import JSZip from 'jszip';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const projectsDir = path.resolve(here, '../projects');
const unitsDir = path.join(root, 'art/units');
const skinsDir = path.join(root, 'client/public/skins');

// body's bodyR=50 (authoring px, skeleton/rigs/critterCore.ts) vs enemy_critter.png's
// actual 1254px native resolution — same "Static scale offset" correction every other
// real-art binding needed (client/src/render/critterCoreRig.ts's
// CRITTER_CORE_REFERENCE_RADIUS convention): scale = (2*bodyR)/nativePx.
const BODY_SCALE = 100 / 1254;

async function main() {
  const editorJson = {
    version: 1,
    selectedClip: 'idle',
    previewMode: 'sprite',
    bindings: {
      body: {
        anchorX: 0.5,
        anchorY: 0.5,
        flipX: false,
        zOrder: 0,
        rotation: 0,
        scaleX: BODY_SCALE,
        scaleY: BODY_SCALE,
      },
    },
    animations: {
      // critter-core's own gait -- "scurry": small, quick, three patters per `move` cycle, an
      // `idle` that never quite settles. brute-core (one heavy step, lands with a squash) and
      // floater-core (lateral bank, no footfall) carry their own; see the NOTE at the top.
      idle: {
        duration: 1.4,
        loop: true,
        keyframes: [
          { time: 0, bones: { body: { translateY: 0, scaleX: 1, scaleY: 1 } } },
          { time: 0.35, bones: { body: { translateY: -4, scaleX: 0.97, scaleY: 1.03 } } },
          { time: 0.7, bones: { body: { translateY: 0, scaleX: 1.04, scaleY: 0.96 } } },
          { time: 1.05, bones: { body: { translateY: -3, scaleX: 0.98, scaleY: 1.02 } } },
          { time: 1.4, bones: { body: { translateY: 0, scaleX: 1, scaleY: 1 } } },
        ],
      },
      // `move`: THREE hops per cycle with the lean alternating, so it reads as a scurry rather
      // than a faster idle bob. Starts AND ends at identity, because a base-clip swap has no
      // cross-fade (`RigSkin.playClip` swaps outright) and an idle<->move switch pops by
      // exactly however far this clip's t=0 sits from rest.
      move: {
        duration: 0.6,
        loop: true,
        keyframes: [
          { time: 0, bones: { body: { translateY: 0, translateX: 0, rotation: 0 } } },
          { time: 0.1, bones: { body: { translateY: -6, translateX: 1.5, rotation: -5 } } },
          { time: 0.2, bones: { body: { translateY: 0, translateX: 0, rotation: 0 } } },
          { time: 0.3, bones: { body: { translateY: -6, translateX: -1.5, rotation: 5 } } },
          { time: 0.4, bones: { body: { translateY: 0, translateX: 0, rotation: 0 } } },
          { time: 0.5, bones: { body: { translateY: -6, translateX: 1.5, rotation: -5 } } },
          { time: 0.6, bones: { body: { translateY: 0, translateX: 0, rotation: 0 } } },
        ],
      },
      // `attack`: wind up back, lunge forward, settle. Unlike every other clip here this one
      // is sampled as an ADDITIVE OVERLAY on whatever base clip is playing (translate and
      // rotation add, scale and alpha multiply), so its numbers are DELTAS around identity
      // and it has to start and end AT identity or the layer pops on trigger and on expiry.
      // `rigComposition.test.ts` asserts that per bundle. +translateX is FORWARD: the whole
      // rig mirrors on `view.scale.x` for a left-facing body (client/src/render/facing.ts),
      // so a canonical +X delta lands on the facing side whichever way the creature looks.
      attack: {
        duration: 0.35,
        loop: false,
        keyframes: [
          { time: 0, bones: { body: { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1 } } },
          { time: 0.05, bones: { body: { translateX: -3, translateY: -2, scaleX: 0.88, scaleY: 1.12 } } },
          { time: 0.13, bones: { body: { translateX: 11, translateY: 2, scaleX: 1.18, scaleY: 0.84 } } },
          { time: 0.22, bones: { body: { translateX: 2, translateY: 0, scaleX: 0.96, scaleY: 1.04 } } },
          { time: 0.35, bones: { body: { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1 } } },
        ],
      },
      hurt: {
        duration: 0.3,
        loop: false,
        keyframes: [
          { time: 0, bones: { body: { scaleX: 1, scaleY: 1, alpha: 1, rotation: 0 } } },
          { time: 0.05, bones: { body: { scaleX: 1.2, scaleY: 0.76, alpha: 0.5, rotation: -6 } } },
          { time: 0.14, bones: { body: { scaleX: 0.9, scaleY: 1.1, alpha: 1, rotation: 5 } } },
          { time: 0.22, bones: { body: { scaleX: 1.04, scaleY: 0.97, alpha: 1, rotation: -2 } } },
          { time: 0.3, bones: { body: { scaleX: 1, scaleY: 1, alpha: 1, rotation: 0 } } },
        ],
      },
      death: {
        duration: 0.9,
        loop: false,
        keyframes: [
          { time: 0, bones: { body: { scaleX: 1, scaleY: 1, translateY: 0, rotation: 0, alpha: 1 } } },
          { time: 0.18, bones: { body: { scaleX: 1.25, scaleY: 0.75, translateY: 4, rotation: 0, alpha: 1 } } },
          { time: 0.45, bones: { body: { scaleX: 0.6, scaleY: 0.55, translateY: 13, rotation: 14, alpha: 0.45 } } },
          { time: 0.9, bones: { body: { scaleX: 0.25, scaleY: 0.2, translateY: 20, rotation: 30, alpha: 0 } } },
        ],
      },
      spawn: {
        duration: 0.35,
        loop: false,
        keyframes: [
          { time: 0, bones: { body: { scaleX: 0.15, scaleY: 0.15, alpha: 0 } } },
          { time: 0.13, bones: { body: { scaleX: 1.22, scaleY: 0.8, alpha: 1 } } },
          { time: 0.23, bones: { body: { scaleX: 0.92, scaleY: 1.08 } } },
          { time: 0.35, bones: { body: { scaleX: 1, scaleY: 1 } } },
        ],
      },
    },
    attachmentPoints: [{ id: 'shadow', label: '🔵 Shadow', parentBone: 'root', offsetX: 0, offsetY: 4 }],
  };

  const zip = new JSZip();
  zip.file('editor.json', JSON.stringify(editorJson, null, 2));
  zip.folder('images').file('body.png', readFileSync(path.join(unitsDir, 'enemy_critter.png')));

  // NOTE the .editortao this rebuilds is not byte-reproducible either -- a rebuild drops it
  // from 1.39 MB to 1.06 MB, i.e. the shipped project carries something this script does not
  // author. Committing the rebuilt zip would silently discard that, so the repo keeps the
  // shipped one; this write is for a bootstrap, or for opening the new clips in the editor.
  const outBuf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const outPath = path.join(projectsDir, 'critter-core.editortao');
  writeFileSync(outPath, outBuf);
  console.log(`wrote ${outPath} (${outBuf.length} bytes)`);

  // client/public/skins/critter-core/ — the loose-file bundle client/src/render/
  // taoBundle.ts actually loads at runtime (same shape as the character bundles,
  // design/12's real packed .tao is still pending).
  const skinOutDir = path.join(skinsDir, 'critter-core');
  mkdirSync(skinOutDir, { recursive: true });
  // Ground truth for bindings and for the body art is the SHIPPED bundle when one exists (see
  // the CAUTION at the top of this file): both were calibrated against a 256 px downsample this
  // script cannot reproduce, so re-deriving them from the raw source is a regression, not a
  // refresh. The `editorJson` values are the bootstrap path, for a bundle that does not exist yet.
  const shippedPath = path.join(skinOutDir, 'animation.json');
  const shipped = existsSync(shippedPath) ? JSON.parse(readFileSync(shippedPath, 'utf8')) : null;
  const animationJson = {
    version: 2,
    bindings: shipped?.bindings ?? editorJson.bindings,
    // ... and the clips too, since 2026-11-15: critter's gait is now authored in the bundle and
    // is one of three deliberately different ones (see the NOTE at the top of this file).
    animations: shipped?.animations ?? editorJson.animations,
  };
  writeFileSync(shippedPath, `${JSON.stringify(animationJson, null, 2)}\n`);
  writeFileSync(path.join(skinOutDir, 'frames.json'), JSON.stringify({ body: ['default'] }, null, 2));
  const bodyPath = path.join(skinOutDir, 'body.png');
  if (!existsSync(bodyPath)) writeFileSync(bodyPath, readFileSync(path.join(unitsDir, 'enemy_critter.png')));
  console.log(`wrote ${skinOutDir}/ (${shipped ? 'kept shipped bindings + body.png' : 'bootstrapped from raw art'})`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
