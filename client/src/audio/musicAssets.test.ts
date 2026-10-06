/**
 * The shipped music loops' own rules, read from the SHIPPED files under
 * `public/audio/music/` and the provenance record in `art/audio/credits.json`.
 *
 * WHY THIS FILE HAD TO EXIST. Until it did, the loops were outside every TypeScript-side
 * gate in the repo — and not because anyone decided that. `platform/audioAssets.test.ts` reads
 * `public/audio/` with a NON-recursive `readdirSync`, so the moment music shipped into a
 * subdirectory it fell out of that file's byte budget, its credits cross-check, its format check
 * and its licence sweep, silently and all at once.
 *
 * It is not a copy of that file. Music's rules are inverted or absent in three places, and each
 * inversion is a real decision worth pinning:
 *
 *  - **Stereo is REQUIRED here, and forbidden there.** A 100 ms cue's second channel is pure
 *    overhead; a 69 s bed streams, so its bytes amortise. A mono re-encode of a music loop would
 *    pass the cue gate and be a downgrade.
 *  - **The LENGTH is load-bearing, not descriptive.** `MusicPlayer` starts the next deck at
 *    `length - XFADE_S` because the loop is closed by the player, not the file. A catalogue
 *    length that drifts from the shipped file puts the crossfade in the wrong place, which is
 *    audible as a badly cut loop and invisible everywhere else.
 *  - **The licence is NOT always CC0, and CC-BY carries a condition.** `packs.json` asserts CC0
 *    of every SFX pack, so the music cannot be filed there. Since 2026-10-06 every loop is
 *    openly licensed music (the AI-generated masters before it are gone), three of the four
 *    CC-BY, and CC-BY is only honoured if the credit is SHOWN. So this file checks the licence
 *    against an allow-list, the captured licence text, the archived source's bytes, and that the
 *    record's credit line is the one `musicCredits.ts` puts on the Settings screen.
 *
 * Nothing here decodes audio; the mp3s are parsed at the MPEG frame level (`audio/mp3Frames.ts`,
 * shared with the cue gate). Whether a loop sounds RIGHT is not testable and is not tested — see
 * `art/audio/README.md` on what measurement can and cannot say about these files.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseMp3 } from './mp3Frames';
import {
  ALL_TRACKS,
  MUSIC_CATALOGUE,
  MUSIC_DIR,
  PLACEHOLDER_TRACKS,
  XFADE_S,
  musicPaths,
} from './musicCatalogue';
import { MUSIC_CREDITS, musicCreditLines } from './musicCredits';

const MUSIC_ON_DISK_DIR = new URL('../../public/audio/music/', import.meta.url);
const CREDITS = new URL('../../../art/audio/credits.json', import.meta.url);
const ART_AUDIO = new URL('../../../art/audio/', import.meta.url);

/**
 * Total budget for the music set. 2.46 MB shipped (four loops, 2026-10-06); `assetPacks.json`'s
 * `music` pack allows 3.00 MB, so this is the finer drift check between "a fifth loop lands" and
 * "a package overrun with no name on it".
 *
 * Deliberately NOT generous. Music is by far the heaviest asset class in the game — the four
 * loops outweigh the whole cue set ~20x — so the one thing this number has to do is make a
 * re-encode at a higher bitrate an explicit decision rather than a silent 40% increase.
 */
const MUSIC_BUDGET_BYTES = 2_600_000;

/** CC0 and CC-BY only: both allow commercial use and an edited loop. NC is out because the game
 *  earns from ads; ND because cutting a loop region is an adaptation. Mirrors `MusicLicense`. */
const ALLOWED_LICENSES = ['CC0-1.0', 'CC-BY-4.0', 'CC-BY-3.0'];

interface MusicRecord {
  track: string;
  file: string;
  title: string;
  author: string;
  license: string;
  license_url: string;
  license_text: string;
  source_page: string;
  upstream_url: string;
  upstream_sha256: string;
  upstream_member: string | null;
  upstream_length_s: number;
  source: string;
  source_sha256: string;
  archived_as: 'verbatim' | 'excerpt';
  excerpt_start_s: number;
  region_start_s: number;
  length_s: number;
  source_length_s: number;
  shelf: { hz: number; db: number; order: number } | null;
  tempo_factor: number;
  sample_rate: number;
  channels: number;
  bytes: number;
  xfade_band_diff_db: number;
  mid_band_dbfs: number;
  attribution: string;
  rationale: string;
  retrieved: string;
}
interface Credits {
  music: MusicRecord[];
  music_terms?: unknown;
  cues: { files: { file: string }[] }[];
}

