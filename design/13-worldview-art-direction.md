# Worldview & art direction

The game's **visual identity and the fiction that wraps it** — the setting that makes the locked systems (`05` loop, `03` elements, `09` content) feel like one world, and the art rules that keep it readable on WeChat (`04`) and cheap to produce for a **high-DAU, shallow-monetization** title (`14` breadth-not-power meta). Sibling to `12` (which owns the *pipeline* — how pixels load and animate); this doc owns *what the world is and what it looks like*, `12` owns *how the assets are built*.

> **Art-first (locked 2026-07-23).** The visual identity was designed **first**, and the worldview reverse-engineered from it. The earlier "reclaimer-diver humanoid" concept trio (`art/concept/`) is **retired** — it read as generic post-apoc survival, contradicted the plucky tone, and was over-rendered for the flat-cel cut-out pipeline (`12`). The direction below replaces it. The prompts that produced the accepted concepts are archived in `art/concept/prompts.md` for future iteration.

## Visual identity (locked)

### The protagonist — a floating orb-core, not a humanoid

The hero is a **small hovering spherical core**: one rounded shell, **no arms, no legs**, a single large expressive eye, a transparent belly chamber that fills with glowing crystal, and **two weapon modules that orbit it** on glowing energy tethers. It floats (bob + lean into travel; squash-stretch on accel) — there is no walk cycle. *(The tether is **drawn**, not authored art — a glowing arc from a bone's pivot to its tip, opt-in per bone; the assembly of all of the above shipped visibly broken until 2026-08-17, see `12`'s update log.)*

This body plan was chosen because it wins on all four production constraints at once:

| Constraint | Why the orb-core wins |
|-----------|-----------------------|
| **Cheap to animate** | No legs → no locomotion cycle; the rig is near-trivial (a root + orbiting mount points), *simpler* than a humanoid, not harder. |
| **Cheap / consistent to draw** | One bold radially-ish-symmetric shape stays on-model across frames and characters; front/back sets nearly collapse (`12` facing model). |
| **Distinctive silhouette** | A round core with orbiting weapons + a glowing belly reads as *one game* at app-icon size — the brand hook nothing else in the genre has. |
| **Fits the weapon system** | The two orbiting modules **are** the two weapon slots (`02`/`03`); the `orbit` ballistic (`03`) already exists in the frame catalog. |

**The brand hook (icon / marketing):** the orbiting weapon modules + the belly that fills with element-colored crystal as you collect. Diegetic (it is your extraction canister), it is the silhouette, and it doubles as a live HUD.

### Characters are a roster, not skins

There is **no base-character-plus-skin hierarchy and no cosmetic-only skin** (`02`/`05`/`14`). Instead the game ships a **flat roster of distinct characters**, each a fully themed orb-core in this art language (e.g. a Sun-Wukong core — golden-fur shell, crown-shaped crystal spikes, a fiery eye). This is the collection/monetization hook for the DAU model: "unlock a new character" carries far more perceived value and social pull than "buy a skin."

Hard boundary that keeps this from fighting the weapon system:

> **A character's theme lives entirely on the orb** — shell, eye, crystal-spike motif, belly — **and never on the weapons.** Weapons are shared in-run loot (`05`) that plug into the same universal socket regardless of who is carrying them. A Wukong core still picks up and mounts the same fire sword any other character would.

Characters are **balanced side-grades**, not power tiers: each carries a `(maxHp, maxShield, maxEnergy)` triple + one shield-break passive (`02`/`05`), tuned as a distinct playstyle of equal worth. In PvP a paying player gets **more selectable characters** (breadth / comfort picks / counter-picks), never more power — the accepted "pay for access, not for power" model, held fair by keeping the **free starter roster playstyle-complete** and by the side-grade balance discipline in `14`. The silhouette should read the character's *archetype* (a fragile skirmisher vs a tanky core), not hide it. Launch scope is **3 characters**, then slow additions (a new one every ~2–6 months), so the balance surface stays small.

