# Work log — 2026-09-17

Volume 70. See [`design/ROADMAP.md`](../ROADMAP.md) for the index and the phase spine.

## The home page and the login behind it, designed — then the design reflected on (2026-09-17, docs only, no engine change)

Stage 1 closed from the owner's side (see `ROADMAP.md` "Product stages"): *"我们目前只做技术验证。
真机和 wechat 我已经验证了。现在我们进入阶段二。"* — the two open Stage 1 items were scoped to
technical validation, the device half was verified by the owner personally, and Stage 2 opened on
that basis. The first Stage 2 question was the front door: *"我们先从首页开始。有些平台有账号系统，
有些要走我自己的账号系统，而且关卡的话不需要登录 … 你给个完整的设计"*, followed by one correction
(*"如果玩家之前登录过，本地有 token 的话，应该是走自动登录的"*) and then *"你再全面反思一下"*.

**No code changed.** What this pass produced is a design in `16` and `10`, three defects found by
reading rather than by running, and a reflection that reversed part of its own first answer. The
reflection is the reason the volume is worth keeping: the design was two thirds infrastructure for
a thing that has no value yet, and it took being asked to look again to see it.

### Three defects, none of which a test would have reported

All three were found by reading the boot path against the account path. Each is live today.

1. **Logging into an account that already has server state silently discards local guest
   progress.** `OnlineMatch.syncMetaWithSession` is `setMeta(remote ?? local)` — the `??` only
   covers the brand-new-account branch, where `pullAccountMeta` returns `null`. A guest who banked
   materials on this browser and then signs into an account they made on another device loses the
   bank, with no prompt and no message. The portal requirement this fails is quoted in `design/20`
   and reads *"support migrating local guest progress upon login"*; we satisfy it for new accounts
   only, which is the case where there is nothing to migrate into.

2. **A stored token is trusted forever and never verified.** `fetchMe` (`GET /auth/me`) exists in
   `client/src/net/auth.ts` and has **zero production callers** — boot reads
   `localStorage['daydayup.session.v1']` and treats whatever it finds as a live login. Sessions
   have a fixed 30-day TTL (`AuthService.SESSION_TTL_MS`) that `issueSession` writes once and
   nothing ever extends, so an expired, revoked or deleted session renders as `Hi, {name}` while
   every bearer call 401s into a `.catch()`: `saveAccountMeta`'s is fire-and-forget by design and
   `syncMetaWithSession`'s falls through to "keep using local state". **The failure is total and
   silent in both directions** — the player believes they are signed in, and cloud save has never
   once worked.

3. **A guest's ladder rating is thrown away every match.** `ladderReport` keys a seat that carries
   no `accountId` as `seat:{roomId}:{seatIdx}` — a fresh identity per match, so nothing
   accumulates. The guest already HAS a persistent id (`identity.ts`'s UUID, which `POST /find`
   receives), so this is a key choice rather than a missing capability.

### What the reflection reversed

The first answer was a ten-section design with a five-state account chip, a field-by-field merge
algorithm, a WeChat `openid` login and four delivery batches. Asked to look again, four things in
it were wrong, and they are recorded here because each is a shape that will recur.

- **It was a vault for an empty bank.** What an account buys a player today: cloud sync of a
  six-field `MetaState`, a ladder nobody is on, and a store that cannot sell anything (billsvc is
  still the dev stub; Phase 9 is unbuilt). Two of the three "natural upgrade points" the design
  offered the player do not work. What justifies work here is the three defects above, which are
  wrong regardless of whether the account is worth having — not the feature surface around them.
- **The token check was a second request that was not needed.** The correction asked for
  auto-login, and the answer added a boot-time `fetchMe`. But the boot path already calls
  `/account/meta`, whose 401 answers the same question — one request, not two, and one fewer chip
  state. What the code actually needs is for `fetchAccountMeta` to return a 401 as a value instead
  of throwing it, which is smaller than what was proposed.
- **The ladder was answered with a label instead of a fix.** The design's "honest labelling"
  section proposed telling a guest their rating is discarded. Three warnings on a front door whose
  locked rule is that login is never required reads as nagging — and each of the three had a fix
  available. Defect 3 above is the fix; the label was the lazy half of it.
- **It designed the account corner and never looked at the front door.** The lobby's five routes
  were taken as given. They are not in equal health: **CO-OP is a dead door** — `Matchmaker.poll`
  backfills bots only for `mode === 'pvp'`, so a co-op queue with nobody else in it waits out
  `queueTtlMs` (30 s) and expires — PvP works but makes a solo player wait the same 30 s for
  `pvpBotFillMs` before anything happens, and SQUAD needs a second human with a room code. Three
  of five doors are shut or slow, and the pass spent its effort on the chip in the corner.
- **It left the returning player's first need one screen deep.** CONTINUE RUN lives in the Forge,
  behind SOLO PvE. The design noted that a saved run is device-local and does not travel with an
  account, and then did nothing with that observation.

One more thing the reflection changed rather than reversed: the merge default. A field-by-field
union is the wrong DEFAULT on a shared computer, where the local guest progress belongs to whoever
used the browser last. The rule that survives is narrower — *this device merges once, on its first
association with any account, and the account is the truth afterwards* — with the confirmation
screen's primary button reading "use the account's" and merge as the second choice.

### What was kept

The parts of the first answer that survived the reflection, because they are about shape rather
than about feature surface:

- **Three identity layers, one seam.** Device guest / host-vouched identity / our own account, all
  read through `getPlayerId()`, with a federated row and a local row being two shapes of the same
  `accounts` document. A new platform is then one `/auth/<provider>` route and one silent call
  site, which is exactly what CrazyGames cost.
- **Clickability is the host's decision; the copy is the session's.** These are fused into one
  boolean today (`MainMenu.setAccountEntry`), and they come apart the moment a host has an
  identity but forbids a logout — which is every federated host, including WeChat if it ever gets
  `wx.login`.
- **Offline is not logged out.** Only an explicit 401 drops a session; a network failure keeps it.
  And a 401 clears the session without touching local `MetaState`, ever.

### Also recorded: WeChat has no identity at all

Worth restating because the opposite is the natural assumption. There is no `wx.login` in this
client and no `POST /auth/wechat` on the server, so **every WeChat player is a guest** and a
cleared storage is a new player with nothing. Adding it is a token exchange shaped exactly like
`POST /auth/portal`, and `wx.login` needs no consent dialog — but it is OUR choice rather than a
platform requirement, and it mints a server-side identity for a player who never asked for one.
That is a cost to weigh, not a checkbox, and `client/public/privacy.html` would need the same
pass design/21 §5 already owes it.

### The priorities this pass ends with

P0, because all three are wrong today and none depends on the account being worth having: the
merge wipe, the unverified token, and the guest ladder key. P1 is the front door itself — co-op's
missing bot backfill, PvP's 30-second wait, and CONTINUE RUN's absence from the lobby. Everything
else (the chip's extra states, WeChat identity, sliding session renewal, the upgrade-point
entries) is P2 and waits for a store that can sell something or a player with two devices.

`docs` `ui` `net`
