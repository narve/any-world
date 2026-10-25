/** Modes (DESIGN §4.4): provider status line, failure hints, and the offline demo generator. */
import { describe, it, expect } from 'vitest';
import { normalizeSettings } from '../../src/client/storage';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseWorld } from '../../src/schema/refs';
import type { ProviderConfig } from '../../src/llm/types';
import { generateWorld, WorldGenerationError } from '../../src/llm/generate';
import { demoGenerator, generationHint, OFFLINE_PRESET, pickDemoWorld, problemText, providerProblem, providerStatus, type DemoWorldChoice, type ServerState } from '../../src/client/modes';
import { promptLibrary } from '../../src/client/prompts';

const dir = join(__dirname, '..', '..', 'content', 'worlds');
const worlds = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => {
    const r = parseWorld(JSON.parse(readFileSync(join(dir, f), 'utf8')));
    if (!r.ok) throw new Error(f);
    return { id: f.replace(/\.json$/, ''), meta: r.world.meta, world: r.world };
  }) satisfies DemoWorldChoice[];

const unknown: ServerState = { kind: 'unknown' };
const down: ServerState = { kind: 'unreachable' };
const serving = (...ids: string[]): ServerState => ({ kind: 'ok', configured: new Set(ids) });
const cfg = (c: Partial<ProviderConfig>): ProviderConfig => ({ preset: 'anthropic', transport: 'direct', ...c });

describe('providerProblem', () => {
  it('direct transport: missing key, missing base URL, CORS-less presets, unknown presets', () => {
    expect(providerProblem(cfg({}), unknown)).toMatchObject({ kind: 'missing_key' });
    expect(providerProblem(cfg({ apiKey: 'sk' }), unknown)).toBeNull();
    expect(providerProblem(cfg({ preset: 'custom' }), unknown)).toMatchObject({ kind: 'missing_base_url' });
    expect(providerProblem(cfg({ preset: 'custom', baseUrl: 'http://localhost:1234/v1' }), unknown)).toBeNull();
    expect(providerProblem(cfg({ preset: 'deepseek', apiKey: 'sk' }), unknown)).toMatchObject({ kind: 'cors' });
    expect(providerProblem(cfg({ preset: 'ollama' }), unknown)).toBeNull();
    expect(providerProblem(cfg({ preset: 'nope' }), unknown)).toMatchObject({ kind: 'unknown_preset', id: 'nope' });
  });

  it('backend transport: unreachable server, preset without a server key', () => {
    const b = cfg({ transport: 'backend' });
    expect(providerProblem(b, down)).toMatchObject({ kind: 'server_unreachable' });
    expect(providerProblem(b, serving('mock'))).toMatchObject({ kind: 'server_no_key' });
    expect(problemText(providerProblem(b, serving('mock'))!)).toContain('ANTHROPIC_API_KEY');
    expect(providerProblem(b, serving('anthropic'))).toBeNull();
    expect(providerProblem(b, unknown)).toBeNull();
  });

  it('the offline demo generator never has a problem', () => {
    expect(providerProblem(cfg({ preset: OFFLINE_PRESET }), down)).toBeNull();
  });
});

describe('providerStatus', () => {
  it('ready: names the provider and the transport; direct mode mentions the local key', () => {
    const s = providerStatus(cfg({ apiKey: 'sk' }), unknown, true);
    expect(s.tone).toBe('ok');
    expect(s.text).toContain('Anthropic Claude');
    expect(s.text).toContain('in the browser');
    expect(s.detail).toMatch(/this browser only/);
    const b = providerStatus(cfg({ transport: 'backend' }), serving('anthropic'), true);
    expect(b.text).toContain('via the server');
    expect(b.detail).toBeUndefined();
  });

  it('demo mode, missing key and an unreachable server each say what is going on', () => {
    expect(providerStatus(cfg({}), unknown, false)).toMatchObject({ tone: 'warn' });
    expect(providerStatus(cfg({}), unknown, false).text).toMatch(/needs an API key/);
    expect(providerStatus(cfg({ transport: 'backend' }), down, false)).toMatchObject({ tone: 'demo' });
    expect(providerStatus(cfg({ transport: 'backend' }), down, false).text).toMatch(/cannot be reached/);
    expect(providerStatus(cfg({ transport: 'backend' }), unknown, false).text).toMatch(/Checking/);
    expect(providerStatus(cfg({ transport: 'backend' }), serving(), false).text).toMatch(/no key for Anthropic Claude/);
  });

  it('CORS-less preset in direct mode works but warns; GM off is mentioned', () => {
    const s = providerStatus(cfg({ preset: 'deepseek', apiKey: 'sk' }), unknown, true, { gm: false });
    expect(s.tone).toBe('warn');
    expect(s.detail).toMatch(/CORS/);
    expect(s.detail).toMatch(/game master is off/);
  });

  it('offline demo generator', () => {
    expect(providerStatus(cfg({ preset: OFFLINE_PRESET }), down, true)).toMatchObject({ tone: 'demo' });
  });
});

