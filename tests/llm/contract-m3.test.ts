/**
 * Contract tests for the M3 prompt paths over mocked HTTP: what a world / GM / dialogue request looks
 * like on the wire for each provider family, and the whole generation pipeline through a provider
 * and through the backend proxy.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { AnthropicProvider } from '../../src/llm/anthropic';
import { OpenAICompatibleProvider } from '../../src/llm/openai-compatible';
import { BackendProvider } from '../../src/llm/transport';
import { generateWorld, WORLD_JSON_HINT_SCHEMA } from '../../src/llm/generate';
import { worldRequest } from '../../src/llm/prompts/world';
import { gmRequest } from '../../src/llm/prompts/gm';
import { gmJsonSchema, dialogueJsonSchema } from '../../src/llm/gm-checks';
import { LlmGmDirector } from '../../src/llm/gm-runtime';
import { parseWorld } from '../../src/schema/refs';
import type { WorldSpec } from '../../src/schema/world';
import { playToSituation, gmInputFor } from '../../src/llm/situation';
import { createApp } from '../../server/app';
import { anthropicMessage, chatCompletion, fastRetry, json, mockFetch } from './helpers';

const shipText = readFileSync('content/worlds/fixture-ship.json', 'utf8');
const ship = (() => {
  const r = parseWorld(JSON.parse(shipText));
  if (!r.ok) throw new Error('fixture');
  return r.world as WorldSpec;
})();

const worldReq = () => worldRequest({ prompt: 'a ship', language: 'nb' }, { jsonSchema: WORLD_JSON_HINT_SCHEMA, schemaInPrompt: false });

describe('world request on the wire', () => {
  it('Anthropic: prompt-only JSON (the open hint schema is never sent as output_config), no schema pasted', async () => {
    const f = mockFetch(json(anthropicMessage(shipText)));
    const p = new AnthropicProvider({ apiKey: 'k', fetch: f, browser: false, ...fastRetry });
    await p.complete(worldReq());
    const body = f.calls[0]!.body;
    expect(body.output_config?.format).toBeUndefined();
    expect(body.system).toContain('type WorldSpec =');
    expect(body.system).toContain('Respond with a single valid JSON value only');
    expect(body.system).not.toContain('"$schema"');
    expect(body.max_tokens).toBe(32_000);
    expect(body.messages).toEqual([{ role: 'user', content: expect.stringContaining('a ship') }]);
  });

  it('OpenAI-compatible json_schema: the small hint schema, not the 110k one', async () => {
    const f = mockFetch(json(chatCompletion(shipText)));
    const p = new OpenAICompatibleProvider({ baseUrl: 'https://api.example.com/v1', model: 'm', apiKey: 'k', fetch: f, structuredOutput: 'json_schema', ...fastRetry });
    await p.complete(worldReq());
    const body = f.calls[0]!.body;
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.schema).toEqual(WORLD_JSON_HINT_SCHEMA);
    expect(JSON.stringify(body).length).toBeLessThan(60_000);
  });

  it('OpenAI-compatible json_object: JSON mode on, hint not pasted into the prompt', async () => {
    const f = mockFetch(json(chatCompletion(shipText)));
    const p = new OpenAICompatibleProvider({ baseUrl: 'https://api.example.com/v1', model: 'm', fetch: f, structuredOutput: 'json_object', ...fastRetry });
    await p.complete(worldReq());
    const body = f.calls[0]!.body;
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.messages[0].content).not.toContain('"title":"WorldSpec"');
  });
});

describe('GM request on the wire', () => {
  const sit = playToSituation(ship, { seed: 2, area: 0, turnsInArea: 5 });

  it('Anthropic: recursive GmResponse schema → prompt-only JSON with the condensed doc', async () => {
    const f = mockFetch(json(anthropicMessage('{"actions":[]}')));
    const p = new AnthropicProvider({ apiKey: 'k', fetch: f, browser: false, ...fastRetry });
    await p.complete(gmRequest(gmInputFor(ship, sit, 'idle'), 'gm:idle/fixture-ship/a0', { jsonSchema: gmJsonSchema(), schemaInPrompt: false }));
    const body = f.calls[0]!.body;
    expect(body.output_config?.format).toBeUndefined();
    expect(body.system).toContain('type GmResponse =');
    expect(body.system).not.toContain('"$defs"');
    expect(body.max_tokens).toBe(1500);
  });

  it('OpenAI-compatible json_schema: native GmResponse / DialogueResponse schemas', async () => {
    const f = mockFetch(json(chatCompletion('{"actions":[]}')));
    const p = new OpenAICompatibleProvider({ baseUrl: 'https://api.example.com/v1', model: 'm', apiKey: 'k', fetch: f, structuredOutput: 'json_schema', ...fastRetry });
    await p.complete(gmRequest(gmInputFor(ship, sit, 'idle'), 'gm:idle/fixture-ship/a0', { jsonSchema: gmJsonSchema(), schemaInPrompt: false }));
    const rf = f.calls[0]!.body.response_format;
    expect(rf.json_schema.name).toBe('gm_response');
    expect(JSON.stringify(rf.json_schema.schema)).toContain('offer_choice');
    expect(JSON.stringify(dialogueJsonSchema())).toContain('reply');
  });

  it('a GM director over a mocked OpenAI-compatible endpoint', async () => {
    const f = mockFetch(json(chatCompletion('```json\n{"actions":[{"type":"narrate","text":"Moss, breathing."}]}\n```')));
    const p = new OpenAICompatibleProvider({ baseUrl: 'https://api.example.com/v1', model: 'm', fetch: f, structuredOutput: 'none', ...fastRetry });
    const r = await new LlmGmDirector({ provider: p }).respond({
      id: 1,
      hook: 'area_enter',
      area: 0,
      turn: sit.state.turn,
      signal: new AbortController().signal,
      ctx: { world: ship, state: sit.state, difficulty: 'normal', weirdness: 0.5, recentLog: [], areaEnteredTurn: 0 },
    });
    expect(r).toEqual({ actions: [{ type: 'narrate', text: 'Moss, breathing.' }] });
  });
});

describe('generateWorld end-to-end over mocked HTTP', () => {
  it('Anthropic provider: an invalid world is repaired on the second call', async () => {
    const broken = JSON.parse(shipText);
    broken.items[0].knowledge = 'unknown';
    delete broken.items[0].appearanceGroup;
    broken.goal.win = { type: 'flag', flag: 'never-set-anywhere' };
    const f = mockFetch(json(anthropicMessage(JSON.stringify(broken))), json(anthropicMessage(shipText)));
    const p = new AnthropicProvider({ apiKey: 'k', fetch: f, browser: false, ...fastRetry });
    const res = await generateWorld({ provider: p, prompt: 'a ship', balance: false });
    expect(res.attempts).toBe(2);
    expect(res.world.meta.title).toBe(ship.meta.title);
    const second = f.calls[1]!.body;
    expect(second.messages).toHaveLength(3);
    expect(second.messages[2].content).toContain('flag "never-set-anywhere" is never set');
    expect(second.messages[2].content).toContain('appearanceGroup');
  });

  describe('through the backend proxy', () => {
    let close: (() => Promise<void>) | null = null;
    afterEach(async () => {
      await close?.();
      close = null;
    });

    it('BackendProvider → POST /api/llm → upstream: the world arrives validated', async () => {
      const upstream = mockFetch(json(chatCompletion(shipText)));
      const { server } = createApp({ env: { DEEPSEEK_API_KEY: 'sk-x' }, fetch: upstream, log: () => {} });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      close = () => new Promise((r) => server.close(() => r()));
      const port = (server.address() as AddressInfo).port;
      const p = new BackendProvider('deepseek', undefined, { backendUrl: `http://127.0.0.1:${port}` });
      const res = await generateWorld({ provider: p, prompt: 'a ship', balance: false });
      expect(res.world.meta.title).toBe(ship.meta.title);
      const sent = upstream.calls[0]!.body;
      expect(sent.messages[0].content).toContain('type WorldSpec =');
      expect(sent.response_format).toBeDefined();
    });
  });
});
