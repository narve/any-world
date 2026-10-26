/**
 * Regression tests for the engine issues of adversarial review round 2 (see issues/M1-*.md):
 * unaffordable GM offers, half-applied paid offers, terrain soft-locks, left-behind uniques and
 * trade labels leaking unknown item names.
 */
import { describe, expect, it } from 'vitest';
import { GM_BUDGET_PER_AREA, GM_ACTION_COST } from '../../src/schema/gm';
import { applyGmActions, bfsDistances, legalActions, serialize, deserialize, step, transitionBlocker, type GameState, leadPlayer } from '../../src/engine';
import type { WorldSpecInput } from '../../src/schema';
import { applyEffectList } from '../../src/engine/effects';
import { act, addActor, ctxFor, env, newGame, player, roomMap, testWorld } from './helpers';

const model = { archetype: 'blob', colors: { primary: '#888888' } } as const;

function withMerchant(w: WorldSpecInput): void {
  (w.actors as unknown[]).push({
    id: 'merchant',
    name: 'Merchant',
    description: 'sells things',
    faction: 'friendly',
    stats: { hp: 10 },
    behaviour: { type: 'idle' },
    xp: 0,
    npc: { role: 'trader', personality: 'shrewd', greeting: 'Buy something.', lines: [], stock: ['murk'] },
    model,
  });
}

const invalid = (r: { events: { type: string }[] }) => r.events.some((e) => e.type === 'invalid');

describe('review r2: trade labels keep unknown items unknown', () => {
  it('trader dialogue does not reveal the real name of an unknown item', () => {
    const world = testWorld(withMerchant);
    let s = newGame(world);
    const p = player(s);
    const m = addActor(world, s, 'merchant', { x: p.pos.x + 1, y: p.pos.y });
    expect(leadPlayer(s).knowledge.murk.level).toBe('unknown');
    s = act(world, s, { type: 'talk', targetId: m.id }).state;
    const labels = leadPlayer(s).pendingChoice!.options.map((o) => o.label).join(' | ');
    expect(labels).not.toContain('Murky Draught');
    expect(labels).toContain(leadPlayer(s).knowledge.murk.appearance!.label);
  });

  it('GM trade offer does not reveal the real name of an unknown item', () => {
    const world = testWorld(withMerchant);
    let s = newGame(world);
    const p = player(s);
    const m = addActor(world, s, 'merchant', { x: p.pos.x + 1, y: p.pos.y });
    s = applyGmActions(s, [{ type: 'trade', actorId: m.id, items: [{ item: 'murk', price: 0 }] }], env(world)).state;
    const labels = leadPlayer(s).pendingChoice!.options.map((o) => o.label).join(' | ');
    expect(labels).not.toContain('Murky Draught');
    expect(labels).toContain(leadPlayer(s).knowledge.murk.appearance!.label);
  });

  it('a known item is still labelled by its real name', () => {
    const world = testWorld(withMerchant);
    let s = newGame(world);
    leadPlayer(s).knowledge.murk.level = 'clear';
    const p = player(s);
    const m = addActor(world, s, 'merchant', { x: p.pos.x + 1, y: p.pos.y });
    s = act(world, s, { type: 'talk', targetId: m.id }).state;
    expect(leadPlayer(s).pendingChoice!.options[0].label).toContain('Murky Draught');
  });
});

describe('review r2: GM offers cannot soft-lock the run', () => {
  const pricey = [
    { label: 'Pay 10', actions: [{ type: 'currency' as const, amount: -10 }, { type: 'give_item' as const, item: 'coat', count: 1 }] },
    { label: 'Pay 20', actions: [{ type: 'currency' as const, amount: -20 }, { type: 'grant_xp' as const, amount: 5 }] },
  ];

  it('an offer whose options all cost more than the player has gets a free way out', () => {
    const world = testWorld();
    let s = newGame(world);
    expect(s.purse).toBe(0);
    s = applyGmActions(s, [{ type: 'offer_choice', prompt: 'A stranger offers a bargain.', options: pricey }], env(world)).state;
    expect(leadPlayer(s).pendingChoice).not.toBeNull();
    expect(leadPlayer(s).pendingChoice!.options).toHaveLength(3);
    const legal = legalActions(s, env(world));
    expect(legal.length).toBeGreaterThan(0);
    for (const a of legal) expect(invalid(step(s, a, env(world)))).toBe(false);
    const r = step(s, legal[0], env(world));
    expect(leadPlayer(r.state).pendingChoice).toBeNull();
    // and play continues
    expect(invalid(step(r.state, { type: 'wait' }, env(world)))).toBe(false);
  });

  it('an offer that already has a free option gets no extra one', () => {
    const world = testWorld();
    let s = newGame(world);
    s = applyGmActions(s, [{ type: 'offer_choice', prompt: 'Well?', options: [pricey[0], { label: 'No', actions: [] }] }], env(world)).state;
    expect(leadPlayer(s).pendingChoice!.options.map((o) => o.label)).toEqual(['Pay 10', 'No']);
  });

  it('a locked choice from an old save (no affordable option) is declined by any pick', () => {
    const world = testWorld();
    let s = newGame(world);
    leadPlayer(s).pendingChoice = { kind: 'gm_offer', prompt: 'old', options: pricey.map((o) => ({ ...o, actions: [...o.actions] })) };
    s = deserialize(world, serialize(s));
    const legal = legalActions(s, env(world));
    expect(legal.length).toBeGreaterThan(0);
    const r = step(s, legal[0], env(world));
    expect(invalid(r)).toBe(false);
    expect(leadPlayer(r.state).pendingChoice).toBeNull();
    expect(r.state.purse).toBe(0);
    expect(leadPlayer(r.state).slots.some((it) => it?.defId === 'coat')).toBe(false);
  });

  it('options naming a missing item are left out, so the price can never buy nothing', () => {
    const world = testWorld();
    let s = newGame(world);
    s = applyGmActions(s, [{ type: 'currency', amount: 50 }], env(world)).state;
    s = applyGmActions(
      s,
      [{ type: 'offer_choice', prompt: '?', options: [{ label: 'Buy ghost', actions: [{ type: 'currency', amount: -10 }, { type: 'give_item', item: 'no-such-item', count: 1 }] }, pricey[0]] }],
      env(world),
    ).state;
    expect(leadPlayer(s).pendingChoice!.options.map((o) => o.label)).toEqual(['Pay 10', 'Decline']);
  });
});

