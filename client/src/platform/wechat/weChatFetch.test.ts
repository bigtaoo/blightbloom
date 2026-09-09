/**
 * `wx.request` as a `fetch` — the shim that turned three switched-off features back on
 * (design/21 §9).
 *
 * What is worth testing here is not "does a request go out". It is the four places where
 * this runtime's shape differs from `fetch`'s, because every one of them fails SILENTLY in
 * the direction of a wrong answer rather than an error:
 *
 *  - `dataType` must not be the runtime's default `'json'`, which pre-parses the body and
 *    hands back `undefined` for anything that is not JSON. `clientFlags.ts` is built on an
 *    HTML error page being a failed parse; pre-parsing turns it into an empty answer.
 *  - a 404 must RESOLVE with `ok: false`, the way `fetch` does, because that is the case
 *    `clientFlags.ts` separates from a transport failure.
 *  - a `fail` callback must reject, and a synchronous throw from the runtime must reject
 *    too — a promise that never settles would hang a caller's `await` forever.
 *  - request headers must survive, because the one that matters is `authorization`: lose it
 *    and every event this host sends is anonymous.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createWeChatFetch } from './weChatFetch';

interface Capture {
  url: string;
  method?: string;
  header?: Record<string, string>;
  data?: string;
  dataType?: string;
}

/** A `wx.request` fake that records the options and answers with a scripted result. */
function requestFake(answer: (opts: Record<string, unknown>) => void) {
  const calls: Capture[] = [];
  vi.stubGlobal('wx', {
    request: (opts: Record<string, unknown>) => {
      calls.push(opts as unknown as Capture);
      answer(opts);
    },
  });
  return calls;
}

