# Work log — 2026-09-07: the backend goes live, and then gets tested

Volume 40. No engine change. Two entries about the same layer from opposite sides: the
deployment that made `bb.gamestao.com` real, and the tests that were missing under it.

Indexed from [`../ROADMAP.md`](../ROADMAP.md).

## The three planes go live on a borrowed box (2026-09-06/07, server + CI + docs, no engine change)

*Recorded retroactively on 2026-09-07 from the commits, `design/19-server-platform.md` §9 and
`server/deploy/README.md` — this pass shipped, updated the phase spine (ROADMAP 9.0 🔴 → 🟢) and
both docs, and never wrote its work-log entry. The entry is here so the date and theme indexes
stop having a hole where the whole deployment is.*

ROADMAP 9.0 was found on 2026-09-05 while writing Phase 9's setup steps: a Paddle webhook is a
server-to-server POST to a public HTTPS URL, and this project had no server deployment of any
kind. That outranked the credential question, because no credential can be exercised without an
address to send it to.

`gameserver`/`matchsvc`/`billsvc` now run as three containers from one image
(`server/Dockerfile` + `server/docker-compose.yml`, process selected by `command:`) on the same
company VPS and Cloudflare zone the sibling project's backend uses, behind the same Caddy
instance — one appended site block — at the new subdomain `bb.gamestao.com`. The client points
at it by default (`client/src/game/runState.ts`).

**The one thing the design section had not anticipated is why there is a build step at all.**
This server imports live TypeScript from sibling workspaces through tsconfig path aliases
(`@dd/engine`, `@dd/game/*`, `@dd/net/*`), not published packages, so the sibling project's
rsync-and-run approach would have meant shipping the whole monorepo to the VPS and running
`npm ci` there. `server/scripts/build.mjs` esbuild-bundles each entrypoint into one flat ESM
file instead, resolving those aliases at build time; `ws` and `node:sqlite` stay external, and
the image installs `ws` from a nine-line `server/deploy/package.json` of its own.

CI deploys it: `.github/workflows/server-deploy.yml` builds the bundles and pipes a tarball over
SSH to a key registered with a **forced command** (`command="…/wnet-test-ci-deploy.sh",restrict`),
so whatever that key asks sshd to run, sshd runs only the deploy script. The live copy of that
script sits OUTSIDE the deploy target on purpose — installed inside it, a deploy could replace
the script and the constraint would be gone — and it moves five things, never
`.env`, so the ticket secret and the internal key are beyond this key's reach.

> **Correction, 2026-09-07 (volume 42).** As written, this paragraph also said the script never
> moves `docker-compose.yml`, and argued from that the key cannot ship a compose file
> bind-mounting the host's `/` into a container. **That was false when written**: the script has
> always copied `docker-compose.yml`, and `deploy.manifests.test.ts` asserts it is in the
> payload. The capability is real — it is also what let the `backup` worker deploy itself as a
> new service — and it is now named in `deploy/ci-deploy.sh`'s own header, with its bounding
> facts and the exact change to revoke it. Corrected here rather than rewritten away, because
> the wrong sentence was about a security boundary and a reader would have relied on it. Success is defined as each container answering its
own `/health`, not as the command returning 0.

Everything on the box is named `wnet-test` rather than after this game: it is company hardware
borrowed for idle capacity, and the whole footprint tears down with
`docker compose down && rm -rf ~/wnet-test`. **billsvc runs in dev-stub mode** — no Paddle
credential exists yet, and `startupGuard.ts` refuses that flag under `NODE_ENV=production`
outright, so the compose block runs it as `development` and reaches nothing but matchsvc.

`net` `platform` `docs`

## The deploy layer gets tested (2026-09-07, server tests + build script, no engine change)

Asked in one line — *"服务器部分有测试可以加吗"* — and the interesting part is what the answer
turned out to be. `server/src` measured **99.56% lines / 97.93% branches** over its whole tree,
and reading the 27 uncovered branches one by one, almost all of them are defensive arms a nearer
guard already shadows: `Matchmaker`'s `if (!w)` / `if (q)`, `MatchRoom.kickSeat`'s `if (!seat)`.
Writing tests for those means poking private state, and pins nothing.

**The gap was everything the pass above shipped.** Five files — `scripts/build.mjs`,
`Dockerfile`, `docker-compose.yml`, `deploy/package.json`, `deploy/ci-deploy.sh` — none of them
imported by anything under `src/`, none of them reachable from a single test, all of them plain
text to `tsc`, and all of them outside `coverage.include` (`src/**`), so no percentage could ever
have moved to say so. The artifact that runs in production is not the code the suite tests: it is
three esbuild bundles in a container. That is now design/18-test-strategy.md's **Layer 6**.