describe('review r2: paid GM offers are atomic', () => {
  it('choosing a paid GM offer never takes the price without delivering the goods', () => {
    const world = testWorld();
    let s = newGame(world);
    s = applyGmActions(s, [{ type: 'currency', amount: 20 }], env(world)).state;
    s = applyGmActions(
      s,
      [
        {
          type: 'offer_choice',
          prompt: 'Buy a coat?',
          options: [
            { label: 'Buy (10)', actions: [{ type: 'currency', amount: -10 }, { type: 'give_item', item: 'coat', count: 1 }] },
            { label: 'No', actions: [] },
          ],
        },
      ],
      env(world),
    ).state;
    // other GM hooks (async) spend the area budget while the offer is open
    s = applyGmActions(s, [{ type: 'grant_xp', amount: 1 }, { type: 'grant_xp', amount: 1 }, { type: 'grant_xp', amount: 1 }], env(world)).state;
    while (leadPlayer(s).pendingPerkChoice) s = step(s, { type: 'choose_perk', perkId: leadPlayer(s).pendingPerkChoice![0] }, env(world)).state;
    const before = s.purse;
    const r = step(s, { type: 'choose_option', index: 0 }, env(world));
    expect(before - r.state.purse).toBe(10);
    expect(leadPlayer(r.state).slots.some((it) => it?.defId === 'coat')).toBe(true);
  });

  it('the offer reserves the costliest option and refunds what the chosen one leaves unused', () => {
    const world = testWorld();
    let s = newGame(world);
    s = applyGmActions(
      s,
      [{ type: 'offer_choice', prompt: '?', options: [{ label: 'Coat', actions: [{ type: 'give_item', item: 'coat', count: 1 }] }, { label: 'No', actions: [] }] }],
      env(world),
    ).state;
    const reserved = GM_ACTION_COST.offer_choice + GM_ACTION_COST.give_item;
    expect(s.area.gmBudget).toBe(GM_BUDGET_PER_AREA - reserved);
    const declined = step(s, { type: 'choose_option', index: 1 }, env(world)).state;
    expect(declined.area.gmBudget).toBe(GM_BUDGET_PER_AREA - GM_ACTION_COST.offer_choice);
    const took = step(s, { type: 'choose_option', index: 0 }, env(world)).state;
    expect(took.area.gmBudget).toBe(GM_BUDGET_PER_AREA - reserved);
    expect(leadPlayer(took).slots.some((it) => it?.defId === 'coat')).toBe(true);
  });

  it('an offer whose goods do not fit the remaining budget is not made', () => {
    const world = testWorld();
    let s = newGame(world);
    s.area.gmBudget = 3; // offer (1) + give_item (3) does not fit
    s = applyGmActions(
      s,
      [{ type: 'offer_choice', prompt: '?', options: [{ label: 'Coat', actions: [{ type: 'give_item', item: 'coat', count: 1 }] }, { label: 'No', actions: [] }] }],
      env(world),
    ).state;
    expect(leadPlayer(s).pendingChoice).toBeNull();
    expect(s.area.gmBudget).toBe(3);
  });
});