const credits = JSON.parse(readFileSync(CREDITS, 'utf8')) as Credits;
const onDisk = readdirSync(fileURLToPath(MUSIC_ON_DISK_DIR))
  .filter((f) => f.endsWith('.mp3'))
  .sort();
const parsed = new Map(
  onDisk.map((f) => [f, parseMp3(new Uint8Array(readFileSync(new URL(f, MUSIC_ON_DISK_DIR))))]),
);
const bytesOf = (name: string): number =>
  readFileSync(new URL(name, MUSIC_ON_DISK_DIR)).byteLength;

describe('the music catalogue and the files on disk', () => {
  it('names a file for every shipped loop and a shipped loop for every named file', () => {
    // Both directions, the same rule `cueCatalogue.test.ts` follows and for the same reason: a
    // path that names nothing fails SILENTLY at runtime (the deck just never sounds), so the
    // symptom of a typo is not an error anywhere, it is a bed that does not play.
    const named = musicPaths()
      .map((p) => p.replace(`${MUSIC_DIR}/`, ''))
      .sort();
    expect(named).toEqual(onDisk);
  });

  it('points every track at a file that exists', () => {
    // The assertion above compares two lists; this one goes to the filesystem, so a naming
    // scheme that drifts fails as itself rather than as a mismatch.
    for (const track of ALL_TRACKS) {
      const rel = MUSIC_CATALOGUE[track].path.replace(`${MUSIC_DIR}/`, '');
      expect(
        existsSync(fileURLToPath(new URL(rel, MUSIC_ON_DISK_DIR))),
        `${track} -> ${MUSIC_CATALOGUE[track].path} missing`,
      ).toBe(true);
    }
  });

  it('records the exact audible length the player uses to place the crossfade', () => {
    // The load-bearing number. `MusicPlayer.checkWrap` starts the next deck at
    // `lengthS - XFADE_S`; a catalogue value that drifts from the file moves the fade off the
    // seam the asset was measured at. Tolerance is 50 ms because the LAME delay/padding fields
    // are READ rather than guessed — a naive frame count would need meaningless slack.
    for (const track of ALL_TRACKS) {
      const def = MUSIC_CATALOGUE[track];
      const info = parsed.get(def.path.replace(`${MUSIC_DIR}/`, ''))!;
      expect(Math.abs(info.durationMs - def.lengthS * 1000), `${track} length`).toBeLessThan(50);
    }
  });

  it('gives every track room for a crossfade at both ends of its loop', () => {
    // The degenerate case is not theoretical: with `lengthS <= XFADE_S` the wrap condition
    // (`pos >= lengthS - XFADE_S`) is true at position 0, so the player would wrap on its first
    // frame and every frame after — a machine-gun of crossfades rather than a loop. Two full
    // windows is the honest floor: one for the tail, one so the incoming deck is settled before
    // it becomes the outgoing one.
    for (const track of ALL_TRACKS) {
      expect(MUSIC_CATALOGUE[track].lengthS, `${track} length`).toBeGreaterThan(2 * XFADE_S);
    }
  });

  it('ships every loop as STEREO Layer III at 24 kHz — the inverse of the cue rule', () => {
    // `audioAssets.test.ts` asserts channels === 1 for every cue, because a 100 ms cue's second
    // channel is pure overhead. Here a mono re-encode would halve the bytes and lose the width
    // of a bed that streams, so the same property is pinned the other way round. If these two
    // assertions ever agree, one of them has been broken.
    for (const name of onDisk) {
      const info = parsed.get(name)!;
      expect(info.channels, `${name} channel count`).toBe(2);
      expect(info.sampleRate, `${name} sample rate`).toBe(24000);
    }
  });

  it('carries the gapless metadata the loop seam depends on', () => {
    // Without the Xing/LAME tag a decoder cannot know how much encoder delay to drop, so the
    // stream starts tens of ms late — which on a LOOP is not a one-off blemish: it shifts the
    // whole file against the length the player places the crossfade from, once a minute forever.
    for (const name of onDisk) {
      const info = parsed.get(name)!;
      expect(info.rawDurationMs, `${name} has no padding to trim`).toBeGreaterThan(
        info.durationMs,
      );
    }
  });

  it('crossfades over exactly the window the loops were MEASURED across', () => {
    // The one number shared with a tool that is NOT in `npm run check` (Python in CI is a line
    // this repo has not crossed). `audit.py`'s XFADE_S is the width of the two windows
    // `xfade_band_diff` compares, and the shipped figures — menu 1.77 dB, boss 1.60 dB, both
    // measured post the 2026-09-06 tempo stretch — are that measurement. Widen `XFADE_S` on the
    // TypeScript side alone and the player fades across
    // material whose compatibility was never checked; narrow it and measured seam quality is left
    // on the table. Either way both sides stay internally consistent and nothing else notices,
    // which is exactly the drift the pipeline pass hit three times in one afternoon between its
    // own search metric and its own gate.
    const audit = readFileSync(new URL('../../../tools/audio-pipeline/audit.py', import.meta.url), 'utf8');
    const m = audit.match(/^XFADE_S\s*=\s*([\d.]+)/m);
    expect(m, 'audit.py no longer declares XFADE_S at the top level').not.toBe(null);
    expect(Number(m![1]), 'XFADE_S drifted between the player and the gate').toBe(XFADE_S);
  });

  it('stays inside the music byte budget', () => {
    const total = onDisk.reduce((n, f) => n + bytesOf(f), 0);
    expect(total).toBeLessThanOrEqual(MUSIC_BUDGET_BYTES);
  });

  it('keeps every track gain inside the headroom the loops were mastered for', () => {
    // Level is set in the ASSET (a -30 dBFS band target); `gain` is a knob on top of it, and
    // every shipped value is 1.0. A value above 1 would push a bed mastered to a measured
    // target back toward the cues it was measured to sit under.
    for (const track of ALL_TRACKS) {
      const { gain } = MUSIC_CATALOGUE[track];
      expect(gain, `${track} gain`).toBeGreaterThan(0);
      expect(gain, `${track} gain`).toBeLessThanOrEqual(1);
    }
  });
});

