# Project instructions for Claude Code

## Branches, the daily branch, and pull requests

Adopted 2026-09-10 from the sibling project `funny` (its `CLAUDE.md` "分支与提交" plus
`claudedocs/worktrees.md`). Three rules, and the first one is the whole point:

1. **Never commit to `main` directly. `main` only ever advances through a merged PR.**
   Enforced server-side by the repository ruleset **"Only PR"**
   (github.com/bigtaoo/blightbloom → Settings → Rules): no deletion, no force-push, a PR
   required (0 approvals — the PR exists for CI and for the diff, not for a reviewer), and
   the four `check.yml` jobs — `logic consistency`, `check`, `coverage`, `sims` — required
   and **strict** (the branch must be up to date with `main` before it can merge). Repo
   admins carry an always-on bypass so the repo can never lock its owner out; treat that as
   a fire escape, not a door. Using it silently is how the gate becomes decorative.
2. **Integration goes through a daily branch named `DD.MM.YYYY`** (e.g. `10.09.2026`), never
   straight from a task branch into `main`. The shared checkout `D:/daydayup` is pinned to
   the *current daily branch*, not to `main` — a session that finds it on `main` should
   check out (or create) today's branch off `origin/main` before doing anything else.
   Task work still gets its own worktree + branch (`.claude/worktrees/<slug>` on
   `feat/<slug>`, branched off the daily branch) and merges back `--no-ff`; a small
   doc-level fix can be committed straight onto the daily branch in the shared tree.
3. **One PR per daily branch, `<DD.MM.YYYY>` → `main`, opened early.** `check.yml` only
   triggers on `pull_request` and on pushes to `main`, so until the PR exists the daily
   branch is running no CI at all — open it with the day's first push, not at the end.
   Title and body in English like everything else here (see "Language policy"). Merge it
   when the four checks are green; a red check is the answer, not an obstacle to route
   around. Merging is also what deploys — `client-deploy` / `server-deploy` and friends
   trigger on push to `main`.

```bash
git fetch origin && git switch -c 10.09.2026 origin/main   # start the day
git worktree add -b feat/<slug> .claude/worktrees/<slug> 10.09.2026
git merge --no-ff feat/<slug>                              # task branch → daily branch
git push -u origin 10.09.2026
gh pr create --base main --head 10.09.2026 --title "..." --body "..."
```

Reusing a daily branch that has already been merged: fast-forward it first with
`git branch -f <DD.MM.YYYY> origin/main` (from a checkout that is not sitting on it) or
`git pull --ff-only`, so the next PR's diff is the new work only. Local `main` is a mirror
of `origin/main` and nothing else — never commit onto it, refresh it with
`git fetch origin && git branch -f main origin/main`.

## "结束任务" (end task) command

When the user says **"结束任务"**, run this exact sequence, in this exact order:

1. **Update docs and memory first** — design/NN docs, `ROADMAP.md`, README status boxes
   for whatever the task actually shipped, plus the persistent memory system, so both
   describe the final shipped state, not a mid-task snapshot.
2. **Merge the code to the daily branch `DD.MM.YYYY`** — not to `main`, which is PR-only
   (see "Branches, the daily branch, and pull requests"). If the session's work happened
   on a branch/worktree, bring it onto the daily branch now (`git merge --no-ff`, or a
   cherry-pick where that is cleaner; run the full test suite + `tsc --noEmit` after).
   Create the daily branch off `origin/main` if the day has none yet.
3. **Clean up worktree and branch** — once step 2 is confirmed merged (verify with a
   real content diff against the daily branch, not just `git log`, since a cherry-pick
   produces a new commit SHA even after the content is fully merged), remove the
   now-redundant worktree and delete the branch.
4. **Commit last** — the final commit should capture the fully-merged, fully-cleaned-up
   state, not an intermediate one.
5. **Push, and open or update the day's PR into `main`** — `git push` the daily branch,
   then `gh pr create --base main --head <DD.MM.YYYY>` if the day has no PR yet (English
   title and body). Report the PR link and the state of the four required checks. Merge it
   once they are green; if any is red, leave the PR open and say which one, rather than
   reaching for the admin bypass.

If any step finds nothing to do (e.g. no unmerged branch exists, or the day's PR is
already open and green), skip it silently rather than asking. Treat "结束任务" as a
distinct trigger phrase from an ordinary "commit this" or "merge this" request — it means
run the full five-step sequence, not just whichever single step the wording most
resembles.

## Code organization: 500-line file convention

Source files (excluding tests and generated output) should stay at or under 500 lines.
This is a **baseline-drift gate, not a hard cap** — files already over the limit are
tracked as backlog, not blocked on — but design new files to stay under it, and shrink
known offenders over time rather than let them grow further.

When a file does need to be split, pick a form in this priority order — a linear
inheritance chain is the fallback, never the default, and this order applies to new code
too, not just to splitting up something that already got too big:

