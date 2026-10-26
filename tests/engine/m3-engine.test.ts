/**
 * M3 engine work: the trader sell path, loss lines that name the status/terrain, attacks on
 * non-hostiles the goal needs defeated, the GM's allConsumablesUnknown rule mid-run, and the
 * copy-on-write state clone (purity under tile changes, speed).
 */
import { describe, it, expect } from 'vitest';
import { testWorld, testWorldInput, newGame, addActor, player, act, env, loadFixture, roomMap } from './helpers';
import { applyGmActions, legalActions, serialize, step, createGame, sellPrice, leadPlayer } from '../../src/engine';
import { parseWorld, type WorldSpecInput } from '../../src/schema';
import type { GameState, PlayerAction } from '../../src/engine/types';
import { botByName, newMemory } from '../../src/engine/sim/bots';
import { createRng } from '../../src/engine/rng';

const model = { archetype: 'blob', colors: { primary: '#888888' } } as const;

function withTrader(patch?: (x: WorldSpecInput) => void) {
  return testWorld((x) => {
    x.actors.push({
      id: 'merchant',
      name: 'Merchant',
      description: 'sells',
      faction: 'friendly',
      stats: { hp: 10 },
      behaviour: { type: 'idle' },
      xp: 0,
      npc: { role: 'trader', personality: 'shrewd', greeting: 'Buying or selling?', lines: ['Fine wares.'], stock: ['coat'] },
      model,
    } as never);
    patch?.(x);
  });
}

function talkTo(w: ReturnType<typeof testWorld>, s: GameState, id: string): GameState {
  const r = act(w, s, { type: 'talk', targetId: id });
  expect(r.events.some((e) => e.type === 'invalid')).toBe(false);
  return r.state;
}

describe('trader sell path', () => {
  it('a trader buys carried, unequipped items at half value (one unit), as tagged dialogue options', () => {
    const w = withTrader();
    let s = newGame(w);
    const m = addActor(w, s, 'merchant', { x: 2, y: 1 });
    s = talkTo(w, s, m.id);
    const pc = leadPlayer(s).pendingChoice!;
    const sells = pc.options.filter((o) => o.tag === 'sell');
    // the stick is equipped (not offered); the tonic stack is
    expect(sells.map((o) => o.sell!.defId)).toEqual(['tonic']);
    const tonicValue = w.items.find((i) => i.id === 'tonic')!.value;
    expect(sells[0].actions).toEqual([{ type: 'currency', amount: sellPrice(tonicValue) }]);
    expect(sells[0].label).toBe(`Tonic (+${sellPrice(tonicValue)} coins)`);
    // buy options come first, "goodbye" stays last
    expect(pc.options[0].tag).toBe('buy');
    expect(pc.options[pc.options.length - 1].label).toBe('Goodbye');
    const idx = pc.options.indexOf(sells[0]);
    const before = s.purse;
    const r = act(w, s, { type: 'choose_option', index: idx });
    expect(r.tookTurn).toBe(false);
    s = r.state;
    expect(leadPlayer(s).pendingChoice).toBeNull();
    expect(s.purse).toBe(before + sellPrice(tonicValue));
    expect(leadPlayer(s).slots.find((it) => it?.defId === 'tonic')!.count).toBe(1);
    const line = s.log[s.log.length - 1];
    expect(line.key).toBe('log.trade.sold');
    expect(line.text).toBe(`Tess sells Tonic for ${sellPrice(tonicValue)} coins.`);
    // legalActions lists the sell options too (bots / UI)
    s = talkTo(w, s, m.id);
    const listed = legalActions(s, env(w)).flatMap((a) => (a.type === 'choose_option' ? [a.index] : []));
    leadPlayer(s).pendingChoice!.options.forEach((o, i) => {
      if (o.tag === 'sell') expect(listed).toContain(i);
    });
  });

  it('never buys keys, progress items or worthless items, and unknown items keep their appearance name', () => {
    const w = withTrader((x) => {
      x.areas[0].transitionRequires = { type: 'all', of: [{ type: 'has_item', who: 'player', item: 'key' }, { type: 'has_item', who: 'player', item: 'ring' }] };
      x.items.find((i) => i.id === 'coat')!.value = 0;
      x.player.startingItems.push({ item: 'key' }, { item: 'ring' }, { item: 'coat' }, { item: 'murk' }, { item: 'wand' });
    });
    let s = newGame(w);
    const m = addActor(w, s, 'merchant', { x: 2, y: 1 });
    s = talkTo(w, s, m.id);
    const sells = leadPlayer(s).pendingChoice!.options.filter((o) => o.tag === 'sell');
    expect(sells.map((o) => o.sell!.defId).sort()).toEqual(['murk', 'tonic', 'wand']);
    const murk = sells.find((o) => o.sell!.defId === 'murk')!;
    expect(murk.label.startsWith(leadPlayer(s).knowledge.murk.appearance!.label)).toBe(true);
    expect(murk.label).not.toContain('Murky');
  });

  it('a stale offer sells from another slot holding the item, or is refused when the item is gone', () => {
    const w = withTrader();
    let s = newGame(w);
    const m = addActor(w, s, 'merchant', { x: 2, y: 1 });
    s = talkTo(w, s, m.id);
    const idx = leadPlayer(s).pendingChoice!.options.findIndex((o) => o.tag === 'sell');
    const from = leadPlayer(s).pendingChoice!.options[idx].sell!.slot;
    // move the stack elsewhere behind the offer's back (state surgery)
    const moved = structuredClone(s);
    leadPlayer(moved).slots[12] = leadPlayer(moved).slots[from];
    leadPlayer(moved).slots[from] = null;
    const r1 = act(w, moved, { type: 'choose_option', index: idx });
    expect(r1.events.some((e) => e.type === 'invalid')).toBe(false);
    expect(leadPlayer(r1.state).slots[12]!.count).toBe(1);
    const gone = structuredClone(s);
    leadPlayer(gone).slots[from] = null;
    const r2 = act(w, gone, { type: 'choose_option', index: idx });
    expect(r2.events).toEqual([{ type: 'invalid', reason: 'you no longer have that' }]);
    expect(r2.state).toBe(gone);
  });

  it('sellPrice is half the value rounded down, 0 for worthless items', () => {
    expect(sellPrice(10)).toBe(5);
    expect(sellPrice(7)).toBe(3);
    expect(sellPrice(1)).toBe(0);
    expect(sellPrice(0)).toBe(0);
    expect(sellPrice(Number.NaN)).toBe(0);
  });
});

