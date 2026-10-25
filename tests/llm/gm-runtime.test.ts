import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseWorld } from '../../src/schema/refs';
import type { WorldSpec } from '../../src/schema/world';
import type { GmAction, GmHook, GmResponse } from '../../src/schema/gm';
import { MockProvider } from '../../src/llm/mock';
import { LLMServerError } from '../../src/llm/errors';
import type { LLMProvider } from '../../src/llm/types';
import { LlmGmDirector, LlmDialogue, createDemoGm, offlineDialogueTurn } from '../../src/llm/gm-runtime';
import { isHelpfulAction, applyHelpCeiling, gmActionProblems, gmResponseErrors, dialogueResponseErrors } from '../../src/llm/gm-checks';
import { gmPurpose, dialoguePurpose } from '../../src/llm/recording-keys';
import { playToSituation, npcsInArea, type Situation } from '../../src/llm/situation';
import type { GmRequest } from '../../src/client/gm-director';

function fixture(name: string): WorldSpec {
  const r = parseWorld(JSON.parse(readFileSync(`content/worlds/${name}.json`, 'utf8')));
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r.world;
}

const ship = fixture('fixture-ship');
const teen = fixture('fixture-teen');
const sit: Situation = playToSituation(ship, { seed: 5, area: 0, turnsInArea: 20 });

function request(hook: GmHook, s: Situation = sit, world: WorldSpec = ship, signal = new AbortController().signal): GmRequest {
  return {
    id: 1,
    hook,
    area: s.state.area.index,
    turn: s.state.turn,
    signal,
    ctx: { world, state: s.state, difficulty: s.difficulty, weirdness: 0.5, recentLog: s.recentLog, areaEnteredTurn: s.areaEnteredTurn },
  };
}

const heal = ship.items.find((i) => i.onUse?.effects.some((e) => e.type === 'heal'))!.id;
const hostile = ship.actors.find((a) => (a.faction ?? 'hostile') === 'hostile' && !a.npc && !a.unique)!.id;

describe('LlmGmDirector', () => {
  it('answers with the model\'s valid actions; scoped purpose; schema attached without prompt duplication', async () => {
    const resp: GmResponse = { actions: [{ type: 'narrate', text: 'The moss leans.' }, { type: 'mood', music: 'eerie' }] };
    const mock = new MockProvider({ responses: { 'gm:area_enter': { json: resp } } });
    const d = new LlmGmDirector({ provider: mock, worldKey: 'fixture-ship' });
    const r = await d.respond(request('area_enter'));
    expect(r).toEqual(resp);
    const req = mock.calls[0]!;
    expect(req.purpose).toBe(gmPurpose('area_enter', 'fixture-ship', 0));
    expect(req.purpose).toBe('gm:area_enter/fixture-ship/a0');
    expect(req.schemaInPrompt).toBe(false);
    expect(req.jsonSchema).toBeTruthy();
    expect(req.messages[0]!.content).toContain('HOOK: area_enter');
  });

  it('engine refusals go back to the model for one repair turn', async () => {
    const bad = { actions: [{ type: 'give_item', item: 'no-such-item' }] };
    const good = { actions: [{ type: 'narrate', text: 'A hatch sighs open.' }] };
    const mock = new MockProvider({ responses: { gm: [{ json: bad }, { json: good }] } });
    const r = await new LlmGmDirector({ provider: mock }).respond(request('idle'));
    expect(r).toEqual(good);
    expect(mock.calls).toHaveLength(2);
    const repair = mock.calls[1]!.messages.at(-1)!.content;
    expect(repair).toContain('actions[0] (give_item): refused by the engine');
  });

  it('keeps the valid part of a reply that stays invalid', async () => {
    const bad = { actions: [{ type: 'narrate', text: 'Still here.' }, { type: 'spawn', actor: 'no-such-actor' }] };
    const errors: unknown[] = [];
    const mock = new MockProvider({ responses: { gm: { json: bad } } });
    const r = await new LlmGmDirector({ provider: mock, onError: (e) => errors.push(e) }).respond(request('idle'));
    expect(r).toEqual({ actions: [{ type: 'narrate', text: 'Still here.' }] });
    expect(errors).toHaveLength(1);
  });

  it('falls back to the offline director when the provider fails', async () => {
    const failing: LLMProvider = { id: 'down', model: 'x', complete: async () => Promise.reject(new LLMServerError('503')) };
    const s0 = playToSituation(ship, { seed: 5, area: 0, turnsInArea: 0 });
    const r = await new LlmGmDirector({ provider: failing }).respond(request('intro', s0));
    expect(r).toEqual({ actions: [{ type: 'narrate', text: ship.gm.fallback.intro }] });
    // no fallback configured: nothing
    expect(await new LlmGmDirector({ provider: failing, fallback: null }).respond(request('intro', s0))).toBeNull();
  });

  it('returns null when aborted (the runner dropped the request)', async () => {
    const mock = new MockProvider({ responses: { gm: { json: { actions: [{ type: 'narrate', text: 'late' }] } } }, latencyMs: 500 });
    const ctrl = new AbortController();
    const p = new LlmGmDirector({ provider: mock }).respond(request('idle', sit, ship, ctrl.signal));
    setTimeout(() => ctrl.abort(), 10);
    expect(await p).toBeNull();
  });

  it('enforces the help ceiling per area across requests', async () => {
    const gifts: GmAction[] = [
      { type: 'give_item', item: heal, count: 1 },
      { type: 'grant_xp', amount: 5 },
      { type: 'currency', amount: 5 },
      { type: 'narrate', text: 'Gifts rain down.' },
    ];
    const mock = new MockProvider({ responses: { gm: { json: { actions: gifts } } } });
    const d = new LlmGmDirector({ provider: mock });
    const r1 = await d.respond(request('milestone'));
    // normal: at most 2 helpful actions per area
    expect(r1!.actions.map((a) => a.type)).toEqual(['give_item', 'grant_xp', 'narrate']);
    expect(mock.calls[0]!.messages[0]!.content).toContain('HELP USED this area: 0 of 2');
    const r2 = await d.respond(request('idle'));
    expect(r2!.actions.map((a) => a.type)).toEqual(['narrate']);
    expect(mock.calls[1]!.messages[0]!.content).toContain('HELP USED this area: 2 of 2 (used up');
  });

  it('death and victory hooks allow words only', async () => {
    const reply = { actions: [{ type: 'narrate', text: 'Here lies Ines.' }, { type: 'grant_xp', amount: 10 }] };
    const mock = new MockProvider({ responses: { gm: { json: reply } } });
    const r = await new LlmGmDirector({ provider: mock, retries: 0 }).respond(request('death'));
    expect(r).toEqual({ actions: [{ type: 'narrate', text: 'Here lies Ines.' }] });
  });

  it('an empty answer is "nothing to add"', async () => {
    const mock = new MockProvider({ responses: { gm: { json: { actions: [] } } } });
    expect(await new LlmGmDirector({ provider: mock }).respond(request('region_discovered'))).toBeNull();
  });
});

