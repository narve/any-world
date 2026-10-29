/**
 * Frozen hashes of single player's prompts and schemas (docs/progress/MP4-DESIGN.md §8 G1).
 *
 * MP4 adds party text, a room-only `player` field and a room-only `chat` hook to the GM prompts;
 * none of it may reach single player. These hashes pin the exact text single player sends today:
 * the GM system prompt, the GM user message per hook, gmJsonSchema, GM_SCHEMA_DOC, the dialogue
 * prompts and the world prompts, and the whole requests LlmGmDirector / LlmDialogue send. A change
 * here is a change to single player's AI behaviour (and to the request hashes of its recordings):
 * only update a hash on purpose, never to make a party change pass.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import type { WorldSpec } from '../../src/schema/world';
import type { GmHook } from '../../src/schema/gm';
import { parseWorld } from '../../src/schema/refs';
import { fnv1a64, requestHash, stableStringify } from '../../src/llm/hash';
import { GM_SCHEMA_DOC, DIALOGUE_SCHEMA_DOC } from '../../src/llm/prompts/world-schema';
import { gmSystemPrompt, gmUserMessage } from '../../src/llm/prompts/gm';
import { buildDialoguePrompt } from '../../src/llm/prompts/dialogue';
import { worldSystemPrompt, worldUserMessage } from '../../src/llm/prompts/world';
import { gmInputFor, dialogueInputFor, playToSituation, npcsInArea } from '../../src/llm/situation';
import { dialogueJsonSchema, gmJsonSchema } from '../../src/llm/gm-checks';
import { LlmDialogue, LlmGmDirector } from '../../src/llm/gm-runtime';
import { MockProvider } from '../../src/llm/mock';
import type { CompletionRequest } from '../../src/llm/types';

function fixture(name: string): WorldSpec {
  const r = parseWorld(JSON.parse(readFileSync(`content/worlds/${name}.json`, 'utf8')));
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r.world;
}

const h = (text: string) => fnv1a64(text);

/** compares with the frozen value; FROZEN_PRINT=1 prints the current values instead (a deliberate update) */
function frozen(name: keyof typeof FROZEN, value: unknown): void {
  if (process.env.FROZEN_PRINT) process.stderr.write(`  ${name}: ${JSON.stringify(value)},\n`);
  else expect(value, name).toEqual(FROZEN[name]);
}

const SP_HOOKS: GmHook[] = ['intro', 'area_enter', 'region_discovered', 'low_hp', 'boss_seen', 'milestone', 'idle', 'death', 'victory'];

