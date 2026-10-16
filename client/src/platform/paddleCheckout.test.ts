/**
 * `PaddleCheckout` — the web store's overlay handoff (design/22 §1.1).
 *
 * The property that matters is that every way the overlay can go wrong ends in an answer the
 * purchase flow can report, never a promise that hangs (a hung handoff is a store button that
 * stays "Buying…" forever) — and that Paddle.js, which may be initialised only once, is.
 */
import { describe, expect, it, vi } from 'vitest';
import { PADDLE_JS_URL, PaddleCheckout, browserPaddleHost, type PaddleGlobal, type ScriptDocument } from './paddleCheckout';

const PARAMS = { priceId: 'pri_1', customDataOrderId: 'ord-1', clientToken: 'test_tok', environment: 'sandbox' };

/** A fake Paddle global whose events the test fires by hand. */
function fakePaddle() {
  let emit: (name: string) => void = () => {};
  const paddle = {
    Environment: { set: vi.fn() },
    Initialize: vi.fn((opts: { eventCallback: (e: { name?: string }) => void }) => {
      emit = (name) => opts.eventCallback({ name });
    }),
    Checkout: { open: vi.fn() },
  };
  return { paddle: paddle as unknown as PaddleGlobal & typeof paddle, emit: (name: string) => emit(name) };
}

/** Open, then let the test fire events once `Checkout.open` has actually been called. */
async function opened(c: PaddleCheckout, fake: ReturnType<typeof fakePaddle>, params = PARAMS) {
  const outcome = c.open(params);
  await vi.waitFor(() => expect(fake.paddle.Checkout.open).toHaveBeenCalled());
  // Wrapped: an async function returning the bare promise would wait for it to settle.
  return { outcome };
}

describe('PaddleCheckout', () => {
  it('opens one item of the price, with the order id in customData, and resolves completed', async () => {
    const fake = fakePaddle();
    const c = new PaddleCheckout({ load: async () => fake.paddle });
    const { outcome: outcome } = await opened(c, fake);
    fake.emit('checkout.loaded'); // an event this module does not act on
    fake.emit('checkout.completed');
    expect(await outcome).toBe('completed');
    expect(fake.paddle.Environment.set).toHaveBeenCalledWith('sandbox');
    expect(fake.paddle.Initialize).toHaveBeenCalledWith(expect.objectContaining({ token: 'test_tok' }));
    expect(fake.paddle.Checkout.open).toHaveBeenCalledWith({
      items: [{ priceId: 'pri_1', quantity: 1 }],
      customData: { orderId: 'ord-1' },
    });
  });

  it('a close without completion is closed; the close that follows a completion changes nothing', async () => {
    const fake = fakePaddle();
    const c = new PaddleCheckout({ load: async () => fake.paddle });
    const { outcome: first } = await opened(c, fake);
    fake.emit('checkout.closed');
    expect(await first).toBe('closed');

    fake.paddle.Checkout.open.mockClear();
    const { outcome: second } = await opened(c, fake);
    fake.emit('checkout.completed');
    fake.emit('checkout.closed');
    expect(await second).toBe('completed');
  });

  it('initialises Paddle.js once, and does not touch the environment for production', async () => {
    const fake = fakePaddle();
    const c = new PaddleCheckout({ load: async () => fake.paddle });
    const live = { ...PARAMS, environment: 'production', clientToken: 'live_tok' };
    for (let i = 0; i < 2; i++) {
      fake.paddle.Checkout.open.mockClear();
      const { outcome: o } = await opened(c, fake, live);
      fake.emit('checkout.closed');
      await o;
    }
    expect(fake.paddle.Initialize).toHaveBeenCalledTimes(1);
    expect(fake.paddle.Environment.set).not.toHaveBeenCalled();
  });

  it('refuses a second token rather than checking out against the wrong seller', async () => {
    const fake = fakePaddle();
    const c = new PaddleCheckout({ load: async () => fake.paddle });
    const { outcome: o } = await opened(c, fake);
    fake.emit('checkout.closed');
    await o;
    expect(await c.open({ ...PARAMS, clientToken: 'test_other' })).toBe('unavailable');
  });

  it('a second open supersedes the first instead of leaving it hanging', async () => {
    const fake = fakePaddle();
    const c = new PaddleCheckout({ load: async () => fake.paddle });
    const { outcome: first } = await opened(c, fake);
    fake.paddle.Checkout.open.mockClear();
    const { outcome: second } = await opened(c, fake);
    expect(await first).toBe('closed');
    fake.emit('checkout.completed');
    expect(await second).toBe('completed');
  });

  it('is unavailable when a field is missing, the script fails, or the overlay throws', async () => {
    const fake = fakePaddle();
    const load = vi.fn(async () => fake.paddle);
    const c = new PaddleCheckout({ load });
    for (const missing of ['priceId', 'customDataOrderId', 'clientToken'] as const) {
      expect(await c.open({ ...PARAMS, [missing]: undefined })).toBe('unavailable');
    }
    expect(load).not.toHaveBeenCalled(); // nothing loaded for a block that could never open

    expect(await new PaddleCheckout({ load: async () => { throw new Error('blocked'); } }).open(PARAMS)).toBe('unavailable');

    fake.paddle.Checkout.open.mockImplementation(() => { throw new Error('bad price'); });
    expect(await c.open(PARAMS)).toBe('unavailable');
  });
});

/** A document that records the script tags appended to it. */
function fakeDoc() {
  const tags: { src: string; async: boolean; onload: (() => void) | null; onerror: (() => void) | null }[] = [];
  const doc: ScriptDocument = {
    createElement: () => ({ src: '', async: false, onload: null, onerror: null }),
    head: { appendChild: (node: never) => tags.push(node) },
  };
  return { doc, tags };
}

describe('browserPaddleHost', () => {
  it('adds one async script tag on first use, and resolves the global it defines', async () => {
    const { doc, tags } = fakeDoc();
    const win: { Paddle?: PaddleGlobal } = {};
    const host = browserPaddleHost(() => doc, win);
    expect(tags).toHaveLength(0); // nothing at construction
    const a = host.load();
    const b = host.load();
    expect(tags).toHaveLength(1);
    expect(tags[0]).toMatchObject({ src: PADDLE_JS_URL, async: true });
    const { paddle } = fakePaddle();
    win.Paddle = paddle;
    tags[0]!.onload!();
    expect(await a).toBe(paddle);
    expect(await b).toBe(paddle);
    expect(await host.load()).toBe(paddle); // already present: no new tag
    expect(tags).toHaveLength(1);
  });

  it('a failed load rejects, and the next attempt tries again', async () => {
    const { doc, tags } = fakeDoc();
    const host = browserPaddleHost(() => doc, {});
    const first = host.load();
    tags[0]!.onerror!();
    await expect(first).rejects.toThrow('failed to load');

    const second = host.load();
    expect(tags).toHaveLength(2);
    tags[1]!.onload!(); // loaded, but defined no global
    await expect(second).rejects.toThrow('without a Paddle global');
  });
});
