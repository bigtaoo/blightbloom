# Application record, builds, publish and traffic

Transcribed from `get_application`, `get_sandbox_state` and `get_sandbox_traffic`, 2026-11-14.

## Application

| Field | Value |
|---|---|
| `id` | `cmw50x3v701x1pz0h001x2abi` |
| `title` | Blightbloom |
| `status` | `DRAFT` (never submitted to moderation; the sandbox is the only public surface) |
| `createdAt` | `2026-11-06T13:42:00.403Z` |
| `updatedAt` | `2026-11-12T09:53:00.464Z` |
| `engine` / `category` | `js` / `action` |
| `agent` / `modelId` / `createdVia` | `claude-code` / `claude-opus-5-5` / `MCP` |
| `organizationId` | `cmvsgxrvc0aotj00hftxwn5wk` |
| `userId` | `cmvsgxrvc0aouj00hu5dqlosv` |
| `authorId` | `3ce2ff0d-29d1-499e-a2ec-4c5e41221d80` |
| `supportedLanguages` | EN, DE, ES, FR, IT, PL, RU, ZH |
| `supportedDevices` | DESKTOP, ANDROID, IOS |
| `isHorizontal` / `isVertical` | `true` / `false` |
| `checksum` | `f2c3b3cd0117d6be878c1301636a4675eac69b180cefac453cc7fb92bb067a0d` |
| `lastReleaseId` | `cmwddfkx41uuuk30imbjdl0ft` |
| `catalogAvailable` | `false` |
| `hasInGamePurchases` / `leaderboards` / `multiplayer` / `social` | all `false` |
| `media` | 3 covers (landscape `preview`, portrait `preview_vertical`, square `icon`), all uploaded 2026-11-06T13:49:36Z |
| `applicationTasks` | `[]` |

Store copy as it stood at deletion time. The description, how-to-play text and story are the text
that the 11-09 .. 11-14 ad traffic clicked through, so they are part of the funnel being measured.

> **description** — Blightbloom is a top-down roguelite shooter. Fight room by room through a
> blighted dungeon with two weapons at a time, ranged or melee, and the best melee weapons can
> swing incoming bullets straight back. Pick a hero from a roster of side-grades, each with its own
> health, shield, energy and passive, and clear five chapters of floors and bosses. Bank the
> materials you carry out of each run to forge new gear for the next.

> **howToPlayText** — Clear every room of enemies, then step into the portal to reach the next
> floor; survive the boss to finish the chapter. Keyboard and mouse: move with WASD, hold the left
> mouse button to attack (aiming is automatic), press 1 or 2 to switch weapon. Touch: drag the left
> side of the screen to move, hold the right side to attack, tap a weapon button to switch. Swing a
> melee weapon into enemy bullets to deflect them.

> **story** — It is a top-down dungeon shooter where a sword can hit bullets back at whoever fired
> them. An earlier version had a second stick just for aiming. I took it out, and now your hero
> faces the threat on their own, so your hands only decide where to stand, when to attack and which
> of your two weapons to hold. Melee weapons got the bullet deflect so that standing close is worth
> the risk. After a few rooms, which did you reach for more, the gun or the blade?

(The story field is reproduced with its one contraction expanded; everything else is verbatim.)

## The sixteen uploaded archives

This table is the **build timeline**: it maps every `build` / `build_version` string in `03-` and
`04-` to the moment that build became uploadable, which is how a day-level figure gets split.
`initialSize` is the first-load payload in bytes; `loadingTime` is the console measurement in ms.
`state` is the automated bridge check, not moderation.

