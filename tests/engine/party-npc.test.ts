/**
 * MP1 B2a: dialogues in a party. The world keeps moving while a player's choice is open, so a
 * choice whose speaker died, left talking range or turned hostile closes (log.party.talk_gone)
 * instead of applying; one dialogue per NPC at a time; the shared purse is checked at each choice
 * in resolution order.
 */
import { describe, it, expect } from 'vitest';
import { addActor, env, roomMap, simpleGenerator, testWorld } from './helpers';
import { createGame, legalActions, stepTurn } from '../../src/engine';
import type { GameState, PlayerAction, PlayerId } from '../../src/engine/types';
import type { WorldSpec } from '../../src/schema/world';

const model = { archetype: 'blob', colors: { primary: '#888888' } } as const;
const w = testWorld((x) => {
  x.actors.push({
    id: 'merchant',
    name: 'Merchant',
    description: 'sells',
    faction: 'friendly',
    stats: { hp: 10 },
    behaviour: { type: 'idle' },
    xp: 0,
    npc: { role: 'trader', personality: 'brisk', greeting: 'Buying?', lines: [], stock: ['tonic'] },
    model,
  } as never);
});

function party(world: WorldSpec = w): GameState {
  return createGame(world, { seed: 3, map: roomMap(12, 10), mapGenerator: simpleGenerator, players: [{ name: 'Ann' }, { name: 'Bea' }] });
}
const turn = (s: GameState, inputs: Parameters<typeof stepTurn>[1], advance = false) => stepTurn(s, inputs, { ...env(w), advance });
const act = (pid: PlayerId, ...actions: PlayerAction[]) => ({ playerId: pid, actions });
const talked = (s: GameState) => s.log.filter((l) => l.key === 'log.party.talk_gone').map((l) => l.params?.player);

/** p1 at (1,1), p2 next to it; the sage two steps from p1 */
function withSage(): { s: GameState; sage: string } {
  const s = party();
  const sage = addActor(w, s, 'sage', { x: 3, y: 2 }).id;
  const r = turn(s, [act('p1', { type: 'talk', targetId: sage })]);
  expect(r.state.players.p1.pendingChoice?.speakerId).toBe(sage);
  return { s: r.state, sage };
}

describe('a dialogue whose speaker is gone closes', () => {
  it('the speaker dies while the world moves: closed at the end of the round', () => {
    const { s, sage } = withSage();
    s.area.actors = s.area.actors.filter((a) => a.id !== sage);
    const r = turn(s, [act('p2', { type: 'wait' })]);
    expect(r.state.players.p1.pendingChoice).toBeNull();
    expect(talked(r.state)).toEqual(['Ann']);
  });

  it('the speaker walks out of talking range', () => {
    const { s, sage } = withSage();
    s.area.actors.find((a) => a.id === sage)!.pos = { x: 9, y: 7 };
    const r = turn(s, [act('p2', { type: 'wait' })]);
    expect(r.state.players.p1.pendingChoice).toBeNull();
  });

  it('the speaker turned hostile: choosing closes the dialogue and applies nothing', () => {
    const { s, sage } = withSage();
    const p1 = s.area.actors.find((a) => a.id === s.players.p1.actorId)!;
    p1.hp = 5;
    s.area.actors.find((a) => a.id === sage)!.faction = 'hostile';
    const r = turn(s, [act('p1', { type: 'choose_option', index: 0 })]);
    expect(r.outcomes[0].ok).toBe(true);
    expect(r.state.players.p1.pendingChoice).toBeNull();
    expect(r.state.area.actors.find((a) => a.id === s.players.p1.actorId)!.hp).toBe(5);
    expect(talked(r.state)).toEqual(['Ann']);
  });

  it('a closed GM offer gives back the budget reserved for it', () => {
    const s = party();
    const sage = addActor(w, s, 'sage', { x: 3, y: 2 });
    s.players.p1.pendingChoice = { kind: 'gm_offer', prompt: 'Deal?', speakerId: sage.id, options: [{ label: 'Yes', actions: [] }], reservedBudget: 3 };
    const budget = s.area.gmBudget;
    s.area.actors = s.area.actors.filter((a) => a !== sage);
    const r = turn(s, [act('p2', { type: 'wait' })]);
    expect(r.state.players.p1.pendingChoice).toBeNull();
    expect(r.state.area.gmBudget).toBe(budget + 3);
  });

  it('the speaker still there: the dialogue stays open while the others play', () => {
    const { s } = withSage();
    const r = turn(s, [act('p2', { type: 'wait' })]);
    expect(r.state.turn).toBe(s.turn + 1);
    expect(r.state.players.p1.pendingChoice).not.toBeNull();
  });
});

describe('one dialogue per NPC', () => {
  it('a second player cannot talk to an NPC another player is talking with', () => {
    const { s, sage } = withSage();
    expect(legalActions(s, { ...env(w), playerId: 'p2' })).not.toContainEqual({ type: 'talk', targetId: sage });
    const r = turn(s, [act('p2', { type: 'talk', targetId: sage })]);
    expect(r.outcomes[0]).toMatchObject({ ok: false, reason: 'illegal' });
    expect(r.state.players.p2.pendingChoice).toBeNull();
  });

  it('two players talking to one NPC in the same turn: the second is contested', () => {
    const s = party();
    const sage = addActor(w, s, 'sage', { x: 3, y: 2 }).id;
    const r = turn(s, [act('p1', { type: 'talk', targetId: sage }), act('p2', { type: 'talk', targetId: sage })]);
    expect(r.outcomes[0].ok).toBe(true);
    expect(r.outcomes[1]).toMatchObject({ ok: false, reason: 'contested' });
  });
});

describe('the shared purse', () => {
  it('two trades in one turn are checked against the purse in resolution order', () => {
    let s = party();
    const m1 = addActor(w, s, 'merchant', { x: 3, y: 2 }).id;
    const m2 = addActor(w, s, 'merchant', { x: 1, y: 3 }).id;
    s = turn(s, [act('p1', { type: 'talk', targetId: m1 }), act('p2', { type: 'talk', targetId: m2 })]).state;
    expect(s.players.p1.pendingChoice?.options[0].tag).toBe('buy');
    s.purse = 15; // one tonic (10)
    const tonics = (st: GameState, pid: PlayerId) => st.players[pid].slots.reduce((n, it) => n + (it?.defId === 'tonic' ? it.count : 0), 0);
    const r = turn(s, [act('p2', { type: 'choose_option', index: 0 }), act('p1', { type: 'choose_option', index: 0 })]);
    expect(r.outcomes[0].ok).toBe(true);
    expect(r.outcomes[1]).toMatchObject({ ok: false, reason: 'stale' });
    expect(r.state.purse).toBe(5);
    expect(tonics(r.state, 'p2')).toBe(tonics(s, 'p2') + 1);
    expect(tonics(r.state, 'p1')).toBe(tonics(s, 'p1'));
    expect(r.state.players.p1.pendingChoice).not.toBeNull();
  });
});
