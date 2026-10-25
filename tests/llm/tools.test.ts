/** The agents-as-provider CLIs (tools/print-prompt.ts, tools/agent-provider.ts) and the balance worker. */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRequestFromArgs, parseArgs } from '../../tools/print-prompt';
import { worldRequest } from '../../src/llm/prompts/world';
import { WORLD_JSON_HINT_SCHEMA } from '../../src/llm/generate';
import { requestHash } from '../../src/llm/hash';
import { handleBalanceMessage, workerBalancer, type WorkerLike, type BalanceRequestMessage } from '../../src/llm/balance-worker';
import { parseWorld } from '../../src/schema/refs';
import type { WorldSpec } from '../../src/schema/world';

const tsx = (args: string[], input?: string) =>
  spawnSync(process.execPath, ['--import', 'tsx', ...args], { encoding: 'utf8', input, timeout: 120_000, cwd: process.cwd() });

const tmp = () => mkdtempSync(join(tmpdir(), 'agent-'));

describe('print-prompt', () => {
  it('parses flags', () => {
    expect(parseArgs(['--purpose', 'world', '--prompt=a b', '--json', '--weirdness', '0.3'])).toEqual({ purpose: 'world', prompt: 'a b', json: true, weirdness: '0.3' });
  });

  it('builds exactly the request the game sends', () => {
    const b = buildRequestFromArgs(parseArgs(['--purpose', 'world', '--prompt', 'clockwork saints', '--language', 'nb', '--difficulty', 'hard', '--weirdness', '0.7']));
    const game = worldRequest({ prompt: 'clockwork saints', language: 'nb', difficulty: 'hard', weirdness: 0.7, surpriseSeed: 1, recentWorlds: [] }, { jsonSchema: WORLD_JSON_HINT_SCHEMA, schemaInPrompt: false });
    expect(requestHash(b.request)).toBe(requestHash(game));
  });

  it('GM and dialogue requests are reproducible from the same arguments', () => {
    const args = parseArgs(['--purpose', 'gm', '--world', 'fixture-western', '--hook', 'idle', '--area', '0', '--turn', '15', '--seed', '4']);
    const a = buildRequestFromArgs(args);
    const b = buildRequestFromArgs(args);
    expect(a.request.purpose).toBe('gm:idle/fixture-western/a0');
    expect(requestHash(a.request)).toBe(requestHash(b.request));
  });

  it('CLI prints system, user and metadata', () => {
    const r = tsx(['tools/print-prompt.ts', '--purpose', 'world', '--prompt', 'a frozen post office', '--language', 'nb']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('===== SYSTEM =====');
    expect(r.stdout).toContain('===== USER =====');
    expect(r.stdout).toContain('a frozen post office');
    expect(r.stdout).toMatch(/requestHash: [0-9a-f]{16}/);
    const j = tsx(['tools/print-prompt.ts', '--purpose', 'world', '--json']);
    expect(JSON.parse(j.stdout).purpose).toBe('world');
  });
});

describe('agent-provider', () => {
  it('a valid world: VALID, then recorded (with the requested language)', () => {
    const dir = tmp();
    const r = tsx(['tools/agent-provider.ts', '--purpose', 'world', '--response', 'content/worlds/fixture-western.json', '--language', 'nb', '--prompt', 'a rain broker', '--no-balance', '--record', '--worlds-dir', dir, '--id', 'w1']);
    // Node's own runtime warnings (e.g. "(node:123) [UNDICI-EHPA] … EnvHttpProxyAgent is experimental"
    // when NODE_USE_ENV_PROXY is set by a sandbox proxy) are not output of the tool
    const ownStderr = r.stderr
      .split('\n')
      .filter((l) => l.trim() && !/^\(node:\d+\) \[[A-Z0-9_-]+\] Warning:/.test(l) && !l.includes('node --trace-warnings'))
      .join('\n');
    expect(ownStderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('VALID: "The Rain Broker of Sweetwater" (weird western, nb)');
    const saved = JSON.parse(readFileSync(join(dir, 'w1.json'), 'utf8'));
    expect(saved.meta.language).toBe('nb');
    expect(saved.meta.prompt).toBe('a rain broker');
    expect(parseWorld(saved, { strictKeys: true }).ok).toBe(true);
  });

  it('an invalid world prints the repair message the LLM would get, exit 1', () => {
    const w = JSON.parse(readFileSync('content/worlds/fixture-teen.json', 'utf8'));
    w.areas[0].placedItems.push({ item: 'ghost', where: 'far' });
    const r = tsx(['tools/agent-provider.ts', '--purpose', 'world', '--response', '-', '--no-balance'], 'Sure! ' + JSON.stringify(w));
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('Your previous reply could not be used. Problems found:');
    expect(r.stdout).toContain('unknown item "ghost"');
  });

  it('unknown keys are reported and block recording', () => {
    const w = JSON.parse(readFileSync('content/worlds/fixture-teen.json', 'utf8'));
    w.actors[0].behavior = { type: 'chaser' };
    const f = join(tmp(), 'w.json');
    writeFileSync(f, JSON.stringify(w));
    const r = tsx(['tools/agent-provider.ts', '--purpose', 'world', '--response', f, '--no-balance', '--record', '--worlds-dir', tmp()]);
    expect(r.stdout).toContain('actors[0].behavior: unknown key');
    expect(r.stdout).toContain('not recorded');
    expect(r.status).toBe(1);
  });

  it('a world with balance runs the bots and prints the verdict', () => {
    const r = tsx(['tools/agent-provider.ts', '--purpose', 'world', '--response', 'content/worlds/fixture-ship.json', '--seeds', '2']);
    expect([0, 2]).toContain(r.status);
    expect(r.stdout).toMatch(/explorer\s+won/);
    expect(r.stdout).toContain('verdict:');
  });

  it('GM responses: engine refusals as repair feedback; valid ones recorded under the scoped purpose', () => {
    const base = ['tools/agent-provider.ts', '--purpose', 'gm', '--world', 'fixture-ship', '--hook', 'idle', '--area', '0', '--turn', '10'];
    const bad = tsx([...base, '--response', '-'], JSON.stringify({ actions: [{ type: 'give_item', item: 'nope' }] }));
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain('actions[0] (give_item): refused by the engine');
    const dir = tmp();
    const good = { actions: [{ type: 'narrate', text: 'The lamps dim for a moment.' }, { type: 'set_flag', flag: 'gm_event_area_0' }] };
    const ok = tsx([...base, '--response', '-', '--record', '--recordings-dir', dir], JSON.stringify(good));
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('total cost 0');
    const file = join(dir, 'fixture-ship', 'gm-idle-a0.json');
    expect(existsSync(file)).toBe(true);
    const again = tsx([...base, '--response', '-', '--record', '--recordings-dir', dir], JSON.stringify(good));
    expect(again.status).toBe(0);
    const recs = JSON.parse(readFileSync(file, 'utf8')).recordings;
    expect(recs).toHaveLength(2);
    expect(recs[0].purpose).toBe('gm:idle/fixture-ship/a0');
  });

  it('dialogue responses', () => {
    const dir = tmp();
    const base = ['tools/agent-provider.ts', '--purpose', 'dialogue', '--world', 'fixture-teen', '--npc', 'janitor', '--area', '0'];
    const r = tsx([...base, '--response', '-', '--record', '--recordings-dir', dir], JSON.stringify({ reply: 'Mind the mop.', options: ['Sorry!'] }));
    expect(r.stdout + r.stderr).toContain('reply: Mind the mop.');
    expect(r.status).toBe(0);
    expect(readdirSync(join(dir, 'fixture-teen'))).toEqual(['dialogue-janitor.json']);
  });
});

describe('balance worker', () => {
  const w = (() => {
    const r = parseWorld(JSON.parse(readFileSync('content/worlds/fixture-teen.json', 'utf8')));
    if (!r.ok) throw new Error('fixture');
    return r.world as WorldSpec;
  })();

  it('handles a balance request message', () => {
    const reply = handleBalanceMessage({ id: 7, world: w, difficulty: 'normal', opts: { seeds: 2, rounds: 0, confirm: false } });
    expect(reply.id).toBe(7);
    expect(reply.ok).toBe(true);
    if (reply.ok) expect(reply.outcome.report.sims[0]!.runs).toBe(2);
    const bad = handleBalanceMessage({ id: 8, world: w, difficulty: 'nope' as never, opts: {} });
    expect(bad).toMatchObject({ id: 8, ok: false });
  });

  it('workerBalancer posts to a worker and resolves with its answer; falls back when workers fail', async () => {
    let terminated = 0;
    const fake = (): WorkerLike => {
      const listeners: Record<string, ((e: any) => void)[]> = {};
      return {
        addEventListener: (t: string, fn: (e: any) => void) => void (listeners[t] ??= []).push(fn),
        postMessage: (m: unknown) => setTimeout(() => listeners.message?.forEach((fn) => fn({ data: handleBalanceMessage(m as BalanceRequestMessage) })), 0),
        terminate: () => void terminated++,
      } as WorkerLike;
    };
    const out = await workerBalancer(fake)(w, 'normal', { seeds: 2, rounds: 0, confirm: false });
    expect(out.report.sims[0]!.runs).toBe(2);
    expect(terminated).toBe(1);
    const noWorkers = workerBalancer(() => {
      throw new Error('Worker is not defined');
    });
    expect((await noWorkers(w, 'normal', { seeds: 1, rounds: 0, confirm: false })).report.sims[0]!.runs).toBe(1);
    const ctrl = new AbortController();
    const hang = (): WorkerLike => ({ addEventListener: () => {}, postMessage: () => {}, terminate: () => void terminated++ }) as unknown as WorkerLike;
    const p = workerBalancer(hang)(w, 'normal', {}, ctrl.signal);
    ctrl.abort();
    await expect(p).rejects.toThrow(/aborted/);
  });
});