describe('generationHint', () => {
  const err = (kind: ConstructorParameters<typeof WorldGenerationError>[0]) => new WorldGenerationError(kind, kind);
  it('a direct network failure is explained as CORS (cloud) or a local server problem', () => {
    expect(generationHint(err('network'), cfg({ apiKey: 'x' }))).toMatch(/CORS/);
    expect(generationHint(err('network'), cfg({ preset: 'ollama' }))).toMatch(/local AI server/);
    expect(generationHint(err('network'), cfg({ transport: 'backend' }))).toMatch(/game server/);
  });
  it('timeouts and keys', () => {
    expect(generationHint(err('timeout'), cfg({}))).toMatch(/faster model/);
    expect(generationHint(err('auth'), cfg({ transport: 'backend' }))).toMatch(/environment/);
    expect(generationHint(err('auth'), cfg({}))).toMatch(/API key/);
    expect(generationHint(err('invalid'), cfg({}))).toBeNull();
    expect(generationHint(new Error('x'), cfg({}))).toBeNull();
  });
});

describe('pickDemoWorld', () => {
  const lib = promptLibrary();

  it('a library prompt plays its own recorded world', () => {
    for (const p of lib.filter((x) => x.worldId && worlds.some((w) => w.id === x.worldId))) {
      expect(pickDemoWorld(worlds, { prompt: p.prompt, language: p.language ?? 'en', seed: 1 }, lib)?.id).toBe(p.worldId);
    }
  });

  it('"Surprise me" is deterministic per seed, stays in the requested language and skips fixtures', () => {
    const a = pickDemoWorld(worlds, { prompt: '', language: 'nb', seed: 7 })!;
    expect(a.world.meta.language).toBe('nb');
    expect(pickDemoWorld(worlds, { prompt: '', language: 'nb', seed: 7 })!.id).toBe(a.id);
    const seen = new Set<string>();
    for (let seed = 1; seed < 60; seed++) seen.add(pickDemoWorld(worlds, { prompt: '', language: 'en', seed })!.id);
    expect(seen.size).toBeGreaterThan(3);
    expect([...seen].some((id) => id.startsWith('fixture-'))).toBe(false);
  });

  it('a free prompt picks the world sharing most words; unknown languages fall back to any world', () => {
    expect(pickDemoWorld(worlds, { prompt: 'a silent heist in a vault', language: 'en', seed: 3 })?.id).toBe('heist-silent-vault');
    expect(pickDemoWorld(worlds, { prompt: 'something', language: 'de', seed: 3 })).not.toBeNull();
    expect(pickDemoWorld([], { prompt: '', language: 'en', seed: 1 })).toBeNull();
  });
});

describe('demoGenerator', () => {
  it('runs the real generation pipeline and returns the chosen world', async () => {
    const choice = worlds.find((w) => w.id === 'fixture-teen')!;
    const res = await generateWorld({ provider: demoGenerator(choice.id, choice.world), prompt: 'teen drama', language: 'en', balance: false, yieldToUi: async () => {} });
    expect(res.world.meta.title).toBe(choice.world.meta.title);
    expect(res.attempts).toBe(1);
  });
});

describe('server access code (MP0)', () => {
  const cfg = { preset: 'anthropic', transport: 'backend' as const };
  const server = { kind: 'ok' as const, configured: new Set(['anthropic', 'mock']), codeRequired: true };

  it('a server that asks for a code is a problem until one is entered', () => {
    expect(providerProblem(cfg, server)).toEqual({ kind: 'server_code' });
    expect(providerProblem(cfg, server, '  ')).toEqual({ kind: 'server_code' });
    expect(providerProblem(cfg, server, 'otter')).toBeNull();
    expect(providerProblem(cfg, { ...server, codeRequired: false })).toBeNull();
    expect(problemText({ kind: 'server_code' })).toMatch(/access code/);
  });

  it('a refused code gets its own hint, a refused server key keeps the old one', () => {
    const codeErr = new WorldGenerationError('auth', 'HTTP 401: Wrong server access code');
    const keyErr = new WorldGenerationError('auth', 'Upstream rejected the server’s credentials');
    expect(generationHint(codeErr, cfg)).toMatch(/access code/);
    expect(generationHint(keyErr, cfg)).not.toMatch(/access code/);
  });

  it('the code survives a save and reload, trimmed', () => {
    const s = normalizeSettings({ provider: cfg, accessCode: '  otter  ' }, 'backend');
    expect(s.accessCode).toBe('otter');
    expect(normalizeSettings({ provider: cfg, accessCode: 42 }, 'backend').accessCode).toBeUndefined();
  });
});
