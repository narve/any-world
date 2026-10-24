/**
 * Regression test for issues/M2-sell-column-dead-ui.md: the trade window must not show a Sell
 * column that can never be used. Since M3 the engine's traders buy (tag 'sell' options): the column
 * shows exactly when there is something they buy, and selling works.
 */
import { describe, it, expect } from 'vitest';
import type { GameState, Pos } from '../../src/engine/types';
import { GameSession } from '../../src/client/session';
import { tradeColumns } from '../../src/client/ui/format';
import { loadFixture, roomMap } from '../engine/helpers';

const western = loadFixture('fixture-western.json');

function session(): GameSession {
  return new GameSession({ world: western, worldId: 'fixture-test', seed: 1, map: roomMap(14, 10) });
}

function setup(s: GameSession, defId: string, me: Pos, them: Pos): string {
  const st = structuredClone(s.state) as GameState;
  st.area.actors = st.area.actors.filter((a) => a.id === st.player.actorId || a.defId === defId);
  st.area.actors.find((a) => a.id === st.player.actorId)!.pos = { ...me };
  const npc = st.area.actors.find((a) => a.defId === defId);
  if (!npc) throw new Error(`no ${defId} in area`);
  npc.pos = { ...them };
  st.player.currency = 95; // the unspent pile the playtest bot ended with
  s.state = st;
  s.act({ type: 'wait' });
  return npc.id;
}

describe('trade window columns', () => {
  it('hides the Sell column when the trader buys nothing', () => {
    expect(tradeColumns({ sellable: [] })).toEqual({ buy: true, sell: false });
  });

  it('shows the Sell column when there is something to sell', () => {
    const sellable = [{ slot: 0, price: 3, item: {} as never }];
    expect(tradeColumns({ sellable })).toEqual({ buy: true, sell: true });
  });

  it('a real trader opens a shop with offers, and a Sell column exactly when they buy something', () => {
    const s = session();
    const id = setup(s, 'widow-oquendo', { x: 5, y: 5 }, { x: 6, y: 5 });
    s.intent({ type: 'talk' });
    s.intent({ type: 'open_trade', npcId: id });
    const tv = s.viewModel().game!.trade!;
    expect(tv.offers.length).toBeGreaterThan(0);
    // the engine's trader buys (tag 'sell' options, M3): the column follows what is on offer
    expect(tradeColumns(tv).sell).toBe(tv.sellable.length > 0);
  });

  it('selling to a trader pays and keeps the shop open (engine sell offers)', () => {
    const s = session();
    const id = setup(s, 'widow-oquendo', { x: 5, y: 5 }, { x: 6, y: 5 });
    s.intent({ type: 'talk' });
    s.intent({ type: 'open_trade', npcId: id });
    const tv = s.viewModel().game!.trade!;
    if (!tv.sellable.length) return; // nothing this trader wants from the starting kit
    const offer = tv.sellable[0];
    const before = s.state.player.currency;
    const out = s.trade({ type: 'sell', slot: offer.slot });
    expect(out.changed).toBe(true);
    expect(s.state.player.currency).toBe(before + offer.price);
    expect(s.viewModel().game!.trade).not.toBeNull();
  });

  it('a stray sell intent is a harmless no-op with an explanation', () => {
    const s = session();
    const id = setup(s, 'widow-oquendo', { x: 5, y: 5 }, { x: 6, y: 5 });
    s.intent({ type: 'talk' });
    s.intent({ type: 'open_trade', npcId: id });
    const before = s.state;
    // a slot the trader made no offer for (an empty backpack slot)
    const out = s.trade({ type: 'sell', slot: 27 });
    expect(s.state).toBe(before);
    expect(out.toasts[0]?.tone).toBe('info');
    expect(s.viewModel().game!.trade).not.toBeNull();
  });
});
