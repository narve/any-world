/**
 * Entry point: `npm start` (production: API + dist/client) or imported by server/dev.ts (API only;
 * Vite serves the client and proxies /api here).
 * Env: PORT (8787), HOST (0.0.0.0), provider keys (ANTHROPIC_API_KEY, DEEPSEEK_API_KEY, …, see
 * src/llm/presets.ts), LLM_RATE_PER_MIN, LLM_RATE_BURST, LLM_MAX_BODY_BYTES, LLM_MAX_OUTPUT_TOKENS,
 * LLM_TIMEOUT_MS (per upstream attempt, 600000), LLM_TOTAL_TIMEOUT_MS (attempts + backoff; default
 * LLM_TIMEOUT_MS; keep it below the client's backend timeout, 660000 by default), LLM_MAX_RETRIES (2;
 * 429/5xx/network only), LLM_ALLOW_ANY_MODEL, <PRESET>_MODELS (extra allowed model ids, comma-separated; any preset with a key, including custom with CUSTOM_LLM_API_KEY, is restricted), LLM_MAX_CACHED_PROVIDERS (64), TRUST_PROXY (number of trusted reverse-proxy
 * hops; 1 = the proxy's appended right-most X-Forwarded-For entry; the left-most entry is client-controlled
 * and never used), STATIC_DIR (dist/client), ANYWORLD_HOST_CODE (access code for AI calls; unset = open),
 * ALLOWED_ORIGINS (comma-separated origins allowed to call /api from other sites, e.g. GitHub Pages),
 * ANYWORLD_ENGINE_VERSION (overrides the computed engine version, server/engine-version.ts; ignored in production).
 * Rooms (MP2): ANYWORLD_DATA_DIR (else STATE_DIRECTORY from systemd, else .data/ in the repo; the server
 * refuses to start when it cannot write there, server/data-dir.ts), ANYWORLD_MAX_ROOMS (10),
 * ANYWORLD_TEST_TIMING (JSON of RoomTiming durations for the child-process tests; ignored in production).
 * Prints `[server] listening <port>` once the port is bound (tests read it); SIGTERM/SIGINT snapshot
 * every room and send `bye` before exiting.
 */
import { assertSafeNode } from './node-check';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Server } from 'node:http';
import { createApp, type AppOptions } from './app';
import { engineVersionFor } from './engine-version';
import { ensureDataDir, resolveDataDir } from './data-dir';
import type { RoomManager } from './rooms/manager';
import type { RoomTiming } from './rooms/timing';

export { createApp, type AppOptions } from './app';

export interface StartOptions extends AppOptions {
  port?: number;
  host?: string;
}

export interface StartedServer {
  server: Server;
  port: number;
  configuredPresets: () => string[];
  cachedProviderCount: () => number;
  /** the rooms, when StartOptions.rooms was given */
  rooms: RoomManager | null;
  /**
   * Stops the server: every room snapshots and sends `bye` (graceful shutdown, design §7), sockets
   * get up to `graceMs` (default 1000) to close and are then terminated (closeAllConnections does not
   * reach upgraded sockets), then the HTTP server closes.
   */
  close: (graceMs?: number) => Promise<void>;
}

/** Start listening; resolves once the port is bound. */
export async function startServer(opts: StartOptions = {}): Promise<StartedServer> {
  const env = opts.env ?? process.env;
  const app = createApp(opts);
  const port = opts.port ?? (env.PORT !== undefined ? Number(env.PORT) : 8787);
  const host = opts.host ?? env.HOST ?? '0.0.0.0';
  await new Promise<void>((res, rej) => {
    app.server.once('error', rej);
    app.server.listen(port, host, () => {
      app.server.off('error', rej);
      res();
    });
  });
  const addr = app.server.address();
  const bound = typeof addr === 'object' && addr ? addr.port : port;
  return {
    server: app.server,
    port: bound,
    configuredPresets: app.configuredPresets,
    cachedProviderCount: app.cachedProviderCount,
    rooms: app.rooms?.manager ?? null,
    close: async (graceMs = 1000) => {
      if (app.rooms) {
        app.rooms.manager.shutdown();
        await app.rooms.sockets.close(graceMs);
      }
      await new Promise<void>((res) => {
        app.server.closeAllConnections?.();
        app.server.close(() => res());
      });
    },
  };
}

/** ANYWORLD_TEST_TIMING (JSON, outside production only) → room durations; throws on bad JSON */
export function testTiming(env: Record<string, string | undefined>): Partial<RoomTiming> | undefined {
  const raw = env.ANYWORLD_TEST_TIMING?.trim();
  if (!raw || env.NODE_ENV === 'production') return undefined;
  const v: unknown = JSON.parse(raw);
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('ANYWORLD_TEST_TIMING must be a JSON object');
  return v as Partial<RoomTiming>;
}

/** the data directory, created and checked; prints the reason and exits 1 when it cannot be used */
export function dataDirOrExit(env: Record<string, string | undefined>, tag = '[server]'): string {
  const dir = resolveDataDir(env);
  try {
    ensureDataDir(dir);
  } catch (e) {
    console.error(`${tag} cannot use data directory ${dir}: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  return dir;
}

async function main(): Promise<void> {
  assertSafeNode();
  const production = process.env.NODE_ENV === 'production';
  const staticDir = production ? resolve(process.env.STATIC_DIR ?? 'dist/client') : undefined;
  // computed once from the deployed checkout (MP2 design §8)
  const engineVersion = engineVersionFor(process.env);
  const dataDir = dataDirOrExit(process.env);
  const timing = testTiming(process.env);
  const started = await startServer({ staticDir, engineVersion, rooms: { dataDir, ...(timing ? { timing } : {}) } });
  const { port, configuredPresets } = started;
  const configured = configuredPresets().join(', ');
  console.log(`[server] AnyWorld API on http://localhost:${port}${staticDir ? ` serving ${staticDir}` : ''}`);
  console.log(`[server] engine version ${engineVersion}`);
  console.log(`[server] rooms in ${dataDir}`);
  console.log(`[server] LLM presets available: ${configured}`);
  console.log(`[server] listening ${port}`);
  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[server] ${signal}: saving rooms and stopping`);
    started.close().then(
      () => process.exit(0),
      (e: unknown) => {
        console.error('[server] shutdown failed:', e);
        process.exit(1);
      },
    );
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  main().catch((e) => {
    console.error('[server] failed to start:', e);
    process.exit(1);
  });
}
