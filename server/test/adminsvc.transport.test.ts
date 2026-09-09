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
import { LOGIN_BODY_LIMIT, readForm, requestTarget } from '../src/adminsvc/http';

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

describe('readForm', () => {
  it('decodes a urlencoded body', async () => {
    const req = fakeRequest();
    const form = await new Promise<URLSearchParams>((resolve) => {
      readForm(req, resolve);
      req.emit('data', Buffer.from('user=admin&password=hunter2'));
      req.emit('end');
    });
    expect(form.get('user')).toBe('admin');
    expect(form.get('password')).toBe('hunter2');
  });

  it('is lenient about a malformed percent escape rather than throwing', () => {
    // `URLSearchParams` decodes by specification and never throws; a per-field
    // `decodeURIComponent` would throw on `%zz` and turn a corrupted form into a 500.
    const req = fakeRequest();
    let form: URLSearchParams | null = null;
    readForm(req, (f) => (form = f));
    req.emit('data', Buffer.from('user=%zz&password=x'));
    req.emit('end');
    expect(form).not.toBeNull();
    expect(() => form!.get('user')).not.toThrow();
  });

  it('drops the overflow tail, so an over-long body parses as truncated', () => {
    // The safe direction: what reaches the parser is a cut string, so the login it produces
    // fails. The OPPOSITE arrangement — parse the prefix and ignore the rest — would let a
    // 10 MB body through on the strength of its first 4 KB.
    const req = fakeRequest();
    let form: URLSearchParams | null = null;
    readForm(req, (f) => (form = f));
    req.emit('data', Buffer.from('user=admin&password='));
    req.emit('data', Buffer.from('z'.repeat(LOGIN_BODY_LIMIT + 10)));
    req.emit('end');
    expect(form!.get('password')).toBe('');
  });

  it('answers with an EMPTY form when the request errors mid-body', () => {
    // A client that hangs up or a reset connection. The callback must still fire — a
    // handler that never answered would leave the socket open until the client's own
    // timeout, and the login it produces from an empty form is correctly a refusal.
    const req = fakeRequest();
    let form: URLSearchParams | null = null;
    readForm(req, (f) => (form = f));
    req.emit('data', Buffer.from('user=admin'));
    req.emit('error', new Error('ECONNRESET'));
    expect(form).not.toBeNull();
    expect([...form!.keys()]).toEqual([]);
  });

  it('answers with an empty form for a body that never arrives', () => {
    const req = fakeRequest();
    let form: URLSearchParams | null = null;
    readForm(req, (f) => (form = f));
    req.emit('end');
    expect([...form!.keys()]).toEqual([]);
  });
});
