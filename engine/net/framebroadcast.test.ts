/**
 * FrameBroadcast — the server-side frame-relay core (design/06, ROADMAP 3.1). Verifies
 * the metronome/ordering/watermark/log contract in isolation, then the capstone
 * loopback: a client's commands relayed through server → NetInputSource → engine reproduce
 * the LOCAL run of the same intent BYTE-FOR-BYTE (2026-10-03: each command lands on its own
 * frame, and the frames between hold). That closes design/06's loop — online plays exactly
 * what the player did, not a re-timed copy of it.
 */
import { describe, it, expect } from 'vitest';
import { FrameBroadcast } from '@dd/engine/net/FrameBroadcast';
import { NetInputSource } from '@dd/engine/net/NetInputSource';
import { makeCommand } from '@dd/engine/state/input';
import { Button, type PlayerCommand } from '@dd/engine/state/commands';
import type { Brad } from '@dd/engine/math/trig';
import { toReplay, runReplay, runHeadless, hashState } from '@dd/engine/replay';
import type { EngineConfig } from '@dd/engine/state/GameState';

const cmd = (owner: number, tick: number, buttons = 0) =>
  makeCommand({ owner, tick, moveBrad: 0 as Brad, moveMag: 0, buttons });

describe('FrameBroadcast — metronome / ordering / watermark / log', () => {
  it('advances the watermark by framesPerBatch every pulse, even with no input', () => {
    const b = new FrameBroadcast({ framesPerBatch: 3 });
    expect(b.tick()).toEqual({ toFrame: 3, frames: [] }); // pure pulse, no waiting
    expect(b.tick()).toEqual({ toFrame: 6, frames: [] });
    expect(b.frame).toBe(6);
  });

  it('with no arrival offset, flushes onto the window toFrame, one command per owner, owners ascending', () => {
    const b = new FrameBroadcast({ framesPerBatch: 3 });
    // Submitted out of owner order; owner 1's two commands fold into one, the later's state.
    const a1 = cmd(1, 0, Button.FIRE);
    const a0 = cmd(0, 0);
    const a1b = cmd(1, 0, Button.INTERACT);
    b.submit(a1); b.submit(a0); b.submit(a1b);
    const batch = b.tick();
    expect(batch.toFrame).toBe(3);
    expect(batch.frames).toHaveLength(1);
    expect(batch.frames[0]!.frame).toBe(3);
    expect(batch.frames[0]!.cmds).toEqual([a0, a1b]);
    // Buffer cleared: the next pulse is an empty metronome pulse.
    expect(b.tick()).toEqual({ toFrame: 6, frames: [] });
  });

  it('lands each command on the window frame its arrival offset falls in (2026-10-03)', () => {
    const b = new FrameBroadcast({ framesPerBatch: 3 });
    b.tick(); // window (3, 6] is open
    const early = cmd(0, 0, Button.FIRE);
    const mid = cmd(1, 0, Button.FIRE);
    const late = cmd(0, 0);
    b.submit(early, 0); b.submit(mid, 1.7); b.submit(late, 2);
    expect(b.tick()).toEqual({
      toFrame: 6,
      frames: [{ frame: 4, cmds: [early] }, { frame: 5, cmds: [mid] }, { frame: 6, cmds: [late] }],
    });
    expect(b.log.map((f) => f.frame)).toEqual([4, 5, 6]);
  });

  it('clamps an offset into the window and never lands a command before an earlier arrival', () => {
    const b = new FrameBroadcast({ framesPerBatch: 3 });
    const first = cmd(0, 0, Button.FIRE);
    const second = cmd(1, 0);
    const third = cmd(1, 0, Button.FIRE);
    b.submit(first, 99); // a late metronome: past the window → its last frame
    b.submit(second, -4); // before the window → would be frame 1, but `first` already holds 3
    expect(b.tick().frames).toEqual([{ frame: 3, cmds: [first, second] }]);
    b.submit(third, -4);
    expect(b.tick().frames).toEqual([{ frame: 4, cmds: [third] }]);
  });

  it('folds a tap and its immediate clear on one frame: the state of the clear, the tap kept', () => {
    const b = new FrameBroadcast({ framesPerBatch: 3 });
    const tap = { ...cmd(0, 1, Button.FIRE | Button.SWAP_WEAPON), pickupTargetId: 7, shopBuyId: 3, cardVote: 2 };
    const clear = { ...cmd(0, 2, 0), moveMag: 255 };
    b.submit(tap, 1); b.submit(clear, 1);
    const [fc] = b.tick().frames;
    expect(fc!.frame).toBe(2);
    expect(fc!.cmds).toEqual([{ ...clear, buttons: Button.SWAP_WEAPON, pickupTargetId: 7, shopBuyId: 3, cardVote: 2 }]);
  });

  it('logSince returns only the non-empty frames after a given watermark (reconnect payload)', () => {
    const b = new FrameBroadcast({ framesPerBatch: 3 });
    b.tick(); // frame 3, empty
    b.submit(cmd(0, 0, Button.FIRE));
    b.tick(); // frame 6, has a command
    b.submit(cmd(1, 0));
    b.tick(); // frame 9, has a command
    expect(b.logSince(0).map((f) => f.frame)).toEqual([6, 9]);
    expect(b.logSince(6).map((f) => f.frame)).toEqual([9]); // only frames strictly after 6
    expect(b.log).toHaveLength(2); // empty frame-3 pulse was never logged
  });
});

