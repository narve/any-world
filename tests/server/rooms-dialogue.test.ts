/**
 * MP4 G4 (design §4.1): per-player dialogue and trade in a room, verified (MP1 built it). In-process
 * room on the manual clock (tests/client/room-harness.ts), one RoomSession per client:
 *  - p1 talks to the preacher, p2 trades with the widow, p3 walks: p1 and p2 are busy and not active,
 *    so p3's turns resolve at once, without the deadline;
 *  - p1's replies never touch p2's open conversation;
 *  - one trader, two players: the second is refused while the first talks, then both buy from the
 *    shared purse and it ends at the sum of the two prices;
 *  - every replica on the server's hash throughout.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createGame, hashState } from '../../src/engine';
import type { ActorInstance, GameState, PlayerId, Pos } from '../../src/engine/types';
import { RoomSession } from '../../src/client/room/room-session';
import { dialogueMap } from '../../src/client/view';
import type { RoomClient } from '../../src/net/client';
import { loadFixture, roomMap } from '../engine/helpers';
import { MemRoom } from '../client/room-harness';

const western = loadFixture('fixture-western.json');

let h: MemRoom | null = null;
afterEach(() => {
  h?.dispose();
  h = null;
});

interface Seat {
  c: RoomClient;
  s: RoomSession;
}

async function started(names: string[]): Promise<Seat[]> {
  h = new MemRoom({ seed: 3 });
  const clients = names.map((n, i) => h!.client(n, { host: i === 0 }));
  await h.join(...clients);
  clients[0]!.start();
  await h.flush();
  return clients.map((c) => {
    const s = new RoomSession({ client: c });
    s.attach(() => {});
    return { c, s };
  });
}

/** a small open room: the players placed, hostiles removed, the NPCs of `keep` placed */
function smallRoom(names: string[], at: Pos[], keep: { defId: string; pos: Pos }[]): (s: GameState) => GameState {
  return () => {
    const st = structuredClone(createGame(western, { seed: 9, map: roomMap(18, 10), players: names.map((name) => ({ name })), exitCountdownTurns: 10 })) as GameState;
    const players = new Set(st.party.map((p) => st.players[p]!.actorId));
    const kept: ActorInstance[] = [];
    for (const k of keep) {
      const a = st.area.actors.find((x) => x.defId === k.defId && !kept.includes(x))!;
      a.pos = { ...k.pos };
      kept.push(a);
    }
    st.area.actors = st.area.actors.filter((a) => players.has(a.id) || kept.includes(a));
    st.party.forEach((pid, i) => (st.area.actors.find((x) => x.id === st.players[pid]!.actorId)!.pos = { ...at[i]! }));
    st.purse = 500;
    return st;
  };
}

const npc = (s: GameState, defId: string) => s.area.actors.find((a) => a.defId === defId)!;
const posOf = (s: GameState, pid: PlayerId) => ({ ...s.area.actors.find((a) => a.id === s.players[pid]!.actorId)!.pos });

function expectLockstep(seats: Seat[]): void {
  const want = hashState(h!.room.state!);
  for (const x of seats) {
    expect(x.c.n).toBe(h!.room.n);
    expect(hashState(x.c.state!)).toBe(want);
    expect(x.c.desyncs).toBe(0);
  }
}

/** the price of buy option `i` of an open trade (its currency action) */
function priceOf(s: RoomSession, i: number): number {
  const pc = s.me.pendingChoice!;
  const opt = pc.options[dialogueMap(pc).buy[i]!]!;
  const cur = opt.actions.find((a) => a.type === 'currency') as { amount: number } | undefined;
  return -(cur?.amount ?? 0);
}

