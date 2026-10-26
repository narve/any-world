/**
 * MP1 B1: the party data model. A single player is a party of one (players / party / purse /
 * partyRules; knowledge, pending choice, fog, second chance and last harm per player); saves are
 * version 2 with run-length coded fog, and version-1 saves are refused.
 */
import { describe, it, expect } from 'vitest';
import { act, ctxFor, env, handBuiltPlayer, loadFixture, newGame, roomMap, testWorld } from './helpers';
import { applyGmActions, createGame, describeInventory, deserialize, hashState, leadPlayer, patchPlayer, playerIds, playerSheet, serialize, step } from '../../src/engine';
import { packSeen, unpackSeen } from '../../src/engine/serialize';
import { cloneState } from '../../src/engine/clone';
import { actorName, isPlayer, me, playerActorOf, playerName, playerOf, withPlayer } from '../../src/engine/ctx';
import { knowledgeOf, reveal } from '../../src/engine/knowledge';
import type { GameState } from '../../src/engine/types';

const ship = loadFixture('fixture-ship.json');

function twoPlayers(): GameState {
  const s = createGame(ship, { seed: 4, map: roomMap(14, 10) });
  handBuiltPlayer(s, { x: 3, y: 3 }, 'Bea');
  return s;
}

describe('a single player is a party of one', () => {
  it('createGame builds version 2 with one lead player and no run-wide player fields', () => {
    const s = createGame(ship, { seed: 1, map: roomMap(14, 10) });
    expect(s.version).toBe(2);
    expect(s.party).toEqual(['p1']);
    expect(playerIds(s)).toEqual(['p1']);
    const p = leadPlayer(s);
    expect(p.id).toBe('p1');
    expect(p.name).toBe(ship.player.name);
    expect(p.actorId).toBe('a1');
    expect(p.pendingChoice).toBeNull();
    expect(p.seen).toBeInstanceOf(Uint8Array);
    expect(p.seen.length).toBe(14 * 10);
    expect(Object.keys(p.knowledge).length).toBe(ship.items.length);
    expect(s.purse).toBe(ship.player.startCurrency ?? 0);
    expect(s.partyRules).toEqual({ exitCountdownTurns: 5 });
    for (const gone of ['player', 'knowledge', 'pendingChoice', 'mercyUsed', 'lastHarm']) expect(gone in s).toBe(false);
    expect('seen' in s.area).toBe(false);
  });

  it('NewGameOptions.exitCountdownTurns is kept in the state (at least 1 turn)', () => {
    expect(createGame(ship, { seed: 1, map: roomMap(), exitCountdownTurns: 8 }).partyRules.exitCountdownTurns).toBe(8);
    expect(createGame(ship, { seed: 1, map: roomMap(), exitCountdownTurns: 0 }).partyRules.exitCountdownTurns).toBe(1);
  });

  it('currency is the shared purse: GM currency and trades move it', () => {
    const w = testWorld();
    let s = newGame(w);
    const before = s.purse;
    s = applyGmActions(s, [{ type: 'currency', amount: 7 }], env(w)).state;
    expect(s.purse).toBe(before + 7);
  });

  it('the fog lives on the player and follows the area', () => {
    const w = testWorld();
    const s = newGame(w);
    const r = act(w, s, { type: 'wait' });
    expect(leadPlayer(r.state).seen.length).toBe(r.state.area.map.width * r.state.area.map.height);
    expect([...leadPlayer(r.state).seen].some((v) => v === 2)).toBe(true);
  });
});