describe('GM checks', () => {
  it('classifies helpful actions', () => {
    expect(isHelpfulAction(ship, { type: 'give_item', item: heal, count: 1 })).toBe(true);
    expect(isHelpfulAction(ship, { type: 'grant_xp', amount: 3 })).toBe(true);
    expect(isHelpfulAction(ship, { type: 'currency', amount: -5 })).toBe(false);
    expect(isHelpfulAction(ship, { type: 'spawn', actor: hostile, count: 1, near: 'random' })).toBe(false);
    expect(isHelpfulAction(ship, { type: 'effect', target: 'player', effects: [{ type: 'heal', amount: { base: 5 } }] })).toBe(true);
    expect(isHelpfulAction(ship, { type: 'effect', target: 'nearest_enemy', effects: [{ type: 'damage', amount: { base: 5 }, damageType: 'physical' }] })).toBe(true);
    expect(
      isHelpfulAction(ship, {
        type: 'offer_choice',
        prompt: '?',
        options: [
          { label: 'a', actions: [{ type: 'grant_xp', amount: 2 }] },
          { label: 'b', actions: [] },
        ],
      }),
    ).toBe(true);
    const regen = { id: 'r', name: 'R', description: 'd', playerTriggers: [{ on: 'on_turn' as const, every: 5, chance: 1, action: { targeting: { shape: 'self' as const, range: 0, radius: 0, affects: 'self_only' as const, needsLos: true }, effects: [{ type: 'heal' as const, amount: { base: 2 } }] } }], switches: {} };
    expect(isHelpfulAction(ship, { type: 'add_rule', rule: regen, reason: 'x' })).toBe(true);
  });

  it('applyHelpCeiling keeps non-helpful actions and the first helpful ones', () => {
    const acts: GmAction[] = [{ type: 'grant_xp', amount: 1 }, { type: 'narrate', text: 'n' }, { type: 'grant_xp', amount: 2 }];
    expect(applyHelpCeiling(ship, acts, 1)).toEqual({ actions: [acts[0], acts[1]], used: 1 });
    expect(applyHelpCeiling(ship, acts, 0).actions).toEqual([acts[1]]);
  });

  it('dry-runs actions against the snapshot with accumulating budget', () => {
    const spawn: GmAction = { type: 'spawn', actor: hostile, count: 1, near: 'random' };
    // budget 10, spawn costs 3: the 4th spawn is over budget
    const probs = gmActionProblems(ship, sit.state, [spawn, spawn, spawn, spawn]);
    expect(probs.map((p) => p.index)).toEqual([3]);
    expect(probs[0]!.message).toMatch(/^actions\[3\] \(spawn\): refused by the engine/);
    expect(gmResponseErrors(ship, sit.state, { actions: [{ type: 'mood', music: 'calm' }] }, 'victory')).toEqual([]);
    expect(gmResponseErrors(ship, sit.state, { actions: [spawn] }, 'intro')[0]).toContain('allows only narrate, say and mood');
  });
});

