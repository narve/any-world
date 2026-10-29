/**
 * MP2 C2: the room log (src/net/log.ts). Applying entries with applyEntry gives exactly what the
 * direct engine calls give (state hash and events, entry by entry), also after the entries went
 * over the wire (JSON + LogEntrySchema) and from a snapshot in the middle (a restart replay); a
 * runParty-style loop written as entries ends on runParty's own hash. parseWorld is idempotent and
 * worldIdOf stable on every shipped world, so a client's worldId check never fires on a good world.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  addPlayer,
  applyGmActions,
  createGame,
  deserialize,
  hashState,
  leaveMap,
  readyPlayers,
  returnToMap,
  serialize,
  setAway,
  stepTurn,
  worldIdOf,
} from '../../src/engine';
import { FREE_ACTIONS } from '../../src/engine/party';
import { botByName, newMemory, type BotMemory } from '../../src/engine/sim/bots';
import { MAX_FREE_PER_TURN, runParty } from '../../src/engine/sim/party';
import { parseWorld, type WorldSpec } from '../../src/schema';
import type { GmAction } from '../../src/schema/gm';
import type { GameEvent, GameState, PlayerId, TurnInput, TurnResult } from '../../src/engine/types';
import { applyEntries, applyEntry, changedArea, type LogEntry, type LogEntryBody } from '../../src/net/log';
import { LogEntrySchema } from '../../src/net/protocol';

const WORLDS = 'content/worlds';

function loadWorld(file: string): WorldSpec {
  const r = parseWorld(JSON.parse(readFileSync(join(WORLDS, file), 'utf8')), { strictKeys: true });
  if (!r.ok) throw new Error(`${file}: ${r.errors.join('; ')}`);
  return r.world;
}

const western = loadWorld('fixture-western.json');

interface Recorded {
  start: GameState;
  entries: LogEntry[];
  /** hash and events after each entry, from the direct engine calls */
  after: { hash: string; events: GameEvent[] }[];
  final: GameState;
  /** state after each joint turn (runParty's onTurn) */
  turns: GameState[];
}

type Extra = (s: GameState, t: number) => { entry: LogEntryBody; apply: () => { state: GameState; events: GameEvent[] } } | null;

/**
 * Plays a party game the way runParty does (free actions alone, then one joint stepTurn with
 * advance), calling the engine directly and writing every call down as a log entry; `extra` adds
 * room entries (away, leave, join, gm…) between turns.
 */
function record(world: WorldSpec, seed: number, players: number, partyTurns: number, extra?: Extra): Recorded {
  const names = Array.from({ length: players }, (_, i) => `P${i + 1}`);
  let s = createGame(world, { seed, players: names.map((name) => ({ name })) });
  const start = s;
  const env = { world };
  const entries: LogEntry[] = [];
  const after: Recorded['after'] = [];
  const turns: GameState[] = [];
  const bot = botByName('explorer');
  const mems = new Map<PlayerId, BotMemory>(s.party.map((id, i) => [id, newMemory(i === 0 ? seed : seed * 31 + i)]));
  const push = (e: LogEntryBody, state: GameState, events: GameEvent[]) => {
    entries.push({ ...e, n: entries.length, run: 1 } as LogEntry);
    after.push({ hash: hashState(state), events });
    s = state;
  };
  const tally = (r: TurnResult) => {
    for (const o of r.outcomes) {
      const m = mems.get(o.playerId);
      if (!m) continue;
      m.lastAction = o.action;
      m.lastInvalid = o.ok ? null : (o.detail ?? 'refused');
      m.lastReason = o.ok ? null : (o.reason ?? null);
    }
  };
  for (let t = 0; t < partyTurns && s.status === 'playing'; t++) {
    const x = extra?.(s, t);
    if (x) {
      const r = x.apply();
      push(x.entry, r.state, r.events);
      for (const id of s.party) if (!mems.has(id)) mems.set(id, newMemory(seed * 31 + Number(id.slice(1))));
    }
    const ready = new Set(readyPlayers(s, env));
    const kept = new Map<PlayerId, TurnInput>();
    const decide = (pid: PlayerId) => {
      for (let n = 0; ; n++) {
        const ps = s.players[pid];
        if (!ps || ps.down || s.status !== 'playing') return;
        if (!ready.has(pid) && !ps.pendingChoice && !ps.pendingPerkChoice) return;
        const action = bot.decide(s, world, mems.get(pid)!, pid);
        if (FREE_ACTIONS.has(action.type)) {
          if (n >= MAX_FREE_PER_TURN) return;
          const inputs = [{ playerId: pid, actions: [action] }];
          const r = stepTurn(s, inputs, { ...env, advance: false });
          tally(r);
          push({ k: 'turn', inputs, advance: false }, r.state, r.events);
          continue;
        }
        if (ready.has(pid)) kept.set(pid, { playerId: pid, actions: [action] });
        return;
      }
    };
    for (const pid of [...s.party]) decide(pid);
    for (const pid of [...kept.keys()]) {
      const ps = s.players[pid];
      if (!ps.pendingChoice && !ps.pendingPerkChoice) continue;
      kept.delete(pid);
      decide(pid);
    }
    if (s.status !== 'playing') break;
    const inputs = s.party.filter((id) => kept.has(id)).map((id) => kept.get(id)!);
    const r = stepTurn(s, inputs, { ...env, advance: true });
    tally(r);
    push({ k: 'turn', inputs, advance: true }, r.state, r.events);
    turns.push(s);
  }
  return { start, entries, after, final: s, turns };
}

