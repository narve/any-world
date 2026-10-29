/**
 * MP4 G1: recheckGmActions / recheckOfferOption moved to src/gm/recheck.ts with a `pid`: the
 * checks read the state from that player's perspective, as the engine applies a `gm` entry with
 * EngineEnv.playerId. Without a pid they answer for the lead, as before (the client re-exports them).
 */
import { describe, it, expect } from 'vitest';
import { addPlayer, applyGmActions, createGame } from '../../src/engine';
import type { GameState, PlayerId } from '../../src/engine/types';
import type { GmAction } from '../../src/schema/gm';
import { recheckGmActions, recheckOfferOption } from '../../src/gm/recheck';
import * as clientRecheck from '../../src/client/gm-recheck';
import { perspective } from '../../src/gm/perspective';
import * as clientPerspective from '../../src/client/room/perspective';
import { loadFixture, roomMap } from '../engine/helpers';

const world = loadFixture('fixture-western.json');
const lethal = (n: number) => ({ type: 'effect', target: 'player', effects: [{ type: 'resource', resource: 'hp', amount: { base: -n } }] }) as GmAction;
const coins = (n: number) => ({ type: 'currency', amount: n }) as GmAction;

function party(): { s: GameState; p1: PlayerId; p2: PlayerId } {
  let s = createGame(world, { seed: 2, map: roomMap(16, 12) });
  s = addPlayer(s, { name: 'Bo' }, { world }).state;
  const [p1, p2] = s.party as [PlayerId, PlayerId];
  return { s, p1, p2 };
}
const actorOf = (s: GameState, pid: PlayerId) => s.area.actors.find((a) => a.id === s.players[pid]!.actorId)!;

describe('src/gm/recheck with a pid', () => {
  it('the client paths re-export the moved modules', () => {
    expect(clientRecheck.recheckGmActions).toBe(recheckGmActions);
    expect(clientRecheck.recheckOfferOption).toBe(recheckOfferOption);
    expect(clientPerspective.perspective).toBe(perspective);
  });

  it('damage is checked against the hp of the player it is for', () => {
    const { s: s0, p1, p2 } = party();
    const s = structuredClone(s0);
    actorOf(s, p2).hp = 3;
    const acts = [lethal(5), coins(4)];
    // for the lead (full hp) it is safe; for p2 (hp 3) it would knock them out
    expect(recheckGmActions(world, s, acts).actions).toEqual(acts);
    expect(recheckGmActions(world, s, acts, p1).actions).toEqual(acts);
    const r = recheckGmActions(world, s, acts, p2);
    expect(r.actions).toEqual([coins(4)]);
    expect(r.dropped.map((d) => d.type)).toEqual(['effect']);
    // and the engine applies a kept action to that player
    const applied = applyGmActions(s, [lethal(2)], { world, playerId: p2 });
    expect(actorOf(applied.state, p2).hp).toBe(1);
    expect(actorOf(applied.state, p1).hp).toBe(actorOf(s, p1).hp);
  });

  it('an offer option of a member is rechecked from that member\'s view; party order is kept', () => {
    const { s: s0, p1, p2 } = party();
    const s = structuredClone(s0);
    actorOf(s, p2).hp = 2;
    s.players[p2]!.pendingChoice = { kind: 'gm_offer', prompt: 'A deal?', options: [{ label: 'Take', actions: [lethal(3), coins(5)] }, { label: 'No', actions: [] }] };
    const r = recheckOfferOption(world, s, 0, p2);
    expect(r.dropped.map((d) => d.type)).toEqual(['effect']);
    expect(r.state.party).toEqual([p1, p2]);
    const pc = r.state.players[p2]!.pendingChoice;
    expect(pc?.kind === 'gm_offer' && pc.options[0]!.actions).toEqual([coins(5)]);
    // the lead has no open offer: nothing to do
    expect(recheckOfferOption(world, s, 0).state).toBe(s);
    expect(recheckOfferOption(world, s, 0, p1).state).toBe(s);
  });
});
