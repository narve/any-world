import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { WorldSpec, ActorDef, ItemDef, Generator, type WorldSpec as WorldSpecT } from '../../src/schema/world';
import { GmResponse, DialogueResponse, GmHook } from '../../src/schema/gm';
import { parseWorld } from '../../src/schema/refs';
import { schemaVocabulary, namedFields } from '../../src/llm/prompts/schema-doc';
import { WORLD_SCHEMA_DOC, WORLD_NAMED, WORLD_NOTES, GM_SCHEMA_DOC, DIALOGUE_SCHEMA_DOC } from '../../src/llm/prompts/world-schema';
import { buildWorldPrompt, worldRequest, surpriseDraw, worldSystemPrompt, WORLD_EXAMPLE } from '../../src/llm/prompts/world';
import { languageInstruction, languageName, normaliseLanguage, weirdnessBand } from '../../src/llm/prompts/common';
import { buildGmPrompt, HOOK_BRIEF, HELPFUL_CEILING } from '../../src/llm/prompts/gm';
import { buildDialoguePrompt } from '../../src/llm/prompts/dialogue';
import { gmInputFor, dialogueInputFor, playToSituation, npcsInArea } from '../../src/llm/situation';

function fixture(name: string): WorldSpecT {
  const r = parseWorld(JSON.parse(readFileSync(`content/worlds/${name}.json`, 'utf8')));
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r.world;
}

const mentions = (doc: string, word: string) => new RegExp(`(^|[^A-Za-z0-9_])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9_]|$)`).test(doc);

