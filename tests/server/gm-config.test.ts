/**
 * MP4 G3: the room server's GM configuration (server/gm-config.ts) and the presets' GM models: opt-in
 * (a key in the environment alone builds nothing), never the mock preset, model and timeout defaults,
 * ANYWORLD_TEST_GM outside production only, and the Mistral preset's plain JSON mode.
 */
import { describe, it, expect } from 'vitest';
import { gmConfigFor, gmModelFor, GM_CALLS_PER_HOUR, GM_ROOM_CALLS_PER_HOUR } from '../../server/gm-config';
import { getPreset, PRESETS } from '../../src/llm/presets';
import { createDirectProvider } from '../../src/llm/transport';
import { gmRequest } from '../../src/llm/prompts/gm';
import { gmJsonSchema } from '../../src/llm/gm-checks';
import { MockProvider } from '../../src/llm/mock';
import type { LLMProvider, ProviderPreset } from '../../src/llm/types';
import { chatCompletion, fastRetry, json, mockFetch } from '../llm/helpers';

const FAKE_KEY = 'fake-key-for-tests';

function deps(o: { configured?: (p: ProviderPreset) => boolean; maxRooms?: number; files?: Record<string, string> } = {}) {
  const built: { preset: string; model: string }[] = [];
  const logs: string[] = [];
  return {
    built,
    logs,
    deps: {
      maxRooms: o.maxRooms ?? 10,
      providerFor: (p: ProviderPreset, model: string): LLMProvider => {
        built.push({ preset: p.id, model });
        return { id: p.id, model, complete: async () => ({ text: '{}', model }) };
      },
      isConfigured: o.configured ?? ((p: ProviderPreset) => p.id === 'mistral'),
      log: (l: string) => logs.push(l),
      readFile: (path: string) => {
        const f = o.files?.[path];
        if (f === undefined) throw new Error(`no file ${path}`);
        return f;
      },
    },
  };
}

describe('gmConfigFor', () => {
  it('is opt-in: a key in the environment and no ANYWORLD_GM_PRESET builds no provider', () => {
    const d = deps();
    const c = gmConfigFor({ MISTRAL_API_KEY: FAKE_KEY, ANTHROPIC_API_KEY: FAKE_KEY }, d.deps);
    expect(c.setting).toBe('unset');
    expect(c.provider).toBeNull();
    expect(d.built).toEqual([]);
  });

  it('defaults: the preset GM model, timeouts 5 s / 4 s, concurrency maxRooms x 2, hourly caps', () => {
    const d = deps({ maxRooms: 7 });
    const c = gmConfigFor({ MISTRAL_API_KEY: FAKE_KEY, ANYWORLD_GM_PRESET: 'mistral' }, d.deps);
    expect(c.setting).toBe('ai');
    expect(d.built).toEqual([{ preset: 'mistral', model: 'mistral-small-latest' }]);
    expect(c.provider?.model).toBe('mistral-small-latest');
    expect(c.label).toBe('mistral mistral-small-latest');
    expect([c.timeoutMs, c.deadlineMs, c.concurrency, c.callsPerHour, c.roomCallsPerHour]).toEqual([5000, 4000, 14, GM_CALLS_PER_HOUR, GM_ROOM_CALLS_PER_HOUR]);
  });

  it('reads the model, timeout, concurrency and caps from the environment', () => {
    const d = deps();
    const c = gmConfigFor(
      { ANYWORLD_GM_PRESET: 'Mistral', ANYWORLD_GM_MODEL: 'mistral-medium-latest', ANYWORLD_GM_TIMEOUT_MS: '3000', ANYWORLD_GM_CONCURRENCY: '3', ANYWORLD_GM_CALLS_PER_HOUR: '50', ANYWORLD_GM_ROOM_CALLS_PER_HOUR: '5' },
      d.deps,
    );
    expect(d.built).toEqual([{ preset: 'mistral', model: 'mistral-medium-latest' }]);
    expect([c.timeoutMs, c.deadlineMs, c.concurrency, c.callsPerHour, c.roomCallsPerHour]).toEqual([3000, 2000, 3, 50, 5]);
  });

  it('off, mock, unknown and unconfigured presets give no provider (logged, never fatal)', () => {
    const d = deps();
    expect(gmConfigFor({ ANYWORLD_GM_PRESET: 'off', MISTRAL_API_KEY: FAKE_KEY }, d.deps).setting).toBe('off');
    expect(gmConfigFor({ ANYWORLD_GM_PRESET: 'mock' }, d.deps).provider).toBeNull();
    expect(gmConfigFor({ ANYWORLD_GM_PRESET: 'nope' }, d.deps).provider).toBeNull();
    expect(gmConfigFor({ ANYWORLD_GM_PRESET: 'anthropic' }, d.deps).provider).toBeNull();
    expect(d.built).toEqual([]);
    expect(d.logs).toHaveLength(3);
    expect(d.logs.join('\n')).not.toContain(FAKE_KEY);
  });

  it('ANYWORLD_TEST_GM scripts a MockProvider outside production only; off still wins', async () => {
    const file = JSON.stringify({ responses: { 'gm:intro': { json: { actions: [{ type: 'narrate', text: 'hi' }] } } }, latencyMs: 0 });
    const d = deps({ files: { '/t.json': file } });
    const c = gmConfigFor({ ANYWORLD_TEST_GM: '/t.json' }, d.deps);
    expect(c.setting).toBe('ai');
    expect(c.provider).toBeInstanceOf(MockProvider);
    const r = await c.provider!.complete({ system: '', messages: [{ role: 'user', content: 'x' }], purpose: 'gm:intro/w/a0' });
    expect(JSON.parse(r.text)).toEqual({ actions: [{ type: 'narrate', text: 'hi' }] });
    expect(gmConfigFor({ ANYWORLD_TEST_GM: '/t.json', NODE_ENV: 'production' }, d.deps).provider).toBeNull();
    expect(gmConfigFor({ ANYWORLD_TEST_GM: '/t.json', ANYWORLD_GM_PRESET: 'off' }, d.deps).setting).toBe('off');
  });

  it('gmModelFor: ANYWORLD_GM_MODEL, then the preset gmModel, then <PRESET>_MODEL, then defaultModel', () => {
    const ds = getPreset('deepseek')!;
    expect(gmModelFor({}, ds)).toBe(ds.defaultModel);
    expect(gmModelFor({ DEEPSEEK_MODEL: 'deepseek-reasoner' }, ds)).toBe('deepseek-reasoner');
    expect(gmModelFor({ DEEPSEEK_MODEL: 'x' }, getPreset('anthropic')!)).toBe('claude-haiku-5-5');
    expect(gmModelFor({ ANYWORLD_GM_MODEL: 'y' }, getPreset('anthropic')!)).toBe('y');
  });
});

