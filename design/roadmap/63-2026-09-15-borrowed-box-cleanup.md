# Work log — 2026-09-15

Volume 63. See [`design/ROADMAP.md`](../ROADMAP.md) for the index and the phase spine.

## Leaving a borrowed box is a second job (2026-09-15, infra + docs, no engine change)

The ask: the game has its own server now, so delete everything the borrowing left behind — and
the interesting part is that the deployment had already been torn down. "The borrowed box is clean" is written
in volume 61, and it was true about the thing it was measuring: no
containers, no volumes, no deploy directory, no site block. It was the wrong measurement.

### `docker compose down` removes the deployment, not the project

A sweep of the machine afterwards found, none of it reachable from a compose file:

| left behind | what it actually was |
| --- | --- |
| `~/db-snapshots/` | two SQLite snapshots of **live account and billing data**, taken by hand before the `display_name` migration |
| `~/obs-*.mjs` ×4 | throwaway probe scripts from the observability bring-up, still naming `obs-loki` / `obs-prometheus` |
| 4 images | the version-pinned `alloy` / `loki` / `grafana` / `prometheus` this stack ran; every other tenant used `:latest` or a different major |
| 124 buildx refs | `~/.docker/buildx/refs/…`, each a JSON line recording this project's build paths |
| 761 MB build cache | the shared builder's, dominated by 13× `COPY dist/*.mjs` and 12× this Dockerfile's `mkdir -p /data /backups` |
| 5 `.bash_history` lines | including the deploy key's whole `authorized_keys` line, pasted three times |
| 5 Caddyfile backups | the host's own `Caddyfile.bak-*`, each still carrying the site block and its upstream container names |

The first row is the one that matters. Everything else is litter; that one is player data on
hardware this project no longer has any claim to, and no teardown step would ever have caught it
because nothing created it — a human did, once, and then the file was done being interesting.

**Two traps in the cleanup itself**, both of which would have damaged a neighbour:

- **The buildx refs directory is SHARED.** 124 of the 215 files there were this project's; the
  other 91 belong to the two co-tenants. `rm -rf` on that directory is the obvious move and it
  destroys their build metadata. The refs are one-line JSON naming a `LocalPath`, so the correct
  filter is `grep -l` on the paths and nothing else.
- **`docker buildx prune --filter description~=…` is accepted and does nothing.** `du` takes the
  same filter and returns a correct subset — a nonsense value matched zero entries, which is what
  made the filter look trustworthy — but `prune` with it reclaimed `0B` three times in a row while
  the matching entries sat in `du`'s output. So the cache is all-or-nothing. A full prune was the
  call: it costs the neighbours one cold rebuild and nothing else, and leaving it would have left
  this project's source layers on the disk indefinitely.

**One thing cannot be removed and should be written down rather than quietly dropped**: every log
line this project's containers wrote between 2026-09-07 and the move is in the box owner's Loki,
permanently. Their collector read the Docker socket unfiltered, this stack could never close that
half (`../19-server-platform.md` §10 has the pair), and a retention policy on somebody else's
store is not a thing to go and edit.

### The disguise changes hands

The second half of the ask — rename the co-tenant to the name this project had been using —
only parses once you look at the box: the co-tenant that moved in after this project left was sitting there under its
own project name, in the open, which is exactly the exposure the neutral name was invented to
avoid. So the name was not retired — it was handed over. Directory, compose project, container,
CI script, key file and installer all renamed, and the Caddy block's comment and upstream with
them.

Two things deliberately did **not** move:

- **The public hostname.** It is a live DNS record with a client pointing at it; renaming it is a
  DNS change and a client change, not a change to this machine. The disguise is about what is
  visible with shell access, and a public hostname is not that.
- **The application bundle.** It is CI output from the other repo, overwritten on every deploy,
  and it carries that project's name in a dozen admin strings. Renaming it here would be undone
  by the next push and would break an env var while it lasted.

