/**
 * Makes design/08's `step()` skeleton — the doc this repo calls "the determinism contract" —
 * enforceable (design/18-test-strategy.md, Layer 0, alongside `determinismLint.test.ts`).
 *
 * Every system's file header opens with `Step N — …`, `GameEngine.step()` labels every call with
 * the same number, and design/08 lists the whole order. Three statements of one fact, and until
 * 2026-09-03 nothing compared them. They had disagreed for weeks:
 *
 *  - `StatusEffectSystem` was inserted as step 8 at `ENGINE_VERSION` 8 and the three systems
 *    below it never got renumbered — `DeathDropsSystem` said 8 (runs at 9), `PickupSystem` said 9
 *    (runs at 10) and its prose cross-referenced "a kill in step 8" (step 9), `SpawnSystem` said
 *    10 (runs at 11). Each also disagreed with `StatusEffectSystem`'s own header, which correctly
 *    refers forward to "death & drops (step 9)".
 *  - `ZoneSystem` and `EnvironmentSystem` had dropped the number entirely — a bare `Step —`.
 *  - design/08 did not mention `DoorSystem` (11.5) at all, while it had run between spawns and
 *    extraction since `ENGINE_VERSION` 35.
 *
 * None of that changes a single sim outcome, which is exactly why it survived 1137 green tests
 * and why it is worth a gate rather than a review habit: the numbers are how a human navigates
 * the one ordering in this codebase that IS the determinism contract, and a wrong one sends
 * someone reading about the wrong pass. The step ORDER itself is enforced by the golden hashes;
 * this file enforces that the labels describing it still tell the truth.
 *
 * The rules and their parser live in `fixtures/stepOrder.mjs`, so each one can be proven to FIRE
 * against a synthetic violation — see "the gate actually catches things" below. A contract test
 * that only ever reports zero on the real tree is indistinguishable from one that checks nothing
 * (`daydayup-test-assertion-craft`).
 */
import { describe, expect, it } from 'vitest';
import { engineSourceFiles, readEngineFile } from './fixtures/repoFiles.mjs';
import {
  checkStepNumbering, fieldClasses, labelKey, labelLessThan, parseDesignStepLabels,
  parseStepOrder, parseSystemStep, stepBody,
} from './fixtures/stepOrder.mjs';

/** Every `engine/systems/*System.ts`, keyed by file name, as the gate's scope. */
function systemSources(): Map<string, string> {
  const out = new Map<string, string>();
  for (const rel of engineSourceFiles()) {
    const m = /^systems\/(\w+System\.ts)$/.exec(rel);
    if (m) out.set(m[1], readEngineFile(rel));
  }
  return out;
}

const gameEngineSrc = readEngineFile('GameEngine.ts');
const designSrc = readEngineFile('../design/08-simulation-core.md');

describe('step numbering is consistent across code and docs', () => {
  it('every system header agrees with its position in GameEngine.step()', () => {
    expect(checkStepNumbering(gameEngineSrc, systemSources())).toEqual([]);
  });

  // Guards the guard: if the scope regex or the fixture walk ever silently matched nothing, the
  // assertion above would pass vacuously. 19 systems, 19 labelled calls.
  it('the gate has a non-empty scope', () => {
    const systems = systemSources();
    expect(systems.size).toBe(19);
    const { calls, problems } = parseStepOrder(gameEngineSrc);
    expect(problems).toEqual([]);
    expect(calls).toHaveLength(19);
    expect(calls.map(c => c.label)).toEqual([
      '1', '2', '3', '4', '5', '6', '7', '8', '8a', '8b', '9', '10', '10.5', '10.6', '11', '11.5', '12', '13', '14',
    ]);
  });

  it('design/08 lists exactly the steps step() runs', () => {
    const doc = parseDesignStepLabels(designSrc);
    const code = parseStepOrder(gameEngineSrc).calls.map(c => c.label);
    expect(doc).not.toBeNull();
    expect(doc).toEqual(code);
  });

  // `step()` is scoped to the method, not the file: `advance()` also lives in GameEngine and a
  // system's `tick` called from anywhere else must not read as part of the frozen order.
  it('reads step() only, not the whole class', () => {
    const body = stepBody(gameEngineSrc);
    expect(body).toContain('this.winCondition.tick(s)');
    expect(body).not.toContain('advance(frame');
  });
});

