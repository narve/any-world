import { describe, it, expect } from 'vitest';
import { testWorld, newGame, ctxFor, player, addActor, act, env, roomMap, simpleGenerator, loadFixture } from './helpers';
import {
  createGame,
  step,
  applyGmActions,
  legalActions,
  describeActor,
  serialize,
  deserialize,
  getWorld,
} from '../../src/engine';
import { giveItem } from '../../src/engine/inventory';
import { GM_BUDGET_PER_AREA } from '../../src/schema';
import type { GmAction } from '../../src/schema';
import type { GameState, PlayerAction } from '../../src/engine/types';
import { createRng } from '../../src/engine/rng';

function randomRun(w: ReturnType<typeof testWorld>, seed: number, n: number): { states: GameState[]; actions: PlayerAction[] } {
  let s = newGame(w, seed);
  const rng = createRng(seed + 1000);
  const states = [s];
  const actions: PlayerAction[] = [];
  for (let i = 0; i < n && s.status === 'playing'; i++) {
    const la = legalActions(s, env(w));
    const a = la[rng.int(0, la.length - 1)];
    actions.push(a);
    s = act(w, s, a).state;
    states.push(s);
  }
  return { states, actions };
}

describe('determinism & purity', () => {
  it('same seed + same actions → identical state', () => {
    const w = testWorld();
    const { states, actions } = randomRun(w, 3, 150);
    let s = newGame(w, 3);
    for (const a of actions) s = act(w, s, a).state;
    expect(serialize(s)).toBe(serialize(states[states.length - 1]));
  });

  it('createGame is deterministic with the real map generator, and seeds differ', () => {
    const w = loadFixture('fixture-ship.json');
    const a = createGame(w, { seed: 11 });
    const b = createGame(w, { seed: 11 });
    const c = createGame(w, { seed: 12 });
    expect(serialize(a)).toBe(serialize(b));
    expect(serialize(a)).not.toBe(serialize(c));
    expect(a.area.actors.length).toBeGreaterThan(1);
  });

  it('step / applyGmActions / legalActions / describe never mutate their input', () => {
    const w = testWorld();
    const { states, actions } = randomRun(w, 5, 60);
    for (let i = 0; i < actions.length; i++) {
      const before = serialize(states[i]);
      const snapshot = structuredClone(states[i]);
      act(w, states[i], actions[i]);
      legalActions(states[i], env(w));
      applyGmActions(states[i], [{ type: 'grant_xp', amount: 5 }, { type: 'narrate', text: 'x' }], env(w));
      for (const a of states[i].area.actors) describeActor(states[i], a.id, env(w));
      expect(serialize(states[i])).toBe(before);
      expect(states[i]).toEqual(snapshot);
    }
  });

  it('invalid actions return the very same state object', () => {
    const w = testWorld();
    const s = newGame(w);
    for (const a of [
      { type: 'use', slot: 99 },
      { type: 'move', dir: 'up' },
      { type: 'attack', targetId: 'zzz' },
      { type: 'choose_perk', perkId: 'tough' },
      { type: 'nonsense' },
    ] as unknown as PlayerAction[]) {
      const r = act(w, s, a);
      expect(r.state).toBe(s);
      expect(r.tookTurn).toBe(false);
      expect(r.events[0].type).toBe('invalid');
    }
  });

  it('serialize/deserialize round-trips (Uint8Array seen) and continues identically', () => {
    const w = testWorld();
    const { states } = randomRun(w, 9, 40);
    const s = states[states.length - 1];
    const json = serialize(s);
    const back = deserialize(w, json);
    expect(back.area.seen).toBeInstanceOf(Uint8Array);
    expect([...back.area.seen]).toEqual([...s.area.seen]);
    expect(serialize(back)).toBe(json);
    const a = act(w, s, { type: 'wait' }).state;
    const b = act(w, back, { type: 'wait' }).state;
    expect(serialize(a)).toBe(serialize(b));
    expect(() => deserialize(w, '{')).toThrow();
    expect(() => deserialize(testWorld((x) => (x.meta.title = 'Other')), json)).toThrow(/different world/);
    expect(getWorld(s)).toBe(w);
  });
});

