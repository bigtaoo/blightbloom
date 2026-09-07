# Design

This directory records **decisions** and **architecture**. It is the single source of truth for the team. Change the plan here first.

| Doc | Contents |
|-----|----------|
| [00-tech-stack.md](00-tech-stack.md) | Tech-stack decision record (why single-engine Pixi; why not Three.js / Cocos) |
| [01-rendering.md](01-rendering.md) | Rendering & depth — **index + fidelity roadmap + quality tiers**. The mechanisms are in [rendering/](rendering/): [foundations](rendering/01-foundations.md) (view, coordinates, layers, limits), [walls](rendering/02-walls.md), [occlusion & doors](rendering/03-occlusion-and-doors.md), [floor/arena/void](rendering/04-floor-arena-void.md), [character & objects](rendering/05-character-and-objects.md). `design/01 milestone N` in a code comment still reads the roadmap in the index. |
| [02-entity-model.md](02-entity-model.md) | Entity model: Actor / Skin / Weapon three-layer split |
| [03-weapon-system.md](03-weapon-system.md) | Weapon system: ranged, melee, block/deflect, extensibility |
| [04-wechat.md](04-wechat.md) | WeChat mini-game adaptation, base-library version notes, verification checklist |
| [05-gameplay.md](05-gameplay.md) | Gameplay: core loop, PvE search-fight-extract (floors + extraction checkpoints) / PvPvE arena, HP+shield survivability, material economy, parry positioning, landscape controls |
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
| [16-accounts.md](16-accounts.md) | Accounts: username/password login (SQLite + scrypt + opaque bearer sessions), never required to play, and the two things bound to an account — PvP ladder rating and forge blueprints/materials/loadout |
| [17-i18n.md](17-i18n.md) | Internationalization: English-canonical `t()` with compile-time key checking, the locale files, what is deliberately left untranslated, and the repo's English-only rule for code/comments/docs |
| [18-test-strategy.md](18-test-strategy.md) | Test strategy: the two meanings of "out of sync" — replay divergence, and systems disagreeing inside one build — the six gaps that were measured, and the four layers that closed them (contract gates incl. the committed golden hash, unit tests, parity sweeps, invariant smoke runs) |
| [19-server-platform.md](19-server-platform.md) | Server platform: the three planes (control / data / billing), the internal-key trust seam and the two defects it closes, entitlements moving server-side out of the client-authored meta blob, the billing order/receipt/ledger model and its idempotency rules, IAP adapters + the fail-closed dev stub, and the gameserver registry that keeps topology out of the ticket |
| [20-game-portals.md](20-game-portals.md) | Game portals (CrazyGames): why a portal is the first target that constrains what the client MAY do rather than what it CAN do, the declared-host seam that replaced feature detection, the requirement-by-requirement record of what changed, the one-input phase derivation the game does not know about, three live findings the SDK docs do not contain, and what still needs a registered domain or a product decision |

## Where the plan lives

[ROADMAP.md](ROADMAP.md) is the ordered implementation plan and the index to the running
record of what actually shipped. The docs above answer *what was decided and why*; ROADMAP
answers *what is built right now*. When a milestone closes, both get written back to — a
decision doc that still describes a shipped system as unbuilt is a bug.

It comes in three parts, because as one file it had reached 8,575 lines and eighty-six
sections with the plan and the log interleaved in no particular order:

- **[ROADMAP.md](ROADMAP.md)** — the phase spine (Phases 0–7, what `ROADMAP 3.1` in a code
  comment refers to), the dependency summary, and the log index by date and by theme.
- **[roadmap/](roadmap/)** — the work log itself, one volume per stretch of dates, each
  under 1000 lines. New passes append to the highest-numbered volume; the rules are in
  ROADMAP.md's *Appending to the log*.
- **[roadmap/current-state.md](roadmap/current-state.md)** — the running "what is built
  right now" note. Not the authority on `ENGINE_VERSION`; `engine/versionHistory.ts` is.

## Decision format

Record each important decision as a one-line conclusion + rationale + impact, so it is easy to revisit "why we chose this" later.
