/**
 * MP2 C2: the engine version (design §8). The client's build-time constant (vitest defines it the
 * way vite.config.ts does) agrees with the server's computation; the hash covers the lockstep code
 * only, is the same with or without git and with CRLF line ends, and /api/health reports it.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ENGINE_VERSION } from '../../src/net/version';
import { REPO_ROOT, computeEngineVersion, engineFiles, engineVersionFor } from '../../server/engine-version';
import { startServer } from '../../server/index';

const tmp: string[] = [];
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

/** a copy of the engine files outside any git repository (the directory-walk fallback) */
function copyEngine(): string {
  const dir = mkdtempSync(join(tmpdir(), 'anyworld-engine-'));
  tmp.push(dir);
  for (const f of engineFiles()) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    copyFileSync(join(REPO_ROOT, f), join(dir, f));
  }
  return dir;
}

describe('engine version', () => {
  it('the client constant agrees with the server computation', () => {
    expect(ENGINE_VERSION).not.toBe('dev');
    expect(ENGINE_VERSION).toBe(engineVersionFor(process.env));
    if (!process.env.ANYWORLD_ENGINE_VERSION) expect(ENGINE_VERSION).toBe(computeEngineVersion());
  });

  it('is 16 hex characters and stable', () => {
    const v = computeEngineVersion();
    expect(v).toMatch(/^[0-9a-f]{16}$/);
    expect(computeEngineVersion(REPO_ROOT)).toBe(v);
  });

  it('covers src/engine, src/schema and src/net without the bots, balance and client-only net files', () => {
    const files = engineFiles();
    expect(files).toContain('src/engine/index.ts');
    expect(files).toContain('src/schema/world.ts');
    expect(files).toContain('src/net/protocol.ts');
    expect(files).toContain('src/net/log.ts');
    expect(files.every((f) => f.endsWith('.ts'))).toBe(true);
    expect(files.some((f) => f.startsWith('src/engine/sim/') || f.startsWith('src/engine/balance/'))).toBe(false);
    expect(files).not.toContain('src/net/messages.ts');
    expect(files).not.toContain('src/net/client.ts');
    expect(files.some((f) => f.startsWith('src/client/') || f.startsWith('src/gm/'))).toBe(false);
    expect([...files].sort()).toEqual(files);
  });

  it('gives the same version without git, with CRLF line ends; an engine edit changes it, a bot edit does not', () => {
    const dir = copyEngine();
    expect(computeEngineVersion(dir)).toBe(computeEngineVersion());
    const types = join(dir, 'src/engine/types.ts');
    writeFileSync(types, readFileSync(types, 'utf8').replace(/\n/g, '\r\n'));
    expect(computeEngineVersion(dir)).toBe(computeEngineVersion());
    // not counted: bots, client-only net files
    mkdirSync(join(dir, 'src/engine/sim'), { recursive: true });
    writeFileSync(join(dir, 'src/engine/sim/extra.ts'), 'export const x = 1;\n');
    writeFileSync(join(dir, 'src/net/messages.ts'), '// changed\n');
    expect(computeEngineVersion(dir)).toBe(computeEngineVersion());
    writeFileSync(types, readFileSync(types, 'utf8') + '\n// changed\n');
    expect(computeEngineVersion(dir)).not.toBe(computeEngineVersion());
  });

  it('ANYWORLD_ENGINE_VERSION overrides it outside production only', () => {
    expect(engineVersionFor({ ANYWORLD_ENGINE_VERSION: 'next-deploy' })).toBe('next-deploy');
    expect(engineVersionFor({ ANYWORLD_ENGINE_VERSION: 'next-deploy', NODE_ENV: 'test' })).toBe('next-deploy');
    expect(engineVersionFor({ ANYWORLD_ENGINE_VERSION: 'next-deploy', NODE_ENV: 'production' })).toBe(computeEngineVersion());
    expect(engineVersionFor({})).toBe(computeEngineVersion());
  });

  it('/api/health reports it', async () => {
    const quiet = { log: () => {}, port: 0, host: '127.0.0.1' };
    const a = await startServer({ ...quiet, env: {} });
    const b = await startServer({ ...quiet, env: { ANYWORLD_ENGINE_VERSION: 'other' } });
    const c = await startServer({ ...quiet, env: {}, engineVersion: 'given' });
    try {
      const engine = async (port: number) => ((await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()) as { engine: string }).engine;
      expect(await engine(a.port)).toBe(computeEngineVersion());
      expect(await engine(b.port)).toBe('other');
      expect(await engine(c.port)).toBe('given');
    } finally {
      await Promise.all([a.close(), b.close(), c.close()]);
    }
  });
});
