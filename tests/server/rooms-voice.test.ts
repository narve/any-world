/**
 * MP4 G4: the words-only NPC voice in rooms (design §4.3; RoomGm.voice, Room.voiceTurns /
 * sendVoice, the `npc` message, RoomSession's voice and bubbles). In-process on the manual clock; the
 * provider is scripted (no real AI): every dialogue call answers after a given delay and honours its
 * signal, every GM call answers at once with words.
 *  - a conversation turn is voiced: the speaker's panel shows the line, a teammate gets a bubble, the
 *    voice's actions are never applied and no entry is made
 *  - dropped: the conversation closed or moved on (a newer turn aborts the older), the timeout
 *  - only 'ai' rooms voice; the voice takes at most half the pool and never waits for a slot
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createGame, hashState } from '../../src/engine';
import type { ActorInstance, GameState, PlayerId, Pos } from '../../src/engine/types';
import { RoomSession } from '../../src/client/room/room-session';
import type { RoomClient } from '../../src/net/client';
import type { ServerMsg } from '../../src/net/protocol';
import { LLMAbortedError } from '../../src/llm/errors';
import type { CompletionRequest, CompletionResponse, LLMProvider } from '../../src/llm/types';
import { offGmConfig, type GmConfig } from '../../server/gm-config';
import { VOICE_GAP_MS, VOICE_TIMEOUT_MS } from '../../server/rooms/gm';
import { loadFixture, roomMap } from '../engine/helpers';
import { MemRoom } from '../client/room-harness';

const western = loadFixture('fixture-western.json');

let h: MemRoom | null = null;
afterEach(() => {
  h?.dispose();
  h = null;
});

/** dialogue calls answer `replies` in order after `delays` (ms on the room clock); GM calls answer words at once */
class VoiceProvider implements LLMProvider {
  readonly id = 'mock';
  readonly model = 'mock';
  dialogueCalls = 0;
  aborted = 0;
  sch: MemRoom['sch'] | null = null;
  constructor(
    private readonly replies: string[],
    private readonly delays: number[],
  ) {}
  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    if (!req.purpose.startsWith('dialogue')) return { text: JSON.stringify({ actions: [{ type: 'narrate', text: 'AI: a moment' }] }), model: 'mock', stopReason: 'end_turn' };
    const i = this.dialogueCalls++;
    const sch = this.sch!;
    await new Promise<void>((resolve, reject) => {
      const t = sch.setTimer(sch.now() + (this.delays[i] ?? 100), resolve);
      req.signal?.addEventListener('abort', () => {
        sch.cancel(t);
        this.aborted++;
        reject(new LLMAbortedError(undefined, { provider: this.id }));
      });
    });
    const reply = this.replies[i] ?? `voice ${i}`;
    return { text: JSON.stringify({ reply, options: [], actions: [{ type: 'give_item', item: 'canteen', count: 1 }] }), model: 'mock', stopReason: 'end_turn' };
  }
}

function aiConfig(provider: LLMProvider | null, o: Partial<GmConfig> = {}): GmConfig {
  return { ...offGmConfig(10), setting: provider ? 'ai' : 'unset', provider, label: 'test', ...o };
}

interface Seat {
  c: RoomClient;
  s: RoomSession;
  npc: Extract<ServerMsg, { t: 'npc' }>[];
}

async function started(room: MemRoom, names: string[]): Promise<Seat[]> {
  const clients = names.map((n, i) => room.client(n, { host: i === 0 }));
  await room.join(...clients);
  clients[0]!.start();
  await room.flush();
  return clients.map((c) => {
    const s = new RoomSession({ client: c, now: () => room.sch.now() });
    s.attach(() => {});
    const npc: Seat['npc'] = [];
    c.on((e) => {
      if (e.t === 'message' && e.msg.t === 'npc') npc.push(e.msg);
    });
    return { c, s, npc };
  });
}