describe('loss lines name what did it', () => {
  it('terrain underfoot: "bested (Spikes, blunt)" with a catalog key', () => {
    const w = testWorld();
    let s = newGame(w);
    const p = player(s);
    p.hp = 1;
    s.area.map.tiles[p.pos.y * s.area.map.width + p.pos.x].terrain = 'spikes';
    for (let i = 0; i < 3 && s.status === 'playing'; i++) s = act(w, s, { type: 'wait' }).state;
    expect(s.status).toBe('lost');
    expect(s.endReason).toBe('bested (Spikes, blunt)');
    expect(s.endReasonKey).toBe('end.loss.cause_typed');
    expect(s.endReasonParams).toEqual({ defeated: 'bested', cause: 'Spikes', damageType: 'blunt' });
  });

  it('an attacker: "bested by Rat (blunt)"', () => {
    const w = testWorld();
    let s = newGame(w);
    player(s).hp = 1;
    player(s).base.ac = -50;
    addActor(w, s, 'rat', { x: 2, y: 1 }, { energy: 100, ai: { alerted: true } });
    for (let i = 0; i < 20 && s.status === 'playing'; i++) s = act(w, s, { type: 'wait' }).state;
    expect(s.status).toBe('lost');
    expect(s.endReason).toBe('bested by Rat (blunt)');
    expect(s.endReasonKey).toBe('end.loss.by_cause');
  });
});

describe('legalActions: attacks the goal needs', () => {
  const winBy = (cond: unknown) =>
    testWorld((x) => {
      x.goal.win = cond as never;
      x.areas[1].placed!.push({ actor: 'sage', where: 'far' } as never);
    });

  it('lists an attack on a friendly NPC whose defeat the goal requires, and step accepts it', () => {
    const w = winBy({ type: 'actor_defeated', actor: 'sage' });
    let s = newGame(w);
    const sage = addActor(w, s, 'sage', { x: 2, y: 1 });
    s = act(w, s, { type: 'wait' }).state;
    const attacks = legalActions(s, env(w)).filter((a) => a.type === 'attack');
    expect(attacks).toEqual([{ type: 'attack', targetId: sage.id }]);
    const r = act(w, s, attacks[0]);
    expect(r.events.some((e) => e.type === 'invalid')).toBe(false);
    expect(r.state.area.actors.find((a) => a.id === sage.id)?.faction ?? 'gone').not.toBe('friendly');
  });

  it('does not list it when the goal does not need it (or needs it NOT defeated), or once it is done', () => {
    for (const cond of [{ type: 'flag', flag: 'boss-down' }, { type: 'not', cond: { type: 'actor_defeated', actor: 'sage' } }]) {
      const w = winBy(cond);
      let s = newGame(w);
      addActor(w, s, 'sage', { x: 2, y: 1 });
      s = act(w, s, { type: 'wait' }).state;
      expect(legalActions(s, env(w)).some((a) => a.type === 'attack')).toBe(false);
    }
    const w = winBy({ type: 'actor_defeated', actor: 'sage', count: 2 });
    let s = newGame(w);
    addActor(w, s, 'sage', { x: 2, y: 1 });
    s.defeated.sage = 2;
    s = { ...s, status: 'playing' };
    expect(legalActions(s, env(w)).some((a) => a.type === 'attack')).toBe(false);
  });

  it('a transformed actor matches by an earlier form', () => {
    const w = winBy({ type: 'actor_defeated', actor: 'sage' });
    let s = newGame(w);
    addActor(w, s, 'rat', { x: 2, y: 1 }, { faction: 'neutral', formerDefIds: ['sage'] });
    s = act(w, s, { type: 'wait' }).state;
    expect(legalActions(s, env(w)).some((a) => a.type === 'attack')).toBe(true);
  });
});

