/**
 * MP3 D2: RoomSession (src/client/room/room-session.ts) against real rooms through the in-memory
 * harness (room-harness.ts): each session plays its own player; a session as p2 has p2's HUD,
 * hints, persuade odds and legal actions; the replica is never written (a write trap on `state`,
 * and every client's hash equals the server's after 200 entries); the dry run; coalescing; chains
 * sent as one input keep the conversation open; travel from the entries; party toasts once each and
 * none on catch-up; late join; the spectator camera; reconnects without duplicates.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createGame, hashState, legalActions, passability, persuadeOdds, playerSheet } from '../../src/engine';
import type { ActorInstance, GameState, PlayerAction, PlayerId, Pos } from '../../src/engine/types';
import { botByName, newMemory, type BotName } from '../../src/engine/sim/bots';
import { RoomSession } from '../../src/client/room/room-session';
import { perspective } from '../../src/client/room/perspective';
import { ChatModel } from '../../src/client/room/chat-model';
import type { Outcome } from '../../src/client/session';
import { dialogueMap } from '../../src/client/view';
import type { RoomClient } from '../../src/net/client';
import { loadFixture, roomMap } from '../engine/helpers';
import { MemRoom } from './room-harness';

const western = loadFixture('fixture-western.json');

let h: MemRoom | null = null;
afterEach(() => {
  h?.dispose();
  h = null;
});

interface Seat {
  c: RoomClient;
  s: RoomSession;
  outs: Outcome[];
  off: () => void;
}

/** a started room with `names.length` players (the first is the host) and a session per client */
async function started(names: string[], o: { seed?: number } = {}): Promise<{ h: MemRoom; seats: Seat[] }> {
  const room = new MemRoom({ seed: o.seed ?? 3 });
  h = room;
  const clients = names.map((n, i) => room.client(n, { host: i === 0 }));
  await room.join(...clients);
  clients[0].start();
  await room.flush();
  return { h: room, seats: clients.map((c) => session(c)) };
}

function session(c: RoomClient): Seat {
  const s = new RoomSession({ client: c });
  const outs: Outcome[] = [];
  const off = s.attach((o) => outs.push(o));
  return { c, s, outs, off };
}

/** every state write outside absorb / rebuild throws */
function trapWrites(s: RoomSession): void {
  let v = s.state;
  Object.defineProperty(s, 'state', {
    configurable: true,
    get: () => v,
    set: (x: GameState) => {
      if (!s.writable) throw new Error('RoomSession wrote its state outside absorb');
      v = x;
    },
  });
}

/** a small open room with the given players placed, hostiles removed, actors of `keep` placed */
function smallRoom(names: string[], at: Pos[], keep: { defId: string; pos: Pos }[] = [], o: { w?: number; h?: number } = {}): (s: GameState) => GameState {
  return () => {
    const s = createGame(western, { seed: 9, map: roomMap(o.w ?? 16, o.h ?? 10), players: names.map((name) => ({ name })), exitCountdownTurns: 10 });
    const st = structuredClone(s) as GameState;
    const players = new Set(st.party.map((p) => st.players[p].actorId));
    const kept: ActorInstance[] = [];
    for (const k of keep) {
      const a = st.area.actors.find((x) => x.defId === k.defId && !kept.includes(x));
      if (!a) throw new Error(`no ${k.defId}`);
      a.pos = { ...k.pos };
      kept.push(a);
    }
    st.area.actors = st.area.actors.filter((a) => players.has(a.id) || kept.includes(a));
    st.party.forEach((pid, i) => {
      const a = st.area.actors.find((x) => x.id === st.players[pid].actorId)!;
      a.pos = { ...at[i] };
      // (each player a different hp, so the HUD shows whose it is)
      a.hp = Math.max(1, a.hp - i);
    });
    return st;
  };
}

const actorOf = (s: GameState, pid: PlayerId) => s.area.actors.find((a) => a.id === s.players[pid].actorId)!;
const posOf = (s: GameState, pid: PlayerId) => ({ ...actorOf(s, pid).pos });

/** everyone else is reading a menu, so this player's turns resolve without waiting */
async function othersInMenu(seats: Seat[], except: number): Promise<void> {
  seats.forEach((x, i) => i !== except && x.c.presence('menu'));
  await h!.flush();
}