describe('loopback: FrameBroadcast → NetInputSource → engine == the local run (design/06)', () => {
  const N = 180;
  const framesPerBatch = 3;
  const config: EngineConfig = {
    seed: 4242, worldW: 800, worldH: 800, playerStart: [400, 400],
    waves: [[[500, 400], [300, 400]], [[400, 300]]],
  };

  /** Relay `intent` (one command per sim frame) the way a live client does — through
   *  `NetInputSource.submit`'s change filter, each arriving in the window third of its own
   *  frame — then drive an engine off the confirmed stream. */
  function online(intent: PlayerCommand[]) {
    const server = new FrameBroadcast({ framesPerBatch });
    const net = new NetInputSource({ submit: (c) => server.submit(c, pendingOffset) }, { bufferFrames: 0 });
    let pendingOffset = 0;
    net.handleServerMsg({ type: 'match_start', seed: config.seed, startFrame: 0, localOwner: 0, playerCount: 1 });
    for (let f = 1; f <= N; f++) {
      pendingOffset = (f - 1) % framesPerBatch;
      net.submit(intent[f - 1]!);
      if (f % framesPerBatch === 0) net.handleServerMsg({ type: 'frame_batch', ...server.tick() });
    }
    return { engine: runHeadless(config, net, server.frame), server };
  }
  const local = (intent: PlayerCommand[]) => runReplay(toReplay(config, intent), N);

  it('a command changing every frame reproduces the local run byte-for-byte', () => {
    const intent: PlayerCommand[] = [];
    for (let f = 1; f <= N; f++) {
      intent.push(makeCommand({
        owner: 0, tick: f,
        moveBrad: ((f * 337) & 0xffff) as Brad, moveMag: (f * 7) % 256,
        buttons: Button.FIRE,
      }));
    }
    const { engine, server } = online(intent);
    const ref = local(intent);
    expect(server.log).toHaveLength(N); // every frame carried its own command
    expect(engine.state.tick).toBe(ref.state.tick);
    expect(hashState(engine.state)).toBe(hashState(ref.state));
  });

  it('a held stick sent once, and a one-shot swap, reproduce the local run — the gaps hold, the tap does not repeat', () => {
    const run = (f: number) =>
      makeCommand({ owner: 0, tick: f, moveBrad: (f < 90 ? 0 : 16384) as Brad, moveMag: f < 150 ? 255 : 0, buttons: Button.FIRE | (f === 40 ? Button.SWAP_WEAPON : 0) });
    const intent = Array.from({ length: N }, (_, i) => run(i + 1));
    const { engine, server } = online(intent);
    const ref = local(intent);
    // Sent on change only: the start, the tap, its clear, the turn, the stop.
    expect(server.log.map((f) => f.frame)).toEqual([1, 40, 41, 90, 150]);
    expect(hashState(engine.state)).toBe(hashState(ref.state));
    // The control: the same stream with every gap idled — what the client did before
    // 2026-10-03 — is a different run.
    const sparse = server.log.flatMap((fc) => fc.cmds.map((c) => ({ ...c, tick: fc.frame })));
    expect(hashState(runReplay(toReplay(config, sparse), N).state)).not.toBe(hashState(ref.state));
  });

  it('a card vote from a seat standing still reaches the sim (2026-10-08: it was filtered as a duplicate)', () => {
    // Idle throughout, one tap on frame 40 — the shape of a player choosing a card at the
    // portal. The vote is the only field that ever changes.
    const intent = Array.from({ length: N }, (_, i) =>
      makeCommand({ owner: 0, tick: i + 1, moveBrad: 0 as Brad, moveMag: 0, buttons: 0, cardVote: i + 1 === 40 ? 2 : 0 }));
    const { engine, server } = online(intent);
    expect(server.log.map((f) => f.frame)).toEqual([1, 40, 41]);
    expect(engine.state.players[0]!.cardVote).toBe(2);
    expect(hashState(engine.state)).toBe(hashState(local(intent).state));
  });
});
