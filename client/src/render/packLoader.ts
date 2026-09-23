// Making a subpackage's files reachable before anything asks for them (design/04, design/12).
//
// On WeChat a subpackage's files do not exist until `wx.loadSubpackage` has run for it — a
// texture path inside one resolves to nothing before that, which every loader here would
// treat as "not generated yet" and silently fall back on. So the load has to be ordered
// ahead of the preload, not raced with it.
//
// **Which packs are fetched WHEN is declared in `assetPacks.json`, not here** (design/12,
// "the first download is code only"): each pack carries a `phase`, and `preloadArt.ts` asks
// `packsForPhase()` for the list. Until 2026-09-01 this module's only caller was
// `ensureAllPacks()` from `preloadCoreArt` — every pack at boot, which satisfied WeChat's
// first-download rule while buying nothing else, because the bytes still all arrived before
// the first frame. Now the `lobby` pack is awaited at boot and the rest are kicked from the
// lobby, with the `run`-phase ones awaited again at the run boundary
// (`game/controllers/TransitionGate.ts`).
//
// `ensureAllPacks()` survives as the "everything, now" path: `preloadCoreArt` still offers the
// old one-call shape, which is what the loader tests and any caller that does not want to
// think about phases run against.
//
// On web this is all no-ops — there are no subpackages, the files are just served, and
// `AssetHost.loadPack` is absent.
import { getAssetHost } from './assetHost';
import { SUBPACKS, type PackDef } from './assetManifest';

/** Memoised per pack: the SAME promise is returned to every caller, so a background kick and
 *  a later gate cannot start two downloads, and a pack already loaded costs nothing to
 *  re-request. This is what makes the run gate free once the background load has finished. */
const inFlight = new Map<string, Promise<void>>();

export function ensurePack(name: string): Promise<void> {
  let p = inFlight.get(name);
  if (!p) {
    const def = SUBPACKS.find((s) => s.name === name);
    // An unknown name is main-pack content (or a typo). Resolving is right for the first and
    // survivable for the second — the asset either loads because it was in main all along, or
    // fails in the loader's own best-effort catch. Throwing here would turn a manifest typo
    // into a boot failure on the one platform that has no reload button.
    p = def ? loadPack(def.name, def.root) : Promise.resolve();
    inFlight.set(name, p);
  }
  return p;
}

async function loadPack(name: string, root: string): Promise<void> {
  const host = getAssetHost();
  if (!host.loadPack) return;
  try {
    await host.loadPack(name, root);
  } catch (err) {
    // Best-effort, exactly like every art preload: a subpackage that will not download leaves
    // its consumers on their Graphics fallbacks rather than failing boot (design/02/12,
    // "gameplay is never blocked on art").
    console.warn(`subpackage '${name}' failed to load; its art falls back to placeholders`, err);
  }
}

/**
 * A whole phase's packs, in parallel, with `onEach` called as each one settles.
 *
 * `onEach` exists for the progress screen (`game/ui/loadingScreen.ts`) and is the honest
 * granularity available on both platforms: one tick per pack. WeChat's `wx.loadSubpackage`
 * returns a `LoadSubpackageTask` whose `onProgressUpdate` would give real bytes, but that is
 * not in this repo's `wx.d.ts` and has never been exercised on a device — see design/12's
 * "What this does NOT claim". A pack that fails still ticks: `loadPack` swallows the error, so
 * a dead download must not leave the progress bar short of the end forever.
 */
export async function ensurePacks(defs: readonly PackDef[], onEach?: () => void): Promise<void> {
  await Promise.all(defs.map((d) => ensurePack(d.name).then(() => onEach?.())));
}

/** Every declared subpackage, in parallel — the pre-phase "everything, now" path, still used
 *  by `preloadCoreArt`. */
export async function ensureAllPacks(): Promise<void> {
  await Promise.all(SUBPACKS.map((s) => ensurePack(s.name)));
}

/** Drops the memo table. Tests only — the map would otherwise leak a resolved promise from
 *  one test's fake host into the next test's assertions about what was loaded. */
export function resetPackLoader(): void {
  inFlight.clear();
}
