# Work log — 2026-10-15

Volume 145. See [`design/ROADMAP.md`](../ROADMAP.md) for the index and the phase spine.

## The first download, measured and cut (2026-10-15, client + art + build + test + docs, no ENGINE_VERSION change)

> 好的，你参考standing和funny项目，处理首包的加载大小问题

The ask followed the question of whether the game is ready for a CrazyGames basic launch. A
portal judges a game on its first wait, and nothing in this repo measured it: the WeChat
package check (`checkWeChatPackage.mjs`) budgets each asset pack, but it reads
`client/public`, so it cannot see the code at all, and it does not say which bytes a web
player waits on. Of the two reference projects, `funny` had the useful piece, a shipped-size
gate over its real build (`client/scripts/checkBundleSize.mjs`). `standing`'s only size check is a
per-package WeChat budget (`build/checkWeChatPackage.mjs`), which this repo already has.

**Measured first, against `npm run build:crazygames`:**

| | before | after | budget |
| --- | --- | --- | --- |
| `entry.brotli`: entry + modulepreloads, brotli q11 | 305.2 KiB | 305.3 KiB | 350 KiB |
| `lobby.wait`: `main` + `lobby` phase art | 858.5 KiB | 836.0 KiB | 1000 KiB |
| — of which awaited behind the splash (uiSkins `boot`, en) | 418 kB | 338 kB | (uiSkins.test.ts) |
| `run.wait`: `run` phase art, awaited on the first Play | 4258.4 KiB | 2548.7 KiB | 3000 KiB |
| `dist.total`: the upload | 9862.3 KiB | 8130.3 KiB | 9500 KiB |

The code was not the problem. It is already split as far as this repo allows (design/12: no
JS code-splitting, since some targets cannot load code at runtime). The run wait was the problem:
110 rigs, weapons, environment fixtures and UI icons shipped as RGBA PNG.

**1. Palette quantisation, under a bar that already existed.** The lobby set had been
quantised on 2026-09-28 (libimagequant, dithering 1.0) and the owner had accepted how it
looked. `tools/png-pipeline/quantize.py` applies the same encoder to every RGBA PNG in
`client/public`. Each file has to pass a bar before it is rewritten: composite old and new
over three dark backdrops, take the per-pixel max-channel difference, keep the worst
backdrop's mean and p99. The bar is mean ≤ 2.93 and p99 ≤ 14, the worst reading inside the
lobby set the owner accepted, so no file gets a per-file taste call. 110 files pass. 8 do
not: the four elemental swords, the skirmisher's shell and belly, and two UI icons, all with
fine gradients or thin glints that band in 256 colours. They stay RGBA, as does the door
curtain (owner's call, design/12 2026-09-01b). A 2–3× contact sheet of the ten worst-scoring
passes showed no visible difference.

**2. One logo at boot, not two.** The awaited `boot` tier carried both the English and the
Chinese logo, so that a language switch never waited. On the web the locale is known before
the art loads (`persistedLocale()`), and on CrazyGames it never changes after boot.
`preloadLobbyArt(onProgress, locale)` now calls `setBootLocale`, and `uiTierOf` puts the other
language's logo in the `lobby` tier: it is still fetched, just not awaited. `MainMenu` already
re-lays itself out when a `lobby` texture lands, so a switch to the other language shows its
logo one fetch later. The awaited boot drops from 418,048 to 338,252 bytes (en).

**Three gates, so none of it can silently come back:**

- `build/checkBundleSize.mjs` (`npm run check:bundlesize`), ported from `funny`. It reads
  the built dist (post-minification, post-hash) and checks the four numbers above against
  absolute budgets in `build/bundle-size-budget.json`, each with a written reason. They are
  not ratchets, since bytes move on every dependency bump. It fails on an unbuilt tree, on a
  chunk `index.html` names but the build did not emit, and on a pack phase it does not know,
  so it never reports zero for something it could not measure. It needs a build, so it is
  exempt from `npm run check` (`checkScriptChain.test.mjs` records why), and CI runs it in
  the `check` job after `build:crazygames`.
- `client/src/render/shippedPngFormat.test.ts`: every shipped PNG must be palette (IHDR
  colour type 3) unless it is in a nine-entry allowlist with a reason. Stale entries fail
  too. This is the gate that matters day to day. `compress.mjs` re-encodes to RGBA, and
  freshly exported art lands as RGBA, each at about 3× the bytes with every other test still
  green. Control: putting one icon back to RGBA turns it red, naming the file.
- `uiSkins.test.ts` / `preloadArt.test.ts`: the boot tier holds exactly one logo, and its
  bytes drop by exactly the other logo's size. `preloadLobbyArt` with a locale resolves
  without the other logo and still fetches it. Control: dropping the `setBootLocale` call
  turns it red.

**Found on the way:** `wallComposition.test.ts` inflated PNG rows by hand and assumed RGBA,
so it broke on the first palette swatch. It now reads through `decodePNG`, which has handled
colour type 3 since 2026-09-28.

**Still open.** `entry.brotli` is now the largest single wait in front of the menu, and the
lever there is the architectural one design/12 already recorded ("the first download
itself": `@dd/engine` cannot leave the first chunk while `runState.ts` imports it). The
budgets are local measurements. Wire time on a real portal page is unmeasured, and so is a
cold load on the CrazyGames QA tool.