describe('the gate actually catches things', () => {
  // One minimal, self-contained engine + system pair that PASSES, so each case below can break
  // exactly one thing and attribute the failure to it.
  const OK_ENGINE = [
    'class GameEngine {',
    '  private readonly alpha = new AlphaSystem();',
    '  private readonly beta = new BetaSystem();',
    '  step(commands: readonly PlayerCommand[]): GameEvent[] {',
    '    this.alpha.tick(s); // 1',
    '    this.beta.tick(s); //  2  (PvE)',
    '    return s.events;',
    '  }',
    '}',
    '',
  ].join('\n');
  const okSystems = (a = 1, b = 2) => new Map([
    ['AlphaSystem.ts', `/**\n * Step ${a} — Alpha.\n */\nexport class AlphaSystem {}\n`],
    ['BetaSystem.ts', `/**\n * Step ${b} — Beta.\n */\nexport class BetaSystem {}\n`],
  ]);

  it('passes on a consistent pair (the control)', () => {
    expect(checkStepNumbering(OK_ENGINE, okSystems())).toEqual([]);
  });

  it('catches the real 2026-09-03 bug: a header one behind its call position', () => {
    // BetaSystem still claims step 1 after something was inserted above it.
    const problems = checkStepNumbering(OK_ENGINE, okSystems(1, 1));
    expect(problems).toEqual(['BetaSystem.ts header says Step 1, but step() runs it at 2']);
  });

  it('catches a header that dropped its number entirely (the ZoneSystem shape)', () => {
    const systems = okSystems();
    systems.set('BetaSystem.ts', '/**\n * Step — Beta.\n */\nexport class BetaSystem {}\n');
    expect(checkStepNumbering(OK_ENGINE, systems)).toEqual([
      'BetaSystem.ts header says "Step —" with no number (step() runs it at 2)',
    ]);
  });

  it('catches a header with no Step line at all', () => {
    const systems = okSystems();
    systems.set('BetaSystem.ts', '/** Beta, undocumented. */\nexport class BetaSystem {}\n');
    expect(checkStepNumbering(OK_ENGINE, systems)).toEqual([
      'BetaSystem.ts header has no "Step N —" line (step() runs it at 2)',
    ]);
  });

  it('catches a reordered call whose label was not moved with it', () => {
    const swapped = OK_ENGINE
      .replace('this.alpha.tick(s); // 1\n', '')
      .replace('this.beta.tick(s); //  2  (PvE)', 'this.beta.tick(s); //  2  (PvE)\n    this.alpha.tick(s); // 1');
    const problems = checkStepNumbering(swapped, okSystems());
    expect(problems).toEqual(['step() order is not increasing: beta (2) then alpha (1)']);
  });

  it('catches an unlabelled call — how a system joins the order unnumbered', () => {
    const unlabelled = OK_ENGINE.replace('this.beta.tick(s); //  2  (PvE)', 'this.beta.tick(s);');
    const problems = checkStepNumbering(unlabelled, okSystems());
    expect(problems).toContain('step() calls this.beta.tick() with no "// <step number>" comment');
  });

  it('catches a system file that step() never runs', () => {
    const systems = okSystems();
    systems.set('GammaSystem.ts', '/**\n * Step 3 — Gamma.\n */\nexport class GammaSystem {}\n');
    expect(checkStepNumbering(OK_ENGINE, systems)).toEqual([
      'engine/systems/GammaSystem.ts exists but step() never calls it',
    ]);
  });

  it('catches a call whose system file is missing', () => {
    const systems = okSystems();
    systems.delete('BetaSystem.ts');
    expect(checkStepNumbering(OK_ENGINE, systems)).toEqual([
      'step() runs BetaSystem but engine/systems/BetaSystem.ts was not found',
    ]);
  });

  it('catches a call on a field nothing constructs', () => {
    const stray = OK_ENGINE.replace('    return s.events;', '    this.ghost.tick(s); // 3\n    return s.events;');
    expect(checkStepNumbering(stray, okSystems())).toContain(
      'step() calls this.ghost.tick() but no "new …()" declares that field',
    );
  });

  it('reports a GameEngine with no step() rather than passing vacuously', () => {
    expect(parseStepOrder('class GameEngine {}').problems).toEqual([
      'GameEngine.step(commands…) body not found',
    ]);
  });
});

