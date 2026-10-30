import { describe, it, expect } from 'vitest';
import { testWorld, newGame, ctxFor, player, addActor, act, roomMap } from './helpers';
import { addInstance, giveItem, makeItem, countItem } from '../../src/engine/inventory';
import { initKnowledge, describeObservations } from '../../src/engine/knowledge';
import { createRng } from '../../src/engine/rng';
import { getStat } from '../../src/engine/stats';
import { describeItem, leadPlayer } from '../../src/engine';
import { TOTAL_SLOTS, QUICK_SLOTS } from '../../src/engine/types';
import type { GameState } from '../../src/engine/types';

function setup(patch?: Parameters<typeof testWorld>[0]) {
  const w = testWorld(patch);
  const s = newGame(w);
  return { w, s, ctx: ctxFor(w, s), p: player(s) };
}
const slotOf = (s: GameState, defId: string) => leadPlayer(s).slots.findIndex((x) => x?.defId === defId);

describe('inventory', () => {
  it('starting items: equipped weapon, stacked consumables in quick slots', () => {
    const { s } = setup();
    expect(leadPlayer(s).slots).toHaveLength(TOTAL_SLOTS);
    expect(leadPlayer(s).slots[0]).toMatchObject({ defId: 'stick', count: 1 });
    expect(leadPlayer(s).slots[1]).toMatchObject({ defId: 'tonic', count: 2 });
    expect(leadPlayer(s).equipped).toEqual({ weapon: 0, armour: null, trinket: null });
  });

  it('pickup goes to the first free quick slot, then the backpack; stacks; full inventory refuses', () => {
    const { w, s, ctx, p } = setup();
    // floor items under the player
    const drop = (defId: string, n = 1) => s.area.items.push({ item: makeItem(ctx, defId, n)!, pos: { ...p.pos } });
    drop('coat');
    let st = act(w, s, { type: 'pickup' }).state;
    expect(leadPlayer(st).slots[2]?.defId).toBe('coat');
    // fill all quick slots
    const c2 = ctxFor(w, st);
    for (let i = 3; i < QUICK_SLOTS; i++) addInstance(c2, makeItem(c2, 'key')!);
    st.area.items.push({ item: makeItem(c2, 'ring')!, pos: { ...player(st).pos } });
    st = act(w, st, { type: 'pickup' }).state;
    expect(leadPlayer(st).slots[QUICK_SLOTS]?.defId).toBe('ring');
    // stacking into the existing tonic stack
    const c3 = ctxFor(w, st);
    st.area.items.push({ item: makeItem(c3, 'tonic', 3)!, pos: { ...player(st).pos } });
    st = act(w, st, { type: 'pickup' }).state;
    expect(leadPlayer(st).slots[1]).toMatchObject({ defId: 'tonic', count: 5 });
    // fill everything, then pickup fails
    const c4 = ctxFor(w, st);
    for (let i = 0; i < TOTAL_SLOTS; i++) addInstance(c4, makeItem(c4, 'key')!);
    expect(leadPlayer(st).slots.every((x) => x)).toBe(true);
    st.area.items.push({ item: makeItem(c4, 'coat')!, pos: { ...player(st).pos } });
    expect(act(w, st, { type: 'pickup' }).events[0]).toMatchObject({ type: 'invalid', reason: 'no room to carry that' });
    expect(act(w, st, { type: 'pickup' }).state).toBe(st);
    // giveItem overflows to the floor
    const before = st.area.items.length;
    giveItem(c4, 'wand', 1);
    expect(st.area.items.length).toBe(before + 1);
    expect(act(w, newGame(w), { type: 'pickup' }).events[0]).toMatchObject({ type: 'invalid' });
  });

  it('consumed: count decreases, last one empties the slot', () => {
    const { w, s, p } = setup();
    p.hp = 10;
    let st = act(w, s, { type: 'use', slot: 1 }).state;
    expect(player(st).hp).toBe(16);
    expect(leadPlayer(st).slots[1]?.count).toBe(1);
    st = act(w, st, { type: 'use', slot: 1 }).state;
    expect(leadPlayer(st).slots[1]).toBeNull();
    expect(st.stats.itemsUsed).toBe(2);
    expect(act(w, st, { type: 'use', slot: 1 }).events[0]).toMatchObject({ type: 'invalid', reason: 'that slot is empty' });
  });

  it('charges: run out and the item turns inert', () => {
    const { w, s, ctx } = setup();
    giveItem(ctx, 'wand', 1);
    addActor(w, s, 'rat', { x: 4, y: 4 }, { hp: 99, maxHp: 99 });
    const slot = slotOf(s, 'wand');
    let st = act(w, s, { type: 'use', slot, target: { x: 4, y: 4 } }).state;
    expect(leadPlayer(st).slots[slot]?.charges).toBe(1);
    const rat = st.area.actors.find((a) => a.defId === 'rat')!;
    st = act(w, st, { type: 'use', slot, target: { ...rat.pos } }).state;
    expect(leadPlayer(st).slots[slot]?.charges).toBe(0);
    expect(act(w, st, { type: 'use', slot, target: { ...rat.pos } }).events[0]).toMatchObject({ type: 'invalid', reason: 'no charges left' });
    expect(describeItem(st, leadPlayer(st).slots[slot]!.id, { world: w }).usable).toBe(false);
  });

  it('reusable: pays its cost and respects the cooldown', () => {
    const { w, s, ctx } = setup();
    giveItem(ctx, 'spark', 1);
    addActor(w, s, 'golem', { x: 5, y: 1 });
    const slot = slotOf(s, 'spark');
    let st = act(w, s, { type: 'use', slot }).state;
    expect(player(st).mp).toBe(7);
    // cooldown 2 = blocked for the next 2 turns
    expect(leadPlayer(st).slots[slot]).toMatchObject({ defId: 'spark', cooldown: 2 });
    expect(act(w, st, { type: 'use', slot }).events[0]).toMatchObject({ type: 'invalid' });
    st = act(w, st, { type: 'wait' }).state;
    expect(act(w, st, { type: 'use', slot }).events[0]).toMatchObject({ type: 'invalid' });
    st = act(w, st, { type: 'wait' }).state;
    st = act(w, st, { type: 'use', slot }).state;
    expect(player(st).mp).toBe(4);
    player(st).mp = 1;
    st = act(w, st, { type: 'wait' }).state;
    st = act(w, st, { type: 'wait' }).state;
    expect(act(w, st, { type: 'use', slot }).events[0]).toMatchObject({ type: 'invalid', reason: 'not enough Focus' });
  });

  it('aimed items need a valid target', () => {
    const { w, s, ctx } = setup();
    giveItem(ctx, 'wand', 1);
    const slot = slotOf(s, 'wand');
    expect(act(w, s, { type: 'use', slot }).events[0]).toMatchObject({ type: 'invalid', reason: 'no target in range' });
    expect(act(w, s, { type: 'use', slot, target: { x: 99, y: 99 } }).events[0]).toMatchObject({ type: 'invalid' });
  });

  it('passive: using a weapon equips it; requirements are checked', () => {
    const { w, s, ctx, p } = setup();
    giveItem(ctx, 'bow', 1);
    giveItem(ctx, 'key', 1);
    const bow = slotOf(s, 'bow');
    expect(act(w, s, { type: 'use', slot: bow }).events[0]).toMatchObject({ type: 'invalid', reason: 'requires Grace 14' });
    p.base.dex = 14;
    const st = act(w, s, { type: 'use', slot: bow }).state;
    expect(leadPlayer(st).equipped.weapon).toBe(bow);
    expect(leadPlayer(st).slots[bow]?.defId).toBe('bow'); // stays in its slot
    expect(act(w, st, { type: 'use', slot: bow }).events[0]).toMatchObject({ type: 'invalid', reason: 'already equipped' });
    expect(act(w, st, { type: 'use', slot: slotOf(st, 'key') }).events[0]).toMatchObject({ type: 'invalid', reason: 'nothing happens when you use that' });
  });

  it('equip/unequip armour and trinkets (modifiers + on_equip trigger)', () => {
    const { w, s, ctx } = setup();
    giveItem(ctx, 'coat', 1);
    giveItem(ctx, 'ring', 1);
    let st = act(w, s, { type: 'equip', slot: slotOf(s, 'coat') }).state;
    st = act(w, st, { type: 'equip', slot: slotOf(st, 'ring') }).state;
    expect(leadPlayer(st).equipped.armour).toBe(slotOf(st, 'coat'));
    expect(st.flags['ring-on']).toBe(true);
    const c = ctxFor(w, st);
    expect(getStat(c, player(st), 'ac')).toBe(12);
    expect(getStat(c, player(st), 'dex')).toBe(14);
    st = act(w, st, { type: 'unequip', slot: slotOf(st, 'coat') }).state;
    expect(leadPlayer(st).equipped.armour).toBeNull();
    expect(getStat(ctxFor(w, st), player(st), 'ac')).toBe(10);
    expect(act(w, st, { type: 'unequip', slot: slotOf(st, 'coat') }).events[0]).toMatchObject({ type: 'invalid', reason: 'not equipped' });
    expect(act(w, st, { type: 'equip', slot: slotOf(st, 'tonic') }).events[0]).toMatchObject({ type: 'invalid' });
  });

  it('move_item swaps slots and keeps equipment tracking; stacks merge', () => {
    const { w, s, ctx } = setup();
    let st = act(w, s, { type: 'move_item', from: 0, to: 20 }).state;
    expect(leadPlayer(st).slots[20]?.defId).toBe('stick');
    expect(leadPlayer(st).equipped.weapon).toBe(20);
    st = act(w, st, { type: 'move_item', from: 1, to: 20 }).state;
    expect(leadPlayer(st).slots[1]?.defId).toBe('stick');
    expect(leadPlayer(st).slots[20]?.defId).toBe('tonic');
    expect(leadPlayer(st).equipped.weapon).toBe(1);
    const c = ctxFor(w, st);
    leadPlayer(st).slots[5] = makeItem(c, 'tonic', 4);
    st = act(w, st, { type: 'move_item', from: 5, to: 20 }).state;
    expect(leadPlayer(st).slots[20]?.count).toBe(6);
    expect(leadPlayer(st).slots[5]).toBeNull();
    for (const bad of [{ from: 0, to: 0 }, { from: -1, to: 3 }, { from: 3, to: 28 }, { from: 7, to: 3 }]) {
      expect(act(w, st, { type: 'move_item', ...bad }).events[0]).toMatchObject({ type: 'invalid' });
    }
    void ctx;
  });

  it('drop puts the stack on the floor and unequips', () => {
    const { w, s, p } = setup();
    const st = act(w, s, { type: 'drop', slot: 0 }).state;
    expect(leadPlayer(st).slots[0]).toBeNull();
    expect(leadPlayer(st).equipped.weapon).toBeNull();
    expect(st.area.items).toEqual([{ item: expect.objectContaining({ defId: 'stick' }), pos: p.pos }]);
    const back = act(w, st, { type: 'pickup' }).state;
    expect(leadPlayer(back).slots[0]?.defId).toBe('stick');
    expect(countItem(leadPlayer(back), 'stick')).toBe(1);
  });
});