**The ordering constraint is the part worth keeping.** The live deploy script's path is named
inside `authorized_keys` as an SSH forced command, and `authorized_keys` is root-owned on that
box with no passwordless sudo — so the rename could not be atomic with the thing that points at
it. Renaming the script alone breaks that project's CI deploy silently, at the next push, with an
sshd error nobody is watching for. So the old path stays as a shim and a prepared script does both
edits in one root run. **A rename that needs two privileges is two deploys, and the order is:
create the new name, leave the old one working, switch the pointer, then remove the old name.**

### What "delete the information" means when the information is load-bearing

The repo half was not a `sed`. Four of this deployment's decisions exist *because* the box was
borrowed, and volume 61 argued that they were retirable only because each one
carried a comment saying so. Deleting those comments would have re-created the exact problem the
move solved — a rule with no surviving reason, which nobody can evaluate and therefore nobody can
remove.

So the split is **identity out, shape in**. Gone from the whole tree, roadmap history included:
the hostname, the IP, the neighbours' site names, their Caddyfile path, their container and
network names, the account names, and the neutral name itself. Kept: that the box was
borrowed, that the proxy was somebody else's, that the network was external, that the exporters
were the host's, and that the names were deliberately neutral — every one of which is this
project's own history and none of which identifies anybody. Seventeen files: `server/deploy/`'s
runbook, the compose / alloy / prometheus headers, `matchsvc.ts`, two deploy test files,
`../19-server-platform.md`, the top-level `README.md`, `../ROADMAP.md`, and roadmap volumes 40,
42, 44, 47, 50, 52 and this one.

Two of those edits were corrections rather than scrubs, and they are the reason a sweep like this
should not be done with a regex:

- This volume's own *"the borrowed box is clean"* was false when written, and is now a pointer to
  the section you are reading.
- `server/deploy/README.md` §7 said the retired deploy key was *"owner-confirmed as theirs to
  clean up"*, which had quietly become a way of never doing it. It names the staged script and
  the one command now.

### The cleanup script's own three bugs, and the one that generalises

The root run happened the same day and the key is revoked — the live `authorized_keys` is three
lines, none of them this project's, and the key material is in none of the backups beside it
either. It took two scripts, and the reason is worth more than the outcome.

**The one that generalises.** The first script ended with a residue check — a `grep` alternation of
the two project names — over `authorized_keys` and its backups, and it printed **clean** for the
retired key's own line. That
line reads `command="…",restrict ssh-ed25519 AAAA… <neutral>-deploy` — it is labelled with the box's
neutral naming and by construction never contains this project's name, which was the entire point of
the naming. **A residue check that greps for a name cannot find what was deliberately named not to
say it.** It only caught the co-tenant's line at all because the other half of the pattern happened to
match. The replacement matches on KEY MATERIAL, and that is the form to reach for: verify by the thing
itself, not by what it is called.

**An off-by-one over a date range.** The same script scrubbed the retired key from backups matching
`authorized_keys.bak-2026091[0-4]*` — every backup made on the 15th was outside the glob, including
the snapshot the script takes itself one line earlier. It faithfully removed the key from the live
file and left a copy of it in the backup it had just written.

**A quoting bug that never reached the box intact.** The follow-up was first built inside a
double-quoted `ssh "…"` wrapping a quoted heredoc, so the local shell ate `$WT` before transmission
and what landed was `sed -i "// s|…`. `set -eu` caught it at the first backup, so nothing was
modified — the only damage was one stray `.tmp`. The fix is to ship a script as a FILE over stdin
(`tr -d '' < f | ssh host 'cat > f'`) and `sh -n` it on the far side before running it. The `tr` is
not optional: `core.autocrlf` makes every shell script in this repo CRLF in a Windows worktree, and a
CRLF `sh` script dies with `$'': command not found` — the failure `../../server/deploy/README.md`
already records for `ci-deploy.sh`.

### Still open

- **The other repo has not caught up.** `bigtaoo/e.gamestao` still holds its own copies of the
  deploy script and compose file under the old names. They are inert copies — the live ones on the
  box are what run — but a re-install from that repo would undo half of this.

`platform` `docs`
