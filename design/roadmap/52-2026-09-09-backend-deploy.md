# Work log — 2026-09-09 → 09-10

Volume 52. See [`design/ROADMAP.md`](../ROADMAP.md) for the index and the phase spine.

## The deploy that reported success three times while nothing changed (2026-09-09, deploy + server + docs, no engine change)

Volumes 47–50 built the observability stack, analytics, the ops console and client flag
delivery, and left all of it unpushed. This is the deploy: `main` was seven commits ahead of
`origin/main`, and a push deploys client and server. Nine containers now run on the borrowed
VPS, and every row of [`server/deploy/README.md`](../../server/deploy/README.md) §4 has been
walked against the live host.

What is worth writing down is not that it landed. It is that **three separate things reported
success while having done nothing**, and each one had a different mechanism. The runbook
predicted one of the three, named the right symptom, and pointed at the wrong cause.

### The two hand steps were right, and there was a third nobody had written down

§2's two hand steps — `BB_ADMIN_PASSWORD` into `~/wnet-test/.env` (compose's `:?` refuses
*every* service without it), then a `handle /admin*` block ahead of the catch-all — were
correct and sufficient as written. Reading `~/wnet/docker/Caddyfile` first was also right:
a `bb.gamestao.com` block was already there from volume 47, so the snippet's append would
have produced a duplicate.

The third step is the one that matters, because skipping it is silent in the direction that
costs data. `ci-deploy.sh`'s live copy at `~/wnet-test-ci-deploy.sh` is **hand-installed by
design** — the CI key must not be able to rewrite its own forced command — so editing the repo
copy does nothing, and CI going green is not evidence the new check ran. The live copy predated
adminsvc entirely: no `dist/adminsvc.mjs` in the payload check, no `data/adminsvc` in the
ownership loop, no `adminsvc:8790:/admin/health` in the health loop. Deploying with it would
have let compose create that bind-mount source `root:root` and reproduced 2026-09-08's
eighteen hours of silent backup failure, with CI reporting success both times.

This is the same shape 2026-09-08 already recorded — a guard that existed only in the repo —
and it recurred nine days later on the same file. The standing `diff` check is the whole
defence:

```bash
ssh wnet-server 'cat ~/wnet-test-ci-deploy.sh' | diff - server/deploy/ci-deploy.sh && echo IN-SYNC
```

Install with `tr -d '\r'`. `core.autocrlf=true` and no `.gitattributes` means every shell
script in this repo is CRLF in a Windows worktree and LF in CI, and a CRLF script dies on the
box with `$'\r': command not found`.

### Failure 1 — the ownership loop could fix a state dir but not create one

The first deploy died at `mkdir: cannot create directory '/home/tao/wnet-test/data/adminsvc':
Permission denied`. `~/wnet-test/data` is uid-1000-owned — container `node` (1000) equals host
`elkadmin` (1000) on this box — while the account CI logs in as is 1001. So the deploy user
cannot create anything under `data/` at all.

It had never shown up because **`mkdir -p` is a silent no-op for a directory that already
exists**, and every directory did, for as long as the set never grew. The first new one broke
it. Fixed by moving creation into the root container that was already there for the chown, and
only on that path — `backups` sits at the top level, which the deploy user owns, so its plain
`mkdir` succeeds and no wide mount is ever taken for it.

Loud, at least. This is the good half: the check that had been added to the script for
adminsvc is what turned a silent `root:root` mount into a failed deploy.

### Failure 2 — a failed backup cycle was a 24-hour decision

The second deploy died at `wnet-test-backup: no healthy backup cycle within 15s`. The worker's
first cycle runs immediately at boot, which is what gives a fresh deploy a verified snapshot in
seconds. It also **races the services that create the databases it reads**: it ran 0.6s before
matchsvc created `analytics.db` — a *new* third backup source, from volume 48's retention
instrumentation — recorded the source as failed, and then slept the full 24-hour interval.

One lost race by half a second cost a day of snapshots and failed every deploy, because
`ci-deploy.sh` demands a healthy cycle. A failed cycle now retries from a 60-second floor,
doubling to the interval: the immediate cycle keeps its purpose without that one attempt being
decisive, and a permanently broken source degrades to one attempt per interval — the old
behaviour, reached rather than assumed.

