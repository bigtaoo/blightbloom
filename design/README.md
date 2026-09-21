# Design

This directory records **decisions** and **architecture**. It is the single source of truth for the team. Change the plan here first.

| Doc | Contents |
|-----|----------|
| [00-tech-stack.md](00-tech-stack.md) | Tech-stack decision record (why single-engine Pixi; why not Three.js / Cocos) |
| [01-rendering.md](01-rendering.md) | Rendering & depth — **index + fidelity roadmap + quality tiers**. The mechanisms are in [rendering/](rendering/): [foundations](rendering/01-foundations.md) (view, coordinates, layers, limits), [walls](rendering/02-walls.md), [occlusion](rendering/03-occlusion.md), [doors](rendering/04-doors.md), [floor/arena/void](rendering/05-floor-arena-void.md), [character & objects](rendering/06-character-and-objects.md). `design/01 milestone N` in a code comment still reads the roadmap in the index. |
| [02-entity-model.md](02-entity-model.md) | Entity model: Actor / Skin / Weapon three-layer split |
| [03-weapon-system.md](03-weapon-system.md) | Weapon system: ranged, melee, block/deflect, extensibility |
| [04-wechat.md](04-wechat.md) | WeChat mini-game adaptation, base-library version notes, verification checklist |
| [05-gameplay.md](05-gameplay.md) | Gameplay — **index + the locked decisions + the cross-mode summaries** (PvP, the economy table, parry, controls). The mechanisms are in [gameplay/](gameplay/): [the run and its rooms](gameplay/01-the-run-and-its-rooms.md), [what a floor hands you](gameplay/02-what-a-floor-hands-you.md), [weapon energy and the melee mobs](gameplay/03-weapon-energy-and-melee-mobs.md). `design/05 "Section title"` in a code comment lands via the index's map. |
| [06-netcode-determinism.md](06-netcode-determinism.md) | Netcode & determinism: server frame-broadcast lockstep + client prediction, deterministic `@dd/engine` core, migration plan (mirrors sibling project `funny`) |
| [07-collision-combat.md](07-collision-combat.md) | Collision & combat: circle/wall collision, uniform-grid broad phase, swept directional bullets, block/deflect & melee arcs (brad/fp-trig), damage pipeline, death & drops — bodies of `08`'s step 4–9 |
| [08-simulation-core.md](08-simulation-core.md) | Simulation core: `GameState` schema, fixed `step()` system order, per-tick twin-stick `PlayerCommand`, `InputSource`/replay/headless (concrete form of `06`'s principles) |
| [09-content-data.md](09-content-data.md) | Content & data model: `@dd/engine` config layout, weapon/enemy/skin/rarity/run-buff schemas, room-piece & seeded-dungeon formats, PvP fairness build-wall, human-units→fp/brad conversion & versioning |
| [10-ui-hud.md](10-ui-hud.md) | UI, HUD & screen flow: all-Pixi UI, the menu→loadout→match→result state machine, in-match HUD read from `state`/`events`, twin-stick input → `PlayerCommand` quantization boundary, landscape/safe-area layout, WeChat text constraints |
| [11-audio.md](11-audio.md) | Audio: SFX/music driven by the engine `events` queue (`08`) on the render clock, the event→sound cue map, WeChat `InnerAudioContext` constraints (`04`), determinism/audio decoupling (prediction-replay dedupe + catch-up coalescing), settings/buses (`10`), and an audio-sourcing note (AI + CC0 libraries) |
| [12-art-animation.md](12-art-animation.md) | Art & animation pipeline: character = shared orb-core rig + own atlas (`02`), own rig defs (editor rewritten, not funny's humanoid), orbiting-socket weapon mounting, twin-stick facing model, Pixi `Assets` loading (web + WeChat adapter), tilted-view authoring rules (`01`), art-is-presentation-only determinism rule |
| [13-worldview-art-direction.md](13-worldview-art-direction.md) | Worldview & art direction (art-first): floating orb-core hero + universal-mount weapons + crystal-mirror enemies, the Blight setting reverse-engineered from the art, flat-cel style, the element=colour dual-channel (colour + icon) law, desaturated-environment rule, tone |
| [14-meta-forging.md](14-meta-forging.md) | Meta & forging: blueprint unlock + per-run material crafting (5 elemental materials), intrinsic weapon rarity (no upgrades, no affixes — Soul-Knight route), characters-are-skins side-grade roster, PvP fairness (weapons walled structurally / characters by discipline), bounded no-gacha monetization |
| [15-pvp-arena.md](15-pvp-arena.md) | PvP arena: 8-player solo-or-squad battle royale, room-graph shrinking zone, `ArenaMap`/`CellTrait` map-editor schema, team/hostility model, PvP HP/weapon scaling, periodic cross-client anti-cheat checkpoints, sparse held-input net sync |
| [16-accounts.md](16-accounts.md) | Accounts: username/password login (MongoDB Atlas since 2026-09-15, SQLite before it + scrypt + opaque bearer sessions), never required to play, and the two things bound to an account — PvP ladder rating and forge blueprints/materials/loadout |
| [17-i18n.md](17-i18n.md) | Internationalization: English-canonical `t()` with compile-time key checking, the locale files, what is deliberately left untranslated, and the repo's English-only rule for code/comments/docs |
| [18-test-strategy.md](18-test-strategy.md) | Test strategy — **index + the status block + the `What shipped` table**. The two meanings of "out of sync" (replay divergence, and systems disagreeing inside one build), the six gaps that were measured, and the nine layers that have closed them since. The sections are in [testing/](testing/): [the layers as built](testing/01-the-layers-as-built.md) (4 coverage, 5 content, 6 deploy, 7 assembly), [the six gaps and the original plan](testing/02-the-six-gaps-and-the-original-plan.md) (`G1`–`G6`, Layers −1–3), [what each bump fixed](testing/03-what-each-version-fixed.md) (v49/v50/v51, and what building the gates found). `design/18 G4` and `design/18 Layer 0` in a code comment land via the index's map. |
| [19-server-platform.md](19-server-platform.md) | Server platform — **index + the path convention + the locked decisions + §8–§9**. The ten numbered sections are in [serverplatform/](serverplatform/): [§1–§3 planes, entitlements, trust seam](serverplatform/01-the-planes-and-the-trust-seam.md), [§4–§5 billing](serverplatform/02-billing.md), [§6–§7 topology and operations](serverplatform/03-topology-and-operations.md), [§10 observability](serverplatform/04-observability.md). `design/19 §4` in a code comment lands via the index's map; **section numbers are the address — do not renumber one.** |
| [20-game-portals.md](20-game-portals.md) | Game portals (CrazyGames): why a portal is the first target that constrains what the client MAY do rather than what it CAN do, the declared-host seam that replaced feature detection, the requirement-by-requirement record of what changed, the one-input phase derivation the game does not know about, three live findings the SDK docs do not contain, and what still needs a registered domain or a product decision |
| [21-ops-analytics.md](21-ops-analytics.md) | Ops and analytics: the two things already in place that shrink the problem (the log store answers monitoring; Grafana is the ops frontend), first-party retention instrumentation and the closed event vocabulary that rides the existing client-log trust boundary, a fifth process holding no write handle to player data, why a publicly exposed console is read-only and every player-data write stays a CLI on the box, feature flags and the allowlist that keeps a security switch out of them, and the live privacy-policy sentence that stops being true |

## Where the plan lives

[ROADMAP.md](ROADMAP.md) is the ordered implementation plan and the index to the running
record of what actually shipped. The docs above answer *what was decided and why*; ROADMAP
answers *what is built right now*. When a milestone closes, both get written back to — a
decision doc that still describes a shipped system as unbuilt is a bug.

It comes in three parts, because as one file it had reached 8,575 lines and eighty-six
sections with the plan and the log interleaved in no particular order:

- **[ROADMAP.md](ROADMAP.md)** — the phase spine (Phases 0–7, what `ROADMAP 3.1` in a code
  comment refers to), the dependency summary, and the log index by date and by theme.
- **[roadmap/](roadmap/)** — the work log itself, **one pass per volume**, each under 1000
  lines. A new pass takes the next free number and writes its own file; appending to the
  volume that happens to be open is what produced volume 55's nine passes in 1,346 lines
  (split apart 2026-09-15). Both index halves get a line in the same edit —
  `npm run check:roadmapindex` fails a dated pass that is not in the by-date log, a counter
  that was incremented rather than derived, and a by-theme entry carrying a summary.
- **[roadmap/current-state.md](roadmap/current-state.md)** — the running "what is built
  right now" note. Not the authority on `ENGINE_VERSION`; `engine/versionHistory.ts` is.

## Decision format

Record each important decision as a one-line conclusion + rationale + impact, so it is easy to revisit "why we chose this" later.
