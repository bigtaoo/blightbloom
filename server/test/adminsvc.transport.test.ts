/**
 * adminsvc's transport primitives (`adminsvc/http.ts`): the request target it derives, and
 * the bounded form reader.
 *
 * Two cases here exist because the alternative is a dead branch. `IncomingMessage` types
 * both `url` and `method` as possibly `undefined` and Node always sets them for a real
 * request, so those fallbacks are unreachable through a socket — and a fallback no test can
 * reach is indistinguishable, to a coverage gate, from one nobody bothered to test.
 * `requestTarget` takes the narrow `Pick<>` it actually needs, so the contract can be
 * exercised directly: the type admits `undefined`, so a case passes `undefined`.
 *
 * Same reasoning for `readForm`'s `error` arm. A request that errors mid-body is a real
 * event (a client that hangs up, a reset connection) and a genuinely awkward one to produce
 * over a live socket; the function takes an event emitter, so the case emits the event.
 */
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { LOGIN_BODY_LIMIT, readFormBody, requestTarget } from '../src/adminsvc/http';

/** The three fields `readForm` touches, as an emitter a test can drive. */
function fakeRequest(): EventEmitter & IncomingMessage {
  return new EventEmitter() as EventEmitter & IncomingMessage;
}

describe('requestTarget', () => {
  it('parses the path and drops the query string', () => {
    // The path is what the audit line logs, and a search term on this console is a player's
    // username — a log store is not where it belongs.
    const target = requestTarget({ url: '/admin/?tab=commerce&q=zoe', method: 'GET', headers: { host: 'x' } });
    expect(target.path).toBe('/admin/');
    expect(target.method).toBe('GET');
    expect(target.url.searchParams.get('tab')).toBe('commerce');
  });

  it('normalises a path with a traversal segment before the dispatch chain sees it', () => {
    // `URL` resolves `..` itself, so `/admin/../etc/passwd` arrives at the chain as
    // `/etc/passwd` and simply matches none of the five allowed paths. Worth pinning: a
    // handler that compared the RAW `req.url` would see a string starting with `/admin/`.
    expect(requestTarget({ url: '/admin/../etc/passwd', method: 'GET', headers: { host: 'x' } }).path).toBe(
      '/etc/passwd',
    );
  });

  it('falls back to / and GET when the type\'s undefined is what arrives', () => {
    const target = requestTarget({ url: undefined, method: undefined, headers: { host: 'x' } });
    expect(target.path).toBe('/');
    expect(target.method).toBe('GET');
  });

  it('tolerates a missing Host header', () => {
    // A malformed HTTP/1.0 request has none. The origin is never used for anything — only
    // `pathname` and `searchParams` are read — so the literal "undefined" hostname is
    // harmless, and what matters is that it does not throw.
    expect(() => requestTarget({ url: '/admin/', method: 'GET', headers: {} })).not.toThrow();
    expect(requestTarget({ url: '/admin/', method: 'GET', headers: {} }).path).toBe('/admin/');
  });
});

/**
 * `readFormBody`, which replaced `readForm(req, done)` on 2026-09-15.
 *
 * The shape of every case below changed with it, and the change is the point: the body is
 * requested BEFORE the events are emitted, then awaited afterwards. That works because
 * `readFormBody` attaches its `data`/`end`/`error` listeners synchronously and only the
 * RESOLUTION is deferred — which is exactly the property a handler needs, since an awaited
 * read that attached its listeners a tick late would miss a body that had already arrived.
 */
describe('readFormBody', () => {
  it('decodes a urlencoded body', async () => {
    const req = fakeRequest();
    const pending = readFormBody(req);
    req.emit('data', Buffer.from('user=admin&password=hunter2'));
    req.emit('end');
    const form = await pending;
    expect(form.get('user')).toBe('admin');
    expect(form.get('password')).toBe('hunter2');
  });

  it('attaches its listeners SYNCHRONOUSLY, before it returns', () => {
    // The property the whole promise form rests on, asserted directly rather than inferred
    // from the cases above passing. A version that attached them inside a `process.nextTick`
    // would pass every one of those (the emits are also deferred by the await) and lose a
    // real body that arrived in the same tick as the request.
    const req = fakeRequest();
    void readFormBody(req);
    expect(req.listenerCount('data')).toBe(1);
    expect(req.listenerCount('end')).toBe(1);
    expect(req.listenerCount('error')).toBe(1);
  });

  it('is lenient about a malformed percent escape rather than throwing', async () => {
    // `URLSearchParams` decodes by specification and never throws; a per-field
    // `decodeURIComponent` would throw on `%zz` and turn a corrupted form into a 500.
    const req = fakeRequest();
    const pending = readFormBody(req);
    req.emit('data', Buffer.from('user=%zz&password=x'));
    req.emit('end');
    const form = await pending;
    expect(() => form.get('user')).not.toThrow();
  });

  it('drops the overflow tail, so an over-long body parses as truncated', async () => {
    // The safe direction: what reaches the parser is a cut string, so the login it produces
    // fails. The OPPOSITE arrangement — parse the prefix and ignore the rest — would let a
    // 10 MB body through on the strength of its first 4 KB.
    const req = fakeRequest();
    const pending = readFormBody(req);
    req.emit('data', Buffer.from('user=admin&password='));
    req.emit('data', Buffer.from('z'.repeat(LOGIN_BODY_LIMIT + 10)));
    req.emit('end');
    expect((await pending).get('password')).toBe('');
  });

  it('RESOLVES with an empty form when the request errors mid-body', async () => {
    // A client that hangs up or a reset connection. It must resolve rather than reject: a
    // rejection here would travel up through an awaiting handler into the server's error
    // boundary and answer a hung-up client with a 500, and the login an empty form produces
    // is correctly a refusal. A promise that did neither would leave the socket open until
    // the client's own timeout.
    const req = fakeRequest();
    const pending = readFormBody(req);
    req.emit('data', Buffer.from('user=admin'));
    req.emit('error', new Error('ECONNRESET'));
    expect([...(await pending).keys()]).toEqual([]);
  });

  it('resolves with an empty form for a body that never arrives', async () => {
    const req = fakeRequest();
    const pending = readFormBody(req);
    req.emit('end');
    expect([...(await pending).keys()]).toEqual([]);
  });
});