describe('presets: GM models and the Mistral preset', () => {
  it('every gmModel is one of its preset models (cheap and fast: Haiku, Mistral Small, GPT-5 mini)', () => {
    const gm = PRESETS.filter((p) => p.gmModel);
    expect(gm.map((p) => [p.id, p.gmModel])).toEqual([
      ['anthropic', 'claude-haiku-5-5'],
      ['openai', 'gpt-5-mini'],
      ['mistral', 'mistral-small-latest'],
    ]);
    for (const p of gm) expect(p.models).toContain(p.gmModel);
  });

  it('Mistral: plain JSON mode (json_object, no strict schema), mistral-medium-latest by default', async () => {
    const p = getPreset('mistral')!;
    expect(p.structuredOutput).toBe('json_object');
    expect(p.defaultModel).toBe('mistral-medium-latest');
    expect(p.models).toContain('mistral-large-latest');
    const f = mockFetch(json(chatCompletion('{"actions":[]}')), json(chatCompletion('{"a":1}')), json(chatCompletion('{"a":1}')));
    const prov = createDirectProvider(p, { apiKey: FAKE_KEY }, { fetch: f, browser: false, ...fastRetry });
    expect(prov.model).toBe('mistral-medium-latest');
    // a world-style request (the schema described in the prompt text): JSON mode and the JSON instruction
    await prov.complete({ system: 'world', messages: [{ role: 'user', content: 'go' }], purpose: 'world', jsonSchema: { type: 'object' }, schemaInPrompt: false });
    let body = f.calls[0]!.body;
    expect(body.model).toBe('mistral-medium-latest');
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(JSON.stringify(body)).not.toContain('json_schema');
    expect(body.messages[0].content).toContain('Respond with a single valid JSON value only');
    // a small schema still goes into the prompt
    await prov.complete({ system: 's', messages: [{ role: 'user', content: 'go' }], purpose: 'x', jsonSchema: { type: 'object', required: ['a'] } });
    body = f.calls[1]!.body;
    expect(body.messages[0].content).toContain('"required":["a"]');
    // the GM path (schemaInPrompt false: the doc is in the system prompt) still gets the JSON wording
    const gmProv = createDirectProvider(p, { apiKey: FAKE_KEY, model: 'mistral-small-latest' }, { fetch: f, browser: false, ...fastRetry });
    const { loadFixture } = await import('../engine/helpers');
    const { createGame } = await import('../../src/engine');
    const world = loadFixture('fixture-western.json');
    const state = createGame(world, { seed: 1 });
    const req = gmRequest({ world, state, difficulty: 'normal', weirdness: 0.5, recentLog: [], areaEnteredTurn: 0, hook: 'intro', area: 0, turn: 0, helpfulUsed: 0 }, 'gm:intro/w/a0', { jsonSchema: gmJsonSchema(), schemaInPrompt: false });
    await gmProv.complete(req);
    body = f.calls[2]!.body;
    expect(body.model).toBe('mistral-small-latest');
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.messages[0].content).toContain('JSON');
    expect(body.messages[0].content).toContain('Respond with a single valid JSON value only');
  });
});