describe('turns & energy', () => {
  it('a normal action advances one round; fast monsters act more often', () => {
    const w = testWorld((x) => {
      x.actors[0].speed = 200;
      x.actors[0].stats.hp = 500;
    });
    const s = newGame(w);
    const r = addActor(w, s, 'rat', { x: 2, y: 1 }, { ai: { alerted: true }, energy: 0 });
    let st = s;
    for (let i = 0; i < 10; i++) st = act(w, st, { type: 'wait' }).state;
    expect(st.turn).toBe(10);
    const bites = st.log.filter((l) => l.text.startsWith('Rat bites')).length;
    expect(bites).toBeGreaterThanOrEqual(18);
    void r;
  });

  it('mp regenerates every mpRegenEvery turns; hp only when hpRegenEvery > 0 and not disabled', () => {
    const w = testWorld((x) => {
      x.player.mpRegenEvery = 2;
      x.player.hpRegenEvery = 3;
    });
    const s = newGame(w);
    player(s).mp = 0;
    player(s).hp = 10;
    let st = s;
    for (let i = 0; i < 6; i++) st = act(w, st, { type: 'wait' }).state;
    expect(player(st).mp).toBe(3);
    expect(player(st).hp).toBe(12);
    const w2 = testWorld((x) => {
      x.player.hpRegenEvery = 1;
      x.rules = [{ id: 'd', name: 'D', description: 'd', switches: { noNaturalHpRegen: true } }];
    });
    const s2 = newGame(w2);
    player(s2).hp = 10;
    expect(player(act(w2, s2, { type: 'wait' }).state).hp).toBe(10);
  });

  it('custom resources tick per turn; onEmpty fires once on crossing; emptyIsDeath ends the run', () => {
    const w = testWorld((x) => {
      x.resources![0].perTurn = -2;
    });
    let st = newGame(w);
    for (let i = 0; i < 5; i++) st = act(w, st, { type: 'wait' }).state;
    expect(st.player.resources.oil).toBe(0);
    expect(player(st).statuses.map((x) => x.id)).toContain('blind');
    const w2 = testWorld((x) => {
      x.resources![0].perTurn = -5;
      x.resources![0].emptyIsDeath = true;
    });
    let s2 = newGame(w2);
    s2 = act(w2, s2, { type: 'wait' }).state;
    expect(s2.status).toBe('playing');
    const r = act(w2, s2, { type: 'wait' });
    expect(r.state.status).toBe('lost');
    expect(r.state.endReason).toBe('Oil ran out');
    expect(r.events.some((e) => e.type === 'game_over')).toBe(true);
    expect(act(w2, r.state, { type: 'wait' }).events[0]).toMatchObject({ type: 'invalid' });
  });

  it('terrain onStand effects apply at the end of the round; a just-expired root is not reapplied', () => {
    const w = testWorld();
    const map = roomMap();
    map.tiles[1 * map.width + 2] = { kind: 'floor', terrain: 'spikes' };
    map.tiles[2 * map.width + 2] = { kind: 'floor', terrain: 'glue' };
    let st = newGame(w, 1, map);
    st = act(w, st, { type: 'move', dir: 'e' }).state;
    expect(player(st).hp).toBe(29);
    st = act(w, st, { type: 'move', dir: 's' }).state;
    expect(player(st).statuses.map((x) => x.id)).toEqual(['root']);
    expect(act(w, st, { type: 'move', dir: 'e' }).events[0]).toMatchObject({ type: 'invalid' });
    st = act(w, st, { type: 'wait' }).state;
    expect(player(st).statuses).toEqual([]);
    st = act(w, st, { type: 'move', dir: 'e' }).state;
    expect(player(st).pos).toEqual({ x: 3, y: 2 });
  });

  it('on_turn triggers honour `every`', () => {
    const w = testWorld((x) => {
      x.rules = [{ id: 't', name: 'T', description: 'd', playerTriggers: [{ on: 'on_turn', every: 3, action: { targeting: { shape: 'self', affects: 'self_only' }, effects: [{ type: 'counter', counter: 'tick', add: 1 }] } }] }];
    });
    let st = newGame(w);
    for (let i = 0; i < 9; i++) st = act(w, st, { type: 'wait' }).state;
    expect(st.counters.tick).toBe(3);
  });
});