describe('LlmDialogue', () => {
  const s = playToSituation(teen, { seed: 1, area: 0, turnsInArea: 0 });
  const npc = npcsInArea(teen, s.state)[0]!;
  const def = teen.actors.find((a) => a.id === npc.defId)!;
  const input = { world: teen, state: s.state, npcId: npc.id, difficulty: 'normal' as const, history: [], playerLine: '' };

  it('one in-character turn, scoped purpose', async () => {
    const reply = { reply: 'Mind the wet floor.', options: ['What happened here?', 'Bye.'], actions: [], end: false };
    const mock = new MockProvider({ responses: { dialogue: { json: reply } } });
    const r = await new LlmDialogue({ provider: mock, worldKey: 'fixture-teen' }).turn(input);
    expect(r).toEqual({ response: reply, source: 'llm' });
    expect(mock.calls[0]!.purpose).toBe(dialoguePurpose('fixture-teen', def.id));
  });

  it('repairs a trade with the wrong actor, then falls back to canned lines when the model keeps failing', async () => {
    const bad = { reply: 'Here.', options: [], actions: [{ type: 'trade', actorId: 'zz99', items: [] }] };
    expect(dialogueResponseErrors(teen, s.state, npc.id, { reply: 'x', options: ['a'], actions: [], end: true })).toContain('options: must be empty when end is true');
    const mock = new MockProvider({ responses: { dialogue: [{ json: bad }, { text: 'not json' }] } });
    const r = await new LlmDialogue({ provider: mock }).turn(input);
    expect(mock.calls).toHaveLength(2);
    expect(mock.calls[1]!.messages.at(-1)!.content).toContain('trade');
    expect(r.source).toBe('offline');
    expect(r.response.reply).toBe(def.npc!.greeting);
  });

  it('offline turns walk the greeting and lines, then end', () => {
    const lines = [def.npc!.greeting, ...def.npc!.lines];
    const history: { speaker: 'npc' | 'player'; text: string }[] = [];
    for (const l of lines) {
      const t = offlineDialogueTurn({ ...input, history });
      expect(t.reply).toBe(l);
      expect(t.end).toBe(false);
      history.push({ speaker: 'npc', text: t.reply });
    }
    expect(offlineDialogueTurn({ ...input, history }).end).toBe(true);
  });
});

describe('demo mode (recordings)', () => {
  it('serves each recorded moment once, then the offline director answers', async () => {
    const recorded = { actions: [{ type: 'narrate', text: 'RECORDED: the moss turns to watch you.' }] };
    const s0 = playToSituation(ship, { seed: 5, area: 0, turnsInArea: 0 });
    const { director, provider } = createDemoGm({
      worldKey: 'fixture-ship',
      recordings: [
        { purpose: 'gm:intro/fixture-ship/a0', json: recorded },
        { purpose: 'gm:intro/other-world/a0', json: { actions: [{ type: 'narrate', text: 'WRONG WORLD' }] } },
      ],
    });
    expect(await director.respond(request('intro', s0))).toEqual(recorded);
    // second time: the recording is used up, the offline intro answers
    expect(await director.respond(request('intro', s0))).toEqual({ actions: [{ type: 'narrate', text: ship.gm.fallback.intro }] });
    // a moment without any recording never borrows another world's or another moment's
    const r = await director.respond(request('area_enter', s0));
    expect(JSON.stringify(r)).not.toContain('RECORDED');
    expect(JSON.stringify(r)).not.toContain('WRONG WORLD');
    expect(provider.callCount).toBe(3);
  });

  it('demo dialogue replays recorded turns in order, then canned lines', async () => {
    const s = playToSituation(teen, { seed: 1, area: 0, turnsInArea: 0 });
    const npc = npcsInArea(teen, s.state)[0]!;
    const purpose = dialoguePurpose('fixture-teen', npc.defId);
    const { dialogue } = createDemoGm({
      worldKey: 'fixture-teen',
      recordings: [
        { purpose, json: { reply: 'Turn one.', options: ['Go on'] } },
        { purpose, json: { reply: 'Turn two.', options: [], end: true } },
      ],
    });
    const input = { world: teen, state: s.state, npcId: npc.id, difficulty: 'normal' as const };
    expect((await dialogue.turn(input)).response.reply).toBe('Turn one.');
    expect((await dialogue.turn(input)).response).toMatchObject({ reply: 'Turn two.', end: true });
    const third = await dialogue.turn(input);
    expect(third.source).toBe('offline');
  });
});

describe('demo mode with the bundled recordings', () => {
  it('the ship intro comes from content/recordings/fixture-ship', async () => {
    const { loadRecordingsFromDir } = await import('../../src/llm/recordings-node');
    const recordings = await loadRecordingsFromDir('content/recordings', { worldKey: 'fixture-ship' });
    const { director } = createDemoGm({ worldKey: 'fixture-ship', recordings });
    const s0 = playToSituation(ship, { seed: 9, area: 0, turnsInArea: 0 });
    const r = await director.respond(request('intro', s0));
    expect(r!.actions[0]).toMatchObject({ type: 'narrate', text: expect.stringContaining('Year two hundred and eleven') });
  });
});
