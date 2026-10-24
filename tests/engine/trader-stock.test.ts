/**
 * Traders offer their whole stock (issues/M2-trader-stock-cut.md): the dialogue used to list only
 * the first 4 of up to 8 stock entries, so most authored gear in every fixture was unbuyable.
 */
import { describe, it, expect } from 'vitest';
import { act, addActor, loadFixture, newGame, player } from './helpers';

const FIXTURES = ['fixture-western.json', 'fixture-ship.json', 'fixture-teen.json', 'fixture-dream.json'];

describe('trader dialogue lists the whole stock', () => {
  for (const file of FIXTURES) {
    const w = loadFixture(file);
    const traders = w.actors.filter((a) => a.npc?.role === 'trader' && a.npc.stock.length > 0);
    for (const def of traders) {
      it(`${file}: every stock item of ${def.id} is a buy option`, () => {
        const s = newGame(w, 1);
        const p = player(s);
        const npc = addActor(w, s, def.id, { x: p.pos.x + 1, y: p.pos.y }, { faction: 'friendly' });
        const st = act(w, s, { type: 'talk', targetId: npc.id }).state;
        const buys = st.pendingChoice!.options.filter((o) => o.tag === 'buy');
        const offered = buys.map((o) => o.actions.find((x) => x.type === 'give_item')).map((x) => (x as { item: string }).item);
        const expected = def.npc!.stock.filter((id) => w.items.some((it) => it.id === id));
        expect(offered).toEqual(expected);
        // goodbye is always there to leave
        expect(st.pendingChoice!.options.at(-1)!.label).toBe('Goodbye');
      });
    }
  }

  it('the fixtures between them have traders with more than 4 items (the case that was cut)', () => {
    const big = FIXTURES.flatMap((f) => loadFixture(f).actors).filter((a) => a.npc?.role === 'trader' && a.npc.stock.length > 4);
    expect(big.length).toBeGreaterThan(0);
  });
});