describe('frozen single-player prompts (MP4 G1)', () => {
  const ship = fixture('fixture-ship');
  const teen = fixture('fixture-teen');
  const sit = playToSituation(ship, { seed: 3, area: 0, turnsInArea: 25 });
  const sit1 = playToSituation(ship, { seed: 5, area: 1, turnsInArea: 4, difficulty: 'gentle' });

  it('schemas and schema docs', () => {
    frozen('schemas', {
      gmJsonSchema: h(stableStringify(gmJsonSchema())),
      dialogueJsonSchema: h(stableStringify(dialogueJsonSchema())),
      GM_SCHEMA_DOC: h(GM_SCHEMA_DOC),
      DIALOGUE_SCHEMA_DOC: h(DIALOGUE_SCHEMA_DOC),
    });
  });

  it('GM system prompt', () => {
    const nb: WorldSpec = { ...ship, meta: { ...ship.meta, language: 'nb' } };
    frozen('gmSystem', {
      shipNormal: h(gmSystemPrompt(ship, 'normal')),
      shipGentle: h(gmSystemPrompt(ship, 'gentle')),
      teenHard: h(gmSystemPrompt(teen, 'hard')),
      nbBrutal: h(gmSystemPrompt(nb, 'brutal')),
    });
  });

  it('GM user message for every single-player hook', () => {
    const out: Record<string, string> = {};
    for (const hook of SP_HOOKS) out[hook] = h(gmUserMessage(gmInputFor(ship, sit, hook, { helpfulUsed: hook === 'idle' ? 2 : 0 })));
    out['area1_gentle_detail'] = h(gmUserMessage(gmInputFor(ship, sit1, 'milestone', { detail: { reason: 'level_up', level: 2 }, weirdness: 0.8 })));
    frozen('gmUser', out);
  });

  it('dialogue prompts', () => {
    const s2 = playToSituation(teen, { seed: 1, area: 0, turnsInArea: 0 });
    const npc = npcsInArea(teen, s2.state)[0]!;
    const open = buildDialoguePrompt(dialogueInputFor(teen, s2, npc.defId));
    const later = buildDialoguePrompt(dialogueInputFor(teen, s2, npc.defId, { history: [{ speaker: 'npc', text: 'Hello there.' }], playerLine: 'Where is the notebook?' }));
    frozen('dialogue', { system: h(open.system), openUser: h(open.user), laterUser: h(later.user) });
  });

  it('world prompts', () => {
    frozen('world', {
      systemEn: h(worldSystemPrompt('en')),
      systemNb: h(worldSystemPrompt('nb')),
      userSurprise: h(worldUserMessage({ surpriseSeed: 7 })),
      userPrompt: h(worldUserMessage({ prompt: 'a lighthouse keeper and her cat', language: 'nb', difficulty: 'hard', weirdness: 0.2, recentWorlds: ['Old ship', 'Teen drama'] })),
    });
  });

  it('the requests LlmGmDirector and LlmDialogue send', async () => {
    const seen: CompletionRequest[] = [];
    const provider = new MockProvider({ fallback: (req) => (seen.push(req), req.purpose.startsWith('gm') ? '{"actions":[]}' : '{"reply":"Hm.","options":[],"actions":[],"end":false}') });
    const director = new LlmGmDirector({ provider, worldKey: 'fixture-ship', fallback: null });
    for (const hook of ['intro', 'area_enter', 'idle'] as const) {
      const input = gmInputFor(ship, sit, hook);
      await director.respond({
        hook,
        area: input.area,
        turn: input.turn,
        id: 1,
        signal: new AbortController().signal,
        ctx: { world: ship, state: input.state, difficulty: input.difficulty, weirdness: 0.5, recentLog: input.recentLog ?? [], areaEnteredTurn: input.areaEnteredTurn ?? 0 },
      });
    }
    const s2 = playToSituation(teen, { seed: 1, area: 0, turnsInArea: 0 });
    const npc = npcsInArea(teen, s2.state)[0]!;
    await new LlmDialogue({ provider, worldKey: 'fixture-teen' }).turn(dialogueInputFor(teen, s2, npc.defId, { playerLine: 'Hi.' }));
    frozen('requests', seen.map((r) => ({ purpose: r.purpose, hash: requestHash(r), maxTokens: r.maxTokens, temperature: r.temperature, schemaInPrompt: r.schemaInPrompt })));
  });
});

// prettier-ignore
const FROZEN = {
  schemas: {"gmJsonSchema":"945814bee4aab137","dialogueJsonSchema":"7271f80c173c5283","GM_SCHEMA_DOC":"2c4ddfb5f176801a","DIALOGUE_SCHEMA_DOC":"881af4b14d7590c1"},
  gmSystem: {"shipNormal":"2d31f8bd6ec81c9a","shipGentle":"e5d4ffb3c1928c07","teenHard":"f6d8393fad9d2b70","nbBrutal":"41b1f166a160047c"},
  gmUser: {"intro":"c354608789b67291","area_enter":"0a55c2d546e841e6","region_discovered":"d07f31ee68609f5b","low_hp":"b4dc5edc88fbb907","boss_seen":"25b5a51e2197d164","milestone":"63530ce4746dd20d","idle":"47d68dbf43a88220","death":"f60a067c1d42999f","victory":"db5c9cd3fd7c3e6a","area1_gentle_detail":"50be1ed217eb5cc9"},
  dialogue: {"system":"621228bcb067206d","openUser":"c13231effeba883a","laterUser":"41da14b30d929eae"},
  world: {"systemEn":"de5d31da0d7e13af","systemNb":"461da181c146a5c4","userSurprise":"6a794e99bfda7484","userPrompt":"8aa17590e154b74e"},
  requests: [{"purpose":"gm:intro/fixture-ship/a0","hash":"1b12dddb2ce9b38d","maxTokens":1500,"temperature":0.9,"schemaInPrompt":false},{"purpose":"gm:area_enter/fixture-ship/a0","hash":"ba9a8b87d434316f","maxTokens":1500,"temperature":0.9,"schemaInPrompt":false},{"purpose":"gm:idle/fixture-ship/a0","hash":"ff38debd8bb3cd9e","maxTokens":1500,"temperature":0.9,"schemaInPrompt":false},{"purpose":"dialogue/fixture-teen/janitor","hash":"4f74875f3c83c3f3","maxTokens":1200,"temperature":0.9,"schemaInPrompt":false}],
};
