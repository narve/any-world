/**
 * MP2 C5: the FaultyChannel of the scripted clients (tools/rooms/scripted-client.ts) over a fake
 * socket: frames keep their order through the jitter, stalls hold the incoming side, only inputs are
 * lost, and a random close calls the dropper after the frame it follows.
 */
import { describe, it, expect } from 'vitest';
import type { RoomSocket } from '../../src/net/client';
import { FaultyChannel, rng } from '../../tools/rooms/scripted-client';
import { until } from './rooms-helpers';

function fakeSocket() {
  const sent: string[] = [];
  const s: RoomSocket & { sent: string[]; deliver(d: string): void } = {
    readyState: 1,
    sent,
    send: (d: string) => void sent.push(d),
    close: () => {},
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    deliver(d: string) {
      this.onmessage?.({ data: d });
    },
  };
  return s;
}

describe('FaultyChannel', () => {
  it('delays frames with jitter and keeps their order', async () => {
    const real = fakeSocket();
    const ch = new FaultyChannel({ delayMs: [0, 30], seed: 3 }, () => real);
    const sock = ch.factory('ws://x');
    const got: string[] = [];
    sock.onmessage = (ev) => void got.push(String(ev.data));
    for (let i = 0; i < 40; i++) real.deliver(String(i));
    expect(got).toEqual([]);
    await until(() => got.length === 40, 2000, 'the frames');
    expect(got).toEqual([...Array(40).keys()].map(String));
    for (let i = 0; i < 10; i++) sock.send(`{"t":"chat","text":"${i}"}`);
    await until(() => real.sent.length === 10, 2000, 'the sends');
    expect(real.sent.map((d) => JSON.parse(d).text)).toEqual([...Array(10).keys()].map(String));
    expect(ch.stats.frames).toBe(40);
  });

  it('loses only inputs, stalls the incoming side, and drops the socket after a frame', async () => {
    const real = fakeSocket();
    let drops = 0;
    const ch = new FaultyChannel({ dropInputs: 1, stallEvery: 1, stallMs: 80, closeEvery: 1, seed: 1 }, () => real);
    ch.dropper = () => drops++;
    const sock = ch.factory('ws://x');
    sock.send('{"t":"input","area":0,"turn":1,"actions":[{"type":"wait"}],"intent":"decide"}');
    sock.send('{"t":"typing","on":true}');
    await until(() => real.sent.length === 1, 1000, 'the typing frame');
    expect(ch.stats.droppedInputs).toBe(1);
    expect(JSON.parse(real.sent[0]).t).toBe('typing');
    const got: string[] = [];
    sock.onmessage = (ev) => void got.push(String(ev.data));
    const t0 = Date.now();
    real.deliver('a');
    await until(() => got.length === 1, 1000, 'the stalled frame');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(70);
    expect(ch.stats.stalls).toBe(1);
    expect(drops).toBe(1);
    expect(ch.stats.closes).toBe(1);
  });

  it('rng is seeded', () => {
    const a = rng(5);
    const b = rng(5);
    const xs = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(xs);
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
  });
});
