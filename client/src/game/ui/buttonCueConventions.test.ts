/**
 * The UI-cue conventions, swept over EVERY `new Button(...)` in the client rather than sampled
 * (design/11 "The UI cues").
 *
 * `gameUiSound.test.ts` presses real buttons on real screens, which is the stronger evidence —
 * but it can only assert the call sites someone thought to list, and the decision this pass
 * spread across ~14 screen files is per-call-site: a button that dismisses a screen must say
 * `sound: 'ui.back'`, a settings option `sound: 'ui.toggle'`, and only the two buttons whose
 * OUTCOME picks the cue may be `'silent'`. The failure mode is a new screen shipping a BACK
 * button that sounds like a forward one — which on a phone is the same finger in nearly the
 * same place, and is the kind of thing nobody files a bug about.
 *
 * So this reads the source. It is crude, deliberately: the alternative is a runtime registry of
 * every Button ever constructed, which is machinery in shipped code to serve a test. The guards
 * against a crude sweep going vacuous — the real risk with a regex, since a regex that matches
 * nothing passes everything — are the floors at the bottom: the number of buttons found, the
 * number of dismiss buttons among them, and a hard failure on any construction shape the parser
 * cannot classify.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const GAME_SRC = fileURLToPath(new URL('../', import.meta.url));

/** A button whose name says it dismisses the screen it is on. */
const DISMISSES = /^(back|cancel|leave|quit|resume|close|menu)/i;

/**
 * The only buttons allowed to make no sound of their own, each because the TRANSACTION behind
 * it decides between `ui.tap` and `ui.denied` (`ForgeActions`) — the widget cannot know whether
 * the press did anything. Anything else that goes silent is a bug, not a decision.
 */
const SILENT_BY_DESIGN = new Set(['screens/StoreScreen.ts:skuRowBtn']);

const ALLOWED = new Set(['ui.tap', 'ui.back', 'ui.toggle', 'ui.denied', 'silent']);

interface Site {
  file: string;
  name: string;
  sound: string | null; // null = the default, ui.tap
  line: string;
}

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return tsFiles(full);
    return entry.endsWith('.ts') && !entry.endsWith('.test.ts') ? [full] : [];
  });
}

/** Every `new Button(...)` construction in `src/game`, with the field it is assigned to. */
function buttonSites(): Site[] {
  const sites: Site[] = [];
  for (const file of tsFiles(GAME_SRC)) {
    const rel = file.slice(GAME_SRC.length).replace(/\\/g, '/');
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const at = line.indexOf('new Button(');
      if (at < 0) continue;
      // The name is the last identifier before the `=`: covers `this.backBtn = new Button(`,
      // `const row = new Button(` and `readonly pauseBtn = new Button(` alike.
      const name = /([A-Za-z_]\w*)\s*=\s*$/.exec(line.slice(0, at))?.[1] ?? '';
      const sound = /sound:\s*'([^']*)'/.exec(line.slice(at))?.[1] ?? null;
      sites.push({ file: rel, name, sound, line: line.trim() });
    }
  }
  return sites;
}

const sites = buttonSites();
const key = (s: Site) => `${s.file}:${s.name}`;

describe('every Button in the client declares a cue that matches what it does', () => {
  it('parses every construction — an unrecognised shape fails rather than being skipped', () => {
    // The guard that keeps the rest of this file honest. A refactor to, say, a factory function
    // or a multi-line constructor call would silently shrink the sweep to nothing; here it
    // fails instead, and whoever made the change decides what the convention becomes.
    const unparsed = sites.filter((s) => !s.name);
    expect(unparsed.map((s) => `${s.file}: ${s.line}`)).toEqual([]);
  });

  it('marks the button that leaves a screen with ui.back, and nothing else', () => {
    const dismiss = sites.filter((s) => DISMISSES.test(s.name));
    for (const s of dismiss) {
      expect(s.sound, `${key(s)} dismisses its screen and must sound like it`).toBe('ui.back');
    }
    // The converse, so `ui.back` cannot drift onto a button that goes FORWARD: every use of it
    // is on a name that reads as leaving.
    for (const s of sites.filter((s) => s.sound === 'ui.back')) {
      expect(DISMISSES.test(s.name), `${key(s)} plays ui.back but is not a dismiss button`).toBe(true);
    }
    expect(dismiss.length, 'the dismiss sweep found suspiciously few buttons')
      .toBeGreaterThanOrEqual(10);
  });

  it('marks every settings option with ui.toggle', () => {
    // Scoped to the one screen where it is a rule rather than a judgement: everything on
    // `Settings.ts` except its exit changes a value under the player's finger. This is where a
    // new setting gets added, and where forgetting the cue would be least visible.
    const settings = sites.filter((s) => s.file === 'screens/Settings.ts');
    const options = settings.filter((s) => !DISMISSES.test(s.name));
    for (const s of options) {
      expect(s.sound, `${key(s)} is a settings option`).toBe('ui.toggle');
    }
    expect(options.length).toBeGreaterThanOrEqual(4);
  });

  it('lets only the outcome-dependent buttons stay silent', () => {
    const silent = sites.filter((s) => s.sound === 'silent').map(key).sort();
    expect(silent).toEqual([...SILENT_BY_DESIGN].sort());
  });

  it('uses no cue outside the family, and leaves the ordinary button on the default', () => {
    for (const s of sites) {
      if (s.sound !== null) expect(ALLOWED, `${key(s)} declares '${s.sound}'`).toContain(s.sound);
    }
    // The default is the point: a button that means nothing special opts into nothing, and
    // still clicks. If this ever reached zero, every button would be hand-annotated and the
    // next one added would be the one that is forgotten.
    expect(sites.filter((s) => s.sound === null).length).toBeGreaterThanOrEqual(20);
  });

  it('swept the whole screen layer, not a corner of it', () => {
    expect(sites.length, 'found far fewer buttons than the client has').toBeGreaterThanOrEqual(40);
    const files = new Set(sites.map((s) => s.file));
    for (const expected of [
      'screens/MainMenu.ts', 'ui/LobbyRoutes.ts', 'screens/Forge.ts', 'screens/Settings.ts',
      'screens/PauseMenu.ts', 'screens/Screens.ts', 'ui/HudView.ts', 'ui/PortalPrompt.ts',
    ]) {
      expect(files, `${expected} contributed no buttons — did the sweep miss it?`).toContain(expected);
    }
  });
});
