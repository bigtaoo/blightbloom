/**
 * `StagedBuild` — the step queue a descend's floor is built from, a few ms per frame. The order is
 * the contract that matters: a floor's pieces are MOUNTED in step order, and mount order is draw
 * order, so a runner that reordered anything would repaint the floor wrong without failing a
 * single geometry test.
 */
import { describe, it, expect } from 'vitest';
import { StagedBuild, solo, type BuildStep } from './stagedBuild';

/** A clock that advances `per` ms every time it is read. */
function clock(per: number): () => number {
  let t = 0;
  return () => (t += per);
}

function recorder(): { log: string[]; step: (name: string, more?: BuildStep[]) => BuildStep } {
  const log: string[] = [];
  return { log, step: (name, more) => () => { log.push(name); return more; } };
}

describe('StagedBuild', () => {
  it('runs every step, in order, on runAll', () => {
    const { log, step } = recorder();
    const b = new StagedBuild();
    b.start([step('a'), step('b'), step('c')]);
    b.runAll();
    expect(log).toEqual(['a', 'b', 'c']);
    expect(b.busy).toBe(false);
  });

  it('runs a step\'s expansion NEXT, ahead of the rest of the queue', () => {
    const { log, step } = recorder();
    const b = new StagedBuild();
    b.start([step('plan', [step('wall1'), step('wall2', [step('wall2.cap')])]), step('portal')]);
    b.runAll();
    expect(log).toEqual(['plan', 'wall1', 'wall2', 'wall2.cap', 'portal']);
  });

  it('stops at the budget and resumes where it left off', () => {
    const { log, step } = recorder();
    const b = new StagedBuild();
    b.start([step('a'), step('b'), step('c'), step('d'), step('e')]);
    const now = clock(3); // start=3, then 6 after a, 9 after b...
    expect(b.runFor(5, now)).toBe(true); // a (6-3=3 < 5) b (9-3=6 >= 5) → stop
    expect(log).toEqual(['a', 'b']);
    expect(b.runFor(5, now)).toBe(true);
    expect(log).toEqual(['a', 'b', 'c', 'd']);
    expect(b.runFor(5, now)).toBe(false);
    expect(log).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('always makes progress: one step per call even when a single step blows the budget', () => {
    const { log, step } = recorder();
    const b = new StagedBuild();
    b.start([step('a'), step('b')]);
    const now = clock(100);
    b.runFor(4, now);
    expect(log).toEqual(['a']);
    b.runFor(4, now);
    expect(log).toEqual(['a', 'b']);
  });

  it('start replaces a queue in progress, and cancel empties it', () => {
    const { log, step } = recorder();
    const b = new StagedBuild();
    b.start([step('old1'), step('old2')]);
    b.runFor(0, clock(1));
    b.start([step('new')]);
    b.runAll();
    expect(log).toEqual(['old1', 'new']);
    b.start([step('x')]);
    b.cancel();
    expect(b.busy).toBe(false);
    b.runAll();
    expect(log).toEqual(['old1', 'new']);
  });

  it('does not keep a caller\'s array alive or mutate it', () => {
    const { step } = recorder();
    const steps = [step('a'), step('b')];
    const b = new StagedBuild();
    b.start(steps);
    b.runAll();
    expect(steps).toHaveLength(2);
  });

  it('a solo step gets a frame to itself — never after another step, nothing after it', () => {
    const { log, step } = recorder();
    const b = new StagedBuild();
    b.start([step('a'), step('b'), solo(() => { log.push('HEAVY'); }), step('c'), step('d')]);
    const now = clock(0); // an infinitely fast clock: only `solo` can end a frame early
    b.runFor(4, now);
    expect(log).toEqual(['a', 'b']);
    b.runFor(4, now);
    expect(log).toEqual(['a', 'b', 'HEAVY']);
    b.runFor(4, now);
    expect(log).toEqual(['a', 'b', 'HEAVY', 'c', 'd']);
  });

  it('two solo steps in a row take a frame each, and runAll ignores the marking', () => {
    const log: string[] = [];
    const b = new StagedBuild();
    b.start([solo(() => { log.push('x'); }), solo(() => { log.push('y'); })]);
    b.runFor(4, clock(0));
    expect(log).toEqual(['x']);
    b.runFor(4, clock(0));
    expect(log).toEqual(['x', 'y']);
    b.start([solo(() => { log.push('p'); }), solo(() => { log.push('q'); })]);
    b.runAll();
    expect(log).toEqual(['x', 'y', 'p', 'q']);
  });
});