describe('players and actors', () => {
  it('isPlayer / playerOf / actorName cover every party member', () => {
    const s = twoPlayers();
    const ctx = ctxFor(ship, s);
    const p2 = s.players.p2;
    const a2 = playerActorOf(ctx, 'p2')!;
    expect(a2.id).toBe(p2.actorId);
    expect(isPlayer(ctx, a2)).toBe(true);
    expect(playerOf(ctx, a2)).toBe(p2);
    expect(actorName(ctx, a2)).toBe('Bea');
    expect(playerName(ctx)).toBe(ship.player.name);
    expect(withPlayer(ctx, 'p2', () => me(ctx).name)).toBe('Bea');
    expect(ctx.pid).toBe('p1');
    const hostile = s.area.actors.find((a) => !isPlayer(ctx, a));
    if (hostile) expect(playerOf(ctx, hostile)).toBeUndefined();
  });

  it('appearances are shared, learning is personal', () => {
    const s = twoPlayers();
    const ctx = ctxFor(ship, s);
    const unknown = ship.items.find((d) => d.knowledge === 'unknown' && d.appearanceGroup)!;
    const a1 = knowledgeOf(ctx, unknown.id).appearance;
    const a2 = withPlayer(ctx, 'p2', () => knowledgeOf(ctx, unknown.id).appearance);
    expect(a1).toBeDefined();
    expect(a2).toEqual(a1);
    withPlayer(ctx, 'p2', () => reveal(ctx, unknown.id, 'clear', false));
    expect(s.players.p2.knowledge[unknown.id].level).toBe('clear');
    expect(s.players.p1.knowledge[unknown.id].level).toBe('unknown');
  });

  it('a GM rule hiding consumables hides them for every player, under one shared appearance', () => {
    const forget = { id: 'forgetful', name: 'Forgetful', description: 'Every draught looks alike.', playerTriggers: [], switches: { allConsumablesUnknown: true } };
    const w = testWorld((x) => {
      x.items.push({ ...x.items.find((i) => i.id === 'tonic')!, id: 'bread', name: 'Bread', appearanceGroup: 'flask', knowledge: 'clear' } as never);
      x.unknownAppearances!.flask.push({ label: 'blue flask', color: '#0000ff' });
    });
    const s0 = newGame(w);
    handBuiltPlayer(s0, { x: 4, y: 4 }, 'Bea');
    const s = applyGmActions(s0, [{ type: 'add_rule', rule: forget as never, reason: 'fog' }], env(w)).state;
    const k1 = s.players.p1.knowledge.bread;
    const k2 = s.players.p2.knowledge.bread;
    expect(k1.level).toBe('unknown');
    expect(k2.level).toBe('unknown');
    expect(k2.appearance).toEqual(k1.appearance);
    // the lead carries tonic: known to the whole party, so it stays known for everyone
    expect(s.players.p2.knowledge.tonic.level).toBe('clear');
    const back = applyGmActions(s, [{ type: 'remove_rule', id: 'forgetful', reason: 'clear' }], env(w)).state;
    expect(back.players.p1.knowledge.bread.level).toBe('clear');
    expect(back.players.p2.knowledge.bread.level).toBe('clear');
  });

  it('read queries answer for env.playerId (default: the lead)', () => {
    const s = twoPlayers();
    s.players.p2.xp = 3;
    const w = { world: ship };
    expect(playerSheet(s, w).xp).toBe(leadPlayer(s).xp);
    expect(playerSheet(s, { ...w, playerId: 'p2' }).xp).toBe(3);
    expect(describeInventory(s, { ...w, playerId: 'p2' }).every((v) => v === null)).toBe(true);
    expect(describeInventory(s, w).some((v) => v !== null)).toBe(true);
  });

  it('patchPlayer copies without touching the input', () => {
    const s = twoPlayers();
    const t = patchPlayer(s, { xp: 9 }, 'p2');
    expect(t.players.p2.xp).toBe(9);
    expect(s.players.p2.xp).toBe(0);
    expect(t.players.p1).toBe(s.players.p1);
  });

  it('step leaves a hand-built second player intact (single-player rules still act for the lead)', () => {
    const s = twoPlayers();
    const r = step(s, { type: 'wait' }, { world: ship });
    expect(r.state.party).toEqual(['p1', 'p2']);
    expect(r.state.area.actors.filter((a) => a.id === r.state.players.p2.actorId)).toHaveLength(1);
  });
});

describe('save, load, clone', () => {
  it('fog is run-length coded', () => {
    expect(packSeen(Uint8Array.from([0, 0, 0, 1, 1, 2]))).toBe('0x3,1x2,2x1');
    expect(packSeen([])).toBe('');
    expect([...unpackSeen('0x3,1x2,2x1', 6)]).toEqual([0, 0, 0, 1, 1, 2]);
    // short and over-long codes are clipped to the map
    expect([...unpackSeen('2x2', 4)]).toEqual([2, 2, 0, 0]);
    expect([...unpackSeen('1x10', 3)]).toEqual([1, 1, 1]);
    expect([...unpackSeen('junk,1x1', 2)]).toEqual([1, 0]);
  });

  it('a two-player state round-trips through serialize / deserialize', () => {
    const s = twoPlayers();
    s.players.p2.seen[5] = 2;
    s.players.p2.seen[6] = 1;
    s.players.p2.mercyUsed = true;
    const json = serialize(s);
    const doc = JSON.parse(json) as { state: { players: Record<string, { seen: unknown }> } };
    expect(typeof doc.state.players.p2.seen).toBe('string');
    const back = deserialize(ship, json);
    expect(back.party).toEqual(['p1', 'p2']);
    expect(back.players.p2.seen).toBeInstanceOf(Uint8Array);
    expect([...back.players.p2.seen]).toEqual([...s.players.p2.seen]);
    expect([...back.players.p1.seen]).toEqual([...s.players.p1.seen]);
    expect(back.players.p2.mercyUsed).toBe(true);
    expect(serialize(back)).toBe(json);
    expect(hashState(back)).toBe(hashState(s));
  });

  it('a large fogged map stays small in the save', () => {
    const s = createGame(ship, { seed: 2, map: roomMap(91, 65) });
    const doc = JSON.parse(serialize(s)) as { state: { players: Record<string, { seen: string }> } };
    expect(doc.state.players.p1.seen.length).toBeLessThan(2000);
  });

  it('version-1 saves are refused, as are saves without a party', () => {
    const s = twoPlayers();
    const doc = JSON.parse(serialize(s)) as { state: Record<string, unknown> };
    doc.state.version = 1;
    expect(() => deserialize(ship, JSON.stringify(doc))).toThrow('unsupported save version 1');
    doc.state.version = 2;
    doc.state.party = [];
    expect(() => deserialize(ship, JSON.stringify(doc))).toThrow('save is corrupt');
    doc.state.party = ['p9'];
    expect(() => deserialize(ship, JSON.stringify(doc))).toThrow('save is corrupt');
  });

  it('cloneState copies every player, fog as a typed array', () => {
    const s = twoPlayers();
    (s.players.p2 as { seen: number[] | Uint8Array }).seen = Array.from(s.players.p2.seen);
    const { state: c } = cloneState(s);
    expect(c.players.p2).not.toBe(s.players.p2);
    expect(c.players.p2.seen).toBeInstanceOf(Uint8Array);
    expect(c.players.p1.knowledge).not.toBe(s.players.p1.knowledge);
    c.players.p2.seen[0] = 2;
    expect(s.players.p2.seen[0]).toBe(0);
    expect(hashState(c)).not.toBe(hashState(s));
  });
});