/** replays entries from `from`, checking the hash and events after each against the recording */
function replayChecked(world: WorldSpec, from: GameState, rec: Recorded, offset = 0): GameState {
  let s = from;
  for (let i = offset; i < rec.entries.length; i++) {
    const r = applyEntry(world, s, rec.entries[i]);
    expect(hashState(r.state), `entry ${i} (${rec.entries[i].k})`).toBe(rec.after[i].hash);
    expect(r.events).toEqual(rec.after[i].events);
    s = r.state;
  }
  return s;
}

/** the room entries a run gets besides turns: away and back, leave and return, a late join, the GM */
const roomExtras = (world: WorldSpec): Extra => (s, t) => {
  const env = { world };
  const give: GmAction[] = [{ type: 'narrate', text: 'The wind turns.' }, { type: 'give_item', item: world.items[0].id, count: 1 }];
  switch (t) {
    case 3:
      return { entry: { k: 'gm', hook: 'intro', actions: give }, apply: () => applyGmActions(s, give, env) };
    case 10:
      return { entry: { k: 'away', pid: 'p2' }, apply: () => setAway(s, 'p2', true, env) };
    case 25:
      return { entry: { k: 'back', pid: 'p2' }, apply: () => setAway(s, 'p2', false, env) };
    case 30:
      return { entry: { k: 'leave', pid: 'p3' }, apply: () => leaveMap(s, 'p3', env) };
    case 40: {
      const r = addPlayer(s, { name: 'Dee', near: 'p1' }, env);
      return { entry: { k: 'join', seat: 's4', name: 'Dee', pid: r.playerId, near: 'p1' }, apply: () => ({ state: r.state, events: [] }) };
    }
    case 55:
      return { entry: { k: 'return', pid: 'p3', near: 'p1' }, apply: () => returnToMap(s, 'p3', { near: 'p1' }, env) };
    default:
      return null;
  }
};