### Weapons — a universal mount socket

Every weapon is a **module that plugs into a standard socket** (the orbiting mount). The socket is identical across all weapons; only the **business end** differs — a barrel, a beam emitter, a crystal blade, a hammer head. This is what lets the `03` **Frame × Element × Affix** roster explode from few pieces without the art fighting it:

- **Any frame fits any character** — ranged and melee share one mount, validated by concept (a gun barrel and a crystal blade plugging into the identical socket).
- **Element = the crystal's colour** — swap the glowing crystal colour to swap element (`03`); the housing is unchanged. A per-weapon **element icon badge** carries the icon half of that read (see the colour law below). **Correction, 2026-08-25:** this line used to say the badge "rides on the housing", and when the icon channel was actually built it deliberately did not go there — the mounted module is ~15 world px, sweeps a full circle around the body every frame on this doc's own universal tether mount, and is frequently behind the body, so small + moving + intermittently hidden are the conditions a legibility backstop has to SURVIVE rather than share. It also can't be baked into the art, since one PNG per weapon is re-tinted per element at runtime. The weapon's badge lives where a weapon is actually read: the HUD `WeaponCard`'s damage badge while equipped, and on the drop itself while it is on the floor.
- **Tether length = melee reach** — a short tether is a dagger's tight sweep, a long one a spear's poke; an emergent, free mapping onto `03`'s `dagger/saber/hammer/spear` reach.
- **Melee swing = the socket sweeping an arc around the core** — that swept sector *is* the deflect sector (`03`'s "the arc that hits enemies is the arc that bats bullets back").

This **replaces** the old humanoid `gear_hand` + per-weapon `grip` mounting model (`02`/`03`/`12`).

### Enemies — the corrupted-crystal mirror

Enemies share the hero's DNA — **living crystal, single glowing eye** — but are its **failed opposite**: raw, jagged, wild-grown crystal over a cracked core, where the hero is a polished, contained shell. One base creature is **re-tinted** into the element variants (`09`'s render-only `tint`): a squat single-eyed crystal critter → **emberling / frostling / galvanist / ironclad** — fire / ice / lightning / **physical** (`ironclad` is the physical-resistant, armour-plated one) — told apart by colour + icon alone. **Poison has no dedicated critter yet** (the poison read currently lives on the `blightlord` boss, which is *weak* to it, `09`); a poison-tinted variant is a later add. Roster variety beyond the base body (a heavy brute, a floating ranged form) is a later pass.

The **boss closes the loop thematically**: it is a **giant failed core** — a huge cracked crystal core with orbiting shard rings — the same kind of thing the player *is*, but corrupted. Hero and final boss are the two poles of one object. Its **shard rings are its armament**: the boss fires in the sim like any mob, but it draws no weapon module, because a mob's rifle stuck to a 60-px core reads as a loadout rather than a finale. Enforced since 2026-08-21 rather than merely implied — `boss-core` declares `weaponMount: 'none'` (`12`), and until then it drew the same 12x5 `Graphics` placeholder bar every enemy did.

The mobs, by contrast, **do** carry a visible weapon — the raider rifle they shoot with (`gun_enemygun.png`, jagged crystal over a dark housing, on-language with the corrupted-crystal read). It mounts on the body's own drawn edge rather than on an orbiting socket: an orbiting module on a tether is the hero's silhouette, and a mob holding its gun is the contrast that keeps the two readable apart.

### Style & the colour law

