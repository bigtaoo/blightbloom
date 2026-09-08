/**
 * CoopSession — the client session driver (design/06, ROADMAP 3.1). Wires a fake
 * Transport to a REAL server-side FrameBroadcast and runs a full client↔server loop:
 * session.submit → transport → server relay → frame_batch → session.drive. Asserts the
 * session's simulation reproduces a plain replay of the confirmed stream byte-for-byte —
 * the whole online path, end to end, verified headlessly.
 */
import { describe, it, expect } from 'vitest';
import { CoopSession } from './CoopSession';
import type { Transport } from './transport';
import { FrameBroadcast } from '@dd/engine/net/FrameBroadcast';
import { makeCommand } from '@dd/engine/state/input';
import { Button, type PlayerCommand } from '@dd/engine/state/commands';
import type { ClientMsg, ServerMsg, MatchStart } from '@dd/engine/net/protocol';
import type { Brad } from '@dd/engine/math/trig';
import type { EngineConfig } from '@dd/engine/state/GameState';
import { toReplay, runReplay, hashState } from '@dd/engine/replay';

class FakeTransport implements Transport {
  readonly sent: ClientMsg[] = [];
  closed = false;
  private handler: ((m: ServerMsg) => void) | null = null;
  private disconnectHandler: ((reason: string) => void) | null = null;
  send(m: ClientMsg): void {
    this.sent.push(m);
  }
  onMessage(h: (m: ServerMsg) => void): void {
    this.handler = h;
  }
  onDisconnect(h: (reason: string) => void): void {
    this.disconnectHandler = h;
  }
  close(): void {
    this.closed = true;
  }
  deliver(m: ServerMsg): void {
    this.handler?.(m);
  }
  fail(reason: string): void {
    this.disconnectHandler?.(reason);
  }
  lastCmd(): PlayerCommand {
    const c = [...this.sent].reverse().find((m) => m.type === 'cmd');
    if (!c || c.type !== 'cmd') throw new Error('no cmd sent');
    return c.cmd;
  }
}

const SEED = 4242;
const CONFIG: EngineConfig = {
  seed: SEED, worldW: 800, worldH: 800,
  waves: [[[500, 400], [300, 400]], [[400, 300]]],
  players: [{ start: [400, 400] }], // one co-op seat (the shape scales to N)
};