describe('areas, goals and progression', () => {
  it('transition is locked until transitionRequires holds, then populates the next area', () => {
    const w = testWorld();
    const map = roomMap(6, 4, { start: { x: 1, y: 1 }, exit: { x: 2, y: 1 } });
    let st = newGame(w, 1, map);
    expect(act(w, st, { type: 'transition' }).events[0]).toMatchObject({ type: 'invalid', reason: 'not at the way onward' });
    st = act(w, st, { type: 'move', dir: 'e' }).state;
    expect(legalActions(st, env(w)).some((a) => a.type === 'transition')).toBe(false);
    expect(act(w, st, { type: 'transition' }).events[0]).toMatchObject({ type: 'invalid', reason: 'Stairs: locked' });
    giveItem(ctxFor(w, st), 'key', 1);
    expect(legalActions(st, env(w)).some((a) => a.type === 'transition')).toBe(true);
    const r = act(w, st, { type: 'transition' });
    const s2 = r.state;
    expect(s2.area.index).toBe(1);
    expect(s2.stats.areasCleared).toBe(1);
    expect(r.events.some((e) => e.type === 'area_entered' && e.index === 1)).toBe(true);
    expect(player(s2).pos).toEqual(s2.area.map.start);
    expect(s2.area.actors.filter((a) => a.defId === 'boss')).toHaveLength(1);
    expect(s2.area.actors.filter((a) => a.defId === 'rat').length).toBeGreaterThanOrEqual(1);
    expect(s2.area.items.some((i) => i.item.defId === 'key')).toBe(true);
    expect(s2.area.gmBudget).toBe(GM_BUDGET_PER_AREA);
    expect(s2.uniquesSpawned).toEqual(['boss']);
    // last area: nowhere further
    const pl = player(s2);
    pl.pos = { ...s2.area.map.exit };
    expect(act(w, s2, { type: 'transition' }).events[0]).toMatchObject({ type: 'invalid', reason: 'there is nowhere further to go' });
  });

  it('allies near the player come along to the next area', () => {
    const w = testWorld((x) => {
      delete x.areas[0].transitionRequires;
    });
    const map = roomMap(8, 5, { start: { x: 1, y: 1 }, exit: { x: 2, y: 1 } });
    let st = newGame(w, 1, map);
    addActor(w, st, 'rat', { x: 1, y: 2 }, { allyOf: 'a1', faction: 'friendly' });
    st = act(w, st, { type: 'move', dir: 'e' }).state;
    st = act(w, st, { type: 'transition' }).state;
    expect(st.area.actors.some((a) => a.allyOf === 'a1')).toBe(true);
  });

  it('win condition ends the game (on_death trigger sets the flag)', () => {
    const w = testWorld();
    const s = newGame(w);
    const b = addActor(w, s, 'boss', { x: 2, y: 1 }, { hp: 1 });
    let st = s;
    for (let i = 0; i < 20 && st.status === 'playing'; i++) {
      const target = st.area.actors.find((a) => a.id === b.id);
      st = target ? act(w, st, { type: 'attack', targetId: b.id }).state : act(w, st, { type: 'wait' }).state;
    }
    expect(st.status).toBe('won');
    expect(st.log.some((l) => l.text === 'You won.')).toBe(true);
  });

  it('goal.lose ends the game', () => {
    const w = testWorld((x) => {
      x.goal.lose = { type: 'counter', counter: 'shame', cmp: 'gte', value: 2 };
    });
    const s = newGame(w);
    const r = applyGmActions(s, [{ type: 'set_flag', flag: 'x', value: true }], env(w));
    expect(r.state.status).toBe('playing');
    const ctx = ctxFor(w, r.state);
    r.state.counters.shame = 2;
    void ctx;
    expect(act(w, r.state, { type: 'wait' }).state.status).toBe('lost');
  });

  it('level-up offers perks that block other actions until chosen; perks apply', () => {
    const w = testWorld();
    let st = applyGmActions(newGame(w), [{ type: 'grant_xp', amount: 10 }], env(w)).state;
    expect(st.player.level).toBe(2);
    const choices = st.player.pendingPerkChoice!;
    expect(choices).toHaveLength(3);
    expect(legalActions(st, env(w))).toEqual(choices.map((perkId) => ({ type: 'choose_perk', perkId })));
    expect(act(w, st, { type: 'wait' }).events[0]).toMatchObject({ type: 'invalid', reason: 'choose a perk first' });
    const notOffered = ['tough', 'quick', 'clever', 'strong'].find((p) => !choices.includes(p))!;
    expect(act(w, st, { type: 'choose_perk', perkId: notOffered }).events[0]).toMatchObject({ type: 'invalid' });
    const hpBefore = player(st).maxHp;
    st = act(w, st, { type: 'choose_perk', perkId: choices[0] }).state;
    expect(st.player.perks).toEqual([choices[0]]);
    expect(st.player.pendingPerkChoice).toBeNull();
    if (choices[0] === 'tough') expect(player(st).maxHp).toBe(hpBefore + 5);
    if (choices[0] === 'clever') expect(st.player.slots.some((x) => x?.defId === 'spark')).toBe(true);
    expect(player(st).maxHp).toBeGreaterThanOrEqual(34); // +4 hp per level
  });
});

