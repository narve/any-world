/**
 * <PRESET>_PLAY_MODEL: play calls (GM, NPC voices) run on their own model when the page names none;
 * creating a world keeps the default model, and a model the page names wins.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from '../../server/index';
import { anthropicMessage, json, mockFetch } from '../llm/helpers';

const upstream = mockFetch(() => json(anthropicMessage('hi')));
let base = '';
let close: () => Promise<void>;

beforeAll(async () => {
  const s = await startServer({
    port: 0,
    host: '127.0.0.1',
    env: { ANTHROPIC_API_KEY: 'sk-ant-x', ANTHROPIC_PLAY_MODEL: 'claude-sonnet-5-5' },
    fetch: upstream,
    upstream: { maxRetries: 0, timeoutMs: 300 },
    rateLimit: { perMinute: 600, burst: 50 },
    log: () => {},
  });
  base = `http://127.0.0.1:${s.port}`;
  close = s.close;
});
afterAll(() => close());

const modelFor = async (purpose: string, model?: string): Promise<string> => {
  const r = await fetch(`${base}/api/llm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ preset: 'anthropic', ...(model ? { model } : {}), request: { system: 's', messages: [{ role: 'user', content: 'x' }], purpose } }),
  });
  expect(r.status).toBe(200);
  return (upstream.calls.at(-1)!.body as { model: string }).model;
};

describe('play model', () => {
  it('world creation uses the default model, play calls the play model, a named model wins', async () => {
    expect(await modelFor('world')).toBe('claude-opus-5-5');
    expect(await modelFor('gm:intro/w/a0')).toBe('claude-sonnet-5-5');
    expect(await modelFor('dialogue/w/npc')).toBe('claude-sonnet-5-5');
    expect(await modelFor('gm:idle/w/a0', 'claude-haiku-5-5')).toBe('claude-haiku-5-5');
  });

  it('the play model is on the allowed list the server reports', async () => {
    const info = await (await fetch(`${base}/api/presets`)).json();
    expect(info.presets.find((p: { id: string }) => p.id === 'anthropic').models).toContain('claude-sonnet-5-5');
  });
});