describe('RoomSession: own player and view', () => {
  it('each session plays its own player; p2 has p2s HUD, legal actions, sheet and odds', async () => {
    const { h, seats } = await started(['Ann', 'Bo', 'Cy']);
    await h.craft(smallRoom(['Ann', 'Bo', 'Cy'], [{ x: 2, y: 2 }, { x: 6, y: 5 }, { x: 10, y: 3 }], [{ defId: 'preacher-weekes', pos: { x: 7, y: 5 } }]), seats.map((x) => x.c));
    const [a, b, c] = seats;
    expect(b.s.pid).toBe('p2');
    expect(b.s.state.party[0]).toBe('p2');
    const vm = b.s.viewModel().game!;
    expect(vm.hud.playerName).toBe('Bo');
    const rep = b.s.replica;
    expect(vm.hud.hp.value).toBe(actorOf(rep, 'p2').hp);
    expect(a.s.viewModel().game!.hud.hp.value).toBe(actorOf(rep, 'p1').hp);
    expect(legalActions(b.s.state)).toEqual(legalActions(rep, { playerId: 'p2' }));
    expect(playerSheet(b.s.state)).toEqual(playerSheet(rep, { playerId: 'p2' }));
    const npc = rep.area.actors.find((x) => x.defId === 'preacher-weekes')!;
    expect(persuadeOdds(b.s.state, npc.id)).toEqual(persuadeOdds(rep, npc.id, { playerId: 'p2' }));
    // the talk hint and the interact targets are p2s: only p2 stands next to the preacher
    expect(legalActions(b.s.state).some((x) => x.type === 'talk' && x.targetId === npc.id)).toBe(true);
    expect(b.s.player().id).toBe(rep.players.p2.actorId);
    expect(a.s.player().id).toBe(rep.players.p1.actorId);

    // p2 moves: p2's actor moves, not the lead's
    const p1 = posOf(rep, 'p1');
    const p2 = posOf(rep, 'p2');
    a.c.presence('menu');
    c.c.presence('menu');
    await h.flush();
    const out = b.s.uiAction({ type: 'move', dir: 'n' });
    expect(out.pending).toEqual({ type: 'move', dir: 'n' });
    expect(out.changed).toBe(false);
    expect(b.s.queued?.action).toEqual({ type: 'move', dir: 'n' });
    await h.flush();
    expect(posOf(b.s.replica, 'p2')).toEqual({ x: p2.x, y: p2.y - 1 });
    expect(posOf(b.s.replica, 'p1')).toEqual(p1);
    expect(b.s.queued).toBeNull();
    for (const x of seats) expect(hashState(x.c.state!)).toBe(hashState(h.room.state!));
    expect(a.s.player().pos).toEqual(p1);
    expect(b.s.player().pos).toEqual({ x: p2.x, y: p2.y - 1 });
  });
});

/** one sim-bot decision through the session's UI calls (as the controller makes them) */
function drive(s: RoomSession, a: PlayerAction, talks: { n: number }): Outcome {
  const pc = s.me.pendingChoice;
  if (pc?.kind === 'dialogue') {
    if (a.type === 'persuade') return s.intent({ type: 'persuade', targetId: a.targetId });
    if (a.type === 'choose_option') {
      const m = dialogueMap(pc);
      if (++talks.n > 4 || a.index === m.leaveIndex) return s.dialogueLeave();
      const buy = m.buy.indexOf(a.index);
      if (buy >= 0) return s.trade({ type: 'buy', offerIndex: buy });
      const ui = m.engineIndex.indexOf(a.index);
      return ui >= 0 ? s.dialogueReply(ui) : s.dialogueLeave();
    }
  }
  talks.n = 0;
  if (a.type === 'talk') return s.intent({ type: 'talk' });
  return s.uiAction(a);
}