describe('GM actions', () => {
  it('apply every action type within budget', () => {
    const w = testWorld();
    const s = newGame(w);
    const sage = addActor(w, s, 'sage', { x: 3, y: 1 });
    const actions: GmAction[] = [
      { type: 'narrate', text: 'The lights flicker.' },
      { type: 'say', actorId: sage.id, text: 'Psst.' },
      { type: 'mood', music: 'tense' },
      { type: 'set_flag', flag: 'omen', value: true },
      { type: 'reveal_item', item: 'murk', level: 'vague' },
      { type: 'currency', amount: 30 },
      { type: 'give_item', item: 'coat', count: 1 },
    ];
    const r = applyGmActions(s, actions, env(w));
    const st = r.state;
    expect(st.log.some((l) => l.kind === 'gm' && l.text === 'The lights flicker.')).toBe(true);
    expect(st.log.some((l) => l.kind === 'npc' && l.speaker === 'Sage')).toBe(true);
    expect(st.flags.omen).toBe(true);
    expect(st.knowledge.murk.level).toBe('vague');
    expect(st.player.currency).toBe(30);
    expect(st.player.slots.some((x) => x?.defId === 'coat')).toBe(true);
    expect(st.area.gmBudget).toBe(GM_BUDGET_PER_AREA - 1 - 1 - 3);
    expect(r.tookTurn).toBe(false);

    const r2 = applyGmActions(st, [
      { type: 'spawn', actor: 'rat', count: 2, near: 'player' },
      { type: 'place_item', item: 'tonic', near: 'exit' },
    ], env(w));
    expect(r2.state.area.actors.filter((a) => a.defId === 'rat')).toHaveLength(2);
    expect(r2.state.area.items).toHaveLength(1);
    expect(r2.state.area.gmBudget).toBe(0);
    const r3 = applyGmActions(r2.state, [{ type: 'grant_xp', amount: 5 }, { type: 'narrate', text: 'free' }], env(w));
    expect(r3.state.player.xp).toBe(0);
    expect(r3.gmSkipped).toEqual([{ action: 'grant_xp', reason: 'over budget' }]);
    expect(r3.events).toContainEqual({ type: 'gm_skipped', action: 'grant_xp', reason: 'over budget' });
    // refused GM actions are diagnostics, never lines in the player's log
    expect(r3.state.log.some((l) => l.text.includes('skipped') || l.text.includes('over budget'))).toBe(false);
    expect(r3.state.log.some((l) => l.text === 'free')).toBe(true);
  });

  it('effect, change_faction, grant_xp, start_quest (completes + rewards), trade, offer_choice', () => {
    const w = testWorld();
    const s = newGame(w);
    const rat = addActor(w, s, 'rat', { x: 3, y: 3 });
    const sage = addActor(w, s, 'sage', { x: 1, y: 2 });
    let st = applyGmActions(s, [{ type: 'effect', target: 'all_visible_enemies', effects: [{ type: 'damage', amount: { base: 2 }, damageType: 'physical' }] }], env(w)).state;
    expect(st.area.actors.find((a) => a.id === rat.id)!.hp).toBe(3);
    st = applyGmActions(st, [{ type: 'change_faction', actorId: rat.id, faction: 'neutral' }], env(w)).state;
    expect(st.area.actors.find((a) => a.id === rat.id)!.faction).toBe('neutral');
    st = applyGmActions(st, [{ type: 'start_quest', id: 'q1', title: 'Find the coat', description: 'd', complete: { type: 'has_item', who: 'player', item: 'coat' }, reward: [{ type: 'grant_xp', amount: 4 }, { type: 'currency', amount: 7 }] }], env(w)).state;
    expect(st.quests[0].status).toBe('active');
    giveItem(ctxFor(w, st), 'coat', 1);
    const done = act(w, st, { type: 'wait' });
    expect(done.state.quests[0].status).toBe('done');
    expect(done.state.player.currency).toBe(7);
    expect(done.events.some((e) => e.type === 'quest_updated' && e.status === 'done')).toBe(true);
    st = applyGmActions(done.state, [{ type: 'trade', actorId: sage.id, items: [{ item: 'tonic', price: 5 }, { item: 'wand', price: 50 }] }], env(w)).state;
    expect(st.pendingChoice?.options.map((o) => o.label)).toEqual(['Tonic (5 coins)', 'Wand (50 coins)', 'Leave']);
    expect(legalActions(st, env(w))).toEqual([{ type: 'choose_option', index: 0 }, { type: 'choose_option', index: 2 }]);
    expect(act(w, st, { type: 'choose_option', index: 1 }).events[0]).toMatchObject({ type: 'invalid', reason: 'not enough coins' });
    st = act(w, st, { type: 'choose_option', index: 0 }).state;
    expect(st.player.currency).toBe(2);
    expect(st.pendingChoice).toBeNull();
    st = applyGmActions(st, [{ type: 'offer_choice', prompt: 'Pick', options: [{ label: 'Gold', actions: [{ type: 'currency', amount: 10 }] }, { label: 'Nothing', actions: [] }] }], env(w)).state;
    expect(st.pendingChoice?.kind).toBe('gm_offer');
    // the option's cost (currency: 1) was reserved with the offer; choosing it charges nothing more
    const budget = st.area.gmBudget;
    st = act(w, st, { type: 'choose_option', index: 0 }).state;
    expect(st.player.currency).toBe(12);
    expect(st.area.gmBudget).toBe(budget);
  });

  it('invalid references are skipped (gm_skipped, not the player log)', () => {
    const w = testWorld();
    const s = newGame(w);
    const r = applyGmActions(s, [
      { type: 'spawn', actor: 'dragon', count: 1, near: 'player' },
      { type: 'give_item', item: 'nope', count: 1 },
      { type: 'say', actorId: 'a999', text: 'hi' },
      { type: 'effect', target: 'player', effects: [{ type: 'apply_status', status: 'ghost', duration: 2 }] },
      { type: 'reveal_item', item: 'zzz', level: 'clear' },
      { type: 'bogus' } as unknown as GmAction,
    ], env(w));
    expect(r.gmSkipped).toHaveLength(6);
    expect(r.gmSkipped!.map((x) => x.action)).toEqual(['spawn', 'give_item', 'say', 'effect', 'reveal_item', 'action']);
    expect(r.state.log.some((l) => /skipped|unknown/.test(l.text))).toBe(false);
    expect(r.state.area.gmBudget).toBe(GM_BUDGET_PER_AREA);
  });
});