describe('review r2: spawned terrain never cuts the player off', () => {
  // pocket at x 1..2, y 7..8 with a single entrance at (2,6)
  const walls = [
    { x: 1, y: 6 },
    { x: 3, y: 6 },
    { x: 3, y: 7 },
    { x: 3, y: 8 },
  ];
  const mason = (w: WorldSpecInput, duration?: number) => {
    (w.items as unknown[]).push({
      id: 'mason',
      name: 'Mason Kit',
      kind: 'Tool',
      description: 'builds a pillar',
      category: 'tool',
      useMode: 'reusable',
      onUse: {
        targeting: { shape: 'single', range: 8, affects: 'all', needsLos: false },
        effects: [{ type: 'spawn_terrain', terrain: 'pillar', radius: 0, ...(duration ? { duration } : {}) }],
      },
      model,
    });
    (w.player as { startingItems: unknown[] }).startingItems.push({ item: 'mason' });
  };
  const keyReachable = (s: GameState) => {
    const map = s.area.map;
    const pass = (x: number, y: number) => {
      const t = map.tiles[y * map.width + x];
      return ['floor', 'door', 'door_open', 'start', 'transition'].includes(t.kind) && t.terrain !== 'pillar';
    };
    return bfsDistances(map.width, map.height, player(s).pos, pass)[8 * map.width + 1] >= 0;
  };

  it('permanent blocking terrain cannot wall off the item the exit requires', () => {
    const world = testWorld((w) => mason(w));
    let s: GameState = newGame(world, 1, roomMap(12, 10, { walls }));
    s.area.items.push({ item: { id: 'ikey', defId: 'key', count: 1 }, pos: { x: 1, y: 8 } });
    const slot = leadPlayer(s).slots.findIndex((it) => it?.defId === 'mason');
    const r = step(s, { type: 'use', slot, target: { x: 2, y: 6 } }, env(world));
    expect(invalid(r)).toBe(false);
    s = r.state;
    expect(s.area.map.tiles[6 * 12 + 2].terrain).toBeUndefined();
    expect(keyReachable(s)).toBe(true);
    expect(transitionBlocker(s, env(world))).not.toBeNull();
  });

  it('permanent blocking terrain cannot seal off an empty pocket either (later spawns may land there)', () => {
    const world = testWorld();
    const s: GameState = newGame(world, 1, roomMap(12, 10, { walls }));
    const ctx = ctxFor(world, s);
    applyEffectList(ctx, [{ type: 'spawn_terrain', terrain: 'pillar', radius: 0 }], player(s), [], { x: 2, y: 6 }, []);
    expect(s.area.map.tiles[6 * 12 + 2].terrain).toBeUndefined();
    // a pillar in the open room is fine
    applyEffectList(ctx, [{ type: 'spawn_terrain', terrain: 'pillar', radius: 0 }], player(s), [], { x: 6, y: 4 }, []);
    expect(s.area.map.tiles[4 * 12 + 6].terrain).toBe('pillar');
  });

  it('temporary blocking terrain may close the pocket (it expires)', () => {
    const world = testWorld();
    const s: GameState = newGame(world, 1, roomMap(12, 10, { walls }));
    const ctx = ctxFor(world, s);
    applyEffectList(ctx, [{ type: 'spawn_terrain', terrain: 'pillar', radius: 0, duration: 3 }], player(s), [], { x: 2, y: 6 }, []);
    expect(s.area.map.tiles[6 * 12 + 2].terrain).toBe('pillar');
  });
});

describe('review r2: uniques left behind can appear again', () => {
  const toExit = (s: GameState) => {
    const p = player(s);
    p.pos = { ...s.area.map.exit };
    for (const a of s.area.actors) if (a !== p && a.pos.x === p.pos.x && a.pos.y === p.pos.y) a.pos = { x: 5, y: 5 };
  };

  it('a unique spawned early (GM spawn) and left behind still appears where the area plan places it', () => {
    const world = testWorld();
    let s = newGame(world);
    s = applyGmActions(s, [{ type: 'spawn', actor: 'boss', count: 1, near: 'random' }], env(world)).state;
    expect(s.area.actors.filter((a) => a.defId === 'boss')).toHaveLength(1);
    s = applyGmActions(s, [{ type: 'give_item', item: 'key', count: 1 }], env(world)).state;
    toExit(s);
    const r = step(s, { type: 'transition' }, env(world));
    expect(invalid(r)).toBe(false);
    expect(r.state.area.index).toBe(1);
    expect(r.state.area.actors.filter((a) => a.defId === 'boss')).toHaveLength(1);
  });

  it('a unique is never alive twice at once', () => {
    const world = testWorld();
    let s = newGame(world);
    s = applyGmActions(s, [{ type: 'spawn', actor: 'boss', count: 3, near: 'random' }], env(world)).state;
    s = applyGmActions(s, [{ type: 'spawn', actor: 'boss', count: 1, near: 'random' }], env(world)).state;
    expect(s.area.actors.filter((a) => a.defId === 'boss')).toHaveLength(1);
  });

  it('a defeated unique never comes back', () => {
    const world = testWorld();
    let s = newGame(world);
    s.defeated.boss = 1;
    s = applyGmActions(s, [{ type: 'give_item', item: 'key', count: 1 }], env(world)).state;
    toExit(s);
    s = step(s, { type: 'transition' }, env(world)).state;
    expect(s.area.index).toBe(1);
    expect(s.area.actors.some((a) => a.defId === 'boss')).toBe(false);
    s = applyGmActions(s, [{ type: 'spawn', actor: 'boss', count: 1, near: 'random' }], env(world)).state;
    expect(s.area.actors.some((a) => a.defId === 'boss')).toBe(false);
  });
});