**`deploy.bundle.test.ts` (6 cases, ~600 ms) boots the real artifact.** It builds into a scratch
directory in the OS temp tree — never `server/dist`, which is a live deploy artifact — and then
links in ONLY what `deploy/package.json` declares, standing in for the image's
`npm install --omit=dev`. That placement is the half that makes the test worth running: Node's
upward `node_modules` walk from a bundle in the temp tree finds nothing of this monorepo, so a
bundle reaching for anything the deploy manifest does not list fails there exactly as it would in
the container. The first draft got this wrong in the informative direction — building into a
temp dir with no `node_modules` at all, which failed with the production `ERR_MODULE_NOT_FOUND`
and made the shape of the fix obvious. Each bundle is then started as a bare `node` process and
must answer its own `/health` with its **own service name**; `{ok: true}` alone would wave
through a mis-mapped entry in `build.mjs`, which is one typo. Proven by deleting `ws` from
`deploy/package.json`: two of the three boots go red, with the container's own stack trace in the
failure message, which for this class of bug IS the diagnosis.

**`deploy.manifests.test.ts` (15 cases, ~180 ms) cross-checks the five files against each other
and against the code.** Bundle names must agree across `build.mjs`, compose `command:`, the
forced command's payload check and the workflow's `tar` list; the deploy manifest must declare
exactly the non-builtin externals, each pinned to an exact version (a range means the deployed
bytes can change without a commit, which is what makes a rollback meaningless); the base image's
Node major must be at least `build.mjs`'s `target`; every compose env var must be a name `src/`
actually reads; neither credential may be inlined where `env_file: .env` is the mechanism; each
service must expose and healthcheck **its own** port; and every internal `http://` URL must name
a real service at the port that service listens on, while `BB_GAMESERVER_URL` must be the
`wss://` public address and must NOT resolve to a container.

Two of those are the ones a percentage could never reach. A **renamed env var** leaves compose
quietly passing a value nobody reads while the process runs on its default — code correct, tests
green, deployed configuration inert. It is also exactly the failure design/19 §9 already recorded
from the sibling project (*"a value written into an env file is not a value the process can
see"*) and left as a thing to design against; that sentence ended *"this project has no deploy
mechanism yet"*, and is now updated to point at the test. A **copy-pasted service block** leaves
a healthcheck polling its neighbour's port, which reports a dead container healthy — worse than
having no healthcheck.

**`build.mjs` was refactored to be readable by a test** rather than re-typed into one: it exports
`entries` / `external` / `target` and a `buildAll(outdir)`, and only builds when run directly, via
the same `process.argv[1] === fileURLToPath(import.meta.url)` guard `src/index.ts` and
`src/matchsvc.ts` already use.

**The compose reader is hand-rolled and therefore guarded.** Adding a YAML parser to a workspace
with two runtime dependencies, to read one file it already ships, was the worse trade — but a
regex reader's failure mode is matching NOTHING after a reformat and passing every assertion over
an empty set. The first `describe` in the file exists only to fail in that case: exactly three
services, each with a two-element `command`, ≥3 env vars, one exposed port, a `/health`
healthcheck and `env_file: .env`.

**The billing guard is tested from the deployed side, with its control.** The compose file's
billsvc env block is fed to the real `assertBillingStartupSafety`, and a second case asserts the
same env flipped to `NODE_ENV=production` throws. Without that control the first case passes just
as happily against a guard that never throws at all.

**Four branch cases in `src` were worth adding, and three were not.** Added: a disconnect BEFORE
launch (stops no clock that was ever started, and still destroys the abandoned room); a `resume`
into a room that never lost anyone (which calls `startMetronome` a second time — asserted through
the frame counter, because a doubled interval means every client receives the match at double
speed, and that is the symptom that reaches players); an integrity kick against a seat that
dropped before the vote completed; and a kick that takes the room's last connection. Plus one in
`BotClient`: a bot torn down before its match ever starts. All five were mutation-checked, and
four mutants — the already-running metronome guard, `kickSeat`'s already-gone guard, and both
destroy-when-empty arms — died.

Not added, and now commented in the source instead: `startMetronome`'s `!connected` arm and
`kickSeat`'s phase check are unreachable because every caller already gates on the same condition,
and `BotClient.tick`'s guard needs a tick already in flight past a `clearInterval`. One correction
came out of the mutation run: that last guard is **not** load-bearing (Node's `clearInterval`
tolerates a null handle, so deleting it keeps the new test green), so the test's comment says what
it actually pins — the teardown — rather than claiming a TypeError it does not prevent.

Server suite 1004 → **1031** across 48 files; `src` branch coverage 97.93% → **98.31%**
(`MatchRoom` 93.25 → 97.75, `BotClient` 87.5 → 93.75). Neither new file adds anything to the
measured tree — they test the artifact and the manifests, which is the point.

**Still open**: nothing here runs Docker. Building the image and starting the compose project
needs a daemon CI would have to provide, and the two properties that actually break — the bundle
resolving everything it imports, and the manifests agreeing — are both reachable without one. A
variable that reaches the VPS's untracked `.env` but not the process is likewise still possible;
nothing tracked can see inside it.

`net` `test` `docs`