describe('npc verbs', () => {
  it('talk opens a role-based dialogue; healer heals once', () => {
    const w = testWorld();
    const s = newGame(w);
    const sage = addActor(w, s, 'sage', { x: 2, y: 1 });
    player(s).hp = 5;
    const r = act(w, s, { type: 'move', dir: 'e' }); // bump = talk
    expect(r.events.some((e) => e.type === 'npc_talk' && e.actorId === sage.id)).toBe(true);
    expect(r.tookTurn).toBe(false);
    let st = r.state;
    expect(st.pendingChoice).toMatchObject({ kind: 'dialogue', prompt: 'Hello, traveller.', speakerId: sage.id });
    expect(act(w, st, { type: 'wait' }).events[0]).toMatchObject({ type: 'invalid', reason: 'make a choice first' });
    const heal = st.pendingChoice!.options.findIndex((o) => o.label === 'Ask for help');
    st = act(w, st, { type: 'choose_option', index: heal }).state;
    expect(player(st).hp).toBe(20);
    st = act(w, st, { type: 'talk', targetId: sage.id }).state;
    expect(st.pendingChoice!.options.some((o) => o.label === 'Ask for help')).toBe(false);
    st = act(w, st, { type: 'choose_option', index: st.pendingChoice!.options.length - 1 }).state;
    // already talked to: bumping now swaps places instead of re-opening the dialogue
    const sw = act(w, st, { type: 'move', dir: 'e' }).state;
    expect(player(sw).pos).toEqual({ x: 2, y: 1 });
    expect(sw.area.actors.find((a) => a.id === sage.id)!.pos).toEqual({ x: 1, y: 1 });
  });

  it('talk needs an NPC in range and the verb enabled', () => {
    const w = testWorld();
    const s = newGame(w);
    const rat = addActor(w, s, 'rat', { x: 2, y: 1 });
    const sage = addActor(w, s, 'sage', { x: 8, y: 8 });
    expect(act(w, s, { type: 'talk', targetId: rat.id }).events[0]).toMatchObject({ type: 'invalid' });
    expect(act(w, s, { type: 'talk', targetId: sage.id }).events[0]).toMatchObject({ type: 'invalid', reason: 'too far away' });
    const w2 = testWorld((x) => {
      x.verbs = { talk: false, sneak: false, search: false, persuade: false };
    });
    const s2 = newGame(w2);
    const sage2 = addActor(w2, s2, 'sage', { x: 2, y: 1 });
    expect(act(w2, s2, { type: 'talk', targetId: sage2.id }).events[0]).toMatchObject({ type: 'invalid' });
    expect(act(w2, s2, { type: 'search' }).events[0]).toMatchObject({ type: 'invalid' });
    expect(act(w2, s2, { type: 'toggle_sneak' }).events[0]).toMatchObject({ type: 'invalid' });
    expect(act(w2, s2, { type: 'persuade', targetId: sage2.id }).events[0]).toMatchObject({ type: 'invalid' });
  });

  it('persuade is a stat check that can calm a hostile', () => {
    const w = testWorld();
    let calmed = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const s = newGame(w, seed);
      const rat = addActor(w, s, 'rat', { x: 2, y: 1 }, { ai: { alerted: true } });
      const r = act(w, s, { type: 'persuade', targetId: rat.id });
      expect(r.tookTurn).toBe(true);
      if (r.state.area.actors.find((a) => a.id === rat.id)?.faction === 'neutral') calmed++;
    }
    expect(calmed).toBeGreaterThan(0);
    expect(calmed).toBeLessThan(20);
  });

  it('sneak halves notice radius; search spots ambushers', () => {
    const w = testWorld((x) => {
      x.actors[0].behaviour = { type: 'ambusher', param: 1 };
    });
    let s = newGame(w, 1, roomMap(20, 10));
    s = act(w, s, { type: 'toggle_sneak' }).state;
    expect(s.player.sneaking).toBe(true);
    const r = addActor(w, s, 'rat', { x: 3, y: 2 });
    s = act(w, s, { type: 'search' }).state;
    expect(s.area.actors.find((a) => a.id === r.id)!.ai.alerted).toBe(true);
    const w2 = testWorld();
    let q = newGame(w2, 1, roomMap(20, 10));
    q = act(w2, q, { type: 'toggle_sneak' }).state;
    const far = addActor(w2, q, 'rat', { x: 6, y: 1 }); // sight 7 → 4 while sneaking
    q = act(w2, q, { type: 'wait' }).state;
    expect(q.area.actors.find((a) => a.id === far.id)!.ai.alerted).toBe(false);
  });
});