describe('the label vocabulary', () => {
  // The two escape hatches are load-bearing, not sloppiness: 8a/8b and 11.5 exist so that
  // inserting a pass did not have to churn every header and every design/08 citation below it.
  it('orders the suffixed and fractional labels the way the shipped order needs', () => {
    expect(labelLessThan('8', '8a')).toBe(true);
    expect(labelLessThan('8a', '8b')).toBe(true);
    expect(labelLessThan('8b', '9')).toBe(true);
    expect(labelLessThan('11', '11.5')).toBe(true);
    expect(labelLessThan('11.5', '12')).toBe(true);
  });

  it('is strict, so a duplicate label is a failure and not a tie', () => {
    expect(labelLessThan('7', '7')).toBe(false);
    expect(labelLessThan('8a', '8a')).toBe(false);
  });

  it('sorts 10 after 9 (string compare would not)', () => {
    expect(labelLessThan('9', '10')).toBe(true);
    expect('10' < '9').toBe(true); // the bug this avoids
  });

  it('rejects a label it cannot order rather than guessing', () => {
    expect(labelKey('12x3')).toBeNull();
    expect(labelKey('')).toBeNull();
    expect(labelLessThan('1', 'nope')).toBe(false);
  });
});

describe('parser details that have bitten this repo before', () => {
  // The exact trap `determinismLint.test.ts`'s header warns about: prose in a system file cites
  // other steps constantly, and matching one of those as the declaration is a silent wrong pass.
  it('does not mistake a prose cross-reference for the declaration', () => {
    const src = [
      '/**',
      ' * Step 10 — Pickup. Pickups dropped THIS tick are skipped so a',
      ' * kill in step 9 is not vacuumed the same frame.',
      ' */',
    ].join('\n');
    expect(parseSystemStep(src).declared).toBe('10');
  });

  // Found by this gate failing on its first run against the real tree, which is the reason the
  // rule is worth having at all: `GameEngine.ts`'s header says "step(commands) is the direct
  // entry (headless/tests)", and a plain `indexOf('step(commands')` matched THAT, then ran to the
  // constructor's closing brace and happily reported the field declarations as the step order —
  // seventeen systems, zero labels, and a "contract" that checked nothing.
  it('does not mistake a doc-comment mention of step(commands) for the declaration', () => {
    const src = [
      '/**',
      ' * step(commands) is the direct entry (headless/tests).',
      ' */',
      'class GameEngine {',
      '  private readonly alpha = new AlphaSystem();',
      '  constructor() {',
      '    this.state = 1;',
      '  }',
      '  step(commands: readonly PlayerCommand[]): GameEvent[] {',
      '    this.alpha.tick(s); // 1',
      '    return s.events;',
      '  }',
      '}',
    ].join('\n');
    const body = stepBody(src);
    expect(body).toContain('this.alpha.tick(s)');
    expect(body).not.toContain('private readonly alpha');
    expect(parseStepOrder(src).calls).toEqual([{ field: 'alpha', className: 'AlphaSystem', label: '1' }]);
  });

  it('ignores a Step line that appears far below the header', () => {
    const src = `/** Nothing here. */\n${'//\n'.repeat(60)} * Step 3 — not a header.\n`;
    expect(parseSystemStep(src).stated).toBe(false);
  });

  it('reads the real GameEngine field map', () => {
    const map = fieldClasses(gameEngineSrc);
    expect(map.get('pickup')).toBe('PickupSystem');
    expect(map.get('doors')).toBe('DoorSystem');
  });

  it('parses the real design/08 skeleton, including the dotless 11.5', () => {
    const labels = parseDesignStepLabels(designSrc);
    expect(labels).toContain('11.5');
    expect(labels).toContain('8a');
    // Continuation lines are indented far past a step number and must not register as steps.
    expect(labels?.filter(l => l === '05')).toHaveLength(0);
  });
});