describe('condensed World Spec description', () => {
  it('mentions every WorldSpec field and every enum / literal value', () => {
    const { keys, values } = schemaVocabulary(WorldSpec);
    const missingKeys = [...keys].filter((k) => !mentions(WORLD_SCHEMA_DOC, k));
    const missingValues = [...values].filter((v) => !WORLD_SCHEMA_DOC.includes(v));
    expect(missingKeys).toEqual([]);
    expect(missingValues).toEqual([]);
    expect(keys.size).toBeGreaterThan(150);
    expect(values.size).toBeGreaterThan(150);
  });

  it('is far smaller than the JSON Schema (~110k) and declares each named type once', () => {
    expect(WORLD_SCHEMA_DOC.length).toBeLessThan(26_000);
    for (const [name] of WORLD_NAMED) expect(WORLD_SCHEMA_DOC.match(new RegExp(`^type ${name} =`, 'gm'))?.length, name).toBe(1);
  });

  it('every note key names a real field of a named type', () => {
    const fields = namedFields(WORLD_NAMED);
    expect(Object.keys(WORLD_NOTES).filter((k) => !fields.has(k))).toEqual([]);
  });

  it('shows ranges, defaults and array bounds', () => {
    expect(WORLD_SCHEMA_DOC).toContain('actors: ActorDef[4..28]');
    expect(WORLD_SCHEMA_DOC).toContain('speed?: int 25..400 = 100');
    expect(WORLD_SCHEMA_DOC).toContain('tags: (string≤24)[≤8]');
    expect(WORLD_SCHEMA_DOC).toMatch(/type Id = string≤48 \/ids are lowercase/);
    expect(WORLD_SCHEMA_DOC).toMatch(/type Effect =\n  \| \{ type: "damage"/);
  });

  it('GM and dialogue descriptions cover their response schemas', () => {
    for (const [schema, doc] of [
      [GmResponse, GM_SCHEMA_DOC],
      [DialogueResponse, DIALOGUE_SCHEMA_DOC],
    ] as const) {
      const { keys, values } = schemaVocabulary(schema);
      expect([...keys].filter((k) => !mentions(doc, k))).toEqual([]);
      expect([...values].filter((v) => !doc.includes(v))).toEqual([]);
    }
    // GmAction reuses GmLeafAction instead of repeating 17 variants
    expect(GM_SCHEMA_DOC).toMatch(/type GmAction =\n  \| GmLeafAction\n  \| \{ type: "offer_choice"/);
    expect(GM_SCHEMA_DOC.length).toBeLessThan(9_000);
  });
});

describe('world prompt', () => {
  it('carries genre freedom, anti-cliché, non-violent conflict, win-condition variety and the schema', () => {
    const sys = worldSystemPrompt('en');
    for (const s of ['Genre freedom', 'Avoid clichés', 'Conflict does not have to be violent', 'Win conditions vary', 'non-realistic', 'WORLD SPEC FORMAT', 'type WorldSpec =', 'BALANCE', 'VALIDATION RULES']) {
      expect(sys).toContain(s);
    }
    expect(sys.length).toBeLessThan(40_000);
  });

  it('lists the params knobs of every map generator', () => {
    const sys = worldSystemPrompt('en');
    for (const g of Generator.options) expect(sys, g).toMatch(new RegExp(`^- ${g}: `, 'm'));
    for (const knob of ['roomCount', 'openness', 'buildings', 'islandCount', 'chambers', 'cellSize', 'bridgeLength', 'membranes']) {
      expect(sys).toContain(knob);
    }
  });

  it('asks for player-facing text in the requested language, ids in ASCII English', () => {
    const p = buildWorldPrompt({ prompt: 'en fyrvokters siste vinter', language: 'nb', difficulty: 'hard', weirdness: 0.9 });
    expect(p.system).toContain('LANGUAGE: write ALL player-facing text in Norwegian Bokmål (language tag "nb")');
    expect(p.system).toContain('Ids, JSON keys, enum values');
    expect(p.system).toContain('bokmål');
    expect(p.user).toContain('"""\nen fyrvokters siste vinter\n"""');
    expect(p.user).toContain('Set meta.language to "nb"');
    expect(p.user).toContain('hard:');
    expect(p.user).toContain('(unhinged)');
  });

  it('surprise me draws a deterministic genre × era × tone × twist', () => {
    expect(surpriseDraw(42)).toEqual(surpriseDraw(42));
    const draws = new Set(Array.from({ length: 30 }, (_, i) => JSON.stringify(surpriseDraw(i + 1))));
    expect(draws.size).toBeGreaterThan(25);
    const p = buildWorldPrompt({ surpriseSeed: 42 });
    const d = surpriseDraw(42);
    expect(p.user).toContain('Surprise me');
    expect(p.user).toContain(`- genre: ${d.genre}`);
    expect(p.user).toContain(`- twist: ${d.twist}`);
    expect(p.user).toContain('meta.prompt to the player\'s prompt ("" for surprise)');
  });

  it('steers away from recent worlds', () => {
    const p = buildWorldPrompt({ prompt: 'x', recentWorlds: ['The Rain Broker', 'Lowmoor Goes Under'] });
    expect(p.user).toContain('- The Rain Broker');
    expect(p.user).toContain('clearly different');
  });

  it('the shape example is valid', () => {
    expect(ActorDef.safeParse(WORLD_EXAMPLE.actor).success).toBe(true);
    expect(ItemDef.safeParse(WORLD_EXAMPLE.item).success).toBe(true);
  });

  it('worldRequest: purpose, budget, no attached schema by default', () => {
    const r = worldRequest({ prompt: 'p' });
    expect(r.purpose).toBe('world');
    expect(r.maxTokens).toBe(32_000);
    expect(r.jsonSchema).toBeUndefined();
    expect(r.messages).toHaveLength(1);
  });
});

describe('prompt helpers', () => {
  it('languages', () => {
    expect(normaliseLanguage('NB_no')).toBe('nb-NO');
    expect(normaliseLanguage('')).toBe('en');
    expect(normaliseLanguage('not a tag!')).toBe('en');
    expect(languageName('nb')).toMatch(/Norwegian Bokmål/);
    expect(languageName('en')).toBe('English');
    expect(languageInstruction('en')).not.toContain('bokmål');
  });

  it('weirdness bands are ordered', () => {
    expect([0, 0.3, 0.5, 0.8, 1].map((w) => weirdnessBand(w).label)).toEqual(['grounded', 'a little odd', 'strange', 'surreal', 'unhinged']);
    expect(weirdnessBand(Number.NaN).label).toBe('strange');
  });
});

describe('GM and dialogue prompts', () => {
  const ship = fixture('fixture-ship');
  const sit = playToSituation(ship, { seed: 3, area: 0, turnsInArea: 25 });

  it('GM prompt: persona, world language, discipline, situation ids and the hook brief', () => {
    const p = buildGmPrompt(gmInputFor(ship, sit, 'idle', { helpfulUsed: 2 }));
    expect(p.system).toContain(ship.gm.persona.slice(0, 40));
    expect(p.system).toContain('LANGUAGE: write ALL player-facing text in English');
    expect(p.system).toContain('Moderate presence');
    expect(p.system).toContain(`at most ${HELPFUL_CEILING.normal} helpful actions per area`);
    expect(p.system).toContain('add_rule');
    expect(p.system).toContain('type GmResponse =');
    expect(p.user).toContain('SITUATION (JSON');
    expect(p.user).toMatch(/"gm":\{"budget":\d+/);
    expect(p.user).toContain('HELP USED this area: 2 of 2 (used up');
    expect(p.user).toContain(HOOK_BRIEF.idle);
    expect(p.user).toMatch(/"rules":\[\{"id":"thin-air"/);
    expect(p.user).toContain(`AREA 0 "${ship.areas[0]!.name}"`);
    expect(p.user).toContain('item pool (ids for place_item / give_item)');
    // the system prompt is identical across hooks of one run (cacheable)
    expect(buildGmPrompt(gmInputFor(ship, sit, 'area_enter')).system).toBe(p.system);
  });

  it('GM prompt uses the world language', () => {
    const nb: WorldSpecT = { ...ship, meta: { ...ship.meta, language: 'nb' } };
    expect(buildGmPrompt(gmInputFor(nb, sit, 'intro')).system).toContain('Norwegian Bokmål');
  });

  it('every hook has a brief', () => {
    for (const h of GmHook.options) expect(HOOK_BRIEF[h].length).toBeGreaterThan(20);
  });

  it('dialogue prompt: the NPC, its secrets and wants, history and the player line', () => {
    const teen = fixture('fixture-teen');
    const s2 = playToSituation(teen, { seed: 1, area: 0, turnsInArea: 0 });
    const npc = npcsInArea(teen, s2.state)[0]!;
    const input = dialogueInputFor(teen, s2, npc.defId, { history: [{ speaker: 'npc', text: 'Hello there.' }], playerLine: 'Where is the notebook?' });
    const p = buildDialoguePrompt(input);
    const def = teen.actors.find((a) => a.id === npc.defId)!;
    expect(p.user).toContain(`NPC ${npc.id} = ${def.name}`);
    if (def.npc?.secrets) expect(p.user).toContain(def.npc.secrets.slice(0, 30));
    expect(p.user).toContain('NPC: Hello there.');
    expect(p.user).toContain('The player says: "Where is the notebook?"');
    expect(p.system).toContain('type DialogueResponse =');
    expect(() => dialogueInputFor(teen, s2, 'nobody-here')).toThrow(/no NPC "nobody-here"/);
  });
});