- **Flat-cel "半平涂".** Bold clean uniform outlines, flat solid colour fills, simple soft cel shadows, minimal internal detail, strong readable silhouette. Deliberately **flatter than rendered concept art** — cut-out parts (`12`) rotate every frame, so baked lighting/texture would break, and a DAU title must produce content (characters, enemies, weapons) **cheaply and on-model**. The accepted weapon/melee concepts are the **flatness benchmark**; the enemy concepts are slightly over-rendered (lava texture, gloss) and must be flattened one notch in production.
- **Element = colour is a hard gameplay rule, dual-channel.** A **closed five-colour language** drives all combat legibility: **fire = orange-red, ice = pale blue, lightning = bright yellow, poison = sickly green, physical = neutral white/grey.** Lightning and poison were pulled fully off the shared violet they could each drift toward — pure yellow vs. pure green, no violet left in either — for a cleaner split than a violet-tinted version of each would read. Every weapon / enemy / status also carries a small matching **element icon badge** (flame / snowflake / bolt / skull / gem). Colour sets the mood, the icon is the legibility backstop (small size, colour-blind, dark background). This dual channel is **locked** and governs bullet trails, status auras (`07`), enemy `tint` (`09`), weapon crystal, and biome accents. **The icon channel shipped 2026-08-25** (`client/src/game/elementIcons.ts`) — see "The element icon badge" below. Before that, for the doc's whole life, only the COLOUR half existed.
- **Environment desaturated, hazards saturated.** Base stonework/terrain is low-chroma so the *interactive* bits — element FX, loot crystals, blight glow, the orbiting weapons — pop. The poison biome's ambient green must be dialled down and poison must **not** be the first biome, or green FX/enemies camouflage against a green floor.
- **Biome identity = element theme + palette shift**, cheap to swap via `12`'s lazy per-biome bundles.

### The element icon badge (shipped 2026-08-25)