describe('GM rule allConsumablesUnknown mid-run', () => {
  const forget = {
    id: 'forgetful',
    name: 'Forgetful',
    description: 'Every draught looks alike.',
    playerTriggers: [],
    switches: { allConsumablesUnknown: true },
  };

  function world() {
    return testWorld((x) => {
      x.items.push({
        id: 'bread',
        name: 'Bread',
        kind: 'Flask',
        description: 'food',
        category: 'consumable',
        useMode: 'consumed',
        appearanceGroup: 'flask',
        onUse: { targeting: { shape: 'self', range: 0, radius: 0, affects: 'self_only', needsLos: false }, effects: [{ type: 'heal', amount: { base: 1 } }] },
        model,
      } as never);
      x.unknownAppearances!.flask.push({ label: 'blue flask', color: '#0000ff' });
    });
  }

  it('hides known consumables the player has not used or carried, with appearances from the pool; lifting the rule restores them', () => {
    const w = world();
    let s = newGame(w);
    const r = applyGmActions(s, [{ type: 'add_rule', rule: forget as never, reason: 'Your memory fogs.' }], env(w));
    expect(r.gmSkipped).toEqual([]);
    s = r.state;
    // bread: clear, never used, not carried → unknown under the free pool label
    expect(leadPlayer(s).knowledge.bread.level).toBe('unknown');
    expect(leadPlayer(s).knowledge.bread.ruleHidden).toBe(true);
    const pool = ['green flask', 'red flask', 'blue flask'];
    expect(pool).toContain(leadPlayer(s).knowledge.bread.appearance!.label);
    // the carried tonic stays known; murk/fog keep their own appearances
    expect(leadPlayer(s).knowledge.tonic.level).toBe('clear');
    const labels = ['murk', 'fog', 'bread'].map((id) => leadPlayer(s).knowledge[id].appearance!.label);
    expect(new Set(labels).size).toBe(3);
    expect(r.events).toContainEqual({ type: 'item_identified', defId: 'bread', level: 'unknown' });
    const back = applyGmActions(s, [{ type: 'remove_rule', id: 'forgetful', reason: 'It clears.' }], env(w));
    expect(back.gmSkipped).toEqual([]);
    expect(leadPlayer(back.state).knowledge.bread.level).toBe('clear');
    expect(leadPlayer(back.state).knowledge.bread.ruleHidden).toBeUndefined();
    // murk was unknown by design: stays unknown
    expect(leadPlayer(back.state).knowledge.murk.level).toBe('unknown');
  });

  it("a world rule hides consumables from the start, and the GM retiring it restores them", () => {
    const input = testWorldInput();
    (input as { rules?: unknown[] }).rules = [forget];
    const parsed = parseWorld(input);
    if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
    const w = parsed.world;
    let s = createGame(w, { seed: 1, map: roomMap() });
    expect(leadPlayer(s).knowledge.tonic.level).toBe('unknown');
    expect(leadPlayer(s).knowledge.tonic.ruleHidden).toBe(true);
    s = applyGmActions(s, [{ type: 'remove_rule', id: 'forgetful', reason: 'x' }], { world: w }).state;
    expect(leadPlayer(s).knowledge.tonic.level).toBe('clear');
  });
});

