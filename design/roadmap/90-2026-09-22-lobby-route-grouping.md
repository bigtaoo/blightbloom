# Work log — 2026-09-22

Volume 90. See [`design/ROADMAP.md`](../ROADMAP.md) for the index and the phase spine.

## Group the lobby by kind, and take a door off the screen instead of dimming it (2026-09-22, client + ui + test + i18n + docs, no engine change)

> The owner looked at a screenshot of the shipped lobby and asked whether piling eight tap
> targets onto the front door was a good idea.

The count was not the defect. `client/src/game/ui/LobbyRoutes.ts` +
`client/src/game/screens/MainMenu.ts` held three different KINDS of control in one column —
**start playing** (CONTINUE RUN / SOLO PvE / CO-OP / PVP SOLO QUEUE), **prepare** (SQUAD / FORGE /
TUTORIAL), **chrome** (LOGIN / SETTINGS) — with nothing in the layout encoding that. A player
scanned eight near-identical dark pills and the only signal present was the one green fill. Three
findings came out of the audit, and design/10-ui-hud.md's own locked rules ruled out the easy fix
for two of them: LOGIN/SETTINGS carry a recorded misclick history (design/10, the 2026-08-02
legibility fix), TUTORIAL and the account chip drew the same glyph in the same purple (a second,
more literal case of the same "two adjacent buttons must differ by more than their label" rule
that fix was written for), and CO-OP/SQUAD cross two axes — mode and social unit — with neither
label saying which one it differs by (left out of scope; see below).

### LOGIN and SETTINGS left the card

They are not routes into the game, so they stopped sharing a card with the ones that are.
`accountBtn`/`settingsBtn` moved from inside `menuCard` to a centred row 12px under it, no
backing panel — same widths, same `autoWidth`-measured centring `MainMenu.show()` already had,
only the `y` changed. `accountLabel` (the portal's non-interactive name text) moved from a
separate slot above the card to the same slot the row it replaces occupies, so the two states
(a button, or a label) share one row instead of two.

Height was break-even by construction, not by luck: the card's bottom pad dropped from 24 to 12
(it was sized for a 42px button's descender room, and the card's last element is a route row
now, not the utility pair) — exactly what the utility row's own 42 + 12px gap cost when it moved
outside. Measured at the binding case (portal build, quick-play + data notice, no saved run):
630px of a 640px design height before this pass, 630px after — `viewportFit.test.ts`'s sweep
(all eight locales, all seven shipped viewports) stayed green with the same margin it had.

### A divider, inside the card

A 1px `Graphics` line, full card width, between PVP SOLO QUEUE and the SQUAD | FORGE row —
splitting "start playing" from "prepare" without dimming either side, which is the distinction
design/10's own rule turns on: *"do not dim a door — open it, or take it off the screen"* is a
rule about a route's HEALTH, not its grouping, and every route below the divider keeps its exact
height, fill, border and icon chip. Deliberately not a `Button`: no `onTap`, so it draws no press
target and needs no special case in `widgetOverlap.test.ts`'s tappable walk, which finds every
press target by reflecting on an `onTap` slot. It cost 12px (8 + 1 + 8, replacing the plain 5px
row gap that used to separate the two rows) — paid for by the same bottom-pad saving above.

### TUTORIAL taken off the screen, not dimmed — and a second door added

`LobbyRoutes.setRecommendTutorial(recommend)` used to drive only the row's "NEW HERE?" badge; the
row itself was always drawn, for every player, forever, regardless of
`MetaState.hasSeenTutorial`. That is a route dimmed by omission rather than by styling — a
returning player was never shown a de-emphasised row, they were shown the same row a new player
sees, on a screen that already knew they didn't need it. `setRecommendTutorial(false)` now hides
the row outright (`recommendTutorial` defaults to `true`, so a caller that never calls it — every
existing unit test that doesn't wire `ScreenFlow` — keeps today's shipped behaviour), which is
the letter of "take it off the screen" rather than a new kind of dimming.

Taking a route off the screen must not make it unreachable, so `screens/Settings.ts` gained a
REPLAY TUTORIAL entry — a fixed action, not a `SettingsState` field, wired through a plain
`onTutorial` passthrough (`gameWiring.ts`) to the same `RunLifecycle.beginTutorialRun()` the
lobby's own row calls. It joined the existing MUTE/BACK row as a third button rather than getting
a row of its own: Settings' own design height already sat exactly on the 640px floor
(`viewportFit.test.ts` — the row inserted first, on its own, overflowed by exactly its own 44px),
and a row already wide enough for the worst-case translated MUTE/BACK labels had a great deal
more spare width than a fresh 44px of height did. `RunLifecycle.beginTutorialRun()` now hides
`settingsScreen` alongside `mainMenu` on the way into the run — a real gap this opened, since
every earlier entry point into a run was reachable only from the lobby.

TUTORIAL also stopped borrowing the account chip's colour (`0x6b46c1` → `0x2f6f5f`, the glyph
itself still borrowed — no dedicated tutorial icon exists yet).

### Deliberately out of scope

**The CO-OP / SQUAD relabel.** The sharpest finding from the audit, and a copy change gated on
an open design question (design/05-gameplay.md:152, whether co-op PvE is matchmade or
friends/party-only at launch) that a layout pass should not decide by accident in eight locale
files. The new divider already puts the two routes on opposite sides of a visible rule, which is
most of the confusion this pass could close without answering that question.

### Verification

Unit: `MainMenu.test.ts` (new — the utility row's position outside the card, in all four states;
the divider's position and that it carries no `onTap`; TUTORIAL's chip colour against ACCOUNT's,
read from source the way `buttonCueConventions.test.ts` already does for a per-call-site
convention no runtime check reaches), `LobbyRoutes.test.ts`, `Settings.test.ts`,
`labelFit.test.ts`, `viewportFit.test.ts`, `widgetOverlap.test.ts`, `gameWiring.test.ts`,
`RunLifecycle.test.ts`, `buttonCueConventions.test.ts` (REPLAY TUTORIAL is a documented exception
to "every Settings option is `ui.toggle`" — it changes no `SettingsState` field). Full client
suite green (7,339 tests), `npm run check` clean. Driven live (`npm run dev -w client`) at
760×640 and at the phone-landscape viewport `viewportFit.test.ts` guards
(667×375) across all four states named in the plan — plain, with a saved run, with the tallest
maintenance banner, and the portal build (quick-play + no login entry point) — confirming the
divider, the moved utility row, the TUTORIAL chip colour and the REPLAY TUTORIAL row all render
as measured, with nothing clipped at the design-height floor.
