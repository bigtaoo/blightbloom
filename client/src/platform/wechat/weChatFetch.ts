// `wx.request` wrapped as a `fetch` — this shell's only road to the network (design/21 §9;
// design/04-wechat.md item 19).
//
// There is no `fetch`, no `XMLHttpRequest` and no `navigator.sendBeacon` on the mini-game
// runtime, and until this existed that absence was paid for by features being switched off:
// `installClientLog` sent nothing, `installPublicFlags` was installed and inert, and
// analytics was not installed at all. All three take a `fetchImpl`, so all three are wired by
// handing them the function below.
//
// ## What it implements, and what it deliberately does not
//
// Only the shape the three callers here actually use: a string url, `method`, a `Record`
// (or `Headers`-like) of request headers, a STRING body, and a response with `ok`, `status`,
// `headers.get()`, `text()` and `json()`. There is no streaming body, no `Request` object
// input, no redirect control and no abort — a caller reaching for one of those gets
// `undefined` rather than a wrong answer, and `net/`'s own modules are the only callers.
//
// Three `RequestInit` fields are accepted and IGNORED, and each is worth naming because
// every one of them is load-bearing on the web and meaningless here:
//
//  - `credentials: 'omit'` — the web calls carry it because matchsvc answers
//    `access-control-allow-origin: *`, which is illegal for a credentialed request. There is
//    no origin, no cookie jar and no CORS preflight on this runtime; a mini-game's request
//    is gated by the account's 服务器域名 whitelist instead.
//  - `keepalive: true` — its whole purpose is surviving a page unload, and there is no page.
//    See `main.wechat.ts` for what replaces the exit flush here.
//  - `signal` — nothing in `net/` aborts a request.
//
// ## The one runtime behaviour that had to be turned off
//
// `wx.request` defaults to `dataType: 'json'`, which makes the runtime `JSON.parse` the body
// and hand back the result — and hand back `undefined` when the body is not JSON, with no
// error and no way to see what arrived. That would quietly break the one guarantee
// `clientFlags.ts` is built on: an HTML error page from something in front of the server has
// to be a FAILED parse (leaving the flags as shipped), not a body that silently reads as
// empty. So the raw string is requested and `json()` parses it here, which is what `fetch`
// does and what every caller was written against.

/** The subset of `RequestInit` this shim reads. Everything else is accepted and ignored —
 *  see the header for the three that matter. */
type WeChatRequestInit = Pick<RequestInit, 'method' | 'headers' | 'body'>;

/** The subset of `Response` this shim provides. */
interface WeChatResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly url: string;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
  json(): Promise<unknown>;
}

/** Flatten whatever a caller passed as `headers` into the plain object `wx.request` wants.
 *  `Headers` does not exist on this runtime, so an instance of it can only arrive from a
 *  caller that built one somewhere else; handled anyway because dropping headers silently
 *  would lose the `authorization` line that makes an event attributable. */
function flattenHeaders(headers: WeChatRequestInit['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  if (headers === undefined) return out;
  if (Array.isArray(headers)) {
    for (const [k, v] of headers) out[k] = v;
  } else if (typeof (headers as Headers).forEach === 'function') {
    (headers as Headers).forEach((v, k) => {
      out[k] = v;
    });
  } else {
    for (const [k, v] of Object.entries(headers as Record<string, string>)) out[k] = v;
  }
  return out;
}

/**
 * A `fetch` over `wx.request`, or `undefined` on a runtime that has no `wx.request` at all.
 *
 * `undefined` rather than a throwing stub, because that is the value every caller here
 * already treats as "no network": `installPublicFlags` stays inert and the flags stay as
 * compiled in, and the log and analytics senders drop their batches. So a shell this does
 * not work on degrades to exactly the state it was in before this file existed, rather than
 * failing boot on the line that installed it.
 */
export function createWeChatFetch(): typeof fetch | undefined {
  if (typeof wx === 'undefined' || typeof wx.request !== 'function') return undefined;

  const doFetch = (input: string | URL | Request, init?: WeChatRequestInit): Promise<WeChatResponse> => {
    // `String(url)` rather than a `toString?.()` chain: a `URL` stringifies to its href, and
    // the guard the chain implied was a branch no caller can reach — which a coverage gate
    // cannot tell from an untested one.
    const url = typeof input === 'string' ? input : String(input);
    const body = init?.body;
    if (body !== undefined && body !== null && typeof body !== 'string') {
      // Every caller in `net/` passes `JSON.stringify(...)`. A Blob/FormData/stream body
      // would have to be encoded here to mean anything, and encoding one wrong is worse than
      // saying so: a rejected promise lands in the same `catch` a network failure does.
      return Promise.reject(new Error('weChatFetch: only a string body is supported'));
    }

    return new Promise<WeChatResponse>((resolve, reject) => {
      const opts = {
        url,
        method: (init?.method ?? 'GET') as 'GET' | 'POST',
        header: flattenHeaders(init?.headers),
        // See the header: NOT the default 'json'.
        dataType: 'text',
        ...(typeof body === 'string' ? { data: body } : {}),
        success: (res: WxRequestSuccess): void => {
          const status = res.statusCode;
          // `data` is a string here because of `dataType`, but a runtime that ignored that
          // hint would hand back an object — stringify rather than let `text()` answer
          // "[object Object]" through an implicit coercion nobody can see.
          const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data ?? null);
          const header = res.header ?? {};
          resolve({
            // A 404 resolves with `ok: false`, exactly as `fetch` does — this is what lets
            // `clientFlags.ts` distinguish "a deployment that predates this route" from a
            // transport failure, and both of them from a usable answer.
            ok: status >= 200 && status < 300,
            status,
            url,
            headers: {
              get: (name: string): string | null => {
                const want = name.toLowerCase();
                const hit = Object.entries(header).find(([k]) => k.toLowerCase() === want);
                return hit ? hit[1] : null;
              },
            },
            text: () => Promise.resolve(text),
            // Rejects on a body that is not JSON, which is `Response.json`'s behaviour and
            // the fail-safe path every caller already has a `catch` for.
            json: () => Promise.resolve().then(() => JSON.parse(text) as unknown),
          });
        },
        // A timeout, a DNS failure, or the one this platform adds: a host missing from the
        // account's 服务器域名 whitelist, which fails on a device while DevTools with
        // 不校验域名 ticked succeeds. Same shape as a rejected `fetch`.
        fail: (res: { errMsg?: string; errno?: number }): void => {
          reject(new Error(`weChatFetch: ${res.errMsg ?? 'request failed'}`));
        },
      };
      try {
        wx.request(opts);
      } catch (err) {
        // A synchronous throw from the runtime (a malformed url is one) must reach the
        // caller's `catch` rather than leaving a promise that never settles.
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  };

  // The cast is the honest shape of this file: what it returns satisfies every call site in
  // `net/`, and does not satisfy the whole `fetch` type. See the header for the list.
  return doFetch as unknown as typeof fetch;
}
