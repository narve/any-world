/**
 * M3 gate: fixes driven by the world authors' prompt feedback (docs/progress/M3.md).
 *  - a trade inside a conversation is dropped instead of costing the whole reply (recordings had them)
 *  - GM snapshots for low_hp / death / victory look like those moments
 *  - the GM item pool keeps an unidentified item's nature secret and does not call a poison "heals"
 *  - condition-gated rule triggers are not counted as if they always fired
 *  - the prompts carry the engine facts the authors had to dig out of the source
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseWorld } from '../../src/schema/refs';
import type { WorldSpec, ItemDef, RuleVariant } from '../../src/schema/world';
import type { GameState } from '../../src/engine/types';
import { MockProvider } from '../../src/llm/mock';
import { LlmDialogue } from '../../src/llm/gm-runtime';
import { dialogueResponseErrors, dropTrades } from '../../src/llm/gm-checks';
import { playToSituation, npcsInArea, stateForHook, gmInputFor } from '../../src/llm/situation';
import { itemNature } from '../../src/llm/prompts/gm-summary';
import { worldSystemPrompt } from '../../src/llm/prompts/world';
import { gmSystemPrompt, gmUserMessage } from '../../src/llm/prompts/gm';
import { dialogueSystemPrompt } from '../../src/llm/prompts/dialogue';
import { languageInstruction } from '../../src/llm/prompts/common';
import { estimateRuleImpact, CONDITIONAL_SHARE } from '../../src/engine/balance/rules';

function fixture(name: string): WorldSpec {
  const r = parseWorld(JSON.parse(readFileSync(`content/worlds/${name}.json`, 'utf8')));
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r.world;
}
const ship = fixture('fixture-ship');

describe('trades inside a conversation', () => {
  const sit = playToSituation(ship, { seed: 5, area: 0, turnsInArea: 0 });
  const bosun = npcsInArea(ship, sit.state).find((n) => n.defId === 'bosun-kettering')!;
  // the live game: the conversation is the open choice while the NPC speaks
  const live: GameState = { ...sit.state, pendingChoice: { kind: 'dialogue', prompt: 'Bosun:', speakerId: bosun.id, options: [{ label: 'Goodbye', actions: [] }] } };
  const reply = {
    reply: 'Air, food, or trouble? I sell all three.',
    options: ['Air, please.'],
    actions: [
      { type: 'trade', actorId: 'bosun-kettering', items: [{ item: 'o2-canister', price: 10 }] },
      { type: 'set_flag', flag: 'met-bosun', value: true },
    ],
    end: false,
  };

  it('is not an error by the speaking NPC, and is dropped from the reply', async () => {
    expect(dialogueResponseErrors(ship, live, bosun.id, reply as never)).toEqual([]);
    const mock = new MockProvider({ responses: { dialogue: { json: reply } } });
    const r = await new LlmDialogue({ provider: mock, retries: 0 }).turn({ world: ship, state: live, npcId: bosun.id, difficulty: 'normal', history: [] });
    expect(r.source).toBe('llm');
    expect(r.response.reply).toBe(reply.reply);
    expect(r.response.actions.map((a) => a.type)).toEqual(['set_flag']);
  });

  it('dropTrades leaves replies without trades untouched', () => {
    const plain = { actions: [{ type: 'narrate', text: 'x' }] } as never as { actions: [] };
    expect(dropTrades(plain)).toBe(plain);
  });

  it('a trade by someone else is still an error', () => {
    const bad = { ...reply, actions: [{ type: 'trade', actorId: 'sister-ula', items: [{ item: 'o2-canister', price: 1 }] }] };
    expect(dialogueResponseErrors(ship, live, bosun.id, bad as never).join('\n')).toContain('trade');
  });
});

describe('hook-shaped GM snapshots', () => {
  const sit = playToSituation(ship, { seed: 5, area: 0, turnsInArea: 5 });
  const hpOf = (s: GameState) => s.area.actors.find((a) => a.id === s.player.actorId)!;

  it('low_hp shows a badly hurt player; death and victory show the run ended', () => {
    const low = stateForHook(sit, 'low_hp');
    expect(hpOf(low).hp).toBeLessThanOrEqual(Math.ceil(hpOf(low).maxHp * 0.25));
    expect(hpOf(low).hp).toBeGreaterThan(0);
    expect(stateForHook(sit, 'death').status).toBe('lost');
    expect(hpOf(stateForHook(sit, 'death')).hp).toBe(0);
    expect(stateForHook(sit, 'victory').status).toBe('won');
  });

  it('other hooks and the source snapshot are untouched', () => {
    const before = JSON.stringify(sit.state);
    stateForHook(sit, 'death');
    expect(JSON.stringify(sit.state)).toBe(before);
    expect(stateForHook(sit, 'idle')).toBe(sit.state);
    expect(gmUserMessage(gmInputFor(ship, sit, 'victory'))).toContain('"status":"won"');
  });
});

describe('GM item pool', () => {
  const base = ship.items.find((i) => i.onUse && i.onUse.effects.some((e) => e.type === 'heal'))!;
  const harm = ship.statuses.find((s) => s.harmful)!;
  it('a heal with a harmful side effect is mixed, not "heals"', () => {
    const mixed: ItemDef = { ...base, onUse: { ...base.onUse!, effects: [...base.onUse!.effects, { type: 'apply_status', status: harm.id, duration: 5 }] } };
    expect(itemNature(ship, base)).toBe('heals');
    expect(itemNature(ship, mixed)).toContain('mixed');
  });
});

describe('rule impact of condition-gated triggers', () => {
  it('counts a gated trigger at a fraction of an ungated one', () => {
    const effect = { type: 'damage', amount: { base: 2 } } as const;
    const open: RuleVariant = { id: 'r', name: 'R', description: 'd', playerTriggers: [{ on: 'on_turn', every: 5, chance: 1, action: { targeting: { shape: 'self', affects: 'self_only', range: 0 }, effects: [effect] } }] } as never;
    const gated: RuleVariant = { ...open, playerTriggers: [{ ...open.playerTriggers![0]!, action: { ...open.playerTriggers![0]!.action, condition: { type: 'flag', flag: 'x' } } }] } as never;
    const a = estimateRuleImpact(ship, open).hpPer100;
    const b = estimateRuleImpact(ship, gated).hpPer100;
    expect(a).toBeGreaterThan(0);
    expect(b).toBeCloseTo(a * CONDITIONAL_SHARE, 5);
  });
});

describe('prompts carry the engine facts authors asked for', () => {
  const world = worldSystemPrompt('en');
  it('world prompt', () => {
    for (const s of [
      'goal.labels',
      'onEmpty runs when the resource reaches 0',
      'perTurn may be fractional',
      'the other party is the target',
      'a kiter needs open ground',
      'quest_giver hands over the first item',
      'A persuaded actor is not defeated',
      'any density > 0 gives at least one tile',
      'onStand runs every turn',
      'color is the dark base',
      '"guarded" puts the item within 2 tiles',
      'cost effort inside the last area',
      '700–1100 turns',
      'meta.tagline ≤140',
      'never only made by spawn_item',
    ]) {
      expect(world, s).toContain(s);
    }
    // the shape example is no longer an abstract painting
    expect(world).not.toMatch(/Smudge Hound|Fixative Drop/);
  });

  it('GM prompt: def ids, secret item natures, allowed actions per hook', () => {
    const gm = gmSystemPrompt(ship, 'normal');
    expect(gm).toContain('prefer the def id');
    expect(gm).toContain('never name or hint at it');
    expect(gm).toContain('intro, death and victory take only narrate, say and mood');
  });

  it('dialogue prompt: no trade action, buttons come from the game', () => {
    const d = dialogueSystemPrompt(ship, 'normal');
    expect(d).toContain('Do not use trade');
    expect(d).toContain('The game builds the player');
  });

  it('bokmål register', () => {
    expect(languageInstruction('nb')).toContain('"du"');
    expect(languageInstruction('en')).not.toContain('"du"');
  });
});
