/**
 * `GET /metrics` — the Prometheus exposition every service serves.
 *
 * The infrastructure half of "server status" is already answered by the box's own cAdvisor
 * and node-exporter, which `monitoring/prometheus.yml` scrapes rather than duplicating.
 * What those cannot see is anything ABOUT this game: a container using 40 MB of RAM looks
 * identical whether it is holding twelve live matches or nothing at all. That is what this
 * file adds, and it is deliberately a short list — a gauge nobody has a question for is a
 * gauge nobody maintains.
 *
 * ## Hand-rolled, like everything else here
 *
 * No `prom-client`. `deploy/package.json` has one runtime dependency and each entry point
 * is a flat esbuild bundle; the exposition format is a text format, and rendering it is the
 * forty lines below. The same trade `log.ts` makes for the same reason.
 *
 * ## The route is internal, and stays internal
 *
 * `/metrics` is served on each service's own port, which is `expose`d and never published
 * (`docker-compose.yml`) — reachable from Prometheus over the compose network and from
 * nowhere else. matchsvc is the one service Caddy proxies wholesale, so it is also the one
 * where that is not automatic: `matchsvc.ts` refuses a `/metrics` request that arrived
 * through the proxy, because a public metrics endpoint is a free readout of how many
 * players are online and how the queue is doing.
 */

export type MetricType = 'gauge' | 'counter';

export interface Metric {
  name: string;
  help: string;
  type: MetricType;
  value: number;
  labels?: Record<string, string>;
}

/** Escape a label value per the exposition format: backslash, double quote, newline. */
function escapeLabel(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/**
 * Render metrics in the Prometheus text exposition format.
 *
 * `# HELP`/`# TYPE` are emitted once per metric NAME even when several series share it —
 * repeating them makes Prometheus reject the whole scrape as a duplicate declaration,
 * which presents as "the target is down" rather than as a formatting complaint.
 */
export function renderMetrics(metrics: readonly Metric[]): string {
  const lines: string[] = [];
  const declared = new Set<string>();
  for (const m of metrics) {
    if (!declared.has(m.name)) {
      declared.add(m.name);
      lines.push(`# HELP ${m.name} ${m.help}`);
      lines.push(`# TYPE ${m.name} ${m.type}`);
    }
    const labels = Object.entries(m.labels ?? {})
      .map(([k, v]) => `${k}="${escapeLabel(v)}"`)
      .join(',');
    // A non-finite value renders as `NaN`/`+Inf`, both of which Prometheus accepts and
    // neither of which any panel can plot. Zero is the honest reading for a gauge whose
    // source failed, so the coercion is here rather than at every call site.
    const value = Number.isFinite(m.value) ? m.value : 0;
    lines.push(labels ? `${m.name}{${labels}} ${value}` : `${m.name} ${value}`);
  }
  // The format requires a trailing newline; without it the last sample is silently dropped.
  return `${lines.join('\n')}\n`;
}

export const METRICS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

/**
 * The three numbers every process here reports, so a dashboard row exists for a service
 * before anybody has thought of a service-specific gauge for it.
 *
 * `uptime` is the one that earns its place: a container that is restarting in a loop shows
 * as healthy in `docker ps` for as long as each attempt survives its start period, and the
 * only tell from outside is an uptime that keeps resetting.
 */
export function processMetrics(svc: string, now: () => number = Date.now, startedAtMs?: number): Metric[] {
  const labels = { svc };
  const uptimeSec = startedAtMs === undefined ? process.uptime() : (now() - startedAtMs) / 1000;
  const mem = process.memoryUsage();
  return [
    {
      name: 'bb_process_uptime_seconds',
      help: 'Seconds since this process started.',
      type: 'gauge',
      value: uptimeSec,
      labels,
    },
    {
      name: 'bb_process_resident_memory_bytes',
      help: 'Resident set size of this process.',
      type: 'gauge',
      value: mem.rss,
      labels,
    },
    {
      name: 'bb_process_heap_used_bytes',
      help: 'V8 heap in use by this process.',
      type: 'gauge',
      value: mem.heapUsed,
      labels,
    },
  ];
}

/** A convenience for the common shape: a single labelled gauge. */
export function gauge(name: string, help: string, value: number, labels?: Record<string, string>): Metric {
  return { name, help, type: 'gauge', value, labels };
}
