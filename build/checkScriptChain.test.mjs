// Every `check:*` script is either in the `check` chain or exempt on the record.
//
// A gate is a file plus the thing that runs it, and only the first half is visible. Drop
// `npm run check:assetheaders` from the `check` chain and the gate still exists, still passes
// when invoked by hand, still has a green test suite of its own — and never runs again, in CI
// or locally. Nothing turns red; the drift it was watching simply resumes.
//
// The exemptions below are the two gates that are deliberately NOT in `check`, each with the
// reason, because "a working way to be exempt is an invitation to use it" (the coverage gate's
// own note in CLAUDE.md) — so the list is short, stated, and itself checked: an exemption that
// stops matching a real script fails this file rather than sitting there.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

/** `check:*` scripts that the `check` chain deliberately does not run. */
const EXEMPT = [
  {
    script: 'check:coverage',
    why: 'measured by `npm run coverage`, which is minutes rather than seconds — CI runs it as its own job (CLAUDE.md, "Test coverage: 90/90")',
  },
  {
    script: 'check:logic',
    why: 'the named logic-consistency gates, verified then run by `npm run check:logic` — its own CI job for the same reason',
  },
];

describe('the root `check` chain', () => {
  const chain = pkg.scripts.check;
  // A `check:*` script that itself runs `check` is a SUPERSET (`check:full` = `check` plus the
  // balance sims), not a gate the chain is supposed to contain. Derived rather than listed by
  // name, so the next wrapper added needs no edit here — and so a wrapper cannot be quietly
  // used as a hiding place for a gate.
  const gates = Object.keys(pkg.scripts)
    .filter((s) => s.startsWith('check:'))
    .filter((s) => !pkg.scripts[s].includes('npm run check '));

  it('runs every check gate that is not exempt', () => {
    const missing = gates
      .filter((g) => !EXEMPT.some((e) => e.script === g))
      .filter((g) => !chain.includes(`npm run ${g}`));
    expect(missing, `these gates exist but nothing runs them: ${missing.join(', ')}`).toEqual([]);
  });

  it('has more than one gate in it, so the case above cannot pass vacuously', () => {
    // The failure mode of a filter-then-assert-empty test: a rename that makes `gates` empty
    // leaves `missing` empty too, and the case above goes green over nothing at all.
    expect(gates.length).toBeGreaterThan(3);
    expect(gates).toContain('check:assetheaders');
  });

  it('has no exemption for a script that no longer exists', () => {
    for (const { script, why } of EXEMPT) {
      expect(pkg.scripts[script], `exempt but undefined: ${script} (${why})`).toBeDefined();
      expect(chain, `${script} is exempt and yet in the chain`).not.toContain(`npm run ${script}`);
    }
  });

  it('starts on the typecheck and ends on the test suite', () => {
    // Ordering is a convenience rather than a rule, but it is the one every gate relies on: a
    // typo should fail in seconds, not after the full suite has run.
    //
    // The first version of this case was `indexOf('typecheck') < indexOf('npm run test')`, and
    // a mutation battery killed it — putting the suite FIRST removes `typecheck` from the
    // chain entirely, `indexOf` answers −1, and −1 is less than everything. The presence of
    // each step has to be asserted before any two of them are compared; this file says so
    // about a needle in prose and then did it anyway.
    const steps = chain.split('&&').map((s) => s.trim());
    expect(steps.filter((s) => s === 'npm run typecheck')).toHaveLength(1);
    expect(steps[0]).toBe('npm run typecheck');
    expect(steps[steps.length - 1]).toBe('npm run test');
  });
});
