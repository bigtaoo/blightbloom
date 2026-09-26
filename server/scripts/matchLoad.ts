/**
 * The matchmaking load driver (2026-09-26, the launch-readiness pass on auto-matchmaking).
 *
 * Plays dozens of clients against a matchsvc at once — solo co-op, solo PvP, co-op parties
 * and PvP squads, each through the same HTTP calls the real client makes (`/party/*`, then
 * `POST /find` and a `GET /find/:id` poll) — and checks the answers rather than timing them:
 *
 *  - **nobody is left in the queue**: every seat ends `matched`, none `expired`/`timeout`;
 *  - **no room is over-filled or double-seated**: owners unique, never more than `playerCount`;
 *  - **a party is never split**: every member lands in ONE room, and a squad in ONE team;
 *  - **the per-IP budgets refuse nobody who should not be refused**: each client comes from
 *    its own `X-Forwarded-For` address (what Caddy appends, and the hop `rateLimit.clientKey`
 *    reads), unless {@link LoadOptions.sharedIp} deliberately puts them all behind one NAT.
 *
 * A module rather than a script body so `test/matchLoad.test.ts` can run it against an
 * in-process matchsvc on every CI run; `loadtestMatchmaking.ts` is the CLI around it for a
 * real deployment. **Never point it at production**: every room it forms is a real room, and
 * every empty seat is a real bot connection on a real gameserver.
 */

export type LoadKind = 'coop' | 'pvp' | 'coopParty' | 'squad';

/** How many of each UNIT to play. A co-op party is two clients, a squad four. */
export interface LoadPlan {
  coop: number;
  pvp: number;
  coopParties: number;
  squads: number;
}

