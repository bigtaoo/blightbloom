/**
 * `npm run loadtest:match -w server -- [--url http://localhost:8788] [--coop 20] [--pvp 12]
 *   [--coop-parties 6] [--squads 2] [--shared-ip 203.0.113.7] [--timeout 60000]`
 *
 * The CLI around `matchLoad.ts` (2026-09-26): plays the given mix of clients against a running
 * matchsvc and prints the outcome — seat counts by status, rooms formed, time-to-match
 * percentiles, and every invariant broken. Exits 1 on any violation.
 *
 * Point it at a local or staging matchsvc, **never at production**: every room formed is real
 * and every empty seat is a real bot connection on the gameserver behind it. Without a
 * `BB_TICKET_SECRET`-matched gameserver the tickets are still minted — this measures the
 * control plane, which is where a queue can strand someone.
 */
import { runMatchLoad, type LoadPlan } from './matchLoad';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const num = (name: string, fallback: number) => Number(arg(name) ?? fallback);

const plan: LoadPlan = {
  coop: num('coop', 20),
  pvp: num('pvp', 12),
  coopParties: num('coop-parties', 6),
  squads: num('squads', 2),
};
const report = await runMatchLoad({
  baseUrl: arg('url') ?? 'http://localhost:8788',
  plan,
  sharedIp: arg('shared-ip'),
  timeoutMs: num('timeout', 60_000),
});

console.log(JSON.stringify({ plan, byStatus: report.byStatus, rooms: report.rooms, waitMs: report.waitMs }, null, 2));
if (report.violations.length > 0) {
  console.error(`\n${report.violations.length} violation(s):`);
  for (const v of report.violations) console.error(`  - ${v}`);
  process.exit(1);
}
console.log('\nOK — every seat matched, no room over-filled, no party split.');