The colour law above has always been written as **dual-channel and locked**, and until 2026-08-25
only one channel existed: `ELEMENT_COLORS` drove bullet trails, status auras, enemy `tint` and the
mounted weapon's tint, and nothing anywhere drew an icon. Every elemental read in the game was one
hue away from being unreadable — which is exactly the condition ("small size, colour-blind, dark
background") the second channel is named here to survive.

**Vectors, not art** — `client/src/game/elementIcons.ts`, the same standing rule as the HUD's
stat-chip glyphs (see "HUD art" below): a badge is tinted per element from an already-locked
palette and has to stay crisp at any DPR, and five PNGs would be five more files to keep on-model.
Two entry points: `drawElementGlyph` (the bare mark) and `drawElementBadge` (the mark on a dark
chip with an element-hue ring — the form that rides on a world object, where "dark background" has
to be supplied rather than assumed).

**Every glyph is a solid mass, never a stroke.** They are drawn at r = 3-8 px in the world, and the
defect class this avoids is on record in `art/props/prompts.md`: a shape that measures perfectly
correct and is one invisible pixel wide at the size it is displayed. That is why ice is a fat
six-pointed star rather than a literal six-armed snowflake, and why `elementIcons.test.ts` asserts
filled AREA (bolt 0.158 of its box, skull 0.550) and not just bounds.

Where the four channels landed, and one deliberate omission:

| carrier | colour channel (already existed) | icon channel (new) |
|---|---|---|
| **enemy** | `EnemyActor.tint` | a badge at the left end of its floating health bar |
| **status** | the aura ring's hue (`07`) | a glyph ON that status's own ring (`scene/statusAura.ts`) |
| **weapon (HUD)** | the damage badge's tint | the glyph inside that badge (`ui/WeaponCard.ts`) |
| **weapon (dropped)** | *nothing* — the ground icon was untinted | a badge on the drop, plus the icon now tinted |
| **bullet** | its hue + additive halo | **none** — a 4 px dot has no room, and this doc's list names weapon / enemy / status |

The enemy badge rides on the **health bar** rather than on the body, and both reasons come from
things already on screen: the bar is mounted on `layers.hud`, so unlike anything parented to the
body it is never behind a wall the occlusion x-ray only partially fades (`01`), and unlike a fixed
offset on the body it is never covered by the orbiting weapon module, which sweeps a full circle
around every actor by this doc's own universal-mount rule.

The badge is driven by an **authored** `EnemyBlueprint.element`, render-only alongside `tint`, and
not derived from the resist map. A "strongest resist wins" rule is one line and free, and it is
wrong twice: `brute` resists physical without being the physical variant, and `blightlord` — the
boss whose whole flavour is poison, and which is *weak* to poison — resists physical hardest, so
it would have been badged as the physical mob. Exactly the four variants this doc names carry the
field; `enemies.test.ts` sweeps that and asserts the derived rule would have been wrong.

**Two silhouette collisions this doc's own glyph list created, and how they were resolved.** Both
are the semantic-collision class no tonal or alpha measurement can catch — the same class as the
rejected bandage that read as an eyeball (`art/environment`): before adding a small shape, ask what
else in this game is that shape.

- **skull** was already `drawHudIcon('enemies')`, the enemies-remaining stat chip. Resolved in the
  DOC's favour: poison keeps the locked skull, and the chip became a single-eyed crystal critter
  head — which is more on-fiction anyway, since this doc describes enemies as *"living crystal,
  single glowing eye"* and nothing in this world has a skull. That absence is precisely what makes
  a skull read as "toxic" here rather than as "a mob".
- **gem** vs the material crystal (`drawHudIcon('banked')`, and `Pickup`'s material drop). Resolved
  by silhouette, not by renaming: a material is a TALL four-point crystal shard, physical's gem is
  a WIDE brilliant cut with a flat table and a girdle. Different aspect, different top edge, and
  the aspect inequality is pinned as a test so a later edit to either shape cannot converge them.

`physical` gets a glyph even though `ELEMENT_COLORS` deliberately omits it (a physical bullet takes
its faction colour, which is right for world FX). The icon channel has no such fallback: without
one, "no badge" and "physical" would be the same picture, so a physical weapon would be
indistinguishable from one whose badge simply failed to draw.

### Element palette (locked 2026-07-27)

The hex values already driving combat FX (`client/src/game/theme.ts`'s `THEME.colors`/`ELEMENT_COLORS`) — this is that "concrete per-element hex" the list below used to call out as undecided; it's just the shipped values confirmed and written down, not a new choice:

| Element | Hex | Used as |
|---|---|---|
| Fire | `#FF7043` | `statusBurn` — bullet trail, burn aura, `emberling` tint |
| Ice | `#81D4FA` | `statusChill` — bullet trail, chill aura |
| Lightning | `#FFF176` | `statusShock` — bullet trail, chain-hit flash |
| Poison | `#9CCC65` | `statusPoison` — bullet trail, poison-stack aura |
| Physical | `#E2E8F0` | no dedicated status FX (physical has no on-hit status) — the same neutral already used for the `gun`/`sword`/rarity-white palette entries |

> **Drift fixed:** `frostling`/`galvanist` (`content/enemies.ts`) were originally authored independently of the FX table above (`0x4fc3f7`/`0xffd54f`, close-but-different shades of the ice/lightning hues) — now unified to the exact `#81D4FA`/`#FFF176` FX values, alongside `emberling` which already matched fire exactly. `ironclad`'s `0x90a4ae` steel-grey remains its own physical-flavoured tint (deliberately not `#E2E8F0` — armour-plate flavour, not the neutral FX colour) and `blightlord`'s `0x8e24aa` toxic purple remains the boss's own flavour colour, unrelated to poison's FX hue (poison still has no dedicated critter, see above) — both intentional, not drift.

## Worldview (reverse-engineered from the art, locked)

- **Setting — the Blight (枯潮).** A spreading contamination is **crystallising** the world along **elemental lines** — fire / ice / lightning / poison. Each expresses as a different contaminated zone, which is why the run's floors are **elemental biomes** (`05`), the enemies are **wild crystal-blooms** corrupted by each element (the `09` variants emberling/frostling/galvanist/ironclad), and the boss is a **giant failed core**.
- **Role — a purifier core (提纯核).** You are a **purpose-built reclaimer core** — a small clean floating machine-being — that dives into contaminated zones to **siphon corrupted matter and refine it into pure crystal**, banking it before the Blight claims it (the belly literally fills). You are the **polished, contained** counterpart to the wild crystal creatures.
- **Tone — bright, luminous, hopeful.** Post-contamination but plucky and beautiful-dangerous, not grim, not horror. The crystal glows; the world is stylised, not gory. You are *reclaiming*, diving a little deeper and getting a little stronger each run — which is exactly the name **DayDayUp (天天向上, "better every day")** and the casual WeChat audience.

### The fiction earns every locked rule

The art-first setting still makes each locked mechanic diegetic:

| Locked rule (`05`/`09`) | In-world reason |
|-------------------------|-----------------|
| Weapons are ephemeral (wiped at run end) | Weapons found/refined in a zone are **contaminated crystal** — stable inside, they decay the moment they leave |
| Only materials carry out | Materials = **stabilised, purified** crystal — the one thing safe to extract (what your belly banks) |
| A brought weapon is single-use, costs materials | You **refine one unstable weapon** from materials for the dive; it survives one run, like any in-zone weapon (`05`/`14`) |
| Deeper floors → better materials | Deeper = **closer to the Blight source** → purer, more valuable crystal (and more dangerous) |
| Extraction rooms are checkpoints | **Decontamination gates** — passing one locks in what you have refined |
| Meta sells breadth, not power (`14`: blueprints + side-grade characters) | A safe **outpost / workshop** forges materials into loadout gear and takes in new **core models** (characters) |
| Elemental enemy variants + boss | Wild crystal-blooms corrupted by each element; the boss is a **failed / overgrown core** |

## Relationship to the other docs

- **`12`:** the pipeline that produces and animates these assets. The orb-core drops the humanoid rig — the rig is our own (`12`), and the weapon mount is an orbiting **socket**, not `gear_hand`.
- **`01`:** the tilted view + colour/glow the element language rides on.
- **`02`/`05`/`14`:** characters-are-a-roster (defensive identity + break passive, side-grade balanced), the biome/economy loop the fiction wraps, and the enemy `tint`/variant data the colour law drives.
- **`03`:** weapon looks inherit the element colour law and plug into the universal mount; melee sweep = deflect arc.

## To design

- ~~**Per-biome background palettes**~~ — **shipped 2026-07-28, as a code palette, not new art**: `game/theme.ts biomePalette()` derives ground/grid/pillar/wall colours per biome from this doc's already-locked element hex table (a small blend toward each hue, kept subtle per this doc's own "environment desaturated, hazards saturated" rule) — `DungeonConfig.biomeId` → `ELEMENT_COLORS` vocabulary, one new map entry per future biome. **Update (2026-08-18): these are now explicitly the NO-ART-LOADED fallback, not the shipped look.** Once real swatches landed (next bullet) the two roles diverged and nobody noticed: the palette blends each element's hue into a slate base, so the ember pillar colour is a pale mauve, while every shipped swatch is the charcoal-navy stone `art/biome/prompts.md` specifies. Pillars were still drawn from the palette, and once `01`'s standing-wall pass made the walls read as real stone those four pale-mauve cylinders became the worst thing in the frame. Pillars now carry their own hand-toned stone (`scene/pillarRender.ts`), and anything with real art derives its tones from that art. The palette is still the right thing for the backdrop `void` — it just is not where a textured object's colour comes from. **Update (2026-08-25): the "a biome with no swatch yet (poison)" half of that sentence is now obsolete** — poison has real swatches, so every element in the closed five does, and no shipped biome is on the palette for its floor or walls any more.
- ~~**The other biomes' looks**~~ — **shipped 2026-08-02**: real tileable floor/wall swatches for fire/ice/lightning/neutral (`client/public/biome/{floor,wall}_{fire,ice,lightning,neutral}.png`), generated after two prior attempts came back in the wrong style/shape (painterly isometric illustrated rooms, not flat-cel orthographic swatches — see `art/biome/prompts.md`'s explicit "NOT a scene/room" language, which is what finally fixed it). `render/biomeTiles.ts` preloads them (same non-blocking pattern as `uiSkins.ts`) and `RoomBuilder.ts` renders via `TilingSprite` when a swatch exists, falling back to the pre-existing flat palette fill otherwise (`RoomBuilder.test.ts` now covers both paths). **Update (2026-08-25): poison's three swatches shipped, closing the set** — `{floor,wall,wallface}_poison.png`, generated first-try with no reroll. The earlier reasoning for skipping it ("not floor 1, no dedicated critter") was a reason not to *schedule* the biome, not a reason to leave the fifth element of a LOCKED five-colour language with no art path at all; `render/biomeTiles.ts` now registers all five, and a registered key whose file is missing is the same flat-fill fallback as before, so nothing had to wait on anything. Poison's brief carried one hard clause the other four do not — this doc's own *"the poison biome's ambient green must be dialled down … or green FX/enemies camouflage against a green floor"* — and it is stated NUMERICALLY in the prompt and then asserted on the shipped pixels (`scene/biomeSwatchArt.test.ts`): blue stays the highest channel, green runs no more than 10/255 ahead of red (measured 3.3-6.3), and the brightest stone pixel stays far below the `#9CCC65` FX green's luma of 186 — which is the property that actually stops the camouflage. Composited offline at real render scale, a poison bullet and a poison-tinted mob pop hard off the floor. One real defect needed an import fix: the elevation came back with a 1-2 px near-black frame drawn around all four sides despite the prompt forbidding a border, cropped at a 4 px inset (which also improved its horizontal seam to better-than-adjacent-column). **Update (2026-08-18): a second wall asset joined them — `wallface_{fire,ice,lightning,neutral}.png`, the wall's front ELEVATION**, because the swatches above turned out to be only half a wall: they were being laid flat on the wall's own footprint, so the tilted view's promised "small front face" (`01`) existed on pillars and nowhere else. Walls now stand, with the elevation as the face and the original swatch reused unchanged as the top cap — see `01` "Standing walls" for the geometry and `art/biome/prompts.md` for the prompt (its seam rule is deliberately different from every other swatch here: left-right only).
- ~~**The 3 launch characters**~~ — **shipped 2026-07-27**: `vanguard` (the balanced default, cream/gold orb, already bound `12`), `skirmisher` (a Sun-Wukong-themed core — golden fur shell, crystal crown, fire-orange belly/eye — the fragile-high-shield agile pick) and `juggernaut` (a frost-guardian core — pale-blue armoured shell, ice-cyan belly/eye — the flat-HP tank pick) round out the roster, each a distinct themed orb-core on the shared rig (`content/skins.ts`'s `atlasKey`s `char_vanguard`/`char_skirmisher`/`char_juggernaut`). Which one anchors marketing is still open.
- ~~**Enemy body variety**~~ — beyond the re-tinted base critter: the boss core shipped 2026-07-27; **the brute + floating ranged form shipped 2026-07-28** (`content/enemies.ts`'s `brute`/`floater` blueprints, `09`'s new `bodyRig` field, reusing critter-core's rig). Nothing left open here.
- ~~**Outpost / hub look**~~ — **shipped 2026-08-01, NPC gap closed 2026-08-02**: a real hub background (`client/public/ui/hub_bg.png`) — a floating repair-dock platform, warm neutral stone/beige palette (deliberately kept off the ice-blue hue this doc reserves for combat FX), small crystal accents only, matching this doc's "environment desaturated" rule — plus matching icon glyphs for every menu button across `MainMenu`/`LoginScreen`/`PauseMenu`/`PartyScreen`/`Forge` (PLAY/SQUAD/LOGIN/SETTINGS plus the later REGISTER/CHANGE PASSWORD/LOG OUT/BACK/QUIT TO FORGE/CREATE PARTY/JOIN WITH CODE/LEAVE PARTY/CLEAR LOADOUT pass) and the run-outcome win/loss badges (`client/public/ui/icon_*.png`). Shared by every menu-shaped screen, all built on the common `ui/widgets.ts` `Panel`, non-blocking preload (`render/uiSkins.ts`) so a missing file just falls back to the pre-existing flat colour/plain text — `uiSkins.test.ts` now covers that fallback contract directly. The Forger NPC — a stationary, blocky/industrial orb-core variant with a hammer + tongs on the hero's own universal weapon-mount tethers instead of weapons, warm stone/beige/gold palette with a small ember-orange glow accent — is bound into `Forge.ts` as a corner-anchored decorative sprite (`client/public/ui/npc_forger.png`), hidden until its texture exists AND the viewport has room beside the row column (`Forge.npc.test.ts`). First-pass generations for the hub, the squad icon, and (twice) the NPC were rejected and regenerated: the hub came back painterly-isometric (`01`'s rejected style), the squad icon read as disconnected googly eyes, and the NPC's first accepted-on-style pass came back on an opaque grey background instead of a real transparent one (caught by decoding pixel alpha directly, not by eye — the preview render looked identical either way). Originals + rejects kept in `art/ui/*_raw.png`/`*_alt.png` and `art/npc/*_raw.png`/`*_alt.png` (matching `art/weapon`'s naming).
- ~~**HUD art**~~ — **closed 2026-08-02 with no new assets, by rule**: the rebuilt in-match HUD (`10`) shows the character's own rig `shell` texture as its portrait and the weapon's own business-end texture as its item icon — the *same* files the world renderer mounts (`render/skinRegistry`/`render/weaponSkins`, `12`). No headshots, no separate icon set. This is the standing rule, not a shortcut: a HUD icon that is a second drawing of the same object drifts from it, and a new character or weapon would need two assets instead of one. The only bespoke HUD art is the stat-chip glyph set, and those are drawn as vectors in code (`ui/hudIcons.ts`) so they can be tinted per stat from the palettes this doc already locks.
- ~~**Pillar surfacing**~~ — **shipped 2026-08-20, and NOT the way this item predicted.** The prediction here was "no new art needed, the swatches already exist"; that was wrong, and `scene/pillarRender.ts` had already recorded why in 2026-08-18 — sampling a 256 px wall swatch through a ~35 px cap window lands on one arbitrary dark patch, and the elevation on the shaft reads as an open-topped well. What a fixed-size object needs is art authored at its own scale, so this shipped as a whole-object SPRITE (`art/biome/pillar_neutral_raw.png` → `client/public/biome/pillar_neutral.png`, `pillarRender.buildPillarSprite`). **One file for every biome, not one per element**: `pillarTint()` multiplies the biome's wall colour over it, the same channel the hand-toned body used, and a real per-element attempt (`pillar_fire_alt.png`) was rejected for arriving at a different camera angle than the neutral one — 21% of its height as top surface against 30%, in a game with one fixed camera. Two measured import steps were needed and are recorded in `art/biome/prompts.md`: the generation came back with a painted transparency checkerboard (zero transparent pixels), and its shaft measured twice the value of the wall face beside it, fixed by a luma-keyed curve (`tools/png-pipeline/lumaCurve.mjs`) that leaves the top surface alone. This doc's "environment desaturated" rule held throughout — the shipped file carries no element hue at all.
- **Environment fixture trims** — `client/public/environment/door_{locked,open}_raw.png` are front ELEVATIONS and are now drawn standing (`01`). Both were re-run through `tools/png-pipeline/compress.mjs` on 2026-08-20: they had shipped with ~33 px of transparent margin per side (so a door's leaf covered 67% of its own opening) and, worse, DIFFERENT margins per state, so the two visual states were not registered against one another. Now 147x217 (locked) and 156x224 (open), alpha-tight. Any future fixture pair wants the same treatment before it is wired up — a renderer that fits art to a rect cannot see the margin.

- **The open door's curtain-of-light is an exception to "environment desaturated, hazards saturated"** (2026-08-30b) — a live report that the passable state still didn't read at a glance next to the locked hazard panel (`01`'s "the recess itself is still shared stone" section). `door_curtain_raw.png`: a vertical curtain of warm-gold energy (generated as a soft additive VFX glow, not a masked prop — deliberately NOT run through the checkerboard/haze fixes the rest of this pipeline enforces, since graduated alpha IS the content here, not a defect). Kept off every hue this doc already reserves — hazard red, `extractGlow`/`pickupHeal` green, shield/deflect cyan — so a passable door reads as its own category rather than borrowing another system's colour. One shared file across all five biomes, same reasoning as the pillar/portal-arch sprites: it is additive light, not textured stone, so it carries no biome material to disagree with.

- **Biome difficulty/order** — **all five elements now have real looks** (poison closed the set 2026-08-25), so nothing here is blocked on art any more. What is left is entirely a `05` balance question: which biome comes first/second/etc., and where poison slots in (kept off floor 1 regardless, per this doc's "environment desaturated" note about green-on-green camouflage). Concretely it is one entry in `theme.ts`'s `BIOME_ID_TO_ELEMENT` plus an authored room set — `engine/world/rooms/` still has only `ember`. Still open.
- ~~**Rarity vs element colour namespace**~~ — **spec locked and shipped 2026-08-25** (`client/src/game/rarityOverlay.ts`). The worry
  recorded here was not hypothetical, it was already true of the two shipped palettes: FOUR of the five rarity hues sit on top of a
  reserved element hue — `fine` blue `#63B3ED` vs ice `#81D4FA`, `legend` orange `#F6AD55` vs fire `#FF7043`, `legendary` gold
  `#F6E05E` vs lightning `#FFF176`, and `common` white `#E2E8F0` which is *byte-identical* to physical's neutral. So no re-picking of
  hues could have fixed it: as long as rarity's carrier is HUE, rarity and element compete for one channel, and this doc locks that
  channel to element.

  **The spec: rarity's channel is COUNT, element's is hue.** Neither can express the other, so the two can never be confused — a
  stronger guarantee than any pair of palettes could give, and the reason this is the shape worth locking rather than a nicer set of
  oranges. Concretely: (1) **count** = the tier's index in `RARITY_ORDER`, so common 0 → legendary 4, countable at a glance and monotone
  so "more marks = better" needs no legend; (2) **position** = an arc across the TOP of the object, centred and symmetric, so the marks
  are found without being hunted for and never cover the silhouette they describe; (3) **colour is reinforcement only** — the marks take
  `RARITY_COLORS`, the object keeps its element hue, and a colour-blind player still counts four; (4) **emissive ramps with tier** — the
  marks blend additively with alpha climbing up the ladder, which is this item's "emissive overlay" clause, layered on top of count
  rather than replacing it; (5) **`common` draws nothing at all**, because that is what the baseline tier means, and it keeps the
  overwhelmingly common case at zero added geometry.

  Shipped on the one object in the game that carried NEITHER channel: a weapon lying on the floor (`scene/Pickup.ts`). Its rarity was
  invisible — every drop wore the same amber kind-glow — and its element was invisible too, because the ground icon was drawn untinted,
  so a fire rifle and a poison one were the same picture. Both are fixed there; the icon is now tinted the same way `Skin.setWeaponTint`
  tints the MOUNTED copy of that exact texture.

  Deliberately NOT drawn on the actor's own mounted weapon: the mount is ~15 world px, sweeps a full circle around the body every frame
  by this doc's own universal-mount rule, and is frequently behind it — small, moving and intermittently hidden are the conditions a
  legibility backstop should survive, not share. The equipped weapon's tier already reads from the HUD `WeaponCard`'s rarity-bordered
  chip, 40 px away and stationary; the overlay's job is the case with no card.
- **Shipping title** — is "DayDayUp" the final name or a codename? The Blight/crystal-core setting may suggest a title.