describe('RoomSession: lockstep', () => {
  it('never writes the replica: state writes only in absorb, and every hash equals the servers after 200 entries', async () => {
    const { h, seats } = await started(['Ann', 'Bo', 'Cy'], { seed: 4 });
    for (const x of seats) trapWrites(x.s);
    const names: BotName[] = ['explorer', 'talker', 'cautious'];
    const bots = seats.map((_, i) => ({ bot: botByName(names[i]), mem: newMemory(i + 1), talks: { n: 0 } }));
    let sent = 0;
    for (let guard = 0; guard < 4000 && h.room.n < 200 && h.room.state!.status === 'playing'; guard++) {
      seats.forEach((x, i) => {
        if (x.s.ended || x.s.queued || x.s.me.down) return;
        const out = drive(x.s, bots[i].bot.decide(x.s.state, western, bots[i].mem), bots[i].talks);
        if (out.pending) sent++;
      });
      await h.advance(40);
    }
    expect(h.room.n).toBeGreaterThanOrEqual(h.room.state!.status === 'playing' ? 200 : 20);
    expect(sent).toBeGreaterThan(50);
    await h.advance(100);
    const want = hashState(h.room.state!);
    for (const x of seats) {
      expect(x.c.n).toBe(h.room.n);
      expect(hashState(x.c.state!)).toBe(want);
      expect(x.s.state).toBe(perspective(x.c.state!, x.s.pid));
      expect(x.c.desyncs).toBe(0);
    }
    // (the trap works)
    expect(() => {
      seats[1].s.state = seats[1].s.replica;
    }).toThrow(/outside absorb/);
  }, 60_000);

  it('dry run: an illegal action toasts and is not sent; not ready is sent and queued; the last countdown turn is not dry-run', async () => {
    const { h, seats } = await started(['Ann', 'Bo']);
    await h.craft(smallRoom(['Ann', 'Bo'], [{ x: 1, y: 1 }, { x: 8, y: 6 }]), seats.map((x) => x.c));
    const [a] = seats;
    const n0 = h.inputs(a.c).length;
    const out = a.s.uiAction({ type: 'move', dir: 'nw' }); // into the corner wall
    expect(out.pending).toBeUndefined();
    expect(out.toasts[0]?.tone).toBe('warn');
    expect(h.inputs(a.c)).toHaveLength(n0);

    // not ready (no energy for a turn action): sent, and shown as queued
    const real = a.c.state!;
    const tired = structuredClone(real) as GameState;
    actorOf(tired, 'p1').energy = 0;
    a.c.state = tired;
    const o2 = a.s.uiAction({ type: 'move', dir: 'e' });
    a.c.state = real;
    expect(o2.pending).toEqual({ type: 'move', dir: 'e' });
    expect(o2.toasts).toEqual([]);
    expect(h.inputs(a.c)).toHaveLength(n0 + 1);
    expect(a.s.queued?.action).toEqual({ type: 'move', dir: 'e' });

    // the last exit-countdown turn: sent unchecked (the server's refusal toasts)
    const cd = structuredClone(real) as GameState;
    cd.area.exitCountdown = { turnsLeft: 1, by: 'p2' };
    a.c.state = cd;
    const o3 = a.s.uiAction({ type: 'move', dir: 'n' }); // into the wall
    a.c.state = real;
    expect(o3.pending).toEqual({ type: 'move', dir: 'n' });
    expect(h.inputs(a.c)).toHaveLength(n0 + 2);
  });

  it('coalesces: one turn action per turn, the same one is not resent, a new one replaces it', async () => {
    const { h, seats } = await started(['Ann', 'Bo']);
    await h.craft(smallRoom(['Ann', 'Bo'], [{ x: 4, y: 4 }, { x: 10, y: 6 }]), seats.map((x) => x.c));
    const [a, b] = seats;
    const n0 = h.inputs(a.c).length;
    a.s.uiAction({ type: 'move', dir: 'e' });
    a.s.uiAction({ type: 'move', dir: 'e' }); // key repeat
    expect(h.inputs(a.c)).toHaveLength(n0 + 1);
    a.s.uiAction({ type: 'move', dir: 's' });
    expect(h.inputs(a.c)).toHaveLength(n0 + 2);
    await h.flush();
    // Bo has not acted: nothing resolved yet; Bo acts and the turn carries Ann's latest
    expect(posOf(h.room.state!, 'p1')).toEqual({ x: 4, y: 4 });
    b.s.uiAction({ type: 'wait' });
    await h.flush();
    expect(posOf(h.room.state!, 'p1')).toEqual({ x: 4, y: 5 });
    expect(a.s.queued).toBeNull();
    const last = h.inputs(b.c).at(-1)!;
    expect(last.intent).toBe('wait');
  });

  it('an input the socket dropped for its rate (error rate) is sent again on the next key press', async () => {
    const { h, seats } = await started(['Ann', 'Bo']);
    await h.craft(smallRoom(['Ann', 'Bo'], [{ x: 4, y: 4 }, { x: 10, y: 6 }]), seats.map((x) => x.c));
    const [a] = seats;
    const n0 = h.inputs(a.c).length;
    a.s.uiAction({ type: 'move', dir: 'e' });
    expect(a.s.queued?.action).toEqual({ type: 'move', dir: 'e' });
    a.s.onMessage({ t: 'error', code: 'rate', message: 'too many messages; slow down' });
    expect(a.s.queued).toBeNull();
    a.s.uiAction({ type: 'move', dir: 'e' });
    expect(h.inputs(a.c)).toHaveLength(n0 + 2);
  });
});