describe('CoopSession — full client↔server loop reproduces a replay', () => {
  it('drives the engine off confirmed batches to a state byte-equal to the recorded replay', () => {
    const framesPerBatch = 3;
    const N = 180;
    const transport = new FakeTransport();

    const session = new CoopSession({
      transport, roomId: 'r', owner: 0, seed: SEED, playerCount: 1,
      buildConfig: (_info: MatchStart) => CONFIG,
      bufferFrames: 0,
    });
    // Joining sends the handshake.
    expect(transport.sent[0]).toEqual({ type: 'join', roomId: 'r', owner: 0, seed: SEED, playerCount: 1 });
    expect(session.started).toBe(false);

    // Server accepts the room and starts the match → the session builds its engine.
    transport.deliver({ type: 'match_start', seed: SEED, startFrame: 0, localOwner: 0, playerCount: 1 });
    expect(session.started).toBe(true);

    // The server relay. Each render frame the client submits one command; the server
    // buckets it and pulses a batch every `framesPerBatch` frames back to the client.
    const server = new FrameBroadcast({ framesPerBatch, startFrame: 0 });
    for (let f = 1; f <= N; f++) {
      const cmd = makeCommand({
        owner: 0, tick: f,
        moveBrad: ((f * 337) & 0xffff) as Brad, moveMag: (f * 7) % 256,
        buttons: Button.FIRE,
      });
      session.submit(cmd); // → transport 'cmd'
      server.submit(transport.lastCmd()); // server receives exactly what was sent
      if (f % framesPerBatch === 0) {
        transport.deliver({ type: 'frame_batch', ...server.tick() });
        session.drive(); // consume the freshly-confirmed frames
      }
    }
    session.drive(); // drain any remainder

    // Reference: replay the commands AS CONFIRMED (server re-tags each to its window frame).
    const confirmed: PlayerCommand[] = server.log.flatMap((fc) =>
      fc.cmds.map((c) => ({ ...c, tick: fc.frame })),
    );
    const reference = runReplay(toReplay(CONFIG, confirmed), server.frame);

    expect(session.state).not.toBeNull();
    expect(session.state!.tick).toBe(reference.state.tick);
    expect(hashState(session.state!)).toBe(hashState(reference.state));
  });

  it('stalls at the confirmed watermark and catches up when a burst of batches arrives', () => {
    const transport = new FakeTransport();
    const session = new CoopSession({
      transport, roomId: 'r', owner: 0, seed: SEED, playerCount: 1,
      buildConfig: () => CONFIG, bufferFrames: 0,
    });
    transport.deliver({ type: 'match_start', seed: SEED, startFrame: 0, localOwner: 0, playerCount: 1 });

    // Nothing confirmed yet → drive() stalls immediately at frame 1.
    expect(session.drive()).toEqual([]);
    expect(session.state!.tick).toBe(0);

    // A burst confirms up to frame 12 at once; a single drive() must catch up all of it.
    const server = new FrameBroadcast({ framesPerBatch: 3, startFrame: 0 });
    for (let i = 0; i < 4; i++) transport.deliver({ type: 'frame_batch', ...server.tick() });
    // backlog = confirmed frames STRICTLY ahead of the next frame (frame 1 is also
    // steppable), so 11 here while drive() will step all 12 (frames 1..12).
    expect(session.backlog()).toBe(11);
    session.drive();
    expect(session.state!.tick).toBe(12); // caught up to the watermark in one drive
    expect(session.backlog()).toBe(0);
  });

  it('sends a periodic anti-cheat checkpoint every CHECKPOINT_TICKS, hash-equal to a reference replay at that tick (design/15, ROADMAP 4.4)', () => {
    const framesPerBatch = 3;
    const N = 180; // one checkpoint boundary (150) inside this range, none at 0 or 300
    const transport = new FakeTransport();
    const session = new CoopSession({
      transport, roomId: 'r', owner: 0, seed: SEED, playerCount: 1,
      buildConfig: () => CONFIG, bufferFrames: 0,
    });
    transport.deliver({ type: 'match_start', seed: SEED, startFrame: 0, localOwner: 0, playerCount: 1 });

    // No FIRE held (design/10 v33: the engine now auto-faces and would land every shot
    // on the nearest enemy, clearing the waves — and hitting gameover — well before tick
    // 150). This test only cares about the checkpoint mechanism, so never firing keeps
    // the match in 'playing' for the whole window.
    const server = new FrameBroadcast({ framesPerBatch, startFrame: 0 });
    for (let f = 1; f <= N; f++) {
      const cmd = makeCommand({
        owner: 0, tick: f,
        moveBrad: ((f * 337) & 0xffff) as Brad, moveMag: (f * 7) % 256,
        buttons: 0,
      });
      session.submit(cmd);
      server.submit(transport.lastCmd());
      if (f % framesPerBatch === 0) {
        transport.deliver({ type: 'frame_batch', ...server.tick() });
        session.drive();
      }
    }
    session.drive();

    const checkpoints = transport.sent.filter((m): m is Extract<ClientMsg, { type: 'checkpoint' }> => m.type === 'checkpoint');
    expect(checkpoints).toHaveLength(1); // only tick 150 falls in (0, 180]
    expect(checkpoints[0]!.tick).toBe(150);

    // Reference: replay the confirmed stream only up to tick 150 and hash there —
    // must match exactly what the session reported mid-match at that same tick.
    const confirmed: PlayerCommand[] = server.log.flatMap((fc) => fc.cmds.map((c) => ({ ...c, tick: fc.frame })));
    const referenceAt150 = runReplay(toReplay(CONFIG, confirmed), 150);
    expect(referenceAt150.state.tick).toBe(150);
    expect(checkpoints[0]!.stateHash).toBe(hashState(referenceAt150.state));
  });
});