/** p1 next to the preacher, p2 next to the widow, 3 tiles apart; no hostiles */
function smallRoom(names: string[]): (s: GameState) => GameState {
  const at: Pos[] = [{ x: 4, y: 4 }, { x: 7, y: 4 }];
  const keep = [{ defId: 'preacher-weekes', pos: { x: 4, y: 3 } }, { defId: 'widow-oquendo', pos: { x: 7, y: 3 } }];
  return () => {
    const st = structuredClone(createGame(western, { seed: 9, map: roomMap(16, 10), players: names.map((name) => ({ name })), exitCountdownTurns: 10 })) as GameState;
    const players = new Set(st.party.map((p) => st.players[p]!.actorId));
    const kept: ActorInstance[] = [];
    for (const k of keep) {
      const a = st.area.actors.find((x) => x.defId === k.defId)!;
      a.pos = { ...k.pos };
      kept.push(a);
    }
    st.area.actors = st.area.actors.filter((a) => players.has(a.id) || kept.includes(a));
    st.party.forEach((pid, i) => (st.area.actors.find((x) => x.id === st.players[pid]!.actorId)!.pos = { ...at[i]! }));
    return st;
  };
}

const npcId = (s: GameState, defId: string) => s.area.actors.find((a) => a.defId === defId)!.id;
const packSize = (s: GameState, pid: PlayerId) => s.players[pid]!.slots.filter(Boolean).length;

async function setUp(provider: VoiceProvider | null, o: Partial<GmConfig> = {}): Promise<Seat[]> {
  h = new MemRoom({ world: western, seed: 5, gm: aiConfig(provider, o) });
  if (provider) provider.sch = h.sch;
  const seats = await started(h, ['Ann', 'Bo']);
  await h.craft(smallRoom(['Ann', 'Bo']), seats.map((x) => x.c));
  await h.advance(VOICE_GAP_MS);
  return seats;
}

/** moves the room clock in small steps, letting the voice's promise chains finish between them (they need more than one microtask) */
async function tick(ms: number, step = 100): Promise<void> {
  for (let t = 0; t < ms; t += step) {
    await h!.advance(Math.min(step, ms - t));
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    await h!.flush();
  }
}

function expectLockstep(seats: Seat[]): void {
  for (const x of seats) expect(hashState(x.c.state!)).toBe(hashState(h!.room.state!));
}