describe('RoomSession: dialogue and trade chains', () => {
  it('"Ask for help", "Ask what they know" and a buy keep the conversation open, each sent as one input', async () => {
    const { h, seats } = await started(['Ann', 'Bo']);
    await h.craft(
      (s) => {
        const st = smallRoom(['Ann', 'Bo'], [{ x: 3, y: 3 }, { x: 12, y: 7 }], [{ defId: 'preacher-weekes', pos: { x: 4, y: 3 } }, { defId: 'widow-oquendo', pos: { x: 3, y: 4 } }])(s);
        st.purse = 999;
        actorOf(st, 'p1').hp = 3;
        return st;
      },
      seats.map((x) => x.c),
    );
    const [a] = seats;
    await othersInMenu(seats, 0);
    const preacher = a.s.replica.area.actors.find((x) => x.defId === 'preacher-weekes')!;
    a.s.intent({ type: 'persuade', targetId: preacher.id }); // (persuade is not talk: refused or not, it is sent alone)
    await h.advance(40);
    a.s.intent({ type: 'talk' });
    await h.flush();
    let pc = a.s.me.pendingChoice;
    if (pc?.kind === 'dialogue' && pc.speakerId !== preacher.id) {
      a.s.dialogueLeave();
      await h.flush();
    }
    // talk to the preacher by id (the nearest NPC may be the widow)
    if (a.s.me.pendingChoice?.kind !== 'dialogue') {
      a.s.act({ type: 'talk', targetId: preacher.id });
      await h.flush();
    }
    pc = a.s.me.pendingChoice;
    expect(pc?.kind).toBe('dialogue');
    expect(pc!.speakerId).toBe(preacher.id);
    const help = dialogueMap(pc!).engineIndex.findIndex((i) => pc!.options[i].tag === 'service:heal');
    expect(help).toBeGreaterThanOrEqual(0);
    const n0 = h.inputs(a.c).length;
    const replicaLog = a.s.replica.log.length;
    a.s.dialogueReply(help);
    expect(h.inputs(a.c)).toHaveLength(n0 + 1);
    expect(h.inputs(a.c).at(-1)!.actions.map((x) => x.type)).toEqual(['choose_option', 'talk']);
    await h.flush();
    expect(a.s.me.pendingChoice?.kind).toBe('dialogue');
    expect(a.s.player().hp).toBeGreaterThan(3);
    expect(a.s.history.map((x) => x.who)).toEqual(['npc', 'player']);
    expect(a.s.viewModel().game!.dialogue!.reply).toMatch(/helps you/);
    // the healer's line is this client's only: in the log view, never in the replica
    expect(a.s.overlay.lines).toHaveLength(1);
    expect(a.s.replica.log.slice(replicaLog).some((l) => /helps you/.test(l.text))).toBe(false);
    expect(a.s.viewModel().game!.log.some((l) => /helps you/.test(l.text))).toBe(true);

    // "Ask what they know": the answer is the NPC's line, the conversation stays open
    const pc2 = a.s.me.pendingChoice!;
    const m2 = dialogueMap(pc2);
    const ask = m2.engineIndex.findIndex((i) => pc2.options[i].actions.length === 1 && pc2.options[i].actions[0].type === 'say');
    if (ask >= 0) {
      const said = (pc2.options[m2.engineIndex[ask]].actions[0] as { text: string }).text;
      a.s.dialogueReply(ask);
      await h.flush();
      expect(a.s.me.pendingChoice?.kind).toBe('dialogue');
      expect(a.s.viewModel().game!.dialogue!.reply).toBe(said);
      expect(a.s.history).toHaveLength(4);
    }
    a.s.dialogueLeave();
    await h.flush();
    expect(a.s.me.pendingChoice).toBeNull();

    // the widow's shop: a buy keeps the shop open
    const widow = a.s.replica.area.actors.find((x) => x.defId === 'widow-oquendo')!;
    a.s.act({ type: 'talk', targetId: widow.id });
    await h.flush();
    expect(a.s.me.pendingChoice?.speakerId).toBe(widow.id);
    a.s.intent({ type: 'open_trade', npcId: widow.id });
    const purse = a.s.replica.purse;
    const n1 = h.inputs(a.c).length;
    const out = a.s.trade({ type: 'buy', offerIndex: 0 });
    expect(out.pending).toBeTruthy();
    expect(h.inputs(a.c)).toHaveLength(n1 + 1);
    await h.flush();
    expect(a.s.replica.purse).toBeLessThan(purse);
    expect(a.s.me.pendingChoice?.kind).toBe('dialogue');
    expect(a.s.tradeOpen).toBe(true);
    expect(a.s.viewModel().game!.trade).toBeTruthy();
    for (const x of seats) expect(hashState(x.c.state!)).toBe(hashState(h.room.state!));
  });
});

