/**
 * The public edge's one billsvc route (design/22 §1.2).
 *
 * billsvc answers `/metrics`, `/order/*` and its other `/webhook/*` routes with no gate of its
 * own, because nothing outside the compose network can reach it (`src/billsvc/server.ts`). The
 * Caddyfile is therefore what makes those routes internal, and a widened matcher — a `/webhook*`
 * prefix, a dropped `method` line — would publish them with nothing turning red. This reads
 * the real file and pins the route to exactly one method and one path.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const caddyfile = readFileSync(fileURLToPath(new URL('../caddy/Caddyfile', import.meta.url)), 'utf8');

/** The file with comments removed, so a commented-out directive cannot satisfy an assertion. */
const live = caddyfile
  .split(/\r?\n/)
  .map((l) => l.replace(/#.*$/, '').trimEnd())
  .filter((l) => l.trim() !== '')
  .join('\n');

/** The body of the block opened by the line `opener {`, or null. Caddy blocks nest by braces. */
function block(opener: string): string | null {
  const at = live.indexOf(`${opener} {`);
  if (at < 0) return null;
  let depth = 0;
  for (let i = live.indexOf('{', at); i < live.length; i++) {
    if (live[i] === '{') depth++;
    if (live[i] === '}' && --depth === 0) return live.slice(live.indexOf('{', at) + 1, i);
  }
  return null;
}

describe('Caddyfile: the Paddle webhook route', () => {
  it('matches POST and the exact path, nothing wider', () => {
    const matcher = block('@paddleWebhook');
    expect(matcher).not.toBeNull();
    const lines = matcher!
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    expect(lines.sort()).toEqual(['method POST', 'path /webhook/paddle']);
  });

  it('is the only way into billsvc', () => {
    const proxies = [...live.matchAll(/reverse_proxy\s+billsvc\S*/g)];
    expect(proxies).toHaveLength(1);
    expect(block('handle @paddleWebhook')?.trim()).toBe('reverse_proxy billsvc:8789');
  });

  it('comes before the catch-all, which first-match would otherwise give it to', () => {
    const route = live.indexOf('handle @paddleWebhook {');
    const catchAll = live.search(/^\s*handle \{/m);
    expect(route).toBeGreaterThan(-1);
    expect(catchAll).toBeGreaterThan(route);
  });
});
