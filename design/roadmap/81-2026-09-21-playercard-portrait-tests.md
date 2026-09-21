# Work log — 2026-09-21

Volume 81. See [`design/ROADMAP.md`](../ROADMAP.md) for the index and the phase spine.

## The branch the test environment hid: the HUD card's portrait (2026-09-21, client + test, no engine change)

The follow-up [volume 80](80-2026-09-21-loadout-forge-split.md) named and deferred: *“`ui/PlayerCard.ts`
has the identical hole and its own task.”* Same defect, the other screen — the loadout's 104 px
portrait got its tests there, the HUD card's 44 px one gets them here.

### A 90/90 gate cannot see a branch the environment decides

`PlayerCard.bindPortrait` has two halves. One binds the character's rig `shell` texture into the
frame — contained, centred, above the frame and below the text. The other draws a teal disc when
the art is missing, because art is best-effort everywhere in this codebase (`design/02`/`12`).
**Only the second had ever executed in a test**, and not because anyone chose to skip the first:
under plain vitest there is no asset pipeline, so `getRigSkin` answers `undefined` for every key
ever passed to it. The file's one portrait case says so in its own title — *“survives a skin id
with no registered art.”*

This is the mirror image of [volume 75](75-2026-09-17-account-test-gaps.md)'s shape, and worth
naming as a pair:

| | what the test runs | what ships |
| --- | --- | --- |
| volume 75 | the injected fake | the implementation, never executed |
| here | the real dependency, **answering its failure value** | the success path, never executed |

Volume 75's version is a decision someone made once (pass a `fakeStore`) and can find by grep. This
one is made by the *runner*, silently, for every test in the file and every test anyone adds later
— and it selects the unhappy path, so what goes unexecuted is the branch **every player sees on
every frame of every run**. Neither is visible as a percentage: the lines in question run, with
only the taken side exercised, which is exactly the column `design/18` Layer 4 says bites.

The fix is the same one `scene/Skin.test.ts` established and volume 80 reused: mock
`render/skinRegistry` with `vi.hoisted`, in the `importOriginal` form so the module's other exports
survive, and hand `getRigSkin` a map keyed by `atlasKey`. Empty by default, so every other case in
the file keeps meeting the no-art state.

### What ten cases pin, and why each is a claim rather than a restatement

- **Contain, not stretch**, on **both** arms of the `Math.min` — a 80×40 texture and a 40×80 one.
  The assertion is `scale.x === scale.y` *and* the magnitude, so neither a per-axis fit (0.45 by
  0.9, which squashes the character 2:1) nor a `Math.max` survives. Measured against the box the
  card actually draws: the long side lands on the 36 px inner edge, the short one stays inside it.
- **Child index 1.** At 0 the frame paints over the face; appended, the face paints over the name
  and all three bars. The test asserts the index *and* the two neighbours that give it meaning —
  the frame below, the first `Text` above.
- **The re-bind on a character change is two claims, not one**: the texture swaps, *and* the fit is
  recomputed. A `bindPortrait` that only reassigned `texture` on an existing sprite keeps the old
  character's scale and draws the new art at the wrong size.
- **An ally or seat whose art is missing drops back to the disc** rather than keeping the previous
  character's face — the case that would otherwise put the wrong person in the HUD.
- **The lookup goes through `atlasKey`, not the skin id.** Pinned by a lookup log rather than by
  the outcome, which also lets the `lastSkinId` cache be checked by *calls* — an identity cache
  that stopped caching would still hand back the same sprite object, so object identity cannot see
  the defect and a call count can.

### The mutation battery, and the one that survived

Eleven mutations, all eleven killed: stretch-instead-of-contain (2 red), `Math.max` (3), index 0
(1), append (1), drop the texture re-assign (1), skip the refit (1), uncentre (1), drop the
`lastSkinId` guard (1), keep the stale sprite (1), look up by skin id (9), drop the
`fallback.clear()` on the bound side (1).

The last one **survived the first pass, and the test was at fault rather than the mutation being
equivalent.** The assertion — *no disc left painted under real art* — sat on a freshly constructed
card, where the constructor has never drawn a disc, so `clear()` was a no-op and the expectation
held with or without it. It is the shape already on the books (an assertion about an absence that
was never a presence), arrived at from a new direction: the precondition was not missing from the
fixture, it was missing from **the order the two `set()` calls were made in**. The test now goes
through an unarted character first, which is the only path on which a placeholder can actually be
left under a portrait — a real defect, and an invisible one, since the disc is inset well within
the portrait and would read as a tint on the art rather than as a stray shape.

### Numbers

- Client **7,067 → 7,077** tests green (300 files), measured on the merged tree with volume 80
  present — both numbers from the same suite, rather than a before from this branch's older base.
- Coverage, `npm run coverage`: client **98.06% lines / 93.86% branches**, up from volume 80's
  97.98 / 93.80; engine 97.71 / 93.77 and server 98.63 / 97.73 untouched. All three green.
- No production file changed. No `ENGINE_VERSION` bump — nothing in `@dd/engine` was touched.
- `check:filelength`, `check:docpaths` and `check:roadmapindex` clean; `tsc --noEmit` clean for
  `client`/`engine`/`server`.

### Still open

`AllyRow` lives in the same file and has no portrait at all — the teammate is an icon, a name and a
bar. Giving it one is a design question (the row is 24 px against the card's 56), not a test gap,
and nothing here assumes an answer.