describe('knowledge', () => {
  it('unknown items get distinct per-run appearances from their pool', () => {
    const w = testWorld();
    const seen = new Set<string>();
    for (let seed = 1; seed <= 10; seed++) {
      const k = initKnowledge(w, createRng(seed));
      expect(k.murk.level).toBe('unknown');
      expect(k.murk.appearance!.label).not.toBe(k.fog.appearance!.label);
      seen.add(k.murk.appearance!.label);
      expect(initKnowledge(w, createRng(seed)).murk.appearance).toEqual(k.murk.appearance);
      expect(k.tonic.level).toBe('clear');
      expect(k.tonic.appearance).toBeUndefined();
    }
    expect(seen.size).toBe(2);
  });

  it('allConsumablesUnknown makes clear consumables unknown with a fallback appearance', () => {
    const w = testWorld((x) => {
      x.rules = [{ id: 'r', name: 'R', description: 'd', switches: { allConsumablesUnknown: true } }];
    });
    const k = initKnowledge(w, createRng(1));
    expect(k.tonic.level).toBe('unknown');
    expect(k.tonic.appearance!.label).toBe('unfamiliar flask');
    expect(k.stick.level).toBe('clear');
  });

  it('using an unknown item reveals it (full) and notes exact numbers', () => {
    const { w, s, ctx, p } = setup();
    giveItem(ctx, 'murk', 1);
    const slot = slotOf(s, 'murk');
    const id = leadPlayer(s).slots[slot]!.id;
    const before = describeItem(s, id, { world: w });
    expect(before.knowledge).toBe('unknown');
    expect(before.name).toBe(leadPlayer(s).knowledge.murk.appearance!.label.replace(/^./, (c) => c.toUpperCase()));
    expect(before.effectLines).toEqual([]);
    expect(before.description).not.toContain('secretly');
    p.hp = 10;
    const r = act(w, s, { type: 'use', slot });
    const k = leadPlayer(r.state).knowledge.murk;
    expect(k.level).toBe('clear');
    expect(k.timesUsed).toBe(1);
    expect(k.notes).toEqual(['You felt better (+6 Health).']);
    expect(r.events.some((e) => e.type === 'item_identified' && e.defId === 'murk' && e.level === 'clear')).toBe(true);
  });

  it('revealOnUse vague → vague text, notes without numbers; clear shows effect lines', () => {
    const { w, s, ctx } = setup();
    giveItem(ctx, 'fog', 2);
    const slot = slotOf(s, 'fog');
    const st = act(w, s, { type: 'use', slot }).state;
    const k = leadPlayer(st).knowledge.fog;
    expect(k.level).toBe('vague');
    expect(k.notes).toEqual(['You became Burning.']);
    const view = describeItem(st, leadPlayer(st).slots[slot]!.id, { world: w });
    expect(view).toMatchObject({ name: 'Fog Draught', knowledge: 'vague', vagueText: 'Warm going down.', effectLines: [] });
    const tonic = describeItem(st, leadPlayer(st).slots[1]!.id, { world: w });
    expect(tonic.effectLines).toEqual(['Restores 6 Health']);
  });

  it('revealOnUse none keeps the item obscure', () => {
    const w = testWorld((x) => {
      x.items.find((i) => i.id === 'murk')!.revealOnUse = 'none';
    });
    const s = newGame(w);
    giveItem(ctxFor(w, s), 'murk', 1);
    player(s).hp = 10;
    const st = act(w, s, { type: 'use', slot: slotOf(s, 'murk') }).state;
    expect(leadPlayer(st).knowledge.murk.level).toBe('unknown');
    expect(leadPlayer(st).knowledge.murk.notes).toEqual(['You felt better.']);
  });

  it('describeObservations summarises outcomes', () => {
    const { ctx } = setup();
    expect(describeObservations(ctx, [], true)).toBe('Nothing obvious happened.');
    expect(describeObservations(ctx, [{ kind: 'hurt', self: false, amount: 4, who: 'Rat' }], true)).toBe('It hurt Rat (-4).');
    expect(describeObservations(ctx, [{ kind: 'resource', self: true, amount: 5, label: 'oil' }], false)).toBe('Your Oil rose.');
  });

  it('describeItem shows effect lines for clear items', () => {
    const { w, s, ctx } = setup();
    giveItem(ctx, 'spark', 1);
    giveItem(ctx, 'wand', 1);
    const spark = describeItem(s, leadPlayer(s).slots[slotOf(s, 'spark')]!.id, { world: w });
    expect(spark.effectLines).toEqual(['Deals 3 fire damage', 'Target: line, range 5', 'Costs 3 Focus', 'Cooldown 2 turns']);
    const stick = describeItem(s, leadPlayer(s).slots[0]!.id, { world: w });
    expect(stick.equipped).toBe(true);
    expect(stick.effectLines[0]).toBe('Attack: 1d4+2 blunt (Might)');
    const wand = describeItem(s, leadPlayer(s).slots[slotOf(s, 'wand')]!.id, { world: w });
    expect(wand.charges).toBe(2);
    expect(() => describeItem(s, 'nope', { world: w })).toThrow();
  });
});

describe('terrain interaction', () => {
  it('interact runs the terrain action once per tile', () => {
    const w = testWorld();
    const map = roomMap();
    map.tiles[1 * map.width + 2] = { kind: 'floor', terrain: 'chest' };
    const s = newGame(w, 1, map);
    const st = act(w, s, { type: 'interact', pos: { x: 2, y: 1 } }).state;
    expect(st.area.items.map((i) => i.item.defId)).toEqual(['tonic']);
    expect(act(w, st, { type: 'interact', pos: { x: 2, y: 1 } }).events[0]).toMatchObject({ type: 'invalid' });
    expect(act(w, s, { type: 'interact', pos: { x: 5, y: 5 } }).events[0]).toMatchObject({ type: 'invalid', reason: 'too far away' });
  });
});