describe('RoomSession: travel', () => {
  it('sends one travel step per turn from the entries and stops at the destination or when a hostile comes into view', async () => {
    const { h, seats } = await started(['Ann', 'Bo']);
    await h.craft(smallRoom(['Ann', 'Bo'], [{ x: 2, y: 2 }, { x: 13, y: 8 }]), seats.map((x) => x.c));
    const [a] = seats;
    await othersInMenu(seats, 0);
    const n0 = h.inputs(a.c).length;
    const click = a.s.intent({ type: 'click_tile', pos: { x: 10, y: 6 }, button: 'primary' });
    expect(click.travel).toBe(true);
    a.s.travelTick();
    for (let i = 0; i < 100 && a.s.travelDest; i++) await h.advance(40);
    expect(a.s.player().pos).toEqual({ x: 10, y: 6 });
    expect(a.s.travelDest).toBeNull();
    const sent = h.inputs(a.c).slice(n0);
    expect(sent.length).toBe(8);
    expect(sent.every((m) => m.intent === 'travel' && m.actions[0].type === 'move')).toBe(true);
    expect(new Set(sent.map((m) => m.turn)).size).toBe(sent.length);

    // a long hall with a hostile beyond sight: travel stops once it comes into view
    await h.craft(smallRoom(['Ann', 'Bo'], [{ x: 2, y: 5 }, { x: 2, y: 8 }], [{ defId: 'mesa-rattler', pos: { x: 17, y: 5 } }], { w: 40, h: 10 }), seats.map((x) => x.c));
    await othersInMenu(seats, 0);
    a.s.intent({ type: 'click_tile', pos: { x: 36, y: 5 }, button: 'primary' });
    a.s.travelTick();
    for (let i = 0; i < 200 && a.s.travelDest; i++) await h.advance(40);
    expect(a.s.travelDest).toBeNull();
    const st = a.s.state;
    const rattler = st.area.actors.find((x) => x.defId === 'mesa-rattler')!;
    expect((a.s.me.seen as ArrayLike<number>)[rattler.pos.y * st.area.map.width + rattler.pos.x]).toBe(2);
    expect(a.s.player().pos.x).toBeLessThan(15);
    expect(a.s.player().pos.x).toBeGreaterThan(2);
  });
});

/** a room started with sessions created on the `run` event, synchronously (as the browser does) */
async function startedLive(names: string[]): Promise<{ h: MemRoom; seats: Seat[] }> {
  const room = new MemRoom({ seed: 3 });
  h = room;
  const clients = names.map((n, i) => room.client(n, { host: i === 0 }));
  await room.join(...clients);
  const seats: Seat[] = [];
  for (const c of clients) {
    const off = c.on((e) => {
      if (e.t === 'state' && e.reason === 'run') {
        off();
        seats.push(session(c));
      }
    });
  }
  clients[0].start();
  await room.flush();
  // (in client order)
  seats.sort((x, y) => clients.indexOf(x.c) - clients.indexOf(y.c));
  return { h: room, seats };
}