describe('per-player dialogue and trade in a room (design §4.1)', () => {
  it('p1 talks, p2 trades, p3 walks without waiting; p1 never changes p2s conversation', async () => {
    const seats = await started(['Ann', 'Bo', 'Cy']);
    await h!.craft(
      smallRoom(['Ann', 'Bo', 'Cy'], [{ x: 3, y: 3 }, { x: 12, y: 3 }, { x: 7, y: 7 }], [
        { defId: 'preacher-weekes', pos: { x: 4, y: 3 } },
        { defId: 'widow-oquendo', pos: { x: 13, y: 3 } },
      ]),
      seats.map((x) => x.c),
    );
    const [a, b, c] = seats as [Seat, Seat, Seat];
    const rep = () => h!.room.state!;
    // (each opens its conversation alone: nobody else waits on a talk either)
    c.c.presence('menu');
    await h!.flush();
    a.s.act({ type: 'talk', targetId: npc(rep(), 'preacher-weekes').id });
    await h!.flush();
    b.s.act({ type: 'talk', targetId: npc(rep(), 'widow-oquendo').id });
    await h!.flush();
    expect(a.s.me.pendingChoice).toMatchObject({ kind: 'dialogue', speakerId: npc(rep(), 'preacher-weekes').id });
    expect(b.s.me.pendingChoice).toMatchObject({ kind: 'dialogue', speakerId: npc(rep(), 'widow-oquendo').id });
    b.s.intent({ type: 'open_trade', npcId: npc(rep(), 'widow-oquendo').id });
    expect(b.s.tradeOpen).toBe(true);

    // p1 and p2 are busy (not active): p3's steps resolve at once, the clock never waits on them
    c.c.presence('playing');
    await h!.flush();
    expect(h!.room.roster().filter((r) => r.pid === 'p1' || r.pid === 'p2').map((r) => r.presence)).toEqual(['busy', 'busy']);
    expect(h!.room.clockView().active).toEqual(['p3']);
    for (const dir of ['n', 'n', 'e'] as const) {
      const n0 = h!.room.n;
      const p3 = posOf(rep(), 'p3');
      expect(c.s.uiAction({ type: 'move', dir }).pending).toBeTruthy();
      await h!.flush();
      expect(h!.room.n).toBe(n0 + 1);
      expect(posOf(rep(), 'p3')).not.toEqual(p3);
    }

    // p1's replies (the healer's "Ask for help" chain and the rest) never change p2's open choice
    const p2Choice = JSON.stringify(rep().players.p2!.pendingChoice);
    let replies = 0;
    for (let i = 0; i < 3 && a.s.me.pendingChoice?.kind === 'dialogue'; i++) {
      const m = dialogueMap(a.s.me.pendingChoice);
      if (!m.engineIndex.length) break;
      a.s.dialogueReply(0);
      replies++;
      await h!.flush();
      expect(JSON.stringify(rep().players.p2!.pendingChoice)).toBe(p2Choice);
      expect(b.s.tradeOpen).toBe(true);
    }
    expect(replies).toBeGreaterThan(0);
    a.s.dialogueLeave();
    await h!.flush();
    expect(a.s.me.pendingChoice).toBeNull();
    expect(JSON.stringify(rep().players.p2!.pendingChoice)).toBe(p2Choice);

    // p2's buy goes through while the others play on
    const purse = rep().purse;
    const price = priceOf(b.s, 0);
    b.s.trade({ type: 'buy', offerIndex: 0 });
    await h!.flush();
    expect(rep().purse).toBe(purse - price);
    expect(b.s.me.pendingChoice?.kind).toBe('dialogue');
    expect(a.s.me.pendingChoice).toBeNull();
    expectLockstep(seats);
  });

  it('one trader, two players: the second waits for the first, both buy from the shared purse', async () => {
    const seats = await started(['Ann', 'Bo']);
    await h!.craft(smallRoom(['Ann', 'Bo'], [{ x: 5, y: 4 }, { x: 7, y: 4 }], [{ defId: 'widow-oquendo', pos: { x: 6, y: 4 } }]), seats.map((x) => x.c));
    const [a, b] = seats as [Seat, Seat];
    const widow = npc(h!.room.state!, 'widow-oquendo').id;
    a.s.act({ type: 'talk', targetId: widow });
    await h!.flush();
    expect(a.s.me.pendingChoice?.speakerId).toBe(widow);
    // (talking with someone else: refused, and nothing is appended)
    const n0 = h!.room.n;
    b.s.act({ type: 'talk', targetId: widow });
    await h!.flush();
    expect(h!.room.n).toBe(n0);
    expect(b.s.me.pendingChoice).toBeNull();

    const start = h!.room.state!.purse;
    a.s.intent({ type: 'open_trade', npcId: widow });
    const p1Price = priceOf(a.s, 1);
    a.s.trade({ type: 'buy', offerIndex: 1 });
    await h!.flush();
    expect(h!.room.state!.purse).toBe(start - p1Price);
    a.s.dialogueLeave();
    await h!.flush();

    b.s.act({ type: 'talk', targetId: widow });
    await h!.flush();
    expect(b.s.me.pendingChoice?.speakerId).toBe(widow);
    b.s.intent({ type: 'open_trade', npcId: widow });
    const p2Price = priceOf(b.s, 0);
    b.s.trade({ type: 'buy', offerIndex: 0 });
    await h!.flush();
    expect(h!.room.state!.purse).toBe(start - p1Price - p2Price);
    expect(p1Price + p2Price).toBeGreaterThan(0);
    // each item in its buyer's pack
    const pack = (pid: PlayerId) => h!.room.state!.players[pid]!.slots.filter(Boolean).map((x) => x!.defId);
    expect(pack('p1').length + pack('p2').length).toBeGreaterThanOrEqual(2);
    expectLockstep(seats);
  });
});