| createdAt (UTC) | name | archiveId | bridge | loadingTime | initialSize | size | state |
|---|---|---|---|---|---|---|---|
| 2026-11-12T09:52:48.162Z | `blightbloom-2026-11-12-4e30e5f5-run-gate-payload` | `cmwdddgki1usuk30i4qlueddg` | 2.4.2 | 1880 | 1,280,670 | 6,669,404 | PASSED |
| 2026-11-11T15:16:37.182Z | `blightbloom-2026-11-11-9403aaf9-ad-placements` | `cmwc9i1fi0gfck30i7ljladf6` | 2.4.1 | 1708 | 1,282,700 | 7,217,261 | PASSED |
| 2026-11-10T09:30:18.804Z | `blightbloom-2026-11-10-ee9465b8-real-frametimes` | `cmwahou2c1d5wm80h9gygw3s6` | 2.4.1 | 1582 | 1,873,519 | 7,217,019 | PASSED |
| 2026-11-09T09:32:55.079Z | `blightbloom-2026-11-09-4f9804f3-death-cause` | `cmw92cbzb29csmt0hcj1pm9d5` | 2.4.1 | 1567 | 1,280,101 | 7,216,168 | PASSED |
| 2026-11-09T07:58:22.448Z | `blightbloom-2026-11-09-6d2ae6b5-locale-fix` | `cmw8yyqy826fqmt0hdnzetu4s` | 2.4.1 | 1451 | 1,279,144 | 7,215,249 | PASSED |
| 2026-11-08T16:32:20.695Z | `blightbloom-2026-11-08-5e325436-first-30s` | `cmw81vv881lximt0hapoe86xm` | 2.4.1 | 1791 | 1,279,141 | 7,215,214 | PASSED |
| 2026-11-08T12:05:19.715Z | `blightbloom-2026-11-08-a6febbce-perf-ladder` | `cmw7schcz1d07mt0hysvfowvh` | 2.4.1 | 1732 | 1,278,587 | 7,214,670 | PASSED |
| 2026-11-07T14:53:41.925Z | `blightbloom-0.0.1+99cba6ee-first-run-fixes` | `cmw6ix5lx0jhimt0h7umajvkm` | 2.4.1 | 2332 | 1,278,194 | 7,214,240 | PASSED |
| 2026-11-06T17:09:05.877Z | `blightbloom-0.0.1+14af20b3-chapter1-ramp` | `cmw58bff908qcos0h4aa6o4sq` | 2.4.1 | 1564 | 1,277,265 | 7,213,316 | PASSED |
| 2026-11-06T16:39:22.680Z | `blightbloom-0.0.1+21e5b74f-guide-label` | `cmw5797i007m9pz0h4edfstxg` | 2.4.1 | 1642 | 1,277,216 | 7,213,253 | PASSED |
| 2026-11-06T16:14:41.623Z | `blightbloom-0.0.1+f63ae5fa-guide-arrow` | `cmw56dgpk06t0pz0h2a5elxwl` | 2.4.1 | 1702 | 1,276,316 | 7,212,313 | PASSED |
| 2026-11-06T15:53:32.638Z | `blightbloom-0.0.1+40382ff8-onboarding` | `cmw55m9jy06hgos0hw0sfxxs8` | 2.4.1 | **6752** | 1,276,030 | 7,211,995 | PASSED |
| 2026-11-06T14:54:32.839Z | `blightbloom-0.0.1+935340c-next-room-arrow-r2` | `cmw53ie8704ippz0h43i9qq3s` | 2.4.1 | 1641 | 1,275,292 | 7,210,935 | PASSED |
| 2026-11-06T14:53:00.826Z | `blightbloom-0.0.1+935340c-next-room-arrow` | `cmw53gf8a04p9os0hosvyghwb` | null | null | 2,314 | 7,210,935 | **PROBLEM** |
| 2026-11-06T14:06:49.904Z | `blightbloom-2026-11-06-first-run-autostart` | `cmw51t16902y4pz0hqx6xfi4c` | 2.4.1 | 1661 | 1,273,640 | 7,209,012 | PASSED |
| 2026-11-06T13:42:04.243Z | `blightbloom-0.0.1-playgama-2026-11-06` | `cmw50x6tv01x6pz0hjvfw2b26` | 2.4.1 | 1600 | 1,273,595 | 7,208,897 | PASSED |