const toasts = (x: Seat) => x.outs.flatMap((o) => o.toasts.map((t) => t.text));

describe('RoomSession: the GM, the exit countdown and the party', () => {
  it('the intro and area cards come from the servers GM entries; the exit countdown shows for everyone', async () => {
    const { h, seats } = await startedLive(['Ann', 'Bo', 'Cy']);
    for (const x of seats) {
      expect(x.s.narration?.kind).toBe('intro');
      expect(x.s.narration?.text).toBe(western.gm.fallback.intro);
    }
    await h.craft(smallRoom(['Ann', 'Bo', 'Cy'], [{ x: 14, y: 8 }, { x: 3, y: 3 }, { x: 5, y: 2 }]), seats.map((x) => x.c));
    const [a, b, c] = seats;
    expect(a.s.narration).toBeNull(); // a rebuilt view drops the card
    const out = a.s.act({ type: 'transition' });
    expect(out.pending).toEqual({ type: 'transition' });
    b.s.uiAction({ type: 'wait' });
    c.s.uiAction({ type: 'wait' });
    await h.flush();
    for (const x of seats) expect(x.s.state.area.exitCountdown).toMatchObject({ by: 'p1' });
    const left = b.s.state.area.exitCountdown!.turnsLeft;
    await h.advance(150);
    expect(b.s.state.area.exitCountdown!.turnsLeft).toBe(left - 1);
    for (let i = 0; i < 30 && h.room.state!.area.index === 0; i++) await h.advance(150);
    await h.advance(600);
    expect(h.room.state!.area.index).toBe(1);
    for (const x of seats) {
      expect(x.s.state.area.index).toBe(1);
      expect(x.s.narration?.kind).toBe('area_enter');
      expect(x.s.narration?.title).toBe(western.areas[1].name);
      expect(hashState(x.c.state!)).toBe(hashState(h.room.state!));
      expect(x.s.state.party[0]).toBe(x.s.pid);
    }
  });

  it('join, away and back toast once each, never for oneself or a catch-up batch; a late joiner plays its own player', async () => {
    const { h, seats } = await started(['Ann', 'Bo']);
    const [a, b] = seats;
    const cy = h.client('Cy');
    let late: Seat | null = null;
    cy.on((e) => {
      if (e.t === 'welcome' && !late) late = session(cy);
    });
    await h.join(cy);
    expect(toasts(a)).toEqual(['Cy joined']);
    expect(toasts(b)).toEqual(['Cy joined']);
    expect(late).not.toBeNull();
    const c = late as unknown as Seat;
    expect(c.s.pid).toBe('p3');
    expect(c.s.state.party[0]).toBe('p3');
    expect(c.s.player().id).toBe(c.s.replica.players.p3.actorId);
    expect(c.s.viewModel().game!.hud.playerName).toBe('Cy');
    expect(toasts(c)).toEqual([]);

    // Bo's connection drops and comes back: Ann and Cy hear it once; Bo's catch-up batch toasts nothing
    const bOuts = b.outs.length;
    b.c.drop();
    await h.flush();
    expect(toasts(a)).toEqual(['Cy joined', 'Bo is away']);
    await h.advance(60);
    expect(b.c.status).toBe('joined');
    expect(b.c.reconnects).toBe(1);
    expect(toasts(a)).toEqual(['Cy joined', 'Bo is away', 'Bo is back']);
    expect(toasts(c)).toEqual(['Bo is away', 'Bo is back']);
    const caught = b.outs.slice(bOuts);
    expect(caught.length).toBeGreaterThan(0);
    expect(caught.flatMap((o) => o.toasts)).toEqual([]);
    for (const x of [a, b, c]) expect(hashState(x.c.state!)).toBe(hashState(h.room.state!));
    expect(b.s.state).toBe(perspective(b.c.state!, 'p2'));
  });

  it('down: the camera follows the nearest standing teammate, [ / ] cycle, and it comes back on getting up', async () => {
    const { h, seats } = await started(['Ann', 'Bo', 'Cy']);
    await h.craft(
      (s) => {
        const st = smallRoom(['Ann', 'Bo', 'Cy'], [{ x: 4, y: 4 }, { x: 12, y: 8 }, { x: 6, y: 4 }])(s);
        actorOf(st, 'p1').hp = 0;
        st.players.p1.down = { since: st.turn, helpedTurns: 0 };
        return st;
      },
      seats.map((x) => x.c),
    );
    const [a, b, c] = seats;
    expect(a.s.me.down).toBeTruthy();
    expect(a.s.followed).toBe('p3');
    expect(a.s.cameraState.party[0]).toBe('p3');
    expect(a.s.state.party[0]).toBe('p1'); // the HUD stays this player's
    expect(a.s.cycleFollow(1)).toBe('p2');
    expect(a.s.cameraState.party[0]).toBe('p2');
    expect(a.s.cycleFollow(1)).toBe('p3');
    expect(a.s.cycleFollow(-1)).toBe('p2');
    expect(b.s.followed).toBeNull();
    expect(b.s.cameraState).toBe(b.s.state);
    // a down player's action is not sent
    const n0 = h.inputs(a.c).length;
    a.s.uiAction({ type: 'wait' });
    expect(h.inputs(a.c)).toHaveLength(n0);
    // Cy stands next to Ann: she gets up, the camera comes back
    c.s.uiAction({ type: 'move', dir: 'w' });
    b.s.uiAction({ type: 'wait' });
    await h.flush();
    for (let i = 0; i < 6 && a.s.me.down; i++) {
      c.s.uiAction({ type: 'wait' });
      b.s.uiAction({ type: 'wait' });
      await h.advance(40);
    }
    expect(a.s.me.down).toBeFalsy();
    expect(a.s.followed).toBeNull();
    expect(a.s.cameraState).toBe(a.s.state);
  });

  it('a reconnect rebuilds the view and the chat without repeating lines, bubbles or toasts', async () => {
    const { h, seats } = await started(['Ann', 'Bo']);
    const [a, b] = seats;
    const chat = new ChatModel({ self: a.c.seat, lines: a.c.chat });
    a.c.on((e) => {
      if (e.t === 'welcome') chat.merge(e.msg.chat);
      if (e.t === 'message' && e.msg.t === 'chat') chat.push(e.msg.line, h.sch.now());
    });
    b.c.say('hello');
    await h.advance(1100);
    b.c.say('on my way');
    await h.advance(10);
    expect(chat.lines.map((l) => l.text)).toEqual(['hello', 'on my way']);
    expect(chat.unread).toBe(2);
    const bubbles = chat.bubbles(h.sch.now()).length;
    // a dropped socket (entries caught up) and a lost replica (welcome snapshot)
    a.c.drop();
    await h.advance(60);
    expect(a.c.status).toBe('joined');
    a.c.state = null;
    a.c.drop();
    const outs = a.outs.length;
    await h.advance(60);
    expect(a.outs.slice(outs).some((o) => o.areaChanged)).toBe(true);
    expect(chat.lines.map((l) => l.text)).toEqual(['hello', 'on my way']);
    expect(chat.unread).toBe(2);
    expect(chat.bubbles(h.sch.now()).length).toBe(bubbles);
    expect(toasts(a)).toEqual([]);
    expect(a.s.state).toBe(perspective(a.c.state!, 'p1'));
    expect(hashState(a.c.state!)).toBe(hashState(h.room.state!));
    // still playing: an action goes through
    b.c.presence('menu');
    await h.flush();
    const p = posOf(a.s.replica, 'p1');
    const dir = (['e', 's', 'w', 'n'] as const).find((d) => {
      const v = { e: [1, 0], s: [0, 1], w: [-1, 0], n: [0, -1] }[d];
      return passability(a.s.replica)(p.x + v[0], p.y + v[1]) && !a.s.replica.area.actors.some((x) => x.pos.x === p.x + v[0] && x.pos.y === p.y + v[1]);
    })!;
    a.s.uiAction({ type: 'move', dir });
    await h.flush();
    expect(posOf(a.s.replica, 'p1')).not.toEqual(p);
  });
});