describe('applyEntry', () => {
  const rec = record(western, 7, 3, 90, roomExtras(western));

  it('replays a run with every entry kind exactly like the direct engine calls', () => {
    const kinds = new Set(rec.entries.map((e) => e.k));
    expect([...kinds].sort()).toEqual(['away', 'back', 'gm', 'join', 'leave', 'return', 'turn']);
    expect(rec.entries.some((e) => e.k === 'turn' && !e.advance)).toBe(true);
    expect(rec.final.party).toHaveLength(4);
    expect(rec.final.players.p3.left).toBeUndefined();
    const s = replayChecked(western, createGame(western, { seed: 7, players: ['P1', 'P2', 'P3'].map((name) => ({ name })) }), rec);
    expect(hashState(s)).toBe(hashState(rec.final));
  });

  it('entries survive the wire (JSON and LogEntrySchema) unchanged', () => {
    const wire = rec.entries.map((e) => LogEntrySchema.parse(JSON.parse(JSON.stringify(e))));
    expect(wire).toEqual(rec.entries);
    expect(hashState(applyEntries(western, rec.start, wire))).toBe(hashState(rec.final));
  });

  it('a snapshot in the middle plus the rest of the log ends on the same hash (restart replay)', () => {
    const cut = Math.floor(rec.entries.length / 2);
    const mid = applyEntries(western, rec.start, rec.entries.slice(0, cut));
    const loaded = deserialize(western, serialize(mid));
    expect(hashState(loaded)).toBe(hashState(mid));
    expect(hashState(replayChecked(western, loaded, rec, cut))).toBe(hashState(rec.final));
  });

  it('a runParty-style loop written as entries ends on runParty’s own states', () => {
    const plain = record(western, 11, 2, 60);
    const states: string[] = [];
    runParty(western, 11, ['explorer', 'explorer'], { onTurn: (i) => void states.push(hashState(i.state)), maxTurns: 10_000, invariants: false });
    expect(plain.turns.map(hashState)).toEqual(states.slice(0, plain.turns.length));
    expect(hashState(applyEntries(western, plain.start, plain.entries))).toBe(hashState(plain.final));
  });

  it('a join entry whose player id differs from the engine’s throws (a desync)', () => {
    const s = createGame(western, { seed: 1, players: [{ name: 'A' }, { name: 'B' }] });
    expect(() => applyEntry(western, s, { n: 0, run: 1, k: 'join', seat: 's3', name: 'C', pid: 'p9', near: 'p1' })).toThrow(/p3/);
    expect(applyEntry(western, s, { n: 0, run: 1, k: 'join', seat: 's3', name: 'C', pid: 'p3', near: 'p1' }).state.party).toEqual(['p1', 'p2', 'p3']);
  });

  it('no-op entries return the same state object (the room does not append them)', () => {
    const s = createGame(western, { seed: 1, players: [{ name: 'A' }, { name: 'B' }] });
    expect(applyEntry(western, s, { n: 0, run: 1, k: 'back', pid: 'p2' }).state).toBe(s);
    const solo = createGame(western, { seed: 1 });
    expect(applyEntry(western, solo, { n: 0, run: 1, k: 'away', pid: 'p1' }).state).toBe(solo);
    expect(applyEntry(western, s, { n: 0, run: 1, k: 'turn', inputs: [{ playerId: 'p1', actions: [{ type: 'unequip', slot: 27 }] }], advance: false }).state).toBe(s);
  });

  it('a gm entry with pid applies its actions to that player (MP4); absent or off the map, to the lead', () => {
    let s = createGame(western, { seed: 4 });
    s = addPlayer(s, { name: 'Bo' }, { world: western }).state;
    const [p1, p2] = s.party as [PlayerId, PlayerId];
    const item = western.items.find((i) => i.onUse)!.id;
    const give: GmAction[] = [{ type: 'give_item', item, count: 1 }];
    const count = (st: GameState, pid: PlayerId) => st.players[pid]!.slots.filter((x) => x?.defId === item).reduce((n, x) => n + (x?.count ?? 1), 0);
    const e = (pid?: PlayerId): LogEntry => LogEntrySchema.parse(JSON.parse(JSON.stringify({ n: 3, run: 1, k: 'gm', hook: 'idle', ...(pid ? { pid } : {}), actions: give })));
    const toP2 = applyEntry(western, s, e(p2)).state;
    expect([count(toP2, p1), count(toP2, p2)]).toEqual([count(s, p1), count(s, p2) + 1]);
    expect(hashState(toP2)).toBe(hashState(applyGmActions(s, give, { world: western, playerId: p2 }).state));
    const toLead = applyEntry(western, s, e()).state;
    expect([count(toLead, p1), count(toLead, p2)]).toEqual([count(s, p1) + 1, count(s, p2)]);
    // p2 left the map: the answer goes to the lead, the same on every replica
    const left = leaveMap(s, p2, { world: western }).state;
    expect(hashState(applyEntry(western, left, e(p2)).state)).toBe(hashState(applyEntry(western, left, e()).state));
  });

  it('changedArea compares the area index', () => {
    expect(changedArea(rec.start, rec.start)).toBe(false);
    expect(changedArea(rec.start, rec.final)).toBe(rec.start.area.index !== rec.final.area.index);
    expect(changedArea(rec.start, { ...rec.start, area: { ...rec.start.area, index: 1 } })).toBe(true);
  });
});

describe('worlds on the wire', () => {
  const files = readdirSync(WORLDS).filter((f) => f.endsWith('.json')).sort();

  it('ships 21 worlds', () => {
    expect(files).toHaveLength(21);
  });

  it.each(files)('%s: parseWorld is idempotent and worldIdOf stable', (file) => {
    const w1 = loadWorld(file);
    // what a client gets in `welcome` (the server's parsed world as JSON), parsed again
    const again = parseWorld(JSON.parse(JSON.stringify(w1)), { strictKeys: true });
    expect(again.ok, again.ok ? '' : again.errors.join('; ')).toBe(true);
    if (!again.ok) return;
    expect(again.world).toEqual(w1);
    expect(worldIdOf(again.world)).toBe(worldIdOf(w1));
    // a third round trip of a freshly parsed copy, not the cached object
    const w3 = parseWorld(JSON.parse(JSON.stringify(again.world))) as { ok: true; world: WorldSpec };
    expect(worldIdOf(w3.world)).toBe(worldIdOf(w1));
  });
});