describe('copy-on-write state clone', () => {
  it('step never mutates its input, even when tiles change (doors, temporary terrain, interactions)', () => {
    const w = testWorld();
    const map = roomMap(14, 10);
    map.tiles[1 * 14 + 4] = { kind: 'door', region: 0 };
    map.tiles[3 * 14 + 2] = { kind: 'floor', terrain: 'chest', region: 0 };
    let s = newGame(w, 3, map);
    const s0 = s;
    const snap0 = structuredClone(s0);
    const tiles0 = s0.area.map.tiles;
    const steps: PlayerAction[] = [
      { type: 'move', dir: 'e' },
      { type: 'move', dir: 'e' },
      { type: 'move', dir: 'e' }, // opens the door at (4,1)
      { type: 'interact', pos: { x: 4, y: 1 } }, // closes it again
      { type: 'move', dir: 'sw' },
      { type: 'interact', pos: { x: 2, y: 3 } }, // the chest
    ];
    const history: { state: GameState; json: string }[] = [];
    for (const a of steps) {
      const before = serialize(s);
      const snap = structuredClone(s);
      const r = act(w, s, a);
      expect(serialize(s)).toBe(before);
      expect(s).toEqual(snap);
      history.push({ state: s, json: before });
      s = r.state;
    }
    // temporary terrain spawned by a GM effect, then ticking down over turns
    const gm = applyGmActions(s, [{ type: 'effect', target: 'player', effects: [{ type: 'spawn_terrain', terrain: 'glue', radius: 1, duration: 3 } as never] }], env(w));
    expect(gm.state.area.map.tiles.some((t) => t.terrain === 'glue' && t.terrainTtl !== undefined)).toBe(true);
    expect(s.area.map.tiles.some((t) => t.terrain === 'glue')).toBe(false);
    s = gm.state;
    for (let i = 0; i < 5; i++) {
      const before = serialize(s);
      history.push({ state: s, json: before });
      s = act(w, s, { type: 'wait' }).state;
      expect(serialize(history[history.length - 1].state)).toBe(before);
    }
    // every earlier state is still exactly what it was
    for (const h of history) expect(serialize(h.state)).toBe(h.json);
    expect(s0).toEqual(snap0);
    expect(s0.area.map.tiles).toBe(tiles0);
    // the glue expired again in the newest state
    expect(s.area.map.tiles.some((t) => t.terrain === 'glue')).toBe(false);
    // the door and chest changes landed in the new states only
    expect(snap0.area.map.tiles[1 * 14 + 4].kind).toBe('door');
    expect(snap0.area.map.tiles[3 * 14 + 2].interacted).toBeUndefined();
  });

  it('untouched tiles are shared between consecutive states; touched ones are copies', () => {
    const w = testWorld();
    const map = roomMap(14, 10);
    map.tiles[1 * 14 + 2] = { kind: 'door', region: 0 };
    const s0 = newGame(w, 3, map);
    const s1 = act(w, s0, { type: 'wait' }).state;
    expect(s1.area.map.tiles).toBe(s0.area.map.tiles);
    const s2 = act(w, s1, { type: 'move', dir: 'e' }).state; // opens the door
    expect(s2.area.map.tiles).not.toBe(s1.area.map.tiles);
    expect(s2.area.map.tiles[1 * 14 + 2]).not.toBe(s1.area.map.tiles[1 * 14 + 2]);
    expect(s2.area.map.tiles[5 * 14 + 5]).toBe(s1.area.map.tiles[5 * 14 + 5]);
    expect(s1.area.map.tiles[1 * 14 + 2].kind).toBe('door');
    expect(s2.area.map.tiles[1 * 14 + 2].kind).toBe('door_open');
    // log entries are shared, the log array is not
    expect(s2.log).not.toBe(s1.log);
    expect(leadPlayer(s1).seen).not.toBe(leadPlayer(s2).seen);
  });

  it('long fixture runs: every input state survives its step unchanged, and step stays fast', () => {
    const times: number[] = [];
    for (const f of ['fixture-dream.json', 'fixture-ship.json']) {
      const world = loadFixture(f);
      let s = createGame(world, { seed: 5 });
      const bot = botByName('explorer');
      const mem = newMemory(5);
      const rng = createRng(77);
      for (let i = 0; i < 300 && s.status === 'playing'; i++) {
        const action = rng.chance(0.2) ? legalActions(s, { world })[0] : bot.decide(s, world, mem);
        const before = i % 15 === 0 ? serialize(s) : null;
        const t0 = performance.now();
        const r = step(s, action, { world });
        times.push(performance.now() - t0);
        if (before !== null) expect(serialize(s)).toBe(before);
        s = r.state;
      }
    }
    times.sort((a, b) => a - b);
    // the target is < 0.3 ms on a quiet machine; generous here so a loaded CI box does not flake
    expect(times[times.length >> 1]).toBeLessThan(2);
  }, 60_000);
});