describe('CoopSession — reconnect (ROADMAP reconnect, design/06)', () => {
  it('reconnect() sends `resume` (with the current lastFrame) on the NEW transport, not the old one', () => {
    const transport = new FakeTransport();
    const session = new CoopSession({
      transport, roomId: 'r', owner: 2, seed: SEED, playerCount: 1,
      buildConfig: () => CONFIG, bufferFrames: 0,
    });
    transport.deliver({ type: 'match_start', seed: SEED, startFrame: 0, localOwner: 2, playerCount: 1 });

    const server = new FrameBroadcast({ framesPerBatch: 3, startFrame: 0 });
    for (let i = 0; i < 2; i++) transport.deliver({ type: 'frame_batch', ...server.tick() });
    session.drive(); // net.resumeFrame() tracks the confirmed watermark, not what drive() actually stepped

    const transport2 = new FakeTransport();
    session.reconnect(transport2);

    expect(transport2.sent).toEqual([{ type: 'resume', roomId: 'r', owner: 2, lastFrame: 6 }]);
    expect(transport.sent.some((m) => m.type === 'resume')).toBe(false); // never touches the dead transport
  });

  it('after reconnect(), submit/checkpoint/reportResult/close all route through the NEW transport', () => {
    const transport = new FakeTransport();
    const session = new CoopSession({
      transport, roomId: 'r', owner: 0, seed: SEED, playerCount: 1,
      buildConfig: () => CONFIG, bufferFrames: 0,
    });
    transport.deliver({ type: 'match_start', seed: SEED, startFrame: 0, localOwner: 0, playerCount: 1 });

    const transport2 = new FakeTransport();
    session.reconnect(transport2);
    transport.sent.length = 0; // only care what happens AFTER the swap

    session.submit(makeCommand({ owner: 0, tick: 1, moveBrad: 0 as Brad, moveMag: 10, buttons: 0 }));
    session.reportResult(0xabc);
    session.close();

    expect(transport.sent).toEqual([]); // nothing more ever reaches the dead transport
    expect(transport2.sent.some((m) => m.type === 'cmd')).toBe(true);
    expect(transport2.sent).toContainEqual({ type: 'result', stateHash: 0xabc, winner: null, placements: undefined });
    expect(transport2.closed).toBe(true);
  });

  it('a `conn_resync` delivered on the new transport folds into the confirmed stream exactly like a fresh frame_batch', () => {
    const transport = new FakeTransport();
    const session = new CoopSession({
      transport, roomId: 'r', owner: 0, seed: SEED, playerCount: 1,
      buildConfig: () => CONFIG, bufferFrames: 0,
    });
    transport.deliver({ type: 'match_start', seed: SEED, startFrame: 0, localOwner: 0, playerCount: 1 });
    expect(session.drive()).toEqual([]); // stalled — nothing confirmed yet

    const transport2 = new FakeTransport();
    session.reconnect(transport2);
    transport2.deliver({ type: 'conn_resync', startFrame: 0, curFrame: 9, log: [] });

    session.drive();
    expect(session.state!.tick).toBe(9); // caught straight up to the resynced watermark
  });

  it('onDisconnect fires from either transport, routed through whichever is currently wired', () => {
    const transport = new FakeTransport();
    const session = new CoopSession({
      transport, roomId: 'r', owner: 0, seed: SEED, playerCount: 1,
      buildConfig: () => CONFIG, bufferFrames: 0,
    });
    const seen: string[] = [];
    session.onDisconnect((reason) => seen.push(reason));

    transport.fail('first drop');
    const transport2 = new FakeTransport();
    session.reconnect(transport2);
    transport2.fail('second drop');

    expect(seen).toEqual(['first drop', 'second drop']);
  });

  it('onServerError surfaces a `{type:"error"}` message without disturbing NetInputSource', () => {
    const transport = new FakeTransport();
    const session = new CoopSession({
      transport, roomId: 'r', owner: 0, seed: SEED, playerCount: 1,
      buildConfig: () => CONFIG, bufferFrames: 0,
    });
    transport.deliver({ type: 'match_start', seed: SEED, startFrame: 0, localOwner: 0, playerCount: 1 });

    const seen: { code: string; message: string }[] = [];
    session.onServerError((code, message) => seen.push({ code, message }));
    transport.deliver({ type: 'error', code: 'resume_failed', message: 'gone' });

    expect(seen).toEqual([{ code: 'resume_failed', message: 'gone' }]);
    expect(session.started).toBe(true); // an 'error' message is not a match_over/gameover signal
  });
});

describe('CoopSession — seat names (design/20)', () => {
  function session(transport: FakeTransport) {
    return new CoopSession({
      transport,
      roomId: 'r1',
      owner: 0,
      seed: SEED,
      playerCount: 1,
      buildConfig: () => CONFIG,
    });
  }

  it('is empty before the match starts, and for a room with no names', () => {
    const transport = new FakeTransport();
    const s = session(transport);
    expect(s.seatNames).toEqual([]);
    transport.deliver({ type: 'match_start', seed: SEED, startFrame: 0, localOwner: 0, playerCount: 1 });
    expect(s.seatNames).toEqual([]);
  });

  it('captures the names match_start carried', () => {
    const transport = new FakeTransport();
    const s = session(transport);
    transport.deliver({
      type: 'match_start', seed: SEED, startFrame: 0, localOwner: 0, playerCount: 2, names: ['Ada', null],
    });
    expect(s.seatNames).toEqual(['Ada', null]);
  });

  it('captures them from conn_resync too, which a RECONNECT is the only source of', () => {
    // A reconnecting client never sees `match_start` again. Without this it would come back
    // from a dropped socket with everyone's name gone — the failure `ConnResync.names`
    // exists for, and one no `match_start`-only test could see.
    const transport = new FakeTransport();
    const s = session(transport);
    transport.deliver({
      type: 'match_start', seed: SEED, startFrame: 0, localOwner: 0, playerCount: 2, names: ['Ada', 'Grace'],
    });
    const second = new FakeTransport();
    s.reconnect(second);
    expect(s.seatNames).toEqual(['Ada', 'Grace']); // unchanged by the swap itself
    second.deliver({ type: 'conn_resync', startFrame: 0, curFrame: 9, log: [], names: ['Ada', 'Hopper'] });
    expect(s.seatNames).toEqual(['Ada', 'Hopper']);
  });

  it('keeps the names it had when a message carries none', () => {
    // A `frame_batch` arrives ten times a second and says nothing about names; a resync from
    // an older server says nothing either. Neither may blank the roster.
    const transport = new FakeTransport();
    const s = session(transport);
    transport.deliver({
      type: 'match_start', seed: SEED, startFrame: 0, localOwner: 0, playerCount: 2, names: ['Ada', 'Grace'],
    });
    transport.deliver({ type: 'frame_batch', toFrame: 1, frames: [] });
    transport.deliver({ type: 'conn_resync', startFrame: 0, curFrame: 1, log: [] });
    expect(s.seatNames).toEqual(['Ada', 'Grace']);
  });
});