describe('the NPC voice in rooms (words only)', () => {
  it("voices a conversation turn: the speaker's line, a teammate's bubble, no actions and no entry", async () => {
    const p = new VoiceProvider(['Bless you, traveller. The well is poisoned.'], [400]);
    const [a, b] = await setUp(p);
    const preacher = npcId(h!.room.state!, 'preacher-weekes');
    const pack = packSize(h!.room.state!, 'p1');
    a.s.act({ type: 'talk', targetId: preacher });
    await h!.flush();
    expect(a.s.me.pendingChoice?.speakerId).toBe(preacher);
    const canned = a.s.me.pendingChoice!.prompt;
    expect(p.dialogueCalls).toBe(1);
    // the teammate sees the canned line as a bubble first
    expect(b.s.npcBubbles.all(h!.sch.now())).toMatchObject([{ actorId: preacher, text: canned }]);
    const n = h!.room.n;
    await tick(500);
    expect(a.npc).toEqual([{ t: 'npc', run: 1, n: n - 1, pid: 'p1', actorId: preacher, text: 'Bless you, traveller. The well is poisoned.' }]);
    expect(a.s.voiceLine()).toBe('Bless you, traveller. The well is poisoned.');
    expect(a.s.viewModel().game!.dialogue!.reply).toBe('Bless you, traveller. The well is poisoned.');
    expect(b.s.npcBubbles.all(h!.sch.now())).toMatchObject([{ actorId: preacher, text: 'Bless you, traveller. The well is poisoned.' }]);
    expect(b.s.voiceLine()).toBeNull();
    // words only: the gift in the voice's answer is never applied, and nothing was appended
    expect(h!.room.n).toBe(n);
    expect(packSize(h!.room.state!, 'p1')).toBe(pack);
    expectLockstep([a, b]);
  });

  it('drops a line whose conversation closed, and a newer turn aborts the older request', async () => {
    const p = new VoiceProvider(['FIRST', 'SECOND', 'THIRD'], [3000, 4000, 300]);
    const [a, b] = await setUp(p);
    const preacher = npcId(h!.room.state!, 'preacher-weekes');
    a.s.act({ type: 'talk', targetId: preacher });
    await tick(1000);
    a.s.dialogueLeave();
    await tick(3000);
    expect(a.npc).toEqual([]);
    expect(p.aborted).toBe(1);

    // a reply past the gap aborts the open request; its own line arrives
    await tick(VOICE_GAP_MS);
    a.s.act({ type: 'talk', targetId: preacher });
    await tick(VOICE_GAP_MS + 500);
    expect(p.dialogueCalls).toBe(2);
    a.s.dialogueReply(0);
    await h!.flush();
    expect(p.aborted).toBe(2);
    await tick(400);
    expect(a.npc.map((m) => m.text)).toEqual(['THIRD']);
    expect(b.npc.map((m) => m.text)).toEqual(['THIRD']);
    expect(a.s.voiceLine() === 'THIRD' || a.s.me.pendingChoice?.kind !== 'dialogue').toBe(true);
    expectLockstep([a, b]);
  });

  it('a turn sooner than the gap keeps its canned line; a line later than the timeout is dropped', async () => {
    const p = new VoiceProvider(['LATE', 'NEXT'], [VOICE_TIMEOUT_MS + 2000, 200]);
    const [a] = await setUp(p);
    const preacher = npcId(h!.room.state!, 'preacher-weekes');
    a.s.act({ type: 'talk', targetId: preacher });
    await tick(VOICE_TIMEOUT_MS + 3000);
    expect(a.npc).toEqual([]);
    expect(p.aborted).toBe(1);
    // the slot came back: the next turn is voiced; one sooner than the gap is not asked
    a.s.dialogueReply(0);
    await h!.flush();
    expect(p.dialogueCalls).toBe(2);
    if (a.s.me.pendingChoice?.kind === 'dialogue' && a.s.me.pendingChoice.options.length > 1) {
      a.s.dialogueReply(0);
      await h!.flush();
      expect(p.dialogueCalls).toBe(2);
    }
    await tick(300);
    expect(a.npc.length).toBeLessThanOrEqual(1);
  });

  it('only the AI GM voices; the voice takes at most half the pool and never waits for a slot', async () => {
    const none = await setUp(null);
    expect(h!.room.gmMode()).toBe('offline');
    none[0]!.s.act({ type: 'talk', targetId: npcId(h!.room.state!, 'preacher-weekes') });
    await tick(1000);
    expect(none[0]!.npc).toEqual([]);
    h!.dispose();

    const p = new VoiceProvider(['ONE', 'TWO'], [1000, 1000]);
    const [a, b] = await setUp(p, { concurrency: 2 });
    a.s.act({ type: 'talk', targetId: npcId(h!.room.state!, 'preacher-weekes') });
    await h!.flush();
    b.s.act({ type: 'talk', targetId: npcId(h!.room.state!, 'widow-oquendo') });
    await h!.flush();
    expect(a.s.me.pendingChoice?.kind).toBe('dialogue');
    expect(b.s.me.pendingChoice?.kind).toBe('dialogue');
    expect(p.dialogueCalls).toBe(1);
    await tick(1200);
    expect(a.npc.map((m) => [m.pid, m.text])).toEqual([['p1', 'ONE']]);
    expect(b.s.npcBubbles.all(h!.sch.now()).map((x) => x.text)).toContain('ONE');
    expectLockstep([a, b]);
  });
});