**Making `retryDelayMs` pure and testing it was not enough**, and that is the transferable
part. Reverting the loop body to `sleep(cfg.intervalMs)` leaves every one of those cases green
while restoring the exact bug. So `runForever` took a `LoopDeps { now, io, sleep }` seam and the
test *is* the thing the loop waits on — it drives a source that fails once and then succeeds,
and asserts the delays in order. Verified by control run: the two loop tests go red against the
reverted loop, the pure ones do not.

### Failure 3 — the Caddyfile edit that `validate` and `reload` both confirmed

`/admin/` came back as `{"error":"not found"}` — byte-identical to matchsvc's catch-all 404,
which is precisely the trap §3.4 of [design/21](../21-ops-analytics.md) names and §2 repeats:
*getting the ordering wrong is not an error, it is the console's page answered by matchsvc's
404 handler, a blank page with a 200.* The ordering was right. The block was in the file,
ahead of the catch-all, and the file was validated and reloaded.

`docker inspect docker-caddy-1` says why: the mount is
`/home/tao/wnet/docker/Caddyfile -> /etc/caddy/Caddyfile`, a single **file**, so it is bound to
that file's **inode** and not to its path. The edit had gone in with `awk … > new && mv new
Caddyfile`, and `sed -i` for a follow-up fix — both of which write a new file and rename it over
the old name. The host path then pointed at a new inode while the container kept the old one.
And so:

- `caddy validate --config /etc/caddy/Caddyfile` read the stale inode and printed
  **Valid configuration**,
- `caddy reload --config /etc/caddy/Caddyfile` reloaded it and logged `adapted config to JSON`,
- and the route never existed.

Every command reported success and the config never changed. The only check that actually
proves a Caddyfile edit reached Caddy is comparing the two inodes:

```bash
ssh wnet-server 'stat -c "host %i" ~/wnet/docker/Caddyfile
  docker exec docker-caddy-1 stat -c "container %i" /etc/caddy/Caddyfile'