1. **Independent function modules (preferred).** If the file is really a set of
   independent functions, or an if/else dispatch chain with no shared private state
   (a content table, a router, a batch of pure helpers), split by operation/domain into
   sibling files of free functions. Zero inheritance, zero ceremony.
2. **Independent classes + composition (default for a single class that's grown too
   big).** First count the cross-boundary `this.foo()` calls across the proposed split.
   A short, countable list (rule of thumb: fewer than ~10) means composition works: each
   concern becomes its own class whose constructor takes a typed `deps` object (hand-written
   injection, matching the existing style in this repo — **do not** reach for an IoC
   container such as InversifyJS/tsyringe; that solves "how do I wire up the whole app",
   not "how do I split one class"). Where one side only needs a handful of the other's
   methods, narrow that dependency to a small interface declaring just those methods
   rather than depending on the whole concrete class. A genuine **two-way** dependency (A
   calls B *and* B calls A) is a sign the boundary is drawn wrong — merge the two into one
   class, or extract a shared lower layer both depend on; don't reach for inheritance just
   to route around it.
3. **Linear inheritance chain (fallback only).** Only when ②'s cross-call list can't be
   enumerated — most methods reach across the proposed split — fall back to
   `class B extends A {}` as a mechanical, behavior-preserving split. This has a real
   cost: fields shared across the chain have to widen from `private` to `protected`,
   chain order becomes an implicit constraint, and it does nothing to stop the top-most
   (largest) layer from growing again on its own. Treat it as deferring the problem, not
   solving it.

Practical rules once a file is split:

- Sibling files may import each other or be imported by the assembly shell that
  re-exports them — never the other way around (the shell importing a sibling that
  imports the shell back is a cycle).
- Give each split-out file a one-line header comment naming the split and its
  responsibility.
- If anything outside the module imports the original path, keep that path alive as a
  thin re-export shell (`export * from './xxx/yyy'`) so the split is invisible to callers.

**Enforcement**: `build/checkFileLength.mjs`, driven by each workspace's
`scripts/file-length-baseline.json`. It's a drift check, not a blanket gate — it fails
only if (a) a file *not* already in the baseline crosses 500 lines, or (b) a file already
in the baseline grows past its recorded line count. Run it via `npm run check:filelength`
inside a workspace, or `npm run check:filelength --workspaces --if-present` from the repo
root (also folded into the root `check` script, after `typecheck` and before `test`).
Shrinking a baselined file back under the limit doesn't require touching the JSON — the
script reports it as a non-blocking notice — but delete the stale entry when you do.

This mirrors the convention adopted in the sibling project `funny`
(`claudedocs/server.md` / `claudedocs/client-modules.md`, "单文件 500 行收敛"), scaled
down for this repo's smaller codebase.

## Test coverage: 90/90, over the whole tree

Coverage is measured and gated (2026-09-03). **90% lines AND 90% branches** for `client`,
`engine` and `server`, each over its **whole** source tree — there is no exemption list and no
per-package override, on purpose: a working way to be exempt is an invitation to use it.

```bash
npm run coverage      # measure all three, print the report, run the gate
npm run check:logic   # the 12 named logic-consistency gates, verified then run
```

`npm run coverage` is **not** part of `npm run check` — it is minutes, not seconds. CI runs it
as its own job on every push and pull request, alongside `logic`, `check` and `sims`.

Three things to know before touching any of it:

- **Branches are gated too, and that is the column that bites.** Uncovered branches are the
  absent-field fallbacks, the refusal paths and the lost-race arms — code whose *line* runs on
  every call while only the taken side is ever exercised. `server/src/MatchRoom.ts` read
  99.08% lines / 83.14% branches with every trust boundary in it untested.
- **Never narrow `coverage.include`.** The gate's `scopeShrunk` rule fails a scope smaller than
  the source tree, and `build/coverageScope.test.mjs` fails an include entry that names an
  individual file. Both exist because narrowing raises every number without adding a test:
  scoping the client to `src/game/**` reports 97.68%/92.13% — both green — over 130 of 224
  files.
- **A percentage cannot keep the pure layer pure.** `client/src/game/pureLayerBoundary.test.ts`
  does that: the modules it lists may not reach a browser-dependent module or touch a browser
  global. At ~96% the gate has hundreds of lines of headroom, so a file importing PIXI can land
  in the pure layer with nothing turning red — and what that costs is the ability to test the
  logic at all.

`design/18-test-strategy.md` "Layer 4" has the full account, including why functions is
reported but deliberately not gated.

## Language policy

- All code, code comments, and documentation in this repository must be written
  in English — no exceptions for design docs, READMEs, or inline comments.
- Commit messages, and PR titles and bodies, must be written in English.
- The only non-English content allowed anywhere in the repo is translation/localization
  data itself (i18n locale files, e.g. `zh.json`) — content whose entire purpose is to
  hold a non-English translation. English is the source-of-truth locale that all other
  locales key off of / translate from.
- This applies to new content going forward; it does not retroactively require
  rewriting existing non-English comments unless you're already touching that file.