/** `success` with a body and a status. */
const answers = (body: string, statusCode = 200, header: Record<string, string> = {}) =>
  (opts: Record<string, unknown>): void => {
    (opts.success as (r: unknown) => void)({ data: body, statusCode, header });
  };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createWeChatFetch', () => {
  it('is undefined on a runtime with no wx.request', () => {
    // Not a throwing stub: `undefined` is the value every consumer already reads as "no
    // network", so a shell this does not work on degrades to the state it was in before this
    // file existed instead of failing on the boot line that installed it.
    vi.stubGlobal('wx', undefined);
    expect(createWeChatFetch()).toBeUndefined();
    vi.stubGlobal('wx', {});
    expect(createWeChatFetch()).toBeUndefined();
  });

  it('GETs, and never asks the runtime to parse the body for it', async () => {
    const calls = requestFake(answers(JSON.stringify({ flags: { a: 1 } })));
    const res = await createWeChatFetch()!('https://bb.example.test/client/flags');
    expect(calls[0]!.url).toBe('https://bb.example.test/client/flags');
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.data).toBeUndefined();
    // The trap: `'json'` is this API's DEFAULT, so the assertion is that it was overridden.
    expect(calls[0]!.dataType).not.toBe('json');
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ flags: { a: 1 } });
  });

  it('rejects json() on a body that is not JSON, rather than reading it as empty', async () => {
    // An HTML error page from something in front of the server. `clientFlags.ts` keeps the
    // values this build shipped with only because this throws.
    requestFake(answers('<html><body>502 Bad Gateway</body></html>'));
    const res = await createWeChatFetch()!('https://bb.example.test/client/flags');
    expect(res.ok).toBe(true);
    await expect(res.json()).rejects.toThrow();
    expect(await res.text()).toContain('502');
  });

  it('resolves a 404 with ok:false, the way fetch does', async () => {
    requestFake(answers('not found', 404));
    const res = await createWeChatFetch()!('https://bb.example.test/client/flags');
    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
  });

  it('treats every 2xx as ok and nothing else', async () => {
    for (const [status, ok] of [[199, false], [200, true], [204, true], [299, true], [300, false], [500, false]] as const) {
      requestFake(answers('', status));
      expect((await createWeChatFetch()!('https://x.test/')).ok, `status ${status}`).toBe(ok);
      vi.unstubAllGlobals();
    }
  });

  it('POSTs a string body and the headers verbatim', async () => {
    const calls = requestFake(answers('', 202));
    await createWeChatFetch()!('https://bb.example.test/client/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer tok-1' },
      // Both are accepted and ignored, and both are load-bearing on the web: see the file
      // header. Passed here so that the arm which ignores them is the arm that runs.
      credentials: 'omit',
      keepalive: true,
      body: '{"events":[]}',
    });
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.data).toBe('{"events":[]}');
    // The one that matters: without `authorization` every event from this host is anonymous.
    expect(calls[0]!.header).toEqual({ 'content-type': 'application/json', authorization: 'Bearer tok-1' });
  });

  it('flattens the other two header shapes a caller could pass', async () => {
    const calls = requestFake(answers(''));
    const f = createWeChatFetch()!;
    await f('https://x.test/', { headers: [['a', '1'], ['b', '2']] });
    expect(calls[0]!.header).toEqual({ a: '1', b: '2' });
    // `Headers` does not exist on this runtime, so one can only arrive from a caller that
    // built it elsewhere — handled anyway, because dropping headers silently is how the
    // `authorization` line above would go missing.
    await f('https://x.test/', { headers: new Headers({ c: '3' }) });
    expect(calls[1]!.header).toEqual({ c: '3' });
    await f('https://x.test/');
    expect(calls[2]!.header).toEqual({});
  });

  it('rejects a body it cannot send, instead of sending something else', async () => {
    const calls = requestFake(answers(''));
    await expect(createWeChatFetch()!('https://x.test/', { method: 'POST', body: new Uint8Array([1]) })).rejects.toThrow(/string body/);
    // And no request went out — encoding one wrong is worse than saying so.
    expect(calls).toEqual([]);
  });

  it('rejects on a transport failure', async () => {
    // Includes the failure this platform adds: a host missing from the account's 服务器域名
    // whitelist, which fails on a device while DevTools with 不校验域名 ticked succeeds.
    requestFake((opts) => {
      (opts.fail as (r: unknown) => void)({ errMsg: 'request:fail url not in domain list' });
    });
    await expect(createWeChatFetch()!('https://bb.example.test/client/flags')).rejects.toThrow(/url not in domain list/);
  });

  it('rejects when the runtime throws synchronously', async () => {
    // A promise that never settles would hang the caller's `await` rather than reaching the
    // `catch` every consumer here already has.
    vi.stubGlobal('wx', {
      request: () => {
        throw new Error('bad url');
      },
    });
    await expect(createWeChatFetch()!('not a url')).rejects.toThrow(/bad url/);
  });

  it('reads response headers case-insensitively, and absent ones as null', async () => {
    requestFake(answers('{}', 200, { 'Content-Type': 'application/json' }));
    const res = await createWeChatFetch()!('https://x.test/');
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('x-missing')).toBeNull();
  });

  it('stringifies a body a runtime handed back pre-parsed anyway', async () => {
    // Belt and braces on the `dataType` above: a base library that ignored the hint would
    // hand back an object, and an implicit coercion would make `text()` answer
    // "[object Object]" — a body no parse can recover and nothing can see going wrong.
    requestFake((opts) => {
      (opts.success as (r: unknown) => void)({ data: { flags: {} }, statusCode: 200, header: {} });
    });
    const res = await createWeChatFetch()!('https://x.test/');
    expect(await res.text()).toBe('{"flags":{}}');
    expect(await res.json()).toEqual({ flags: {} });
  });

  it('survives a success with no header field at all', async () => {
    requestFake((opts) => {
      (opts.success as (r: unknown) => void)({ data: '{}', statusCode: 200 });
    });
    const res = await createWeChatFetch()!('https://x.test/');
    expect(res.headers.get('content-type')).toBeNull();
    expect(res.url).toBe('https://x.test/');
  });

  it('reads a success with no body as the JSON null, not as undefined', async () => {
    // A 204, or a runtime that omits `data` for an empty body. `text()` must still be a
    // string and `json()` must still parse — a caller reaching for either gets an answer
    // rather than a `TypeError` two frames away from the cause.
    requestFake((opts) => {
      (opts.success as (r: unknown) => void)({ statusCode: 204, header: {} });
    });
    const res = await createWeChatFetch()!('https://x.test/');
    expect(res.ok).toBe(true);
    expect(await res.text()).toBe('null');
    expect(await res.json()).toBeNull();
  });

  it('rejects with a usable message even when the runtime supplies none', async () => {
    requestFake((opts) => {
      (opts.fail as (r: unknown) => void)({});
    });
    await expect(createWeChatFetch()!('https://x.test/')).rejects.toThrow(/request failed/);
  });

  it('wraps a non-Error thrown by the runtime', async () => {
    // A rejection value that is not an `Error` loses its message through every `catch` that
    // reads `.message` — including this project's own log wrapper.
    vi.stubGlobal('wx', {
      request: () => {
        throw 'boom';
      },
    });
    await expect(createWeChatFetch()!('https://x.test/')).rejects.toThrow(/boom/);
  });

  it('accepts a URL as well as a string', async () => {
    const calls = requestFake(answers(''));
    await createWeChatFetch()!(new URL('https://bb.example.test/client/log'));
    expect(calls[0]!.url).toBe('https://bb.example.test/client/log');
  });
});