export interface LoadOptions {
  baseUrl: string;
  plan: LoadPlan;
  /** Seats in a PvP room — the client's `SQUAD_MATCH_SEATS`. Default 8. */
  pvpSeats?: number;
  /** Poll cadence while queued. Default 500 ms, the real client's. */
  pollMs?: number;
  /** A seat still queued this long after it started is reported `timeout`. Default 60 s. */
  timeoutMs?: number;
  /** Arrivals are spread evenly over this window rather than landing in one tick. Default 2 s. */
  staggerMs?: number;
  /** Put every client behind this one address (a carrier-grade NAT). Default: one each. */
  sharedIp?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export type SeatStatus = 'matched' | 'expired' | 'timeout' | 'refused' | 'error';

export interface SeatOutcome {
  client: string;
  unit: string;
  kind: LoadKind;
  status: SeatStatus;
  /** The HTTP status of the refusal, for `refused`/`error`. */
  httpStatus?: number;
  roomId?: string;
  owner?: number;
  teamId?: number;
  playerCount?: number;
  waitedMs: number;
}

export interface LoadReport {
  seats: SeatOutcome[];
  byStatus: Record<SeatStatus, number>;
  rooms: number;
  waitMs: { p50: number; p95: number; max: number };
  /** Every invariant the run broke, in words. Empty is the pass. */
  violations: string[];
}

interface Ctx {
  base: string;
  pvpSeats: number;
  pollMs: number;
  timeoutMs: number;
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

class Refused extends Error {
  constructor(readonly httpStatus: number, message: string) {
    super(message);
  }
}

async function call(ctx: Ctx, ip: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await ctx.fetch(`${ctx.base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = ((await res.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  if (!res.ok) throw new Refused(res.status, String(json.error ?? res.status));
  return json;
}

/** One seat's `/find` + poll, exactly as `client/src/net/matchmaking.ts` does it. */
async function findSeat(ctx: Ctx, seat: Omit<SeatOutcome, 'status' | 'waitedMs'>, ip: string, body: object): Promise<SeatOutcome> {
  const started = ctx.now();
  const done = (status: SeatStatus, extra: Partial<SeatOutcome> = {}): SeatOutcome => ({
    ...seat, status, waitedMs: ctx.now() - started, ...extra,
  });
  const matched = (m: Record<string, unknown>) =>
    done('matched', { roomId: m.roomId as string, owner: m.owner as number, teamId: m.teamId as number, playerCount: m.playerCount as number });
  try {
    const found = await call(ctx, ip, '/find', body);
    if (found.match) return matched(found.match as Record<string, unknown>);
    for (;;) {
      await ctx.sleep(ctx.pollMs);
      const polled = await call(ctx, ip, `/find/${encodeURIComponent(found.queueId as string)}`);
      if (polled.status === 'matched') return matched(polled.match as Record<string, unknown>);
      if (polled.status === 'expired') return done('expired');
      if (ctx.now() - started >= ctx.timeoutMs) return done('timeout');
    }
  } catch (e) {
    return e instanceof Refused ? done(e.httpStatus === 429 ? 'refused' : 'error', { httpStatus: e.httpStatus }) : done('error');
  }
}

/** A party of `size` from create to every member's seat. A refused party call refuses them all. */
async function playParty(ctx: Ctx, unit: string, kind: 'coopParty' | 'squad', clients: string[], ipOf: (c: string) => string): Promise<SeatOutcome[]> {
  const mode = kind === 'coopParty' ? 'coop' : 'pvp';
  const playerCount = kind === 'coopParty' ? 2 : ctx.pvpSeats;
  const [leader, ...members] = clients as [string, ...string[]];
  let partyId: string;
  try {
    const created = await call(ctx, ipOf(leader), '/party/create', { playerId: leader, mode });
    partyId = created.partyId as string;
    for (const m of members) await call(ctx, ipOf(m), '/party/join', { playerId: m, code: created.code });
    await call(ctx, ipOf(leader), '/party/start', { partyId, playerId: leader });
  } catch (e) {
    const httpStatus = e instanceof Refused ? e.httpStatus : undefined;
    const status: SeatStatus = httpStatus === 429 ? 'refused' : 'error';
    return clients.map((client) => ({ client, unit, kind, status, httpStatus, waitedMs: 0 }));
  }
  // The leader queues on START; each member only after its own party poll sees `matching`,
  // i.e. up to one poll later — the stagger that makes a party arrive in pieces.
  return Promise.all(
    clients.map(async (client, i) => {
      if (i > 0) await ctx.sleep(Math.round((ctx.pollMs * i) / clients.length));
      return findSeat(ctx, { client, unit, kind }, ipOf(client), { playerCount, mode, partyId });
    }),
  );
}

function percentile(sorted: number[], p: number): number {
  return sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}

/** The invariants, over the finished seats. */
export function checkInvariants(seats: readonly SeatOutcome[]): string[] {
  const out: string[] = [];
  for (const s of seats) if (s.status !== 'matched') out.push(`${s.client} (${s.kind}) ended ${s.status}${s.httpStatus ? ` ${s.httpStatus}` : ''}`);
  const rooms = new Map<string, SeatOutcome[]>();
  for (const s of seats) if (s.roomId) rooms.set(s.roomId, [...(rooms.get(s.roomId) ?? []), s]);
  for (const [roomId, inRoom] of rooms) {
    const owners = new Set(inRoom.map((s) => s.owner));
    if (owners.size !== inRoom.length) out.push(`room ${roomId} seats two clients in one chair`);
    if (inRoom.length > inRoom[0]!.playerCount!) out.push(`room ${roomId} holds ${inRoom.length} of ${inRoom[0]!.playerCount}`);
  }
  const units = new Map<string, SeatOutcome[]>();
  for (const s of seats) if (s.kind === 'coopParty' || s.kind === 'squad') units.set(s.unit, [...(units.get(s.unit) ?? []), s]);
  for (const [unit, members] of units) {
    if (members.some((s) => s.status !== 'matched')) continue; // already reported per seat
    if (new Set(members.map((s) => s.roomId)).size !== 1) out.push(`${unit} was split across rooms`);
    else if (new Set(members.map((s) => s.teamId)).size !== 1 && members[0]!.kind === 'squad') out.push(`${unit} was split across teams`);
  }
  return out;
}

export async function runMatchLoad(opts: LoadOptions): Promise<LoadReport> {
  const ctx: Ctx = {
    base: opts.baseUrl.replace(/\/$/, ''),
    pvpSeats: opts.pvpSeats ?? 8,
    pollMs: opts.pollMs ?? 500,
    timeoutMs: opts.timeoutMs ?? 60_000,
    fetch: opts.fetch ?? fetch,
    sleep: opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    now: opts.now ?? Date.now,
  };
  let n = 0;
  const ipOf = (client: string) => opts.sharedIp ?? client.split('@')[1]!;
  const newClient = () => {
    const i = ++n;
    return `c${i}@10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;
  };

  const units: (() => Promise<SeatOutcome[]>)[] = [];
  const { coop, pvp, coopParties, squads } = opts.plan;
  for (let i = 0; i < coop; i++) {
    const c = newClient();
    units.push(async () => [await findSeat(ctx, { client: c, unit: c, kind: 'coop' }, ipOf(c), { playerCount: 2, mode: 'coop' })]);
  }
  for (let i = 0; i < pvp; i++) {
    const c = newClient();
    units.push(async () => [await findSeat(ctx, { client: c, unit: c, kind: 'pvp' }, ipOf(c), { playerCount: ctx.pvpSeats, mode: 'pvp' })]);
  }
  for (let i = 0; i < coopParties; i++) {
    const cs = [newClient(), newClient()];
    units.push(() => playParty(ctx, `coop-party-${i}`, 'coopParty', cs, ipOf));
  }
  for (let i = 0; i < squads; i++) {
    const cs = [newClient(), newClient(), newClient(), newClient()];
    units.push(() => playParty(ctx, `squad-${i}`, 'squad', cs, ipOf));
  }

  // Interleave the kinds (a round-robin over the plan order would queue every co-op client
  // before the first PvP one), then spread the arrivals over the stagger window.
  const order = units.map((u, i) => ({ u, k: (i * 7919) % units.length })).sort((a, b) => a.k - b.k);
  const gap = order.length > 1 ? (opts.staggerMs ?? 2_000) / (order.length - 1) : 0;
  const seats = (
    await Promise.all(
      order.map(async ({ u }, i) => {
        await ctx.sleep(Math.round(gap * i));
        return u();
      }),
    )
  ).flat();

  const byStatus: Record<SeatStatus, number> = { matched: 0, expired: 0, timeout: 0, refused: 0, error: 0 };
  for (const s of seats) byStatus[s.status]++;
  const waits = seats.filter((s) => s.status === 'matched').map((s) => s.waitedMs).sort((a, b) => a - b);
  return {
    seats,
    byStatus,
    rooms: new Set(seats.map((s) => s.roomId).filter(Boolean)).size,
    waitMs: { p50: percentile(waits, 0.5), p95: percentile(waits, 0.95), max: waits[waits.length - 1] ?? 0 },
    violations: checkInvariants(seats),
  };
}
