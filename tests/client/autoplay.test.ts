/**
 * The in-page autoplay (MP3 D5, room/autoplay.ts) on the in-memory room: two players, each a sim bot
 * acting through its RoomSession (the controller's actNow path), reach the next area together, the
 * area marks agree with the server's state, the chat script speaks, and turning it off stops the inputs.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MemRoom } from './room-harness';
import { Autoplay } from '../../src/client/room/autoplay';
import { RoomSession } from '../../src/client/room/room-session';
import type { GameController } from '../../src/client/game-controller';
import type { RoomClient } from '../../src/net/client';
import { hashState } from '../../src/engine/index';

let room: MemRoom | null = null;
afterEach(() => {
  room?.dispose();
  room = null;
});

const tick = () => new Promise((r) => setTimeout(r, 0));

function player(c: RoomClient, o: { bot: 'explorer' | 'cautious'; seed: number }) {
  const session = new RoomSession({ client: c });
  const off = session.attach(() => undefined);
  // (the controller's actNow: the session's act; the UI side is not under test here)
  const controller = { actNow: (a: Parameters<RoomSession['act']>[0]) => session.act(a) } as unknown as GameController;
  const said: string[] = [];
  const auto = new Autoplay(
    {
      client: c,
      live: () => ({ session, controller }),
      say: (text) => {
        said.push(text);
        return c.say(text);
      },
    },
    { ...o, chatEvery: 20 },
  );
  return { session, auto, said, off };
}

describe('Autoplay', () => {
  it('plays both players through their sessions to the next area; the marks agree', async () => {
    const r = (room = new MemRoom({ seed: 5 }));
    const a = r.client('Kari', { host: true });
    const b = r.client('Ola');
    await r.join(a, b);
    a.start();
    await r.flush();
    const pa = player(a, { bot: 'explorer', seed: 1 });
    const pb = player(b, { bot: 'cautious', seed: 2 });
    pa.auto.set(true);
    pb.auto.set(true);
    // (an independent look at the same entries: the replica right after the area changed)
    let seen: string | null = null;
    const offB = b.on((e) => {
      if (e.t !== 'entries') return;
      for (const st of e.steps) if (!seen && st.after.area.index !== st.before.area.index) seen = `${st.after.area.index}@${st.entry.n + 1}:${hashState(st.after)}`;
    });
    for (let i = 0; i < 4000 && !pa.auto.snapshot().areas.length; i++) {
      await tick();
      await r.advance(40);
    }
    offB();
    const sa = pa.auto.snapshot();
    const sb = pb.auto.snapshot();
    expect(sa.faults).toEqual([]);
    expect(sb.faults).toEqual([]);
    expect(sa.areas.length).toBe(1);
    expect(sb.areas).toEqual(sa.areas);
    // the first area change: n and the hash right after it
    const m = sa.areas[0];
    expect(m.area).toBe(1);
    expect(`${m.area}@${m.n}:${m.hash}`).toBe(seen);
    expect(m.n).toBeLessThanOrEqual(r.room.n);
    // every action went through the session (as inputs), and the chat script spoke
    expect(sa.sent).toBeGreaterThan(20);
    expect(r.inputs(a).length).toBeGreaterThan(20);
    expect(pa.said.length).toBeGreaterThan(0);
    expect(b.chat.some((l) => l.text === pa.said[0])).toBe(true);

    // off: no more inputs from A (B's bot plays on alone)
    pa.auto.set(false);
    await tick();
    await r.advance(40);
    const sent = r.inputs(a).length;
    for (let i = 0; i < 30; i++) {
      await tick();
      await r.advance(40);
    }
    expect(r.inputs(a).length).toBe(sent);
    pa.auto.dispose();
    pb.auto.dispose();
    pa.off();
    pb.off();
  });
});