describe('the placeholder mechanism', () => {
  it('marks exactly the tracks that have no file of their own', () => {
    // The whole point of `borrowedFrom` being a field rather than a comment: what is real and
    // what is standing in is assertable. None stands in since 2026-10-06 (`dungeon.ember`
    // borrowed `menu.mp3` until then); a track added before its file exists shows up here.
    expect(PLACEHOLDER_TRACKS).toEqual([]);
    for (const track of ALL_TRACKS) {
      const def = MUSIC_CATALOGUE[track];
      const borrowed = def.borrowedFrom !== null;
      // A track with its own file must have a provenance record; a borrower must NOT — a record
      // for a file that does not exist is a fabricated source.
      const recorded = credits.music.some((m) => m.track === track);
      expect(recorded, `${track} provenance record`).toBe(!borrowed);
    }
  });

  it('borrows a real track, and borrows its file and length verbatim', () => {
    // Vacuous while nothing borrows, and kept: it is the rule the next placeholder must obey. A
    // borrowed entry that copied the path but not the length would put the crossfade at the
    // lender's seam minus the borrower's guess.
    for (const track of PLACEHOLDER_TRACKS) {
      const def = MUSIC_CATALOGUE[track];
      const lender = def.borrowedFrom!;
      expect(ALL_TRACKS, `${track} borrows unknown track ${lender}`).toContain(lender);
      expect(MUSIC_CATALOGUE[lender].borrowedFrom, `${lender} is itself a borrower`).toBe(null);
      expect(def.path, `${track} path`).toBe(MUSIC_CATALOGUE[lender].path);
      expect(def.lengthS, `${track} length`).toBe(MUSIC_CATALOGUE[lender].lengthS);
    }
  });

  it('never plays the same file in a dungeon and in its boss room', () => {
    // With one file on both sides of the boss-room threshold there is no audible change at all,
    // and "the music never switches" is indistinguishable from "the music feature is broken".
    for (const run of ['dungeon.ember', 'dungeon.frost'] as const) {
      expect(MUSIC_CATALOGUE[run].path, run).not.toBe(MUSIC_CATALOGUE.boss.path);
    }
  });

  it('gives each chapter a bed of its own', () => {
    expect(MUSIC_CATALOGUE['dungeon.frost'].path).not.toBe(MUSIC_CATALOGUE['dungeon.ember'].path);
  });
});

