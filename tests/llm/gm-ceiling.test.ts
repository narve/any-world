/**
 * Regression tests for review M5 round 1 (issues/M5-gm-*.md): the LLM GM's per-area help ceiling
 * could be bypassed (offline fallback, runner timeout, unclassified help), and GM / NPC answers
 * could win, lose or unlock by writing the goal's flags / counters or handing out goal items.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseWorld } from '../../src/schema/refs';
import type { WorldSpec } from '../../src/schema/world';
import type { GmAction, GmHook } from '../../src/schema/gm';
import { LlmGmDirector, HelpLedger, CappedGmDirector } from '../../src/llm/gm-runtime';
import { isHelpfulAction, goalWriteProblem, gmActionProblems, dialogueResponseErrors, applyHelpCeiling } from '../../src/llm/gm-checks';
import { goalRefs } from '../../src/llm/goal-refs';
import { gmSystemPrompt } from '../../src/llm/prompts/gm';
import { dialogueSystemPrompt } from '../../src/llm/prompts/dialogue';
import { MockProvider } from '../../src/llm/mock';
import { applyGmActions } from '../../src/engine/index';
import type { GmDirector } from '../../src/client/gm-director';
import { HELPFUL_CEILING } from '../../src/llm/prompts/gm';
import { LLMServerError } from '../../src/llm/errors';
import type { LLMProvider } from '../../src/llm/types';
import { playToSituation, type Situation } from '../../src/llm/situation';
import type { GmRequest } from '../../src/client/gm-director';

function fixture(name: string): WorldSpec {
  const r = parseWorld(JSON.parse(readFileSync(`content/worlds/${name}.json`, 'utf8')));
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r.world;
}

const ship = fixture('fixture-ship');

function request(hook: GmHook, s: Situation, world: WorldSpec = ship): GmRequest {
  return {
    id: 1,
    hook,
    area: s.state.area.index,
    turn: s.state.turn,
    signal: new AbortController().signal,
    ctx: { world, state: s.state, difficulty: s.difficulty, weirdness: 0.5, recentLog: s.recentLog, areaEnteredTurn: s.areaEnteredTurn },
  };
}

const failing: LLMProvider = { id: 'down', model: 'x', complete: async () => Promise.reject(new LLMServerError('503')) };

describe('help ceiling: offline fallback answers are not capped', () => {
  it('a model failure after the area ceiling is used up must not hand out more help through the fallback', async () => {
    let checked = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const sit = playToSituation(ship, { seed, area: 0, turnsInArea: 20 });
      if (sit.state.status !== 'playing') continue;
      const ledger = new HelpLedger();
      // the LLM already used the whole ceiling in this area
      ledger.add(sit.state, HELPFUL_CEILING[sit.difficulty] ?? 2);
      const d = new LlmGmDirector({ provider: failing, ledger, onError: () => undefined });
      const r = await d.respond(request('idle', sit));
      if (!r) continue;
      checked++;
      const helpful = r.actions.filter((a) => isHelpfulAction(ship, a));
      expect(helpful, `seed ${seed}: fallback answered ${JSON.stringify(r.actions.map((a) => a.type))} past the ceiling`).toEqual([]);
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe('help ceiling: helpful actions that are not classified as helpful', () => {
  const enemyHit: GmAction = { type: 'effect', target: 'all_visible_enemies', effects: [{ type: 'damage', amount: { base: 40 }, damageType: 'physical' } as never] };
  const nearestHit: GmAction = { type: 'effect', target: 'nearest_enemy', effects: [{ type: 'damage', amount: { base: 40 }, damageType: 'physical' } as never] };

  it('damaging every visible enemy helps the player', () => {
    expect(isHelpfulAction(ship, enemyHit)).toBe(true);
  });

  it('damaging the nearest enemy helps the player', () => {
    expect(isHelpfulAction(ship, nearestHit)).toBe(true);
  });

  it('turning a hostile actor friendly helps the player', () => {
    expect(isHelpfulAction(ship, { type: 'change_faction', actorId: 'a1', faction: 'friendly' })).toBe(true);
  });
});

describe('GM answers that complete the world goal', () => {
  it('an idle-hook GM answer in area 1 cannot win the run by setting the goal flag', async () => {
    const teen = fixture('fixture-teen');
    const sit = playToSituation(teen, { seed: 3, area: 0, turnsInArea: 10 });
    expect(sit.state.status).toBe('playing');
    // the goal: { any: [ flag speech-delivered, … ] }; a single GM action satisfies it
    const mock = new MockProvider({ responses: { gm: { json: { actions: [{ type: 'set_flag', flag: 'speech-delivered', value: true }] } } } });
    const d = new LlmGmDirector({ provider: mock, onError: () => undefined });
    const r = await d.respond(request('idle', sit, teen));
    const after = r ? applyGmActions(sit.state, r.actions, { world: teen }).state : sit.state;
    expect(after.status).toBe('playing');
  });
});

const teen = fixture('fixture-teen');
const teenSit = playToSituation(teen, { seed: 3, area: 0, turnsInArea: 10 });

describe('goal protection', () => {
  it('collects the goal and lock references', () => {
    const r = goalRefs(teen);
    expect([...r.flags]).toContain('speech-delivered');
    expect([...r.counters]).toContain('detentions');
    expect([...r.items]).toContain('speech-notebook');
  });

  it('refuses goal writes in every shape, and leaves ordinary ones alone', () => {
    const bad: GmAction[] = [
      { type: 'set_flag', flag: 'speech-delivered', value: true },
      { type: 'set_flag', flag: 'speech-delivered', value: false },
      { type: 'effect', target: 'player', effects: [{ type: 'counter', counter: 'detentions', add: 3 }] },
      { type: 'effect', target: 'player', effects: [{ type: 'set_flag', flag: 'speech-delivered', value: true }] },
      { type: 'give_item', item: 'speech-notebook', count: 1 },
      { type: 'place_item', item: 'speech-notebook', near: 'player' },
      { type: 'effect', target: 'player', effects: [{ type: 'spawn_item', item: 'speech-notebook', count: 1 }] },
      { type: 'start_quest', id: 'q', title: 't', description: 'd', complete: { type: 'flag', flag: 'x' } as never, reward: [{ type: 'give_item', item: 'speech-notebook' }] },
      { type: 'offer_choice', prompt: '?', options: [{ label: 'a', actions: [{ type: 'set_flag', flag: 'speech-delivered', value: true }] }, { label: 'b', actions: [] }] },
      {
        type: 'add_rule',
        reason: 'r',
        rule: { id: 'r', name: 'R', description: 'd', playerTriggers: [{ on: 'on_turn', chance: 1, action: { targeting: { shape: 'self', range: 0, radius: 0, affects: 'self_only', needsLos: true }, effects: [{ type: 'counter', counter: 'detentions', add: 1 }] } }], switches: {} },
      },
      { type: 'add_rule', reason: 'r', rule: { id: 'r2', name: 'R', description: 'd', playerTriggers: [], switches: { violenceCounter: 'detentions' } } },
    ];
    for (const a of bad) expect(goalWriteProblem(teen, a), JSON.stringify(a)).toMatch(/goal or an area lock/);
    expect(goalWriteProblem(teen, { type: 'set_flag', flag: 'gm_event_area_0', value: true })).toBeNull();
    expect(goalWriteProblem(teen, { type: 'narrate', text: 'x' })).toBeNull();
    const probs = gmActionProblems(teen, teenSit.state, [{ type: 'narrate', text: 'n' }, bad[0]!]);
    expect(probs.map((p) => p.index)).toEqual([1]);
    expect(probs[0]!.message).toMatch(/^actions\[1\] \(set_flag\): refused: flag "speech-delivered"/);
  });

  it('a GM that insists on the goal flag gets a repair turn, then only its harmless actions are kept', async () => {
    const mock = new MockProvider({ responses: { gm: { json: { actions: [{ type: 'narrate', text: 'The hall hushes.' }, { type: 'set_flag', flag: 'speech-delivered', value: true }] } } } });
    const r = await new LlmGmDirector({ provider: mock, onError: () => undefined }).respond(request('idle', teenSit, teen));
    expect(mock.calls).toHaveLength(2);
    expect(mock.calls[1]!.messages.at(-1)!.content).toContain('flag "speech-delivered"');
    expect(r).toEqual({ actions: [{ type: 'narrate', text: 'The hall hushes.' }] });
  });

  it('a GM answer cannot force a loss through the goal counter', async () => {
    const mock = new MockProvider({ responses: { gm: { json: { actions: [{ type: 'effect', target: 'player', effects: [{ type: 'counter', counter: 'detentions', add: 5 }] }] } } } });
    const r = await new LlmGmDirector({ provider: mock, onError: () => undefined }).respond(request('idle', teenSit, teen));
    const after = r ? applyGmActions(teenSit.state, r.actions, { world: teen }).state : teenSit.state;
    expect(after.status).toBe('playing');
  });

  it('dialogue: goal writes are refused, but the speaking NPC may hand over its own stock', () => {
    const npc = teenSit.state.area.actors.find((a) => teen.actors.find((d) => d.id === a.defId)?.npc);
    expect(npc).toBeTruthy();
    if (!npc) return;
    const reply = { reply: 'Fine.', options: [], end: false };
    expect(dialogueResponseErrors(teen, teenSit.state, npc.id, { ...reply, actions: [{ type: 'set_flag', flag: 'speech-delivered', value: true }] }).join('\n')).toContain('speech-delivered');
    // a world whose NPC stocks a lock item: that NPC may give it, the GM may not
    const def = teen.actors.find((d) => d.id === npc.defId)!;
    const world: WorldSpec = { ...teen, actors: teen.actors.map((d) => (d === def ? { ...d, npc: { ...d.npc!, stock: [...d.npc!.stock, 'speech-notebook'] } } : d)) };
    const give: GmAction = { type: 'give_item', item: 'speech-notebook', count: 1 };
    expect(dialogueResponseErrors(world, teenSit.state, npc.id, { ...reply, actions: [give] }).filter((e) => e.includes('goal'))).toEqual([]);
    expect(goalWriteProblem(world, give)).not.toBeNull();
  });

  it('the GM and dialogue prompts list what is protected', () => {
    const gm = gmSystemPrompt(teen, 'normal');
    expect(gm).toContain('"speech-delivered"');
    expect(gm).toContain('"detentions"');
    expect(gm).toContain('"speech-notebook"');
    expect(dialogueSystemPrompt(teen, 'normal')).toContain("speaking NPC's own stock");
  });
});

describe('help ceiling: the runner timeout path', () => {
  it('past its deadline the director answers through the capped fallback', async () => {
    const hanging: LLMProvider = {
      id: 'slow',
      model: 'x',
      complete: (req) =>
        new Promise((_, reject) => req.signal?.addEventListener('abort', () => reject(new (class extends Error {})('aborted')), { once: true })),
    };
    const gifts: GmDirector = { name: 'gifts', respond: async () => ({ actions: [{ type: 'grant_xp', amount: 5 }, { type: 'grant_xp', amount: 6 }, { type: 'grant_xp', amount: 7 }, { type: 'narrate', text: 'n' }] }) };
    const sit = playToSituation(ship, { seed: 5, area: 0, turnsInArea: 20 });
    const d = new LlmGmDirector({ provider: hanging, fallback: gifts, deadlineMs: 20, onError: () => undefined });
    const r = await d.respond(request('idle', sit));
    const ceiling = HELPFUL_CEILING[sit.difficulty] ?? 2;
    expect(r!.actions.filter((a) => isHelpfulAction(ship, a))).toHaveLength(Math.min(ceiling, 3));
    expect(d.ledger.get(sit.state)).toBe(Math.min(ceiling, 3));
  });

  it('a CappedGmDirector sharing the ledger caps the runner\'s own fallback', async () => {
    const sit = playToSituation(ship, { seed: 5, area: 0, turnsInArea: 20 });
    const ledger = new HelpLedger();
    ledger.add(sit.state, 5);
    const gifts: GmDirector = { name: 'gifts', respond: async () => ({ actions: [{ type: 'grant_xp', amount: 5 }, { type: 'narrate', text: 'n' }] }) };
    const llm = new LlmGmDirector({ provider: failing, ledger });
    const capped = llm.capped(gifts);
    expect(capped).toBeInstanceOf(CappedGmDirector);
    expect(capped.name).toBe('gifts');
    expect(await capped.respond(request('idle', sit))).toEqual({ actions: [{ type: 'narrate', text: 'n' }] });
    expect(llm.capped(capped)).toBe(capped);
  });
});

describe('help classification with state', () => {
  it('change_faction counts only when the actor is hostile now', () => {
    const sit = playToSituation(ship, { seed: 5, area: 0, turnsInArea: 0 });
    const hostile = sit.state.area.actors.find((a) => a.faction === 'hostile' && a.hp > 0);
    const calm = sit.state.area.actors.find((a) => a.faction !== 'hostile' && a.hp > 0 && a.faction !== 'player');
    expect(hostile).toBeTruthy();
    if (hostile) expect(isHelpfulAction(ship, { type: 'change_faction', actorId: hostile.id, faction: 'neutral' }, sit.state)).toBe(true);
    if (calm) expect(isHelpfulAction(ship, { type: 'change_faction', actorId: calm.id, faction: 'friendly' }, sit.state)).toBe(false);
    expect(isHelpfulAction(ship, { type: 'change_faction', actorId: 'a1', faction: 'hostile' })).toBe(false);
  });

  it('quests with rewards, allies and weakening enemies count; empty quests and enemy buffs do not', () => {
    const quest = (reward: never[]): GmAction => ({ type: 'start_quest', id: 'q', title: 't', description: 'd', complete: { type: 'flag', flag: 'x' } as never, reward });
    expect(isHelpfulAction(ship, quest([{ type: 'grant_xp', amount: 10 }] as never[]))).toBe(true);
    expect(isHelpfulAction(ship, quest([]))).toBe(false);
    expect(isHelpfulAction(ship, { type: 'effect', target: 'nearest_enemy', effects: [{ type: 'modify_stat', stat: 'str', amount: -2 } as never] })).toBe(true);
    expect(isHelpfulAction(ship, { type: 'effect', target: 'nearest_enemy', effects: [{ type: 'heal', amount: { base: 5 } }] })).toBe(false);
    const ally = ship.actors.find((a) => a.faction === 'friendly' && !a.npc);
    if (ally) expect(isHelpfulAction(ship, { type: 'spawn', actor: ally.id, count: 1, near: 'player' })).toBe(true);
    // an offer that pacifies counts against the ceiling too
    const acts: GmAction[] = [{ type: 'change_faction', actorId: 'a1', faction: 'friendly' }, { type: 'grant_xp', amount: 1 }];
    expect(applyHelpCeiling(ship, acts, 1).actions).toEqual([acts[0]]);
  });
});

