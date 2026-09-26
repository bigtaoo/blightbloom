/**
 * Split of `server.ts` (2026-09-26, ROADMAP 9.1): billsvc's request-body readers and its one
 * response writer. Free functions, CLAUDE.md's first split form — `server.ts` keeps the
 * routes and imports these; nothing here imports `server.ts` back.
 *
 * Why the split happened at all: Paddle signs the RAW request bytes (design/19 §9, item 2),
 * so its webhook needs a reader that hands back exactly what arrived — `readRaw` below — and
 * re-serialising a parsed body to verify it is the classic way to fail as "bad signature"
 * rather than "you verified the wrong bytes". `readJson` is now a thin JSON layer over the
 * SAME raw reader, so the two can never disagree about the size cap or the abort handling.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  // `x-internal-key` is deliberately NOT advertised here. Every internal route is called
  // process-to-process, never from a browser, so a preflight never needs it — and listing
  // it would invite a client to try. `internalAuth.ts`'s own header note says the same.
  'access-control-allow-headers': 'content-type',
};

/**
 * The body cap. An Apple receipt is a base64 blob of several kilobytes and a Paddle
 * `transaction.completed` payload with a few line items is a few kilobytes more, so
 * matchsvc's 4 KB find-request ceiling would silently truncate a real webhook body into a
 * parse failure — or, for Paddle, into a signature failure.
 */
export const MAX_BODY_BYTES = 256 * 1024;

export function send(res: ServerResponse, status: number, body: unknown): void {
  const json = status === 204 ? '' : JSON.stringify(body);
  res.writeHead(status, { ...CORS, 'content-type': 'application/json' });
  res.end(json);
}

/**
 * What `readRaw` hands its callback. `bytes` is the body EXACTLY as it arrived — the thing a
 * signature is computed over — and `null` when the body was discarded past the cap, because
 * a truncated prefix would verify as a forgery and later read like the whole payload.
 * `text` is the same bytes decoded as UTF-8 for the event log, or a marker saying what was
 * discarded.
 */
export interface RawBody {
  bytes: Buffer | null;
  text: string;
}

/**
 * Invoke `done`, turning a synchronous throw or a rejected promise into a 500. Every route
 * body became a promise in the MongoDB port, and a lost one is the one failure mode that is
 * not a wrong answer but NO answer — the platform's request then hangs until its own timeout,
 * which tells it nothing. A 500 tells it to retry.
 */
function invokeGuarded<T>(res: ServerResponse, done: (value: T) => void | Promise<void>, value: T): void {
  try {
    const maybe = done(value);
    if (maybe) void maybe.catch((e: unknown) => send(res, 500, { error: (e as Error).message, code: 'internal' }));
  } catch (e) {
    send(res, 500, { error: (e as Error).message, code: 'internal' });
  }
}

/** Read the request body verbatim (bounded), then invoke `done`. */
export function readRaw(req: IncomingMessage, res: ServerResponse, done: (body: RawBody) => void | Promise<void>): void {
  const chunks: Buffer[] = [];
  let size = 0;
  let overflow = false;
  req.on('data', (c: Buffer) => {
    size += c.length;
    if (size > MAX_BODY_BYTES) {
      overflow = true;
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => {
    if (overflow) {
      // The body is DISCARDED past the cap, so there is no verbatim payload to store. Say so,
      // rather than storing a truncated prefix that would later read like the whole thing.
      return invokeGuarded(res, done, { bytes: null, text: `<oversized body discarded: >${size} bytes>` });
    }
    const bytes = Buffer.concat(chunks);
    invokeGuarded(res, done, { bytes, text: bytes.toString('utf8') });
  });
  // UNOBSERVABLE, AND KEPT ANYWAY — recorded here so the next reader does not have to
  // re-derive it. A 2026-09-04 mutation battery deleted this line and all 221 tests stayed
  // green. That is not a test gap: probed directly on node v26, an aborted request emits
  // 'aborted' and 'error' on `req` and never emits 'end', but with NO 'error' listener node
  // routes it internally — no uncaughtException, process unharmed. So there is no behaviour
  // for a test to pin, and `done` here only ever writes to a socket that is already gone. It
  // stays for two reasons: it is the same idiom `matchsvc.ts`'s `readJson` uses, and node's
  // "unhandled 'error' throws" rule is a runtime detail this file should not depend on.
  // `billsvc.http.test.ts`'s mid-upload-disconnect case covers the OUTCOME that matters
  // either way (the process keeps serving and books nothing); it does not cover this line.
  req.on('error', () => invokeGuarded(res, done, { bytes: null, text: '' }));
}

/**
 * Read a JSON request body (bounded), then invoke `done`. Malformed/oversized → `{}`.
 *
 * `raw` is a SECOND argument rather than something the caller re-derives (ROADMAP 8.5): the
 * webhook event log stores the bytes as they arrived, and a payload that did not parse is
 * exactly the one whose bytes are worth the most. Re-serialising the parsed body would lose
 * the unparsable case entirely and silently reorder every other one.
 */
export function readJson(
  req: IncomingMessage,
  res: ServerResponse,
  done: (body: unknown, raw: string) => void | Promise<void>,
): void {
  readRaw(req, res, ({ bytes, text }) => done(parseJsonOrEmpty(bytes, text), text));
}

/** `{}` for an absent, oversized or unparsable body — the lenient reading the non-Paddle
 *  routes have always had. */
function parseJsonOrEmpty(bytes: Buffer | null, text: string): unknown {
  if (!bytes || bytes.length === 0) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