describe('music provenance', () => {
  it('describes every shipped file exactly — no orphans, no missing entries', () => {
    const recorded = credits.music.map((m) => m.file.replace(/^audio\/music\//, '')).sort();
    expect(recorded).toEqual(onDisk);
  });

  it('records each file at its real size, rate and channel count', () => {
    // Drift here means the record describes a file that is no longer what shipped, which is the
    // one thing a provenance record must not do.
    for (const m of credits.music) {
      const name = m.file.replace(/^audio\/music\//, '');
      const info = parsed.get(name)!;
      expect(bytesOf(name), `${name} bytes`).toBe(m.bytes);
      expect(info.sampleRate, `${name} rate`).toBe(m.sample_rate);
      expect(info.channels, `${name} channels`).toBe(m.channels);
      expect(Math.abs(info.durationMs - m.length_s * 1000), `${name} length`).toBeLessThan(50);
    }
  });

  it('archives the source behind every shipped loop, byte for byte as recorded', () => {
    // art/ holds source, public/ holds shipped (art/README.md's convention). Without the source
    // the region cannot be re-cut. The hash is what makes "this is the file the loop came from"
    // a checked claim rather than a filename.
    for (const m of credits.music) {
      const src = new URL(`sources/${m.source}`, ART_AUDIO);
      expect(existsSync(fileURLToPath(src)), `${m.source} not archived`).toBe(true);
      const sha = createHash('sha256').update(readFileSync(src)).digest('hex');
      expect(sha, `${m.source} changed since it was recorded`).toBe(m.source_sha256);
      expect(m.source.startsWith('music/'), `${m.track} source dir`).toBe(true);
    }
  });

  it('can always fetch the full master back', () => {
    // An excerpt is a deliberate loss (the upstream downloads are 20-50 MB), so it is only
    // acceptable with a way back to the whole recording: where it came from and what it hashed
    // to. A verbatim archive IS the upstream file, so the two hashes must agree.
    for (const m of credits.music) {
      expect(m.upstream_url, `${m.track} upstream url`).toMatch(/^https:\/\//);
      expect(m.source_page, `${m.track} source page`).toMatch(/^https:\/\//);
      expect(m.upstream_sha256, `${m.track} upstream hash`).toMatch(/^[0-9a-f]{64}$/);
      expect(['verbatim', 'excerpt'], `${m.track} archived_as`).toContain(m.archived_as);
      if (m.archived_as === 'verbatim') {
        expect(m.source_sha256, `${m.track} verbatim archive`).toBe(m.upstream_sha256);
        expect(m.excerpt_start_s, `${m.track} verbatim excerpt start`).toBe(0);
      }
      expect(
        m.excerpt_start_s + m.region_start_s + m.length_s,
        `${m.track} region runs past the end of the upstream file`,
      ).toBeLessThanOrEqual(m.upstream_length_s);
    }
  });

  it('records the region it was cut from, and that the region fits inside the archive', () => {
    for (const m of credits.music) {
      expect(m.region_start_s, `${m.track} region start`).toBeGreaterThanOrEqual(0);
      expect(
        m.region_start_s + m.length_s,
        `${m.track} region runs past the end of its archived source`,
      ).toBeLessThanOrEqual(m.source_length_s);
    }
  });

  it('records the two measurements the music gate is about, inside the gate', () => {
    // `tools/audio-pipeline/audit.py --class music`: xfade_band_diff <= 2.5 and mid_band_dbfs in
    // [-31, -29]. Duplicated here rather than trusted, because the Python gate is NOT in
    // `npm run check` (that would put Python in CI) — so without these two lines the numbers the
    // whole level and seam design rests on are checked only by a tool nobody runs on a commit.
    for (const m of credits.music) {
      expect(m.xfade_band_diff_db, `${m.track} xfade band diff`).toBeLessThanOrEqual(2.5);
      expect(m.mid_band_dbfs, `${m.track} mid-band level`).toBeGreaterThanOrEqual(-31);
      expect(m.mid_band_dbfs, `${m.track} mid-band level`).toBeLessThanOrEqual(-29);
    }
  });

  it('carries only a licence that allows a commercial, edited loop', () => {
    // The assertion that earns its place on a monetised title. An NC track would be a breach the
    // day an ad loads; an ND track would be one the moment its loop region was cut.
    for (const m of credits.music) {
      expect(ALLOWED_LICENSES, `${m.track} licence ${m.license}`).toContain(m.license);
      expect(m.license_url, `${m.track} licence url`).toMatch(/^https:\/\/creativecommons\.org\//);
      expect(m.retrieved, `${m.track} retrieved`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(m.rationale.length, `${m.track} rationale`).toBeGreaterThan(40);
    }
  });

  it('archives the licence statement it was taken under, captured from the source', () => {
    // The statement on the source page is what was agreed to; a page can change. The capture
    // must name the page it came from and the licence the record claims, so a record that is
    // edited to a different licence without a new capture fails here.
    for (const m of credits.music) {
      const url = new URL(m.license_text, ART_AUDIO);
      expect(existsSync(fileURLToPath(url)), `${m.license_text} missing`).toBe(true);
      const text = readFileSync(url, 'utf8');
      expect(text, `${m.track} capture names its page`).toContain(m.source_page);
      expect(text, `${m.track} capture names the work`).toContain(m.title);
      expect(text, `${m.track} capture names the licence`).toContain(m.license_url);
    }
  });

  it('has no service-terms block left over from the AI-generated masters', () => {
    // `music_terms` described Suno's terms. With no generated track left, a block still saying
    // "the owner accepted these terms" would be a record of something nothing ships under.
    expect(credits).not.toHaveProperty('music_terms');
  });

  it('does not let a music file leak into the SFX cue records', () => {
    // The two records are gated by different rules (mono vs stereo, CC0 vs CC-BY), so a music
    // file listed under `cues` would be held to the wrong one — and would be reported as "too
    // long" and "stereo wastes bytes", which is exactly what the Python gate did before it
    // learned to route by directory.
    const cueFiles = credits.cues.flatMap((c) => c.files.map((f) => f.file));
    for (const f of cueFiles) expect(f.startsWith('audio/music/')).toBe(false);
  });
});

describe('the in-game credit', () => {
  it('shows, for every track, exactly the credit its provenance record names', () => {
    // CC-BY's one condition is a visible credit. `musicCredits.ts` is what the Settings screen
    // renders; this holds it to the record, field by field, so swapping a file without its
    // credit (or editing one side alone) fails.
    for (const m of credits.music) {
      const c = MUSIC_CREDITS[m.track as keyof typeof MUSIC_CREDITS];
      expect(c, `${m.track} has no in-game credit`).toBeDefined();
      expect(c.line, `${m.track} line`).toBe(m.attribution);
      expect(c.title, `${m.track} title`).toBe(m.title);
      expect(c.author, `${m.track} author`).toBe(m.author);
      expect(c.license, `${m.track} licence`).toBe(m.license);
    }
  });

  it('names the title, the author and the licence in each line', () => {
    // What a CC-BY credit has to carry, checked on the rendered string rather than the fields
    // beside it — the fields are not what a player sees.
    const shortLicence: Record<string, string> = {
      'CC0-1.0': 'CC0',
      'CC-BY-4.0': 'CC-BY 4.0',
      'CC-BY-3.0': 'CC-BY 3.0',
    };
    for (const track of ALL_TRACKS) {
      const c = MUSIC_CREDITS[track];
      expect(c.line, track).toContain(`'${c.title}'`);
      expect(c.line, track).toContain(c.author);
      expect(c.line, track).toContain(shortLicence[c.license]);
    }
  });

  it('lists one line per distinct file, in track order', () => {
    expect(musicCreditLines()).toEqual(credits.music.map((m) => m.attribution));
  });
});