All sixteen have `isUploaded: true`, `isInvalid: false`, `isHidden: false`, `errorMessage: null`,
`bridgeEngine: javascript` and `decompressionFallback: null`.

The one `PROBLEM`: `reason: BRIDGE_NOT_INITIALIZED`, message *"Playgama Bridge never initialized in
this archive. Fix the SDK setup and upload a new archive."* It was re-uploaded 92 seconds later as
`-r2`, which passed. `initialSize 2314` is the tell: the bundle never shipped.

Two numbers worth keeping for a future build: the 11-10 archive `initialSize` of **1,873,519**
bytes is a ~594 KB spike over every neighbour (~1.28 MB), and the 11-06 `-onboarding` archive took
**6752 ms** to load against a ~1.6 s norm. Both are console measurements, not game telemetry.

## What was actually live

`get_sandbox_state`:

| Field | Value |
|---|---|
| `siteId` | `4g34tdpnqftrct` |
| `url` | `https://playgama.ai/play/4g34tdpnqftrct` |
| `status` / `discoveryStatus` | `ACTIVE` / `VISIBLE` |
| `publishedAt` | `2026-11-12T09:54:32.155Z` |
| `revision.id` | `cmwddfot22681hj0hj0ac4rwy` |
| `revision.archiveId` | `cmwdddgki1usuk30i4qlueddg` (the `4e30e5f5` build) |
| `revision.title` / `revision.createdAt` | Blightbloom / `2026-11-12T09:54:32.150Z` |
| `takenDownBy` | `null` |
| `publish` | `null` (no publish in flight) |

`activeArchives` carried exactly one entry: `cmwdddgki1usuk30i4qlueddg` on `PLAYGAMA_SANDBOX`,
`updatedAt 2026-11-12T09:54:32.159Z`.

**Only the latest publish time is retained by the console.** Earlier revisions are not listed
anywhere, so the archive upload times above are the best available proxy for when each build went
live, and the `build` distributions in `04-` are the only direct evidence of which build a given
player actually ran.

## Traffic campaigns

`get_sandbox_traffic` — `hasCompletedRun: true`, `current: null`, verdict
`{allowed: false, reason: "PAYMENT_REQUIRED"}`, `remainingFreeRuns: 0`. The paid offer that would
follow is `{kind: PAID, available: false, priceUsd: 20, budgetUsd: 6, durationDays: 3,
expectedGameplays: 50}`; `referralOffer` unavailable, `NO_REFERRAL_BONUS`.

| id | kind | budget | startsAt | endsAt | spentRatio | goalProgress | creatives |
|---|---|---|---|---|---|---|---|
| `cmw906b1t27fdmt0hzvv5ony1` | FREE | $12 | 2026-11-09T08:32:14.675Z | 2026-11-14T15:35:40.190Z | 0.15413 (`spentFinal: false`) | 1 | 20 |
| `cmw6n5dse0n5zmt0h4a9c8oul` | FREE | $3 | 2026-11-07T16:52:04.200Z | 2026-11-08T16:52:04.200Z | 0.14206 (`spentFinal: true`) | 0.625 | 20 |

Both FINISHED, neither with a `failureReason`. The $12 campaign carried two post URLs:
`https://x.com/gamestaoo/status/2119709564253716931` and
`https://x.com/gamestaoo/status/2120540934060302352`. The $3 campaign had none.

Note the spend: the $12 campaign reported `goalProgress: 1` having spent **15.4%** of its budget,
and that figure was still not final at read time.

`get_submission_state` (with `archiveId: cmwdddgki1usuk30i4qlueddg`) returned
`MODERATION_UNAVAILABLE` — *"This game cannot be submitted to moderation. Publish it to the sandbox
instead"*. The sandbox was the ceiling for this test; the catalog was never in reach.
