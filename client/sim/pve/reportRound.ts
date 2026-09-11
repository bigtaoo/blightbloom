/**
 * Rounding helpers shared by `report.ts` and its `reportFire.ts` sibling (CLAUDE.md
 * "500-line file convention"). A leaf on purpose: it imports nothing, so the shell can
 * re-export the sibling without either of them importing the shell back.
 *
 * Every number in these reports is rounded at the point it is STORED, not at the point
 * it is printed, so a table and an assertion over the same field can never disagree.
 */
export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
export function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