describe('legalActions', () => {
  it('every listed action is accepted by step', () => {
    const w = testWorld();
    for (const seed of [1, 2]) {
      let s = newGame(w, seed);
      addActor(w, s, 'sage', { x: 3, y: 1 });
      addActor(w, s, 'rat', { x: 6, y: 6 });
      const ctx = ctxFor(w, s);
      for (const id of ['spark', 'wand', 'coat', 'ring', 'murk', 'key']) giveItem(ctx, id, 1);
      const rng = createRng(seed);
      for (let i = 0; i < 80 && s.status === 'playing'; i++) {
        const la = legalActions(s, env(w));
        for (const a of la) {
          const r = step(s, a, env(w));
          expect(r.events.find((e) => e.type === 'invalid'), JSON.stringify(a)).toBeUndefined();
        }
        s = step(s, la[rng.int(0, la.length - 1)], env(w)).state;
      }
    }
  });

  it('createGame without an injected map uses the map generator', () => {
    const w = testWorld();
    const s = createGame(w, { seed: 4, mapGenerator: simpleGenerator });
    expect(s.area.map.width).toBe(30);
    expect(player(s).pos).toEqual(s.area.map.start);
  });
});

describe('pending choices', () => {
  it('a perk choice and an open dialogue never deadlock (perk first, then the dialogue)', () => {
    const w = testWorld();
    let st = applyGmActions(newGame(w), [
      { type: 'offer_choice', prompt: '?', options: [{ label: 'xp', actions: [{ type: 'grant_xp', amount: 10 }] }, { label: 'no', actions: [] }] },
    ], env(w)).state;
    st = act(w, st, { type: 'choose_option', index: 0 }).state; // levels up → perk pending
    st = applyGmActions(st, [{ type: 'offer_choice', prompt: '!', options: [{ label: 'a', actions: [] }, { label: 'b', actions: [] }] }], env(w)).state;
    expect(st.player.pendingPerkChoice).not.toBeNull();
    expect(st.pendingChoice).not.toBeNull();
    const la = legalActions(st, env(w));
    expect(la.every((a) => a.type === 'choose_perk')).toBe(true);
    st = act(w, st, la[0]).state;
    expect(legalActions(st, env(w))).toEqual([{ type: 'choose_option', index: 0 }, { type: 'choose_option', index: 1 }]);
    st = act(w, st, { type: 'choose_option', index: 1 }).state;
    expect(legalActions(st, env(w)).some((a) => a.type === 'wait')).toBe(true);
  });
});