```

So **edit in place and keep the inode** — `cat >>` (which is what §2's own snippet does, and
why volume 47's Grafana block worked) or `cp new Caddyfile`. Never `mv` over it, never `sed -i`.

Recovery has a wrinkle worth keeping: the mount is `:ro` inside the container, so you cannot
write back through it, and the replaced inode has no name left on the host — there is nothing
to repair. Routing was restored with zero downtime by `docker cp`-ing the good file to a
writable path in the container and `caddy reload --config /tmp/… --adapter caddyfile`. That
leaves the in-container path stale, so the next person reloading from it silently reverts the
block; `docker restart docker-caddy-1` re-resolves the bind mount to the host path and collapses
the split. That restart is the box owner's shared proxy fronting `wnet-mock.elk.de`, the
IP/hostname device block and `sync.gamestao.com`, so it was asked for rather than assumed, then
done and verified — both inodes equal, all four site blocks answering.

**After any reload, curl the neighbours, not just your own site.** A reload replaces the whole
config, and three of the four blocks in it are not ours.

### What the checklist found that the checklist was wrong about

All fifteen §4 rows pass. Two of them could not have.

- The **`cache-control: no-store`** sub-row asked for `curl -sI`. matchsvc routes on
  `req.method === 'GET'`, so a HEAD request falls through to the catch-all and returns **404** —
  the very failure that same row calls out three lines earlier as *the one row in this list where
  a 404 is the failure*. Read it off the GET with `curl -sD - -o /dev/null`.
- The **`/admin/health` returns 404** row passes for the wrong reason if read before the row
  above it: a missing `/admin*` block produces an identical 404. The row above is the only thing
  that proves the prefix reaches adminsvc at all, so the ordering is now stated in the file.
- And the row reading *"all three tabs answer"* never learned about the fourth. **Flags** arrived
  with §4 of design/21 and the row that verifies the console did not change, so a missing Flags
  tab was a thing nobody was looking for.

The flag round trip is worth recording as verified end to end, because it crosses every layer
this volume and the four before it built: a value typed into the console's form → `ops.db` →
matchsvc's 60-second poll → `GET /client/flags` → a real browser, rendered above the main menu.
Then cleared, and confirmed gone. The public route exposes exactly two keys while the internal
feed carries all four, which is the partition that keeps `match.pvpBotBackfillDelayMs` — a value
that would tell a player which opponent was not a person — off a public surface.

Two smaller things the pass turned up: Loki's backend label is `source="backend"`, and a wrong
selector returns **no series**, which reads exactly like nothing shipping logs rather than like a
typo. And `ver=` now carries a real build sha on the client stream, so volume 47's follow-up fix
holds in production — the field that was `unknown` for every client, which is worse than absent,
because a constant looks like an answer.

### Tests, and the one that would not have caught anything

Four suites gained assertions. The backup loop's pacing is above; the other three pin
`ci-deploy.sh`, and all three passed every existing assertion in `deploy.manifests.test.ts`
before being written:

- **Creating a state dir.** The existing test pinned *which* dirs get normalised, not that the
  script can make one — a different property, and it was false. Asserted as a shape (no unguarded
  `mkdir`, plus a container-side fallback), because a revert to the bare form is what has to go
  red, and matching the exact command would pin a spelling instead.
- **The health loop.** Port and path are literals there, so a copy-pasted entry polls the
  neighbour's port and reports a dead container healthy — the same failure the compose
  healthchecks in that file already guard, one file over and unguarded. Ports now come from
  compose's own `expose`, paths from the route module.
- **The required-variable set.** Both `:?` credentials were pinned individually; the set was not.
  A third would fail every service with compose's own opaque *"required variable is not set"*
  instead of the script's named explanation — and on an existing box, since `.env` is the one
  file CI cannot ship. Derived from compose, so it holds for a variable nobody has written yet.
  `BB_ADMIN_PASSWORD` was added to both places together; nothing had made that a requirement
  rather than a habit.

Each was control-run: the bare `mkdir`, adminsvc polled on `/health`, matchsvc polled on
billsvc's port, and an unchecked third `:?` variable each turn exactly the intended test red.

**The test that does not exist is the one for failure 3**, and it is worth saying why rather than
leaving a gap that looks like an oversight. The inode trap is a host filesystem operation against
a file this repo does not own and does not ship. The nearest testable thing would be linting the
runbook's prose for `mv`/`sed -i`, which pins wording rather than behaviour. It is recorded in §2
and in memory instead — which is the honest place for a fact no gate can hold.

### One process note

`check` went red once, at `4908cd1`, and not for a reason on the box: a scripted `snapshot` in a
new test omitted `Snapshot.source`. **vitest transpiles without typechecking**, so the file was
green in the runner and red under `tsc --noEmit`. Both local commands had been run — `tsc` before
the tests were added and vitest after — so neither covered the final state. The full
`npm run check` is the only thing that does, and it belongs after the last edit rather than
somewhere in the middle.

### Left deliberately

- **`acc_check_0909` is still the only row in `accounts.db`.** Rows 2 and 5 of §4 need a real
  session, so registering an account was unavoidable. Removing it is a CLI script on the box,
  because neither the console nor the deploy key can write player data — which is decision B1
  working rather than an inconvenience. Recorded in §4 rather than left as a leftover test
  account nobody wrote down, since that is indistinguishable from a real one.
- **`BB_CG_GAME_ID` is still unset**, and matchsvc says so at every startup. Unchanged by this
  deploy; it needs a game id CrazyGames has not assigned.
- **The off-box backup copy** remains §7's open item. The worker verified its snapshots through
  this deploy, on the same disk as the databases.
## `main` stops being a place you can commit to (2026-09-10, repo governance + docs, no code change)

*"把 funny 项目的 main 分支保护，每日分支，开 PR 的规则借鉴过来"* — adopt the sibling project's
branch governance here.

Until today this repo's rule was the opposite one, written into `CLAUDE.md`'s 结束任务 sequence:
finish a task by merging it **onto `main`** and committing there. That is why the whole log above
exists as a straight line of commits on `main` — and why nothing in this repo ever ran CI before
the code was already on the branch that deploys. `check.yml` triggers on `pull_request` and on
pushes to `main`; with no PRs, only the second half was ever reached, so every run was a
**post-mortem**: `client-deploy` and `server-deploy` fire on the same push, and the four gates
(`logic consistency`, `check`, `coverage`, `sims`) were reporting on a commit that had already
shipped. Volume 52's own first half is what that feels like from the inside.

What `funny` does instead, and what is now in force here:

- A repository ruleset named **"Only PR"** on `bigtaoo/blightbloom` — a straight port of funny's,
  same name, same shape: no deletion, no force-push, a pull request required (**0** approvals —
  the PR is there for CI and for a readable diff, not for a reviewer this repo does not have),
  and the four `check.yml` jobs required with the **strict** policy, so a branch must be current
  with `main` before it can merge. The one soft edge is deliberate and copied too: repo admins
  keep an always-on bypass, because a single-owner repo that can lock its owner out is a worse
  failure than an ungated push. It is a fire escape. Using it quietly is how the gate becomes
  decorative.
- **A daily integration branch, `DD.MM.YYYY`.** Task branches (`.claude/worktrees/<slug>` on
  `feat/<slug>`) merge `--no-ff` into the day's branch; the day's branch is what opens the PR
  into `main`. The shared checkout `D:/daydayup` is now pinned to the day's branch rather than to
  `main`, which also removes a hazard this repo has hit repeatedly — the shared tree's branch was
  the deploy branch, so a stray commit in the wrong checkout was a commit on the thing that ships.
- **One PR per daily branch, opened with the day's first push.** Not at the end: the daily branch
  gets no CI at all until the PR exists, so opening it late reproduces exactly the post-mortem
  above one level down. Merging the PR is what deploys.

Three documents record it. `CLAUDE.md` gains a "Branches, the daily branch, and pull requests"
section and its 结束任务 sequence grows a fifth step (push, open-or-update the day's PR, report
the check state, merge when green) with step 2 retargeted from `main` to the daily branch;
`README.md` gains a short *Branching* note under "Getting started"; and the memory file that had
been teaching the old habit — *Worktree & concurrency gotchas*, whose §"Merging YOUR branch to
main…" is the most-followed recipe in it — now opens with the substitution rather than being left
to contradict the instructions.

One gate fired during the change and was right to: `build/checkDocPaths.mjs` rejected the new
citation of funny's `claudedocs/worktrees.md`, which is a real file in a repo that is not this
one. It joins the three sibling-project entries already in that allowlist, with its reason.

**Measured, not assumed.** The change shipped through its own rule: PR
[#1](https://github.com/bigtaoo/blightbloom/pull/1) — the first pull request this repo has ever
had — reported `BLOCKED` from the moment it opened and flipped to `CLEAN` only once all four
gates landed (`logic consistency` 29s, `sims` 54s, `check` 2m32s, `coverage` 2m40s; ~2m40s
wall-clock, which is what the rule costs per merge). Two things that reading the ruleset JSON
would not have told you: the admin bypass does **not** pre-empt the gate — the same account that
holds an always-on bypass still saw `BLOCKED`, because a bypass is something you reach for, not a
state the PR is evaluated in — and the merge itself is the only place `main` moved, so the
daily-branch reuse recipe (`git branch -f main origin/main`, then `git merge --ff-only
origin/main` on the day's branch) is not optional bookkeeping but the thing that keeps the next
PR's diff to the new work only. Both were walked before this paragraph was written.

What this does **not** do is change the language policy or the hook situation: funny hard-blocks
CJK in `git commit` / `gh pr create` command lines with `.claude/hooks/no-cjk-vcs.mjs`, and this
repo has no `.claude/settings.json` at all. The rule ("commit messages, and PR titles and bodies,
in English") is now written down in both repos; only one of them enforces it mechanically.

## The lobby, and the login that was still in flight when the menu went live (2026-09-10, client + docs, no engine change)

*"这个页面是否需要重新设计？对于crazygames或者微信这种自动登录的，应该要自动登录的loading，对于需要登录的，应该是登录页面。然后进入到大厅，大厅里才是关卡，匹配，组队之类的"* — a screenshot of the shipped title screen with **组队** (SQUAD) and **登录** (LOGIN) circled, and a three-part proposal: an auto-login loading state, a login screen where there is no auto-login, and a lobby behind both. Two of the three shipped. The third is refused, and design/16 now says why in its own section rather than leaving the next person to re-derive it.

**What the screenshot was actually showing.** One screen doing three jobs — title card, account entry, mode entry — and the incoherence that follows from it: *"play with other people" had two doors that were never adjacent.* SQUAD sat on the title screen as a peer of PLAY; CO-OP and PVP SOLO QUEUE sat one screen deeper, behind it, on `ModeSelect`. Merging the two screens removes a layer rather than adding one — four screens to a run became three — and the five routes became siblings. `ModeSelect.ts` is deleted, the `'modeSelect'` phase is gone from the union, `MatchmakingReturnPhase` is down to `'menu' | 'squad'`, and the analytics table loses its `mode_select` screen id. The file is still `MainMenu.ts` and the phase is still `'menu'`: the docs call it the lobby, the code calls it the menu, and both places now say so. The routes themselves live in a new composed widget (`ui/LobbyRoutes.ts`), which is CLAUDE.md's split order ② — four cross-boundary calls in one direction.

**The login page is refused, and the reason is not taste.** `design/16` has held "logging in is NEVER required to play" since it was written; a portal forbids a game's own login outright (`docs.crazygames.com/requirements/account-integration` disallows an external login option, a logout that leads back to one, and a login button as a primary call to action); and **the set of hosts that auto-login has exactly one member, which is not the pair the proposal assumed.** There is no `wx.login` in this client and no `POST /auth/wechat` on the server — every WeChat player is a guest, and that correction is now written into design/16 along with what the missing half would take. What replaces a login gate is the account **chip**: identity visible at the front door without being a gate.

**The loading state was the half worth building, and it was hiding an ordering bug.** On the portal, `portalAuth.start()` ran *after* `game.start()` and after the boot splash came down, so the menu was interactive while the silent login was still in flight. That is two problems, and the second one is not cosmetic: quick-play makes the first click start a **run**, and a session landing mid-run drove `OnlineMatch.syncMetaWithSession` into `run.setMeta(remote)` with no phase guard at all — over a `MetaState` whose staged loadout `RunLifecycle.beginRun` had already spent (`setMeta(clearLoadout(...))`), so the account's older blob hands it back. The fix is deliberately two halves, because the gate alone would be a UX change dressed as a correctness fix: `platform/identityGate.ts` holds the splash until the login has an ANSWER — an account or a guest — under a budget of 2000 ms (below `SDK_WAIT_MS`'s 3000 on purpose: that 3 s is only ever spent when the SDK script never arrives, and that case answers "guest" however long anyone waits), and `isHubPhase` defers any sync that arrives outside the between-runs screens to the next return to the lobby (`ScreenNav` calls the flush, injected the same way `connect` already was, so the one-way edge holds). The gate makes the race unlikely; only the guard makes it impossible, and a player who signs in on the portal page mid-session still needs the guard. Boot order is asserted in `portalBuild.test.ts` — where, incidentally, the pre-existing `at('game.start()')` assertion turned out to be satisfiable by a COMMENT mentioning the call, which the new paragraph explaining the old order promptly introduced; anchoring on the statement (`stmt()`) is the repair.

**What the tests could not see, and what found it.** The lobby's first layout put CO-OP and PVP QUEUE side by side at 135px to buy back vertical space. `PVP SOLO QUEUE` draws 169px of label starting 54px in — and the same holds in **seven of eight locales** (Polish `KOLEJKA PVP SOLO` 187, Russian 186; only Chinese fits). `viewportFit.test.ts` sweeps all eight locales at seven viewports and stayed green through every one of them, correctly: it asserts nothing lands outside the design space, and a label spilling out of its button into the gap beside it is still comfortably on screen. Its own header already said to read it as "nothing is off screen, never nothing collides"; this is that sentence collecting. What found it was reading label widths off a running page. Three things came out of closing it:

- The routes are one full-width column, and the height came out of the header and out of a banner that wraps wider (700px) before it wraps taller.
- A companion sweep now measures every lobby label against its own button, **with an icon installed** — because `getUiTexture` answers `undefined` in a unit test, so an un-iconed label centres itself and fits where the shipped one does not. It found two overflows this pass did not cause: German `EINSTELLUNGEN` and Italian `IMPOSTAZIONI` have never fitted the 135px SETTINGS button (now OPTIONEN / OPZIONI).
- And one that this pass would have shipped: **`Button.redraw()` re-centred an icon button's label on top of its own chip.** `setIcon` was the only thing that ever applied the offset, so every later `redraw` — an auto-width `setText`, and the new `setFill`/`setBorder` — silently undid it and drew the label from the middle of the box rightward, off the edge. `LobbyRoutes.setSoloPrimary` calls `setFill`, on the portal build only. Extracted as `layoutLabel()` and called from both.

The one constant that could not be measured in vitest at all is the maintenance banner's headroom: `fakeTextCanvas` charges 0.6em per character, so the worst legal 140-character banner is two lines there and three on a real page. Measured live at 55px, which is what `BANNER_RESERVE` is now derived from — the layout never centres the block so high that an operator's notice would be drawn off the top, and the banner still adds no row, which is the property design/21 §4 depends on.

**Numbers.** 5904 client tests (was 5869), 277 files; `tsc --noEmit` clean; `npm run check`, `check:logic` and `check:filelength` green; coverage 97.59% lines / 93.07% branches on the client, all three packages over the 90/90 gate. Verified in a real browser on the worktree's own dev server (a screenshot of both the default and the portal configuration, and SOLO PvE clicked through to the forge), because the layout half of this is exactly what a green suite is worst at.
