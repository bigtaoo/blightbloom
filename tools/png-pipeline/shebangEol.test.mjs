import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Every tracked script with a shebang must check out with LF (`.gitattributes`, 2026-09-29).
 * @vitest/mocker strips a shebang with /^#!.*\n/, and `.` does not match `\r`, so a CRLF
 * shebang line survives and the module fails to load ("SyntaxError: Invalid or unexpected
 * token"). This is what broke alphaClamp.test.mjs and lumaCurve.test.mjs in every fresh
 * Windows worktree.
 *
 * The test asserts the ATTRIBUTE, not the bytes on disk. A checkout made before the rule
 * existed already holds LF, so reading it would pass with the rule deleted. What git will
 * write on the next checkout is the property that matters.
 */
const git = (args) => execFileSync('git', args, { encoding: 'utf8' });
const root = git(['rev-parse', '--show-toplevel']).trim();
const shebangFiles = git(['-C', root, 'grep', '-l', '^#!', '--', '*.mjs', '*.js', '*.cjs', '*.ts'])
  .split('\n')
  .filter(Boolean);

describe('shebang scripts check out with LF', () => {
  it('finds the scripts it guards', () => {
    // Without this, a `git grep` that matched nothing would make the next test vacuous.
    expect(shebangFiles).toContain('tools/png-pipeline/alphaClamp.mjs');
    expect(shebangFiles).toContain('tools/png-pipeline/lumaCurve.mjs');
  });

  it('pins eol=lf on every one of them', () => {
    const out = git(['-C', root, 'check-attr', 'eol', '--', ...shebangFiles]);
    const notLf = out
      .split('\n')
      .filter(Boolean)
      .filter((line) => !line.endsWith(': eol: lf'));
    expect(notLf).toEqual([]);
  });

  it('has no CR on the shebang line of this checkout', () => {
    const bad = shebangFiles.filter((f) => {
      const head = fs.readFileSync(path.join(root, f), 'utf8').split('\n', 1)[0];
      return head.endsWith('\r');
    });
    expect(bad).toEqual([]);
  });
});
