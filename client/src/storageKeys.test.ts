/**
 * Every persistent storage key this client writes, pinned by name (2026-09-17).
 *
 * These seven strings are the only handle a returning player has on everything they own.
 * Nothing in the tree depended on any of them: each is a lone literal in one module, read
 * back only by that module, so renaming one is a one-word edit that no type, no test and no
 * gate would have noticed — and the day it happens every existing player silently becomes a
 * new player. Their save, their settings, their in-progress run and their LOGIN all read as
 * absent, because absent is exactly what a different key returns.
 *
 * That is not hypothetical here. This project was renamed from the codename `daydayup` to
 * Blightbloom on 2026-09-06 and the rename was deliberately left unfinished: every
 * `daydayup` string still in the tree is load-bearing, and "tidying up the last of the old
 * name" is the specific mistake this file exists to turn into a failing test rather than a
 * support thread. `design/16-accounts.md` and the rename note in the README are the prose;
 * this is the gate.
 *
 * It is a source sweep, so its own worst failure mode is matching nothing and passing
 * forever. Three guards against that, the same three `client/src/game/pureLayerBoundary
 * .test.ts` uses: the set is compared EXACTLY (a new unpinned key fails just as loudly as a
 * renamed one), the number of files actually read has a floor, and the CONVERSE is asserted
 * — no key wearing the new name, which is what a half-finished rename would leave behind.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('.', import.meta.url));

/** Key → what it holds, and what a rename of it costs the player. */
const KEYS: Record<string, string> = {
  'daydayup.session.v1': 'the logged-in session — a rename signs every player out and hides their cloud save',
  'daydayup.playerId.v1': 'the guest install id — the ladder key, the analytics cohort, and the one-time merge key',
  'daydayup.meta.v1': 'MetaState: blueprints, materials, loadout — the whole Forge',
  'daydayup.runsave.v1': 'the in-progress run CONTINUE RUN resumes',
  'daydayup.settings.v1': 'audio/locale/quality settings',
  'daydayup.perf.fpsWarn': 'a dev-set perf warning threshold',
  'daydayup.perf.busyWarn': 'a dev-set perf warning threshold',
};

const KEY_LITERAL = /(['"`])(daydayup\.[A-Za-z0-9_.]+)\1/g;
/** What a "finished" rename would leave: the same key shape under the current project name. */
const RENAMED_LITERAL = /(['"`])(blightbloom\.[A-Za-z0-9_.]+)\1/g;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Comments are stripped before the match. Three modules name a key in prose — `identity.ts`
 * says the WeChat build reuses `daydayup.playerId.v1`, and saying so is exactly the sort of
 * cross-reference worth having — but a sweep that counts those cannot tell "written twice"
 * from "written once and explained". The stripping is itself asserted below, because one
 * that ate the whole file would make every check here pass over nothing.
 */
const stripComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const files = sourceFiles(SRC);
const found = new Map<string, string[]>();
const renamed: string[] = [];
let strippedSomething = false;
for (const file of files) {
  const raw = readFileSync(file, 'utf8');
  const text = stripComments(raw);
  if (text.length < raw.length) strippedSomething = true;
  for (const [, , key] of text.matchAll(KEY_LITERAL)) {
    found.set(key, [...(found.get(key) ?? []), file]);
  }
  for (const [, , key] of text.matchAll(RENAMED_LITERAL)) renamed.push(`${key} (${file})`);
}

describe('storage keys — the handles a returning player has on their own data', () => {
  it('read the source tree it claims to have read', () => {
    // The floor. A sweep whose walk silently returned nothing would satisfy every
    // "contains no..." assertion below and report a clean tree it never opened.
    expect(files.length).toBeGreaterThan(200);
    expect(files.some((f) => f.endsWith('session.ts'))).toBe(true);
    // ...and stripped comments out of it rather than the code: a strip that returned the
    // empty string would make "no key wearing the new name" true of an empty tree.
    expect(strippedSomething).toBe(true);
    expect(stripComments(readFileSync(join(SRC, 'net', 'session.ts'), 'utf8'))).toContain(
      "const STORAGE_KEY = 'daydayup.session.v1'",
    );
  });

  it('are exactly these seven, spelled exactly this way', () => {
    // An exact set, not a subset: a NEW key added without a line here fails too, which is the
    // half that keeps this file from going stale while looking like it is working.
    expect([...found.keys()].sort()).toEqual(Object.keys(KEYS).sort());
  });

  it('are each written in exactly one module', () => {
    // A key spelled out twice is a key that can be renamed in one place and not the other —
    // the same silent data loss, arriving through a copy instead of an edit.
    for (const [key, where] of found) expect(where, `${key}: ${KEYS[key]}`).toHaveLength(1);
  });

  it('carry no twin under the new project name', () => {
    // The converse, and the actual failure mode: the rename to Blightbloom was left
    // unfinished on purpose. A `blightbloom.*` key means somebody finished it, and every
    // player's data is behind the old name.
    expect(renamed).toEqual([]);
  });
});
